/** Entry advisor: frozen prompt, reply schema and validation, version identity. Pure. */

import { z } from "zod";
import { DAY_TYPE_RULES, ENTRY } from "@/config/entry";
import { canonicalJson, sha256, type Packet } from "./packet";

export const VERDICTS = ["take", "reduce", "skip"] as const;
export const DAY_TYPES = ["trend_up", "trend_down", "range", "reversal", "vol_expansion", "unclear"] as const;
export const REASON_CATEGORIES = ["price", "vol", "news", "calendar", "book", "bot_record", "data"] as const;

export const ENTRY_SYSTEM_PROMPT = `You advise on one SPX options bot entry, at the moment it has filled. You are in SHADOW MODE: nothing you say changes, places or blocks any trade. Your calls are logged and later scored against what the book actually did, to answer one question: would following your per-trade calls have beaten running the book untouched?

For the entry in the packet, say whether you would have taken it at full size ("take"), at half size ("reduce") or not at all ("skip"). Most bots make money most days; skipping a winner costs as much as avoiding a loser saves. Call "skip" or "reduce" only for a specific reason visible in the packet: the price action, volatility, scheduled events, headlines, today's book, or this bot's own record. Judge the trade's structure: short-premium trades lose on large or trending moves; long-premium trades (e.g. a long straddle) gain from them.

Everything in the packet was known at or before the fill. "health" lists data that is missing or stale; set "data_ok": false if what is missing would change your call.

Classify the day so far as one of trend_up, trend_down, range, reversal, vol_expansion, unclear.

Reply with JSON only:
{"verdict": "take"|"reduce"|"skip", "confidence": 0-100, "day_type": "...", "reasons": [{"category": "price"|"vol"|"news"|"calendar"|"book"|"bot_record"|"data", "text": "<= ${ENTRY.maxReasonWords} words"}] (1 to 3), "main_risk": "<= ${ENTRY.maxReasonWords} words", "would_change_mind": "<= ${ENTRY.maxReasonWords} words", "data_ok": true|false}`;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const short = z.string().min(1).refine((s) => words(s) <= ENTRY.maxReasonWords, `at most ${ENTRY.maxReasonWords} words`);

export const replySchema = z.object({
  verdict: z.enum(VERDICTS),
  confidence: z.number().min(0).max(100),
  day_type: z.enum(DAY_TYPES),
  reasons: z.array(z.object({ category: z.enum(REASON_CATEGORIES), text: short })).min(1).max(3),
  main_risk: short,
  would_change_mind: short,
  data_ok: z.boolean(),
});
export type EntryReply = z.infer<typeof replySchema>;

export const REPLY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "day_type", "reasons", "main_risk", "would_change_mind", "data_ok"],
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
    main_risk: { type: "string" },
    would_change_mind: { type: "string" },
    data_ok: { type: "boolean" },
  },
} as const;

export function parseEntryReply(text: string): EntryReply {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e < s) throw new Error("no JSON object in reply");
  const r = replySchema.safeParse(JSON.parse(text.slice(s, e + 1)));
  if (!r.success) throw new Error(`schema: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return r.data;
}

export const renderEntryPrompt = (p: Packet) => `Entry packet (all times ET; bar rows are [time, open, high, low, close]):\n${JSON.stringify(p)}`;

/** Everything that defines a version. */
export function entryVersionSpec(model: string, effort: string) {
  return { model, effort, system: ENTRY_SYSTEM_PROMPT, schema: REPLY_JSON_SCHEMA, packetLayout: ENTRY.packetLayout, rules: ENTRY, dayTypes: DAY_TYPE_RULES };
}
export const entryVersionHash = (model: string, effort: string) => sha256(canonicalJson(entryVersionSpec(model, effort)));
