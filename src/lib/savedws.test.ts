import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteSaved, duplicateWorkspace, filterSaved, findByName, freshAgentSpec, fromSaved, mergeSaved, normalizeSaved, overwriteSaved,
  renameSaved, toSaved, uniqueName, upsertSaved, SAVED_LIMITS,
} from './savedws.ts';
import type { SavedWorkspace } from './savedws.ts';
import { ALL_PICKS, buildBackup, mergeBackup, parseBackup, replaceFromBackup, serializeBackup } from './backup.ts';
import type { BackupState } from './backup.ts';
import { DEFAULTS } from './settings.ts';
import type { Pane, Workspace } from './model.ts';

const SID = '0123abcd-0123-4567-89ab-0123456789ab';

function ws2x2(): Workspace {
  const panes: Pane[] = [
    { id: 't-shell1', col: 0, row: 0, colSpan: 1, rowSpan: 1, parked: false, kind: 'shell', icon: 'terminal', title: 'PowerShell', ref: 'pwsh',
      spec: { program: 'pwsh.exe', args: ['-NoLogo'], cwd: 'C:\\Users\\me' } },
    { id: 't-ssh1', col: 1, row: 0, colSpan: 1, rowSpan: 1, parked: false, kind: 'ssh', icon: 'server', title: 'web', ref: 'h-web',
      spec: { program: 'ssh', args: ['me@web'], env: { ORCHESTRA_ASKPASS_KEY: 'orchestra:h-web:password' } } },
    { id: 't-claude1', col: 0, row: 1, colSpan: 2, rowSpan: 1, parked: false, kind: 'agent', icon: 'bot', title: 'Claude · Main', ref: 'acc-main',
      spec: { program: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', `& claude --resume ${SID} --settings 'C:\\s.json'`], cwd: 'E:\\proj',
        env: { CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-w', ORCHESTRA_ACCOUNT: 'acc-main', ANTHROPIC_API_KEY: 'sk-secreto', MY_TOKEN: 'x' } },
      lastSession: { id: SID, dir: 'C:\\Users\\me\\.claude-w' } },
  ];
  return { id: 'ws-live', name: 'Trabajo', cols: [0.6, 0.4], rows: [0.5, 0.5], panes, focusId: 't-shell1', statusBarItems: ['cpu'] as Workspace['statusBarItems'] };
}

test('toSaved: sin ids vivos, sin sesión de Claude, sin secretos; carpeta viva', () => {
  const ws = ws2x2();
  const before = JSON.stringify(ws);
  const sw = toSaved(ws, { name: '  Mi espacio ', now: 1000, liveCwd: { 't-shell1': 'D:\\otra', 't-ssh1': '/home/me' } });
  assert.equal(JSON.stringify(ws), before, 'no muta la pestaña');
  assert.equal(sw.name, 'Mi espacio');
  assert.match(sw.id, /^sw-/);
  assert.deepEqual(sw.cols, [0.6, 0.4]);
  assert.equal(sw.panes.length, 3);
  const json = JSON.stringify(sw);
  for (const live of ['t-shell1', 't-ssh1', 't-claude1', 'ws-live']) assert.ok(!json.includes(live), `no guarda ${live}`);
  assert.ok(!json.includes(SID), 'ni la sesión de Claude');
  assert.ok(!json.includes('sk-secreto') && !json.includes('MY_TOKEN') && !json.includes('ASKPASS'), 'ni secretos');
  assert.ok(!('lastSession' in sw.panes[2]));
  assert.equal(sw.panes[0].spec.cwd, 'D:\\otra', 'la carpeta actual manda');
  assert.equal(sw.panes[1].spec.cwd, undefined, 'SSH: la carpeta remota no es una carpeta local');
  assert.equal(sw.panes[1].ref, 'h-web');
  assert.equal(sw.panes[2].spec.env?.CLAUDE_CONFIG_DIR, 'C:\\Users\\me\\.claude-w');
  assert.ok(!sw.panes[2].spec.args.at(-1)?.includes('--resume'));
  assert.deepEqual(sw.statusBarItems, ['cpu']);
});

test('freshAgentSpec quita --resume y --continue', () => {
  const a = freshAgentSpec({ program: 'powershell.exe', args: ['-Command', `& claude --resume ${SID} --settings x`] });
  assert.equal(a.args[1], '& claude --settings x');
  const b = freshAgentSpec({ program: 'powershell.exe', args: ['-Command', '& claude --continue --settings x'] });
  assert.equal(b.args[1], '& claude --settings x');
});

test('fromSaved: ids nuevos cada vez y misma disposición', () => {
  const sw = toSaved(ws2x2(), { name: 'X' });
  const a = fromSaved(sw);
  const b = fromSaved(sw, 'Otro');
  assert.notEqual(a.id, b.id);
  assert.equal(b.name, 'Otro');
  assert.equal(a.name, 'X');
  const ids = new Set([...a.panes, ...b.panes].map((p) => p.id));
  assert.equal(ids.size, 6);
  assert.deepEqual(a.panes.map((p) => [p.col, p.row, p.colSpan, p.kind, p.title]), sw.panes.map((p) => [p.col, p.row, p.colSpan, p.kind, p.title]));
  a.panes[0].title = 'cambiado';
  assert.equal(sw.panes[0].title, 'PowerShell', 'copia profunda');
  const d = duplicateWorkspace(ws2x2(), 'Copia');
  assert.equal(d.panes.length, 3);
  assert.ok(!d.panes.some((p) => p.lastSession));
});

test('choque de nombres: pregunta, sobrescribe conservando id, renombrar y borrar', () => {
  const a = toSaved(ws2x2(), { name: 'Trabajo', now: 1 });
  let r = upsertSaved([], a);
  assert.ok(r.ok);
  const list = r.ok ? r.list : [];
  const b = toSaved({ ...ws2x2(), cols: [1] , panes: [] }, { name: ' trabajo ', now: 2 });
  r = upsertSaved(list, b);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'conflict');
  r = upsertSaved(list, b, true);
  assert.ok(r.ok && r.replaced);
  const l2 = r.ok ? r.list : [];
  assert.equal(l2.length, 1);
  assert.equal(l2[0].id, a.id);
  assert.deepEqual(l2[0].cols, [1]);
  assert.equal(upsertSaved(l2, toSaved(ws2x2(), { name: 'x' }), false).ok, true);
  assert.equal((upsertSaved(l2, { ...a, name: '   ' }) as { reason: string }).reason, 'empty');
  const l3 = (upsertSaved(l2, toSaved(ws2x2(), { name: 'Casa' })) as { list: SavedWorkspace[] }).list;
  assert.equal((renameSaved(l3, l3[1].id, 'TRABAJO') as { reason: string }).reason, 'conflict');
  assert.equal((renameSaved(l3, l3[1].id, '') as { reason: string }).reason, 'empty');
  const rn = renameSaved(l3, l3[1].id, 'Hogar');
  assert.ok(rn.ok && rn.list[1].name === 'Hogar');
  const ow = overwriteSaved(l3, l3[0].id, toSaved(ws2x2(), { name: 'ignorado', now: 9 }));
  assert.equal(ow[0].name, 'Trabajo');
  assert.equal(ow[0].savedAt, 9);
  assert.equal(deleteSaved(l3, l3[0].id).length, 1);
  assert.ok(findByName(l3, 'CASA'));
  assert.equal(uniqueName('Casa', ['casa', 'Casa 2']), 'Casa 3');
});

test('tope de guardados', () => {
  let list: SavedWorkspace[] = [];
  for (let i = 0; i < SAVED_LIMITS.count; i++) list.push(toSaved(ws2x2(), { name: `n${i}` }));
  const r = upsertSaved(list, toSaved(ws2x2(), { name: 'uno más' }));
  assert.equal(!r.ok && r.reason, 'full');
  list = [];
});

test('buscar por nombre y por títulos de panel, recientes primero', () => {
  const l = [toSaved(ws2x2(), { name: 'Alfa', now: 1 }), toSaved({ ...ws2x2(), panes: [] }, { name: 'Beta', now: 5 })];
  assert.deepEqual(filterSaved(l, '').map((s) => s.name), ['Beta', 'Alfa']);
  assert.deepEqual(filterSaved(l, 'web').map((s) => s.name), ['Alfa']);
  assert.deepEqual(filterSaved(l, 'BET').map((s) => s.name), ['Beta']);
});

test('migración: estados antiguos y entradas rotas', () => {
  assert.deepEqual(normalizeSaved(undefined), []);
  assert.deepEqual(normalizeSaved({ a: 1 }), []);
  const good = toSaved(ws2x2(), { name: 'Bueno' });
  const raw = JSON.parse(JSON.stringify([
    good, { ...good }, // mismo id y nombre: se rehace el id y se numera el nombre
    { name: '', cols: [1], rows: [1], panes: [] },
    { name: 'sin rejilla', cols: 'x', rows: [1], panes: [] },
    { name: 'Panel roto', cols: [1], rows: [1], panes: [{ kind: 'nope', spec: { program: 'x', args: [] } }, { kind: 'agent', spec: { program: 'p', args: [`& claude --resume ${SID}`], env: { SECRET_X: 'a', OK: 'b' } }, col: 9 }] },
    null, 5,
  ]));
  const out = normalizeSaved(raw);
  assert.deepEqual(out.map((s) => s.name), ['Bueno', 'Bueno 2', 'Panel roto']);
  assert.notEqual(out[0].id, out[1].id);
  assert.equal(out[2].panes.length, 1);
  assert.equal(out[2].panes[0].col, 0);
  assert.deepEqual(out[2].panes[0].spec.env, { OK: 'b' });
  assert.ok(!out[2].panes[0].spec.args[0].includes('--resume'));
  // el ssh no conserva entorno aunque venga en el archivo
  assert.equal(normalizeSaved([{ name: 's', cols: [1], rows: [1], panes: [{ kind: 'ssh', spec: { program: 'ssh', args: [], env: { A: '1' } } }] }])[0].panes[0].spec.env, undefined);
});

function state(saved?: SavedWorkspace[]): BackupState {
  const ws = ws2x2();
  return { settings: { ...DEFAULTS }, hosts: [], accounts: [], customThemes: [], workspaces: [ws], activeId: ws.id, ignoredDirs: [], ...(saved ? { savedWorkspaces: saved } : {}) };
}

test('ida y vuelta por la copia de seguridad', () => {
  const saved = [toSaved(ws2x2(), { name: 'Guardado', now: 7 })];
  const file = serializeBackup(buildBackup(state(saved), { appVersion: 't' }));
  const part = JSON.stringify(JSON.parse(file).savedWorkspaces);
  assert.ok(!part.includes('sk-secreto') && !part.includes(SID));
  const p = parseBackup(file);
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(p.summary.saved, 1);
  assert.deepEqual(p.sections.savedWorkspaces, saved);
  // sustituir: entran los del archivo
  const rep = replaceFromBackup(state([]), p.sections, ALL_PICKS);
  assert.deepEqual(rep.state.savedWorkspaces, saved);
  assert.equal(rep.report.savedAdded, 1);
  // mezclar: el mismo se salta; otro con el mismo nombre y distinto contenido entra numerado
  const same = mergeBackup(state(saved), p.sections, ALL_PICKS);
  assert.equal(same.report.savedAdded, 0);
  assert.equal(same.report.savedSkipped, 1);
  const other = [{ ...toSaved({ ...ws2x2(), panes: [] }, { name: 'Guardado' }) }];
  const mixed = mergeBackup(state(other), p.sections, ALL_PICKS);
  assert.deepEqual(mixed.state.savedWorkspaces?.map((s) => s.name), ['Guardado', 'Guardado 2']);
  // sin casilla de espacios: no se tocan
  const none = replaceFromBackup(state(other), p.sections, { ...ALL_PICKS, workspaces: false });
  assert.deepEqual(none.state.savedWorkspaces, other);
  // copia antigua sin la clave: al sustituir, los actuales se quedan
  const old = JSON.parse(file);
  delete old.savedWorkspaces;
  const po = parseBackup(JSON.stringify(old));
  assert.ok(po.ok && po.sections.savedWorkspaces === undefined);
  if (po.ok) assert.deepEqual(replaceFromBackup(state(other), po.sections, ALL_PICKS).state.savedWorkspaces, other);
  void mergeSaved;
});
