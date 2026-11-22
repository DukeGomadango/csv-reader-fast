# csv-reader-fast

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/dukegomadango/csv-reader-fast/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/dukegomadango/csv-reader-fast/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's csv-reader 1.0.0: `solve.js` exports `run({text, header})`, which returns the same `{columns, rows, errors}` as the reference for every input, including broken CSV, and `runBuffer(input)`, which returns that answer as JSON text. Plain JavaScript only: no WebAssembly, no native code, no prebuilt binary.

How it is fast: the text is handled as its UTF-8 bytes, and runs of clean records are turned into JSON rows by a single sticky regexp replace (the regexp engine does the per-field work, so there is almost no per-field JavaScript, no arrays of fields and no `JSON.stringify` of rows). Records that are not clean (another width, a stray CR, characters after a closing quote, a quote that never closes) are read one at a time by csv-reader's own algorithm. `main.ts` is the harness driver: it parses `cases.json` as latin1 when that is safe, so no text is decoded or re-encoded, and writes each answer's JSON as it is.

## Run it

```sh
node main.ts   # reads /input/cases.json, writes /output/answers.json (MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override)
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
