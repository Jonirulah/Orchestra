import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOSTS_SORTS, addFolder, buildHostView, canStepHost, cleanFolderList, compareNames, deleteFolder, folderOf, folderOrder,
  freeFolderName, freezeOrder, moveFolder, moveHost, renameFolder, sortHosts, stepFolder, stepHost, toggleCollapsed,
} from './hostview.ts';
import { DEFAULTS, clampSettings } from './settings.ts';
import { normalizeHost } from './model.ts';
import type { Host } from './model.ts';
import { buildBackup, parseBackup } from './backup.ts';

const mk = (id: string, name: string, group?: string): Host => ({ id, name, host: `${id}.lan`, tags: [], authMethod: 'agent', agentAccess: 'none', ...(group ? { group } : {}) });
const ids = (l: readonly Host[]) => l.map((h) => h.id);
/** Vista resumida: «carpeta: ids». */
const view = (hosts: Host[], o: Partial<Parameters<typeof buildHostView>[1]> = {}) =>
  buildHostView(hosts, { sort: 'manual', folders: [], collapsed: [], ...o }).map((f) => `${f.name || '-'}:${ids(f.hosts).join(',')}`);

// Orden guardado deliberadamente desordenado.
const H = (): Host[] => [
  mk('z', 'zeta', 'Prod'),
  mk('a', 'Álamo', 'Prod'),
  mk('n', 'nube'),
  mk('b', 'beta', 'Dev'),
  mk('w10', 'web10', 'Prod'),
  mk('w2', 'web2', 'Prod'),
  mk('c', 'casa'),
];

test('datos antiguos sin orden: carpetas A-Z, «sin carpeta» al final, hosts en el orden guardado (lo de siempre)', () => {
  assert.deepEqual(view(H()), ['Dev:b', 'Prod:z,a,w10,w2', '-:n,c']);
});

test('orden por nombre: sin distinguir mayúsculas ni acentos y con números naturales; carpetas también A-Z', () => {
  assert.deepEqual(view(H(), { sort: 'name', folders: ['Prod', 'Dev'] }), ['Dev:b', 'Prod:a,w2,w10,z', '-:c,n']);
  assert.equal(compareNames('álamo', 'Alamo'), 0);
  assert.ok(compareNames('web2', 'web10') < 0);
  assert.deepEqual(HOSTS_SORTS, ['manual', 'name']);
});

test('sortHosts no muta y es estable en empates', () => {
  const l = [mk('1', 'x'), mk('2', 'X'), mk('3', 'a')];
  const before = ids(l);
  assert.deepEqual(ids(sortHosts(l, 'name')), ['3', '1', '2']);
  assert.deepEqual(ids(l), before);
  assert.deepEqual(ids(sortHosts(l, 'manual')), before);
});

test('orden guardado de carpetas manda; las que falten van detrás A-Z; las vacías de la lista se ven', () => {
  const h = H();
  assert.deepEqual(folderOrder(h, ['Prod', 'Vacía']), ['Prod', 'Vacía', 'Dev']);
  assert.deepEqual(view(h, { folders: ['Prod', 'Vacía'] }), ['Prod:z,a,w10,w2', 'Vacía:', 'Dev:b', '-:n,c']);
});

test('filtro de texto: solo carpetas con resultados y desplegadas', () => {
  const v = buildHostView(H(), { sort: 'manual', folders: [], collapsed: ['Prod'], text: 'web' });
  assert.deepEqual(v.map((f) => [f.name, ids(f.hosts), f.total, f.collapsed]), [['Prod', ['w10', 'w2'], 4, false]]);
  assert.deepEqual(view(H(), { text: 'zzz' }), []);
  // sin texto, la plegada se marca (sus hosts siguen en la vista para el contador)
  const p = buildHostView(H(), { sort: 'manual', folders: [], collapsed: ['Prod'] }).find((f) => f.name === 'Prod')!;
  assert.equal(p.collapsed, true);
  assert.equal(p.total, 4);
});

test('«sin carpeta» solo aparece si tiene hosts', () => {
  assert.deepEqual(view([mk('x', 'x', 'A')]), ['A:x']);
});

test('mover un host dentro de su carpeta (antes de otro y al final)', () => {
  const h = H();
  const r = moveHost(h, 'w2', 'Prod', 'z');
  assert.deepEqual(view(r), ['Dev:b', 'Prod:w2,z,a,w10', '-:n,c']);
  assert.deepEqual(view(moveHost(h, 'z', 'Prod', null)), ['Dev:b', 'Prod:a,w10,w2,z', '-:n,c']);
  assert.deepEqual(ids(h), ['z', 'a', 'n', 'b', 'w10', 'w2', 'c'], 'no muta');
});

test('mover un host a otra carpeta cambia su group; a «sin carpeta» lo quita', () => {
  const r = moveHost(H(), 'a', 'Dev', 'b');
  assert.equal(r.find((x) => x.id === 'a')!.group, 'Dev');
  assert.deepEqual(view(r), ['Dev:a,b', 'Prod:z,w10,w2', '-:n,c']);
  const u = moveHost(H(), 'b', '', 'c');
  assert.equal('group' in u.find((x) => x.id === 'b')!, false);
  assert.deepEqual(view(u, { folders: ['Dev'] }), ['Dev:', 'Prod:z,a,w10,w2', '-:n,b,c']);
  // a una carpeta vacía
  assert.deepEqual(view(moveHost(H(), 'n', 'Vacía', null), { folders: ['Vacía'] }), ['Vacía:n', 'Dev:b', 'Prod:z,a,w10,w2', '-:c']);
  // id desconocido: copia igual
  assert.deepEqual(ids(moveHost(H(), 'nope', 'Dev', null)), ids(H()));
});

test('Alt+↑/↓: un puesto; en el borde salta a la carpeta vecina', () => {
  const h = H();
  assert.deepEqual(view(stepHost(h, [], 'a', -1)), ['Dev:b', 'Prod:a,z,w10,w2', '-:n,c']);
  assert.deepEqual(view(stepHost(h, [], 'a', 1)), ['Dev:b', 'Prod:z,w10,a,w2', '-:n,c']);
  // primero de Prod sube: al final de Dev
  assert.deepEqual(view(stepHost(h, [], 'z', -1)), ['Dev:b,z', 'Prod:a,w10,w2', '-:n,c']);
  // último de Prod baja: al principio de «sin carpeta»
  assert.deepEqual(view(stepHost(h, [], 'w2', 1)), ['Dev:b', 'Prod:z,a,w10', '-:w2,n,c']);
  // extremos: sin cambios
  assert.equal(canStepHost(h, [], 'b', -1), false);
  assert.equal(canStepHost(h, [], 'c', 1), false);
  assert.equal(canStepHost(h, [], 'b', 1), true);
});

test('mover y subir/bajar carpetas', () => {
  const h = H();
  assert.deepEqual(moveFolder(h, [], 'Prod', 'Dev'), ['Prod', 'Dev']);
  assert.deepEqual(moveFolder(h, ['Prod', 'Dev', 'X'], 'Prod', null), ['Dev', 'X', 'Prod']);
  assert.deepEqual(stepFolder(h, [], 'Dev', 1), ['Prod', 'Dev']);
  assert.deepEqual(stepFolder(h, [], 'Dev', -1), ['Dev', 'Prod']);
  assert.deepEqual(moveFolder(h, [], 'nope', 'Dev'), ['Dev', 'Prod']);
});

test('congelar el A-Z como manual: lo visible no cambia al pasar a Manual', () => {
  const h = H();
  const f = freezeOrder(h, ['Prod', 'Dev'], 'name');
  assert.deepEqual(f.folders, ['Dev', 'Prod']);
  assert.deepEqual(view(f.hosts, { folders: f.folders }), view(h, { sort: 'name', folders: ['Prod', 'Dev'] }));
});

test('renombrar carpeta: los hosts la siguen; si ya existe, se juntan', () => {
  const r = renameFolder(H(), ['Prod', 'Dev'], ['Prod'], 'Prod', 'Producción');
  assert.deepEqual(r.folders, ['Producción', 'Dev']);
  assert.deepEqual(r.collapsed, ['Producción']);
  assert.equal(r.hosts.filter((x) => x.group === 'Producción').length, 4);
  const m = renameFolder(H(), ['Prod', 'Dev'], ['Dev'], 'Dev', 'Prod');
  assert.deepEqual(m.folders, ['Prod']);
  assert.deepEqual(m.collapsed, []);
  assert.deepEqual(view(m.hosts, { folders: m.folders }), ['Prod:z,a,b,w10,w2', '-:n,c']);
  const same = renameFolder(H(), [], [], 'Dev', '  ');
  assert.deepEqual(same.folders, ['Dev', 'Prod']);
});

test('borrar carpeta: sus hosts pasan a «sin carpeta» sin perder ninguno ni su orden', () => {
  const d = deleteFolder(H(), ['Prod', 'Dev'], ['Prod'], 'Prod');
  assert.equal(d.hosts.length, 7);
  assert.deepEqual(d.folders, ['Dev']);
  assert.deepEqual(d.collapsed, []);
  assert.deepEqual(view(d.hosts, { folders: d.folders }), ['Dev:b', '-:z,a,n,w10,w2,c']);
});

test('nueva carpeta: nombre libre y al final', () => {
  const h = H();
  assert.equal(freeFolderName(h, [], 'New folder'), 'New folder');
  const f = addFolder(h, [], 'New folder');
  assert.deepEqual(f, ['Dev', 'Prod', 'New folder']);
  assert.equal(freeFolderName(h, f, 'new FOLDER'), 'new FOLDER 2');
  assert.deepEqual(addFolder(h, f, 'Dev'), f, 'repetida: sin cambios');
});

test('plegar / desplegar', () => {
  assert.deepEqual(toggleCollapsed([], 'A'), ['A']);
  assert.deepEqual(toggleCollapsed(['A', 'B'], 'A'), ['B']);
});

test('folderOf recorta y trata vacío como «sin carpeta»', () => {
  assert.equal(folderOf({ group: '  ' }), '');
  assert.equal(folderOf({ group: ' Prod ' }), 'Prod');
  assert.equal(folderOf({}), '');
});

test('ajustes: valores por defecto, limpieza y datos antiguos sin los campos', () => {
  assert.equal(DEFAULTS.hostsSort, 'manual');
  const old = clampSettings({ fontSize: 14 });
  assert.deepEqual([old.hostsSort, old.hostFolders, old.hostFoldersCollapsed], ['manual', [], []]);
  const s = clampSettings({ hostsSort: 'name', hostFolders: [' Prod ', 'Prod', '', 3, 'Dev'], hostFoldersCollapsed: 'x' });
  assert.deepEqual([s.hostsSort, s.hostFolders, s.hostFoldersCollapsed], ['name', ['Prod', 'Dev'], []]);
  assert.equal(clampSettings({ hostsSort: 'lastUsed' }).hostsSort, 'manual');
  assert.equal(cleanFolderList(Array.from({ length: 500 }, (_, i) => `f${i}`)).length, 200);
});

test('migración: hosts guardados sin orden conservan su orden al cargar', () => {
  const raw = [{ id: 'h2', name: 'b', host: 'b' }, { id: 'h1', name: 'a', host: 'a', group: 'G' }, { id: 'h3', name: 'c', host: 'c' }];
  const hosts = raw.map((r) => normalizeHost(r as Host));
  assert.deepEqual(view(hosts), ['G:h1', '-:h2,h3']);
});

test('copia total: conserva el orden de los hosts, su carpeta y el orden/plegado de carpetas', () => {
  const h = moveHost(H(), 'w2', 'Dev', null);
  const settings = clampSettings({ hostsSort: 'manual', hostFolders: ['Prod', 'Dev'], hostFoldersCollapsed: ['Dev'] });
  const file = buildBackup({ settings, hosts: h, accounts: [], customThemes: [], workspaces: [], activeId: '', ignoredDirs: [] }, { appVersion: 't' });
  const back = parseBackup(JSON.stringify(file));
  assert.ok(back.ok);
  if (!back.ok) return;
  assert.deepEqual(ids(back.sections.hosts), ids(h));
  assert.equal(back.sections.hosts.find((x) => x.id === 'w2')!.group, 'Dev');
  assert.deepEqual(back.sections.settings!.hostFolders, ['Prod', 'Dev']);
  assert.deepEqual(back.sections.settings!.hostFoldersCollapsed, ['Dev']);
});
