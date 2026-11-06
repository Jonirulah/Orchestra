// Estado de sesión de las cuentas de Codex y opencode. Módulo puro (sin Svelte ni Tauri): se prueba con node --test.
//
// Solo se guarda un veredicto (con sesión / sin sesión / desconocido) y, como mucho, el método o un recuento.
// El backend ya descarta la salida de `codex login status` / `opencode auth list`; aquí se vuelve a filtrar
// lo que llegue (lista blanca) para que nada con pinta de secreto pueda quedarse en memoria ni en el estado.
import { t } from './i18n.ts';
import type { Account, Provider } from './model.ts';
import { providerOf } from './model.ts';

export type LoginStatus = 'signedIn' | 'notSignedIn' | 'unknown';
const STATUSES: readonly LoginStatus[] = ['signedIn', 'notSignedIn', 'unknown'];
const METHODS = ['chatgpt', 'apikey', 'other'] as const;

export interface ProviderEntry {
  status: LoginStatus;
  method?: (typeof METHODS)[number];
  count?: number;
  /** Cuándo se comprobó (ms). */
  at: number;
}

/** Mínimo entre dos comprobaciones de la misma cuenta si no se piden a mano. */
export const STATUS_MIN_GAP_MS = 30_000;

/** Lo que devuelve el backend -> entrada segura. Campos y valores desconocidos se descartan. */
export function toProviderEntry(raw: unknown, now: number): ProviderEntry {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const status = STATUSES.includes(r.status as LoginStatus) ? (r.status as LoginStatus) : 'unknown';
  const e: ProviderEntry = { status, at: now };
  if (METHODS.includes(r.method as never)) e.method = r.method as ProviderEntry['method'];
  if (typeof r.count === 'number' && Number.isInteger(r.count) && r.count >= 0 && r.count < 1000) e.count = r.count;
  return e;
}

/** ¿Toca volver a preguntar? Sin entrada previa o pasado el mínimo; `force` = a mano. */
export function shouldRefresh(e: ProviderEntry | undefined, now: number, force = false, gapMs = STATUS_MIN_GAP_MS): boolean {
  return force || !e || now - e.at >= gapMs;
}

/** Cuentas cuya sesión se puede comprobar con el comando del proveedor (todas las que no son de Claude). */
export function checkable(accounts: readonly Account[]): Account[] {
  return accounts.filter((a) => providerOf(a) !== 'claude');
}

/** Texto del estado (`checking` = hay una consulta en curso). */
export function statusLabel(e: ProviderEntry | undefined, checking = false): string {
  if (checking) return t('providers.status.checking');
  if (!e) return t('providers.status.unknown');
  if (e.status === 'notSignedIn') return t('providers.status.notSignedIn');
  if (e.status === 'unknown') return t('providers.status.unknown');
  if (e.method === 'chatgpt') return t('providers.status.signedInChatgpt');
  if (e.method === 'apikey') return t('providers.status.signedInApikey');
  if (e.count !== undefined) return t('providers.status.signedInN', { n: e.count });
  return t('providers.status.signedIn');
}

export function statusTone(e: ProviderEntry | undefined): 'ok' | 'warn' | 'muted' {
  return e?.status === 'signedIn' ? 'ok' : e?.status === 'notSignedIn' ? 'warn' : 'muted';
}

/** Proveedores que se pueden añadir como cuenta nueva, en el orden del selector. */
export const ADDABLE: readonly Provider[] = ['claude', 'codex', 'opencode'];
