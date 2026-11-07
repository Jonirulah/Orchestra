// Tabla MCP × cuenta del gestor de MCP (Ajustes → Servidores MCP). Módulo puro: sin Svelte ni Tauri.
// Filas = MCP agrupados por nombre. Si un nombre tiene varias huellas, la fila tiene varias variantes (A, B…): cada
// celda dice qué variante tiene esa cuenta y la fila lleva qué cambia entre ellas (comando, args, url, claves de env…).
import type { McpAccount, McpDef, McpProbeResult } from './backend.ts';

/** Qué puede cambiar entre dos definiciones con el mismo nombre (lo visible; `values` = solo cambian valores ocultos). */
export type McpDiffField = 'transport' | 'command' | 'args' | 'url' | 'cwd' | 'envKeys' | 'headerKeys' | 'envPassthrough' | 'values';

/** Una definición concreta (nombre + huella) y en qué cuentas está. Es lo que se copia, quita o iguala (F2). */
export interface McpVariant {
  /** `nombre|huella`: estable mientras Orchestra sigue abierto. */
  key: string;
  name: string;
  fingerprint: string;
  /** «A», «B»… por orden de cuántas cuentas la tienen; «» si el nombre solo tiene una variante. */
  letter: string;
  /** Definición representativa (la primera encontrada). */
  def: McpDef;
  /** Por cuenta (id), todas las apariciones de esta variante (una cuenta de Claude puede tenerla en varios proyectos). */
  cells: Record<string, McpDef[]>;
  /** Qué cambia respecto a las otras variantes del mismo nombre (vacío si es la única). */
  diff: McpDiffField[];
}

export interface McpRow {
  /** El nombre (una fila por nombre). */
  key: string;
  name: string;
  /** Definición de la variante A. */
  def: McpDef;
  /** Por cuenta, todas las apariciones de todas las variantes. */
  cells: Record<string, McpDef[]>;
  /** Variantes por orden (A primero). Una sola si no hay conflicto. */
  variants: McpVariant[];
  /** Unión de lo que cambia entre variantes (vacío si solo hay una). */
  diff: McpDiffField[];
  /** Gestionado fuera de la config (plugin o claude.ai): informativo. */
  managed: boolean;
}

/** Lo que necesitan las acciones de F2 (copiar, quitar, igualar): una variante o una fila sin variantes. */
export type McpRowLike = Pick<McpVariant, 'key' | 'name' | 'def' | 'cells'>;

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sortedLower = (a: string[]) => [...a].map((x) => x.toLowerCase()).sort();
const normCmd = (c: string | null) => (c ?? '').trim().replace(/\\/g, '/').toLowerCase();

/** Campos visibles en los que difieren dos definiciones. Si no difiere ninguno pero la huella sí, `values`. */
export function diffDefs(a: McpDef, b: McpDef): McpDiffField[] {
  const out: McpDiffField[] = [];
  if (a.transport !== b.transport) out.push('transport');
  if (normCmd(a.command) !== normCmd(b.command)) out.push('command');
  if (!sameList(a.args, b.args)) out.push('args');
  if ((a.url ?? '').replace(/\/+$/, '') !== (b.url ?? '').replace(/\/+$/, '')) out.push('url');
  if (normCmd(a.cwd) !== normCmd(b.cwd)) out.push('cwd');
  if (!sameList(sortedLower(a.envKeys), sortedLower(b.envKeys))) out.push('envKeys');
  if (!sameList(sortedLower(a.headerKeys), sortedLower(b.headerKeys))) out.push('headerKeys');
  if (!sameList(sortedLower(a.envPassthrough), sortedLower(b.envPassthrough))) out.push('envPassthrough');
  if (!out.length && a.fingerprint !== b.fingerprint) out.push('values');
  return out;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Agrupa los MCP de todas las cuentas: una fila por nombre, con sus variantes. Orden: por nombre (sin mayúsculas), los
 *  gestionados fuera al final. Variantes: la que está en más cuentas es la A; empate → huella. */
export function buildMcpRows(accounts: McpAccount[]): McpRow[] {
  const vars = new Map<string, McpVariant>();
  for (const acc of accounts) {
    for (const d of acc.servers) {
      const key = `${d.name}|${d.fingerprint}`;
      let v = vars.get(key);
      if (!v) {
        v = { key, name: d.name, fingerprint: d.fingerprint, letter: '', def: d, cells: {}, diff: [] };
        vars.set(key, v);
      }
      (v.cells[acc.id] ??= []).push(d);
    }
  }
  const byName = new Map<string, McpVariant[]>();
  for (const v of vars.values()) {
    const g = byName.get(v.name);
    if (g) g.push(v); else byName.set(v.name, [v]);
  }
  const rows: McpRow[] = [];
  for (const [name, g] of byName) {
    g.sort((a, b) => Object.keys(b.cells).length - Object.keys(a.cells).length || a.fingerprint.localeCompare(b.fingerprint));
    const all = new Set<McpDiffField>();
    if (g.length > 1) {
      g.forEach((v, i) => {
        v.letter = LETTERS[i] ?? String(i + 1);
        const fields = new Set<McpDiffField>();
        for (const o of g) if (o !== v) for (const f of diffDefs(v.def, o.def)) fields.add(f);
        v.diff = [...fields];
        for (const f of fields) all.add(f);
      });
    }
    const cells: Record<string, McpDef[]> = {};
    for (const v of g) for (const [acc, defs] of Object.entries(v.cells)) (cells[acc] ??= []).push(...defs);
    rows.push({ key: name, name, def: g[0].def, cells, variants: g, diff: [...all], managed: g.every((v) => !!v.def.managedBy) });
  }
  return rows.sort((a, b) => Number(a.managed) - Number(b.managed) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name));
}

/** Letras de las variantes que tiene una cuenta en esta fila («» si la fila no tiene variantes). */
export function cellLetters(row: McpRow, accountId: string): string[] {
  if (row.variants.length < 2) return [];
  return row.variants.filter((v) => v.cells[accountId]).map((v) => v.letter);
}

/** Variante a la que pertenece una aparición. */
export const variantOf = (row: McpRow, d: McpDef): McpVariant | undefined => row.variants.find((v) => v.fingerprint === d.fingerprint);

/** Clave de una sonda: cuenta + ámbito + nombre + proyecto. */
export const probeKey = (accountId: string, d: Pick<McpDef, 'scope' | 'name' | 'projectPath'>) => `${accountId}|${d.scope}|${d.name}|${d.projectPath ?? ''}`;

/** ¿Se puede probar esa aparición? Los conectores de claude.ai no tienen definición local. */
export const canProbe = (d: McpDef) => d.scope !== 'claudeai';

/** ¿Entra en las sesiones? Encendido y, si es de un `.mcp.json` de proyecto, aprobado. */
export const isActive = (d: McpDef) => d.enabled !== false && !(d.scope === 'project' && d.enabled === null);
/** ¿Tiene sentido probarlo? Solo lo que entra en las sesiones y tiene definición local (no los conectores de claude.ai). */
export const shouldProbe = (d: McpDef) => canProbe(d) && isActive(d);

/** Coste de una fila: el mayor `tokensEst` de sus sondas correctas, solo de apariciones encendidas (lo apagado o sin
 *  aprobar no cuesta nada en las sesiones). */
export function rowTokens(row: McpRow, results: Record<string, ProbeLike | undefined>): number | null {
  let best: number | null = null;
  for (const [acc, defs] of Object.entries(row.cells)) {
    for (const d of defs) {
      if (!isActive(d)) continue;
      const r = results[probeKey(acc, d)];
      if (r?.status === 'ok' && (best === null || r.tokensEst > best)) best = r.tokensEst;
    }
  }
  return best;
}

/** Resultado de una sonda o el error del comando (cuenta/MCP no encontrados). */
export type ProbeLike = McpProbeResult | { status: 'error'; msg: string };

/** Estado de una aparición o celda. Uno solo, el mismo para la celda, el tooltip y el detalle. */
export type McpStatus = 'untested' | 'ok' | 'failed' | 'auth' | 'timeout' | 'off' | 'pending' | 'managed';
export interface StatusView {
  status: McpStatus;
  /** Ámbito de la aparición que manda (la celda lo enseña siempre junto al estado). */
  scope: McpDef['scope'];
  tools?: number;
  /** Fallos: el mensaje crudo (va en «Ver detalle»). */
  msg?: string;
}

/** Estado de UNA aparición: apagado y sin aprobar mandan sobre cualquier prueba (no se cargan en las sesiones). */
export function defStatus(d: McpDef, r: ProbeLike | undefined): StatusView {
  const scope = d.scope;
  if (d.enabled === false) return { status: 'off', scope };
  if (d.scope === 'project' && d.enabled === null) return { status: 'pending', scope };
  if (!r) return { status: d.managedBy ? 'managed' : 'untested', scope };
  switch (r.status) {
    case 'ok': return { status: 'ok', scope, tools: r.tools };
    case 'needsAuth': return { status: 'auth', scope };
    case 'timeout': return { status: 'timeout', scope };
    default: return { status: 'failed', scope, msg: r.msg };
  }
}

const RANK: Record<McpStatus, number> = { failed: 7, timeout: 6, auth: 5, untested: 4, managed: 3, ok: 2, pending: 1, off: 0 };
/** Estado de una celda (una cuenta puede tener el mismo MCP en varios proyectos): manda la peor aparición activa; si no hay
 *  ninguna activa, «sin aprobar» antes que «apagado». `null` = la cuenta no lo tiene. */
export function cellView(defs: McpDef[] | undefined, accountId: string, results: Record<string, ProbeLike | undefined>): StatusView | null {
  if (!defs?.length) return null;
  const views = defs.map((d) => defStatus(d, results[probeKey(accountId, d)]));
  return views.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
}

/** Coste de una cuenta (pie de columna): suma de los MCP encendidos que dieron cifra. `partial` en cuanto una celda
 *  encendida no la dio: sin probar (`pending`), falla / pide sesión / no responde (`failed`) o no se puede medir
 *  (`unmeasurable`, conectores de claude.ai). Lo apagado y lo sin aprobar no cuenta. */
export interface ColumnTotal { tokens: number; probed: number; pending: number; failed: number; unmeasurable: number; partial: boolean }
export function columnTotal(rows: McpRow[], accountId: string, results: Record<string, ProbeLike | undefined>): ColumnTotal {
  const out: ColumnTotal = { tokens: 0, probed: 0, pending: 0, failed: 0, unmeasurable: 0, partial: false };
  for (const row of rows) {
    const defs = row.cells[accountId];
    if (cellState(defs) !== 'on') continue; // apagado o sin aprobar: no entra en las sesiones
    const probeable = defs!.filter(shouldProbe);
    if (!probeable.length) { out.unmeasurable++; continue; }
    const rs = probeable.map((d) => results[probeKey(accountId, d)]);
    if (rs.some((r) => !r)) { out.pending++; continue; }
    if (rs.some((r) => r!.status !== 'ok')) { out.failed++; continue; }
    // Varias apariciones (proyectos distintos): en una sesión solo se carga una → la mayor.
    out.tokens += Math.max(0, ...rs.map((r) => (r as { tokensEst: number }).tokensEst));
    out.probed++;
  }
  out.partial = out.pending + out.failed + out.unmeasurable > 0;
  return out;
}

/** Tipo de fallo de una sonda, para una frase corta traducida (el texto crudo va en «Ver detalle»). */
export type ProbeErrorKind = 'refused' | 'notFound' | 'exit' | 'timeout' | 'auth' | 'http' | 'dns' | 'other';
export interface ProbeError { kind: ProbeErrorKind; code?: number; host?: string }
/** Clasifica el mensaje de un fallo. Lo más concreto primero: «Connection refused … exit code 1» es «conexión rechazada». */
export function classifyProbeError(msg: string): ProbeError {
  const m = msg ?? '';
  if (/connection refused|econnrefused|actively refused|os error (10061|111)\b|denegó expresamente/i.test(m)) {
    const h = m.match(/host "?([\w.-]+)"?[^\d]{0,40}port (\d+)/i) ?? m.match(/\b((?:\d{1,3}\.){3}\d{1,3}|localhost):(\d+)/i);
    return { kind: 'refused', host: h ? `${h[1]}:${h[2]}` : undefined };
  }
  if (/could not start|failed to spawn|not recognized as|no such file|cannot find|command not found|enoent|os error 2\b|program not found|is not installed/i.test(m)) return { kind: 'notFound' };
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|log ?in|sign ?in|authenticat/i.test(m)) return { kind: 'auth' };
  if (/timed? ?out|timeout/i.test(m)) return { kind: 'timeout' };
  if (/dns|name resolution|no such host|getaddrinfo|resolve host/i.test(m)) return { kind: 'dns' };
  const h = m.match(/\bHTTP (\d{3})\b/);
  if (h) return { kind: 'http', code: Number(h[1]) };
  const e = m.match(/exit(?:ed with)? code:? ?(-?\d+)/i);
  if (e) return { kind: 'exit', code: Number(e[1]) };
  return { kind: 'other' };
}

/** Tokens en corto según el idioma: EN 950 / 1.5k / 12k; ES 950 / 1,5 k / 12 k (espacio duro antes de la k). */
export function compactTokens(n: number, lang: string = 'en'): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  const v = k >= 10 ? Math.round(k) : Math.round(k * 10) / 10;
  return lang === 'es' ? `${String(v).replace('.', ',')} k` : `${v}k`;
}

const RUNNERS = new Set(['npx', 'uvx', 'bunx', 'pnpx']);
/** Si el MCP se lanza con un ejecutor de paquetes (`npx`, `uvx`, `pnpm dlx`…), el paquete que descarga y ejecuta. */
export function thirdPartyPackage(d: McpDef): string | null {
  if (d.transport !== 'stdio' || !d.command) return null;
  const base = d.command.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '');
  let args = d.args;
  if (base === 'pnpm' || base === 'yarn') {
    if (args[0] !== 'dlx') return null;
    args = args.slice(1);
  } else if (!RUNNERS.has(base)) {
    return null;
  }
  const pkg = args.find((a) => !a.startsWith('-') && a !== '•••');
  if (!pkg || pkg.startsWith('.') || /^[a-z]:[\\/]/i.test(pkg) || pkg.startsWith('/')) return null;
  return pkg;
}

/** Estado de una celda para pintarla. */
export type CellState = 'none' | 'on' | 'off' | 'pending';
/** Una celda está «on» si alguna aparición está encendida; «off» si todas están apagadas; «pending» = .mcp.json sin aprobar. */
export function cellState(defs: McpDef[] | undefined): CellState {
  if (!defs?.length) return 'none';
  if (defs.some((d) => d.enabled !== false && !(d.scope === 'project' && d.enabled === null))) return 'on';
  if (defs.some((d) => d.scope === 'project' && d.enabled === null)) return 'pending';
  return 'off';
}

// ---------- comparación de versiones por fragmentos ----------

export interface DiffPiece { text: string; changed: boolean }
const tokens = (s: string) => s.match(/[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g) ?? [];
/** Trozos de `a` marcando los que no están en `b` (LCS por fragmentos: palabras con `_`, números, signos sueltos).
 *  Los trozos cambiados seguidos se juntan: `@0.5.0` sale como un solo resaltado. */
export function diffPieces(a: string, b: string): DiffPiece[] {
  const x = tokens(a), y = tokens(b);
  const n = x.length, m = y.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffPiece[] = [];
  const push = (text: string, changed: boolean) => {
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += text; else out.push({ text, changed });
  };
  let i = 0, j = 0;
  while (i < n) {
    if (j < m && x[i] === y[j]) { push(x[i], false); i++; j++; }
    else if (j < m && L[i][j + 1] >= L[i + 1][j]) j++;
    else { push(x[i], true); i++; }
  }
  return out;
}

/** Los trozos de `diffPieces` agrupados por palabra (separadas por espacios), para pintar cada palabra en un bloque que
 *  no se parte por dentro (un comando solo salta de línea en un espacio). */
export function wordPieces(pieces: DiffPiece[]): DiffPiece[][] {
  const words: DiffPiece[][] = [[]];
  for (const p of pieces) {
    const parts = p.text.split(/(\s+)/);
    parts.forEach((t, k) => {
      if (k % 2 === 1) { if (words[words.length - 1].length) words.push([]); return; }
      if (t) words[words.length - 1].push({ text: t, changed: p.changed });
    });
  }
  return words.filter((w) => w.length);
}

export type TotalOut = 'untested' | 'failed' | 'auth' | 'timeout' | 'off' | 'pending' | 'claudeai';
export interface TotalBreakdown {
  counted: { name: string; tokens: number }[];
  /** Fuera de la suma y por qué. Los apagados / sin aprobar no hacen «parcial» (no se cargan). */
  out: { name: string; why: TotalOut }[];
  /** Mismo MCP en varios ámbitos de la cuenta: en una sesión solo se carga uno (local > proyecto > usuario). */
  multi: { name: string; n: number }[];
}
export function totalBreakdown(rows: McpRow[], accountId: string, results: Record<string, ProbeLike | undefined>): TotalBreakdown {
  const b: TotalBreakdown = { counted: [], out: [], multi: [] };
  for (const row of rows) {
    const defs = row.cells[accountId];
    if (!defs?.length) continue;
    if (defs.length > 1) b.multi.push({ name: row.name, n: defs.length });
    const st = cellState(defs);
    if (st === 'off' || st === 'pending') { b.out.push({ name: row.name, why: st }); continue; }
    const probeable = defs.filter(shouldProbe);
    if (!probeable.length) { b.out.push({ name: row.name, why: 'claudeai' }); continue; }
    const rs = probeable.map((d) => results[probeKey(accountId, d)]);
    const bad = rs.find((r) => r && r.status !== 'ok');
    if (rs.some((r) => !r)) { b.out.push({ name: row.name, why: 'untested' }); continue; }
    if (bad) { b.out.push({ name: row.name, why: bad.status === 'needsAuth' ? 'auth' : bad.status === 'timeout' ? 'timeout' : 'failed' }); continue; }
    b.counted.push({ name: row.name, tokens: Math.max(0, ...rs.map((r) => (r as { tokensEst: number }).tokensEst)) });
  }
  return b;
}

// ---- Densidad de la tabla (v7) ----
// UNA densidad para toda la tabla según el ancho disponible (nunca una por celda ni por columna):
//   normal   → icono + palabra del ámbito + estado («usuario ✓ 3», «proyecto ✕ falla»);
//   compacta → icono del ámbito + estado (la palabra del estado es SIEMPRE la misma y nunca se abrevia).
// Si ni en compacta caben todas las columnas, se enseñan las que caben ENTERAS (ventana de columnas con flechas a los
// lados); el contenido de una celda nunca se recorta.

/** Lo que se pinta en una celda: etiqueta de versión («A», «A/B»), ámbito (icono + palabra, o «2 ámbitos») y estado. */
export interface CellParts {
  version: string | null;
  scope: string;
  /** Palabra fija del estado («falla», «login», «sin respuesta»…) o la cifra de herramientas. */
  status: string;
  /** Hay icono de estado (✓, ⚠…) delante del texto. */
  statusIcon: boolean;
}
export type Density = 'normal' | 'compact';
/** Medidas fijas en px (padding de la celda, iconos y huecos) a 12 px de letra. */
export const CELL_PX = { pad: 16, icon: 12, gap: 6, inner: 3, stIcon: 10, stGap: 4, chipPad: 6, probe: 26 } as const;

/** Ancho que ocupa una celda en una densidad; `measure` da el ancho en px de un texto a 12 px. Incluye el hueco del
 *  botón de sondear que asoma al pasar el ratón (no tapa nada). */
export function cellWidth(p: CellParts, d: Density, measure: (s: string) => number): number {
  const P = CELL_PX;
  let w = P.pad + P.probe;
  if (p.version) w += measure(p.version) + P.chipPad + P.gap;
  w += P.icon + (d === 'normal' ? P.inner + measure(p.scope) : 0) + P.gap;
  w += (p.statusIcon ? P.stIcon + P.stGap : 0) + measure(p.status);
  return Math.ceil(w);
}

/** Ancho mínimo de una columna en una densidad: el de su celda más ancha (y lo que pida su cabecera o total). */
export function columnMinWidth(cells: readonly CellParts[], d: Density, measure: (s: string) => number, other = 0): number {
  return Math.max(other, ...cells.map((p) => cellWidth(p, d, measure)));
}

export interface TableLayout {
  density: Density;
  /** Columnas que se ven: [start, end). */
  start: number;
  end: number;
}
/** Densidad única y ventana de columnas enteras para un ancho. `normal[i]` / `compact[i]`: mínimo de cada columna en
 *  cada densidad; `nameW`: columna de nombres; `gutter`: hueco de la flecha de cada lado con columnas ocultas. */
export function tableLayout(width: number, nameW: number, normal: readonly number[], compact: readonly number[], start = 0, gutter = 28): TableLayout {
  const n = normal.length;
  const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);
  if (!n) return { density: 'normal', start: 0, end: 0 };
  if (nameW + sum(normal) <= width) return { density: 'normal', start: 0, end: n };
  if (nameW + sum(compact) <= width) return { density: 'compact', start: 0, end: n };
  const fits = (s: number, e: number) => nameW + sum(compact.slice(s, e)) + (s > 0 ? gutter : 0) + (e < n ? gutter : 0) <= width;
  let s = Math.max(0, Math.min(n - 1, start));
  let e = s + 1;
  while (e < n && fits(s, e + 1)) e++;
  // Al final sobra sitio: se rellena hacia atrás (la ventana siempre va llena).
  while (e === n && s > 0 && fits(s - 1, e)) s--;
  return { density: 'compact', start: s, end: e };
}
/** Primera columna de la ventana para que se vea entera la columna `idx` (moviendo lo mínimo). */
export function windowFor(idx: number, cur: TableLayout, width: number, nameW: number, normal: readonly number[], compact: readonly number[], gutter = 28): number {
  if (idx >= cur.start && idx < cur.end) return cur.start;
  if (idx < cur.start) return idx;
  let s = cur.start;
  while (s < idx && tableLayout(width, nameW, normal, compact, s, gutter).end <= idx) s++;
  return s;
}

/** Etiqueta de versión de una celda: «A» o «A/B» (varias versiones en la misma cuenta); null en filas de una versión. */
export function cellVersionLabel(row: McpRow, defs: readonly McpDef[]): string | null {
  if (row.variants.length < 2) return null;
  const letters = [...new Set(defs.map((d) => row.variants.find((v) => v.fingerprint === d.fingerprint)?.letter).filter(Boolean))].sort();
  return letters.join('/') || null;
}
