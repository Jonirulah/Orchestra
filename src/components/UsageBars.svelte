<script lang="ts">
  // Barras finas con la cuenta atrás hasta el reinicio: 5 h (solo si hay dato), 7 d y, si un límite activo de un modelo va
  // más gastado que el semanal general, una fila más con el nombre del modelo.
  // Solo spans: se puede poner dentro de un <button>.
  import { app } from '../lib/store.svelte.ts';
  import { usageViews } from '../lib/policy.ts';
  import { t } from '../lib/i18n.ts';
  import { staleTip } from '../lib/usageQuery.ts';

  let { accountId }: { accountId: string } = $props();

  const views = $derived(usageViews(app.quota[accountId], app.nowSec));
  const rows = $derived(
    views
      ? [
          { key: '5h', label: '5h', v: views.five, tip: '' },
          { key: '7d', label: '7d', v: views.seven, tip: '' },
          { key: 'x', label: views.extra?.label ?? '', v: views.extra?.view ?? null, tip: views.extra ? t('usage.bars.scopedTip', { name: views.extra.label }) : '' },
        ].filter((r) => r.v)
      : [],
  );
  // Si la consulta a Anthropic dice «token caducado» y los datos son viejos, el tooltip lo avisa (las filas no cambian de tamaño).
  const stale = $derived(staleTip(app.quota[accountId]?.at, app.usageStatus[accountId], app.nowSec));
  const waiting = $derived(!views && app.capturingUsage && app.hasLiveClaude(accountId));
</script>

{#if views}
  <span class="usage">
    {#each rows as r (r.key)}
      {#if r.v}
        {@const full = r.tip ? r.tip + '\n' + r.v.tip : r.v.tip}
        <span class="urow" class:stale={!!stale} class:scoped={r.key === 'x'} title={stale ? full + '\n' + stale : full}>
          <span class="ulbl">{r.label}</span>
          <span class="track"><span class="fill {r.v.level}" style:width="{r.v.pct}%"></span></span>
          <span class="upct {r.v.level}">{Math.round(r.v.pct)}%</span>
          <span class="uleft">{r.v.left}</span>
        </span>
      {/if}
    {/each}
  </span>
{:else if waiting}
  <span class="uwait">{t('usage.bars.waiting')}</span>
{/if}

<style>
  /* Columnas compartidas (subgrid): las barras empiezan en el mismo sitio aunque la etiqueta de un modelo sea más larga. */
  .usage { display: grid; grid-template-columns: minmax(14px, 44px) minmax(30px, 1fr) 26px 38px; column-gap: 5px; row-gap: 3px; margin-top: 3px; }
  .urow { display: grid; grid-template-columns: subgrid; grid-column: 1 / -1; align-items: center; }
  .urow.stale { opacity: 0.75; }
  .urow.scoped .track { height: 3px; }
  .ulbl { color: var(--muted); font-size: 9.5px; line-height: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track { height: 4px; border-radius: 2px; background: var(--border-strong); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: 2px; transition: width 0.4s ease; min-width: 1px; }
  .fill.ok { background: var(--ok); }
  .fill.warn { background: var(--warn); }
  .fill.bad { background: var(--bad); }
  .uleft { color: var(--muted); font-size: 9.5px; line-height: 1; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .upct { font-size: 9.5px; line-height: 1; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--muted); }
  .upct.warn { color: var(--warn); }
  .upct.bad { color: var(--bad); }
  .uwait { color: var(--faint); font-size: 10px; margin-top: 2px; }
</style>
