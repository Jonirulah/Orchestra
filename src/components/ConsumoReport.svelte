<script lang="ts">
  // Diálogo «Copiar informe para tu IA»: genera el Markdown (consumo/informe.rs), enseña su tamaño en tokens antes de
  // copiar y avisa si pasa de ~8k; nivel de detalle resumen/completo; copiar al portapapeles o guardar como .md.
  import { onMount } from 'svelte';
  import { app } from '../lib/store.svelte.ts';
  import * as be from '../lib/backend.ts';
  import { t, getLocale } from '../lib/i18n.ts';
  import { reportTokens, REPORT_WARN_TOKENS, fmtNum } from '../lib/consumo.ts';
  import Seg from './Seg.svelte';

  let { days, onclose }: { days: number; onclose: () => void } = $props();
  let detail = $state<'summary' | 'full'>('summary');
  let md = $state('');
  let busy = $state(false);
  let msg = $state<{ ok: boolean; text: string } | null>(null);
  const loc = $derived(getLocale() === 'es' ? 'es-ES' : 'en-US');
  const tok = $derived(reportTokens(md));
  const kb = $derived((new TextEncoder().encode(md).length / 1024).toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

  async function build() {
    busy = true; msg = null;
    try { md = await be.consumoReport(days, detail, app.adviceOpts()); }
    catch (e) { md = ''; msg = { ok: false, text: t('consumo.report.failed', { err: String(e) }) }; }
    finally { busy = false; }
  }
  function setDetail(d: 'summary' | 'full') { detail = d; void build(); }
  async function copy() {
    try { await navigator.clipboard.writeText(md); msg = { ok: true, text: t('consumo.report.copied') }; app.toast(t('consumo.report.copied')); }
    catch (e) { msg = { ok: false, text: t('consumo.report.failed', { err: String(e) }) }; }
  }
  async function save() {
    try { const path = await be.consumoSaveReport(md); msg = { ok: true, text: t('consumo.report.saved', { path }) }; }
    catch (e) { msg = { ok: false, text: t('consumo.report.failed', { err: String(e) }) }; }
  }
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onclose(); } }
  onMount(() => { void build(); });
</script>

<svelte:window onkeydown={onKey} />

<div class="modal-back" role="presentation" onpointerdown={(e) => { if (e.target === e.currentTarget) onclose(); }}>
  <div class="modal rep" role="dialog" aria-modal="true" aria-label={t('consumo.report.title')}>
    <h2>{t('consumo.report.title')}</h2>
    <div class="body">
      <p class="intro">{t('consumo.report.intro', { days })}</p>
    <div class="bar">
      <Seg options={[{ id: 'summary', label: t('consumo.report.summary') }, { id: 'full', label: t('consumo.report.full') }]} value={detail} onchange={setDetail} />
      <span class="size" class:warn={tok > REPORT_WARN_TOKENS}>
        {busy ? t('consumo.report.loading') : t('consumo.report.size', { tok: fmtNum(tok, getLocale() === 'es' ? 'es' : 'en'), kb })}
      </span>
    </div>
    {#if !busy && tok > REPORT_WARN_TOKENS}<div class="msg warn">{t('consumo.report.big', { max: fmtNum(REPORT_WARN_TOKENS, getLocale() === 'es' ? 'es' : 'en') })}</div>{/if}
    <textarea readonly aria-label={t('consumo.report.preview')} value={md} spellcheck="false"></textarea>
    {#if msg}<div class="msg" class:bad={!msg.ok}>{msg.text}</div>{/if}
    </div>
    <div class="foot">
      <button class="btn" disabled={busy || !md} onclick={() => void save()}>{t('consumo.report.save')}</button>
      <button class="btn primary" disabled={busy || !md} onclick={() => void copy()}>{t('consumo.report.copy')}</button>
      <button class="btn ghost" onclick={onclose}>{t('consumo.close')}</button>
    </div>
  </div>
</div>

<style>
  .rep { --muted: #9aa1ab; --faint: #858d98; width: min(760px, 94vw); }
  .intro { margin: 0; font-size: 12px; color: var(--muted); }
  .bar { display: flex; align-items: center; gap: 12px; }
  .size { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .size.warn { color: var(--warn); }
  textarea { width: 100%; height: 340px; resize: vertical; font-family: var(--mono, monospace); font-size: 11.5px; line-height: 1.45;
    background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; box-sizing: border-box; }
  .msg { font-size: 12px; color: var(--ok, var(--muted)); }
  .msg.warn { color: var(--warn); }
  .msg.bad { color: var(--bad); }
</style>
