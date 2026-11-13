import { type CostContext, generateStructured } from "@hermes/core";
import { z } from "zod";
import type { ShotScript } from "../schemas.js";

// Director: shot script (beats) -> shot list for frames-first production. Each shot becomes one keyframe
// still + one animated clip; dialogue lines are timed from TTS audio, holds from the shot list.

export const ShotType = z.enum(["talk", "react", "hold", "action", "insert"]);

export const Shot = z.object({
  id: z.string().describe("s01, s02, ... in order"),
  type: ShotType.describe(
    "talk = an on-screen character speaks (lip-synced); react = a silent reaction (small facial/body change); hold = near-still beat (silence, stare, aftermath); action = physical movement or gag; insert = object/prop close-up",
  ),
  framing: z.enum(["WIDE", "MED", "CU", "ECU", "TWO_SHOT", "OTS", "INSERT"]),
  characters: z.array(z.string()).describe("Characters visible in frame (exact cast names). Empty for a pure insert."),
  speaker: z.string().nullable().describe("For talk shots: the on-screen character whose mouth moves. Null otherwise."),
  line_ids: z.array(z.number()).describe("Indices of dialogue lines (from LINES) heard during this shot, in order"),
  background: z.string().describe("Name of one of the show's background plates, or 'close-up' for tight shots"),
  keyframe_prompt: z
    .string()
    .describe(
      "Literal description of the still frame: who is where, pose, facial expression, props, camera framing, lighting. Vertical 9:16 composition. No style words (added automatically), no text.",
    ),
  motion_prompt: z
    .string()
    .describe(
      "What moves during the clip, minimal and concrete (e.g. 'slow blink, slight head tilt'). Deadpan: less is more.",
    ),
  end_frame_prompt: z
    .string()
    .nullable()
    .describe("Action shots only: the final frame of the movement, same framing. Null otherwise."),
  min_duration_s: z.number().describe("Minimum on-screen seconds (talk shots also stretch to fit their lines)"),
  hold_after_s: z.number().describe("Extra silent seconds after the last line ends, for comic timing (0 if none)"),
  sfx: z.string().nullable(),
});
export type Shot = z.infer<typeof Shot>;

export const Line = z.object({
  id: z.number(),
  character: z.string(),
  text: z.string(),
  delivery: z.string().nullable(),
  on_screen: z.boolean().describe("False when the speaker is off-screen or too large to show speaking (voice only)"),
});
export type Line = z.infer<typeof Line>;

export const ShotList = z.object({
  lines: z.array(Line),
  shots: z.array(Shot),
  notes: z.string().describe("One or two sentences on the cutting rhythm and where the laugh lands"),
});
export type ShotList = z.infer<typeof ShotList>;

export interface CastMember {
  name: string;
  design: string;
  framing_rule: string;
}

export const MAX_SHOTS = 18;
export const MIN_SHOT_S = 1.2;

const SYSTEM = `You are the Director of a deadpan animated comedy for vertical video (9:16, phones). You turn a beat-by-beat shot script into a SHOT LIST for a frames-first pipeline: each shot is one still keyframe that gets animated briefly.

Rules:
- Keep every beat, line and joke from the script. Never add jokes or dialogue.
- Deadpan timing is the comedy: give reactions and silences their own shots, and use hold_after_s for pauses before or after punchlines. Cut on the laugh.
- Prefer simple, stable compositions: one or two characters, clear staging, readable faces at phone size. Avoid shots that need complex motion (crowds, fast action, hands doing intricate things); show the result or a reaction instead.
- Respect each character's framing rule. Characters that never fit in frame are shown as close-ups of a part (eye, snout, claw) and are never the on-screen 'speaker': their lines play over reaction shots or close-ups with on_screen=false.
- talk shots: exactly one visible speaker, face clearly visible, mostly MED or CU.
- action shots: describe the start state in keyframe_prompt and the end state in end_frame_prompt.
- keyframe_prompt must stand alone (an image model sees only it plus reference images): restate who, where, pose, expression, props and framing every time.
- Total runtime should stay under 60 seconds.
- Economy: every shot costs a generated keyframe and an animated clip, and every cut is another chance for drift. Aim for 10-16 shots (never more than ${MAX_SHOTS}), each at least 1.5 seconds. Merge beats that can share one composition (a line and its reaction can play in one two-shot; repeated business can reuse the same framing).
- Big effects (explosions, torrents of fire, melting, collapsing) are hard to animate convincingly: show the setup and the RESULT plus a reaction, cutting across the effect itself, or let a sound effect sell it over a reaction shot. Never describe crowds, fast motion or intricate hand work.`;

export async function directShots(
  o: { script: ShotScript; cast: CastMember[]; backgrounds: string[] },
  ctx: CostContext,
) {
  const lines = o.script.beats
    .filter((b) => b.kind === "line" && b.text)
    .map((b, i) => `${i}. ${b.character}${b.delivery ? ` (${b.delivery})` : ""}: ${b.text}`)
    .join("\n");
  const r = await generateStructured({
    role: "director",
    system: SYSTEM,
    prompt: `CAST:
${o.cast.map((c) => `- ${c.name}: ${c.design}\n  framing rule: ${c.framing_rule}`).join("\n")}

BACKGROUND PLATES AVAILABLE: ${o.backgrounds.join(", ")}

TITLE: ${o.script.title}
LOGLINE: ${o.script.logline}

LINES (use these ids in line_ids; return them in "lines" with on_screen set):
${lines}

SHOT SCRIPT (beats, in order):
${JSON.stringify(o.script.beats.map((b) => Object.fromEntries(Object.entries(b).filter(([, v]) => v !== null))))}`,
    schema: ShotList,
    schemaName: "shot_list",
    ctx: { ...ctx, stage: "direct" },
  });
  return r.output;
}

/** Sanity checks the orchestrator runs on every shot list (cheap, deterministic). */
export function validateShotList(sl: ShotList, cast: string[]): string[] {
  const problems: string[] = [];
  const lineIds = new Set(sl.lines.map((l) => l.id));
  const used = new Set<number>();
  for (const s of sl.shots) {
    for (const id of s.line_ids) {
      if (!lineIds.has(id)) problems.push(`${s.id}: unknown line ${id}`);
      if (used.has(id)) problems.push(`${s.id}: line ${id} used twice`);
      used.add(id);
    }
    if (s.type === "talk" && !s.speaker) problems.push(`${s.id}: talk shot without speaker`);
    if (s.speaker && !s.characters.includes(s.speaker)) problems.push(`${s.id}: speaker not in frame`);
    for (const c of s.characters) if (!cast.includes(c)) problems.push(`${s.id}: unknown character ${c}`);
    if (s.type === "action" && !s.end_frame_prompt) problems.push(`${s.id}: action shot without end frame`);
  }
  for (const l of sl.lines) if (!used.has(l.id)) problems.push(`line ${l.id} never placed in a shot`);
  if (sl.shots.length > MAX_SHOTS) problems.push(`${sl.shots.length} shots > ${MAX_SHOTS}; merge beats`);
  for (const s of sl.shots)
    if (s.line_ids.length === 0 && s.min_duration_s + s.hold_after_s < MIN_SHOT_S)
      problems.push(`${s.id}: silent shot shorter than ${MIN_SHOT_S}s`);
  return problems;
}
