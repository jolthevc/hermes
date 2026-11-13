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
      "Image prompt for the base. biped: the whole character isolated on a plain flat light-grey background. giant_parts: a framed close-up plate where the named part fills most of the frame (surrounding anatomy may show), dark cave background. Neutral state, no text, plus the show's style.",
    ),
  canvas: z.enum(["portrait", "square", "landscape"]),
  overlay_region: z
    .string()
    .describe(
      "The area that this part's overlay variants change, described for a vision model to locate, e.g. 'the eye and its eyelids', 'the nostril and the smoke above it'. Use 'none' if the part has no overlay variants.",
    ),
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
- Every part has ONE base image, and every variant is an EDIT of that base made by an image-edit model: write it as "Change only <X> to <Y>. Keep the character, framing, pose, lighting, colours and background exactly identical."
- biped characters: one part "body": the whole character standing neutral, arms relaxed, three-quarter view, isolated on a plain flat light-grey background, fully in frame with margin. Its variants are full-body POSES (mode "full") for the actions this character plausibly performs, chosen from the core actions and this show's kit actions (6-10 poses, including signature prop business; keep held props held, e.g. a teacup stays in a hand). Do NOT add expressions or mouth shapes; those are added automatically. overlay_region: "the character's whole head including hair, glasses and any hat or helmet".
- giant_parts characters (too large to ever fit in frame): 3-5 parts, each a FRAMED CLOSE-UP PLATE as the show will actually frame it (e.g. "eye": one enormous eye filling the frame; "snout": the end of the snout with one nostril; "claw": one huge claw resting on gold coins; "tail": a section of tail sweeping across). Do not try to isolate a part from the head: image models draw the whole head when asked for an isolated jaw or nostril. Dark cave background, consistent lighting. State changes are overlay variants (eye: narrow, half_lidded, wide, closed, pupil_dilated; snout: smoke_puff, flared); big movements are full variants (claw: tap_raised).
- Base prompts are literal visual descriptions consistent with the character's design and the style. No text, no other characters.`;

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

// ---------- Region locator (vision) ----------
export const Region = z.object({
  found: z.boolean(),
  x0: z.number().describe("left edge, 0-1000 of image width"),
  y0: z.number().describe("top edge, 0-1000 of image height"),
  x1: z.number().describe("right edge, 0-1000 of image width"),
  y1: z.number().describe("bottom edge, 0-1000 of image height"),
});

/** Bounding box (in pixels, padded) of a described area in an image; null if not found. */
export async function locateRegion(
  o: { imageUrl: string; what: string; width: number; height: number; padFrac?: number },
  ctx: CostContext,
) {
  const r = await generateStructured({
    role: "video_qa",
    system: "You locate regions in images precisely. Return a tight bounding box in 0-1000 normalized coordinates.",
    prompt: `Find ${o.what} in this image. The box must contain all of it, as tightly as possible.`,
    media: [{ type: "image", url: o.imageUrl }],
    schema: Region,
    schemaName: "region",
    ctx: { ...ctx, stage: "kit:locate" },
  });
  const b = r.output;
  if (!b.found || b.x1 <= b.x0 || b.y1 <= b.y0) return null;
  const pad = o.padFrac ?? 0.1;
  const px = (v: number, size: number) => Math.round((v / 1000) * size);
  let x0 = px(b.x0, o.width);
  let y0 = px(b.y0, o.height);
  let x1 = px(b.x1, o.width);
  let y1 = px(b.y1, o.height);
  const pw = Math.round((x1 - x0) * pad);
  const ph = Math.round((y1 - y0) * pad);
  x0 = Math.max(0, x0 - pw);
  y0 = Math.max(0, y0 - ph);
  x1 = Math.min(o.width, x1 + pw);
  y1 = Math.min(o.height, y1 + ph);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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

export type JudgeKind = "base_biped" | "base_plate" | "pose" | "overlay";

const JUDGE_CONTEXT: Record<JudgeKind, string> = {
  base_biped:
    "Image 2 is the BASE puppet. For intended_change_only and change_achieved, score whether it is the whole character, cleanly isolated on a plain background, in a neutral standing pose.",
  base_plate:
    "Image 2 is a BASE close-up plate for a character too large to fit in frame. Surrounding anatomy may be visible. For intended_change_only and change_achieved, score whether the named part clearly dominates the frame in a neutral state.",
  pose: "Image 3 is the EDITED pose on its plain background. The background should stay plain and the same tone. Held props should still be held. Score the edit.",
  overlay:
    "Image 3 is the BASE with an edited region pasted back in: this is exactly what viewers will see. Check that the requested change is clearly visible, that nothing else changed, and that there is no visible seam, double edge, misalignment or colour shift around the pasted region.",
};

export async function judgePart(
  o: {
    character: string;
    request: string;
    kind: JudgeKind;
    referenceUrl: string;
    baseUrl: string;
    variantUrl?: string;
  },
  ctx: CostContext,
) {
  const r = await generateStructured({
    role: "video_qa",
    system:
      "You are the model-sheet supervisor on a stop-motion style animated show. You check puppet parts for consistency. Be strict: production will reuse these parts in every episode.",
    prompt: `CHARACTER: ${o.character}\n${o.variantUrl ? "REQUESTED EDIT" : "PART"}: ${o.request}\n\nImage 1 = character reference. Image 2 = the base. ${JUDGE_CONTEXT[o.kind]}`,
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
