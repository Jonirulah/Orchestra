// Cómo se ve un panel SSH que se cae, reconecta o se rinde. Módulo puro (sin Svelte ni Tauri): se prueba con node --test.
// sshconn.ts guarda el estado (caída en curso, cuenta atrás, rendición); aquí solo se decide qué pintar y con qué texto.
import { t, type Key } from './i18n.ts';
import type { Reason } from './reconnect.ts';

/** Racha de caída en curso: desde la primera caída hasta que se confirma la vuelta (o se rinde). */
export interface DownView {
  /** Cuándo se cayó (ms). */
  since: number;
  /** Intento en curso o anunciado (1 = primero). */
  attempt?: number;
}

/** Por qué se rindió, ya clasificado para enseñarlo. */
export type DropCause = 'auth' | 'hostkey' | 'dns' | 'refused' | 'timeout' | 'unreachable' | 'closed' | 'max' | 'paused';

export interface GaveUpView {
  cause: DropCause;
  /** Intentos hechos. */
  attempt: number;
  /** Cuándo se rindió (ms). */
  at: number;
  /** Cuándo empezó la caída (ms). */
  since: number;
}

/** Estado visual de un panel SSH. */
export type SshLook =
  | 'none'          // no es SSH
  | 'up'            // en marcha (o arrancando por primera vez)
  | 'deciding'      // acaba de salir; se decide en unos milisegundos si se reintenta
  | 'waiting'       // caído, cuenta atrás hasta el siguiente intento
  | 'retrying'      // caído, intento lanzado, aún sin confirmar
  | 'gaveup'        // se rindió: franja roja con el motivo
  | 'exited';       // terminó sin reconexión (salida normal, contraseña mala al arrancar…)

export interface LookIn {
  kind: string;
  state: 'starting' | 'running' | 'exited' | undefined;
  /** Cuenta atrás (de sshconn): pending = decidiendo. */
  reconnecting?: { pending?: boolean } | undefined;
  down?: DownView | undefined;
  gaveUp?: GaveUpView | undefined;
}

export function sshLook(i: LookIn): SshLook {
  if (i.kind !== 'ssh') return 'none';
  if (i.gaveUp) return 'gaveup';
  if (i.reconnecting) return i.reconnecting.pending ? 'deciding' : 'waiting';
  if (i.down) return i.state === 'exited' ? 'deciding' : 'retrying';
  return i.state === 'exited' ? 'exited' : 'up';
}

/** ¿Va el velo sobre el terminal? (cualquier estado de caída; «deciding» solo si ya venía caído, para no parpadear en un exit normal). */
export function veiled(look: SshLook, wasDown: boolean): boolean {
  return look === 'waiting' || look === 'retrying' || look === 'gaveup' || (look === 'deciding' && wasDown);
}

/** Color del punto de aviso: ámbar mientras se intenta, rojo si se rindió; null = sin punto. */
export function dotOf(look: SshLook, wasDown: boolean): 'amber' | 'red' | null {
  if (look === 'gaveup') return 'red';
  if (look === 'waiting' || look === 'retrying' || (look === 'deciding' && wasDown)) return 'amber';
  return null;
}

/** Lo peor de varios paneles (para la pestaña y la fila del host): rojo gana a ámbar. */
export function worstDot(dots: ('amber' | 'red' | null)[]): 'amber' | 'red' | null {
  return dots.includes('red') ? 'red' : dots.includes('amber') ? 'amber' : null;
}

/** Fracción de la espera ya transcurrida (0..1) para la barra fina de la cuenta atrás. */
export function countdownFrac(rc: { delaySec: number; at: number }, now: number): number {
  const total = rc.delaySec * 1000;
  if (!(total > 0)) return 1;
  const left = rc.at - now;
  return Math.min(1, Math.max(0, 1 - left / total));
}

/** Duración corta y legible: «38 s», «2 min 5 s», «1 h 3 min». */
export function fmtDowntime(ms: number): string {
  const s = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) { const r = s % 60; return r ? `${m} min ${r} s` : `${m} min`; }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} h ${rm} min` : `${h} h`;
}

/** Hora local «17:42». */
export function fmtClock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Texto del separador que se escribe en el terminal al volver: «── reconectado 17:42 · caída 38 s ──». */
export function separatorText(at: number, downMs: number): string {
  return t('attention.ssh.separator', { time: fmtClock(at), dur: fmtDowntime(downMs) });
}

/** Clasifica el final de la salida de ssh (y la razón de la decisión) en un motivo legible. */
export function dropCause(tail: string, reason: Reason | 'paused'): DropCause {
  if (reason === 'paused') return 'paused';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(tail)) return 'hostkey';
  if (/Permission denied|Too many authentication failures|No more authentication methods/i.test(tail) || reason === 'auth-failed') return 'auth';
  if (/Could not resolve hostname|Name or service not known|nodename nor servname|No such host/i.test(tail)) return 'dns';
  if (/Connection refused/i.test(tail)) return 'refused';
  if (/timed out/i.test(tail)) return 'timeout';
  if (/Network is unreachable|No route to host|Host is unreachable/i.test(tail)) return 'unreachable';
  if (/Connection (closed|reset)|Broken pipe|kex_exchange_identification/i.test(tail)) return 'closed';
  return 'max';
}

const CAUSE_KEY: Record<Exclude<DropCause, 'paused'>, Key> = {
  auth: 'attention.ssh.cause.auth',
  hostkey: 'attention.ssh.cause.hostkey',
  dns: 'attention.ssh.cause.dns',
  refused: 'attention.ssh.cause.refused',
  timeout: 'attention.ssh.cause.timeout',
  unreachable: 'attention.ssh.cause.unreachable',
  closed: 'attention.ssh.cause.closed',
  max: 'attention.ssh.cause.max',
};

/** Texto de la franja roja: «Reconexión abandonada tras 3 intentos: la red no responde (tiempo agotado)». */
export function gaveUpText(g: GaveUpView): string {
  if (g.cause === 'paused') return t('attention.ssh.paused');
  const why = t(CAUSE_KEY[g.cause]);
  return g.attempt === 1 ? t('attention.ssh.gaveUpOne', { why }) : t('attention.ssh.gaveUp', { n: g.attempt, why });
}
