// Guardián: las animaciones CSS infinitas solo pueden animar transform y opacity.
// Cualquier otra propiedad (box-shadow, left, background...) no la puede mover el compositor: obliga a recalcular estilo
// y repintar en el hilo principal en cada fotograma, a la frecuencia del monitor (240 Hz aquí), mientras dure. Con varios
// agentes ocupados en la barra lateral eso era lo que más gastaba del renderizador (docs/dev-notes/_estado_lag-render.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const COMPOSITED = new Set(['transform', 'opacity']);

function files(): string[] {
  const out = [join(ROOT, 'app.css')];
  for (const d of ['components', 'lib']) {
    for (const f of readdirSync(join(ROOT, d))) if (f.endsWith('.svelte')) out.push(join(ROOT, d, f));
  }
  return out;
}

/** Bloques `@keyframes nombre { ... }` → propiedades que animan. */
export function keyframeProps(css: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let depth = 1, i = re.lastIndex;
    while (i < css.length && depth > 0) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
    const body = css.slice(re.lastIndex, i - 1);
    const props = new Set<string>();
    for (const p of body.matchAll(/([a-z-]+)\s*:/g)) props.add(p[1]);
    out.set(m[1], props);
  }
  return out;
}

/** Nombres de animación usados con `infinite` en declaraciones `animation:`. */
export function infiniteAnimations(css: string, names: Iterable<string>): string[] {
  const known = new Set(names);
  const out: string[] = [];
  for (const d of css.matchAll(/(?<![\w-])animation\s*:\s*([^;}]+)/g)) {
    for (const part of d[1].split(',')) {
      if (!/\binfinite\b/.test(part)) continue;
      const name = part.trim().split(/\s+/).find((tok) => known.has(tok));
      if (name) out.push(name);
    }
  }
  return out;
}

test('el detector ve una animación infinita de box-shadow (comprobación del propio guardián)', () => {
  const css = '.a { animation: ring 1.6s ease-out infinite; } @keyframes ring { 0% { box-shadow: 0 0 0 0 red; } 100% { box-shadow: 0 0 0 7px transparent; } }';
  const kf = keyframeProps(css);
  assert.deepEqual(infiniteAnimations(css, kf.keys()), ['ring']);
  assert.deepEqual([...kf.get('ring')!], ['box-shadow']);
});

test('las animaciones infinitas solo animan transform/opacity (las mueve el compositor)', () => {
  const bad: string[] = [];
  for (const f of files()) {
    const css = readFileSync(f, 'utf8');
    const kf = keyframeProps(css);
    for (const name of infiniteAnimations(css, kf.keys())) {
      const extra = [...kf.get(name)!].filter((p) => !COMPOSITED.has(p));
      if (extra.length) bad.push(`${f.slice(ROOT.length + 1)}: @keyframes ${name} anima ${extra.join(', ')}`);
    }
  }
  assert.deepEqual(bad, []);
});
