<script lang="ts">
  // Consejos del motor (consumo/consejos.rs): gravedad, ahorro estimado, por qué, qué hacer y la prueba (abre la sesión).
  // «Ocultar» quita ese caso al momento y para siempre (se guarda en el estado de Orchestra).
  import type { ConsumoAdvice } from '../lib/backend.ts';
  import { app } from '../lib/store.svelte.ts';
  import { t, tk, getLocale } from '../lib/i18n.ts';
  import { fmtTok, fmtUsd, fmtPct, fmtUnit, shortPath, projectKeyOf, visibleAdvice, adviceShare, adviceText, adviceAssume, sortAdvice, evidenceLabel, langOf, modelName, type Unit } from '../lib/consumo.ts';

  let { advice, home = '', projectKey = '', limit = 5, canOpen = true, unit = 'eq', total }:
    { advice: ConsumoAdvice[] | undefined; home?: string; projectKey?: string; limit?: number; canOpen?: boolean; unit?: Unit; total?: [number, number] } = $props();
  let all = $state(false);
  let open = $state<string | null>(null);
  const loc = $derived(getLocale());
  // C11: en el orden de la unidad de la pantalla (eq o USD).
  const list = $derived(sortAdvice(visibleAdvice(advice, app.consumoDismissed), unit));
  const shown = $derived(all ? list : list.slice(0, limit));
  const pct = (p: number) => fmtPct(p, loc === 'es');
  const label = (s: string, session?: string) => shortPath(s, projectKey || projectKeyOf(session), '', home);
  const lang = $derived(langOf(loc));
  /** Fila de «Bloques más caros» del origen (si la tiene). */
  const hasRow = (a: ConsumoAdvice) => /^(read|bash|image|reminder)\|/.test(a.origin ?? '');
  /** Nombre del origen o la partida que cita el consejo, en el idioma de la interfaz. */
  function originName(a: ConsumoAdvice): string {
    const o = a.origin ?? '';
    if (o.startsWith('cat:')) return o.slice(4).split(',').map((c) => tk(`consumo.cat.${c}`)).join(' + ');
    if (o.startsWith('event:')) return tk(`consumo.advice.originEv.${o.slice(6)}`);
    if (o.startsWith('gen|')) {
      const [, who, model] = o.split('|');
      return who === 'main' ? t('consumo.advice.genOriginMain', { mn: modelName(model ?? '') }) : t('consumo.advice.genOrigin', { who: who ?? '', mn: modelName(model ?? '') });
    }
    if (o.startsWith('read|')) return label(a.originLabel ?? '', undefined) || o;
    if (o.startsWith('image|')) return tk('consumo.cat.image');
    if (o.startsWith('session|')) return t('consumo.advice.thatSession');
    if (!o) return t('consumo.advice.wholeTotal');
    return a.originLabel ?? o;
  }
  /** Cifra en la unidad de la pantalla, con «eq» si es eq. */
  const amt = (usd: number, eq: number) => unit === 'usd' ? fmtUsd(usd, lang) : `${fmtTok(eq, lang)} eq`;
  /** C11: «de 2,8 M → ~0,9 M en «cargo test» (total 53,6 M del periodo), suponiendo salidas recortadas a 3 k». */
  const basis = (a: ConsumoAdvice) => {
    const before = unit === 'usd' ? (a.originUsd ?? 0) : (a.originEq ?? 0);
    const after = unit === 'usd' ? (a.afterUsd ?? before - a.saveUsd) : (a.afterEq ?? before - a.saveEq);
    return t('consumo.advice.beforeAfter', {
      before: fmtUnit(before, unit, lang),
      after: fmtUnit(Math.max(0, after), unit, lang),
      what: originName(a),
      y: fmtUnit(unit === 'usd' ? (a.totalUsd ?? 0) : (a.totalEq ?? 0), unit, lang),
      scope: t(a.session ? 'consumo.advice.scopeSession' : 'consumo.advice.scopePeriod'),
      assume: adviceAssume(a),
    }).replace(/, $/, '');
  };
  /** Ahorro de todos sin doble conteo (Rust `total_saving`); solo si la lista es la misma que la que lo calculó. */
  const totalAll = $derived.by(() => {
    if (!total || !advice?.length || list.length !== advice.length) return null;
    const v = unit === 'usd' ? total[0] : total[1];
    const tot = unit === 'usd' ? (advice[0].totalUsd ?? 0) : (advice[0].totalEq ?? 0);
    if (!(v > 0) || !(tot > 0)) return null;
    const sum = advice.reduce((s, a) => s + (unit === 'usd' ? a.saveUsd : a.saveEq), 0);
    return {
      text: t('consumo.advice.allTotal', { abs: amt(total[0], total[1]), pct: pct(v / tot), scope: t(advice[0].session ? 'consumo.advice.scopeSession' : 'consumo.advice.scopePeriod') }),
      title: t('consumo.advice.allTotalTitle', { sum: unit === 'usd' ? fmtUsd(sum, lang) : `${fmtTok(sum, lang)} eq` }),
    };
  });
  const goRow = (a: ConsumoAdvice) => window.dispatchEvent(new CustomEvent('consumo-origin', { detail: a.origin }));
</script>

{#if !list.length}
  <div class="none">{t('consumo.advice.none')}</div>
{:else}
  {#if totalAll}<div class="tot" title={totalAll.title}>{totalAll.text}</div>{/if}
  <ol class="adv">
    {#each shown as a (a.id)}
      <li class="sev-{a.severity}">
        <div class="row">
          <span class="chip" title={tk(`consumo.advice.sev.${a.severity}`)}>{tk(`consumo.advice.sev.${a.severity}`)}</span>
          <button type="button" class="ttl" aria-expanded={open === a.id} onclick={() => (open = open === a.id ? null : a.id)}>{adviceText(a, 'title')}</button>
          {#if a.severity !== 'info'}
            <span class="save" title={t('consumo.advice.savesTitle', { eq: fmtTok(a.saveEq), usd: fmtUsd(a.saveUsd) })}>
              {t('consumo.advice.saves', { abs: amt(a.saveUsd, a.saveEq), pct: pct(adviceShare(a, unit)) })} <small>{t('consumo.advice.estimate')}</small>
            </span>
          {/if}
          <button type="button" class="btn ghost sm" title={t('consumo.advice.dismissTitle')} onclick={() => app.dismissAdvice(a.id)}>{t('consumo.advice.dismiss')}</button>
        </div>
        {#if open !== a.id}
          <!-- «Qué hacer» siempre a la vista, en una línea; entero al desplegar (y en el tooltip). -->
          <div class="do"><b>{t('consumo.advice.action')}:</b> {adviceText(a, 'action')}</div>
          {#if a.severity !== 'info' && a.totalEq}
            <div class="bas">{basis(a)}{#if hasRow(a)} · <button type="button" class="lnk" onclick={() => goRow(a)}>{t('consumo.advice.goRow')}</button>{/if}</div>
          {/if}
        {:else}
          <div class="det">
            <p>{adviceText(a, 'why')}</p>
            <p><b>{t('consumo.advice.action')}:</b> {adviceText(a, 'action')}</p>
            {#if a.severity !== 'info' && a.totalEq}
              <p class="bas">{basis(a)}{#if hasRow(a)} · <button type="button" class="lnk" onclick={() => goRow(a)}>{t('consumo.advice.goRow')}</button>{/if}</p>
            {/if}
            {#if a.evidence.length}
              <div class="evh">{t('consumo.advice.evidence')}</div>
              <ul class="ev">
                {#each a.evidence as e, i (i)}
                  <li>
                    <code title={evidenceLabel(e)}>{e.labelId ? evidenceLabel(e) : label(e.label, e.session)}</code>
                    <span class="meta">
                      {#if e.who}{e.who === 'main' ? t('consumo.row.main') : e.who} · {/if}
                      {#if e.tokens}{t('consumo.advice.tokens', { n: fmtTok(e.tokens) })}{/if}
                      {#if e.rereads} · {t('consumo.advice.rereads', { n: e.rereads })}{/if}
                      {#if e.req !== undefined && e.req !== null} · {t('consumo.advice.req', { n: e.req + 1 })}{/if}
                    </span>
                    {#if canOpen && e.session}
                      <button type="button" class="lnk" onclick={() => { app.consumoPane = null; app.consumoPath = e.session ?? null; }}>{t('consumo.advice.open')}</button>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ol>
{/if}
<div class="foot">
  {#if list.length > limit}
    <button type="button" class="lnk" onclick={() => (all = !all)}>{all ? t('consumo.advice.less') : t('consumo.advice.more', { n: list.length })}</button>
  {/if}
  {#if app.consumoDismissed.length}
    <button type="button" class="lnk" onclick={() => app.restoreAdvice()}>{t('consumo.advice.restore', { n: app.consumoDismissed.length })}</button>
  {/if}
</div>

<style>
  .none { font-size: 12px; color: var(--faint); }
  .tot { font-size: 12px; color: var(--text); font-weight: 600; margin: 0 0 6px 0; font-variant-numeric: tabular-nums; cursor: help; }
  .adv { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .adv > li { border: 1px solid var(--border); border-left: 3px solid var(--faint); border-radius: 6px; padding: 6px 8px; background: var(--bg); min-width: 0; }
  .adv > li.sev-high { border-left-color: var(--bad); }
  .adv > li.sev-medium { border-left-color: var(--warn); }
  .adv > li.sev-low { border-left-color: var(--info); }
  .row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .chip { font-size: 10px; color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; flex: none; }
  .sev-high .chip { color: var(--bad); }
  .sev-medium .chip { color: var(--warn); }
  .ttl { flex: 1; min-width: 0; text-align: left; font-size: 12.5px; color: var(--text); overflow-wrap: anywhere; line-height: 1.35; }
  .ttl:hover { text-decoration: underline; }
  .save { flex: none; font-size: 12px; color: var(--text); font-variant-numeric: tabular-nums; }
  .save small { color: var(--faint); font-size: 10px; }
  .btn.sm { font-size: 11px; padding: 1px 7px; flex: none; }
  /* «Qué hacer» entero, siempre (pasa de línea; nunca «…»). */
  .do { margin: 3px 0 0 0; font-size: 11.5px; color: var(--muted); overflow-wrap: anywhere; min-width: 0; line-height: 1.4; }
  .bas { margin: 2px 0 0 0; font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .do b { color: var(--text); font-weight: 600; }
  .det { padding: 6px 2px 2px 2px; font-size: 12px; color: var(--muted); display: grid; gap: 4px; }
  .det p { margin: 0; }
  .det b { color: var(--text); font-weight: 600; }
  .evh { font-size: 10.5px; color: var(--faint); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 2px; }
  .ev { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
  /* La ruta entera, sin cortar el nombre: si no cabe, la meta pasa debajo. */
  /* Prueba | cifras | «Abrir esta sesión»: el enlace siempre en la misma columna, a la derecha. */
  .ev li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: baseline; gap: 2px 10px; min-width: 0; }
  .ev code { font-size: 11px; color: var(--text); overflow-wrap: anywhere; min-width: 0; flex: 0 1 auto; }
  .meta { font-size: 11px; color: var(--faint); flex: none; font-variant-numeric: tabular-nums; }
  .lnk { font-size: 11px; color: var(--accent); flex: none; }
  .lnk:hover { text-decoration: underline; }
  .foot { display: flex; gap: 14px; }
  .foot:empty { display: none; }
</style>
