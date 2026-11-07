// Consumo: agregados y formato para las pantallas (por sesión y global). Módulo puro (sin Svelte ni Tauri): se prueba
// con node --test. Los datos vienen de consumo.rs (tipos en backend.ts); aquí solo se agrupan, se ordenan y se escriben.

import type {
  ConsumoCat, ConsumoCatAgg, ConsumoEvent, ConsumoScanReport, ConsumoSessionReport, ConsumoTopBlock,
  ConsumoOrigin, ConsumoAdvice,
} from './backend.ts';
import { tokK } from './tokfmt.ts';
import { tk, tn, getLocale } from './i18n.ts';
import type { ConsumoEvidence } from './backend.ts';

/** De dónde salen los datos. Hoy solo hay analizador de Claude; codex/opencode llegarán después (ver investigación). */
export type ConsumoProvider = 'claude' | 'codex' | 'opencode';
export const CONSUMO_PROVIDERS: readonly ConsumoProvider[] = ['claude', 'codex', 'opencode'];
/** Proveedores con analizador construido. */
export const CONSUMO_READY: readonly ConsumoProvider[] = ['claude'];

/** «eq» = equivalente en tokens de entrada (lo que se muestra por defecto); «usd» = estimación a precio de API. */
export type Unit = 'eq' | 'usd';

// ───────────── categorías → 8 grupos con color fijo ─────────────

/**
 * Grupos de la barra apilada, en orden fijo (el color va con el grupo, nunca con su rango). 7 grupos.
 *
 * Paleta: con 8 tonos de la paleta categórica oscura ningún orden pasa el validador de dataviz con TODAS las parejas
 * (en una leyenda cualquier pareja puede quedar junta; la crítica vio Read/Otros y Razonamiento/Avisos iguales).
 * Solución con codificación compuesta: 3 tonos que pasan todas las parejas (azul, naranja, aguamarina:
 * `validate_palette.js "#3987e5,#d95926,#199e70" --mode dark --surface "#13161b" --pairs all` → PASS, CVD 9,4,
 * normal 20,9, contraste ≥ 3:1), cada uno con una variante rayada (textura a 45°) para su pareja de familia, y
 * «Otros» en gris neutro (el gris es para «otros», nunca para una serie):
 *   base fija / avisos-skills-memoria (texto inyectado) = azul liso / azul rayado
 *   salida / razonamiento (generado)                     = naranja liso / naranja rayado
 *   Bash / Read (resultados de herramienta)               = aguamarina liso / aguamarina rayado
 *   otros (Grep, MCP, imágenes, resultados de subagente…) = gris
 */
export const GROUPS = ['base', 'reminder', 'output', 'thinking', 'bash', 'read', 'other'] as const;
export type Group = (typeof GROUPS)[number];

export const GROUP_COLOR: Record<Group, string> = {
  base: '#3987e5', reminder: '#3987e5', output: '#d95926', thinking: '#d95926', bash: '#199e70', read: '#199e70', other: '#6b717c',
};
const HATCHED: ReadonlySet<Group> = new Set(['reminder', 'thinking', 'read']);

/** Relleno CSS del grupo: liso o rayado a 45° (rayas del color de la superficie). */
export function groupFill(g: Group): string {
  const c = GROUP_COLOR[g];
  return HATCHED.has(g) ? `repeating-linear-gradient(45deg, ${c} 0 3px, color-mix(in srgb, ${c} 35%, #13161b) 3px 5.5px)` : c;
}

export function groupOf(cat: ConsumoCat): Group {
  switch (cat) {
    case 'base': case 'output': case 'thinking': case 'bash': case 'read': case 'reminder': return cat;
    default: return 'other'; // subagent, search, mcp, image, user, compact, otherTool, unattributed
  }
}

/** Tokens que genera el modelo (se pagan a precio de salida). El resto de grupos es contexto que entra, por origen. */
export const GENERATED: ReadonlySet<Group> = new Set(['output', 'thinking']);
export type Section = 'context' | 'generated';
export const sectionOf = (g: Group): Section => (GENERATED.has(g) ? 'generated' : 'context');

export interface Slice { group: Group; t: number; eq: number; usd: number; count: number; pct: number }

/** Suma por grupo, en el orden fijo de GROUPS, sin los vacíos; `pct` sobre la unidad elegida. */
export function slices(cats: ConsumoCatAgg[], unit: Unit): Slice[] {
  const m = new Map<Group, Slice>();
  for (const c of cats) {
    const g = groupOf(c.cat);
    const s = m.get(g) ?? { group: g, t: 0, eq: 0, usd: 0, count: 0, pct: 0 };
    s.t += c.t; s.eq += c.eq; s.usd += c.usd; s.count += c.count;
    m.set(g, s);
  }
  // Dos tramos que no se mezclan: primero el CONTEXTO por origen (base, avisos, Bash, Read; «otros» al final del
  // tramo) y después lo GENERADO (salida, razonamiento). Dentro de cada tramo, por tamaño. Leyenda y barra en el
  // mismo orden. % por mayor resto.
  const rank = (g: Group) => (GENERATED.has(g) ? 2 : g === 'other' ? 1 : 0);
  const out = GROUPS.map((g) => m.get(g)).filter((s): s is Slice => !!s && s[unit] > 0)
    .sort((a, b) => rank(a.group) - rank(b.group) || b[unit] - a[unit]);
  const sh = roundShares(out.map((s) => s[unit]));
  return out.map((s, i) => ({ ...s, pct: sh[i] }));
}

/** Categorías que caben en «other», para el detalle del tooltip. */
export function otherCats(cats: ConsumoCatAgg[], unit: Unit): ConsumoCatAgg[] {
  return cats.filter((c) => groupOf(c.cat) === 'other' && c[unit] > 0).sort((a, b) => b[unit] - a[unit]);
}

export function sumCats(cats: ConsumoCatAgg[], unit: Unit): number { return cats.reduce((a, c) => a + c[unit], 0); }

// ───────────── formato (con el idioma: coma decimal en ES) ─────────────

export type Lang = 'en' | 'es';
const LOC: Record<Lang, string> = { en: 'en-US', es: 'es-ES' };
export const langOf = (l: string | undefined): Lang => (l === 'es' ? 'es' : 'en');

/** Entero con separador de miles del idioma, también con 4 cifras (es-ES de serie deja «9287»; aquí «9.287»). */
export function fmtNum(n: number, lang: Lang = 'en'): string {
  return Math.round(Number.isFinite(n) ? n : 0).toLocaleString(LOC[lang], { useGrouping: 'always' } as unknown as Intl.NumberFormatOptions);
}

/**
 * Reparto en décimas de punto por MAYOR RESTO: devuelve fracciones (múltiplos de 0,001) que suman exactamente 1
 * (100,0 %) si la suma es > 0. `rest` = parte del total que no está en `values` (p. ej. el resto de subagentes):
 * entra en el reparto pero no se devuelve, así las filas visibles + el resto cierran en 100,0 %.
 */
export function roundShares(values: number[], rest = 0): number[] {
  const all = rest > 0 ? [...values, rest] : values;
  const sum = all.reduce((a, v) => a + Math.max(0, v), 0);
  if (!(sum > 0)) return values.map(() => 0);
  const raw = all.map((v) => (Math.max(0, v) / sum) * 1000);
  const fl = raw.map(Math.floor);
  let left = 1000 - fl.reduce((a, v) => a + v, 0);
  const order = raw.map((v, i) => [v - fl[i], i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; fl[i] += 1; left -= 1; }
  return fl.slice(0, values.length).map((v) => v / 1000);
}

/** Tokens (o tokens equivalentes) en corto: EN 253.9M · 289k; ES 253,9 M · 289 k. */
export function fmtTok(n: number, lang: Lang = 'en'): string {
  const s = tokK(n);
  if (lang !== 'es') return s;
  return s.replace('.', ',').replace(/([0-9])([kMB])$/, '$1 $2');
}

/** USD, siempre con 2 decimales: EN $1,234.56 · ES 1.234,56 $ (miles también con 4 cifras). */
export function fmtUsd(n: number, lang: Lang = 'en'): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  const s = v.toLocaleString(LOC[lang], { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' } as unknown as Intl.NumberFormatOptions);
  return lang === 'es' ? `${s} $` : `$${s}`;
}

export function fmtUnit(n: number, unit: Unit, lang: Lang = 'en'): string { return unit === 'usd' ? fmtUsd(n, lang) : fmtTok(n, lang); }

/** Siempre un decimal: 0.256 → "25.6 %" (o "25,6 %" con coma decimal); < 0.05 % → "<0.1 %". */
export function fmtPct(p: number, comma = false): string {
  if (!Number.isFinite(p) || p <= 0) return '0 %';
  const s = p < 0.0005 ? '<0.1' : (p * 100).toFixed(1);
  return `${comma ? s.replace('.', ',') : s} %`;
}

/** Variación: +23 % · −12 % (signo menos de verdad). */
export function fmtDelta(d: number, lang: Lang = 'en'): string {
  if (!Number.isFinite(d)) return '';
  const a = Math.abs(d) * 100;
  const s = (a >= 10 ? Math.round(a).toString() : a.toFixed(1)).replace('.', lang === 'es' ? ',' : '.');
  return `${d >= 0 ? '+' : '−'}${s} %`;
}

/** 7200 s → "2 h", 420 → "7 min", 40 → "40 s". */
export function fmtGap(s: number, lang: Lang = 'en'): string {
  const c = (x: string) => (lang === 'es' ? x.replace('.', ',') : x);
  if (s >= 5400) return `${c((s / 3600).toFixed(s >= 36000 ? 0 : 1))} h`;
  if (s >= 90) return `${Math.round(s / 60)} min`;
  return `${Math.max(0, Math.round(s))} s`;
}

/**
 * Ruta larga cortada por el medio conservando el nombre del fichero: «…\lib\backend.ts». Si no es una ruta
 * (comando, texto) se corta por el final. Siempre ≤ `max` caracteres.
 */
export function midPath(s: string, max = 44): string {
  if (s.length <= max) return s;
  const isPath = !/\s/.test(s) && /[\\/]/.test(s);
  if (!isPath) return `${s.slice(0, max - 1)}…`;
  const parts = s.split(/(?=[\\/])/); // conserva el separador delante de cada trozo
  let out = parts[parts.length - 1];
  if (out.length + 1 > max) return `…${out.slice(out.length - (max - 1))}`;
  for (let i = parts.length - 2; i >= 1; i--) {
    if (parts[i].length + out.length + 1 > max) break;
    out = parts[i] + out;
  }
  return `…${out}`;
}

/**
 * Fórmula del coste real de un bloque, con sus pesos reales (vienen de Rust): coste = t × w + t × n × r.
 * `w` = escritura en caché por token (0 si entró antes del periodo), `n` = relecturas en el periodo, `r` = lectura de
 * caché por token y relectura. En tokens de entrada equivalentes; el USD es el mismo coste a precio de API.
 */
export interface Formula { t: number; w: number; n: number; r: number; write: number; read: number; total: number }
export function costFormula(b: { t: number; w?: number; n?: number; r?: number }): Formula {
  const w = b.w ?? 0, n = b.n ?? 0, r = b.r ?? 0;
  const write = b.t * w, read = b.t * n * r;
  return { t: b.t, w, n, r, write, read, total: write + read };
}

/** Peso con 2 decimales en el idioma (2,00 · 0,05). */
/** «claude-opus-5-5-20261001» → «Opus 5.5». */
export function modelName(m: string): string {
  const x = m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*$/, '');
  const mm = /^([a-z]+)-(\d+)(?:-(\d+))?/.exec(x);
  if (!mm) return x;
  return `${mm[1][0].toUpperCase()}${mm[1].slice(1)} ${mm[2]}${mm[3] ? `.${mm[3]}` : ''}`;
}

export function fmtWeight(x: number, lang: Lang = 'en'): string {
  return x.toLocaleString(LOC[lang], { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}

// ───────────── rutas: nada personal en pantalla ─────────────

/** Codificación de Claude Code para la carpeta de un proyecto: todo lo que no es letra o cifra pasa a «-». */
export function encodeProject(path: string): string { return path.replace(/[^A-Za-z0-9]/g, '-'); }

/** Carpeta de proyecto (la que cuelga de `projects`) de la ruta de un transcript. */
export function projectKeyOf(path: string | undefined): string {
  if (!path) return '';
  const parts = path.split(/[\\/]+/);
  const i = parts.map((p) => p.toLowerCase()).lastIndexOf('projects');
  return i >= 0 && i + 1 < parts.length ? parts[i + 1] : '';
}

const HOME_RE = /(?:[A-Za-z]:[\\/]|\/[a-z]\/|\/)(?:Users|home)[\\/][^\\/\s"'`]+/gi;

/**
 * Abrevia una ruta o comando para mostrarlo: la carpeta del proyecto (si se conoce su clave `C--x-app`) pasa a
 * `projectLabel` («<project>») y la carpeta personal (C:\Users\nombre, /c/Users/nombre, /home/nombre) a «~».
 */
export function shortPath(s: string, projectKey = '', projectLabel = '<project>', home = ''): string {
  // C11: una sola normalización: separadores repetidos («C:\\Users», «a//b») a uno (salvo el «\\» inicial de UNC).
  //     «https://» no se toca.
  let out = s.replace(/(?<!^)\\{2,}/g, '\\').replace(/(?<!^)(?<!:)\/{2,}/g, '/');
  if (projectKey.length > 3) {
    const n = projectKey.length;
    const keyL = projectKey.toLowerCase();
    // Forma msys (/e/x/y) de la misma ruta: «E--x-y» → «-e-x-y».
    const msys = keyL.replace(/^([a-z])--/, '-$1-');
    let i = 0;
    let res = '';
    while (i < out.length) {
      const prev = i === 0 ? ' ' : out[i - 1];
      const startOk = /[\s"'`=(]/.test(prev);
      const cand = out.slice(i, i + n);
      const next = out[i + n];
      const endOk = next === undefined || /[\\/\s"'`)]/.test(next);
      if (startOk && endOk && cand.length === n && (encodeProject(cand).toLowerCase() === keyL || encodeProject(cand).toLowerCase() === msys)
        && /[\\/]/.test(cand)) {
        // Sin etiqueta (C11): la ruta queda relativa al proyecto («src/lib/x.ts»), sin marcador ni separador delante.
        i += n;
        if (projectLabel) res += projectLabel;
        else if (/[\\/]/.test(out[i] ?? '')) i++;
        else res += '.';
      } else {
        res += out[i];
        i++;
      }
    }
    out = res;
  }
  if (home) {
    const esc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\\/g, '[\\\\/]');
    out = out.replace(new RegExp(esc, 'gi'), '~');
  }
  return out.replace(HOME_RE, '~');
}

/** Nombre legible de una carpeta de proyecto: «C--Users-ana-app» → «~-app» si `home` es C:\Users\ana; si no, «C:/Users-ana-app». */
export function projectLabel(key: string, home = ''): string {
  if (!key) return '?';
  const h = home ? encodeProject(home) : '';
  if (h && key.toLowerCase().startsWith(h.toLowerCase())) {
    const rest = key.slice(h.length).replace(/^-/, '');
    return rest ? `~/${rest}` : '~';
  }
  const m = /^([A-Za-z])--(.*)$/.exec(key);
  if (!m) return key;
  // «Users-nombre-…» sin saber dónde acaba el nombre: se tapa hasta el siguiente «-».
  const rest = m[2].replace(/^Users-[^-]+-?/i, '~/');
  return rest.startsWith('~/') ? (rest === '~/' ? '~' : rest) : `${m[1].toUpperCase()}:/${rest}`;
}

/** «main» / «sub:obrero» → tipo de agente o null para el hilo principal. */
export function whoType(who: string | undefined | null): string | null {
  if (!who || who === 'main') return null;
  return who.startsWith('sub:') ? who.slice(4) : who;
}

// ───────────── tiempo: días locales ─────────────

/** Comienzo (epoch s) del día local que contiene `ts`. */
export function dayStart(ts: number): number {
  const d = new Date(ts * 1000);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
}

export interface Day {
  start: number; eq: number; usd: number; requests: number;
  /** Por grupo de la barra «Adónde va» (mismo orden y color): [eq, usd]. Vacío si el backend no lo da. */
  g?: Partial<Record<Group, [number, number]>>;
  /** Día (u hora) que aún no ha terminado: la columna es parcial. */
  partial?: boolean;
}

/** Reparte `byHourCat` en los días (u horas) de `out` por grupo y marca el último como parcial si contiene `now`. */
export function stackDays(out: Day[], byHourCat: [number, ConsumoCat, number, number][] | undefined, now: number, hourly = false): Day[] {
  const span = hourly ? 3600 : 0;
  for (const d of out) d.g = {};
  if (byHourCat) {
    for (const [h, cat, eq, usd] of byHourCat) {
      const ts = h * 3600;
      const d = hourly ? out.find((x) => ts >= x.start && ts < x.start + span) : out.find((x) => x.start === dayStart(ts));
      if (!d) continue;
      const g = groupOf(cat);
      const v = (d.g![g] ??= [0, 0]);
      v[0] += eq; v[1] += usd;
    }
  }
  for (const d of out) d.partial = hourly ? now >= d.start && now < d.start + 3600 : dayStart(now) === d.start;
  return out;
}

/**
 * Los últimos `days` días locales hasta `now` (1 = solo hoy), con la factura de `byHour` sumada a cada uno.
 * Los días sin actividad salen a cero (la gráfica no se salta días).
 */
export function localDays(byHour: [number, number, number, number][], days: number, now: number): Day[] {
  const out: Day[] = [];
  let s = dayStart(now);
  for (let i = 0; i < Math.max(1, days); i++) {
    out.unshift({ start: s, eq: 0, usd: 0, requests: 0 });
    s = dayStart(s - 43200); // medio día antes cae en el día anterior aunque haya cambio de hora
  }
  const first = out[0].start;
  for (const [h, eq, usd, n] of byHour) {
    const ts = h * 3600;
    if (ts < first) continue;
    const ds = dayStart(ts);
    const d = out.find((x) => x.start === ds);
    if (d) { d.eq += eq; d.usd += usd; d.requests += n; }
  }
  return out;
}

// ───────────── listas ordenadas con «otros» ─────────────

export interface Row { key: string; eq: number; usd: number; requests: number; pct: number; other?: number }

/**
 * Ordena por la unidad, se queda con `limit` filas y pliega el resto en una fila «other» (key = '').
 * `pct` sobre `total` si se da (un solo denominador para toda la pantalla); si no, sobre la suma de las filas.
 */
export function rankRows(rows: [string, number, number, number][], unit: Unit, limit = 6, total?: number): Row[] {
  const all = rows.map(([key, eq, usd, requests]) => ({ key, eq, usd, requests, pct: 0 }))
    .filter((r) => r[unit] > 0).sort((a, b) => b[unit] - a[unit]);
  const den = total ?? all.reduce((a, r) => a + r[unit], 0);
  const head = all.slice(0, limit);
  const tail = all.slice(limit);
  if (tail.length) {
    head.push(tail.reduce((a, r) => ({ ...a, eq: a.eq + r.eq, usd: a.usd + r.usd, requests: a.requests + r.requests }),
      { key: '', eq: 0, usd: 0, requests: 0, pct: 0, other: tail.length } as Row));
  }
  // % por mayor resto sobre `den` (lo que no está en las filas, p. ej. el hilo principal en subTypes, es el resto).
  const sum = head.reduce((a, r) => a + r[unit], 0);
  const sh = roundShares(head.map((r) => r[unit]), Math.max(0, den - sum));
  return head.map((r, i) => ({ ...r, pct: den > 0 ? sh[i] : 0 }));
}

/** Por quién (hilo principal y cada tipo de subagente). */
export function whoRows(byWho: [string, number, number, number][], unit: Unit, limit = 6): Row[] {
  return rankRows(byWho, unit, limit);
}

// ───────────── bloques caros agrupados por origen (como «Bloques más caros, agrupados por origen» del informe) ─────────────

/** Comando normalizado (= consejos.rs `command_key`): sin `cd …&&`, sin VAR=x, programa + subcomando: «cargo test». */
export function commandKey(cmd: string): string {
  let s = cmd.trim();
  for (;;) {
    if (!s.toLowerCase().startsWith('cd ')) break;
    const a = s.indexOf('&&'), b = s.indexOf(';');
    if (a >= 0) s = s.slice(a + 2).trim();
    else if (b >= 0) s = s.slice(b + 1).trim();
    else break;
  }
  const words = s.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && words[i].includes('=') && !words[i].startsWith('-') && !words[i].includes('/')) i++;
  if (i >= words.length) return '';
  const base = (w: string) => { const x = w.replace(/^["']+|["']+$/g, ''); const parts = x.split(/[\\/]/); return parts[parts.length - 1] || x; };
  let key = base(words[i]);
  const w2 = words[i + 1]?.replace(/^["']+|["']+$/g, '');
  if (w2 && !w2.startsWith('-') && !/[\\/.|><$]/.test(w2) && w2.length <= 24) key += ` ${w2}`;
  return key;
}

/** Origen de un bloque: Bash → comando normalizado; Read → nombre del fichero; resto → herramienta (o skill). */
export function originOf(b: ConsumoTopBlock): string {
  const what = b.detail ?? b.tool ?? '';
  if (b.cat === 'bash') return commandKey(what) || what;
  if (b.cat === 'read') { const p = what.split(/[\\/]/); return p[p.length - 1] || what; }
  return b.tool ?? what;
}

export interface TopGroup<T extends ConsumoTopBlock = ConsumoTopBlock> {
  key: string; cat: ConsumoCat; tool?: string; origin: string; n: number; t: number; eq: number; usd: number;
  /** Parte del TOTAL del periodo/sesión (no de la tabla): lo que explica de verdad. */
  pct: number;
  items: T[];
}

/** Agrupa los bloques por (categoría, origen), ordenados por coste en la unidad; `pct` sobre `total`. */
export function groupTop<T extends ConsumoTopBlock>(rows: T[], unit: Unit, total: number): TopGroup<T>[] {
  const m = new Map<string, TopGroup<T>>();
  for (const b of rows) {
    const origin = originOf(b);
    const key = `${b.cat}|${origin}`;
    const g = m.get(key) ?? { key, cat: b.cat, tool: b.tool, origin, n: 0, t: 0, eq: 0, usd: 0, pct: 0, items: [] };
    g.n += 1; g.t += b.t; g.eq += b.eq; g.usd += b.usd; g.items.push(b);
    m.set(key, g);
  }
  return [...m.values()].map((g) => ({ ...g, pct: total > 0 ? g[unit] / total : 0, items: [...g.items].sort((a, b) => b[unit] - a[unit]) }))
    .sort((a, b) => b[unit] - a[unit]);
}

/** Clave de origen de un bloque (= consejos.rs `origin_of`): Read por proyecto + ruta COMPLETA, Bash por comando. */
export function originKeyOf(b: ConsumoTopBlock): string {
  const what = b.detail ?? b.tool ?? '';
  if (b.cat === 'read') return `read|${projectKeyOf(b.session)}|${what}`;
  if (b.cat === 'bash') return `bash|${commandKey(what) || what}`;
  if (b.cat === 'image') return `image|${b.session ?? ''}`;
  return `${b.cat}|${b.tool ?? what}`;
}

/**
 * Filas de «Bloques más caros» desde los orígenes de Rust (las MISMAS cifras que citan los consejos y el informe:
 * todos los bloques del periodo, no solo los del top). `items` = los bloques del top que caen en cada origen.
 * Sin `origins` (datos viejos) agrupa el top como antes.
 */
export function originGroups<T extends ConsumoTopBlock>(origins: ConsumoOrigin[] | undefined, rows: T[], unit: Unit, total: number): TopGroup<T>[] {
  if (!origins?.length) return groupTop(rows, unit, total);
  const items = new Map<string, T[]>();
  for (const b of rows) { const k = originKeyOf(b); items.set(k, [...(items.get(k) ?? []), b]); }
  return origins.map((o) => ({
    key: o.key, cat: o.cat, tool: o.cat === 'read' || o.cat === 'bash' ? undefined : o.label, origin: o.label, n: o.n, t: o.t, eq: o.eq, usd: o.usd,
    pct: total > 0 ? o[unit] / total : 0,
    items: [...(items.get(o.key) ?? [])].sort((a, b) => b[unit] - a[unit]),
  })).sort((a, b) => b[unit] - a[unit] || a.key.localeCompare(b.key));
}

/** id de DOM estable de la fila de un origen (los consejos enlazan a ella). */
export function originDomId(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `org-${h.toString(16)}`;
}

/** Ruta partida en carpeta (puede pasar de línea tras cada separador) y nombre (no se parte nunca). */
export function splitPath(p: string): { dir: string; name: string } {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i < 0 || /\s/.test(p.slice(0, i))) return { dir: '', name: p };
  return { dir: p.slice(0, i + 1).replace(/([\\/])/g, '$1\u200b'), name: p.slice(i + 1) };
}

/** Parámetros de un texto de consejo, formateados en el idioma de la interfaz (convenciones de consejos.rs `tx`):
 *  `…Tok` tokens, `…Pct` fracción, `…Dec` un decimal, número = entero, «@x» = fragmento, `who` «main» = hilo principal. */
function adviceVars(p: Record<string, string | number> | undefined, lang: Lang, textId = ''): Record<string, string> {
  const out: Record<string, string> = {};
  const plurals: [string, number][] = [];
  for (const [k, v] of Object.entries(p ?? {})) {
    if (typeof v === 'string') out[k] = v.startsWith('@') ? tk(`consumo.adv.frag.${v.slice(1)}`) : k === 'who' && v === 'main' ? tk('consumo.row.main') : v;
    else if (k.endsWith('Pl')) plurals.push([k, v]);
    else if (k.endsWith('Tok')) out[k] = fmtTok(v, lang);
    else if (k.endsWith('Pct')) out[k] = fmtPct(v, lang === 'es');
    else if (k.endsWith('Dec')) out[k] = v.toLocaleString(LOC[lang], { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    else out[k] = fmtNum(v, lang);
  }
  // C11: «…Pl» = número con su nombre en singular o plural (`consumo.adv.pl.<textId>.<nombre>.one|other`, tn()).
  // tn() pone su propio {n}: el «n» de los parámetros no puede pisarlo.
  const { n: _n, ...rest } = out;
  for (const [k, v] of plurals) out[k] = tn(`consumo.adv.pl.${textId}.${k.slice(0, -2)}`, v, rest);
  return out;
}

/** Título, por qué o qué hacer de un consejo EN EL IDIOMA DE LA INTERFAZ (no en el del escaneo): clave
 *  `consumo.adv.<textId>.<campo>[<Variante>]` con sus parámetros. Sin `textId` (datos viejos), el texto de Rust. */
export function adviceText(a: ConsumoAdvice, field: 'title' | 'why' | 'action'): string {
  if (!a.textId) return a[field];
  const v = a.params?.[`${field}V`];
  const sub = `${field}${v ? String(v)[0].toUpperCase() + String(v).slice(1) : ''}`;
  const s = tk(`consumo.adv.${a.textId}.${sub}`, adviceVars(a.params, langOf(getLocale()), a.textId));
  return s === `consumo.adv.${a.textId}.${sub}` ? a[field] : s;
}

/** C11: la suposición que modela el «después» de un consejo, en el idioma de la interfaz («suponiendo salidas…»). */
export function adviceAssume(a: ConsumoAdvice): string {
  if (!a.assume) return '';
  const k = `consumo.adv.assume.${a.assume}`;
  const s = tk(k, adviceVars(a.assumeP, langOf(getLocale()), a.textId));
  return s === k ? '' : s;
}

/** C11: consejos en el orden de la unidad de la pantalla (ahorro en eq o en USD, de mayor a menor; empate por id). */
export function sortAdvice<T extends { id: string; saveEq: number; saveUsd: number }>(list: T[], unit: Unit): T[] {
  const v = (a: T) => (unit === 'usd' ? a.saveUsd : a.saveEq);
  return [...list].sort((a, b) => v(b) - v(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Etiqueta de una prueba de consejo en el idioma de la interfaz (las que tienen texto; el resto son rutas/comandos). */
export function evidenceLabel(e: ConsumoEvidence): string {
  if (!e.labelId) return e.label;
  const s = tk(`consumo.adv.ev.${e.labelId}`, adviceVars(e.lp, langOf(getLocale()), 'ev'));
  return s === `consumo.adv.ev.${e.labelId}` ? e.label : s;
}

/** Clase de un error del análisis para enseñarlo traducido (el texto crudo va en «Ver detalle»). */
export function errorKind(err: string): 'read' | 'parse' | 'other' {
  if (/os error|permission|denied|not found|no such file|cannot find|access|acceso|io error/i.test(err)) return 'read';
  if (/json|parse|expected|invalid|utf-?8|eof/i.test(err)) return 'parse';
  return 'other';
}

/** Ahorro de un consejo en la unidad de la pantalla, sobre el total de la MISMA vista (0..1). */
export function adviceShare(a: ConsumoAdvice, unit: Unit): number {
  const tot = unit === 'usd' ? a.totalUsd : a.totalEq;
  if (!tot) return a.savePct;
  return (unit === 'usd' ? a.saveUsd : a.saveEq) / tot;
}

/** Invariantes de los consejos (C9) contra los orígenes y el total de la vista; [] = todo cuadra. */
export function adviceIssues(advice: ConsumoAdvice[], origins: ConsumoOrigin[] | undefined, totalUsd: number, tol = 1e-9): string[] {
  const out: string[] = [];
  const le = (a: number, b: number) => a <= b * (1 + tol) + 1e-9;
  const sum = new Map<string, [number, number]>();
  let all = 0;
  for (const a of advice) {
    const ou = a.originUsd ?? Infinity;
    if (!le(a.saveUsd, ou)) out.push(`${a.id}: ahorro ${a.saveUsd} > origen ${ou} (${a.origin})`);
    if (!le(ou === Infinity ? 0 : ou, totalUsd)) out.push(`${a.id}: origen ${ou} > total ${totalUsd}`);
    const k = a.origin ?? '';
    const e = sum.get(k) ?? [0, ou];
    e[0] += a.saveUsd; sum.set(k, e);
    all += a.saveUsd;
    if (/^(read|bash|image|reminder)\|/.test(k)) {
      const row = origins?.find((o) => o.key === k);
      if (!row) out.push(`${a.id}: el origen ${k} no tiene fila`);
      else if (row.n !== a.originN || row.t !== a.originT || Math.abs(row.usd - (a.originUsd ?? 0)) > 1e-9) out.push(`${a.id}: cita ${a.originN}×/${a.originT}, la fila ${row.n}×/${row.t}`);
      else if (a.nums?.rowN !== undefined && a.nums.rowN !== row.n) out.push(`${a.id}: el texto cita ${a.nums.rowN} veces, la fila ${row.n}`);
    }
  }
  for (const [k, [sm, ou]] of sum) if (!le(sm, ou)) out.push(`Σ ahorros de ${k || '(total)'} ${sm} > ${ou}`);
  if (!le(all, totalUsd)) out.push(`Σ de todos los ahorros ${all} > total ${totalUsd}`);
  return out;
}

// ───────────── vista global ─────────────

export type Period = 1 | 7 | 30;
export const PERIODS: readonly Period[] = [1, 7, 30];

/** Inicio del periodo que se pide al backend: medianoche local de hace `period − 1` días (hoy = medianoche de hoy). */
export function periodSince(period: Period, now: number): number {
  let s = dayStart(now);
  for (let i = 1; i < period; i++) s = dayStart(s - 43200);
  return s;
}

/** Sobrecoste de un tipo de suceso. `kind`: expired | modelChanged | prefixChanged | coldStart | compaction. */
export interface EventCost { kind: string; eq: number; usd: number; count: number }

export interface GlobalModel {
  provider: ConsumoProvider;
  days: Day[];
  /** EL total del periodo: de él salen todos los repartos (Σ de cada uno = total). */
  totalEq: number; totalUsd: number; total: number;
  /** Total del periodo anterior de igual duración y su variación (null si no hay con qué comparar). */
  prev: number; delta: number | null; prevPartial: boolean;
  requests: number;
  slices: Slice[];
  projects: Row[]; models: Row[];
  /** Hilo principal y subagentes (2 filas), % sobre el total. */
  who: Row[];
  mainPct: number; subPct: number;
  /** Subagentes por tipo, % sobre el TOTAL del periodo (mismo denominador que todo lo demás). */
  subTypes: Row[];
  /** Todos los bloques caros, ordenados; la vista enseña 5 y «ver más». */
  top: ConsumoTopBlock[];
  /** Sucesos con su sobrecoste, ordenados por coste. */
  eventCost: EventCost[];
  events: { compactions: number; expired: number; modelChanged: number; prefixChanged: number; coldStarts: number; breakEq: number; breakUsd: number };
  baseMain: number; baseSub: number;
  files: number; mainFiles: number; subFiles: number;
}

export function globalModel(r: ConsumoScanReport, period: Period, now: number, unit: Unit, provider: ConsumoProvider = 'claude'): GlobalModel {
  const totalEq = r.total?.[0] ?? sumCats(r.cats, 'eq');
  const totalUsd = r.total?.[1] ?? sumCats(r.cats, 'usd');
  const total = unit === 'usd' ? totalUsd : totalEq;
  const prev = r.prevTotal ? (unit === 'usd' ? r.prevTotal[1] : r.prevTotal[0]) : 0;
  const days = stackDays(period === 1 ? hoursOfToday(r.byHour, now) : localDays(r.byHour, period, now), r.byHourCat, now, period === 1);
  const fold = r.byWho.map(([k, eq, usd, n]) => [k.startsWith('sub:') ? 'sub' : 'main', eq, usd, n] as [string, number, number, number])
    .reduce((acc, x) => { const e = acc.find((y) => y[0] === x[0]); if (e) { e[1] += x[1]; e[2] += x[2]; e[3] += x[3]; } else acc.push([...x]); return acc; }, [] as [string, number, number, number][]);
  const who = rankRows(fold, unit, 2, total);
  const ev = r.eventCost ?? [];
  return {
    provider, days, totalEq, totalUsd, total,
    // Δ % solo si el periodo anterior está entero (si no, compara con medio periodo: +8512 %).
    prev, delta: prev > 0 && r.prevComplete !== false ? (total - prev) / prev : null, prevPartial: r.prevComplete === false && prev > 0,
    requests: r.requests,
    slices: slices(r.cats, unit),
    projects: rankRows(r.byProject, unit, 6, total),
    models: rankRows(r.byModel, unit, 4, total),
    who,
    mainPct: who.find((x) => x.key === 'main')?.pct ?? 0,
    subPct: who.find((x) => x.key === 'sub')?.pct ?? 0,
    subTypes: rankRows(r.byWho.filter(([k]) => k.startsWith('sub:')).map(([k, ...v]) => [k.slice(4), ...v] as [string, number, number, number]), unit, 6, total),
    top: [...r.top].sort((a, b) => b[unit] - a[unit]),
    eventCost: ev.map(([kind, eq, usd, count]) => ({ kind, eq, usd, count })).sort((a, b) => b[unit] - a[unit]),
    events: {
      compactions: r.compactions, expired: r.breakCauses[0], modelChanged: r.breakCauses[1], prefixChanged: r.breakCauses[2],
      coldStarts: r.coldStarts, breakEq: r.breakCost?.[0] ?? 0, breakUsd: r.breakCost?.[1] ?? 0,
    },
    baseMain: r.baseMeanMain, baseSub: r.baseMeanSub,
    files: r.files, mainFiles: r.mainFiles, subFiles: r.subFiles,
  };
}

/** Hoy, por horas locales (24 columnas; `start` = comienzo de la hora). */
export function hoursOfToday(byHour: [number, number, number, number][], now: number): Day[] {
  const s = dayStart(now);
  const out: Day[] = Array.from({ length: 24 }, (_, i) => ({ start: s + i * 3600, eq: 0, usd: 0, requests: 0 }));
  for (const [h, eq, usd, n] of byHour) {
    const i = Math.floor((h * 3600 - s) / 3600);
    if (i >= 0 && i < 24) { out[i].eq += eq; out[i].usd += usd; out[i].requests += n; }
  }
  return out;
}

/**
 * Repartos que no suman el total (±`tol`): vacío si todo cuadra. Lo usan los tests (fixture y demo) y sirve de
 * alarma: un número que no cuadra en pantalla es peor que no enseñarlo.
 */
export function sumIssues(m: GlobalModel | SessionModel, unit: Unit, tol = 0.005): string[] {
  const out: string[] = [];
  const check = (name: string, sum: number, pcts?: number) => {
    if (Math.abs(sum - m.total) > tol * Math.max(1e-12, Math.abs(m.total))) out.push(`${name}: ${sum} ≠ ${m.total}`);
    if (pcts !== undefined && Math.abs(pcts - 1) > tol) out.push(`${name} %: ${pcts}`);
  };
  const s = (rows: { eq: number; usd: number }[]) => rows.reduce((a, r) => a + r[unit], 0);
  const p = (rows: { pct: number }[]) => rows.reduce((a, r) => a + r.pct, 0);
  check('slices', s(m.slices), p(m.slices));
  if ('days' in m) {
    check('days', s(m.days));
    check('projects', s(m.projects), p(m.projects));
    check('models', s(m.models), p(m.models));
    check('who', s(m.who), p(m.who));
    check('main+subTypes', (m.who.find((x) => x.key === 'main')?.[unit] ?? 0) + s(m.subTypes), m.mainPct + p(m.subTypes));
    for (const b of m.top) if (b[unit] > m.total * (1 + tol)) out.push(`top > total: ${b[unit]}`);
  } else {
    check('main+subTypes', m.mainCost + s(m.subTypes), m.mainPct + p(m.subTypes));
  }
  return out;
}

// ───────────── vista por sesión ─────────────

export interface Marker { ts: number; kind: 'compaction' | 'cacheBroken'; event: ConsumoEvent }
export interface TopRow extends ConsumoTopBlock { whoType: string | null }

export interface SessionModel {
  provider: ConsumoProvider;
  slices: Slice[];
  /** Coste total (main + subagentes) en la unidad: el 100 % de todo el cajón. */
  total: number;
  mainCost: number;
  mainPct: number;
  /** Subagentes por tipo: key = tipo, requests = nº de subagentes; % sobre el total de la sesión. */
  subTypes: Row[];
  subCost: number; subPct: number; subCount: number;
  top: TopRow[];
  line: { ts: number; ctx: number; seg: number }[];
  markers: Marker[];
  base: number;
  baseParts: { label: string; chars: number; pct: number }[];
  requests: number; maxContext: number; lastContext: number;
  compactions: number; cacheBreaks: number;
  firstTs: number; lastTs: number;
}

export function sessionModel(r: ConsumoSessionReport, unit: Unit, provider: ConsumoProvider = 'claude'): SessionModel {
  const all = [r.main, ...r.subagents];
  const cats: ConsumoCatAgg[] = all.flatMap((f) => f.summary.cats);
  const total = sumCats(cats, unit);
  const mainCost = sumCats(r.main.summary.cats, unit);
  const types = new Map<string, [string, number, number, number]>();
  for (const s of r.subagents) {
    const k = s.who.agentType ?? 'agent';
    const e = types.get(k) ?? [k, 0, 0, 0];
    e[1] += sumCats(s.summary.cats, 'eq'); e[2] += sumCats(s.summary.cats, 'usd'); e[3] += 1;
    types.set(k, e);
  }
  // `session` = el fichero del bloque: la clave de origen de Read lleva el proyecto, la de imagen la sesión.
  const top: TopRow[] = all.flatMap((f) => f.summary.top.map((b) => ({ ...b, session: b.session ?? f.path, whoType: f.who.agentType })))
    .sort((a, b) => b[unit] - a[unit]); // la vista los agrupa por origen
  const ev = r.main.summary.events;
  // Lo que no se ve en el transcript (sistema, herramientas y el CLAUDE.md raíz) = base − partes visibles (como Rust).
  // Las partes vienen en caracteres: a tokens con ≈ 4 caracteres por token (como FileFacts en Rust).
  const tokParts: [string, number][] = r.baseParts.map(([k, c]) => [k, Math.ceil(c / 4)]);
  const vis = tokParts.reduce((a, [, n]) => a + n, 0);
  const bp: [string, number][] = r.main.summary.base > vis ? [...tokParts, ['system+tools', r.main.summary.base - vis]] : tokParts;
  const chars = bp.reduce((a, [, n]) => a + n, 0);
  const subCost = total - mainCost;
  return {
    provider,
    slices: slices(cats, unit),
    total,
    mainCost,
    mainPct: roundShares([mainCost, subCost])[0],
    subTypes: rankRows([...types.values()], unit, 6, total),
    subCost, subPct: roundShares([mainCost, subCost])[1], subCount: r.subagents.length,
    top,
    line: r.contextLine.map(([ts, ctx, seg]) => ({ ts, ctx, seg })),
    markers: ev.filter((e) => e.kind !== 'coldStart').map((e) => ({ ts: e.ts, kind: e.kind as Marker['kind'], event: e })),
    base: r.main.summary.base,
    baseParts: ((bp) => { const sh = roundShares(bp.map((x) => x[1])); return bp.map(([label, n], i) => ({ label, chars: n, pct: chars > 0 ? sh[i] : 0 })); })(bp.sort((a, b) => b[1] - a[1])),
    requests: all.reduce((a, f) => a + f.summary.requests, 0),
    maxContext: r.main.summary.maxContext,
    lastContext: r.main.summary.lastContext,
    compactions: ev.filter((e) => e.kind === 'compaction').length,
    cacheBreaks: ev.filter((e) => e.kind === 'cacheBroken').length,
    firstTs: r.main.summary.firstTs, lastTs: r.main.summary.lastTs,
  };
}

// ───────────── ejes ─────────────

/** Marcas redondas del eje Y de 0 a ≥ max (unos `n` tramos): 0 / 50k / 100k… */
export function niceTicks(max: number, n = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** Polilínea SVG de la línea de contexto en una caja w×h (x por tiempo; huecos > 0 entre puntos se mantienen). */
export function linePath(pts: { ts: number; ctx: number }[], w: number, h: number, maxY: number): string {
  if (!pts.length || maxY <= 0) return '';
  const t0 = pts[0].ts;
  const span = Math.max(1, pts[pts.length - 1].ts - t0);
  return pts.map((p, i) => `${i ? 'L' : 'M'}${((p.ts - t0) / span * w).toFixed(1)},${(h - p.ctx / maxY * h).toFixed(1)}`).join('');
}

/** Índice del punto más cercano a la x del puntero (para la cruceta). */
export function nearestIndex(pts: { ts: number }[], x: number, w: number): number {
  if (!pts.length) return -1;
  const t0 = pts[0].ts;
  const span = Math.max(1, pts[pts.length - 1].ts - t0);
  const ts = t0 + (x / Math.max(1, w)) * span;
  let best = 0;
  for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].ts - ts) < Math.abs(pts[best].ts - ts)) best = i;
  return best;
}

// ── Consejos e informe (C4/C5): el motor está en Rust (consumo/consejos.rs); aquí solo lo que pinta la interfaz. ──

/** Tope de descartes guardados y de largo de cada id. */
export const MAX_DISMISSED = 500;
/** Lista de descartes saneada: solo textos cortos, sin repetir, los más recientes al final. */
export function cleanDismissed(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) if (typeof x === 'string' && x.length > 0 && x.length <= 64 && !out.includes(x)) out.push(x);
  return out.slice(-MAX_DISMISSED);
}
/** Consejos que se ven: sin los descartados (la interfaz los quita al momento, sin volver a escanear). */
export function visibleAdvice<T extends { id: string }>(list: T[] | undefined, dismissed: string[]): T[] {
  const gone = new Set(dismissed);
  return (list ?? []).filter((a) => !gone.has(a.id));
}
/** Tokens aproximados de un texto (≈ bytes UTF-8 / 4), como el informe. */
export function reportTokens(md: string): number {
  return Math.ceil(new TextEncoder().encode(md).length / 4);
}
/** A partir de aquí se avisa de que el informe es grande para pegarlo. */
export const REPORT_WARN_TOKENS = 8000;
