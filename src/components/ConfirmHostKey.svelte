<script lang="ts">
  import { app } from '../lib/store.svelte.ts';
  import { t } from '../lib/i18n.ts';

  const p = $derived(app.hostKeyPrompt!);
  const address = $derived(p.probe ? `${p.probe.host}:${p.probe.port}` : `${p.host.host}:${p.host.port ?? 22}`);
  const blocked = $derived(p.phase === 'jump' || p.phase === 'alias' || p.phase === 'error');

  function focusMe(el: HTMLElement) { el.focus(); }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); app.cancelHostKey(); } }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-back" onpointerdown={(e) => { if (e.target === e.currentTarget) app.cancelHostKey(); }}>
  <div class="modal" role="dialog" aria-modal="true" aria-label={t('hostkey.confirm.aria')} tabindex="-1" use:focusMe>
    <h2>{p.phase === 'confirm' ? t('hostkey.confirm.titleConfirm') : t('hostkey.confirm.titleOther')}</h2>
    <div class="body">
      <div class="who">
        <b>{p.host.name || p.host.host}</b>
        <span class="addr">{address}</span>
      </div>

      {#if p.phase === 'checking'}
        <p class="hint" role="status">{t('hostkey.confirm.checking')}</p>
      {:else if p.phase === 'confirm' && p.probe}
        <p class="hint">{p.probe.keys.length > 1 ? t('hostkey.confirm.newMany') : t('hostkey.confirm.newOne')}</p>
        <div class="fps" data-testid="hostkey-fingerprints">
          {#each p.probe.keys as k (k.algo)}
            <div class="fp"><span class="kt">{k.keyType}</span><code>{k.fingerprint}</code></div>
          {/each}
        </div>
        <p class="warn">{t('hostkey.confirm.warning')}</p>
        {#if p.message}<p class="err" role="alert">{p.message}</p>{/if}
      {:else}
        <p class={p.phase === 'error' ? 'err' : 'warn'} role="alert">{p.message}</p>
      {/if}
    </div>
    <div class="foot">
      {#if p.phase === 'confirm'}
        <button class="btn ghost" onclick={() => app.cancelHostKey()}>{t('hostkey.confirm.cancel')}</button>
        <button class="btn primary" disabled={p.busy} onclick={() => app.acceptHostKey()}>{t('hostkey.confirm.trust')}</button>
      {:else if blocked}
        <button class="btn primary" onclick={() => app.cancelHostKey()}>{t('hostkey.confirm.close')}</button>
      {:else}
        <button class="btn ghost" onclick={() => app.cancelHostKey()}>{t('hostkey.confirm.cancel')}</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .who { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .addr { color: var(--muted); font: 12px 'Cascadia Mono', Consolas, monospace; }
  .fps { display: grid; gap: 6px; padding: 9px 11px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--border); }
  .fp { display: grid; grid-template-columns: 64px 1fr; gap: 10px; align-items: baseline; }
  .kt { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  code { font: 12px 'Cascadia Mono', Consolas, monospace; user-select: text; overflow-wrap: anywhere; }
  .warn { margin: 0; padding: 8px 11px; border-radius: 7px; font-size: 12px; line-height: 1.4; color: var(--text); background: rgba(245, 185, 66, 0.1); border: 1px solid rgba(245, 185, 66, 0.4); }
  .err { margin: 0; color: var(--bad); font-size: 12px; line-height: 1.4; user-select: text; }
  .btn:disabled { opacity: 0.4; pointer-events: none; }
</style>
