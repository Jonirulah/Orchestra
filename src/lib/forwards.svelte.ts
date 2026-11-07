// Estado vivo del reenvío de puertos: túneles (los vigila Rust, aquí se consultan), avisos de «puerto detectado», el
// diálogo «Reenviar un puerto…» y el cableado con la salida de los terminales. La lógica pura está en portdetect.ts.
import { app } from './store.svelte.ts';
import * as be from './backend.ts';
import * as fb from './fwdbackend.ts';
import * as T from './terminals.ts';
import { hostOfPane } from './remotemetrics.ts';
import { PortScanner, autoTunnelsToStop, fwdDest, localUrl, savedToStart, shouldOffer, tunnelId } from './portdetect.ts';
import type { TunnelMeta, TunnelSnap } from './portdetect.ts';
import type { Host } from './model.ts';
import { t } from './i18n.ts';

export interface PortNotice { key: string; hostId: string; hostName: string; port: number; at: number }
export interface FwdDialog { hostId: string; remote?: number }

/** Cuánto se queda el aviso en pantalla si no se toca (ms). */
const NOTICE_MS = 20000;
/** Cuánto se espera a que el túnel suba antes de abrir el navegador (ms). */
const OPEN_WAIT_MS = 25000;

class Forwards {
  tunnels = $state<TunnelSnap[]>([]);
  meta = $state<Record<string, TunnelMeta>>({});
  notices = $state<PortNotice[]>([]);
  dialog = $state<FwdDialog | null>(null);

  /** «hostId:puerto» ya avisados (o ignorados) en esta sesión de la app. */
  private seen = new Set<string>();
  /** Túneles guardados que el usuario paró a mano: no se rearrancan hasta que el host vuelva a conectar. */
  private paused = new Set<string>();
  private scanners = new Map<string, { sc: PortScanner; dec: TextDecoder }>();
  /** Panel SSH vivo -> host guardado (lo rellena `sync`). */
  private paneHost = new Map<string, string>();
  private liveHosts = new Set<string>();
  private pollTimer = 0;
  private wired = false;

  host(id: string): Host | undefined { return app.hosts.find((h) => h.id === id); }
  hostName(id: string): string { const h = this.host(id); return h ? h.name || h.host : id; }
  /** Túneles de un host (por su clave de destino). */
  ofHost(hostId: string): TunnelSnap[] { return this.tunnels.filter((x) => this.meta[x.id]?.hostId === hostId); }
  isSaved(s: Pick<TunnelSnap, 'id' | 'remotePort'>): boolean {
    const m = this.meta[s.id];
    return !!m && !!this.host(m.hostId)?.forwards?.some((f) => f.remote === s.remotePort);
  }

  wire(): void {
    if (this.wired) return;
    this.wired = true;
    T.setOutputTap((id, b) => this.onBytes(id, b));
  }

  private onBytes(paneId: string, b: Uint8Array): void {
    if (!app.settings.portsDetect) return;
    const hostId = this.paneHost.get(paneId);
    if (!hostId) return;
    let s = this.scanners.get(paneId);
    if (!s) { s = { sc: new PortScanner(), dec: new TextDecoder() }; this.scanners.set(paneId, s); }
    const ports = s.sc.feed(s.dec.decode(b, { stream: true }));
    if (!ports.length) return;
    const tunneled = new Set(this.tunnels.map((x) => `${this.meta[x.id]?.hostId}:${x.remotePort}`));
    for (const port of ports) {
      if (!shouldOffer(hostId, port, this.seen, tunneled)) continue;
      this.seen.add(`${hostId}:${port}`);
      if (app.settings.portsAutoOpen) { void this.forward(hostId, port, { open: true }); continue; }
      const key = `${hostId}:${port}`;
      this.notices = [...this.notices.filter((n) => n.key !== key), { key, hostId, hostName: this.hostName(hostId), port, at: Date.now() }].slice(-3);
      window.setTimeout(() => this.dismiss(key), NOTICE_MS);
    }
  }

  dismiss(key: string): void { this.notices = this.notices.filter((n) => n.key !== key); }

  /**
   * Lleva los túneles al estado que piden los paneles: los guardados de los hosts conectados arrancan; los automáticos de un
   * host sin paneles vivos se paran. Lo llama un `$effect` (PortForwards.svelte) cuando cambian paneles, estados o hosts.
   */
  sync(workspaces: typeof app.workspaces, hosts: readonly Host[], live: typeof app.live): void {
    this.wire();
    const paneHost = new Map<string, string>();
    for (const w of workspaces) for (const p of w.panes) {
      const h = hostOfPane(p, hosts);
      if (h && live[p.id]?.state !== 'exited') paneHost.set(p.id, h.id);
    }
    for (const id of this.scanners.keys()) if (!paneHost.has(id)) this.scanners.delete(id);
    this.paneHost = paneHost;
    const liveHosts = new Set(paneHost.values());
    // Host que vuelve a conectar: sus guardados parados a mano pueden volver.
    for (const id of [...this.paused]) { const hid = this.meta[id]?.hostId; if (!hid || !liveHosts.has(hid)) this.paused.delete(id); }
    this.liveHosts = liveHosts;
    for (const id of autoTunnelsToStop(this.tunnels, this.meta, hosts, liveHosts)) this.stop(id);
    const have = new Set([...this.tunnels.map((x) => x.id), ...this.paused]);
    for (const s of savedToStart([...hosts], liveHosts, have)) void this.start(s.host, s.remote, s.local, false);
  }

  private async start(h: Host, remote: number, local: number | undefined, auto: boolean): Promise<TunnelSnap | null> {
    const d = fwdDest(h);
    try {
      const snap = await fb.pfwdStart({ ...d, remotePort: remote, ...(local ? { localPort: local } : {}) });
      this.meta = { ...this.meta, [snap.id]: { hostId: h.id, auto: this.meta[snap.id]?.auto ?? auto } };
      this.upsert(snap);
      this.ensurePolling();
      return snap;
    } catch (e) {
      app.toast(t('ports.toast.failed', { port: remote, error: String(e) }));
      return null;
    }
  }

  private upsert(s: TunnelSnap): void {
    const i = this.tunnels.findIndex((x) => x.id === s.id);
    if (i >= 0) this.tunnels[i] = s; else this.tunnels = [...this.tunnels, s];
  }

  /** Crea (o reutiliza) el túnel al puerto remoto. `open`: abre el navegador cuando suba. `save`: lo guarda en el host. */
  async forward(hostId: string, remote: number, o: { local?: number; open?: boolean; save?: boolean } = {}): Promise<void> {
    const h = this.host(hostId);
    if (!h) return;
    this.dismiss(`${hostId}:${remote}`);
    this.seen.add(`${hostId}:${remote}`);
    // Con StrictHostKeyChecking=yes la huella tiene que estar aceptada: el mismo paso que al abrir un panel.
    if (!(await app.ensureHostKey(h))) return;
    if (o.save) this.setSaved(hostId, remote, true, o.local);
    this.paused.delete(tunnelId(fwdDest(h), remote));
    const snap = await this.start(h, remote, o.local, !o.save);
    if (!snap) return;
    if (o.open) await this.openWhenUp(snap.id);
  }

  /** Espera a que el túnel esté arriba y abre `http://localhost:<local>/`. */
  async openWhenUp(id: string): Promise<void> {
    const end = Date.now() + OPEN_WAIT_MS;
    while (Date.now() < end) {
      const s = this.tunnels.find((x) => x.id === id);
      if (!s) return;
      if (s.state === 'up') { be.openUrl(localUrl(s.localPort)); return; }
      if (s.state === 'error') { app.toast(t('ports.toast.failed', { port: s.remotePort, error: s.error ?? '' })); return; }
      await new Promise((r) => setTimeout(r, 250));
      await this.refresh();
    }
    app.toast(t('ports.toast.slow'));
  }

  open(s: TunnelSnap): void { if (s.state === 'up') be.openUrl(localUrl(s.localPort)); else void this.openWhenUp(s.id); }

  async copy(s: TunnelSnap): Promise<void> {
    try { await be.copyText(localUrl(s.localPort)); app.toast(t('ports.toast.copied', { url: localUrl(s.localPort) })); }
    catch (e) { app.toast(t('terminals.copy.failed', { error: String(e) })); }
  }

  stop(id: string): void {
    const m = this.meta[id];
    if (m && this.liveHosts.has(m.hostId) && this.isSaved(this.tunnels.find((x) => x.id === id) ?? { id, remotePort: -1 })) this.paused.add(id);
    fb.pfwdStop(id);
    this.tunnels = this.tunnels.filter((x) => x.id !== id);
    const { [id]: _gone, ...rest } = this.meta;
    this.meta = rest;
  }

  /** Guarda (o quita) el reenvío en el host: arranca solo cada vez que se conecta. */
  setSaved(hostId: string, remote: number, on: boolean, local?: number): void {
    const h = this.host(hostId);
    if (!h) return;
    const cur = (h.forwards ?? []).filter((f) => f.remote !== remote);
    const next = on ? [...cur, local && local !== remote ? { remote, local } : { remote }] : cur;
    const nh: Host = { ...$state.snapshot(h) as Host, forwards: next.length ? next : undefined };
    if (!nh.forwards) delete nh.forwards;
    app.saveHost(nh);
  }

  toggleSaved(s: TunnelSnap): void {
    const m = this.meta[s.id];
    if (m) this.setSaved(m.hostId, s.remotePort, !this.isSaved(s), s.localPort !== s.remotePort ? s.localPort : undefined);
  }

  openDialog(hostId: string, remote?: number): void { this.dialog = { hostId, ...(remote ? { remote } : {}) }; }

  // ---------- consulta a Rust ----------

  async refresh(): Promise<void> {
    try {
      const list = await fb.pfwdList();
      // Solo los que conoce este frontend (los demás no deberían existir).
      this.tunnels = list.filter((x) => this.meta[x.id]);
    } catch { /* se reintenta en el siguiente tic */ }
    if (!this.tunnels.length) this.stopPolling();
  }

  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = window.setInterval(() => void this.refresh(), 1000);
  }
  private stopPolling(): void { clearInterval(this.pollTimer); this.pollTimer = 0; }
}

export const forwards = new Forwards();
