// Columnas de la vista MCP = cuentas de la barra lateral (mismo nombre visible y traducido, mismo color, mismo orden), y
// la demo del navegador usa UNA sola lista de cuentas para la barra lateral y para la vista MCP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoAccounts, demoMcpBase, DEMO_CODEX_DEFAULT } from './demodata.ts';
import { ACCOUNT_COLORS, claudeAccountName, displayName } from './model.ts';
import type { Account } from './model.ts';
import { CODEX_LAUNCHER_COLOR, CODEX_LAUNCHER_NAME, columnIdentity, orderColumns } from './mcpcols.ts';
import { setLocale } from './i18n.ts';

const labels = { defaultAccount: 'Cuenta por defecto', opencodeGlobal: 'opencode (global)' };

/** Lo que crea la tienda en la demo (syncAccounts + demoProviderAccounts), sin Svelte. */
function sidebarAccounts(q: URLSearchParams): Account[] {
  const out: Account[] = [];
  for (const a of demoAccounts(q).filter((x) => x.provider === 'claude')) {
    out.push({ id: a.dir, name: claudeAccountName(a.dir, a.isDefault), dir: a.dir, isDefault: a.isDefault, provider: 'claude', color: ACCOUNT_COLORS[out.length % ACCOUNT_COLORS.length] });
  }
  for (const a of demoAccounts(q).filter((x) => x.provider !== 'claude')) {
    out.push({ id: a.dir, name: a.name!, dir: a.dir, isDefault: false, provider: a.provider, color: a.color! });
  }
  return out;
}
/** Filas de cuenta de la barra lateral (nombre visible + color), en su orden: por herramienta; el lanzador «Codex
 *  (ChatGPT)» tras las cuentas de Codex si no hay cuenta de Codex por defecto. */
function sidebarRows(accs: Account[]): { name: string; color: string }[] {
  const rows: { name: string; color: string }[] = [];
  for (const p of ['claude', 'codex', 'opencode'] as const) {
    for (const a of accs.filter((x) => x.provider === p)) rows.push({ name: displayName(a.name), color: a.color });
    if (p === 'codex' && !accs.some((x) => x.provider === 'codex' && x.isDefault)) rows.push({ name: CODEX_LAUNCHER_NAME, color: CODEX_LAUNCHER_COLOR });
  }
  return rows;
}

for (const variant of ['', 'mcp6', 'mcp8', 'mcpauth']) {
  test(`demo ${variant || 'normal'}: columnas MCP = cuentas de la barra lateral (nombre traducido, color y orden)`, () => {
    setLocale('es');
    const q = new URLSearchParams(variant);
    const accs = sidebarAccounts(q);
    const cols = orderColumns(demoMcpBase(q), accs).map((a) => {
      const c = columnIdentity(a, accs, labels);
      return { name: c.name, color: c.color };
    });
    assert.deepEqual(cols, sidebarRows(accs));
    assert.ok(cols.some((c) => c.name === 'Principal'), '«Main» se muestra traducido');
    setLocale('en');
  });
}

test('sin cuentas: tampoco hay cuentas en la barra lateral de la demo', () => {
  const q = new URLSearchParams('mcpnone');
  assert.deepEqual(demoAccounts(q), []);
  assert.deepEqual(demoMcpBase(q), []);
});

test('Codex por defecto sin cuenta → «Codex (ChatGPT)»; carpeta ignorada → nombre de la carpeta, sin color', () => {
  const base = { label: null, source: '', servers: [], error: null };
  const def = columnIdentity({ ...base, id: `codex:${DEMO_CODEX_DEFAULT}`, provider: 'codex', dir: DEMO_CODEX_DEFAULT, isDefault: true }, [], labels);
  assert.equal(def.name, 'Codex (ChatGPT)');
  assert.equal(def.color, CODEX_LAUNCHER_COLOR);
  const ign = columnIdentity({ ...base, id: 'claude:C:/x/.claude-zz', provider: 'claude', dir: 'C:/x/.claude-zz', isDefault: false }, [], labels);
  assert.deepEqual([ign.name, ign.color, ign.tool], ['zz', null, 'Claude']);
});

// v6: columnas = filas de cuenta de la barra lateral en TODOS los estados de la demo, también cuando la barra lateral
// guarda cuentas de las que no hay datos MCP (estado guardado de otra sesión: 9 cuentas en la barra y 5 con datos).
import { sidebarColumns, sidebarEntries, sidebarEntryName } from './mcpcols.ts';
const STATES = ['', 'mcp6', 'mcp8', 'mcpauth', 'mcp0', 'mcpnone'];
for (const side of STATES) for (const data of STATES) for (const view of [{ sort: 'manual', group: true }, { sort: 'name', group: false }] as const) {
  test(`columnas = barra lateral: barra «${side || 'normal'}», datos «${data || 'normal'}», orden ${view.sort}${view.group ? ' agrupado' : ''}`, () => {
    setLocale('es');
    const accs = sidebarAccounts(new URLSearchParams(side));
    const entries = sidebarEntries(accs, view, { quota: {}, now: 0 });
    const known = new Set(demoAccounts(new URLSearchParams(data)).map((a) => a.dir));
    const cols = sidebarColumns(demoMcpBase(new URLSearchParams(data)), entries, (a) => known.has(a.dir));
    assert.deepEqual(cols.map((c) => columnIdentity(c, accs, labels).name), entries.map(sidebarEntryName));
    for (const c of cols) {
      const has = c.provider === 'opencode' || (c.provider === 'codex' && c.isDefault) || known.has(c.dir);
      if (data === 'mcpnone') assert.ok(c.unreadable, `sin datos: ${c.dir} atenuada`);
      else assert.equal(!c.unreadable, has, `${c.dir}: atenuada solo si no hay datos`);
      if (c.unreadable && c.provider === 'claude') assert.equal(c.unreadable, 'noSession');
    }
    setLocale('en');
  });
}
