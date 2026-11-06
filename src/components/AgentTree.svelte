<script lang="ts">
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { app } from '../lib/store.svelte.ts';
  import type { AgentInfo, Tokens } from '../lib/backend.ts';
  import { cacheThresholds } from '../lib/settings.ts';
  import { t, tk } from '../lib/i18n.ts';
  import Icon from './Icon.svelte';
  import { gitState } from '../lib/gitstate.svelte.ts';
  import { truncateBranch } from '../lib/gitinfo.ts';

  let now = $state(Date.now() / 1000);
  let closed = $state<Record<string, boolean>>({});
  let armedId = $state<string | null>(null);
  let armTimer = 0;
  const dur = (ms: number) => (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms);
  onMount(() => {
    const t = setInterval(() => (now = Date.now() / 1000), 5000);
    return () => { clearInterval(t); clearTimeout(armTimer); };
  });

  /** Cierra el panel del agente; con «confirmClose» hace falta un segundo clic (igual que el botón del panel). */
  function closeAgent(id: string) {
    if (armedId === id || !app.settings.confirmClose) { armedId = null; app.closePane(id); return; }
    armedId = id;
    clearTimeout(armTimer);
    armTimer = window.setTimeout(() => (armedId = null), 2200);
  }

  const norm = (p?: string) => (p ?? '').replace(/\\/g, '/').toLowerCase();
  const accountOf = (a: AgentInfo) => app.claudeAccounts.find((x) => norm(x.dir) === norm(a.configDir));
  const k = (n: number) =>
    n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  /** New input = fresh input + cache writes (what you actually pay full price for). */
  const fresh = (t: Tokens) => t.input + t.cacheCreate;

  /** Texto del estado del agente (si el estado no tiene clave, se muestra tal cual). */
  const statusLabel = (s: string) => { const r = tk(`agents.status.${s}`); return r.startsWith('agents.status.') ? s : r; };

  /** Caché de prompt: cuánto le queda antes de enfriarse y qué costaría reescribirla. */
  function cache(a: AgentInfo) {
    if (!a.lastRequestAt || a.agent !== 'claude') return null;
    const left = a.cacheTtl - (now - a.lastRequestAt);
    if (left <= 0) return { cls: 'cold', text: t('agents.cache.cold', { n: k(a.ctxTokens) }) };
    const min = Math.ceil(left / 60);
    const th = cacheThresholds(app.settings.cacheWarnMin);
    return { cls: left < th.hot ? 'hot' : left < th.warm ? 'warm' : 'ok', text: t('agents.cache.minutes', { min }) };
  }

  const done = (a: AgentInfo) => a.todos.filter((t) => t.status === 'completed').length;
  const running = (a: AgentInfo) => a.subagents.filter((s) => s.state === 'running').length;
  const label = (a: AgentInfo) => app.paneById(a.paneId)?.title ?? (a.agent === 'codex' ? 'Codex' : a.agent === 'opencode' ? 'opencode' : 'Claude'); // i18n-ignore: product names
</script>

<div class="tree">
  {#each app.agents as a (a.paneId)}
    {@const acc = accountOf(a)}
    {@const c = cache(a)}
    <div class="ag" class:wait={a.status === 'waiting'} in:fly={{ x: -10, duration: dur(150) }}>
      <div class="row">
        <button class="chev" onclick={() => (closed[a.paneId] = !closed[a.paneId])} aria-label={t('agents.collapseAria')}>
          <Icon name={closed[a.paneId] ? 'right' : 'down'} size={11} />
        </button>
        <button class="main" onclick={() => app.focusPane(a.paneId)} title={t('agents.goToTitle')}>
          <span class="st" class:busy={a.status === 'busy'} class:waiting={a.status === 'waiting'} class:idle={a.status === 'idle'}></span>
          <span class="txt">
            <span class="name">{label(a)}</span>
            <span class="sub">
              {#if acc}<span class="adot" style:background={acc.color}></span>{/if}{statusLabel(a.status)}{a.ctxTokens ? ` · ${k(a.ctxTokens)}` : ''}{gitState.byPane[a.paneId]?.branch ? ` · ${truncateBranch(gitState.byPane[a.paneId]?.branch ?? '', 18)}` : ''}{a.title ? ` · ${a.title}` : ''}
            </span>
          </span>
        </button>
        <button class="xbtn" class:armed={armedId === a.paneId} title={t('agents.closeTitle')} aria-label={t('agents.closeAria')} onclick={() => closeAgent(a.paneId)}>
          {#if armedId === a.paneId}{t('agents.closeConfirm')}{:else}<Icon name="x" size={12} />{/if}
        </button>
      </div>

      {#if !closed[a.paneId]}
        <div class="det">
          {#if a.current}<div class="cur"><Icon name="bolt" size={11} /> {a.current}</div>{/if}
          <div class="meta">
            {#if a.ctxTokens}<span>{t('agents.ctx', { n: k(a.ctxTokens) })}</span>{/if}
            {#if c}<span class="cache {c.cls}" title={t('agents.cache.ttlTitle', { min: a.cacheTtl / 60 })}>{c.text}</span>{/if}
          </div>

          <!-- Los tokens del agente principal (contexto, ↑ entrada, ↓ salida) están en la cabecera de su panel. -->
          {#if a.subTokens?.requests}
            <div class="tok sub" title={t('agents.subTokens.title', { requests: a.subTokens.requests, fresh: k(fresh(a.subTokens)), cached: k(a.subTokens.cacheRead) })}>
              <span>{t('agents.subTokens.label')}</span>
              <span>{t('agents.tokens.out', { n: k(a.subTokens.output) })}</span>
              <span class="dim">{t('agents.subTokens.requests', { n: k(a.subTokens.requests) })}</span>
            </div>
          {/if}

          {#if a.todos.length}
            <div class="h">{t('agents.tasks', { done: done(a), total: a.todos.length })}</div>
            {#each a.todos as t, i (i)}
              <div class="todo" class:okk={t.status === 'completed'} class:now={t.status === 'in_progress'}>
                <span class="mk">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}</span>
                <span>{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
              </div>
            {/each}
          {/if}

          {#if a.subagents.length}
            <div class="h">{t('agents.subagents', { n: running(a) })}</div>
            {#each a.subagents as s (s.id)}
              <div class="sub-line" class:open={app.subagentView?.paneId === a.paneId && app.subagentView?.subId === s.id}>
                <button class="sub-row" class:run={s.state === 'running'} onclick={() => (app.subagentView = { paneId: a.paneId, subId: s.id })} title={`${s.description}
${t('agents.sub.openTitle')}`}>
                  <span class="mk">{s.state === 'running' ? '◐' : '✓'}</span>
                  <span class="kind">{s.kind}</span>
                  <span class="desc">{s.description}</span>
                </button>
                <button class="sub-go" title={t('agents.sub.goToPane')} aria-label={t('agents.sub.goToPane')} onclick={() => app.focusPane(a.paneId)}>
                  <Icon name="terminal" size={11} />
                </button>
              </div>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .ag { margin: 2px 6px 4px; border-radius: 7px; border: 1px solid transparent; }
  .ag.wait { border-color: rgba(239, 107, 115, 0.55); background: rgba(239, 107, 115, 0.06); }
  .row { display: flex; align-items: center; }
  .chev { color: var(--faint); width: 18px; display: grid; place-items: center; align-self: stretch; }
  .main { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; padding: 5px 6px 5px 2px; border-radius: 6px; text-align: left; }
  .main:hover { background: var(--raise); }
  .xbtn { flex: none; margin: 0 4px 0 2px; min-width: 22px; height: 22px; padding: 0 5px; border-radius: 5px; display: grid; place-items: center; color: var(--faint); font-size: 11px; opacity: 0.55; }
  .row:hover .xbtn, .xbtn:focus-visible, .xbtn.armed { opacity: 1; }
  .xbtn:hover { color: var(--bad); background: var(--raise); }
  .xbtn.armed { background: var(--bad); color: #1a0a0b; font-weight: 600; }
  .st { width: 9px; height: 9px; border-radius: 50%; background: var(--faint); flex: none; }
  .st.busy { background: var(--accent); animation: pulse 1.2s ease-in-out infinite, ring 1.6s ease-out infinite; }
  @keyframes ring { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); } 100% { box-shadow: 0 0 0 7px transparent; } }
  @keyframes orch-spin-mk { to { transform: rotate(360deg); } }
  .sub-row.run .mk { display: inline-block; animation: orch-spin-mk 1.4s linear infinite; }
  .ag { transition: border-color 0.15s, background 0.15s; }
  .ag:hover { background: color-mix(in srgb, var(--raise) 55%, transparent); }
  @media (prefers-reduced-motion: reduce) { .st.busy, .st.waiting, .sub-row.run .mk { animation: none; } }
  .st.waiting { background: var(--bad); animation: pulse 0.7s ease-in-out infinite; }
  .st.idle { background: var(--ok); }
  @keyframes pulse { 50% { opacity: 0.35; transform: scale(0.8); } }
  .txt { display: grid; min-width: 0; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .adot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: 0; }
  .det { padding: 0 8px 6px 26px; display: grid; gap: 3px; }
  .cur { color: var(--accent); font-size: 11.5px; display: flex; gap: 5px; align-items: center; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .meta { display: flex; gap: 8px; flex-wrap: wrap; font-size: 11px; color: var(--muted); }
  .tok { display: flex; gap: 9px; flex-wrap: wrap; font-size: 11px; color: var(--text); font-variant-numeric: tabular-nums; }
  .tok.sub { color: var(--info); }
  .tok .dim { color: var(--faint); }
  .cache.ok { color: var(--ok); }
  .cache.warm { color: var(--accent); }
  .cache.hot, .cache.cold { color: var(--bad); }
  .h { color: var(--faint); font-size: 10px; letter-spacing: 0.08em; font-weight: 600; margin-top: 5px; }
  .todo { display: flex; gap: 6px; font-size: 11.5px; color: var(--muted); }
  .todo.okk { color: var(--faint); text-decoration: line-through; }
  .todo.now { color: var(--text); }
  .mk { width: 12px; flex: none; text-align: center; }
  .sub-line { display: flex; align-items: center; min-width: 0; border-radius: 4px; }
  .sub-line.open { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .sub-go { flex: none; width: 20px; height: 20px; display: grid; place-items: center; color: var(--faint); border-radius: 4px; opacity: 0; }
  .sub-line:hover .sub-go, .sub-go:focus-visible { opacity: 0.8; }
  .sub-go:hover { color: var(--accent); background: var(--raise); opacity: 1; }
  .sub-row { flex: 1; display: flex; gap: 6px; align-items: center; font-size: 11.5px; color: var(--faint); text-align: left; padding: 1px 3px; border-radius: 4px; min-width: 0; }
  .sub-row:hover { background: var(--raise); }
  .sub-row.run { color: var(--text); }
  .sub-row.run .mk { color: var(--accent); }
  .kind { color: var(--info); flex: none; }
  .desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
