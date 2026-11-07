<script lang="ts">
  // Barra apilada por grupo de categoría + leyenda con % y valor (la leyenda hace de tabla: nada queda solo en el tooltip).
  // Dos ejes que no se mezclan: el tramo de CONTEXTO (lo que entra, por origen) y el de lo GENERADO (salida y
  // razonamiento), rotulados sobre la barra; la leyenda va en dos listas en el mismo orden que la barra.
  import type { ConsumoCatAgg } from '../lib/backend.ts';
  import { groupFill, otherCats, sectionOf, fmtUnit as fmtUnit0, fmtPct, fmtTok as fmtTok0, langOf, type Slice, type Unit, type Section } from '../lib/consumo.ts';
  import { t, tk, getLocale } from '../lib/i18n.ts';

  let { slices, unit, cats = [] }: { slices: Slice[]; unit: Unit; cats?: ConsumoCatAgg[] } = $props();
  const comma = $derived(getLocale() === 'es');
  const lang = $derived(langOf(getLocale()));
  const fmtUnit = (n: number, u: Unit) => fmtUnit0(n, u, lang);
  const fmtTok = (n: number) => fmtTok0(n, lang);
  let hover = $state<{ s: Slice; x: number } | null>(null);
  let bar = $state<HTMLDivElement>();

  function onMove(e: PointerEvent, s: Slice) {
    const r = bar?.getBoundingClientRect();
    hover = { s, x: r ? e.clientX - r.left : 0 };
  }
  const others = $derived(otherCats(cats, unit));
  const SECS: Section[] = ['context', 'generated'];
  const secs = $derived(SECS.map((k) => {
    const items = slices.filter((s) => sectionOf(s.group) === k);
    return { k, items, pct: items.reduce((a, s) => a + s.pct, 0), v: items.reduce((a, s) => a + s[unit], 0) };
  }).filter((x) => x.items.length));
</script>

<div class="stack">
  <div class="secs" aria-hidden="true">
    {#each secs as x (x.k)}
      <span class="sec" style:flex-grow={x.pct * 1000} title={`${tk(`consumo.stack.${x.k}`)}: ${tk(`consumo.stack.${x.k}Hint`)}`}><b>{tk(`consumo.stack.${x.k}Short`)}</b> {fmtPct(x.pct, comma)}</span>
    {/each}
  </div>
  <div class="bar" bind:this={bar} role="img" aria-label={slices.map((s) => `${tk(`consumo.group.${s.group}`)} ${fmtPct(s.pct, comma)}`).join(', ')}>
    {#each secs as x, si (x.k)}
      <div class="part" class:gap={si > 0} style:flex-grow={x.pct * 1000}>
        {#each x.items as s (s.group)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="seg" class:on={hover?.s.group === s.group} style:flex-grow={x.pct > 0 ? (s.pct / x.pct) * 1000 : 1} style:background={groupFill(s.group)}
            onpointermove={(e) => onMove(e, s)} onpointerleave={() => (hover = null)}></div>
        {/each}
      </div>
    {/each}
    {#if hover}
      <div class="tip" style:left={`${hover.x}px`}>
        <b>{fmtUnit(hover.s[unit], unit)}</b> <span class="mut">{fmtPct(hover.s.pct, comma)}</span>
        <div>{tk(`consumo.group.${hover.s.group}`)}</div>
        <div class="mut">{t('consumo.tip.tokens', { t: fmtTok(hover.s.t) })}</div>
        {#if hover.s.group === 'other'}
          {#each others as c (c.cat)}<div class="mut">{tk(`consumo.cat.${c.cat}`)} · {fmtUnit(c[unit], unit)}</div>{/each}
        {/if}
      </div>
    {/if}
  </div>
  <div class="legend">
    {#each secs as x (x.k)}
      <div class="lg">
        <div class="lh"><span>{tk(`consumo.stack.${x.k}`)}</span> <span class="pc">{fmtPct(x.pct, comma)}</span></div>
        <ul>
          {#each x.items as s (s.group)}
            <li class:on={hover?.s.group === s.group}>
              <i style:background={groupFill(s.group)}></i>
              <span class="lb">{tk(`consumo.group.${s.group}`)}</span>
              <span class="pc">{fmtPct(s.pct, comma)}</span>
              <span class="vl">{fmtUnit(s[unit], unit)}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </div>
</div>

<style>
  .stack { display: grid; gap: 8px; }
  .secs { display: flex; gap: 8px; font-size: 11px; color: var(--muted); min-width: 0; }
  .sec { flex-basis: 0; min-width: 0; border-bottom: 1px solid var(--border-strong); padding-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sec b { color: var(--text); font-weight: 500; }
  .bar { position: relative; display: flex; gap: 8px; height: 16px; margin-top: -4px; }
  .part { display: flex; gap: 2px; flex-basis: 0; min-width: 4px; }
  .seg { min-width: 2px; height: 100%; }
  .seg:first-child { border-radius: 4px 0 0 4px; }
  .seg:last-child { border-radius: 0 4px 4px 0; }
  .seg:only-child { border-radius: 4px; }
  .seg.on { filter: brightness(1.25); }
  .tip { position: absolute; top: 22px; transform: translateX(-50%); z-index: 5; background: var(--raise); border: 1px solid var(--border-strong); border-radius: 6px; padding: 6px 8px; font-size: 11.5px; white-space: nowrap; pointer-events: none; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); }
  .tip b { color: var(--text); font-size: 12.5px; }
  .mut { color: var(--muted); }
  .legend { display: flex; flex-wrap: wrap; gap: 8px 24px; }
  .lg { flex: 1 1 240px; min-width: 0; display: grid; gap: 3px; align-content: start; }
  .lh { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .lg ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
  .lg li { display: flex; align-items: center; gap: 7px; font-size: 12px; min-width: 0; padding: 1px 0; }
  .lg li.on .lb { color: var(--text); }
  .lg i { width: 12px; height: 12px; border-radius: 2px; flex: none; }
  .lb { color: var(--muted); overflow-wrap: anywhere; flex: 1; min-width: 0; }
  .pc { color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .vl { color: var(--faint); font-variant-numeric: tabular-nums; min-width: 52px; text-align: right; white-space: nowrap; }
</style>
