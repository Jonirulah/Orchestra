import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpRows, cellLetters, cellState, cellView, classifyProbeError, columnTotal, defStatus, compactTokens, diffDefs, probeKey, rowTokens, thirdPartyPackage, variantOf, diffPieces, totalBreakdown, wordPieces } from './mcpmatrix.ts';
import type { McpAccount, McpDef, McpProbeResult } from './backend.ts';

function def(name: string, fingerprint: string, over: Partial<McpDef> = {}): McpDef {
  return {
    name, transport: 'stdio', command: 'npx', args: ['-y', `@x/${name}`], url: null, cwd: null, envKeys: [], headerKeys: [],
    envPassthrough: [], enabled: true, scope: 'user', projectPath: null, rawKind: 'stdio', authStatus: null, disabledIn: [],
    managedBy: null, fingerprint, ...over,
  };
}
function acc(id: string, servers: McpDef[]): McpAccount {
  return { id, provider: id.startsWith('codex') ? 'codex' : 'claude', dir: id, isDefault: false, label: null, source: '', servers, error: null };
}

test('same name + same fingerprint in several accounts = one row', () => {
  const rows = buildMcpRows([acc('claude:a', [def('github', 'f1')]), acc('codex:b', [def('github', 'f1')]), acc('claude:c', [])]);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0].cells).sort(), ['claude:a', 'codex:b']);
  assert.equal(rows[0].variants.length, 1);
  assert.equal(rows[0].variants[0].letter, '');
  assert.deepEqual(rows[0].diff, []);
  assert.deepEqual(cellLetters(rows[0], 'claude:a'), []);
});

test('same name + different fingerprint = ONE row with variants A/B marked per cell, with what changes', () => {
  const a = def('github', 'f1', { envKeys: ['GITHUB_TOKEN'] });
  const b = def('github', 'f2', { args: ['-y', '@x/github@0.5'], envKeys: ['GH_PAT'] });
  // f2 está en dos cuentas → es la A; f1 en una → B.
  const rows = buildMcpRows([acc('claude:a', [a]), acc('claude:b', [b]), acc('codex:c', [b]), acc('claude:d', [])]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.key, 'github');
  assert.deepEqual(r.variants.map((v) => [v.letter, v.fingerprint]), [['A', 'f2'], ['B', 'f1']]);
  assert.deepEqual([...r.diff].sort(), ['args', 'envKeys']);
  for (const v of r.variants) assert.deepEqual([...v.diff].sort(), ['args', 'envKeys']);
  assert.deepEqual(Object.keys(r.cells).sort(), ['claude:a', 'claude:b', 'codex:c']);
  assert.deepEqual(cellLetters(r, 'claude:a'), ['B']);
  assert.deepEqual(cellLetters(r, 'codex:c'), ['A']);
  assert.deepEqual(cellLetters(r, 'claude:d'), []);
  assert.equal(variantOf(r, a)?.letter, 'B');
  assert.deepEqual(Object.keys(r.variants[0].cells).sort(), ['claude:b', 'codex:c']);
  // Una cuenta con las dos variantes (en proyectos distintos) lleva las dos letras.
  const both = buildMcpRows([acc('claude:a', [a, { ...b, scope: 'local', projectPath: 'C:/p' }])]);
  assert.deepEqual(cellLetters(both[0], 'claude:a'), ['A', 'B']);
  // Solo cambia un valor oculto (misma forma, distinta huella) → «values».
  assert.deepEqual(diffDefs(def('x', 'f1', { envKeys: ['K'] }), def('x', 'f9', { envKeys: ['K'] })), ['values']);
  // Mayúsculas/barras del comando y orden de las claves no cuentan como diferencia visible.
  assert.deepEqual(diffDefs(def('x', 'f1', { command: 'C:\\Tools\\NPX', envKeys: ['A', 'b'] }), def('x', 'f2', { command: 'c:/tools/npx', envKeys: ['B', 'a'] })), ['values']);
  assert.deepEqual(diffDefs(def('x', 'f1', { transport: 'http', command: null, url: 'https://a/mcp/' }), def('x', 'f2', { transport: 'http', command: null, url: 'https://b/mcp' })), ['url']);
});

test('different names never mix; managed rows go last; same name in several projects stays one cell list', () => {
  const rows = buildMcpRows([
    acc('claude:a', [
      def('zeta', 'f3'),
      def('claude.ai Trello', '00', { scope: 'claudeai', managedBy: 'claude.ai' }),
      def('claude.ai Miro', '00', { scope: 'claudeai', managedBy: 'claude.ai' }),
      def('unity', 'f4', { scope: 'local', projectPath: 'C:/p1' }),
      def('unity', 'f4', { scope: 'local', projectPath: 'C:/p2', enabled: false }),
    ]),
  ]);
  assert.deepEqual(rows.map((r) => r.name), ['unity', 'zeta', 'claude.ai Miro', 'claude.ai Trello']);
  assert.equal(rows[0].cells['claude:a'].length, 2);
  assert.equal(rows[2].variants.length, 1); // misma huella vacía, nombres distintos: no se juntan
  assert.equal(rows[2].managed, true);
});

test('cell state: on / off / pending approval / none', () => {
  assert.equal(cellState(undefined), 'none');
  assert.equal(cellState([def('a', 'f', { enabled: false })]), 'off');
  assert.equal(cellState([def('a', 'f', { enabled: false }), def('a', 'f', { enabled: null })]), 'on');
  assert.equal(cellState([def('a', 'f', { scope: 'project', enabled: null })]), 'pending');
  assert.equal(cellState([def('a', 'f', { scope: 'project', enabled: false })]), 'off');
});

test('row cost = biggest ok probe; tokens are compact', () => {
  const d = def('github', 'f1');
  const rows = buildMcpRows([acc('claude:a', [d]), acc('codex:b', [d])]);
  const res: Record<string, McpProbeResult> = {
    [probeKey('claude:a', d)]: { status: 'ok', tools: 26, serverName: null, version: null, toolsBytes: 47_200, tokensEst: 11_800 },
    [probeKey('codex:b', d)]: { status: 'timeout' },
  };
  assert.equal(rowTokens(rows[0], res), 11_800);
  assert.equal(rowTokens(rows[0], {}), null);
  assert.equal(compactTokens(950), '950');
  assert.equal(compactTokens(1_500), '1.5k');
  assert.equal(compactTokens(11_800), '12k');
  assert.equal(compactTokens(2_450, 'es'), '2,5 k');
  assert.equal(compactTokens(11_800, 'es'), '12 k');
  assert.equal(compactTokens(950, 'es'), '950');
});

test('column total = sum of enabled MCP that gave a number; partial if any configured cell gave none (untested, fails, claude.ai); off/pending do not count', () => {
  const gh = def('github', 'f1');
  const fs = def('filesystem', 'f2');
  const off = def('unity', 'f3', { enabled: false });
  const pend = def('postgres', 'f4', { scope: 'project', projectPath: 'C:/p', enabled: null });
  const ai = def('claude.ai Miro', '00', { scope: 'claudeai', managedBy: 'claude.ai' });
  const bad = def('linear', 'f5');
  // Mismo MCP en dos proyectos (local): cuenta una vez, el mayor.
  const l1 = def('db', 'f6', { scope: 'local', projectPath: 'C:/a' });
  const l2 = def('db', 'f6', { scope: 'local', projectPath: 'C:/b' });
  const accs = [acc('claude:a', [gh, fs, off, pend, ai, bad, l1, l2]), acc('claude:e', [])];
  const rows = buildMcpRows(accs);
  const ok = (t: number): McpProbeResult => ({ status: 'ok', tools: 1, serverName: null, version: null, toolsBytes: t * 4, tokensEst: t });
  const res: Record<string, McpProbeResult> = {
    [probeKey('claude:a', gh)]: ok(11_800),
    [probeKey('claude:a', off)]: ok(99_999), // apagado: no suma aunque se haya probado
    [probeKey('claude:a', bad)]: { status: 'failed', msg: 'x' },
    [probeKey('claude:a', l1)]: ok(1_000),
    [probeKey('claude:a', l2)]: ok(3_000),
  };
  assert.deepEqual(columnTotal(rows, 'claude:a', res), { tokens: 14_800, probed: 2, pending: 1, failed: 1, unmeasurable: 1, partial: true });
  res[probeKey('claude:a', fs)] = ok(2_450);
  assert.deepEqual(columnTotal(rows, 'claude:a', res), { tokens: 17_250, probed: 3, pending: 0, failed: 1, unmeasurable: 1, partial: true });
  // Solo con lo que da cifra el total deja de ser parcial.
  const clean = buildMcpRows([acc('claude:c', [gh, off, pend])]);
  const r2 = { [probeKey('claude:c', gh)]: ok(500), [probeKey('claude:c', off)]: ok(9_000) };
  assert.deepEqual(columnTotal(clean, 'claude:c', r2), { tokens: 500, probed: 1, pending: 0, failed: 0, unmeasurable: 0, partial: false });
  // Pide sesión o no responde: tampoco da cifra -> parcial.
  const r3 = { ...r2, [probeKey('claude:c', gh)]: { status: 'needsAuth' } as McpProbeResult };
  assert.equal(columnTotal(clean, 'claude:c', r3).partial, true);
  // Cuenta sin MCP: total vacío.
  assert.deepEqual(columnTotal(rows, 'claude:e', res), { tokens: 0, probed: 0, pending: 0, failed: 0, unmeasurable: 0, partial: false });
});

test('third-party package runners are detected', () => {
  assert.equal(thirdPartyPackage(def('a', 'f', { command: 'npx', args: ['-y', '@playwright/mcp@latest'] })), '@playwright/mcp@latest');
  assert.equal(thirdPartyPackage(def('a', 'f', { command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['-y', 'pkg'] })), 'pkg');
  assert.equal(thirdPartyPackage(def('a', 'f', { command: 'uvx', args: ['mcp-server-git'] })), 'mcp-server-git');
  assert.equal(thirdPartyPackage(def('a', 'f', { command: 'pnpm', args: ['dlx', 'x-mcp'] })), 'x-mcp');
  assert.equal(thirdPartyPackage(def('a', 'f', { command: 'node', args: ['server.js'] })), null);
  assert.equal(thirdPartyPackage(def('a', 'f', { command: 'npx', args: ['./local'] })), null);
  assert.equal(thirdPartyPackage(def('a', 'f', { transport: 'http', command: null, args: [], url: 'https://x' })), null);
});

test('row cost ignores MCP that are off or not approved (they cost nothing in sessions)', () => {
  const off = def('unity', 'f3', { enabled: false });
  const rows = buildMcpRows([acc('claude:a', [off])]);
  const ok: McpProbeResult = { status: 'ok', tools: 9, serverName: null, version: null, toolsBytes: 6_100, tokensEst: 1_525 };
  assert.equal(rowTokens(rows[0], { [probeKey('claude:a', off)]: ok }), null);
});

test('cell and detail say the same: off / not approved win over any probe; the cell always carries the scope', () => {
  const pend = def('postgres', 'f4', { scope: 'project', projectPath: 'C:/p', enabled: null });
  const failed: McpProbeResult = { status: 'failed', msg: 'Connection refused' };
  const res = { [probeKey('claude:a', pend)]: failed };
  // Detalle (una aparición) y celda (todas): mismo estado y mismo ámbito.
  assert.deepEqual(defStatus(pend, failed), { status: 'pending', scope: 'project' });
  assert.deepEqual(cellView([pend], 'claude:a', res), { status: 'pending', scope: 'project' });
  // Aprobado en otra cuenta: ahí sí manda la prueba.
  const on = { ...pend, enabled: true };
  assert.deepEqual(cellView([on], 'claude:b', { [probeKey('claude:b', on)]: failed }), { status: 'failed', scope: 'project', msg: 'Connection refused' });
  // Sin probar: ámbito + «sin probar»; probado: ámbito + resultado.
  const gh = def('github', 'f1');
  assert.deepEqual(cellView([gh], 'claude:a', {}), { status: 'untested', scope: 'user' });
  assert.deepEqual(cellView([gh], 'claude:a', { [probeKey('claude:a', gh)]: { status: 'ok', tools: 14, serverName: null, version: null, toolsBytes: 1, tokensEst: 1 } }), { status: 'ok', scope: 'user', tools: 14 });
  // Varios proyectos: manda la peor aparición activa; la apagada no tapa a la encendida.
  const a = def('db', 'f6', { scope: 'local', projectPath: 'C:/a', enabled: false });
  const b = def('db', 'f6', { scope: 'local', projectPath: 'C:/b' });
  assert.equal(cellView([a, b], 'claude:a', {})!.status, 'untested');
  assert.equal(cellView(undefined, 'claude:a', {}), null);
  // Gestionado fuera (claude.ai): no se prueba.
  assert.equal(cellView([def('claude.ai X', '0', { scope: 'claudeai', managedBy: 'claude.ai' })], 'claude:a', {})!.status, 'managed');
});

test('probe error classifier: short kind for a translated sentence', () => {
  const pg = 'the server exited before answering initialize (exit code 1). stderr: error: Failed to spawn: `mcp-server-postgres` Caused by: could not connect to server: Connection refused (os error 10061). Is the server running on host "127.0.0.1" and accepting TCP/IP connections on port 5432?';
  assert.deepEqual(classifyProbeError(pg), { kind: 'refused', host: '127.0.0.1:5432' });
  assert.equal(classifyProbeError('could not start uvx: program not found').kind, 'notFound');
  assert.equal(classifyProbeError("'mcp-foo' is not recognized as an internal or external command").kind, 'notFound');
  assert.deepEqual(classifyProbeError('exited with code 3'), { kind: 'exit', code: 3 });
  assert.equal(classifyProbeError('operation timed out').kind, 'timeout');
  assert.equal(classifyProbeError('Error: please log in first').kind, 'auth');
  assert.deepEqual(classifyProbeError('HTTP 404'), { kind: 'http', code: 404 });
  assert.equal(classifyProbeError('network error: dns error: no such host').kind, 'dns');
  assert.equal(classifyProbeError('no answer to initialize').kind, 'other');
});

test('diff de versiones por fragmentos: resalta solo lo que cambia', () => {
  const hl = (a: string, b: string) => diffPieces(a, b).filter((p) => p.changed).map((p) => p.text);
  assert.deepEqual(hl('npx -y @modelcontextprotocol/server-github@0.5.0', 'npx -y @modelcontextprotocol/server-github'), ['@0.5.0']);
  assert.deepEqual(hl('npx -y @modelcontextprotocol/server-github', 'npx -y @modelcontextprotocol/server-github@0.5.0'), []);
  assert.deepEqual(hl('GITHUB_TOKEN=•••', 'GITHUB_PERSONAL_ACCESS_TOKEN=•••'), ['GITHUB_TOKEN']);
  assert.deepEqual(hl('GITHUB_PERSONAL_ACCESS_TOKEN=•••', 'GITHUB_TOKEN=•••'), ['GITHUB_PERSONAL_ACCESS_TOKEN']);
  // Los trozos juntan el texto completo.
  assert.equal(diffPieces('a b@1', 'a b').map((p) => p.text).join(''), 'a b@1');
});

test('desglose del total: qué suma, qué queda fuera y por qué; dos ámbitos cuentan una vez', () => {
  const on = def('gh', 'f1');
  const accounts: McpAccount[] = [{ id: 'c:a', provider: 'claude', dir: 'a', isDefault: false, label: null, source: '', error: null, servers: [
    on, { ...on, scope: 'local', projectPath: 'C:/p' }, def('fs', 'f2'), def('pw', 'f3'), def('off', 'f4', { enabled: false }),
    def('db', 'f5', { scope: 'project', projectPath: 'C:/p', enabled: null }), def('T', 'f6', { scope: 'claudeai', managedBy: 'claude.ai' }), def('ln', 'f7'),
  ] }];
  const rows = buildMcpRows(accounts);
  const ok = (n: number) => ({ status: 'ok' as const, tools: 1, serverName: 'x', version: '1', toolsBytes: n * 4, tokensEst: n });
  const res = { 'c:a|user|gh|': ok(100), 'c:a|local|gh|C:/p': ok(300), 'c:a|user|fs|': { status: 'failed' as const, msg: 'x' }, 'c:a|user|ln|': { status: 'needsAuth' as const } };
  const b = totalBreakdown(rows, 'c:a', res);
  assert.deepEqual(b.counted, [{ name: 'gh', tokens: 300 }]);
  assert.deepEqual(Object.fromEntries(b.out.map((o) => [o.name, o.why])), { db: 'pending', fs: 'failed', ln: 'auth', off: 'off', pw: 'untested', T: 'claudeai' });
  assert.deepEqual(b.multi, [{ name: 'gh', n: 2 }]);
});

test('palabras del comando con su resaltado: el salto de línea solo puede caer entre palabras', () => {
  const w = wordPieces(diffPieces('npx -y @modelcontextprotocol/server-github@0.5.0', 'npx -y @modelcontextprotocol/server-github'));
  assert.deepEqual(w.map((x) => x.map((p) => p.text).join('')), ['npx', '-y', '@modelcontextprotocol/server-github@0.5.0']);
  assert.deepEqual(w[2].filter((p) => p.changed).map((p) => p.text), ['@0.5.0']);
});
