/** Entry advisor: frozen prompt, reply schema and validation, version identity. Pure. */

import { z } from "zod";
import { DAY_TYPE_RULES, ENTRY, LIVE_PROFILES } from "@/config/entry";
import { canonicalJson, sha256, type Packet } from "./packet";

export const VERDICTS = ["take", "reduce", "skip"] as const;
export const DAY_TYPES = ["trend_up", "trend_down", "range", "reversal", "vol_expansion", "unclear"] as const;
export const REASON_CATEGORIES = ["price", "vol", "news", "calendar", "book", "bot_record", "data"] as const;

export const ENTRY_SYSTEM_PROMPT = `You advise on one SPX options bot entry, at the moment it has filled. You are in SHADOW MODE: nothing you say changes, places or blocks any trade. Your calls are logged and later scored against what the book actually did, to answer one question: would following your per-trade calls have beaten running the book untouched?

For the entry in the packet, say whether you would have taken it at full size ("take"), at half size ("reduce") or not at all ("skip"). Most bots make money most days; skipping a winner costs as much as avoiding a loser saves. Call "skip" or "reduce" only for a specific reason visible in the packet: the price action, volatility, scheduled events, headlines, today's book, or this bot's own record. Judge the trade's structure: short-premium trades lose on large or trending moves; long-premium trades (e.g. a long straddle) gain from them.

Everything in the packet was known at or before the fill. "health" lists data that is missing or stale; set "data_ok": false if what is missing would change your call.

List the reasons most important first, and name in "primary_category" the category of the one reason that decided the verdict.

Classify the day so far as one of trend_up, trend_down, range, reversal, vol_expansion, unclear.

Reply with JSON only:
{"verdict": "take"|"reduce"|"skip", "confidence": 0-100, "day_type": "...", "reasons": [{"category": "price"|"vol"|"news"|"calendar"|"book"|"bot_record"|"data", "text": "<= ${ENTRY.maxReasonWords} words"}] (1 to 3, most important first), "primary_category": the deciding reason's category, "main_risk": "<= ${ENTRY.maxReasonWords} words", "would_change_mind": "<= ${ENTRY.maxReasonWords} words", "data_ok": true|false}`;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
/** Text fields: length is not a reason to drop a call; over-long text is trimmed afterwards and flagged. */
const short = z.string().trim().min(1);

export const replySchema = z.object({
  verdict: z.enum(VERDICTS),
  confidence: z.number().min(0).max(100),
  day_type: z.enum(DAY_TYPES),
  reasons: z.array(z.object({ category: z.enum(REASON_CATEGORIES), text: short })).min(1),
  /** The category of the reason that decided the verdict. */
  primary_category: z.enum(REASON_CATEGORIES),
  main_risk: short,
  would_change_mind: short,
  data_ok: z.boolean(),
});
export type EntryReply = z.infer<typeof replySchema>;

export const REPLY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "day_type", "reasons", "primary_category", "main_risk", "would_change_mind", "data_ok"],
  properties: {
    verdict: { type: "string", enum: [...VERDICTS] },
    confidence: { type: "number" },
    day_type: { type: "string", enum: [...DAY_TYPES] },
    reasons: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "text"],
        properties: { category: { type: "string", enum: [...REASON_CATEGORIES] }, text: { type: "string" } },
      },
    },
    primary_category: { type: "string", enum: [...REASON_CATEGORIES] },
    main_risk: { type: "string" },
    would_change_mind: { type: "string" },
    data_ok: { type: "boolean" },
  },
} as const;

/** Cut a text field to the word limit, marking the cut with "…". */
export function trimWords(s: string, max = ENTRY.maxReasonWords): { text: string; trimmed: boolean } {
  const w = words(s);
  return w.length <= max ? { text: s.trim(), trimmed: false } : { text: `${w.slice(0, max).join(" ")}…`, trimmed: true };
}

/**
 * Parse and validate a reply. Over-long text fields are trimmed to the word limit and more than 3 reasons are
 * cut to the first 3; the call is kept and the trimmed fields are listed. Anything else invalid throws.
 */
export function parseEntryReply(text: string): { reply: EntryReply; trimmed: string[] } {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e < s) throw new Error("no JSON object in reply");
  const r = replySchema.safeParse(JSON.parse(text.slice(s, e + 1)));
  if (!r.success) throw new Error(`schema: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const trimmed: string[] = [];
  const cut = (field: string, v: string) => {
    const t = trimWords(v);
    if (t.trimmed) trimmed.push(field);
    return t.text;
  };
  const reply = r.data;
  if (reply.reasons.length > 3) trimmed.push(`reasons (${reply.reasons.length} → 3)`);
  return {
    reply: {
      ...reply,
      reasons: reply.reasons.slice(0, 3).map((x, i) => ({ ...x, text: cut(`reasons[${i}]`, x.text) })),
      main_risk: cut("main_risk", reply.main_risk),
      would_change_mind: cut("would_change_mind", reply.would_change_mind),
    },
    trimmed,
  };
}

export const renderEntryPrompt = (p: Packet) => `Entry packet (all times ET; bar rows are [time, open, high, low, close]):\n${JSON.stringify(p)}`;

/** Everything that defines a version. */
export function entryVersionSpec(model: string, effort: string) {
  return {
    model, effort, system: ENTRY_SYSTEM_PROMPT, schema: REPLY_JSON_SCHEMA, packetLayout: ENTRY.packetLayout, rules: ENTRY, dayTypes: DAY_TYPE_RULES,
    // v2: over-long text is trimmed, not an error; bot matching falls back to how bots fill live.
    replyHandling: "trim-to-limit", liveProfiles: LIVE_PROFILES,
  };
}
export const entryVersionHash = (model: string, effort: string) => sha256(canonicalJson(entryVersionSpec(model, effort)));
