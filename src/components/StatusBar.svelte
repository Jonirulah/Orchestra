<script lang="ts">
  // Barra de estado al pie de la ventana: métricas del equipo en vivo (CPU, RAM, disco, red, uptime, host) más agentes y uso de Claude.
  // Solo se monta con `statusBar` encendido; muestrea mientras la ventana está visible (ver docs/ARCHITECTURE.md). Nada sale de la máquina.
  import { onMount } from 'svelte';
  import { app } from '../lib/store.svelte.ts';
  import { t, tk } from '../lib/i18n.ts';
  import { metricsSample, metricsReset, rmetricsStart, rmetricsStop, rmetricsSample, rmetricsHidden } from '../lib/backend.ts';
  import { RmController, desiredMonitors, hostOfPane, rmKey, rmReq } from '../lib/remotemetrics.ts';
  import { usageViews } from '../lib/policy.ts';
  import { ctxmenu } from '../lib/ctxmenu.svelte.ts';
  import { isMenuKey, sep } from '../lib/ctxmenu.ts';
  import type { MenuItem } from '../lib/ctxmenu.ts';
  import { fade } from 'svelte/transition';
  import { ITEM_IDS, LOCAL_METRIC_IDS, REMOTE_CAPABLE, SLOT_PX, SRV_PX, metricSource, countAgents, customizeList, fitItems, fmtBytes, fmtPct, fmtRate, fmtUptime, isContextItem, itemsFor, levelFor, pctOf, sshTarget, toggleFor, topUsage } from '../lib/statusbar.ts';
  import type { ItemId, Level, Metrics, RemoteSnap } from '../lib/statusbar.ts';
  import { gitState, refreshGit } from '../lib/gitstate.svelte.ts';
  import { chipText, cwdForPane, gitLevel } from '../lib/gitinfo.ts';
  import { fmtMs } from '../lib/latency.ts';
  import { tokSummary } from '../lib/tokfmt.ts';
  import Icon from './Icon.svelte';
  import MetricsHistory from './MetricsHistory.svelte';
  import type { HistSource } from '../lib/history.ts';

  /** En la vista previa de Ajustes: sin tope de ancho de rejilla ni reinicio del muestreador compartido. */
  let { preview = false }: { preview?: boolean } = $props();

  let m = $state<Metrics | null>(null);
  let width = $state(0);

  const s = $derived(app.settings);

  // ---- panel con foco de la pestaña activa: de él salen los elementos de contexto y la adaptación ----
  const ws = $derived(app.active);
  const fp = $derived(ws?.panes.find((p) => p.id === ws.focusId && !p.parked) ?? ws?.panes.find((p) => !p.parked));
  const g = $derived(fp && fp.kind !== 'ssh' ? gitState.byPane[fp.id] : null);
  const items = $derived(itemsFor(ws, s, fp ? { kind: fp.kind, repo: !!g?.branch } : null));
  const hasOwn = $derived(Array.isArray(ws?.statusBarItems));
  const wantsGit = $derived(s.statusBarAdapt || s.statusBarItems.includes('branch') || !!ws?.statusBarItems?.includes('branch'));
  const needsMetrics = $derived(items.some((i) => (LOCAL_METRIC_IDS as readonly string[]).includes(i) || i === 'hostname' || i === 'target'));
  /** Cambia con la pestaña o el foco: los elementos de contexto se vuelven a montar y entran con un fundido. */
  const ctxKey = $derived(`${ws?.id}:${fp?.id ?? ''}`);
  const fadeMs = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 120;

  // Git del panel con foco si el chip de las cabeceras está apagado (con él encendido ya lo mantiene GitChip).
  $effect(() => {
    if (!wantsGit || s.gitChip || !fp || fp.kind === 'ssh') return;
    const live = app.live[fp.id];
    const cwd = cwdForPane(live?.cwd, app.agentOf(fp.id)?.cwd, fp.spec.cwd);
    if (!cwd) return;
    const id = fp.id;
    const tick = () => { if (!document.hidden) void refreshGit(id, cwd); };
    tick();
    const iv = window.setInterval(tick, s.gitIntervalSec * 1000);
    return () => clearInterval(iv);
  });

  // ---- muestreo: solo con la ventana visible y solo si algún elemento lo necesita ----
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  async function sample() {
    if (busy) return;
    busy = true;
    try { m = await metricsSample(); } catch { /* sin datos: la barra enseña guiones */ } finally { busy = false; }
  }
  function stop() { if (timer !== undefined) { clearInterval(timer); timer = undefined; } }
  function start(sec: number) {
    stop();
    if (document.hidden) return;
    void sample();
    timer = setInterval(() => void sample(), sec * 1000);
  }
  $effect(() => {
    const sec = s.statusBarInterval;
    if (!needsMetrics) { stop(); return; }
    start(sec);
    const vis = () => { if (document.hidden) stop(); else start(sec); };
    document.addEventListener('visibilitychange', vis);
    return () => { document.removeEventListener('visibilitychange', vis); stop(); };
  });
  onMount(() => () => { stop(); if (!preview) { metricsReset(); rmc.stopAll(); } });

  // ---- métricas del servidor (SSH): un monitor por host mientras haya algún panel SSH vivo de él, sea cual sea la pestaña ----
  const rmc = new RmController({ start: rmetricsStart, stop: rmetricsStop });
  const want = $derived(preview ? new Map() : desiredMonitors(app.workspaces, app.hosts, app.live, s.remoteMetricsInterval));
  $effect(() => { rmc.sync(want); });
  const fh = $derived(fp ? hostOfPane(fp, app.hosts) : undefined);
  const fReq = $derived(fh && !preview && app.live[fp!.id]?.state !== 'exited' ? rmReq(fh, s.remoteMetricsInterval) : null);
  /** Cambia solo al pasar a otro destino: moverse entre paneles del mismo host reutiliza la última muestra sin reconectar. */
  const fKey = $derived(fReq ? rmKey(fReq) : null);
  let snap = $state<RemoteSnap | null>(null);
  $effect(() => {
    const key = fKey;
    if (!key) { snap = null; return; }
    let busyR = false;
    const poll = async () => {
      if (busyR || document.hidden) return;
      busyR = true;
      try { snap = await rmetricsSample(key); } catch { /* sin datos: marcador */ } finally { busyR = false; }
    };
    void poll();
    const iv = window.setInterval(() => void poll(), 1000);
    return () => clearInterval(iv);
  });
  $effect(() => {
    if (preview) return;
    const vis = () => rmetricsHidden(document.hidden);
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  });
  const source = $derived(metricSource(!!fKey, snap));

  // ---- uso de Claude: la cuenta del panel enfocado, si no la última usada, si no la primera con datos ----
  const normDir = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const usageAcc = $derived.by(() => {
    const accs = app.claudeAccounts;
    const focus = app.active?.focusId;
    const dir = focus ? app.agentOf(focus)?.configDir : undefined;
    const byDir = dir ? accs.find((a) => normDir(a.dir) === normDir(dir)) : undefined;
    return byDir ?? accs.find((a) => a.id === s.lastAccountId) ?? accs.find((a) => app.quota[a.id]) ?? accs[0];
  });

  interface Row { id: ItemId; label: string; text: string; level: Level | null; tip: string; key: string; color?: string; icon?: string; dim?: boolean }
  const label = (id: ItemId) => (id === 'hostname' || id === 'net' || isContextItem(id) ? '' : tk(`statusbar.short.${id}`));

  const agStatus = (st: string) => { const k = tk(`agents.status.${st}`); return k.startsWith('agents.status.') ? st : k; };
  const localNote = $derived(fp?.kind === 'ssh' && source.kind === 'local' ? `\n${t('statusbar.tip.localNote')}` : '');
  const srvHost = $derived(source.kind === 'remote' ? source.sample.hostname || fh?.host || '' : fh?.host ?? '');
  /** Mensaje del marcador cuando el monitor no tiene datos (nunca ceros falsos). */
  function pendingTip(): string {
    if (source.kind !== 'remote-pending') return '';
    if (source.state === 'stale') return t('statusbar.remote.stale');
    if (source.state !== 'unavailable') return t('statusbar.remote.connecting');
    const k = source.failKind;
    const reason = source.reason ?? '';
    if (k === 'hostkey') return t('statusbar.remote.hostkey');
    if (k === 'auth') return t('statusbar.remote.auth');
    if (k === 'unsupported') return t('statusbar.remote.unsupported');
    if (k === 'network') return t('statusbar.remote.network', { reason });
    return t('statusbar.remote.other', { reason });
  }

  /** Elementos que siguen al panel con foco. `null` = no hay nada que enseñar (se oculta el hueco). */
  function buildContext(id: ItemId): Row | null {
    if (!fp) return null;
    const base = { id, label: label(id), key: `${id}@${ctxKey}` };
    switch (id) {
      case 'pane': return { ...base, text: fp.title, level: null, icon: fp.icon, tip: t('statusbar.tip.pane', { title: fp.title }) };
      case 'target': {
        const tg = sshTarget(fp, app.hosts, app.sshConfig);
        const text = tg ?? (m?.hostname || fp.title);
        return { ...base, text, level: null, tip: tg ? t('statusbar.tip.targetSsh', { target: tg }) : t('statusbar.tip.targetLocal') };
      }
      case 'branch': {
        if (!g?.branch) return null;
        const c = chipText(g, s.gitCounts);
        const lv = gitLevel(g);
        return { ...base, text: [c.name, c.changes, c.ahead, c.behind].filter(Boolean).join(' '), level: lv === 'bad' ? 'bad' : lv === 'dirty' ? 'warn' : null, tip: t('statusbar.tip.branch', { root: g.repoRoot }) };
      }
      case 'latency': {
        const b = app.conn.view(fp);
        if (b.mode === 'none') return null;
        if (b.mode === 'jump') return { ...base, text: t('pane.latency.jump'), level: null, tip: t('pane.latency.jumpTitle') };
        if (b.mode === 'idle') return { ...base, text: '–', level: null, tip: t('pane.latency.idle') };
        return { ...base, text: fmtMs(b.stats.last, s.latencyShowUnit), level: b.level === 'none' ? null : b.level, tip: t('statusbar.tip.latency') };
      }
      case 'account': {
        const dir = app.agentOf(fp.id)?.configDir;
        const acc = dir ? app.accounts.find((a) => normDir(a.dir) === normDir(dir)) : undefined;
        return acc ? { ...base, text: acc.name, level: null, color: acc.color, tip: t('statusbar.tip.account', { account: acc.name }) } : null;
      }
      case 'agentState': {
        const ag = app.agentOf(fp.id);
        if (!ag) return null;
        const toks = tokSummary(ag.ctxTokens ?? 0, (ag.tokens?.input ?? 0) + (ag.tokens?.cacheCreate ?? 0), ag.tokens?.output ?? 0);
        return { ...base, text: toks ? `${agStatus(ag.status)} · ${toks}` : agStatus(ag.status), level: ag.status === 'waiting' ? 'warn' : null, tip: t('statusbar.tip.agentState') };
      }
    }
    return null;
  }

  function build(id: ItemId): Row | null {
    if (isContextItem(id)) return buildContext(id);
    const remoteCap = (REMOTE_CAPABLE as readonly string[]).includes(id);
    if (source.kind === 'remote-pending' && remoteCap) {
      const wait = source.state === 'connecting' || source.state === 'none';
      return { id, label: label(id), key: id as string, text: wait ? '…' : 'n/a', level: null, tip: pendingTip(), dim: true };
    }
    const r = buildMetric(id);
    if (source.kind === 'remote' && remoteCap) {
      const tip = id === 'cpu'
        ? t('statusbar.tip.cpuRemote', { pct: fmtPct(source.sample.cpu), cores: source.sample.cores, load: source.sample.load.toFixed(2) })
        : r.tip;
      return { ...r, tip: t('statusbar.tip.serverPrefix', { host: srvHost, tip }) };
    }
    return localNote && (LOCAL_METRIC_IDS as readonly string[]).includes(id) ? { ...r, tip: r.tip + localNote } : r;
  }

  function buildMetric(id: ItemId): Row {
    const dash = '–';
    const base = { id, label: label(id), key: id as string };
    const x = source.kind === 'remote' ? source.sample : m;
    switch (id) {
      case 'hostname': return { ...base, text: x?.hostname || dash, level: null, tip: t('statusbar.tip.hostname') };
      case 'cpu': {
        const p = x?.cpu ?? 0;
        return { ...base, text: x ? fmtPct(p) : dash, level: x ? levelFor(p) : null, tip: t('statusbar.tip.cpu', { pct: fmtPct(p) }) };
      }
      case 'ram': {
        const p = pctOf(x?.ramUsed ?? 0, x?.ramTotal ?? 0);
        return {
          ...base, text: x ? `${fmtBytes(x.ramUsed)} ${fmtPct(p)}` : dash, level: x ? levelFor(p) : null,
          tip: t('statusbar.tip.ram', { used: fmtBytes(x?.ramUsed ?? 0), total: fmtBytes(x?.ramTotal ?? 0), pct: fmtPct(p), swapUsed: fmtBytes(x?.swapUsed ?? 0), swapTotal: fmtBytes(x?.swapTotal ?? 0) }),
        };
      }
      case 'disk': {
        const r = x?.ready ? fmtRate(x.diskRead) : dash, w = x?.ready ? fmtRate(x.diskWrite) : dash;
        return { ...base, text: `R ${r} W ${w}`, level: null, tip: t('statusbar.tip.disk', { read: r, write: w }) };
      }
      case 'net': {
        const d = x?.ready ? fmtRate(x.netIn) : dash, u = x?.ready ? fmtRate(x.netOut) : dash;
        return { ...base, text: `↓ ${d} ↑ ${u}`, level: null, tip: t('statusbar.tip.net', { down: d, up: u }) };
      }
      case 'uptime': return { ...base, text: x ? fmtUptime(x.uptime) : dash, level: null, tip: t('statusbar.tip.uptime', { time: x ? fmtUptime(x.uptime) : dash }) };
      case 'agents': {
        const c = countAgents(app.agents);
        return { ...base, text: `${c.working} / ${c.waiting}`, level: c.waiting > 0 ? 'warn' : null, tip: t('statusbar.tip.agents', { working: c.working, waiting: c.waiting }) };
      }
      case 'usage': {
        const v = usageAcc ? usageViews(app.quota[usageAcc.id], app.nowSec) : null;
        const top = v ? topUsage(v.five?.pct, v.seven?.pct) : null;
        if (!top || !usageAcc) return { ...base, text: dash, level: null, tip: t('statusbar.tip.usageNone') };
        return { ...base, text: `${top.window} ${fmtPct(top.pct)}`, level: levelFor(top.pct), tip: t('statusbar.tip.usage', { window: top.window, account: usageAcc.name, pct: fmtPct(top.pct) }) };
      }
      default: return { ...base, text: dash, level: null, tip: '' };
    }
  }
  const built = $derived(items.map(build).filter((r): r is Row => r !== null));
  const firstSrv = $derived(source.kind === 'local' ? null : built.find((r) => (REMOTE_CAPABLE as readonly string[]).includes(r.id))?.id ?? null);
  /** Ancho (px) del botón de la gráfica junto al nombre del host (18 + 4 de margen). */
  const HIST_PX = 22;
  const histPx = $derived(built.some((r) => r.id === 'hostname') ? HIST_PX : 0);
  const rows = $derived(built.slice(0, fitItems(built.map((r) => r.id), Math.max(0, width - 20 - (firstSrv ? SRV_PX : 0) - histPx)).length));

  // ---- histórico de la última hora: botón junto al nombre del host y panel flotante (MetricsHistory) ----
  let histOpen = $state(false);
  let histBtn = $state<HTMLButtonElement>();
  /** Misma lógica que la barra: servidor si el panel SSH enfocado tiene métricas remotas; si no, este equipo. */
  const histSrc = $derived<HistSource>(source.kind === 'remote' && fKey ? { kind: 'remote', key: fKey, host: srvHost } : { kind: 'local' });

  // ---- menú contextual: marcar/desmarcar elementos ----
  function toggle(id: ItemId) {
    const r = toggleFor(app.active, app.settings.statusBarItems, id, !items.includes(id));
    if (r.scope === 'tab') app.setTabStatusItems(r.list); else app.setting('statusBarItems', r.list);
  }
  function menu(): MenuItem[] {
    return [
      ...ITEM_IDS.map((id): MenuItem => ({ id: `item:${id}`, label: tk(`statusbar.item.${id}`), checked: items.includes(id), run: () => toggle(id) })),
      sep('s0'),
      hasOwn
        ? { id: 'tab-default', label: t('statusbar.ctx.useDefault'), run: () => app.setTabStatusItems(undefined) }
        : { id: 'tab-custom', label: t('statusbar.ctx.customize'), run: () => app.setTabStatusItems(customizeList(items)) },
      sep('s1'),
      { id: 'settings', label: t('statusbar.ctx.settings'), run: () => { app.settingsTab = 'general'; app.settingsOpen = true; } },
      { id: 'hide', label: t('statusbar.ctx.hide'), run: () => app.setting('statusBar', false) },
    ];
  }
  function onctx(ev: MouseEvent) { ctxmenu.openFromEvent(ev, menu(), ev.currentTarget as HTMLElement); }
  function onkey(ev: KeyboardEvent) {
    if (isMenuKey(ev)) { ev.preventDefault(); ctxmenu.openBelow(ev.currentTarget as HTMLElement, menu()); }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="sb" class:preview role="group" aria-label={t('statusbar.aria')} tabindex="0" bind:clientWidth={width} oncontextmenu={onctx} onkeydown={onkey}>
  {#each rows as r, i (r.key)}
    {#if i > 0}<span class="sep" aria-hidden="true"></span>{/if}
    {#if r.id === firstSrv}<span class="srv" style:width="{SRV_PX - 6}px" title={t('statusbar.srv.tip', { host: srvHost })}>{t('statusbar.srv.mark')}</span>{/if}
    <span class="it" style:width="{SLOT_PX[r.id]}px" title={r.tip} in:fade={{ duration: isContextItem(r.id) ? fadeMs : 0 }}>
      {#if r.icon}<Icon name={r.icon} size={12} />{/if}
      {#if r.color}<i class="dot" style:background={r.color} aria-hidden="true"></i>{:else if r.level}<i class="dot {r.level}" aria-hidden="true"></i>{/if}
      {#if r.label}<span class="nm">{r.label}</span>{/if}
      <span class="val {r.level ?? ''}" class:dim={r.dim}>{r.text}</span>
    </span>
    {#if r.id === 'hostname'}
      <button
        class="hist" class:on={histOpen} type="button" bind:this={histBtn} disabled={preview}
        title={t('statusbar.hist.button')} aria-label={t('statusbar.hist.button')} aria-expanded={histOpen} aria-haspopup="dialog"
        onclick={() => (histOpen = !histOpen)}
      ><Icon name="chart" size={12} /></button>
    {/if}
  {/each}
  {#if !rows.length}<span class="empty">{items.length ? '' : t('statusbar.empty')}</span>{/if}
</div>
{#if histOpen && !preview && rows.some((r) => r.id === 'hostname')}
  <MetricsHistory src={histSrc} anchor={histBtn} onclose={() => (histOpen = false)} />
{/if}

<style>
  .sb {
    grid-column: 1 / -1; display: flex; align-items: center; height: 25px; padding: 0 10px; overflow: hidden;
    background: var(--panel); border-top: 1px solid var(--border);
    font-size: 11.5px; line-height: 1; font-variant-numeric: tabular-nums; color: var(--text); white-space: nowrap; user-select: none;
  }
  .sb.preview { grid-column: auto; border: 1px solid var(--border); border-radius: var(--radius); }
  .sb:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .it { display: inline-flex; align-items: center; gap: 5px; flex: none; overflow: hidden; text-overflow: ellipsis; }
  .sep { flex: none; width: 1px; height: 12px; margin: 0 10px; background: var(--border-strong); }
  .nm { color: var(--muted); }
  .srv { flex: none; margin-right: 6px; padding: 1px 0; text-align: center; font-size: 9.5px; letter-spacing: 0.03em; text-transform: uppercase; color: var(--accent); border: 1px solid var(--accent); border-radius: 3px; opacity: 0.85; }
  .val.dim { color: var(--faint); }
  .val { overflow: hidden; text-overflow: ellipsis; transition: color 0.4s ease; }
  .val.warn { color: var(--warn); }
  .val.bad { color: var(--bad); }
  .dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); transition: background-color 0.4s ease; }
  .dot.warn { background: var(--warn); }
  .dot.bad { background: var(--bad); }
  .empty { color: var(--faint); }
  .hist { flex: none; display: inline-grid; place-items: center; width: 18px; height: 18px; margin-left: 4px; border-radius: 4px; color: var(--muted); }
  .hist:hover:not(:disabled), .hist.on { color: var(--accent); background: var(--raise); }
  .hist:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .hist:disabled { cursor: default; }
  @media (prefers-reduced-motion: reduce) {
    .val, .dot { transition: none; }
  }
</style>
