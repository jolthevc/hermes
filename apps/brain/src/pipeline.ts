// The sketch pipeline (frames-first production; see docs/PLAN.md). Each stage is a job; when it succeeds the
// orchestrator enqueues the next one. A stage with no handler yet is "pending build": the sketch waits there
// (state in_progress, stage = that name) until the handler ships, then `hermes resume` picks it up.

export const SKETCH_STAGES = [
  "draft",
  "punchup",
  "shot_script",
  "script_gate", // Gate 1 (judge ensemble)
  "direct", // Director: beats -> shot list
  "voice", // TTS per line from approved voices (+ word timings)
  "animatic", // Gate 2: timings vs shot list
  "keyframes", // one still per shot from references; vision judge
  "animate", // talk = audio-driven video, react/hold = near-still, action = first/last-frame i2v
  "edit", // assembly, captions, sound
  "qa", // Gate 3: video judge per shot + whole cut
  "review", // Gate 4: autopilot publish or human queue
] as const;

export type SketchStage = (typeof SKETCH_STAGES)[number];

export function nextStage(stage: string): SketchStage | null {
  const i = SKETCH_STAGES.indexOf(stage as SketchStage);
  return i >= 0 && i < SKETCH_STAGES.length - 1 ? SKETCH_STAGES[i + 1]! : null;
}

// Which queue each stage runs on. GPU stages are dispatched by the GPU dispatcher (Vast first, RunPod fallback).
export const STAGE_QUEUE: Record<SketchStage, string> = {
  draft: "cpu",
  punchup: "cpu",
  shot_script: "cpu",
  script_gate: "cpu",
  direct: "cpu",
  voice: "gpu:tts",
  animatic: "cpu",
  keyframes: "gpu:image",
  animate: "gpu:video",
  edit: "cpu",
  qa: "cpu",
  review: "cpu",
};
