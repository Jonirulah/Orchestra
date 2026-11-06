import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAFETY_MIN, compactKey, compactWindow, decideCompact, pushLog } from './autocompact.ts';
import type { CompactInput } from './autocompact.ts';

const NOW = 1_000_000;
/** Entrada que cumple todo: 55 min tras la última petición con TTL de 1 h y 200 k de contexto. */
function base(over: Partial<CompactInput> = {}, agent: Partial<CompactInput['agent']> = {}): CompactInput {
  return {
    enabled: true,
    agent: { agent: 'claude', status: 'idle', sessionId: 's1', ctxTokens: 200_000, lastRequestAt: NOW - 55 * 60, cacheTtl: 3600, ...agent },
    nowSec: NOW, userIdleSec: 600, ctxK: 150, afterMin: 50, userIdleMin: 5, done: new Set<string>(),
    ...over,
  };
}

test('all conditions true: compacts', () => {
  assert.deepEqual(decideCompact(base()), { compact: true, reason: 'ok' });
});

test('each condition failing alone gives false with its own reason', () => {
  const cases: [string, CompactInput][] = [
    ['disabled', base({ enabled: false })],
    ['not-claude', base({}, { agent: 'codex' })],
    ['not-idle', base({}, { status: 'busy' })],
    ['no-session', base({}, { sessionId: undefined })],
    ['context-too-small', base({}, { ctxTokens: 149_999 })],
    ['no-last-request', base({}, { lastRequestAt: undefined })],
    ['too-early', base({}, { lastRequestAt: NOW - 49 * 60 })],
    ['too-late', base({}, { lastRequestAt: NOW - 58 * 60 })],
    ['already-done', base({ done: new Set([compactKey({ sessionId: 's1', lastRequestAt: NOW - 55 * 60 })]) })],
    ['user-active', base({ userIdleSec: 299 })],
  ];
  for (const [reason, inp] of cases) {
    const d = decideCompact(inp);
    assert.equal(d.compact, false, reason);
    assert.equal(d.reason, reason);
  }
});

test('context threshold edge: exactly ctxK*1000 is enough', () => {
  assert.equal(decideCompact(base({}, { ctxTokens: 150_000 })).compact, true);
  assert.equal(decideCompact(base({ ctxK: 300 }, { ctxTokens: 299_999 })).reason, 'context-too-small');
});

test('window edges: from afterMin (inclusive) to ttl - 3 min (exclusive)', () => {
  assert.equal(decideCompact(base({}, { lastRequestAt: NOW - 50 * 60 })).compact, true);
  assert.equal(decideCompact(base({}, { lastRequestAt: NOW - (50 * 60 - 1) })).reason, 'too-early');
  assert.equal(decideCompact(base({}, { lastRequestAt: NOW - (57 * 60 - 1) })).compact, true);
  assert.equal(decideCompact(base({}, { lastRequestAt: NOW - 57 * 60 })).reason, 'too-late');
});

test('window follows the cache TTL (5 min cache: never reaches 50 min)', () => {
  assert.deepEqual(compactWindow(50, 3600), { from: 50, to: 60 - SAFETY_MIN });
  assert.deepEqual(compactWindow(50, 0), { from: 50, to: 57 });
  const d = decideCompact(base({}, { cacheTtl: 300, lastRequestAt: NOW - 51 * 60 }));
  assert.equal(d.compact, false);
  assert.equal(d.reason, 'too-late');
});

test('user idle edge: exactly the threshold counts as away', () => {
  assert.equal(decideCompact(base({ userIdleSec: 300 })).compact, true);
  assert.equal(decideCompact(base({ userIdleMin: 10, userIdleSec: 599 })).reason, 'user-active');
});

test('idle probe is only needed once everything else passes', () => {
  assert.equal(decideCompact(base({ userIdleSec: null })).reason, 'needs-idle-check');
  // Si algo más falla antes, no hace falta consultar el sistema.
  assert.equal(decideCompact(base({ userIdleSec: null }, { status: 'busy' })).reason, 'not-idle');
  assert.equal(decideCompact(base({ userIdleSec: null }, { agent: 'codex' })).reason, 'not-claude');
});

test('done set is per (session, lastRequestAt): a new request re-arms it', () => {
  const t = NOW - 55 * 60;
  const done = new Set([compactKey({ sessionId: 's1', lastRequestAt: t })]);
  assert.equal(decideCompact(base({ done })).reason, 'already-done');
  assert.equal(decideCompact(base({ done }, { lastRequestAt: t + 60 })).compact, true);
  assert.equal(decideCompact(base({ done }, { sessionId: 's2' })).compact, true);
});

test('pushLog keeps the latest 20, newest first', () => {
  let log: ReturnType<typeof pushLog> = [];
  for (let n = 0; n < 25; n++) log = pushLog(log, { at: n, title: `t${n}`, ctxTokens: 1 });
  assert.equal(log.length, 20);
  assert.equal(log[0].title, 't24');
  assert.equal(log[19].title, 't5');
});
