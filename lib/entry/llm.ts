/** Entry advisor model calls. No refusal fallback: a version is one frozen model. */

import Anthropic from "@anthropic-ai/sdk";
import { callCost } from "../trader/prompt";
import { ENTRY_SYSTEM_PROMPT, REPLY_JSON_SCHEMA } from "./prompt";

export interface EntryModelCall {
  text: string;
  stopReason: string | null;
  modelServed: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  costUsd: number | null;
}

export type EntryCallModel = (args: { model: string; effort: string; user: string; kind: "entry" | "summary" }) => Promise<EntryModelCall>;

export const SUMMARY_SYSTEM_PROMPT =
  "Summarize the last 10 trading days of market-moving news for an SPX options trader, in one paragraph of at most 150 words: the themes that moved or could move the index (Fed and rates, inflation and jobs data, geopolitics, mega-cap earnings, policy). Plain text, no lists, no predictions.";

export const callEntryModel: EntryCallModel = async ({ model, effort, user, kind }) => {
  const client = new Anthropic(); // ANTHROPIC_API_KEY from env
  const resp = await client.beta.messages.create({
    model,
    max_tokens: kind === "entry" ? 8000 : 4000,
    system: [{ type: "text", text: kind === "entry" ? ENTRY_SYSTEM_PROMPT : SUMMARY_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    output_config:
      kind === "entry"
        ? { effort: effort as "low", format: { type: "json_schema", schema: REPLY_JSON_SCHEMA as unknown as Record<string, unknown> } }
        : { effort: "low" },
  });
  const text = resp.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const usage = {
    input_tokens: resp.usage.input_tokens,
    output_tokens: resp.usage.output_tokens,
    cache_read_input_tokens: resp.usage.cache_read_input_tokens,
    cache_creation_input_tokens: resp.usage.cache_creation_input_tokens,
  };
  return { text, stopReason: resp.stop_reason, modelServed: resp.model, usage, costUsd: callCost(model, usage) };
};
