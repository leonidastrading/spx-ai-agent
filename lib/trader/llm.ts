/** The trader's model call. No refusal fallback: a version is one frozen model. */

import Anthropic from "@anthropic-ai/sdk";
import { REPLY_JSON_SCHEMA } from "./rules";
import { TRADER_SYSTEM_PROMPT, callCost } from "./prompt";

export interface ModelCall {
  text: string;
  stopReason: string | null;
  modelServed: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  costUsd: number | null;
}

export type CallModel = (args: { model: string; effort: string; user: string }) => Promise<ModelCall>;

export const callTraderModel: CallModel = async ({ model, effort, user }) => {
  const client = new Anthropic(); // ANTHROPIC_API_KEY from env
  const resp = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    // The system prompt is identical on every call; cache it.
    system: [{ type: "text", text: TRADER_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    output_config: {
      effort: effort as "low" | "medium" | "high" | "xhigh" | "max",
      format: { type: "json_schema", schema: REPLY_JSON_SCHEMA as unknown as Record<string, unknown> },
    },
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
