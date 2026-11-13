import { type CostContext, generateStructured } from "@hermes/core";
import { z } from "zod";

// ---------- Art Director ----------
export const StyleDirection = z.object({
  name: z.string().describe("Short name, e.g. 'Parchment cutout'"),
  summary: z.string().describe("One sentence a human can judge"),
  style_prompt: z
    .string()
    .describe(
      "Style suffix appended to EVERY image prompt for this show: medium, linework, shading, palette, texture. Concrete, no artist or franchise names.",
    ),
  renderer: z.enum(["2d_cutout", "3d_toon", "clay"]).describe("Which production style this implies"),
});

export const CharacterDesign = z.object({
  name: z.string(),
  design_prompt: z
    .string()
    .describe(
      "Physical design: silhouette, proportions, colors, clothing, signature props. Style-free (no medium words).",
    ),
  framing_rule: z.string().describe("e.g. 'never fully in frame; show eye/claw/tail parts' or 'full body'"),
});

export const StyleBrief = z.object({
  directions: z.array(StyleDirection).describe("Exactly 3 clearly different looks"),
  characters: z.array(CharacterDesign),
  key_art_prompt: z
    .string()
    .describe(
      "One vertical key-art scene showing the main cast in the main location, mid-scene, no text. Style-free; the style suffix is added per direction.",
    ),
  background_prompts: z
    .array(z.object({ name: z.string(), prompt: z.string() }))
    .describe("Main locations, empty of characters"),
});
export type StyleBrief = z.infer<typeof StyleBrief>;

const ART_SYSTEM = `You are the Art Director of an animated comedy show for vertical video (9:16, phone screens).
You turn a show bible into concrete, production-ready visual direction for image models.
Rules:
- The look must be ORIGINAL. Never reference existing shows, studios, franchises or named artists.
- Designs must read instantly at phone size: bold silhouettes, few colors, clear faces, big readable expressions.
- Designs must be animatable as simple puppets: limited detail, separable parts (head, torso, arms, mouth), flat or simple shading.
- Prompts are literal visual descriptions for an image model. No story, no jokes, no text in images.`;

export async function styleBrief(bible: string, ctx: CostContext) {
  const r = await generateStructured({
    role: "showrunner",
    system: ART_SYSTEM,
    prompt: `SHOW BIBLE:\n${bible}\n\nProduce the style brief: 3 clearly different directions that all fit the bible's tone (one may follow the bible's own "Look" notes closely, the others should be genuine alternatives), the character designs, key art prompt and background prompts.`,
    schema: StyleBrief,
    schemaName: "style_brief",
    ctx: { ...ctx, stage: "kit:style_brief" },
  });
  return r.output;
}

// ---------- Casting ----------
export const VoiceBrief = z.object({
  voices: z.array(
    z.object({
      character: z.string(),
      instruct: z
        .string()
        .describe(
          "Voice description for a voice-design TTS model: age, gender, timbre, pitch, pace, accent, energy, texture. Describe an ORIGINAL voice; never name or imitate a real person or existing character.",
        ),
      audition_line: z
        .string()
        .describe("A 6-14 second in-character line that shows the voice and the deadpan delivery"),
    }),
  ),
});
export type VoiceBrief = z.infer<typeof VoiceBrief>;

// ---------- Casting Judge (listens to audio) ----------
export const VoiceScore = z.object({
  matches_brief: z.number().describe("1-5: does it sound like the described voice (age, pitch, timbre, pace, accent)"),
  clarity: z.number().describe("1-5: every word intelligible, no slurring or mispronunciation"),
  comic_delivery: z.number().describe("1-5: timing and attitude serve the comedy described in the brief"),
  artifacts: z
    .number()
    .describe("1-5: 5 = clean; lower for glitches, robotic tone, clipping, odd breaths, wrong words"),
  distinctiveness: z.number().describe("1-5: memorable, would be recognizable as this character"),
  overall: z.number().describe("1-5"),
  notes: z.string().describe("One or two sentences: what works, what doesn't"),
});
export type VoiceScore = z.infer<typeof VoiceScore>;

export async function judgeVoice(
  o: { character: string; instruct: string; line: string; wavBase64: string },
  ctx: CostContext,
) {
  const r = await generateStructured({
    role: "casting_judge",
    system:
      "You are a casting director auditioning voices for an animated deadpan comedy. Listen carefully and score strictly. A take that is clear but generic should not score above 3 overall.",
    prompt: `CHARACTER: ${o.character}\nVOICE BRIEF: ${o.instruct}\nSCRIPTED LINE: "${o.line}"\n\nListen to the attached audition and score it.`,
    media: [{ type: "audio", base64: o.wavBase64, format: "wav" }],
    schema: VoiceScore,
    schemaName: "voice_score",
    ctx: { ...ctx, stage: "cast:judge" },
  });
  return r.output;
}

/** Casting revises a voice description using the judge's notes on failed takes (keeps the audition line). */
export async function reviseVoiceInstruct(
  o: { character: string; instruct: string; judgeNotes: string[] },
  ctx: CostContext,
) {
  const r = await generateStructured({
    role: "showrunner",
    system:
      "You are a casting director rewriting a voice description for a voice-design TTS model whose last takes missed the brief. Keep the character the same; make the description more explicit and concrete where the takes went wrong (state accent, pitch range, pace and affect unambiguously, and say what to avoid). Never name or imitate a real person or existing character.",
    prompt: `CHARACTER: ${o.character}\nCURRENT DESCRIPTION: ${o.instruct}\n\nJUDGE NOTES ON THE LAST TAKES:\n${o.judgeNotes.map((n) => `- ${n}`).join("\n")}`,
    schema: z.object({ instruct: z.string(), what_changed: z.string() }),
    schemaName: "voice_revision",
    ctx: { ...ctx, stage: "cast:revise" },
  });
  return r.output;
}

export async function voiceBrief(bible: string, ctx: CostContext) {
  const r = await generateStructured({
    role: "showrunner",
    system:
      "You are the casting director of an animated deadpan comedy. You design original character voices for a voice-design TTS model. Comedy voices must be distinct from each other within the cast and serve the character's comic function (the straight man sounds unbothered; the blowhard sounds grand).",
    prompt: `SHOW BIBLE:\n${bible}\n\nWrite one voice brief per main character.`,
    schema: VoiceBrief,
    schemaName: "voice_brief",
    ctx: { ...ctx, stage: "cast:voice_brief" },
  });
  return r.output;
}
