import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPlanLine, isReadmePlaceholder, lingering, previewEntries, shownErrors, canApply, copyChange, copyTargets, emptyForm, equalizeTargets, formFromDraft, formToDef, planSummary, relistCheck, removeTargets, resultSummary, validateForm } from './mcpform.ts';
import { buildMcpRows } from './mcpmatrix.ts';
import { parsePasted } from './mcppaste.ts';
import type { McpAccount, McpDef, McpPlanStep } from './backend.ts';

function def(name: string, fingerprint: string, over: Partial<McpDef> = {}): McpDef {
  return {
    name, transport: 'stdio', command: 'npx', args: ['-y', `@x/${name}`], url: null, cwd: null, envKeys: [], headerKeys: [],
    envPassthrough: [], enabled: true, scope: 'user', projectPath: null, rawKind: 'stdio', authStatus: null, disabledIn: [],
    managedBy: null, fingerprint, ...over,
  };
}
function acc(id: string, servers: McpDef[]): McpAccount {
  const provider = id.startsWith('codex') ? 'codex' : id.startsWith('opencode') ? 'opencode' : 'claude';
  return { id, provider, dir: id, isDefault: false, label: null, source: '', servers, error: null };
}

test('pegar del README → formulario → definición para Rust', () => {
  const r = parsePasted('claude mcp add brave -e BRAVE_API_KEY=abc -- npx -y "@modelcontextprotocol/server-brave-search" "dir with space"');
  const f = formFromDraft(r.drafts[0]);
  assert.equal(f.argsText, '-y\n@modelcontextprotocol/server-brave-search\ndir with space');
  assert.deepEqual(validateForm(f, ['claude:a']), []);
  assert.deepEqual(formToDef(f), {
    name: 'brave', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search', 'dir with space'], url: null,
    env: [{ key: 'BRAVE_API_KEY', value: 'abc' }], headers: [], bearerEnvVar: null, scope: 'user', projectPath: null,
  });
  // http: env y comando fuera; filas vacías fuera.
  const h = { ...emptyForm(), name: 'gh', transport: 'http' as const, url: 'https://x/mcp', headers: [{ key: 'X-Key', value: 's' }, { key: ' ', value: '' }], env: [{ key: 'A', value: '1' }], bearerEnvVar: 'TOK' };
  assert.deepEqual(formToDef(h), { name: 'gh', transport: 'http', command: null, args: [], url: 'https://x/mcp', env: [], headers: [{ key: 'X-Key', value: 's' }], bearerEnvVar: 'TOK', scope: 'user', projectPath: null });
  // Ámbito de proyecto: pide carpeta.
  const p = { ...emptyForm(), name: 'db', command: 'uvx', scope: 'project' as const };
  assert.deepEqual(validateForm(p, ['a']), ['project']);
  assert.deepEqual(validateForm({ ...p, project: 'C:/Dev/app' }, ['a']), []);
  assert.equal(formToDef({ ...p, project: ' C:/Dev/app ' }).projectPath, 'C:/Dev/app');
});

test('validación: nombre, comando, URL, claves, cuentas', () => {
  assert.deepEqual(validateForm(emptyForm(), []), ['name', 'command', 'targets']);
  const f = { ...emptyForm(), name: 'ok', transport: 'http' as const, url: 'ftp://x', headers: [{ key: 'bad key', value: 'v' }], bearerEnvVar: '1X' };
  assert.deepEqual(validateForm(f, ['a']), ['url', 'headerKey', 'bearer']);
  assert.deepEqual(validateForm({ ...emptyForm(), name: '-x', command: 'c', env: [{ key: '9A', value: '' }] }, ['a']), ['name', 'envKey']);
});

test('destinos de Aplicar a / Quitar de / Igualar a esta', () => {
  const accounts = [
    acc('claude:a', [def('github', 'f1'), def('unity', 'u1', { scope: 'local', projectPath: 'C:/p' })]),
    acc('claude:b', [def('github', 'f2')]),
    acc('codex:c', [def('github', 'f1')]),
    acc('opencode:global', []),
  ];
  const rows = buildMcpRows(accounts);
  const gh1 = rows.find((r) => r.name === 'github')!.variants.find((v) => v.fingerprint === 'f1')!;
  const unity = rows.find((r) => r.name === 'unity')!;
  assert.deepEqual(copyTargets(gh1, rows, accounts), ['opencode:global']);
  assert.deepEqual(removeTargets(gh1, accounts), ['claude:a', 'codex:c']);
  assert.deepEqual(equalizeTargets(gh1, rows, accounts), ['claude:b']);
  // Ámbito local de Claude: no se quita desde aquí, pero sí se puede copiar al ámbito user de las demás.
  assert.deepEqual(removeTargets(unity, accounts), []);
  assert.deepEqual(copyTargets(unity, rows, accounts), ['claude:a', 'claude:b', 'codex:c', 'opencode:global']);
  const c = copyChange(gh1, accounts, ['claude:b'], true)!;
  assert.deepEqual(c, { kind: 'copy', from: { accountId: 'claude:a', scope: 'user', name: 'github', projectPath: null }, targets: ['claude:b'], replace: true });
  // Gestionado fuera (plugin): no hay origen.
  const p = buildMcpRows([acc('claude:a', [def('sentry', 's', { scope: 'plugin', managedBy: 'plugin:x' })])]);
  assert.equal(copyChange(p[0], [acc('claude:a', [def('sentry', 's', { scope: 'plugin', managedBy: 'plugin:x' })])], ['claude:b'], false), null);
});

test('vista previa: resumen, aplicar solo si hay algo; resultado y comprobación tras relistar', () => {
  const step = (accountId: string, over: Partial<McpPlanStep>): McpPlanStep => ({ accountId, provider: 'claude', action: 'add', file: 'f', lines: ['x'], blocked: null, note: null, ...over });
  const steps = [step('a', {}), step('b', { blocked: 'Codex CLI cannot set HTTP headers' }), step('c', { action: 'skip', note: 'Already there' })];
  assert.deepEqual(planSummary(steps), { apply: 1, skip: 1, blocked: 1 });
  assert.equal(canApply(steps), true);
  assert.equal(canApply(steps.slice(1)), false);
  const results = [
    { accountId: 'a', status: 'ok' as const, msg: 'Added', verified: true },
    { accountId: 'b', status: 'skipped' as const, msg: 'blocked', verified: null },
    { accountId: 'd', status: 'failed' as const, msg: 'boom', verified: false },
  ];
  assert.deepEqual(resultSummary(results), { ok: 1, failed: 1, skipped: 1 });
  const change = { kind: 'add' as const, def: formToDef({ ...emptyForm(), name: 'gh', command: 'npx' }), targets: ['a', 'b', 'd'], replace: false };
  assert.deepEqual(relistCheck(change, results, [acc('a', [def('gh', 'f')])]), { a: true });
  assert.deepEqual(relistCheck(change, results, [acc('a', [])]), { a: false });
  assert.deepEqual(relistCheck({ kind: 'remove', name: 'gh', targets: ['a'] }, results, [acc('a', [])]), { a: true });
});

test('validación diferida: el formulario recién abierto no enseña ningún error; al salir de un campo, solo el suyo; al pedir la vista previa, todos', () => {
  const errs = validateForm(emptyForm(), []);
  assert.deepEqual(errs, ['name', 'command', 'targets']);
  assert.deepEqual(shownErrors(errs, {}, false), [], 'recién abierto: nada en rojo');
  assert.deepEqual(shownErrors(errs, { name: true }, false), ['name'], 'tras salir del nombre');
  assert.deepEqual(shownErrors(errs, { url: true }, false), [], 'un campo tocado que está bien no enseña nada');
  assert.deepEqual(shownErrors(errs, {}, true), ['name', 'command', 'targets'], 'tras pulsar Vista previa');
});

// Caso de la crítica v3 (grave 4): A en Main y Work, B en b → «Igualar a A» toca SOLO b; Main y Work «sin cambios».
test('igualar a A: solo la cuenta con B cambia; las que ya tienen A salen como sin cambios', () => {
  const A = def('github', 'aaaa', { envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'] });
  const B = def('github', 'bbbb', { args: ['-y', '@x/github@0.5.0'], envKeys: ['GITHUB_TOKEN'] });
  const accounts = [acc('claude:main', [A]), acc('codex:work', [{ ...A }]), acc('claude:b', [B])];
  const rows = buildMcpRows(accounts);
  const [vA, vB] = rows[0].variants;
  assert.equal(vA.letter, 'A');
  assert.equal(vA.def.fingerprint, 'aaaa');
  const targets = equalizeTargets(vA, rows, accounts);
  assert.deepEqual(targets, ['claude:b']);
  const change = copyChange(vA, accounts, targets, true)!;
  assert.deepEqual(change.targets, ['claude:b']);
  const steps: McpPlanStep[] = [{ accountId: 'claude:b', provider: 'claude', action: 'replace', file: 'b/.claude.json', lines: ['claude mcp remove github --scope user', "claude mcp add-json github '{}' --scope user"], blocked: null, note: null }];
  const p = previewEntries(change, steps, accounts, rows, vA);
  assert.deepEqual(p.map((e) => [e.accountId, e.kind, e.from.join(''), e.to, e.untouched]), [
    ['claude:main', 'same', '', 'A', true],
    ['codex:work', 'same', '', 'A', true],
    ['claude:b', 'replace', 'B', 'A', false],
  ]);
  // Y al revés: igualar a B toca Main y Work, no b.
  assert.deepEqual(equalizeTargets(vB, rows, accounts), ['claude:main', 'codex:work']);
});

// Grave 5: una cuenta con la misma definición en dos ámbitos (usuario + local de un proyecto). «Quitar» toca solo el
// de usuario, dice qué ámbito y fichero, y que el local se queda.
test('quitar con el mismo MCP en dos ámbitos dice cuál toca (ámbito y fichero) y cuál se queda', () => {
  const A = def('github', 'aaaa');
  const local = { ...A, scope: 'local' as const, projectPath: 'C:/Dev/game' };
  const accounts = [acc('claude:main', [A, local]), acc('claude:b', [{ ...local }])];
  const rows = buildMcpRows(accounts);
  const v = rows[0].variants[0];
  assert.equal(rows[0].variants.length, 1);
  assert.deepEqual(removeTargets(v, accounts), ['claude:main']);
  const steps: McpPlanStep[] = [{ accountId: 'claude:main', provider: 'claude', action: 'remove', file: 'C:/Users/u/.claude.json', lines: ['claude mcp remove github --scope user'], blocked: null, note: null }];
  const [e] = previewEntries({ kind: 'remove', name: 'github', targets: ['claude:main'] }, steps, accounts, rows, v);
  assert.equal(e.kind, 'remove');
  assert.equal(e.scope, 'user');
  assert.equal(e.file, 'C:/Users/u/.claude.json');
  assert.deepEqual(e.keeps.map((d) => [d.scope, d.projectPath]), [['local', 'C:/Dev/game']]);
});

test('vista previa: bloqueado, misma definición y salto llevan su motivo', () => {
  const A = def('x', 'f1');
  const accounts = [acc('claude:a', [A]), acc('codex:c', []), acc('opencode:global', [])];
  const rows = buildMcpRows(accounts);
  const steps: McpPlanStep[] = [
    { accountId: 'codex:c', provider: 'codex', action: 'add', file: 'c', lines: [], blocked: 'Codex CLI cannot set HTTP headers', note: null },
    { accountId: 'claude:a', provider: 'claude', action: 'skip', file: 'a', lines: [], blocked: null, note: 'Already there with the same definition' },
    { accountId: 'opencode:global', provider: 'opencode', action: 'add', file: 'o', lines: ['opencode.json: mcp.x = {}'], blocked: null, note: null },
  ];
  const p = previewEntries({ kind: 'copy', from: { accountId: 'claude:a', scope: 'user', name: 'x', projectPath: null }, targets: ['codex:c', 'claude:a', 'opencode:global'], replace: false }, steps, accounts, rows, rows[0].variants[0]);
  assert.deepEqual(p.map((e) => [e.accountId, e.kind, e.scope]), [['claude:a', 'same', 'user'], ['codex:c', 'blocked', 'user'], ['opencode:global', 'add', 'global']]);
  assert.match(p[1].reason!, /headers/);
});

test('comandos de la vista previa: el JSON sale formateado en varias líneas', () => {
  const f = formatPlanLine(`CLAUDE_CONFIG_DIR=C:\\x claude mcp add-json gh '{"args":["-y","a"],"type":"stdio"}' --scope user`);
  assert.equal(f.head, "CLAUDE_CONFIG_DIR=C:\\x claude mcp add-json gh '");
  assert.equal(f.json, '{\n  "args": [\n    "-y",\n    "a"\n  ],\n  "type": "stdio"\n}');
  assert.equal(f.tail, "' --scope user");
  const o = formatPlanLine('opencode.json: mcp.fs = {"enabled":true}');
  assert.equal(o.head, 'opencode.json: mcp.fs = ');
  assert.equal(o.json, '{\n  "enabled": true\n}');
  assert.deepEqual(formatPlanLine('codex mcp remove gh'), { head: 'codex mcp remove gh', json: null, tail: '' });
});

test('Quitar / Igualar: qué copias del ámbito local o de proyecto siguen activas (y cuáles se pueden incluir)', () => {
  const A = def('github', 'A');
  const B = def('github', 'B');
  const accounts = [
    acc('claude:main', [A, { ...A, scope: 'local', projectPath: 'C:/Dev/game' }]),
    acc('claude:b', [B, { ...A, scope: 'local', projectPath: 'C:/Dev/orchestra' }, { ...B, scope: 'project', projectPath: 'C:/Dev/web', enabled: true }]),
    acc('codex:w', [A]),
  ];
  const rows = buildMcpRows(accounts);
  const vA = rows[0].variants.find((v) => v.fingerprint === 'A')!;
  // Quitar A de Main: Main seguirá usando A desde C:/Dev/game; con includeLocal, ya no.
  const rm = { kind: 'remove' as const, name: 'github', targets: ['claude:main'] };
  assert.deepEqual(lingering(rm, accounts, rows, vA).map((l) => [l.accountId, l.letter, l.scope, l.path, l.removable]), [['claude:main', 'A', 'local', 'C:/Dev/game', true]]);
  assert.deepEqual(lingering(rm, accounts, rows, vA, true), []);
  // Igualar a A: b seguirá usando B desde C:/Dev/web (proyecto: no se puede incluir); su local ya es A.
  const eq = copyChange(vA, accounts, ['claude:b'], true)!;
  const l = lingering(eq, accounts, rows, vA, true);
  assert.deepEqual(l.map((x) => [x.accountId, x.letter, x.scope, x.removable]), [['claude:b', 'B', 'project', false]]);
  // Sin incluir el local: las copias locales que YA son A no cuentan (Main en C:/Dev/game, b en C:/Dev/orchestra).
  assert.deepEqual(lingering(eq, accounts, rows, vA).map((x) => [x.accountId, x.scope]), [['claude:b', 'project']]);
  // Aplicar a (sin sustituir) y añadir: nada que avisar.
  assert.deepEqual(lingering(copyChange(vA, accounts, ['codex:w'], false)!, accounts, rows, vA), []);
});

test('marcador del README (YOUR_KEY, <token>, xxx…): campo en rojo y sin vista previa hasta cambiarlo', () => {
  for (const v of ['YOUR_KEY', 'your-api-key', '<token>', '<YOUR_GITHUB_PAT>', 'xxx', 'xxxxxxxx', 'sk-xxxx', 'ghp_...', '[API_KEY]', '{{TOKEN}}', 'changeme', 'my_token', '...', 'API_KEY_HERE'])
    assert.ok(isReadmePlaceholder(v), v);
  for (const v of ['bsk-9f2e7c1a55d04b8e', 'ghp_A1b2C3d4E5f6G7h8', '${GITHUB_TOKEN}', '{env:TOKEN}', 'Bearer abc.def', 'production', 'C:\Dev', ''])
    assert.ok(!isReadmePlaceholder(v), v);
  const f = formFromDraft(parsePasted('claude mcp add brave -e BRAVE_API_KEY=YOUR_KEY -- npx -y server-brave').drafts[0]);
  assert.ok(validateForm(f, ['claude:a']).includes('placeholder'));
  f.env[0].value = 'bsk-9f2e7c1a55d04b8e';
  assert.deepEqual(validateForm(f, ['claude:a']), []);
  f.argsText += '\n--api-key=<token>';
  assert.ok(validateForm(f, ['claude:a']).includes('placeholder'));
});
