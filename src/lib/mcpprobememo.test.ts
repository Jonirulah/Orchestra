// Resultados de pruebas guardados (v7): vuelven al reabrir la vista; se invalidan si cambia la huella.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agoParts, recallProbes } from './mcpprobememo.ts';
import type { ProbeMemo } from './mcpprobememo.ts';
import { probeKey } from './mcpmatrix.ts';
import { mcpLoginSpec } from './model.ts';
import type { McpAccount, McpDef } from './backend.ts';

const def = (name: string, fingerprint: string) => ({ name, scope: 'user', projectPath: null, fingerprint } as unknown as McpDef);
const acc = (id: string, servers: McpDef[]) => ({ id, servers } as unknown as McpAccount);

test('un resultado guardado vuelve con su hora si la definición no ha cambiado', () => {
  const a = acc('claude:x', [def('github', 'f1'), def('linear', 'f2')]);
  const memo: Record<string, ProbeMemo> = {
    [probeKey('claude:x', def('github', 'f1'))]: { r: { status: 'ok', tools: 26 } as never, at: 1000, fp: 'f1' },
    [probeKey('claude:x', def('linear', 'f2'))]: { r: { status: 'needsAuth' } as never, at: 2000, fp: 'OLD' },
  };
  const { results, at } = recallProbes(memo, [a]);
  assert.deepEqual(Object.keys(results), [probeKey('claude:x', def('github', 'f1'))]);
  assert.equal(at[probeKey('claude:x', def('github', 'f1'))], 1000);
  // Otra cuenta con el mismo nombre no hereda el resultado.
  assert.deepEqual(recallProbes(memo, [acc('claude:y', [def('github', 'f1')])]).results, {});
});

test('«probado hace X»', () => {
  assert.deepEqual(agoParts(30_000), { unit: 'now', n: 0 });
  assert.deepEqual(agoParts(5 * 60_000 + 59_000), { unit: 'min', n: 5 });
  assert.deepEqual(agoParts(3 * 3600_000), { unit: 'h', n: 3 });
  assert.deepEqual(agoParts(2 * 86400_000 + 1), { unit: 'd', n: 2 });
});

test('Iniciar sesión: el comando de cada herramienta con el entorno de la cuenta', () => {
  const codex = { id: 'c1', dir: 'C:/Users/u/.codex-w', isDefault: false, provider: 'codex' as const };
  const s = mcpLoginSpec('codex', codex, 'linear');
  assert.equal(s.args.at(-1), "& codex mcp login 'linear'");
  assert.equal(s.env?.CODEX_HOME, codex.dir);
  assert.equal(mcpLoginSpec('opencode', null, 'linear').args.at(-1), "& opencode mcp auth 'linear'");
  assert.match(mcpLoginSpec('claude', null, 'linear', { hint: '/mcp → linear' }).args.at(-1)!, /^Write-Host '\/mcp → linear' -ForegroundColor Yellow; & claude$/);
});
