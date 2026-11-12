# Human baseline (setup D)

Have you or a funny friend write about 6 sketches for the pilot show after reading `shows/<show-id>/bible.md`.
Use the same format as `gold/TEMPLATE.txt`, with visual action, holds and reactions written in, not just dialogue.
Put them in `human/<show-id>/*.txt`, then run:

```
node src/cli.mjs convert --show <show-id> --source human
```

Don't read the AI scripts before writing these.
