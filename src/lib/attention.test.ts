import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertPlan, fmtSince, nextWaiting, paneOrder, trackWaiting, waitRows, waitingPerWs } from './attention.ts';

// Dos pestañas: A (a1, a2, a3 aparcado) y B (b1, b2).
const ws = [
  { id: 'A', panes: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3', parked: true }] },
  { id: 'B', panes: [{ id: 'b1' }, { id: 'b2' }] },
];
const order = paneOrder(ws);

test('paneOrder recorre pestaña a pestaña', () => {
  assert.deepEqual(order.map((o) => `${o.wsId}:${o.paneId}`), ['A:a1', 'A:a2', 'A:a3', 'B:b1', 'B:b2']);
});

test('nextWaiting: ninguno espera → null', () => {
  assert.equal(nextWaiting(order, new Set(), 'a1'), null);
});

test('nextWaiting: rota entre los que esperan, cruzando pestañas y volviendo al principio', () => {
  const w = new Set(['a2', 'b2']);
  assert.equal(nextWaiting(order, w, 'a1'), 'a2');
  assert.equal(nextWaiting(order, w, 'a2'), 'b2'); // salta de pestaña
  assert.equal(nextWaiting(order, w, 'b2'), 'a2'); // vuelta al principio
  assert.equal(nextWaiting(order, w, 'b1'), 'b2');
});

test('nextWaiting: incluye los aparcados (segundo plano)', () => {
  assert.equal(nextWaiting(order, new Set(['a3']), 'a1'), 'a3');
});

test('nextWaiting: si el actual es el único, se queda en él; sin foco o foco desconocido, el primero', () => {
  assert.equal(nextWaiting(order, new Set(['b1']), 'b1'), 'b1');
  assert.equal(nextWaiting(order, new Set(['b1', 'a2']), undefined), 'a2');
  assert.equal(nextWaiting(order, new Set(['b1', 'a2']), 'zzz'), 'a2');
});

test('nextWaiting: ignora ids que esperan pero ya no existen', () => {
  assert.equal(nextWaiting(order, new Set(['gone']), 'a1'), null);
});

test('waitingPerWs cuenta por pestaña', () => {
  assert.deepEqual(waitingPerWs(ws, new Set(['a2', 'a3', 'b2'])), { A: 2, B: 1 });
  assert.deepEqual(waitingPerWs(ws, new Set()), {});
});

test('waitRows: solo los que esperan, el más antiguo primero, con qué piden', () => {
  const now = 100_000;
  const agents = [
    { paneId: 'a1', status: 'busy' },
    { paneId: 'a2', status: 'waiting', waitingFor: ' Bash: rm -rf build ' },
    { paneId: 'b2', status: 'waiting' },
    { paneId: 'gone', status: 'waiting' },
  ];
  const titles: Record<string, string> = { a1: 'Uno', a2: 'Dos', b2: 'Cinco' };
  const rows = waitRows(agents, { a2: now - 30_000, b2: now - 200_000 }, now, (id) => titles[id]);
  assert.deepEqual(rows, [
    { paneId: 'b2', title: 'Cinco', asks: '', sinceSec: 200 },
    { paneId: 'a2', title: 'Dos', asks: 'Bash: rm -rf build', sinceSec: 30 },
  ]);
});

test('fmtSince', () => {
  assert.equal(fmtSince(2), '');
  assert.equal(fmtSince(45), '45 s');
  assert.equal(fmtSince(185), '3 min');
  assert.equal(fmtSince(7300), '2 h');
});

test('trackWaiting conserva el inicio y avisa solo de los nuevos', () => {
  const a = trackWaiting({}, ['x'], 10);
  assert.deepEqual(a, { since: { x: 10 }, started: ['x'] });
  const b = trackWaiting(a.since, ['x', 'y'], 20);
  assert.deepEqual(b, { since: { x: 10, y: 20 }, started: ['y'] });
  const c = trackWaiting(b.since, ['y'], 30);
  assert.deepEqual(c, { since: { y: 20 }, started: [] });
  // vuelve a esperar: cuenta desde cero y avisa otra vez
  assert.deepEqual(trackWaiting(c.since, ['x', 'y'], 40).started, ['x']);
});

test('alertPlan: delante no molesta; detrás parpadea y notifica si el ajuste lo deja', () => {
  assert.deepEqual(alertPlan(true, true), { flash: false, notify: false });
  assert.deepEqual(alertPlan(false, true), { flash: true, notify: true });
  assert.deepEqual(alertPlan(false, false), { flash: true, notify: false });
});
