<script lang="ts">
  import { app } from '../lib/store.svelte.ts';
  import { t } from '../lib/i18n.ts';

  // El más antiguo primero. Sin botón de cerrar ni Escape que apruebe: Escape y clic fuera DENIEGAN.
  const r = $derived(app.mcpApprovals[0]);
  const more = $derived(app.mcpApprovals.length - 1);

  function focusMe(el: HTMLElement) { el.focus(); }
  function deny() { if (r) app.answerMcpApproval(r.id, false); }
  function allow() { if (r) app.answerMcpApproval(r.id, true); }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && r) { e.preventDefault(); deny(); } }} />

{#if r}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-back" onpointerdown={(e) => { if (e.target === e.currentTarget) deny(); }}>
    <div class="modal" role="alertdialog" aria-modal="true" aria-label={t('mcp.approval.aria')} tabindex="-1" use:focusMe>
      <h2>{t('mcp.approval.title')}</h2>
      <div class="body">
        <p class="hint">{t('mcp.approval.intro', { host: r.host })}</p>
        <div class="who">
          <span class="k">{t('mcp.approval.hostLabel')}</span>
          <b>{r.host}</b>
          <span class="addr">{r.address}</span>
        </div>
        <div class="k">{t('mcp.approval.commandLabel')}</div>
        <pre class="cmd" data-testid="mcp-approval-command">{r.command}</pre>
        <p class="note">{t('mcp.approval.timeoutNote', { secs: r.timeoutSecs })} {t('mcp.approval.expires', { secs: r.expiresInSecs })}</p>
        <p class="warn">{t('mcp.approval.warning')}</p>
        {#if more > 0}<p class="note">{t('mcp.approval.queue', { n: more })}</p>{/if}
      </div>
      <div class="foot">
        <button class="btn primary" onclick={deny}>{t('mcp.approval.deny')}</button>
        <button class="btn ghost" onclick={allow}>{t('mcp.approval.allow')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .who { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .addr { color: var(--muted); font: 12px 'Cascadia Mono', Consolas, monospace; }
  .cmd { margin: 0; padding: 9px 11px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--border); font: 12.5px 'Cascadia Mono', Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 40vh; overflow: auto; user-select: text; }
  .note { margin: 0; color: var(--muted); font-size: 12px; }
  .warn { margin: 0; padding: 8px 11px; border-radius: 7px; font-size: 12px; line-height: 1.4; color: var(--text); background: rgba(245, 185, 66, 0.1); border: 1px solid rgba(245, 185, 66, 0.4); }
</style>
