import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RmController, desiredMonitors, hostOfPane, rmKey, rmReq } from './remotemetrics.ts';
import type { RmReq, RmBackend } from './remotemetrics.ts';
import { normalizeHost } from './model.ts';
import type { Host } from './model.ts';
import { DEFAULT_RM_INTERVAL, RM_INTERVAL_LIMITS, REMOTE_CAPABLE, cleanRmInterval, metricSource } from './statusbar.ts';
import type { RemoteSnap, RemoteSample } from './statusbar.ts';
import { DEFAULTS, LIMITS, SECTION_KEYS, clampSettings } from './settings.ts';
import { buildBackup, parseBackup, serializeBackup } from './backup.ts';
import type { BackupState } from './backup.ts';

const host = (id: string, h: string, extra: Partial<Host> = {}): Host => ({ id, name: h, tags: [], host: h, authMethod: 'agent', agentAccess: 'none', remoteMetrics: true, ...extra });
const pane = (id: string, ref?: string, kind: 'ssh' | 'shell' = 'ssh') => ({ id, kind, ref });
const H1 = host('h1', 'a.example.com', { user: 'root', port: 2222 });
const H2 = host('h2', 'b.example.com');

// ---------- petición y claves ----------

test('rmReq: solo con remoteMetrics, y la clave coincide con la de Rust (user@host:puerto|salto)', () => {
  assert.equal(rmReq({ ...H1, remoteMetrics: undefined }, 3), null);
  assert.equal(rmReq({ ...H1, remoteMetrics: false }, 3), null);
  const r = rmReq(H1, 3)!;
  assert.equal(rmKey(r), 'root@a.example.com:2222|');
  assert.equal(rmKey(rmReq(host('x', 'c.example.com', { proxyJump: ' j@bastion ' }), 3)!), '@c.example.com:22|j@bastion');
});

test('rmReq: el secreto nunca viaja, solo el nombre de la entrada de la bóveda', () => {
  const h = host('h3', 'd.example.com', { authMethod: 'password', hasPassword: true });
  const r = rmReq(h, 4)!;
  assert.equal(r.secretKey, 'host:h3:password');
  assert.ok(!JSON.stringify(r).match(/hunter2/));
  assert.equal(rmReq(host('h4', 'e.example.com'), 4)!.secretKey, undefined);
  const k = rmReq(host('h5', 'f.example.com', { authMethod: 'key', identityFile: 'C:\\k\\id', hasPassphrase: true }), 4)!;
  assert.equal(k.identitiesOnly, true);
  assert.equal(k.identity, 'C:\\k\\id');
  assert.equal(k.secretKey, 'host:h5:passphrase');
});

test('hostOfPane: solo paneles SSH de un host guardado (no alias ni shells)', () => {
  assert.equal(hostOfPane(pane('p', 'h1'), [H1, H2]), H1);
  assert.equal(hostOfPane(pane('p', 'cfg:prod'), [H1]), undefined);
  assert.equal(hostOfPane(pane('p', 'h1', 'shell'), [H1]), undefined);
  assert.equal(hostOfPane(pane('p', undefined), [H1]), undefined);
});

// ---------- qué monitores deben existir ----------

test('varios paneles del mismo host (en pestañas distintas) = 1 monitor', () => {
  const ws = [{ panes: [pane('p1', 'h1'), pane('p2', 'h1'), pane('p3', 'h1')] }, { panes: [pane('p4', 'h1')] }];
  assert.equal(desiredMonitors(ws, [H1], {}, 3).size, 1);
});

test('otro host = otro monitor; shells y alias no cuentan', () => {
  const ws = [{ panes: [pane('p1', 'h1'), pane('p2', 'h2'), pane('p3', undefined, 'shell'), pane('p4', 'cfg:x')] }];
  assert.equal(desiredMonitors(ws, [H1, H2], {}, 3).size, 2);
});

test('el último panel que termina quita el monitor; con otro vivo se mantiene', () => {
  const ws = [{ panes: [pane('p1', 'h1'), pane('p2', 'h1')] }];
  assert.equal(desiredMonitors(ws, [H1], { p1: { state: 'exited' }, p2: { state: 'running' } }, 3).size, 1);
  assert.equal(desiredMonitors(ws, [H1], { p1: { state: 'exited' }, p2: { state: 'exited' } }, 3).size, 0);
  assert.equal(desiredMonitors([{ panes: [] }], [H1], {}, 3).size, 0, 'cerrados todos');
});

test('con las métricas apagadas en el host no hay monitor', () => {
  assert.equal(desiredMonitors([{ panes: [pane('p1', 'h1')] }], [{ ...H1, remoteMetrics: false }], {}, 3).size, 0);
});

test('el foco y la visibilidad no intervienen en qué monitores existen', () => {
  const ws = [{ panes: [pane('p1', 'h1')] }];
  const a = desiredMonitors(ws, [H1], { p1: { state: 'running' } }, 3);
  const b = desiredMonitors(ws, [H1], {}, 3);
  assert.deepEqual([...a.keys()], [...b.keys()]);
});

class Fake implements RmBackend {
  starts: RmReq[] = []; stops: string[] = [];
  async start(r: RmReq) { this.starts.push(r); return rmKey(r); }
  stop(k: string) { this.stops.push(k); }
}

test('RmController: un arranque por destino, para al desaparecer y no repite', () => {
  const be = new Fake();
  const c = new RmController(be);
  const ws = [{ panes: [pane('p1', 'h1'), pane('p2', 'h1'), pane('p3', 'h2')] }];
  const want = desiredMonitors(ws, [H1, H2], {}, 3);
  assert.equal(c.sync(want).started.length, 2);
  assert.equal(c.sync(want).started.length, 0, 'sincronizar de nuevo no reconecta');
  assert.equal(be.starts.length, 2, 'un solo arranque por host aunque haya 2 paneles');
  const r = c.sync(desiredMonitors([{ panes: [pane('p1', 'h1')] }], [H1, H2], {}, 3));
  assert.deepEqual(r.stopped, ['@b.example.com:22|']);
  assert.deepEqual(be.stops, ['@b.example.com:22|']);
  c.stopAll();
  assert.equal(be.stops.length, 2);
  assert.deepEqual(c.keys(), []);
});

test('RmController: cambiar el intervalo reenvía la petición y suelta la referencia sobrante', async () => {
  const be = new Fake();
  const c = new RmController(be);
  const ws = [{ panes: [pane('p1', 'h1')] }];
  c.sync(desiredMonitors(ws, [H1], {}, 3));
  c.sync(desiredMonitors(ws, [H1], {}, 6));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(be.starts.map((s) => s.interval), [3, 6]);
  assert.equal(be.stops.length, 1, 'el recuento de Rust vuelve a 1');
});

// ---------- ajustes y fuente de la barra ----------

const rs = (): RemoteSample => ({ ready: true, cpu: 12, ramUsed: 1, ramTotal: 2, swapUsed: 0, swapTotal: 0, diskRead: 0, diskWrite: 0, netIn: 0, netOut: 0, uptime: 5, hostname: 'srv', cores: 4, load: 0.5 });

test('cleanRmInterval: 2..10, por defecto 3, basura = por defecto', () => {
  assert.equal(DEFAULT_RM_INTERVAL, 3);
  assert.deepEqual([...RM_INTERVAL_LIMITS], [2, 10]);
  assert.equal(cleanRmInterval(0), 2);
  assert.equal(cleanRmInterval(1.4), 2);
  assert.equal(cleanRmInterval(99), 10);
  assert.equal(cleanRmInterval(5.4), 5);
  for (const v of ['3', null, undefined, NaN, Infinity, {}]) assert.equal(cleanRmInterval(v), 3);
});

test('clampSettings acota remoteMetricsInterval; la sección general lo restablece', () => {
  assert.equal(clampSettings({ remoteMetricsInterval: 500 }).remoteMetricsInterval, 10);
  assert.equal(clampSettings({ remoteMetricsInterval: -3 }).remoteMetricsInterval, 2);
  assert.equal(clampSettings({}).remoteMetricsInterval, 3);
  assert.equal(DEFAULTS.remoteMetricsInterval, 3);
  assert.ok((SECTION_KEYS.general as readonly string[]).includes('remoteMetricsInterval'));
  assert.equal(LIMITS.remoteMetricsInterval[0], 2);
});

test('metricSource: local si el host no tiene las métricas encendidas, aunque haya muestra', () => {
  assert.deepEqual(metricSource(false, { state: 'ok', sample: rs() }), { kind: 'local' });
  assert.deepEqual(metricSource(false, null), { kind: 'local' });
});

test('metricSource: remoto solo con estado ok y muestra', () => {
  const s = rs();
  const r = metricSource(true, { state: 'ok', sample: s });
  assert.equal(r.kind, 'remote');
  assert.equal(r.kind === 'remote' && r.sample, s);
});

test('metricSource: conectando, caído, desfasado o sin monitor NUNCA caen al equipo local ni dan ceros', () => {
  const cases: [RemoteSnap | null | undefined, string][] = [
    [null, 'none'], [undefined, 'none'], [{ state: 'none' }, 'none'], [{ state: 'connecting' }, 'connecting'],
    [{ state: 'stale', sample: rs() }, 'stale'], [{ state: 'unavailable', kind: 'hostkey', reason: 'x' }, 'unavailable'],
    [{ state: 'ok' }, 'connecting'],
  ];
  for (const [snap, state] of cases) {
    const r = metricSource(true, snap);
    assert.equal(r.kind, 'remote-pending', JSON.stringify(snap));
    assert.equal(r.kind === 'remote-pending' && r.state, state, JSON.stringify(snap));
  }
  const u = metricSource(true, { state: 'unavailable', kind: 'auth', reason: 'needs interactive login' });
  assert.deepEqual(u, { kind: 'remote-pending', state: 'unavailable', failKind: 'auth', reason: 'needs interactive login' });
});

test('metricSource no muta la entrada; los elementos de servidor son solo métricas', () => {
  const snap: RemoteSnap = { state: 'ok', sample: rs() };
  const before = JSON.stringify(snap);
  metricSource(true, snap);
  assert.equal(JSON.stringify(snap), before);
  assert.ok((REMOTE_CAPABLE as readonly string[]).includes('cpu') && !(REMOTE_CAPABLE as readonly string[]).includes('agents'));
});

// ---------- modelo y copia de seguridad ----------

test('normalizeHost: remoteMetrics solo se conserva como true', () => {
  const base = { id: 'h', name: 'n', tags: [], host: 'a.example.com', authMethod: 'agent' as const, agentAccess: 'none' as const };
  assert.equal(normalizeHost({ ...base, remoteMetrics: true }).remoteMetrics, true);
  for (const v of [false, 'true', 1, null, undefined]) assert.ok(!('remoteMetrics' in normalizeHost({ ...base, remoteMetrics: v as never })), String(v));
  assert.ok(!('remoteMetrics' in normalizeHost(base)));
});

function state(hosts: Host[]): BackupState {
  return { settings: { ...DEFAULTS }, hosts, accounts: [], customThemes: [], workspaces: [], activeId: undefined, ignoredDirs: [] } as unknown as BackupState;
}
const NOW = new Date('2026-11-06T12:00:00Z');

test('copia de seguridad: remoteMetrics hace el viaje de ida y vuelta; valores raros = apagado', () => {
  const txt = serializeBackup(buildBackup(state([host('h-1', 'srv1.example.com'), host('h-2', 'srv2.example.com', { remoteMetrics: undefined })]), { appVersion: '0.1.0', now: NOW }));
  assert.ok(txt.includes('"remoteMetrics": true'), 'viaja en el archivo');
  const r = parseBackup(txt);
  assert.ok(r.ok);
  assert.equal(r.sections.hosts.find((h) => h.id === 'h-1')?.remoteMetrics, true);
  assert.ok(!('remoteMetrics' in r.sections.hosts.find((h) => h.id === 'h-2')!));
  const f = JSON.parse(txt);
  f.hosts = [{ ...f.hosts[0], id: 'a', remoteMetrics: 'yes' }, { ...f.hosts[0], id: 'b', remoteMetrics: 1 }, { ...f.hosts[0], id: 'c', remoteMetrics: false }];
  const w = parseBackup(JSON.stringify(f));
  assert.ok(w.ok);
  assert.equal(w.sections.hosts.length, 3);
  for (const h of w.sections.hosts) assert.ok(!('remoteMetrics' in h), h.id);
});
