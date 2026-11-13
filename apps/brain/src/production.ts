import { director, ShotScript } from "@hermes/agents";
import { db, HermesError, type Job, log, schema, storage } from "@hermes/core";
import { and, desc, eq } from "drizzle-orm";
import { GPU_KINDS } from "./gpu-kinds.js";
import type { StageHandler } from "./stages.js";

// Frames-first production stages (docs/PLAN.md): direct -> voice -> animatic -> keyframes -> animate -> edit.

const { sketches, shotScripts, shotLists, showVersions, artifacts } = schema;

type Look = {
  brief?: {
    directions: { style_prompt: string }[];
    characters: { name: string; design_prompt: string; framing_rule: string }[];
    background_prompts: { name: string; prompt: string }[];
  };
  style?: number;
  board?: { key: string };
};
type Voices = { cast?: Record<string, { key: string; refText: string; instruct: string }> };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export async function sketchContext(sketchId: string) {
  const [s] = await db.select().from(sketches).where(eq(sketches.id, sketchId));
  if (!s) throw new HermesError(`sketch ${sketchId} missing`, "invalid_input");
  const [v] = await db
    .select()
    .from(showVersions)
    .where(and(eq(showVersions.showId, s.showId), eq(showVersions.version, s.showVersion)));
  if (!v) throw new HermesError(`show version ${s.showId} v${s.showVersion} missing`, "invalid_input");
  const look = v.look as Look;
  if (!look.brief || look.style === undefined)
    throw new HermesError(`show ${s.showId} v${s.showVersion} has no approved look`, "invalid_input");
  const cast = look.brief.characters.map((c) => ({
    name: c.name,
    design: c.design_prompt,
    framing_rule: c.framing_rule,
  }));
  // Script names are often short ("Grimsby"); cast names are full ("Pell Grimsby"). Match loosely.
  const resolve = (name: string) => {
    const n = name.toLowerCase().trim();
    return cast.find(
      (c) => c.name.toLowerCase() === n || c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase()),
    );
  };
  const voices = (v.voices as Voices).cast ?? {};
  const voiceFor = (name: string) => {
    const c = resolve(name);
    const key = Object.keys(voices).find((k) => k.toLowerCase() === (c?.name ?? name).toLowerCase());
    return key ? { name: c?.name ?? name, ...voices[key]! } : null;
  };
  return {
    sketch: s,
    version: v,
    look,
    cast,
    resolve,
    voiceFor,
    style: look.brief.directions[look.style]!.style_prompt,
  };
}

async function latestShotList(sketchId: string) {
  const [row] = await db
    .select()
    .from(shotLists)
    .where(eq(shotLists.sketchId, sketchId))
    .orderBy(desc(shotLists.version))
    .limit(1);
  if (!row) throw new HermesError(`no shot list for ${sketchId}`, "invalid_input");
  return { row, sl: director.ShotList.parse(row.data) };
}

// ---------- direct (CPU) ----------
export const directHandler: StageHandler = async (job) => {
  const ctx = await sketchContext(job.sketchId!);
  const [ss] = await db
    .select()
    .from(shotScripts)
    .where(eq(shotScripts.sketchId, ctx.sketch.id))
    .orderBy(desc(shotScripts.createdAt))
    .limit(1);
  if (!ss) throw new HermesError("no shot script", "invalid_input");
  const script = ShotScript.parse(ss.data);
  const sl = await director.directShots(
    { script, cast: ctx.cast, backgrounds: ctx.look.brief!.background_prompts.map((b) => b.name) },
    { showId: ctx.sketch.showId, sketchId: ctx.sketch.id, jobId: job.id, stage: "direct" },
  );
  // Normalize names to the cast so later stages can find references and voices.
  for (const s of sl.shots) {
    s.characters = s.characters.map((c) => ctx.resolve(c)?.name ?? c);
    if (s.speaker) s.speaker = ctx.resolve(s.speaker)?.name ?? s.speaker;
  }
  for (const l of sl.lines) l.character = ctx.resolve(l.character)?.name ?? l.character;
  const problems = director.validateShotList(
    sl,
    ctx.cast.map((c) => c.name),
  );
  if (problems.length) throw new HermesError(`shot list invalid: ${problems.slice(0, 5).join("; ")}`, "bad_output");
  const [prev] = await db
    .select({ v: shotLists.version })
    .from(shotLists)
    .where(eq(shotLists.sketchId, ctx.sketch.id))
    .orderBy(desc(shotLists.version))
    .limit(1);
  await db.insert(shotLists).values({ sketchId: ctx.sketch.id, version: (prev?.v ?? 0) + 1, data: sl });
  return { shots: sl.shots.length, lines: sl.lines.length, types: sl.shots.map((s) => s.type).join(",") };
};

// ---------- voice (GPU, tts pool) ----------
GPU_KINDS.voice = {
  build: async (job) => {
    const ctx = await sketchContext(job.sketchId!);
    const { sl } = await latestShotList(ctx.sketch.id);
    const inputs: Record<string, string> = {};
    const voices: Record<string, { ref: string; ref_text: string }> = {};
    const lines: { id: number; voice: string; text: string }[] = [];
    for (const l of sl.lines) {
      const v = ctx.voiceFor(l.character);
      if (!v) throw new HermesError(`no approved voice for ${l.character}`, "invalid_input");
      const vs = slug(v.name);
      if (!voices[vs]) {
        inputs[`ref_${vs}`] = v.key;
        voices[vs] = { ref: `ref_${vs}`, ref_text: v.refText };
      }
      lines.push({ id: l.id, voice: vs, text: l.text });
    }
    return {
      pool: "tts",
      task: "voice_lines_multi",
      showId: ctx.sketch.showId,
      sketchId: ctx.sketch.id,
      params: { voices, lines },
      inputs,
      outputs: Object.fromEntries(
        lines.map((l) => [
          `line_${l.id}`,
          {
            key: storage.artifactKey(
              ctx.sketch.showId,
              ctx.sketch.id,
              `voice/line-${String(l.id).padStart(2, "0")}.wav`,
            ),
            contentType: "audio/wav",
            kind: "line_audio",
            meta: { line_id: l.id, voice: l.voice },
          },
        ]),
      ),
    };
  },
};

async function lineAudio(sketchId: string) {
  const rows = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.sketchId, sketchId), eq(artifacts.kind, "line_audio")))
    .orderBy(desc(artifacts.createdAt));
  const byLine = new Map<number, (typeof rows)[number]>();
  for (const r of rows) {
    const id = (r.meta as { line_id: number }).line_id;
    if (!byLine.has(id)) byLine.set(id, r); // newest take wins
  }
  return byLine;
}

// ---------- animatic gate (CPU, deterministic) ----------
export interface TimelineShot {
  id: string;
  start_s: number;
  duration_s: number;
  lines: { id: number; start_s: number; duration_s: number; key: string }[];
}

const LINE_GAP_S = 0.25; // breath between consecutive lines in the same shot

export const animaticHandler: StageHandler = async (job) => {
  const { sl } = await latestShotList(job.sketchId!);
  const audio = await lineAudio(job.sketchId!);
  const timeline: TimelineShot[] = [];
  let t = 0;
  for (const s of sl.shots) {
    const lines: TimelineShot["lines"] = [];
    let cursor = 0.2; // tiny lead-in so a line never starts on the cut
    for (const id of s.line_ids) {
      const a = audio.get(id);
      if (!a) throw new HermesError(`no audio for line ${id}`, "invalid_input");
      const d = Number((a.meta as { duration_s?: number }).duration_s ?? 0);
      lines.push({ id, start_s: +cursor.toFixed(3), duration_s: d, key: a.storageKey });
      cursor += d + LINE_GAP_S;
    }
    const spoken = lines.length ? cursor - LINE_GAP_S : 0;
    const duration = Math.max(s.min_duration_s, spoken) + s.hold_after_s;
    timeline.push({ id: s.id, start_s: +t.toFixed(3), duration_s: +duration.toFixed(3), lines });
    t += duration;
  }
  const problems: string[] = [];
  if (t > 60) problems.push(`runtime ${t.toFixed(1)}s > 60s`);
  for (const s of timeline) if (s.duration_s < 0.8) problems.push(`${s.id} only ${s.duration_s}s`);
  const [sk] = await db.select().from(sketches).where(eq(sketches.id, job.sketchId!));
  await db
    .update(sketches)
    .set({ runtimeS: t, features: { ...(sk!.features as object), timeline, animatic_problems: problems } })
    .where(eq(sketches.id, job.sketchId!));
  log.info({ sketch: job.sketchId, runtime: +t.toFixed(1), shots: timeline.length, problems }, "animatic timed");
  if (problems.some((p) => p.startsWith("runtime")))
    throw new HermesError(`animatic gate failed: ${problems.join("; ")}`, "invalid_input");
  return { runtime_s: +t.toFixed(1), shots: timeline.length, problems };
};

export const PRODUCTION_HANDLERS: Record<string, StageHandler> = {
  direct: directHandler,
  animatic: animaticHandler,
};

export type { Job };
export { latestShotList, lineAudio };
