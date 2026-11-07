#!/usr/bin/env node
// Prepara una release firmada de Orchestra. NO publica nada: deja el comando `gh release create`
// impreso para revisarlo. Proceso completo en docs/dev-notes/actualizaciones.md.
//
// Uso: node scripts/release.mjs <versión> [opciones]
//   --key <archivo>        clave privada del updater (por defecto <home>/.tauri/orchestra-updater.key;
//                          si existe <archivo>.password se usa como contraseña)
//   --out <carpeta>        dónde dejar los artefactos (por defecto <repo>/../Orchestra-release); van en <out>/v<versión>/
//   --target <carpeta>     CARGO_TARGET_DIR (por defecto el del entorno o src-tauri/target)
//   --no-bump              no tocar la versión (ya subida a mano)
//   --skip-build           no compilar (reutiliza lo que haya en el target)
//   --tauri-config <json>  config extra para `tauri build --config` (solo builds de prueba: endpoint local)
//   --url-base <url>       base de la URL del instalador en latest.json (pruebas); por defecto la release de GitHub
//   --repo <dueño/repo>    por defecto Jonirulah/Orchestra
//   --product <nombre>     productName de la build (por defecto Orchestra; las de prueba usan otro para no pisar la instalación real)
//   --binary <nombre>      nombre del exe sin .exe (por defecto orchestra)

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FILES, bumpContents, currentVersion } from './bump-version.mjs';
import { buildLatestJson, githubAssetUrl, installerName, notesFromChangelog } from './latest-json.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (name) => argv.includes(`--${name}`);
const die = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

const version = argv[0]; // la versión va siempre la primera
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) die('uso: node scripts/release.mjs <X.Y.Z> [opciones] (ver cabecera del script)');

const repo = opt('repo', 'Jonirulah/Orchestra');
const product = opt('product', 'Orchestra');
const binary = opt('binary', 'orchestra');
const keyPath = opt('key', join(homedir(), '.tauri', 'orchestra-updater.key'));
const outDir = join(opt('out', join(ROOT, '..', 'Orchestra-release')), `v${version}`);
const target = opt('target', process.env.CARGO_TARGET_DIR || join(ROOT, 'src-tauri', 'target'));
const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/^\uFEFF/, '');

// 1) Notas: la sección del CHANGELOG tiene que existir antes de tocar nada.
const notes = notesFromChangelog(read('CHANGELOG.md'), version);
if (notes == null) die(`CHANGELOG.md no tiene la sección "## [${version}] - <fecha>". Escríbela antes.`);
if (!existsSync(keyPath)) die(`no encuentro la clave privada en ${keyPath}`);

// 2) Versión.
if (!flag('no-bump')) {
  const contents = Object.fromEntries(FILES.map((f) => [f, read(f)]));
  const oldV = currentVersion(contents['package.json']);
  if (oldV !== version) {
    const next = bumpContents(contents, oldV, version);
    for (const f of FILES) if (next[f] !== contents[f]) writeFileSync(join(ROOT, f), next[f], 'utf8');
    console.log(`Versión ${oldV} -> ${version} en ${FILES.length} archivos.`);
    console.log('  Revisa a mano en los README la frase «New in …» / «Novedades de la …» del párrafo de estado.');
  }
}
if (currentVersion(read('package.json')) !== version) die('package.json no tiene la versión pedida (¿--no-bump sin subirla?)');

// 3) Compilar y firmar (tauri build firma el instalador si ve TAURI_SIGNING_PRIVATE_KEY).
if (!flag('skip-build')) {
  const pwFile = `${keyPath}.password`;
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: target,
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, 'utf8').trim(),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: existsSync(pwFile) ? readFileSync(pwFile, 'utf8').trim() : '',
  };
  // Una sola línea de comando (npx es un .cmd en Windows y necesita shell); la ruta va entre comillas.
  const extra = opt('tauri-config');
  const cmd = `npx tauri build${extra ? ` --config "${extra.replace(/"/g, '')}"` : ''}`;
  console.log(`> ${cmd}  (CARGO_TARGET_DIR=${target})`);
  const r = spawnSync(cmd, { cwd: ROOT, env, stdio: 'inherit', shell: true });
  if (r.status !== 0) die(`tauri build terminó con código ${r.status}`);
}

// 4) Artefactos.
const nsisDir = join(target, 'release', 'bundle', 'nsis');
const setup = installerName(version, product);
const setupPath = join(nsisDir, setup);
const sigPath = `${setupPath}.sig`;
const exePath = join(target, 'release', `${binary}.exe`);
for (const p of [setupPath, sigPath, exePath]) if (!existsSync(p)) die(`falta ${p}`);
mkdirSync(outDir, { recursive: true });
const portable = `${product}_${version}_x64-portable.exe`;
copyFileSync(setupPath, join(outDir, setup));
copyFileSync(sigPath, join(outDir, `${setup}.sig`));
copyFileSync(exePath, join(outDir, portable));

const urlBase = opt('url-base');
const url = urlBase ? `${urlBase.replace(/\/$/, '')}/${setup}` : githubAssetUrl(repo, version, setup);
const latest = buildLatestJson({ version, notes, signature: readFileSync(sigPath, 'utf8'), url });
writeFileSync(join(outDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`, 'utf8');
writeFileSync(join(outDir, 'notes.md'), `${notes}\n`, 'utf8');

console.log(`\nArtefactos en ${outDir}:\n  ${setup}\n  ${setup}.sig\n  ${portable}\n  latest.json\n  notes.md`);
if (urlBase) {
  console.log('\n(Build de prueba con --url-base: NO publicar.)');
} else {
  const q = (s) => `"${s}"`;
  console.log('\nRevisa y, si todo está bien, publica con (no se ha ejecutado):\n');
  console.log(`gh release create v${version} --repo ${repo} --title ${q(`Orchestra ${version}`)} --notes-file ${q(join(outDir, 'notes.md'))} ${q(join(outDir, setup))} ${q(join(outDir, `${setup}.sig`))} ${q(join(outDir, portable))} ${q(join(outDir, 'latest.json'))}`);
  console.log('\nlatest.json tiene que ir en la release marcada como «latest» (no prerelease): el endpoint es releases/latest/download/latest.json.');
}
