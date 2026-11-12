import { z } from "zod";

// Renderer-agnostic shot script: the contract between the writers' room and production.
export const Beat = z.object({
  kind: z.enum(["shot", "line", "action", "reaction", "hold", "sfx", "music", "title_card"]),
  character: z.string().nullable().describe("Character name, or null"),
  text: z.string().nullable().describe("Dialogue for 'line', card text for 'title_card'"),
  delivery: z.string().nullable().describe("Parenthetical for lines, e.g. 'flat', 'too calm'"),
  framing: z.string().nullable().describe("For 'shot': core framing token (WIDE, MED, CU, ...)"),
  setting: z.string().nullable().describe("For 'shot': where we are / what we see"),
  expression: z.string().nullable().describe("Expression token for reactions (and optionally lines)"),
  action_desc: z.string().nullable().describe("What visibly happens, in plain words. Always set for 'action'."),
  action_token: z.string().nullable().describe("Core or kit token this maps to, or null if none fits"),
  realization: z
    .enum(["core", "kit", "insert"])
    .nullable()
    .describe("core rig vocab | show kit action | video insert shot"),
  duration_s: z.number().nullable().describe("Seconds for holds/actions/reactions; null for lines"),
  note: z.string().nullable(),
});
export type Beat = z.infer<typeof Beat>;

export const ShotScript = z.object({
  title: z.string(),
  logline: z.string(),
  cast: z.array(z.string()),
  est_runtime_s: z.number(),
  beats: z.array(Beat),
  kit_requests: z.array(z.object({ token: z.string(), description: z.string() })),
});
export type ShotScript = z.infer<typeof ShotScript>;

export const Premise = z.object({
  premise: z.string().describe("One sentence"),
  game: z.string().describe("The funny pattern that escalates"),
  button: z.string().describe("How it might end"),
  engine: z.string().describe("Comic engine, short snake_case, e.g. status_reversal, procedure_vs_absurd"),
  lead_character: z.string(),
});
export const PremiseList = z.object({ premises: z.array(Premise) });
export type Premise = z.infer<typeof Premise>;

export const Picks = z.object({
  picks: z.array(z.object({ index: z.number().describe("1-based index into the pitched list"), why: z.string() })),
});

export const CoreVocab = z.object({
  framings: z.array(z.string()),
  camera: z.array(z.string()),
  expressions: z.array(z.string()),
  actions: z.array(z.string()),
});
export type CoreVocab = z.infer<typeof CoreVocab>;

export const KitManifest = z.object({
  actions: z.array(z.object({ token: z.string(), description: z.string() })).default([]),
});
export type KitManifest = z.infer<typeof KitManifest>;
