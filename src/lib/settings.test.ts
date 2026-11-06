import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  APP_VERSION, DEFAULTS, SECTION_KEYS, cacheThresholds, clampSettings, fontStack, hexAlpha, parseImport, resetSection,
} from './settings.ts';
import { THEMES, THEME_IDS, themeOf } from './themes.ts';
import { SHORTCUTS } from './shortcuts.ts';

test('defaults are valid: clamping them changes nothing', () => {
  assert.deepEqual(clampSettings(DEFAULTS), DEFAULTS);
});

test('out-of-range numbers are clamped, invalid ones fall back', () => {
  const s = clampSettings({ fontSize: 99, lineHeight: 0.2, scanIntervalSec: 0, cacheWarnMin: 500, sidebarWidth: 5 });
  assert.equal(s.fontSize, 24);
  assert.equal(s.lineHeight, 1.0);
  assert.equal(s.scanIntervalSec, 1);
  assert.equal(s.cacheWarnMin, 30);
  assert.equal(s.sidebarWidth, 210);
  assert.equal(clampSettings({ fontSize: 3 }).fontSize, 9);
  assert.equal(clampSettings({ scrollback: 7777 }).scrollback, DEFAULTS.scrollback);
  assert.equal(clampSettings({ scrollback: 'many' }).scrollback, DEFAULTS.scrollback);
  assert.equal(clampSettings({ scrollback: 25000 }).scrollback, 25000);
  assert.equal(clampSettings({ fontSize: NaN }).fontSize, DEFAULTS.fontSize);
  assert.equal(clampSettings({ fontSize: '14' }).fontSize, DEFAULTS.fontSize);
  assert.equal(clampSettings({ lineHeight: 1.23456 }).lineHeight, 1.23);
});

test('invalid enums, colors and types fall back to defaults', () => {
  const s = clampSettings({
    cursorStyle: 'star', rightClick: 7, bell: null, theme: 'nope', accountPolicy: 'chaos',
    accent: 'red', closeToTray: 'yes', copyOnSelect: 1, agentCwd: 42,
  });
  assert.equal(s.cursorStyle, DEFAULTS.cursorStyle);
  assert.equal(s.rightClick, DEFAULTS.rightClick);
  assert.equal(s.bell, DEFAULTS.bell);
  assert.equal(s.theme, DEFAULTS.theme);
  assert.equal(s.accountPolicy, DEFAULTS.accountPolicy);
  assert.equal(s.accent, DEFAULTS.accent);
  assert.equal(s.closeToTray, true);
  assert.equal(s.copyOnSelect, false);
  assert.equal(s.agentCwd, '');
  assert.equal(clampSettings({ accent: '#AABBCC' }).accent, '#aabbcc');
});

test('an old saved state without the new keys gets defaults and keeps its own values', () => {
  const old = { fontSize: 16, scrollback: 10000, closeToTray: false, sidebarWidth: 340, sidebarOpen: false, accountPolicy: 'most-free', agentCwd: 'E:\\work', lastAccountId: 'acc_1' };
  const s = clampSettings(old);
  assert.equal(s.fontSize, 16);
  assert.equal(s.scrollback, 10000);
  assert.equal(s.closeToTray, false);
  assert.equal(s.sidebarWidth, 340);
  assert.equal(s.sidebarOpen, false);
  assert.equal(s.accountPolicy, 'most-free');
  assert.equal(s.agentCwd, 'E:\\work');
  assert.equal(s.lastAccountId, 'acc_1');
  assert.equal(s.theme, DEFAULTS.theme);
  assert.equal(s.confirmClose, true);
  assert.equal(s.cacheWarnMin, 5);
  assert.equal(s.scanIntervalSec, 2);
});

test('unknown keys are dropped', () => {
  const s = clampSettings({ fontSize: 14, hacker: 'x', __proto__: { evil: 1 }, constructor: 'y' }) as unknown as Record<string, unknown>;
  assert.equal(s.hacker, undefined);
  assert.equal(s.evil, undefined);
  assert.deepEqual(Object.keys(s).filter((k) => !(k in DEFAULTS)), []);
});

test('garbage input gives the defaults and never throws', () => {
  for (const g of [null, undefined, 'text', 42, true, [], [1, 2], () => 1, Symbol('x')]) {
    assert.deepEqual(clampSettings(g), DEFAULTS);
  }
});

test('JSON round-trip keeps every setting', () => {
  const s = clampSettings({
    ...DEFAULTS, fontFamily: 'Fira Code', fontSize: 17, lineHeight: 1.3, cursorStyle: 'block', cursorBlink: false,
    scrollback: 50000, copyOnSelect: true, rightClick: 'paste', bell: 'none', theme: 'dracula', accent: '#6cb2ff',
    confirmClose: false, notifyPermission: false, notifyDone: false, scanIntervalSec: 7, cacheWarnMin: 12,
    accountPolicy: 'round-robin', agentCwd: 'E:\\x', lastAccountId: 'abc',
  });
  assert.deepEqual(clampSettings(JSON.parse(JSON.stringify(s))), s);
  assert.equal(s.theme, 'dracula');
});

test('parseImport merges over the current settings and reports problems', () => {
  const cur = { ...DEFAULTS, fontSize: 20 };
  const ok = parseImport('{"theme":"gruvbox","fontSize":99,"bogus":1}', cur);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.settings.theme, 'gruvbox');
    assert.equal(ok.settings.fontSize, 24);
    assert.equal(ok.settings.cursorStyle, cur.cursorStyle);
    assert.deepEqual(ok.ignored, ['bogus']);
  }
  const keep = parseImport('{"theme":"onedark"}', cur);
  assert.ok(keep.ok && keep.settings.fontSize === 20);
  for (const bad of ['{nope', '[1,2]', '"x"', 'null', '{}', '{"bogus":1}']) assert.equal(parseImport(bad, cur).ok, false, bad);
});

test('resetSection only touches its own keys', () => {
  const cur = clampSettings({ ...DEFAULTS, fontSize: 20, theme: 'dracula', closeToTray: false, cacheWarnMin: 9, sidebarWidth: 400 });
  const t = resetSection(cur, 'terminal');
  assert.equal(t.fontSize, DEFAULTS.fontSize);
  assert.equal(t.theme, DEFAULTS.theme);
  assert.equal(t.closeToTray, false);
  assert.equal(t.cacheWarnMin, 9);
  const a = resetSection(cur, 'agents');
  assert.equal(a.cacheWarnMin, DEFAULTS.cacheWarnMin);
  assert.equal(a.fontSize, 20);
  assert.equal(resetSection(cur, 'general').sidebarWidth, 400);
  for (const keys of Object.values(SECTION_KEYS)) for (const k of keys) assert.ok(k in DEFAULTS, k);
});

test('sshHostKeyPolicy: default is the secure one; junk falls back; valid values pass; old settings load', () => {
  assert.equal(DEFAULTS.sshHostKeyPolicy, 'confirm');
  assert.equal(clampSettings({}).sshHostKeyPolicy, 'confirm');
  assert.equal(clampSettings({ sshHostKeyPolicy: 'accept-new' }).sshHostKeyPolicy, 'accept-new');
  assert.equal(clampSettings({ sshHostKeyPolicy: 'confirm' }).sshHostKeyPolicy, 'confirm');
  for (const bad of ['yes', 'no', '', 'default', 1, null, true, {}, ['accept-new']]) {
    assert.equal(clampSettings({ sshHostKeyPolicy: bad }).sshHostKeyPolicy, 'confirm', String(bad));
  }
  // Ajustes guardados por una versión sin el campo.
  const { sshHostKeyPolicy: _drop, ...old } = DEFAULTS;
  assert.equal(clampSettings(old).sshHostKeyPolicy, 'confirm');
});

test('sshHostKeyPolicy: Reset section (SSH keys) restores it and touches nothing else; import accepts it', () => {
  const cur = { ...DEFAULTS, sshHostKeyPolicy: 'accept-new' as const, fontSize: 20 };
  const r = resetSection(cur, 'sshkeys');
  assert.equal(r.sshHostKeyPolicy, 'confirm');
  assert.equal(r.fontSize, 20);
  assert.ok(SECTION_KEYS.sshkeys.includes('sshHostKeyPolicy' as never)); // la sección SSH ahora también lleva la reconexión y la latencia (test más abajo)
  const imp = parseImport('{"sshHostKeyPolicy":"accept-new"}', DEFAULTS);
  assert.ok(imp.ok && imp.settings.sshHostKeyPolicy === 'accept-new');
  const bad = parseImport('{"sshHostKeyPolicy":"never"}', DEFAULTS);
  assert.ok(bad.ok && bad.settings.sshHostKeyPolicy === 'confirm');
});

test('fontStack puts the choice first, keeps the old fallbacks, never duplicates', () => {
  assert.equal(fontStack('Cascadia Code'), "'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', 'Consolas', monospace");
  assert.equal(fontStack('Fira Code').split(', ')[0], "'Fira Code'");
  assert.equal(fontStack("'My Font', monospace").split(', ')[0], "'My Font'");
  assert.equal(fontStack("'My Font', monospace").match(/monospace/g)?.length, 1);
  assert.equal(fontStack('consolas').match(/onsolas/gi)?.length, 1);
});

test('accent helpers and cache thresholds', () => {
  assert.equal(hexAlpha('#f5b942', 0.14), 'rgba(245, 185, 66, 0.14)');
  assert.equal(hexAlpha('nonsense', 0.14), 'rgba(245, 185, 66, 0.14)');
  assert.deepEqual(cacheThresholds(5), { hot: 300, warm: 1200 });
  assert.deepEqual(cacheThresholds(10), { hot: 600, warm: 2400 });
  assert.deepEqual(cacheThresholds(999), { hot: 1800, warm: 7200 });
});

test('every theme has the full palette', () => {
  assert.ok(THEME_IDS.length >= 5);
  for (const id of THEME_IDS) {
    const t = THEMES[id].theme as Record<string, string>;
    assert.equal(Object.keys(t).length, 21, id);
    for (const v of Object.values(t)) assert.match(v, /^(#[0-9a-f]{6}|rgba\(.+\))$/i, id);
  }
  assert.equal(themeOf('nope'), THEMES.orchestra.theme);
});

test('APP_VERSION matches tauri.conf.json and Ctrl+, is documented', () => {
  const conf = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.equal(APP_VERSION, conf.version);
  assert.ok(SHORTCUTS.some((g) => g.items.some((i) => i.keys === 'Ctrl+,')));
});

test('auto-compact settings: off by default, clamped, reset with the agents section', () => {
  assert.equal(DEFAULTS.autoCompact, false);
  assert.equal(DEFAULTS.autoCompactCtxK, 150);
  assert.equal(DEFAULTS.autoCompactAfterMin, 50);
  assert.equal(DEFAULTS.autoCompactUserIdleMin, 5);
  const lo = clampSettings({ autoCompactCtxK: 1, autoCompactAfterMin: 1, autoCompactUserIdleMin: 0 });
  assert.deepEqual([lo.autoCompactCtxK, lo.autoCompactAfterMin, lo.autoCompactUserIdleMin], [50, 20, 1]);
  const hi = clampSettings({ autoCompactCtxK: 9999, autoCompactAfterMin: 90, autoCompactUserIdleMin: 600 });
  assert.deepEqual([hi.autoCompactCtxK, hi.autoCompactAfterMin, hi.autoCompactUserIdleMin], [800, 55, 60]);
  assert.equal(clampSettings({ autoCompact: 'yes' }).autoCompact, false);
  assert.equal(clampSettings({ autoCompact: true }).autoCompact, true);
  assert.equal(clampSettings({ autoCompactAfterMin: NaN }).autoCompactAfterMin, 50);
  const cur = clampSettings({ autoCompact: true, autoCompactCtxK: 400, autoCompactAfterMin: 30, autoCompactUserIdleMin: 20, fontSize: 20 });
  const a = resetSection(cur, 'agents');
  assert.equal(a.autoCompact, false);
  assert.equal(a.autoCompactCtxK, 150);
  assert.equal(a.autoCompactAfterMin, 50);
  assert.equal(a.autoCompactUserIdleMin, 5);
  assert.equal(a.fontSize, 20);
});

test('MCP settings: on by default, local terminals hidden by default, junk falls back', () => {
  assert.equal(DEFAULTS.mcpEnabled, true);
  assert.equal(DEFAULTS.mcpExposeLocal, false);
  const s = clampSettings({ mcpEnabled: false, mcpExposeLocal: true });
  assert.equal(s.mcpEnabled, false);
  assert.equal(s.mcpExposeLocal, true);
  const bad = clampSettings({ mcpEnabled: 'yes', mcpExposeLocal: 1 });
  assert.equal(bad.mcpEnabled, true);
  assert.equal(bad.mcpExposeLocal, false);
});

test('language setting: English by default, junk falls back, reset with the general section', () => {
  assert.equal(DEFAULTS.language, 'en');
  assert.equal(clampSettings({ language: 'es' }).language, 'es');
  assert.equal(clampSettings({ language: 'system' }).language, 'system');
  for (const bad of ['fr', '', 3, null, undefined, {}]) assert.equal(clampSettings({ language: bad }).language, 'en', String(bad));
  assert.equal(clampSettings({}).language, 'en');
  assert.equal(resetSection(clampSettings({ language: 'es', fontSize: 20 }), 'general').language, 'en');
  assert.equal(resetSection(clampSettings({ language: 'es' }), 'terminal').language, 'es');
});

test('a custom theme id is accepted in settings; malformed ids still fall back', () => {
  assert.equal(clampSettings({ theme: 'custom:my-theme' }).theme, 'custom:my-theme');
  assert.equal(clampSettings({ theme: 'custom:Bad Id' }).theme, DEFAULTS.theme);
  assert.equal(clampSettings({ theme: 'custom:' }).theme, DEFAULTS.theme);
});

test('usage query: off by default, interval clamped 2..30, reset with the agents section', () => {
  assert.equal(DEFAULTS.usageQuery, false);
  assert.equal(DEFAULTS.usageQueryMin, 5);
  assert.equal(clampSettings({}).usageQuery, false);
  assert.equal(clampSettings({ usageQuery: 'yes' }).usageQuery, false);
  assert.equal(clampSettings({ usageQuery: 1 }).usageQuery, false);
  assert.equal(clampSettings({ usageQuery: true }).usageQuery, true);
  assert.equal(clampSettings({ usageQueryMin: 0 }).usageQueryMin, 2);
  assert.equal(clampSettings({ usageQueryMin: 999 }).usageQueryMin, 30);
  assert.equal(clampSettings({ usageQueryMin: 'x' }).usageQueryMin, 5);
  assert.equal(clampSettings({ usageQueryMin: NaN }).usageQueryMin, 5);
  assert.equal(clampSettings({ usageQueryMin: 12 }).usageQueryMin, 12);
  const cur = clampSettings({ usageQuery: true, usageQueryMin: 20, fontSize: 20 });
  const a = resetSection(cur, 'agents');
  assert.equal(a.usageQuery, false);
  assert.equal(a.usageQueryMin, 5);
  assert.equal(a.fontSize, 20);
  assert.ok(SECTION_KEYS.agents.includes('usageQuery' as never));
});

test('usage query can never be switched on by importing settings JSON (it needs the confirmation in the dialog)', () => {
  const cur = clampSettings({});
  const r = parseImport('{"usageQuery":true,"usageQueryMin":9,"fontSize":15}', cur);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.settings.usageQuery, false);
    assert.equal(r.settings.usageQueryMin, 9);
    assert.equal(r.settings.fontSize, 15);
    assert.ok(!r.applied.includes('usageQuery'));
    assert.ok(r.ignored.includes('usageQuery'));
  }
  // solo ese campo: no hay nada que aplicar
  assert.equal(parseImport('{"usageQuery":true}', cur).ok, false);
  // y si ya estaba encendida, importar otra cosa no la apaga
  const on = clampSettings({ usageQuery: true });
  const r2 = parseImport('{"fontSize":14}', on);
  assert.ok(r2.ok && r2.settings.usageQuery === true);
});

// ---------- SSH: reconexión automática e insignia de latencia ----------

const NUM_RANGES: Record<string, [number, number, number]> = {
  // clave: [mín, máx, por defecto]
  sshReconnectMaxAttempts: [0, 50, 8],
  sshReconnectFirstDelaySec: [1, 60, 2],
  sshReconnectFactor: [1, 4, 2],
  sshReconnectMaxDelaySec: [5, 600, 30],
  sshReconnectMinUpSec: [0, 300, 10],
  latencyIntervalSec: [2, 60, 5],
  latencyTimeoutSec: [1, 10, 2],
  latencyWarnMs: [1, 2000, 80],
  latencyBadMs: [2, 5000, 200],
  latencySamples: [5, 120, 30],
  latencyFailsBad: [1, 10, 3],
};

test('ssh connection settings: documented defaults', () => {
  const d = DEFAULTS as unknown as Record<string, unknown>;
  for (const [k, [, , def]] of Object.entries(NUM_RANGES)) assert.equal(d[k], def, k);
  assert.equal(DEFAULTS.sshAutoReconnect, true);
  assert.equal(DEFAULTS.sshReconnectCodes, 'nonzero');
  assert.equal(DEFAULTS.sshReconnectFlash, true);
  assert.equal(DEFAULTS.latencyBadge, true);
  assert.equal(DEFAULTS.latencyShowUnit, true);
});

test('ssh connection settings: every number is clamped to its range, junk falls back to the default, old states load with defaults', () => {
  for (const [k, [lo, hi, def]] of Object.entries(NUM_RANGES)) {
    const get = (v: unknown) => (clampSettings({ [k]: v, ...(k === 'latencyBadMs' ? { latencyWarnMs: 1 } : {}) }) as unknown as Record<string, number>)[k]; // warn=1 para que la corrección warn<bad no se mezcle
    assert.equal(get(lo), lo, `${k} min`);
    assert.equal(get(hi), hi, `${k} max`);
    assert.equal(get(lo - 1000), lo, `${k} below`);
    if (k !== 'latencyWarnMs') assert.equal(get(hi + 100000), hi, `${k} above`);
    for (const bad of ['x', NaN, null, undefined, {}, Infinity]) assert.equal(get(bad), def, `${k} ${String(bad)}`);
  }
  assert.equal(clampSettings({ sshReconnectFactor: 1.46 }).sshReconnectFactor, 1.5, 'factor keeps one decimal');
  assert.equal(clampSettings({ sshReconnectMaxAttempts: 0 }).sshReconnectMaxAttempts, 0, '0 = unlimited is allowed');
  const old: Record<string, unknown> = { ...DEFAULTS };
  for (const k of [...Object.keys(NUM_RANGES), 'sshAutoReconnect', 'sshReconnectCodes', 'sshReconnectFlash', 'latencyBadge', 'latencyShowUnit']) delete old[k];
  const s = clampSettings(old) as unknown as Record<string, unknown>;
  for (const [k, [, , def]] of Object.entries(NUM_RANGES)) assert.equal(s[k], def, k);
});

test('ssh connection settings: booleans and the exit-code choice reject junk', () => {
  for (const k of ['sshAutoReconnect', 'sshReconnectFlash', 'latencyBadge', 'latencyShowUnit'] as const) {
    const d = DEFAULTS[k];
    assert.equal(clampSettings({ [k]: !d })[k], !d, k);
    for (const bad of ['yes', 1, 0, null, {}]) assert.equal(clampSettings({ [k]: bad })[k], d, `${k} ${String(bad)}`);
  }
  assert.equal(clampSettings({ sshReconnectCodes: '255' }).sshReconnectCodes, '255');
  assert.equal(clampSettings({ sshReconnectCodes: 'nonzero' }).sshReconnectCodes, 'nonzero');
  for (const bad of ['all', 255, '', null, undefined]) assert.equal(clampSettings({ sshReconnectCodes: bad }).sshReconnectCodes, 'nonzero', String(bad));
});

test('latency thresholds: bad is always above warn (corrected, never the other way round)', () => {
  const c = (warn: number, bad: number) => clampSettings({ latencyWarnMs: warn, latencyBadMs: bad });
  let s = c(80, 200);
  assert.deepEqual([s.latencyWarnMs, s.latencyBadMs], [80, 200]);
  s = c(300, 200);
  assert.deepEqual([s.latencyWarnMs, s.latencyBadMs], [300, 301]);
  s = c(100, 100);
  assert.deepEqual([s.latencyWarnMs, s.latencyBadMs], [100, 101]);
  s = c(2000, 2);
  assert.deepEqual([s.latencyWarnMs, s.latencyBadMs], [2000, 2001]);
  s = c(5000, 5000);
  assert.deepEqual([s.latencyWarnMs, s.latencyBadMs], [2000, 5000], 'warn is clamped to 2000 first, bad then fits');
  // y es estable: volver a validar no cambia nada
  for (const x of [c(300, 200), c(100, 100), c(2000, 2)]) assert.deepEqual(clampSettings(x), x);
});

test('Reset section (SSH) restores every reconnect/latency setting and nothing outside the section', () => {
  const cur = clampSettings({
    sshAutoReconnect: false, sshReconnectMaxAttempts: 0, sshReconnectFirstDelaySec: 9, sshReconnectFactor: 3, sshReconnectMaxDelaySec: 100,
    sshReconnectMinUpSec: 0, sshReconnectCodes: '255', sshReconnectFlash: false, latencyBadge: false, latencyIntervalSec: 30, latencyTimeoutSec: 7,
    latencyWarnMs: 10, latencyBadMs: 20, latencySamples: 100, latencyFailsBad: 9, latencyShowUnit: false, fontSize: 20, sshHostKeyPolicy: 'accept-new',
  });
  const r = resetSection(cur, 'sshkeys');
  assert.deepEqual({ ...r, fontSize: 0 }, { ...DEFAULTS, fontSize: 0 });
  assert.equal(r.fontSize, 20);
  for (const k of Object.keys(NUM_RANGES)) assert.ok(SECTION_KEYS.sshkeys.includes(k as never), k);
  for (const k of ['sshAutoReconnect', 'sshReconnectCodes', 'sshReconnectFlash', 'latencyBadge', 'latencyShowUnit']) assert.ok(SECTION_KEYS.sshkeys.includes(k as never), k);
});

test('ssh connection settings can be imported (and are validated on the way in)', () => {
  const r = parseImport('{"sshReconnectMaxAttempts":99,"latencyWarnMs":500,"latencyBadMs":100,"sshReconnectCodes":"255"}', DEFAULTS);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.settings.sshReconnectMaxAttempts, 50);
    assert.deepEqual([r.settings.latencyWarnMs, r.settings.latencyBadMs], [500, 501]);
    assert.equal(r.settings.sshReconnectCodes, '255');
  }
});

// ---------- catálogo de temas: forma y legibilidad ----------
const lum = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test('every built-in theme has valid colours, a unique id and label', () => {
  assert.ok(THEME_IDS.length >= 20, `solo ${THEME_IDS.length} temas`);
  const labels = new Set<string>();
  for (const id of THEME_IDS) {
    const { label, theme } = THEMES[id] as { label: string; theme: Record<string, string> };
    assert.match(id, /^[a-z0-9]+$/, `id raro: ${id}`);
    assert.ok(label.length > 0 && !labels.has(label), `etiqueta repetida o vacía: ${id}`);
    labels.add(label);
    for (const k of ['background', 'foreground', 'cursor', 'cursorAccent', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']) {
      assert.match(theme[k], /^#[0-9a-f]{6}$/i, `${id}.${k} = ${theme[k]}`);
    }
    assert.match(theme.selectionBackground, /^rgba\(\d{1,3},\d{1,3},\d{1,3},(0|1|0?\.\d+)\)$/, `${id}.selectionBackground`);
  }
});

test('the text of every built-in theme is readable on its background (WCAG ≥ 4.5; High Contrast ≥ 15)', () => {
  for (const id of THEME_IDS) {
    const t = THEMES[id].theme as Record<string, string>;
    const c = contrast(t.foreground, t.background);
    assert.ok(c >= (id === 'highcontrast' ? 15 : 4.5), `${id}: foreground/background ${c.toFixed(2)}`);
    // El cursor tiene que verse sobre el fondo.
    assert.ok(contrast(t.cursor, t.background) >= 2.5, `${id}: cursor ${contrast(t.cursor, t.background).toFixed(2)}`);
  }
});
