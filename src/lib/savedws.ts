// Espacios de trabajo guardados: copias con nombre de una pestaña para volver a abrirla. Módulo puro (sin Svelte ni Tauri): se prueba con `node --test`.
//
// Qué se guarda: la rejilla (columnas, filas y sus tamaños) y, por panel, su sitio, tipo, título, icono, carpeta, orden y la referencia
// al host o a la cuenta. Qué NO: ids de panel (son los de los PTY vivos), la salida del terminal, la sesión de Claude que alojaba
// (`lastSession`) ni nada con pinta de secreto en el entorno. Al abrirlo se crea una pestaña con ids nuevos; los paneles de Claude
// arrancan una conversación NUEVA (ver `freshAgentSpec`): retomar la misma sesión en dos pestañas a la vez las haría pelear.
import { restorableSpec, stripResume, uid } from './model.ts';
import type { Pane, PaneKind, PaneSpec, Workspace } from './model.ts';
import { cleanOverride } from './statusbar.ts';
import type { ItemId } from './statusbar.ts';

/** Panel guardado: lo de `Pane` menos el id vivo y la sesión de Claude. */
export type SavedPane = Omit<Pane, 'id' | 'lastSession'>;

export interface SavedWorkspace {
  /** Id propio del guardado (`sw-…`), no el de ninguna pestaña. */
  id: string;
  name: string;
  /** Milisegundos desde 1970 de la última vez que se guardó o sobrescribió. */
  savedAt: number;
  cols: number[];
  rows: number[];
  panes: SavedPane[];
  statusBarItems?: ItemId[];
}

export const SAVED_LIMITS = { count: 100, name: 60, panes: 64, tracks: 8 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Nombre limpio de una línea; '' si no queda nada. */
export function cleanName(v: unknown): string {
  return typeof v === 'string' ? v.replace(CTRL, '').trim().slice(0, SAVED_LIMITS.name) : '';
}

/** Comparación de nombres sin mayúsculas ni espacios de más (para el choque de nombres). */
const nameKey = (s: string): string => cleanName(s).toLocaleLowerCase();

/** Entorno que no se guarda: el nombre de la entrada de la bóveda (se regenera desde el host) y cualquier clave con pinta de secreto. */
const SECRETISH = /pass(word|phrase)?|secret|token|credential|api_?key|auth/i;
const ASKPASS_ENV = 'ORCHESTRA_ASKPASS_KEY';

/** Orden de un agente sin retomar nada: fuera `--resume <id>` y `--continue`. */
export function freshAgentSpec(spec: PaneSpec): PaneSpec {
  const s = stripResume(spec);
  const args = s.args ?? [];
  const last = args[args.length - 1] ?? '';
  const next = last.replace(/ --continue(?= |$)/, '');
  return next === last ? s : { ...s, args: [...args.slice(0, -1), next] };
}

function savedSpec(kind: PaneKind, spec: PaneSpec, cwd: string | undefined): PaneSpec {
  let s = restorableSpec(spec);
  if (kind === 'agent') s = freshAgentSpec(s);
  const out: PaneSpec = { program: s.program, args: [...(s.args ?? [])] };
  const dir = cwd || s.cwd;
  if (dir) out.cwd = dir;
  if (s.env && kind !== 'ssh') { // SSH: el entorno es solo el de la bóveda, se rehace desde el host al abrir
    const env = Object.fromEntries(Object.entries(s.env).filter(([k]) => k !== ASKPASS_ENV && !SECRETISH.test(k)));
    if (Object.keys(env).length) out.env = env;
  }
  return out;
}

/**
 * De pestaña a guardado. `liveCwd` = carpeta actual de cada panel según el terminal (si se conoce, manda sobre la de arranque).
 * No muta `ws`.
 */
export function toSaved(ws: Workspace, opts: { name: string; id?: string; now?: number; liveCwd?: Record<string, string | undefined> }): SavedWorkspace {
  const panes: SavedPane[] = ws.panes.slice(0, SAVED_LIMITS.panes).map((p) => {
    const sp: SavedPane = {
      col: p.col, row: p.row, colSpan: p.colSpan, rowSpan: p.rowSpan, parked: p.parked,
      kind: p.kind, icon: p.icon, title: p.title,
      spec: savedSpec(p.kind, p.spec, p.kind === 'ssh' ? undefined : opts.liveCwd?.[p.id]),
    };
    if (p.ref) sp.ref = p.ref;
    return sp;
  });
  const sw: SavedWorkspace = {
    id: opts.id ?? uid('sw'), name: cleanName(opts.name) || cleanName(ws.name) || 'Workspace', savedAt: opts.now ?? Date.now(),
    cols: [...ws.cols], rows: [...ws.rows], panes,
  };
  const sbi = cleanOverride(ws.statusBarItems);
  if (sbi) sw.statusBarItems = sbi;
  return sw;
}

/** De guardado a pestaña nueva: ids nuevos de pestaña y de panel. No muta `sw`. */
export function fromSaved(sw: SavedWorkspace, name?: string): Workspace {
  const ws: Workspace = {
    id: uid('ws'), name: cleanName(name) || sw.name, cols: [...sw.cols], rows: [...sw.rows],
    panes: sw.panes.map((p) => ({ ...JSON.parse(JSON.stringify(p)) as SavedPane, id: uid('t') })),
  };
  if (sw.statusBarItems) ws.statusBarItems = [...sw.statusBarItems];
  return ws;
}

/** Copia de una pestaña abierta (Duplicar): misma disposición, paneles nuevos sin sesión de Claude. */
export function duplicateWorkspace(ws: Workspace, name: string, liveCwd?: Record<string, string | undefined>): Workspace {
  return fromSaved(toSaved(ws, { name, liveCwd }), name);
}

export function findByName(list: readonly SavedWorkspace[], name: string, exceptId?: string): SavedWorkspace | undefined {
  const k = nameKey(name);
  return k ? list.find((s) => s.id !== exceptId && nameKey(s.name) === k) : undefined;
}

export type SaveResult =
  | { ok: true; list: SavedWorkspace[]; saved: SavedWorkspace; replaced: boolean }
  | { ok: false; reason: 'empty' | 'conflict' | 'full'; existing?: SavedWorkspace };

/**
 * Añade `sw`. Si ya hay uno con ese nombre: sin `overwrite`, `conflict` (la interfaz pregunta); con él, lo sustituye conservando
 * su id y su sitio en la lista. No muta `list`.
 */
export function upsertSaved(list: readonly SavedWorkspace[], sw: SavedWorkspace, overwrite = false): SaveResult {
  const name = cleanName(sw.name);
  if (!name) return { ok: false, reason: 'empty' };
  const existing = findByName(list, name);
  if (existing) {
    if (!overwrite) return { ok: false, reason: 'conflict', existing };
    const saved = { ...sw, id: existing.id, name: existing.name }; // se sobrescribe ESE: conserva su id y su nombre
    return { ok: true, list: list.map((s) => (s.id === existing.id ? saved : s)), saved, replaced: true };
  }
  if (list.length >= SAVED_LIMITS.count) return { ok: false, reason: 'full' };
  const saved = { ...sw, name };
  return { ok: true, list: [...list, saved], saved, replaced: false };
}

/** Sobrescribe el guardado `id` con el contenido de `sw` (mismo nombre e id). */
export function overwriteSaved(list: readonly SavedWorkspace[], id: string, sw: SavedWorkspace): SavedWorkspace[] {
  return list.map((s) => (s.id === id ? { ...sw, id: s.id, name: s.name } : s));
}

export type RenameResult = { ok: true; list: SavedWorkspace[] } | { ok: false; reason: 'empty' | 'conflict' | 'missing' };

export function renameSaved(list: readonly SavedWorkspace[], id: string, name: string): RenameResult {
  const n = cleanName(name);
  if (!n) return { ok: false, reason: 'empty' };
  if (!list.some((s) => s.id === id)) return { ok: false, reason: 'missing' };
  if (findByName(list, n, id)) return { ok: false, reason: 'conflict' };
  return { ok: true, list: list.map((s) => (s.id === id ? { ...s, name: n } : s)) };
}

export function deleteSaved(list: readonly SavedWorkspace[], id: string): SavedWorkspace[] {
  return list.filter((s) => s.id !== id);
}

/** Búsqueda en la lista: por nombre y por los títulos de sus paneles; sin texto, todos. Más recientes primero. */
export function filterSaved(list: readonly SavedWorkspace[], query: string): SavedWorkspace[] {
  const q = query.trim().toLocaleLowerCase();
  const hit = (s: SavedWorkspace) => !q || s.name.toLocaleLowerCase().includes(q) || s.panes.some((p) => p.title.toLocaleLowerCase().includes(q));
  return list.filter(hit).sort((a, b) => b.savedAt - a.savedAt);
}

/** «Base», «Base 2», «Base 3»… el primero que no choque con `taken`. */
export function uniqueName(base: string, taken: readonly string[]): string {
  const b = cleanName(base) || 'Workspace';
  const used = new Set(taken.map(nameKey));
  if (!used.has(nameKey(b))) return b;
  for (let i = 2; ; i++) {
    const n = `${b.slice(0, SAVED_LIMITS.name - 4)} ${i}`;
    if (!used.has(nameKey(n))) return n;
  }
}

// ---------- leer lo guardado (estado en disco o copia de seguridad) ----------

const PANE_KINDS: readonly PaneKind[] = ['shell', 'ssh', 'agent'];
const int = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : dflt;

function tracks(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > SAVED_LIMITS.tracks) return null;
  if (!v.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) return null;
  const sum = (v as number[]).reduce((a, b) => a + b, 0);
  return (v as number[]).map((n) => n / sum);
}

function specOf(raw: unknown): PaneSpec | null {
  if (!isObj(raw) || typeof raw.program !== 'string' || !raw.program.trim() || raw.program.length > 1000) return null;
  if (!Array.isArray(raw.args) || raw.args.length > 64 || !raw.args.every((a) => typeof a === 'string' && a.length <= 8000 && !a.includes('\u0000'))) return null;
  const spec: PaneSpec = { program: raw.program.trim(), args: [...(raw.args as string[])] };
  if (typeof raw.cwd === 'string' && raw.cwd && raw.cwd.length <= 1000 && !raw.cwd.includes('\u0000')) spec.cwd = raw.cwd;
  if (isObj(raw.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env).slice(0, 64)) {
      if (typeof v !== 'string' || v.length > 4000 || v.includes('\u0000') || !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(k)) continue;
      if (k === ASKPASS_ENV || SECRETISH.test(k)) continue;
      env[k] = v;
    }
    if (Object.keys(env).length) spec.env = env;
  }
  return spec;
}

function paneOf(raw: unknown, cols: number, rows: number): SavedPane | null {
  if (!isObj(raw)) return null;
  const kind = PANE_KINDS.includes(raw.kind as PaneKind) ? (raw.kind as PaneKind) : null;
  const spec = specOf(raw.spec);
  if (!kind || !spec) return null;
  if (kind === 'ssh') delete spec.env;
  const col = int(raw.col, 0, cols - 1, 0);
  const row = int(raw.row, 0, rows - 1, 0);
  const p: SavedPane = {
    col, row, colSpan: int(raw.colSpan, 1, cols - col, 1), rowSpan: int(raw.rowSpan, 1, rows - row, 1), parked: raw.parked === true,
    kind, icon: cleanName(raw.icon).slice(0, 40) || 'terminal', title: typeof raw.title === 'string' ? raw.title.replace(CTRL, '').slice(0, 200) : '',
    spec: kind === 'agent' ? freshAgentSpec(spec) : spec,
  };
  const ref = cleanName(raw.ref);
  if (ref) p.ref = ref.slice(0, 200);
  return p;
}

/**
 * Lista guardada leída del disco o de una copia: lo que no sea una lista da `[]` (estados de antes de esta función), las entradas
 * rotas se descartan, los ids repetidos se rehacen, los nombres repetidos se numeran y se recorta al tope.
 */
export function normalizeSaved(raw: unknown): SavedWorkspace[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedWorkspace[] = [];
  const ids = new Set<string>();
  for (const r of raw) {
    if (out.length >= SAVED_LIMITS.count) break;
    if (!isObj(r)) continue;
    const cols = tracks(r.cols);
    const rows = tracks(r.rows);
    const name = cleanName(r.name);
    if (!cols || !rows || !name || !Array.isArray(r.panes)) continue;
    const panes = r.panes.slice(0, SAVED_LIMITS.panes).map((p) => paneOf(p, cols.length, rows.length)).filter((p): p is SavedPane => !!p);
    let id = typeof r.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(r.id) ? r.id : uid('sw');
    while (ids.has(id)) id = uid('sw');
    ids.add(id);
    const sw: SavedWorkspace = {
      id, name: uniqueName(name, out.map((s) => s.name)),
      savedAt: typeof r.savedAt === 'number' && Number.isFinite(r.savedAt) && r.savedAt > 0 ? r.savedAt : 0,
      cols, rows, panes,
    };
    const sbi = cleanOverride(r.statusBarItems);
    if (sbi) sw.statusBarItems = sbi;
    out.push(sw);
  }
  return out;
}

/**
 * Mezcla los guardados de una copia con los actuales: el que ya está (mismo id o mismo nombre y mismo contenido) se salta; si el
 * nombre choca con otro distinto, entra con el nombre numerado. Devuelve la lista nueva y cuántos entraron / se saltaron.
 */
export function mergeSaved(cur: readonly SavedWorkspace[], incoming: readonly SavedWorkspace[]): { list: SavedWorkspace[]; added: number; skipped: number } {
  const list = [...cur];
  let added = 0;
  let skipped = 0;
  const sig = (s: SavedWorkspace) => JSON.stringify([s.cols, s.rows, s.panes]);
  for (const s of incoming) {
    const same = list.find((x) => x.id === s.id) ?? findByName(list, s.name);
    if (same && (same.id === s.id || sig(same) === sig(s))) { skipped++; continue; }
    if (list.length >= SAVED_LIMITS.count) { skipped++; continue; }
    const ids = new Set(list.map((x) => x.id));
    let id = s.id;
    while (ids.has(id)) id = uid('sw');
    list.push({ ...s, id, name: uniqueName(s.name, list.map((x) => x.name)) });
    added++;
  }
  return { list, added, skipped };
}
