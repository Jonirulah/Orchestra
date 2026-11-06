// Reconexión automática de los paneles SSH. Módulo puro (sin Svelte ni Tauri): se prueba con node --test.
// Solo decide; el almacén programa el temporizador y reutiliza el camino de «Restart» (huella, bóveda, refreshSshSpec).

/** Qué códigos de salida disparan la reconexión: cualquiera ≠ 0, o solo 255 (los errores de conexión de ssh). */
export const RECONNECT_CODES = ['nonzero', '255'] as const;
export type ReconnectCodes = (typeof RECONNECT_CODES)[number];

/** Todo lo que se puede ajustar (Ajustes → SSH). Las funciones de abajo no llevan constantes propias: reciben esto. */
export interface ReconnectOpts {
  /** Intentos máximos por racha; 0 = sin límite. */
  maxAttempts: number;
  /** Espera antes del primer intento (s). */
  firstDelaySec: number;
  /** Cada espera es «factor» veces la anterior (1 = fija). */
  factor: number;
  /** Tope de la espera (s). */
  maxDelaySec: number;
  /** Segundos que debe haber durado la sesión (desde su primera salida) para que su caída cuente como «se cayó». */
  minUpSec: number;
  codes: ReconnectCodes;
}

/** Valores de serie (los mismos que `DEFAULTS` de settings.ts; una prueba lo vigila): esperas 2, 4, 8, 16, 30, 30, 30, 30. */
export const DEFAULT_RECONNECT: ReconnectOpts = { maxAttempts: 8, firstDelaySec: 2, factor: 2, maxDelaySec: 30, minUpSec: 10, codes: 'nonzero' };

/** Saca las opciones de los ajustes. */
export function reconnectOptsOf(s: {
  sshReconnectMaxAttempts: number; sshReconnectFirstDelaySec: number; sshReconnectFactor: number;
  sshReconnectMaxDelaySec: number; sshReconnectMinUpSec: number; sshReconnectCodes: ReconnectCodes;
}): ReconnectOpts {
  return {
    maxAttempts: s.sshReconnectMaxAttempts, firstDelaySec: s.sshReconnectFirstDelaySec, factor: s.sshReconnectFactor,
    maxDelaySec: s.sshReconnectMaxDelaySec, minUpSec: s.sshReconnectMinUpSec, codes: s.sshReconnectCodes,
  };
}

/** Espera (s) antes del intento `attempt` (1 = primero): primera × factor^(n−1), con tope. Siempre ≥ 1 s. */
export function backoff(attempt: number, o: ReconnectOpts = DEFAULT_RECONNECT): number {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const raw = o.firstDelaySec * Math.pow(o.factor, n - 1);
  return Math.max(1, Math.round(Math.min(o.maxDelaySec, raw)));
}

export type Reason =
  | 'ok'
  | 'not-ssh'
  | 'disabled'
  | 'user'
  | 'clean-exit'
  | 'other-code'
  | 'short-session'
  | 'auth-failed'
  | 'max-attempts';

export interface DecideIn {
  kind: string;
  /** Código de salida del proceso (undefined = desconocido). */
  code: number | undefined;
  /** Segundos que duró la sesión desde su primera salida (o desde el lanzamiento si no hubo). */
  upSec: number;
  /** Lo pidió el usuario (cerrar, Restart, cambio de cuenta, Cancelar). */
  userInitiated: boolean;
  enabled: boolean;
  /** Reintentos ya hechos en esta racha (0 = la primera caída). */
  attempt: number;
  /** El final de la salida de ssh dice «Permission denied», huella cambiada, etc.: reintentar no sirve. */
  authFailed?: boolean;
}

export interface Decision {
  reconnect: boolean;
  delaySec: number;
  reason: Reason;
  /** Número de este intento (1..maxAttempts) si se reconecta; si no, el contador que llegó. */
  attempt: number;
}

/**
 * ¿Hay que reconectar?
 * - Solo SSH, con el ajuste encendido, con código ≠ 0 (un `exit` escrito por el usuario sale con 0; con `codes: '255'` solo 255) y sin que lo haya pedido el usuario.
 * - La primera caída exige que la sesión hubiera estado ≥ `minUpSec` activa: contraseña mala, host desconocido o conexión rechazada salen enseguida y no se repiten.
 * - Dentro de una racha (ya se está reintentando) un fallo rápido es lo normal (la red sigue caída): se sigue con el backoff hasta el tope.
 * - Una sesión que vuelve a durar ≥ `minUpSec` cierra la racha: el contador vuelve a 0.
 * - Tope de `maxAttempts` intentos (0 = sin tope); después el panel queda en el estado «terminado» de siempre.
 */
export function decide(i: DecideIn, o: ReconnectOpts = DEFAULT_RECONNECT): Decision {
  const stop = (reason: Reason, attempt = i.attempt): Decision => ({ reconnect: false, delaySec: 0, reason, attempt });
  if (i.kind !== 'ssh') return stop('not-ssh');
  if (!i.enabled) return stop('disabled');
  if (i.userInitiated) return stop('user');
  if (i.code === undefined || i.code === 0) return stop('clean-exit');
  if (o.codes === '255' && i.code !== 255) return stop('other-code');
  const sessionWasUp = i.upSec >= o.minUpSec;
  const attempt = sessionWasUp ? 0 : Math.max(0, Math.floor(i.attempt) || 0);
  if (i.authFailed) return stop('auth-failed', attempt);
  if (attempt === 0 && !sessionWasUp) return stop('short-session', 0);
  if (o.maxAttempts > 0 && attempt >= o.maxAttempts) return stop('max-attempts', attempt);
  return { reconnect: true, delaySec: backoff(attempt + 1, o), reason: 'ok', attempt: attempt + 1 };
}

/** Finales de salida de ssh con los que reintentar es inútil (o peligroso: bloquear la cuenta). */
const FATAL = /Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Too many authentication failures|No more authentication methods/i;

/** ¿Las últimas líneas de la terminal son un fallo de autenticación / de huella? */
export function isAuthFailure(tail: string): boolean {
  return FATAL.test(tail);
}
