// Switch test sin la app: para las áreas de la UI principal (sidebar, topbar, grid, pane, palette, agents, usage, app)
// comprueba que el texto español difiere del inglés salvo los idénticos a propósito (listados abajo), que las
// claves existen en ambos idiomas y que t()/tk() devuelven cada idioma tras setLocale.
// Uso: node --test scripts/i18n-ui-switch.test.mjs   (Node >= 22.18, ejecuta los .ts directamente)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../src/lib/locales/en/index.ts';
import { es } from '../src/lib/locales/es/index.ts';
import { t, tk, setLocale } from '../src/lib/i18n.ts';

const AREAS = ['sidebar', 'topbar', 'grid', 'pane', 'palette', 'agents', 'usage', 'app'];
const area = (k) => k.split('.')[0];
const mine = Object.keys(en).filter((k) => AREAS.includes(area(k)));

// Idénticos a propósito: nombres, símbolos, abreviaturas técnicas.
const SAME = new Set([
  'sidebar.accounts.auto', // «Claude · auto»
  'grid.empty.auto', // «auto»
  'pane.badgeWithSub', // «{status} · {n} sub»
  'agents.ctx', // «ctx {n}»
  'sidebar.accounts.chip.claude', 'sidebar.accounts.chip.codex', 'sidebar.accounts.chip.opencode', // nombres de producto
  'sidebar.accounts.group.claude', 'sidebar.accounts.group.codex', 'sidebar.accounts.group.opencode', // nombres de producto
  'sidebar.accounts.groupHead', // «{label} ({n})»
]);

test('hay claves de las áreas de UI', () => {
  assert.ok(mine.length > 80, `solo ${mine.length}`);
});

test('el español existe y difiere del inglés (salvo idénticos a propósito)', () => {
  const same = [];
  for (const k of mine) {
    assert.ok(es[k], `falta es ${k}`);
    if (es[k] === en[k]) same.push(k);
  }
  const unexpected = same.filter((k) => !SAME.has(k));
  assert.deepEqual(unexpected, [], `idénticos sin justificar: ${unexpected.join(', ')}`);
  for (const k of SAME) assert.ok(same.includes(k) || !(k in en), `${k} ya no es idéntico: quítalo de SAME`);
});

test('t()/tk() cambian de idioma con setLocale', () => {
  try {
    setLocale('en');
    assert.equal(t('palette.empty'), 'Nothing matches');
    assert.equal(tk('agents.status.waiting'), 'needs permission');
    assert.equal(t('sidebar.activeAgents', { n: 3 }), 'ACTIVE AGENTS (3)');
    setLocale('es');
    assert.equal(t('palette.empty'), 'Sin coincidencias');
    assert.equal(tk('agents.status.waiting'), 'necesita permiso');
    assert.equal(t('sidebar.activeAgents', { n: 3 }), 'AGENTES ACTIVOS (3)');
  } finally {
    setLocale('en');
  }
});

test('todos los estados de agente tienen texto en ambos idiomas', () => {
  for (const s of ['busy', 'waiting', 'idle', 'running', 'shell', 'new']) {
    assert.ok(en[`agents.status.${s}`] && es[`agents.status.${s}`], s);
  }
});

test('el inglés conserva los textos originales de la UI', () => {
  assert.equal(en['topbar.overflowHint'], "Panes that don't fit move to «background» without closing.");
  assert.equal(en['grid.splitTitle'], 'Drag to adjust · double-click to equalize');
  assert.equal(en['pane.exitedCode'].replace('{code}', '1'), 'Process exited (code 1)');
  assert.equal(en['sidebar.connectPlaceholder'], 'Connect: user@host:port  ↵');
});
