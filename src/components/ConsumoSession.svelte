<script lang="ts">
  // Cajón lateral con el consumo de la sesión de Claude de un panel: reparto por categoría, contexto en el tiempo con
  // compactaciones y cachés rotas, top 10, base fija y principal frente a subagentes. Se lee el .jsonl al abrir.
  import { tick } from 'svelte';
  import { fly } from 'svelte/transition';
  import { app } from '../lib/store.svelte.ts';
  import * as be from '../lib/backend.ts';
  import { t, tk, tn, getLocale } from '../lib/i18n.ts';
  import { sessionModel, errorKind, fmtNum, fmtTok as fmtTok0, fmtUnit as fmtUnit0, fmtUsd, fmtPct, projectKeyOf, projectLabel, langOf, type Unit, type ConsumoProvider } from '../lib/consumo.ts';
  import Icon from './Icon.svelte';
  import Seg from './Seg.svelte';
  import ConsumoStack from './ConsumoStack.svelte';
  import ConsumoContext from './ConsumoContext.svelte';
  import ConsumoTopGroups from './ConsumoTopGroups.svelte';
  import ConsumoRanks from './ConsumoRanks.svelte';
  import ConsumoAdvice from './ConsumoAdvice.svelte';

  const dur = (ms: number) => (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms);

  let report = $state<be.ConsumoSessionReport | null>(null);
  let phase = $state<'loading' | 'ok' | 'none' | 'error'>('loading');
  let err = $state('');
  let unit = $state<Unit>('eq');
  let home = $state('');
  let panel = $state<HTMLElement>();

  const paneId = $derived(app.consumoPane);
  /** Abierto por ruta (prueba de un consejo de la vista global) en vez de por panel. */
  const byPath = $derived(app.consumoPane ? null : app.consumoPath);
  const openKey = $derived(paneId ?? byPath);
  const agent = $derived(paneId ? app.agentOf(paneId) : undefined);
  const provider = $derived<ConsumoProvider>(agent?.agent ?? 'claude');
  const model = $derived(report ? sessionModel(report, unit, provider) : null);
  const projectKey = $derived(report ? projectKeyOf(report.main.path) : '');
  const cats = $derived(report ? [report.main, ...report.subagents].flatMap((f) => f.summary.cats) : []);

  async function load() {
    const ag = agent;
    phase = 'loading';
    try {
      const path = byPath;
      const opts = app.adviceOpts();
      const r = path ? await be.consumoSession(path, opts)
        : be.inTauri ? (ag?.configDir && ag.sessionId ? await be.consumoPane(ag.configDir, ag.sessionId, opts) : null) : await be.consumoPane('', '', opts);
      report = r;
      phase = r && r.main.summary.requests > 0 ? 'ok' : 'none';
    } catch (e) {
      err = String(e);
      phase = 'error';
    }
  }

  $effect(() => {
    if (!openKey) return;
    report = null;
    void load();
    void tick().then(() => panel?.focus());
  });
  $effect(() => { void be.homeDir().then((h) => (home = h)).catch(() => {}); });

  function close() { app.consumoPane = null; app.consumoPath = null; }
  function onWindowKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !openKey) return;
    if ((e.target as HTMLElement)?.closest?.('.xterm')) return;
    if (app.settingsOpen || app.hostDialog || app.accountDialog || app.paletteOpen || app.hostKeyPrompt) return;
    e.preventDefault();
    close();
  }
  const subLabel = (k: string) => (k ? k : '');
  const lang = $derived(langOf(getLocale()));
  const fmtTok = (n: number) => fmtTok0(n, lang);
  const fmtUnit = (n: number, u: Unit) => fmtUnit0(n, u, lang);
  /** Nombre de una parte de la base fija: traducido si es una clave conocida (skill_listing, user…), si no tal cual. */
  function baseLabel(k: string): string {
    const id = k === 'system+tools' ? 'systemTools' : k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    const v = tk(`consumo.base.${id}`);
    return v === `consumo.base.${id}` ? k : v;
  }
  /** Título: proyecto · fecha de la sesión (y el título del panel, si lo hay). */
  const heading = $derived.by(() => {
    if (!model || !report) return agent?.title ?? agent?.name ?? '';
    const d = new Date(model.firstTs * 1000).toLocaleString(lang === 'es' ? 'es-ES' : 'en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const p = projectLabel(projectKey, home);
    return t('consumo.session.of', { project: p === '~' ? t('consumo.homeLabel') : p, date: d });
  });
  const usdTotal = $derived(report ? sessionModel(report, 'usd', provider).total : 0);
  /** Un solo denominador: hilo principal + cada tipo de subagente suman el 100 % de la sesión. */
  const splitRows = $derived(model ? [
    { key: 'main', eq: unit === 'eq' ? model.mainCost : 0, usd: unit === 'usd' ? model.mainCost : 0, requests: 1, pct: model.mainPct },
    ...model.subTypes,
  ] : []);
</script>

<svelte:window onkeydown={onWindowKey} />

{#if openKey}
  <aside class="drawer cdrawer" bind:this={panel} tabindex="-1" aria-label={t('consumo.session.title')} transition:fly={{ x: 560, duration: dur(180) }}>
    <header>
      <div class="top">
        <Icon name="bars" size={14} />
        <span class="ttl">{t('consumo.session.title')}</span>
        <span class="prov">{tk(`consumo.provider.${provider}`)}</span>
        <span class="sp"></span>
        <button class="x" title={t('consumo.session.refresh')} aria-label={t('consumo.session.refresh')} onclick={() => void load()}><Icon name="refresh" size={13} /></button>
        <button class="x" title={t('consumo.close')} aria-label={t('consumo.close')} onclick={close}><Icon name="x" size={13} /></button>
      </div>
      <div class="desc" title={heading}>{heading}</div>
      <div class="unitrow"><Seg options={[{ id: 'eq', label: t('consumo.unit.eq') }, { id: 'usd', label: t('consumo.unit.usd') }]} value={unit} onchange={(u) => (unit = u)} /></div>
      {#if model}
        <div class="stats">
          <b>{fmtUnit(model.total, unit)}</b>
          <span class="unit" title={t('consumo.unitHint')}>{unit === 'usd' ? t('consumo.usdNote') : t('consumo.unitShort')} ⓘ</span>
          {#if unit === 'eq' && usdTotal > 0}<span class="note">≈ {fmtUsd(usdTotal, lang)} · {t('consumo.usdNote')}</span>{/if}
          <span class="subp"><b>{fmtPct(model.subPct, lang === 'es')}</b> {t('consumo.kpi.sub')} · {tn('consumo.row.agents', model.subCount)}</span>
          <span class="st">{t('consumo.session.stats', { n: fmtNum(model.requests, lang), max: fmtTok(model.maxContext), now: fmtTok(model.lastContext) })}</span>
        </div>
      {/if}
    </header>

    <div class="body">
      {#if phase === 'loading' && !model}
        <div class="msg">{t('consumo.session.loading')}</div>
      {:else if phase === 'none'}
        <div class="msg">{t('consumo.session.none')}</div>
      {:else if phase === 'error'}
        <div class="msg bad">{t('consumo.error', { err: tk(`consumo.error${errorKind(err)[0].toUpperCase()}${errorKind(err).slice(1)}`) })}
          <details class="raw"><summary>{t('consumo.errorDetail')}</summary><code>{err}</code></details></div>
      {:else if model}
        <section>
          <h3>{t('consumo.sec.cats')}</h3>
          <ConsumoStack slices={model.slices} {unit} {cats} />
        </section>
        {#if report?.advice}
          <section>
            <h3>{t('consumo.advice.title')} <small>{t('consumo.advice.hintSession')}</small></h3>
            <ConsumoAdvice advice={report.advice} total={report.adviceTotal} {home} {projectKey} {unit} limit={4} canOpen={false} />
          </section>
        {/if}
        <section>
          <h3>{t('consumo.session.context')} <small>{t('consumo.session.contextHint')}</small></h3>
          <ConsumoContext line={model.line} markers={model.markers} />
        </section>
        <section class="two">
          <div>
            <h3>{t('consumo.session.base')}</h3>
            <p class="hint">{t('consumo.session.baseHint', { tok: fmtTok(model.base) })}</p>
            <ConsumoRanks unit="eq" rows={model.baseParts.map((p) => ({ key: p.label, eq: model.base * p.pct, usd: 0, requests: 0, pct: p.pct }))}
              label={(r) => baseLabel(r.key)} />
          </div>
          <div>
            <h3>{t('consumo.session.split')}</h3>
            <p class="hint">{t('consumo.session.splitHint')}</p>
            <ConsumoRanks {unit} rows={splitRows}
              label={(r) => (r.key === 'main' ? t('consumo.row.main') : r.key ? subLabel(r.key) : t('consumo.row.other', { n: r.other ?? 0 }))}
              sub={(r) => (r.key === 'main' ? '' : tn('consumo.row.agents', r.requests))} />
          </div>
        </section>
        <section>
          <h3>{t('consumo.sec.topGrouped')}</h3>
          <p class="hint">{t('consumo.sec.topGroupedHintSession')}</p>
          <ConsumoTopGroups rows={model.top} origins={report?.origins} {unit} total={model.total} {home} {projectKey} limit={5} pathMax={30} />
        </section>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .drawer { --muted: #9aa1ab; --faint: #858d98; position: fixed; top: 0; right: 0; bottom: 0; width: var(--consumo-drawer, min(560px, 100vw)); z-index: 50; display: flex; flex-direction: column; background: var(--panel); border-left: 1px solid var(--border-strong); box-shadow: -14px 0 40px rgba(0, 0, 0, 0.45); outline: none; }
  header { padding: 8px 10px 10px 14px; border-bottom: 1px solid var(--border); display: grid; gap: 4px; flex: none; }
  .top { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--info); }
  .ttl { color: var(--text); font-weight: 600; font-size: 13px; white-space: nowrap; }
  .unitrow { display: flex; margin: 2px 0; }
  .prov { font-size: 10px; color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; }
  .sp { flex: 1; }
  .x { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 5px; color: var(--muted); }
  .x:hover { background: var(--raise); color: var(--text); }
  .unit { font-size: 11px; color: var(--muted); cursor: help; }
  .subp b { font-size: 13px; }
  .st { flex-basis: 100%; font-size: 11px; color: var(--faint); }
  .desc { font-size: 12.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stats { display: flex; align-items: baseline; gap: 10px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
  .stats b { font-size: 20px; color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
  .note { font-size: 10.5px; color: var(--faint); }
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px 18px; display: grid; gap: 20px; align-content: start; }
  section { display: grid; gap: 8px; min-width: 0; }
  section.two { grid-template-columns: 1fr; gap: 20px; }
  section.two > div { display: grid; gap: 8px; align-content: start; min-width: 0; }
  h3 { margin: 0; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  h3 small { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--faint); margin-left: 6px; }
  .hint { margin: -4px 0 0; font-size: 11px; color: var(--faint); }
  .msg { color: var(--faint); font-size: 12px; text-align: center; padding: 20px 0; }
  .msg.bad { color: var(--bad); }
  .raw { color: var(--muted); font-size: 11px; margin-top: 6px; }
  .raw summary { cursor: pointer; }
  .raw code { display: block; white-space: pre-wrap; overflow-wrap: anywhere; text-align: left; }
</style>
