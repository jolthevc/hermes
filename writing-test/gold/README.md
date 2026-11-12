# Gold baseline (internal eval only — never published, never used as writer input)

Transcribe 5–6 real sketches from the reference channels into plain-text screenplays here, one per `.txt` file.
They are mixed blind into the rating set so every AI setup is scored **relative to this ceiling**.

Rules:
- **Pick sketches 20–40s long**, of different types (dialogue-led, visual gag, reaction-led). Prefer ones the raters probably haven't seen.
- **Transcribe what's on screen, not just dialogue**: framings, actions, holds and reactions with rough durations. Use `TEMPLATE.txt`.
- Replace character names with neutral ones (e.g. `CAPTAIN` → `A`, `B`) so names don't give the source away.
- Don't describe the art style. Raters judge the writing as described.
- These files never go into writer prompts, few-shot examples, or anything published. They're only for measuring.

Then run:

```
node src/cli.mjs convert --show <show-id> --source gold
```

Raters get an "I've seen this before" box; recognized sketches are dropped from the scores.
