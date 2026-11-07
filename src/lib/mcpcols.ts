// Identidad de las columnas de la vista MCP: cada columna es una cuenta de la barra lateral, con el MISMO nombre visible
// (y su traducción: «Main» → «Principal») y el MISMO punto de color; la herramienta va de subtítulo.
import type { McpAccount } from './backend.ts';
import type { Account } from './model.ts';
import { displayName, providerLabel, providerOf } from './model.ts';
import { buildAccountView } from './accountview.ts';
import type { ViewCtx, ViewOpts } from './accountview.ts';

/** Color del lanzador suelto «Codex (ChatGPT)» de la barra lateral (Sidebar.svelte). */
export const CODEX_LAUNCHER_COLOR = '#10a37f';
/** Nombre del lanzador suelto de Codex en la barra lateral (nombre de producto: no se traduce). */
export const CODEX_LAUNCHER_NAME = 'Codex (ChatGPT)';

export interface ColumnIdentity {
  /** Nombre visible, igual que en la barra lateral. */
  name: string;
  /** Punto de color de la barra lateral (null: la cuenta no está en la barra lateral). */
  color: string | null;
  /** Herramienta («Claude», «Codex», «opencode»), para el subtítulo. */
  tool: string;
  /** Cuentas de la barra lateral que representa (opencode: su config es global, una columna para todas). */
  accounts: Account[];
}

const norm = (d: string) => d.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Fallback cuando la carpeta no es una cuenta de Orchestra (p. ej. ignorada): «por defecto» o el nombre de la carpeta. */
function folderName(a: McpAccount, defaultLabel: string): string {
  if (a.isDefault) return defaultLabel;
  const base = a.dir.split(/[\\/]/).filter(Boolean).pop() ?? a.dir;
  return base.replace(/^\.(claude|codex)-?/, '').replace(/^\./, '') || base;
}

/** `labels.defaultAccount`: «Cuenta por defecto»; `labels.opencodeGlobal`: «opencode (global)». */
export function columnIdentity(a: McpAccount, appAccounts: readonly Account[], labels: { defaultAccount: string; opencodeGlobal: string }): ColumnIdentity {
  const tool = providerLabel(a.provider);
  if (a.provider === 'opencode') {
    const oc = appAccounts.filter((x) => providerOf(x) === 'opencode');
    if (oc.length === 1) return { name: displayName(oc[0].name), color: oc[0].color, tool, accounts: oc };
    return { name: labels.opencodeGlobal, color: oc[0]?.color ?? null, tool, accounts: oc };
  }
  const mine = appAccounts.find((x) => providerOf(x) === a.provider && norm(x.dir) === norm(a.dir));
  if (mine) return { name: displayName(mine.name), color: mine.color, tool, accounts: [mine] };
  // El Codex de siempre (~/.codex) sin cuenta propia: en la barra lateral es el lanzador «Codex (ChatGPT)».
  if (a.provider === 'codex' && a.isDefault) return { name: CODEX_LAUNCHER_NAME, color: CODEX_LAUNCHER_COLOR, tool, accounts: [] };
  return { name: folderName(a, labels.defaultAccount), color: null, tool, accounts: [] };
}

/** Columnas en el orden de la barra lateral: por herramienta (Claude, Codex, opencode) y dentro, en el orden guardado
 *  de las cuentas; el Codex por defecto sin cuenta va tras las de Codex (donde está su lanzador). */
export function orderColumns(list: readonly McpAccount[], appAccounts: readonly Account[]): McpAccount[] {
  const P = ['claude', 'codex', 'opencode'];
  const rank = (a: McpAccount) => {
    const i = appAccounts.findIndex((x) => providerOf(x) === a.provider && norm(x.dir) === norm(a.dir));
    return i >= 0 ? i : appAccounts.length + (a.isDefault ? 0 : 1);
  };
  return list.map((a, i) => ({ a, i })).sort((x, y) => P.indexOf(x.a.provider) - P.indexOf(y.a.provider) || rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
}

// ---- Columnas = filas de cuenta de la barra lateral (v6) ----
// Una columna por cada cuenta de la barra lateral, en su mismo orden, SIEMPRE (también en los estados vacíos y tras
// igualar / quitar): si de una cuenta no hay datos MCP, la columna sale igual, atenuada y con el motivo.

/** Fila de cuenta de la barra lateral: una cuenta guardada o el lanzador suelto «Codex (ChatGPT)». */
export type SidebarEntry = { kind: 'account'; account: Account } | { kind: 'codexLauncher' };

/** Las filas de cuenta de la barra lateral en su orden (sin filtro de texto ni de proveedor: todas), con la misma
 *  función que pinta la barra (buildAccountView). La fila «auto» no es una cuenta. */
export function sidebarEntries(appAccounts: readonly Account[], opts: { sort: ViewOpts['sort']; group: boolean }, ctx: Pick<ViewCtx, 'quota' | 'now'>): SidebarEntry[] {
  const hasDefaultCodex = appAccounts.some((a) => providerOf(a) === 'codex' && a.isDefault);
  const out: SidebarEntry[] = [];
  for (const s of buildAccountView(appAccounts, { filter: 'all', sort: opts.sort, group: opts.group }, { ...ctx, hasDefaultCodex })) {
    for (const a of s.accounts) out.push({ kind: 'account', account: a });
    for (const r of s.specialRows) if (r === 'codex') out.push({ kind: 'codexLauncher' });
  }
  return out;
}

/** Motivo de una columna sin datos MCP. */
export type Unreadable = 'noSession' | 'unreadable';
/** Columna de la vista: la cuenta MCP (o una vacía si no hay datos) + por qué no se puede leer. */
export type McpColumn = McpAccount & { unreadable?: Unreadable };

/** Columnas de la vista MCP a partir de la barra lateral. `list`: lo que leyó el backend; `loggedIn(acc)`: sesión del
 *  perfil de Claude (undefined = no se sabe). Varias cuentas de opencode comparten la config (global): una columna, en
 *  el sitio de la primera. Lo que el backend lee y no está en la barra lateral (carpetas ignoradas) no sale. */
export function sidebarColumns(list: readonly McpAccount[], entries: readonly SidebarEntry[], loggedIn: (a: Account) => boolean | undefined = () => undefined): McpColumn[] {
  const out: McpColumn[] = [];
  const used = new Set<string>();
  const empty = (provider: McpAccount['provider'], dir: string, isDefault: boolean, why: Unreadable): McpColumn =>
    ({ id: `none:${provider}:${dir}`, provider, dir, isDefault, label: null, source: '', servers: [], error: null, unreadable: why });
  for (const e of entries) {
    if (e.kind === 'codexLauncher') {
      const m = list.find((x) => x.provider === 'codex' && x.isDefault);
      if (m) { if (!used.has(m.id)) { used.add(m.id); out.push(m); } } else out.push(empty('codex', '~/.codex', true, 'unreadable'));
      continue;
    }
    const a = e.account;
    const p = providerOf(a);
    const m = p === 'opencode' ? list.find((x) => x.provider === 'opencode') : list.find((x) => x.provider === p && norm(x.dir) === norm(a.dir));
    if (m) { if (!used.has(m.id)) { used.add(m.id); out.push(m); } continue; }
    if (p === 'opencode' && out.some((c) => c.provider === 'opencode')) continue; // ya tiene su columna (compartida)
    out.push(empty(p, a.dir, a.isDefault, p === 'claude' && loggedIn(a) === false ? 'noSession' : 'unreadable'));
  }
  return out;
}

/** Nombre de la fila de la barra lateral (lo que se compara con el de la columna). */
export function sidebarEntryName(e: SidebarEntry): string {
  return e.kind === 'codexLauncher' ? CODEX_LAUNCHER_NAME : displayName(e.account.name);
}

/** Ruta para enseñar: en Windows (unidad «C:» o ruta UNC) siempre con «\»; el resto, tal cual. */
export function winPath(p: string): string {
  return /^[A-Za-z]:([\\/]|$)|^\\\\/.test(p) ? p.replace(/\//g, '\\') : p;
}
