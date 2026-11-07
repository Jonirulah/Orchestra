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
  /** Estado del prompt del panel según lo tecleado (`nextDraft`); ausente = nada tecleado. */
  draft?: DraftState;
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
  // Caché de 5 min (o «tras» demasiado largo): la ventana [from, to) está vacía y nunca actuaría.
  if (w.from >= w.to) return no('ttl-too-short');
  if (mins < w.from) return no('too-early');
  if (mins >= w.to) return no('too-late');
  if (i.done.has(compactKey(a))) return no('already-done');
  // Texto sin enviar en el prompt: escribir `/compact\r` lo pegaría detrás y mandaría «borrador/compact».
  if (i.draft?.draft) return no('user-typed');
  if (i.userIdleSec === null) return no('needs-idle-check');
  if (i.userIdleSec < i.userIdleMin * 60) return no('user-active');
  return { compact: true, reason: 'ok' };
}

/** Lo que el usuario ha tecleado en un panel, visto desde la entrada que llega al PTY. */
export interface DraftState {
  /** Hay texto escrito en el prompt que aún no se ha enviado. */
  draft: boolean;
  /** Milisegundos de época de la última entrada real del usuario (no las respuestas del terminal). */
  lastInputAt: number;
}

/** Respuestas que el propio terminal manda al programa (no son teclas): foco, ratón, posición del cursor, atributos, OSC. */
const NOISE = /\x1b\[[IO]|\x1b\[<[\d;]*[Mm]|\x1b\[M[\s\S]{3}|\x1b\[\d+;\d+R|\x1b\[[?>]?[\d;]*c|\x1b\[\?[\d;]*\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export type InputKind = 'noise' | 'submit' | 'clear' | 'typing';

/**
 * Clasifica un trozo de entrada del teclado (lo que xterm manda con `onData`).
 * - `submit`: termina en Enter (`\r`): el prompt se envía y queda vacío.
 * - `clear`: Ctrl+C solo; Claude vacía el prompt.
 * - `noise`: respuestas del terminal o un Esc suelto; no cambian el prompt.
 * - `typing`: lo demás (letras, pegar, retroceso, flechas que traen el historial): deja borrador.
 */
export function classifyInput(data: string): InputKind {
  const rest = data.replace(NOISE, '');
  if (rest === '' || rest === '\x1b') return 'noise';
  if (rest === '\x03') return 'clear';
  if (rest.endsWith('\r')) return 'submit';
  return 'typing';
}

/** Estado nuevo del prompt tras una entrada del usuario en `atMs`. */
export function nextDraft(prev: DraftState | undefined, data: string, atMs: number): DraftState {
  const k = classifyInput(data);
  const before = prev ?? { draft: false, lastInputAt: 0 };
  if (k === 'noise') return before;
  return { draft: k === 'typing', lastInputAt: atMs };
}

/** Ajustes de prueba (`ORCHESTRA_DEV_AUTOCOMPACT=ctxK=1,afterSec=30,idleSec=0`): solo desarrollo, sin límites de Settings. */
export interface DevOverride { ctxK?: number; afterMin?: number; userIdleMin?: number }

export function parseDevOverride(raw: string | null | undefined): DevOverride | null {
  if (!raw) return null;
  const out: DevOverride = {};
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    const n = Number(v);
    if (!v || !Number.isFinite(n) || n < 0) continue;
    if (k === 'ctxK') out.ctxK = n;
    else if (k === 'afterSec') out.afterMin = n / 60;
    else if (k === 'idleSec') out.userIdleMin = n / 60;
  }
  return Object.keys(out).length ? out : null;
}

export interface CompactLogEntry { at: number; title: string; ctxTokens: number }

/** Añade una entrada al registro y lo recorta a las últimas `max`, la más reciente primero. */
export function pushLog(log: readonly CompactLogEntry[], e: CompactLogEntry, max = 20): CompactLogEntry[] {
  return [e, ...log].slice(0, max);
}
