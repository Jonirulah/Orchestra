// Consulta de uso opcional (ver docs/SECURITY.md, «Usage query (opt-in)»). Módulo puro: se prueba con node --test.
// Aquí solo hay ayudas de interfaz (estado -> texto, antigüedad, qué cuentas consultar). El token nunca llega al frontend.
import { t, tk } from './i18n.ts';

export const QUERY_STATUSES = ['ok', 'expired', 'nocreds', 'unauthorized', 'rate_limited', 'error'] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

/** Lo que devuelve el comando `usage_fetch` por cuenta. */
export interface UsageResult {
  accountId: string;
  status: QueryStatus;
  fiveHour?: { used: number; resetsAt: number };
  sevenDay?: { used: number; resetsAt: number };
  fetchedAt: number;
  message?: string;
}

/** Último resultado de la consulta de una cuenta (lo que guarda `app.usageStatus`). */
export interface QueryEntry { status: QueryStatus; at: number; message?: string }

/** Margen (s) a partir del cual unos datos se consideran viejos. */
export const STALE_SEC = 15 * 60;

export const INTERVAL_MIN = [2, 30] as const;

export function isQueryStatus(v: unknown): v is QueryStatus {
  return typeof v === 'string' && (QUERY_STATUSES as readonly string[]).includes(v);
}

/** Intervalo en minutos dentro de 2..30 (entero); lo inválido cae a 5. */
export function clampIntervalMin(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 5;
  return Math.min(INTERVAL_MIN[1], Math.max(INTERVAL_MIN[0], Math.round(v)));
}

/** Convierte lo que llegue del backend en una entrada válida (un estado desconocido se trata como error). */
export function toEntry(r: Partial<UsageResult> | null | undefined, nowSec: number): QueryEntry {
  const status = isQueryStatus(r?.status) ? r.status : 'error';
  const at = typeof r?.fetchedAt === 'number' && Number.isFinite(r.fetchedAt) && r.fetchedAt > 0 ? r.fetchedAt : nowSec;
  const message = typeof r?.message === 'string' && r.message ? r.message.slice(0, 200) : undefined;
  return { status, at, message };
}

/** «just now», «5 min ago», «2 h ago», «3 d ago». */
export function agoText(sec: number): string {
  const s = Number.isFinite(sec) ? Math.max(0, sec) : 0;
  if (s < 60) return t('settings.usage.ago.now');
  const m = Math.floor(s / 60);
  if (m < 60) return t('settings.usage.ago.min', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('settings.usage.ago.hour', { n: h });
  return t('settings.usage.ago.day', { n: Math.floor(h / 24) });
}

/** Línea de estado de una cuenta (Ajustes -> Cuentas). Sin entrada: «Checking…». */
export function statusText(e: QueryEntry | undefined, nowSec: number, loggedIn: boolean): string {
  if (!loggedIn) return t('settings.usage.status.nocreds');
  if (!e) return t('settings.usage.status.checking');
  // Las claves de i18n van en camelCase: rate_limited -> rateLimited.
  const seg = e.status === 'rate_limited' ? 'rateLimited' : e.status;
  return tk(`settings.usage.status.${seg}`, { ago: agoText(nowSec - e.at) });
}

/** Tono de color de la línea de estado. */
export function statusTone(e: QueryEntry | undefined): 'ok' | 'warn' | 'bad' | 'muted' {
  if (!e) return 'muted';
  switch (e.status) {
    case 'ok': return 'ok';
    case 'expired': case 'rate_limited': return 'warn';
    case 'unauthorized': case 'error': return 'bad';
    default: return 'muted';
  }
}

/**
 * Texto del tooltip de las barras cuando los datos son viejos Y la consulta dice que el token caducó
 * (la cuenta lleva rato sin abrirse): «last data 40 min ago». Vacío si no hace falta avisar.
 */
export function staleTip(quotaAt: number | undefined, e: QueryEntry | undefined, nowSec: number): string {
  if (!e || e.status !== 'expired' || quotaAt === undefined || !Number.isFinite(quotaAt)) return '';
  const age = nowSec - quotaAt;
  if (age < STALE_SEC) return '';
  return t('usage.bars.lastData', { ago: agoText(age) });
}

/** Cuentas que se consultan: solo las que tienen sesión iniciada. */
export function queryTargets<A extends { id: string; dir: string }>(accts: A[], loggedIn: (a: A) => boolean): { id: string; dir: string }[] {
  return accts.filter((a) => a.id && a.dir && loggedIn(a)).map((a) => ({ id: a.id, dir: a.dir }));
}
