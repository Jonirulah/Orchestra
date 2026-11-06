import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RECONNECT, backoff, decide, isAuthFailure, reconnectOptsOf } from './reconnect.ts';
import type { DecideIn, ReconnectOpts } from './reconnect.ts';
import { DEFAULTS } from './settings.ts';

const MAX_ATTEMPTS = DEFAULT_RECONNECT.maxAttempts;
const MIN_UP_SEC = DEFAULT_RECONNECT.minUpSec;
const BACKOFF_SEC = [2, 4, 8, 16, 30, 30, 30, 30];

const base: DecideIn = { kind: 'ssh', code: 255, upSec: 120, userInitiated: false, enabled: true, attempt: 0 };
const d = (o: Partial<DecideIn> = {}, opts: ReconnectOpts = DEFAULT_RECONNECT) => decide({ ...base, ...o }, opts);

test('backoff: 2, 4, 8, 16, 30, 30, 30, 30 and clamped outside 1..8', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoff(n)), BACKOFF_SEC);
  assert.equal(backoff(0), 2);
  assert.equal(backoff(-5), 2);
  assert.equal(backoff(9), 30);
  assert.equal(backoff(1000), 30);
  assert.equal(backoff(NaN), 2);
  assert.equal(backoff(2.9), 4);
});

test('a real drop (code 255 after 2 min) reconnects in 2 s, attempt 1', () => {
  const r = d();
  assert.deepEqual(r, { reconnect: true, delaySec: 2, reason: 'ok', attempt: 1 });
});

test('exit code 0 (the user typed exit) never reconnects', () => {
  for (const upSec of [0, 5, 10, 3600]) assert.equal(d({ code: 0, upSec }).reconnect, false, `up ${upSec}`);
  assert.equal(d({ code: 0 }).reason, 'clean-exit');
  assert.equal(d({ code: undefined }).reconnect, false);
});

test('wrong password / unknown host / refused: session shorter than 10 s does not reconnect on a fresh streak', () => {
  for (const upSec of [0, 0.5, 3, 9, MIN_UP_SEC - 0.001]) {
    const r = d({ upSec, attempt: 0 });
    assert.equal(r.reconnect, false, `up ${upSec}`);
    assert.equal(r.reason, 'short-session');
  }
  assert.equal(d({ upSec: MIN_UP_SEC }).reconnect, true, 'exactly 10 s is enough');
});

test('user-initiated stops (close, restart, switch account, cancel) never reconnect', () => {
  const r = d({ userInitiated: true });
  assert.equal(r.reconnect, false);
  assert.equal(r.reason, 'user');
});

test('setting off, or not an ssh pane: no reconnect', () => {
  assert.equal(d({ enabled: false }).reconnect, false);
  assert.equal(d({ enabled: false }).reason, 'disabled');
  for (const kind of ['shell', 'agent']) {
    assert.equal(d({ kind }).reconnect, false);
    assert.equal(d({ kind }).reason, 'not-ssh');
  }
});

test('max 8 attempts: 1..8 reconnect, the 9th does not', () => {
  for (let made = 0; made < MAX_ATTEMPTS; made++) {
    const r = d({ upSec: 0.2, attempt: made === 0 ? 0 : made, ...(made === 0 ? { upSec: 60 } : {}) });
    assert.equal(r.reconnect, true, `after ${made} attempts`);
    assert.equal(r.attempt, made + 1);
    assert.equal(r.delaySec, backoff(made + 1));
  }
  const last = d({ upSec: 0.2, attempt: MAX_ATTEMPTS });
  assert.equal(last.reconnect, false);
  assert.equal(last.reason, 'max-attempts');
  assert.equal(d({ upSec: 0.2, attempt: 50 }).reconnect, false);
});

test('inside a streak a fast failure keeps retrying (the network is still down)', () => {
  const r = d({ upSec: 0.3, attempt: 3 });
  assert.deepEqual(r, { reconnect: true, delaySec: 16, reason: 'ok', attempt: 4 });
});

test('a reconnect that stayed up >= 10 s resets the counter', () => {
  const r = d({ upSec: 45, attempt: 7 });
  assert.equal(r.reconnect, true);
  assert.equal(r.attempt, 1);
  assert.equal(r.delaySec, 2);
  // incluso con el contador agotado: la sesión sí llegó a estar viva
  assert.equal(d({ upSec: 45, attempt: MAX_ATTEMPTS }).reconnect, true);
});

test('authentication failures never reconnect, even in a streak or after a long wait at the prompt', () => {
  assert.equal(d({ authFailed: true }).reconnect, false);
  assert.equal(d({ authFailed: true }).reason, 'auth-failed');
  assert.equal(d({ authFailed: true, attempt: 3, upSec: 0.1 }).reconnect, false);
});

test('isAuthFailure recognises the ssh endings that must not loop, and not plain network drops', () => {
  assert.ok(isAuthFailure('deploy@10.0.0.5: Permission denied (publickey,password).'));
  assert.ok(isAuthFailure('Host key verification failed.'));
  assert.ok(isAuthFailure('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@'));
  assert.ok(isAuthFailure('Received disconnect from x: Too many authentication failures'));
  assert.equal(isAuthFailure('client_loop: send disconnect: Connection reset'), false);
  assert.equal(isAuthFailure('packet_write_wait: Connection to 10.0.0.5 port 22: Broken pipe'), false);
  assert.equal(isAuthFailure('ssh: connect to host x port 22: Connection timed out'), false);
  assert.equal(isAuthFailure(''), false);
});

test('decide never returns a delay outside the table and is pure (same input, same output)', () => {
  for (let a = 0; a <= 12; a++) {
    for (const upSec of [0, 20]) {
      const x = d({ attempt: a, upSec });
      assert.deepEqual(x, d({ attempt: a, upSec }));
      if (x.reconnect) assert.ok(BACKOFF_SEC.includes(x.delaySec) && x.attempt >= 1 && x.attempt <= MAX_ATTEMPTS);
    }
  }
});

test('the built-in defaults are exactly the settings defaults (no drift between reconnect.ts and settings.ts)', () => {
  assert.deepEqual(reconnectOptsOf(DEFAULTS), DEFAULT_RECONNECT);
  assert.equal(DEFAULTS.sshAutoReconnect, true);
});

const custom = (o: Partial<ReconnectOpts>): ReconnectOpts => ({ ...DEFAULT_RECONNECT, ...o });

test('custom backoff: factor 1 = fixed delay, factor 3, first delay and max delay', () => {
  const fixed = custom({ factor: 1, firstDelaySec: 7 });
  assert.deepEqual([1, 2, 3, 9, 100].map((n) => backoff(n, fixed)), [7, 7, 7, 7, 7]);
  const f3 = custom({ factor: 3, firstDelaySec: 1, maxDelaySec: 50 });
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => backoff(n, f3)), [1, 3, 9, 27, 50, 50]);
  const frac = custom({ factor: 1.5, firstDelaySec: 2, maxDelaySec: 600 });
  assert.deepEqual([1, 2, 3, 4].map((n) => backoff(n, frac)), [2, 3, 5, 7]);
  assert.equal(backoff(1000, custom({ maxDelaySec: 600 })), 600);
  assert.equal(backoff(3, custom({ firstDelaySec: 60, maxDelaySec: 5 })), 5, 'max delay wins over the first delay');
  assert.ok(backoff(1, custom({ firstDelaySec: 0 })) >= 1, 'never below 1 s');
});

test('custom attempts: cap of 3, cap of 1, and 0 = unlimited', () => {
  const three = custom({ maxAttempts: 3 });
  assert.equal(d({ upSec: 0.1, attempt: 2 }, three).reconnect, true);
  assert.equal(d({ upSec: 0.1, attempt: 3 }, three).reconnect, false);
  assert.equal(d({ upSec: 0.1, attempt: 3 }, three).reason, 'max-attempts');
  const one = custom({ maxAttempts: 1 });
  assert.equal(d({}, one).reconnect, true);
  assert.equal(d({ upSec: 0.1, attempt: 1 }, one).reconnect, false);
  const inf = custom({ maxAttempts: 0 });
  for (const a of [8, 9, 50, 500, 100000]) {
    const r = d({ upSec: 0.1, attempt: a }, inf);
    assert.equal(r.reconnect, true, `attempt ${a}`);
    assert.equal(r.attempt, a + 1);
    assert.equal(r.delaySec, 30);
  }
});

test('custom minimum uptime: 0 counts every non-zero exit, 60 s needs a longer session', () => {
  assert.equal(d({ upSec: 0 }, custom({ minUpSec: 0 })).reconnect, true);
  assert.equal(d({ upSec: 59 }, custom({ minUpSec: 60 })).reconnect, false);
  assert.equal(d({ upSec: 60 }, custom({ minUpSec: 60 })).reconnect, true);
  assert.equal(d({ upSec: 20, attempt: 5 }, custom({ minUpSec: 30 })).attempt, 6, 'below minUp the streak continues');
  assert.equal(d({ upSec: 31, attempt: 5 }, custom({ minUpSec: 30 })).attempt, 1, 'above minUp the streak resets');
  // y una contraseña mala sigue sin repetirse aunque minUpSec sea 0
  assert.equal(d({ upSec: 0, authFailed: true }, custom({ minUpSec: 0 })).reconnect, false);
});

test("exit codes: 'nonzero' reconnects on any non-zero, '255' only on ssh connection errors", () => {
  const only255 = custom({ codes: '255' });
  for (const code of [1, 2, 127, 130, -1]) {
    assert.equal(d({ code }).reconnect, true, `nonzero ${code}`);
    const r = d({ code }, only255);
    assert.equal(r.reconnect, false, `255-only ${code}`);
    assert.equal(r.reason, 'other-code');
  }
  assert.equal(d({ code: 255 }, only255).reconnect, true);
  assert.equal(d({ code: 0 }, only255).reconnect, false);
  assert.equal(d({ code: 0 }, only255).reason, 'clean-exit');
});
