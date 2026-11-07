<script lang="ts">
  // Panel flotante con el histórico de la última hora (CPU, RAM + swap, red, disco) encima de la barra de estado.
  // Fuente: el equipo local o, con un panel SSH enfocado que tiene métricas remotas, el servidor. Se refresca cada 5 s
  // mientras está abierto. Se cierra con Esc, clic fuera o el botón que lo abrió. SVG a mano, sin librerías.
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { t } from '../lib/i18n.ts';
  import { metricsHistory, rmetricsHistory } from '../lib/backend.ts';
  import { REFRESH_MS, clock, gapOf, minutesAgo, nearestIndex, niceBytes, pct, segments, seriesPaths, spanMinutes, stats, stepOf, tAtX, timeDomain, xOf, yOf } from '../lib/history.ts';
  import type { Box, HistPoint, HistSource } from '../lib/history.ts';
  import { fmtBytes, fmtPct, fmtRate } from '../lib/statusbar.ts';
  import Icon from './Icon.svelte';

  let { src, anchor, onclose }: { src: HistSource; anchor: HTMLElement | undefined; onclose: () => void } = $props();

  const W = 452;
  const PAD = 12;
  const CW = W - 2 * PAD;
  const CH = 38;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  let pts = $state<HistPoint[]>([]);
  let loaded = $state(false);
  let panel = $state<HTMLElement>();
  let hoverT = $state<number | null>(null);

  // ---- datos: al abrir y cada REFRESH_MS; una respuesta vieja (de otra fuente) se descarta ----
  const srcKey = $derived(src.kind === 'remote' ? `r:${src.key}` : 'local');
  $effect(() => {
    const key = srcKey;
    const s = src;
    let alive = true;
    let busy = false;
    loaded = false;
    pts = [];
    const load = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const r = s.kind === 'remote' ? await rmetricsHistory(s.key) : await metricsHistory();
        if (alive && key === srcKey) { pts = r; loaded = true; }
      } catch { if (alive) loaded = true; } finally { busy = false; }
    };
    void load();
    const iv = window.setInterval(() => void load(), REFRESH_MS);
    return () => { alive = false; clearInterval(iv); };
  });

  // ---- posición: encima de la barra, alineado con el botón, sin salirse de la ventana ----
  let pos = $state({ left: 8, bottom: 32 });
  function place() {
    if (!anchor) return;
    const a = anchor.getBoundingClientRect();
    const bar = anchor.closest('.sb')?.getBoundingClientRect() ?? a;
    const left = Math.round(Math.min(Math.max(8, a.left - 16), window.innerWidth - W - 8));
    pos = { left: Math.max(8, left), bottom: Math.round(window.innerHeight - bar.top + 6) };
  }
  onMount(() => {
    place();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onclose(); anchor?.focus(); } };
    const onDown = (e: PointerEvent) => {
      const el = e.target as Node | null;
      if (el && (panel?.contains(el) || anchor?.contains(el))) return;
      onclose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', place);
    };
  });

  // ---- escalas y series ----
  const dom = $derived(timeDomain(pts));
  const view = $derived(pts.filter((p) => p.t >= dom.t0));
  const gap = $derived(gapOf(stepOf(view)));
  const box = (yMax: number): Box => ({ w: CW, h: CH, t0: dom.t0, t1: dom.t1, yMax, pad: 2 });
  const ramPct = $derived(view.map((p) => pct(p.ramUsed, p.ramTotal)));
  const swapPct = $derived(view.map((p) => pct(p.swapUsed, p.swapTotal)));
  const hasSwap = $derived(swapPct.some((v) => v !== null));
  const netMax = $derived(niceBytes(Math.max(0, ...view.map((p) => Math.max(p.netIn, p.netOut)))));
  const diskMax = $derived(niceBytes(Math.max(0, ...view.map((p) => Math.max(p.diskRead ?? 0, p.diskWrite ?? 0)))));

  interface Series { id: string; vals: (number | null)[]; color: string; dash?: boolean; label?: string }
  interface Chart { id: string; title: string; yMax: number; fmt: (v: number) => string; series: Series[]; scale?: string }
  const charts = $derived<Chart[]>([
    { id: 'cpu', title: t('statusbar.hist.cpu'), yMax: 100, fmt: fmtPct, series: [{ id: 'cpu', vals: view.map((p) => p.cpu), color: 'var(--accent)' }] },
    {
      id: 'ram', title: t('statusbar.hist.ram'), yMax: 100, fmt: fmtPct,
      series: [
        { id: 'ram', vals: ramPct, color: 'var(--info)' },
        ...(hasSwap ? [{ id: 'swap', vals: swapPct, color: 'var(--muted)', dash: true, label: t('statusbar.hist.swap') }] : []),
      ],
    },
    {
      id: 'net', title: t('statusbar.hist.net'), yMax: netMax, fmt: fmtRate, scale: fmtRate(netMax),
      series: [
        { id: 'in', vals: view.map((p) => p.netIn), color: 'var(--ok)', label: '↓' },
        { id: 'out', vals: view.map((p) => p.netOut), color: 'var(--info)', label: '↑' },
      ],
    },
    {
      id: 'disk', title: t('statusbar.hist.disk'), yMax: diskMax, fmt: fmtRate, scale: fmtRate(diskMax),
      series: [
        { id: 'read', vals: view.map((p) => p.diskRead), color: 'var(--ok)', label: t('statusbar.hist.read') },
        { id: 'write', vals: view.map((p) => p.diskWrite), color: 'var(--info)', label: t('statusbar.hist.write') },
      ],
    },
  ]);
  const drawn = $derived(charts.map((c) => ({
    ...c,
    paths: c.series.map((s) => ({ ...s, st: stats(s.vals), ...seriesPaths(segments(view, (i) => s.vals[i], gap), box(c.yMax)) })),
  })));

  // ---- cursor: un solo instante para todas las gráficas ----
  const hi = $derived(hoverT === null ? -1 : nearestIndex(view, hoverT));
  const hp = $derived(hi >= 0 ? view[hi] : null);
  const hx = $derived(hp ? xOf(hp.t, box(1)) : 0);
  function onMove(e: PointerEvent) {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    hoverT = tAtX(e.clientX - r.left, box(1));
  }
  /** Valor que enseña la cabecera de una serie: el del cursor o el último. */
  const shown = (s: { vals: (number | null)[]; st: { cur: number } | null }): number | null => (hi >= 0 ? s.vals[hi] : (s.st?.cur ?? null));
  const ramGB = $derived.by(() => {
    const p = hp ?? view[view.length - 1];
    return p ? `${fmtBytes(p.ramUsed)} / ${fmtBytes(p.ramTotal)}` : '';
  });
  const span = $derived(spanMinutes(dom));
  const title = $derived(src.kind === 'remote' ? t('statusbar.hist.server', { host: src.host }) : t('statusbar.hist.local'));
  const sub = $derived(hp
    ? `${t('statusbar.hist.at', { time: clock(hp.t) })} · ${minutesAgo(hp.t, dom.t1) ? t('statusbar.hist.ago', { min: minutesAgo(hp.t, dom.t1) }) : t('statusbar.hist.now')}`
    : t('statusbar.hist.span', { min: span }));
</script>

<div
  class="mh" bind:this={panel} role="dialog" aria-label={t('statusbar.hist.aria')} tabindex="-1"
  style:left="{pos.left}px" style:bottom="{pos.bottom}px" style:width="{W}px"
  transition:fade={{ duration: reduce ? 0 : 110 }}
>
  <header>
    <Icon name={src.kind === 'remote' ? 'server' : 'chart'} size={13} />
    <span class="ttl">{title}</span>
    <span class="sub" aria-live="off">{sub}</span>
    <button class="x" type="button" title={t('statusbar.hist.close')} aria-label={t('statusbar.hist.close')} onclick={() => { onclose(); anchor?.focus(); }}><Icon name="x" size={12} /></button>
  </header>

  {#if view.length < 2}
    <p class="wait">{loaded ? t('statusbar.hist.collecting') : '…'}</p>
  {:else}
    {#each drawn as c (c.id)}
      <section class="row">
        <div class="hd">
          <span class="nm">{c.title}</span>
          {#each c.paths as s (s.id)}
            {@const v = shown(s)}
            <span class="cur" class:minor={s.dash}>
              <i class="key" class:dash={s.dash} style:--c={s.color} aria-hidden="true"></i>{#if s.label}<span class="lb">{s.label}</span>{/if}
              <b>{v === null ? t('statusbar.hist.noData') : c.fmt(v)}</b>
            </span>
          {/each}
          {#if c.id === 'ram' && ramGB}<span class="gb">{ramGB}</span>{/if}
        </div>
        <svg class="ch" width={CW} height={CH} viewBox="0 0 {CW} {CH}" role="img" aria-label={c.title}
          onpointermove={onMove} onpointerleave={() => (hoverT = null)}>
          <line class="grid" x1="0" x2={CW} y1={yOf(c.yMax / 2, box(c.yMax))} y2={yOf(c.yMax / 2, box(c.yMax))} />
          <line class="base" x1="0" x2={CW} y1={CH - 0.5} y2={CH - 0.5} />
          {#each c.paths as s (s.id)}
            {#if !s.dash && s.area}<path class="area" d={s.area} style:fill={s.color} />{/if}
          {/each}
          {#each c.paths as s (s.id)}
            <path class="line" class:dash={s.dash} d={s.line} style:stroke={s.color} />
          {/each}
          {#if c.scale}<text class="scale" x="3" y="10">{c.scale}</text>{/if}
          {#if hp}
            <line class="cursor" x1={hx} x2={hx} y1="0" y2={CH} />
            {#each c.paths as s (s.id)}
              {@const v = s.vals[hi]}
              {#if v !== null}<circle class="dot" cx={hx} cy={yOf(v, box(c.yMax))} r="2.6" style:fill={s.color} />{/if}
            {/each}
          {/if}
        </svg>
        <div class="ft">
          {#each c.paths as s (s.id)}
            {#if s.st}<span>{s.label ? `${s.label} ` : ''}{t('statusbar.hist.stats', { max: c.fmt(s.st.max), avg: c.fmt(s.st.avg) })}</span>{/if}
          {/each}
        </div>
      </section>
    {/each}
    <div class="axis" aria-hidden="true">
      <span>{t('statusbar.hist.minus', { min: span })}</span>
      {#if span >= 4}<span>{t('statusbar.hist.minus', { min: Math.round(span / 2) })}</span>{/if}
      <span>{t('statusbar.hist.now')}</span>
    </div>
  {/if}
</div>

<style>
  .mh {
    position: fixed; z-index: 900; padding: 8px 12px 9px; display: flex; flex-direction: column; gap: 6px;
    background: var(--panel); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.38); font-size: 11px; line-height: 1.2; font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .mh:focus { outline: none; }
  header { display: flex; align-items: center; gap: 6px; color: var(--muted); min-width: 0; }
  .ttl { color: var(--text); font-weight: 600; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .sub { color: var(--muted); flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .x { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 4px; color: var(--muted); flex: none; }
  .x:hover { color: var(--text); background: var(--raise); }
  .x:focus-visible { outline: 1px solid var(--accent); }
  .wait { margin: 14px 0 12px; color: var(--muted); text-align: center; white-space: normal; }
  .row { display: flex; flex-direction: column; gap: 3px; }
  .hd { display: flex; align-items: baseline; gap: 10px; min-width: 0; overflow: hidden; }
  .nm { color: var(--muted); width: 52px; flex: none; }
  .cur { display: inline-flex; align-items: baseline; gap: 4px; }
  .cur b { font-weight: 600; color: var(--text); }
  .cur.minor b { font-weight: 500; color: var(--muted); }
  .lb { color: var(--muted); }
  .key { display: inline-block; width: 10px; height: 0; border-top: 2px solid var(--c); transform: translateY(-3px); }
  .key.dash { border-top-style: dashed; }
  .gb { margin-left: auto; color: var(--muted); }
  .ch { display: block; overflow: visible; cursor: crosshair; }
  .grid { stroke: var(--border); stroke-dasharray: 2 3; stroke-width: 1; }
  .base { stroke: var(--border-strong); stroke-width: 1; }
  .area { opacity: 0.14; stroke: none; }
  .line { fill: none; stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
  .line.dash { stroke-width: 1.25; stroke-dasharray: 3 2.5; }
  .scale { fill: var(--muted); font-size: 9px; paint-order: stroke; stroke: var(--panel); stroke-width: 3px; stroke-linejoin: round; }
  .cursor { stroke: var(--text); stroke-width: 1; opacity: 0.45; }
  .dot { stroke: var(--panel); stroke-width: 1.2; }
  .ft { display: flex; gap: 14px; color: var(--faint); font-size: 10px; padding-left: 0; }
  .axis { display: flex; justify-content: space-between; color: var(--faint); font-size: 10px; border-top: 1px solid var(--border); padding-top: 4px; }
</style>
