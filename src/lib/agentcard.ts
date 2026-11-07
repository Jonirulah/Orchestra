// Ficha flotante de un agente (barra lateral → «Agentes activos»). Módulo puro: se prueba con node --test.
//
// Regla: lo que no se sabe no se enseña. Ninguna función se inventa un dato: devuelven `null` o una lista vacía.

/** Ventana de contexto clásica de Claude y la ampliada. */
export const WINDOW_200K = 200_000;
export const WINDOW_1M = 1_000_000;

/**
 * Ventana de contexto del modelo, en tokens. `null` si no se sabe (modelo desconocido y nada que lo delate).
 * - El id con «1m» (p. ej. `claude-opus-5-5[1m]`) → 1M.
 * - Más de 200k de contexto en uso → por fuerza es de 1M (el transcript no siempre trae el sufijo).
 * - Cualquier otro `claude-*` → 200k.
 */
export function contextWindow(model: string | undefined, ctxTokens: number): number | null {
  const m = (model ?? '').toLowerCase();
  if (/(^|[^a-z0-9])1m([^a-z0-9]|$)/.test(m)) return WINDOW_1M;
  if (ctxTokens > WINDOW_200K) return WINDOW_1M;
  if (m.startsWith('claude-') || m.startsWith('claude')) return WINDOW_200K;
  return null;
}

/** Nombre corto del modelo: «claude-opus-5-5» → «Opus 5.5»; «claude-sonnet-4-5-20250929» → «Sonnet 4.5». Lo demás, tal cual. */
export function prettyModel(model: string | undefined): string | null {
  if (!model) return null;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?(\[1m\])?$/i.exec(model.trim());
  if (!m) return model.trim() || null;
  const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${fam} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' 1M' : ''}`;
}

/** Ventana en corto y redonda: 200000 → «200k», 1000000 → «1M». */
export function fmtWindow(w: number): string {
  return w >= 1e6 ? `${Math.round((w / 1e6) * 10) / 10}M` : `${Math.round(w / 1000)}k`;
}

export interface CtxBar {
  /** Ventana de contexto (tokens). */
  window: number;
  /** Uso en % (0..100, redondeado). */
  pct: number;
  /** Posición de la marca de auto-compact en % de la barra, si cae dentro. */
  markPct: number | null;
}

/** Barra de contexto. `null` si no hay ventana conocida o no hay contexto (entonces se enseña solo la cifra, o nada). */
export function ctxBar(ctxTokens: number, window: number | null, compactAt: number | null): CtxBar | null {
  if (!window || !(ctxTokens > 0)) return null;
  const pct = Math.max(0, Math.min(100, Math.round((ctxTokens / window) * 100)));
  const markPct = compactAt && compactAt > 0 && compactAt < window ? Math.round((compactAt / window) * 1000) / 10 : null;
  return { window, pct, markPct };
}

/** Recorta el pedido del usuario a su primera línea con texto y a `max` caracteres (con «…»). `null` si está vacío. */
export function clampPrompt(s: string | undefined, max = 140): string | null {
  if (!s) return null;
  const first = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  const one = first.replace(/\s+/g, ' ');
  const chars = Array.from(one);
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : one;
}

/** Duración corta: «45 s», «3 min», «2 h 14 min», «3 d 4 h». `null` si no es un número válido. */
export function fmtDuration(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null;
  const s = Math.floor(sec);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** Carpeta acortada: la carpeta de usuario pasa a «~» y solo quedan los `keep` últimos tramos. */
export function shortCwd(cwd: string | undefined, keep = 3): string | null {
  if (!cwd) return null;
  let p = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  p = p.replace(/^[A-Za-z]:\/Users\/[^/]+/i, '~').replace(/^\/(home|Users)\/[^/]+/, '~');
  const parts = p.split('/').filter((x, i) => x.length > 0 || i === 0);
  if (parts.length <= keep + 1) return p || null;
  return `${parts[0]}/…/${parts.slice(-keep).join('/')}`;
}

// ---------- duración del estado ----------

export interface StatusMark { status: string; since: number | null }

/**
 * Lleva la cuenta de desde cuándo está cada agente en su estado (épocas en segundos).
 * - Si el estado cambia (o el agente es nuevo y ya lo habíamos visto antes en otro estado) → `since = now`.
 * - La primera vez que se ve un agente no sabemos cuándo empezó su estado: para «inactivo» y «esperando» vale la
 *   hora de la última respuesta (`lastRequestAt`); para lo demás se queda en `null` hasta ver un cambio.
 * Devuelve un mapa nuevo con solo los agentes presentes.
 */
export function trackStatus(
  prev: Readonly<Record<string, StatusMark>>,
  agents: readonly { paneId: string; status: string; lastRequestAt?: number }[],
  now: number,
): Record<string, StatusMark> {
  const out: Record<string, StatusMark> = {};
  for (const a of agents) {
    const p = prev[a.paneId];
    if (p && p.status === a.status) out[a.paneId] = p;
    else if (p) out[a.paneId] = { status: a.status, since: now };
    else {
      const guess = (a.status === 'idle' || a.status === 'waiting') && a.lastRequestAt && a.lastRequestAt <= now ? a.lastRequestAt : null;
      out[a.paneId] = { status: a.status, since: guess };
    }
  }
  return out;
}

// ---------- qué secciones se enseñan ----------

export interface CardTokens { input: number; output: number; cacheRead: number; cacheCreate: number; requests: number }
export interface CardAgent {
  status: string;
  ctxTokens: number;
  current?: string;
  lastPrompt?: string;
  waitingFor?: string;
  startedAt?: number;
  cwd?: string;
  todos: readonly { status: string }[];
  subagents: readonly { state: string }[];
  tokens?: CardTokens;
  subTokens?: CardTokens;
}

export interface CardSections {
  ctx: boolean;
  now: boolean;
  tasks: boolean;
  subs: boolean;
  session: boolean;
}

const hasTok = (t?: CardTokens) => !!t && (t.requests > 0 || t.output > 0 || t.input + t.cacheCreate > 0);

/** Secciones de la ficha con algo que enseñar. `branch` = rama git del panel (viene de otro sitio). */
export function cardSections(a: CardAgent, branch?: string | null): CardSections {
  return {
    ctx: a.ctxTokens > 0,
    now: !!a.current || !!clampPrompt(a.lastPrompt),
    tasks: a.todos.length > 0,
    subs: a.subagents.length > 0,
    session: !!a.startedAt || hasTok(a.tokens) || hasTok(a.subTokens) || !!a.cwd || !!branch,
  };
}

/** Progreso de las tareas: hechas, total y la que está en curso (índice o -1). */
export function todoProgress(todos: readonly { status: string }[]): { done: number; total: number; current: number } {
  return { done: todos.filter((t) => t.status === 'completed').length, total: todos.length, current: todos.findIndex((t) => t.status === 'in_progress') };
}

/**
 * Posición de la ficha (px, coordenadas de la ventana): a la derecha de la barra lateral, alineada con la fila;
 * si no cabe abajo, sube; nunca se sale por arriba ni por la derecha.
 */
export function cardPosition(
  row: { top: number; bottom: number },
  sidebarRight: number,
  card: { width: number; height: number },
  view: { width: number; height: number },
  margin = 8,
): { left: number; top: number } {
  let left = sidebarRight + margin;
  if (left + card.width > view.width - margin) left = Math.max(margin, view.width - margin - card.width);
  let top = row.top;
  if (top + card.height > view.height - margin) top = Math.max(margin, Math.min(row.bottom, view.height - margin) - card.height);
  if (top + card.height > view.height - margin) top = Math.max(margin, view.height - margin - card.height);
  return { left, top: Math.max(margin, top) };
}
