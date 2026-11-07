// i18n de Ajustes (settings.terminal/agents/dialog/accounts/data), atajos y themeimport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { en } from './locales/en/index.ts';
import { es } from './locales/es/index.ts';
import { setLocale, t } from './i18n.ts';
import { SHORTCUTS } from './shortcuts.ts';
import { parseTheme } from './themeimport.ts';

const MINE = /^(settings\.(terminal|agents|dialog|accounts|data)|shortcuts|themeimport)\./;
// Textos que son iguales en inglés y en español a propósito (nombres propios, palabras idénticas, plantillas).
const SAME = new Set([
  'settings.dialog.tabGeneral', 'settings.dialog.tabTerminal',
  'settings.terminal.cursorLabel', 'settings.terminal.fileError', 'settings.agents.experimental',
  'settings.agents.compactLogLine', 'settings.data.build', 'settings.accounts.colorAria',
  'settings.accounts.sortManual', // «Manual» se escribe igual
]);

test('settings/shortcuts/themeimport: Spanish differs from English (except the allow-list)', () => {
  const keys = Object.keys(en).filter((k) => MINE.test(k));
  assert.ok(keys.length > 150, `expected many keys, got ${keys.length}`);
  const same = keys.filter((k) => (es as Record<string, string>)[k] === (en as Record<string, string>)[k]);
  assert.deepEqual(same.filter((k) => !SAME.has(k)), []);
  assert.deepEqual([...SAME].filter((k) => !same.includes(k)), [], 'allow-list entry that is actually translated');
});

test('SHORTCUTS: every title/description is a real key and the combos stay untranslated', () => {
  for (const g of SHORTCUTS) {
    assert.ok(g.titleKey in en, g.titleKey);
    for (const it of g.items) {
      assert.ok(it.whatKey in en, it.whatKey);
      assert.ok(it.keys.length > 0);
    }
  }
});

test('themeimport messages follow the language, resolved when parse runs', () => {
  try {
    setLocale('es');
    const r = parseTheme('   ');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, es['themeimport.empty']);
    assert.equal(t('shortcuts.paste'), 'Pegar');
  } finally {
    setLocale('en');
  }
  const r2 = parseTheme('   ');
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.error, 'Nothing to import: the text is empty.');
});
