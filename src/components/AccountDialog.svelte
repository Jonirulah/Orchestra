<script lang="ts">
  import { app } from '../lib/store.svelte.ts';
  import { accountDir, displayName, providerLabel } from '../lib/model.ts';
  import type { Account, Provider } from '../lib/model.ts';
  import { ADDABLE } from '../lib/providers.ts';
  import { t } from '../lib/i18n.ts';
  import Seg from './Seg.svelte';

  // Frases con marcado: {dir}, {login}, {line} y {flag} se pintan como <code>; **...** como negrita (ver locales/en/dialogs.ts).
  const SPLIT = '\u0001';
  const hintFolder = t('dialogs.account.hintFolder', { dir: SPLIT }).split(SPLIT);
  const hintShared = t('dialogs.account.hintShared').split('**');
  const hintLogin = t('dialogs.account.hintLogin', { login: SPLIT }).split(SPLIT);
  const codexFolder = t('dialogs.account.codexHintFolder', { dir: SPLIT }).split(SPLIT);
  const codexStore = t('dialogs.account.codexHintStore', { line: SPLIT }).split(SPLIT);
  const codexLogin = t('dialogs.account.codexHintLogin', { login: SPLIT }).split(SPLIT);
  const ocFolder = t('dialogs.account.opencodeHintFolder', { dir: SPLIT }).split(SPLIT);
  const ocIsolation = t('dialogs.account.opencodeHintIsolation', { flag: SPLIT }).split(SPLIT);
  const ocLogin = t('dialogs.account.opencodeHintLogin', { login: SPLIT }).split(SPLIT);

  let provider = $state<Provider>('claude');
  let name = $state('');
  let useDefault = $state(false);
  let busy = $state(false);
  let error = $state('');
  /** Cuenta de Codex/opencode ya creada: el diálogo pasa a ofrecer «Iniciar sesión». */
  let created = $state<Account | null>(null);

  const isClaude = $derived(provider === 'claude');
  const dir = $derived(accountDir(provider, app.home, name || 'name'));
  const defaultTaken = $derived(!isClaude && useDefault && app.hasDefaultAccount(provider));
  const defaultName = $derived(provider === 'codex' ? t('dialogs.account.defaultNameCodex') : t('dialogs.account.defaultNameOpencode'));
  const finalName = $derived(name.trim() || (useDefault ? defaultName : ''));
  const clash = $derived(!(useDefault && !isClaude) && app.accounts.some((a) => a.dir.toLowerCase() === dir.toLowerCase()));
  const installed = $derived(provider === 'codex' ? app.providers?.codexInstalled : provider === 'opencode' ? app.providers?.opencodeInstalled : true);
  const options = $derived(ADDABLE.map((p) => ({ id: p, label: p === 'codex' ? 'Codex (ChatGPT)' : providerLabel(p) }))); // i18n-ignore: product names

  function pick(p: Provider) { provider = p; useDefault = false; error = ''; }

  async function create() {
    if (!finalName || clash || defaultTaken || busy) return;
    busy = true;
    error = '';
    try {
      if (isClaude) {
        await app.addAccount(name);
        app.accountDialog = false;
      } else {
        created = await app.addProviderAccount(provider as 'codex' | 'opencode', finalName, { useDefault });
      }
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  function signIn() {
    if (created) app.signIn(created.id);
    app.accountDialog = false;
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') app.accountDialog = false; }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-back" onpointerdown={(e) => { if (e.target === e.currentTarget) app.accountDialog = false; }}>
  <div class="modal">
    <h2>{created ? t('dialogs.account.doneTitle', { name: displayName(created.name) }) : t('dialogs.account.title')}</h2>
    {#if created}
      <div class="body">
        <p class="hint">{t('dialogs.account.doneHint')}</p>
      </div>
      <div class="foot">
        <button class="btn ghost" onclick={() => (app.accountDialog = false)}>{t('dialogs.account.later')}</button>
        <button class="btn primary" onclick={signIn}>{t('dialogs.account.signIn')}</button>
      </div>
    {:else}
      <div class="body">
        <div class="field"><span>{t('dialogs.account.providerLabel')}</span><Seg {options} value={provider} onchange={pick} /></div>
        {#if !isClaude}
          <label class="chk">
            <input type="checkbox" bind:checked={useDefault} disabled={app.hasDefaultAccount(provider)} />
            {provider === 'codex' ? t('dialogs.account.codexUseDefault') : t('dialogs.account.opencodeUseDefault')}
          </label>
          {#if useDefault}
            <p class="hint">{provider === 'codex' ? t('dialogs.account.codexUseDefaultHint') : t('dialogs.account.opencodeUseDefaultHint')}</p>
          {/if}
        {/if}
        <label class="field"><span>{t('dialogs.account.nameLabel')}</span><input bind:value={name} placeholder={useDefault && !isClaude ? defaultName : t('dialogs.account.namePlaceholder')} onkeydown={(e) => e.key === 'Enter' && create()} /></label>

        {#if isClaude}
          <p class="hint">
            {hintFolder[0]}<code>{dir}</code>{hintFolder[1]}
            {#each hintShared as seg, i}{#if i % 2}<b>{seg}</b>{:else}{seg}{/if}{/each}
            {hintLogin[0]}<code>/login</code>{hintLogin[1]}<!-- i18n-ignore: command name -->
          </p>
        {:else if provider === 'codex' && !useDefault}
          <p class="hint">{codexFolder[0]}<code>{dir}</code>{codexFolder[1]}</p>
          <p class="hint">{codexStore[0]}<code>cli_auth_credentials_store = "file"</code>{codexStore[1]}<!-- i18n-ignore: config line --></p>
          <p class="hint">{codexLogin[0]}<code>codex login</code>{codexLogin[1]}<!-- i18n-ignore: command name --></p>
        {:else if provider === 'opencode' && !useDefault}
          <p class="hint">{ocFolder[0]}<code>{dir}</code>{ocFolder[1]}</p>
          <p class="hint">{ocIsolation[0]}<code>--standalone</code>{ocIsolation[1]}<!-- i18n-ignore: CLI flag --></p>
          <p class="hint">{ocLogin[0]}<code>opencode auth login</code>{ocLogin[1]}<!-- i18n-ignore: command name --></p>
        {/if}
        {#if !isClaude && installed === false}<p class="hint" style="color:var(--warn)">{t('dialogs.account.notInstalled')}</p>{/if}
        {#if clash}<p class="hint" style="color:var(--bad)">{t('dialogs.account.clash')}</p>{/if}
        {#if defaultTaken}<p class="hint" style="color:var(--bad)">{t('dialogs.account.defaultTaken')}</p>{/if}
        {#if error}<p class="hint" style="color:var(--bad)">{error}</p>{/if}
      </div>
      <div class="foot">
        <button class="btn ghost" onclick={() => (app.accountDialog = false)}>{t('dialogs.account.cancel')}</button>
        <button class="btn primary" disabled={!finalName || clash || defaultTaken || busy} onclick={create}>{isClaude ? t('dialogs.account.claudeCreateOpen') : t('dialogs.account.create')}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  code { color: var(--accent); user-select: text; }
  .btn:disabled { opacity: 0.4; pointer-events: none; }
  .chk { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text); }
</style>
