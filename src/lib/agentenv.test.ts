import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CODE_MODE_ENV, RESERVED_ENV, cleanEnvRows, codeModeOn, customEnvFor, envIssues, envMap, exportableEnv, setCodeMode, spawnEnv,
} from './agentenv.ts';
import type { EnvRow } from './agentenv.ts';
import { claudeSpec, mcpLoginSpec, normalizeAccounts, providerSpec } from './model.ts';
import type { Account, Pane, PaneSpec } from './model.ts';
import { DEFAULTS, SECTION_KEYS, clampSettings } from './settings.ts';
import { buildBackup, mergeBackup, parseBackup, serializeBackup } from './backup.ts';
import type { BackupState } from './backup.ts';
import { fromSaved, toSaved } from './savedws.ts';

const acc = (id: string, provider: Account['provider'], extra: Partial<Account> = {}): Account =>
  ({ id, name: id, dir: `C:\\Users\\me\\.${provider}-${id}`, isDefault: false, color: '#f5b942', provider, ...extra });
const pane = (spec: PaneSpec, ref?: string, kind: Pane['kind'] = 'agent'): Pane =>
  ({ id: 't-1', col: 0, row: 0, colSpan: 1, rowSpan: 1, parked: false, kind, icon: 'bot', title: 'x', ref, spec });
const rows = (...kv: [string, string][]): EnvRow[] => kv.map(([key, value]) => ({ key, value }));

const claude = acc('c1', 'claude');
const codex = acc('x1', 'codex');
const oc = acc('o1', 'opencode');
const ACCS = [claude, codex, oc];
const G = rows([CODE_MODE_ENV, '1'], ['FOO', 'global']);

test('la lista global se aplica a Claude, Codex, opencode y al inicio de sesión MCP (y no a una shell normal)', () => {
  for (const [a, spec] of [[claude, claudeSpec(claude)], [codex, providerSpec(codex)], [oc, providerSpec(oc)], [codex, mcpLoginSpec('codex', codex, 'srv')]] as const) {
    const env = spawnEnv(pane(spec, a.id), G, ACCS)!;
    assert.equal(env[CODE_MODE_ENV], '1', `${a.provider}: falta la global`);
    assert.equal(env.FOO, 'global');
    assert.equal(env.ORCHESTRA_ACCOUNT, a.id, 'las de Orchestra siguen');
  }
  // Inicio de sesión MCP sin cuenta (lanzador «Codex» de siempre): también es un agente.
  assert.equal(spawnEnv(pane(mcpLoginSpec('codex', null, 'srv')), G, ACCS)?.FOO, 'global');
  // Una shell o un SSH no son agentes: no reciben nada.
  const sh = pane({ program: 'pwsh.exe', args: [] }, 'pwsh', 'shell');
  assert.equal(spawnEnv(sh, G, ACCS), undefined);
  assert.deepEqual(customEnvFor(pane({ program: 'ssh', args: [] }, 'h-1', 'ssh'), G, ACCS), {});
});

test('la variable de la cuenta gana a la global si coincide la clave (también con otras mayúsculas)', () => {
  const work = acc('c2', 'claude', { env: rows(['FOO', 'cuenta'], ['solo_cuenta', 'sí']) });
  const env = spawnEnv(pane(claudeSpec(work), work.id), rows(['foo', 'global'], ['BAR', 'g']), [work])!;
  assert.equal(env.FOO, 'cuenta');
  assert.equal(env.foo, undefined, 'en Windows FOO y foo son la misma variable: no van las dos');
  assert.equal(env.BAR, 'g');
  assert.equal(env.solo_cuenta, 'sí');
  // La de otra cuenta no se cuela.
  assert.deepEqual(spawnEnv(pane(claudeSpec(claude), claude.id), [], [claude, work]), spawnEnv(pane(claudeSpec(claude), claude.id), [], [claude]));
});

test('las reservadas de Orchestra no se pisan: se avisan y no se aplican', () => {
  const evil = rows(...RESERVED_ENV.map((k) => [k, 'C:\\pisado'] as [string, string]), ['claude_config_dir', 'x']);
  assert.deepEqual(envIssues(evil), evil.map(() => 'reserved'));
  assert.deepEqual(envMap(evil), {});
  const work = acc('c2', 'claude', { env: rows(['CLAUDE_CONFIG_DIR', 'C:\\otra']) });
  const env = spawnEnv(pane(claudeSpec(work), work.id), evil, [work])!;
  assert.equal(env.CLAUDE_CONFIG_DIR, work.dir);
  assert.equal(env.ORCHESTRA_ACCOUNT, work.id);
  // Cuenta por defecto (sin CLAUDE_CONFIG_DIR en el spec): tampoco se la inventa la lista.
  const def = acc('c0', 'claude', { isDefault: true });
  assert.equal(spawnEnv(pane(claudeSpec(def), def.id), evil, [def])!.CLAUDE_CONFIG_DIR, undefined);
  const op = acc('o2', 'opencode');
  const e2 = spawnEnv(pane(providerSpec(op), op.id), rows(['XDG_DATA_HOME', 'C:\\x']), [op])!;
  assert.match(e2.XDG_DATA_HOME, /\\data$/);
});

test('nombre inválido o repetido se rechaza (fila guardada, sin aplicar); fila vacía se ignora', () => {
  const r = rows(['1ABC', 'a'], ['CON-GUION', 'b'], ['CON ESPACIO', 'c'], ['BIEN_1', 'd'], ['bien_1', 'e'], ['', ''], ['', 'sin nombre'], ['_ok', 'f']);
  assert.deepEqual(envIssues(r), ['invalid', 'invalid', 'invalid', null, 'duplicate', null, 'invalid', null]);
  assert.deepEqual(envMap(r), { BIEN_1: 'd', _ok: 'f' });
  // Lo guardado se limpia como dato: sin «=», sin control, con tope; lo que no es fila se descarta.
  assert.deepEqual(cleanEnvRows([{ key: 'A=B\n', value: 'x\u0000y' }, 'basura', { key: 1, value: 'x' }, null]), [{ key: 'AB', value: 'xy' }]);
  assert.equal(cleanEnvRows(Array.from({ length: 200 }, (_, i) => ({ key: `K${i}`, value: '' }))).length, 64);
  assert.deepEqual(cleanEnvRows('no'), []);
  // Y lo mismo al cargar los ajustes y las cuentas.
  assert.deepEqual(clampSettings({ agentEnv: [{ key: 'FOO', value: '1' }, 5] }).agentEnv, [{ key: 'FOO', value: '1' }]);
  assert.deepEqual(clampSettings({}).agentEnv, []);
  assert.deepEqual(normalizeAccounts([{ ...claude, env: [{ key: 'A', value: 'b' }, { key: 2 }] }])[0].env, [{ key: 'A', value: 'b' }]);
  assert.equal('env' in normalizeAccounts([{ ...claude, env: 'x' }])[0], false);
});

test('panel restaurado o reiniciado toma los ajustes ACTUALES: quitar la variable la quita al relanzar', () => {
  const p = pane(claudeSpec(claude, { cwd: 'C:\\w' }), claude.id);
  let globalRows = setCodeMode([], true);
  assert.equal(spawnEnv(p, globalRows, ACCS)?.[CODE_MODE_ENV], '1');
  // El spec del panel nunca la lleva dentro: lo que se guarda (estado, espacios, copia) no la congela.
  assert.equal(p.spec.env?.[CODE_MODE_ENV], undefined);
  const restored = fromSaved(toSaved({ id: 'w', name: 'w', cols: [1], rows: [1], panes: [p] }, { name: 'w' })).panes[0];
  assert.equal(restored.spec.env?.[CODE_MODE_ENV], undefined);
  assert.equal(spawnEnv(restored, globalRows, ACCS)?.[CODE_MODE_ENV], '1', 'restaurado con la variable puesta → la lleva');
  globalRows = setCodeMode(globalRows, false);
  assert.equal(spawnEnv(restored, globalRows, ACCS)?.[CODE_MODE_ENV], undefined, 'quitada → el restaurado ya no la lleva');
  assert.equal(spawnEnv(p, globalRows, ACCS)?.[CODE_MODE_ENV], undefined, 'quitada → el reiniciado ya no la lleva');
  assert.equal(spawnEnv(p, globalRows, ACCS)?.ORCHESTRA_ACCOUNT, claude.id);
});

test('terminals.ts lanza y reinicia con el entorno calculado al momento, no con el del spec', () => {
  const src = readFileSync(new URL('./terminals.ts', import.meta.url), 'utf8');
  const spawns = [...src.matchAll(/be\.ptySpawn\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  assert.equal(spawns.length, 2, 'launch() y restart()');
  for (const s of spawns) {
    assert.match(s, /env: envOf\(pane\)/);
    assert.doesNotMatch(s, /env: pane\.spec\.env/);
  }
  assert.match(src, /hooks\.spawnEnv \? hooks\.spawnEnv\(pane\)/);
  const store = readFileSync(new URL('./store.svelte.ts', import.meta.url), 'utf8');
  assert.match(store, /spawnEnv: \(pane\) => spawnEnv\(pane, this\.settings\.agentEnv, this\.accounts\)/);
});

test('interruptor del modo código: añade o quita solo esa variable', () => {
  assert.equal(codeModeOn([]), false);
  const on = setCodeMode(rows(['FOO', '1']), true);
  assert.deepEqual(on, rows(['FOO', '1'], [CODE_MODE_ENV, '1']));
  assert.equal(codeModeOn(on), true);
  assert.deepEqual(setCodeMode(on, true), on, 'encender dos veces no duplica');
  // Una fila previa con otro valor (o repetida) se reaprovecha.
  assert.deepEqual(setCodeMode(rows([CODE_MODE_ENV, '0'], ['A', 'b'], [CODE_MODE_ENV, '1']), true), rows([CODE_MODE_ENV, '1'], ['A', 'b']));
  assert.equal(codeModeOn(rows([CODE_MODE_ENV, '0'])), false);
  assert.deepEqual(setCodeMode(on, false), rows(['FOO', '1']));
  assert.deepEqual(setCodeMode(rows(['claude_code_experimental_code_mode', '1']), false), []);
});

test('ajustes: van en la sección Agentes y por defecto no hay ninguna', () => {
  assert.deepEqual(DEFAULTS.agentEnv, []);
  assert.ok((SECTION_KEYS.agents as readonly string[]).includes('agentEnv'));
});

test('copia de seguridad: ida y vuelta de la lista global y la de cuenta, sin las de nombre secreto', () => {
  const work = acc('c2', 'claude', { env: rows(['CUENTA_VAR', 'v'], ['ANTHROPIC_API_KEY', 'sk-xxx'], ['GITHUB_TOKEN', 'ghp']) });
  const state: BackupState = {
    settings: { ...DEFAULTS, agentEnv: rows([CODE_MODE_ENV, '1'], ['MY_PASSWORD', 'p'], ['MY_SECRET', 's'], ['VISIBLE', 'ok']) },
    hosts: [], accounts: [work], customThemes: [], workspaces: [], activeId: '', ignoredDirs: [],
  };
  const text = serializeBackup(buildBackup(state, { appVersion: '0.4.6' }));
  for (const secret of ['sk-xxx', 'ghp', 'MY_PASSWORD', 'MY_SECRET', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN']) assert.ok(!text.includes(secret), `se coló ${secret}`);
  const r = parseBackup(text);
  assert.ok(r.ok);
  assert.deepEqual(r.sections.settings?.agentEnv, rows([CODE_MODE_ENV, '1'], ['VISIBLE', 'ok']));
  assert.deepEqual(r.sections.accounts[0].env, rows(['CUENTA_VAR', 'v']));
  // Importar en un equipo vacío: quedan los ajustes y la cuenta con su lista.
  const blank: BackupState = { settings: { ...DEFAULTS }, hosts: [], accounts: [], customThemes: [], workspaces: [], activeId: '', ignoredDirs: [] };
  const { state: after } = mergeBackup(blank, r.sections, { settings: true, hosts: true, accounts: true, themes: true, workspaces: true });
  assert.equal(codeModeOn(after.settings.agentEnv), true);
  assert.deepEqual(after.accounts[0].env, rows(['CUENTA_VAR', 'v']));
  // El archivo es dato: una lista hostil se limpia al entrar.
  const hostile = JSON.parse(text);
  hostile.settings.agentEnv = [{ key: 'X\u0001=', value: 'y' }, { nope: 1 }];
  const r2 = parseBackup(JSON.stringify(hostile));
  assert.ok(r2.ok);
  assert.deepEqual(r2.sections.settings?.agentEnv, [{ key: 'X', value: 'y' }]);
  assert.deepEqual(exportableEnv(undefined), []);
});
