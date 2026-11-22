import { isUtf8 } from 'node:buffer';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 flags, set before solve.js is imported: incremental marking off (as the house baseline's driver does); no optimizing
// compiler (the work is short, one pass of regexps and a few loops, and compiling costs more CPU than it saves); regexps are
// compiled to native code at once instead of being interpreted on their first run.
setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--no-opt');
setFlagsFromString('--no-regexp-tier-up');

const { runBuffer } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  runBuffer: (input: unknown, isBytes: boolean) => Buffer;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The program the harness runs (node 22: node /bot/main.ts). It reads every case from /input/cases.json, answers each one alone
// with solve.js, and writes /output/answers.json: a JSON array of the answers, one per case and in the cases' order.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// cases.json is UTF-8 JSON. When it holds no \u escape, it is parsed as latin1 (one char per byte), so every text arrives as its
// UTF-8 bytes and nothing is decoded or encoded again; otherwise it is decoded as usual. solve.js's runBuffer(input, isBytes)
// returns each answer as JSON text (a Buffer), which is written out as it is.
const raw = readFileSync(join(INPUT_DIR, 'cases.json'));
type Case = { id: string; input: unknown };
let cases: Case[];
let isBytes = false;
if (isUtf8(raw)) {
  const s = raw.latin1Slice(0, raw.length);
  if (!s.includes('\\u')) {
    cases = JSON.parse(s) as Case[];
    isBytes = true;
  }
}
cases ??= JSON.parse(raw.toString('utf8')) as Case[];

const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
const put = (b: Buffer | string) => {
  const buf = typeof b === 'string' ? Buffer.from(b) : b;
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
};
put('[');
for (let i = 0; i < cases.length; i++) {
  if (i > 0) put(',');
  put(runBuffer(cases[i].input, isBytes));
}
put(']');
closeSync(fd);
process.exit(0);
