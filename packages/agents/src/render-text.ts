import type { ShotScript } from "./schemas.js";

const dur = (d: number | null) => (d ? ` (${d}s)` : "");

/** Normalized plain-text rendering of a shot script (review feed, blind rating). Production tags hidden. */
export function renderText(s: ShotScript): string {
  const out: string[] = [];
  for (const b of s.beats) {
    const who = b.character ? b.character.toUpperCase() : "";
    switch (b.kind) {
      case "shot":
        out.push(`\n[${b.framing ?? "SHOT"}${b.setting ? ` — ${b.setting}` : ""}]`);
        break;
      case "line":
        out.push(`${who}${b.delivery ? ` (${b.delivery})` : ""}: ${b.text ?? ""}`);
        break;
      case "action": {
        const desc = b.action_desc ?? b.action_token ?? "";
        const named = !who || desc.toUpperCase().includes(who);
        out.push(`   > ${named ? "" : `${who}: `}${desc}${dur(b.duration_s)}`);
        break;
      }
      case "reaction":
        out.push(
          `   > ${who} reacts: ${b.expression ?? ""}${b.action_desc ? ` — ${b.action_desc}` : ""}${dur(b.duration_s)}`,
        );
        break;
      case "hold":
        out.push(`   [HOLD${dur(b.duration_s)}${b.action_desc || b.note ? ` — ${b.action_desc ?? b.note}` : ""}]`);
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
