// Single-script feasibility test. Run from the writing-test folder:
//   node src/cli.mjs premises --show dragons-accountant [--n 10]   pitch 30, head writer picks n
//   node src/cli.mjs script   --show dragons-accountant --pick 3   draft + punch-up + beat format
//   node src/cli.mjs cost                                          spend so far, by stage
//   node src/cli.mjs models   [filter]                             OpenRouter model ids + prices
// All calls go through OpenRouter; spending stops at SPEND_CAP_USD (default $6).
import fs from "node:fs";
import path from "node:path";
import { Sketch, renderForRaters } from "./schema.mjs";
import * as P from "./prompts.mjs";
import { write, structured, listOpenRouterModels, spentSoFar, SPEND_CAP_USD } from "./llm.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = {};
for (let i = 1; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1];
const show = args.show;
const outDir = () => path.join("out", show);
const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const writeJSON = (p, v) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, JSON.stringify(v, null, 2)));

function loadShow() {
  if (!show) throw new Error("--show <id> is required");
  const dir = path.join("shows", show);
  const kitPath = path.join(dir, "kit.json");
  return {
    bible: fs.readFileSync(path.join(dir, "bible.md"), "utf8"),
    kit: fs.existsSync(kitPath) ? readJSON(kitPath) : { actions: [] },
  };
}

async function premises() {
  const { bible } = loadShow();
  const n = +(args.n ?? 10);
  const system = P.writerSystem(bible);
  const tag = { show, run: "feasibility" };
  console.log(`Pitching ${n * 3} premises...`);
  const pitched = await write({ system, prompt: P.premisesPrompt(n * 3), tag: { ...tag, stage: "premises" } });
  console.log(`Head writer picking ${n}...`);
  const picked = await write({ system, prompt: P.selectPrompt(pitched, n), tag: { ...tag, stage: "select" } });
  const picks = picked.split("\n").map((l) => l.trim()).filter((l) => /^\d+\./.test(l)).slice(0, n)
    .map((l, i) => ({ n: i + 1, text: l.replace(/^\d+\.\s*/, "") }));
  writeJSON(path.join(outDir(), "premises.json"), { pitched, picks });
  console.log("\n" + picks.map((p) => `${p.n}. ${p.text}`).join("\n\n"));
}

async function script() {
  const { bible, kit } = loadShow();
  const { picks } = readJSON(path.join(outDir(), "premises.json"));
  const pick = picks.find((p) => p.n === +args.pick);
  if (!pick) throw new Error(`--pick must be one of 1-${picks.length}`);
  const system = P.writerSystem(bible);
  const tag = { show, run: "feasibility", pick: pick.n };

  console.log("Drafting...");
  const draft = await write({ system, prompt: P.draftPrompt(pick.text), tag: { ...tag, stage: "draft" } });
  console.log("Punch-up pass...");
  const punched = await write({ system, prompt: P.punchUpPrompt(draft), tag: { ...tag, stage: "punchup" } });
  const final = punched.includes("FINAL:") ? punched.split("FINAL:").pop().trim() : punched.trim();
  const notes = punched.includes("FINAL:") ? punched.split("FINAL:")[0].replace("NOTES:", "").trim() : "";
  console.log("Converting to beat format...");
  const core = readJSON("vocab/core.json");
  const sketch = await structured({ system: P.CONVERT_SYSTEM, prompt: P.convertPrompt(final, core, kit), schema: Sketch, tag: { ...tag, stage: "convert" } });
  const rendered = renderForRaters(sketch);

  const base = path.join(outDir(), `script-${pick.n}`);
  writeJSON(base + ".json", { pick, draft, punchup_notes: notes, final_screenplay: final, sketch });
  fs.writeFileSync(base + ".txt", `${sketch.title}\n${sketch.logline}\n\n${rendered}\n`);
  console.log(`\n${sketch.title} — ~${Math.round(sketch.est_runtime_s)}s\n${sketch.logline}\n\n${rendered}`);
  const inserts = sketch.beats.filter((b) => b.realization === "insert");
  console.log(`\nActions: ${sketch.beats.filter((b) => b.realization === "core").length} core, ${sketch.beats.filter((b) => b.realization === "kit").length} kit, ${inserts.length} insert shots`);
  costReport(pick.n);
}

function ledger() {
  return fs.existsSync("out/ledger.jsonl")
    ? fs.readFileSync("out/ledger.jsonl", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
}

function costReport(pickN) {
  const rows = ledger();
  const fmt = (r) => `${r.stage.padEnd(9)} ${r.model.padEnd(28)} in ${String(r.prompt_tokens).padStart(6)}  out ${String(r.completion_tokens).padStart(6)}  (reasoning ${String(r.reasoning_tokens ?? "?").padStart(5)})  $${(r.usd ?? 0).toFixed(4)}`;
  console.log("\nCALLS");
  for (const r of rows) console.log("  " + fmt(r));
  const sum = (rs) => rs.reduce((s, r) => s + (r.usd ?? 0), 0);
  const ideation = rows.filter((r) => r.stage === "premises" || r.stage === "select");
  console.log(`\nIdeation (pitch + pick, shared by all ${10} premises): $${sum(ideation).toFixed(4)}`);
  if (pickN) {
    const own = rows.filter((r) => r.pick === pickN);
    console.log(`This script (draft + punch-up + convert): $${sum(own).toFixed(4)}`);
    console.log(`Per-script at scale (own cost + ideation shared across 10): $${(sum(own) + sum(ideation) / 10).toFixed(4)}`);
  }
  console.log(`Total spent: $${spentSoFar().toFixed(4)} of $${SPEND_CAP_USD} cap`);
}

const commands = {
  premises, script,
  cost: () => costReport(args.pick ? +args.pick : null),
  models: async () => console.table((await listOpenRouterModels(argv[1] ?? "")).slice(0, 40)),
};
if (!commands[cmd]) { console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(0, 6).join("\n")); process.exit(1); }
await commands[cmd]();
