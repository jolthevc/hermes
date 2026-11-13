import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db, rawSql } from "./db/client.js";
import { incidents, jobs, stageRuns } from "./db/schema.js";
import { backoffMs, classify, type ErrorClass, isHermesError, RETRY_POLICY } from "./errors.js";

// Durable Postgres job queue. Claims use FOR UPDATE SKIP LOCKED with a lease; expired leases
// are reclaimed by the reaper, so a crashed worker never loses a job. Language-agnostic: GPU
// orchestration and future workers use the same table.

export type Job = typeof jobs.$inferSelect;

export interface EnqueueOptions {
  queue?: string;
  sketchId?: string | null;
  showId?: string | null;
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
  idempotencyKey?: string;
}

export async function enqueue(kind: string, payload: Record<string, unknown>, o: EnqueueOptions = {}) {
  const [row] = await db
    .insert(jobs)
    .values({
      kind,
      payload,
      queue: o.queue ?? "cpu",
      sketchId: o.sketchId ?? null,
      showId: o.showId ?? null,
      priority: o.priority ?? 100,
      // Default to the DB clock (column default) so local clock skew can't delay jobs.
      ...(o.runAfter ? { runAfter: o.runAfter } : {}),
      maxAttempts: o.maxAttempts ?? 6,
      idempotencyKey: o.idempotencyKey,
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning();
  return row ?? null; // null = already enqueued under this idempotency key
}

/**
 * Claim the next due job. `waitedSeconds` only claims jobs that have been due for at least that long:
 * the GPU dispatcher uses it to hand jobs to a fallback provider when the primary hasn't served them in time.
 */
export async function claim(
  queues: string[],
  workerId: string,
  leaseSeconds = 900,
  waitedSeconds = 0,
  onlyIds?: number[],
): Promise<Job | null> {
  if (onlyIds && onlyIds.length === 0) return null;
  const rows = await rawSql<Job[]>`
    UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = ${workerId},
      locked_until = now() + make_interval(secs => ${leaseSeconds}), updated_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND queue = ANY(${queues})
        AND run_after <= now() - make_interval(secs => ${waitedSeconds})
        ${onlyIds ? rawSql`AND id = ANY(${onlyIds})` : rawSql``}
      ORDER BY priority, run_after, id
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id, queue, kind, payload, status, priority, attempts, max_attempts AS "maxAttempts",
      run_after AS "runAfter", locked_by AS "lockedBy", locked_until AS "lockedUntil", last_error AS "lastError",
      error_class AS "errorClass", result, sketch_id AS "sketchId", show_id AS "showId",
      idempotency_key AS "idempotencyKey", external_id AS "externalId", created_at AS "createdAt", updated_at AS "updatedAt"`;
  return rows[0] ?? null;
}

export async function heartbeat(jobId: number, workerId: string, leaseSeconds = 900) {
  await db
    .update(jobs)
    .set({ lockedUntil: sql`now() + make_interval(secs => ${leaseSeconds})` })
    .where(and(eq(jobs.id, jobId), eq(jobs.lockedBy, workerId)));
}

async function recordRun(job: Job, status: string, startedAt: Date, worker: string, errClass?: string, err?: string) {
  await db.insert(stageRuns).values({
    jobId: job.id,
    sketchId: job.sketchId,
    stage: job.kind,
    attempt: job.attempts,
    status,
    worker,
    startedAt,
    finishedAt: new Date(),
    durationMs: Date.now() - startedAt.getTime(),
    errorClass: errClass,
    error: err?.slice(0, 4000),
  });
}

export async function complete(job: Job, result: unknown, startedAt: Date, worker: string) {
  await db
    .update(jobs)
    .set({ status: "succeeded", result: result ?? null, lockedBy: null, lockedUntil: null, lastError: null })
    .where(eq(jobs.id, job.id));
  await recordRun(job, "succeeded", startedAt, worker);
}

/** Records the failure and either schedules a retry or marks the job dead. Returns true if it will retry. */
export async function fail(job: Job, err: unknown, startedAt: Date, worker: string): Promise<boolean> {
  const cls: ErrorClass = classify(err);
  const policy = RETRY_POLICY[cls];
  const msg = err instanceof Error ? err.message : String(err);
  const maxAttempts = Math.min(job.maxAttempts, policy.maxAttempts);
  const willRetry = policy.retry && job.attempts < maxAttempts;
  const hint = isHermesError(err) ? err.retryAfterMs : undefined;
  await db
    .update(jobs)
    .set({
      status: willRetry ? "queued" : "dead",
      runAfter: willRetry
        ? sql`now() + make_interval(secs => ${backoffMs(policy, job.attempts, hint) / 1000})`
        : undefined,
      lastError: msg.slice(0, 4000),
      errorClass: cls,
      lockedBy: null,
      lockedUntil: null,
    })
    .where(eq(jobs.id, job.id));
  await recordRun(job, "failed", startedAt, worker, cls, msg);
  if (!willRetry) {
    await db.insert(incidents).values({
      severity: cls === "budget" ? "warn" : "error",
      source: job.kind,
      errorClass: cls,
      message: msg.slice(0, 2000),
      sketchId: job.sketchId,
      jobId: job.id,
      context: { attempts: job.attempts, queue: job.queue },
    });
  }
  return willRetry;
}

/** Requeue jobs whose worker died mid-run (lease expired). */
export async function reapExpired(): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ status: "queued", lockedBy: null, lockedUntil: null, lastError: "lease expired (worker lost)" })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedUntil, sql`now()`)))
    .returning({ id: jobs.id });
  return rows.length;
}

export async function queueDepth(queues: string[]) {
  const rows = await db
    .select({ queue: jobs.queue, status: jobs.status, n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(inArray(jobs.queue, queues))
    .groupBy(jobs.queue, jobs.status);
  return rows;
}
