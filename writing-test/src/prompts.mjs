// Prompts for the writers' room. The show bible is the stable prefix (cached); per-call content follows.

export const CRAFT = `
You write short animated comedy sketches for vertical video (20-40 seconds on screen, roughly 40-110 spoken words).

What makes these work:
- One absurd premise, played completely straight. The characters treat the absurd thing as normal; the comedy comes from their commitment.
- One clear "game" per sketch: a single funny pattern that is established, then heightened 1-2 times, then paid off.
- Specificity beats wackiness. A precise, mundane detail is funnier than a random one.
- Character-driven: the joke should come from who these characters are (see the bible), so it could only happen on this show.
- Deadpan delivery and timing are part of the writing. Write the pauses, holds, looks and reactions explicitly — silence is often the punchline.
- Visual comedy counts: describe what we SEE (actions, props, reactions, framing changes), not just what is said. Describe physical gags freely and plainly; production will figure out how to animate them. Never limit an idea because it seems hard to animate.
- End on a button: a final turn, a reaction, or a callback that lands within the last 3 seconds. No trailing.
- Open fast: the premise must be clear within the first 3 seconds (no slow setup, no title-card exposition unless it's a joke).

Avoid (these mark generic AI humor):
- Puns and wordplay as the main joke. Pop-culture references. "Random" non-sequiturs that don't follow the game.
- Characters explaining the joke, commenting on how absurd things are, or winking at the audience.
- Everyone being quippy; one straight man is usually needed.
- Endings that summarize, moralize, or say "classic X".
- Overused setups: therapy sessions, job interviews, "AI takes over", "plot twist", "we're not so different".
`.trim();

export const SCREENPLAY_FORMAT = `
Format the sketch as a plain-text screenplay like this:

TITLE: <title>
LOGLINE: <one sentence: premise + the game>

[WIDE — <where we are, what we see>]
NAME (delivery): Line.
   > <visible action, plain words> (2s)
   > NAME reacts: <expression> — <what their face/body does> (1s)
   [HOLD (1.5s) — <what we hold on>]
   [SFX: <sound>]
[CU — <on what>]
...

Use framings WIDE, MED, CU, ECU, TWO_SHOT, OTS, INSERT_PROP, POV. Put durations on holds, actions and reactions.
`.trim();

export function writerSystem(bible) {
  return `${CRAFT}\n\n# THE SHOW BIBLE\n\n${bible}`;
}

export const oneShotPrompt = (prior) => `
Write one new sketch for this show.
${prior.length ? `\nAlready written in this batch (do something clearly different in premise and game):\n${prior.map((p) => "- " + p).join("\n")}\n` : ""}
${SCREENPLAY_FORMAT}

Output only the screenplay.`.trim();

export const premisesPrompt = (n) => `
Pitch ${n} distinct sketch premises for this show. For each, one line:
<number>. <premise in one sentence> || GAME: <the funny pattern that escalates> || BUTTON: <how it might end>

Range widely across situations, which characters lead, and comic engines (escalation, reversal, status games, literal-mindedness, procedure applied to the absurd, etc.). Rough ideas are fine; quantity and range matter here. Output only the list.`.trim();

export const selectPrompt = (premises, k) => `
You are the head writer. From these pitches, pick the ${k} with the strongest, clearest game that could ONLY happen on this show and that will play in 20-40 seconds. Prefer variety: no two picks with the same engine or setup.

${premises}

Output exactly ${k} lines, each: <original number>. <premise, copied or sharpened> || GAME: ... || BUTTON: ...
No other text.`.trim();

export const draftPrompt = (pitch) => `
Write the sketch for this pitch. Find the most specific, character-true version of the game; escalate it; land the button.

PITCH: ${pitch}

${SCREENPLAY_FORMAT}

Output only the screenplay.`.trim();

export const punchUpPrompt = (draft) => `
You are running the punch-up pass on this draft. Be ruthless and specific:
1. Name the single weakest beat and the moment the game is least clear.
2. Find funnier, more specific choices for at least three lines or actions; add or sharpen a visual reaction or hold where silence would be funnier than a line.
3. Cut anything that doesn't serve the game. Confirm it fits 20-40 seconds (about 40-110 spoken words).
4. Make sure the ending is a button, not a trail-off.

DRAFT:
${draft}

Write your notes briefly under "NOTES:", then the full revised screenplay under "FINAL:" in the same format.`.trim();

export const CONVERT_SYSTEM = `
You convert comedy sketch screenplays into a structured beat list for an animation pipeline. Preserve the writing exactly: never change, add or remove dialogue, actions, holds, or jokes. Your job is only structure and mapping.

For every visible action, set action_desc to a plain description, then map it:
- If a token in CORE ACTIONS or KIT ACTIONS clearly expresses it, set action_token to that token and realization to "core" or "kit".
- Otherwise set action_token to null and realization to "insert" (a generated insert shot will animate it), and add a kit_requests entry with a short snake_case token and description.
Use framing tokens from CORE FRAMINGS where possible. Use expression tokens from the vocab where they fit, else a short plain word.
Estimate est_runtime_s at ~2.6 spoken words per second plus all holds/actions/reactions.`.trim();

export const convertPrompt = (screenplay, core, kit) => `
CORE FRAMINGS: ${core.framings.join(", ")}
CORE EXPRESSIONS: ${core.expressions.join(", ")}
CORE ACTIONS: ${core.actions.join(", ")}
KIT ACTIONS (this show only): ${kit.actions.map((a) => `${a.token} (${a.description})`).join("; ") || "none"}

SCREENPLAY:
${screenplay}`.trim();

export const JUDGE_SYSTEM = `
You are a comedy development executive judging short animated sketches (20-40s, vertical video) before they are produced. Judge the sketch AS DESCRIBED — dialogue, visual action, holds and reactions together — imagining it performed with deadpan timing. Be calibrated and harsh: most sketches are not good enough to post. A 5 is something you'd expect to share with friends; a 3 is competent but forgettable; a 1 is not funny.`.trim();

export const judgePrompt = (bible, rendered) => `
SHOW CONTEXT (for character consistency):
${bible}

SKETCH:
${rendered}

Score it.`.trim();
