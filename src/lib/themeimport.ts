// Importar temas de color de terminal desde texto (Orchestra JSON, Windows Terminal, iTerm2, Alacritty).
// Módulo puro: sin DOM ni Svelte, TypeScript borrable; se prueba con node --test. Nunca evalúa nada ni lanza.

import { ANSI_KEYS, CUSTOM_PREFIX, MAX_CUSTOM_THEMES, baseDef, isCustomThemeId } from './themes.ts';
import type { ThemeDef } from './themes.ts';
import { t } from './i18n.ts';

export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_IMPORT_THEMES = 50;
export const MAX_NAME_LEN = 40;

export type ParseResult =
  | { ok: true; themes: ThemeDef[]; warnings: string[] }
  | { ok: false; error: string };


// ---------- colores ----------

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (se descarta el alfa), `0xrrggbb`, `rgb(r,g,b)`/`rgba(...)` → `#rrggbb` en minúsculas, o null. */
export function parseColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (m) {
    const h = m[1].toLowerCase();
    if (h.length === 3 || h.length === 4) return '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return '#' + h.slice(0, 6);
  }
  m = /^0x([0-9a-f]{6})$/i.exec(s);
  if (m) return '#' + m[1].toLowerCase();
  m = /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(s);
  if (m) {
    const ch = (x: string) => (x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x));
    const [r, g, b] = [ch(m[1]), ch(m[2]), ch(m[3])];
    if (![r, g, b].every(Number.isFinite)) return null;
    return '#' + hex2(r) + hex2(g) + hex2(b);
  }
  return null;
}

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const x = parseInt(hex.slice(i, i + 2), 16) / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Razón de contraste WCAG entre dos `#rrggbb` (1..21). */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// ---------- nombres e ids ----------

export function sanitizeName(raw: unknown, fallback: string): string {
  let s = typeof raw === 'string' ? raw : '';
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/[<>]/g, '');
  s = s.replace(/[\t\r\n]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN).trim();
  return s || fallback;
}

export function slugOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'theme';
}

function freeId(base: string, taken: Set<string>): string {
  let id = CUSTOM_PREFIX + base;
  for (let n = 2; taken.has(id); n++) id = `${CUSTOM_PREFIX}${base}-${n}`;
  taken.add(id);
  return id;
}

/** Reasigna ids para que no choquen entre sí ni con los ya guardados (`-2`, `-3`…). No muta la entrada. */
export function withUniqueIds(incoming: readonly ThemeDef[], existing: readonly ThemeDef[]): ThemeDef[] {
  const taken = new Set(existing.map((d) => d.id));
  return incoming.map((d) => {
    const base = isCustomThemeId(d.id) ? d.id.slice(CUSTOM_PREFIX.length) : slugOf(d.name);
    const id = taken.has(CUSTOM_PREFIX + base) ? freeId(base.replace(/-\d+$/, '') || 'theme', taken) : freeId(base, taken);
    return { ...d, id, custom: true as const };
  });
}

function baseName(fileName: string | undefined): string {
  if (!fileName) return '';
  return (fileName.split(/[\\/]/).pop() ?? '').replace(/\.(json|itermcolors|toml|conf|txt)$/i, '');
}

// ---------- construcción común ----------

interface Raw {
  name?: unknown;
  background?: unknown; foreground?: unknown; cursor?: unknown; selection?: unknown;
  /** 16 posiciones; undefined = ausente. */
  ansi: unknown[];
}

function show(v: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(typeof v === 'string' ? v : JSON.stringify(v) ?? v).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 30);
}

function build(raw: Raw, fallbackName: string, warnings: string[]): ThemeDef {
  const base = baseDef();
  const name = sanitizeName(raw.name, fallbackName);
  const pick = (v: unknown, label: string, dflt: string): string => {
    if (v === undefined || v === null) return dflt;
    const c = parseColor(v);
    if (c) return c;
    warnings.push(t('themeimport.invalidColor', { name, value: show(v), label }));
    return dflt;
  };
  const missingFg = raw.foreground === undefined || raw.foreground === null;
  const missingBg = raw.background === undefined || raw.background === null;
  if (missingBg) warnings.push(t('themeimport.noBackground', { name }));
  if (missingFg) warnings.push(t('themeimport.noForeground', { name }));
  const background = pick(raw.background, 'background', base.background);
  const foreground = pick(raw.foreground, 'foreground', base.foreground);
  // Sin cursor propio, el del color del texto (el ámbar de Orchestra sobre otra paleta desentona).
  const cursor = pick(raw.cursor, 'cursor', raw.cursor === undefined || raw.cursor === null ? foreground : base.cursor);
  const selection = pick(raw.selection, 'selection', base.selection);
  let bad = 0;
  const ansi = ANSI_KEYS.map((k, i) => {
    const v = raw.ansi[i];
    if (v === undefined || v === null) { bad++; return base.ansi[i]; }
    const c = parseColor(v);
    if (c) return c;
    bad++;
    warnings.push(t('themeimport.invalidColor', { name, value: show(v), label: k }));
    return base.ansi[i];
  });
  if (bad) warnings.push(t('themeimport.ansiPartial', { name, n: 16 - bad }));
  if (contrastRatio(background, foreground) < 3) warnings.push(t('themeimport.lowContrast', { name }));
  return { id: '', name, background, foreground, cursor, selection, ansi, custom: true };
}

/** Pone ids únicos, aplica el tope y construye el resultado. */
function finish(defs: ThemeDef[], warnings: string[]): ParseResult {
  if (!defs.length) return { ok: false, error: t('themeimport.noSchemes') };
  let list = defs;
  if (list.length > MAX_IMPORT_THEMES) {
    warnings.push(t('themeimport.onlyFirst', { max: MAX_IMPORT_THEMES, total: list.length }));
    list = list.slice(0, MAX_IMPORT_THEMES);
  }
  const taken = new Set<string>();
  const themes = list.map((d) => ({ ...d, id: freeId(slugOf(d.name), taken) }));
  return { ok: true, themes, warnings };
}

// ---------- JSON (Orchestra y Windows Terminal) ----------

/** Quita comentarios `//` y `/* *\/` y comas finales, respetando las cadenas. */
export function stripJsonc(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  let str = false;
  while (i < n) {
    const c = src[i];
    if (str) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') str = false;
      i++;
      continue;
    }
    if (c === '"') { str = true; out += c; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    out += c;
    i++;
  }
  let res = '';
  str = false;
  for (i = 0; i < out.length; i++) {
    const c = out[i];
    if (str) {
      res += c;
      if (c === '\\') { res += out[i + 1] ?? ''; i++; } else if (c === '"') str = false;
      continue;
    }
    if (c === '"') { str = true; res += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    res += c;
  }
  return res;
}

const WT_ANSI = [
  'black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite',
] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function own(o: Record<string, unknown>, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

/** Un objeto en formato Orchestra o Windows Terminal (o mezcla) → Raw; null si no tiene ningún color. */
function rawFromObject(o: Record<string, unknown>): Raw | null {
  const ansi: unknown[] = new Array(16).fill(undefined);
  const arr = own(o, 'ansi');
  if (Array.isArray(arr)) {
    for (let i = 0; i < 16; i++) ansi[i] = arr[i];
  } else {
    // «magenta»/«brightMagenta» (nombre de xterm) valen como alias de purple.
    for (let i = 0; i < 16; i++) ansi[i] = own(o, WT_ANSI[i]) ?? own(o, ANSI_KEYS[i]);
  }
  const r: Raw = {
    name: own(o, 'name'),
    background: own(o, 'background'),
    foreground: own(o, 'foreground'),
    cursor: own(o, 'cursor') ?? own(o, 'cursorColor'),
    selection: own(o, 'selection') ?? own(o, 'selectionBackground'),
    ansi,
  };
  const any = r.background !== undefined || r.foreground !== undefined || r.cursor !== undefined || r.selection !== undefined
    || ansi.some((v) => v !== undefined);
  return any ? r : null;
}

function parseJson(text: string, fileName: string | undefined): ParseResult {
  let root: unknown;
  try {
    root = JSON.parse(stripJsonc(text));
  } catch {
    return { ok: false, error: t('themeimport.jsonUnreadable') };
  }
  let items: unknown[];
  if (Array.isArray(root)) items = root;
  else if (isObj(root) && Array.isArray(own(root, 'schemes'))) items = own(root, 'schemes') as unknown[];
  else if (isObj(root) && Array.isArray(own(root, 'themes'))) items = own(root, 'themes') as unknown[];
  else if (isObj(root)) items = [root];
  else return { ok: false, error: t('themeimport.jsonNoTheme') };

  const warnings: string[] = [];
  const defs: ThemeDef[] = [];
  const fb = sanitizeName(baseName(fileName), t('themeimport.fallbackImported'));
  const total = items.length;
  // Se lee solo lo necesario: con miles de entradas no se procesa todo.
  for (let i = 0; i < Math.min(total, MAX_IMPORT_THEMES); i++) {
    const it = items[i];
    const raw = isObj(it) ? rawFromObject(it) : null;
    if (!raw) { warnings.push(t('themeimport.skippedEntry', { n: i + 1 })); continue; }
    defs.push(build(raw, total > 1 ? `${fb} ${i + 1}` : fb, warnings));
  }
  if (total > MAX_IMPORT_THEMES) {
    warnings.push(t('themeimport.onlyFirst', { max: MAX_IMPORT_THEMES, total }));
  }
  if (!defs.length) return { ok: false, error: t('themeimport.noSchemesJson') };
  return finish(defs, warnings);
}

// ---------- iTerm2 (.itermcolors, plist XML) ----------

function parseIterm(text: string, fileName: string | undefined): ParseResult {
  const dicts = new Map<string, string>();
  for (const m of text.matchAll(/<key>\s*([^<]{1,60}?)\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)) {
    if (!dicts.has(m[1])) dicts.set(m[1], m[2]);
  }
  const color = (key: string): string | undefined => {
    const d = dicts.get(key);
    if (d === undefined) return undefined;
    const comp: Record<string, number> = {};
    for (const c of d.matchAll(/<key>\s*(Red|Green|Blue) Component\s*<\/key>\s*<(real|integer)>\s*([^<]*?)\s*<\/\2>/g)) {
      comp[c[1]] = parseFloat(c[3]);
    }
    const v = [comp.Red, comp.Green, comp.Blue];
    if (!v.every((x) => Number.isFinite(x))) return 'invalid';
    // Lo normal es 0..1; un valor > 1 se toma como escala 0..255.
    const scale = v.some((x) => x > 1) ? 1 : 255;
    return '#' + v.map((x) => hex2(x * scale)).join('');
  };
  const raw: Raw = {
    background: color('Background Color'), foreground: color('Foreground Color'),
    cursor: color('Cursor Color'), selection: color('Selection Color'),
    ansi: ANSI_KEYS.map((_, i) => color(`Ansi ${i} Color`)),
  };
  const any = raw.background !== undefined || raw.foreground !== undefined || raw.cursor !== undefined
    || raw.selection !== undefined || raw.ansi.some((v) => v !== undefined);
  if (!any) return { ok: false, error: t('themeimport.noIterm') };
  const warnings: string[] = [];
  const def = build({ ...raw, name: baseName(fileName) }, t('themeimport.fallbackIterm'), warnings);
  return finish([def], warnings);
}

// ---------- Alacritty (TOML mínimo) ----------

function stripTomlComment(line: string): string {
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function tomlValue(v: string): string {
  const s = v.trim();
  if (s[0] === '"' || s[0] === "'") {
    const e = s.indexOf(s[0], 1);
    return e < 0 ? s.slice(1) : s.slice(1, e);
  }
  return s.split(/[\s,]/)[0];
}

/** Subconjunto de TOML: `[tabla.sub]`, `clave = valor` (texto o suelto) y tablas en línea de un nivel. Claves planas «tabla.sub.clave». */
export function readToml(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith('[[')) { section = '\0'; continue; }
    const h = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (h) { section = h[1].replace(/["'\s]/g, ''); continue; }
    if (section === '\0') continue;
    const kv = /^([A-Za-z0-9_\-."']+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = (section ? section + '.' : '') + kv[1].replace(/["'\s]/g, '');
    const val = kv[2].trim();
    if (val.startsWith('{')) {
      for (const p of val.matchAll(/([A-Za-z0-9_\-]+)\s*=\s*("[^"]*"|'[^']*'|[^,}\s]+)/g)) out.set(`${key}.${p[1]}`, tomlValue(p[2]));
    } else {
      out.set(key, tomlValue(val));
    }
  }
  return out;
}

const ALACRITTY_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

function parseAlacritty(text: string, fileName: string | undefined): ParseResult {
  const toml = readToml(text);
  const get = (k: string) => toml.get(k);
  const raw: Raw = {
    background: get('colors.primary.background'), foreground: get('colors.primary.foreground'),
    cursor: get('colors.cursor.cursor'), selection: get('colors.selection.background'),
    ansi: [
      ...ALACRITTY_NAMES.map((n) => get(`colors.normal.${n}`)),
      ...ALACRITTY_NAMES.map((n) => get(`colors.bright.${n}`)),
    ],
  };
  const any = raw.background !== undefined || raw.foreground !== undefined || raw.cursor !== undefined
    || raw.selection !== undefined || raw.ansi.some((v) => v !== undefined);
  if (!any) return { ok: false, error: t('themeimport.noAlacritty') };
  const warnings: string[] = [];
  const def = build({ ...raw, name: baseName(fileName) }, t('themeimport.fallbackAlacritty'), warnings);
  return finish([def], warnings);
}

// ---------- entrada principal ----------

/** Detecta el formato por el contenido y devuelve los temas (ids `custom:<slug>` únicos dentro del lote). */
export function parseTheme(text: string, fileName?: string): ParseResult {
  try {
    if (typeof text !== 'string') return { ok: false, error: t('themeimport.nothing') };
    if (text.length > MAX_INPUT_BYTES) return { ok: false, error: t('themeimport.tooLarge') };
    const body = text.replace(/^﻿/, '').trim();
    if (!body) return { ok: false, error: t('themeimport.empty') };
    if (/^<\?xml|<plist[\s>]/i.test(body)) return parseIterm(body, fileName);
    if (/^\s*\[colors(\.[A-Za-z]+)?\]/m.test(body)) return parseAlacritty(body, fileName);
    const j = stripJsonc(body).trim();
    if (j[0] === '{' || j[0] === '[') return parseJson(body, fileName);
    return { ok: false, error: t('themeimport.unrecognized') };
  } catch {
    return { ok: false, error: t('themeimport.unreadable') };
  }
}

/** Orchestra JSON (2 espacios): lo que se descarga o copia, y lo que `parseTheme` vuelve a leer idéntico. */
export function exportTheme(def: ThemeDef): string {
  return JSON.stringify(
    { name: def.name, background: def.background, foreground: def.foreground, cursor: def.cursor, selection: def.selection, ansi: def.ansi },
    null, 2,
  );
}

// ---------- validador de lo guardado ----------

/** Valida la lista guardada: descarta lo mal formado (sin lanzar), ids repetidos y lo que pase de 50. */
export function sanitizeCustomThemes(raw: unknown): ThemeDef[] {
  const out: ThemeDef[] = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set<string>();
  for (const it of raw) {
    if (out.length >= MAX_CUSTOM_THEMES) break;
    try {
      if (!isObj(it)) continue;
      const id = own(it, 'id');
      if (!isCustomThemeId(id) || seen.has(id)) continue;
      const nameRaw = own(it, 'name');
      if (typeof nameRaw !== 'string') continue;
      const name = sanitizeName(nameRaw, '');
      if (!name) continue;
      const bg = parseColor(own(it, 'background'));
      const fg = parseColor(own(it, 'foreground'));
      const cur = parseColor(own(it, 'cursor'));
      const sel = parseColor(own(it, 'selection'));
      const a = own(it, 'ansi');
      if (!bg || !fg || !cur || !sel || !Array.isArray(a) || a.length !== 16) continue;
      const ansi = a.map(parseColor);
      if (ansi.some((c) => c === null)) continue;
      seen.add(id);
      out.push({ id, name, background: bg, foreground: fg, cursor: cur, selection: sel, ansi: ansi as string[], custom: true });
    } catch { /* entrada rara: se descarta */ }
  }
  return out;
}
