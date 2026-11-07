<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { app } from '../lib/store.svelte.ts';
  import * as T from '../lib/terminals.ts';
  import { displayName, providerOf, type Pane } from '../lib/model.ts';
  import { t, tk } from '../lib/i18n.ts';
  import { tokSummary } from '../lib/tokfmt.ts';
  import { fmtMs } from '../lib/latency.ts';
  import Icon from './Icon.svelte';
  import GitChip from './GitChip.svelte';

  let { pane, maximized = false }: { pane: Pane; maximized?: boolean } = $props();

  let host: HTMLDivElement;
  let armed = $state(false);
  let armTimer: number | undefined;
  let acctOpen = $state(false);
  let searching = $state(false);
  let query = $state('');
  let searchInput = $state<HTMLInputElement>();
  let dropOver = $state(false);

  const live = $derived(app.live[pane.id]);
  const focused = $derived(app.active.focusId === pane.id);
  const acc = $derived(pane.kind === 'agent' ? app.accountById(pane.ref) : undefined);
  const exited = $derived(live?.state === 'exited');
  const ag = $derived(app.agentOf(pane.id));
  /** Texto del estado del agente (si el estado no tiene clave, se muestra tal cual). */
  const agStatus = (s: string) => { const r = tk(`agents.status.${s}`); return r.startsWith('agents.status.') ? s : r; };
  /** Contexto y tokens de la sesión, junto al estado del agente en la cabecera («289k · ↑4.7M ↓1.5M»). */
  const toks = $derived(ag ? tokSummary(ag.ctxTokens ?? 0, (ag.tokens?.input ?? 0) + (ag.tokens?.cacheCreate ?? 0), ag.tokens?.output ?? 0) : '');
  const bell = $derived(live?.bell && Date.now() - live.bell < 2500);
  /** SSH que aún no ha escrito nada: está resolviendo, conectando o negociando. Al llegar un aviso o una contraseña ya hay salida. */
  const connecting = $derived(pane.kind === 'ssh' && live?.state !== 'exited' && !live?.output);
  let clock = $state(Date.now());
  $effect(() => {
    if (!connecting) return;
    clock = Date.now();
    const iv = window.setInterval(() => (clock = Date.now()), 1000);
    return () => clearInterval(iv);
  });
  const slow = $derived(connecting && !!live?.startedAt && clock - live.startedAt > 8000);

  // Insignia de latencia (tiempo de conexión TCP al puerto SSH) y reconexión automática: la lógica está en sshconn.ts.
  const badge = $derived(app.conn.view(pane));
  const rc = $derived(app.sshState.reconnecting[pane.id]);
  const flashing = $derived(!!app.sshState.flash[pane.id]);
  const unit = $derived(app.settings.latencyShowUnit);
  const latLabel = $derived(badge.mode === 'live' ? fmtMs(badge.stats.last, unit) : '—');
  const latTitle = $derived.by(() => {
    if (badge.mode === 'jump') return t('pane.latency.jumpTitle');
    if (badge.mode === 'idle') return `${t('pane.latency.idle')}\n${t('pane.latency.explain')}`;
    if (badge.mode !== 'live') return '';
    const s = badge.stats;
    const f = (x: number | null) => fmtMs(x, true);
    return `${t('pane.latency.stats', { last: f(s.last), min: f(s.min), avg: f(s.avg), max: f(s.max), loss: s.lossPct, n: s.n })}\n${t('pane.latency.explain')}`;
  });
  $effect(() => {
    if (!rc || rc.pending) return;
    clock = Date.now();
    const iv = window.setInterval(() => (clock = Date.now()), 250);
    return () => clearInterval(iv);
  });
  const rcSecs = $derived(rc && !rc.pending ? Math.max(0, Math.ceil((rc.at - clock) / 1000)) : 0);

  onMount(() => {
    const isNew = T.ensure(pane);
    T.mount(pane.id, host);
    if (isNew) requestAnimationFrame(() => requestAnimationFrame(() => T.launch($state.snapshot(pane) as Pane)));
    const ro = new ResizeObserver(() => T.fitNow(pane.id));
    ro.observe(host);
    const onSearch = (e: Event) => { if ((e as CustomEvent).detail === pane.id) void openSearch(); };
    window.addEventListener('orchestra-search', onSearch);
    return () => {
      ro.disconnect();
      window.removeEventListener('orchestra-search', onSearch);
      T.unmount(pane.id);
    };
  });

  $effect(() => { if (focused) T.focus(pane.id); });

  function close() {
    if (exited || armed || !app.settings.confirmClose) { app.closePane(pane.id); return; }
    armed = true;
    clearTimeout(armTimer);
    armTimer = window.setTimeout(() => (armed = false), 2200);
  }

  async function openSearch() {
    searching = true;
    await tick();
    searchInput?.focus();
    searchInput?.select();
  }
  function closeSearch() { searching = false; T.clearSearch(pane.id); T.focus(pane.id); }
  function find(back = false) { T.findNext(pane.id, query, back); }

  function onDragOver(e: DragEvent) {
    const t = e.dataTransfer?.types ?? [];
    if (t.includes('application/x-orchestra-pane') || t.includes('application/x-orchestra-open')) {
      e.preventDefault();
      dropOver = true;
    }
  }
  function onDrop(e: DragEvent) {
    dropOver = false;
    const other = e.dataTransfer?.getData('application/x-orchestra-pane');
    const open = e.dataTransfer?.getData('application/x-orchestra-open');
    if (other) { e.preventDefault(); if (other !== pane.id) app.swap(other, pane.id); }
    else if (open) { e.preventDefault(); app.open(JSON.parse(open), { col: pane.col, row: pane.row }); }
  }
  function onDragStart(e: DragEvent) {
    e.dataTransfer?.setData('application/x-orchestra-pane', pane.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }
</script>

<svelte:window onpointerdown={(e) => { if (acctOpen && !(e.target as HTMLElement).closest('.acct-wrap')) acctOpen = false; }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section class="pane" class:focused class:bell class:drop={dropOver} class:flash={flashing}
  style:grid-column={maximized ? '1 / -1' : `${pane.col + 1} / span ${pane.colSpan}`}
  style:grid-row={maximized ? '1 / -1' : `${pane.row + 1} / span ${pane.rowSpan}`}
  onpointerdown={() => app.focus(pane.id)} ondragover={onDragOver} ondragleave={() => (dropOver = false)} ondrop={onDrop}>

  <div class="head" draggable="true" ondragstart={onDragStart} ondblclick={() => app.toggleMaximize(pane.id)}>
    <span class="state" class:run={live?.state === 'running'} class:dead={exited}></span>
    <span class="kind"><Icon name={pane.icon} size={13} /></span>
    <span class="title">{pane.title}</span>
    {#if live?.title && live.title !== pane.title && pane.kind !== 'agent'}<span class="otitle">{live.title}</span>{/if}
    {#if pane.kind !== 'ssh'}<GitChip {pane} />{/if}
    {#if badge.mode === 'jump'}<span class="lat" title={latTitle}><i class="ld"></i>{t('pane.latency.jump')}</span>
    {:else if badge.mode !== 'none'}<span class="lat {badge.mode === 'live' ? badge.level : 'none'}" title={latTitle}><i class="ld"></i>{latLabel}</span>{/if}

    {#if ag}{@const nRun = ag.subagents.filter((x) => x.state === 'running').length}<span class="agb" class:busy={ag.status === 'busy'} class:waiting={ag.status === 'waiting'}>{nRun ? t('pane.badgeWithSub', { status: agStatus(ag.status), n: nRun }) : agStatus(ag.status)}</span>{#if toks}<span class="agtok" title={t('pane.tokensTitle')}>{toks}</span>{/if}{/if}

    {#if pane.kind === 'agent' && app.claudeAccounts.length > 0 && pane.ref !== 'codex' && (!acc || providerOf(acc) === 'claude')}
      <span class="acct-wrap">
        <button class="chip" onclick={() => (acctOpen = !acctOpen)} title={t('pane.account.switchTitle')}>
          <span class="cdot" style:background={acc?.color ?? 'var(--faint)'}></span>{acc?.name ?? t('pane.account.fallback')}<Icon name="down" size={11} />
        </button>
        {#if acctOpen}
          {@const head = t('pane.account.menuHead', { flag: '\u0001' }).split('\u0001')}
          <div class="menu">
            <div class="mh">{head[0]}<code>--continue</code>{head[1] ?? ''}</div> <!-- i18n-ignore: CLI flag -->
            {#each app.claudeAccounts as a (a.id)}
              {@const pr = app.profileOf(a)}
              <button class="mi" class:cur={a.id === pane.ref} onclick={() => { acctOpen = false; if (a.id !== pane.ref) void app.switchAccount(pane.id, a.id); }}>
                <span class="cdot" style:background={a.color}></span>
                <span class="mt"><b>{displayName(a.name)}</b><small>{pr?.loggedIn ? [pr.email, pr.plan].filter(Boolean).join(' · ') : t('pane.account.notLoggedIn')}</small></span>
                {#if a.id === pane.ref}<span class="ck">●</span>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </span>
    {/if}

    <span class="grow"></span>
    {#if ag?.agent === 'claude'}<button class="iconbtn" class:on={app.consumoPane === pane.id} title={t('consumo.session.openTitle')} aria-label={t('consumo.session.openTitle')} onclick={() => (app.consumoPane = app.consumoPane === pane.id ? null : pane.id)}><Icon name="bars" size={13} /></button>{/if}
    <button class="iconbtn" title={t('pane.searchTitle')} onclick={openSearch}><Icon name="search" size={13} /></button>
    {#if exited}<button class="iconbtn" title={t('pane.restartTitle')} onclick={() => app.restartPane(pane.id)}><Icon name="refresh" size={13} /></button>{/if}
    <button class="iconbtn" title={maximized ? t('pane.restoreTitle') : t('pane.maximizeTitle')} onclick={() => app.toggleMaximize(pane.id)}><Icon name={maximized ? 'restore' : 'max'} size={13} /></button>
    <button class="iconbtn danger" class:armed title={t('pane.closeTitle')} onclick={close}>
      {#if armed}{t('pane.closeConfirm')}{:else}<Icon name="x" size={13} />{/if}
    </button>
  </div>

  <div class="body">
    <div class="term" bind:this={host}></div>
    {#if searching}
      <div class="search">
        <input bind:this={searchInput} bind:value={query} placeholder={t('pane.search.placeholder')}
          oninput={() => find()} onkeydown={(e) => { if (e.key === 'Enter') find(e.shiftKey); if (e.key === 'Escape') closeSearch(); }} />
        <button class="iconbtn" title={t('pane.search.previousTitle')} onclick={() => find(true)}>↑</button>
        <button class="iconbtn" title={t('pane.search.nextTitle')} onclick={() => find()}>↓</button>
        <button class="iconbtn" onclick={closeSearch}><Icon name="x" size={12} /></button>
      </div>
    {/if}
    {#if connecting}
      <div class="connecting" role="status" aria-live="polite">
        <span class="spin" aria-hidden="true"></span>
        <span class="ctext">{t('pane.connecting', { host: pane.title })}</span>
        {#if slow}<span class="cslow">{t('pane.connectingSlow')}</span>{/if}
      </div>
    {/if}
    {#if rc && !rc.pending}
      <div class="dead-bar reconnect" role="status" aria-live="polite">
        <span class="rtext">{rc.max > 0 ? t('pane.reconnect.bar', { s: rcSecs, n: rc.attempt, max: rc.max }) : t('pane.reconnect.barUnlimited', { s: rcSecs, n: rc.attempt })}</span>
        <button class="btn" onclick={() => app.conn.reconnectNow(pane.id)}><Icon name="refresh" size={13} /> {t('pane.reconnect.now')}</button>
        <button class="btn ghost" onclick={() => app.conn.cancel(pane.id)}>{t('pane.reconnect.cancel')}</button>
      </div>
    {:else if exited && !rc}
      <div class="dead-bar">
        {live?.code !== undefined ? t('pane.exitedCode', { code: live.code }) : t('pane.exited')}
        <button class="btn" onclick={() => app.restartPane(pane.id)}><Icon name="refresh" size={13} /> {t('pane.restart')}</button>
        <button class="btn ghost" onclick={() => app.closePane(pane.id)}>{t('pane.closePane')}</button>
      </div>
    {/if}
    {#if dropOver}<div class="dropmark">{t('pane.dropHere')}</div>{/if}
  </div>
</section>

<style>
  .pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; margin: 3px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; position: relative; }
  .pane.focused { border-color: color-mix(in srgb, var(--accent) 70%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent); }
  .pane.bell .head { background: var(--accent-soft); }
  .head { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 5px 0 9px; background: var(--panel); border-bottom: 1px solid var(--border); cursor: grab; flex: none; }
  .head:active { cursor: grabbing; }
  .state { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
  .state.run { background: var(--ok); }
  .state.dead { background: var(--bad); }
  .kind { color: var(--muted); display: grid; }
  .title { font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .otitle { color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .grow { flex: 1; }
  .agb { font-size: 10.5px; padding: 0 7px; border-radius: 9px; background: var(--raise); color: var(--ok); white-space: nowrap; }
  .agtok { font-size: 10.5px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  /* Insignia de latencia: mismo peso visual que .agtok, con un punto del color del nivel. */
  .lat { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; flex: none; cursor: default; }
  .lat .ld { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); flex: none; }
  .lat.ok .ld { background: var(--ok); }
  .lat.warn .ld { background: var(--warn); }
  .lat.bad .ld { background: var(--bad); }
  .lat.bad { color: var(--bad); }
  .pane.flash .head { animation: orch-flash 1.5s ease-out; }
  @keyframes orch-flash { 0% { background: color-mix(in srgb, var(--ok) 38%, var(--panel)); } 100% { background: var(--panel); } }
  @media (prefers-reduced-motion: reduce) { .pane.flash .head { animation: none; background: color-mix(in srgb, var(--ok) 22%, var(--panel)); } }
  .dead-bar.reconnect { background: rgba(232, 165, 60, 0.12); border-top-color: rgba(232, 165, 60, 0.45); color: var(--text); }
  .dead-bar .rtext { flex: 1; min-width: 0; }
  .agb.busy { color: var(--accent); background: var(--accent-soft); }
  .agb.waiting { color: #1a0a0b; background: var(--bad); font-weight: 600; }
  .acct-wrap { position: relative; }
  .chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--border-strong); font-size: 11.5px; color: var(--text); }
  .chip:hover { border-color: var(--accent); }
  .cdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .menu { position: absolute; top: 24px; left: 0; z-index: 30; min-width: 280px; background: var(--panel); border: 1px solid var(--border-strong); border-radius: 9px; padding: 5px; box-shadow: 0 16px 50px rgba(0, 0, 0, 0.55); cursor: default; }
  .mh { color: var(--muted); font-size: 11px; padding: 5px 8px 7px; }
  .mh code { color: var(--accent); }
  .mi { display: flex; align-items: center; gap: 9px; width: 100%; padding: 6px 8px; border-radius: 6px; text-align: left; }
  .mi:hover { background: var(--raise); }
  .mi.cur { background: var(--accent-soft); }
  .mt { display: grid; flex: 1; min-width: 0; }
  .mt small { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ck { color: var(--accent); font-size: 10px; }
  .body { position: relative; flex: 1; min-height: 0; padding: 4px 0 0 6px; background: var(--term-bg, var(--bg)); }
  .term { position: absolute; inset: 4px 0 0 6px; }
  .search { position: absolute; top: 6px; right: 14px; z-index: 5; display: flex; align-items: center; gap: 2px; background: var(--panel); border: 1px solid var(--border-strong); border-radius: 8px; padding: 4px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5); }
  .search input { width: 190px; padding: 3px 7px; }
  .dead-bar { position: absolute; left: 0; right: 0; bottom: 0; z-index: 4; display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: rgba(239, 107, 115, 0.12); border-top: 1px solid rgba(239, 107, 115, 0.4); color: #ffc2c6; backdrop-filter: blur(3px); }
  /* No intercepta el ratón ni el teclado: si ssh pide algo, llega salida y el aviso desaparece. */
  .connecting { position: absolute; inset: 0; z-index: 3; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; pointer-events: none; color: var(--muted); font-size: 12.5px; text-align: center; padding: 0 24px; }
  .connecting .ctext { color: var(--text); }
  .connecting .cslow { font-size: 11.5px; max-width: 360px; }
  .spin { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--border-strong); border-top-color: var(--accent); animation: orch-spin 0.8s linear infinite; }
  @keyframes orch-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } }
  .pane.drop { border-color: var(--accent); }
  .dropmark { position: absolute; inset: 0; z-index: 6; display: grid; place-items: center; background: rgba(245, 185, 66, 0.12); color: var(--accent); font-weight: 600; pointer-events: none; }
</style>
