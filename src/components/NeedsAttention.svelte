<script lang="ts">
  // Bloque «Necesitan atención» de la barra lateral: una fila por agente que espera respuesta (la lógica está en attention.ts).
  import { app } from '../lib/store.svelte.ts';
  import { fmtSince, waitRows } from '../lib/attention.ts';
  import { t } from '../lib/i18n.ts';
  import Icon from './Icon.svelte';

  let now = $state(Date.now());
  $effect(() => {
    const iv = window.setInterval(() => (now = Date.now()), 5000);
    return () => clearInterval(iv);
  });
  const rows = $derived(waitRows(app.agents, app.waitSince, now, (id) => app.paneById(id)?.title));
</script>

{#if rows.length}
  <div class="na" role="region" aria-label={t('attention.block.title', { n: rows.length })}>
    <div class="na-h">
      <Icon name="bell" size={12} />
      <span class="na-t">{t('attention.block.title', { n: rows.length })}</span>
      <kbd>Ctrl+Shift+A</kbd> <!-- i18n-ignore: combinación de teclas -->
    </div>
    {#each rows as r (r.paneId)}
      <button class="na-row" onclick={() => app.focusPane(r.paneId)} title={t('attention.block.rowTitle')}>
        <span class="na-name">{r.title}</span>
        <span class="na-since">{fmtSince(r.sinceSec)}</span>
        <span class="na-ask">{r.asks || t('attention.block.waiting')}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .na { margin: 6px 8px 4px; border: 1px solid color-mix(in srgb, var(--bad) 45%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--bad) 8%, var(--panel)); overflow: hidden; }
  .na-h { display: flex; align-items: center; gap: 6px; padding: 5px 8px; color: var(--bad); font-size: 11px; font-weight: 700; letter-spacing: 0.02em; }
  .na-t { flex: 1; min-width: 0; }
  kbd { font: inherit; font-size: 10px; font-weight: 500; color: var(--muted); border: 1px solid var(--border-strong); border-radius: 4px; padding: 0 4px; }
  .na-row { display: grid; grid-template-columns: 1fr auto; column-gap: 8px; width: 100%; padding: 4px 8px 5px 10px; text-align: left; border-top: 1px solid color-mix(in srgb, var(--bad) 18%, transparent); position: relative; }
  .na-row::before { content: ''; position: absolute; left: 0; top: 5px; bottom: 5px; width: 2px; border-radius: 2px; background: var(--bad); }
  .na-row:hover { background: color-mix(in srgb, var(--bad) 14%, transparent); }
  .na-name { font-size: 12px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .na-since { font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; align-self: center; }
  .na-ask { grid-column: 1 / -1; font-size: 11px; color: var(--muted); font-family: var(--mono, ui-monospace, monospace); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
