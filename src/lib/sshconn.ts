// Lo que pasa alrededor de una sesión SSH: la insignia de latencia y la reconexión automática.
// TS plano (sin runas ni Tauri): el almacén le pasa contenedores reactivos y un «contexto» con lo que necesita;
// así se prueba con node --test, con temporizadores falsos. Las decisiones puras están en latency.ts y reconnect.ts.
import { dedupeTargets, latencyOptsOf, latencyTarget, levelOf, pushSample, statsOf, targetId } from './latency.ts';
import type { CfgEntry, Level, PingTarget, Sample, Stats } from './latency.ts';
import { decide, isAuthFailure, reconnectOptsOf } from './reconnect.ts';
import { dropCause } from './sshdrop.ts';
import type { DownView, GaveUpView } from './sshdrop.ts';
import type { ReconnectCodes } from './reconnect.ts';
import type { Host, Pane } from './model.ts';

/** Los ajustes que usa (un subconjunto de Settings). */
export interface ConnSettings {
  sshAutoReconnect: boolean; sshReconnectMaxAttempts: number; sshReconnectFirstDelaySec: number; sshReconnectFactor: number;
  sshReconnectMaxDelaySec: number; sshReconnectMinUpSec: number; sshReconnectCodes: ReconnectCodes; sshReconnectFlash: boolean;
  latencyBadge: boolean; latencyIntervalSec: number; latencyTimeoutSec: number; latencyWarnMs: number; latencyBadMs: number;
  latencySamples: number; latencyFailsBad: number; latencyShowUnit: boolean;
}
export interface PingRes { id: string; ms: number | null; error: string | null }
export interface LiveLike { state: 'starting' | 'running' | 'exited'; startedAt?: number; firstOutputAt?: number }

export interface ConnCtx {
  settings(): ConnSettings;
  hosts(): Host[];
  sshConfig(): CfgEntry[];
  /** El panel, y si se ve (espacio de trabajo activo y no aparcado). undefined = ya no existe. */
  pane(id: string): { pane: Pane; visible: boolean } | undefined;
  /** Los paneles que se ven ahora. */
  visiblePanes(): Pane[];
  live(id: string): LiveLike | undefined;
  /** El MISMO camino que el botón «Restart» (huella, bóveda, refreshSshSpec). `attempt` = intento automático (para el rótulo del terminal). */
  restart(id: string, attempt?: number): void;
  /** Se confirmó la vuelta tras una caída (para escribir el separador en el terminal). */
  reconnected?(id: string, at: number, downMs: number): void;
  toast(msg: string): void;
  /** Texto de las últimas líneas del terminal (cómo terminó ssh). */
  tailText(id: string): Promise<string>;
  ping(targets: PingTarget[], timeoutSec: number): Promise<PingRes[]>;
  pageVisible(): boolean;
  now(): number;
  /** Textos (i18n) que necesita para avisar. */
  gaveUpText(name: string, n: number): string;
}

export interface ReconnectView {
  /** Se está decidiendo (unos milisegundos): no se enseña ninguna barra. */
  pending?: boolean;
  attempt: number;
  /** 0 = sin límite. */
  max: number;
  delaySec: number;
  /** Cuándo se lanza el intento (ms). */
  at: number;
}

export interface ConnState {
  latency: Record<string, Sample[]>;
  reconnecting: Record<string, ReconnectView>;
  /** Cabecera destellando tras reconectar (id → instante). */
  flash: Record<string, number>;
  /** Racha de caída en curso (desde la primera caída hasta confirmar la vuelta o rendirse). */
  down: Record<string, DownView>;
  /** Se rindió: motivo legible para la franja roja (hasta que el usuario reinicie o cierre). */
  gaveUp: Record<string, GaveUpView>;
}

/** Tras la primera salida de un reintento, cuánto tiene que seguir vivo el proceso para darlo por reconectado (ms):
 *  un fallo de red también escribe una línea («Connection timed out») y sale enseguida. */
export const CONFIRM_MS = 1500;

export type BadgeView =
  | { mode: 'none' }
  | { mode: 'jump' }
  | { mode: 'idle' }
  | { mode: 'live'; stats: Stats; level: Level; n: number };

export class SshConn {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private streak = new Map<string, number>();
  private stopped = new Set<string>();
  private flashTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private confirmTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private shutting = false;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private tickN = 0;

  private ctx: ConnCtx;
  st: ConnState;

  constructor(ctx: ConnCtx, st: ConnState) {
    this.ctx = ctx;
    this.st = st;
  }

  // ---------- reconexión ----------

  /** Un proceso del panel terminó. Decide en unos milisegundos (hay que esperar a que xterm pinte el final de la salida). */
  async onExit(id: string, code: number | undefined): Promise<void> {
    const found = this.ctx.pane(id);
    if (!found || found.pane.kind !== 'ssh') return;
    delete this.st.latency[id];
    const s = this.ctx.settings();
    // Las salidas «seguras» no esperan ni parpadean.
    if (!s.sshAutoReconnect || code === undefined || code === 0) { this.streak.delete(id); delete this.st.down[id]; return; }
    this.clearTimer(id);
    this.st.reconnecting[id] = { pending: true, attempt: 0, max: 0, delaySec: 0, at: 0 };
    const tail = await this.ctx.tailText(id).catch(() => '');
    const now = this.ctx.now();
    const again = this.ctx.pane(id);
    const live = this.ctx.live(id);
    // El usuario lo reinició o cerró mientras tanto: nada que hacer (su acción ya limpió el estado).
    if (!again || live?.state !== 'exited' || !this.st.reconnecting[id]?.pending) { delete this.st.reconnecting[id]; return; }
    const o = reconnectOptsOf(s);
    const firstOut = live.firstOutputAt;
    const d = decide({
      kind: again.pane.kind, code, upSec: firstOut ? Math.max(0, (now - firstOut) / 1000) : 0,
      // Cancelado, aparcado, en otro espacio de trabajo o cerrando la aplicación: igual que si lo hubiera parado el usuario.
      userInitiated: this.stopped.has(id) || !again.visible || this.shutting,
      enabled: s.sshAutoReconnect, attempt: this.streak.get(id) ?? 0, authFailed: isAuthFailure(tail),
    }, o);
    if (!d.reconnect) {
      delete this.st.reconnecting[id];
      const down = this.st.down[id];
      // Se rinde una racha de caída (o se agotan los intentos): franja roja con el motivo. Un fallo al arrancar no es una caída.
      if ((down || d.reason === 'max-attempts') && !this.shutting) {
        const why = d.reason === 'user' ? 'paused' : d.reason;
        this.st.gaveUp[id] = { cause: dropCause(tail, why), attempt: Math.max(1, d.attempt), at: now, since: down?.since ?? now };
      }
      delete this.st.down[id];
      if (d.reason === 'max-attempts') this.ctx.toast(this.ctx.gaveUpText(again.pane.title, d.attempt));
      this.streak.delete(id);
      return;
    }
    this.st.down[id] = { since: this.st.down[id]?.since ?? now, attempt: d.attempt };
    this.streak.set(id, d.attempt);
    this.st.reconnecting[id] = { attempt: d.attempt, max: o.maxAttempts, delaySec: d.delaySec, at: now + d.delaySec * 1000 };
    this.timers.set(id, setTimeout(() => this.fire(id), d.delaySec * 1000));
  }

  /** «Reconnect now»: salta la espera (cuenta como el intento que ya estaba anunciado). */
  reconnectNow(id: string): void {
    if (!this.st.reconnecting[id] || this.st.reconnecting[id].pending) return;
    this.clearTimer(id);
    this.fire(id);
  }

  /** «Cancel»: no se reintenta más en este panel hasta que el usuario lo reinicie. */
  cancel(id: string): void {
    this.clearTimer(id);
    delete this.st.reconnecting[id];
    delete this.st.down[id];
    this.streak.delete(id);
    this.stopped.add(id);
  }

  /** El usuario reinicia el panel (botón Restart): se olvida todo, también el «Cancel». */
  userRestarted(id: string): void {
    this.forget(id);
    this.stopped.delete(id);
    delete this.st.latency[id];
  }

  /** El panel se cierra (o su espacio de trabajo): sin estado ni temporizadores. */
  closed(id: string): void {
    this.forget(id);
    this.stopped.delete(id);
    delete this.st.latency[id];
  }

  shutdown(): void {
    this.shutting = true;
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
    for (const t of this.confirmTimers.values()) clearTimeout(t);
    this.confirmTimers.clear();
    this.st.reconnecting = {};
    this.disarm();
  }

  private forget(id: string): void {
    this.clearTimer(id);
    clearTimeout(this.confirmTimers.get(id));
    this.confirmTimers.delete(id);
    delete this.st.reconnecting[id];
    delete this.st.down[id];
    delete this.st.gaveUp[id];
    this.streak.delete(id);
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(id);
  }

  private fire(id: string): void {
    this.timers.delete(id);
    delete this.st.reconnecting[id];
    const found = this.ctx.pane(id);
    // Si mientras esperaba lo han parado, cambiado de sitio o la aplicación se cierra, no se lanza.
    if (!found || !found.visible || this.shutting || this.stopped.has(id) || this.ctx.live(id)?.state !== 'exited') {
      const down = this.st.down[id];
      // Oculto mientras esperaba (otra pestaña o segundo plano): no se lanza, pero se dice por qué en lugar de quedarse mudo.
      if (down && found && !this.shutting && !this.stopped.has(id) && this.ctx.live(id)?.state === 'exited') {
        this.st.gaveUp[id] = { cause: 'paused', attempt: this.streak.get(id) ?? 1, at: this.ctx.now(), since: down.since };
      }
      delete this.st.down[id];
      this.streak.delete(id);
      return;
    }
    this.ctx.restart(id, this.streak.get(id));
  }

  /**
   * Llegó la primera salida del proceso. Si era un reintento, se confirma la vuelta cuando el proceso sigue vivo
   * CONFIRM_MS después (un fallo de red también escribe algo y sale): separador en el terminal, fin del velo y destello.
   */
  outputSeen(id: string): void {
    if (!this.streak.get(id) || !this.st.down[id]) return;
    clearTimeout(this.confirmTimers.get(id));
    this.confirmTimers.set(id, setTimeout(() => {
      this.confirmTimers.delete(id);
      const down = this.st.down[id];
      if (!down || this.ctx.live(id)?.state === 'exited' || !this.ctx.pane(id)) return;
      const now = this.ctx.now();
      delete this.st.down[id];
      this.ctx.reconnected?.(id, now, now - down.since);
      if (!this.ctx.settings().sshReconnectFlash) return;
      this.st.flash[id] = now;
      clearTimeout(this.flashTimers.get(id));
      this.flashTimers.set(id, setTimeout(() => { delete this.st.flash[id]; this.flashTimers.delete(id); }, 1600));
    }, CONFIRM_MS));
  }

  // ---------- latencia ----------

  /** Enciende o apaga el sondeo según los ajustes (llamar al arrancar y cuando cambien `latencyBadge` / `latencyIntervalSec`). */
  arm(): void {
    this.disarm();
    const s = this.ctx.settings();
    if (!s.latencyBadge) { this.st.latency = {}; return; }
    void this.tick();
    this.tickTimer = setInterval(() => void this.tick(), s.latencyIntervalSec * 1000);
  }

  disarm(): void {
    if (this.tickTimer !== undefined) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
  }

  /** Una pasada: UNA llamada para todos los paneles medibles (direcciones sin repetir). Nunca lanza. */
  async tick(): Promise<void> {
    const s = this.ctx.settings();
    if (!s.latencyBadge || !this.ctx.pageVisible() || this.busy || this.shutting) return;
    const hosts = this.ctx.hosts();
    const cfg = this.ctx.sshConfig();
    const byAddr = new Map<string, string[]>(); // «host:puerto» -> ids de panel
    const wanted: { host: string; port: number }[] = [];
    for (const p of this.ctx.visiblePanes()) {
      if (this.ctx.live(p.id)?.state !== 'running') continue;
      const t = latencyTarget(p, hosts, cfg);
      if (t.kind !== 'measure') continue;
      const key = targetId(t.host, t.port);
      byAddr.set(key, [...(byAddr.get(key) ?? []), p.id]);
      wanted.push(t);
    }
    const targets = dedupeTargets(wanted);
    if (!targets.length) return;
    this.busy = true;
    this.tickN++;
    try {
      const res = await this.ctx.ping(targets, s.latencyTimeoutSec);
      const cap = s.latencySamples;
      for (const r of res) {
        for (const id of byAddr.get(r.id) ?? []) {
          // Si entre medias el panel dejó de estar en marcha, la muestra se descarta (no pinta una insignia sobre «—»).
          if (this.ctx.live(id)?.state !== 'running') continue;
          this.st.latency[id] = pushSample(this.st.latency[id] ?? [], r.error ? null : r.ms, cap);
        }
      }
    } catch { /* sin medición: la insignia se queda como estaba */ } finally {
      this.busy = false;
    }
  }

  /** Cuántas pasadas con red ha hecho (para las pruebas y la medida de cadencia). */
  get ticks(): number { return this.tickN; }

  /** Lo que enseña la insignia de un panel. */
  view(pane: Pane): BadgeView {
    const s = this.ctx.settings();
    if (pane.kind !== 'ssh' || !s.latencyBadge) return { mode: 'none' };
    const t = latencyTarget(pane, this.ctx.hosts(), this.ctx.sshConfig());
    if (t.kind === 'none') return { mode: 'none' };
    if (t.kind === 'jump') return { mode: 'jump' };
    if (this.ctx.live(pane.id)?.state !== 'running') return { mode: 'idle' };
    const stats = statsOf(this.st.latency[pane.id] ?? [], s.latencySamples);
    return { mode: 'live', stats, level: levelOf(stats, latencyOptsOf(s)), n: stats.n };
  }
}
