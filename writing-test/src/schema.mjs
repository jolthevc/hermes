// Renderer-agnostic sketch format + a normalized plain-text rendering for blind rating.
import { z } from "zod";

export const Beat = z.object({
  kind: z.enum(["shot", "line", "action", "reaction", "hold", "sfx", "music", "title_card"]),
  character: z.string().nullable().describe("Character id/name, or null"),
  text: z.string().nullable().describe("Dialogue for 'line', card text for 'title_card'"),
  delivery: z.string().nullable().describe("Parenthetical for lines, e.g. 'flat', 'too calm'"),
  framing: z.string().nullable().describe("For 'shot': core framing token (WIDE, MED, CU, ...)"),
  setting: z.string().nullable().describe("For 'shot': where we are / what we see, short"),
  expression: z.string().nullable().describe("For 'reaction' (and optionally lines): expression token"),
  action_desc: z.string().nullable().describe("What visibly happens, in plain words. Always set for 'action'."),
  action_token: z.string().nullable().describe("Core or kit token this maps to, or null if none fits"),
  realization: z.enum(["core", "kit", "insert"]).nullable().describe("How production will realize an action: core rig vocab, show-kit custom action, or video-model insert shot"),
  duration_s: z.number().nullable().describe("Seconds for holds/actions/reactions; null for lines (timed from audio)"),
  note: z.string().nullable(),
});

export const Sketch = z.object({
  title: z.string(),
  logline: z.string().describe("One sentence: the premise and the game of the scene"),
  cast: z.array(z.string()),
  est_runtime_s: z.number(),
  beats: z.array(Beat),
  kit_requests: z.array(z.object({ token: z.string(), description: z.string() }))
    .describe("Actions that needed an insert shot and might deserve a permanent kit action"),
});

const fmtDur = (d) => (d ? ` (${d}s)` : "");

// Normalized text shown to raters. Identical formatting for every source (AI, human, gold)
// so raters can't tell where a script came from. Production tags (tokens/realization) are hidden.
export function renderForRaters(s) {
  const out = [];
  for (const b of s.beats) {
    const who = b.character ? b.character.toUpperCase() : "";
    switch (b.kind) {
      case "shot":
        out.push(`\n[${b.framing ?? "SHOT"}${b.setting ? " — " + b.setting : ""}]`);
        break;
      case "line":
        out.push(`${who}${b.delivery ? " (" + b.delivery + ")" : ""}: ${b.text ?? ""}`);
        break;
      case "action": {
        const desc = b.action_desc ?? b.action_token ?? "";
        // Prefix the actor unless the description already names them.
        const named = !who || desc.toUpperCase().includes(who);
        out.push(`   > ${named ? "" : who + ": "}${desc}${fmtDur(b.duration_s)}`);
        break;
      }
      case "reaction":
        out.push(`   > ${who} reacts: ${b.expression ?? ""}${b.action_desc ? " — " + b.action_desc : ""}${fmtDur(b.duration_s)}`);
        break;
      case "hold":
        out.push(`   [HOLD${fmtDur(b.duration_s)}${b.action_desc || b.note ? " — " + (b.action_desc ?? b.note) : ""}]`);
        break;
      case "sfx":
        out.push(`   [SFX: ${(b.action_desc ?? b.text ?? b.note ?? "").replace(/^\s*SFX:\s*/i, "")}]`);
        break;
      case "music":
        out.push(`   [MUSIC: ${b.action_desc ?? b.text ?? b.note ?? ""}]`);
        break;
      case "title_card":
        out.push(`\n[CARD: ${b.text ?? ""}]`);
        break;
    }
  }
  return out.join("\n").trim();
}
