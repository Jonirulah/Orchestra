// i18n de la sección MCP de Ajustes (settings.mcp.*) y de la etiqueta «Alt+flechas» de los atajos.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { en } from './locales/en/index.ts';
import { es } from './locales/es/index.ts';
import { setLocale } from './i18n.ts';
import { SHORTCUTS, comboText } from './shortcuts.ts';
import { claudeAddCommand } from './mcpsync.ts';

afterEach(() => setLocale('en'));

const E = en as Record<string, string>;
const S = es as Record<string, string>;
const keys = Object.keys(E).filter((k) => k.startsWith('settings.mcp.'));
// Iguales en los dos idiomas a propósito: «Token» se escribe igual y no se traduce.
const SAME = new Set(['settings.mcp.tokenLabel']);
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('settings.mcp.*: Spanish differs from English (except the listed ones) and {vars} match', () => {
  assert.ok(keys.length >= 35, `only ${keys.length} keys`);
  const same = keys.filter((k) => E[k] === S[k]);
  assert.deepEqual(same.filter((k) => !SAME.has(k)), []);
  assert.deepEqual([...SAME].filter((k) => !same.includes(k)), [], 'allow-list entry that is actually translated');
  for (const k of keys) assert.deepEqual(vars(S[k]), vars(E[k]), k);
});

test('settings.mcp: untranslatable terms survive in Spanish', () => {
  assert.match(S['settings.mcp.enableHint'], /MCP/);
  assert.match(S['settings.mcp.statusListening'], /<code>127\.0\.0\.1:\{port\}<\/code>/);
  assert.match(E['settings.mcp.statusListening'], /<code>127\.0\.0\.1:\{port\}<\/code>/);
  // Texto de HTML: solo <code>; nada más de marcado en ninguna clave.
  for (const k of keys) {
    for (const text of [E[k], S[k]]) assert.deepEqual((text.match(/<[^>]+>/g) ?? []).filter((x) => !/^<\/?code>$/.test(x)), [], k);
  }
});

test('the "claude mcp add" command is protocol text and is not localized', () => {
  setLocale('es');
  assert.equal(claudeAddCommand('http://127.0.0.1:1/mcp', 'T'),
    'claude mcp add --transport http orchestra http://127.0.0.1:1/mcp --header "Authorization: Bearer T"');
});

test('shortcuts: Alt+Arrow keys in English, Alt+flechas in Spanish, other combos untouched', () => {
  const combos = SHORTCUTS.flatMap((g) => g.items.map((i) => i.keys));
  const arrows = combos.filter((k) => k.includes('{arrows}'));
  assert.deepEqual(arrows, ['Alt+{arrows}']);
  assert.ok(combos.includes('Ctrl+,'));
  setLocale('en');
  assert.ok(combos.map(comboText).includes('Alt+Arrow keys'));
  setLocale('es');
  const esCombos = combos.map(comboText);
  assert.ok(esCombos.includes('Alt+flechas'));
  assert.ok(!esCombos.includes('Alt+Arrow keys'));
  // El resto de combinaciones no cambia con el idioma.
  assert.deepEqual(esCombos.filter((c) => c !== 'Alt+flechas'), combos.filter((c) => !c.includes('{arrows}')));
  assert.ok(combos.every((c) => !/[{}]/.test(comboText(c))));
});
