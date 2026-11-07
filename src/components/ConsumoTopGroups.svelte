<script lang="ts">
  // Bloques más caros AGRUPADOS POR ORIGEN (todas las lecturas de CLAUDE.md juntas, todos los `cargo test`…), con
  // «% del total» del periodo o de la sesión: lo que explica de verdad del gasto. Cada origen se despliega y enseña
  // sus bloques con la cuenta de cada uno (ConsumoTop). Mismo agrupado que el informe para la IA.
  import type { ConsumoTopBlock, ConsumoOrigin } from '../lib/backend.ts';
  import { tick } from 'svelte';
  import { originGroups, originDomId, midPath, groupFill, groupOf, fmtTok, fmtUnit, fmtPct, fmtNum, shortPath, projectKeyOf, langOf, type Unit } from '../lib/consumo.ts';
  import { t, tk, tn, getLocale } from '../lib/i18n.ts';
  import ConsumoTop from './ConsumoTop.svelte';

  type TopRow = ConsumoTopBlock & { whoType?: string | null };
  let { rows, origins, unit, total, home = '', projectKey = '', showWho = true, limit = 5, pathMax = 56 }: {
    rows: TopRow[]; origins?: ConsumoOrigin[]; unit: Unit; total: number; home?: string; projectKey?: string; showWho?: boolean; limit?: number; pathMax?: number;
  } = $props();
  const lang = $derived(langOf(getLocale()));
  // Filas = orígenes de Rust (las mismas cifras que citan los consejos y el informe).
  const groups = $derived(originGroups(origins, rows, unit, total));
  let more = $state(false);
  let open = $state<string | null>(null);
  const shown = $derived(more ? groups : groups.slice(0, limit));
  const origin = (g: (typeof groups)[number]) => shortPath(g.origin, projectKey || g.key.split('|')[1] || projectKeyOf(g.items[0]?.session), '', home);
  // «Ver su fila» desde un consejo: abre el origen (y «ver más» si hace falta) y lo trae a la vista.
  $effect(() => {
    const go = async (e: Event) => {
      const key = (e as CustomEvent<string>).detail;
      const i = groups.findIndex((g) => g.key === key);
      if (i < 0) return;
      if (i >= limit) more = true;
      open = key;
      await tick();
      document.getElementById(originDomId(key))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    window.addEventListener('consumo-origin', go);
    return () => window.removeEventListener('consumo-origin', go);
  });
</script>

{#if !groups.length}
  <div class="empty">{t('consumo.top.empty')}</div>
{:else}
  <table class="grp">
    <thead>
      <tr>
        <th class="o">{t('consumo.top.origin')}</th>
        <th class="n">{t('consumo.top.times')}</th>
        <th class="n">{t('consumo.top.tokens')}</th>
        <th class="n">{t('consumo.top.pctTotal')}</th>
        <th class="n c">{t('consumo.top.cost')}</th>
      </tr>
    </thead>
    <tbody>
      {#each shown as g (g.key)}
        {@const o = origin(g)}
        <tr class="row" class:open={open === g.key} id={originDomId(g.key)}>
          <td class="o">
            <button type="button" class="ob" aria-expanded={open === g.key} title={`${g.tool ?? tk(`consumo.cat.${g.cat}`)} · ${o}`} onclick={() => (open = open === g.key ? null : g.key)}>
              <span class="car" aria-hidden="true">{open === g.key ? '▾' : '▸'}</span>
              <i style:background={groupFill(groupOf(g.cat))}></i>
              <span class="tool">{g.tool ?? tk(`consumo.cat.${g.cat}`)}</span>
              {#if o !== g.tool}<span class="det" title={o}>{midPath(o, pathMax)}</span>{/if}
            </button>
          </td>
          <td class="n">{fmtNum(g.n, lang)}</td>
          <td class="n">{fmtTok(g.t, lang)}</td>
          <td class="n">{fmtPct(g.pct, lang === 'es')}</td>
          <td class="n c">{fmtUnit(g[unit], unit, lang)}</td>
        </tr>
        {#if open === g.key}
          <tr class="sub"><td colspan="5">
            <div class="subw">
              <div class="subh">{tn('consumo.top.instances', g.n)}</div>
              {#if g.items.length}
                <ConsumoTop rows={g.items} {unit} {home} {projectKey} {showWho} limit={10} />
              {:else}
                <div class="subh">{t('consumo.top.noItems')}</div>
              {/if}
            </div>
          </td></tr>
        {/if}
      {/each}
    </tbody>
  </table>
  {#if groups.length > limit}
    <button class="more" onclick={() => (more = !more)}>{more ? t('consumo.top.less') : t('consumo.top.more', { n: groups.length })}</button>
  {/if}
{/if}

<style>
  .empty { color: var(--faint); font-size: 12px; }
  .grp { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
  th { text-align: left; font-weight: 500; color: var(--faint); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; padding: 0 6px 6px; border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  th.n { text-align: right; }
  td { padding: 4px 6px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); vertical-align: middle; }
  tr.row:hover td { background: color-mix(in srgb, var(--text) 4%, transparent); }
  th:not(.o), td:not(.o) { width: 88px; }
  th.c, td.c { width: 96px; }
  .n { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
  td.c { color: var(--text); }
  .ob { display: flex; align-items: center; gap: 7px; min-width: 0; width: 100%; text-align: left; color: inherit; }
  .ob:hover .det { color: var(--text); }
  .car { color: var(--muted); font-size: 10px; width: 10px; flex: none; }
  .ob i { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .tool { color: var(--text); flex: none; max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* C11: la ruta en UNA línea, cortada por la mitad (midPath conserva el nombre); la completa en el tooltip. */
  .det { color: var(--muted); font-family: var(--mono, ui-monospace, Consolas, monospace); font-size: 11px; white-space: nowrap; min-width: 0; }
  tr.sub td { background: var(--bg); padding: 6px 8px 10px 24px; }
  .subw { display: grid; gap: 6px; }
  .subh { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .more { justify-self: start; font-size: 11.5px; color: var(--accent); padding: 4px 0; }
</style>
