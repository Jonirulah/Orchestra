import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAFETY_MIN, classifyInput, compactKey, compactWindow, decideCompact, nextDraft, parseDevOverride, pushLog } from './autocompact.ts';
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
  assert.equal(d.reason, 'ttl-too-short');
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

test('ttl-too-short: an empty window [afterMin, ttl-3) is reported at any time, not as too-early/too-late', () => {
  // Caché de 5 min: la ventana va de 50 a 2 min, vacía.
  for (const m of [1, 4, 30, 55]) {
    assert.equal(decideCompact(base({}, { cacheTtl: 300, lastRequestAt: NOW - m * 60 })).reason, 'ttl-too-short', `min ${m}`);
  }
  // Borde: from == to también está vacía.
  assert.equal(decideCompact(base({ afterMin: 57 }, { cacheTtl: 3600 })).reason, 'ttl-too-short');
  // Con una ventana de verdad (afterMin 1, caché 5 min = [1, 2)) sí actúa.
  assert.equal(decideCompact(base({ afterMin: 1 }, { cacheTtl: 300, lastRequestAt: NOW - 90 })).compact, true);
});

test('user-typed: a pending draft in the prompt blocks compacting', () => {
  const lr = NOW - 55 * 60;
  const typed = nextDraft(undefined, 'borrador', (lr + 60) * 1000);
  assert.equal(decideCompact(base({ draft: typed })).reason, 'user-typed');
  // Escrito MIENTRAS el agente trabajaba (antes de lastRequestAt): sigue en el prompt y también bloquea.
  const early = nextDraft(undefined, 'a medias', (lr - 30) * 1000);
  assert.equal(decideCompact(base({ draft: early })).reason, 'user-typed');
  // Se comprueba antes de consultar la inactividad del sistema.
  assert.equal(decideCompact(base({ draft: typed, userIdleSec: null })).reason, 'user-typed');
});

test('user-typed: the Enter that sent the message, or Ctrl+C, leaves the prompt empty', () => {
  const lr = NOW - 55 * 60;
  let d = nextDraft(undefined, 'hola', (lr - 5) * 1000);
  d = nextDraft(d, '\r', (lr - 4) * 1000);
  assert.deepEqual(d, { draft: false, lastInputAt: (lr - 4) * 1000 });
  assert.equal(decideCompact(base({ draft: d })).compact, true);
  // Un Enter de más sobre el prompt vacío después de la respuesta: tampoco hay borrador.
  assert.equal(decideCompact(base({ draft: nextDraft(d, '\r', (lr + 10) * 1000) })).compact, true);
  // Pegar con Enter final en el mismo trozo = enviado.
  assert.equal(nextDraft(undefined, 'texto pegado\r', 1).draft, false);
  // Ctrl+C vacía el prompt de Claude.
  assert.equal(nextDraft(nextDraft(undefined, 'xx', 1), '\x03', 2).draft, false);
});

test('classifyInput: terminal replies and a lone Esc are noise and keep the previous state', () => {
  for (const n of ['\x1b[I', '\x1b[O', '\x1b[<0;10;5M', '\x1b[<0;10;5m', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b]11;rgb:0000/0000/0000\x07', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', '\x1b']) {
    assert.equal(classifyInput(n), 'noise', JSON.stringify(n));
  }
  const d = nextDraft(undefined, 'x', 5);
  assert.deepEqual(nextDraft(d, '\x1b[O', 99), d);
  assert.deepEqual(nextDraft(undefined, '\x1b[I', 9), { draft: false, lastInputAt: 0 });
  for (const t of ['a', '\x7f', '\x1b[A', '\x1b[200~pegado\x1b[201~', 'ñ']) assert.equal(classifyInput(t), 'typing', JSON.stringify(t));
  assert.equal(classifyInput('\r'), 'submit');
  assert.equal(classifyInput('\x03'), 'clear');
});

test('parseDevOverride: seconds to minutes, ignores junk, null when empty', () => {
  assert.equal(parseDevOverride(undefined), null);
  assert.equal(parseDevOverride(''), null);
  assert.equal(parseDevOverride('foo=1,ctxK=abc'), null);
  assert.deepEqual(parseDevOverride('ctxK=1, afterSec=30,idleSec=0'), { ctxK: 1, afterMin: 0.5, userIdleMin: 0 });
});
