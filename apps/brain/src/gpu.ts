import { hostname } from "node:os";
import { db, env, HermesError, type Job, log, queue, recordCost, salad, schema, storage } from "@hermes/core";
import { and, eq, isNotNull, like } from "drizzle-orm";
import { onDead, onSucceeded } from "./orchestrator.js";

const { jobs, artifacts } = schema;
const WORKER_ID = `gpu-dispatcher:${hostname()}:${process.pid}`;
const LEASE_S = 3 * 3600; // GPU jobs can wait for a cold node; the poller heartbeats while Salad works

// ---------- task contract (mirrors workers/common/hermes_worker/server.py) ----------
export interface GpuOutputSlot {
  key: string;
  contentType: string;
  kind: string; // artifact kind to register
  meta?: Record<string, unknown>;
}

export interface GpuTask {
  pool: "image" | "tts" | "render" | "video"; // Salad queue / container group
  task: string;
  params: Record<string, unknown>;
  inputs: Record<string, string>; // name -> storage key
  outputs: Record<string, GpuOutputSlot>; // name -> slot
  showId?: string;
  sketchId?: string;
}

interface WorkerOutput {
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

const USD_PER_GPU_HOUR: Record<string, number> = { image: 0.3, tts: 0.3, render: 0.3, video: 0.3 };

async function toWorkerInput(t: GpuTask) {
  const inputs: Record<string, string> = {};
  for (const [name, key] of Object.entries(t.inputs)) inputs[name] = await storage.presignGet(key, 6 * 3600);
  const outputs: Record<string, { url: string; content_type: string }> = {};
  for (const [name, slot] of Object.entries(t.outputs))
    outputs[name] = {
      url: await storage.presignPut(slot.key, slot.contentType, 6 * 3600),
      content_type: slot.contentType,
    };
  return { task: t.task, params: t.params, inputs, outputs };
}

// ---------- backends ----------
// local: POST straight to a worker container (dev / mock contract tests). salad: SaladCloud Job Queues.
const backend = () => (process.env.GPU_BACKEND ?? "salad") as "salad" | "local";
const localUrl = (pool: string) =>
  process.env[`LOCAL_GPU_URL_${pool.toUpperCase()}`] ??
  `http://localhost:${{ image: 8101, tts: 8102, render: 8103, video: 8104 }[pool]}`;

async function finish(job: Job, t: GpuTask, out: WorkerOutput, startedAt: Date) {
  if (!out.ok)
    throw new HermesError(
      `GPU ${t.pool}/${t.task} failed: ${out.error}`,
      out.error_class === "transient" ? "transient" : "fatal",
    );
  const ids: Record<string, string> = {};
  for (const o of out.outputs ?? []) {
    const slot = t.outputs[o.name];
    if (!slot) continue;
    const [row] = await db
      .insert(artifacts)
      .values({
        kind: slot.kind,
        storageKey: slot.key,
        contentType: slot.contentType,
        bytes: o.bytes,
        sha256: o.sha256,
        showId: t.showId,
        sketchId: t.sketchId,
        meta: { ...slot.meta, ...o.meta, task: t.task, jobId: job.id },
      })
      .returning({ id: artifacts.id });
    ids[o.name] = row!.id;
  }
  const gpuSeconds = Number(out.metrics?.gpu_seconds ?? 0);
  await recordCost({
    showId: t.showId,
    sketchId: t.sketchId,
    jobId: job.id,
    stage: job.kind,
    provider: backend() === "salad" ? "salad" : "local",
    model: `${t.pool}/${t.task}`,
    gpuSeconds,
    usd: (gpuSeconds / 3600) * (USD_PER_GPU_HOUR[t.pool] ?? 0.3),
    meta: out.metrics ?? {},
  });
  const result = (await GPU_KINDS[job.kind]?.collect?.(job, ids, out)) ?? { artifacts: ids };
  await queue.complete(job, result, startedAt, WORKER_ID);
  await onSucceeded(job, result);
  log.info({ job: job.id, kind: job.kind, outputs: Object.keys(ids).length, gpuSeconds }, "gpu job done");
}

async function failJob(job: Job, err: unknown, startedAt: Date) {
  const retry = await queue.fail(job, err, startedAt, WORKER_ID);
  log.warn({ job: job.id, kind: job.kind, retry, err: (err as Error).message }, "gpu job failed");
  if (!retry) await onDead(job, err);
}

/** Claim one GPU job and dispatch it. Returns false if nothing to do. */
async function dispatchOne(pools: string[]): Promise<boolean> {
  const job = await queue.claim(
    pools.map((p) => `gpu:${p}`),
    WORKER_ID,
    LEASE_S,
  );
  if (!job) return false;
  const startedAt = new Date();
  try {
    const kind = GPU_KINDS[job.kind];
    if (!kind) throw new HermesError(`No GPU kind "${job.kind}"`, "fatal");
    const t = await kind.build(job);
    const input = await toWorkerInput(t);
    if (backend() === "local") {
      const res = await fetch(`${localUrl(t.pool)}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(30 * 60_000),
      });
      if (!res.ok)
        throw new HermesError(`local worker ${res.status}: ${(await res.text()).slice(0, 300)}`, "transient");
      await finish(job, t, (await res.json()) as WorkerOutput, startedAt);
    } else {
      const sj = await salad.submitJob(t.pool, input, { hermes_job_id: job.id });
      await db
        .update(jobs)
        .set({ externalId: sj.id, payload: { ...(job.payload as object), _task: t } })
        .where(eq(jobs.id, job.id));
      log.info({ job: job.id, salad: sj.id, pool: t.pool }, "submitted to Salad");
    }
  } catch (e) {
    await failJob(job, e, startedAt);
  }
  return true;
}

/** Check Salad for every in-flight GPU job; finish, fail or heartbeat each. */
async function pollSalad(): Promise<number> {
  const inflight = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "running"), like(jobs.queue, "gpu:%"), isNotNull(jobs.externalId)));
  for (const job of inflight) {
    const t = (job.payload as { _task: GpuTask })._task;
    try {
      const sj = await salad.getJob<unknown, WorkerOutput>(t.pool, job.externalId!);
      if (sj.status === "succeeded")
        await finish(job, t, sj.output ?? { ok: false, error: "no output" }, job.updatedAt);
      else if (sj.status === "failed" || sj.status === "cancelled")
        await failJob(job, new HermesError(`Salad job ${sj.status}`, "transient"), job.updatedAt);
      else await queue.heartbeat(job.id, WORKER_ID, LEASE_S);
    } catch (e) {
      log.warn({ job: job.id, err: (e as Error).message }, "salad poll error");
    }
  }
  return inflight.length;
}

export async function runGpuDispatcher(opts: { untilIdle?: boolean; pools?: string[] } = {}) {
  const pools = opts.pools ?? ["image", "tts", "render", "video"];
  await storage.ensureBucket();
  log.info({ backend: backend(), pools, bucket: env.S3_BUCKET }, "gpu dispatcher started");
  for (;;) {
    await queue.reapExpired();
    let worked = false;
    while (await dispatchOne(pools)) worked = true;
    const inflight = backend() === "salad" ? await pollSalad() : 0;
    if (opts.untilIdle && !worked && inflight === 0) return;
    await new Promise((r) => setTimeout(r, worked ? 500 : 5_000));
  }
}
