<script lang="ts">
  // Lista ordenada con barra horizontal (una sola serie: un color, sin leyenda; el valor va en la punta).
  import { fmtUnit as fmtUnit0, fmtPct, langOf, type Row, type Unit } from '../lib/consumo.ts';
  import { getLocale } from '../lib/i18n.ts';

  let { rows, unit, label, sub, indent = false, scaleMax }: { rows: Row[]; unit: Unit; label: (r: Row) => string; sub?: (r: Row) => string; indent?: boolean; scaleMax?: number } = $props();
  const lang = $derived(langOf(getLocale()));
  const fmtUnit = (n: number, u: Unit) => fmtUnit0(n, u, lang);
  const comma = $derived(getLocale() === 'es');
  // Con `scaleMax` una lista sangrada usa la misma escala que la lista de arriba.
  const max = $derived(scaleMax ?? Math.max(0, ...rows.map((r) => r[unit])));
</script>

<ul class="ranks" class:indent>
  {#each rows as r (r.key)}
    <li title={sub ? `${label(r)} · ${sub(r)}` : label(r)}>
      <div class="hd">
        <span class="lb">{label(r)}</span>
        <span class="vl">{fmtUnit(r[unit], unit)}</span>
        <span class="pc">{fmtPct(r.pct, comma)}</span>
      </div>
      <div class="track"><div class="fill" class:other={!r.key} style:width={`${max > 0 ? (r[unit] / max) * 100 : 0}%`}></div></div>
      {#if sub}<div class="sub">{sub(r)}</div>{/if}
    </li>
  {/each}
</ul>

<style>
  .ranks.indent { padding-left: 14px; border-left: 2px solid var(--border); }
  .ranks { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  li { display: grid; gap: 3px; min-width: 0; }
  .hd { display: flex; align-items: baseline; gap: 8px; font-size: 12px; min-width: 0; }
  /* El nombre no se corta: si no cabe, pasa a la línea siguiente. */
  .lb { flex: 1; min-width: 0; color: var(--text); overflow-wrap: anywhere; }
  .vl { color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pc { color: var(--faint); font-variant-numeric: tabular-nums; min-width: 46px; text-align: right; white-space: nowrap; }
  .track { height: 6px; }
  .fill { height: 100%; min-width: 2px; background: #3987e5; border-radius: 0 4px 4px 0; }
  .fill.other { background: var(--faint); }
  .sub { font-size: 10.5px; color: var(--faint); }
</style>
