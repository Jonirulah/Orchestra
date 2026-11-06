// Vista de la lista de cuentas (barra lateral y Ajustes → Cuentas): filtrar por proveedor, agrupar y ordenar.
// Módulo puro (sin Svelte ni Tauri): se prueba con node --test. No muta nunca la lista que recibe (`app.accounts` queda como está).
import { PROVIDERS, accountTitle, providerOf } from './model.ts';
import type { Account, Provider } from './model.ts';
import { nextReset, pressure } from './policy.ts';
import type { Quota } from './policy.ts';
import type { Key } from './i18n.ts';

/** Qué proveedor se enseña: todos o uno. */
export type AccountsFilter = 'all' | Provider;
/** Orden dentro de cada grupo (o de la lista plana). `free` y `reset` solo tienen sentido para Claude (única con cuota). */
export type AccountsSort = 'manual' | 'name' | 'free' | 'reset';

export const ACCOUNTS_FILTERS: readonly AccountsFilter[] = ['all', 'claude', 'codex', 'opencode'];
export const ACCOUNTS_SORTS: readonly AccountsSort[] = ['manual', 'name', 'free', 'reset'];

/** Filas sueltas que no son una cuenta: `auto` = «Claude · auto»; `codex` = el lanzador «Codex (ChatGPT)» (solo sin cuenta Default de Codex). */
export type SpecialRow = 'auto' | 'codex';

export interface ViewOpts { filter: AccountsFilter; sort: AccountsSort; group: boolean }

export interface ViewCtx {
  quota: Record<string, Quota | undefined>;
  /** Segundos epoch. */
  now: number;
  /** Texto del filtro global de la barra (ya sin espacios; se compara en minúsculas). Vacío = sin filtro. */
  text?: string;
  /** Email del perfil de la cuenta, si lo hay (el filtro de texto también lo mira). */
  emailOf?: (a: Account) => string | undefined;
  /** Hay una cuenta «Default» de Codex: entonces sobra el lanzador suelto. */
  hasDefaultCodex: boolean;
  /** Mostrar las filas sueltas (la barra las lleva; Ajustes no). Por defecto sí. */
  specialRows?: boolean;
}

export interface Section {
  /** `null` = lista plana (agrupar apagado). */
  provider: Provider | null;
  /** Clave del título del grupo (`null` en la lista plana). */
  labelKey: Key | null;
  /** ¿Se pinta el encabezado? Solo con agrupación efectiva: ≥ 2 proveedores con cuentas y más de una sección visible. */
  heading: boolean;
  accounts: Account[];
  specialRows: SpecialRow[];
}

export const providerGroupKey = (p: Provider): Key =>
  p === 'codex' ? 'sidebar.accounts.group.codex' : p === 'opencode' ? 'sidebar.accounts.group.opencode' : 'sidebar.accounts.group.claude';

/** Cuántas cuentas hay de cada proveedor (sin filtros de ningún tipo). */
export function providerCounts(accounts: readonly Account[]): Record<Provider, number> {
  const n: Record<Provider, number> = { claude: 0, codex: 0, opencode: 0 };
  for (const a of accounts) n[providerOf(a)]++;
  return n;
}

/** El filtro guardado, o `all` si ese proveedor ya no tiene ninguna cuenta (o el valor no es válido). */
export function effectiveFilter(filter: AccountsFilter, accounts: readonly Account[]): AccountsFilter {
  if (filter === 'all' || !PROVIDERS.includes(filter)) return 'all';
  return providerCounts(accounts)[filter] > 0 ? filter : 'all';
}

/** Filtro de texto de la barra: nombre, email o proveedor contienen el texto (sin mayúsculas). */
export function matchesText(a: Account, text: string, email?: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  return [a.name, email, providerOf(a)].some((x) => x?.toLowerCase().includes(q));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Ordena una COPIA. Estable: los empates (y lo que no tiene dato) conservan el orden de entrada. */
export function sortAccounts(list: readonly Account[], sort: AccountsSort, ctx: Pick<ViewCtx, 'quota' | 'now'>): Account[] {
  const idx = new Map(list.map((a, i) => [a, i] as const));
  const byIdx = (a: Account, b: Account) => idx.get(a)! - idx.get(b)!;
  const out = [...list];
  if (sort === 'manual') return out;
  if (sort === 'name') return out.sort((a, b) => collator.compare(accountTitle(a), accountTitle(b)) || byIdx(a, b));
  // free / reset: solo Claude con dato entra en el orden; el resto (otros proveedores o sin dato) va al final tal como estaba.
  const key = (a: Account): number => {
    if (providerOf(a) !== 'claude') return Infinity;
    const q = ctx.quota[a.id];
    return sort === 'free' ? pressure(q, ctx.now) : nextReset(q, ctx.now);
  };
  const k = new Map(list.map((a) => [a, key(a)] as const));
  return out.sort((a, b) => {
    const ka = k.get(a)!, kb = k.get(b)!;
    if (ka === kb) return byIdx(a, b); // incluye Infinity === Infinity
    return ka < kb ? -1 : 1;
  });
}

/** Secciones a pintar. Las cuentas llegan en su orden guardado y NO se modifican. */
export function buildAccountView(accounts: readonly Account[], opts: ViewOpts, ctx: ViewCtx): Section[] {
  const filter = effectiveFilter(opts.filter, accounts);
  const text = ctx.text ?? '';
  const withRows = ctx.specialRows !== false;
  const shown = accounts.filter((a) =>
    (filter === 'all' || providerOf(a) === filter) && matchesText(a, text, ctx.emailOf?.(a)));
  const rowsFor = (p: Provider): SpecialRow[] => {
    if (!withRows || (filter !== 'all' && filter !== p)) return [];
    if (p === 'claude') return ['auto'];
    if (p === 'codex' && !ctx.hasDefaultCodex) return ['codex'];
    return [];
  };

  if (!opts.group) {
    const rows = PROVIDERS.flatMap(rowsFor);
    return [{ provider: null, labelKey: null, heading: false, accounts: sortAccounts(shown, opts.sort, ctx), specialRows: rows }];
  }

  const sections: Section[] = [];
  for (const p of PROVIDERS) {
    const mine = shown.filter((a) => providerOf(a) === p);
    const rows = rowsFor(p);
    if (!mine.length && !rows.length) continue; // nada que enseñar: sin grupo vacío
    sections.push({ provider: p, labelKey: providerGroupKey(p), heading: false, accounts: sortAccounts(mine, opts.sort, ctx), specialRows: rows });
  }
  // Encabezados solo si de verdad hay varios proveedores con cuentas y se ven varios grupos (con uno solo sobran).
  const providersWithAccounts = PROVIDERS.filter((p) => providerCounts(accounts)[p] > 0).length;
  if (providersWithAccounts >= 2 && sections.length >= 2) for (const s of sections) s.heading = true;
  return sections;
}
