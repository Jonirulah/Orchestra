import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_PICKS, BACKUP_LIMITS, MAX_BACKUP_BYTES, anyPicked, backupFileName, buildBackup, mergeBackup, parseBackup, replaceFromBackup,
  sanitizeSpec, serializeBackup,
} from './backup.ts';
import type { BackupFile, BackupPicks, BackupSections, BackupState } from './backup.ts';
import { DEFAULTS } from './settings.ts';
import { baseDef } from './themes.ts';
import type { ThemeDef } from './themes.ts';
import type { Account, Host, Pane, Workspace } from './model.ts';
import { MAX_CUSTOM_THEMES } from './themes.ts';

// ---------- fixtures ----------

const theme = (id: string, name: string, bg = '#101010'): ThemeDef => ({ ...baseDef(), id, name, background: bg, custom: true });

const host = (id: string, h: string, extra: Partial<Host> = {}): Host => ({ id, name: h, tags: [], host: h, authMethod: 'agent', agentAccess: 'none', ...extra });

const pane = (id: string, extra: Partial<Pane> = {}): Pane => ({
  id, col: 0, row: 0, colSpan: 1, rowSpan: 1, parked: false, kind: 'shell', icon: 'terminal', title: 'PowerShell', ref: 'pwsh',
  spec: { program: 'pwsh.exe', args: ['-NoLogo'], cwd: 'C:\\Users\\me' }, ...extra,
});

const ws = (id: string, name: string, panes: Pane[] = [pane(`${id}-p1`)]): Workspace => ({ id, name, cols: [0.5, 0.5], rows: [1], panes });

function stateA(): BackupState {
  return {
    settings: { ...DEFAULTS, fontSize: 17, theme: 'custom:night', usageQuery: true },
    hosts: [
      host('h-1', 'srv1.example.com', { user: 'root', port: 2222, authMethod: 'password', hasPassword: true, command: 'cd /srv && bash -l', notes: 'prod\nbox', tags: ['prod'] }),
      host('h-2', 'srv2.example.com', { authMethod: 'key', identityFile: 'C:\\k\\id_ed25519', hasPassphrase: true, proxyJump: 'jump.example.com' }),
    ],
    accounts: [
      { id: 'acc-1', name: 'Main', dir: 'C:\\Users\\me\\.claude', isDefault: true, color: '#f5b942', provider: 'claude' },
      { id: 'acc-2', name: 'Work', dir: 'C:\\Users\\me\\.claude-work', isDefault: false, color: '#6cb2ff', provider: 'claude' },
    ],
    customThemes: [theme('custom:night', 'Night', '#0a0a1a')],
    workspaces: [
      ws('ws-1', 'Main', [
        pane('t-1'),
        pane('t-2', { col: 1, kind: 'ssh', ref: 'h-1', title: 'srv1', spec: { program: 'ssh', args: ['-p', '2222', 'root@srv1.example.com'], env: { ORCHESTRA_ASKPASS_KEY: 'host:h-1:password' } } }),
        pane('t-3', { kind: 'agent', ref: 'acc-2', spec: { program: 'powershell.exe', args: ['-NoLogo', '-Command', '& claude'], env: { ORCHESTRA_ACCOUNT: 'acc-2', CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-work' } }, lastSession: { id: '11111111-1111-1111-1111-111111111111', dir: 'C:\\Users\\me\\.claude-work' } }),
      ]),
      ws('ws-2', 'Logs'),
    ],
    activeId: 'ws-2',
    ignoredDirs: ['C:\\Users\\me\\.claude-old'],
  };
}
const NOW = new Date('2026-11-06T12:00:00Z');
const make = (s: BackupState = stateA()): BackupFile => buildBackup(s, { appVersion: '0.1.0', now: NOW });
const text = (s: BackupState = stateA()): string => serializeBackup(make(s));
function sectionsOf(s: BackupState): BackupSections {
  const r = parseBackup(text(s));
  assert.ok(r.ok);
  return r.sections;
}
const none: BackupPicks = { settings: false, hosts: false, accounts: false, themes: false, workspaces: false };
const only = (...k: (keyof BackupPicks)[]): BackupPicks => ({ ...none, ...Object.fromEntries(k.map((x) => [x, true])) });
/** Estado vacío «de otro equipo». */
const blank = (): BackupState => ({ settings: { ...DEFAULTS }, hosts: [], accounts: [], customThemes: [], workspaces: [ws('ws-local', 'Local', [pane('t-local')])], activeId: 'ws-local', ignoredDirs: [] });
const fileWith = (patch: Record<string, unknown>): string => JSON.stringify({ ...make(), ...patch });

// ---------- exportar ----------

test('round trip: lo exportado se lee igual (menos secretos y estado vivo)', () => {
  const r = parseBackup(text());
  assert.ok(r.ok);
  const s = stateA();
  assert.deepEqual(r.summary, {
    hosts: 2, accounts: 2, themes: 1, workspaces: 2, panes: 4, saved: 0, hasSettings: true, droppedPanes: 0, droppedHosts: 0, hostsWithCommand: 2,
    appVersion: '0.1.0', exportedAt: '2026-11-06T12:00:00.000Z',
  });
  const expHosts = s.hosts.map((h) => { const { hasPassword: _a, hasPassphrase: _b, ...rest } = h; return rest; });
  assert.deepEqual(r.sections.hosts, expHosts);
  assert.deepEqual(r.sections.accounts, s.accounts);
  assert.deepEqual(r.sections.customThemes, s.customThemes);
  assert.deepEqual(r.sections.ignoredDirs, s.ignoredDirs);
  assert.equal(r.sections.activeId, 'ws-2');
  assert.equal(r.sections.settings?.fontSize, 17);
  assert.equal(r.sections.settings?.theme, 'custom:night');
  assert.equal(r.sections.settings?.usageQuery, false);
  // paneles: todo menos lastSession y la clave de la bóveda
  const p3 = r.sections.workspaces[0].panes[2];
  assert.equal(p3.lastSession, undefined);
  assert.deepEqual(p3.spec.env, { ORCHESTRA_ACCOUNT: 'acc-2', CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-work' });
  assert.deepEqual(r.sections.workspaces[0].panes[1].spec, { program: 'ssh', args: ['-p', '2222', 'root@srv1.example.com'] });
  assert.deepEqual(r.sections.workspaces[0].panes[0], pane('t-1'));
});

test('el archivo lleva la cabecera y el nombre es orchestra-backup-AAAA-MM-DD.json', () => {
  const b = make();
  assert.equal(b.app, 'orchestra-backup');
  assert.equal(b.format, 1);
  assert.equal(b.appVersion, '0.1.0');
  assert.equal(b.exportedAt, '2026-11-06T12:00:00.000Z');
  assert.equal(backupFileName(NOW), 'orchestra-backup-2026-11-06.json');
});

function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); allKeys(x, out); }
  return out;
}

test('ninguna parte del archivo contiene secretos, usageQuery ni credenciales', () => {
  const s = stateA();
  // Trampas: un secreto metido donde no debe, en claves y valores.
  (s.hosts[0] as unknown as Record<string, unknown>).password = 'hunter2';
  (s.hosts[0] as unknown as Record<string, unknown>).apiToken = 'sk-ant-oat01-SECRET';
  (s.accounts[0] as unknown as Record<string, unknown>).oauthToken = 'sk-ant-oat01-SECRET2';
  (s.workspaces[0].panes[0] as unknown as Record<string, unknown>).secret = 'x';
  const json = text(s);
  const keys = allKeys(JSON.parse(json));
  for (const bad of ['password', 'passphrase', 'token', 'secret', 'credential', 'usageQuery', 'hasPassword', 'hasPassphrase', 'lastSession']) {
    assert.ok(!keys.some((k) => (bad === 'usageQuery' ? k === bad : k.toLowerCase().includes(bad.toLowerCase()))), `clave «${bad}» en el archivo`);
  }
  for (const bad of ['hunter2', 'sk-ant', 'host:h-1:password', 'ORCHESTRA_ASKPASS_KEY', 'credentials']) {
    assert.ok(!json.includes(bad), `«${bad}» en el archivo`);
  }
});

test('buildBackup no muta el estado', () => {
  const s = stateA();
  const before = JSON.stringify(s);
  make(s);
  assert.equal(JSON.stringify(s), before);
  assert.equal(s.settings.usageQuery, true);
});

// ---------- leer: errores ----------

const errOf = (input: string): string => { const r = parseBackup(input); assert.ok(!r.ok, 'debía fallar'); return r.error; };

test('parseBackup rechaza lo que no es una copia, con un mensaje claro', () => {
  assert.match(errOf(''), /nothing to read/i);
  assert.match(errOf('   '), /nothing to read/i);
  assert.match(errOf('{not json'), /not valid JSON/i);
  assert.match(errOf('[]'), /not an Orchestra backup/i);
  assert.match(errOf('"hola"'), /not an Orchestra backup/i);
  assert.match(errOf(fileWith({ app: 'otra-cosa' })), /not an Orchestra backup/i);
  assert.match(errOf(JSON.stringify({ fontSize: 14, theme: 'dracula' })), /not an Orchestra backup/i); // un JSON de ajustes suelto
  assert.match(errOf(fileWith({ format: undefined })), /format number/i);
  assert.match(errOf(fileWith({ format: '1' })), /format number/i);
  assert.match(errOf(fileWith({ format: 0 })), /format number/i);
  assert.match(errOf(fileWith({ format: 1.5 })), /format number/i);
});

test('parseBackup rechaza un formato futuro y dice cuál', () => {
  assert.match(errOf(fileWith({ format: 2 })), /format 2.*newer/i);
  assert.match(errOf(fileWith({ format: 99 })), /format 99/);
  assert.ok(parseBackup(fileWith({ format: 1 })).ok);
});

test('parseBackup rechaza un archivo de más de 5 MB antes de interpretarlo', () => {
  const pad = ' '.repeat(MAX_BACKUP_BYTES + 1);
  assert.match(errOf(`${text()}${pad}`), /too big/i);
  assert.match(errOf(JSON.stringify({ app: 'orchestra-backup', format: 1, notes: 'é'.repeat(MAX_BACKUP_BYTES / 2 + 10) })), /too big/i); // bytes, no caracteres
  assert.ok(parseBackup(text()).ok);
});

test('parseBackup rechaza listas absurdas y copias sin nada importable', () => {
  assert.match(errOf(fileWith({ hosts: Array.from({ length: BACKUP_LIMITS.hosts + 1 }, (_, i) => host(`h${i}`, `h${i}.example.com`)) })), /Too many.*hosts/i);
  assert.match(errOf(fileWith({ workspaces: Array.from({ length: BACKUP_LIMITS.workspaces + 1 }, (_, i) => ws(`w${i}`, `W${i}`)) })), /Too many.*workspaces/i);
  assert.match(errOf(fileWith({ workspaces: [ws('w', 'W', Array.from({ length: BACKUP_LIMITS.panesPerWorkspace + 1 }, (_, i) => pane(`p${i}`)))] })), /Too many.*panes/i);
  assert.match(errOf(JSON.stringify({ app: 'orchestra-backup', format: 1 })), /anything Orchestra can import/i);
  assert.match(errOf(fileWith({ settings: {}, hosts: [], accounts: [], customThemes: [], workspaces: [] })), /anything Orchestra can import/i);
});

// ---------- leer: datos hostiles y antiguos ----------

test('un panel con especificación hostil se descarta; los buenos pasan', () => {
  const bad: unknown[] = [
    { ...pane('b1'), spec: { program: 'cmd.exe', args: ['/c', 42] } },                              // argumento no string
    { ...pane('b2'), spec: { program: 'cmd.exe', args: 'calc' } },                                   // args no es lista
    { ...pane('b3'), spec: { program: '', args: [] } },                                              // sin programa
    { ...pane('b4'), spec: { program: 'x'.repeat(BACKUP_LIMITS.program + 1), args: [] } },           // programa gigante
    { ...pane('b5'), spec: { program: 'a', args: Array(BACKUP_LIMITS.args + 1).fill('x') } },        // demasiados args
    { ...pane('b6'), spec: { program: 'a', args: ['y'.repeat(BACKUP_LIMITS.arg + 1)] } },            // arg gigante
    { ...pane('b7'), spec: { program: 'a', args: [], env: Object.fromEntries(Array.from({ length: BACKUP_LIMITS.envVars + 1 }, (_, i) => [`V${i}`, '1'])) } }, // env enorme
    { ...pane('b8'), spec: { program: 'a', args: [], env: { A: { nested: 1 } } } },                  // valor de env no string
    { ...pane('b9'), spec: { program: 'a', args: [], env: { 'BAD KEY': '1' } } },                    // nombre de variable raro
    { ...pane('b10'), spec: { program: 'a', args: [], env: { A: 'z'.repeat(BACKUP_LIMITS.envValue + 1) } } },
    { ...pane('b11'), spec: { program: 'a', args: [], cwd: 5 } },                                    // cwd no string
    { ...pane('b12'), spec: 'powershell -enc AAAA' },                                                // spec no es objeto
    { ...pane('b13'), spec: null },
    { ...pane('b14'), kind: 'rm -rf' },                                                              // tipo desconocido
    'cadena suelta', null, 7,
  ];
  const good = pane('ok-1');
  const r = parseBackup(fileWith({ workspaces: [{ ...ws('w', 'W'), panes: [...bad, good] }] }));
  assert.ok(r.ok);
  assert.equal(r.summary.droppedPanes, 17); // 14 paneles inválidos + 3 entradas que ni son objetos
  assert.deepEqual(r.sections.workspaces[0].panes.map((p) => p.id), ['ok-1']);
});

test('la clave de la bóveda nunca entra desde un archivo, y las claves desconocidas del panel se tiran', () => {
  const evil = { ...pane('e1'), evil: 'x', __proto__: { polluted: true }, spec: { program: 'ssh', args: ['evil.example.com'], env: { ORCHESTRA_ASKPASS_KEY: 'host:h-1:password', FOO: 'bar' }, extra: 1 } };
  const r = parseBackup(fileWith({ workspaces: [{ ...ws('w', 'W'), panes: [JSON.parse(JSON.stringify(evil))] }] }));
  assert.ok(r.ok);
  const p = r.sections.workspaces[0].panes[0];
  assert.deepEqual(p.spec, { program: 'ssh', args: ['evil.example.com'], env: { FOO: 'bar' } });
  assert.deepEqual(Object.keys(p).sort(), ['col', 'colSpan', 'icon', 'id', 'kind', 'parked', 'ref', 'row', 'rowSpan', 'spec', 'title']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('sanitizeSpec: casos sueltos', () => {
  assert.deepEqual(sanitizeSpec({ program: 'pwsh', args: [] }), { program: 'pwsh', args: [] });
  assert.deepEqual(sanitizeSpec({ program: 'pwsh', args: ['a'], cwd: '' }), { program: 'pwsh', args: ['a'] });
  assert.equal(sanitizeSpec({ program: 'pwsh', args: ['a\u0000b'] }), null);
  assert.equal(sanitizeSpec({ program: 'pwsh' }), null);
  assert.equal(sanitizeSpec(undefined), null);
});

test('la geometría del panel se acota a la cuadrícula; ids raros o repetidos se rehacen', () => {
  const w = { id: 'w 1;rm', name: 'N', cols: [2, 2], rows: [1], panes: [
    pane('dup', { col: 99, row: -4, colSpan: 50, rowSpan: 0 }), pane('dup'), pane('id with spaces'),
  ] };
  const r = parseBackup(fileWith({ workspaces: [w], activeId: 'w 1;rm' }));
  assert.ok(r.ok);
  const out = r.sections.workspaces[0];
  assert.notEqual(out.id, 'w 1;rm');
  assert.equal(r.sections.activeId, undefined); // el id raro se rehízo: ya no apunta a nada
  assert.deepEqual(out.cols, [0.5, 0.5]);
  assert.deepEqual([out.panes[0].col, out.panes[0].row, out.panes[0].colSpan, out.panes[0].rowSpan], [1, 0, 1, 1]);
  assert.equal(new Set(out.panes.map((p) => p.id)).size, 3);
  assert.ok(out.panes.every((p) => /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(p.id)));
});

test('rejillas absurdas (0, negativas, enormes) descartan el espacio de trabajo', () => {
  const r = parseBackup(fileWith({ workspaces: [{ ...ws('a', 'A'), cols: [] }, { ...ws('b', 'B'), rows: [-1] }, { ...ws('c', 'C'), cols: Array(20).fill(1) }, ws('d', 'D')] }));
  assert.ok(r.ok);
  assert.deepEqual(r.sections.workspaces.map((x) => x.id), ['d']);
});

test('hosts hostiles: destino que parece opción de ssh, usuario con @, datos de más', () => {
  const r = parseBackup(fileWith({ hosts: [
    host('h1', '-oProxyCommand=calc'), host('h2', 'ok.example.com', { user: '-oProxyCommand=x' }), host('h3', 'ok2.example.com', { user: 'a@b' }),
    host('h4', 'bad host'), { id: 'h5' }, 'x',
    { ...host('h6', 'good.example.com'), proxyJump: '-oProxyCommand=calc', port: 70000, color: 'red', password: 'p', passphrase: 'q', extra: { a: 1 }, agentAccess: 'root', hasPassword: true },
  ] }));
  assert.ok(r.ok);
  assert.equal(r.summary.droppedHosts, 6);
  assert.equal(r.sections.hosts.length, 1);
  assert.deepEqual(r.sections.hosts[0], { id: 'h6', name: 'good.example.com', tags: [], host: 'good.example.com', authMethod: 'agent', agentAccess: 'none' });
});

test('hosts: ids que acabarían en la bóveda se sanean; los repetidos se rehacen', () => {
  const r = parseBackup(fileWith({ hosts: [host('a b/c', 'a.example.com'), host('same', 'b.example.com'), host('same', 'c.example.com')] }));
  assert.ok(r.ok);
  const ids = r.sections.hosts.map((h) => h.id);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every((i) => /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(i)));
});

test('archivos de versiones antiguas (faltan secciones o campos) se leen', () => {
  const old = { app: 'orchestra-backup', format: 1, hosts: [{ id: 'h1', host: 'old.example.com', name: 'old' }] };
  const r = parseBackup(JSON.stringify(old));
  assert.ok(r.ok);
  assert.equal(r.summary.hasSettings, false);
  assert.equal(r.sections.settings, null);
  assert.deepEqual(r.sections.hosts[0], { id: 'h1', name: 'old', tags: [], host: 'old.example.com', authMethod: 'agent', agentAccess: 'none' });
  assert.deepEqual([r.sections.accounts, r.sections.customThemes, r.sections.workspaces, r.sections.ignoredDirs], [[], [], [], []]);
  // Ajustes parciales: lo que falta toma su valor por defecto; basura se acota.
  const r2 = parseBackup(fileWith({ settings: { fontSize: 9999, theme: 'no-existe', bogus: 1 } }));
  assert.ok(r2.ok && r2.sections.settings);
  assert.ok(r2.sections.settings.fontSize <= 40);
  assert.equal(r2.sections.settings.theme, DEFAULTS.theme);
  assert.equal((r2.sections.settings as unknown as Record<string, unknown>).bogus, undefined);
});

test('un archivo con usageQuery encendido nunca lo trae encendido', () => {
  const r = parseBackup(fileWith({ settings: { ...DEFAULTS, usageQuery: true } }));
  assert.ok(r.ok && r.sections.settings);
  assert.equal(r.sections.settings.usageQuery, false);
});

test('importar ajustes nunca enciende usageQuery ni mcpExposeLocal (ni mezclando ni reemplazando)', () => {
  const imp = stateA();
  imp.settings = { ...imp.settings, usageQuery: true, mcpExposeLocal: true };
  for (const fn of [mergeBackup, replaceFromBackup]) {
    const cur = blank();
    cur.settings = { ...cur.settings, usageQuery: false, mcpExposeLocal: false };
    const { state } = fn(cur, sectionsOf(imp), ALL_PICKS);
    assert.equal(state.settings.usageQuery, false);
    assert.equal(state.settings.mcpExposeLocal, false);
  }
  // Y si ya estaban encendidos en este equipo, se quedan como están.
  const on = blank();
  on.settings = { ...on.settings, usageQuery: true, mcpExposeLocal: true };
  const imp2 = stateA();
  imp2.settings = { ...imp2.settings, usageQuery: false, mcpExposeLocal: false };
  const r = mergeBackup(on, sectionsOf(imp2), ALL_PICKS);
  assert.equal(r.state.settings.usageQuery, true);
  assert.equal(r.state.settings.mcpExposeLocal, true);
});

test('temas inválidos o de más se descartan sin romper la lectura', () => {
  const r = parseBackup(fileWith({ customThemes: [{ id: 'custom:x', name: 'X', background: 'no-color' }, theme('custom:ok', 'OK'), 5, null] }));
  assert.ok(r.ok);
  assert.deepEqual(r.sections.customThemes.map((d) => d.id), ['custom:ok']);
});

test('cuentas: sin carpeta se descartan; provider raro vuelve a claude', () => {
  const r = parseBackup(fileWith({ accounts: [{ id: 'a1', name: 'A', dir: '' }, { id: 'a2', name: 'B', dir: 'C:\\x\\.codex-b', provider: 'evil', token: 't', color: 'zzz' }, 7] }));
  assert.ok(r.ok);
  assert.equal(r.sections.accounts.length, 1);
  assert.deepEqual(r.sections.accounts[0], { id: 'a2', name: 'B', dir: 'C:\\x\\.codex-b', isDefault: false, color: '#f5b942', provider: 'claude' });
});

// ---------- mezclar ----------

test('mezclar la copia en un estado vacío lo añade todo, con ids intactos', () => {
  const cur = blank();
  const { state, report } = mergeBackup(cur, sectionsOf(stateA()), ALL_PICKS);
  assert.deepEqual(state.hosts.map((h) => h.id), ['h-1', 'h-2']);
  assert.deepEqual(state.accounts.map((a) => a.id), ['acc-1', 'acc-2']);
  assert.deepEqual(state.customThemes.map((d) => d.id), ['custom:night']);
  assert.deepEqual(state.workspaces.map((w) => w.id), ['ws-local', 'ws-1', 'ws-2']);
  assert.equal(state.activeId, 'ws-local'); // la mezcla no cambia de espacio activo
  assert.equal(state.settings.fontSize, 17);
  assert.equal(state.settings.theme, 'custom:night');
  assert.deepEqual(report, {
    mode: 'merge', settings: true, hostsAdded: 2, hostsSkipped: 0, accountsAdded: 2, accountsSkipped: 0, themesAdded: 1, themesSkipped: 0,
    workspacesAdded: 2, workspacesSkipped: 0, panesAdded: 4, savedAdded: 0, savedSkipped: 0,
  });
});

test('mezclar una copia en el mismo estado no duplica nada', () => {
  const cur = stateA();
  const { state, report } = mergeBackup(cur, sectionsOf(cur), ALL_PICKS);
  assert.equal(state.hosts.length, 2);
  assert.equal(state.accounts.length, 2);
  assert.equal(state.customThemes.length, 1);
  assert.equal(state.workspaces.length, 2);
  assert.deepEqual([report.hostsAdded, report.accountsAdded, report.themesAdded, report.workspacesAdded, report.panesAdded], [0, 0, 0, 0, 0]);
  assert.deepEqual([report.hostsSkipped, report.accountsSkipped, report.themesSkipped, report.workspacesSkipped], [2, 2, 1, 2]);
  assert.deepEqual(state.hosts[0], cur.hosts[0]); // y conserva la bandera de la bóveda del que ya estaba
});

test('hosts: dedupe por id y luego por usuario@host:puerto; colisión de id con otro destino = id nuevo', () => {
  const cur = blank();
  cur.hosts = [host('h-1', 'SRV1.example.com', { user: 'root', port: 2222, hasPassword: true, authMethod: 'password' }), host('h-9', 'other.example.com')];
  const bk = sectionsOf(stateA());
  bk.hosts.push(host('h-1', 'different.example.com'));      // mismo id, otro destino -> id nuevo
  bk.hosts.push(host('h-77', 'other.example.com'));          // otro id, mismo destino que h-9 -> dupe
  bk.hosts.push(host('h-78', 'new.example.com', { user: 'u', port: 22 })); // nuevo
  const { state, report } = mergeBackup(cur, bk, only('hosts'));
  const hosts = state.hosts;
  assert.equal(hosts.filter((h) => h.host.toLowerCase() === 'srv1.example.com').length, 1, 'srv1 no se duplica (mayúsculas aparte)');
  assert.equal(hosts.filter((h) => h.host === 'other.example.com').length, 1);
  const diff = hosts.find((h) => h.host === 'different.example.com');
  assert.ok(diff && diff.id !== 'h-1', 'colisión de id: id nuevo');
  assert.equal(hosts.filter((h) => h.id === 'h-1').length, 1);
  assert.ok(hosts.some((h) => h.host === 'new.example.com'));
  assert.equal(new Set(hosts.map((h) => h.id)).size, hosts.length);
  assert.equal(report.hostsAdded, 3); // srv2, different, new
  assert.equal(report.hostsSkipped, 2); // srv1 (mismo id y destino) y h-77 (otro id, mismo destino que h-9)
});

test('mezclar: los paneles apuntan al host/cuenta que quedó (renombrado o ya existente)', () => {
  const cur = blank();
  cur.hosts = [host('h-1', 'otro-destino.example.com')];                                        // h-1 ocupado por OTRO host
  cur.accounts = [{ id: 'acc-X', name: 'Work', dir: 'c:/users/me/.claude-work/', isDefault: false, color: '#fff', provider: 'claude' }]; // misma carpeta con otra grafía
  const { state } = mergeBackup(cur, sectionsOf(stateA()), ALL_PICKS);
  const newH1 = state.hosts.find((h) => h.host === 'srv1.example.com');
  assert.ok(newH1 && newH1.id !== 'h-1');
  const added = state.workspaces.find((w) => w.id === 'ws-1');
  assert.ok(added);
  assert.equal(added.panes.find((p) => p.kind === 'ssh')?.ref, newH1.id);
  const agent = added.panes.find((p) => p.kind === 'agent');
  assert.equal(agent?.ref, 'acc-X');
  assert.equal(agent?.spec.env?.ORCHESTRA_ACCOUNT, 'acc-X');
  assert.equal(state.accounts.filter((a) => a.dir.toLowerCase().includes('claude-work')).length, 1);
});

test('cuentas: la «de siempre» de otro equipo no se convierte en una segunda por defecto', () => {
  const cur = blank();
  cur.accounts = [{ id: 'mine', name: 'Main', dir: 'C:\\Users\\newpc\\.claude', isDefault: true, color: '#f5b942', provider: 'claude' }];
  const { state, report } = mergeBackup(cur, sectionsOf(stateA()), only('accounts'));
  assert.equal(state.accounts.filter((a) => a.isDefault).length, 1);
  assert.deepEqual(state.accounts.map((a) => a.id), ['mine', 'acc-2']);
  assert.equal(report.accountsSkipped, 1);
  assert.deepEqual(state.ignoredDirs, ['C:\\Users\\me\\.claude-old']);
});

test('temas: dedupe por contenido, ids nuevos si chocan con otro tema distinto, tope de 50', () => {
  const cur = blank();
  cur.customThemes = [theme('custom:night', 'Night', '#0a0a1a'), theme('custom:other', 'Other')];
  const bk = sectionsOf(stateA());
  bk.customThemes.push(theme('custom:other', 'Another one', '#202020'));
  const r1 = mergeBackup(cur, bk, only('themes'));
  assert.equal(r1.report.themesSkipped, 1);
  assert.equal(r1.report.themesAdded, 1);
  assert.equal(new Set(r1.state.customThemes.map((d) => d.id)).size, 3);
  // tope
  const full = blank();
  full.customThemes = Array.from({ length: MAX_CUSTOM_THEMES }, (_, i) => theme(`custom:t${i}`, `T${i}`, `#0000${(i % 10)}${(i % 10)}`.slice(0, 7)));
  const r2 = mergeBackup(full, { ...bk, customThemes: [theme('custom:zzz', 'Zzz', '#123456')] }, only('themes'));
  assert.equal(r2.state.customThemes.length, MAX_CUSTOM_THEMES);
  assert.equal(r2.report.themesAdded, 0);
  assert.equal(r2.report.themesSkipped, 1);
});

test('workspaces: mismo id y nombre = ya está; ids de espacio y de panel que chocan se rehacen', () => {
  const cur = blank();
  cur.workspaces = [ws('ws-1', 'Main', [pane('t-1')]), ws('ws-3', 'Local')];
  const bk = sectionsOf(stateA());
  bk.workspaces[0].name = 'Renamed';                  // ws-1 con otro nombre -> se añade con id nuevo
  bk.workspaces[0].focusId = 't-1';
  const { state, report } = mergeBackup(cur, bk, only('workspaces'));
  assert.equal(report.workspacesAdded, 2);
  const ids = state.workspaces.map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length);
  const paneIds = state.workspaces.flatMap((w) => w.panes.map((p) => p.id));
  assert.equal(new Set(paneIds).size, paneIds.length);
  const renamed = state.workspaces.find((w) => w.name === 'Renamed');
  assert.ok(renamed && renamed.id !== 'ws-1');
  assert.equal(renamed.focusId, renamed.panes.find((p) => p.title === 'PowerShell')?.id);
  assert.equal(state.workspaces[0].panes[0].id, 't-1'); // los de aquí no se tocan
});

test('mezclar: los ajustes solo cambian si se marcan; usageQuery se queda como estaba; un tema que falta cae al de serie', () => {
  const cur = blank();
  cur.settings = { ...DEFAULTS, usageQuery: true, fontSize: 12 };
  const bk = sectionsOf(stateA());
  const a = mergeBackup(cur, bk, only('hosts'));
  assert.deepEqual(a.state.settings, cur.settings);
  const b = mergeBackup(cur, bk, only('settings'));
  assert.equal(b.state.settings.fontSize, 17);
  assert.equal(b.state.settings.usageQuery, true);   // el de aquí, no el del archivo
  assert.equal(b.state.settings.theme, DEFAULTS.theme); // custom:night no está (Themes sin marcar)
  const c = mergeBackup(cur, bk, only('settings', 'themes'));
  assert.equal(c.state.settings.theme, 'custom:night');
  // y al revés: con usageQuery apagado aquí, un archivo (aunque lo trajera) no lo enciende
  const off = blank();
  assert.equal(mergeBackup(off, bk, ALL_PICKS).state.settings.usageQuery, false);
});

test('mezclar: si el tema del archivo cambia de id al entrar, los ajustes lo siguen', () => {
  const cur = blank();
  cur.customThemes = [theme('custom:night', 'Not the same', '#999999')];
  const { state } = mergeBackup(cur, sectionsOf(stateA()), only('settings', 'themes'));
  const added = state.customThemes.find((d) => d.name === 'Night');
  assert.ok(added && added.id !== 'custom:night');
  assert.equal(state.settings.theme, added.id);
});

test('mezclar sin casillas no toca nada; secciones sueltas solo tocan la suya', () => {
  const cur = blank();
  const bk = sectionsOf(stateA());
  assert.deepEqual(mergeBackup(cur, bk, none).state, cur);
  const h = mergeBackup(cur, bk, only('hosts')).state;
  assert.equal(h.hosts.length, 2);
  assert.deepEqual([h.accounts, h.customThemes, h.workspaces, h.ignoredDirs, h.settings], [cur.accounts, cur.customThemes, cur.workspaces, cur.ignoredDirs, cur.settings]);
  const w = mergeBackup(cur, bk, only('workspaces')).state;
  assert.deepEqual([w.hosts, w.accounts, w.customThemes], [[], [], []]);
  assert.equal(w.workspaces.length, 3);
  assert.equal(anyPicked(bk, none), false);
  assert.equal(anyPicked(bk, only('themes')), true);
  assert.equal(anyPicked({ ...bk, customThemes: [] }, only('themes')), false);
});

test('mergeBackup y replaceFromBackup no mutan sus entradas', () => {
  for (const fn of [mergeBackup, replaceFromBackup]) {
    const cur = stateA();
    cur.hosts[0].hasPassword = true;
    const bk = sectionsOf(blank());
    const bk2 = sectionsOf(stateA());
    const c0 = JSON.stringify(cur); const b0 = JSON.stringify(bk2);
    const out = fn(cur, bk2, ALL_PICKS);
    assert.equal(JSON.stringify(cur), c0);
    assert.equal(JSON.stringify(bk2), b0);
    assert.notEqual(out.state, cur);
    out.state.hosts.push(host('zz', 'zz.example.com'));
    out.state.workspaces[0].panes.length = 0;
    assert.equal(JSON.stringify(cur), c0);
    assert.equal(JSON.stringify(bk2), b0);
    void bk;
  }
});

// ---------- reemplazar ----------

test('reemplazar cambia las secciones marcadas y deja las demás', () => {
  const cur = stateA();
  cur.hosts = [host('old', 'old.example.com')];
  cur.accounts = [{ id: 'old-acc', name: 'Old', dir: 'C:\\old', isDefault: false, color: '#fff', provider: 'claude' }];
  cur.customThemes = [theme('custom:old', 'Old')];
  cur.ignoredDirs = ['C:\\ignored'];
  const bk = sectionsOf(blank());                // un archivo con solo un espacio de trabajo
  const bk2 = parseBackup(text(stateA()));
  assert.ok(bk2.ok);
  const { state, report } = replaceFromBackup(cur, bk2.sections, only('hosts', 'themes'));
  assert.deepEqual(state.hosts.map((h) => h.id), ['h-1', 'h-2']);
  assert.deepEqual(state.customThemes.map((d) => d.id), ['custom:night']);
  assert.deepEqual(state.accounts, cur.accounts);
  assert.deepEqual(state.ignoredDirs, cur.ignoredDirs);
  assert.deepEqual(state.workspaces, cur.workspaces);
  assert.deepEqual(state.settings, cur.settings);
  assert.equal(report.mode, 'replace');
  assert.deepEqual([report.hostsAdded, report.themesAdded, report.accountsAdded, report.workspacesAdded], [2, 1, 0, 0]);
  void bk;
});

test('reemplazar espacios de trabajo: trae los del archivo, su activo y sus paneles; los viejos desaparecen', () => {
  const cur = blank();
  const { state, report } = replaceFromBackup(cur, sectionsOf(stateA()), only('workspaces'));
  assert.deepEqual(state.workspaces.map((w) => w.id), ['ws-1', 'ws-2']);
  assert.equal(state.activeId, 'ws-2');
  assert.equal(report.panesAdded, 4);
  // sin activo en el archivo -> el primero
  const bk = sectionsOf(stateA());
  bk.activeId = undefined;
  assert.equal(replaceFromBackup(cur, bk, only('workspaces')).state.activeId, 'ws-1');
});

test('reemplazar nunca deja cero espacios de trabajo', () => {
  const cur = blank();
  const bk = sectionsOf(stateA());
  bk.workspaces = [];
  const { state } = replaceFromBackup(cur, bk, only('workspaces'));
  assert.deepEqual(state.workspaces, cur.workspaces);
  assert.equal(state.activeId, 'ws-local');
});

test('reemplazar hosts conserva la bandera de la bóveda solo si el host es el mismo y el método no cambió', () => {
  const cur = blank();
  cur.hosts = [host('h-1', 'srv1.example.com', { authMethod: 'password', hasPassword: true }), host('h-2', 'srv2.example.com', { authMethod: 'key', hasPassphrase: true })];
  const bk = sectionsOf(stateA());
  bk.hosts[1] = { ...bk.hosts[1], authMethod: 'agent' };   // h-2 cambia de método: el secreto guardado ya no se usa
  const { state } = replaceFromBackup(cur, bk, only('hosts'));
  assert.equal(state.hosts[0].hasPassword, true);
  assert.equal(state.hosts[1].hasPassphrase, undefined);
});

test('reemplazar ajustes: usageQuery sigue como estaba y un tema propio que no llega cae al de serie', () => {
  const cur = blank();
  cur.settings = { ...DEFAULTS, usageQuery: true };
  const { state } = replaceFromBackup(cur, sectionsOf(stateA()), only('settings'));
  assert.equal(state.settings.usageQuery, true);
  assert.equal(state.settings.fontSize, 17);
  assert.equal(state.settings.theme, DEFAULTS.theme);
  // si los temas se reemplazan en la misma pasada, el tema llega
  assert.equal(replaceFromBackup(cur, sectionsOf(stateA()), only('settings', 'themes')).state.settings.theme, 'custom:night');
});

test('reemplazar cuentas trae también las carpetas ignoradas', () => {
  const cur = blank();
  cur.ignoredDirs = ['C:\\a'];
  const { state } = replaceFromBackup(cur, sectionsOf(stateA()), only('accounts'));
  assert.deepEqual(state.ignoredDirs, ['C:\\Users\\me\\.claude-old']);
  assert.equal(state.accounts.length, 2);
});

// ---------- el panel importado no puede llevar nada que no hayamos validado ----------

test('lo que sale de mergeBackup/replaceFromBackup con un archivo hostil ya está validado', () => {
  const hostile = fileWith({
    workspaces: [{ ...ws('w', 'W'), panes: [
      { ...pane('h1'), spec: { program: 'cmd.exe', args: ['/c', { a: 1 }] } },
      { ...pane('h2'), spec: { program: 'ssh', args: ['x'], env: { ORCHESTRA_ASKPASS_KEY: 'host:victim:password' } } },
    ] }],
  });
  const r = parseBackup(hostile);
  assert.ok(r.ok);
  for (const fn of [mergeBackup, replaceFromBackup]) {
    const { state } = fn(blank(), r.sections, ALL_PICKS);
    const panes = state.workspaces.flatMap((w) => w.panes);
    assert.ok(!panes.some((p) => p.id === 'h1'));
    assert.ok(!JSON.stringify(state).includes('host:victim'));
  }
});

test('copias de ida y vuelta: exportar lo importado da lo mismo (estable)', () => {
  const first = parseBackup(text());
  assert.ok(first.ok);
  const { state } = replaceFromBackup(blank(), first.sections, ALL_PICKS);
  const again = buildBackup(state, { appVersion: '0.1.0', now: NOW });
  const b0 = make();
  // lo único que cambia es lo esperado: el estado de partida tenía usageQuery y lastSession, que no viajan
  assert.deepEqual(again.hosts, b0.hosts);
  assert.deepEqual(again.accounts, b0.accounts);
  assert.deepEqual(again.customThemes, b0.customThemes);
  assert.deepEqual(again.workspaces, b0.workspaces);
  assert.deepEqual(again.settings, b0.settings);
});

// ---------- barra de estado por pestaña ----------

test('statusbar: la lista propia de una pestaña viaja en la copia (exportar e importar) y se limpia', () => {
  const s = stateA();
  s.workspaces[0] = { ...s.workspaces[0], statusBarItems: ['target', 'latency', 'cpu'] };
  const r = parseBackup(serializeBackup(buildBackup(s, { appVersion: 'x' })));
  assert.ok(r.ok);
  assert.deepEqual(r.sections.workspaces[0].statusBarItems, ['target', 'latency', 'cpu']);
  assert.equal(r.sections.workspaces[1].statusBarItems, undefined);
  const dirty = parseBackup(fileWith({ workspaces: [{ ...ws('w', 'W'), statusBarItems: ['cpu', 'bogus', 'cpu', 7, 'branch'] }, { ...ws('v', 'V'), statusBarItems: 'cpu' }] }));
  assert.ok(dirty.ok);
  assert.deepEqual(dirty.sections.workspaces[0].statusBarItems, ['cpu', 'branch']);
  assert.equal('statusBarItems' in dirty.sections.workspaces[1], false);
});
