# Writing test

This test answers one question before any renderer work: can the writers' room produce sketches worth posting, measured against real reference sketches?

## Sources in the blind set
| id | Source | How |
|---|---|---|
| A | Opus 5.5, one-shot | `generate --setup A` |
| B | Opus 5.5, multi-stage (pitch 36 premises, pick 12, draft, punch-up) | `generate --setup B` |
| C | Open-weight model via OpenRouter, same multi-stage | `generate --setup C --model <id>` |
| D | Human-written baseline (~6) | `human/<show>/*.txt` then `convert --source human` |
| G | **Gold**: 5–6 transcribed reference sketches (internal only) | `gold/*.txt` then `convert --source gold` |

Every script, whatever its source, goes through the same converter (Sonnet 5.5, structured output) into the shared beat format (`src/schema.mjs`), then gets rendered in **one identical text format**, so raters can't tell sources apart by formatting. Raters see visual action, holds and reactions, not just dialogue.

**Vocabulary** (`vocab/core.json` plus `shows/<id>/kit.json`): writers never see it. The converter maps each described action to a core or kit token. Anything that fits neither is marked `realization: "insert"` (a video-model insert shot) and logged in `kit_requests`, so frequent requests can become permanent kit actions. The vocabulary never limits what gets written.

## Run it
```
$env:ANTHROPIC_API_KEY / $env:OPENROUTER_API_KEY must be set
node src/cli.mjs models qwen            # pick an open-weight model id
node src/cli.mjs generate --show dragons-accountant --setup A --n 12
node src/cli.mjs generate --show dragons-accountant --setup B --n 12
node src/cli.mjs generate --show dragons-accountant --setup C --n 12 --model <id>
node src/cli.mjs convert  --show dragons-accountant --source human
node src/cli.mjs convert  --show dragons-accountant --source gold
node src/cli.mjs pack     --show dragons-accountant      # out/<show>/blind.json + separate key
node src/cli.mjs judge    --show dragons-accountant --judges opus,sonnet,or:<id>
# ...humans rate blind.json (rating page) -> ratings.json...
node src/cli.mjs analyze  --show dragons-accountant --ratings ratings.json
node src/cli.mjs cost     --show dragons-accountant
```

## What `analyze` reports
- Per source: mean score with 95% bootstrap CI, % postable (score ≥4), and both **as a % of the gold baseline**.
- Human-human agreement: how consistent the raters are with each other. This is the ceiling for any AI judge.
- Each AI judge: Spearman correlation and pairwise agreement with the mean human score.
- Sketches a rater marks "I've seen this before" are excluded.

Every model call is logged with tokens and dollars in `out/ledger.jsonl`. `cost` reports the cost per finished script.
