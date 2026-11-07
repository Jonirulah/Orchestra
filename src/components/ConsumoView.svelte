<script lang="ts">
  // Vista global de Consumo: capa sobre la zona de paneles (los terminales siguen montados debajo). Al abrir se escanea
  // con el índice (solo se lee lo que cambió); el botón vuelve a escanear con progreso y se puede cancelar.
  // Orden: coste del periodo (Δ %) + adónde va + consejos → repartos → bloques caros por origen. Un solo total para todo.
  import { onMount } from 'svelte';
  import { app } from '../lib/store.svelte.ts';
  import * as be from '../lib/backend.ts';
  import { t, tk, tn, getLocale } from '../lib/i18n.ts';
  import {
    globalModel, modelName, errorKind, fmtTok, fmtUnit, fmtUsd, fmtNum, fmtPct, fmtDelta, projectLabel, periodSince, langOf, PERIODS, CONSUMO_PROVIDERS, CONSUMO_READY,
    type Period, type Unit, type ConsumoProvider, type Row,
  } from '../lib/consumo.ts';
  import Icon from './Icon.svelte';
  import Seg from './Seg.svelte';
  import ConsumoStack from './ConsumoStack.svelte';
  import ConsumoRanks from './ConsumoRanks.svelte';
  import ConsumoColumns from './ConsumoColumns.svelte';
  import ConsumoTopGroups from './ConsumoTopGroups.svelte';
  import ConsumoAdvice from './ConsumoAdvice.svelte';
  import ConsumoReport from './ConsumoReport.svelte';

  let period = $state<Period>(7);
  let unit = $state<Unit>('eq');
  let provider = $state<ConsumoProvider>('claude');
  let report = $state<be.ConsumoScanReport | null>(null);
  let scanning = $state(false);
  let progress = $state<{ done: number; total: number } | null>(null);
  let err = $state('');
  let home = $state('');
  let reportOpen = $state(false);
  let unitTip = $state(false);
  const wx = (x: number) => x.toLocaleString(lang === 'es' ? 'es-ES' : 'en-US', { maximumFractionDigits: 3 });
  let now = $state(Math.floor(Date.now() / 1000));
  const lang = $derived(langOf(getLocale()));
  const comma = $derived(lang === 'es');

  const model = $derived(report ? globalModel(report, period, now, unit, provider) : null);

  async function scan() {
    if (scanning) return;
    scanning = true; err = ''; progress = null;
    try {
      const n = Math.floor(Date.now() / 1000);
      // El periodo empieza en la medianoche local: así las columnas por día suman el total.
      const r = await be.consumoScan(period, undefined, (done, total) => (progress = { done, total }), app.adviceOpts(), periodSince(period, n));
      now = n;
      if (r) report = r;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      scanning = false; progress = null;
    }
  }
  function setPeriod(p: Period) { period = p; void scan(); }

  onMount(() => {
    void be.homeDir().then((h) => (home = h)).catch(() => {});
    void scan();
  });

  function onWindowKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !app.consumoOpen || app.consumoPane) return;
    if ((e.target as HTMLElement)?.closest?.('.xterm')) return;
    if (app.settingsOpen || app.hostDialog || app.accountDialog || app.paletteOpen || app.hostKeyPrompt) return;
    e.preventDefault();
    app.consumoOpen = false;
  }
  const whoLabel = (r: Row) => (r.key === 'main' ? t('consumo.row.main') : r.key === 'sub' ? t('consumo.row.sub') : r.key);
  const other = (r: Row, f: (r: Row) => string) => (r.key ? f(r) : t('consumo.row.other', { n: r.other ?? 0 }));
  const reqs = (r: Row) => tn('consumo.row.requests', r.requests);
  const model2 = (k: string) => modelName(k);
  /** «~» solo no dice nada: «~ (carpeta personal)». */
  const projLabel = (k: string) => { const l = projectLabel(k, home); return l === '~' ? t('consumo.homeLabel') : l; };
  const big = (n: number) => fmtUnit(n, unit, lang);
  const unitName = $derived(unit === 'usd' ? t('consumo.usdNote') : t('consumo.unitShort'));
</script>

<svelte:window onkeydown={onWindowKey} />

<section class="cv" aria-label={t('consumo.title')}>
  <header>
    <div class="ttl">
      <Icon name="bars" size={16} />
      <h2>{t('consumo.title')}</h2>
      <span class="subt">{t('consumo.subtitle')}</span>
    </div>
    <div class="ctl">
      <div class="prov" role="radiogroup">
        {#each CONSUMO_PROVIDERS as p (p)}
          {@const ready = CONSUMO_READY.includes(p)}
          <button type="button" role="radio" aria-checked={p === provider} class:on={p === provider} disabled={!ready}
            title={ready ? tk(`consumo.provider.${p}`) : `${tk(`consumo.provider.${p}`)}: ${t('consumo.providerSoon')}`}
            onclick={() => (provider = p)}>{tk(`consumo.provider.${p}`)}</button>
        {/each}
      </div>
      <Seg options={PERIODS.map((p) => ({ id: String(p) as '1' | '7' | '30', label: tk(`consumo.period.${p}`) }))} value={String(period) as '1' | '7' | '30'}
        onchange={(id) => setPeriod(Number(id) as Period)} />
      <span title={t('consumo.unitHint')}>
        <Seg options={[{ id: 'eq', label: t('consumo.unit.eq') }, { id: 'usd', label: t('consumo.unit.usd') }]} value={unit} onchange={(u) => (unit = u)} />
      </span>
      {#if scanning}
        <div class="prog" role="status" aria-live="polite">
          <div class="pbar"><div style:width={`${progress && progress.total ? (progress.done / progress.total) * 100 : 0}%`}></div></div>
          <span>{t('consumo.scanning', { done: progress?.done ?? 0, total: progress?.total ?? '…' })}</span>
          <button class="btn ghost" onclick={() => void be.consumoCancel()}>{t('consumo.cancel')}</button>
        </div>
      {:else}
        <button class="btn" title={model && model.requests === 0 ? t('consumo.report.emptyTitle') : t('consumo.report.buttonTitle')} disabled={!report || !model || model.requests === 0 || !!err} onclick={() => (reportOpen = true)}>{t('consumo.report.button')}</button>
        <button class="btn" title={report ? `${t('consumo.scanTitle')}
${t('consumo.diag')}: ${t('consumo.indexed', { files: fmtNum(report.files, lang), ms: fmtNum(report.elapsedMs, lang), read: fmtNum(report.filesRead, lang) })}` : t('consumo.scanTitle')} onclick={() => void scan()}><Icon name="refresh" size={13} /> {t('consumo.scan')}</button>
      {/if}
      <button class="iconbtn" title={t('consumo.close')} aria-label={t('consumo.close')} onclick={() => (app.consumoOpen = false)}><Icon name="x" size={14} /></button>
    </div>
  </header>

  <div class="body">
    {#if err}
      <div class="emptyst bad" role="alert">
        <b>{t('consumo.error', { err: tk(`consumo.error${errorKind(err)[0].toUpperCase()}${errorKind(err).slice(1)}`) })}</b>
        <span>{t('consumo.errorHint')}</span>
        <details class="raw"><summary>{t('consumo.errorDetail')}</summary><code>{err}</code></details>
        <button class="btn" onclick={() => void scan()}><Icon name="refresh" size={13} /> {t('consumo.scan')}</button>
      </div>
    {/if}
    {#if report?.cancelled}<div class="msg warn">{t('consumo.cancelled')}</div>{/if}
    {#if model && model.requests === 0 && !scanning && !err}
      <!-- Vacío: un mensaje con qué hacer, no un tablero de ceros. -->
      <div class="emptyst" role="status">
        <Icon name="bars" size={22} />
        <b>{t('consumo.empty')}</b>
        <span>{t('consumo.emptyHint')}</span>
        {#if period !== 30}<button class="btn" onclick={() => setPeriod(30)}>{t('consumo.emptyTry30')}</button>{/if}
      </div>
    {:else if model && !err}
      <!-- 1. Lo principal: cuánto, adónde va y qué hacer. -->
      <div class="hero">
        <div class="card cost">
          <span class="kl">{t('consumo.kpi.cost')}</span>
          <b class="num">{big(model.total)}</b>
          <span class="unit">{unitName}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <span class="info" tabindex="0" role="note" aria-label={t('consumo.unitHint')} onpointerenter={() => (unitTip = true)} onpointerleave={() => (unitTip = false)}
              onfocus={() => (unitTip = true)} onblur={() => (unitTip = false)}>ⓘ</span>
            {#if unitTip}
              <span class="utip">
                <span>{t('consumo.unitOne')}</span>
                {#each report?.modelWeights ?? [] as [m, r, w5, w1, o] (m)}
                  <span class="mut">{t('consumo.unitModel', { model: modelName(m), r: wx(r), w5: wx(w5), w1: wx(w1), o: wx(o) })}</span>
                {/each}
                <span class="mut">{t('consumo.usdHint')}</span>
              </span>
            {/if}
          </span>
          <span class="kh">{t('consumo.unitOne')}</span>
          {#if model.delta !== null}
            <span class="delta" class:up={model.delta > 0}>{period === 1 ? t('consumo.kpi.deltaDay', { d: fmtDelta(model.delta, lang) }) : t('consumo.kpi.delta', { d: fmtDelta(model.delta, lang), n: period })}</span>
          {:else}
            <span class="kh">{model.prevPartial ? t('consumo.kpi.deltaPartial') : t('consumo.kpi.deltaNone')}</span>
          {/if}
          {#if unit === 'eq'}<span class="kh">≈ {fmtUsd(model.totalUsd, lang)} · {t('consumo.usdNote')}</span>{/if}
          <div class="subk">
            <b>{fmtPct(model.subPct, comma)}</b> <span>{t('consumo.kpi.sub')}</span>
            <div class="kh">{t('consumo.kpi.subHint', { main: fmtPct(model.mainPct, comma) })}</div>
          </div>
          <div class="kh">{tn('consumo.row.requests', model.requests)} · {t('consumo.kpi.requestsHint', { n: fmtNum(model.files, lang), main: fmtNum(model.mainFiles, lang), sub: fmtNum(model.subFiles, lang) })}</div>
        </div>
        <div class="card where">
          <h3>{t('consumo.sec.cats')} <small>{t('consumo.sec.catsHint')}</small></h3>
          <ConsumoStack slices={model.slices} {unit} cats={report?.cats ?? []} />
        </div>
        {#if report?.advice}
          <div class="card advice">
            <h3>{t('consumo.advice.title')} <small>{t('consumo.advice.hint')}</small></h3>
            <ConsumoAdvice advice={report.advice} total={report.adviceTotal} {home} {unit} limit={3} />
          </div>
        {/if}
      </div>

      <!-- 2. Repartos (todos sobre el mismo total). -->
      <div class="cards">
        <div class="card full">
          <h3>{period === 1 ? t('consumo.sec.hourly') : t('consumo.sec.daily')} <small>{unitName}</small></h3>
          <ConsumoColumns days={model.days} {unit} hourly={period === 1} order={model.slices.map((s) => s.group)} />
        </div>
        <div class="card">
          <h3>{t('consumo.sec.who')} <small>{t('consumo.sec.whoHint')}</small></h3>
          <ConsumoRanks rows={model.who} {unit} label={whoLabel} sub={reqs} />
          {#if model.subTypes.length}
            <div class="ind">{t('consumo.row.subIndent')}</div>
            <ConsumoRanks rows={model.subTypes} {unit} indent scaleMax={Math.max(...model.who.map((r) => r[unit]))} label={(r) => other(r, (x) => x.key)} sub={reqs} />
          {/if}
        </div>
        <div class="card">
          <h3>{t('consumo.sec.projects')} <small>{t('consumo.sec.projectsHint')}</small></h3>
          <ConsumoRanks rows={model.projects} {unit} label={(r) => other(r, (x) => projLabel(x.key))} sub={reqs} />
        </div>
        <div class="card">
          <h3>{t('consumo.sec.models')}</h3>
          <ConsumoRanks rows={model.models} {unit} label={(r) => other(r, (x) => model2(x.key))} sub={(r) => (unit === 'eq' ? `${reqs(r)} · ${fmtUsd(r.usd, lang)}` : reqs(r))} />
          {#if unit === 'eq' && model.models.length > 1}<p class="hint">{t('consumo.models.eqHint')}</p>{/if}
        </div>
        <div class="col">
          <div class="card">
            <h3>{t('consumo.sec.events')} <small>{t('consumo.sec.eventsHint')}</small></h3>
            <ul class="ev">
              {#each model.eventCost as e (e.kind)}
                <li>
                  <span class="evk">{tk(`consumo.ev.kind.${e.kind}`)}</span>
                  <span class="evv">{big(e[unit])}</span>
                  <span class="evn">{tn('consumo.ev.times', e.count)}</span>
                </li>
              {/each}
            </ul>
            <p class="hint">{t('consumo.ev.coldHint')}</p>
          </div>
          <div class="card">
            <h3>{t('consumo.session.base')}</h3>
            <div class="bases">
              <div><b>{fmtTok(model.baseMain, lang)}</b> <span class="kh">{t('consumo.row.main')}</span></div>
              <div><b>{fmtTok(model.baseSub, lang)}</b> <span class="kh">{t('consumo.row.sub')}</span></div>
            </div>
            <p class="hint">{t('consumo.kpi.baseHint')}</p>
          </div>
        </div>
      </div>
      <!-- 3. Lo más caro, agrupado por origen y con % del total; cada origen se despliega con sus bloques. -->
      <div class="card">
        <h3>{t('consumo.sec.topGrouped')} <small>{t('consumo.sec.topGroupedHint')}</small></h3>
        <ConsumoTopGroups rows={model.top} origins={report?.origins} {unit} total={model.total} {home} limit={10} />
      </div>
      <!-- Diagnóstico del escaneo (ficheros, ms): fuera de la vista, en el tooltip del botón «Escanear». -->
    {/if}
  </div>
</section>
{#if reportOpen}<ConsumoReport days={period} onclose={() => (reportOpen = false)} />{/if}

<style>
  /* Texto de Consumo con contraste ≥ 4,5:1 sobre panel, fondo y tooltips (el --faint global da 2,4:1). */
  .cv { --muted: #9aa1ab; --faint: #858d98; position: absolute; inset: 0; z-index: 20; background: var(--bg); display: flex; flex-direction: column; min-height: 0; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .ttl { display: flex; align-items: baseline; gap: 10px; color: var(--info); min-width: 0; flex-wrap: wrap; }
  h2 { margin: 0; font-size: 15px; color: var(--text); font-weight: 600; }
  .subt { font-size: 12px; color: var(--muted); }
  .ctl { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .prov { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .prov button { font-size: 11.5px; padding: 3px 9px; color: var(--muted); }
  .prov button.on { background: var(--accent-soft); color: var(--accent); }
  .prov button:disabled { color: var(--faint); cursor: not-allowed; }
  .prog { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--muted); }
  .pbar { width: 120px; height: 4px; background: var(--raise); border-radius: 2px; overflow: hidden; }
  .pbar div { height: 100%; background: var(--accent); transition: width 0.2s; }
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 24px; display: grid; gap: 12px; align-content: start; }
  .msg { font-size: 12px; color: var(--muted); }
  .emptyst { justify-self: center; margin-top: 12vh; display: grid; justify-items: center; gap: 8px; text-align: center; max-width: 460px; color: var(--muted); font-size: 12.5px; }
  .emptyst b { color: var(--text); font-size: 14px; font-weight: 600; }
  .emptyst.bad b { color: var(--bad); }
  .msg.warn { color: var(--warn); }
  .hero { display: grid; grid-template-columns: minmax(220px, 0.8fr) minmax(0, 1.6fr) minmax(0, 1.6fr); gap: 12px; align-items: stretch; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; display: grid; gap: 10px; align-content: start; min-width: 0; }
  .cost { gap: 4px; }
  .kl { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
  .num { font-size: 30px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; line-height: 1.1; }
  .unit { font-size: 12px; color: var(--muted); cursor: help; }
  .unit { position: relative; }
  .info { color: var(--muted); cursor: help; }
  .utip { position: absolute; left: 0; top: calc(100% + 4px); z-index: 8; width: max-content; max-width: 420px; display: grid; gap: 3px;
    background: var(--raise); border: 1px solid var(--border-strong); border-radius: 6px; padding: 7px 9px; font-size: 11.5px; color: var(--text);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); white-space: normal; }
  .utip .mut { color: var(--muted); }
  .delta { font-size: 12px; color: var(--good, #3fb950); }
  .delta.up { color: var(--warn); }
  .kh { font-size: 11px; color: var(--faint); }
  .subk { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }
  .subk b { font-size: 20px; color: var(--text); font-variant-numeric: tabular-nums; }
  .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; align-items: start; }
  .card.full { grid-column: 1 / -1; }
  .col { display: grid; gap: 12px; align-content: start; min-width: 0; }
  h3 { margin: 0; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  h3 small { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--faint); margin-left: 6px; }
  .hint { margin: 0; font-size: 11px; color: var(--faint); }
  .ind { font-size: 10.5px; color: var(--faint); margin-top: 2px; }
  .ev { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 12px; }
  .ev li { display: grid; grid-template-columns: 1fr auto; gap: 0 10px; }
  .evk { color: var(--muted); }
  .evv { color: var(--text); text-align: right; font-variant-numeric: tabular-nums; }
  .evn { grid-column: 1 / -1; font-size: 10.5px; color: var(--faint); }
  .bases { display: flex; gap: 28px; }
  .bases b { font-size: 18px; color: var(--text); font-variant-numeric: tabular-nums; }
  .raw { font-size: 11px; color: var(--muted); max-width: 100%; }
  .raw summary { cursor: pointer; }
  .raw code { display: block; margin-top: 4px; white-space: pre-wrap; overflow-wrap: anywhere; text-align: left; }
  /* Por el ancho de la propia vista (con el cajón abierto la vista se estrecha aunque la ventana no). */
  .body { container-type: inline-size; }
  @container (max-width: 1150px) { .hero { grid-template-columns: minmax(220px, 1fr) minmax(0, 2fr); } .hero .advice { grid-column: 1 / -1; } }
  @container (max-width: 1000px) { .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @container (max-width: 640px) { .hero { grid-template-columns: 1fr; } .cards { grid-template-columns: 1fr; } .card.full { grid-column: auto; } }
</style>
