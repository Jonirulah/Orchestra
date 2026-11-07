import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES, bumpContents, currentVersion } from './bump-version.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const real = () => Object.fromEntries(FILES.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));

test('bumpContents sobre los archivos reales: cambia solo la versión de Orchestra en cada sitio', () => {
  const before = real();
  const oldV = currentVersion(before['package.json']);
  const after = bumpContents(before, oldV, '9.8.7');
  assert.equal(JSON.parse(after['package.json']).version, '9.8.7');
  const lock = JSON.parse(after['package-lock.json']);
  assert.equal(lock.version, '9.8.7');
  assert.equal(lock.packages[''].version, '9.8.7');
  assert.equal(JSON.parse(after['src-tauri/tauri.conf.json']).version, '9.8.7');
  assert.match(after['src-tauri/Cargo.toml'], /^\[package\]\r?\nname = "orchestra"\r?\nversion = "9\.8\.7"/m);
  assert.match(after['src-tauri/Cargo.lock'], /^name = "orchestra"\r?\nversion = "9\.8\.7"/m);
  assert.match(after['src/lib/settings.ts'], /APP_VERSION = '9\.8\.7'/);
  for (const r of ['README.md', 'README.es.md']) {
    assert.ok(after[r].includes('badge/version-9.8.7-orange'));
    assert.ok(after[r].includes('Orchestra_9.8.7_x64-setup.exe'));
    assert.ok(after[r].includes('Orchestra_9.8.7_x64-portable.exe'));
    assert.ok(!after[r].includes(`Orchestra_${oldV}_x64-setup.exe`));
    assert.match(after[r], /^Orchestra 9\.8\.7 \(/m);
  }
  // Nada más cambia: mismas líneas salvo las de la versión.
  for (const f of FILES) {
    const a = before[f].split('\n'), b = after[f].split('\n');
    assert.equal(a.length, b.length, f);
    const changed = a.filter((l, i) => l !== b[i]);
    assert.ok(changed.length >= 1 && changed.length <= 4, `${f}: ${changed.length} líneas cambiadas`);
    for (const l of changed) assert.ok(l.includes(oldV), `${f}: cambió una línea sin la versión: ${l}`);
  }
});

test('bumpContents falla si un patrón no está (no deja la versión a medias)', () => {
  const c = real();
  const oldV = currentVersion(c['package.json']);
  assert.throws(() => bumpContents({ ...c, 'src/lib/settings.ts': '// sin versión' }, oldV, '9.8.7'), /settings\.ts/);
  assert.throws(() => bumpContents(c, oldV, oldV), /ya es/);
  assert.throws(() => bumpContents(c, oldV, 'v1'), /no válida/);
  const { 'README.md': _, ...sinReadme } = c;
  assert.throws(() => bumpContents(sinReadme, oldV, '9.8.7'), /falta README\.md/);
});
