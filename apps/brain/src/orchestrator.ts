import { db, type Job, log, queue, schema } from "@hermes/core";
import { eq } from "drizzle-orm";
import { GPU_KINDS } from "./gpu-kinds.js";
import { nextStage, type SketchStage, STAGE_QUEUE } from "./pipeline.js";
import { PRODUCTION_HANDLERS } from "./production.js";
import { HANDLERS } from "./stages.js";

const { sketches, shows, premises } = schema;

/** Create a sketch from a premise and start it at the first stage. */
export async function startSketch(premiseId: string, opts: { batchTag?: string } = {}) {
  const [p] = await db.select().from(premises).where(eq(premises.id, premiseId));
  if (!p) throw new Error(`premise ${premiseId} not found`);
  const [show] = await db.select().from(shows).where(eq(shows.id, p.showId));
  const [s] = await db
    .insert(sketches)
    .values({
      showId: p.showId,
      showVersion: show!.currentVersion!,
      premiseId,
      stage: "draft",
      state: "in_progress",
      batchTag: opts.batchTag,
      features: { engine: p.engine, lead: p.leadCharacter },
    })
    .returning();
  await db.update(premises).set({ status: "used" }).where(eq(premises.id, premiseId));
  await enqueueStage(s!.id, s!.showId, "draft");
  return s!;
}

export async function enqueueStage(sketchId: string, showId: string, stage: SketchStage) {
  const built =
    STAGE_QUEUE[stage] === "cpu" ? Boolean(HANDLERS[stage] ?? PRODUCTION_HANDLERS[stage]) : Boolean(GPU_KINDS[stage]);
  if (!built) {
    // Not built yet: park the sketch at this stage; `hermes resume` re-enqueues once the handler exists.
    await db.update(sketches).set({ stage, state: "in_progress" }).where(eq(sketches.id, sketchId));
    log.info({ sketchId, stage }, "stage not built yet; sketch waiting");
    return null;
  }
  await db.update(sketches).set({ stage }).where(eq(sketches.id, sketchId));
  return queue.enqueue(
    stage,
    { sketchId },
    {
      queue: STAGE_QUEUE[stage],
      sketchId,
      showId,
      idempotencyKey: `${sketchId}:${stage}`,
    },
  );
}

/** Called after a job succeeds: advance the sketch, or act on a show-level result. */
export async function onSucceeded(job: Job, result: Record<string, unknown> | undefined) {
  if (job.kind === "ideation") {
    const showId = (job.payload as { showId: string }).showId;
    const [show] = await db.select().from(shows).where(eq(shows.id, showId));
    const ids = (result?.premiseIds as string[]) ?? [];
    const autoStart =
      (job.payload as { autoStart?: number }).autoStart ?? (show?.mode === "autopilot" ? show.dailyTarget : 0);
    for (const id of ids.slice(0, autoStart))
      await startSketch(id, { batchTag: (job.payload as { batchTag?: string }).batchTag });
    return;
  }
  if (!job.sketchId) return;
  const next = nextStage(job.kind);
  if (next) await enqueueStage(job.sketchId, job.showId!, next);
  else await db.update(sketches).set({ state: "awaiting_review" }).where(eq(sketches.id, job.sketchId));
}

/** Called when a job is dead (no more retries): park the sketch for the Medic. */
export async function onDead(job: Job, err: unknown) {
  if (!job.sketchId) return;
  await db
    .update(sketches)
    .set({
      state: "parked",
      lastError: `${job.kind}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 2000),
    })
    .where(eq(sketches.id, job.sketchId));
}
