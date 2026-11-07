<script lang="ts">
  import { app } from '../lib/store.svelte.ts';
  import * as T from '../lib/terminals.ts';
  import { SHORTCUTS, comboText } from '../lib/shortcuts.ts';
  import { t } from '../lib/i18n.ts';
  import type { SectionId } from '../lib/settings.ts';
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';
  import SettingsGeneral from './SettingsGeneral.svelte';
  import SettingsTerminal from './SettingsTerminal.svelte';
  import SettingsAgents from './SettingsAgents.svelte';
  import SettingsAccounts from './SettingsAccounts.svelte';
  import SettingsData from './SettingsData.svelte';
  import SettingsMcp from './SettingsMcp.svelte';
  import SettingsMcpServers from './SettingsMcpServers.svelte';
  import SettingsKeys from './SettingsKeys.svelte';

  type Tab = 'general' | 'terminal' | 'agents' | 'accounts' | 'mcpservers' | 'sshkeys' | 'mcp' | 'shortcuts' | 'data';
  const TABS: { id: Tab; label: string; icon: string; sub: string }[] = [
    { id: 'general', label: t('settings.dialog.tabGeneral'), icon: 'gear', sub: t('settings.dialog.subGeneral') },
    { id: 'terminal', label: t('settings.dialog.tabTerminal'), icon: 'terminal', sub: t('settings.dialog.subTerminal') },
    { id: 'agents', label: t('settings.dialog.tabAgents'), icon: 'bot', sub: t('settings.dialog.subAgents') },
    { id: 'accounts', label: t('settings.dialog.tabAccounts'), icon: 'user', sub: t('settings.dialog.subAccounts') },
    // Junto a Cuentas: sus columnas son las cuentas. Pestaña propia porque la tabla necesita todo el ancho del panel.
    { id: 'mcpservers', label: t('settings.dialog.tabMcpServers'), icon: 'layers', sub: t('settings.dialog.subMcpServers') },
    { id: 'sshkeys', label: t('settings.dialog.tabSshKeys'), icon: 'key', sub: t('settings.dialog.subSshKeys') },
    { id: 'mcp', label: t('settings.dialog.tabMcp'), icon: 'plug', sub: t('settings.dialog.subMcp') },
    { id: 'shortcuts', label: t('settings.dialog.tabShortcuts'), icon: 'keyboard', sub: t('settings.dialog.subShortcuts') },
    { id: 'data', label: t('settings.dialog.tabData'), icon: 'database', sub: t('settings.dialog.subData') },
  ];

  // La sección vive en el store: cambiar de idioma remonta el diálogo y debe seguir en la misma.
  let tab = $state<Tab>(TABS.some((x) => x.id === app.settingsTab) ? (app.settingsTab as Tab) : 'general');
  $effect(() => { app.settingsTab = tab; });
  /** Sube al reiniciar una sección: vuelve a montarla para que sus controles locales se reinicien. */
  let rev = $state(0);
  const cur = $derived(TABS.find((x) => x.id === tab)!);
  const resettable = $derived(tab === 'general' || tab === 'terminal' || tab === 'agents' || tab === 'accounts' || tab === 'sshkeys');

  function close() {
    app.settingsOpen = false;
    window.setTimeout(() => { const id = app.active?.focusId; if (id) T.focus(id); }, 0);
  }
  function resetSection() {
    if (!resettable) return;
    app.resetSettingsSection(tab as SectionId);
    rev++;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || app.accountDialog) return;
    e.preventDefault();
    close();
  }
  function focusMe(el: HTMLElement) { el.focus(); }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-back settings-back" onpointerdown={(e) => { if (e.target === e.currentTarget) close(); }}>
  <div class="modal settings" role="dialog" aria-modal="true" aria-label={t('settings.dialog.aria')} tabindex="-1" use:focusMe>
    <nav class="s-nav" aria-label={t('settings.dialog.navAria')}>
      <div class="s-brand">
        <Logo size={38} />
        <div class="s-brandtxt">
          <h2>{t('settings.dialog.title')}</h2>
          <small>Orchestra</small> <!-- i18n-ignore: product name -->
        </div>
      </div>
      {#each TABS as tb (tb.id)}
        <button type="button" class:on={tab === tb.id} title={tb.sub} onclick={() => (tab = tb.id)}><span class="s-ico"><Icon name={tb.icon} size={16} /></span> {tb.label}</button>
      {/each}
      <span class="grow"></span>
      <span class="s-key">{t('settings.dialog.keyHint')}</span>
    </nav>

    <section class="s-pane">
      <header>
        <div>
          <h3>{cur.label}</h3>
          <small>{cur.sub}</small>
        </div>
        <span class="grow"></span>
        {#if resettable}<button type="button" class="s-link" onclick={resetSection}>{t('settings.dialog.resetSection')}</button>{/if}
        <button type="button" class="iconbtn" title={t('settings.dialog.closeTitle')} aria-label={t('settings.dialog.closeAria')} onclick={close}><Icon name="x" size={14} /></button>
      </header>

      <div class="s-body">
        {#key `${tab}-${rev}`}
          {#if tab === 'general'}<SettingsGeneral />
          {:else if tab === 'terminal'}<SettingsTerminal />
          {:else if tab === 'agents'}<SettingsAgents />
          {:else if tab === 'accounts'}<SettingsAccounts onclose={close} />
          {:else if tab === 'sshkeys'}<SettingsKeys onclose={close} />
          {:else if tab === 'mcpservers'}<SettingsMcpServers />
          {:else if tab === 'mcp'}<SettingsMcp />
          {:else if tab === 'data'}<SettingsData />
          {:else}
            {#each SHORTCUTS as g (g.titleKey)}
              <h4 class="s-group">{t(g.titleKey)}</h4>
              <table class="s-keys">
                <tbody>
                  {#each g.items as it (it.keys)}
                    <tr><td class="k">{#each it.keys.split('  /  ') as part, i (i)}{#if i > 0}<span class="or">{t('settings.dialog.or')}</span>{/if}<kbd>{comboText(part)}</kbd>{/each}</td><td>{t(it.whatKey)}</td></tr>
                  {/each}
                </tbody>
              </table>
            {/each}
            <p class="hint">{t('settings.dialog.shortcutsHint')}</p>
          {/if}
        {/key}
      </div>
    </section>
  </div>
</div>
