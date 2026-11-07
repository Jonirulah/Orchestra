import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLatestJson, githubAssetUrl, installerName, notesFromChangelog, PLATFORMS } from './latest-json.mjs';

const CHANGELOG = `# Changelog

## [Unreleased]

### Added
- Something not released yet.

## [0.3.1] - 2026-11-08

### Fixed
- One fix.

## [0.3.0] - 2026-11-07

### Added
- Older stuff.

[0.3.1]: https://github.com/Jonirulah/Orchestra/releases/tag/v0.3.1
`;

test('notesFromChangelog: solo la sección pedida, sin cabecera ni enlaces de referencia', () => {
  assert.equal(notesFromChangelog(CHANGELOG, '0.3.1'), '### Fixed\n- One fix.');
  assert.equal(notesFromChangelog(CHANGELOG, '0.3.0'), '### Added\n- Older stuff.');
  assert.equal(notesFromChangelog(CHANGELOG, '0.9.9'), null);
  assert.equal(notesFromChangelog(CHANGELOG.replace(/\n/g, '\r\n'), '0.3.1'), '### Fixed\n- One fix.');
  // 0.3.1 no debe casar con 0.3.10 ni el punto con cualquier carácter
  assert.equal(notesFromChangelog('## [0.3.10]\n- x\n', '0.3.1'), null);
  assert.equal(notesFromChangelog('## [0x3x1]\n- x\n', '0.3.1'), null);
});

test('el CHANGELOG real tiene la sección de la versión actual', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const notes = notesFromChangelog(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), pkg.version);
  assert.ok(notes && notes.length > 20);
});

test('buildLatestJson: formato del plugin, firma recortada, fecha RFC 3339 sin milisegundos', () => {
  const url = githubAssetUrl('Jonirulah/Orchestra', '0.3.1', installerName('0.3.1'));
  assert.equal(url, 'https://github.com/Jonirulah/Orchestra/releases/download/v0.3.1/Orchestra_0.3.1_x64-setup.exe');
  const j = buildLatestJson({ version: '0.3.1', notes: 'n', pubDate: '2026-11-08T10:20:30.456Z', signature: 'c2ln\n', url });
  assert.equal(j.version, '0.3.1');
  assert.equal(j.pub_date, '2026-11-08T10:20:30Z');
  assert.deepEqual(Object.keys(j.platforms), PLATFORMS);
  for (const p of PLATFORMS) assert.deepEqual(j.platforms[p], { signature: 'c2ln', url });
});

test('buildLatestJson rechaza lo que rompería la actualización', () => {
  const ok = { version: '0.3.1', notes: '', signature: 's', url: 'https://x/y.exe' };
  assert.throws(() => buildLatestJson({ ...ok, version: 'v0.3.1' }), /versión/);
  assert.throws(() => buildLatestJson({ ...ok, signature: '  ' }), /firma/);
  assert.throws(() => buildLatestJson({ ...ok, url: 'ftp://x' }), /URL/);
  assert.throws(() => buildLatestJson({ ...ok, pubDate: 'ayer' }), /fecha/);
});
