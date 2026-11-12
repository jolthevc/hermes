import { KitManifest, type ShowContext, writers } from "@hermes/agents";
import { db, HermesError, type Job, schema } from "@hermes/core";
import { and, desc, eq } from "drizzle-orm";

const { sketches, scripts, shotScripts, shows, showVersions, premises, ideationBatches, lessons } = schema;

export type StageHandler = (job: Job) => Promise<Record<string, unknown> | undefined>;

export async function loadShowContext(showId: string, version?: number): Promise<ShowContext & { version: number }> {
  const [show] = await db.select().from(shows).where(eq(shows.id, showId));
  if (!show) throw new HermesError(`Unknown show ${showId}`, "invalid_input");
  const v = version ?? show.currentVersion;
  if (!v) throw new HermesError(`Show ${showId} has no approved version`, "invalid_input");
  const [sv] = await db
    .select()
    .from(showVersions)
    .where(and(eq(showVersions.showId, showId), eq(showVersions.version, v)));
  if (!sv) throw new HermesError(`Show ${showId} v${v} not found`, "invalid_input");
  const ls = await db
    .select({ lesson: lessons.lesson })
    .from(lessons)
    .where(and(eq(lessons.showId, showId), eq(lessons.active, true)))
    .limit(20);
  return {
    bible: sv.bible,
    kit: KitManifest.parse(sv.kit),
    lessons: ls.map((l) => l.lesson),
    dailyBudgetUsd: show.dailyBudgetUsd,
    version: v,
  };
}

async function loadSketch(job: Job) {
  if (!job.sketchId) throw new HermesError("Job has no sketch", "invalid_input");
  const [s] = await db.select().from(sketches).where(eq(sketches.id, job.sketchId));
  if (!s) throw new HermesError(`Sketch ${job.sketchId} missing`, "invalid_input");
  return s;
}

async function latestScript(sketchId: string, kind: string) {
  const [s] = await db
    .select()
    .from(scripts)
    .where(and(eq(scripts.sketchId, sketchId), eq(scripts.kind, kind)))
    .orderBy(desc(scripts.createdAt))
    .limit(1);
  if (!s) throw new HermesError(`No ${kind} script for sketch ${sketchId}`, "invalid_input");
  return s;
}

const ctxOf = (job: Job, showId: string) => ({ showId, sketchId: job.sketchId, jobId: job.id, stage: job.kind });

// ---------- show-level job: ideation ----------
export const ideate: StageHandler = async (job) => {
  const { showId, count } = job.payload as { showId: string; count: number };
  const show = await loadShowContext(showId);
  const recent = await db
    .select({ premise: premises.premise })
    .from(premises)
    .where(eq(premises.showId, showId))
    .orderBy(desc(premises.createdAt))
    .limit(60);
  const r = await writers.ideate(
    show,
    count,
    { showId, jobId: job.id, stage: "ideation" },
    recent.map((p) => p.premise),
  );
  const [batch] = await db
    .insert(ideationBatches)
    .values({ showId, showVersion: show.version, requested: count, pitchedRaw: r.pitchedText })
    .returning();
  const rows = await db
    .insert(premises)
    .values(
      r.chosen.map((p, i) => ({
        batchId: batch!.id,
        showId,
        rank: i + 1,
        premise: p.premise,
        game: p.game,
        button: p.button,
        engine: p.engine,
        leadCharacter: p.lead_character,
      })),
    )
    .returning({ id: premises.id });
  return { batchId: batch!.id, premiseIds: rows.map((r) => r.id) };
};

// ---------- sketch stages ----------
export const draft: StageHandler = async (job) => {
  const s = await loadSketch(job);
  const show = await loadShowContext(s.showId, s.showVersion);
  const [p] = await db.select().from(premises).where(eq(premises.id, s.premiseId!));
  if (!p) throw new HermesError("Sketch has no premise", "invalid_input");
  const text = await writers.draft(show, writers.pitchText(p), ctxOf(job, s.showId));
  await db.insert(scripts).values({ sketchId: s.id, kind: "draft", screenplay: text });
  return { chars: text.length };
};

export const punchup: StageHandler = async (job) => {
  const s = await loadSketch(job);
  const show = await loadShowContext(s.showId, s.showVersion);
  const d = await latestScript(s.id, "draft");
  const r = await writers.punchUp(show, d.screenplay, ctxOf(job, s.showId));
  await db.insert(scripts).values({ sketchId: s.id, kind: "final", screenplay: r.final, notes: r.notes });
  return { chars: r.final.length };
};

export const shotScript: StageHandler = async (job) => {
  const s = await loadSketch(job);
  const show = await loadShowContext(s.showId, s.showVersion);
  const f = await latestScript(s.id, "final");
  const ss = await writers.toShotScript(show, f.screenplay, ctxOf(job, s.showId));
  await db.insert(shotScripts).values({ sketchId: s.id, data: ss });
  await db
    .update(sketches)
    .set({
      title: ss.title,
      logline: ss.logline,
      runtimeS: ss.est_runtime_s,
      features: {
        cast: ss.cast,
        beats: ss.beats.length,
        inserts: ss.beats.filter((b) => b.realization === "insert").length,
        kit_requests: ss.kit_requests.map((k) => k.token),
      },
    })
    .where(eq(sketches.id, s.id));
  return { title: ss.title, runtime: ss.est_runtime_s };
};

export const HANDLERS: Record<string, StageHandler> = {
  ideation: ideate,
  draft,
  punchup,
  shot_script: shotScript,
};
