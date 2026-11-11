/**
 * Editable inputs. Defaults come from the config/ files; the Settings page
 * saves overrides to the `settings` table. Pure: validation and merging only.
 * Secrets (API keys, passwords) are never settings — they stay in env vars.
 */

import { z } from "zod";
import { LLM, RULES } from "@/config/rules";
import { LEGACY_STRATEGIES, OO_STRATEGY_MAP, STRATEGIES, type StrategyDef } from "@/config/strategies";
import { DEFAULT_KEYWORDS, type KeywordConfig } from "./news";
import { normalizeOoName } from "./optionomega";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface Settings {
  rules: typeof RULES;
  llm: {
    /** Blank = CLAUDE_MODEL env var, else the built-in default. */
    model: string;
    effort: (typeof EFFORTS)[number];
    maxHeadlines: number;
    enabled: boolean;
  };
  email: {
    enabled: boolean;
    /** Blank = ALERT_EMAIL env var. Comma-separated. */
    to: string;
  };
  strategies: StrategyDef[];
  /** Option Omega strategy name (lower-case) -> short strategy name. */
  ooMap: Record<string, string>;
  keywords: KeywordConfig;
}

export const DEFAULT_SETTINGS: Settings = {
  rules: { ...RULES },
  llm: { model: "", effort: "high", maxHeadlines: LLM.maxHeadlines, enabled: true },
  email: { enabled: true, to: "" },
  strategies: STRATEGIES,
  ooMap: OO_STRATEGY_MAP,
  keywords: DEFAULT_KEYWORDS,
};

const terms = z.array(z.string().trim().min(1).max(80)).max(200);

export const settingsSchema = z
  .object({
    rules: z.object({
      atrPercentile: z.number().gt(0).lt(1),
      atrLookbackDays: z.number().int().min(20).max(2000),
      atrMinHistoryDays: z.number().int().min(1).max(2000),
      spyDownPct: z.number().min(0).max(20),
    }),
    llm: z.object({
      model: z.string().trim().max(100).regex(/^[a-z0-9.\-]*$/i, "letters, digits, dots and dashes only"),
      effort: z.enum(EFFORTS),
      maxHeadlines: z.number().int().min(0).max(200),
      enabled: z.boolean(),
    }),
    email: z.object({
      enabled: z.boolean(),
      to: z
        .string()
        .trim()
        .max(500)
        .refine((s) => s === "" || s.split(",").every((e) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e.trim())), "comma-separated email addresses"),
    }),
    strategies: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(40),
          entryEt: z.string().trim().max(60),
          description: z.string().trim().max(300),
        }),
      )
      .min(1)
      .max(30),
    ooMap: z.record(z.string().trim().min(1).max(120), z.string().trim().min(1)),
    keywords: z.object({
      categories: z
        .array(
          z.object({
            key: z.string().regex(/^[a-z0-9_]{1,30}$/, "lower-case letters, digits, underscores"),
            label: z.string().trim().min(1).max(80),
            terms,
            megaCapOnly: z.boolean().optional(),
          }),
        )
        .max(30),
      megaCaps: z.array(z.string().trim().toUpperCase().regex(/^[A-Z.]{1,10}$/)).max(100),
      megaCapNames: terms,
    }),
  })
  .superRefine((s, ctx) => {
    const names = s.strategies.map((x) => x.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", path: ["strategies"], message: "strategy names must be unique" });
    for (const [oo, short] of Object.entries(s.ooMap))
      if (!names.includes(short)) ctx.addIssue({ code: "custom", path: ["ooMap", oo], message: `maps to unknown strategy "${short}"` });
    const keys = s.keywords.categories.map((c) => c.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["keywords"], message: "category keys must be unique" });
    if (s.rules.atrMinHistoryDays > s.rules.atrLookbackDays)
      ctx.addIssue({ code: "custom", path: ["rules", "atrMinHistoryDays"], message: "must be <= lookback days" });
  });

export type SettingsInput = z.input<typeof settingsSchema>;

/** Validate a full settings object. Returns readable error strings on failure. */
export function validateSettings(input: unknown): { ok: true; settings: Settings } | { ok: false; errors: string[] } {
  const r = settingsSchema.safeParse(input);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const s = r.data;
  return {
    ok: true,
    settings: {
      ...s,
      ooMap: Object.fromEntries(Object.entries(s.ooMap).map(([k, v]) => [normalizeOoName(k), v])),
    },
  };
}

/**
 * Merge stored overrides over the defaults section by section. A stored value
 * that no longer validates (e.g. after a code change) falls back to defaults.
 */
export function mergeSettings(stored: unknown): Settings {
  if (!stored || typeof stored !== "object") return DEFAULT_SETTINGS;
  const s = stored as Partial<Settings>;
  const { strategies, ooMap } = migrateLegacyBots(s.strategies ?? DEFAULT_SETTINGS.strategies, s.ooMap ?? DEFAULT_SETTINGS.ooMap);
  const candidate = {
    rules: { ...DEFAULT_SETTINGS.rules, ...(s.rules ?? {}) },
    llm: { ...DEFAULT_SETTINGS.llm, ...(s.llm ?? {}) },
    email: { ...DEFAULT_SETTINGS.email, ...(s.email ?? {}) },
    strategies,
    ooMap,
    keywords: { ...DEFAULT_SETTINGS.keywords, ...(s.keywords ?? {}) },
  };
  const v = validateSettings(candidate);
  return v.ok ? v.settings : DEFAULT_SETTINGS;
}

/**
 * Saved settings from before the VIX split list "2DTE" and "VIX-up". Replace
 * them with the four split bots (and add 3 Delta), keeping every other edit;
 * Option Omega mappings that pointed at the retired names are dropped.
 */
export function migrateLegacyBots(strategies: StrategyDef[], ooMap: Record<string, string>) {
  const names = strategies.map((x) => x.name);
  if (!names.some((n) => LEGACY_STRATEGIES.includes(n))) return { strategies, ooMap };
  const byName = new Map(STRATEGIES.map((x) => [x.name, x]));
  const kept = strategies.filter((x) => !LEGACY_STRATEGIES.includes(x.name));
  const add = STRATEGIES.filter((x) => (x.name.startsWith("2DTE ") || x.name.startsWith("VIX-up ") || x.name === "3 Delta") && !kept.some((k) => k.name === x.name));
  // Keep the defaults' order for everything known; anything custom goes at the end.
  const merged = [...kept, ...add];
  const order = (n: string) => (byName.has(n) ? STRATEGIES.findIndex((x) => x.name === n) : 1000);
  merged.sort((a, b) => order(a.name) - order(b.name));
  const live = new Set(merged.map((x) => x.name));
  return {
    strategies: merged,
    ooMap: Object.fromEntries(Object.entries(ooMap).filter(([, v]) => live.has(v))),
  };
}

export const strategyNames = (s: Settings) => s.strategies.map((x) => x.name);

/** Model actually used: settings, then CLAUDE_MODEL, then the default. */
export function effectiveModel(s: Settings, env: Record<string, string | undefined> = process.env): string {
  return s.llm.model.trim() || env.CLAUDE_MODEL?.trim() || LLM.defaultModel;
}

/** Which env-backed connections are configured (names only; values are never exposed). */
export function envStatus(env: Record<string, string | undefined> = process.env) {
  const has = (k: string) => !!env[k]?.trim();
  return [
    { group: "Alpaca (read-only data)", key: "ALPACA_API_KEY_ID", set: has("ALPACA_API_KEY_ID"), required: true },
    { group: "Alpaca (read-only data)", key: "ALPACA_API_SECRET_KEY", set: has("ALPACA_API_SECRET_KEY"), required: true },
    { group: "Alpaca (read-only data)", key: "ALPACA_FEED", set: has("ALPACA_FEED"), required: false, value: env.ALPACA_FEED || "auto (SIP, else IEX)" },
    { group: "Alpaca (read-only data)", key: "ALPACA_PAPER", set: has("ALPACA_PAPER"), required: false, value: env.ALPACA_PAPER === "true" ? "paper keys" : "live keys" },
    { group: "Anthropic", key: "ANTHROPIC_API_KEY", set: has("ANTHROPIC_API_KEY"), required: true },
    { group: "Anthropic", key: "CLAUDE_MODEL", set: has("CLAUDE_MODEL"), required: false, value: env.CLAUDE_MODEL || `default (${LLM.defaultModel})` },
    { group: "Database", key: "DATABASE_URL", set: has("DATABASE_URL") || has("POSTGRES_URL"), required: true },
    { group: "Email (optional)", key: "RESEND_API_KEY", set: has("RESEND_API_KEY"), required: false, value: has("RESEND_API_KEY") ? "" : "email off" },
    { group: "Email (optional)", key: "ALERT_EMAIL", set: has("ALERT_EMAIL"), required: false },
    { group: "Email (optional)", key: "ALERT_FROM", set: has("ALERT_FROM"), required: false },
    { group: "Access", key: "DASHBOARD_USER / DASHBOARD_PASSWORD", set: has("DASHBOARD_USER") && has("DASHBOARD_PASSWORD"), required: true },
    { group: "Paper accounts (trader / swing)", key: "TRADER_ALPACA_KEY_ID / TRADER_ALPACA_SECRET_KEY", set: has("TRADER_ALPACA_KEY_ID") && has("TRADER_ALPACA_SECRET_KEY"), required: false, value: has("TRADER_ALPACA_KEY_ID") ? "" : "day trader can't trade" },
    { group: "Paper accounts (trader / swing)", key: "SWING_ALPACA_KEY_ID / SWING_ALPACA_SECRET_KEY", set: has("SWING_ALPACA_KEY_ID") && has("SWING_ALPACA_SECRET_KEY"), required: false, value: has("SWING_ALPACA_KEY_ID") ? "" : "swing ideas can't be saved" },
    { group: "Entry advisor", key: "OO_EXPORT_URL / OO_EXPORT_TOKEN", set: has("OO_EXPORT_URL") && has("OO_EXPORT_TOKEN"), required: false, value: has("OO_EXPORT_URL") ? "" : "no entries until oo-trading's export is connected" },
    { group: "Access", key: "CRON_SECRET", set: has("CRON_SECRET"), required: true },
  ];
}
