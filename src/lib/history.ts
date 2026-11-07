// Lógica pura del panel de gráficas de la barra de estado (histórico de la última hora): escalas, rutas SVG con huecos,
// estadísticas y valor bajo el cursor. Sin Svelte ni Tauri: se prueba con node --test.

/** Un punto del histórico tal como llega de Rust (history.rs). `null` = la fuente no da ese dato (se omite, nunca cero). */
export interface HistPoint {
  t: number;
  cpu: number;
  ramUsed: number;
  ramTotal: number;
  swapUsed: number | null;
  swapTotal: number | null;
  netIn: number;
  netOut: number;
  diskRead: number | null;
  diskWrite: number | null;
}

/** De dónde sale el histórico del panel: este equipo o el servidor del panel SSH enfocado (clave del monitor). */
export type HistSource = { kind: 'local' } | { kind: 'remote'; key: string; host: string };

/** Ventana del panel: una hora. */
export const WINDOW_SEC = 3600;
/** Intervalo nominal del muestreo (s): lo que se supone si no hay puntos para medirlo. */
export const STEP_SEC = 5;
/** Cada cuánto se refresca el panel abierto (ms). */
export const REFRESH_MS = 5000;

/** Intervalo típico entre puntos: la mediana de las diferencias positivas (resiste huecos). Sin datos: `STEP_SEC`. */
export function stepOf(pts: readonly { t: number }[]): number {
  const d: number[] = [];
  for (let i = 1; i < pts.length; i++) { const x = pts[i].t - pts[i - 1].t; if (x > 0) d.push(x); }
  if (!d.length) return STEP_SEC;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

/** Salto a partir del cual la línea se corta (no se interpola): más de 3 intervalos sin muestras. */
export const gapOf = (step: number): number => 3 * Math.max(1, step);

/** Dominio de tiempo del eje X: la última hora hasta el último punto, o desde el primero si hay menos. */
export function timeDomain(pts: readonly { t: number }[]): { t0: number; t1: number } {
  if (!pts.length) return { t0: 0, t1: 1 };
  const t1 = pts[pts.length - 1].t;
  const t0 = Math.max(pts[0].t, t1 - WINDOW_SEC);
  return { t0, t1: t1 > t0 ? t1 : t0 + 1 };
}

/** Minutos que cubre el dominio, redondeados (al menos 1): para la etiqueta «-N min». */
export const spanMinutes = (d: { t0: number; t1: number }): number => Math.max(1, Math.round((d.t1 - d.t0) / 60));

/**
 * Techo «bonito» para una escala automática: 1, 2, 2.5 o 5 por potencia de 10, por encima de `v`.
 * `floor` evita que una serie casi plana (p. ej. 3 B/s) se dibuje como montañas.
 */
export function niceMax(v: number, floor = 1): number {
  const x = Number.isFinite(v) && v > floor ? v : floor;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x - 1e-9) return m * p;
  return 10 * p;
}

/** Techo «bonito» para bytes/s en unidades binarias (KB, MB… de 1024), para que la etiqueta salga redonda. Mínimo 1 KB/s. */
export function niceBytes(v: number): number {
  const x = Number.isFinite(v) && v > 1024 ? v : 1024;
  let u = 1;
  while (x / u >= 1024) u *= 1024;
  const m = niceMax(x / u);
  return m >= 1000 ? 1024 * u : m * u;
}

export interface Box { w: number; h: number; t0: number; t1: number; yMax: number; pad?: number }

export function xOf(t: number, b: Box): number {
  const span = b.t1 - b.t0 || 1;
  return ((t - b.t0) / span) * b.w;
}
export function yOf(v: number, b: Box): number {
  const pad = b.pad ?? 1;
  const r = b.yMax > 0 ? Math.min(1, Math.max(0, v / b.yMax)) : 0;
  return pad + (1 - r) * (b.h - 2 * pad);
}

/** Tramos continuos de una serie: se corta donde falta el valor (`null`/no finito) o el salto supera `gap` segundos. */
export function segments(pts: readonly { t: number }[], get: (i: number) => number | null, gap: number): { t: number; v: number }[][] {
  const out: { t: number; v: number }[][] = [];
  let cur: { t: number; v: number }[] = [];
  let lastT = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const v = get(i);
    const t = pts[i].t;
    if (v === null || !Number.isFinite(v)) { if (cur.length) out.push(cur); cur = []; lastT = -Infinity; continue; }
    if (cur.length && t - lastT > gap) { out.push(cur); cur = []; }
    cur.push({ t, v });
    lastT = t;
  }
  if (cur.length) out.push(cur);
  return out;
}

const f = (n: number): string => (Math.round(n * 10) / 10).toString();

/**
 * Rutas SVG de una serie: `line` (trazo) y `area` (relleno hasta la base), una subruta por tramo.
 * Un tramo de un solo punto se dibuja como un trazo mínimo (con extremos redondos se ve como un punto).
 */
export function seriesPaths(segs: readonly { t: number; v: number }[][], b: Box): { line: string; area: string } {
  const line: string[] = [];
  const area: string[] = [];
  const base = f(b.h);
  for (const s of segs) {
    if (!s.length) continue;
    const xy = s.map((p) => [f(xOf(p.t, b)), f(yOf(p.v, b))] as const);
    if (xy.length === 1) {
      line.push(`M${xy[0][0]} ${xy[0][1]}h0.1`);
      continue;
    }
    const pts = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join('');
    line.push(pts);
    area.push(`${pts}L${xy[xy.length - 1][0]} ${base}L${xy[0][0]} ${base}Z`);
  }
  return { line: line.join(''), area: area.join('') };
}

/** Actual (último valor presente), máximo y media de una serie; `null` si no hay ningún valor. */
export function stats(vals: readonly (number | null)[]): { cur: number; max: number; avg: number } | null {
  let n = 0, sum = 0, max = -Infinity, cur: number | null = null;
  for (const v of vals) {
    if (v === null || !Number.isFinite(v)) continue;
    n++; sum += v; if (v > max) max = v; cur = v;
  }
  return n && cur !== null ? { cur, max, avg: sum / n } : null;
}

/** Índice del punto más cercano en el tiempo a `t` (búsqueda binaria; los puntos van ordenados). -1 si no hay puntos. */
export function nearestIndex(pts: readonly { t: number }[], t: number): number {
  if (!pts.length) return -1;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(pts[lo - 1].t - t) <= Math.abs(pts[lo].t - t)) return lo - 1;
  return lo;
}

/** Tiempo que corresponde a una x del ratón dentro de la gráfica. */
export function tAtX(x: number, b: Box): number {
  const r = b.w > 0 ? Math.min(1, Math.max(0, x / b.w)) : 0;
  return b.t0 + r * (b.t1 - b.t0);
}

/** % de uso (0-100) o `null` si el total no es válido. */
export function pct(used: number | null, total: number | null): number | null {
  if (used === null || total === null || !(total > 0)) return null;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/** «hace N min» relativo al último punto: 0 = ahora. */
export const minutesAgo = (t: number, t1: number): number => Math.max(0, Math.round((t1 - t) / 60));

/** Hora local «HH:MM:SS» de un punto (para el tooltip). */
export function clock(t: number): string {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Datos de ejemplo para la demo del navegador: `minutes` minutos cada 5 s hasta `now`, con un hueco de ~2 min
 * (para ver la línea cortada) y, si `swap` es falso, sin swap. Deterministas para un mismo `now` redondeado.
 */
export function demoHistory(now: number, minutes: number, opts: { seed?: number; swap?: boolean; ramGB?: number } = {}): HistPoint[] {
  const GB = 1024 ** 3;
  const seed = opts.seed ?? 1;
  const ramTotal = (opts.ramGB ?? 32) * GB;
  const end = Math.floor(now / STEP_SEC) * STEP_SEC;
  const n = Math.floor((minutes * 60) / STEP_SEC);
  const out: HistPoint[] = [];
  for (let i = n; i >= 0; i--) {
    const t = end - i * STEP_SEC;
    const k = t / 60;
    if (i > n * 0.55 && i < n * 0.55 + 24) continue; // hueco: el equipo «dormía»
    const burst = Math.max(0, Math.sin(k / 3.1 + seed)) ** 6;
    const noise = Math.sin(t * 0.37 + seed) * Math.sin(t * 0.11);
    out.push({
      t,
      cpu: Math.min(100, Math.max(1, 18 + 10 * Math.sin(k / 4 + seed) + 55 * burst + 6 * noise)),
      ramUsed: (0.52 + 0.08 * Math.sin(k / 11 + seed) + 0.1 * burst) * ramTotal,
      ramTotal,
      swapUsed: opts.swap === false ? null : (0.12 + 0.04 * Math.sin(k / 17)) * 8 * GB,
      swapTotal: opts.swap === false ? null : 8 * GB,
      netIn: Math.max(0, 4e5 + 3e5 * noise + 9e6 * burst * Math.abs(Math.sin(t / 7))),
      netOut: Math.max(0, 6e4 + 4e4 * noise + 1.2e6 * burst),
      diskRead: Math.max(0, 2e5 + 1.5e5 * noise + 4e7 * Math.max(0, Math.sin(k / 5.3 + seed)) ** 12),
      diskWrite: Math.max(0, 8e5 + 5e5 * Math.sin(t / 13) + 1.2e7 * burst),
    });
  }
  return out;
}
