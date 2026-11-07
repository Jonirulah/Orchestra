<script lang="ts">
  // Tabla de los bloques más caros: herramienta, ruta o comando abreviado (~ y <proyecto>, cortado por el medio
  // conservando el fichero; la ruta entera en el tooltip), quién, tokens, relecturas y coste real con su fórmula.
  import type { ConsumoTopBlock } from '../lib/backend.ts';
  import {
    groupFill, groupOf, fmtTok, fmtUnit, fmtUsd, fmtNum, fmtWeight, costFormula, shortPath, midPath, projectKeyOf, whoType, langOf, type Unit,
  } from '../lib/consumo.ts';
  import { t, tk, getLocale } from '../lib/i18n.ts';

  type TopRow = ConsumoTopBlock & { whoType?: string | null };
  let { rows, unit, home = '', projectKey = '', showWho = true, limit = 0 }: {
    rows: TopRow[]; unit: Unit; home?: string; projectKey?: string; showWho?: boolean; limit?: number;
  } = $props();
  const lang = $derived(langOf(getLocale()));
  let more = $state(false);
  let tip = $state<number | null>(null);
  const NL = String.fromCharCode(10);
  const shown = $derived(limit > 0 && !more ? rows.slice(0, limit) : rows);

  function what(b: TopRow): string {
    const key = projectKey || projectKeyOf(b.session);
    return b.detail ? shortPath(b.detail, key, '', home) : '';
  }
  function who(b: TopRow): string {
    const w = b.whoType !== undefined ? b.whoType : whoType(b.who);
    return w ?? t('consumo.row.main');
  }
  /** Fórmula con los pesos reales: reproduce el número de la columna. */
  function formula(b: TopRow): string {
    const f = costFormula(b);
    const lines = [t('consumo.top.formula', {
      t: fmtNum(f.t, lang), w: fmtWeight(f.w, lang), n: fmtNum(f.n, lang), r: fmtWeight(f.r, lang), total: fmtNum(f.total, lang),
    })];
    if (f.w === 0) lines.push(t('consumo.top.formulaBefore'));
    else lines.push(t('consumo.top.formulaTtl'));
    lines.push(t('consumo.top.formulaUsd', { usd: fmtUsd(b.usd, lang) }));
    return lines.join(NL);
  }
</script>

{#if !rows.length}
  <div class="empty">{t('consumo.top.empty')}</div>
{:else}
  <table class="top">
    <thead>
      <tr>
        <th class="b">{t('consumo.top.block')}</th>
        {#if showWho}<th class="w">{t('consumo.top.who')}</th>{/if}
        <th class="n">{t('consumo.top.tokens')}</th>
        <th class="n">{t('consumo.top.rereads')}</th>
        <th class="n c">{t('consumo.top.cost')}</th>
      </tr>
    </thead>
    <tbody>
      {#each shown as b, i (i)}
        {@const d = what(b)}
        {@const tool = b.tool ?? tk(`consumo.cat.${b.cat}`)}
        <tr>
          <td class="b" title={d ? `${tool} · ${d}` : tool}>
            <div class="bw">
              <i style:background={groupFill(groupOf(b.cat))}></i>
              <span class="tool">{tool}</span>
              {#if d}<span class="det">{midPath(d, 64)}</span>{/if}
            </div>
          </td>
          {#if showWho}<td class="who" title={who(b)}>{who(b)}</td>{/if}
          <td class="n">{fmtTok(b.t, lang)}</td>
          <td class="n">{fmtNum(b.rereads, lang)}</td>
          <td class="n c">
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <span class="fx" tabindex="0" role="note" aria-label={formula(b)} onpointerenter={() => (tip = i)} onpointerleave={() => (tip = null)}
              onfocus={() => (tip = i)} onblur={() => (tip = null)}>{fmtUnit(b[unit], unit, lang)}</span>
            {#if tip === i}<div class="ftip">{#each formula(b).split(NL) as l, j (j)}<div class:mut={j > 0}>{l}</div>{/each}</div>{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if limit > 0 && rows.length > limit}
    <button class="more" onclick={() => (more = !more)}>{more ? t('consumo.top.less') : t('consumo.top.more', { n: rows.length })}</button>
  {/if}
{/if}

<style>
  .empty { color: var(--faint); font-size: 12px; }
  .top { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
  th { text-align: left; font-weight: 500; color: var(--faint); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; padding: 0 6px 6px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th.n { text-align: right; }
  td { padding: 5px 6px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); vertical-align: middle; }
  tr:hover td { background: color-mix(in srgb, var(--text) 4%, transparent); }
  th.b, td.b { width: auto; }
  th:not(.b), td:not(.b) { width: 72px; }
  th.c, td.c { width: 100px; }
  th.w, td.who { width: 100px; }
  .n { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
  td.c { color: var(--text); cursor: help; position: relative; }
  .ftip { position: absolute; right: 0; top: calc(100% + 2px); z-index: 6; width: max-content; max-width: 460px; text-align: left; white-space: normal;
    background: var(--raise); border: 1px solid var(--border-strong); border-radius: 6px; padding: 7px 9px; font-size: 11.5px; color: var(--text);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); display: grid; gap: 3px; pointer-events: none; }
  .ftip .mut { color: var(--muted); }
  .fx { border-bottom: 1px dotted var(--faint); }
  .bw { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .bw i { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  .tool { color: var(--text); flex: none; max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .det { color: var(--muted); font-family: var(--mono, ui-monospace, Consolas, monospace); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .who { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .more { justify-self: start; font-size: 11.5px; color: var(--accent); padding: 4px 0; }
</style>
