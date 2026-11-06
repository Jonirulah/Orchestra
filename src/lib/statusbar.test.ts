import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPT_REPO, ADAPT_SSH, BAD_AT, CONTEXT_IDS, DEFAULT_ITEMS, ITEM_IDS, LOCAL_METRIC_IDS, SEP_PX, SLOT_PX, WARN_AT, adaptedItems, cleanInterval,
  cleanItems, cleanOverride, countAgents, customizeList, fitItems, fmtBytes, fmtPct, fmtRate, fmtUptime, isContextItem, isItemId, itemsFor,
  levelFor, moveFor, moveItem, pctOf, sshTarget, toggleFor, toggleItem, topUsage,
} from './statusbar.ts';
import type { ItemId } from './statusbar.ts';
import { DEFAULTS, LIMITS, SECTION_KEYS, clampSettings, resetSection } from './settings.ts';

test('cleanItems drops unknown ids and duplicates, keeps order', () => {
  assert.deepEqual(cleanItems(['cpu', 'bogus', 'ram', 'cpu', 7, null, 'ram', 'net']), ['cpu', 'ram', 'net']);
});

test('cleanItems: non-array falls back to defaults, empty list stays empty', () => {
  assert.deepEqual(cleanItems(undefined), [...DEFAULT_ITEMS]);
  assert.deepEqual(cleanItems('cpu'), [...DEFAULT_ITEMS]);
  assert.deepEqual(cleanItems([]), []);
  assert.deepEqual(cleanItems(['nope']), []);
});

test('cleanItems returns a fresh array (never the shared default)', () => {
  const a = cleanItems(undefined);
  a.push('disk');
  assert.deepEqual(cleanItems(undefined), [...DEFAULT_ITEMS]);
});

test('cleanInterval clamps to 1..10 and rounds; junk gives the default', () => {
  assert.equal(cleanInterval(0), 1);
  assert.equal(cleanInterval(99), 10);
  assert.equal(cleanInterval(2.6), 3);
  assert.equal(cleanInterval('3'), 2);
  assert.equal(cleanInterval(NaN), 2);
  assert.equal(cleanInterval(Infinity), 2);
});

test('moveItem swaps neighbours and ignores the ends', () => {
  const l = ['cpu', 'ram', 'net'] as const;
  assert.deepEqual(moveItem(l, 'ram', -1), ['ram', 'cpu', 'net']);
  assert.deepEqual(moveItem(l, 'ram', 1), ['cpu', 'net', 'ram']);
  assert.deepEqual(moveItem(l, 'cpu', -1), ['cpu', 'ram', 'net']);
  assert.deepEqual(moveItem(l, 'net', 1), ['cpu', 'ram', 'net']);
  assert.deepEqual(moveItem(l, 'disk', 1), ['cpu', 'ram', 'net']);
});

test('toggleItem adds at the end once and removes', () => {
  assert.deepEqual(toggleItem(['cpu'], 'ram', true), ['cpu', 'ram']);
  assert.deepEqual(toggleItem(['cpu', 'ram'], 'ram', true), ['cpu', 'ram']);
  assert.deepEqual(toggleItem(['cpu', 'ram'], 'cpu', false), ['ram']);
  assert.deepEqual(toggleItem(['cpu'], 'net', false), ['cpu']);
});

test('fmtBytes / fmtRate: fixed, compact precision', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1023), '1023 B');
  assert.equal(fmtBytes(1024), '1.0 KB');
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtBytes(150 * 1024), '150 KB');
  assert.equal(fmtBytes(22.7 * 1024 ** 3), '22.7 GB');
  assert.equal(fmtBytes(-5), '0 B');
  assert.equal(fmtBytes(NaN), '0 B');
  assert.equal(fmtRate(0), '0 B/s');
  assert.equal(fmtRate(3.4 * 1024 * 1024), '3.4 MB/s');
  assert.equal(fmtRate(Infinity), '0 B/s');
});

test('fmtUptime', () => {
  assert.equal(fmtUptime(0), '0m');
  assert.equal(fmtUptime(59), '0m');
  assert.equal(fmtUptime(12 * 60), '12m');
  assert.equal(fmtUptime(3 * 3600 + 5 * 60), '3h 05m');
  assert.equal(fmtUptime(2 * 86400 + 5 * 3600 + 59 * 60), '2d 5h');
  assert.equal(fmtUptime(-3), '0m');
});

test('fmtPct / pctOf', () => {
  assert.equal(fmtPct(7.4), '7%');
  assert.equal(fmtPct(150), '100%');
  assert.equal(fmtPct(-1), '0%');
  assert.equal(pctOf(50, 200), 25);
  assert.equal(pctOf(5, 0), 0);
  assert.equal(pctOf(300, 100), 100);
});

test('levelFor: strictly above 85 warns, strictly above 95 is bad', () => {
  assert.equal(WARN_AT, 85);
  assert.equal(BAD_AT, 95);
  assert.equal(levelFor(0), 'ok');
  assert.equal(levelFor(85), 'ok');
  assert.equal(levelFor(85.1), 'warn');
  assert.equal(levelFor(95), 'warn');
  assert.equal(levelFor(95.1), 'bad');
  assert.equal(levelFor(100), 'bad');
  assert.equal(levelFor(NaN), 'ok');
});

test('fitItems drops from the right when narrow', () => {
  const all = [...DEFAULT_ITEMS];
  const full = all.reduce((n, id, i) => n + SLOT_PX[id] + (i ? SEP_PX : 0), 0);
  assert.deepEqual(fitItems(all, full), all);
  assert.deepEqual(fitItems(all, full - 1), all.slice(0, -1));
  assert.deepEqual(fitItems(all, SLOT_PX[all[0]]), [all[0]]);
  assert.deepEqual(fitItems(all, SLOT_PX[all[0]] - 1), []);
  assert.deepEqual(fitItems(all, 0), []);
  assert.deepEqual(fitItems([], 1000), []);
});

test('topUsage picks the larger window', () => {
  assert.deepEqual(topUsage(30, 60), { pct: 60, window: '7d' });
  assert.deepEqual(topUsage(80, 60), { pct: 80, window: '5h' });
  assert.deepEqual(topUsage(50, 50), { pct: 50, window: '5h' });
  assert.deepEqual(topUsage(null, 12), { pct: 12, window: '7d' });
  assert.deepEqual(topUsage(12, undefined), { pct: 12, window: '5h' });
  assert.equal(topUsage(null, null), null);
});

test('countAgents', () => {
  assert.deepEqual(countAgents([{ status: 'busy' }, { status: 'busy' }, { status: 'waiting' }, { status: 'idle' }, { status: 'shell' }]), { working: 2, waiting: 1 });
  assert.deepEqual(countAgents([]), { working: 0, waiting: 0 });
});

// ---- integración con los ajustes ----

test('settings: defaults for the status bar are valid and survive clamping', () => {
  assert.equal(DEFAULTS.statusBar, true);
  assert.deepEqual(DEFAULTS.statusBarItems, ['hostname', 'cpu', 'ram', 'net', 'uptime']);
  assert.equal(DEFAULTS.statusBarInterval, 2);
  assert.deepEqual(clampSettings(DEFAULTS), DEFAULTS);
});

test('settings: clampSettings validates the status bar keys', () => {
  const s = clampSettings({ statusBar: 'yes', statusBarItems: ['cpu', 'cpu', 'zzz', 'net'], statusBarInterval: 99 });
  assert.equal(s.statusBar, true); // no booleano -> por defecto
  assert.deepEqual(s.statusBarItems, ['cpu', 'net']);
  assert.equal(s.statusBarInterval, LIMITS.statusBarInterval[1]);
  assert.equal(clampSettings({ statusBar: false }).statusBar, false);
  assert.deepEqual(clampSettings({ statusBarItems: [] }).statusBarItems, []);
  assert.equal(clampSettings({ statusBarInterval: 0 }).statusBarInterval, 1);
});

test('settings: statusbar keys reset with the general section', () => {
  const cur = { ...DEFAULTS, statusBar: false, statusBarItems: ['uptime' as const], statusBarInterval: 7 };
  const r = resetSection(cur, 'general');
  assert.equal(r.statusBar, true);
  assert.deepEqual(r.statusBarItems, [...DEFAULT_ITEMS]);
  assert.equal(r.statusBarInterval, 2);
  for (const k of ['statusBar', 'statusBarItems', 'statusBarInterval']) assert.ok((SECTION_KEYS.general as readonly string[]).includes(k));
});

test('item ids are unique and every id has a slot width', () => {
  assert.equal(new Set(ITEM_IDS).size, ITEM_IDS.length);
  for (const id of ITEM_IDS) assert.ok(SLOT_PX[id] > 0);
});

// ---------- por pestaña ----------

const G = ['cpu', 'ram'] as const;
const frozen = <T extends object>(o: T): T => { Object.freeze(o); for (const v of Object.values(o)) if (v && typeof v === 'object') Object.freeze(v); return o; };

test('itemsFor: tab without override follows the global list; copy, never the same array', () => {
  const g = [...G];
  const out = itemsFor({}, { statusBarItems: g }, null);
  assert.deepEqual(out, ['cpu', 'ram']);
  assert.notEqual(out, g);
  assert.deepEqual(itemsFor(undefined, { statusBarItems: g }), ['cpu', 'ram']);
});

test('itemsFor: override applies only to its own tab (no leak to others)', () => {
  const a = { statusBarItems: ['uptime', 'branch'] as ItemId[] };
  const b = {};
  const s = { statusBarItems: [...G] };
  assert.deepEqual(itemsFor(a, s, null), ['uptime', 'branch']);
  assert.deepEqual(itemsFor(b, s, null), ['cpu', 'ram']);
});

test('itemsFor: an empty override is valid (all items off for this tab)', () => {
  assert.deepEqual(itemsFor({ statusBarItems: [] }, { statusBarItems: [...G] }), []);
});

test('cleanOverride: unknown ids and duplicates dropped, absent stays absent', () => {
  assert.deepEqual(cleanOverride(['cpu', 'bogus', 'cpu', 'target', 5]), ['cpu', 'target']);
  assert.equal(cleanOverride(undefined), undefined);
  assert.equal(cleanOverride('cpu'), undefined);
  assert.equal(cleanOverride(null), undefined);
  assert.deepEqual(cleanOverride([]), []);
  assert.deepEqual(itemsFor({ statusBarItems: ['nope', 'ram'] }, { statusBarItems: [...G] }), ['ram']);
});

test('new context ids are valid items with a slot width and are not local metrics', () => {
  for (const id of CONTEXT_IDS) { assert.ok(isItemId(id)); assert.ok(isContextItem(id)); assert.ok(SLOT_PX[id] > 0); assert.ok(!(LOCAL_METRIC_IDS as readonly string[]).includes(id)); }
  assert.ok(!isContextItem('cpu'));
  assert.deepEqual([...DEFAULT_ITEMS].filter((i) => isContextItem(i)), []);
});

test('toggleFor / moveFor: edit the override when there is one, else the global list; never both', () => {
  const g = frozen([...G]);
  const own = frozen({ statusBarItems: ['cpu'] });
  assert.deepEqual(toggleFor(own, g, 'branch', true), { scope: 'tab', list: ['cpu', 'branch'] });
  assert.deepEqual(toggleFor({}, g, 'branch', true), { scope: 'global', list: ['cpu', 'ram', 'branch'] });
  assert.deepEqual(toggleFor(own, g, 'cpu', false), { scope: 'tab', list: [] });
  assert.deepEqual(moveFor(frozen({ statusBarItems: ['cpu', 'ram'] }), ['net'], 'ram', -1), { scope: 'tab', list: ['ram', 'cpu'] });
  assert.deepEqual(moveFor(null, g, 'ram', -1), { scope: 'global', list: ['ram', 'cpu'] });
  assert.deepEqual(own.statusBarItems, ['cpu']);
});

test('customizeList copies the list that was on screen', () => {
  const shown: ItemId[] = ['cpu', 'target'];
  const c = customizeList(shown);
  assert.deepEqual(c, shown);
  assert.notEqual(c, shown);
});

test('adapt: SSH focused pane gets target, latency, cpu, ram, net', () => {
  const s = { statusBarItems: [...G], statusBarAdapt: true };
  assert.deepEqual(itemsFor({}, s, { kind: 'ssh' }), ['target', 'latency', 'cpu', 'ram', 'net']);
  assert.deepEqual(itemsFor({}, s, { kind: 'ssh', repo: true }), ['target', 'latency', 'cpu', 'ram', 'net']);
});

test('adapt: local pane in a repo gets branch, cpu, ram, net, uptime; without repo the global list', () => {
  const s = { statusBarItems: [...G], statusBarAdapt: true };
  assert.deepEqual(itemsFor({}, s, { kind: 'shell', repo: true }), ['branch', 'cpu', 'ram', 'net', 'uptime']);
  assert.deepEqual(itemsFor({}, s, { kind: 'agent', repo: true }), ['branch', 'cpu', 'ram', 'net', 'uptime']);
  assert.deepEqual(itemsFor({}, s, { kind: 'shell', repo: false }), ['cpu', 'ram']);
  assert.deepEqual(itemsFor({}, s, null), ['cpu', 'ram']);
});

test('adapt: off (default) changes nothing; an override beats adapt', () => {
  assert.deepEqual(itemsFor({}, { statusBarItems: [...G], statusBarAdapt: false }, { kind: 'ssh' }), ['cpu', 'ram']);
  assert.deepEqual(itemsFor({}, { statusBarItems: [...G] }, { kind: 'ssh' }), ['cpu', 'ram']);
  assert.deepEqual(itemsFor({ statusBarItems: ['uptime'] }, { statusBarItems: [...G], statusBarAdapt: true }, { kind: 'ssh' }), ['uptime']);
  assert.equal(DEFAULTS.statusBarAdapt, false);
  assert.equal(clampSettings({ statusBarAdapt: 'yes' }).statusBarAdapt, false);
  assert.equal(clampSettings({ statusBarAdapt: true }).statusBarAdapt, true);
});

test('itemsFor / adaptedItems mutate nothing (frozen inputs) and return fresh arrays', () => {
  const s = frozen({ statusBarItems: [...G], statusBarAdapt: true });
  const w = frozen({ statusBarItems: ['cpu', 'bogus'] });
  itemsFor(w, s, { kind: 'ssh' });
  itemsFor({}, s, { kind: 'ssh' });
  assert.deepEqual(w.statusBarItems, ['cpu', 'bogus']);
  assert.notEqual(adaptedItems({ kind: 'ssh' }), adaptedItems({ kind: 'ssh' }));
  assert.deepEqual(ADAPT_SSH, ['target', 'latency', 'cpu', 'ram', 'net']);
  assert.deepEqual(ADAPT_REPO, ['branch', 'cpu', 'ram', 'net', 'uptime']);
});

test('sshTarget: saved host, ssh config alias, quick connect; null for local panes', () => {
  const hosts = [{ id: 'h1', host: 'srv.example.com', user: 'root', port: 2222 }, { id: 'h2', host: 'b.example.com' }];
  const cfg = [{ alias: 'box', hostname: '10.0.0.5', port: 2200 }, { alias: 'plain' }];
  const p = (o: Record<string, unknown>) => ({ kind: 'ssh', spec: { program: 'ssh', args: [] as string[] }, ...o });
  assert.equal(sshTarget(p({ ref: 'h1' }), hosts, cfg), 'root@srv.example.com:2222');
  assert.equal(sshTarget(p({ ref: 'h2' }), hosts, cfg), 'b.example.com:22');
  assert.equal(sshTarget(p({ ref: 'gone' }), hosts, cfg), null);
  assert.equal(sshTarget(p({ ref: 'cfg:box' }), hosts, cfg), '10.0.0.5:2200');
  assert.equal(sshTarget(p({ ref: 'cfg:plain' }), hosts, cfg), 'plain:22');
  assert.equal(sshTarget(p({ spec: { program: 'ssh', args: ['-p', '2201', 'me@x.org'] } }), hosts, cfg), 'me@x.org:2201');
  assert.equal(sshTarget(p({ spec: { program: 'ssh', args: ['-o', 'X=1', '-v'] } }), hosts, cfg), null);
  assert.equal(sshTarget({ kind: 'shell', spec: { program: 'pwsh', args: [] } }, hosts, cfg), null);
});
