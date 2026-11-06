import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LATENCY, clampLatencyInterval, dedupeTargets, fmtMs, latencyOptsOf, latencyTarget, levelOf, pushSample, statsOf, validHost,
} from './latency.ts';
import { DEFAULTS } from './settings.ts';

const WINDOW = DEFAULT_LATENCY.samples;
import type { CfgEntry, Sample } from './latency.ts';
import { emptyHost, sshAliasArgs, sshArgs } from './model.ts';
import type { Host, Pane } from './model.ts';

const pane = (p: Partial<Pane>): Pane => ({
  id: 't1', col: 0, row: 0, colSpan: 1, rowSpan: 1, parked: false, kind: 'ssh', icon: 'server', title: 'x', spec: { program: 'ssh', args: [] }, ...p,
});
const host = (o: Partial<Host>): Host => ({ ...emptyHost(), id: 'h1', name: 'web', host: 'web.example.com', ...o });

test('pushSample keeps the last 30 and does not mutate the old ring', () => {
  let ring: Sample[] = [];
  const first = ring;
  for (let i = 1; i <= 45; i++) ring = pushSample(ring, i);
  assert.equal(ring.length, WINDOW);
  assert.equal(ring[0], 16);
  assert.equal(ring[WINDOW - 1], 45);
  assert.equal(first.length, 0);
  const a: Sample[] = [1, 2];
  const b = pushSample(a, 3);
  assert.deepEqual(a, [1, 2]);
  assert.deepEqual(b, [1, 2, 3]);
});

test('pushSample turns junk and failures into null', () => {
  for (const bad of [null, undefined, NaN, Infinity, -1, '12', {}]) assert.deepEqual(pushSample([], bad), [null], String(bad));
  assert.deepEqual(pushSample([], 0), [0]);
});

test('statsOf: last/min/avg/max/loss/consecFail', () => {
  const st = statsOf([10, 20, null, 30, null, null]);
  assert.equal(st.n, 6);
  assert.equal(st.last, null);
  assert.equal(st.min, 10);
  assert.equal(st.max, 30);
  assert.equal(st.avg, 20);
  assert.equal(st.lossPct, 50);
  assert.equal(st.consecFail, 2);
  const e = statsOf([]);
  assert.deepEqual(e, { n: 0, last: null, min: null, avg: null, max: null, lossPct: 0, consecFail: 0 });
  const allBad = statsOf([null, null, null, null]);
  assert.equal(allBad.min, null);
  assert.equal(allBad.lossPct, 100);
  assert.equal(allBad.consecFail, 4);
  assert.equal(statsOf([42]).last, 42);
});

test('levelOf: ok < 80, warn 80..200, bad > 200 or 3 consecutive failures', () => {
  const lv = (buf: Sample[]) => levelOf(statsOf(buf));
  assert.equal(lv([]), 'none');
  assert.equal(lv([0.4]), 'ok');
  assert.equal(lv([79.9]), 'ok');
  assert.equal(lv([80]), 'warn');
  assert.equal(lv([200]), 'warn');
  assert.equal(lv([200.1]), 'bad');
  assert.equal(lv([900]), 'bad');
  assert.equal(lv([10, null]), 'warn', 'one failure is only a warning');
  assert.equal(lv([10, null, null]), 'warn');
  assert.equal(lv([10, null, null, null]), 'bad');
  assert.equal(lv([null, null, null, 15]), 'ok', 'a good sample ends the failure streak');
});

test('fmtMs', () => {
  assert.equal(fmtMs(42), '42 ms');
  assert.equal(fmtMs(41.6), '42 ms');
  assert.equal(fmtMs(0.3), '<1 ms');
  assert.equal(fmtMs(999.4), '999 ms');
  assert.equal(fmtMs(1500), '1.5 s');
  for (const x of [null, undefined, NaN, -3, Infinity]) assert.equal(fmtMs(x), '—', String(x));
});

test('clampLatencyInterval: 2..60, junk -> 5', () => {
  assert.equal(clampLatencyInterval(5), 5);
  assert.equal(clampLatencyInterval(0), 2);
  assert.equal(clampLatencyInterval(1), 2);
  assert.equal(clampLatencyInterval(61), 60);
  assert.equal(clampLatencyInterval(1e9), 60);
  assert.equal(clampLatencyInterval(7.6), 8);
  for (const bad of [NaN, Infinity, '5', null, undefined, {}]) assert.equal(clampLatencyInterval(bad), 5, String(bad));
});

test('validHost mirrors the Rust rules', () => {
  for (const ok of ['example.com', '10.0.0.5', '::1', 'a'.repeat(255)]) assert.ok(validHost(ok), ok);
  for (const bad of ['', 'a b', 'a\tb', 'a/b', 'u@h', 'a\u0007b', 'a'.repeat(256)]) assert.ok(!validHost(bad), JSON.stringify(bad));
});

test('latencyTarget: a stored host, with its own port or 22', () => {
  const h = host({ port: 2222 });
  assert.deepEqual(latencyTarget(pane({ ref: h.id }), [h], []), { kind: 'measure', host: 'web.example.com', port: 2222 });
  const h2 = host({});
  assert.deepEqual(latencyTarget(pane({ ref: h2.id }), [h2], []), { kind: 'measure', host: 'web.example.com', port: 22 });
});

test('latencyTarget: ProxyJump on the host -> jump, no measurement', () => {
  const h = host({ proxyJump: 'bastion' });
  assert.deepEqual(latencyTarget(pane({ ref: h.id }), [h], []), { kind: 'jump' });
  assert.deepEqual(latencyTarget(pane({ ref: h.id }), [host({ proxyJump: '   ' })], []), { kind: 'measure', host: 'web.example.com', port: 22 });
});

test('latencyTarget: ssh-config alias (cfg:), HostName, Port, ProxyJump and ProxyCommand', () => {
  const cfg: CfgEntry[] = [
    { alias: 'prod', hostname: '10.0.0.5', port: 2200 },
    { alias: 'inner', hostname: '10.9.9.9', proxyJump: 'bastion' },
    { alias: 'tun', hostname: '10.8.8.8', proxyCommand: 'nc -X 5 %h %p' },
    { alias: 'bare' },
  ];
  assert.deepEqual(latencyTarget(pane({ ref: 'cfg:prod' }), [], cfg), { kind: 'measure', host: '10.0.0.5', port: 2200 });
  assert.deepEqual(latencyTarget(pane({ ref: 'cfg:inner' }), [], cfg), { kind: 'jump' });
  assert.deepEqual(latencyTarget(pane({ ref: 'cfg:tun' }), [], cfg), { kind: 'jump' });
  assert.deepEqual(latencyTarget(pane({ ref: 'cfg:bare' }), [], cfg), { kind: 'measure', host: 'bare', port: 22 });
  assert.deepEqual(latencyTarget(pane({ ref: 'cfg:PROD' }), [], cfg), { kind: 'measure', host: '10.0.0.5', port: 2200 }, 'alias lookup ignores case');
});

test('latencyTarget: a stored host whose name is an ssh-config alias follows the config (HostName / Port / Proxy)', () => {
  const cfg: CfgEntry[] = [{ alias: 'prod', hostname: '10.0.0.5', port: 2200 }, { alias: 'inner', proxyJump: 'b' }];
  assert.deepEqual(latencyTarget(pane({ ref: 'h1' }), [host({ host: 'prod' })], cfg), { kind: 'measure', host: '10.0.0.5', port: 2200 });
  assert.deepEqual(latencyTarget(pane({ ref: 'h1' }), [host({ host: 'prod', port: 22 })], cfg), { kind: 'measure', host: '10.0.0.5', port: 22 }, 'explicit port wins');
  assert.deepEqual(latencyTarget(pane({ ref: 'h1' }), [host({ host: 'inner' })], cfg), { kind: 'jump' });
});

test('latencyTarget: quick connect is parsed from the real ssh args (user@host, -p, -J)', () => {
  const q = (h: Partial<Host>) => pane({ spec: { program: 'ssh', args: sshArgs({ ...host({}), ...h }) } });
  assert.deepEqual(latencyTarget(q({ host: 'quick.example.com', user: 'me', port: 2022 }), [], []), { kind: 'measure', host: 'quick.example.com', port: 2022 });
  assert.deepEqual(latencyTarget(q({ host: '10.1.1.1' }), [], []), { kind: 'measure', host: '10.1.1.1', port: 22 });
  assert.deepEqual(latencyTarget(q({ host: 'x.example.com', proxyJump: 'j' }), [], []), { kind: 'jump' });
  assert.deepEqual(latencyTarget(pane({ spec: { program: 'ssh', args: sshAliasArgs('prod') } }), [], [{ alias: 'prod', hostname: '10.0.0.5' }]), { kind: 'measure', host: '10.0.0.5', port: 22 });
});

test('latencyTarget: nothing to measure for non-ssh, unknown host ids, install-key panes and bad addresses', () => {
  const none = { kind: 'none' };
  assert.deepEqual(latencyTarget(pane({ kind: 'shell' }), [], []), none);
  assert.deepEqual(latencyTarget(pane({ kind: 'agent', ref: 'acc' }), [], []), none);
  assert.deepEqual(latencyTarget(pane({ ref: 'missing' }), [host({})], []), none);
  assert.deepEqual(latencyTarget(pane({ spec: { program: 'powershell.exe', args: ['-Command', 'x'] } }), [], []), none);
  assert.deepEqual(latencyTarget(pane({ ref: 'h1' }), [host({ host: 'bad host' })], []), none);
  assert.deepEqual(latencyTarget(pane({ ref: 'h1' }), [host({ port: 70000 })], []), none);
  assert.deepEqual(latencyTarget(pane({ spec: { program: 'ssh', args: [] } }), [], []), none);
});

test('dedupeTargets: one entry per host:port, case-insensitive, capped at 32', () => {
  const l = dedupeTargets([{ host: 'A.com', port: 22 }, { host: 'a.com', port: 22 }, { host: 'a.com', port: 23 }]);
  assert.deepEqual(l.map((x) => x.id), ['a.com:22', 'a.com:23']);
  const many = dedupeTargets(Array.from({ length: 50 }, (_, i) => ({ host: `h${i}.example.com`, port: 22 })));
  assert.equal(many.length, 32);
});

test('the built-in defaults are exactly the settings defaults (no drift between latency.ts and settings.ts)', () => {
  assert.deepEqual(latencyOptsOf(DEFAULTS), DEFAULT_LATENCY);
  assert.equal(DEFAULTS.latencyBadge, true);
});

test('custom window: pushSample cap and statsOf window', () => {
  let ring: Sample[] = [];
  for (let i = 1; i <= 20; i++) ring = pushSample(ring, i, 5);
  assert.deepEqual(ring, [16, 17, 18, 19, 20]);
  const big: Sample[] = Array.from({ length: 50 }, (_, i) => i + 1);
  const st = statsOf(big, 10);
  assert.equal(st.n, 10);
  assert.equal(st.min, 41);
  assert.equal(st.max, 50);
  assert.equal(statsOf(big).n, 50);
  assert.equal(statsOf([1, 2, 3], 0).n, 1, 'a window of 0 still keeps one sample');
});

test('custom thresholds: warn 20 / bad 50, and bad <= warn is corrected to warn + 1', () => {
  const o = { ...DEFAULT_LATENCY, warnMs: 20, badMs: 50 };
  const lv = (buf: Sample[], x = o) => levelOf(statsOf(buf), x);
  assert.equal(lv([19.9]), 'ok');
  assert.equal(lv([20]), 'warn');
  assert.equal(lv([50]), 'warn');
  assert.equal(lv([50.1]), 'bad');
  const inverted = { ...DEFAULT_LATENCY, warnMs: 100, badMs: 100 };
  assert.equal(lv([99], inverted), 'ok');
  assert.equal(lv([100], inverted), 'warn');
  assert.equal(lv([101], inverted), 'warn');
  assert.equal(lv([101.5], inverted), 'bad', 'bad <= warn behaves as bad = warn + 1');
  assert.equal(lv([100], { ...DEFAULT_LATENCY, warnMs: 100, badMs: 10 }), 'warn');
});

test('custom failure streak: 1 turns red at once, 5 needs five', () => {
  const lv = (buf: Sample[], failsBad: number) => levelOf(statsOf(buf), { ...DEFAULT_LATENCY, failsBad });
  assert.equal(lv([10, null], 1), 'bad');
  assert.equal(lv([10, null], 2), 'warn');
  assert.equal(lv([10, null, null], 2), 'bad');
  assert.equal(lv([null, null, null, null], 5), 'warn');
  assert.equal(lv([null, null, null, null, null], 5), 'bad');
});

test('number only (no unit) formatting', () => {
  assert.equal(fmtMs(42, false), '42');
  assert.equal(fmtMs(41.6, false), '42');
  assert.equal(fmtMs(0.2, false), '<1');
  assert.equal(fmtMs(1500, false), '1500');
  assert.equal(fmtMs(null, false), '—');
  assert.equal(fmtMs(42, true), '42 ms');
});
