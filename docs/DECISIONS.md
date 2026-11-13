# Decisions

Short records of choices that shape the build. Newest first.

## 2026-11-13: Switch from puppet parts to frames-first generation (supersedes "2D clay cutouts")

**Decision.** Stop building cutout puppets. Each sketch is generated shot by shot:

1. A keyframe still per shot (FLUX.2 klein, with the character's model sheet and the background as references), checked by the vision judge.
2. Each keyframe animated by shot type:
   - talking: an audio-driven talking-video model (candidates: InfiniteTalk, LongCat-Video-Avatar; licenses to verify)
   - reactions and holds: near-still clip or the held frame
   - physical gags: first/last-frame image-to-video (Wan 2.x or LTX-2)
3. Assembled with timing from TTS audio plus the shot script's holds, then video QA with rerolls.

**Why.** The automated puppet build stalled on edit-model limits, measured on the real kit:

- mouth edits deleted moustaches (Dunmore 0/20 face overlays)
- pose edits added hands or dropped the teacup (Grimsby 2/10 poses)
- emotion words painted faces on Ember's eye
- tight framings were ignored (snout and jaw failed 3/3)

Whole-frame generation from references is what these models do well (model sheets, boards and backgrounds all passed). A show's "kit" becomes its reference images, which we already produce. Blender and its headless-GPU risk drop out.

**Trade-off.** Consistency becomes very close but not pixel-identical, and motion can glitch (hands, morphing). QA rerolls cover this, and reaction/hold shots stay low-risk.

**Kept.** Writers' room, shot scripts, voices and Casting Judge, vision judge, job queue, Vast/RunPod dispatcher, cost ledger. The kit-parts code stays in the repo but is unused.

**Kit-parts spend before the switch:** about $1.55, of which vision judging was $0.82.

## 2026-11-12: The Dragon's Accountant renders as 2D clay cutouts, not 3D

**Decision.** The pilot show uses the "Felt and Clay Hoard" look, produced as **2D cutout puppets**: clay-style art generated as separate flat parts (head, expressions, torso, arms, mouth set, Ember's eye/claw/tail), with backgrounds removed. The parts are layered on bones in Blender and posed on twos for a stop-motion feel.

**Why.**

- Image→3D (TRELLIS.2) is weak on faces and hands and produces messy meshes.
- Auto-rigging those meshes is the riskiest step in the plan.
- Lip sync on generated 3D faces is hard.

Cutouts make the same parts appear in every episode, so characters stay identical, glitch risk is near zero, renders take seconds, and the clay look comes from the art itself. Deadpan sketches are mostly locked-off shots, so losing camera orbits and 3D relighting costs little.

**Revisit** if a future show needs camera moves around characters, or when image→3D plus auto-rig reliability improves.

## 2026-11-12: Image pool on 24 GB+ GPUs

FLUX.2 [klein] 4B peaks at ~19 GB VRAM. On Salad (Windows/WSL2 hosts), an over-full GPU spills to system RAM instead of failing, which made generation about 100× slower on a 16 GB card (~350 s vs 1.4–2.6 s per image on a 4090). The image pool is restricted to 24 GB+ classes, with CPU offload as a fallback below 20 GB.

## 2026-11-12: Brain owns GPU scaling

Salad's queue autoscaler wasn't applied to our container groups, so the GPU dispatcher sets replicas itself: in-flight jobs ÷ 3, capped per pool, and 0 after 10 idle minutes. This also keeps scaling provider-agnostic.

## 2026-11-12: Voices are designed, never cloned; a judge listens

Voices come from Qwen3-TTS VoiceDesign text descriptions. The approved take becomes the clone reference for that character's lines. A Casting Judge (Gemini via OpenRouter, audio input) scores every take against its brief and picks the best. The human can override.
