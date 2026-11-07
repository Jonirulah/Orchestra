// Estado de la actualización automática y llamadas al backend (src-tauri/src/updater.rs).
// La lógica pura (cuándo comprobar, versiones, errores) está en updatecheck.ts.
import { invoke, Channel } from '@tauri-apps/api/core';
import { inTauri, openUrl } from './backend.ts';
import { app } from './store.svelte.ts';
import { APP_VERSION } from './settings.ts';
import {
  FIRST_CHECK_DELAY_MS, TICK_MS, busyReport, classifyError, errorDetail, progressPct, releasePage, shouldCheck,
  type BusyReport, type UpdateErrorKind,
} from './updatecheck.ts';

export interface UpdateInfo { version: string; current: string; notes: string; date?: string | null }
interface UpdateEnv { current: string; portable: boolean }
type Progress =
  | { event: 'started'; data: { total: number | null } }
  | { event: 'chunk'; data: { got: number } }
  | { event: 'verified' };

export type UpdateStatus = 'idle' | 'checking' | 'latest' | 'available' | 'error' | 'downloading' | 'installing';

// Modo demo (navegador sin Tauri): `?update=0.3.1` simula una versión nueva y `&portable=1` el exe suelto.
const demoParams = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();

class Updater {
  status = $state<UpdateStatus>('idle');
  info = $state<UpdateInfo | null>(null);
  current = $state(APP_VERSION);
  portable = $state(false);
  /** Comprobación pedida a mano desde Ajustes: enseña el resultado aunque sea «ya es la última». */
  manual = $state(false);
  errorKind = $state<UpdateErrorKind | null>(null);
  errorText = $state('');
  got = $state(0);
  total = $state<number | null>(null);
  /** El usuario cerró el aviso de esta versión (vuelve a salir con la siguiente o al reiniciar). */
  dismissed = $state('');
  dialogOpen = $state(false);
  lastCheckAt = $state(0);
  private started = false;

  get pct(): number | null { return progressPct(this.got, this.total); }
  /** ¿Se enseña el aviso de la barra superior? */
  get showChip(): boolean {
    return !!this.info && this.dismissed !== this.info.version && this.status !== 'checking' && this.status !== 'latest';
  }
  /** Lo que se cerrará al instalar. */
  busy(): BusyReport {
    const sshOpen = app.workspaces.reduce((n, w) => n + w.panes.filter((p) => p.kind === 'ssh' && app.live[p.id]?.state === 'running').length, 0);
    return busyReport({ agentStatuses: app.agents.map((a) => a.status), sshOpen });
  }

  /** Arranca la comprobación periódica (una vez). La primera va con retraso para no frenar el arranque. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.loadEnv();
    window.setTimeout(() => {
      void this.tick();
      window.setInterval(() => void this.tick(), TICK_MS);
    }, FIRST_CHECK_DELAY_MS);
  }

  private async loadEnv(): Promise<void> {
    if (!inTauri) { this.portable = demoParams.get('portable') === '1'; return; }
    try {
      const env = await invoke<UpdateEnv>('update_env');
      this.current = env.current;
      this.portable = env.portable;
    } catch { /* sin backend: se queda lo de APP_VERSION */ }
  }

  private async tick(): Promise<void> {
    if (this.status === 'checking' || this.status === 'downloading' || this.status === 'installing') return;
    if (!shouldCheck(app.settings.autoUpdate, this.lastCheckAt, Date.now())) return;
    await this.check(false);
  }

  /** Busca versión nueva. `manual` = botón «Buscar ahora». */
  async check(manual: boolean): Promise<void> {
    if (this.status === 'downloading' || this.status === 'installing') return;
    this.manual = manual;
    this.status = 'checking';
    this.errorKind = null;
    this.errorText = '';
    this.lastCheckAt = Date.now();
    try {
      const info = inTauri ? await invoke<UpdateInfo | null>('update_check') : demoInfo();
      this.info = info;
      this.status = info ? 'available' : 'latest';
    } catch (e) {
      this.fail(String(e));
      // Un fallo de red en la comprobación automática no merece aviso: se reintenta en 6 h.
      if (!manual) this.info = null;
    }
  }

  openDialog(): void { this.dialogOpen = true; }
  closeDialog(): void {
    if (this.status === 'downloading' || this.status === 'installing') return;
    this.dialogOpen = false;
    if (this.status === 'error' && this.info) this.status = 'available';
  }
  dismiss(): void { if (this.info) this.dismissed = this.info.version; this.dialogOpen = false; }

  /** Portable: abre la página de la release para descargarla a mano. */
  download(): void { if (this.info) openUrl(releasePage(this.info.version)); }

  /** Descarga, verifica la firma e instala. En Windows el instalador cierra y reabre Orchestra. */
  async install(): Promise<void> {
    if (!this.info || this.portable) return;
    this.status = 'downloading';
    this.got = 0;
    this.total = null;
    this.errorKind = null;
    // Guarda ya el estado: al volver se restauran los paneles y las sesiones de Claude.
    app.persistNow();
    try {
      if (!inTauri) { await demoInstall(this); return; }
      const ch = new Channel<Progress>();
      ch.onmessage = (m) => {
        if (m.event === 'started') this.total = m.data.total;
        else if (m.event === 'chunk') this.got = m.data.got;
        else if (m.event === 'verified') this.status = 'installing';
      };
      await invoke('update_install', { onEvent: ch });
    } catch (e) {
      this.fail(String(e));
      // La actualización pendiente se consumió: se vuelve a pedir para poder reintentar.
      if (this.errorKind !== 'signature') void this.recheckSilently();
    }
  }

  private async recheckSilently(): Promise<void> {
    try { if (inTauri) await invoke('update_check'); } catch { /* el error ya está a la vista */ }
  }

  private fail(msg: string): void {
    this.status = 'error';
    this.errorKind = classifyError(msg);
    this.errorText = errorDetail(msg);
  }
}

function demoInfo(): UpdateInfo | null {
  const v = demoParams.get('update');
  if (!v) return null;
  return {
    version: v, current: APP_VERSION, date: '2026-11-07T12:00:00Z',
    notes: '### Added\n- Automatic updates from GitHub releases, with signature check.\n- Settings → General: check for updates now.\n\n### Fixed\n- Pasting images into Claude panes.',
  };
}

async function demoInstall(u: Updater): Promise<void> {
  u.total = 6_000_000;
  const stop = demoParams.get('stop'); // `&stop=40` deja la barra al 40 % (capturas)
  for (let i = 1; i <= 20; i++) {
    await new Promise((r) => setTimeout(r, 120));
    u.got = (u.total * i) / 20;
    if (stop && (u.pct ?? 0) >= Number(stop)) return;
  }
  u.status = 'installing';
}

export const updater = new Updater();
