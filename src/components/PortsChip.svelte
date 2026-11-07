<script lang="ts">
  // Chip «⇄ 2» en la cabecera de un panel SSH de un host guardado: abre la lista de reenvíos de ese host (remoto → local,
  // estado, abrir, copiar URL, guardar en el host, parar) y «Reenviar un puerto…».
  import { app } from '../lib/store.svelte.ts';
  import { forwards } from '../lib/forwards.svelte.ts';
  import { hostOfPane } from '../lib/remotemetrics.ts';
  import { tunnelLook, type TunnelSnap } from '../lib/portdetect.ts';
  import type { Pane } from '../lib/model.ts';
  import { t } from '../lib/i18n.ts';
  import Icon from './Icon.svelte';

  let { pane }: { pane: Pane } = $props();
  let open = $state(false);
  let wrap = $state<HTMLElement>();

  const host = $derived(hostOfPane(pane, app.hosts));
  const list = $derived(host ? forwards.ofHost(host.id) : []);
  const bad = $derived(list.some((x) => x.state === 'down' || x.state === 'error'));

  function stateText(s: TunnelSnap): string {
    if (s.state === 'up') return t('ports.state.up');
    if (s.state === 'connecting') return t('ports.state.connecting');
    if (s.state === 'down') return s.retryIn ? t('ports.state.downRetry', { s: s.retryIn }) : t('ports.state.down');
    return t('ports.state.error');
  }
  function outside(e: PointerEvent) { if (open && wrap && !wrap.contains(e.target as Node)) open = false; }
</script>

<svelte:window onpointerdown={outside} onkeydown={(e) => { if (open && e.key === 'Escape') open = false; }} />

{#if host}
  <span class="pw" bind:this={wrap}>
    {#if list.length}
      <button class="chip pc" class:bad onclick={() => (open = !open)} title={t('ports.chip.title')} aria-label={t('ports.chip.aria', { n: list.length })} aria-expanded={open} data-testid="ports-chip">
        <Icon name="swap" size={11} />{list.length}
      </button>
    {:else}
      <button class="iconbtn" onclick={() => (open = !open)} title={t('ports.chip.emptyTitle')} aria-label={t('ports.chip.emptyTitle')} aria-expanded={open} data-testid="ports-chip"><Icon name="swap" size={13} /></button>
    {/if}
    {#if open}
      <div class="pop" role="dialog" aria-label={t('ports.list.title', { host: host.name || host.host })}>
        <div class="ph">{t('ports.list.title', { host: host.name || host.host })}</div>
        {#if !list.length}<div class="empty">{t('ports.list.empty')}</div>{/if}
        {#each list as s (s.id)}
          {@const look = tunnelLook(s)}
          {@const saved = forwards.isSaved(s)}
          <div class="row" data-testid="port-row">
            <span class="dot {look}" title={s.error ?? ''}></span>
            <span class="map"><b>{s.remotePort}</b><i>→</i><span class="loc">localhost:{s.localPort || '…'}</span><!-- i18n-ignore: dirección --></span>
            <span class="st {look}" title={s.error ?? ''}>{stateText(s)}</span>
            <span class="acts">
              <button class="ib" title={t('ports.list.open')} aria-label={t('ports.list.open')} disabled={look === 'bad'} onclick={() => forwards.open(s)}><Icon name="external" size={13} /></button>
              <button class="ib" title={t('ports.list.copy')} aria-label={t('ports.list.copy')} disabled={!s.localPort} onclick={() => void forwards.copy(s)}><Icon name="copy" size={13} /></button>
              <button class="ib" class:on={saved} title={saved ? t('ports.list.unsave') : t('ports.list.save')} aria-label={saved ? t('ports.list.unsave') : t('ports.list.save')} aria-pressed={saved} onclick={() => forwards.toggleSaved(s)}><Icon name="pin" size={13} /></button>
              <button class="ib" title={t('ports.list.stop')} aria-label={t('ports.list.stop')} onclick={() => forwards.stop(s.id)}><Icon name="x" size={13} /></button>
            </span>
          </div>
          {#if s.error && look !== 'ok'}<div class="err">{s.error}</div>{/if}
        {/each}
        <button class="add" onclick={() => { open = false; forwards.openDialog(host.id); }}><Icon name="plus" size={12} />{t('ports.list.add')}</button>
      </div>
    {/if}
  </span>
{/if}

<style>
  .pw { position: relative; display: inline-flex; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--border-strong); font-size: 11.5px; color: var(--text); font-variant-numeric: tabular-nums; }
  .chip:hover { border-color: var(--accent); }
  .pc { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
  .pc.bad { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 50%, transparent); }
  .iconbtn { opacity: 0.75; }
  .pop {
    position: absolute; top: 24px; right: 0; z-index: 40; width: 340px; background: var(--panel); border: 1px solid var(--border-strong);
    border-radius: 9px; padding: 5px; box-shadow: 0 16px 50px rgba(0, 0, 0, 0.55); cursor: default; font-size: 12px;
  }
  .ph { color: var(--muted); font-size: 11px; padding: 5px 8px 6px; }
  .empty { color: var(--muted); padding: 4px 8px 8px; line-height: 1.4; }
  .row { display: grid; grid-template-columns: 10px 1fr auto auto; gap: 8px; align-items: center; padding: 5px 6px 5px 8px; border-radius: 6px; }
  .row:hover { background: var(--raise); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); }
  .dot.ok { background: var(--ok); }
  .dot.wait { background: var(--accent); animation: blink 1s ease-in-out infinite; }
  .dot.down { background: var(--warn); }
  .dot.bad { background: var(--bad); }
  @keyframes blink { 50% { opacity: 0.35; } }
  .map { display: flex; gap: 6px; align-items: baseline; font: 12px 'Cascadia Mono', Consolas, monospace; min-width: 0; }
  .map i { color: var(--faint); font-style: normal; }
  .loc { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st { font-size: 11px; color: var(--muted); white-space: nowrap; }
  .st.down { color: var(--warn); }
  .st.bad { color: var(--bad); }
  .acts { display: inline-flex; gap: 1px; }
  .ib { display: inline-flex; padding: 3px; border-radius: 5px; color: var(--muted); }
  .ib:hover:not(:disabled) { color: var(--text); background: var(--panel-2); }
  .ib:disabled { opacity: 0.35; }
  .ib.on { color: var(--accent); }
  .err { color: var(--bad); font-size: 11px; padding: 0 8px 5px 26px; overflow-wrap: anywhere; user-select: text; }
  .add { display: flex; align-items: center; gap: 7px; width: 100%; margin-top: 3px; padding: 7px 8px; border-radius: 6px; border-top: 1px solid var(--border); color: var(--text); text-align: left; }
  .add:hover { background: var(--raise); color: var(--accent); }
</style>
