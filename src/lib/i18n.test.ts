import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getLocale, resolveLanguage, setLocale, t, tk } from './i18n.ts';
import type { Key } from './i18n.ts';
import { en } from './locales/en/index.ts';
import { es } from './locales/es/index.ts';

afterEach(() => setLocale('en'));

const vars = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

test('English is the default locale and keys resolve', () => {
  assert.equal(getLocale(), 'en');
  assert.equal(t('tray.show'), 'Show Orchestra');
});

test('locale switch round trip', () => {
  setLocale('es');
  assert.equal(getLocale(), 'es');
  assert.equal(t('tray.show'), 'Mostrar Orchestra');
  setLocale('en');
  assert.equal(t('tray.show'), 'Show Orchestra');
  setLocale('fr' as never); // unknown locale falls back to English
  assert.equal(getLocale(), 'en');
});

test('interpolation: values, numbers, unknown vars stay as {name}', () => {
  assert.equal(t('settings.general.accentAria', { color: '#ff0000' }), 'Accent #ff0000');
  assert.equal(t('settings.general.accentAria', { color: 7 }), 'Accent 7');
  assert.equal(t('settings.general.accentAria'), 'Accent {color}');
  assert.equal(t('settings.general.accentAria', { other: 'x' }), 'Accent {color}');
  setLocale('es');
  assert.equal(t('settings.general.accentAria', { color: '#00ff00' }), 'Acento #00ff00');
});

test('fallback chain: current locale -> English -> the key itself', () => {
  const saved = es as Record<string, string>;
  const key = 'tray.quit';
  const original = saved[key];
  try {
    setLocale('es');
    assert.equal(tk(key), original);
    delete saved[key]; // simulate a missing Spanish string
    assert.equal(tk(key), en[key as Key]); // falls back to English
    assert.equal(tk('nope.missing'), 'nope.missing'); // then to the key
    assert.equal(tk('nope.{x}', { x: 1 }), 'nope.1'); // unknown keys are still interpolated
  } finally {
    saved[key] = original;
  }
  assert.equal(tk(key), original);
});

test('tk handles dynamic keys and never returns inherited properties', () => {
  const s = 'show';
  assert.equal(tk(`tray.${s}`), 'Show Orchestra');
  assert.equal(tk('constructor'), 'constructor');
  assert.equal(tk('__proto__'), '__proto__');
  assert.equal(tk('toString'), 'toString');
});

test('resolveLanguage: explicit choices win, system follows the browser language', () => {
  assert.equal(resolveLanguage('en', 'es-ES'), 'en');
  assert.equal(resolveLanguage('es', 'en-US'), 'es');
  assert.equal(resolveLanguage('system', 'es-ES'), 'es');
  assert.equal(resolveLanguage('system', 'es'), 'es');
  assert.equal(resolveLanguage('system', 'ES-mx'), 'es');
  assert.equal(resolveLanguage('system', 'en-GB'), 'en');
  assert.equal(resolveLanguage('system', 'fr-FR'), 'en');
  assert.equal(resolveLanguage('system', ''), 'en');
  assert.ok(['en', 'es'].includes(resolveLanguage('system'))); // no argument: uses navigator when it exists
});

test('parity: every English key exists in Spanish, no empties, same {vars}, no extras', () => {
  const e = en as Record<string, string>;
  const s = es as Record<string, string>;
  for (const k of Object.keys(e)) {
    assert.ok(k in s, `missing in es: ${k}`);
    assert.ok(e[k].trim(), `empty en: ${k}`);
    assert.ok(s[k].trim(), `empty es: ${k}`);
    assert.deepEqual(vars(s[k]), vars(e[k]), `{vars} differ in ${k}`);
  }
  for (const k of Object.keys(s)) assert.ok(k in e, `extra in es: ${k}`);
});

test('keys are namespaced area.component.thing in camelCase', () => {
  for (const k of Object.keys(en)) assert.match(k, /^[a-z]+(\.[A-Za-z0-9]+)+$/, k);
});
