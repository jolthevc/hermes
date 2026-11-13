import type { Job } from "@hermes/core";

// GPU job-kind registry and task contract. A leaf module (no imports from the orchestrator or dispatcher)
// so any stage module can register kinds at load time without circular-import ordering problems.

export interface GpuOutputSlot {
  key: string;
  contentType: string;
  kind: string; // artifact kind to register
  meta?: Record<string, unknown>;
}

export type Pool = "image" | "tts" | "render" | "video";

export interface GpuTask {
  pool: Pool;
  task: string;
  params: Record<string, unknown>;
  inputs: Record<string, string>; // name -> storage key
  outputs: Record<string, GpuOutputSlot>; // name -> slot
  showId?: string;
  sketchId?: string;
}

export interface WorkerOutput {
  ok: boolean;
  error?: string;
  error_class?: string;
  outputs?: { name: string; bytes: number; sha256: string; meta: Record<string, unknown> }[];
  metrics?: { gpu_seconds?: number } & Record<string, unknown>;
}

/** A GPU job kind: how to build its task from the job, and what to do with the registered artifacts. */
export interface GpuKind {
  build: (job: Job) => Promise<GpuTask>;
  collect?: (
    job: Job,
    artifactIds: Record<string, string>,
    out: WorkerOutput,
  ) => Promise<Record<string, unknown> | undefined>;
}

export const GPU_KINDS: Record<string, GpuKind> = {};
