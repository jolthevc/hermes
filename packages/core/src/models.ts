import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { modelRegistry } from "./db/schema.js";

// Every agent role maps to a model (+ fallbacks). Defaults live here; rows in model_registry override
// them at runtime, so models can be swapped from the dashboard without a deploy.
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelChoice {
  model: string;
  fallbacks: string[];
  effort?: Effort;
}

export const DEFAULT_MODELS = {
  brain: { model: "anthropic/claude-sonnet-5.5", fallbacks: ["anthropic/claude-opus-5.5"], effort: "medium" },
  medic: { model: "anthropic/claude-sonnet-5.5", fallbacks: ["anthropic/claude-opus-5.5"], effort: "medium" },
  showrunner: { model: "anthropic/claude-opus-5.5", fallbacks: ["anthropic/claude-sonnet-5.5"], effort: "high" },
  ideation: { model: "anthropic/claude-opus-5.5", fallbacks: ["anthropic/claude-sonnet-5.5"], effort: "high" },
  head_writer: { model: "anthropic/claude-opus-5.5", fallbacks: ["anthropic/claude-sonnet-5.5"], effort: "high" },
  writer: { model: "anthropic/claude-opus-5.5", fallbacks: ["anthropic/claude-sonnet-5.5"], effort: "high" },
  punchup: { model: "anthropic/claude-opus-5.5", fallbacks: ["anthropic/claude-sonnet-5.5"], effort: "high" },
  script_judge: { model: "anthropic/claude-opus-5.5", fallbacks: ["anthropic/claude-sonnet-5.5"], effort: "high" },
  script_editor: { model: "anthropic/claude-haiku-5.5", fallbacks: ["anthropic/claude-sonnet-5.5"], effort: "medium" },
  director: { model: "anthropic/claude-sonnet-5.5", fallbacks: ["anthropic/claude-opus-5.5"], effort: "medium" },
  sound_designer: { model: "anthropic/claude-haiku-5.5", fallbacks: ["anthropic/claude-sonnet-5.5"], effort: "low" },
  editor: { model: "anthropic/claude-sonnet-5.5", fallbacks: ["anthropic/claude-opus-5.5"], effort: "medium" },
  video_qa: { model: "google/gemini-3.8-flash", fallbacks: [], effort: "medium" },
  publisher: { model: "anthropic/claude-haiku-5.5", fallbacks: ["anthropic/claude-sonnet-5.5"], effort: "low" },
  analyst: { model: "anthropic/claude-sonnet-5.5", fallbacks: ["anthropic/claude-opus-5.5"], effort: "medium" },
} satisfies Record<string, ModelChoice>;

export type Role = keyof typeof DEFAULT_MODELS;

const cache = new Map<string, { at: number; choice: ModelChoice }>();

export async function modelFor(role: Role): Promise<ModelChoice> {
  const hit = cache.get(role);
  if (hit && Date.now() - hit.at < 60_000) return hit.choice;
  const [row] = await db.select().from(modelRegistry).where(eq(modelRegistry.role, role));
  const def = DEFAULT_MODELS[role] as ModelChoice;
  const choice: ModelChoice = row
    ? { model: row.model, fallbacks: row.fallbacks, effort: (row.params as { effort?: Effort }).effort ?? def.effort }
    : def;
  cache.set(role, { at: Date.now(), choice });
  return choice;
}
