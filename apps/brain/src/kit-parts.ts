import { parts as partAgents } from "@hermes/agents";
import { db, HermesError, type Job, log, queue, schema, storage } from "@hermes/core";
import { and, eq } from "drizzle-orm";
import { GPU_KINDS } from "./gpu.js";
import { getOrCreateDraft } from "./kit.js";
import type { StageHandler } from "./stages.js";

// Kit Builder pipeline: plan parts -> generate base + edit variants (GPU) -> Part Judge (vision) ->
// regenerate failures with new seeds (max MAX_ROUNDS) -> compile the puppet manifest into the draft kit.

const { showVersions, artifacts } = schema;
const MAX_ROUNDS = 3;
const CANVAS = { portrait: [1024, 1536], square: [1024, 1024], landscape: [1536, 1024] } as const;

type Look = {
  brief?: {
    directions: { style_prompt: string }[];
    characters: { name: string; design_prompt: string; framing_rule: string }[];
  };
  style?: number;
  board?: { artifactId: string; key: string };
  parts_plan?: partAgents.PartsPlan;
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

interface PartsPayload {
  showId: string;
  version: number;
  character: string;
  partId: string;
  round: number;
  only?: string[]; // variant names to (re)generate; undefined = all
  baseKey?: string; // reuse an approved base instead of generating one
  baseSeed?: number;
}

async function version(showId: string, v: number) {
  const [row] = await db
    .select()
    .from(showVersions)
    .where(and(eq(showVersions.showId, showId), eq(showVersions.version, v)));
  if (!row) throw new HermesError(`show version ${showId} v${v} missing`, "invalid_input");
  return row;
}

function findPart(look: Look, character: string, partId: string) {
  const c = look.parts_plan?.characters.find((x) => x.character === character);
  const p = c?.parts.find((x) => x.part_id === partId);
  if (!c || !p) throw new HermesError(`no plan for ${character}/${partId}`, "invalid_input");
  return { c, p };
}

/** Best reference for a character: its approved model sheet (bipeds) or the style board (giant parts). */
async function referenceKey(showId: string, character: string, archetype: string, look: Look) {
  if (archetype === "biped") {
    const sheets = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.showId, showId), eq(artifacts.kind, "character_model_sheet")));
    const mine = sheets.filter((s) => (s.meta as { character?: string }).character === character);
    const s7 = mine.find((s) => (s.meta as { seed?: number }).seed === 7) ?? mine[0];
    if (s7) return s7.storageKey;
  }
  return look.board!.key;
}

// ---------- CPU: plan ----------
export const planPartsHandler: StageHandler = async (job) => {
  const { showId } = job.payload as { showId: string };
  const draft = await getOrCreateDraft(showId);
  const look = draft.look as Look;
  if (!look.brief || look.style === undefined)
    throw new HermesError("pick a style first (kit:pick-style)", "invalid_input");
  const kit = draft.kit as { actions?: { token: string; description: string }[] };
  const plan = await partAgents.planParts(
    {
      bible: draft.bible,
      style: look.brief.directions[look.style]!.style_prompt,
      characters: look.brief.characters,
      kitActions: kit.actions ?? [],
    },
    { showId, jobId: job.id, stage: job.kind },
  );
  for (const c of plan.characters)
    if (c.archetype === "biped")
      for (const p of c.parts) if (p.part_id === "body") p.variants.push(...partAgents.standardFaceVariants());
  await db
    .update(showVersions)
    .set({ look: { ...look, parts_plan: plan } })
    .where(eq(showVersions.id, draft.id));
  let n = 0;
  for (const c of plan.characters)
    for (const p of c.parts) {
      const payload: PartsPayload = {
        showId,
        version: draft.version,
        character: c.character,
        partId: p.part_id,
        round: 1,
      };
      await queue.enqueue(
        "kit:parts",
        { ...payload },
        {
          queue: "gpu:image",
          showId,
          idempotencyKey: `${draft.id}:parts:${c.character}:${p.part_id}:r1`,
        },
      );
      n++;
    }
  return {
    characters: plan.characters.map((c) => `${c.character} (${c.archetype}, ${c.parts.length} parts)`),
    jobs: n,
  };
};

// ---------- GPU: base + variants ----------
GPU_KINDS["kit:parts"] = {
  build: async (job) => {
    const p = job.payload as PartsPayload;
    const v = await version(p.showId, p.version);
    const look = v.look as Look;
    const { c, p: part } = findPart(look, p.character, p.partId);
    const style = look.brief!.directions[look.style!]!.style_prompt;
    const [w, h] = CANVAS[part.canvas];
    const variants = part.variants
      .filter((x) => !p.only || p.only.includes(x.name))
      .map((x, i) => ({ ...x, prompt: `${x.prompt}\n\nStyle: ${style}`, seed: 100 * p.round + i }));
    const dir = `v${p.version}/parts/${slug(p.character)}/${p.partId}/r${p.round}`;
    const slot = (name: string, role: string, extra: Record<string, unknown> = {}) => ({
      key: storage.showKey(p.showId, `${dir}/${name}.png`),
      contentType: "image/png",
      kind: "puppet_part",
      meta: {
        character: p.character,
        archetype: c.archetype,
        part_id: p.partId,
        name,
        role,
        round: p.round,
        version: p.version,
        ...extra,
      },
    });
    const outputs: Record<string, ReturnType<typeof slot>> = {};
    const inputs: Record<string, string> = {};
    let base: Record<string, unknown> | null = null;
    if (p.baseKey) inputs.base = p.baseKey;
    else {
      inputs.ref = await referenceKey(p.showId, p.character, c.archetype, look);
      base = {
        prompt: `${part.base_prompt}\n\nStyle: ${style}`,
        refs: ["ref"],
        width: w,
        height: h,
        seed: p.baseSeed ?? 1,
      };
    }
    outputs.base = slot("base", "base");
    outputs.base_rgba = slot("base_rgba", "base_rgba");
    for (const x of variants) {
      outputs[x.name] = slot(x.name, "variant", { mode: x.mode, request: x.prompt.split("\n")[0] });
      if (x.mode === "overlay") outputs[`${x.name}__raw`] = slot(`${x.name}__raw`, "raw", { variant: x.name });
    }
    return {
      pool: "image",
      task: "variants",
      showId: p.showId,
      params: { base, variants: variants.map(({ name, mode, prompt, seed }) => ({ name, mode, prompt, seed })) },
      inputs,
      outputs,
    };
  },
  collect: async (job) => {
    const p = job.payload as PartsPayload;
    await queue.enqueue(
      "kit:parts_qa",
      { ...p },
      {
        showId: p.showId,
        idempotencyKey: `qa:${p.showId}:${p.version}:${p.character}:${p.partId}:r${p.round}`,
      },
    );
    return { queued_qa: true };
  },
};

// ---------- CPU: Part Judge + regeneration ----------
type PartMeta = {
  character: string;
  part_id: string;
  name: string;
  role: string;
  mode?: string;
  request?: string;
  variant?: string;
  round: number;
  version: number;
  judge?: partAgents.PartScore;
  box?: { x: number; y: number; w: number; h: number };
  change_ratio?: number;
};

async function partArtifacts(showId: string, version: number, character: string, partId: string) {
  const rows = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.showId, showId), eq(artifacts.kind, "puppet_part")));
  return rows
    .map((r) => ({ ...r, m: r.meta as PartMeta }))
    .filter((r) => r.m.version === version && r.m.character === character && r.m.part_id === partId);
}

export const partsQaHandler: StageHandler = async (job) => {
  const p = job.payload as PartsPayload;
  const v = await version(p.showId, p.version);
  const look = v.look as Look;
  const { c } = findPart(look, p.character, p.partId);
  const all = await partArtifacts(p.showId, p.version, p.character, p.partId);
  const thisRound = all.filter((a) => a.m.round === p.round);
  const url = (key: string) => storage.presignGet(key, 6 * 3600);
  const referenceUrl = await url(await referenceKey(p.showId, p.character, c.archetype, look));
  const ctx = { showId: p.showId, jobId: job.id, stage: job.kind };

  const save = (id: string, m: PartMeta, judge: partAgents.PartScore) =>
    db
      .update(artifacts)
      .set({ meta: { ...m, judge } })
      .where(eq(artifacts.id, id));

  // Base: judged when generated this round.
  const baseRow = thisRound.find((a) => a.m.role === "base");
  const baseKey = p.baseKey ?? baseRow?.storageKey;
  if (!baseKey) throw new HermesError("no base for part", "invalid_input");
  if (baseRow && !p.baseKey) {
    const plan = findPart(look, p.character, p.partId).p;
    const score = await partAgents.judgePart(
      {
        character: p.character,
        request: plan.base_prompt.split("\n")[0]!,
        referenceUrl,
        baseUrl: await url(baseRow.storageKey),
      },
      ctx,
    );
    await save(baseRow.id, baseRow.m, score);
    if (!score.pass && p.round < MAX_ROUNDS) {
      // Bad base invalidates every variant: regenerate everything from a new base seed.
      await queue.enqueue(
        "kit:parts",
        { ...p, round: p.round + 1, only: undefined, baseKey: undefined, baseSeed: p.round + 1 },
        {
          queue: "gpu:image",
          showId: p.showId,
          idempotencyKey: `${p.showId}:${p.version}:parts:${p.character}:${p.partId}:r${p.round + 1}`,
        },
      );
      return { base: "failed", issue: score.issue, regenerating: true };
    }
  }

  const baseUrl = await url(baseKey);
  const failed: string[] = [];
  for (const a of thisRound.filter((x) => x.m.role === "variant")) {
    const raw = thisRound.find((x) => x.m.role === "raw" && x.m.variant === a.m.name);
    const target = a.m.mode === "overlay" ? raw : a;
    if (!target) continue;
    let score = await partAgents.judgePart(
      {
        character: p.character,
        request: a.m.request ?? a.m.name,
        referenceUrl,
        baseUrl,
        variantUrl: await url(target.storageKey),
      },
      ctx,
    );
    // Overlays that changed most of the figure (global drift) or nothing at all fail regardless of the judge.
    if (a.m.mode === "overlay" && ((a.m.change_ratio ?? 0) > 0.35 || (a.m.change_ratio ?? 0) < 0.002))
      score = { ...score, pass: false, issue: `overlay change ratio ${a.m.change_ratio} out of range` };
    await save(a.id, a.m, score);
    if (!score.pass) failed.push(a.m.name);
  }
  if (failed.length && p.round < MAX_ROUNDS) {
    await queue.enqueue(
      "kit:parts",
      { ...p, round: p.round + 1, only: failed, baseKey },
      {
        queue: "gpu:image",
        showId: p.showId,
        idempotencyKey: `${p.showId}:${p.version}:parts:${p.character}:${p.partId}:r${p.round + 1}`,
      },
    );
  }
  log.info({ character: p.character, part: p.partId, round: p.round, failed: failed.length }, "parts judged");
  return { round: p.round, failed, regenerating: failed.length > 0 && p.round < MAX_ROUNDS };
};

// ---------- compile ----------
export interface PuppetVariant {
  key: string;
  mode: "full" | "overlay";
  box: { x: number; y: number; w: number; h: number };
  passed: boolean;
}
export interface PuppetPart {
  base: string;
  base_rgba: string;
  canvas: { w: number; h: number };
  variants: Record<string, PuppetVariant>;
}
export interface Puppet {
  character: string;
  archetype: "biped" | "giant_parts";
  parts: Record<string, PuppetPart>;
}

/** Build the puppet manifest from the best artifacts: latest passing take of each variant (else latest). */
export async function compilePuppets(showId: string) {
  const draft = await getOrCreateDraft(showId);
  const look = draft.look as Look;
  if (!look.parts_plan) throw new Error("no parts plan yet (kit:parts)");
  const puppets: Puppet[] = [];
  const gaps: string[] = [];
  for (const c of look.parts_plan.characters) {
    const puppet: Puppet = { character: c.character, archetype: c.archetype, parts: {} };
    for (const part of c.parts) {
      const rows = await partArtifacts(showId, draft.version, c.character, part.part_id);
      const bases = rows.filter((r) => r.m.role === "base").sort((a, b) => b.m.round - a.m.round);
      const base = bases.find((b) => b.m.judge?.pass) ?? bases[0];
      if (!base) {
        gaps.push(`${c.character}/${part.part_id}: no base`);
        continue;
      }
      const baseRgba = rows.find((r) => r.m.role === "base_rgba" && r.m.round === base.m.round)!;
      const [w, h] = CANVAS[part.canvas];
      const pp: PuppetPart = { base: base.storageKey, base_rgba: baseRgba.storageKey, canvas: { w, h }, variants: {} };
      for (const vdef of part.variants) {
        const takes = rows
          .filter((r) => r.m.role === "variant" && r.m.name === vdef.name)
          .sort((a, b) => b.m.round - a.m.round);
        const best = takes.find((t) => t.m.judge?.pass) ?? takes[0];
        if (!best) {
          gaps.push(`${c.character}/${part.part_id}/${vdef.name}: missing`);
          continue;
        }
        if (!best.m.judge?.pass)
          gaps.push(`${c.character}/${part.part_id}/${vdef.name}: ${best.m.judge?.issue ?? "unjudged"}`);
        pp.variants[vdef.name] = {
          key: best.storageKey,
          mode: (best.m.mode as "full" | "overlay") ?? "full",
          box: best.m.box ?? { x: 0, y: 0, w, h },
          passed: Boolean(best.m.judge?.pass),
        };
      }
      puppet.parts[part.part_id] = pp;
    }
    puppets.push(puppet);
  }
  const kit = draft.kit as Record<string, unknown>;
  await db
    .update(showVersions)
    .set({ kit: { ...kit, puppets } })
    .where(eq(showVersions.id, draft.id));
  return { puppets, gaps };
}

export const PARTS_HANDLERS: Record<string, StageHandler> = {
  "kit:plan_parts": planPartsHandler,
  "kit:parts_qa": partsQaHandler,
};
