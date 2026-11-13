import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { db, env, HermesError, type Job, log, queue, recordCost, runpod, schema, storage, vast } from "@hermes/core";
import { and, eq, inArray, like, notInArray, sql } from "drizzle-orm";
import { onDead, onSucceeded } from "./orchestrator.js";

// GPU dispatcher. Providers are tried in GPU_BACKENDS order (default "vast,runpod"):
//  - vast:   the Brain rents on-demand Vast.ai instances per pool, sends jobs straight to our worker's
//            /process (per-instance token), and destroys instances after IDLE_MS. Cheapest.
//  - runpod: RunPod Serverless queue endpoints (/run + /status). Reliable fallback: takes jobs that have
//            waited FALLBACK_AFTER_S for the primary, and jobs whose primary host failed.
//  - local:  static worker URLs (docker compose mock workers) for contract tests.

const { jobs, artifacts, gpuInstances, infraKv } = schema;
const WORKER_ID = `gpu-dispatcher:${hostname()}:${process.pid}`;
const LEASE_S = 3 * 3600;

// ---------- task contract (mirrors workers/common/hermes_worker/server.py) ----------
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

// ---------- pool specs ----------
interface PoolSpec {
  minGpuRamMb: number;
  diskGb: number;
  maxInstances: number;
  runpodGpuTypes: string[];
}
export const POOLS: Record<Pool, PoolSpec> = {
  // FLUX.2 klein peaks at ~19 GB; Ampere+ for bf16 (enforced in the Vast offer search).
  image: {
    minGpuRamMb: 23_000,
    diskGb: 80,
    maxInstances: 2,
    runpodGpuTypes: ["NVIDIA GeForce RTX 4090", "NVIDIA GeForce RTX 3090", "NVIDIA RTX A5000", "NVIDIA L40S"],
  },
  tts: {
    minGpuRamMb: 15_000,
    diskGb: 60,
    maxInstances: 2,
    runpodGpuTypes: ["NVIDIA GeForce RTX 4090", "NVIDIA GeForce RTX 3090", "NVIDIA RTX A5000", "NVIDIA L40S"],
  },
  render: { minGpuRamMb: 15_000, diskGb: 60, maxInstances: 4, runpodGpuTypes: ["NVIDIA GeForce RTX 4090"] },
  video: { minGpuRamMb: 23_000, diskGb: 100, maxInstances: 2, runpodGpuTypes: ["NVIDIA GeForce RTX 4090"] },
};

const IDLE_MS = 10 * 60_000; // destroy an idle Vast instance after this
const READY_TIMEOUT_MS = 25 * 60_000; // image pull + weights download + model load
const FALLBACK_AFTER_S = 20 * 60; // jobs waiting longer than this go to the fallback provider
const RUNPOD_USD_PER_S = 0.00031; // ~$1.10/h for a 24 GB flex worker; refine from invoices

const backends = () =>
  (process.env.GPU_BACKEND ?? env.GPU_BACKENDS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// ---------- shared ----------
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

async function buildTask(job: Job): Promise<GpuTask> {
  const kind = GPU_KINDS[job.kind];
  if (!kind) throw new HermesError(`No GPU kind "${job.kind}"`, "fatal");
  return kind.build(job);
}

async function finish(
  job: Job,
  t: GpuTask,
  out: WorkerOutput,
  startedAt: Date,
  cost: { provider: string; usd: number; seconds: number; meta?: Record<string, unknown> },
) {
  if (!out.ok) {
    // "unknown task" = an older worker image; treat as transient so the job is retried elsewhere.
    const skew = /unknown task/.test(out.error ?? "");
    throw new HermesError(
      `GPU ${t.pool}/${t.task} failed: ${out.error}`,
      out.error_class === "transient" || skew ? "transient" : "fatal",
    );
  }
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
        meta: { ...slot.meta, ...o.meta, task: t.task, jobId: job.id, provider: cost.provider },
      })
      .returning({ id: artifacts.id });
    ids[o.name] = row!.id;
  }
  await recordCost({
    showId: t.showId,
    sketchId: t.sketchId,
    jobId: job.id,
    stage: job.kind,
    provider: cost.provider,
    model: `${t.pool}/${t.task}`,
    gpuSeconds: cost.seconds,
    usd: cost.usd,
    meta: { ...out.metrics, ...cost.meta },
  });
  const result = (await GPU_KINDS[job.kind]?.collect?.(job, ids, out)) ?? { artifacts: ids };
  await queue.complete(job, result, startedAt, WORKER_ID);
  await onSucceeded(job, result);
  log.info(
    { job: job.id, kind: job.kind, provider: cost.provider, seconds: cost.seconds, usd: +cost.usd.toFixed(5) },
    "gpu job done",
  );
}

async function failJob(job: Job, err: unknown, startedAt: Date, opts: { toFallback?: boolean } = {}) {
  // Host-level failures on the primary go straight to the fallback queue (no waiting).
  if (opts.toFallback && backends().includes("runpod") && !job.queue.endsWith(":fallback"))
    await db
      .update(jobs)
      .set({ queue: `${job.queue}:fallback` })
      .where(eq(jobs.id, job.id));
  const retry = await queue.fail(job, err, startedAt, WORKER_ID);
  log.warn({ job: job.id, kind: job.kind, retry, err: (err as Error).message }, "gpu job failed");
  if (!retry) await onDead(job, err);
}

async function queuedCount(pool: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), eq(jobs.queue, `gpu:${pool}`), sql`run_after <= now()`));
  return r?.n ?? 0;
}

async function workerImage(pool: string): Promise<string> {
  const [row] = await db.select().from(infraKv).where(eq(infraKv.key, "worker_images"));
  const img = (row?.value as Record<string, string> | undefined)?.[pool];
  if (!img) throw new HermesError(`No worker image for pool ${pool}; run: pnpm hermes infra:gpu --tag <tag>`, "fatal");
  return img;
}

// ---------- HTTP workers (Vast instances, local mocks) ----------
const running = new Map<string, Promise<void>>(); // instance id -> in-flight job

async function postJob(url: string, token: string, input: unknown): Promise<WorkerOutput> {
  let res: Response;
  try {
    res = await fetch(`${url}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hermes-Token": token },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(45 * 60_000),
    });
  } catch (e) {
    throw new HermesError(`worker unreachable: ${(e as Error).message}`, "transient");
  }
  if (!res.ok) throw new HermesError(`worker ${res.status}: ${(await res.text()).slice(0, 300)}`, "transient");
  return (await res.json()) as WorkerOutput;
}

async function healthy(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
    return r.ok && ((await r.json()) as { ready?: boolean }).ready === true;
  } catch {
    return false;
  }
}

/** Run one job on a ready HTTP worker in the background; the instance is busy until it settles. */
function runOnInstance(inst: typeof gpuInstances.$inferSelect, job: Job) {
  const started = new Date();
  const p = (async () => {
    await db.update(gpuInstances).set({ status: "busy", busyJobId: job.id }).where(eq(gpuInstances.id, inst.id));
    let hostFailure = false;
    try {
      const t = await buildTask(job);
      const out = await postJob(inst.url!, inst.token, await toWorkerInput(t)).catch((e) => {
        hostFailure = true;
        throw e;
      });
      const seconds = (Date.now() - started.getTime()) / 1000;
      await finish(job, t, out, started, {
        provider: inst.provider,
        seconds,
        usd: ((inst.dph ?? 0) * seconds) / 3600,
        meta: { instance: inst.id, gpu: inst.gpuName },
      });
    } catch (e) {
      await failJob(job, e, started, { toFallback: hostFailure });
      if (hostFailure && inst.provider === "vast") await retireInstance(inst, `host failure: ${(e as Error).message}`);
    } finally {
      await db
        .update(gpuInstances)
        .set({ status: "ready", busyJobId: null, lastActiveAt: new Date() })
        .where(and(eq(gpuInstances.id, inst.id), eq(gpuInstances.status, "busy")));
      running.delete(inst.id);
    }
  })();
  running.set(inst.id, p);
}

async function liveInstances(pool?: string) {
  const rows = await db
    .select()
    .from(gpuInstances)
    .where(notInArray(gpuInstances.status, ["destroyed", "failed"]));
  return pool ? rows.filter((r) => r.pool === pool) : rows;
}

/** Destroy a Vast instance and book its unattributed time (startup + idle) as overhead cost. */
async function retireInstance(
  inst: typeof gpuInstances.$inferSelect,
  reason: string,
  status: "destroyed" | "failed" = "destroyed",
) {
  try {
    await vast.destroyInstance(Number(inst.providerId));
  } catch (e) {
    if (!/404|no_such/.test((e as Error).message)) {
      log.error(
        { instance: inst.id, err: (e as Error).message },
        "VAST DESTROY FAILED — instance may still be billing",
      );
      return;
    }
  }
  const lifetimeS = (Date.now() - inst.createdAt.getTime()) / 1000;
  const [{ jobS } = { jobS: 0 }] = await db.execute<{ jobS: number }>(
    sql`select coalesce(sum(gpu_seconds), 0)::float as "jobS" from cost_ledger where meta->>'instance' = ${inst.id}`,
  );
  const overheadS = Math.max(0, lifetimeS - Number(jobS));
  await recordCost({
    stage: "gpu:overhead",
    provider: "vast",
    model: inst.pool,
    gpuSeconds: overheadS,
    usd: ((inst.dph ?? 0) * overheadS) / 3600,
    meta: { instance: inst.id, gpu: inst.gpuName, lifetimeS: Math.round(lifetimeS), reason },
  });
  await db
    .update(gpuInstances)
    .set({ status, destroyedAt: new Date(), lastError: reason })
    .where(eq(gpuInstances.id, inst.id));
  log.info(
    {
      instance: inst.id,
      reason,
      lifetimeMin: +(lifetimeS / 60).toFixed(1),
      overheadUsd: +(((inst.dph ?? 0) * overheadS) / 3600).toFixed(4),
    },
    "vast instance retired",
  );
}

// ---------- Vast fleet ----------
async function provisionVast(pool: Pool) {
  const spec = POOLS[pool];
  // Avoid machines that failed us recently.
  const bad = await db
    .select({ m: gpuInstances.machineId })
    .from(gpuInstances)
    .where(and(eq(gpuInstances.status, "failed"), sql`created_at > now() - interval '24 hours'`));
  const offers = await vast.searchOffers({
    minGpuRamMb: spec.minGpuRamMb,
    minDiskGb: spec.diskGb,
    excludeMachineIds: bad.map((b) => Number(b.m)).filter(Boolean),
    limit: 5,
  });
  if (!offers.length) throw new HermesError(`no Vast offers for pool ${pool}`, "transient");
  const image = await workerImage(pool);
  for (const offer of offers) {
    const token = randomBytes(24).toString("hex");
    try {
      const id = await vast.createInstance({
        offerId: offer.id,
        image,
        diskGb: spec.diskGb,
        label: `hermes-${pool}`,
        env: { HERMES_WORKER_TOKEN: token, PORT: "8000", HF_HOME: "/models" },
        ports: [8000],
      });
      await db.insert(gpuInstances).values({
        id: `vast:${id}`,
        provider: "vast",
        pool,
        providerId: String(id),
        status: "provisioning",
        token,
        image,
        dph: offer.dph_total,
        gpuName: offer.gpu_name,
        machineId: String(offer.machine_id),
      });
      log.info(
        { pool, instance: id, gpu: offer.gpu_name, dph: +offer.dph_total.toFixed(3), geo: offer.geolocation },
        "vast instance created",
      );
      return;
    } catch (e) {
      log.warn({ pool, offer: offer.id, err: (e as Error).message }, "vast offer failed; trying next");
    }
  }
  throw new HermesError(`all Vast offers failed for pool ${pool}`, "transient");
}

async function reconcileVast() {
  for (const inst of await liveInstances()) {
    if (inst.provider !== "vast") continue;
    if (inst.status === "provisioning") {
      const vi = await vast.getInstance(Number(inst.providerId)).catch(() => null);
      const st = vi?.actual_status ?? "";
      if (["exited", "offline", "unknown"].includes(st) || Date.now() - inst.createdAt.getTime() > READY_TIMEOUT_MS) {
        await retireInstance(inst, `never became ready (status=${st || "none"})`, "failed");
        continue;
      }
      const url = vi ? vast.portUrl(vi, 8000) : null;
      if (st === "running" && url && (await healthy(url))) {
        await db
          .update(gpuInstances)
          .set({ status: "ready", url, readyAt: new Date(), lastActiveAt: new Date() })
          .where(eq(gpuInstances.id, inst.id));
        log.info(
          {
            instance: inst.id,
            url: url.replace(/:\d+$/, ":<port>"),
            startupMin: +((Date.now() - inst.createdAt.getTime()) / 60000).toFixed(1),
          },
          "vast instance ready",
        );
      } else if (url && !inst.url) await db.update(gpuInstances).set({ url }).where(eq(gpuInstances.id, inst.id));
    } else if (inst.status === "busy" && !running.has(inst.id)) {
      // Dispatcher restarted mid-job: the job's lease will expire and it gets retried; free the instance.
      await db.update(gpuInstances).set({ status: "ready", busyJobId: null }).where(eq(gpuInstances.id, inst.id));
    } else if (inst.status === "ready") {
      const idle = Date.now() - inst.lastActiveAt.getTime() > IDLE_MS && (await queuedCount(inst.pool)) === 0;
      if (idle) await retireInstance(inst, "idle");
    }
  }
}

/** Destroy any Vast instance labelled hermes-* that we aren't tracking (e.g. after a crash mid-create). */
export async function sweepVastOrphans() {
  const tracked = new Set((await liveInstances()).filter((i) => i.provider === "vast").map((i) => i.providerId));
  for (const vi of await vast.listInstances()) {
    if (!vi.label?.startsWith("hermes-") || tracked.has(String(vi.id))) continue;
    log.warn({ instance: vi.id, label: vi.label }, "destroying untracked hermes Vast instance");
    await vast.destroyInstance(vi.id).catch((e) => log.error({ err: (e as Error).message }, "orphan destroy failed"));
  }
}

const provisionFailures: Record<string, number[]> = {};

async function scaleVast(pools: Pool[]) {
  for (const pool of pools) {
    const queued = await queuedCount(pool);
    if (!queued) continue;
    const alive = (await liveInstances(pool)).length;
    const want = Math.min(POOLS[pool].maxInstances, Math.max(1, Math.ceil(queued / 3)));
    // Circuit breaker: after 3 provisioning failures in 30 min, stop and let the fallback serve.
    const recent = (provisionFailures[pool] ?? []).filter((t) => Date.now() - t < 30 * 60_000);
    provisionFailures[pool] = recent;
    if (alive >= want || recent.length >= 3) continue;
    try {
      await provisionVast(pool);
    } catch (e) {
      recent.push(Date.now());
      log.warn({ pool, err: (e as Error).message }, "vast provisioning failed");
    }
  }
}

async function dispatchHttp(pools: Pool[]) {
  let n = 0;
  for (const inst of await liveInstances()) {
    if (inst.status !== "ready" || running.has(inst.id) || !pools.includes(inst.pool as Pool)) continue;
    const job = await queue.claim([`gpu:${inst.pool}`], WORKER_ID, LEASE_S);
    if (!job) continue;
    runOnInstance(inst, job);
    n++;
  }
  return n;
}

// ---------- local static workers (mock contract tests) ----------
async function ensureLocalInstances(pools: Pool[]) {
  for (const pool of pools) {
    const url =
      process.env[`LOCAL_GPU_URL_${pool.toUpperCase()}`] ??
      `http://localhost:${{ image: 8101, tts: 8102, render: 8103, video: 8104 }[pool]}`;
    const id = `local:${pool}`;
    const [row] = await db.select().from(gpuInstances).where(eq(gpuInstances.id, id));
    if (row && row.status !== "destroyed") continue;
    if (!(await healthy(url))) continue;
    await db
      .insert(gpuInstances)
      .values({
        id,
        provider: "local",
        pool,
        providerId: pool,
        status: "ready",
        url,
        token: "",
        image: "local",
        dph: 0,
      })
      .onConflictDoUpdate({ target: gpuInstances.id, set: { status: "ready", url, destroyedAt: null } });
  }
}

// ---------- RunPod (fallback) ----------
async function runpodEndpoint(pool: string): Promise<string | null> {
  const [row] = await db.select().from(infraKv).where(eq(infraKv.key, "runpod_endpoints"));
  return (row?.value as Record<string, string> | undefined)?.[pool] ?? null;
}

// When this dispatcher first saw each queued primary-queue job. The fallback wait is measured from here,
// so a job that sat in a hold (or through a dispatcher restart) still gets a fair chance on the primary.
const firstSeen = new Map<number, number>();

async function overdueForFallback(pool: string, waitedSeconds: number): Promise<number[]> {
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), eq(jobs.queue, `gpu:${pool}`), sql`run_after <= now()`));
  const now = Date.now();
  const due: number[] = [];
  for (const { id } of rows) {
    if (!firstSeen.has(id)) firstSeen.set(id, now);
    if (now - firstSeen.get(id)! >= waitedSeconds * 1000) due.push(id);
  }
  return due;
}

async function dispatchRunpod(pools: Pool[], waitedSeconds: number) {
  let n = 0;
  for (const pool of pools) {
    const endpoint = await runpodEndpoint(pool);
    if (!endpoint) continue;
    const overdue = await overdueForFallback(pool, waitedSeconds);
    for (;;) {
      // Jobs explicitly sent to fallback go immediately; primary-queue jobs only once overdue.
      const job =
        (await queue.claim([`gpu:${pool}:fallback`], WORKER_ID, LEASE_S)) ??
        (await queue.claim([`gpu:${pool}`], WORKER_ID, LEASE_S, 0, overdue));
      if (!job) break;
      const started = new Date();
      try {
        const t = await buildTask(job);
        const rj = await runpod.run(endpoint, await toWorkerInput(t));
        await db
          .update(jobs)
          .set({ externalId: `runpod:${endpoint}:${rj.id}`, payload: { ...(job.payload as object), _task: t } })
          .where(eq(jobs.id, job.id));
        log.info({ job: job.id, kind: job.kind, pool, runpod: rj.id }, "submitted to RunPod");
        n++;
      } catch (e) {
        await failJob(job, e, started);
      }
    }
  }
  return n;
}

async function pollRunpod() {
  const inflight = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "running"), like(jobs.externalId, "runpod:%")));
  for (const job of inflight) {
    const [, endpoint, id] = job.externalId!.split(":");
    const t = (job.payload as { _task: GpuTask })._task;
    try {
      const s = await runpod.status<WorkerOutput>(endpoint!, id!);
      if (s.status === "COMPLETED") {
        const seconds = (s.executionTime ?? 0) / 1000;
        try {
          await finish(job, t, s.output ?? { ok: false, error: "no output" }, job.updatedAt, {
            provider: "runpod",
            seconds,
            usd: seconds * RUNPOD_USD_PER_S,
            meta: { delayMs: s.delayTime, executionMs: s.executionTime },
          });
        } catch (e) {
          await failJob(job, e, job.updatedAt);
        }
      } else if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(s.status))
        await failJob(job, new HermesError(`RunPod job ${s.status}: ${s.error ?? ""}`, "transient"), job.updatedAt);
      else await queue.heartbeat(job.id, WORKER_ID, LEASE_S);
    } catch (e) {
      log.warn({ job: job.id, err: (e as Error).message }, "runpod poll error");
    }
  }
  return inflight.length;
}

// ---------- loop ----------
export async function runGpuDispatcher(opts: { untilIdle?: boolean; pools?: Pool[] } = {}) {
  const pools = opts.pools ?? (["image", "tts", "render", "video"] as Pool[]);
  const order = backends();
  await storage.ensureBucket();
  // A previous dispatcher may have died mid-job: free its instances (their jobs' leases expire and retry).
  await db.update(gpuInstances).set({ status: "ready", busyJobId: null }).where(eq(gpuInstances.status, "busy"));
  if (order.includes("vast")) await sweepVastOrphans();
  log.info({ backends: order, pools, bucket: env.S3_BUCKET }, "gpu dispatcher started");
  for (;;) {
    await queue.reapExpired();
    let worked = 0;
    if (order[0] === "local") await ensureLocalInstances(pools);
    if (order.includes("vast")) {
      await reconcileVast().catch((e) => log.warn({ err: (e as Error).message }, "vast reconcile"));
      await scaleVast(pools).catch((e) => log.warn({ err: (e as Error).message }, "vast scale"));
    }
    worked += await dispatchHttp(pools);
    if (order.includes("runpod")) {
      // Primary vast: fallback after FALLBACK_AFTER_S. RunPod as primary: immediately.
      worked += await dispatchRunpod(pools, order[0] === "runpod" ? 0 : FALLBACK_AFTER_S);
    }
    const rpInflight = order.includes("runpod") ? await pollRunpod() : 0;

    if (opts.untilIdle) {
      const [{ n } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(jobs)
        .where(and(like(jobs.queue, "gpu:%"), inArray(jobs.status, ["queued", "running"])));
      if (n === 0 && running.size === 0 && rpInflight === 0 && worked === 0) {
        // Tear down: nothing should keep billing after an --until-idle run.
        for (const inst of await liveInstances())
          if (inst.provider === "vast") await retireInstance(inst, "until-idle done");
        return;
      }
    }
    await new Promise((r) => setTimeout(r, worked ? 1_000 : 5_000));
  }
}

/** Status of the GPU fleet for the CLI. */
export async function fleetStatus() {
  return liveInstances();
}
