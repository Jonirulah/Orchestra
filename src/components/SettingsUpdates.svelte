<script lang="ts">
  // Ajustes → General: actualizaciones (lógica en updater.svelte.ts).
  import { app } from '../lib/store.svelte.ts';
  import { updater } from '../lib/updater.svelte.ts';
  import { t, tk } from '../lib/i18n.ts';
  import Toggle from './Toggle.svelte';

  const u = updater;
  // El resultado solo se enseña tras pulsar «Buscar ahora» (el automático avisa con el chip).
  let asked = $state(false);
  function checkNow() { asked = true; void u.check(true); }
</script>

<div class="s-row">
  <div class="lbl">
    <b>{t('updater.settings.autoLabel')}</b>
    <small>{t('updater.settings.autoHint')}</small>
  </div>
  <div class="ctl"><Toggle value={app.settings.autoUpdate} label={t('updater.settings.autoLabel')} onchange={(v) => app.setting('autoUpdate', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl">
    <b>{t('updater.settings.checkLabel')}</b>
    <small>{u.portable ? t('updater.settings.checkHintPortable', { version: u.current }) : t('updater.settings.checkHint', { version: u.current })}</small>
    {#if asked && u.status === 'latest'}
      <p class="s-msg" role="status">{t('updater.settings.latest')}</p>
    {:else if asked && u.status === 'available' && u.info}
      <p class="s-msg" role="status">{t('updater.settings.available', { version: u.info.version })} <button class="lnk" onclick={() => u.openDialog()}>{t('updater.settings.show')}</button></p>
    {:else if asked && u.status === 'error' && u.errorKind}
      <p class="s-msg err" role="alert">{tk(`updater.error.${u.errorKind}`)}{#if u.errorText}<small>{u.errorText}</small>{/if}</p>
    {/if}
  </div>
  <div class="ctl">
    <button class="btn" disabled={u.status === 'checking' || u.status === 'downloading' || u.status === 'installing'} onclick={checkNow}>
      {u.status === 'checking' ? t('updater.settings.checking') : t('updater.settings.checkNow')}
    </button>
  </div>
</div>

<style>
  .lnk { color: inherit; text-decoration: underline; font-weight: 600; }
  .s-msg small { display: block; margin-top: 4px; opacity: 0.8; word-break: break-word; }
</style>
