import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAccount, exhausted, nextReset } from './policy.ts';
import type { Candidate, Quota } from './policy.ts';
import type { Account } from './model.ts';

const NOW = 1_000_000;
const acc = (id: string): Account => ({ id, name: id.toUpperCase(), dir: `C:/${id}`, isDefault: false, color: '#fff' });
const cand = (id: string, quota?: Quota, loggedIn = true): Candidate => ({ acc: acc(id), loggedIn, quota });
const q = (u5: number, r5: number, u7 = 10, r7 = NOW + 5 * 86400): Quota => ({
  fiveHour: { used: u5, resetsAt: r5 }, sevenDay: { used: u7, resetsAt: r7 },
});

test('manual no elige nada', () => {
  assert.equal(pickAccount('manual', [cand('a')], undefined, NOW), null);
});

test('sin cuentas con sesión: null', () => {
  assert.equal(pickAccount('round-robin', [cand('a', undefined, false)], undefined, NOW), null);
});

test('round-robin rota y se salta las que no tienen sesión', () => {
  const cs = [cand('a'), cand('b', undefined, false), cand('c')];
  assert.equal(pickAccount('round-robin', cs, undefined, NOW)!.acc.id, 'a');
  assert.equal(pickAccount('round-robin', cs, 'a', NOW)!.acc.id, 'c');
  assert.equal(pickAccount('round-robin', cs, 'c', NOW)!.acc.id, 'a');
});

test('las agotadas se descartan aunque se reinicien antes', () => {
  const cs = [cand('a', q(100, NOW + 600)), cand('b', q(30, NOW + 3 * 3600)), cand('c', q(10, NOW + 4 * 3600))];
  const p = pickAccount('reset-soonest', cs, undefined, NOW)!;
  assert.equal(p.acc.id, 'b'); // a está agotada; b se reinicia antes que c
  assert.match(p.reason, /resets soonest/);
});

test('una ventana agotada que ya se renovó no cuenta', () => {
  assert.equal(exhausted(q(100, NOW - 10), NOW), false);
  assert.equal(exhausted(q(100, NOW + 10), NOW), true);
  assert.equal(nextReset(q(100, NOW - 10, 10, NOW + 99), NOW), NOW + 99);
});

test('most-free elige la de menor uso del cuello de botella (también la semanal)', () => {
  const cs = [cand('a', q(20, NOW + 100, 90)), cand('b', q(50, NOW + 100, 30)), cand('c', q(10, NOW + 100, 60))];
  assert.equal(pickAccount('most-free', cs, undefined, NOW)!.acc.id, 'b'); // máx: a=90, b=50, c=60
});

test('todas agotadas: la que se libera antes', () => {
  const cs = [cand('a', q(100, NOW + 5000)), cand('b', q(100, NOW + 900))];
  const p = pickAccount('most-free', cs, undefined, NOW)!;
  assert.equal(p.acc.id, 'b');
  assert.match(p.reason, /all exhausted/);
});

test('sin datos de cuota, reset-soonest y most-free caen a round-robin', () => {
  const cs = [cand('a'), cand('b')];
  const p = pickAccount('reset-soonest', cs, 'a', NOW)!;
  assert.equal(p.acc.id, 'b');
  assert.match(p.reason, /no quota data/);
});

test('con datos parciales, la cuenta sin datos va detrás', () => {
  const cs = [cand('a'), cand('b', q(40, NOW + 7200))];
  assert.equal(pickAccount('reset-soonest', cs, undefined, NOW)!.acc.id, 'b');
});
