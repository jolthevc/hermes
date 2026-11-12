import type { CoreVocab, KitManifest } from "../schemas.js";

export const CRAFT = `
You write short animated comedy sketches for vertical video (under 60 seconds on screen).

What makes these work:
- One absurd premise, played completely straight. The characters treat the absurd thing as normal; the comedy comes from their commitment.
- One clear "game" per sketch: a single funny pattern that is established, heightened 1-2 times, then paid off.
- Specificity beats wackiness. A precise, mundane detail is funnier than a random one.
- Character-driven: the joke comes from who these characters are (see the bible), so it could only happen on this show.
- Deadpan delivery and timing are part of the writing. Write the pauses, holds, looks and reactions explicitly; silence is often the punchline.
- Visual comedy counts: describe what we SEE (actions, props, reactions, framing changes), not just what is said. Describe physical gags freely and plainly; production will work out how to animate them. Never limit an idea because it seems hard to animate.
- End on a button: a final turn, reaction or callback that lands in the last few seconds.
- Open fast: the premise must be clear within the first 3 seconds.

Avoid (these mark generic AI humor):
- Puns and wordplay as the main joke. "Random" non-sequiturs that don't follow the game.
- Characters explaining the joke, commenting on how absurd things are, or winking at the audience.
- Everyone being quippy; one straight man is usually needed.
- Endings that summarize, moralize, or say "classic X".
- Overused setups: therapy sessions, job interviews, "AI takes over", "plot twist".
`.trim();

export const SCREENPLAY_FORMAT = `
Format the sketch as a plain-text screenplay:

TITLE: <title>
LOGLINE: <one sentence: premise + the game>

[WIDE — <where we are, what we see>]
NAME (delivery): Line.
   > <visible action, plain words> (2s)
   > NAME reacts: <expression> — <what their face/body does> (1s)
   [HOLD (1.5s) — <what we hold on>]
   [SFX: <sound>]
[CU — <on what>]

Use framings WIDE, MED, CU, ECU, TWO_SHOT, OTS, INSERT_PROP, POV. Put durations on holds, actions and reactions.
`.trim();

export const writerSystem = (bible: string, lessons: string[] = []) =>
  [
    CRAFT,
    "# THE SHOW BIBLE",
    bible,
    lessons.length ? `# LESSONS FROM WHAT HAS WORKED ON THIS SHOW\n${lessons.map((l) => `- ${l}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

export const pitchPrompt = (n: number, avoid: string[]) =>
  `
Pitch ${n} distinct sketch premises for this show. Range widely across situations, which characters lead, and comic engines (escalation, reversal, status games, literal-mindedness, procedure applied to the absurd, etc.). Rough ideas are fine; range matters.
${avoid.length ? `\nDo not repeat these recent premises:\n${avoid.map((a) => `- ${a}`).join("\n")}\n` : ""}`.trim();

export const pickPrompt = (pitched: string, k: number) =>
  `
You are the head writer. From these pitches, pick the ${k} with the strongest, clearest game that could ONLY happen on this show and will play in under 60 seconds. Prefer variety: no two picks with the same engine or setup. Return them best first.

${pitched}`.trim();

export const draftPrompt = (pitch: string) =>
  `
Write the sketch for this pitch. Find the most specific, character-true version of the game; escalate it; land the button.

PITCH: ${pitch}

${SCREENPLAY_FORMAT}

Output only the screenplay.`.trim();

export const punchUpPrompt = (draft: string) =>
  `
You are running the punch-up pass on this draft. Be ruthless and specific:
1. Name the single weakest beat and the moment the game is least clear.
2. Find funnier, more specific choices for at least three lines or actions; add or sharpen a visual reaction or hold where silence would be funnier than a line.
3. Cut anything that doesn't serve the game. Keep it under 60 seconds including holds and actions.
4. Make sure the ending is a button, not a trail-off.

DRAFT:
${draft}

Write your notes briefly under "NOTES:", then the full revised screenplay under "FINAL:" in the same format.`.trim();

export const CONVERT_SYSTEM = `
You convert comedy sketch screenplays into a structured beat list for an animation pipeline. Preserve the writing exactly: never change, add or remove dialogue, actions, holds or jokes. Your job is only structure and mapping.

For every visible action, set action_desc to a plain description and set character to who performs it, then map it:
- If a token in CORE ACTIONS or KIT ACTIONS clearly expresses it (check KIT ACTIONS first for show-specific moves), set action_token and realization "core" or "kit".
- Otherwise set action_token to null and realization "insert", and add a kit_requests entry with a short snake_case token and description.
For sfx beats put the sound in action_desc without a "SFX:" prefix.
Use framing tokens from CORE FRAMINGS. Use expression tokens from the vocab where they fit.
Estimate est_runtime_s at ~2.6 spoken words per second plus all holds/actions/reactions.`.trim();

export const convertPrompt = (screenplay: string, core: CoreVocab, kit: KitManifest) =>
  `
CORE FRAMINGS: ${core.framings.join(", ")}
CORE EXPRESSIONS: ${core.expressions.join(", ")}
CORE ACTIONS: ${core.actions.join(", ")}
KIT ACTIONS (this show only): ${kit.actions.map((a) => `${a.token} (${a.description})`).join("; ") || "none"}

SCREENPLAY:
${screenplay}`.trim();
