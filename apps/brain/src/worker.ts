import { hostname } from "node:os";
import { log, queue } from "@hermes/core";
import { KIT_HANDLERS } from "./kit.js";
import { PARTS_HANDLERS } from "./kit-parts.js";
import { onDead, onSucceeded } from "./orchestrator.js";
import { HANDLERS as SKETCH_HANDLERS } from "./stages.js";

const HANDLERS = { ...SKETCH_HANDLERS, ...KIT_HANDLERS, ...PARTS_HANDLERS };

const WORKER_ID = `${hostname()}:${process.pid}`;

/** Process one job. Returns false when the queue is empty. */
export async function runOne(queues = ["cpu"]): Promise<boolean> {
  await queue.reapExpired();
  const job = await queue.claim(queues, WORKER_ID);
  if (!job) return false;
  const startedAt = new Date();
  const handler = HANDLERS[job.kind];
  const beat = setInterval(() => queue.heartbeat(job.id, WORKER_ID).catch(() => {}), 60_000);
  try {
    if (!handler) throw new Error(`No handler for job kind "${job.kind}"`);
    log.info({ job: job.id, kind: job.kind, attempt: job.attempts, sketch: job.sketchId }, "job start");
    const result = await handler(job);
    await queue.complete(job, result, startedAt, WORKER_ID);
    await onSucceeded(job, result);
    log.info({ job: job.id, kind: job.kind, ms: Date.now() - startedAt.getTime() }, "job done");
  } catch (err) {
    const retry = await queue.fail(job, err, startedAt, WORKER_ID);
    log.warn({ job: job.id, kind: job.kind, retry, err: (err as Error).message }, "job failed");
    if (!retry) await onDead(job, err);
  } finally {
    clearInterval(beat);
  }
  return true;
}

/** Long-running worker loop with N concurrent slots. */
export async function runLoop(opts: { concurrency?: number; untilIdle?: boolean; queues?: string[] } = {}) {
  const slots = opts.concurrency ?? 3;
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
    log.info("stopping after current jobs");
  });
  await Promise.all(
    Array.from({ length: slots }, async () => {
      while (!stopping) {
        const worked = await runOne(opts.queues).catch((e) => {
          log.error({ err: (e as Error).message }, "worker error");
          return false;
        });
        if (!worked) {
          if (opts.untilIdle) return;
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
    }),
  );
}
