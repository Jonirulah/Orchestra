import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildMcpSnapshot, claudeAddCommand, mcpHost, paneKind } from './mcpsync.ts';
import { claudeSpec, emptyHost, newWorkspace } from './model.ts';
import type { Account, Host, Pane, Workspace } from './model.ts';

const SECRETS = ['hunter2-password', 'C:\\Users\\me\\.ssh\\id_ed25519', 'jump.internal', 'passphrase-xyz', 'export TOKEN=abc123', 'my private note'];

/** Host con campos que NUNCA deben salir (algunos ni existen en el tipo hoy: la fase de bóveda puede añadirlos). */
function leakyHost(): Host {
  const h = {
    ...emptyHost(), id: 'h1', name: 'web-1', host: 'web1.example.com', user: 'deploy', port: 2222, group: 'prod',
    tags: ['web', 'eu'], identityFile: SECRETS[1], proxyJump: SECRETS[2], command: SECRETS[4], notes: SECRETS[5],
    agentAccess: 'read' as const,
    password: SECRETS[0], passphrase: SECRETS[3], secretRef: 'vault:h1',
  };
  return h as Host;
}

const pane = (id: string, kind: Pane['kind'], ref?: string, parked = false): Pane => ({
  id, col: 0, row: 0, colSpan: 1, rowSpan: 1, parked, kind, icon: 'x', title: `t-${id}`, ref,
  spec: { program: 'ssh', args: ['-i', SECRETS[1], 'user@host'], env: { SECRET_TOKEN: SECRETS[0] } },
});

function world(): { hosts: Host[]; workspaces: Workspace[] } {
  const a = newWorkspace('Main');
  a.panes = [pane('p1', 'ssh', 'h1'), pane('p2', 'shell', 'powershell'), pane('p3', 'agent', 'acc-1'), pane('p4', 'agent', 'codex')];
  const b = newWorkspace('Servers');
  b.panes = [pane('p5', 'ssh', 'cfg:prod'), pane('p6', 'ssh', 'ghost-host'), pane('p7', 'ssh', undefined, true)];
  return { hosts: [leakyHost()], workspaces: [a, b] };
}

test('snapshot never contains passwords, key paths or any non-whitelisted field', () => {
  const w = world();
  const snap = buildMcpSnapshot({ ...w, live: {} });
  const json = JSON.stringify(snap);
  for (const s of SECRETS) assert.ok(!json.includes(s), `leaked: ${s}`);
  for (const k of ['password', 'identityFile', 'proxyJump', 'passphrase', 'secretRef', 'notes', 'command', 'spec', 'args', 'env']) {
    assert.ok(!json.includes(`"${k}"`), `field leaked: ${k}`);
  }
  assert.deepEqual(Object.keys(snap.hosts[0]).sort(), ['agentAccess', 'group', 'host', 'id', 'name', 'port', 'tags', 'user']);
});

test('host fields are copied and an unknown access level falls closed to none', () => {
  const h = mcpHost(leakyHost());
  assert.deepEqual(h, { id: 'h1', name: 'web-1', host: 'web1.example.com', user: 'deploy', port: 2222, group: 'prod', tags: ['web', 'eu'], agentAccess: 'read' });
  const bad = mcpHost({ ...leakyHost(), agentAccess: 'root' as unknown as Host['agentAccess'] });
  assert.equal(bad.agentAccess, 'none');
  const bare = mcpHost({ ...emptyHost(), id: 'x', host: 'only.host' });
  assert.equal(bare.name, 'only.host');
  assert.ok(!('user' in bare) && !('port' in bare) && !('group' in bare));
});

test('pane kinds, host links, workspace names and live state', () => {
  const snap = buildMcpSnapshot({ ...world(), live: { p1: { state: 'running' }, p3: { state: 'exited' } } });
  const by = Object.fromEntries(snap.panes.map((p) => [p.id, p]));
  assert.equal(snap.panes.length, 7); // incluidos los de segundo plano
  assert.deepEqual(by.p1, { id: 'p1', title: 't-p1', kind: 'ssh', workspace: 'Main', state: 'running', hostId: 'h1' });
  assert.equal(by.p2.kind, 'shell');
  assert.equal(by.p3.kind, 'claude');
  assert.equal(by.p3.state, 'exited');
  assert.equal(by.p4.kind, 'codex');
  assert.equal(by.p4.state, 'starting');
  // SSH sin host guardado: alias de ~/.ssh/config, host borrado, rápido: sin hostId (el backend los niega)
  for (const id of ['p5', 'p6', 'p7']) { assert.equal(by[id].kind, 'ssh'); assert.ok(!('hostId' in by[id]), id); }
  assert.equal(by.p5.workspace, 'Servers');
  assert.equal(paneKind({ kind: 'agent', ref: undefined }), 'claude');
});

test('the snapshot is plain JSON (no proxies, no undefined fields)', () => {
  const snap = buildMcpSnapshot({ ...world(), live: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
});

const acc: Account = { id: 'acc-1', name: 'Main', dir: 'C:\\Users\\me\\.claude', isDefault: true, color: '#fff' };

test('claudeSpec adds --mcp-config only when asked, keeps the other flags', () => {
  const plain = claudeSpec(acc).args.at(-1)!;
  assert.equal(plain, '& claude');
  assert.ok(!plain.includes('--mcp-config'));
  const path = 'C:\\Users\\me\\AppData\\Roaming\\com.orchestra\\mcp\\claude-mcp.json';
  const withMcp = claudeSpec(acc, { mcpConfig: path }).args.at(-1)!;
  assert.equal(withMcp, `& claude --mcp-config '${path}'`);
  const all = claudeSpec(acc, { resume: true, settingsPath: 'C:\\s.json', mcpConfig: path }).args.at(-1)!;
  assert.equal(all, `& claude --continue --settings 'C:\\s.json' --mcp-config '${path}'`);
  // una comilla simple en la ruta se duplica (PowerShell) y no rompe el comando
  const quoted = claudeSpec(acc, { mcpConfig: "C:\\O'Brien\\m.json" }).args.at(-1)!;
  assert.equal(quoted, "& claude --mcp-config 'C:\\O''Brien\\m.json'");
  // el resto de la especificación no cambia
  assert.equal(claudeSpec(acc, { mcpConfig: path }).program, 'powershell.exe');
  assert.deepEqual(claudeSpec(acc, { mcpConfig: path }).env, { ORCHESTRA_ACCOUNT: 'acc-1' });
});

test('claude mcp add command for global use', () => {
  assert.equal(
    claudeAddCommand('http://127.0.0.1:47821/mcp', 'abc'),
    'claude mcp add --transport http orchestra http://127.0.0.1:47821/mcp --header "Authorization: Bearer abc"',
  );
});

// ---------- revisión adversaria (2026-11-06): el comando final de Claude, con rutas difíciles ----------

const HARD_PATHS = [
  'C:\\Users\\José Ñandú\\AppData\\Roaming\\dev.orchestra.app\\mcp\\claude-mcp.json',
  'C:\\Users\\Ana (trabajo)\\AppData\\Roaming\\dev.orchestra.app\\mcp\\claude-mcp.json',
  'C:\\Users\\O\u2019Brien\\AppData\\Roaming\\x\\claude-mcp.json', // comilla tipográfica: PowerShell la trata como comilla simple
  'C:\\Users\\O\u2018Brien\\a.json',
  "C:\\Users\\O'Brien\\a b.json",
  'C:\\Users\\$env:USERNAME\\`n\\$(calc)\\a.json',
  'C:\\Users\\日本語 \u2019\u201a\u201b\\a.json',
];

/** Ejecuta el comando REAL de claudeSpec en PowerShell, con `claude` sustituido por una función que
 *  devuelve sus argumentos, y comprueba que PowerShell los entrega tal cual (sin partir ni ejecutar nada). */
function argsSeenByClaude(cmd: string): string[] | null {
  if (process.platform !== 'win32') return null;
  // Salida en base64: la consola de Windows no es UTF-8 y estropearía los acentos.
  const script = `function claude { $args | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_)) } }; ${cmd}`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => Buffer.from(l.trim(), 'base64').toString('utf8'));
}

test('claudeSpec: PowerShell delivers hard paths to claude intact (spaces, parentheses, unicode, smart quotes, $ and backticks)', () => {
  for (const p of HARD_PATHS) {
    const cmd = claudeSpec(acc, { resume: true, settingsPath: p, mcpConfig: p }).args.at(-1)!;
    const seen = argsSeenByClaude(cmd);
    if (!seen) return;
    assert.deepEqual(seen, ['--continue', '--settings', p, '--mcp-config', p], p);
  }
});

test('claudeSpec: --mcp-config (variadic in Claude Code) is the LAST thing on the command line in every path', () => {
  const p = 'C:\\x\\claude-mcp.json';
  const combos = [
    {}, { resume: true }, { settingsPath: 'C:\\s.json' }, { resume: true, settingsPath: 'C:\\s.json' },
    { cwd: 'C:\\w', resume: true, settingsPath: 'C:\\s.json' },
  ];
  for (const c of combos) {
    for (const a of [acc, { ...acc, isDefault: false, dir: 'C:\\Users\\me\\.claude-work' }]) {
      const cmd = claudeSpec(a, { ...c, mcpConfig: p }).args.at(-1)!;
      assert.ok(cmd.endsWith(`--mcp-config '${p}'`), cmd); // nada detrás: no puede tragarse otro argumento
      assert.equal(cmd.split('--mcp-config').length, 2);
      const noMcp = claudeSpec(a, c).args.at(-1)!;
      assert.ok(!noMcp.includes('mcp'), noMcp); // apagado: ni rastro del flag
    }
  }
});
