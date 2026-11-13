import { parts as partAgents } from "@hermes/agents";
import { db, HermesError, type Job, log, queue, schema, storage } from "@hermes/core";
import { and, eq } from "drizzle-orm";
import { GPU_KINDS } from "./gpu.js";
import { getOrCreateDraft } from "./kit.js";
import type { StageHandler } from "./stages.js";

// Kit Builder pipeline, two phases per part:
//   A "base":     generate the base (+ full-pose edits) -> judge base (and poses on their plain background)
//   B "overlays": once the base passes, a vision locator marks the region overlays change (the head; Ember's eye)
//                 -> every expression / mouth / eyelid edit is cut from that region, aligned, feathered, and judged
//                 as the composite viewers will see.
// Failures regenerate with new seeds up to MAX_ROUNDS per phase; then compile the puppet manifest.

const { showVersions, artifacts } = schema;
const MAX_ROUNDS = 3;
const CANVAS = { portrait: [1024, 1536], square: [1024, 1024], landscape: [1536, 1024] } as const;
const BIPED_REGION = "the character's whole head including hair, glasses and any hat or helmet";

type Look = {
  brief?: {
    directions: { style_prompt: string }[];
    characters: { name: string; design_prompt: string; framing_rule: string }[];
  };
  style?: number;
  board?: { artifactId: string; key: string };
  parts_plan?: partAgents.PartsPlan;
};

type Box = { x: number; y: number; w: number; h: number };

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
  phase: "base" | "overlays";
  round: number;
  only?: string[]; // variant names to (re)generate; undefined = all for the phase
  baseKey?: string; // approved base to edit from (pose regens, overlays phase)
  baseSeed?: number;
  region?: Box; // overlays phase: where the overlay edits are cut from
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

const idem = (p: PartsPayload) => `${p.showId}:${p.version}:parts:${p.character}:${p.partId}:${p.phase}:r${p.round}`;

function enqueueParts(p: PartsPayload) {
  return queue.enqueue("kit:parts", { ...p }, { queue: "gpu:image", showId: p.showId, idempotencyKey: idem(p) });
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
      for (const p of c.parts)
        if (p.part_id === "body") {
          p.variants.push(...partAgents.standardFaceVariants());
          p.overlay_region = BIPED_REGION;
        }
  await db
    .update(showVersions)
    .set({ look: { ...look, parts_plan: plan } })
    .where(eq(showVersions.id, draft.id));
  let n = 0;
  for (const c of plan.characters)
    for (const p of c.parts) {
      await enqueueParts({
        showId,
        version: draft.version,
        character: c.character,
        partId: p.part_id,
        phase: "base",
        round: 1,
      });
      n++;
    }
  return {
    characters: plan.characters.map((c) => `${c.character} (${c.archetype}, ${c.parts.length} parts)`),
    jobs: n,
  };
};

// ---------- GPU: one phase of one part ----------
GPU_KINDS["kit:parts"] = {
  build: async (job) => {
    const p = job.payload as PartsPayload;
    const v = await version(p.showId, p.version);
    const look = v.look as Look;
    const { c, p: part } = findPart(look, p.character, p.partId);
    const style = look.brief!.directions[look.style!]!.style_prompt;
    const [w, h] = CANVAS[part.canvas];
    const wantMode = p.phase === "base" ? "full" : "overlay";
    const variants = part.variants
      .filter((x) => x.mode === wantMode && (!p.only || p.only.includes(x.name)))
      .map((x, i) => ({ ...x, prompt: `${x.prompt}\n\nStyle: ${style}`, seed: 100 * p.round + i }));
    const dir = `v${p.version}/parts/${slug(p.character)}/${p.partId}/${p.phase}-r${p.round}`;
    const key = (name: string) => storage.showKey(p.showId, `${dir}/${name}.png`);
    const baseKey = p.baseKey ?? key("base");
    const slot = (name: string, role: string, extra: Record<string, unknown> = {}) => ({
      key: key(name),
      contentType: "image/png",
      kind: "puppet_part",
      meta: {
        character: p.character,
        archetype: c.archetype,
        part_id: p.partId,
        name,
        role,
        phase: p.phase,
        round: p.round,
        version: p.version,
        base_key: baseKey,
        ...extra,
      },
    });
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
    // The worker always writes base + base_rgba; when reusing an approved base they're just copies.
    const baseRole = p.baseKey ? "base_copy" : "base";
    const outputs: Record<string, ReturnType<typeof slot>> = {
      base: slot("base", baseRole),
      base_rgba: slot("base_rgba", `${baseRole}_rgba`),
    };
    for (const x of variants) {
      const request = x.prompt.split("\n")[0];
      outputs[x.name] = slot(x.name, "variant", { mode: x.mode, request });
      if (x.mode === "full") outputs[`${x.name}__raw`] = slot(`${x.name}__raw`, "raw", { variant: x.name });
      else outputs[`${x.name}__comp`] = slot(`${x.name}__comp`, "comp", { variant: x.name });
    }
    return {
      pool: "image",
      task: "variants",
      showId: p.showId,
      params: {
        base,
        region: p.region ?? null,
        variants: variants.map(({ name, mode, prompt, seed }) => ({ name, mode, prompt, seed })),
      },
      inputs,
      outputs,
    };
  },
  collect: async (job) => {
    const p = job.payload as PartsPayload;
    await queue.enqueue("kit:parts_qa", { ...p }, { showId: p.showId, idempotencyKey: `qa:${idem(p)}` });
    return { queued_qa: true };
  },
};

// ---------- CPU: Part Judge, locator, regeneration ----------
type PartMeta = {
  character: string;
  part_id: string;
  name: string;
  role: string;
  phase?: string;
  mode?: string;
  request?: string;
  variant?: string;
  round: number;
  version: number;
  base_key?: string;
  judge?: partAgents.PartScore;
  box?: Box;
  region?: Box;
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
  const { c, p: part } = findPart(look, p.character, p.partId);
  const rows = (await partArtifacts(p.showId, p.version, p.character, p.partId)).filter(
    (a) => a.m.phase === p.phase && a.m.round === p.round,
  );
  const url = (k: string) => storage.presignGet(k, 6 * 3600);
  const referenceUrl = await url(await referenceKey(p.showId, p.character, c.archetype, look));
  const ctx = { showId: p.showId, jobId: job.id, stage: job.kind };
  const save = (id: string, m: PartMeta, extra: Partial<PartMeta>) =>
    db
      .update(artifacts)
      .set({ meta: { ...m, ...extra } })
      .where(eq(artifacts.id, id));

  // --- base (phase A, when generated this round) ---
  // A base is only "new" when this job generated it (no baseKey given) and it is its own lineage root.
  const baseRow = p.baseKey ? undefined : rows.find((a) => a.m.role === "base" && a.m.base_key === a.storageKey);
  const baseKey = p.baseKey ?? baseRow?.storageKey;
  if (!baseKey) throw new HermesError("no base for part", "invalid_input");
  let baseApprovedNow = false;
  if (p.phase === "base" && baseRow) {
    const score = await partAgents.judgePart(
      {
        character: p.character,
        request: part.base_prompt.split("\n")[0]!,
        kind: c.archetype === "biped" ? "base_biped" : "base_plate",
        referenceUrl,
        baseUrl: await url(baseRow.storageKey),
      },
      ctx,
    );
    await save(baseRow.id, baseRow.m, { judge: score });
    if (!score.pass) {
      // A bad base invalidates its poses: regenerate the whole phase from a new seed.
      if (p.round < MAX_ROUNDS)
        await enqueueParts({ ...p, round: p.round + 1, only: undefined, baseKey: undefined, baseSeed: p.round + 1 });
      log.info({ character: p.character, part: p.partId, round: p.round, issue: score.issue }, "base failed");
      return { base: "failed", issue: score.issue, regenerating: p.round < MAX_ROUNDS };
    }
    baseApprovedNow = true;
  }

  // --- variants of this phase ---
  const baseUrl = await url(baseKey);
  const failed: string[] = [];
  for (const a of rows.filter((x) => x.m.role === "variant")) {
    const target = rows.find((x) => (x.m.role === "raw" || x.m.role === "comp") && x.m.variant === a.m.name);
    if (!target) continue;
    const score = await partAgents.judgePart(
      {
        character: p.character,
        request: a.m.request ?? a.m.name,
        kind: a.m.mode === "full" ? "pose" : "overlay",
        referenceUrl,
        baseUrl,
        variantUrl: await url(target.storageKey),
      },
      ctx,
    );
    await save(a.id, a.m, { judge: score });
    if (!score.pass) failed.push(a.m.name);
  }
  if (failed.length && p.round < MAX_ROUNDS)
    await enqueueParts({ ...p, round: p.round + 1, only: failed, baseKey, baseSeed: undefined });

  // --- base just approved: locate the overlay region once, start phase B ---
  let overlaysQueued = false;
  if (baseApprovedNow && part.variants.some((x) => x.mode === "overlay") && part.overlay_region !== "none") {
    const [w, h] = CANVAS[part.canvas];
    const region = await partAgents.locateRegion(
      { imageUrl: baseUrl, what: part.overlay_region, width: w, height: h },
      ctx,
    );
    if (region) {
      await save(baseRow!.id, { ...baseRow!.m, judge: (baseRow!.m as PartMeta).judge }, { region });
      await enqueueParts({ ...p, phase: "overlays", round: 1, only: undefined, baseKey, region });
      overlaysQueued = true;
    } else log.warn({ character: p.character, part: p.partId, what: part.overlay_region }, "overlay region not found");
  }
  log.info(
    { character: p.character, part: p.partId, phase: p.phase, round: p.round, failed: failed.length, overlaysQueued },
    "parts judged",
  );
  return { phase: p.phase, round: p.round, failed, overlaysQueued };
};

// ---------- compile ----------
export interface PuppetVariant {
  key: string;
  mode: "full" | "overlay";
  box: Box;
  passed: boolean;
}
export interface PuppetPart {
  base: string;
  base_rgba: string;
  canvas: { w: number; h: number };
  region?: Box;
  variants: Record<string, PuppetVariant>;
}
export interface Puppet {
  character: string;
  archetype: "biped" | "giant_parts";
  parts: Record<string, PuppetPart>;
}

/** Build the puppet manifest: the latest approved base, and for each variant derived from THAT base,
 * its latest passing take (else latest take, listed as a gap). */
export async function compilePuppets(showId: string) {
  const draft = await getOrCreateDraft(showId);
  const look = draft.look as Look;
  if (!look.parts_plan) throw new Error("no parts plan yet (kit:parts)");
  const puppets: Puppet[] = [];
  const gaps: string[] = [];
  for (const c of look.parts_plan.characters) {
    const puppet: Puppet = { character: c.character, archetype: c.archetype, parts: {} };
    for (const part of c.parts) {
      const rows = (await partArtifacts(showId, draft.version, c.character, part.part_id)).filter((r) => r.m.phase);
      // Only original bases (base_key == own key); re-uploaded copies from retries are not new bases.
      const bases = rows
        .filter((r) => r.m.role === "base" && r.m.base_key === r.storageKey)
        .sort((a, b) => b.m.round - a.m.round);
      const base = bases.find((b) => b.m.judge?.pass);
      if (!base) {
        gaps.push(`${c.character}/${part.part_id}: no approved base (${bases[0]?.m.judge?.issue ?? "not generated"})`);
        continue;
      }
      const baseRgba = rows.find(
        (r) => r.m.role === "base_rgba" && r.storageKey.startsWith(base.storageKey.replace(/base\.png$/, "")),
      )!;
      const [w, h] = CANVAS[part.canvas];
      const pp: PuppetPart = {
        base: base.storageKey,
        base_rgba: baseRgba?.storageKey ?? base.storageKey,
        canvas: { w, h },
        region: base.m.region,
        variants: {},
      };
      for (const vdef of part.variants) {
        const takes = rows
          .filter((r) => r.m.role === "variant" && r.m.name === vdef.name && r.m.base_key === base.storageKey)
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
