import test from 'node:test';
import assert from 'node:assert/strict';
import { tokK, tokSummary } from './tokfmt.ts';

test('tokK abrevia con k, M y B', () => {
  assert.equal(tokK(42), '42');
  assert.equal(tokK(999), '999');
  assert.equal(tokK(1000), '1k');
  assert.equal(tokK(289_400), '289k');
  assert.equal(tokK(1_500_000), '1.5M');
  assert.equal(tokK(2_300_000_000), '2.3B');
});

test('tokK no revienta con datos raros', () => {
  assert.equal(tokK(NaN), '0');
  assert.equal(tokK(-5), '0');
  assert.equal(tokK(Infinity), '0');
});

test('tokSummary: contexto, entrada nueva y salida; vacío sin datos', () => {
  assert.equal(tokSummary(289_000, 4_700_000, 1_500_000), '289k · ↑4.7M ↓1.5M');
  assert.equal(tokSummary(0, 0, 0), '');
  assert.equal(tokSummary(61_000, 0, 789), '61k · ↑0 ↓789');
  assert.equal(tokSummary(0, 10, 0), '↑10 ↓0');
});
