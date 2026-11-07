<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '../lib/store.svelte.ts';
  import * as be from '../lib/backend.ts';
  import { claudeAddCommand } from '../lib/mcpsync.ts';
  import { t } from '../lib/i18n.ts';
  import Toggle from './Toggle.svelte';

  const DEFAULT_PORT = 47821;

  const s = $derived(app.settings);
  const info = $derived(app.mcp);

  let audit = $state<be.McpAuditEntry[]>([]);
  let msg = $state<{ ok: boolean; text: string } | null>(null);
  let armed = $state(false);
  let armTimer: number | undefined;

  function resultText(e: be.McpAuditEntry): string {
    if (e.decision === 'approved') return t('settings.mcp.resultApproved');
    if (e.decision === 'auto') return t('settings.mcp.resultAuto');
    if (e.decision === 'expired') return t('settings.mcp.resultExpired');
    return e.outcome === 'denied' ? t('settings.mcp.resultDenied') : t('settings.mcp.resultAllowed');
  }

  async function loadAudit() {
    try { audit = await be.mcpAudit(50); } catch { /* sin backend: lista vacía */ }
  }

  onMount(() => {
    void loadAudit();
    const timer = window.setInterval(() => void loadAudit(), 4000);
    return () => { window.clearInterval(timer); clearTimeout(armTimer); };
  });

  async function copy(text: string, okText: string) {
    try {
      await be.copyText(text);
      msg = { ok: true, text: okText };
    } catch (e) {
      msg = { ok: false, text: t('settings.mcp.copyFailed', { error: String(e) }) };
    }
  }

  async function copyToken() {
    const token = await be.mcpToken();
    if (!token) { msg = { ok: false, text: t('settings.mcp.noToken') }; return; }
    await copy(token, t('settings.mcp.copiedToken'));
  }

  async function copyCommand() {
    const token = await be.mcpToken();
    if (!token || !info?.url) { msg = { ok: false, text: t('settings.mcp.notRunningToast') }; return; }
    await copy(claudeAddCommand(info.url, token), t('settings.mcp.copiedCommand'));
  }

  async function regenerate() {
    if (!armed) {
      armed = true;
      clearTimeout(armTimer);
      armTimer = window.setTimeout(() => (armed = false), 2800);
      return;
    }
    armed = false;
    app.mcp = await be.mcpRegenerateToken();
    msg = { ok: true, text: t('settings.mcp.regenerated') };
  }

  const shown = $derived(info?.url ? claudeAddCommand(info.url, '<token>') : ''); // i18n-ignore: marcador del comando, no se traduce
  const when = (ts: string) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString(); };
  const kb = (n: number) => (n ? (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`) : '–');
</script>

<div class="s-row">
  <div class="lbl">
    <b>{t('settings.mcp.enableLabel')}</b>
    <small>{t('settings.mcp.enableHint')}</small>
  </div>
  <div class="ctl"><Toggle value={s.mcpEnabled} label={t('settings.mcp.enableLabel')} onchange={(v) => app.setting('mcpEnabled', v)} /></div>
</div>

<div class="s-row stack">
  <div class="lbl"><b>{t('settings.mcp.statusLabel')}</b></div>
  {#if !s.mcpEnabled}
    <p class="s-state">{t('settings.mcp.statusOff')}</p>
  {:else if info?.running}
    <p class="s-state ok">{@html t('settings.mcp.statusListening', { port: Number(info.port) })}</p>
  {:else}
    <p class="s-state bad">{info?.error ? t('settings.mcp.statusNotRunningError', { error: info.error }) : t('settings.mcp.statusNotRunning')}</p>
  {/if}
  {#if s.mcpEnabled && info?.running && info.error}<p class="s-state bad">{info.error}</p>{/if}
  {#if s.mcpEnabled && info?.running && info.port !== DEFAULT_PORT}<p class="s-state">{t('settings.mcp.portTaken', { port: DEFAULT_PORT })}</p>{/if}
  {#if s.mcpEnabled && info?.warning}<p class="s-state bad" role="alert">{t('settings.mcp.securityWarning', { warning: info.warning })}</p>{/if}
  <small class="note">{t('settings.mcp.openTerminalsNote')}</small>
</div>

<div class="s-row">
  <div class="lbl">
    <b>{t('settings.mcp.exposeLocalLabel')}</b>
    <small>{t('settings.mcp.exposeLocalHint')}</small>
  </div>
  <div class="ctl"><Toggle value={s.mcpExposeLocal} label={t('settings.mcp.exposeLocalLabel')} onchange={(v) => app.setting('mcpExposeLocal', v)} /></div>
</div>

<div class="s-row stack">
  <div class="lbl">
    <b>{t('settings.mcp.tokenLabel')}</b>
    <small>{t('settings.mcp.tokenHint')}</small>
  </div>
  <div class="s-actions">
    <button class="btn" onclick={copyToken} disabled={!info?.running}>{t('settings.mcp.copyToken')}</button>
    <button class="btn danger" class:armed onclick={regenerate}>{armed ? t('settings.mcp.regenerateConfirm') : t('settings.mcp.regenerate')}</button>
  </div>
</div>

<div class="s-row stack">
  <div class="lbl">
    <b>{t('settings.mcp.otherSessionsLabel')}</b>
    <small>{t('settings.mcp.otherSessionsHint')}</small>
  </div>
  <div class="s-path"><code>{shown || t('settings.mcp.commandPlaceholder')}</code></div>
  <div class="s-actions"><button class="btn" onclick={copyCommand} disabled={!info?.running}>{t('settings.mcp.copyCommand')}</button></div>
</div>

{#if msg}<p class="s-msg" class:err={!msg.ok} role="status">{msg.text}</p>{/if}

<div class="s-row stack">
  <div class="lbl">
    <b>{t('settings.mcp.activityLabel')}</b>
    <small>{t('settings.mcp.activityHint')}</small>
  </div>
  {#if audit.length}
    <table class="audit">
      <thead><tr><th>{t('settings.mcp.colTime')}</th><th>{t('settings.mcp.colTool')}</th><th>{t('settings.mcp.colTarget')}</th><th>{t('settings.mcp.colResult')}</th><th>{t('settings.mcp.colSize')}</th></tr></thead>
      <tbody>
        {#each audit as e, i (e.ts + i)}
          <tr class:denied={e.outcome === 'denied'} title={e.reason ?? ''}>
            <td>{when(e.ts)}</td>
            <td><code>{e.tool}</code></td>
            <td>{e.host ?? ''}{e.host && (e.target || e.command) ? ' · ' : ''}{e.target ?? ''}{#if e.command}<code class="cmd" title={e.command}>{e.command}</code>{/if}</td>
            <td>{resultText(e)}</td>
            <td>{kb(e.bytes)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="s-state">{t('settings.mcp.activityEmpty')}</p>
  {/if}
</div>

<style>
  .s-state { margin: 0; color: var(--muted); }
  .s-state.ok { color: var(--ok); }
  .s-state.bad { color: var(--bad); }
  .note { color: var(--faint); font-size: 11.5px; }
  .audit { width: 100%; border-collapse: collapse; font-size: 12px; }
  .audit th { text-align: left; color: var(--muted); font-weight: 600; font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; padding: 4px 6px; border-bottom: 1px solid var(--border-strong); }
  .audit td { padding: 5px 6px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  .audit tr.denied td { color: var(--bad); }
  .audit code.cmd { display: inline-block; max-width: 280px; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
  .audit code { font: 12px 'Cascadia Mono', Consolas, monospace; }
</style>
