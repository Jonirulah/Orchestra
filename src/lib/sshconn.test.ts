import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SshConn } from './sshconn.ts';
import type { ConnCtx, ConnSettings, ConnState, LiveLike, PingRes } from './sshconn.ts';
import { DEFAULTS } from './settings.ts';
import { emptyHost } from './model.ts';
import type { Host, Pane } from './model.ts';
import type { PingTarget } from './latency.ts';

afterEach(() => mock.timers.reset());

const flush = () => new Promise<void>((r) => setImmediate(r));

function mkPane(id: string, o: Partial<Pane> = {}): Pane {
  return { id, col: 0, row: 0, colSpan: 1, rowSpan: 1, parked: false, kind: 'ssh', icon: 'server', title: `srv-${id}`, ref: `h-${id}`, spec: { program: 'ssh', args: [] }, ...o };
}

interface Rig {
  conn: SshConn;
  st: ConnState;
  s: ConnSettings;
  panes: Map<string, { pane: Pane; visible: boolean }>;
  live: Map<string, LiveLike>;
  restarts: string[];
  toasts: string[];
  pings: PingTarget[][];
  timeouts: number[];
  tail: { text: string };
  clock: { now: number; visible: boolean };
  pingImpl: { fn: (t: PingTarget[]) => PingRes[] };
}

function rig(opts: Partial<ConnSettings> = {}, ids = ['a']): Rig {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const s = { ...DEFAULTS, ...opts } as ConnSettings;
  const panes = new Map<string, { pane: Pane; visible: boolean }>();
  const live = new Map<string, LiveLike>();
  const hosts: Host[] = [];
  for (const id of ids) {
    panes.set(id, { pane: mkPane(id), visible: true });
    hosts.push({ ...emptyHost(), id: `h-${id}`, name: id, host: `${id}.example.com` });
    live.set(id, { state: 'running', startedAt: Date.now() - 600_000, firstOutputAt: Date.now() - 590_000 });
  }
  const r = {
    st: { latency: {}, reconnecting: {}, flash: {} } as ConnState, s, panes, live, restarts: [] as string[], toasts: [] as string[],
    pings: [] as PingTarget[][], timeouts: [] as number[], tail: { text: '' }, clock: { now: 0, visible: true },
    pingImpl: { fn: (t: PingTarget[]): PingRes[] => t.map((x) => ({ id: x.id, ms: 25, error: null })) },
  } as unknown as Rig;
  const ctx: ConnCtx = {
    settings: () => r.s,
    hosts: () => hosts,
    sshConfig: () => [],
    pane: (id) => panes.get(id),
    visiblePanes: () => [...panes.values()].filter((p) => p.visible && !p.pane.parked).map((p) => p.pane),
    live: (id) => live.get(id),
    restart: (id) => { r.restarts.push(id); live.set(id, { state: 'starting', startedAt: Date.now() }); },
    toast: (m) => r.toasts.push(m),
    tailText: async () => r.tail.text,
    ping: async (t, to) => { r.pings.push(t); r.timeouts.push(to); return r.pingImpl.fn(t); },
    pageVisible: () => r.clock.visible,
    now: () => Date.now(),
    gaveUpText: (name, n) => `gave up ${name} ${n}`,
  };
  r.conn = new SshConn(ctx, r.st);
  return r;
}

/** Simula la caída: el panel pasa a 'exited' y el almacén avisa. */
async function drop(r: Rig, id: string, code: number | undefined = 255) {
  r.live.set(id, { ...r.live.get(id)!, state: 'exited' });
  await r.conn.onExit(id, code);
}

// ---------- reconexión ----------

test('a dropped established session shows the bar, waits the first delay and restarts through the Restart path', async () => {
  const r = rig();
  await drop(r, 'a');
  const v = r.st.reconnecting.a;
  assert.deepEqual({ attempt: v.attempt, max: v.max, delaySec: v.delaySec }, { attempt: 1, max: 8, delaySec: 2 });
  assert.equal(v.at, Date.now() + 2000);
  mock.timers.tick(1999);
  assert.deepEqual(r.restarts, []);
  mock.timers.tick(1);
  assert.deepEqual(r.restarts, ['a']);
  assert.equal(r.st.reconnecting.a, undefined);
});

test('exit code 0 (the user typed exit) never reconnects', async () => {
  const r = rig();
  await drop(r, 'a', 0);
  assert.equal(r.st.reconnecting.a, undefined);
  mock.timers.tick(120_000);
  assert.deepEqual(r.restarts, []);
});

test('a session that never produced output (refused / unknown host / wrong password) does not loop', async () => {
  const r = rig();
  r.live.set('a', { state: 'running', startedAt: Date.now() - 30_000 }); // 30 s esperando, sin salida
  await drop(r, 'a');
  assert.equal(r.st.reconnecting.a, undefined);
  mock.timers.tick(120_000);
  assert.deepEqual(r.restarts, []);
  // y uno que dio salida pero hace menos de 10 s
  r.live.set('a', { state: 'running', startedAt: Date.now() - 12_000, firstOutputAt: Date.now() - 4_000 });
  await drop(r, 'a');
  assert.equal(r.st.reconnecting.a, undefined);
});

test('an authentication failure after a long wait at the prompt does not reconnect either', async () => {
  const r = rig();
  r.tail.text = 'deploy@10.0.0.5: Permission denied (publickey,password).';
  await drop(r, 'a');
  assert.equal(r.st.reconnecting.a, undefined);
  mock.timers.tick(120_000);
  assert.deepEqual(r.restarts, []);
});

test('setting off: no reconnect', async () => {
  const r = rig({ sshAutoReconnect: false });
  await drop(r, 'a');
  assert.equal(r.st.reconnecting.a, undefined);
  mock.timers.tick(120_000);
  assert.deepEqual(r.restarts, []);
});

test('a non-ssh pane is never reconnected', async () => {
  const r = rig();
  r.panes.get('a')!.pane = mkPane('a', { kind: 'shell' });
  await drop(r, 'a');
  assert.equal(r.st.reconnecting.a, undefined);
});

test('Cancel stops the attempts until the user restarts the pane; Restart clears the Cancel', async () => {
  const r = rig();
  await drop(r, 'a');
  r.conn.cancel('a');
  assert.equal(r.st.reconnecting.a, undefined);
  mock.timers.tick(60_000);
  assert.deepEqual(r.restarts, []);
  // otra caída del mismo panel (p. ej. el usuario lo relanzó por otra vía): sigue cancelado
  await drop(r, 'a');
  assert.equal(r.st.reconnecting.a, undefined);
  // el usuario pulsa Restart: vuelve a valer
  r.conn.userRestarted('a');
  r.live.set('a', { state: 'running', startedAt: Date.now() - 600_000, firstOutputAt: Date.now() - 590_000 });
  await drop(r, 'a');
  assert.ok(r.st.reconnecting.a);
});

test('closing the pane or pressing Restart while waiting cancels the pending timer', async () => {
  const r = rig();
  await drop(r, 'a');
  r.conn.closed('a');
  mock.timers.tick(60_000);
  assert.deepEqual(r.restarts, []);
  const r2 = rig();
  await drop(r2, 'a');
  r2.conn.userRestarted('a');
  mock.timers.tick(60_000);
  assert.deepEqual(r2.restarts, [], 'the user restart goes through the store, not through the timer');
});

test('Reconnect now skips the wait and restarts once', async () => {
  const r = rig();
  await drop(r, 'a');
  r.conn.reconnectNow('a');
  assert.deepEqual(r.restarts, ['a']);
  mock.timers.tick(60_000);
  assert.deepEqual(r.restarts, ['a'], 'the old timer does not fire a second restart');
});

test('parked, hidden (other workspace) and shutting-down panes are not reconnected', async () => {
  const r = rig();
  r.panes.get('a')!.visible = false;
  await drop(r, 'a');
  assert.equal(r.st.reconnecting.a, undefined);
  const r2 = rig();
  await drop(r2, 'a');
  r2.panes.get('a')!.visible = false; // lo aparcan durante la cuenta atrás
  mock.timers.tick(2000);
  assert.deepEqual(r2.restarts, []);
  const r3 = rig();
  r3.conn.shutdown();
  await drop(r3, 'a');
  assert.equal(r3.st.reconnecting.a, undefined);
  const r4 = rig();
  await drop(r4, 'a');
  r4.conn.shutdown();
  mock.timers.tick(60_000);
  assert.deepEqual(r4.restarts, []);
});

test('the 8 attempts follow the default backoff, then it gives up with a toast and the usual state', async () => {
  const r = rig();
  const waits: number[] = [];
  await drop(r, 'a');
  for (let i = 0; i < 8; i++) {
    const v = r.st.reconnecting.a;
    assert.ok(v, `attempt ${i + 1} announced`);
    assert.equal(v.attempt, i + 1);
    waits.push(v.delaySec);
    mock.timers.tick(v.delaySec * 1000);
    // el reintento falla enseguida (sin salida): la red sigue caída
    r.live.set('a', { state: 'exited', startedAt: Date.now() });
    await r.conn.onExit('a', 255);
  }
  assert.deepEqual(waits, [2, 4, 8, 16, 30, 30, 30, 30]);
  assert.equal(r.restarts.length, 8);
  assert.equal(r.st.reconnecting.a, undefined, 'no 9th attempt');
  assert.deepEqual(r.toasts, ['gave up srv-a 8']);
  mock.timers.tick(600_000);
  assert.equal(r.restarts.length, 8);
});

test('custom settings drive the loop: 3 attempts, fixed 5 s delay', async () => {
  const r = rig({ sshReconnectMaxAttempts: 3, sshReconnectFirstDelaySec: 5, sshReconnectFactor: 1 });
  await drop(r, 'a');
  for (let i = 0; i < 3; i++) {
    assert.equal(r.st.reconnecting.a.delaySec, 5);
    assert.equal(r.st.reconnecting.a.max, 3);
    mock.timers.tick(5000);
    r.live.set('a', { state: 'exited', startedAt: Date.now() });
    await r.conn.onExit('a', 255);
  }
  assert.equal(r.restarts.length, 3);
  assert.equal(r.st.reconnecting.a, undefined);
});

test('unlimited attempts (0) keep going far past 8', async () => {
  const r = rig({ sshReconnectMaxAttempts: 0, sshReconnectFirstDelaySec: 1, sshReconnectFactor: 1 });
  await drop(r, 'a');
  for (let i = 0; i < 25; i++) {
    assert.ok(r.st.reconnecting.a, `attempt ${i + 1}`);
    assert.equal(r.st.reconnecting.a.max, 0);
    mock.timers.tick(1000);
    r.live.set('a', { state: 'exited', startedAt: Date.now() });
    await r.conn.onExit('a', 255);
  }
  assert.equal(r.restarts.length, 25);
});

test("'only 255' ignores other non-zero codes", async () => {
  const r = rig({ sshReconnectCodes: '255' });
  await drop(r, 'a', 1);
  assert.equal(r.st.reconnecting.a, undefined);
  await drop(r, 'a', 255);
  assert.ok(r.st.reconnecting.a);
});

test('a reconnect that stays up resets the counter; the next drop starts again at attempt 1', async () => {
  const r = rig();
  await drop(r, 'a');
  mock.timers.tick(2000); // intento 1
  r.live.set('a', { state: 'exited', startedAt: Date.now() });
  await r.conn.onExit('a', 255); // falla: intento 2
  assert.equal(r.st.reconnecting.a.attempt, 2);
  mock.timers.tick(4000);
  // este sí conecta y dura 5 min
  r.live.set('a', { state: 'running', startedAt: Date.now(), firstOutputAt: Date.now() });
  mock.timers.tick(300_000);
  await drop(r, 'a');
  assert.equal(r.st.reconnecting.a.attempt, 1);
  assert.equal(r.st.reconnecting.a.delaySec, 2);
});

test('flash: only on the first output of an automatic retry, and only if the setting is on', async () => {
  const r = rig();
  r.conn.outputSeen('a');
  assert.equal(r.st.flash.a, undefined, 'a normal first connection does not flash');
  await drop(r, 'a');
  mock.timers.tick(2000);
  r.conn.outputSeen('a');
  assert.ok(r.st.flash.a);
  mock.timers.tick(2000);
  assert.equal(r.st.flash.a, undefined, 'goes away by itself');
  const off = rig({ sshReconnectFlash: false });
  await drop(off, 'a');
  mock.timers.tick(2000);
  off.conn.outputSeen('a');
  assert.equal(off.st.flash.a, undefined);
});

test('the user restarting while the decision is pending leaves nothing behind', async () => {
  const r = rig();
  r.live.set('a', { ...r.live.get('a')!, state: 'exited' });
  const p = r.conn.onExit('a', 255);
  r.conn.userRestarted('a'); // antes de que acabe el await
  r.live.set('a', { state: 'starting', startedAt: Date.now() });
  await p;
  assert.equal(r.st.reconnecting.a, undefined);
  mock.timers.tick(60_000);
  assert.deepEqual(r.restarts, []);
});

// ---------- latencia ----------

test('tick: ONE call for all measurable panes, same address once, ring of samples, level view', async () => {
  const r = rig({}, ['a', 'b']);
  // b apunta al mismo host que a
  r.panes.get('b')!.pane = mkPane('b', { ref: 'h-a' });
  await r.conn.tick();
  assert.equal(r.pings.length, 1);
  assert.deepEqual(r.pings[0].map((t) => t.id), ['a.example.com:22']);
  assert.deepEqual(r.timeouts, [2]);
  assert.deepEqual(r.st.latency.a, [25]);
  assert.deepEqual(r.st.latency.b, [25]);
  const v = r.conn.view(r.panes.get('a')!.pane);
  assert.equal(v.mode, 'live');
  if (v.mode === 'live') { assert.equal(v.level, 'ok'); assert.equal(v.stats.last, 25); }
});

test('tick keeps only the configured number of samples', async () => {
  const r = rig({ latencySamples: 5 });
  for (let i = 0; i < 12; i++) await r.conn.tick();
  assert.equal(r.st.latency.a.length, 5);
});

test('tick passes the configured timeout and failures are stored as null', async () => {
  const r = rig({ latencyTimeoutSec: 7 });
  r.pingImpl.fn = (t) => t.map((x) => ({ id: x.id, ms: null, error: 'timeout' }));
  await r.conn.tick();
  assert.deepEqual(r.timeouts, [7]);
  assert.deepEqual(r.st.latency.a, [null]);
  await r.conn.tick(); await r.conn.tick();
  const v = r.conn.view(r.panes.get('a')!.pane);
  assert.ok(v.mode === 'live' && v.level === 'bad' && v.stats.lossPct === 100);
});

test('tick measures nothing when: badge off, window hidden, pane not running, parked/hidden, jump host, not ssh', async () => {
  let r = rig({ latencyBadge: false });
  await r.conn.tick();
  assert.equal(r.pings.length, 0);
  r = rig(); r.clock.visible = false;
  await r.conn.tick();
  assert.equal(r.pings.length, 0);
  r = rig(); r.live.set('a', { state: 'starting' });
  await r.conn.tick();
  assert.equal(r.pings.length, 0, 'not running');
  r = rig(); r.live.set('a', { state: 'exited' });
  await r.conn.tick();
  assert.equal(r.pings.length, 0, 'exited / reconnecting');
  r = rig(); r.panes.get('a')!.visible = false;
  await r.conn.tick();
  assert.equal(r.pings.length, 0, 'hidden');
  r = rig(); r.panes.get('a')!.pane = mkPane('a', { parked: true });
  await r.conn.tick();
  assert.equal(r.pings.length, 0, 'parked');
  r = rig(); r.panes.get('a')!.pane = mkPane('a', { kind: 'shell', ref: undefined });
  await r.conn.tick();
  assert.equal(r.pings.length, 0, 'shell');
});

test('a host behind a jump is not measured and the badge says so', async () => {
  const r = rig();
  const hosts = (r.conn as unknown as { ctx: ConnCtx }).ctx.hosts();
  hosts[0].proxyJump = 'bastion';
  await r.conn.tick();
  assert.equal(r.pings.length, 0);
  assert.equal(r.conn.view(r.panes.get('a')!.pane).mode, 'jump');
});

test('view: none for non-ssh / badge off, idle when not running, ring cleared when the session ends', async () => {
  const r = rig();
  await r.conn.tick();
  assert.ok(r.st.latency.a);
  await drop(r, 'a', 0);
  assert.equal(r.st.latency.a, undefined, 'cleared on exit');
  assert.equal(r.conn.view(r.panes.get('a')!.pane).mode, 'idle');
  assert.equal(r.conn.view(mkPane('z', { kind: 'shell', ref: undefined })).mode, 'none');
  r.s.latencyBadge = false;
  assert.equal(r.conn.view(r.panes.get('a')!.pane).mode, 'none');
});

test('a sample that arrives after the session stopped running is discarded', async () => {
  const r = rig();
  r.pingImpl.fn = (t) => { r.live.set('a', { state: 'exited' }); return t.map((x) => ({ id: x.id, ms: 30, error: null })); };
  await r.conn.tick();
  assert.equal(r.st.latency.a, undefined);
});

test('arm: polls every latencyIntervalSec, once more immediately; off or disarmed = zero calls (count, not timing)', async () => {
  const r = rig({ latencyIntervalSec: 5 });
  r.conn.arm();
  await flush();
  assert.equal(r.pings.length, 1, 'immediate first measurement');
  for (let i = 0; i < 6; i++) { mock.timers.tick(5000); await flush(); }
  assert.equal(r.pings.length, 7);
  r.clock.visible = false;
  for (let i = 0; i < 6; i++) { mock.timers.tick(5000); await flush(); }
  assert.equal(r.pings.length, 7, 'hidden window: no calls');
  r.clock.visible = true;
  r.s.latencyBadge = false;
  r.conn.arm();
  for (let i = 0; i < 6; i++) { mock.timers.tick(5000); await flush(); }
  assert.equal(r.pings.length, 7, 'badge off: no calls');
  assert.deepEqual(r.st.latency, {});
  r.s.latencyBadge = true; r.s.latencyIntervalSec = 20;
  r.conn.arm(); await flush();
  const n = r.pings.length;
  mock.timers.tick(19_999); await flush();
  assert.equal(r.pings.length, n);
  mock.timers.tick(1); await flush();
  assert.equal(r.pings.length, n + 1);
  r.conn.disarm();
  mock.timers.tick(100_000); await flush();
  assert.equal(r.pings.length, n + 1);
});

test('overlapping ticks are skipped while one is in flight', async () => {
  const r = rig();
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  (r.conn as unknown as { ctx: ConnCtx }).ctx.ping = async (t) => { r.pings.push(t); await gate; return t.map((x) => ({ id: x.id, ms: 10, error: null })); };
  const p1 = r.conn.tick();
  await r.conn.tick();
  assert.equal(r.pings.length, 1);
  release();
  await p1;
  assert.equal(r.st.latency.a.length, 1);
});
