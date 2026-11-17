import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clearBackground, glassAlpha, isGlass, windowLook } from './glass.ts';
import { DEFAULTS, LIMITS, SECTION_KEYS, clampSettings } from './settings.ts';
import { THEMES, THEME_IDS } from './themes.ts';
import { buildBackup, parseBackup, serializeBackup } from './backup.ts';

test('por defecto la ventana es opaca y sin efecto (nadie cambia sin querer)', () => {
  assert.equal(DEFAULTS.windowOpacity, 100);
  assert.equal(DEFAULTS.windowEffect, 'none');
  assert.deepEqual(windowLook(DEFAULTS.windowOpacity, DEFAULTS.windowEffect), { glass: false, effect: 'none' });
  assert.equal(glassAlpha(100), 1);
});

test('cristal solo por debajo del 100 %; sin cristal no se pide efecto', () => {
  assert.equal(isGlass(100), false);
  assert.equal(isGlass(99), true);
  assert.equal(isGlass(30), true);
  assert.equal(isGlass(NaN), false);
  assert.deepEqual(windowLook(100, 'acrylic'), { glass: false, effect: 'none' });
  assert.deepEqual(windowLook(80, 'acrylic'), { glass: true, effect: 'acrylic' });
  assert.deepEqual(windowLook(60, 'mica'), { glass: true, effect: 'mica' });
  assert.deepEqual(windowLook(60, 'none'), { glass: true, effect: 'none' });
});

test('el alfa se recorta a 30..100 %', () => {
  assert.equal(glassAlpha(60), 0.6);
  assert.equal(glassAlpha(10), 0.3);
  assert.equal(glassAlpha(250), 1);
  assert.equal(glassAlpha(NaN), 1);
});

test('ajustes: opacidad 30..100 y efecto de la lista; lo raro cae al defecto', () => {
  assert.deepEqual(LIMITS.windowOpacity, [30, 100]);
  assert.equal(clampSettings({ windowOpacity: 5 }).windowOpacity, 30);
  assert.equal(clampSettings({ windowOpacity: 140 }).windowOpacity, 100);
  assert.equal(clampSettings({ windowOpacity: 72.4 }).windowOpacity, 72);
  assert.equal(clampSettings({ windowOpacity: '60' }).windowOpacity, 100);
  assert.equal(clampSettings({ windowEffect: 'mica' }).windowEffect, 'mica');
  assert.equal(clampSettings({ windowEffect: 'acrylic' }).windowEffect, 'acrylic');
  assert.equal(clampSettings({ windowEffect: 'blur' }).windowEffect, 'none');
  // «Restablecer sección» de General las devuelve a opaca
  assert.ok((SECTION_KEYS.general as readonly string[]).includes('windowOpacity'));
  assert.ok((SECTION_KEYS.general as readonly string[]).includes('windowEffect'));
});

test('copia de ajustes: la opacidad y el efecto viajan en export/import', () => {
  const state = {
    settings: { ...DEFAULTS, windowOpacity: 65, windowEffect: 'mica' as const },
    hosts: [], accounts: [], customThemes: [], ignoredDirs: [], activeId: 'w1',
    workspaces: [{ id: 'w1', name: 'Main', cols: [1], rows: [1], panes: [] }],
  };
  const file = buildBackup(state, { appVersion: '0.4.5', now: new Date('2026-11-17T00:00:00Z') });
  const r = parseBackup(serializeBackup(file));
  assert.ok(r.ok);
  assert.equal(r.sections.settings?.windowOpacity, 65);
  assert.equal(r.sections.settings?.windowEffect, 'mica');
});

test('fondo del xterm con cristal: mismo color, alfa 0, en los 21 temas', () => {
  assert.equal(THEME_IDS.length, 21);
  for (const id of THEME_IDS) {
    const bg = THEMES[id].theme.background;
    const c = clearBackground(bg);
    const n = parseInt(bg.slice(1), 16);
    assert.equal(c, `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0)`, id);
  }
  assert.equal(clearBackground('nope'), 'rgba(0,0,0,0)');
});

test('CSS: con alfa 1 los colores de cristal son los de siempre y solo html.glass quita el fondo del body', () => {
  const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8');
  assert.match(css, /--win-a: 1;/);
  assert.match(css, /--bg-g: color-mix\(in srgb, var\(--bg\) calc\(var\(--win-a\) \* 100%\), transparent\);/);
  assert.match(css, /html\.glass, html\.glass body \{ background: transparent; \}/);
  // el body por defecto sigue pintando el fondo opaco
  assert.match(css, /body \{\n  background: var\(--bg\);/);
});
