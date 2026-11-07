// Puente con Rust del explorador SFTP (sftp.rs) y, sin Tauri (demo en el navegador), un sistema de archivos remoto FALSO
// con unas carpetas y archivos y transferencias simuladas con progreso.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { inTauri } from './backend.ts';
import type { Entry, Listing, ProgressMsg, SftpDest } from './sftp.ts';
import { joinPath, parentPath, baseName } from './sftp.ts';

export interface StatInfo { exists: boolean; isDir: boolean; size: number }

// ---------- demo ----------

type DNode = { dir: true; mtime: number; perm: number } | { dir: false; size: number; mtime: number; perm: number };
const T0 = 1_762_500_000;
const demoFs = new Map<string, DNode>();
function dd(p: string, perm = 0o040755, mtime = T0) { demoFs.set(p, { dir: true, perm, mtime }); }
function df(p: string, size: number, mtime = T0, perm = 0o100644) { demoFs.set(p, { dir: false, size, mtime, perm }); }
dd('/'); dd('/home'); dd('/home/deploy'); dd('/srv'); dd('/srv/app'); dd('/var'); dd('/var/log'); dd('/etc');
dd('/home/deploy/app', 0o040775, T0 - 3600); dd('/home/deploy/backups', 0o040700, T0 - 86400 * 3); dd('/home/deploy/.ssh', 0o040700, T0 - 86400 * 40);
dd('/home/deploy/fotos del viaje', 0o040755, T0 - 86400 * 9); dd('/home/deploy/app/src'); dd('/home/deploy/app/dist', 0o040755, T0 - 600);
df('/home/deploy/.bashrc', 3771, T0 - 86400 * 200); df('/home/deploy/.profile', 807, T0 - 86400 * 200);
df('/home/deploy/.ssh/authorized_keys', 412, T0 - 86400 * 40, 0o100600);
df('/home/deploy/deploy.sh', 2_310, T0 - 7200, 0o100755); df('/home/deploy/notas año 2026.md', 14_220, T0 - 900);
df('/home/deploy/dump-2026-11-06.sql.gz', 187_400_000, T0 - 86400); df('/home/deploy/README.md', 5_120, T0 - 86400 * 2);
df('/home/deploy/docker-compose.yml', 1_904, T0 - 86400 * 5); df("/home/deploy/it's quoted.txt", 64, T0 - 86400 * 6);
df('/home/deploy/backups/db-2026-11-01.tar.zst', 2_431_000_000, T0 - 86400 * 6); df('/home/deploy/backups/db-2026-11-04.tar.zst', 2_498_000_000, T0 - 86400 * 3);
df('/home/deploy/app/package.json', 1_288, T0 - 3600); df('/home/deploy/app/server.js', 9_871, T0 - 3600);
df('/home/deploy/app/dist/bundle.js', 812_334, T0 - 600); df('/home/deploy/app/src/index.ts', 3_004, T0 - 4000);
df('/home/deploy/fotos del viaje/playa.jpg', 4_200_000, T0 - 86400 * 9); df('/home/deploy/fotos del viaje/montaña.jpg', 5_800_000, T0 - 86400 * 9);
df('/var/log/syslog', 48_000_000, T0 - 30); df('/var/log/auth.log', 1_200_000, T0 - 60, 0o100640);
df('/srv/app/.env', 512, T0 - 86400, 0o100600); df('/etc/hostname', 12, T0 - 86400 * 300); df('/etc/os-release', 386, T0 - 86400 * 300);
const DEMO_HOME = '/home/deploy';

function demoList(path: string): Listing {
  let p = path.trim() || DEMO_HOME;
  if (p === '~') p = DEMO_HOME;
  else if (p.startsWith('~/')) p = joinPath(DEMO_HOME, p.slice(2));
  p = p.length > 1 ? p.replace(/\/+$/, '') : p;
  const n = demoFs.get(p);
  if (!n) throw new Error(`E_NOFILE: ${p}`);
  if (!n.dir) throw new Error(`E_NOFILE: ${p} is not a folder`);
  const entries: Entry[] = [];
  for (const [k, v] of demoFs) {
    if (k === p || k === '/' || parentPath(k) !== p) continue;
    entries.push({ name: baseName(k), size: v.dir ? 4096 : v.size, mtime: v.mtime, perm: v.dir ? v.perm : v.perm, isDir: v.dir, isLink: false });
  }
  return { path: p, home: DEMO_HOME, entries };
}

const demoProgress = new Set<(m: ProgressMsg) => void>();
const demoTimers = new Map<string, number>();
const emitDemo = (m: ProgressMsg) => { for (const cb of demoProgress) cb(m); };

/** Transferencia simulada: ~4 s por archivo pequeño, más larga en los grandes; los nombres con «fail» fallan a mitad. */
function demoXfer(id: string, total: number, onDone: () => string | null, fail = false) {
  let done = 0;
  const step = Math.max(1, Math.round(total / (total > 50e6 ? 120 : 30)));
  emitDemo({ id, done, total, state: 'run' });
  const tm = window.setInterval(() => {
    done = Math.min(total, done + step);
    if (fail && done > total / 2) {
      clearInterval(tm); demoTimers.delete(id);
      emitDemo({ id, done, total, state: 'error', error: 'E_DENIED: Permission denied' });
      return;
    }
    if (done >= total) {
      clearInterval(tm); demoTimers.delete(id);
      emitDemo({ id, done, total, state: 'done', path: onDone() });
      return;
    }
    emitDemo({ id, done, total, state: 'run' });
  }, 150);
  demoTimers.set(id, tm);
}

// ---------- API ----------

export async function sftpList(dest: SftpDest, path: string): Promise<Listing> {
  if (!inTauri) { await new Promise((r) => setTimeout(r, 120)); return demoList(path); }
  return invoke<Listing>('sftp_list', { dest, path });
}

export async function sftpStat(dest: SftpDest, path: string): Promise<StatInfo> {
  if (!inTauri) { const n = demoFs.get(path); return { exists: !!n, isDir: !!n?.dir, size: n && !n.dir ? n.size : 0 }; }
  return invoke<StatInfo>('sftp_stat', { dest, path });
}

export async function sftpMkdir(dest: SftpDest, dir: string, name: string): Promise<string> {
  if (!inTauri) { const p = joinPath(dir, name); if (demoFs.has(p)) throw new Error(`E_EXISTS: ${p}`); dd(p, 0o040755, Math.floor(Date.now() / 1000)); return p; }
  return invoke<string>('sftp_mkdir', { dest, dir, name });
}

export async function sftpRename(dest: SftpDest, dir: string, from: string, to: string): Promise<void> {
  if (!inTauri) {
    const a = joinPath(dir, from), b = joinPath(dir, to);
    if (demoFs.has(b)) throw new Error(`E_EXISTS: ${b}`);
    for (const [k, v] of [...demoFs]) if (k === a || k.startsWith(`${a}/`)) { demoFs.delete(k); demoFs.set(b + k.slice(a.length), v); }
    return;
  }
  await invoke('sftp_rename', { dest, dir, from, to });
}

export async function sftpRemove(dest: SftpDest, dir: string, names: string[]): Promise<void> {
  if (!inTauri) {
    for (const n of names) { const a = joinPath(dir, n); for (const k of [...demoFs.keys()]) if (k === a || k.startsWith(`${a}/`)) demoFs.delete(k); }
    return;
  }
  await invoke('sftp_remove', { dest, dir, names });
}

export async function sftpUpload(id: string, dest: SftpDest, local: string, dir: string, name: string, overwrite: boolean): Promise<void> {
  if (!inTauri) {
    const size = /big|grande/i.test(name) ? 52_428_800 : 3_500_000 + (name.length * 977_131) % 9_000_000;
    demoXfer(id, size, () => { df(joinPath(dir, name), size, Math.floor(Date.now() / 1000)); return null; }, /fail/i.test(name));
    return;
  }
  await invoke('sftp_upload', { id, dest, local, dir, name, overwrite });
}

export async function sftpDownload(id: string, dest: SftpDest, remote: string, localDir: string | null): Promise<void> {
  if (!inTauri) {
    const n = demoFs.get(remote);
    const size = n && !n.dir ? n.size : 0;
    demoXfer(id, size || 1, () => `C:\\Users\\demo\\Downloads\\${baseName(remote)}`);
    return;
  }
  await invoke('sftp_download', { id, dest, remote, localDir });
}

export function sftpCancel(id: string): void {
  if (!inTauri) {
    const tm = demoTimers.get(id);
    if (tm) { clearInterval(tm); demoTimers.delete(id); emitDemo({ id, done: 0, total: 0, state: 'cancelled' }); }
    return;
  }
  void invoke('sftp_cancel', { id });
}

export async function sftpPick(folder: boolean): Promise<string[]> {
  if (!inTauri) return folder ? ['C:\\Users\\demo\\Descargas'] : ['C:\\Users\\demo\\Documents\\informe final.pdf', 'C:\\Users\\demo\\Documents\\README.md'];
  return invoke<string[]>('sftp_pick', { folder });
}

export async function sftpReveal(path: string): Promise<void> {
  if (inTauri) await invoke('sftp_reveal', { path });
}

export async function sftpDownloadsDir(): Promise<string> {
  return inTauri ? invoke<string>('sftp_downloads_dir') : 'C:\\Users\\demo\\Downloads';
}

export async function onSftpProgress(cb: (m: ProgressMsg) => void): Promise<UnlistenFn> {
  if (!inTauri) { demoProgress.add(cb); return () => demoProgress.delete(cb); }
  return listen<ProgressMsg>('sftp-progress', (e) => cb(e.payload));
}
