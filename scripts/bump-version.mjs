#!/usr/bin/env node
// Sube la versión en todos los sitios donde aparece (lo usa scripts/release.ps1).
//
// Uso: node scripts/bump-version.mjs <nueva versión> [--dry]
// Toca: package.json, package-lock.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml,
// src-tauri/Cargo.lock, src/lib/settings.ts (APP_VERSION) y README.md / README.es.md
// (insignia, nombre del instalador y párrafo de estado). Escribe UTF-8 sin BOM y respeta los saltos de línea.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Reemplazos por archivo: [regex con la versión vieja, sustituto]. `count` = cuántas veces tiene que casar. */
function rules(oldV, newV) {
  const o = esc(oldV);
  return {
    'package.json': [[new RegExp(`^(  "version": ")${o}(")`, 'm'), `$1${newV}$2`, 1]],
    // La raíz y packages[""] (las dos primeras), nunca las dependencias.
    'package-lock.json': [
      [new RegExp(`^(  "name": "orchestra",\\r?\\n  "version": ")${o}(")`, 'm'), `$1${newV}$2`, 1],
      [new RegExp(`^(    "": \\{\\r?\\n      "name": "orchestra",\\r?\\n      "version": ")${o}(")`, 'm'), `$1${newV}$2`, 1],
    ],
    'src-tauri/tauri.conf.json': [[new RegExp(`^(  "version": ")${o}(")`, 'm'), `$1${newV}$2`, 1]],
    'src-tauri/Cargo.toml': [[new RegExp(`^(\\[package\\]\\r?\\nname = "orchestra"\\r?\\nversion = ")${o}(")`, 'm'), `$1${newV}$2`, 1]],
    'src-tauri/Cargo.lock': [[new RegExp(`^(name = "orchestra"\\r?\\nversion = ")${o}(")`, 'm'), `$1${newV}$2`, 1]],
    'src/lib/settings.ts': [[new RegExp(`^(export const APP_VERSION = ')${o}(';)`, 'm'), `$1${newV}$2`, 1]],
    'README.md': readmeRules(o, newV, 'Version'),
    'README.es.md': readmeRules(o, newV, 'Versión'),
  };
}

function readmeRules(o, newV, word) {
  return [
    [new RegExp(`(alt="${word} )${o}(")`, 'g'), `$1${newV}$2`, 1],
    [new RegExp(`(badge/version-)${o}(-)`, 'g'), `$1${newV}$2`, 1],
    [new RegExp(`(Orchestra_)${o}(_x64-(?:setup|portable)\\.exe)`, 'g'), `$1${newV}$2`, -1], // -1 = al menos una
    [new RegExp(`^(Orchestra )${o}( \\()`, 'gm'), `$1${newV}$2`, 1],
  ];
}

export const FILES = Object.keys(rules('0.0.0', '0.0.1'));

/**
 * Aplica la subida a los contenidos dados ({ ruta: texto }). Devuelve los textos nuevos y
 * lanza si algún patrón no aparece las veces esperadas (así no se publica una versión a medias).
 */
export function bumpContents(contents, oldV, newV) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(newV)) throw new Error(`versión no válida: ${newV}`);
  if (oldV === newV) throw new Error(`la versión ya es ${newV}`);
  const out = {};
  for (const [file, list] of Object.entries(rules(oldV, newV))) {
    let text = contents[file];
    if (text === undefined) throw new Error(`falta ${file}`);
    for (const [re, sub, count] of list) {
      const n = (text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length;
      if (count === -1 ? n < 1 : n !== count) throw new Error(`${file}: ${re} casa ${n} veces (se esperaba ${count === -1 ? '≥1' : count})`);
      text = text.replace(re, sub);
    }
    out[file] = text;
  }
  return out;
}

/** Versión actual (la de package.json). */
export const currentVersion = (pkgText) => JSON.parse(pkgText).version;

function main(argv) {
  const newV = argv.find((a) => !a.startsWith('--'));
  if (!newV) { console.error('uso: bump-version.mjs <versión> [--dry]'); process.exit(2); }
  const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/^﻿/, '');
  const contents = Object.fromEntries(FILES.map((f) => [f, read(f)]));
  const oldV = currentVersion(contents['package.json']);
  const next = bumpContents(contents, oldV, newV);
  for (const f of FILES) {
    if (next[f] === contents[f]) continue;
    if (!argv.includes('--dry')) writeFileSync(join(ROOT, f), next[f], 'utf8');
    console.log(`${argv.includes('--dry') ? '(dry) ' : ''}${f}: ${oldV} -> ${newV}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
