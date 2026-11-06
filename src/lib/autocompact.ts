// Decisión del auto-compact en inactividad. Módulo puro (sin Svelte ni Tauri): se prueba con node --test.
//
// Idea: si el usuario se va >1 h, la caché de prompt caduca y el siguiente mensaje reescribe todo el contexto en frío.
// Compactar ANTES de que caduque (leer el contexto caliente + escribir un resumen) sale más barato.

/** Margen (min) antes de que caduque la caché: de ahí en adelante ya es tarde para compactar. */
export const SAFETY_MIN = 3;

export interface CompactAgent {
  agent: 'claude' | 'codex' | 'opencode';
  status: string;
  sessionId?: string;
  ctxTokens: number;
  /** Época en segundos de la última petición. */
  lastRequestAt?: number;
  /** Duración de la caché en segundos (3600 si no se sabe). */
  cacheTtl: number;
}

export interface CompactInput {
  enabled: boolean;
  agent: CompactAgent;
  /** Época actual en segundos. */
  nowSec: number;
  /** Segundos sin entrada del usuario en el sistema; `null` = aún sin consultar. */
  userIdleSec: number | null;
  ctxK: number;
  afterMin: number;
  userIdleMin: number;
  /** Claves (`compactKey`) de lo ya compactado. */
  done: ReadonlySet<string>;
}

export interface CompactDecision { compact: boolean; reason: string }

/** Una vez por (sesión, última petición): tras compactar `lastRequestAt` cambia solo. */
export function compactKey(a: Pick<CompactAgent, 'sessionId' | 'lastRequestAt'>): string {
  return `${a.sessionId ?? ''}@${a.lastRequestAt ?? 0}`;
}

/** Ventana de actuación en minutos desde la última petición: [afterMin, ttl - SAFETY_MIN). */
export function compactWindow(afterMin: number, cacheTtlSec: number): { from: number; to: number } {
  const ttl = cacheTtlSec > 0 ? cacheTtlSec : 3600;
  return { from: afterMin, to: ttl / 60 - SAFETY_MIN };
}

export function decideCompact(i: CompactInput): CompactDecision {
  const no = (reason: string): CompactDecision => ({ compact: false, reason });
  const a = i.agent;
  if (!i.enabled) return no('disabled');
  if (a.agent !== 'claude') return no('not-claude');
  if (a.status !== 'idle') return no('not-idle');
  if (!a.sessionId) return no('no-session');
  if (a.ctxTokens < i.ctxK * 1000) return no('context-too-small');
  if (a.lastRequestAt === undefined || a.lastRequestAt <= 0) return no('no-last-request');
  const mins = (i.nowSec - a.lastRequestAt) / 60;
  const w = compactWindow(i.afterMin, a.cacheTtl);
  if (mins < w.from) return no('too-early');
  if (mins >= w.to) return no('too-late');
  if (i.done.has(compactKey(a))) return no('already-done');
  if (i.userIdleSec === null) return no('needs-idle-check');
  if (i.userIdleSec < i.userIdleMin * 60) return no('user-active');
  return { compact: true, reason: 'ok' };
}

export interface CompactLogEntry { at: number; title: string; ctxTokens: number }

/** Añade una entrada al registro y lo recorta a las últimas `max`, la más reciente primero. */
export function pushLog(log: readonly CompactLogEntry[], e: CompactLogEntry, max = 20): CompactLogEntry[] {
  return [e, ...log].slice(0, max);
}
