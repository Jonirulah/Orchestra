// Elección automática de cuenta al CREAR una terminal. Módulo puro (se prueba con node --test).
import { providerOf } from './model.ts';
import type { Account } from './model.ts';
import { t, tk } from './i18n.ts';

/** Uso de una ventana de cuota: `used` en 0..100, `resetsAt` en segundos epoch. */
export interface Window { used: number; resetsAt: number }
/** Límite extra (p. ej. el semanal de un modelo) que solo conoce la consulta opcional a Anthropic. `percent` en 0..100. */
export interface QuotaLimit { kind: string; percent: number; resetsAt: number; scope?: string; active: boolean }
export interface Quota { fiveHour?: Window; sevenDay?: Window; at?: number; limits?: QuotaLimit[] }

export type AccountPolicy = 'manual' | 'round-robin' | 'reset-soonest' | 'most-free';

/** Título de una política en el idioma actual (llamar al pintar, no a nivel de módulo). */
export function policyLabel(id: AccountPolicy): string {
  switch (id) {
    case 'manual': return t('policy.manualLabel');
    case 'round-robin': return t('policy.roundRobinLabel');
    case 'reset-soonest': return t('policy.resetSoonestLabel');
    case 'most-free': return t('policy.mostFreeLabel');
  }
}

/** Explicación corta de una política en el idioma actual. */
export function policyHint(id: AccountPolicy): string {
  switch (id) {
    case 'manual': return t('policy.manualHint');
    case 'round-robin': return t('policy.roundRobinHint');
    case 'reset-soonest': return t('policy.resetSoonestHint');
    case 'most-free': return t('policy.mostFreeHint');
  }
}

/** Misma forma de siempre (`p.label`, `p.hint`), pero los textos se resuelven al LEER (getters), no al importar. */
const policyEntry = (id: AccountPolicy): { id: AccountPolicy; label: string; hint: string } => ({
  id,
  get label() { return policyLabel(id); },
  get hint() { return policyHint(id); },
});
export const POLICIES: { id: AccountPolicy; label: string; hint: string }[] =
  (['manual', 'round-robin', 'reset-soonest', 'most-free'] as const).map(policyEntry);

export interface Candidate { acc: Account; loggedIn: boolean; quota?: Quota }
export interface Pick { acc: Account; reason: string }

const EXHAUSTED = 99;

/** Ventanas que cuentan para elegir cuenta: 5 h, 7 d y los límites extra ACTIVOS (el cuello de botella puede ser el de un modelo). */
function windows(q?: Quota): Window[] {
  const extra = (q?.limits ?? []).filter((l) => l.active).map((l): Window => ({ used: l.percent, resetsAt: l.resetsAt }));
  return [q?.fiveHour, q?.sevenDay, ...extra].filter((w): w is Window => !!w);
}

/** Agotada = alguna ventana al límite y que aún no se ha renovado. */
export function exhausted(q: Quota | undefined, now: number): boolean {
  return windows(q).some((w) => w.used >= EXHAUSTED && w.resetsAt > now);
}

/** Próxima renovación (la ventana que antes se reinicia). Sin dato: Infinity. */
export function nextReset(q: Quota | undefined, now: number): number {
  const t = windows(q).map((w) => w.resetsAt).filter((r) => r > now);
  return t.length ? Math.min(...t) : Infinity;
}

/** Uso del cuello de botella (la ventana más gastada). Sin dato: Infinity.
 *  Con `now`, una ventana ya renovada (resetsAt pasado) cuenta como 0 %. */
export function pressure(q: Quota | undefined, now?: number): number {
  const u = windows(q).map((w) => (now !== undefined && w.resetsAt <= now ? 0 : w.used));
  return u.length ? Math.max(...u) : Infinity;
}

/** Tiempo restante en texto corto: «38m», «2h 10m», «4d 3h»; ya pasado: «now». */
export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return t('policy.durationNow');
  const m = Math.ceil(sec / 60);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

function fmtReset(sec: number, now: number): string {
  return fmtDuration(sec - now);
}

export type UsageLevel = 'ok' | 'warn' | 'bad';
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Verde < 60 %, ámbar 60-85 %, rojo > 85 %. */
export function usageLevel(pct: number): UsageLevel {
  return pct > 85 ? 'bad' : pct >= 60 ? 'warn' : 'ok';
}

/** Instante local en texto: «Thu 14:05». */
export function fmtWhen(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${tk(`policy.day.${DAYS[d.getDay()]}`)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Lo que pinta una barra: porcentaje, color, cuenta atrás y tooltip. */
export interface WindowView { pct: number; level: UsageLevel; left: string; tip: string; expired: boolean }

/** Una ventana renovada (resetsAt ya pasado) cuenta como 0 % usado. */
export function windowView(w: Window | undefined, now: number): WindowView | null {
  if (!w) return null;
  const expired = w.resetsAt <= now;
  const pct = expired ? 0 : Math.min(100, Math.max(0, w.used));
  const shown = Math.round(pct);
  return {
    pct, expired, level: usageLevel(pct),
    left: expired ? t('policy.window.reset') : fmtDuration(w.resetsAt - now),
    tip: expired ? t('policy.window.tipExpired') : t('policy.window.tip', { pct: shown, when: fmtWhen(w.resetsAt) }),
  };
}

/** Fila extra: el límite activo de un modelo cuando va más gastado que el semanal general. */
export interface ExtraView { label: string; view: WindowView }

/**
 * Límite extra a mostrar: entre los límites ACTIVOS con modelo (`scope`) y aún sin renovar, el más gastado, si supera al semanal
 * general (sin semanal, basta con que exista). Si no, `null`.
 */
export function extraView(q: Quota | undefined, now: number): ExtraView | null {
  const base = q?.sevenDay && q.sevenDay.resetsAt > now ? q.sevenDay.used : 0;
  const best = (q?.limits ?? [])
    .filter((l) => l.active && l.scope && l.resetsAt > now && l.percent > base)
    .sort((a, b) => b.percent - a.percent)[0];
  if (!best?.scope) return null;
  const view = windowView({ used: best.percent, resetsAt: best.resetsAt }, now);
  return view ? { label: best.scope, view } : null;
}

/** Qué mostrar de una cuenta: sin ninguna ventana ni límite = `null` (el llamador decide el texto vacío). */
export function usageViews(q: Quota | undefined, now: number): { five: WindowView | null; seven: WindowView | null; extra: ExtraView | null } | null {
  const five = windowView(q?.fiveHour, now);
  const seven = windowView(q?.sevenDay, now);
  const extra = extraView(q, now);
  return five || seven || extra ? { five, seven, extra } : null;
}

/** Devuelve la cuenta a usar, o null en modo manual / si no hay ninguna con sesión. */
export function pickAccount(policy: AccountPolicy, cands: Candidate[], lastId: string | undefined, now: number): Pick | null {
  if (policy === 'manual') return null;
  // Solo cuentas de Claude: Codex y opencode no tienen cuota ni política (nunca se eligen solas).
  cands = cands.filter((c) => providerOf(c.acc) === 'claude');
  const logged = cands.filter((c) => c.loggedIn);
  if (!logged.length) return null;
  const free = logged.filter((c) => !exhausted(c.quota, now));

  // Todas agotadas: la que se libera antes.
  if (!free.length) {
    const c = [...logged].sort((a, b) => nextReset(a.quota, now) - nextReset(b.quota, now))[0];
    const r = nextReset(c.quota, now);
    return { acc: c.acc, reason: isFinite(r)
      ? t('policy.reason.allExhaustedIn', { name: c.acc.name, time: fmtReset(r, now) })
      : t('policy.reason.allExhausted', { name: c.acc.name }) };
  }

  // Orden circular a partir de la última usada (también desempata a las demás políticas).
  const idx = cands.findIndex((c) => c.acc.id === lastId);
  const rotated = [...cands.slice(idx + 1), ...cands.slice(0, idx + 1)].filter((c) => free.includes(c));

  if (policy === 'reset-soonest') {
    const best = [...rotated].sort((a, b) => nextReset(a.quota, now) - nextReset(b.quota, now))[0];
    const r = nextReset(best.quota, now);
    if (isFinite(r)) return { acc: best.acc, reason: t('policy.reason.resetsSoonest', { time: fmtReset(r, now) }) };
  }
  if (policy === 'most-free') {
    const best = [...rotated].sort((a, b) => pressure(a.quota, now) - pressure(b.quota, now))[0];
    const p = pressure(best.quota, now);
    if (isFinite(p)) return { acc: best.acc, reason: t('policy.reason.mostFree', { pct: Math.round(p) }) };
  }
  // round-robin, o sin datos de cuota para decidir.
  const sinDatos = policy !== 'round-robin';
  return { acc: rotated[0].acc, reason: sinDatos ? t('policy.reason.roundRobinNoData') : t('policy.reason.roundRobin') };
}

// ---------- avisos de cuota (80 % y 95 % de la ventana de 5 h) ----------

/** Estado recordado por cuenta: qué ventana (por su `resetsAt`) y el mayor umbral ya avisado. */
export interface AlertState { resetsAt: number; level: 0 | 80 | 95 }

export function alertLevel(used: number): 0 | 80 | 95 {
  return used >= 95 ? 95 : used >= 80 ? 80 : 0;
}

/** Decide si hay que avisar. La primera vez que se ve una cuenta solo se anota (sin aviso al arrancar);
 *  después se avisa una vez por umbral y ventana. `resetsAt` puede bailar unos segundos: <10 min = misma ventana. */
export function nextAlert(prev: AlertState | undefined, w: Window, now: number): { state: AlertState; fire: 80 | 95 | null } {
  if (w.resetsAt <= now) return { state: { resetsAt: w.resetsAt, level: 0 }, fire: null };
  const lvl = alertLevel(w.used);
  if (!prev) return { state: { resetsAt: w.resetsAt, level: lvl }, fire: null };
  if (Math.abs(prev.resetsAt - w.resetsAt) >= 600) return { state: { resetsAt: w.resetsAt, level: lvl }, fire: lvl || null };
  if (lvl > prev.level) return { state: { resetsAt: prev.resetsAt, level: lvl }, fire: lvl as 80 | 95 };
  return { state: prev, fire: null };
}
