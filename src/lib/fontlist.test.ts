import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupFonts, firstFamily, type InstalledFont } from './fontlist.ts';

const f = (name: string, newSinceStart = false): InstalledFont => ({ name, newSinceStart });
const among = (...names: string[]) => (n: string) => names.map((x) => x.toLowerCase()).includes(n.toLowerCase());

test('installed fonts that are not in the presets show up (the reason user fonts were missing)', () => {
  const usable = among('Asterisk Mono', 'Consolas', 'Karma Future', 'Cascadia Code');
  const g = groupFonts([f('Asterisk Mono'), f('Consolas'), f('Karma Future')], ['Cascadia Code', 'Consolas', 'Hack'], usable,
    among('Asterisk Mono', 'Consolas', 'Cascadia Code'));
  assert.deepEqual(g.mono, ['Asterisk Mono', 'Cascadia Code', 'Consolas']);
  assert.deepEqual(g.other, ['Karma Future']);
  assert.deepEqual(g.missing, ['Hack']);
  assert.deepEqual(g.restart, []);
});

test('a font installed with Orchestra open goes to «restart», not to «missing» or to the usable list', () => {
  const g = groupFonts([f('Hack', true), f('Consolas')], ['Hack', 'Consolas'], among('Consolas'), () => true);
  assert.deepEqual(g.restart, ['Hack']);
  assert.deepEqual(g.missing, []);
  assert.deepEqual(g.mono, ['Consolas']);
});

test('new since start but the webview already paints it: usable as normal', () => {
  const g = groupFonts([f('Hack', true)], [], () => true, () => true);
  assert.deepEqual(g.mono, ['Hack']);
  assert.deepEqual(g.restart, []);
});

test('fonts the webview cannot paint by that name are left out; no duplicates by case or across groups', () => {
  const g = groupFonts([f('Ghost'), f('consolas'), f('Consolas')], ['Consolas'], among('Consolas'), () => true);
  assert.deepEqual(g.mono, ['consolas']);
  assert.deepEqual(g.other, []);
});

test('a preset is always offered as monospaced even if the measurement says otherwise', () => {
  const g = groupFonts([f('Consolas')], ['Consolas'], () => true, () => false);
  assert.deepEqual(g.mono, ['Consolas']);
  assert.deepEqual(g.other, []);
});

test('firstFamily takes the first name of a CSS list', () => {
  assert.equal(firstFamily("'Fira Code', monospace"), 'Fira Code');
  assert.equal(firstFamily('Asterisk Mono'), 'Asterisk Mono');
});
