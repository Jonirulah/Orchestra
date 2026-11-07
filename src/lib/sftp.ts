// Explorador de archivos por SFTP: lógica pura (rutas remotas, orden, filtro, formatos, choques de nombres y cola de
// transferencias). Sin Svelte ni Tauri: se prueba con node --test (sftp.test.ts). El protocolo vive en Rust (sftp.rs).
import { activeSecretKey } from './model.ts';
import type { Host } from './model.ts';

/** Lo que recibe Rust como `Dest` (mismos campos que las métricas del servidor). Solo el NOMBRE del secreto. */
export interface SftpDest {
  user?: string; host: string; port: number; identity?: string; identitiesOnly: boolean; jump?: string; secretKey?: string;
}

export function sftpDest(h: Host): SftpDest {
  const jump = h.proxyJump?.trim();
  const sk = activeSecretKey(h);
  return {
    host: h.host, port: h.port ?? 22,
    ...(h.user ? { user: h.user } : {}),
    ...(h.identityFile ? { identity: h.identityFile } : {}),
    identitiesOnly: h.authMethod === 'key' && !!h.identityFile,
    ...(jump ? { jump } : {}),
    ...(sk ? { secretKey: sk } : {}),
  };
}

export interface Entry { name: string; size: number; mtime: number; perm: number; isDir: boolean; isLink: boolean }
export interface Listing { path: string; home: string; entries: Entry[] }

// ---------- rutas remotas (POSIX) ----------

export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

/** Carpeta de arriba: `/a/b` → `/a`, `/a` → `/`, `/` → `/`. */
export function parentPath(p: string): string {
  const s = p.replace(/\/+$/, '');
  if (!s) return '/';
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  return i === 0 ? '/' : s.slice(0, i);
}

export function baseName(p: string): string {
  const s = p.replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1) || '/';
}

/** Migas de pan: `/home/u` → [/, home, u] con la ruta de cada una. */
export function crumbs(p: string): { label: string; path: string }[] {
  const out = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of p.split('/').filter(Boolean)) {
    acc += `/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

/** Cita una ruta para pegarla en una shell POSIX: tal cual si es segura; si no, entre comillas simples. */
export function shellQuote(p: string): string {
  if (p && /^[A-Za-z0-9_./~@%+=:,-]+$/.test(p) && !p.startsWith('-')) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Nombre válido para crear en el servidor (igual que `valid_name` de Rust). */
export function validName(n: string): boolean {
  return n.length > 0 && new TextEncoder().encode(n).length <= 255 && n !== '.' && n !== '..' && !n.includes('/') && !n.includes('\0');
}

/** Nombre libre: `a.txt` → `a (1).txt`, `a (2).txt`… (`.bashrc` → `.bashrc (1)`). */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const i = name.lastIndexOf('.');
  const [stem, ext] = i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
  for (let k = 1; k < 10000; k++) {
    const c = `${stem} (${k})${ext}`;
    if (!taken.has(c)) return c;
  }
  return `${stem} (${Date.now()})${ext}`;
}

/** Último trozo de una ruta LOCAL de Windows o POSIX. */
export function localBase(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  return s.slice(Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')) + 1);
}

// ---------- lista ----------

export type SortKey = 'name' | 'size' | 'mtime';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Carpetas primero (los enlaces a carpeta cuentan como carpeta); luego por la clave elegida. */
export function sortEntries(list: readonly Entry[], key: SortKey = 'name', desc = false): Entry[] {
  const k = desc ? -1 : 1;
  return [...list].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let c = 0;
    if (key === 'size') c = a.size - b.size;
    else if (key === 'mtime') c = a.mtime - b.mtime;
    if (c === 0) c = collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return c * k;
  });
}

export function filterEntries(list: readonly Entry[], query: string, showHidden: boolean): Entry[] {
  const q = query.trim().toLocaleLowerCase();
  return list.filter((e) => (showHidden || !e.name.startsWith('.')) && (!q || e.name.toLocaleLowerCase().includes(q)));
}

export function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${u[i]}`;
}

/** `st_mode` → `drwxr-xr-x` (l para enlaces). */
export function fmtPerm(mode: number): string {
  const type = (mode & 0o170000) === 0o040000 ? 'd' : (mode & 0o170000) === 0o120000 ? 'l' : '-';
  const r = (b: number, ch: string) => (mode & b ? ch : '-');
  let s = type;
  for (const sh of [6, 3, 0]) s += r(4 << sh, 'r') + r(2 << sh, 'w') + r(1 << sh, 'x');
  if (mode & 0o4000) s = s.slice(0, 3) + (s[3] === 'x' ? 's' : 'S') + s.slice(4);
  if (mode & 0o2000) s = s.slice(0, 6) + (s[6] === 'x' ? 's' : 'S') + s.slice(7);
  if (mode & 0o1000) s = s.slice(0, 9) + (s[9] === 'x' ? 't' : 'T');
  return s;
}

/** Fecha corta estable: `2026-11-07 14:05` (hora local). Este año sin año no: se ve siempre igual. */
export function fmtDate(secs: number): string {
  if (!secs) return '';
  const d = new Date(secs * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Error de Rust (con prefijo estable) → clave de traducción + detalle. */
export function errorKey(err: string): { key: 'files.err.nofile' | 'files.err.denied' | 'files.err.hostkey' | 'files.err.auth' | 'files.err.net' | 'files.err.exists' | 'files.err.cancel' | 'files.err.other'; detail: string } {
  const e = String(err).replace(/^Error: /, '');
  const m = /^(E_[A-Z]+)(?::\s*(.*))?$/s.exec(e);
  const map = { E_NOFILE: 'files.err.nofile', E_DENIED: 'files.err.denied', E_HOSTKEY: 'files.err.hostkey', E_AUTH: 'files.err.auth', E_NET: 'files.err.net', E_EXISTS: 'files.err.exists', E_CANCEL: 'files.err.cancel' } as const;
  if (m && m[1] in map) return { key: map[m[1] as keyof typeof map], detail: m[2] ?? '' };
  return { key: 'files.err.other', detail: e };
}

// ---------- choques al subir ----------

export type Clash = 'overwrite' | 'skip' | 'rename';

/** Qué nombre usar para cada archivo que se sube según la decisión. `null` = saltar. */
export function resolveClash(name: string, exists: boolean, choice: Clash | null, taken: ReadonlySet<string>): { name: string; overwrite: boolean } | null {
  if (!exists) return { name, overwrite: false };
  if (choice === 'overwrite') return { name, overwrite: true };
  if (choice === 'rename') return { name: uniqueName(name, taken), overwrite: false };
  return null;
}

// ---------- cola de transferencias ----------

export type XState = 'queued' | 'run' | 'done' | 'error' | 'cancelled';

export interface Transfer {
  id: string;
  dir: 'up' | 'down';
  hostId: string;
  hostName: string;
  name: string;
  /** Subida: ruta local + carpeta remota. Bajada: ruta remota (+ carpeta local opcional). */
  local?: string;
  remoteDir?: string;
  remote?: string;
  overwrite?: boolean;
  state: XState;
  done: number;
  total: number;
  /** Bytes/s (media suave). */
  speed: number;
  error?: string;
  /** Bajada terminada: ruta local. */
  path?: string;
  at: number;
  lastAt: number;
  lastDone: number;
}

export interface ProgressMsg { id: string; done: number; total: number; state: 'run' | 'done' | 'error' | 'cancelled'; error?: string | null; path?: string | null }

let seq = 0;
export function newId(now = Date.now()): string {
  seq = (seq + 1) % 1e6;
  return `x${now.toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export const MAX_RUNNING = 3;
export const MAX_KEPT = 50;

/** Estado de la cola (puro: se muta en sitio y el llamador lo hace reactivo). */
export class Queue {
  items: Transfer[] = [];

  add(t: Omit<Transfer, 'state' | 'done' | 'total' | 'speed' | 'at' | 'lastAt' | 'lastDone'>, now = Date.now()): Transfer {
    const x: Transfer = { ...t, state: 'queued', done: 0, total: 0, speed: 0, at: now, lastAt: now, lastDone: 0 };
    this.items.push(x);
    this.trim();
    return x;
  }

  get(id: string): Transfer | undefined { return this.items.find((x) => x.id === id); }

  /** Las que hay que lanzar ya (respetando `MAX_RUNNING`); las marca como `run`. */
  startable(now = Date.now()): Transfer[] {
    let running = this.items.filter((x) => x.state === 'run').length;
    const out: Transfer[] = [];
    for (const x of this.items) {
      if (running >= MAX_RUNNING) break;
      if (x.state !== 'queued') continue;
      x.state = 'run'; x.at = now; x.lastAt = now; x.lastDone = 0; x.done = 0; x.speed = 0;
      out.push(x); running++;
    }
    return out;
  }

  progress(m: ProgressMsg, now = Date.now()): Transfer | undefined {
    const x = this.get(m.id);
    if (!x || x.state === 'cancelled' && m.state === 'run') return x;
    if (x.state === 'done' || x.state === 'error') return x; // ya acabada: avisos tardíos fuera
    x.total = m.total;
    const dt = (now - x.lastAt) / 1000;
    if (dt >= 0.25 && m.done >= x.lastDone) {
      const inst = (m.done - x.lastDone) / dt;
      x.speed = x.speed ? x.speed * 0.6 + inst * 0.4 : inst;
      x.lastAt = now; x.lastDone = m.done;
    }
    x.done = m.done;
    if (m.state !== 'run') {
      x.state = m.state;
      if (m.state === 'done') { x.done = Math.max(x.done, x.total); x.path = m.path ?? undefined; const s = (now - x.at) / 1000; if (s > 0) x.speed = x.done / s; }
      if (m.state === 'error') x.error = m.error ?? 'error';
    }
    return x;
  }

  /** Marca como cancelada (si estaba en cola, no llega a lanzarse). Devuelve si había que avisar a Rust. */
  cancel(id: string): boolean {
    const x = this.get(id);
    if (!x) return false;
    if (x.state === 'queued') { x.state = 'cancelled'; return false; }
    if (x.state === 'run') { x.state = 'cancelled'; return true; }
    return false;
  }

  /** Vuelve a poner en cola una fallida o cancelada (id nuevo: Rust no confunde avisos viejos). */
  retry(id: string, now = Date.now()): Transfer | undefined {
    const x = this.get(id);
    if (!x || (x.state !== 'error' && x.state !== 'cancelled')) return undefined;
    x.id = newId(now); x.state = 'queued'; x.error = undefined; x.done = 0; x.total = 0; x.speed = 0;
    return x;
  }

  clearFinished(): void { this.items = this.items.filter((x) => x.state === 'queued' || x.state === 'run'); }

  /** Resumen para la cabecera de la cola. */
  summary(): { active: number; done: number; total: number; pct: number } {
    const act = this.items.filter((x) => x.state === 'run' || x.state === 'queued');
    const done = act.reduce((s, x) => s + x.done, 0), total = act.reduce((s, x) => s + x.total, 0);
    return { active: act.length, done, total, pct: total ? Math.min(100, Math.floor((done / total) * 100)) : 0 };
  }

  private trim(): void {
    while (this.items.length > MAX_KEPT) {
      const i = this.items.findIndex((x) => x.state !== 'queued' && x.state !== 'run');
      if (i < 0) break;
      this.items.splice(i, 1);
    }
  }
}

export function pct(x: Pick<Transfer, 'done' | 'total' | 'state'>): number {
  if (x.state === 'done') return 100;
  return x.total ? Math.min(100, Math.floor((x.done / x.total) * 100)) : 0;
}
