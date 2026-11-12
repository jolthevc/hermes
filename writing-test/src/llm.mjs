// All model calls go through OpenRouter (Claude included). Every call appends one line to
// out/ledger.jsonl with tokens and the dollar cost OpenRouter reports. A hard cap stops runs.
import fs from "node:fs";
import { z } from "zod";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

export const WRITER_MODEL = "anthropic/claude-opus-5.5";
export const CONVERTER_MODEL = "anthropic/claude-haiku-5.5";
export const SPEND_CAP_USD = +(process.env.SPEND_CAP_USD ?? 6);

fs.mkdirSync("out", { recursive: true });
const LEDGER = "out/ledger.jsonl";

export function spentSoFar() {
  if (!fs.existsSync(LEDGER)) return 0;
  return fs.readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean)
    .reduce((s, l) => s + (JSON.parse(l).usd ?? 0), 0);
}

async function chat({ model, system, prompt, effort, schema, tag }) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set (put it in writing-test/.env)");
  const spent = spentSoFar();
  if (spent >= SPEND_CAP_USD) throw new Error(`Spending cap reached: $${spent.toFixed(3)} of $${SPEND_CAP_USD}`);

  const body = {
    model,
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    usage: { include: true },
    ...(effort ? { reasoning: { effort } } : {}),
    ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "output", strict: true, schema: z.toJSONSchema(schema) } } } : {}),
  };
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const choice = data.choices?.[0];
  const u = data.usage ?? {};
  const entry = {
    ts: new Date().toISOString(), ...tag, model: data.model ?? model, provider: data.provider,
    prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens,
    reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? null,
    cached_tokens: u.prompt_tokens_details?.cached_tokens ?? null,
    usd: u.cost ?? null, finish: choice?.finish_reason,
  };
  fs.appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
  console.log(`  [${tag?.stage}] ${entry.prompt_tokens} in / ${entry.completion_tokens} out (${entry.reasoning_tokens ?? "?"} reasoning) $${(entry.usd ?? 0).toFixed(4)}  total $${(spent + (entry.usd ?? 0)).toFixed(3)}`);
  if (choice?.finish_reason === "length") throw new Error(`Output cut off at stage ${tag?.stage}`);
  const text = (choice?.message?.content ?? "").trim();
  if (!text) throw new Error(`Empty response at stage ${tag?.stage} (finish: ${choice?.finish_reason})`);
  return text;
}

// Creative calls: Opus 5.5, high reasoning effort.
export const write = ({ system, prompt, tag, effort = "high", model = WRITER_MODEL }) =>
  chat({ model, system, prompt, effort, tag });

// Structured calls: JSON-schema output, validated with zod, one retry on a bad parse.
export async function structured({ system, prompt, schema, tag, model = CONVERTER_MODEL, effort = "medium" }) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await chat({ model, system, prompt, effort, schema, tag: { ...tag, attempt } });
    try {
      return schema.parse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")));
    } catch (e) {
      if (attempt === 2) throw new Error(`Structured output invalid at stage ${tag?.stage}: ${e.message}`);
    }
  }
}

export async function listOpenRouterModels(filter = "") {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  const { data } = await res.json();
  return data
    .filter((m) => (m.id + m.name).toLowerCase().includes(filter.toLowerCase()))
    .map((m) => ({ id: m.id, in_per_M: +m.pricing.prompt * 1e6, out_per_M: +m.pricing.completion * 1e6, ctx: m.context_length }));
}
