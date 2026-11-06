// Insignia de latencia de los paneles SSH. Módulo puro (sin Svelte ni Tauri): se prueba con node --test.
// Mide el TIEMPO DE CONEXIÓN TCP al puerto SSH (latencia de red), no el retraso al teclear. Ver docs/SECURITY.md.
import type { Host, Pane } from './model.ts';

/** Valores de serie (los mismos que `DEFAULTS` de settings.ts; una prueba lo vigila). Las funciones reciben los ajustes por parámetro. */
export interface LatencyOpts {
  /** Muestras guardadas por panel. */
  samples: number;
  /** Por debajo, verde; desde aquí, ámbar (ms). */
  warnMs: number;
  /** Por encima, rojo (ms). */
  badMs: number;
  /** Fallos seguidos para ponerse rojo. */
  failsBad: number;
  /** «42 ms» o solo «42». */
  showUnit: boolean;
}
export const DEFAULT_LATENCY: LatencyOpts = { samples: 30, warnMs: 80, badMs: 200, failsBad: 3, showUnit: true };
export const MAX_TARGETS = 32;
export const INTERVAL_RANGE = [2, 60] as const;
export const DEFAULT_INTERVAL = 5;

/** Saca las opciones de los ajustes. */
export function latencyOptsOf(s: {
  latencySamples: number; latencyWarnMs: number; latencyBadMs: number; latencyFailsBad: number; latencyShowUnit: boolean;
}): LatencyOpts {
  return { samples: s.latencySamples, warnMs: s.latencyWarnMs, badMs: s.latencyBadMs, failsBad: s.latencyFailsBad, showUnit: s.latencyShowUnit };
}

/** `null` = la medición falló (timeout / inalcanzable). */
export type Sample = number | null;
export type Level = 'none' | 'ok' | 'warn' | 'bad';

export interface Stats {
  n: number;
  last: number | null;
  min: number | null;
  avg: number | null;
  max: number | null;
  /** % de muestras fallidas de la ventana (0..100, entero). */
  lossPct: number;
  /** Fallos seguidos al final de la ventana. */
  consecFail: number;
}

/** Segundos entre mediciones: 2..60, enteros; lo inválido cae a 5. */
export function clampLatencyInterval(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_INTERVAL;
  return Math.min(INTERVAL_RANGE[1], Math.max(INTERVAL_RANGE[0], Math.round(v)));
}

/** Devuelve un anillo nuevo con la muestra añadida (máx. `cap`). Un valor no finito o negativo cuenta como fallo. */
export function pushSample(buf: readonly Sample[], ms: unknown, cap = DEFAULT_LATENCY.samples): Sample[] {
  const s: Sample = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : null;
  const out = [...buf, s];
  return out.length > cap ? out.slice(out.length - cap) : out;
}

export function statsOf(buf: readonly Sample[], window = Infinity): Stats {
  if (buf.length > window) buf = buf.slice(buf.length - Math.max(1, Math.floor(window)));
  const n = buf.length;
  const ok = buf.filter((x): x is number => x !== null);
  let consecFail = 0;
  for (let i = n - 1; i >= 0 && buf[i] === null; i--) consecFail++;
  return {
    n,
    last: n ? buf[n - 1] : null,
    min: ok.length ? Math.min(...ok) : null,
    avg: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null,
    max: ok.length ? Math.max(...ok) : null,
    lossPct: n ? Math.round(((n - ok.length) / n) * 100) : 0,
    consecFail,
  };
}

/** Color de la insignia: verde por debajo de `warnMs`, ámbar hasta `badMs`, rojo por encima o con `failsBad` fallos seguidos. Un fallo suelto = ámbar. `badMs <= warnMs` se corrige a warn + 1. */
export function levelOf(st: Pick<Stats, 'n' | 'last' | 'consecFail'>, o: Pick<LatencyOpts, 'warnMs' | 'badMs' | 'failsBad'> = DEFAULT_LATENCY): Level {
  if (!st.n) return 'none';
  if (st.consecFail >= Math.max(1, o.failsBad)) return 'bad';
  if (st.last === null) return 'warn';
  const bad = o.badMs > o.warnMs ? o.badMs : o.warnMs + 1;
  if (st.last < o.warnMs) return 'ok';
  return st.last <= bad ? 'warn' : 'bad';
}

/** «42 ms» (o «42» sin unidad), «<1 ms», «1.2 s» o «—» (sin dato). */
export function fmtMs(ms: number | null | undefined, unit = true): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1) return unit ? '<1 ms' : '<1';
  if (!unit) return String(Math.round(ms));
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

// ---------- qué panel se mide y contra qué dirección ----------

export interface CfgEntry { alias: string; hostname?: string; port?: number; proxyJump?: string; proxyCommand?: string }
export type LatencyTarget =
  | { kind: 'measure'; host: string; port: number }
  /** Se llega por ProxyJump / ProxyCommand: no se mide (el TCP al primer salto no dice nada del destino). */
  | { kind: 'jump' }
  | { kind: 'none' };

/** Mismas reglas que `net::valid_host` en Rust. */
export function validHost(h: string): boolean {
  return h.length > 0 && h.length <= 255 && !/[\s\u0000-\u001f\u007f/@]/.test(h);
}

const NONE: LatencyTarget = { kind: 'none' };
const JUMP: LatencyTarget = { kind: 'jump' };
const via = (c?: CfgEntry) => !!(c?.proxyJump?.trim() || c?.proxyCommand?.trim());

function resolve(name: string, explicitPort: number | undefined, cfg: readonly CfgEntry[]): LatencyTarget {
  const key = name.replace(/^\[(.*)\]$/, '$1');
  const c = cfg.find((x) => x.alias.toLowerCase() === key.toLowerCase());
  if (via(c)) return JUMP;
  const host = (c?.hostname || key).replace(/^\[(.*)\]$/, '$1');
  const port = explicitPort ?? c?.port ?? 22;
  if (!validHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) return NONE;
  return { kind: 'measure', host, port };
}

/**
 * Dirección que se mide para un panel. Sale de lo que la app ya sabe: el host guardado (`pane.ref`), el alias de
 * ~/.ssh/config (`cfg:alias`) o, en la conexión rápida, los argumentos de ssh. Nunca se lee nada del terminal.
 */
export function latencyTarget(pane: Pick<Pane, 'kind' | 'ref' | 'spec'>, hosts: readonly Host[], cfg: readonly CfgEntry[]): LatencyTarget {
  if (pane.kind !== 'ssh') return NONE;
  const ref = pane.ref;
  if (ref?.startsWith('cfg:')) return resolve(ref.slice(4), undefined, cfg);
  if (ref) {
    const h = hosts.find((x) => x.id === ref);
    if (!h) return NONE;
    if (h.proxyJump?.trim()) return JUMP;
    return resolve(h.host, h.port, cfg);
  }
  // Conexión rápida (sin ref): `ssh … [-p N] [-J x] usuario@host`. Los demás (p. ej. «instalar clave») no son ssh.exe.
  if (pane.spec.program !== 'ssh') return NONE;
  const a = pane.spec.args;
  if (a.includes('-J')) return JUMP;
  const pi = a.indexOf('-p');
  const port = pi >= 0 ? Number(a[pi + 1]) : undefined;
  const last = a[a.length - 1];
  if (!last || last.startsWith('-')) return NONE;
  return resolve(last.slice(last.lastIndexOf('@') + 1), port, cfg);
}

export interface PingTarget { id: string; host: string; port: number }

/** Una dirección una vez aunque varios paneles apunten a ella (`id` = «host:puerto»). Tope MAX_TARGETS por llamada. */
export function dedupeTargets(list: readonly { host: string; port: number }[]): PingTarget[] {
  const seen = new Map<string, PingTarget>();
  for (const t of list) {
    const id = `${t.host.toLowerCase()}:${t.port}`;
    if (!seen.has(id) && seen.size < MAX_TARGETS) seen.set(id, { id, host: t.host, port: t.port });
  }
  return [...seen.values()];
}

export const targetId = (host: string, port: number) => `${host.toLowerCase()}:${port}`;
