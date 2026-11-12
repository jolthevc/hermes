// The sketch pipeline: an ordered list of stages. Each stage is a job; when it succeeds the
// orchestrator enqueues the next one. Stages without a handler yet are "pending build" — a sketch
// that reaches one waits there (state stays in_progress, stage = that name) until the handler ships,
// then `hermes resume` picks it up. Adding a stage = add it here + register a handler.

export const SKETCH_STAGES = [
  "draft",
  "punchup",
  "shot_script",
  "script_gate", // Gate 1 (judge ensemble)
  "direct", // Director: blocking, camera, timing
  "voice", // TTS takes + selection
  "animatic", // Gate 2: timing check
  "render", // Blender (GPU)
  "inserts", // video-model insert shots (GPU)
  "sound",
  "edit", // assembly, captions
  "qa", // Gate 3: technical + video-model review
  "review", // Gate 4: autopilot publish or human queue
] as const;

export type SketchStage = (typeof SKETCH_STAGES)[number];

export function nextStage(stage: string): SketchStage | null {
  const i = SKETCH_STAGES.indexOf(stage as SketchStage);
  return i >= 0 && i < SKETCH_STAGES.length - 1 ? SKETCH_STAGES[i + 1]! : null;
}

// Which queue each stage runs on. GPU stages are dispatched to SaladCloud by the GPU dispatcher.
export const STAGE_QUEUE: Record<SketchStage, string> = {
  draft: "cpu",
  punchup: "cpu",
  shot_script: "cpu",
  script_gate: "cpu",
  direct: "cpu",
  voice: "gpu:tts",
  animatic: "cpu",
  render: "gpu:render",
  inserts: "gpu:video",
  sound: "cpu",
  edit: "cpu",
  qa: "cpu",
  review: "cpu",
};
