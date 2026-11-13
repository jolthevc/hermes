import { type CostContext, generateStructured } from "@hermes/core";
import { z } from "zod";
import { CORE_VOCAB } from "../vocab.js";

// Kit Builder: turns approved designs into a cutout-puppet parts plan. Every variant is an EDIT of its part's
// base image (same canvas), so poses line up and face/mouth/eyelid changes can be extracted as overlays.

export const PartVariant = z.object({
  name: z.string().describe("snake_case, unique within the part, e.g. pose_sip_tea, expr_smug, mouth_D, eye_narrow"),
  mode: z
    .enum(["full", "overlay"])
    .describe("full = whole new pose sprite; overlay = small local change (face, eyelid)"),
  prompt: z.string().describe("Edit instruction: change ONLY the named thing; everything else identical"),
});
export type PartVariant = z.infer<typeof PartVariant>;

export const PartPlan = z.object({
  part_id: z.string().describe("snake_case, e.g. body, eye, claw, tail, nostril"),
  base_prompt: z
    .string()
    .describe(
      "Image prompt for the base: one isolated element, centered, plain flat light-grey background, whole element inside the frame with margin, neutral state, no text, plus the show's style",
    ),
  canvas: z.enum(["portrait", "square", "landscape"]),
  variants: z.array(PartVariant),
});
export type PartPlan = z.infer<typeof PartPlan>;

export const CharacterParts = z.object({
  character: z.string(),
  archetype: z
    .enum(["biped", "giant_parts"])
    .describe("biped = full-body puppet; giant_parts = too big for the frame, only separate parts are ever shown"),
  parts: z.array(PartPlan),
});

export const PartsPlan = z.object({ characters: z.array(CharacterParts) });
export type PartsPlan = z.infer<typeof PartsPlan>;

const SYSTEM = `You are the Kit Builder for a 2D cutout-puppet animated comedy (stop-motion clay look, vertical video).
You plan the image parts each character puppet needs. Rules:
- Every part has ONE base image: the element isolated on a plain flat light-grey background, centered, fully inside the frame with margin, front or three-quarter view, neutral state.
- Every variant is an EDIT of that base made by an image-edit model: write it as "Change only <X> to <Y>. Keep the character, framing, pose, lighting, colours and background exactly identical."
- biped characters: one part "body" (full body, standing neutral, arms relaxed, three-quarter view). Its variants are full-body POSES (mode "full") for the actions this character will plausibly perform, chosen from the core actions and this show's kit actions (6-10 poses, include their signature prop business). Do NOT add expressions or mouth shapes; those are added automatically.
- giant_parts characters (too large to ever fit in frame): 3-6 parts, one per body part the show frames (e.g. eye, nostril, claw, tail). Each gets overlay variants for its states (e.g. eye: narrow, half_lidded, wide, closed, pupil_dilated; nostril: smoke_puff; claw: tap_raised) and full variants for big movements.
- Base prompts are literal visual descriptions consistent with the character's design and the style. No text, no other characters, no scenery.`;

export async function planParts(
  o: {
    bible: string;
    style: string;
    characters: { name: string; design_prompt: string; framing_rule: string }[];
    kitActions: { token: string; description: string }[];
  },
  ctx: CostContext,
) {
  const r = await generateStructured({
    role: "director",
    system: SYSTEM,
    prompt: `STYLE (append to every base prompt): ${o.style}

CHARACTERS:
${o.characters.map((c) => `- ${c.name}: ${c.design_prompt}\n  framing: ${c.framing_rule}`).join("\n")}

CORE ACTIONS: ${CORE_VOCAB.actions.join(", ")}
SHOW KIT ACTIONS: ${o.kitActions.map((a) => `${a.token} (${a.description})`).join("; ")}

SHOW BIBLE (for who does what):
${o.bible}`,
    schema: PartsPlan,
    schemaName: "parts_plan",
    ctx: { ...ctx, stage: "kit:plan_parts" },
  });
  return r.output;
}

// Standard face variants added to every biped body (overlay edits of the base).
const EDIT = (what: string) =>
  `Change only ${what}. Keep the character, head angle, framing, pose, lighting, colours and background exactly identical.`;

export const MOUTH_SHAPES: Record<string, string> = {
  // Rhubarb Lip Sync mouth shapes
  mouth_A: "the mouth to closed with lips pressed together (as for M, B, P)",
  mouth_B: "the mouth to slightly open with teeth together (as for most consonants like S, T, EE)",
  mouth_C: "the mouth to open at medium width (as for EH)",
  mouth_D: "the mouth to wide open (as for AA)",
  mouth_E: "the mouth to slightly open and rounded (as for AW, ER)",
  mouth_F: "the mouth to small and puckered (as for OO, W)",
  mouth_G: "the mouth so the upper teeth rest on the lower lip (as for F, V)",
  mouth_H: "the mouth to open with the tongue raised behind the upper teeth (as for L)",
  mouth_X: "the mouth to relaxed and closed, at rest",
};

export function standardFaceVariants(): PartVariant[] {
  const expr = CORE_VOCAB.expressions
    .filter((e) => e !== "neutral")
    .map((e) => ({
      name: `expr_${e}`,
      mode: "overlay" as const,
      prompt: EDIT(`the facial expression to ${e.replace("_", " ")} (eyes, brows and mouth only)`),
    }));
  const mouths = Object.entries(MOUTH_SHAPES).map(([name, what]) => ({
    name,
    mode: "overlay" as const,
    prompt: EDIT(what),
  }));
  return [...expr, ...mouths, { name: "blink", mode: "overlay", prompt: EDIT("the eyes to fully closed (a blink)") }];
}

// ---------- Part Judge (vision) ----------
export const PartScore = z.object({
  on_model: z.number().describe("1-5: same character/design as the reference (proportions, colours, costume, props)"),
  intended_change_only: z
    .number()
    .describe("1-5: compared with the base, ONLY the requested change happened (5 = nothing else moved)"),
  change_achieved: z.number().describe("1-5: the requested change is clearly visible and correct"),
  style_match: z.number().describe("1-5: matches the show's clay stop-motion style"),
  pass: z.boolean().describe("true only if every score is >= 4"),
  issue: z.string().describe("Main problem in one sentence, or 'none'"),
});
export type PartScore = z.infer<typeof PartScore>;

export async function judgePart(
  o: { character: string; request: string; referenceUrl: string; baseUrl: string; variantUrl?: string },
  ctx: CostContext,
) {
  const r = await generateStructured({
    role: "video_qa",
    system:
      "You are the model-sheet supervisor on a stop-motion style animated show. You check puppet parts for consistency. Be strict: production will reuse these parts in every episode.",
    prompt: o.variantUrl
      ? `CHARACTER: ${o.character}\nREQUESTED EDIT: ${o.request}\n\nImage 1 = character reference. Image 2 = BASE part. Image 3 = EDITED variant. Score the edited variant.`
      : `CHARACTER: ${o.character}\nPART: ${o.request}\n\nImage 1 = character reference. Image 2 = the generated BASE part. Score the base (for intended_change_only and change_achieved, score whether it is a clean isolated element on a plain background in a neutral state).`,
    media: [
      { type: "image", url: o.referenceUrl },
      { type: "image", url: o.baseUrl },
      ...(o.variantUrl ? [{ type: "image" as const, url: o.variantUrl }] : []),
    ],
    schema: PartScore,
    schemaName: "part_score",
    ctx: { ...ctx, stage: "kit:parts_qa" },
  });
  return r.output;
}
