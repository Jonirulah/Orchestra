<script lang="ts">
  // Aviso de versión nueva en la barra superior y diálogo de actualización (lógica en updater.svelte.ts).
  import { onMount } from 'svelte';
  import { updater } from '../lib/updater.svelte.ts';
  import { parseNotes } from '../lib/updatecheck.ts';
  import { t, tk } from '../lib/i18n.ts';
  import Icon from './Icon.svelte';

  onMount(() => updater.start());

  const u = updater;
  const busy = $derived(u.dialogOpen ? u.busy() : { agents: 0, ssh: 0, any: false });
  const blocks = $derived(u.info ? parseNotes(u.info.notes) : []);
  const working = $derived(u.status === 'downloading' || u.status === 'installing');
  const pctText = $derived(u.pct == null ? '' : `${u.pct} %`);
  const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;

  function busyText(): string {
    const parts: string[] = [];
    if (busy.agents) parts.push(t('updater.dialog.busyAgents', { n: busy.agents }));
    if (busy.ssh) parts.push(t('updater.dialog.busySsh', { n: busy.ssh }));
    return t('updater.dialog.busy', { what: parts.join(t('updater.dialog.busyJoin')) });
  }
  function fmtDate(d?: string | null): string {
    if (!d) return '';
    const x = new Date(d);
    return Number.isNaN(x.getTime()) ? '' : x.toLocaleDateString();
  }
  function primary() {
    if (u.portable) u.download();
    else void u.install();
  }
</script>

{#if u.showChip && u.info}
  <div class="upd-chip" class:err={u.status === 'error'} role="status">
    <Icon name="down" size={13} />
    {#if u.status === 'downloading'}
      <button class="lnk" onclick={() => u.openDialog()}>{t('updater.chip.downloading', { pct: pctText })}</button>
    {:else if u.status === 'installing'}
      <span>{t('updater.chip.installing')}</span>
    {:else}
      <button class="lnk ver" onclick={() => u.openDialog()}>{u.status === 'error' ? t('updater.chip.failed') : t('updater.chip.available', { version: u.info.version })}</button>
      <span class="dot">·</span>
      <button class="lnk" onclick={() => u.openDialog()}>{t('updater.chip.notes')}</button>
      <span class="dot">·</span>
      <button class="lnk strong" onclick={() => u.openDialog()}>{u.portable ? t('updater.chip.download') : t('updater.chip.update')}</button>
      <button class="iconbtn x" title={t('updater.chip.dismiss')} aria-label={t('updater.chip.dismiss')} onclick={() => u.dismiss()}><Icon name="x" size={11} /></button>
    {/if}
  </div>
{/if}

{#if u.dialogOpen && u.info}
  <div class="modal-back" role="presentation" onpointerdown={(e) => { if (e.target === e.currentTarget) u.closeDialog(); }}
    onkeydown={(e) => { if (e.key === 'Escape') u.closeDialog(); }}>
    <div class="modal upd-dlg" role="dialog" aria-modal="true" aria-labelledby="upd-title">
      <h2 id="upd-title">{t('updater.dialog.title', { version: u.info.version })}</h2>
      <div class="body">
        <p class="hint">{fmtDate(u.info.date) ? t('updater.dialog.versions', { current: u.current, date: fmtDate(u.info.date) }) : t('updater.dialog.versionsNoDate', { current: u.current })}</p>
        <div class="notes">
          {#each blocks as b, i (i)}
            <svelte:element this={b.kind === 'h' ? 'h4' : b.kind === 'li' ? 'li' : 'p'}>
              {#each b.spans as sp, j (j)}{#if sp.bold}<b>{sp.text}</b>{:else if sp.code}<code>{sp.text}</code>{:else}{sp.text}{/if}{/each}
            </svelte:element>
          {:else}
            <p>{t('updater.dialog.noNotes')}</p>
          {/each}
        </div>
        {#if u.portable}
          <p class="s-msg warn">{t('updater.dialog.portable')}</p>
        {:else if busy.any && !working}
          <p class="s-msg warn" role="alert">{busyText()}</p>
        {:else if !working}
          <p class="hint">{t('updater.dialog.closesHint')}</p>
        {/if}
        {#if working}
          <div class="bar" class:indet={u.pct == null && u.status === 'downloading'}><i style:width="{u.status === 'installing' ? 100 : (u.pct ?? 30)}%"></i></div>
          <p class="hint">
            {#if u.status === 'installing'}{t('updater.dialog.installing')}
            {:else if u.pct != null}{t('updater.dialog.downloading', { pct: pctText })}
            {:else}{t('updater.dialog.downloadingSize', { got: mb(u.got) })}{/if}
          </p>
        {/if}
        {#if u.status === 'error' && u.errorKind}
          <p class="s-msg err" role="alert">{tk(`updater.error.${u.errorKind}`)}{#if u.errorText && u.errorKind !== 'portable'}<small>{u.errorText}</small>{/if}</p>
        {/if}
      </div>
      <div class="foot">
        <button class="btn ghost" disabled={working} onclick={() => u.closeDialog()}>{t('updater.dialog.later')}</button>
        <button class="btn primary" disabled={working || (u.status === 'error' && u.errorKind === 'signature')} onclick={primary}>
          {u.portable ? t('updater.dialog.download') : busy.any ? t('updater.dialog.updateAnyway') : t('updater.dialog.update')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .upd-chip { display: flex; align-items: center; gap: 5px; padding: 3px 4px 3px 9px; border-radius: 13px; border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent); font-size: 12px; white-space: nowrap; }
  .upd-chip.err { border-color: var(--bad); color: var(--bad); background: rgba(239, 107, 115, 0.1); }
  .lnk { color: inherit; padding: 0 1px; }
  .lnk:hover { text-decoration: underline; }
  .ver { color: var(--text); }
  .strong { font-weight: 600; }
  .dot { opacity: 0.6; }
  .x { width: 18px; height: 18px; color: inherit; }
  .upd-dlg { width: min(560px, 94vw); }
  .notes { max-height: 300px; overflow: auto; font-size: 12.5px; line-height: 1.5; background: var(--raise); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px 8px 26px; user-select: text; }
  .notes :global(h4) { margin: 6px 0 2px -14px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .notes :global(li) { margin: 2px 0; }
  .notes :global(p) { margin: 4px 0 4px -14px; }
  .notes :global(code) { font-size: 11.5px; background: var(--panel); padding: 0 4px; border-radius: 4px; }
  .s-msg.warn { background: rgba(245, 185, 66, 0.1); border-color: rgba(245, 185, 66, 0.45); color: var(--accent); }
  .s-msg small { display: block; margin-top: 4px; opacity: 0.8; word-break: break-word; }
  .bar { height: 6px; border-radius: 3px; background: var(--raise); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); transition: width 0.15s; }
  .bar.indet i { animation: slide 1.1s linear infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
</style>
