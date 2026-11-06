import test from 'node:test';
import assert from 'node:assert/strict';
import type { SubEvent, SubChunk } from './backend.ts';
import { emptyState, mergeChunk, buildItems, preview, fmtTime, atBottom, pollDelay } from './subtranscript.ts';

const ev = (kind: SubEvent['kind'], text = '', extra: Partial<SubEvent> = {}): SubEvent => ({ kind, text, error: false, ...extra });
const chunk = (events: SubEvent[], nextOffset: number, done = false): SubChunk => ({ events, nextOffset, done });

test('mergeChunk añade al final y guarda el desplazamiento', () => {
  let s = mergeChunk(emptyState(), chunk([ev('text', 'a'), ev('text', 'b')], 100));
  s = mergeChunk(s, chunk([ev('text', 'c')], 150, true));
  assert.deepEqual(s.rows.map((r) => r.text), ['a', 'b', 'c']);
  assert.equal(s.offset, 150);
  assert.equal(s.done, true);
  assert.equal(new Set(s.rows.map((r) => r.key)).size, 3);
});

test('mergeChunk: un chunk vacío no cambia las filas pero sí el estado de fin', () => {
  const s = mergeChunk(mergeChunk(emptyState(), chunk([ev('text', 'a')], 10)), chunk([], 10, true));
  assert.equal(s.rows.length, 1);
  assert.equal(s.done, true);
});

test('mergeChunk mantiene como mucho `max` eventos y cuenta los descartados', () => {
  const many = Array.from({ length: 12 }, (_, i) => ev('text', String(i)));
  const s = mergeChunk(emptyState(), chunk(many, 1), 5);
  assert.deepEqual(s.rows.map((r) => r.text), ['7', '8', '9', '10', '11']);
  assert.equal(s.dropped, 7);
});

test('mergeChunk: si el desplazamiento retrocede (fichero rehecho) empieza de cero', () => {
  let s = mergeChunk(emptyState(), chunk([ev('text', 'viejo')], 500));
  s = mergeChunk(s, chunk([ev('text', 'nuevo')], 40));
  assert.deepEqual(s.rows.map((r) => r.text), ['nuevo']);
});

test('mergeChunk no muta el estado anterior', () => {
  const a = mergeChunk(emptyState(), chunk([ev('text', 'a')], 1));
  mergeChunk(a, chunk([ev('text', 'b')], 2));
  assert.equal(a.rows.length, 1);
});

test('buildItems empareja el resultado con su llamada', () => {
  const s = mergeChunk(emptyState(), chunk([
    ev('prompt', 'haz'), ev('tool', '', { tool: 'Bash', summary: 'ls', id: 't1' }), ev('result', 'out', { id: 't1', error: true }), ev('text', 'fin'),
  ], 1));
  const it = buildItems(s.rows);
  assert.deepEqual(it.map((x) => x.kind), ['prompt', 'tool', 'text']);
  assert.deepEqual(it[1].result, { text: 'out', error: true });
});

test('buildItems: un resultado huérfano sale suelto', () => {
  const it = buildItems(mergeChunk(emptyState(), chunk([ev('result', 'x', { id: 'zz' })], 1)).rows);
  assert.equal(it.length, 1);
  assert.equal(it[0].kind, 'result');
});

test('buildItems: el texto con HTML/markdown no se toca (se pinta como texto)', () => {
  const raw = '<img src=x onerror=alert(1)> **b**';
  const it = buildItems(mergeChunk(emptyState(), chunk([ev('text', raw)], 1)).rows);
  assert.equal(it[0].text, raw);
});

test('preview recorta por caracteres', () => {
  assert.deepEqual(preview('abc', 5), { head: 'abc', more: false });
  assert.deepEqual(preview('abcdef', 3), { head: 'abc', more: true });
  assert.equal(preview('\u{1F600}\u{1F600}\u{1F600}\u{1F600}', 2).head, '\u{1F600}\u{1F600}');
});

test('fmtTime', () => {
  assert.equal(fmtTime('basura'), '');
  assert.equal(fmtTime(null), '');
  assert.match(fmtTime('2026-01-01T10:20:30Z'), /^\d\d:\d\d:\d\d$/);
});

test('atBottom con margen', () => {
  assert.equal(atBottom(776, 200, 1000), true);
  assert.equal(atBottom(700, 200, 1000), false);
});

test('pollDelay: nada si está cerrado u oculto; lento si terminó', () => {
  assert.equal(pollDelay(false, true, false), null);
  assert.equal(pollDelay(true, false, false), null);
  assert.equal(pollDelay(true, true, false), 1500);
  assert.equal(pollDelay(true, true, true), 5000);
});

test('el cajón pinta todo como texto: nada de {@html}, innerHTML ni eval', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../components/SubagentDrawer.svelte', import.meta.url), 'utf8');
  for (const bad of ['{@html', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'marked', 'markdown']) {
    assert.equal(src.includes(bad), false, `SubagentDrawer.svelte contiene ${bad}`);
  }
  // Y el backend nunca recibe una ruta: solo ids.
  const be = readFileSync(new URL('./backend.ts', import.meta.url), 'utf8');
  assert.match(be, /invoke<SubChunk>\('agent_transcript', \{ paneId, subagentId, afterOffset \}\)/);
});
