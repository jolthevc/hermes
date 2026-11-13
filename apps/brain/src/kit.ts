import { kit as kitAgents } from "@hermes/agents";
import { db, HermesError, type Job, queue, schema, storage } from "@hermes/core";
import { and, desc, eq, isNull } from "drizzle-orm";
import { GPU_KINDS } from "./gpu-kinds.js";
import type { StageHandler } from "./stages.js";

// Show creation (once per show): Art Director → style boards (human picks) → character/expression sheets
// + backgrounds; Casting → voice auditions (human picks). Picks land in a DRAFT show version, which the
// human approves with `hermes show:approve`. Sketches only ever use approved versions.

const { shows, showVersions } = schema;

type Look = {
  brief?: kitAgents.StyleBrief;
  style?: number;
  board?: { artifactId: string; key: string };
};
type Voices = {
  brief?: kitAgents.VoiceBrief;
  cast?: Record<string, { artifactId: string; key: string; refText: string; instruct: string }>;
};

export async function getOrCreateDraft(showId: string) {
  const [draft] = await db
    .select()
    .from(showVersions)
    .where(and(eq(showVersions.showId, showId), isNull(showVersions.approvedAt)))
    .orderBy(desc(showVersions.version))
    .limit(1);
  if (draft) return draft;
  const [latest] = await db
    .select()
    .from(showVersions)
    .where(eq(showVersions.showId, showId))
    .orderBy(desc(showVersions.version))
    .limit(1);
  if (!latest) throw new HermesError(`Show ${showId} has no versions; run show:import first`, "invalid_input");
  const [created] = await db
    .insert(showVersions)
    .values({
      showId,
      version: latest.version + 1,
      bible: latest.bible,
      kit: latest.kit,
      voices: latest.voices,
      look: latest.look,
    })
    .returning();
  return created!;
}

async function patchDraft(id: string, patch: { look?: Look; voices?: Voices }) {
  await db.update(showVersions).set(patch).where(eq(showVersions.id, id));
}

export async function approveDraft(showId: string, by: string) {
  const draft = await getOrCreateDraft(showId);
  await db.update(showVersions).set({ approvedAt: new Date(), approvedBy: by }).where(eq(showVersions.id, draft.id));
  await db.update(shows).set({ currentVersion: draft.version }).where(eq(shows.id, showId));
  return draft.version;
}

const payloadOf = (job: Job) => job.payload as Record<string, unknown> & { showId: string };

// ---------- CPU handlers ----------
export const styleBriefHandler: StageHandler = async (job) => {
  const { showId } = payloadOf(job);
  const draft = await getOrCreateDraft(showId);
  const brief = await kitAgents.styleBrief(draft.bible, { showId, jobId: job.id, stage: job.kind });
  await patchDraft(draft.id, { look: { ...(draft.look as Look), brief } });
  for (const [i] of brief.directions.entries()) {
    await queue.enqueue(
      "kit:boards",
      { showId, version: draft.version, direction: i },
      { queue: "gpu:image", showId, idempotencyKey: `${draft.id}:boards:${i}` },
    );
  }
  return { directions: brief.directions.map((d) => d.name), characters: brief.characters.map((c) => c.name) };
};

export const voiceBriefHandler: StageHandler = async (job) => {
  const { showId } = payloadOf(job);
  const draft = await getOrCreateDraft(showId);
  const brief = await kitAgents.voiceBrief(draft.bible, { showId, jobId: job.id, stage: job.kind });
  await patchDraft(draft.id, { voices: { ...(draft.voices as Voices), brief } });
  for (const v of brief.voices) {
    await queue.enqueue(
      "cast:auditions",
      { showId, version: draft.version, character: v.character },
      { queue: "gpu:tts", showId, idempotencyKey: `${draft.id}:audition:${v.character}` },
    );
  }
  return { characters: brief.voices.map((v) => v.character) };
};

/** Human picked a style direction (and optionally a specific board): queue character sheets + backgrounds. */
export async function pickStyle(showId: string, direction: number, boardArtifactId: string, boardKey: string) {
  const draft = await getOrCreateDraft(showId);
  const look = draft.look as Look;
  if (!look.brief?.directions[direction]) throw new Error(`direction ${direction} not in brief`);
  await patchDraft(draft.id, {
    look: { ...look, style: direction, board: { artifactId: boardArtifactId, key: boardKey } },
  });
  for (const c of look.brief.characters) {
    for (const sheet of ["model", "expressions"] as const)
      await queue.enqueue(
        "kit:sheets",
        { showId, version: draft.version, character: c.name, sheet },
        { queue: "gpu:image", showId, idempotencyKey: `${draft.id}:${direction}:${c.name}:${sheet}` },
      );
  }
  for (const b of look.brief.background_prompts)
    await queue.enqueue(
      "kit:sheets",
      { showId, version: draft.version, background: b.name, sheet: "background" },
      { queue: "gpu:image", showId, idempotencyKey: `${draft.id}:${direction}:bg:${b.name}` },
    );
}

export async function pickVoice(showId: string, character: string, artifactId: string, key: string) {
  const draft = await getOrCreateDraft(showId);
  const voices = draft.voices as Voices;
  const v = voices.brief?.voices.find((x) => x.character === character);
  if (!v) throw new Error(`no voice brief for ${character}`);
  await patchDraft(draft.id, {
    voices: {
      ...voices,
      cast: { ...voices.cast, [character]: { artifactId, key, refText: v.audition_line, instruct: v.instruct } },
    },
  });
}

/** Casting Judge: score every audition against its brief; optionally pick the best take per character. */
export async function judgeVoices(showId: string, apply: boolean) {
  const draft = await getOrCreateDraft(showId);
  const brief = (draft.voices as Voices).brief;
  if (!brief) throw new Error("no voice brief yet");
  const takes = await db
    .select()
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.showId, showId), eq(schema.artifacts.kind, "voice_audition")));
  const results: {
    character: string;
    take: number;
    round: number;
    id: string;
    key: string;
    score: kitAgents.VoiceScore;
  }[] = [];
  for (const t of takes) {
    const m = t.meta as {
      character: string;
      take: number;
      version: number;
      round?: number;
      instruct?: string;
      judge?: kitAgents.VoiceScore;
    };
    if (m.version !== draft.version) continue;
    const b = brief.voices.find((v) => v.character === m.character);
    if (!b) continue;
    let score = m.judge;
    if (!score) {
      // Judge each take against the description it was generated from (earlier rounds used older briefs).
      const wav = await storage.getBytes(t.storageKey);
      score = await kitAgents.judgeVoice(
        {
          character: m.character,
          instruct: m.instruct ?? b.instruct,
          line: b.audition_line,
          wavBase64: wav.toString("base64"),
        },
        { showId, stage: "cast:judge" },
      );
      await db
        .update(schema.artifacts)
        .set({ meta: { ...m, judge: score } })
        .where(eq(schema.artifacts.id, t.id));
    }
    results.push({ character: m.character, take: m.take, round: m.round ?? 1, id: t.id, key: t.storageKey, score });
  }
  const best: Record<string, (typeof results)[number]> = {};
  for (const r of results) {
    const cur = best[r.character];
    const sum = (s: kitAgents.VoiceScore) => s.overall * 2 + s.matches_brief + s.comic_delivery + s.artifacts;
    if (!cur || sum(r.score) > sum(cur.score)) best[r.character] = r;
  }
  if (apply) for (const b of Object.values(best)) await pickVoice(showId, b.character, b.id, b.key);
  return { results, best };
}

/** Casting rewrites a character's voice description from the judge's notes, then auditions a new round. */
export async function reauditionVoice(showId: string, character: string, n: number) {
  const draft = await getOrCreateDraft(showId);
  const voices = draft.voices as Voices;
  const entry = voices.brief?.voices.find((v) => v.character === character);
  if (!entry) throw new Error(`no voice brief for ${character}`);
  const takes = await db
    .select()
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.showId, showId), eq(schema.artifacts.kind, "voice_audition")));
  const mine = takes
    .map((t) => t.meta as { character: string; version: number; round?: number; judge?: kitAgents.VoiceScore })
    .filter((m) => m.character === character && m.version === draft.version);
  const notes = mine.flatMap((m) => (m.judge ? [m.judge.notes] : []));
  const round = Math.max(1, ...mine.map((m) => m.round ?? 1)) + 1;
  const revised = await kitAgents.reviseVoiceInstruct(
    { character, instruct: entry.instruct, judgeNotes: notes },
    { showId, stage: "cast:revise" },
  );
  entry.instruct = revised.instruct;
  await patchDraft(draft.id, { voices });
  await queue.enqueue(
    "cast:auditions",
    { showId, version: draft.version, character, round, n },
    { queue: "gpu:tts", showId, idempotencyKey: `${draft.id}:audition:${character}:r${round}` },
  );
  return { round, ...revised };
}

// ---------- GPU kinds ----------
async function draftFor(job: Job) {
  const { showId, version } = payloadOf(job) as { showId: string; version: number };
  const [v] = await db
    .select()
    .from(showVersions)
    .where(and(eq(showVersions.showId, showId), eq(showVersions.version, version)));
  if (!v) throw new HermesError(`show version ${showId} v${version} missing`, "invalid_input");
  return v;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

GPU_KINDS["kit:boards"] = {
  build: async (job) => {
    const v = await draftFor(job);
    const { showId, direction } = payloadOf(job) as { showId: string; direction: number };
    const brief = (v.look as Look).brief!;
    const d = brief.directions[direction]!;
    const seeds = [11, 22];
    const outputs = Object.fromEntries(
      seeds.map((s, i) => [
        `image_${i}`,
        {
          key: storage.showKey(showId, `v${v.version}/boards/d${direction}-s${s}.png`),
          contentType: "image/png",
          kind: "style_board",
          meta: { direction, directionName: d.name, seed: s, version: v.version },
        },
      ]),
    );
    return {
      pool: "image",
      task: "generate",
      showId,
      params: { prompt: `${brief.key_art_prompt}\n\nStyle: ${d.style_prompt}`, width: 768, height: 1344, seeds },
      inputs: {},
      outputs,
    };
  },
};

GPU_KINDS["kit:sheets"] = {
  build: async (job) => {
    const v = await draftFor(job);
    const p = payloadOf(job) as { showId: string; character?: string; background?: string; sheet: string };
    const look = v.look as Look;
    const brief = look.brief!;
    const style = brief.directions[look.style!]!.style_prompt;
    let prompt: string;
    let name: string;
    let size = { width: 1536, height: 1024 };
    if (p.sheet === "background") {
      const b = brief.background_prompts.find((x) => x.name === p.background)!;
      prompt = `${b.prompt}. Empty of characters. Vertical composition with clear floor and staging space.\n\nStyle: ${style}`;
      name = `bg-${slug(b.name)}`;
      size = { width: 768, height: 1344 };
    } else {
      const c = brief.characters.find((x) => x.name === p.character)!;
      prompt =
        p.sheet === "model"
          ? `Character model sheet: ${c.design_prompt}. Shown three times side by side: front view, three-quarter view, side view. Full body (or the character's key parts if it is too large to fit: ${c.framing_rule}). Neutral pose, arms slightly away from the body, evenly spaced on a plain flat white background. Match the reference image's style exactly.\n\nStyle: ${style}`
          : `Expression sheet for this character: ${c.design_prompt}. Nine head-and-shoulders close-ups in a 3x3 grid on a plain flat white background: neutral, deadpan, annoyed, confused, alarmed, smug, sad, delighted, suspicious. Same character, same design in every cell. Match the reference image's style exactly.\n\nStyle: ${style}`;
      name = `${slug(c.name)}-${p.sheet}`;
    }
    const seeds = [7, 8];
    return {
      pool: "image",
      task: "generate",
      showId: p.showId,
      params: { prompt, ...size, seeds, refs: ["board"] },
      inputs: { board: look.board!.key },
      outputs: Object.fromEntries(
        seeds.map((s, i) => [
          `image_${i}`,
          {
            key: storage.showKey(p.showId, `v${v.version}/sheets/${name}-s${s}.png`),
            contentType: "image/png",
            kind: p.sheet === "background" ? "background_plate" : `character_${p.sheet}_sheet`,
            meta: { character: p.character, background: p.background, sheet: p.sheet, seed: s, version: v.version },
          },
        ]),
      ),
    };
  },
};

GPU_KINDS["cast:auditions"] = {
  build: async (job) => {
    const v = await draftFor(job);
    const p = payloadOf(job) as { showId: string; character: string; round?: number; n?: number };
    const { showId, character } = p;
    const round = p.round ?? 1;
    const brief = (v.voices as Voices).brief!.voices.find((x) => x.character === character)!;
    const n = p.n ?? 3;
    const prefix = round === 1 ? "" : `r${round}-`;
    return {
      pool: "tts",
      task: "voice_design",
      showId,
      params: { instruct: brief.instruct, text: brief.audition_line, language: "English", n },
      inputs: {},
      outputs: Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `audio_${i}`,
          {
            key: storage.showKey(showId, `v${v.version}/voices/${slug(character)}-${prefix}take${i + 1}.wav`),
            contentType: "audio/wav",
            kind: "voice_audition",
            meta: { character, take: i + 1, round, instruct: brief.instruct, version: v.version },
          },
        ]),
      ),
    };
  },
};

export const KIT_HANDLERS: Record<string, StageHandler> = {
  "kit:style_brief": styleBriefHandler,
  "cast:voice_brief": voiceBriefHandler,
};
