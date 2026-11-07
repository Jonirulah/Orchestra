<script lang="ts">
  // Acción sobre un estado malo de una celda (v7): Aprobar (.mcp.json), Encender / Apagar, Iniciar sesión. Igual que el
  // resto de cambios: vista previa con el fichero y lo que se escribe exactamente, aplicar, resultado y «Deshacer».
  import { mcpmApply, mcpmPlan } from '../lib/backend.ts';
  import type { McpAccount, McpApplyResult, McpChange, McpDef, McpPlanStep } from '../lib/backend.ts';
  import { winPath } from '../lib/mcpcols.ts';
  import { t, tk } from '../lib/i18n.ts';

  export type StateAction = { kind: 'approve' | 'on' | 'off' | 'login'; account: McpAccount; def: McpDef };
  interface Props {
    action: StateAction;
    colName: (a: McpAccount) => string;
    toolName: string;
    reload: () => Promise<McpAccount[]>;
    /** Iniciar sesión: abre un terminal de Orchestra con la cuenta y el comando (`cmd`, el que se enseña). */
    onlogin: (cmd: string) => void;
    onclose: () => void;
  }
  let { action, colName, toolName, reload, onlogin, onclose }: Props = $props();
  // El panel se vuelve a montar con cada acción ({#key} en la vista): leer la acción una vez es lo que se quiere.
  // svelte-ignore state_referenced_locally
  const { kind, account: a, def: d } = action;

  let plan = $state<McpPlanStep[] | null>(null);
  let result = $state<McpApplyResult | null>(null);
  let busy = $state(false);
  let err = $state<string | null>(null);
  let opened = $state(false);

  const change = (): McpChange | null =>
    kind === 'approve' ? { kind: 'approve', accountId: a.id, name: d.name, projectPath: d.projectPath ?? '' }
      : kind === 'on' || kind === 'off' ? { kind: 'setEnabled', accountId: a.id, name: d.name, scope: d.scope, projectPath: d.projectPath ?? (d.disabledIn[0] ?? null), on: kind === 'on' }
      : null;
  /** Comando exacto del inicio de sesión de ese MCP con esa herramienta. */
  const loginCmd = a.provider === 'codex' ? `codex mcp login ${d.name}` : a.provider === 'opencode' ? `opencode mcp auth ${d.name}` : 'claude';
  const where = d.projectPath ? winPath(d.projectPath) : '';

  $effect(() => {
    const c = change();
    if (!c) return;
    void mcpmPlan(c).then((p) => (plan = p), (e) => (err = String(e)));
  });
  async function apply() {
    const c = change();
    if (!c) return;
    busy = true;
    err = null;
    try {
      result = await mcpmApply(c);
      await reload();
    } catch (e) {
      err = String(e);
    } finally {
      busy = false;
    }
  }
  const title = $derived(tk(`mcp.view.act.title.${kind}`, { name: d.name, account: colName(a) }));
</script>

<section class="ed sa" aria-label={title}>
  <header>
    <div class="top">
      <h3>{title}</h3>
      <button class="iconbtn" onclick={onclose} aria-label={t('settings.mcp.edit.close')} title={t('settings.mcp.edit.close')}>✕</button>
    </div>
    <p class="muted">{colName(a)} · {toolName}{where ? ` · ${where}` : ''}</p>
  </header>
  <div class="ebody">
    <p class="note">{tk(`mcp.view.act.why.${kind}`, { name: d.name, path: where })}</p>
    {#if kind === 'login'}
      <p class="lbl">{t('mcp.view.act.loginRuns')}</p>
      <pre class="cmdc">{loginCmd}</pre>
      {#if a.provider === 'claude'}<p class="note">{t('mcp.view.act.loginClaude', { name: d.name })}</p>{/if}
      {#if opened}<p class="ok" role="status">{t('mcp.view.act.loginOpened')}</p>{/if}
    {:else if result}
      {#each result.steps as r (r.accountId)}
        <p class={r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'bad' : 'muted'} role="status">
          {r.status === 'ok' ? t('mcp.view.act.done') : r.status === 'failed' ? `${t('settings.mcp.edit.res.failed')}: ${r.msg}` : r.msg}
        </p>
      {/each}
      {#if result.undoId}<p class="muted">{t('mcp.view.act.undoHint')}</p>{/if}
    {:else if plan}
      <p class="lbl">{t('mcp.view.act.previewIntro')}</p>
      {#each plan as s (s.accountId)}
        {#if s.blocked}<p class="bad">{s.blocked}</p>
        {:else}
          <p class="file"><span class="muted">{t('mcp.view.act.file')}</span> <code>{s.file}</code></p>
          {#if s.lines.length}<pre class="cmdc">{s.lines.join('\n')}</pre>{/if}
          {#if s.note}<p class="muted">{s.note}</p>{/if}
          {#if kind === 'approve' || d.scope === 'project'}<p class="note">{t('mcp.view.act.approveAll')}</p>{/if}
        {/if}
      {/each}
    {:else if !err}
      <p class="muted"><span class="spinner" aria-hidden="true"></span>{t('settings.mcp.servers.reading')}</p>
    {/if}
    {#if err}<p class="s-msg err" role="alert">{err}</p>{/if}
  </div>
  <footer class="efoot">
    {#if kind === 'login'}
      <button class="btn" onclick={onclose}>{t('settings.mcp.edit.close')}</button>
      <button class="btn primary" onclick={() => { onlogin(loginCmd); opened = true; }}>{t('mcp.view.act.openTerminal')}</button>
    {:else if result}
      <button class="btn primary" onclick={onclose}>{t('settings.mcp.edit.close')}</button>
    {:else}
      <button class="btn" onclick={onclose} disabled={busy}>{t('settings.mcp.edit.cancel')}</button>
      <button class="btn primary" onclick={() => void apply()} disabled={busy || !plan || plan.every((s) => !!s.blocked || !s.lines.length)}>{busy ? t('settings.mcp.edit.applying') : tk(`mcp.view.act.btn.${kind}`)}</button>
    {/if}
  </footer>
</section>

<style>
  .sa { display: flex; flex-direction: column; min-height: 0; height: 100%; }
  header { flex: none; padding: 12px 14px 10px; border-bottom: 1px solid var(--border); display: grid; gap: 4px; }
  .top { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
  h3 { margin: 0; font-size: 14px; }
  .ebody { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px; display: grid; gap: 8px; align-content: start; }
  .lbl { margin: 4px 0 0; font-weight: 600; }
  .note { margin: 0; color: var(--text); line-height: 1.45; }
  .muted { color: #8b939e; margin: 0; }
  .ok { color: var(--ok); margin: 0; }
  .bad { color: var(--bad); margin: 0; }
  .file { margin: 0; }
  .file code { font: 12px 'Cascadia Mono', Consolas, monospace; overflow-wrap: anywhere; }
  .cmdc { margin: 0; padding: 8px 10px; border-radius: 6px; background: var(--bg); border: 1px solid var(--border); font: 12px/1.5 'Cascadia Mono', Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  .efoot { flex: none; display: flex; gap: 8px; justify-content: flex-end; padding: 10px 14px; border-top: 1px solid var(--border); background: var(--panel); }
</style>
