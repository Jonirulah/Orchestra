#!/usr/bin/env node
// Genera el latest.json que lee tauri-plugin-updater (ver docs/dev-notes/actualizaciones.md).
//
// Uso: node scripts/latest-json.mjs --version 0.3.1 --sig <archivo .sig> --url <URL del instalador>
//                                   [--changelog CHANGELOG.md] [--date <ISO>] [--out latest.json]
// Las notas salen de la sección `## [<versión>]` del CHANGELOG. Sin --out imprime el JSON.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Plataforma de la release: el plugin busca primero `windows-x86_64-nsis` y luego `windows-x86_64`. */
export const PLATFORMS = ['windows-x86_64-nsis', 'windows-x86_64'];

/** Texto de la sección `## [version] - fecha` del CHANGELOG (sin la cabecera), o null si no está. */
export function notesFromChangelog(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^## \\[v?${esc}\\]`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  // Los enlaces de referencia del final (`[0.3.0]: https://…`) no son notas.
  const body = lines.slice(start + 1, end).filter((l) => !/^\[[^\]]+\]:\s*\S+/.test(l));
  return body.join('\n').trim();
}

/** URL de descarga del instalador en la release de GitHub. */
export function githubAssetUrl(repo, version, file) {
  return `https://github.com/${repo}/releases/download/v${version}/${file}`;
}

/** Nombre del instalador NSIS que genera tauri build. */
export const installerName = (version, product = 'Orchestra') => `${product}_${version}_x64-setup.exe`;

/**
 * latest.json para el endpoint `releases/latest/download/latest.json`.
 * `signature` = contenido del .sig que deja tauri build junto al instalador.
 */
export function buildLatestJson({ version, notes, pubDate, signature, url }) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error(`versión no válida: ${version}`);
  const sig = String(signature ?? '').trim();
  if (!sig) throw new Error('falta la firma (.sig)');
  if (!/^https?:\/\//.test(url ?? '')) throw new Error(`URL no válida: ${url}`);
  const date = new Date(pubDate ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error(`fecha no válida: ${pubDate}`);
  const entry = { signature: sig, url };
  return {
    version,
    notes: notes ?? '',
    // RFC 3339 sin milisegundos (el plugin lo exige así).
    pub_date: date.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms: Object.fromEntries(PLATFORMS.map((p) => [p, { ...entry }])),
  };
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const version = arg(argv, 'version');
  const sigFile = arg(argv, 'sig');
  const url = arg(argv, 'url');
  if (!version || !sigFile || !url) {
    console.error('uso: latest-json.mjs --version X.Y.Z --sig <archivo.sig> --url <url> [--changelog CHANGELOG.md] [--date ISO] [--out archivo]');
    process.exit(2);
  }
  const changelog = readFileSync(arg(argv, 'changelog') ?? 'CHANGELOG.md', 'utf8');
  const notes = notesFromChangelog(changelog, version);
  if (notes == null) {
    console.error(`El CHANGELOG no tiene la sección «## [${version}]».`);
    process.exit(1);
  }
  const json = buildLatestJson({ version, notes, pubDate: arg(argv, 'date'), signature: readFileSync(sigFile, 'utf8'), url });
  const text = `${JSON.stringify(json, null, 2)}\n`;
  const out = arg(argv, 'out');
  if (out) writeFileSync(out, text, 'utf8');
  else process.stdout.write(text);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
