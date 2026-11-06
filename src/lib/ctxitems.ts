// Qué elementos lleva cada menú contextual. Puro: recibe las acciones ya hechas (las del store) y devuelve el modelo.
// Se prueba con node --test; el componente (ContextMenu.svelte) solo pinta.
import { ACCOUNT_COLORS, PRESETS, accountTitle, providerOf } from './model.ts';
import type { Account, Provider } from './model.ts';
import { ACCOUNTS_SORTS, providerGroupKey } from './accountview.ts';
import type { AccountsFilter, AccountsSort } from './accountview.ts';
import { sep, tidy } from './ctxmenu.ts';
import type { MenuItem } from './ctxmenu.ts';
import { t, tk } from './i18n.ts';

export interface AccountMenuCtx {
  account: Account;
  /** Claude: tiene sesión (perfil leído de su carpeta). Codex / opencode: veredicto guardado. */
  signedIn: boolean;
  /** Hay una comprobación de sesión en marcha (solo Codex / opencode). */
  checking: boolean;
  openTerminal(): void;
  /** Claude: abre `claude` (ahí se escribe /login). Codex / opencode: abre su inicio de sesión. */
  signIn(): void;
  check(): void;
  rename(): void;
  /** Atajo que se muestra junto a «Rename» (solo donde exista: la barra lateral tiene F2). */
  renameHint?: string;
  setColor(color: string): void;
  openFolder(): void;
  copyPath(): void;
  remove(): void;
}

/** Menú de una cuenta. Solo ofrece lo que existe para su proveedor (la comprobación de sesión no la hay en Claude). */
export function accountMenu(c: AccountMenuCtx): MenuItem[] {
  const claude = providerOf(c.account) === 'claude';
  const items: MenuItem[] = [
    { id: 'open', label: t('ctx.account.newTerminal'), run: c.openTerminal },
    claude
      ? { id: 'signin', label: c.signedIn ? t('ctx.account.signInAgain') : t('ctx.account.signIn'), hint: '/login', run: c.signIn }
      : { id: 'signin', label: c.signedIn ? t('ctx.account.signInAgain') : t('ctx.account.signIn'), run: c.signIn },
  ];
  if (!claude) {
    items.push({ id: 'check', label: c.checking ? t('ctx.account.checking') : t('ctx.account.check'), disabled: c.checking, run: c.check });
  }
  items.push(
    sep('s1'),
    { id: 'rename', label: t('ctx.account.rename'), hint: c.renameHint, run: c.rename },
    {
      id: 'color',
      label: t('ctx.account.color'),
      swatch: c.account.color,
      children: ACCOUNT_COLORS.map((col, i) => ({
        id: `color:${col}`,
        label: tk(`ctx.color.${COLOR_KEYS[i] ?? 'other'}`),
        swatch: col,
        checked: col === c.account.color,
        run: () => c.setColor(col),
      })),
    },
    sep('s2'),
    { id: 'folder', label: t('ctx.account.openFolder'), run: c.openFolder },
    { id: 'copy', label: t('ctx.account.copyPath'), run: c.copyPath },
    sep('s3'),
    { id: 'remove', label: t('ctx.account.remove'), danger: true, confirm: t('ctx.confirm'), run: c.remove },
  );
  return tidy(items);
}

/** Nombres de los 8 colores de ACCOUNT_COLORS, en el mismo orden. */
export const COLOR_KEYS = ['amber', 'blue', 'green', 'purple', 'red', 'cyan', 'orange', 'pink'] as const;

export interface BgMenuCtx {
  accounts: Account[];
  /** Hay algún terminal local al que lanzar «New terminal here». */
  hasShell: boolean;
  cols: number;
  rows: number;
  newTerminal(): void;
  newSsh(): void;
  newClaudeAuto(): void;
  hasClaude: boolean;
  openAccount(a: Account): void;
  setLayout(cols: number, rows: number): void;
  equalize(): void;
}

/** Menú del fondo de la cuadrícula (celda vacía o hueco entre paneles). Siete filas elegibles como mucho. */
export function backgroundMenu(c: BgMenuCtx): MenuItem[] {
  const items: MenuItem[] = [
    { id: 'term', label: t('ctx.bg.newTerminal'), disabled: !c.hasShell, run: c.newTerminal },
    { id: 'ssh', label: t('ctx.bg.newSsh'), run: c.newSsh },
    { id: 'claude', label: t('ctx.bg.newClaude'), disabled: !c.hasClaude, run: c.newClaudeAuto },
    {
      id: 'accounts',
      label: t('ctx.bg.withAccount'),
      disabled: !c.accounts.length,
      children: c.accounts.map((a) => ({
        id: `acc:${a.id}`,
        label: accountTitle(a),
        swatch: a.color,
        run: () => c.openAccount(a),
      })),
    },
    sep('s1'),
    {
      id: 'layout',
      label: t('ctx.bg.layout', { cols: c.cols, rows: c.rows }),
      children: [
        ...PRESETS.map((p) => ({
          id: `layout:${p.id}`,
          label: p.label,
          checked: p.cols === c.cols && p.rows === c.rows,
          run: () => c.setLayout(p.cols, p.rows),
        })),
      ],
    },
    { id: 'equalize', label: t('ctx.bg.equalize'), run: c.equalize },
  ];
  return tidy(items);
}

export interface SidebarMenuCtx {
  addAccount(): void;
  newHost(): void;
  importable: number;
  importHosts(): void;
  settings(): void;
}

/** Menú del fondo de la barra lateral (donde no hay ninguna fila). */
export function sidebarMenu(c: SidebarMenuCtx): MenuItem[] {
  return tidy([
    { id: 'addAccount', label: t('ctx.side.addAccount'), run: c.addAccount },
    { id: 'newHost', label: t('ctx.side.newHost'), run: c.newHost },
    { id: 'import', label: c.importable ? t('ctx.side.importCount', { n: c.importable }) : t('ctx.side.import'), disabled: !c.importable, run: c.importHosts },
    sep('s1'),
    { id: 'settings', label: t('ctx.side.settings'), hint: 'Ctrl+,', run: c.settings },
  ]);
}

export interface AccountsViewMenuCtx {
  /** Filtro EFECTIVO (ya con `effectiveFilter`), para que la marca coincida con lo que se ve. */
  filter: AccountsFilter;
  sort: AccountsSort;
  group: boolean;
  /** Cuentas por proveedor: sin cuentas, esa opción de «Mostrar» no se puede elegir. */
  counts: Record<Provider, number>;
  setSort(s: AccountsSort): void;
  setGroup(on: boolean): void;
  setFilter(f: AccountsFilter): void;
}

/** Menú del botón de ordenar/agrupar de la sección Cuentas: «Ordenar por» (submenú), «Agrupar por proveedor» y «Mostrar: …». */
export function accountsViewMenu(c: AccountsViewMenuCtx): MenuItem[] {
  const provs: Provider[] = ['claude', 'codex', 'opencode'];
  return tidy([
    {
      id: 'sort',
      label: t('ctx.accountsView.sortBy'),
      children: ACCOUNTS_SORTS.map((s) => ({ id: `sort:${s}`, label: tk(`ctx.accountsView.sort.${s}`), checked: c.sort === s, run: () => c.setSort(s) })),
    },
    sep('s1'),
    { id: 'group', label: t('ctx.accountsView.group'), checked: c.group, run: () => c.setGroup(!c.group) },
    sep('s2'),
    { id: 'show:all', label: t('ctx.accountsView.show', { name: t('ctx.accountsView.all') }), checked: c.filter === 'all', run: () => c.setFilter('all') },
    ...provs.map((p): MenuItem => ({
      id: `show:${p}`,
      label: t('ctx.accountsView.show', { name: t(providerGroupKey(p)) }),
      checked: c.filter === p,
      disabled: c.counts[p] === 0,
      run: () => c.setFilter(p),
    })),
  ]);
}
