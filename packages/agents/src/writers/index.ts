import { type CostContext, generate, generateStructured } from "@hermes/core";
import { type KitManifest, Picks, type Premise, PremiseList, ShotScript } from "../schemas.js";
import { CORE_VOCAB } from "../vocab.js";
import * as P from "./prompts.js";

export interface ShowContext {
  bible: string;
  kit: KitManifest;
  lessons?: string[];
  dailyBudgetUsd?: number;
}

/** Ideation + Head Writer: pitch 3n premises, pick the best n (best first). */
export async function ideate(show: ShowContext, n: number, ctx: CostContext, avoid: string[] = []) {
  const system = P.writerSystem(show.bible, show.lessons);
  const pitched = await generateStructured({
    role: "ideation",
    system,
    prompt: P.pitchPrompt(n * 3, avoid),
    schema: PremiseList,
    schemaName: "premise_list",
    ctx: { ...ctx, stage: "ideation" },
    showDailyBudgetUsd: show.dailyBudgetUsd,
  });
  const list = pitched.output.premises;
  const numbered = list
    .map((p, i) => `${i + 1}. ${p.premise} || GAME: ${p.game} || BUTTON: ${p.button} || ENGINE: ${p.engine}`)
    .join("\n");
  const picked = await generateStructured({
    role: "head_writer",
    system,
    prompt: P.pickPrompt(numbered, n),
    schema: Picks,
    schemaName: "picks",
    ctx: { ...ctx, stage: "head_writer" },
    showDailyBudgetUsd: show.dailyBudgetUsd,
  });
  const seen = new Set<number>();
  const chosen: Premise[] = [];
  for (const p of picked.output.picks) {
    const item = list[p.index - 1];
    if (item && !seen.has(p.index)) {
      seen.add(p.index);
      chosen.push(item);
    }
  }
  return { pitched: list, chosen: chosen.slice(0, n), pitchedText: numbered };
}

export const pitchText = (p: Pick<Premise, "premise" | "game" | "button">) =>
  `${p.premise} || GAME: ${p.game} || BUTTON: ${p.button}`;

export async function draft(show: ShowContext, pitch: string, ctx: CostContext) {
  const r = await generate({
    role: "writer",
    system: P.writerSystem(show.bible, show.lessons),
    prompt: P.draftPrompt(pitch),
    ctx: { ...ctx, stage: "draft" },
    showDailyBudgetUsd: show.dailyBudgetUsd,
  });
  return r.output;
}

export async function punchUp(show: ShowContext, draftText: string, ctx: CostContext) {
  const r = await generate({
    role: "punchup",
    system: P.writerSystem(show.bible, show.lessons),
    prompt: P.punchUpPrompt(draftText),
    ctx: { ...ctx, stage: "punchup" },
    showDailyBudgetUsd: show.dailyBudgetUsd,
  });
  const text = r.output;
  const hasFinal = text.includes("FINAL:");
  return {
    final: hasFinal ? text.split("FINAL:").pop()!.trim() : text.trim(),
    notes: hasFinal ? text.split("FINAL:")[0]!.replace("NOTES:", "").trim() : "",
  };
}

export async function toShotScript(show: ShowContext, screenplay: string, ctx: CostContext) {
  const r = await generateStructured({
    role: "script_editor",
    system: P.CONVERT_SYSTEM,
    prompt: P.convertPrompt(screenplay, CORE_VOCAB, show.kit),
    schema: ShotScript,
    schemaName: "shot_script",
    ctx: { ...ctx, stage: "shot_script" },
    showDailyBudgetUsd: show.dailyBudgetUsd,
  });
  return r.output;
}
