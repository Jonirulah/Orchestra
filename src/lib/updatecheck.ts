// Lógica pura de la actualización automática (sin Tauri ni Svelte): cuándo comprobar,
// comparar versiones, clasificar errores y qué avisar antes de instalar. La usa updater.svelte.ts.

/** Repositorio de las releases (el endpoint del plugin está en src-tauri/tauri.conf.json). */
export const RELEASES_URL = 'https://github.com/Jonirulah/Orchestra/releases';
/** Primera comprobación tras arrancar: después de que la interfaz y los paneles ya estén en marcha. */
export const FIRST_CHECK_DELAY_MS = 8_000;
/** Cada cuánto se vuelve a comprobar. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * Cada cuánto se mira si toca comprobar. Un setInterval de 6 h se retrasa si el equipo duerme;
 * con un tic corto y `shouldCheck` la comprobación llega en cuanto despierta.
 */
export const TICK_MS = 15 * 60 * 1000;

/** ¿Toca comprobar? `lastAt` = epoch ms de la última comprobación (0 = nunca). */
export function shouldCheck(enabled: boolean, lastAt: number, now: number, interval = CHECK_INTERVAL_MS): boolean {
  if (!enabled) return false;
  if (!lastAt || lastAt > now) return true; // nunca, o el reloj fue hacia atrás
  return now - lastAt >= interval;
}

interface Parsed { nums: number[]; pre: string[] }

function parse(v: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/**
 * Compara dos versiones semver (acepta «v» delante). Devuelve <0, 0 o >0.
 * Una prerelease es menor que su versión final (0.4.0-beta.1 < 0.4.0). Lo que no se entiende es 0.
 */
export function compareVersions(a: string, b: string): number {
  const x = parse(a), y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) - Number(q); continue; }
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export const isNewer = (remote: string, current: string): boolean => compareVersions(remote, current) > 0;

/** Página de una release concreta (para el portable y «Ver en GitHub»). */
export const releasePage = (version: string): string => `${RELEASES_URL}/tag/v${version.replace(/^v/, '')}`;

export type UpdateErrorKind = 'signature' | 'network' | 'portable' | 'other';

/** El backend antepone `signature:` o `network:` al mensaje (ver src-tauri/src/updater.rs). */
export function classifyError(msg: string): UpdateErrorKind {
  if (msg.startsWith('signature:')) return 'signature';
  if (msg.startsWith('network:')) return 'network';
  if (msg === 'portable') return 'portable';
  return 'other';
}

/** Mensaje sin el prefijo de tipo, para enseñarlo como detalle. */
export const errorDetail = (msg: string): string => msg.replace(/^(signature|network):/, '').trim();

export interface BusyInput {
  /** Estado de cada agente visto en el último escaneo. */
  agentStatuses: string[];
  /** Paneles SSH con el proceso vivo. */
  sshOpen: number;
}
export interface BusyReport { agents: number; ssh: number; any: boolean }

/** Lo que se cerrará al instalar: agentes trabajando (no los parados) y sesiones SSH abiertas. */
export function busyReport(i: BusyInput): BusyReport {
  const agents = i.agentStatuses.filter((s) => s === 'busy' || s === 'running' || s === 'waiting').length;
  return { agents, ssh: i.sshOpen, any: agents > 0 || i.sshOpen > 0 };
}

/** Porcentaje de la descarga (0..100) o null si el servidor no dijo el tamaño. */
export function progressPct(got: number, total: number | null | undefined): number | null {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((got / total) * 100)));
}

/** Notas de la release recortadas para el aviso (el diálogo enseña las completas). */
export function notesPreview(notes: string, max = 280): string {
  const s = notes.replace(/\r\n/g, '\n').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export interface NoteSpan { text: string; bold?: boolean; code?: boolean }
export interface NoteBlock { kind: 'h' | 'li' | 'p'; spans: NoteSpan[] }

/** `**negrita**` y `código` dentro de una línea; lo demás es texto tal cual (nunca HTML). */
export function noteSpans(line: string): NoteSpan[] {
  const out: NoteSpan[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) });
    out.push(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2], code: true });
    last = re.lastIndex;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out;
}

/**
 * Notas de la release (markdown del CHANGELOG) a bloques sencillos: títulos `#`, viñetas `-`/`*`
 * (las líneas sangradas siguientes continúan la viñeta) y párrafos. Así el diálogo no enseña `###` ni `**`.
 */
export function parseNotes(notes: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let cur: { kind: NoteBlock['kind']; text: string } | null = null;
  const flush = () => { if (cur) blocks.push({ kind: cur.kind, spans: noteSpans(cur.text) }); cur = null; };
  for (const raw of notes.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    const li = /^\s{0,3}[-*]\s+(.*)$/.exec(line);
    if (h) { flush(); blocks.push({ kind: 'h', spans: noteSpans(h[1]) }); }
    else if (li) { flush(); cur = { kind: 'li', text: li[1] }; }
    else if (cur) cur.text += ` ${line.trim()}`;
    else cur = { kind: 'p', text: line.trim() };
  }
  flush();
  return blocks;
}
