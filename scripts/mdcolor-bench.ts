// Mide el reescritor del markdown (src/lib/mdcolor.ts) con ≥ 10 MB de salida real de Claude repetida, en trozos como los
// del PTY. Uso: node scripts/mdcolor-bench.ts
import { readFileSync } from 'node:fs';
import { MdColorizer, mdPalette } from '../src/lib/mdcolor.ts';
import { themeOf } from '../src/lib/themes.ts';

const raw = readFileSync(new URL('../docs/dev-notes/fixtures_claude/claude-2.1.322-orchestra-terminal.bin', import.meta.url));
const reps = Math.ceil((10 * 1024 * 1024) / raw.length);
const big = new Uint8Array(raw.length * reps);
for (let i = 0; i < reps; i++) big.set(raw, i * raw.length);
const pal = mdPalette(themeOf('orchestra'));
for (const chunk of [4096, 65536]) {
  const runs: number[] = [];
  let out = 0;
  for (let r = 0; r < 7; r++) {
    const md = new MdColorizer();
    out = 0;
    const t0 = performance.now();
    for (let i = 0; i < big.length; i += chunk) out += md.feed(big.subarray(i, i + chunk), pal).length;
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  const ms = runs[3];
  console.log(`trozos de ${chunk} B: ${(big.length / 1048576).toFixed(1)} MB en ${ms.toFixed(1)} ms (mediana de 7) = ${(big.length / 1048576 / (ms / 1000)).toFixed(0)} MB/s; salida +${(((out - big.length) / big.length) * 100).toFixed(2)} %`);
}
