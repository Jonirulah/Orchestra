// Cuentas por proveedor (Claude / Codex / opencode): migración del estado guardado, entorno por panel,
// exclusión de las que no son de Claude de la política, MCP y arranque de agentes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  accountDir, accountTitle, claudeSpec, codexSpec, normalizeAccounts, providerEnv, providerLabel, providerOf, providerSpec,
} from './model.ts';
import type { Account, Pane } from './model.ts';
import { pickAccount } from './policy.ts';
import type { Candidate } from './policy.ts';
import { buildMcpSnapshot, paneKind } from './mcpsync.ts';

const acc = (over: Partial<Account> & { id: string }): Account => ({
  name: over.id.toUpperCase(), dir: `C:\\Users\\me\\.${over.id}`, isDefault: false, color: '#fff', provider: 'claude', ...over,
});
const NOW = 1_000_000;

// ---------- migración ----------

test('an old saved state (accounts without provider) loads unchanged as Claude accounts', () => {
  // Forma exacta que guardaban las versiones anteriores en state.json.
  const saved = JSON.parse(JSON.stringify({
    accounts: [
      { id: 'acc-a1', name: 'Main', dir: 'C:\\Users\\me\\.claude', isDefault: true, color: '#f5b942' },
      { id: 'acc-b2', name: 'work', dir: 'C:\\Users\\me\\.claude-work', isDefault: false, color: '#6cb2ff' },
    ],
  }));
  const loaded = normalizeAccounts(saved.accounts);
  assert.equal(loaded.length, 2);
  for (const [i, a] of loaded.entries()) {
    assert.equal(a.provider, 'claude');
    // Nada más cambia: mismos campos y valores que lo guardado.
    const { provider, ...rest } = a;
    assert.deepEqual(rest, saved.accounts[i]);
  }
  // Y se lanzan igual que antes.
  assert.deepEqual(claudeSpec(loaded[0]).env, { ORCHESTRA_ACCOUNT: 'acc-a1' });
  assert.deepEqual(claudeSpec(loaded[1]).env, { CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-work', ORCHESTRA_ACCOUNT: 'acc-b2' });
});

test('normalizeAccounts keeps stored providers, defaults junk to claude and drops non-accounts', () => {
  const out = normalizeAccounts([
    { id: 'a', name: 'A', dir: 'x', isDefault: false, color: '#fff', provider: 'codex' },
    { id: 'b', name: 'B', dir: 'y', isDefault: false, color: '#fff', provider: 'opencode', extra: 1 },
    { id: 'c', name: 'C', dir: 'z', isDefault: false, color: '#fff', provider: 'nope' },
    { id: 'd', name: 'D', dir: 'w', isDefault: false, color: '#fff' },
    null, 42, 'x', { id: 7, dir: 'q' }, { name: 'no id', dir: 'q' }, { id: 'e' },
  ]);
  assert.deepEqual(out.map((a) => [a.id, a.provider]), [['a', 'codex'], ['b', 'opencode'], ['c', 'claude'], ['d', 'claude']]);
  assert.equal((out[1] as unknown as { extra: number }).extra, 1, 'unknown fields survive');
  assert.deepEqual(normalizeAccounts(undefined), []);
  assert.deepEqual(normalizeAccounts({}), []);
  // Idempotente: lo normalizado se vuelve a normalizar igual (guardar y recargar).
  assert.deepEqual(normalizeAccounts(JSON.parse(JSON.stringify(out))), out);
});

test('providerOf / providerLabel / accountTitle', () => {
  assert.equal(providerOf(undefined), 'claude');
  assert.equal(providerOf({}), 'claude');
  assert.equal(providerOf({ provider: 'codex' }), 'codex');
  assert.equal(providerOf({ provider: 'whatever' }), 'claude');
  assert.deepEqual(['claude', 'codex', 'opencode'].map((p) => providerLabel(p as never)), ['Claude', 'Codex', 'opencode']);
  assert.equal(accountTitle(acc({ id: 'w', name: 'Work', provider: 'codex' })), 'Codex · Work');
  assert.equal(accountTitle(acc({ id: 'w', name: 'Work', provider: 'opencode' })), 'opencode · Work');
  assert.equal(accountTitle(acc({ id: 'w', name: 'Work' })), 'Claude · Work');
});

// ---------- carpeta y entorno por proveedor ----------

test('accountDir: one folder per provider and name', () => {
  assert.equal(accountDir('claude', 'C:\\Users\\me', 'Work Pro'), 'C:\\Users\\me\\.claude-work-pro');
  assert.equal(accountDir('codex', 'C:\\Users\\me\\', 'Work Pro'), 'C:\\Users\\me\\.codex-work-pro');
  assert.equal(accountDir('opencode', 'C:\\Users\\me', 'Ñandú'), 'C:\\Users\\me\\.opencode-nandu');
});

test('providerEnv: the right variable per provider, never process-wide, default = none', () => {
  const codex = acc({ id: 'c1', provider: 'codex', dir: 'C:\\Users\\me\\.codex-work' });
  assert.deepEqual(providerEnv(codex), { ORCHESTRA_ACCOUNT: 'c1', CODEX_HOME: 'C:\\Users\\me\\.codex-work' });
  const oc = acc({ id: 'o1', provider: 'opencode', dir: 'C:\\Users\\me\\.opencode-work' });
  assert.deepEqual(providerEnv(oc), {
    ORCHESTRA_ACCOUNT: 'o1', XDG_DATA_HOME: 'C:\\Users\\me\\.opencode-work\\data', XDG_STATE_HOME: 'C:\\Users\\me\\.opencode-work\\state',
  });
  assert.deepEqual(providerEnv(acc({ id: 'k1', dir: 'C:\\Users\\me\\.claude-x' })), { ORCHESTRA_ACCOUNT: 'k1', CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-x' });
  // Las cuentas de siempre no llevan variable de carpeta.
  assert.deepEqual(providerEnv({ ...codex, isDefault: true }), { ORCHESTRA_ACCOUNT: 'c1' });
  assert.deepEqual(providerEnv({ ...oc, isDefault: true }), { ORCHESTRA_ACCOUNT: 'o1' });
  // Sin fugas entre proveedores.
  assert.ok(!('CLAUDE_CONFIG_DIR' in providerEnv(codex)) && !('XDG_DATA_HOME' in providerEnv(codex)));
  assert.ok(!('CODEX_HOME' in providerEnv(oc)) && !('CODEX_HOME' in providerEnv(acc({ id: 'k' }))));
});

test('providerSpec: codex / opencode panes, sign-in panes and the opencode --standalone rule', () => {
  const codex = acc({ id: 'c1', provider: 'codex', dir: 'C:\\h\\.codex-a' });
  const run = providerSpec(codex, { cwd: 'C:\\w' });
  assert.equal(run.program, 'powershell.exe');
  assert.deepEqual(run.args, ['-NoLogo', '-NoExit', '-Command', '& codex']);
  assert.equal(run.cwd, 'C:\\w');
  assert.equal(run.env?.CODEX_HOME, 'C:\\h\\.codex-a');
  assert.deepEqual(providerSpec(codex, { login: true }).args, ['-NoLogo', '-NoExit', '-Command', '& codex login']);
  assert.equal(providerSpec(codex, { login: true }).env?.CODEX_HOME, 'C:\\h\\.codex-a', 'sign-in uses the same account folder');

  const oc = acc({ id: 'o1', provider: 'opencode', dir: 'C:\\h\\.opencode-a' });
  // opencode v2 comparte un servicio en segundo plano: sin --standalone no hay aislamiento (verificado con el binario real).
  assert.equal(providerSpec(oc).args[3], '& opencode --standalone');
  assert.equal(providerSpec(oc, { login: true }).args[3], '& opencode auth login --standalone');
  assert.equal(providerSpec(oc).env?.XDG_DATA_HOME, 'C:\\h\\.opencode-a\\data');
  const ocDef = acc({ id: 'o2', provider: 'opencode', dir: 'C:\\h\\.local\\share\\opencode', isDefault: true });
  assert.equal(providerSpec(ocDef).args[3], '& opencode', 'the default opencode account is the shared one');
  assert.equal(providerSpec(ocDef, { login: true }).args[3], '& opencode auth login');
  assert.deepEqual(providerSpec(ocDef).env, { ORCHESTRA_ACCOUNT: 'o2' });
  const codexDef = acc({ id: 'c2', provider: 'codex', dir: 'C:\\h\\.codex', isDefault: true });
  assert.deepEqual(providerSpec(codexDef).env, { ORCHESTRA_ACCOUNT: 'c2' });

  // Ninguna ruta de cuenta se mete en el comando (solo en el entorno): nada que escapar.
  for (const s of [run, providerSpec(oc), providerSpec(oc, { login: true })]) assert.ok(!s.args.join(' ').includes('\\h\\'), s.args.join(' '));
  // El lanzador suelto de siempre sigue igual.
  assert.deepEqual(codexSpec({ cwd: 'C:\\w' }), { program: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', '& codex'], cwd: 'C:\\w' });
  // Dos cuentas = dos entornos distintos (pueden correr a la vez).
  const c2 = acc({ id: 'c3', provider: 'codex', dir: 'C:\\h\\.codex-b' });
  assert.notEqual(providerSpec(codex).env?.CODEX_HOME, providerSpec(c2).env?.CODEX_HOME);
});

// ---------- política: solo Claude ----------

const cand = (a: Account, loggedIn = true): Candidate => ({ acc: a, loggedIn, quota: undefined });

test('pickAccount never picks Codex or opencode accounts, under any policy', () => {
  const codex = acc({ id: 'c1', provider: 'codex' });
  const oc = acc({ id: 'o1', provider: 'opencode' });
  const claude = acc({ id: 'k1' });
  for (const policy of ['round-robin', 'reset-soonest', 'most-free'] as const) {
    assert.equal(pickAccount(policy, [cand(codex), cand(oc)], undefined, NOW), null, `${policy}: only non-Claude -> null`);
    for (const last of [undefined, 'c1', 'o1', 'k1']) {
      const pick = pickAccount(policy, [cand(codex), cand(claude), cand(oc)], last, NOW);
      assert.equal(pick?.acc.id, 'k1', `${policy} last=${last}`);
    }
  }
  // Una cuenta guardada sin `provider` (estado viejo sin normalizar) sigue siendo candidata.
  const legacy = { id: 'old', name: 'old', dir: 'x', isDefault: false, color: '#fff' } as unknown as Account;
  assert.equal(pickAccount('round-robin', [cand(codex), cand(legacy)], undefined, NOW)?.acc.id, 'old');
});

// ---------- MCP ----------

test('MCP pane kinds: Codex accounts are codex, opencode panes are shell, Claude stays claude', () => {
  const providers = { c1: 'codex', o1: 'opencode', k1: 'claude' } as const;
  const p = (ref?: string): Pick<Pane, 'kind' | 'ref'> => ({ kind: 'agent', ref });
  assert.equal(paneKind(p('c1'), providers), 'codex');
  assert.equal(paneKind(p('o1'), providers), 'shell');
  assert.equal(paneKind(p('k1'), providers), 'claude');
  assert.equal(paneKind(p('codex'), providers), 'codex', 'the loose launcher keeps working');
  assert.equal(paneKind(p('gone'), providers), 'claude');
  assert.equal(paneKind(p('c1')), 'claude', 'without the map: as before');
  const pane = (id: string, ref: string): Pane => ({
    id, col: 0, row: 0, colSpan: 1, rowSpan: 1, parked: false, kind: 'agent', icon: 'bot', title: id, ref, spec: { program: 'p', args: [] },
  });
  const snap = buildMcpSnapshot({
    hosts: [], live: {}, providers,
    workspaces: [{ id: 'w', name: 'Main', cols: [1], rows: [1], panes: [pane('x1', 'c1'), pane('x2', 'o1'), pane('x3', 'k1')] }],
  });
  assert.deepEqual(snap.panes.map((q) => q.kind), ['codex', 'shell', 'claude']);
});

// ---------- el almacén no mezcla proveedores ----------

test('the store only feeds Claude accounts to quota, usage query, agent scan, policy and the switcher', () => {
  const src = readFileSync(new URL('./store.svelte.ts', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**'));
  const mustUseClaude = ['be.quotaRead(', 'be.agentScan(', 'queryTargets(', 'const cands = this.'];
  for (const needle of mustUseClaude) {
    const line = code.find((l) => l.includes(needle));
    assert.ok(line, `store has no line with ${needle}`);
    assert.ok(line.includes('claudeAccounts') || line.includes('queryTargets(this.claudeAccounts'), `${needle} must use claudeAccounts: ${line.trim()}`);
  }
  assert.ok(code.some((l) => l.includes('for (const acc of this.claudeAccounts)')), 'quota alerts');
  const sw = code.findIndex((l) => l.includes('async switchAccount('));
  assert.ok(code.slice(sw, sw + 6).some((l) => l.includes("providerOf(acc) !== 'claude'")), 'switchAccount refuses non-Claude targets');
  const rm = code.findIndex((l) => l.includes('removeAccount(id: string)'));
  assert.ok(code.slice(rm, rm + 10).some((l) => l.includes("providerOf(acc) === 'claude' && !this.ignoredDirs")), 'removing a Codex account never lands in the Claude ignore list');
  // La carga normaliza.
  assert.ok(code.some((l) => l.includes('normalizeAccounts(st.accounts)')), 'accounts are normalized on load');
});

test('the settings screen shows no usage bars or usage query for non-Claude accounts', () => {
  const src = readFileSync(new URL('../components/SettingsAccounts.svelte', import.meta.url), 'utf8');
  assert.match(src, /\{#if prov === 'claude'\}<div[^>]*><UsageBars/);
  assert.match(src, /\{#if prov === 'claude' && app\.settings\.usageQuery\}/);
  const side = readFileSync(new URL('../components/Sidebar.svelte', import.meta.url), 'utf8');
  const i = side.indexOf("{#if providerOf(a) === 'claude'}");
  assert.ok(i > 0 && side.indexOf('<UsageBars', i) > i && side.indexOf('{:else}', i) > side.indexOf('<UsageBars', i), 'UsageBars only in the Claude branch');
});
