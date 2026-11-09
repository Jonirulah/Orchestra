import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOW_SLUG, claudeThemeFiles, claudeThemeFor, claudeThemeSlug, contrast, parseColor, shimmerBase } from './claudetheme.ts';
import { baseDef } from './themes.ts';
import { CLAUDE_DARK, CLAUDE_LIGHT } from './claudedefaults.ts';
import { THEMES, THEME_IDS, themeOf } from './themes.ts';

const rgb = (s: string) => parseColor(s)!;
// Lo que acepta Claude (kee() en su binario): #rrggbb, #rgb, rgb(r,g,b), ansi256(n) o ansi:<nombre>.
const VALID = /^#[0-9a-f]{6}$/;
const hue = ([r, g, b]: [number, number, number]) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  return h < 0 ? h + 360 : h;
};

test('every Orchestra theme gives a full Claude theme with colors Claude accepts', () => {
  assert.deepEqual(Object.keys(CLAUDE_DARK).sort(), Object.keys(CLAUDE_LIGHT).sort());
  for (const id of THEME_IDS) {
    const c = claudeThemeFor(THEMES[id].label, themeOf(id));
    assert.deepEqual(Object.keys(c.overrides).sort(), Object.keys(CLAUDE_DARK).sort(), id);
    for (const [k, v] of Object.entries(c.overrides)) assert.match(v, VALID, `${id}.${k}`);
  }
});

test('dark themes get base dark and light themes base light', () => {
  for (const id of THEME_IDS) {
    const t = themeOf(id);
    const lightTheme = contrast(rgb(t.background), [255, 255, 255]) < contrast(rgb(t.background), [0, 0, 0]);
    assert.equal(claudeThemeFor(id, t).base, lightTheme ? 'light' : 'dark', id);
  }
  assert.equal(claudeThemeFor('x', themeOf('githublight')).base, 'light');
  assert.equal(claudeThemeFor('x', themeOf('dracula')).base, 'dark');
});

test('text is the terminal foreground and inverse text its background', () => {
  for (const id of THEME_IDS) {
    const t = themeOf(id), o = claudeThemeFor(id, t).overrides;
    assert.deepEqual(rgb(o.text), rgb(t.foreground), id);
    assert.deepEqual(rgb(o.inverseText), rgb(t.background), id);
  }
});

test('accents are readable on the terminal background (≥ 3:1) and text on its panels (≥ 4.5:1)', () => {
  const accents = ['claude', 'permission', 'suggestion', 'success', 'error', 'warning', 'planMode', 'autoAccept', 'bashBorder', 'ide'];
  for (const id of THEME_IDS) {
    const t = themeOf(id), o = claudeThemeFor(id, t).overrides, bg = rgb(t.background);
    for (const k of accents) assert.ok(contrast(rgb(o[k]), bg) >= 3, `${id}.${k} ${o[k]} on ${t.background}: ${contrast(rgb(o[k]), bg).toFixed(2)}`);
    for (const k of ['userMessageBackground', 'diffAdded', 'diffRemoved', 'bashMessageBackgroundColor', 'memoryBackgroundColor']) {
      const min = Math.min(4.5, 0.8 * contrast(rgb(t.foreground), bg)) - 0.01; // Solarized: su propio texto solo da 4.75:1
      assert.ok(contrast(rgb(o.text), rgb(o[k])) >= min, `${id}: text on ${k} ${o[k]}: ${contrast(rgb(o.text), rgb(o[k])).toFixed(2)}`);
    }
  }
});

test('colors keep their meaning: green diffs, red errors, orange Claude made from the theme red and yellow', () => {
  for (const id of ['orchestra', 'dracula', 'gruvbox', 'nord', 'solarizedlight'] as const) {
    const o = claudeThemeFor(id, themeOf(id)).overrides;
    const hAdded = hue(rgb(o.diffAdded)), hErr = hue(rgb(o.error)), hClaude = hue(rgb(o.claude));
    assert.ok(hAdded > 60 && hAdded < 180, `${id} diffAdded hue ${hAdded}`);
    assert.ok(hErr < 30 || hErr > 320, `${id} error hue ${hErr}`);
    assert.ok(hClaude > 5 && hClaude < 50, `${id} claude hue ${hClaude}`);
  }
});

test('shimmer keys follow their base color, lighter', () => {
  assert.equal(shimmerBase('claudeShimmer'), 'claude');
  assert.equal(shimmerBase('claudeBlueShimmer_FOR_SYSTEM_SPINNER'), 'claudeBlue_FOR_SYSTEM_SPINNER');
  assert.equal(shimmerBase('rainbow_red_shimmer'), 'rainbow_red');
  assert.equal(shimmerBase('claude'), null);
  assert.equal(shimmerBase('selectionBg'), null);
  const o = claudeThemeFor('x', themeOf('orchestra')).overrides;
  assert.ok(contrast(rgb(o.claudeShimmer), [0, 0, 0]) > contrast(rgb(o.claude), [0, 0, 0]));
});

test('slugs are file and theme-id safe', () => {
  assert.equal(claudeThemeSlug('dracula'), 'orchestra-dracula');
  assert.equal(claudeThemeSlug('Mi Tema Ñ!'), 'orchestra-mi-tema');
});

test('theme files: one per built-in and custom theme, plus the one that follows the terminal', () => {
  const night = { ...baseDef(), id: 'custom:night', name: 'Night' };
  const files = claudeThemeFiles([night], 'dracula', 'Orchestra · Terminal theme');
  const slugs = files.map((f) => f.slug);
  assert.equal(files.length, THEME_IDS.length + 2);
  assert.ok(slugs.includes('orchestra-dracula') && slugs.includes('orchestra-custom-night') && slugs.includes(FOLLOW_SLUG));
  assert.equal(new Set(slugs).size, slugs.length);
  for (const f of files) assert.match(f.slug, /^orchestra-[a-z0-9-]+$/);
  const follow = JSON.parse(files.find((f) => f.slug === FOLLOW_SLUG)!.json);
  const dracula = JSON.parse(files.find((f) => f.slug === 'orchestra-dracula')!.json);
  assert.equal(follow.name, 'Orchestra · Terminal theme');
  assert.deepEqual(follow.overrides, dracula.overrides);
  assert.equal(dracula.name, 'Orchestra · Dracula');
  assert.equal(JSON.parse(files.find((f) => f.slug === 'orchestra-orchestra')!.json).name, 'Orchestra Dark');
  // Si el tema elegido ya no existe, sigue a Orchestra Dark (como el terminal).
  const gone = JSON.parse(claudeThemeFiles([], 'custom:borrado', 'x').find((f) => f.slug === FOLLOW_SLUG)!.json);
  assert.deepEqual(gone.overrides, JSON.parse(files.find((f) => f.slug === 'orchestra-orchestra')!.json).overrides);
});
