import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countdownFrac, dotOf, dropCause, fmtClock, fmtDowntime, gaveUpText, separatorText, sshLook, veiled, worstDot } from './sshdrop.ts';
import { setLocale } from './i18n.ts';

const g = { cause: 'timeout' as const, attempt: 3, at: 5000, since: 1000 };

test('sshLook: cada estado del panel', () => {
  assert.equal(sshLook({ kind: 'shell', state: 'exited' }), 'none');
  assert.equal(sshLook({ kind: 'ssh', state: 'running' }), 'up');
  assert.equal(sshLook({ kind: 'ssh', state: 'starting' }), 'up');
  assert.equal(sshLook({ kind: 'ssh', state: 'exited' }), 'exited');
  assert.equal(sshLook({ kind: 'ssh', state: 'exited', reconnecting: { pending: true } }), 'deciding');
  assert.equal(sshLook({ kind: 'ssh', state: 'exited', reconnecting: {}, down: { since: 1 } }), 'waiting');
  assert.equal(sshLook({ kind: 'ssh', state: 'starting', down: { since: 1 } }), 'retrying');
  assert.equal(sshLook({ kind: 'ssh', state: 'running', down: { since: 1 } }), 'retrying');
  assert.equal(sshLook({ kind: 'ssh', state: 'exited', down: { since: 1 } }), 'deciding');
  assert.equal(sshLook({ kind: 'ssh', state: 'exited', gaveUp: g, down: { since: 1 } }), 'gaveup');
});

test('velo y punto: solo mientras está caído; «decidiendo» solo si ya venía caído', () => {
  assert.equal(veiled('up', false), false);
  assert.equal(veiled('exited', false), false);
  assert.equal(veiled('deciding', false), false);
  assert.equal(veiled('deciding', true), true);
  assert.equal(veiled('waiting', true), true);
  assert.equal(veiled('gaveup', false), true);
  assert.equal(dotOf('waiting', true), 'amber');
  assert.equal(dotOf('retrying', true), 'amber');
  assert.equal(dotOf('gaveup', false), 'red');
  assert.equal(dotOf('up', false), null);
  assert.equal(dotOf('exited', false), null);
  assert.equal(worstDot([null, 'amber', 'red']), 'red');
  assert.equal(worstDot([null, 'amber']), 'amber');
  assert.equal(worstDot([]), null);
});

test('countdownFrac va de 0 a 1 y no se sale', () => {
  const rc = { delaySec: 4, at: 10_000 };
  assert.equal(countdownFrac(rc, 6_000), 0);
  assert.equal(countdownFrac(rc, 8_000), 0.5);
  assert.equal(countdownFrac(rc, 10_000), 1);
  assert.equal(countdownFrac(rc, 99_000), 1);
  assert.equal(countdownFrac(rc, 0), 0);
  assert.equal(countdownFrac({ delaySec: 0, at: 0 }, 5), 1);
});

test('fmtDowntime', () => {
  assert.equal(fmtDowntime(0), '0 s');
  assert.equal(fmtDowntime(38_400), '38 s');
  assert.equal(fmtDowntime(60_000), '1 min');
  assert.equal(fmtDowntime(125_000), '2 min 5 s');
  assert.equal(fmtDowntime(3_780_000), '1 h 3 min');
  assert.equal(fmtDowntime(7_200_000), '2 h');
  assert.equal(fmtDowntime(NaN), '0 s');
});

test('separador del terminal, en los dos idiomas', () => {
  const at = new Date(2026, 10, 7, 17, 42, 9).getTime();
  assert.equal(fmtClock(at), '17:42');
  setLocale('es');
  assert.equal(separatorText(at, 38_000), '── reconectado 17:42 · caída 38 s ──');
  setLocale('en');
  assert.equal(separatorText(at, 38_000), '── reconnected 17:42 · down 38 s ──');
});

test('dropCause: motivo legible a partir del final de la salida de ssh', () => {
  assert.equal(dropCause('user@h: Permission denied (publickey,password).', 'auth-failed'), 'auth');
  assert.equal(dropCause('', 'auth-failed'), 'auth');
  assert.equal(dropCause('Host key verification failed.', 'auth-failed'), 'hostkey');
  assert.equal(dropCause('@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @', 'auth-failed'), 'hostkey');
  assert.equal(dropCause('ssh: Could not resolve hostname box: No such host is known.', 'max-attempts'), 'dns');
  assert.equal(dropCause('ssh: connect to host 10.0.0.2 port 22: Connection refused', 'max-attempts'), 'refused');
  assert.equal(dropCause('ssh: connect to host 10.0.0.2 port 22: Connection timed out', 'max-attempts'), 'timeout');
  assert.equal(dropCause('ssh: connect to host 10.0.0.2 port 22: Network is unreachable', 'max-attempts'), 'unreachable');
  assert.equal(dropCause('Connection closed by 10.0.0.2 port 22', 'max-attempts'), 'closed');
  assert.equal(dropCause('???', 'max-attempts'), 'max');
  assert.equal(dropCause('Connection timed out', 'paused'), 'paused');
});

test('texto de la franja roja', () => {
  setLocale('es');
  assert.equal(gaveUpText(g), 'Reconexión abandonada tras 3 intentos: la red no responde (tiempo agotado)');
  setLocale('en');
  assert.equal(gaveUpText({ ...g, cause: 'auth', attempt: 2 }), 'Gave up after 2 attempts: the server rejected the login (password or key)');
  assert.equal(gaveUpText({ ...g, cause: 'dns', attempt: 1 }), 'Gave up after 1 attempt: the host name cannot be resolved');
  assert.equal(gaveUpText({ ...g, cause: 'paused', attempt: 1 }), 'Reconnecting stopped: the pane was hidden while it waited');
});
