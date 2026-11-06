#!/usr/bin/env node
// i18n gate. Usage: node scripts/i18n-check.mjs [--strict] [--summary] [path-substring ...]
//
//  (a) dictionaries: en/es parity, empty values, {var} mismatch, key naming, duplicates across areas
//  (b) usage: t()/tk() keys used but not defined, keys defined but never used
//  (c) HEURISTIC: hard-coded user-visible text still in .svelte templates / .ts (warnings)
//
// Exit code 1 if (a) or (b) fail; (c) only fails with --strict. Path arguments limit the (c) report
// (and the --strict verdict) to files whose path contains one of them, e.g. `components/Sidebar`.
// A line containing the text `i18n-ignore` (in a comment) is skipped by (c). Docs: docs/i18n.md. Node >= 22.18 (runs the .ts dictionaries directly).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const LOCALES = join(SRC, 'lib', 'locales');
// Every area file in locales/en (index.ts excluded): new areas need no edit here.
const AREAS = readdirSync(join(LOCALES, 'en')).filter((n) => /\.ts$/.test(n) && n !== 'index.ts').map((n) => n.replace(/\.ts$/, '')).sort();

// Words that are never translated (product/technical names, key names). Matched as whole words, case-insensitive.
const ALLOW = new Set([
  'orchestra', 'ssh', 'sftp', 'wsl', 'powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'fish', 'claude', 'codex', 'mcp', 'json', 'url', 'uri',
  'ctrl', 'shift', 'alt', 'esc', 'enter', 'tab', 'del', 'win', 'cmd', 'pty', 'cwd', 'id', 'ok', 'pid', 'tcp', 'http', 'https', 'api', 'ip',
  'cascadia', 'consolas', 'jetbrains', 'fira', 'code', 'mono', 'xterm', 'webgl', 'tauri', 'svelte', 'windows', 'linux', 'macos', 'git', 'npm', 'node',
  'exe', 'ed25519', 'rsa', 'ecdsa', 'pem', 'config',
]);

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const SUMMARY = args.includes('--summary');
const FILTERS = args.filter((a) => !a.startsWith('--')).map((a) => a.replaceAll('\\', '/'));

const rel = (p) => relative(ROOT, p).split(sep).join('/');
let errors = 0;
const err = (msg) => { errors++; console.log(`  ERROR ${msg}`); };

// ---------------------------------------------------------------- (a) dictionaries
console.log('== (a) dictionaries');
const load = async (lang, area) => (await import(pathToFileURL(join(LOCALES, lang, `${area}.ts`)).href)).default;
const vars = (s) => [...new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
const dict = { en: {}, es: {} };
const owner = { en: {}, es: {} };
for (const lang of ['en', 'es']) {
  for (const area of AREAS) {
    let d;
    try { d = await load(lang, area); } catch (e) { err(`locales/${lang}/${area}.ts cannot be loaded: ${e.message}`); continue; }
    for (const [k, v] of Object.entries(d)) {
      // `settingsTerminal.ts` may hold `settings.terminal.*` (camelCase file name split into dotted segments).
      const dotted = area.replace(/([a-z0-9])([A-Z])/g, '$1.$2').toLowerCase();
      if (!k.startsWith(`${area}.`) && !k.startsWith(`${dotted}.`)) err(`locales/${lang}/${area}.ts: key "${k}" must start with "${area}."`);
      if (!/^[a-z]+(\.[A-Za-z0-9]+)+$/.test(k)) err(`locales/${lang}/${area}.ts: key "${k}" must look like area.component.thing (camelCase)`);
      if (k in dict[lang]) err(`key "${k}" defined twice (${owner[lang][k]} and ${area}.ts, ${lang})`);
      dict[lang][k] = v; owner[lang][k] = `${area}.ts`;
    }
  }
}
const { en, es } = dict;
for (const k of Object.keys(en)) if (!(k in es)) err(`missing in es: ${k}`);
for (const k of Object.keys(es)) if (!(k in en)) err(`extra in es (not in en): ${k}`);
for (const lang of ['en', 'es']) {
  for (const [k, v] of Object.entries(dict[lang])) {
    if (typeof v !== 'string' || !v.trim()) err(`empty value: ${lang}:${k}`);
  }
}
for (const k of Object.keys(en)) {
  if (k in es && vars(en[k]).join() !== vars(es[k]).join()) err(`{var} mismatch in ${k}: en {${vars(en[k])}} vs es {${vars(es[k])}}`);
}
console.log(`  ${Object.keys(en).length} en keys, ${Object.keys(es).length} es keys`);

// ---------------------------------------------------------------- source files
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== 'locales') walk(p, out); } else if (/\.(ts|svelte)$/.test(n)) out.push(p);
  }
  return out;
}
const files = walk(SRC).filter((f) => !/\.test\.ts$/.test(f) && !/lib[\\/]i18n\.ts$/.test(f));
const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8').replace(/\r\n/g, '\n')]));
const lineOf = (s, idx) => s.slice(0, idx).split('\n').length;

// ---------------------------------------------------------------- (b) usage
console.log('== (b) usage');
const used = new Set();
const prefixes = [];
let dynamicOpaque = 0;
for (const [f, src] of text) {
  for (const m of src.matchAll(/\b(t|tk)\(\s*(['"`])((?:(?!\2)[^\\\n])*)\2/g)) {
    const [, fn, , body] = m;
    if (body.includes('${')) {
      if (fn === 'tk') prefixes.push(body.slice(0, body.indexOf('${')));
      else err(`${rel(f)}:${lineOf(src, m.index)}: t() needs a static key, use tk() for dynamic ones: ${m[0]}`);
      continue;
    }
    used.add(body);
    if (!(body in en)) err(`${rel(f)}:${lineOf(src, m.index)}: ${fn}('${body}') is not defined in locales/en`);
  }
  for (const m of src.matchAll(/\btk\(\s*([A-Za-z_$][\w$.]*)/g)) dynamicOpaque++; // tk(variable): cannot be checked
  // Keys referenced as plain literals in data tables ({ labelKey: 'topbar.foo' }) also count as used.
  for (const m of src.matchAll(/(['"`])([a-z]+(?:\.[A-Za-z0-9]+)+)\1/g)) if (m[2] in en) used.add(m[2]);
}
for (const k of Object.keys(en)) {
  if (used.has(k)) continue;
  if (prefixes.some((p) => p && k.startsWith(p))) continue;
  err(`defined but never used: ${k}  (${owner.en[k]})`);
}
console.log(`  ${used.size} keys used statically, ${prefixes.length} dynamic tk prefixes${dynamicOpaque ? `, ${dynamicOpaque} tk(variable) not checkable` : ''}`);

// ---------------------------------------------------------------- (c) hard-coded text heuristic
const findings = new Map(); // file -> [{line, text}]
const IGNORE_FILES = ['src/lib/themes.ts']; // theme names are proper nouns
const rawLines = new Map([...text].map(([f, src]) => [rel(f), src.split(/\n/)]));
const add = (f, line, txt) => {
  const t = txt.replace(/\s+/g, ' ').trim();
  if (!looksLikeText(t) || IGNORE_FILES.includes(f)) return;
  if ((rawLines.get(f)?.[line - 1] ?? '').includes('i18n-ignore')) return; // per-line escape hatch

  if (!findings.has(f)) findings.set(f, []);
  const list = findings.get(f);
  if (!list.some((x) => x.line === line && x.text === t)) list.push({ line, text: t });
};

const letters = (s) => (s.match(/\p{L}/gu) ?? []).length;
/** ≥2 letters left once allowed words are removed. */
function looksLikeText(s) {
  if (letters(s) < 2) return false;
  const rest = s.replace(/[\p{L}\d_-]+/gu, (w) => (ALLOW.has(w.toLowerCase()) ? ' ' : w));
  return letters(rest) >= 2;
}
/** For string literals found inside code: only things that read like a sentence/label, not identifiers or css classes. */
function literalLooksUserFacing(s) {
  if (!looksLikeText(s)) return false;
  if (/^[\w./:#@\\-]+$/.test(s) && !/^[A-Z][a-z]/.test(s)) return false; // identifiers, paths, css classes, urls
  if (/^[#.\[]|^[a-z]+[:/]/.test(s)) return false; // selectors, css values, urls
  return /^[A-Z¿¡«"“]/.test(s) || /\s/.test(s);
}
const stripCalls = (s) => s.replace(/\btk?\(\s*(['"`])(?:(?!\1)[\s\S])*\1/g, 'T(');

/** String literals inside a JS expression (simple scanner: ', ", ` with escapes). */
function literals(expr) {
  const out = [];
  for (const m of stripCalls(expr).matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    const body = m[1] ?? m[2] ?? (m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
    out.push({ body, index: m.index });
  }
  return out;
}

/** Index of the matching close brace for the `{` at i (skips strings/template literals). Returns -1 if unbalanced. */
function closeBrace(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (j++; j < s.length && s[j] !== q; j++) { if (s[j] === '\\') j++; else if (q === '`' && s[j] === '$' && s[j + 1] === '{') { j = closeBrace(s, j + 1); if (j < 0) return -1; } }
    } else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

const blank = (s) => s.replace(/[^\n]/g, ' ');
const ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label']);

function scanSvelte(f, src) {
  // Hide comments and <style>; keep <script> separately (scanned like .ts) with line numbers intact.
  let tpl = src.replace(/<!--[\s\S]*?-->/g, blank).replace(/<style[\s\S]*?<\/style>/g, blank);
  const scripts = [];
  tpl = tpl.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (m, body) => {
    scripts.push({ body, offset: m.indexOf(body) });
    return blank(m);
  });
  // `scripts[].offset` is relative to the match: recompute absolute offsets from the original string.
  for (const sc of scripts) {
    const at = src.indexOf(sc.body);
    scanCode(f, sc.body, lineOf(src, at) - 1);
  }

  let buf = '';
  let bufLine = 1;
  let line = 1;
  const flush = () => { if (buf.trim()) add(f, bufLine, buf); buf = ''; };
  const countNl = (s) => (s.match(/\n/g) ?? []).length;
  let i = 0;
  while (i < tpl.length) {
    const c = tpl[i];
    if (c === '{') {
      const end = closeBrace(tpl, i);
      if (end < 0) { buf += c; i++; continue; }
      const inner = tpl.slice(i + 1, end);
      if (!/^\s*[#:/@]/.test(inner)) {
        // {expression} in text: flag user-facing string literals (ternaries etc.), keep the rest as a separator.
        for (const l of literals(inner)) if (literalLooksUserFacing(l.body)) add(f, line + countNl(inner.slice(0, l.index)), l.body);
        scanProps(f, inner, line - 1);
      }
      buf += '{…}';
      line += countNl(inner);
      i = end + 1;
      continue;
    }
    if (c === '<' && /[A-Za-z/!]/.test(tpl[i + 1] ?? '')) {
      flush();
      // read the tag up to its closing '>' (quotes and {braces} may contain '>')
      let j = i + 1;
      const tagStart = j;
      while (j < tpl.length && tpl[j] !== '>') {
        if (tpl[j] === '"' || tpl[j] === "'") { const q = tpl[j]; j++; while (j < tpl.length && tpl[j] !== q) j++; }
        else if (tpl[j] === '{') { const e = closeBrace(tpl, j); j = e < 0 ? tpl.length : e; }
        j++;
      }
      const tag = tpl.slice(tagStart, j);
      scanTag(f, tag, line);
      line += countNl(tag);
      i = j + 1;
      bufLine = line;
      continue;
    }
    if (c === '\n') line++;
    if (!buf.trim()) bufLine = line;
    buf += c;
    i++;
  }
  flush();
}

function scanTag(f, tag, line) {
  let j = tag.search(/[\s/]/);
  if (j < 0) return;
  while (j < tag.length) {
    while (j < tag.length && /[\s/]/.test(tag[j])) { if (tag[j] === '\n') line++; j++; }
    let k = j;
    while (k < tag.length && !/[\s=/]/.test(tag[k])) k++;
    const name = tag.slice(j, k);
    j = k;
    if (!name) { j++; continue; }
    if (tag[j] !== '=') continue;
    j++;
    let val = '';
    let braced = false;
    if (tag[j] === '"' || tag[j] === "'") { const q = tag[j]; const e = tag.indexOf(q, j + 1); val = tag.slice(j + 1, e < 0 ? tag.length : e); j = e < 0 ? tag.length : e + 1; }
    else if (tag[j] === '{') { const e = closeBrace(tag, j); val = tag.slice(j + 1, e < 0 ? tag.length : e); braced = true; j = e < 0 ? tag.length : e + 1; }
    else { let e = j; while (e < tag.length && !/[\s>]/.test(tag[e])) e++; val = tag.slice(j, e); j = e; }
    if (braced) scanProps(f, val, line - 1);
    if (!ATTRS.has(name)) { line += (val.match(/\n/g) ?? []).length; continue; }
    if (braced) {
      for (const l of literals(val)) if (literalLooksUserFacing(l.body)) add(f, line, l.body);
    } else {
      add(f, line, val.replace(/\{[^}]*\}/g, ' '));
    }
    line += (val.match(/\n/g) ?? []).length;
  }
}

// .ts (and <script> blocks): toast('…'), and label:/hint:/title:/… string literals.
const PROPS = 'label|hint|title|sub|what|text|message|error|placeholder|tooltip|caption';
function scanCode(f, src, lineBase = 0) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)));
  scanProps(f, code, lineBase);
}
/** toast('…') and `label: '…'`-style properties, in code or inside a template {expression}. */
function scanProps(f, code, lineBase = 0) {
  const lit = `(?:'((?:[^'\\\\\\n]|\\\\.)*)'|"((?:[^"\\\\\\n]|\\\\.)*)"|\`((?:[^\`\\\\]|\\\\.)*)\`)`;
  const re = new RegExp(`(?:\\btoast\\(\\s*|\\b(?:${PROPS})\\s*:\\s*)${lit}`, 'g');
  for (const m of code.matchAll(re)) {
    const body = (m[1] ?? m[2] ?? (m[3] ?? '').replace(/\$\{[^}]*\}/g, '{…}'));
    if (literalLooksUserFacing(body) || (/\btoast\(/.test(m[0]) && looksLikeText(body))) add(f, lineOf(code, m.index) + lineBase, body);
  }
}

for (const [f, src] of text) {
  if (f.endsWith('.svelte')) scanSvelte(rel(f), src); else scanCode(rel(f), src);
}

// ---------------------------------------------------------------- report
const wanted = (f) => !FILTERS.length || FILTERS.some((x) => f.includes(x));
const shown = [...findings.entries()].filter(([f]) => wanted(f)).sort((a, b) => a[0].localeCompare(b[0]));
let total = 0;
console.log(`== (c) hard-coded text (heuristic${FILTERS.length ? `, filter: ${FILTERS.join(' ')}` : ''})`);
for (const [f, list] of shown) {
  list.sort((a, b) => a.line - b.line);
  total += list.length;
  if (SUMMARY) { console.log(`  ${String(list.length).padStart(4)}  ${f}`); continue; }
  console.log(`  ${f} (${list.length})`);
  for (const x of list) console.log(`    ${f}:${x.line}: ${x.text.length > 90 ? `${x.text.slice(0, 87)}...` : x.text}`);
}
console.log(`  total: ${total} in ${shown.length} files${STRICT ? '' : '  (warnings; --strict makes them fail)'}`);

console.log(`\n${errors ? `FAIL: ${errors} error(s) in (a)/(b)` : 'OK: (a) dictionaries and (b) usage'}${STRICT && total ? `, FAIL: ${total} hard-coded string(s) (--strict)` : ''}`);
process.exit(errors || (STRICT && total) ? 1 : 0);
