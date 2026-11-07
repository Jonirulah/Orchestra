<script lang="ts">
  // Ficha flotante de un agente: se abre desde AgentTree al dejar el ratón sobre la fila (o al enfocarla con el teclado).
  // Va colgada de <body> (acción `portal`) para que ningún transform de la barra lateral le cambie el `position: fixed`.
  import type { AgentInfo, Tokens } from '../lib/backend.ts';
  import { t } from '../lib/i18n.ts';
  import { tokK } from '../lib/tokfmt.ts';
  import Icon from './Icon.svelte';
  import {
    cardPosition, cardSections, clampPrompt, contextWindow, ctxBar, fmtDuration, fmtWindow, prettyModel, shortCwd, todoProgress,
  } from '../lib/agentcard.ts';
  import type { StatusMark } from '../lib/agentcard.ts';

  interface Props {
    a: AgentInfo;
    /** Título que enseña la fila (el del panel o el nombre del producto). */
    label: string;
    /** Rectángulo de la fila y borde derecho de la barra lateral (coordenadas de la ventana). */
    anchor: { top: number; bottom: number };
    sideRight: number;
    account?: { name: string; color: string };
    cache: { cls: string; text: string } | null;
    branch?: string;
    mark?: StatusMark;
    /** Umbral de tokens del auto-compact en inactividad (si está encendido). */
    compactAt: number | null;
    statusText: string;
    now: number;
    onenter: () => void;
    onleave: () => void;
  }
  let { a, label, anchor, sideRight, account, cache, branch, mark, compactAt, statusText, now, onenter, onleave }: Props = $props();

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  let h = $state(0);
  let vw = $state(typeof window === 'undefined' ? 1400 : window.innerWidth);
  let vh = $state(typeof window === 'undefined' ? 800 : window.innerHeight);
  const WIDTH = 320;
  const pos = $derived(cardPosition(anchor, sideRight, { width: WIDTH, height: h || 200 }, { width: vw, height: vh }));

  const fresh = (x: Tokens) => x.input + x.cacheCreate;
  const sec = $derived(cardSections(a, branch));
  const win = $derived(contextWindow(a.model, a.ctxTokens));
  const bar = $derived(ctxBar(a.ctxTokens, win, compactAt));
  const prompt = $derived(clampPrompt(a.lastPrompt));
  const model = $derived(prettyModel(a.model));
  /** El nombre del panel solo si no es ya el título (la fila de la barra lateral enseña el del panel). */
  const showPane = $derived(!!a.title && label !== a.title);
  const since = $derived(mark && mark.status === a.status && mark.since ? fmtDuration(now - mark.since) : null);
  const started = $derived(a.startedAt ? fmtDuration(now - a.startedAt) : null);
  const tp = $derived(todoProgress(a.todos));
  const curTodo = $derived(tp.current >= 0 ? a.todos[tp.current] : null);
  const subRun = $derived(a.subagents.filter((s) => s.state === 'running').length);
  const cwd = $derived(shortCwd(a.cwd));
  const hasTok = (x?: Tokens) => !!x && (x.requests > 0 || x.output > 0 || fresh(x) > 0);
</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} />

<div
  class="card"
  use:portal
  bind:offsetHeight={h}
  role="tooltip"
  aria-label={t('agents.card.aria')}
  style:left="{pos.left}px"
  style:top="{pos.top}px"
  style:width="{WIDTH}px"
  onpointerenter={onenter}
  onpointerleave={onleave}
>
  <div class="head">
    <div class="title">{a.title || label}</div>
    {#if showPane || account || model}<div class="who">
      {#if showPane}<span class="pane">{label}</span>{/if}
      {#if account}{#if showPane}<span class="sep">·</span>{/if}<span class="adot" style:background={account.color}></span><span class="acc">{account.name}</span>{/if}
      {#if model}{#if account || showPane}<span class="sep">·</span>{/if}<span class="model">{model}</span>{/if}
    </div>{/if}
    <div class="state" class:wait={a.status === 'waiting'}>
      <span class="st" class:busy={a.status === 'busy'} class:waiting={a.status === 'waiting'} class:idle={a.status === 'idle'}></span>
      <span class="stx">{since ? t('agents.card.since', { status: statusText, d: since }) : statusText}</span>
    </div>
    {#if a.status === 'waiting' && a.waitingFor}
      <div class="asks"><span class="k">{t('agents.card.asks')}</span> <code>{a.waitingFor}</code></div>
    {/if}
  </div>

  {#if sec.ctx}
    <div class="sec">
      <div class="h"><span>{t('agents.card.ctx')}</span>{#if cache}<span class="cache {cache.cls}">{cache.text}</span>{/if}</div>
      {#if bar}
        <div class="bar" class:hi={bar.pct >= 80}>
          <div class="fill" style:width="{bar.pct}%"></div>
          {#if bar.markPct !== null}<div class="mark" style:left="{bar.markPct}%" title={t('agents.card.compactMark', { n: tokK(compactAt ?? 0) })}></div>{/if}
        </div>
        <div class="num">
          <span>{t('agents.card.ctxOf', { n: tokK(a.ctxTokens), w: fmtWindow(bar.window), pct: bar.pct })}</span>
          {#if bar.markPct !== null}<span class="mk-l"><i class="mk-i"></i>{t('agents.card.compactMark', { n: tokK(compactAt ?? 0) })}</span>{/if}
        </div>
      {:else}
        <div class="num">{tokK(a.ctxTokens)}</div>
      {/if}
    </div>
  {/if}

  {#if sec.now}
    <div class="sec">
      <div class="h"><span>{t('agents.card.now')}</span></div>
      {#if a.current}<div class="cur"><Icon name="bolt" size={11} /><span>{a.current}</span></div>{/if}
      {#if prompt}<div class="prompt" title={t('agents.card.lastPrompt')}>{t('agents.card.quoted', { text: prompt })}</div>{/if}
    </div>
  {/if}

  {#if sec.tasks || sec.subs}
    <div class="sec">
      {#if sec.tasks}
        <div class="h"><span>{t('agents.card.tasks', { done: tp.done, total: tp.total })}</span></div>
        <div class="prog"><div class="fill" style:width="{Math.round((tp.done / tp.total) * 100)}%"></div></div>
        {#if curTodo}<div class="todo"><span class="mk">◐</span><span>{curTodo.activeForm || curTodo.content}</span></div>{/if}
      {/if}
      {#if sec.subs}
        <div class="h subs"><span>{t('agents.card.subs', { running: subRun, done: a.subagents.length - subRun })}</span></div>
      {/if}
    </div>
  {/if}

  {#if sec.session}
    <div class="sec">
      <div class="h"><span>{t('agents.card.session')}</span></div>
      {#if started || a.tokens?.requests}
        <div class="line">
          {#if started}<span>{t('agents.card.started', { d: started })}</span>{/if}
          {#if started && a.tokens?.requests}<span class="sep">·</span>{/if}
          {#if a.tokens?.requests}<span>{t('agents.card.requests', { n: tokK(a.tokens.requests) })}</span>{/if}
        </div>
      {/if}
      {#if hasTok(a.tokens)}
        <div class="line tok">{t('agents.card.tokens', { fresh: tokK(fresh(a.tokens)), out: tokK(a.tokens.output), cached: tokK(a.tokens.cacheRead) })}</div>
      {/if}
      {#if hasTok(a.subTokens)}
        <div class="line tok sub">{t('agents.card.subTokens', { fresh: tokK(fresh(a.subTokens)), out: tokK(a.subTokens.output), n: tokK(a.subTokens.requests) })}</div>
      {/if}
      {#if cwd || branch}
        <div class="line where">
          {#if cwd}<span class="cwd" title={a.cwd}><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>{cwd}</span>{/if}
          {#if branch}<span class="br"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11.5 8.5"/></svg>{branch}</span>{/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .card {
    position: fixed; z-index: 900; box-sizing: border-box; padding: 10px 12px 11px;
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border-strong); border-radius: 9px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); font-size: 12px; line-height: 1.4;
    animation: card-in 0.12s ease-out;
  }
  @keyframes card-in { from { opacity: 0; transform: translateX(-4px); } }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } .st.busy, .st.waiting { animation: none; } }
  .head { display: grid; gap: 3px; }
  .title { font-weight: 600; font-size: 13px; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .who, .state, .line { display: flex; align-items: center; gap: 5px; min-width: 0; color: var(--muted); font-size: 11.5px; }
  .adot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .acc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model { color: var(--text); white-space: nowrap; }
  .sep { color: var(--faint); }
  .st { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; }
  .st.busy { background: var(--accent); }
  .st.waiting { background: var(--bad); }
  .st.idle { background: var(--ok); }
  .stx::first-letter { text-transform: uppercase; }
  .state.wait { color: var(--bad); }
  .asks { font-size: 11.5px; color: var(--muted); overflow-wrap: anywhere; }
  .asks .k { color: var(--faint); }
  .asks code { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--text); }
  .sec { margin-top: 9px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--faint) 30%, transparent); display: grid; gap: 4px; }
  .h { display: flex; justify-content: space-between; gap: 8px; color: var(--faint); font-size: 10px; letter-spacing: 0.08em; font-weight: 600; }
  .h.subs { margin-top: 3px; }
  .cache { letter-spacing: 0; font-weight: 500; font-size: 11px; }
  .cache.ok { color: var(--ok); }
  .cache.warm { color: var(--accent); }
  .cache.hot, .cache.cold { color: var(--bad); }
  .bar, .prog { position: relative; height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--faint) 25%, transparent); overflow: visible; }
  .prog { height: 4px; }
  .fill { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: var(--accent); }
  .bar.hi .fill { background: var(--bad); }
  .prog .fill { background: var(--ok); }
  .mark { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--text); opacity: 0.7; border-radius: 1px; }
  .num { display: flex; justify-content: space-between; gap: 8px; font-variant-numeric: tabular-nums; color: var(--muted); font-size: 11.5px; }
  .mk-l { color: var(--faint); font-size: 11px; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .mk-i { display: inline-block; width: 2px; height: 9px; background: var(--text); opacity: 0.7; border-radius: 1px; }
  .cur { display: flex; gap: 5px; align-items: center; color: var(--accent); font-size: 11.5px; min-width: 0; }
  .cur span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prompt { font-style: italic; color: var(--muted); font-size: 11.5px; overflow-wrap: anywhere; user-select: text; }
  .todo { display: flex; gap: 6px; font-size: 11.5px; color: var(--text); }
  .mk { width: 12px; flex: none; text-align: center; color: var(--accent); }
  .tok { font-variant-numeric: tabular-nums; color: var(--text); }
  .tok.sub { color: var(--info); }
  .where { flex-wrap: wrap; gap: 10px; }
  .ic { width: 12px; height: 12px; flex: none; fill: none; stroke: var(--faint); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .pane { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .cwd, .br { display: inline-flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
</style>
