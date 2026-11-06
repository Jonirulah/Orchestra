import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newWorkspace, placePane, reflow, emptyCells, swapPanes, movePaneToCell, removePane,
  resizeTracks, neighbor, sshArgs, emptyHost, parseQuickConnect, equalTracks,
  normalizeHost, sshSpec, sshInstallKeySpec, activeSecretKey, hostSecretKey, exportHosts,
  hostFromSshConfig, newConfigEntries,
  effectiveHostKeyPolicy, hostKeyAction, hostKeyViaJump, HOSTKEY_JUMP_MSG,
} from './model.ts';
import type { Pane, Workspace } from './model.ts';

const mk = (id: string): Pane => ({
  id, col: 0, row: 0, colSpan: 1, rowSpan: 1, parked: false, kind: 'shell',
  icon: 'terminal', title: id, spec: { program: 'x', args: [] },
});

function fill(ws: Workspace, n: number) {
  for (let i = 0; i < n; i++) placePane(ws, mk(`p${i}`));
}

test('placePane rellena en orden y sin solapes', () => {
  const ws = newWorkspace('t', 2, 2);
  fill(ws, 4);
  const cells = ws.panes.map((p) => `${p.col},${p.row}`);
  assert.deepEqual(cells, ['0,0', '1,0', '0,1', '1,1']);
  assert.equal(emptyCells(ws).length, 0);
});

test('con la cuadrícula llena, el nuevo sustituye al enfocado y éste queda vivo en segundo plano', () => {
  const ws = newWorkspace('t', 2, 1);
  fill(ws, 2);
  ws.focusId = 'p0';
  const displaced = placePane(ws, mk('nuevo'));
  assert.equal(displaced?.id, 'p0');
  assert.equal(ws.panes.length, 3);
  assert.equal(ws.panes.find((p) => p.id === 'p0')!.parked, true);
  assert.equal(ws.panes.find((p) => p.id === 'nuevo')!.col, 0);
});

test('reflow reduce sin perder paneles y los recupera al crecer', () => {
  const ws = newWorkspace('t', 2, 2);
  fill(ws, 4);
  reflow(ws, 2, 1);
  assert.equal(ws.panes.filter((p) => p.parked).length, 2);
  assert.equal(ws.panes.length, 4);
  reflow(ws, 4, 4);
  assert.equal(ws.panes.filter((p) => p.parked).length, 0);
  assert.deepEqual(ws.panes.map((p) => p.id), ['p0', 'p1', 'p2', 'p3']);
  assert.deepEqual(equalTracks(4), [0.25, 0.25, 0.25, 0.25]);
});

test('swap y move', () => {
  const ws = newWorkspace('t', 2, 2);
  fill(ws, 2);
  swapPanes(ws, 'p0', 'p1');
  assert.equal(ws.panes[0].col, 1);
  assert.equal(ws.panes[1].col, 0);
  movePaneToCell(ws, 'p0', 0, 1);
  assert.deepEqual([ws.panes[0].col, ws.panes[0].row], [0, 1]);
  movePaneToCell(ws, 'p0', 0, 0); // ocupada por p1: intercambian
  assert.deepEqual([ws.panes[1].col, ws.panes[1].row], [0, 1]);
});

test('removePane mueve el foco', () => {
  const ws = newWorkspace('t', 2, 1);
  fill(ws, 2);
  ws.focusId = 'p1';
  removePane(ws, 'p1');
  assert.equal(ws.focusId, 'p0');
});

test('resizeTracks respeta el mínimo y conserva la suma', () => {
  const t = resizeTracks([0.5, 0.5], 0, 0.9, 0.1);
  assert.ok(Math.abs(t[0] + t[1] - 1) < 1e-9);
  assert.ok(Math.abs(t[1] - 0.1) < 1e-9);
  const u = resizeTracks([0.5, 0.5], 0, -0.9, 0.1);
  assert.ok(Math.abs(u[0] - 0.1) < 1e-9);
});

test('neighbor navega por la cuadrícula', () => {
  const ws = newWorkspace('t', 2, 2);
  fill(ws, 4);
  assert.equal(neighbor(ws, 'p0', 'right'), 'p1');
  assert.equal(neighbor(ws, 'p0', 'down'), 'p2');
  assert.equal(neighbor(ws, 'p3', 'left'), 'p2');
  assert.equal(neighbor(ws, 'p0', 'left'), null);
});

test('sshArgs', () => {
  const h = { ...emptyHost(), host: 'srv.example.com', user: 'ana', port: 2200, identityFile: 'C:/k', proxyJump: 'b' };
  const a = sshArgs(h);
  assert.deepEqual(a.slice(-7), ['-p', '2200', '-i', 'C:/k', '-J', 'b', 'ana@srv.example.com']);
  const t = sshArgs({ ...h, tmux: true });
  assert.ok(t.includes('-t'));
  assert.ok(t[t.length - 1].startsWith('tmux new-session -A -s orchestra'));
});

test('parseQuickConnect', () => {
  assert.deepEqual(parseQuickConnect('root@10.0.0.1:2222'), { user: 'root', host: '10.0.0.1', port: 2222 });
  assert.deepEqual(parseQuickConnect('miservidor'), { user: undefined, host: 'miservidor', port: undefined });
  assert.equal(parseQuickConnect('dos palabras'), null);
});

// ---------- bóveda SSH ----------

const base = { ...emptyHost(), id: 'h-1', host: 'srv', user: 'ana' };

test('sshArgs: auth "agent" no cambia nada (sin IdentitiesOnly, sin env)', () => {
  const a = sshArgs({ ...base, identityFile: 'C:/k' });
  assert.ok(a.includes('-i') && !a.includes('IdentitiesOnly=yes'));
  assert.equal(sshSpec(base).env, undefined);
  assert.deepEqual(sshSpec(base).args, sshArgs(base));
});

test('sshArgs: clave con archivo añade -i e IdentitiesOnly', () => {
  const a = sshArgs({ ...base, authMethod: 'key', identityFile: 'C:/k' });
  const i = a.indexOf('-i');
  assert.equal(a[i + 1], 'C:/k');
  assert.deepEqual(a.slice(a.indexOf('IdentitiesOnly=yes') - 1, a.indexOf('IdentitiesOnly=yes') + 1), ['-o', 'IdentitiesOnly=yes']);
  // Sin archivo no hay IdentitiesOnly.
  assert.ok(!sshArgs({ ...base, authMethod: 'key' }).includes('IdentitiesOnly=yes'));
});

test('contraseña guardada: env lleva solo el NOMBRE de la clave y ssh un solo intento', () => {
  const h = { ...base, authMethod: 'password' as const, hasPassword: true };
  assert.equal(activeSecretKey(h), 'host:h-1:password');
  const s = sshSpec(h);
  assert.deepEqual(s.env, { ORCHESTRA_ASKPASS_KEY: 'host:h-1:password' });
  assert.ok(s.args.join(' ').includes('NumberOfPasswordPrompts=1'));
  // Marcada pero con otro método, o sin bandera: nada.
  assert.equal(activeSecretKey({ ...h, authMethod: 'agent' }), null);
  assert.equal(activeSecretKey({ ...h, hasPassword: false }), null);
  assert.ok(!sshArgs({ ...h, hasPassword: false }).join(' ').includes('NumberOfPasswordPrompts'));
});

test('passphrase guardada con clave', () => {
  const h = { ...base, authMethod: 'key' as const, identityFile: 'C:/k', hasPassphrase: true };
  assert.equal(activeSecretKey(h), hostSecretKey('h-1', 'passphrase'));
  assert.deepEqual(sshSpec(h).env, { ORCHESTRA_ASKPASS_KEY: 'host:h-1:passphrase' });
});

test('un host guardado por versiones anteriores se carga con valores por defecto', () => {
  const old = JSON.parse('{"id":"h-old","name":"viejo","tags":["a"],"host":"srv","identityFile":"C:/k","agentAccess":"read"}');
  const h = normalizeHost(old);
  assert.equal(h.authMethod, 'agent');
  assert.equal(h.hasPassword, undefined);
  assert.deepEqual(sshArgs(h), sshArgs(old));
  assert.equal(normalizeHost({ id: 'x', host: 'y' } as never).agentAccess, 'none');
  assert.deepEqual(normalizeHost({ id: 'x', host: 'y' } as never).tags, []);
  assert.equal(normalizeHost({ ...old, authMethod: 'basura' }).authMethod, 'agent');
});

test('normalizeHost nunca conserva un secreto ni banderas que no corresponden', () => {
  const dirty = { ...base, authMethod: 'agent', hasPassword: true, password: 'hunter2', passphrase: 'x', secret: 'y' };
  const h = normalizeHost(dirty as never);
  assert.ok(!JSON.stringify(h).includes('hunter2'));
  assert.equal(h.hasPassword, undefined);
  assert.equal(normalizeHost({ ...base, authMethod: 'password', hasPassword: true }).hasPassword, true);
});

test('el JSON que se guarda de un host no contiene campos de contraseña', () => {
  const h = normalizeHost({ ...base, authMethod: 'password', hasPassword: true, password: 'hunter2' } as never);
  const saved = JSON.stringify([h]);
  assert.ok(!/hunter2/.test(saved));
  assert.ok(!/"(password|passphrase|secret)": ?/.test(saved));
  // Y lo que viaja en el panel (state.json lo persiste) solo trae el nombre de la entrada.
  assert.ok(!/hunter2/.test(JSON.stringify(sshSpec(h))));
});

test('exportHosts: sin secretos, sin banderas de bóveda ni ids', () => {
  const h = { ...base, authMethod: 'password' as const, hasPassword: true, hasPassphrase: true, tags: ['x'] };
  const txt = exportHosts([h]);
  assert.ok(!/hasPass|"id"|"(password|passphrase|secret)": ?/i.test(txt), txt);
  const o = JSON.parse(txt);
  assert.equal(o.hosts[0].host, 'srv');
  assert.equal(o.hosts[0].authMethod, 'password');
});

test('importar ~/.ssh/config: datos resueltos y se saltan los alias existentes', () => {
  const cfg = [
    { alias: 'prod', hostname: '10.0.0.5', user: 'deploy', port: 2222, identityFile: '~/.ssh/id_prod', proxyJump: 'bastion' },
    { alias: 'Bastion', hostname: 'b.example.com' },
    { alias: 'solo' },
  ];
  const have = [{ ...base, name: 'bastion' }];
  const nuevos = newConfigEntries(cfg, have);
  assert.deepEqual(nuevos.map((c) => c.alias), ['prod', 'solo']);
  const p = hostFromSshConfig(cfg[0]);
  assert.deepEqual([p.name, p.host, p.user, p.port, p.authMethod, p.identityFile, p.proxyJump], ['prod', '10.0.0.5', 'deploy', 2222, 'key', '~/.ssh/id_prod', 'bastion']);
  assert.equal(hostFromSshConfig(cfg[2]).host, 'solo');
  assert.equal(hostFromSshConfig(cfg[2]).authMethod, 'agent');
});

test('instalar clave: PowerShell canaliza la .pub a ssh con comillas simples escapadas', () => {
  const s = sshInstallKeySpec({ ...base, command: 'cd /x', tmux: true }, "C:\\Users\\o'brien\\.ssh\\id.pub");
  assert.equal(s.program, 'powershell.exe');
  const cmd = s.args[s.args.length - 1];
  assert.ok(cmd.startsWith("(Get-Content -Raw -LiteralPath 'C:\\Users\\o''brien\\.ssh\\id.pub').Trim() | ssh "));
  assert.ok(cmd.includes('authorized_keys'));
  assert.ok(!cmd.includes('tmux') && !cmd.includes("'-t'")); // sin tmux ni -t
  assert.ok(!cmd.includes('"')); // sin comillas dobles: PowerShell 5.1 las rompe al pasarlas a ssh
});

// ---------- política de huella SSH (hosts con secreto guardado) ----------

const pw = { ...base, authMethod: 'password' as const, hasPassword: true };
const strictOf = (a: string[]) => a.filter((x) => x.startsWith('StrictHostKeyChecking='));

test('huella: matriz política × (secreto guardado / no) -> argumentos exactos', () => {
  // Con secreto + confirm: la huella debe estar ya en known_hosts (yes). Nunca accept-new.
  assert.deepEqual(sshArgs(pw, 'confirm'), [
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4',
    '-o', 'NumberOfPasswordPrompts=1', '-o', 'StrictHostKeyChecking=yes', 'ana@srv',
  ]);
  // Con secreto + accept-new: exactamente el comportamiento de antes.
  assert.deepEqual(sshArgs(pw, 'accept-new'), [
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4',
    '-o', 'NumberOfPasswordPrompts=1', '-o', 'StrictHostKeyChecking=accept-new', 'ana@srv',
  ]);
  // Sin secreto: ninguna opción de huella, sea cual sea la política (ssh pregunta en la terminal).
  for (const pol of ['confirm', 'accept-new'] as const) {
    const a = sshArgs(base, pol);
    assert.deepEqual(strictOf(a), []);
    assert.ok(!a.includes('NumberOfPasswordPrompts=1'));
    assert.deepEqual(a, sshArgs({ ...pw, hasPassword: false }, pol));
  }
  // Passphrase guardada de una clave: misma regla.
  const key = { ...base, authMethod: 'key' as const, identityFile: 'C:/k', hasPassphrase: true };
  assert.deepEqual(strictOf(sshArgs(key, 'confirm')), ['StrictHostKeyChecking=yes']);
  assert.deepEqual(strictOf(sshArgs(key, 'accept-new')), ['StrictHostKeyChecking=accept-new']);
  // Sin indicar política, la segura.
  assert.deepEqual(strictOf(sshArgs(pw)), ['StrictHostKeyChecking=yes']);
});

test('huella: el valor del host manda sobre el global; "default" y los antiguos siguen al global', () => {
  assert.equal(effectiveHostKeyPolicy({}, 'confirm'), 'confirm');
  assert.equal(effectiveHostKeyPolicy({}, 'accept-new'), 'accept-new');
  assert.equal(effectiveHostKeyPolicy({ hostKeyPolicy: 'default' }, 'accept-new'), 'accept-new');
  assert.equal(effectiveHostKeyPolicy({ hostKeyPolicy: 'accept-new' }, 'confirm'), 'accept-new');
  assert.equal(effectiveHostKeyPolicy({ hostKeyPolicy: 'confirm' }, 'accept-new'), 'confirm');
  assert.equal(effectiveHostKeyPolicy({ hostKeyPolicy: 'basura' as never }, 'confirm'), 'confirm');
  // En los argumentos reales:
  assert.deepEqual(strictOf(sshArgs({ ...pw, hostKeyPolicy: 'accept-new' }, 'confirm')), ['StrictHostKeyChecking=accept-new']);
  assert.deepEqual(strictOf(sshArgs({ ...pw, hostKeyPolicy: 'confirm' }, 'accept-new')), ['StrictHostKeyChecking=yes']);
  assert.deepEqual(strictOf(sshArgs({ ...pw, hostKeyPolicy: 'default' }, 'accept-new')), ['StrictHostKeyChecking=accept-new']);
  // También en la clave instalada y en el spec.
  assert.ok(sshInstallKeySpec(pw, 'C:/k.pub', 'confirm').args.join(' ').includes('StrictHostKeyChecking=yes'));
  assert.ok(sshInstallKeySpec(pw, 'C:/k.pub', 'accept-new').args.join(' ').includes('StrictHostKeyChecking=accept-new'));
  assert.deepEqual(sshSpec(pw, 'accept-new').args, sshArgs(pw, 'accept-new'));
});

test('huella: un host guardado antes (sin el campo) se carga y sigue el global', () => {
  const old = { id: 'o', name: 'viejo', host: 'srv', authMethod: 'password', hasPassword: true };
  const h = normalizeHost(old as never);
  assert.equal(h.hostKeyPolicy, undefined);
  assert.ok(!('hostKeyPolicy' in h));
  assert.deepEqual(strictOf(sshArgs(h, 'confirm')), ['StrictHostKeyChecking=yes']);
  // Valores propios válidos se conservan; 'default' y basura se descartan.
  assert.equal(normalizeHost({ ...old, hostKeyPolicy: 'accept-new' } as never).hostKeyPolicy, 'accept-new');
  assert.equal(normalizeHost({ ...old, hostKeyPolicy: 'confirm' } as never).hostKeyPolicy, 'confirm');
  assert.ok(!('hostKeyPolicy' in normalizeHost({ ...old, hostKeyPolicy: 'default' } as never)));
  assert.ok(!('hostKeyPolicy' in normalizeHost({ ...old, hostKeyPolicy: 'yes' } as never)));
  // El JSON guardado no contiene el secreto.
  assert.ok(!/hunter2/.test(JSON.stringify(normalizeHost({ ...old, password: 'hunter2' } as never))));
});

test('huella: qué hay que hacer antes de abrir (secreto × política × conocida/desconocida)', () => {
  // Sin secreto guardado: nunca hay paso previo, ni con confirm.
  assert.equal(hostKeyAction(base, 'confirm'), 'spawn');
  assert.equal(hostKeyAction({ ...pw, hasPassword: false }, 'confirm'), 'spawn');
  assert.equal(hostKeyAction({ ...base, authMethod: 'agent', hasPassword: true }, 'confirm'), 'spawn');
  // accept-new: abre sin paso previo.
  assert.equal(hostKeyAction(pw, 'accept-new'), 'spawn');
  assert.equal(hostKeyAction({ ...pw, hostKeyPolicy: 'accept-new' }, 'confirm'), 'spawn');
  // confirm: primero comprobar; conocida -> abre; desconocida -> pregunta.
  assert.equal(hostKeyAction(pw, 'confirm'), 'probe');
  assert.equal(hostKeyAction({ ...pw, hostKeyPolicy: 'confirm' }, 'accept-new'), 'probe');
  assert.equal(hostKeyAction(pw, 'confirm', 'known'), 'spawn');
  assert.equal(hostKeyAction(pw, 'confirm', 'unknown'), 'ask');
  // Con salto o alias, desconocida: bloqueado (no se finge); conocida: se abre.
  assert.equal(hostKeyAction({ ...pw, proxyJump: 'u@bastion' }, 'confirm', 'jump'), 'blocked-jump');
  assert.equal(hostKeyAction({ ...pw, proxyJump: 'u@bastion' }, 'confirm', 'known'), 'spawn');
  assert.equal(hostKeyAction(pw, 'confirm', 'alias'), 'blocked-alias');
  // Con accept-new el salto no estorba.
  assert.equal(hostKeyAction({ ...pw, proxyJump: 'u@bastion' }, 'accept-new', 'jump'), 'spawn');
});

test('huella: ProxyJump detectado y mensaje exacto', () => {
  assert.equal(hostKeyViaJump({ proxyJump: 'u@bastion' }), true);
  assert.equal(hostKeyViaJump({ proxyJump: '   ' }), false);
  assert.equal(hostKeyViaJump({}), false);
  assert.equal(
    HOSTKEY_JUMP_MSG,
    "This host is reached through a jump host, so its key can't be checked in advance. Set this host to 'Trust on first use' in its settings, or connect once without a saved password.",
  );
});
