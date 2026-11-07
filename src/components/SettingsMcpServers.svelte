<script lang="ts">
  // Ajustes → MCP de tus cuentas: solo un resumen y el enlace a la vista MCP a pantalla completa (McpView.svelte).
  // La tabla no cabe en el modal de Ajustes con varias cuentas: vive en su propia vista.
  import { onMount } from 'svelte';
  import { app } from '../lib/store.svelte.ts';
  import { mcpmList } from '../lib/backend.ts';
  import type { McpAccount } from '../lib/backend.ts';
  import { buildMcpRows } from '../lib/mcpmatrix.ts';
  import { t, tn } from '../lib/i18n.ts';
  import Icon from './Icon.svelte';

  let accounts = $state<McpAccount[] | null>(null);
  const servers = $derived(accounts ? buildMcpRows(accounts).length : 0);
  onMount(() => {
    void mcpmList([]).then((l) => (accounts = l)).catch(() => (accounts = []));
  });
  function open() {
    app.settingsOpen = false;
    app.consumoOpen = false;
    app.mcpOpen = true;
  }
</script>

<div class="sum">
  <p class="hint">{t('mcp.view.summary.hint')}</p>
  {#if accounts}
    <p class="count">{t('mcp.view.summary.text', { accounts: tn('mcp.view.summary.accounts', accounts.length), servers: tn('mcp.view.summary.servers', servers) })}</p>
  {/if}
  <button class="btn primary" onclick={open}><Icon name="layers" size={14} /> {t('mcp.view.summary.open')}</button>
</div>

<style>
  .sum { display: grid; gap: 10px; justify-items: start; }
  .hint { margin: 0; color: var(--muted); font-size: 13px; }
  .count { margin: 0; color: var(--text); font-size: 13px; }
  .btn { display: inline-flex; align-items: center; gap: 6px; }
</style>
