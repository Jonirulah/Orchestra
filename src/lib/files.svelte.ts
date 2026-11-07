// Estado vivo del explorador SFTP: qué host está abierto en el cajón, la cola de transferencias (sigue aunque se cierre el
// cajón) y el aviso de «descargado». La lógica pura está en sftp.ts; aquí solo se cablea con Rust y la interfaz.
import { app } from './store.svelte.ts';
import * as be from './backend.ts';
import * as sb from './sftpbackend.ts';
import { Queue, newId, sftpDest, errorKey, joinPath } from './sftp.ts';
import type { ProgressMsg, Transfer } from './sftp.ts';
import type { Host } from './model.ts';
import { t } from './i18n.ts';

/** Id de «panel» con el que el cajón pide a Rust las rutas de lo que se suelta (clipimg.rs `orchestra-drop:<id>`). */
export const DROP_ID = 'sftp-drawer';

export interface FilesView { hostId: string; paneId?: string; start?: string; nonce: number }

class Files {
  view = $state<FilesView | null>(null);
  items = $state<Transfer[]>([]);
  notice = $state<{ text: string; path?: string; bad?: boolean; at: number } | null>(null);
  /** Sube en 1 cuando acaba una subida u operación que cambia una carpeta remota: el cajón recarga si es la suya. */
  changed = $state<{ hostId: string; dir: string; n: number }>({ hostId: '', dir: '', n: 0 });
  /** El cajón pone aquí qué hacer con lo soltado. */
  onDrop: ((paths: string[]) => void) | null = null;

  private q = new Queue();
  private wired = false;
  private noticeTimer = 0;

  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    void sb.onSftpProgress((m) => this.progress(m));
    void be.onFileDrop((pane, paths) => { if (pane === DROP_ID) this.onDrop?.(paths); });
  }

  private sync(): void { this.items = this.q.items.map((x) => ({ ...x })); }

  host(id: string): Host | undefined { return app.hosts.find((h) => h.id === id); }

  /** Abre el cajón con el explorador del host. Antes pasa por la huella como al abrir un panel. */
  async open(hostId: string, paneId?: string): Promise<void> {
    this.wire();
    const h = this.host(hostId);
    if (!h) return;
    if (!(await app.ensureHostKey(h))) return;
    const cwd = paneId ? app.live[paneId]?.cwd : undefined;
    const start = cwd && (cwd.startsWith('/') || cwd.startsWith('~')) ? cwd : undefined;
    this.view = { hostId, paneId, start, nonce: Date.now() };
  }

  close(): void { this.view = null; }

  upload(h: Host, local: string, dir: string, name: string, overwrite: boolean): void {
    this.wire();
    this.q.add({ id: newId(), dir: 'up', hostId: h.id, hostName: h.name, name, local, remoteDir: dir, overwrite });
    this.pump();
  }

  async download(h: Host, remote: string, name: string): Promise<void> {
    this.wire();
    let dir: string | undefined = app.settings.sftpDownloadDir || undefined;
    if (app.settings.sftpAskDownload) {
      const p = await sb.sftpPick(true);
      if (!p[0]) return;
      dir = p[0];
    }
    this.q.add({ id: newId(), dir: 'down', hostId: h.id, hostName: h.name, name, remote, local: dir });
    this.pump();
  }

  cancel(id: string): void {
    if (this.q.cancel(id)) sb.sftpCancel(id);
    this.sync();
    this.pump();
  }

  retry(id: string): void {
    this.q.retry(id);
    this.pump();
  }

  clearFinished(): void { this.q.clearFinished(); this.sync(); }

  bump(hostId: string, dir: string): void { this.changed = { hostId, dir, n: this.changed.n + 1 }; }

  private pump(): void {
    for (const x of this.q.startable()) {
      const h = this.host(x.hostId);
      const fail = (e: unknown) => this.progress({ id: x.id, done: 0, total: 0, state: 'error', error: String(e) });
      if (!h) { fail('host removed'); continue; }
      const d = sftpDest(h);
      if (x.dir === 'up') sb.sftpUpload(x.id, d, x.local ?? '', x.remoteDir ?? '', x.name, !!x.overwrite).catch(fail);
      else sb.sftpDownload(x.id, d, x.remote ?? '', x.local ?? null).catch(fail);
    }
    this.sync();
  }

  private progress(m: ProgressMsg): void {
    const before = this.q.get(m.id)?.state;
    const x = this.q.progress(m);
    if (!x) return;
    if (before !== x.state && x.state === 'done') {
      if (x.dir === 'down') this.say(t('files.downloaded', { name: x.name }), x.path);
      else if (x.remoteDir) this.bump(x.hostId, x.remoteDir);
    }
    if (before !== x.state && x.state === 'error' && !this.view) {
      const e = errorKey(x.error ?? '');
      this.say(t('files.xferFailed', { name: x.name, error: t(e.key, { detail: e.detail }) }), undefined, true);
    }
    if (x.state !== 'run') this.pump();
    else this.sync();
  }

  say(text: string, path?: string, bad = false): void {
    clearTimeout(this.noticeTimer);
    this.notice = { text, path, bad, at: Date.now() };
    this.noticeTimer = window.setTimeout(() => { this.notice = null; }, path ? 10000 : 6000);
  }

  /** Ruta remota en el portapapeles. */
  async copyPath(p: string): Promise<void> {
    try { await navigator.clipboard.writeText(p); this.say(t('files.copied')); } catch { /* sin permiso: nada */ }
  }

  /** Escribe la ruta (citada) en el panel SSH, sin Intro. */
  pasteToPane(paneId: string, text: string): void {
    be.ptyWrite(paneId, text);
    app.focus(paneId);
  }

  join = joinPath;
}

export const files = new Files();
