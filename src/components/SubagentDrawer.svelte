<script lang="ts">
  // Cajón lateral de solo lectura con la transcripción en vivo de un subagente. Todo el texto se pinta como nodos de texto
  // (nunca como HTML); el backend manda solo ids y eventos ya reducidos.
  import { tick, untrack } from 'svelte';
  import { fly } from 'svelte/transition';
  import { app } from '../lib/store.svelte.ts';
  import * as be from '../lib/backend.ts';
  import { t } from '../lib/i18n.ts';
  import { emptyState, mergeChunk, buildItems, preview, fmtTime, atBottom, pollDelay } from '../lib/subtranscript.ts';
  import Icon from './Icon.svelte';

  const dur = (ms: number) => (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms);

  let st = $state(emptyState());
  let failed = $state(false);
  let follow = $state(true);
  let expanded = $state<Record<number, boolean>>({});
  let listEl = $state<HTMLDivElement>();
  let panel = $state<HTMLElement>();

  const view = $derived(app.subagentView);
  const agent = $derived(view ? app.agentOf(view.paneId) : undefined);
  const sub = $derived(view ? agent?.subagents.find((x) => x.id === view.subId) : undefined);
  const items = $derived(buildItems(st.rows));
  const running = $derived(sub ? sub.state === 'running' : !st.done);

  // Consulta cada 1,5 s mientras el cajón está abierto y la ventana visible; al volver a verse, consulta de inmediato.
  $effect(() => {
    const v = app.subagentView;
    if (!v) return;
    const { paneId, subId } = v;
    st = emptyState(); failed = false; follow = true; expanded = {};
    let alive = true;
    let timer = 0;
    const schedule = () => {
      clearTimeout(timer);
      const d = pollDelay(true, !document.hidden, st.done);
      if (d != null) timer = window.setTimeout(() => void poll(), d);
    };
    async function poll() {
      if (!alive) return;
      try {
        const chunk = await be.agentTranscript(paneId, subId, st.offset);
        if (!alive) return;
        st = mergeChunk(st, chunk);
        failed = false;
      } catch {
        if (!alive) return;
        failed = true;
      }
      schedule();
    }
    const onVis = () => { if (!document.hidden) { clearTimeout(timer); void poll(); } };
    document.addEventListener('visibilitychange', onVis);
    untrack(() => { void poll(); });
    void tick().then(() => panel?.focus());
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  });

  // Auto-scroll al final mientras «seguir» esté activo.
  $effect(() => {
    void st.rows.length;
    if (!follow || !listEl) return;
    void tick().then(() => { if (follow && listEl) listEl.scrollTop = listEl.scrollHeight; });
  });

  function onScroll() {
    if (!listEl) return;
    follow = atBottom(listEl.scrollTop, listEl.clientHeight, listEl.scrollHeight);
  }

  function close() { app.subagentView = null; }

  function onWindowKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !app.subagentView) return;
    // Esc dentro de un terminal es del programa que corre en él; y los diálogos abiertos tienen prioridad.
    if ((e.target as HTMLElement)?.closest?.('.xterm')) return;
    if (app.settingsOpen || app.hostDialog || app.accountDialog || app.paletteOpen || app.hostKeyPrompt) return;
    e.preventDefault();
    close();
  }
</script>

<svelte:window onkeydown={onWindowKey} />

{#if view}
  <aside class="drawer" bind:this={panel} tabindex="-1" aria-label={t('agents.sub.aria')} transition:fly={{ x: 420, duration: dur(180) }}>
    <header>
      <div class="top">
        <span class="mk" class:run={running}>{running ? '◐' : '✓'}</span>
        <span class="kind">{sub?.kind ?? ''}</span>
        <span class="state" class:run={running}>{running ? t('agents.sub.running') : t('agents.sub.done')}</span>
        <span class="ro">{t('agents.sub.readOnly')}</span>
        <span class="sp"></span>
        <button class="follow" class:on={follow} aria-pressed={follow} title={t('agents.sub.followTitle')} onclick={() => (follow = !follow)}>{t('agents.sub.follow')}</button>
        <button class="x" title={t('agents.sub.close')} aria-label={t('agents.sub.close')} onclick={close}><Icon name="x" size={13} /></button>
      </div>
      <div class="desc" title={sub?.description ?? view.subId}>{sub?.description ?? view.subId}</div>
      {#if !sub}<div class="note">{t('agents.sub.gone')}</div>{/if}
    </header>

    <div class="list" bind:this={listEl} onscroll={onScroll} role="log" aria-live="off">
      {#if st.dropped > 0}<div class="note">{t('agents.sub.older', { n: st.dropped })}</div>{/if}
      {#if !items.length}<div class="note">{t('agents.sub.waiting')}</div>{/if}
      {#each items as it (it.key)}
        {#if it.kind === 'tool'}
          <div class="ev tool">
            <div class="line"><Icon name="bolt" size={11} /><span class="tn">{it.tool}</span><span class="sm">{it.summary}</span><span class="ts">{fmtTime(it.ts)}</span></div>
            {#if it.result}
              {@const p = preview(it.result.text)}
              <div class="res" class:err={it.result.error}>
                <pre>{expanded[it.key] ? it.result.text : p.head}</pre>
                {#if p.more}<button class="more" onclick={() => (expanded[it.key] = !expanded[it.key])}>{expanded[it.key] ? t('agents.sub.showLess') : t('agents.sub.showMore')}</button>{/if}
              </div>
            {/if}
          </div>
        {:else if it.kind === 'result'}
          {@const p = preview(it.text)}
          <div class="ev"><div class="res" class:err={it.result?.error}>
            <div class="lbl">{it.result?.error ? t('agents.sub.error') : t('agents.sub.result')}</div>
            <pre>{expanded[it.key] ? it.text : p.head}</pre>
            {#if p.more}<button class="more" onclick={() => (expanded[it.key] = !expanded[it.key])}>{expanded[it.key] ? t('agents.sub.showLess') : t('agents.sub.showMore')}</button>{/if}
          </div></div>
        {:else}
          <div class="ev {it.kind}">
            <div class="lbl">{#if it.kind === 'prompt'}{t('agents.sub.prompt')}{/if}<span class="ts">{fmtTime(it.ts)}</span></div>
            <div class="txt">{it.text}</div>
          </div>
        {/if}
      {/each}
      {#if failed}<div class="note bad">{t('agents.sub.failed')}</div>{/if}
    </div>
  </aside>
{/if}

<style>
  .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100vw); z-index: 50; display: flex; flex-direction: column; background: var(--panel); border-left: 1px solid var(--border-strong); box-shadow: -14px 0 40px rgba(0, 0, 0, 0.45); outline: none; }
  header { padding: 8px 10px 8px 12px; border-bottom: 1px solid var(--border); display: grid; gap: 4px; flex: none; }
  .top { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .sp { flex: 1; }
  .mk { width: 12px; text-align: center; color: var(--ok); }
  .mk.run { color: var(--accent); display: inline-block; animation: orch-spin-sub 1.4s linear infinite; }
  @keyframes orch-spin-sub { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .mk.run { animation: none; } }
  .kind { color: var(--info); font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { font-size: 11px; color: var(--muted); }
  .state.run { color: var(--accent); }
  .ro { font-size: 10px; color: var(--faint); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; }
  .follow { font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 5px; padding: 1px 8px; }
  .follow.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 50%, transparent); background: var(--accent-soft); }
  .x { width: 22px; height: 22px; display: grid; place-items: center; border-radius: 5px; color: var(--muted); }
  .x:hover { background: var(--raise); color: var(--text); }
  .desc { font-size: 12.5px; color: var(--text); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .list { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .note { color: var(--faint); font-size: 11.5px; text-align: center; padding: 4px 0; }
  .note.bad { color: var(--bad); }
  .ev { font-size: 12px; min-width: 0; }
  .lbl { display: flex; justify-content: space-between; color: var(--faint); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; }
  .ts { color: var(--faint); font-size: 10px; margin-left: auto; font-variant-numeric: tabular-nums; }
  .txt { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); line-height: 1.45; }
  .ev.prompt { background: var(--raise); border-radius: 6px; padding: 6px 8px; }
  .ev.prompt .txt { color: var(--muted); }
  .line { display: flex; align-items: center; gap: 6px; color: var(--accent); min-width: 0; }
  .tn { font-weight: 600; flex: none; }
  .sm { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-family: var(--mono, ui-monospace, Consolas, monospace); font-size: 11px; }
  .res { margin: 3px 0 0 17px; border-left: 2px solid var(--border-strong); padding-left: 8px; }
  .res.err { border-left-color: var(--bad); }
  .res pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--muted); font-family: var(--mono, ui-monospace, Consolas, monospace); font-size: 11px; line-height: 1.4; }
  .res.err pre { color: #ffc2c6; }
  .more { color: var(--info); font-size: 11px; padding: 1px 0; }
  .more:hover { text-decoration: underline; }
</style>
