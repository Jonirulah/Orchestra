<script lang="ts">
  // Tamaño del contexto por petición del hilo principal, con marcas de compactación y de caché reescrita.
  // Cruceta: el puntero solo tiene que estar cerca en X; el tooltip dice la petición, la hora y el suceso si lo hay.
  import { fmtTok as fmtTok0, fmtGap as fmtGap0, linePath, nearestIndex, niceTicks, langOf, type Marker } from '../lib/consumo.ts';
  import { t, tk, getLocale } from '../lib/i18n.ts';

  let { line, markers }: { line: { ts: number; ctx: number; seg: number }[]; markers: Marker[] } = $props();
  const H = 120;
  let w = $state(300);
  let hover = $state<number | null>(null);
  const loc = $derived(getLocale() === 'es' ? 'es-ES' : 'en-US');
  const lang = $derived(langOf(getLocale()));
  const fmtTok = (n: number) => fmtTok0(n, lang);
  const fmtGap = (n: number) => fmtGap0(n, lang);
  /** Marcas de tiempo intermedias: 5 repartidas (inicio, 3 en medio, fin). */
  const xticks = $derived(line.length ? [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * span) : []);
  const ticks = $derived(niceTicks(Math.max(0, ...line.map((p) => p.ctx))));
  const top = $derived(ticks[ticks.length - 1] || 1);
  const path = $derived(linePath(line, w, H, top));
  const t0 = $derived(line[0]?.ts ?? 0);
  const span = $derived(Math.max(1, (line[line.length - 1]?.ts ?? 0) - t0));
  const x = (ts: number) => ((ts - t0) / span) * w;
  const y = (v: number) => H - (v / top) * H;
  /** Marca de cada petición (por índice), para el tooltip. */
  const byReq = $derived(new Map(markers.map((m) => [m.event.req, m])));
  const hm = $derived(hover != null ? byReq.get(hover) : undefined);

  function onMove(e: PointerEvent) {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    hover = nearestIndex(line, e.clientX - r.left, r.width);
  }
  function markerText(m: Marker): string {
    const e = m.event;
    if (m.kind === 'compaction') return t('consumo.session.compaction', { from: fmtTok(e.tokens), to: fmtTok(e.extra) });
    const cause = e.cause === 'expired' ? t('consumo.session.cause.expired', { gap: fmtGap(e.extra) }) : tk(`consumo.session.cause.${e.cause ?? 'prefixChanged'}`);
    return `${t('consumo.session.broken', { tok: fmtTok(e.tokens) })} · ${cause}`;
  }
  const time = (ts: number) => new Date(ts * 1000).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
</script>

<div class="ctx">
  <div class="plot" bind:clientWidth={w}>
    {#each ticks as v (v)}
      <div class="grid" style:top={`${y(v)}px`}><span>{fmtTok(v)}</span></div>
    {/each}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <svg width={w} height={H} onpointermove={onMove} onpointerleave={() => (hover = null)} role="img" aria-label={t('consumo.session.context')}>
      <path d={`${path}L${w},${H}L0,${H}Z`} class="area" />
      <path d={path} class="ln" />
      {#each markers as m (m.event.req + m.kind)}
        {@const p = line[m.event.req]}
        {#if p}
          {#if m.kind === 'compaction'}
            <line x1={x(p.ts)} x2={x(p.ts)} y1="0" y2={H} class="cmp" />
            <circle cx={x(p.ts)} cy={y(m.event.tokens)} r="4" class="dot cmpd" />
          {:else}
            <circle cx={x(p.ts)} cy={y(p.ctx)} r="4.5" class="dot brk" />
          {/if}
        {/if}
      {/each}
      {#if hover != null && line[hover]}
        <line x1={x(line[hover].ts)} x2={x(line[hover].ts)} y1="0" y2={H} class="cross" />
        <circle cx={x(line[hover].ts)} cy={y(line[hover].ctx)} r="4" class="dot hv" />
      {/if}
    </svg>
    {#if hover != null && line[hover]}
      <div class="tip" class:flip={x(line[hover].ts) > w / 2} style:left={`${x(line[hover].ts)}px`}>
        <b>{t('consumo.session.ctxAt', { tok: fmtTok(line[hover].ctx) })}</b>
        <div class="mut">{t('consumo.session.req', { n: hover + 1 })} · {time(line[hover].ts)}</div>
        {#if hm}<div class="ev">{markerText(hm)}</div>{/if}
      </div>
    {/if}
  </div>
  <div class="xs">{#each xticks as ts, i (i)}<span style:left={`${(i / 4) * 100}%`} class:first={i === 0} class:last={i === 4}>{time(ts)}</span>{/each}</div>
  <div class="legend">
    <span><i class="lk"></i>{t('consumo.session.context')}</span>
    <span><i class="mk cmpk"></i>{t('consumo.session.legendCompaction')}</span>
    <span><i class="mk brkk"></i>{t('consumo.session.legendBroken')}</span>
  </div>
</div>

<style>
  .ctx { display: grid; gap: 4px; padding-left: 40px; }
  .plot { position: relative; height: 120px; }
  .grid { position: absolute; left: 0; right: 0; height: 0; border-top: 1px solid var(--border); pointer-events: none; }
  .grid span { white-space: nowrap; position: absolute; right: calc(100% + 6px); transform: translateY(-50%); font-size: 10px; color: var(--faint); font-variant-numeric: tabular-nums; }
  svg { position: absolute; inset: 0; overflow: visible; }
  .ln { fill: none; stroke: #3987e5; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .area { fill: #3987e5; opacity: 0.1; stroke: none; }
  .cmp { stroke: #9085e9; stroke-width: 1; }
  .cross { stroke: var(--muted); stroke-width: 1; }
  .dot { stroke: var(--panel); stroke-width: 2; }
  .cmpd { fill: #9085e9; }
  .brk { fill: var(--warn); }
  .hv { fill: #3987e5; }
  .tip { position: absolute; top: 2px; transform: translateX(10px); z-index: 5; background: var(--raise); border: 1px solid var(--border-strong); border-radius: 6px; padding: 6px 8px; font-size: 11.5px; white-space: nowrap; pointer-events: none; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); }
  .tip.flip { transform: translateX(calc(-100% - 10px)); }
  .tip b { font-size: 12.5px; }
  .mut { color: var(--muted); }
  .ev { color: var(--text); max-width: 320px; white-space: normal; }
  .xs { position: relative; height: 13px; font-size: 10px; color: var(--faint); font-variant-numeric: tabular-nums; }
  .xs span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
  .xs span.first { transform: none; }
  .xs span.last { transform: translateX(-100%); }
  .legend { display: flex; gap: 14px; font-size: 11px; color: var(--muted); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .lk { width: 14px; height: 2px; background: #3987e5; border-radius: 1px; }
  .mk { width: 8px; height: 8px; border-radius: 50%; }
  .cmpk { background: #9085e9; }
  .brkk { background: var(--warn); }
</style>
