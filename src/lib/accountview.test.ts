import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNTS_FILTERS, ACCOUNTS_SORTS, buildAccountView, effectiveFilter, matchesText, providerCounts, sortAccounts,
} from './accountview.ts';
import type { AccountsFilter, AccountsSort, Section, ViewCtx, ViewOpts } from './accountview.ts';
import { accountsViewMenu } from './ctxitems.ts';
import { DEFAULTS, SECTION_KEYS, clampSettings, parseImport, resetSection } from './settings.ts';
import type { Account, Provider } from './model.ts';
import type { Quota } from './policy.ts';
import { t } from './i18n.ts';

const NOW = 1_000_000;
const mk = (id: string, name: string, provider: Provider): Account => ({ id, name, dir: `C:/${id}`, isDefault: false, color: '#fff', provider });
const quota = (used: number, resetsIn: number): Quota => ({ fiveHour: { used, resetsAt: NOW + resetsIn }, sevenDay: { used: 5, resetsAt: NOW + 5 * 86400 } });

// Orden guardado deliberadamente desordenado: mezcla proveedores.
const ZED = mk('c1', 'Zed', 'claude');
const ALPHA = mk('c2', 'alpha', 'claude');
const MID = mk('c3', 'Mid', 'claude'); // sin datos de cuota
const WORK = mk('x1', 'Work', 'codex');
const ABC = mk('x2', 'Abc', 'codex');
const SIDE = mk('o1', 'Side', 'opencode');
const ALL = [ZED, WORK, ALPHA, SIDE, MID, ABC];

const Q: Record<string, Quota> = { c1: quota(70, 3600), c2: quota(20, 7200) };
const ctx = (over: Partial<ViewCtx> = {}): ViewCtx => ({ quota: Q, now: NOW, hasDefaultCodex: false, ...over });
const opts = (over: Partial<ViewOpts> = {}): ViewOpts => ({ filter: 'all', sort: 'manual', group: true, ...over });
const ids = (s: Section) => s.accounts.map((a) => a.id);
const flat = (secs: Section[]) => secs.flatMap(ids);

// ---------- filtro por proveedor ----------

test('filter: each provider shows only its accounts and only its own special rows', () => {
  const claude = buildAccountView(ALL, opts({ filter: 'claude' }), ctx());
  assert.equal(claude.length, 1);
  assert.deepEqual(ids(claude[0]), ['c1', 'c2', 'c3']);
  assert.deepEqual(claude[0].specialRows, ['auto']);

  const codex = buildAccountView(ALL, opts({ filter: 'codex' }), ctx());
  assert.equal(codex.length, 1);
  assert.deepEqual(ids(codex[0]), ['x1', 'x2']);
  assert.deepEqual(codex[0].specialRows, ['codex']);

  const oc = buildAccountView(ALL, opts({ filter: 'opencode' }), ctx());
  assert.equal(oc.length, 1);
  assert.deepEqual(ids(oc[0]), ['o1']);
  assert.deepEqual(oc[0].specialRows, []);
});

test('filter: it also works with grouping off (flat list, rows of the other providers hidden)', () => {
  const [s] = buildAccountView(ALL, opts({ filter: 'codex', group: false }), ctx());
  assert.deepEqual(ids(s), ['x1', 'x2']);
  assert.deepEqual(s.specialRows, ['codex']);
});

test('filter: a provider that no longer has accounts behaves as All', () => {
  const noOpencode = ALL.filter((a) => a.provider !== 'opencode');
  assert.equal(effectiveFilter('opencode', noOpencode), 'all');
  const withFilter = buildAccountView(noOpencode, opts({ filter: 'opencode' }), ctx());
  const withAll = buildAccountView(noOpencode, opts({ filter: 'all' }), ctx());
  assert.deepEqual(withFilter, withAll);
  assert.equal(flat(withFilter).length, 5);
  // un valor inválido guardado también cae a All
  assert.equal(effectiveFilter('bogus' as AccountsFilter, ALL), 'all');
  assert.equal(effectiveFilter('codex', ALL), 'codex');
});

test('providerCounts counts every provider and treats a missing provider as claude', () => {
  assert.deepEqual(providerCounts(ALL), { claude: 3, codex: 2, opencode: 1 });
  const legacy = { id: 'z', name: 'old', dir: 'C:/z', isDefault: false, color: '#fff' } as unknown as Account;
  assert.deepEqual(providerCounts([legacy]), { claude: 1, codex: 0, opencode: 0 });
  assert.deepEqual(providerCounts([]), { claude: 0, codex: 0, opencode: 0 });
});

// ---------- agrupar ----------

test('group on: one section per provider in Claude, Codex, opencode order, with headings', () => {
  const secs = buildAccountView(ALL, opts(), ctx());
  assert.deepEqual(secs.map((s) => s.provider), ['claude', 'codex', 'opencode']);
  assert.deepEqual(secs.map((s) => s.labelKey), ['sidebar.accounts.group.claude', 'sidebar.accounts.group.codex', 'sidebar.accounts.group.opencode']);
  assert.ok(secs.every((s) => s.heading));
  assert.deepEqual(ids(secs[0]), ['c1', 'c2', 'c3']); // orden guardado dentro del grupo
  assert.deepEqual(ids(secs[1]), ['x1', 'x2']);
  assert.deepEqual(ids(secs[2]), ['o1']);
});

test('group on: «Claude · auto» goes in the Claude group and the loose Codex launcher in the Codex group', () => {
  const secs = buildAccountView(ALL, opts(), ctx());
  assert.deepEqual(secs.map((s) => s.specialRows), [['auto'], ['codex'], []]);
});

test('group on: a Default Codex account removes the loose launcher', () => {
  const secs = buildAccountView(ALL, opts(), ctx({ hasDefaultCodex: true }));
  assert.deepEqual(secs.map((s) => s.specialRows), [['auto'], [], []]);
});

test('group off: one flat section, no headings, special rows after all the accounts', () => {
  const secs = buildAccountView(ALL, opts({ group: false }), ctx());
  assert.equal(secs.length, 1);
  assert.equal(secs[0].provider, null);
  assert.equal(secs[0].labelKey, null);
  assert.equal(secs[0].heading, false);
  assert.deepEqual(ids(secs[0]), ['c1', 'x1', 'c2', 'o1', 'c3', 'x2']); // tal cual está guardado
  assert.deepEqual(secs[0].specialRows, ['auto', 'codex']);
});

test('a single provider: no group headings even with grouping on', () => {
  const onlyClaude = [ZED, ALPHA, MID];
  // sin cuenta Default de Codex queda el lanzador suelto (otra sección sin cuentas): tampoco hay encabezados
  const a = buildAccountView(onlyClaude, opts(), ctx());
  assert.ok(a.every((s) => !s.heading));
  assert.deepEqual(flat(a), ['c1', 'c2', 'c3']);
  const b = buildAccountView(onlyClaude, opts(), ctx({ hasDefaultCodex: true }));
  assert.equal(b.length, 1);
  assert.equal(b[0].heading, false);
  assert.deepEqual(b[0].specialRows, ['auto']);
  // filtrando a un proveedor de varios tampoco: ya se sabe de cuál es
  assert.equal(buildAccountView(ALL, opts({ filter: 'codex' }), ctx())[0].heading, false);
});

test('group on: a provider without accounts or rows produces no section', () => {
  const secs = buildAccountView([ZED, WORK], opts(), ctx({ hasDefaultCodex: true }));
  assert.deepEqual(secs.map((s) => s.provider), ['claude', 'codex']); // opencode no existe
  assert.ok(secs.every((s) => s.heading));
  // el texto deja sin cuentas a opencode y a Claude: solo sobrevive lo que tiene algo que enseñar
  const text = buildAccountView(ALL, opts(), ctx({ text: 'work', hasDefaultCodex: true }));
  assert.deepEqual(text.map((s) => s.provider), ['claude', 'codex']);
  assert.deepEqual(text.map((s) => s.accounts.length), [0, 1]); // Claude solo conserva «auto»
});

test('empty list: grouped has only the special rows, nothing crashes', () => {
  const secs = buildAccountView([], opts(), ctx());
  assert.deepEqual(secs.map((s) => [s.provider, s.accounts.length, s.specialRows]), [['claude', 0, ['auto']], ['codex', 0, ['codex']]]);
  assert.ok(secs.every((s) => !s.heading));
  assert.deepEqual(buildAccountView([], opts({ group: false }), ctx())[0].accounts, []);
});

test('specialRows:false (Settings screen) leaves only accounts', () => {
  const secs = buildAccountView(ALL, opts(), ctx({ specialRows: false }));
  assert.ok(secs.every((s) => s.specialRows.length === 0));
  assert.deepEqual(flat(secs), ['c1', 'c2', 'c3', 'x1', 'x2', 'o1']);
});

// ---------- ordenar ----------

test('sort manual keeps the stored order', () => {
  assert.deepEqual(flat(buildAccountView(ALL, opts({ group: false, sort: 'manual' }), ctx())), ['c1', 'x1', 'c2', 'o1', 'c3', 'x2']);
});

test('sort name: A to Z, locale-aware, case-insensitive, numbers natural, tie keeps stored order', () => {
  const list = [mk('a', 'b10', 'claude'), mk('b', 'Álvaro', 'claude'), mk('c', 'b2', 'claude'), mk('d', 'alvaro', 'claude'), mk('e', 'Zoe', 'claude')];
  const names = sortAccounts(list, 'name', ctx()).map((a) => a.id);
  assert.deepEqual(names, ['b', 'd', 'c', 'a', 'e']); // Álvaro = alvaro (empate: gana el primero guardado), b2 < b10
  // dentro de cada grupo
  const secs = buildAccountView(ALL, opts({ sort: 'name' }), ctx());
  assert.deepEqual(ids(secs[0]), ['c2', 'c3', 'c1']); // alpha, Mid, Zed
  assert.deepEqual(ids(secs[1]), ['x2', 'x1']); // Abc, Work
});

test('sort name flat sorts by the full title, so the provider name leads', () => {
  const flatNames = flat(buildAccountView(ALL, opts({ group: false, sort: 'name' }), ctx()));
  assert.deepEqual(flatNames, ['c2', 'c3', 'c1', 'x2', 'x1', 'o1']); // Claude · …, Codex · …, opencode · …
});

test('sort free: lowest pressure first; Claude without data and other providers go last in stored order', () => {
  const flatFree = flat(buildAccountView(ALL, opts({ group: false, sort: 'free' }), ctx()));
  // c2 (20 %) < c1 (70 %); luego, sin dato, en su orden guardado: x1, o1, c3, x2
  assert.deepEqual(flatFree, ['c2', 'c1', 'x1', 'o1', 'c3', 'x2']);
  // agrupado: dentro de Claude c2, c1 y c3 (sin dato) al final; Codex y opencode no cambian
  const secs = buildAccountView(ALL, opts({ sort: 'free' }), ctx());
  assert.deepEqual(ids(secs[0]), ['c2', 'c1', 'c3']);
  assert.deepEqual(ids(secs[1]), ['x1', 'x2']);
});

test('sort free: ties keep stored order, the bottleneck window counts and an expired window counts as 0 %', () => {
  const a = mk('a', 'A', 'claude'), b = mk('b', 'B', 'claude'), c = mk('c', 'C', 'claude'), d = mk('d', 'D', 'claude');
  const qs: Record<string, Quota> = {
    a: quota(40, 100),
    b: quota(40, 50), // empate con a: gana el que estaba antes
    c: { fiveHour: { used: 10, resetsAt: NOW + 10 }, sevenDay: { used: 90, resetsAt: NOW + 1000 } }, // cuello de botella: 90
    d: { fiveHour: { used: 99, resetsAt: NOW - 5 }, sevenDay: { used: 30, resetsAt: NOW + 1000 } }, // 5 h renovada: cuenta 0 → máx 30
  };
  const out = sortAccounts([a, b, c, d], 'free', { quota: qs, now: NOW }).map((x) => x.id);
  assert.deepEqual(out, ['d', 'a', 'b', 'c']);
});

test('sort reset: earliest renewal first; no data and other providers last, stored order kept', () => {
  const flatReset = flat(buildAccountView(ALL, opts({ group: false, sort: 'reset' }), ctx()));
  // c1 renueva en 1 h, c2 en 2 h
  assert.deepEqual(flatReset, ['c1', 'c2', 'x1', 'o1', 'c3', 'x2']);
  const secs = buildAccountView(ALL, opts({ sort: 'reset' }), ctx());
  assert.deepEqual(ids(secs[0]), ['c1', 'c2', 'c3']);
});

test('sort reset: windows already renewed give no date (last), ties keep stored order', () => {
  const a = mk('a', 'A', 'claude'), b = mk('b', 'B', 'claude'), c = mk('c', 'C', 'claude');
  const qs: Record<string, Quota> = { b: quota(10, 500), c: quota(10, 500) } as Record<string, Quota>;
  qs.a = { fiveHour: { used: 10, resetsAt: NOW - 100 } }; // única ventana ya renovada → sin próxima renovación
  assert.deepEqual(sortAccounts([a, b, c], 'reset', { quota: qs, now: NOW }).map((x) => x.id), ['b', 'c', 'a']);
});

test('sort free/reset with a quota entry missing from the map or undefined does not throw', () => {
  const out = sortAccounts([ZED, ALPHA], 'free', { quota: { c1: undefined }, now: NOW });
  assert.deepEqual(out.map((a) => a.id), ['c1', 'c2']);
});

test('every sort keeps all accounts exactly once', () => {
  for (const sort of ACCOUNTS_SORTS) for (const group of [true, false]) for (const filter of ACCOUNTS_FILTERS) {
    const secs = buildAccountView(ALL, opts({ sort, group, filter }), ctx());
    const got = flat(secs);
    assert.equal(new Set(got).size, got.length, `${sort}/${group}/${filter} duplicates`);
    const expected = ALL.filter((a) => filter === 'all' || a.provider === filter).map((a) => a.id).sort();
    assert.deepEqual([...got].sort(), expected, `${sort}/${group}/${filter}`);
  }
});

// ---------- texto, estabilidad, inmutabilidad ----------

test('text filter works on top of the provider filter (name, email, provider word)', () => {
  assert.deepEqual(flat(buildAccountView(ALL, opts({ group: false }), ctx({ text: 'work' }))), ['x1']);
  assert.deepEqual(flat(buildAccountView(ALL, opts({ group: false }), ctx({ text: 'CODEX' }))), ['x1', 'x2']); // por proveedor
  assert.deepEqual(flat(buildAccountView(ALL, opts({ filter: 'claude', group: false }), ctx({ text: 'work' }))), []); // se combinan (Y)
  assert.deepEqual(flat(buildAccountView(ALL, opts({ filter: 'codex' }), ctx({ text: 'ab' }))), ['x2']);
  const emails: Record<string, string> = { c3: 'me@corp.example' };
  assert.deepEqual(flat(buildAccountView(ALL, opts({ group: false }), ctx({ text: 'corp', emailOf: (a) => emails[a.id] }))), ['c3']);
  assert.equal(matchesText(ZED, '  zed '), true);
  assert.equal(matchesText(ZED, 'nope'), false);
  assert.equal(matchesText(ZED, ''), true);
});

test('text filter keeps the special rows (as the sidebar always did) and sorts what matches', () => {
  const secs = buildAccountView(ALL, opts({ sort: 'name' }), ctx({ text: 'nothing-matches' }));
  assert.deepEqual(flat(secs), []);
  assert.deepEqual(secs.map((s) => s.specialRows), [['auto'], ['codex']]);
});

test('the input list and its accounts are never mutated, and the output reuses the same account objects', () => {
  const input = ALL.map((a) => Object.freeze({ ...a }));
  Object.freeze(input);
  const before = JSON.stringify(input);
  for (const sort of ACCOUNTS_SORTS) for (const group of [true, false]) {
    const secs = buildAccountView(input, opts({ sort, group }), ctx()); // un sort() in situ lanzaría TypeError sobre el array congelado
    for (const a of secs.flatMap((s) => s.accounts)) assert.ok(input.includes(a));
  }
  assert.equal(JSON.stringify(input), before);
  const sorted = sortAccounts(input, 'name', ctx());
  assert.notEqual(sorted, input);
  assert.deepEqual(input.map((a) => a.id), ALL.map((a) => a.id));
});

test('the result is stable: the same input gives the same output, and re-sorting a sorted list changes nothing', () => {
  for (const sort of ACCOUNTS_SORTS) {
    const one = buildAccountView(ALL, opts({ sort, group: false }), ctx());
    const two = buildAccountView(ALL, opts({ sort, group: false }), ctx());
    assert.deepEqual(one, two);
    assert.deepEqual(sortAccounts(one[0].accounts, sort, ctx()).map((a) => a.id), ids(one[0]));
  }
});

// ---------- ajustes ----------

test('settings: defaults are all / manual / group on', () => {
  assert.equal(DEFAULTS.accountsFilter, 'all');
  assert.equal(DEFAULTS.accountsSort, 'manual');
  assert.equal(DEFAULTS.accountsGroup, true);
  assert.equal(clampSettings({}).accountsFilter, 'all');
});

test('settings: valid values pass, unknown values fall back to the defaults', () => {
  for (const f of ACCOUNTS_FILTERS) assert.equal(clampSettings({ accountsFilter: f }).accountsFilter, f);
  for (const s of ACCOUNTS_SORTS) assert.equal(clampSettings({ accountsSort: s }).accountsSort, s);
  assert.equal(clampSettings({ accountsGroup: false }).accountsGroup, false);
  for (const bad of ['gemini', '', 'ALL', 1, null, true, {}, ['claude']]) {
    assert.equal(clampSettings({ accountsFilter: bad }).accountsFilter, 'all', String(bad));
    assert.equal(clampSettings({ accountsSort: bad }).accountsSort, 'manual', String(bad));
  }
  for (const bad of ['yes', 0, 1, null, {}]) assert.equal(clampSettings({ accountsGroup: bad }).accountsGroup, true, String(bad));
});

test('settings: an old state file without the keys loads unchanged, and the view settings survive a JSON round trip', () => {
  const old = { fontSize: 16, accountPolicy: 'most-free', sidebarWidth: 340 };
  const s = clampSettings(old);
  assert.equal(s.fontSize, 16);
  assert.equal(s.sidebarWidth, 340);
  assert.deepEqual([s.accountsFilter, s.accountsSort, s.accountsGroup], ['all', 'manual', true]);
  const custom = clampSettings({ ...DEFAULTS, accountsFilter: 'codex', accountsSort: 'reset', accountsGroup: false });
  assert.deepEqual(clampSettings(JSON.parse(JSON.stringify(custom))), custom);
});

test('settings: the accounts section resets exactly the three view keys', () => {
  assert.deepEqual([...SECTION_KEYS.accounts], ['accountsFilter', 'accountsSort', 'accountsGroup']);
  const cur = clampSettings({ ...DEFAULTS, accountsFilter: 'claude', accountsSort: 'name', accountsGroup: false, fontSize: 20 });
  const r = resetSection(cur, 'accounts');
  assert.deepEqual([r.accountsFilter, r.accountsSort, r.accountsGroup], ['all', 'manual', true]);
  assert.equal(r.fontSize, 20);
  // y las demás secciones no las tocan
  const g = resetSection(cur, 'general');
  assert.deepEqual([g.accountsFilter, g.accountsSort, g.accountsGroup], ['claude', 'name', false]);
});

test('settings: pasted JSON can set the view and junk values are cleaned', () => {
  const ok = parseImport('{"accountsSort":"free","accountsFilter":"nope"}', DEFAULTS);
  assert.ok(ok.ok);
  if (ok.ok) { assert.equal(ok.settings.accountsSort, 'free'); assert.equal(ok.settings.accountsFilter, 'all'); }
});

// ---------- menú ----------

function menuCtx(over: Partial<Parameters<typeof accountsViewMenu>[0]> = {}) {
  const log: string[] = [];
  const c = {
    filter: 'all' as AccountsFilter, sort: 'manual' as AccountsSort, group: true,
    counts: { claude: 3, codex: 2, opencode: 0 },
    setSort: (s: AccountsSort) => log.push(`sort:${s}`),
    setGroup: (g: boolean) => log.push(`group:${g}`),
    setFilter: (f: AccountsFilter) => log.push(`filter:${f}`),
    ...over,
  };
  return { items: accountsViewMenu(c), log };
}

test('menu: Sort by submenu has the 4 sorts as radios with only the current one checked', () => {
  const { items, log } = menuCtx({ sort: 'name' });
  const sort = items.find((i) => i.id === 'sort')!;
  assert.equal(sort.label, t('ctx.accountsView.sortBy'));
  assert.deepEqual(sort.children!.map((c) => c.id), ['sort:manual', 'sort:name', 'sort:free', 'sort:reset']);
  assert.deepEqual(sort.children!.map((c) => c.checked), [false, true, false, false]);
  sort.children!.find((c) => c.id === 'sort:reset')!.run!();
  assert.deepEqual(log, ['sort:reset']);
});

test('menu: Group by provider is checkable and toggles to the opposite value', () => {
  const on = menuCtx({ group: true });
  const g1 = on.items.find((i) => i.id === 'group')!;
  assert.equal(g1.checked, true);
  g1.run!();
  assert.deepEqual(on.log, ['group:false']);
  const off = menuCtx({ group: false });
  const g2 = off.items.find((i) => i.id === 'group')!;
  assert.equal(g2.checked, false);
  g2.run!();
  assert.deepEqual(off.log, ['group:true']);
});

test('menu: Show items are radios; providers without accounts are disabled; separators sit between the three blocks', () => {
  const { items, log } = menuCtx({ filter: 'codex' });
  const show = items.filter((i) => i.id.startsWith('show:'));
  assert.deepEqual(show.map((i) => i.id), ['show:all', 'show:claude', 'show:codex', 'show:opencode']);
  assert.deepEqual(show.map((i) => i.checked), [false, false, true, false]);
  assert.deepEqual(show.map((i) => !!i.disabled), [false, false, false, true]); // opencode: 0 cuentas
  show.find((i) => i.id === 'show:claude')!.run!();
  assert.deepEqual(log, ['filter:claude']);
  assert.deepEqual(items.map((i) => !!i.separator), [false, true, false, true, false, false, false, false]);
  assert.ok(show[2].label.includes('ChatGPT'));
});
