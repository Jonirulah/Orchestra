// Densidad de la tabla MCP (v7): UNA densidad por tabla según el ancho (normal → compacta → ventana de columnas
// enteras); el contenido de una celda nunca se recorta ni se abrevia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellWidth, columnMinWidth, tableLayout, windowFor } from './mcpmatrix.ts';
import type { CellParts, Density } from './mcpmatrix.ts';

const m = (s: string) => s.length * 7;
const auth: CellParts = { version: null, scope: 'usuario', status: 'login', statusIcon: true };
const gh: CellParts = { version: 'A/B', scope: '2 ámbitos', status: '26', statusIcon: true };
const slow: CellParts = { version: null, scope: 'proyecto', status: 'sin respuesta', statusIcon: true };
const COLS: CellParts[][] = [[auth, gh], [slow], [gh, slow], [auth], [gh], [slow, auth], [auth]];
const mins = (d: Density) => COLS.map((c) => columnMinWidth(c, d, m, 80));

test('compacta = sin la palabra del ámbito; el estado es el mismo en las dos densidades', () => {
  assert.equal(cellWidth(auth, 'normal', m) - cellWidth(auth, 'compact', m), 3 + m('usuario'));
});

test('una sola densidad por tabla: todas las celdas que se ven caben enteras en la densidad elegida', () => {
  const N = mins('normal'), C = mins('compact');
  for (let w = 300; w < 2400; w += 7) for (let s = 0; s < COLS.length; s++) {
    const L = tableLayout(w, 180, N, C, s);
    const W = L.density === 'normal' ? N : C;
    // Lo que se ve (columnas enteras + flechas) cabe en el ancho, salvo una columna sola que ya no cabe en nada.
    const used = 180 + W.slice(L.start, L.end).reduce((x, y) => x + y, 0) + (L.start > 0 ? 28 : 0) + (L.end < COLS.length ? 28 : 0);
    assert.ok(L.end - L.start === 1 || used <= w, `${w}px desde ${s}: ${used}`);
    assert.ok(L.end > L.start, 'siempre se ve al menos una columna');
    // Cada celda de cada columna visible usa la MISMA densidad (la de la tabla) y cabe en el mínimo de su columna.
    for (let i = L.start; i < L.end; i++) for (const p of COLS[i]) assert.ok(cellWidth(p, L.density, m) <= W[i]);
    if (L.density === 'normal') assert.deepEqual([L.start, L.end], [0, COLS.length]);
  }
});

test('normal si cabe todo; si no, compacta; si tampoco, ventana de columnas enteras con flechas', () => {
  const N = mins('normal'), C = mins('compact');
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  assert.equal(tableLayout(180 + sum(N), 180, N, C).density, 'normal');
  assert.deepEqual(tableLayout(180 + sum(N) - 1, 180, N, C), { density: 'compact', start: 0, end: COLS.length });
  const L = tableLayout(180 + sum(C) - 1, 180, N, C);
  assert.equal(L.density, 'compact');
  assert.ok(L.end < COLS.length && L.start === 0);
});

test('ir a una columna oculta la deja entera a la vista', () => {
  const N = mins('normal'), C = mins('compact');
  const w = 180 + 28 * 2 + C[0] + C[1] + C[2];
  let L = tableLayout(w, 180, N, C, 0);
  for (const idx of [6, 0, 4, 2]) {
    const s = windowFor(idx, L, w, 180, N, C);
    L = tableLayout(w, 180, N, C, s);
    assert.ok(idx >= L.start && idx < L.end, `columna ${idx} en [${L.start}, ${L.end})`);
  }
});
