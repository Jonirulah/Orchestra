// Menú contextual de una cuenta con las acciones reales de la app. Lo usan la barra lateral y Ajustes → Cuentas.
import { app } from './store.svelte.ts';
import { openAccountDir } from './backend.ts';
import { accountMenu } from './ctxitems.ts';
import type { AccountMenuCtx } from './ctxitems.ts';
import { providerOf } from './model.ts';
import type { Account } from './model.ts';
import type { MenuItem } from './ctxmenu.ts';
import { t } from './i18n.ts';

async function copyPath(dir: string): Promise<void> {
  try { await navigator.clipboard.writeText(dir); app.toast(t('ctx.account.pathCopied')); }
  catch { app.toast(t('ctx.account.copyFailed')); }
}

/**
 * Elementos del menú de `a`. `rename` lo pone quien llama (cada sitio renombra a su manera: en línea en la barra,
 * en su campo de texto en Ajustes). `over` cambia otras acciones (en Ajustes, abrir un terminal cierra el diálogo).
 */
export function accountMenuFor(a: Account, rename: () => void, over: Partial<AccountMenuCtx> = {}): MenuItem[] {
  const claude = providerOf(a) === 'claude';
  return accountMenu({
    account: a,
    signedIn: claude ? !!app.profileOf(a)?.loggedIn : app.providerStatus[a.id]?.status === 'signedIn',
    checking: !!app.statusChecking[a.id],
    openTerminal: () => app.open(claude ? { kind: 'claude', accountId: a.id } : { kind: 'account', accountId: a.id }),
    signIn: () => (claude ? app.open({ kind: 'claude', accountId: a.id }) : app.signIn(a.id)),
    check: () => void app.refreshProviderStatus({ id: a.id, force: true }),
    rename,
    setColor: (c) => { const x = app.accountById(a.id); if (x) { x.color = c; app.persist(); } },
    openFolder: () => void openAccountDir(a.dir).catch((e) => app.toast(t('ctx.account.openFailed', { error: String(e).replace(/^Error: /, '') }))),
    copyPath: () => void copyPath(a.dir),
    // El menú ya pidió confirmación (clic doble): quitar solo olvida la cuenta, nunca borra su carpeta.
    remove: () => app.removeAccount(a.id),
    ...over,
  });
}
