/** The once-a-day Anthropic call. Network side effects live here; prompt/parse logic is in decision.ts. */

import Anthropic from "@anthropic-ai/sdk";
import { LLM } from "@/config/rules";
import { SYSTEM_PROMPT, buildUserPrompt, llmJsonSchema, parseLlmOutput, type LlmDecision, type PromptInput } from "./decision";

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_MODEL?.trim() || LLM.defaultModel;
}

export interface LlmAttempt {
  ok: boolean;
  text: string;
  error?: string;
}

export interface LlmRunResult {
  model: string;
  decision: LlmDecision | null;
  attempts: LlmAttempt[];
}

/** Narrow the text out of a response, refusing on refusal/truncation. */
function responseText(resp: { content: Array<{ type: string }>; stop_reason: string | null }): string {
  if (resp.stop_reason === "refusal") throw new Error("model refused");
  if (resp.stop_reason === "max_tokens") throw new Error("response truncated (max_tokens)");
  return resp.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Call the model, validate the JSON, retry once on a parse/validation failure
 * (feeding the error back). Returns decision=null after two failures; the
 * caller stores an error row. API errors (auth, 5xx after SDK retries) throw.
 */
export async function runLlmDecision(
  input: PromptInput,
  opts: { client?: Anthropic; model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" } = {},
): Promise<LlmRunResult> {
  const client = opts.client ?? new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const model = opts.model ?? modelFromEnv();
  const useFallbacks = FALLBACK_MODELS.has(model);
  const names = input.strategies?.map((s) => s.name);
  const prompt = buildUserPrompt(input);
  let messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
  const attempts: LlmAttempt[] = [];

  for (let i = 0; i < 2; i++) {
    const resp = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages,
      output_config: { effort: opts.effort ?? "high", format: { type: "json_schema", schema: llmJsonSchema(names) } },
      ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    let text = "";
    try {
      text = responseText(resp);
      const decision = parseLlmOutput(text, names);
      attempts.push({ ok: true, text });
      return { model, decision, attempts };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      attempts.push({ ok: false, text, error });
      // Retry as a fresh single-turn request with the failure explained.
      messages = [
        {
          role: "user",
          content: `${prompt}\n\nA previous reply to this request could not be used (${error}). Reply with only the JSON object, covering every strategy.`,
        },
      ];
    }
  }
  return { model, decision: null, attempts };
}
