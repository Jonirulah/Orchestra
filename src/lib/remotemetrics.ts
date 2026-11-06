// Métricas del servidor: qué monitores deben existir y cómo se pide al backend (Rust: remote_metrics.rs).
// Puro salvo el controlador, que recibe el backend por parámetro (se prueba con node --test).
//
// Regla: UN monitor por destino (usuario@host:puerto + salto), compartido por todos los paneles de ese host. Existe mientras
// haya algún panel SSH vivo de un host con `remoteMetrics` encendido, en cualquier pestaña, visible o no. No depende del foco.
import { activeSecretKey } from './model.ts';
import type { Host, Pane } from './model.ts';

/** Lo que recibe `rmetrics_start`. Solo el NOMBRE del secreto de la bóveda, nunca el secreto. */
export interface RmReq {
  user?: string; host: string; port: number; identity?: string; identitiesOnly: boolean; jump?: string; secretKey?: string; interval: number;
}

/** Misma clave que `Dest::key()` de Rust: «usuario@host:puerto|salto». */
export const rmKey = (r: Pick<RmReq, 'user' | 'host' | 'port' | 'jump'>): string => `${r.user ?? ''}@${r.host}:${r.port}|${r.jump ?? ''}`;

/** Petición de un host guardado (sale de los mismos campos que lee `sshArgs`). `null` si no tiene las métricas encendidas. */
export function rmReq(h: Host, interval: number): RmReq | null {
  if (h.remoteMetrics !== true) return null;
  const jump = h.proxyJump?.trim();
  const sk = activeSecretKey(h);
  return {
    host: h.host, port: h.port ?? 22, interval,
    ...(h.user ? { user: h.user } : {}),
    ...(h.identityFile ? { identity: h.identityFile } : {}),
    identitiesOnly: h.authMethod === 'key' && !!h.identityFile,
    ...(jump ? { jump } : {}),
    ...(sk ? { secretKey: sk } : {}),
  };
}

export interface LivePane { state: 'starting' | 'running' | 'exited' }

/** Host guardado de un panel SSH (los alias de ~/.ssh/config no tienen ajuste: sin métricas del servidor). */
export function hostOfPane(p: Pick<Pane, 'kind' | 'ref'>, hosts: readonly Host[]): Host | undefined {
  if (p.kind !== 'ssh' || !p.ref || p.ref.startsWith('cfg:')) return undefined;
  return hosts.find((h) => h.id === p.ref);
}

/**
 * Monitores que deben existir ahora: uno por destino distinto con algún panel SSH vivo (no terminado) y el host con las métricas
 * encendidas. Cuentan los paneles de TODAS las pestañas, también los aparcados. Devuelve clave -> petición.
 */
export function desiredMonitors(
  workspaces: readonly { panes: readonly Pick<Pane, 'id' | 'kind' | 'ref'>[] }[],
  hosts: readonly Host[],
  live: Readonly<Record<string, LivePane | undefined>>,
  interval: number,
): Map<string, RmReq> {
  const out = new Map<string, RmReq>();
  for (const w of workspaces) {
    for (const p of w.panes) {
      const h = hostOfPane(p, hosts);
      if (!h || live[p.id]?.state === 'exited') continue;
      const r = rmReq(h, interval);
      if (r) out.set(rmKey(r), r);
    }
  }
  return out;
}

export interface RmBackend {
  start(r: RmReq): Promise<string>;
  stop(key: string): void;
}

/**
 * Lleva el backend al conjunto deseado: arranca los que faltan, para los que sobran y reenvía los que cambiaron de intervalo
 * (Rust reconecta con el nuevo). Cada clave se arranca UNA vez por controlador (el recuento por panel de Rust no se necesita:
 * el frontend ya agrupa por destino).
 */
export class RmController {
  private active = new Map<string, RmReq>();
  private be: RmBackend;
  constructor(be: RmBackend) { this.be = be; }
  keys(): string[] { return [...this.active.keys()]; }
  sync(want: ReadonlyMap<string, RmReq>): { started: string[]; stopped: string[] } {
    const started: string[] = [], stopped: string[] = [];
    for (const [k, r] of want) {
      const cur = this.active.get(k);
      if (!cur) { this.active.set(k, r); started.push(k); void this.be.start(r).catch(() => {}); }
      else if (cur.interval !== r.interval) { this.active.set(k, r); void this.be.start(r).then(() => this.be.stop(k)).catch(() => {}); }
    }
    for (const k of [...this.active.keys()]) {
      if (!want.has(k)) { this.active.delete(k); stopped.push(k); this.be.stop(k); }
    }
    return { started, stopped };
  }
  stopAll(): void { this.sync(new Map()); }
}
