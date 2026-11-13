import { z } from "zod";
import { requireEnv } from "./env.js";
import { classify, HermesError } from "./errors.js";
import { assertBudget, type CostContext, recordCost } from "./ledger.js";
import { log } from "./logger.js";
import { type Effort, modelFor, type Role } from "./models.js";

// All model calls go through OpenRouter (Claude included). Every call is budget-checked,
// costed into the ledger, and falls back across the role's models on refusal / bad output.

export interface CallOptions {
  role: Role;
  system: string;
  prompt: string;
  ctx: CostContext;
  effort?: Effort;
  maxTokens?: number;
  showDailyBudgetUsd?: number;
  /** Optional media attached to the user turn (audio/images), for multimodal judges. */
  media?: ({ type: "audio"; base64: string; format: "wav" | "mp3" } | { type: "image"; url: string })[];
}

function userContent(opts: CallOptions) {
  if (!opts.media?.length) return opts.prompt;
  return [
    { type: "text", text: opts.prompt },
    ...opts.media.map((m) =>
      m.type === "audio"
        ? { type: "input_audio", input_audio: { data: m.base64, format: m.format } }
        : { type: "image_url", image_url: { url: m.url } },
    ),
  ];
}

export interface CallResult<T = string> {
  output: T;
  model: string;
  usd: number;
}

interface OpenRouterResponse {
  model?: string;
  provider?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; code?: number };
}

async function callOnce(model: string, opts: CallOptions, responseFormat?: unknown): Promise<CallResult> {
  await assertBudget(opts.ctx, { showDailyBudgetUsd: opts.showDailyBudgetUsd });
  const choice = await modelFor(opts.role);
  const effort = opts.effort ?? choice.effort;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnv("OPENROUTER_API_KEY")}`,
        "Content-Type": "application/json",
        "X-Title": "hermes",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: userContent(opts) },
        ],
        usage: { include: true },
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(effort ? { reasoning: { effort } } : {}),
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch (e) {
    throw new HermesError(`OpenRouter request failed: ${(e as Error).message}`, "transient");
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    const retryAfter = Number(res.headers.get("retry-after")) * 1000 || undefined;
    const cls = res.status === 429 || res.status >= 500 ? "transient" : res.status === 402 ? "budget" : "fatal";
    throw new HermesError(`OpenRouter ${res.status}: ${body}`, cls, retryAfter);
  }
  const data = (await res.json()) as OpenRouterResponse;
  if (data.error) throw new HermesError(`OpenRouter error: ${data.error.message}`, "transient");
  const u = data.usage ?? {};
  const usd = u.cost ?? 0;
  const c = data.choices?.[0];
  await recordCost({
    ...opts.ctx,
    role: opts.role,
    provider: "openrouter",
    model: data.model ?? model,
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
    cachedTokens: u.prompt_tokens_details?.cached_tokens,
    usd,
    meta: { provider: data.provider, finish: c?.finish_reason, ms: Date.now() - started, effort },
  });
  log.debug({ role: opts.role, model, usd, finish: c?.finish_reason }, "llm call");

  if (c?.message?.refusal || c?.finish_reason === "refusal" || c?.finish_reason === "content_filter") {
    throw new HermesError(`Model ${model} refused`, "refusal");
  }
  if (c?.finish_reason === "length") throw new HermesError(`Output truncated (${model})`, "bad_output");
  const text = (c?.message?.content ?? "").trim();
  if (!text) throw new HermesError(`Empty response (${model}, finish=${c?.finish_reason})`, "bad_output");
  return { output: text, model: data.model ?? model, usd };
}

async function withFallbacks<T>(opts: CallOptions, run: (model: string) => Promise<T>): Promise<T> {
  const choice = await modelFor(opts.role);
  const models = [choice.model, ...choice.fallbacks];
  let lastErr: unknown;
  for (const [i, model] of models.entries()) {
    // Primary model gets one same-model retry on bad output before falling back.
    const tries = i === 0 ? 2 : 1;
    for (let t = 0; t < tries; t++) {
      try {
        return await run(model);
      } catch (e) {
        lastErr = e;
        const cls = classify(e);
        if (cls === "budget" || cls === "transient" || cls === "fatal") throw e; // job-level retry handles these
        if (cls === "refusal") break; // straight to the next model
        log.warn({ role: opts.role, model, err: (e as Error).message }, "model output rejected, retrying");
      }
    }
  }
  throw lastErr;
}

/** Free-text generation (creative stages). */
export function generate(opts: CallOptions): Promise<CallResult<string>> {
  return withFallbacks(opts, (model) => callOnce(model, opts));
}

/** Schema-constrained generation, validated with zod. */
export function generateStructured<S extends z.ZodType>(
  opts: CallOptions & { schema: S; schemaName: string },
): Promise<CallResult<z.infer<S>>> {
  const format = {
    type: "json_schema",
    json_schema: { name: opts.schemaName, strict: true, schema: z.toJSONSchema(opts.schema) },
  };
  return withFallbacks(opts, async (model) => {
    const r = await callOnce(model, opts, format);
    const cleaned = r.output.replace(/^```(?:json)?\s*|\s*```$/g, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new HermesError(`Invalid JSON from ${model}`, "bad_output");
    }
    const v = opts.schema.safeParse(parsed);
    if (!v.success)
      throw new HermesError(`Schema mismatch from ${model}: ${v.error.message.slice(0, 300)}`, "bad_output");
    return { ...r, output: v.data };
  });
}
