<script lang="ts">
  // Coste por día (o por hora, hoy): columnas APILADAS por los mismos grupos y colores que «Adónde va» (de abajo
  // arriba en el orden de la barra), desde una sola línea base, marcas Y redondas, tooltip por columna con el desglose.
  // El día (u hora) en curso va rayado y rotulado «parcial»: aún no ha terminado.
  import { fmtUnit as fmtUnit0, fmtPct, groupFill, niceTicks, langOf, type Day, type Group, type Unit } from '../lib/consumo.ts';
  import { t, tk, tn, getLocale } from '../lib/i18n.ts';

  let { days, unit, hourly = false, order = [] }: { days: Day[]; unit: Unit; hourly?: boolean; order?: Group[] } = $props();
  const loc = $derived(getLocale() === 'es' ? 'es-ES' : 'en-US');
  const lang = $derived(langOf(getLocale()));
  const fmtUnit = (n: number, u: Unit) => fmtUnit0(n, u, lang);
  const ticks = $derived(niceTicks(Math.max(0, ...days.map((d) => d[unit]))));
  const top = $derived(ticks[ticks.length - 1] || 1);
  const ui = $derived(unit === 'usd' ? 1 : 0);
  /** Grupos presentes en algún día, en el orden de la barra. */
  const groups = $derived(order.filter((g) => days.some((d) => (d.g?.[g]?.[ui] ?? 0) > 0)));
  let hover = $state<number | null>(null);

  /** Día de la semana + número en el orden del idioma: EN «Sun 1», ES «dom 1»; 30 días: EN «Nov 1», ES «1 nov». */
  function dayLabel(dt: Date, long: boolean): string {
    if (long) return dt.toLocaleDateString(loc, { day: 'numeric', month: 'short' }).replace('.', '');
    const wd = dt.toLocaleDateString(loc, { weekday: 'short' }).replace('.', '');
    return `${wd} ${dt.getDate()}`;
  }
  function label(d: Day, i: number): string {
    const dt = new Date(d.start * 1000);
    if (hourly) return i % 3 === 0 ? String(dt.getHours()).padStart(2, '0') : '';
    if (days.length > 10) return i % 5 === 0 || i === days.length - 1 ? dayLabel(dt, true) : '';
    return dayLabel(dt, false);
  }
  function full(d: Day): string {
    const dt = new Date(d.start * 1000);
    return hourly ? `${dayLabel(dt, false)} ${String(dt.getHours()).padStart(2, '0')}:00`
      : dt.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long' });
  }
  // Total del periodo y media por día (u hora) COMPLETOS: el día en curso no baja la media.
  const sum = $derived(days.reduce((a, d) => a + d[unit], 0));
  const done = $derived(days.filter((d) => !d.partial));
  const mean = $derived(done.length ? done.reduce((a, d) => a + d[unit], 0) / done.length : sum / Math.max(1, days.length));
  const segs = (d: Day) => groups.map((g) => ({ g, v: d.g?.[g]?.[ui] ?? 0 })).filter((x) => x.v > 0);
</script>

<div class="cols">
  <div class="sum"><b>{t('consumo.cols.total', { v: fmtUnit(sum, unit) })}</b> · <i class="mk"></i>{t(hourly ? 'consumo.cols.meanHour' : 'consumo.cols.mean', { v: fmtUnit(mean, unit) })}</div>
  <div class="plot">
    {#if mean > 0}<div class="mean" style:bottom={`${(mean / top) * 100}%`}></div>{/if}
    {#each ticks as v (v)}
      <div class="grid" style:bottom={`${(v / top) * 100}%`}><span>{fmtUnit(v, unit)}</span></div>
    {/each}
    <div class="bars">
      {#each days as d, i (d.start)}
        {@const ss = segs(d)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="slot" class:on={hover === i} onpointerenter={() => (hover = i)} onpointerleave={() => (hover = null)}>
          <div class="col" class:partial={d.partial} style:height={`${(d[unit] / top) * 100}%`}>
            {#if ss.length}
              {#each ss as x (x.g)}<div class="seg" style:flex-grow={d[unit] > 0 ? (x.v / d[unit]) * 1000 : 1} style:background={groupFill(x.g)}></div>{/each}
            {:else}
              <div class="seg" style:flex-grow="1" style:background="#3987e5"></div>
            {/if}
          </div>
          {#if hover === i}
            <div class="tip" class:right={i > days.length / 2}>
              <b>{fmtUnit(d[unit], unit)}</b>{#if d.partial} <span class="mut">· {t('consumo.cols.partial')}</span>{/if}
              <div>{full(d)}</div>
              <div class="mut">{tn('consumo.row.requests', d.requests)}</div>
              {#each [...ss].reverse() as x (x.g)}
                <div class="tl"><i style:background={groupFill(x.g)}></i>{tk(`consumo.group.${x.g}`)} <span class="mut">{fmtUnit(x.v, unit)} · {fmtPct(d[unit] > 0 ? x.v / d[unit] : 0, lang === 'es')}</span></div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
  <div class="xs">
    {#each days as d, i (d.start)}<span class:pt={d.partial}>{label(d, i)}{#if d.partial && !hourly}<em>{t('consumo.cols.partial')}</em>{/if}</span>{/each}
  </div>
  {#if groups.length > 1}
    <ul class="lgd">
      {#each groups as g (g)}<li><i style:background={groupFill(g)}></i>{tk(`consumo.group.${g}`)}</li>{/each}
      <li><i class="hatch"></i>{t('consumo.cols.partialHint')}</li>
    </ul>
  {/if}
</div>

<style>
  .cols { display: grid; gap: 4px; padding-left: 44px; }
  .plot { position: relative; height: 150px; border-bottom: 1px solid var(--border-strong); }
  .sum { font-size: 11.5px; color: var(--muted); margin: 0 0 8px -44px; font-variant-numeric: tabular-nums; }
  .sum b { color: var(--text); font-weight: 600; }
  .mk { display: inline-block; width: 14px; height: 0; border-top: 2px dashed var(--text); vertical-align: middle; margin-right: 5px; opacity: 0.7; }
  .mean { position: absolute; left: 0; right: 0; height: 0; border-top: 2px dashed color-mix(in srgb, var(--text) 70%, transparent); z-index: 2; pointer-events: none; }
  .grid { position: absolute; left: 0; right: 0; height: 0; border-top: 1px solid var(--border); }
  .grid span { position: absolute; right: calc(100% + 6px); transform: translateY(-50%); font-size: 10px; color: var(--faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bars { position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 2px; }
  .slot { position: relative; flex: 1; height: 100%; display: flex; align-items: flex-end; justify-content: center; }
  .slot.on { background: color-mix(in srgb, var(--text) 5%, transparent); }
  .col { width: min(24px, 70%); border-radius: 4px 4px 0 0; min-height: 0; display: flex; flex-direction: column-reverse; gap: 1px; overflow: hidden; position: relative; }
  .seg { flex-basis: 0; min-height: 0; }
  .col.partial { opacity: 0.85; outline: 1px dashed var(--muted); outline-offset: 1px; }
  .col.partial::after { content: ''; position: absolute; inset: 0; background: repeating-linear-gradient(135deg, transparent 0 4px, rgba(19, 22, 27, 0.55) 4px 6px); }
  .slot.on .col { filter: brightness(1.2); }
  .tip { position: absolute; top: 0; left: calc(50% + 16px); z-index: 5; background: var(--raise); border: 1px solid var(--border-strong); border-radius: 6px; padding: 6px 8px; font-size: 11.5px; white-space: nowrap; pointer-events: none; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); display: grid; gap: 2px; }
  .tip.right { left: auto; right: calc(50% + 16px); }
  .tip b { font-size: 12.5px; }
  .tl { display: flex; align-items: center; gap: 6px; }
  .tl i, .lgd i { width: 9px; height: 9px; border-radius: 2px; flex: none; display: inline-block; }
  .mut { color: var(--muted); }
  .xs { display: flex; gap: 2px; }
  .xs span { flex: 1; text-align: center; font-size: 10px; color: var(--faint); white-space: nowrap; overflow: visible; min-width: 0; display: grid; }
  .xs span.pt { color: var(--muted); }
  .xs em { font-style: normal; font-size: 9.5px; }
  .lgd { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11px; color: var(--muted); }
  .lgd li { display: flex; align-items: center; gap: 6px; }
  .lgd i.hatch { background: repeating-linear-gradient(135deg, #3987e5 0 4px, #13161b 4px 6px); outline: 1px dashed var(--muted); }
</style>
