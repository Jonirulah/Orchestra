<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from './lib/store.svelte.ts';
  import Sidebar from './components/Sidebar.svelte';
  import TopBar from './components/TopBar.svelte';
  import Grid from './components/Grid.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import HostDialog from './components/HostDialog.svelte';
  import AccountDialog from './components/AccountDialog.svelte';
  import Palette from './components/Palette.svelte';
  import SettingsDialog from './components/SettingsDialog.svelte';
  import ConfirmHostKey from './components/ConfirmHostKey.svelte';
  import McpApproval from './components/McpApproval.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import McpView from './components/McpView.svelte';
  import SubagentDrawer from './components/SubagentDrawer.svelte';
  import ConsumoView from './components/ConsumoView.svelte';
  import ConsumoSession from './components/ConsumoSession.svelte';

  onMount(() => { void app.init(); });

  function startResize(ev: PointerEvent) {
    ev.preventDefault();
    const el = ev.currentTarget as HTMLElement;
    el.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => { app.settings.sidebarWidth = Math.max(210, Math.min(520, e.clientX)); };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); app.persist(); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }
</script>

<!-- Dentro de un terminal los atajos los resuelve xterm (attachCustomKeyEventHandler); aquí solo el resto. -->
<svelte:window onkeydown={(e) => {
  if ((e.target as HTMLElement)?.closest?.('.xterm')) return;
  if (app.ready && app.handleShortcut(e)) e.preventDefault();
}} />

{#if app.ready}
  <!-- Cambiar de idioma remonta toda la interfaz (los xterm viven fuera, en terminals.ts, y PaneView los descuelga/cuelga). -->
  {#key app.settings.language}
  <div class="shell" class:drawer={!!(app.consumoPane || app.consumoPath)} style:grid-template-columns={app.settings.sidebarOpen && !app.mcpFold ? `${app.settings.sidebarWidth}px 5px 1fr` : '1fr'}>
    {#if app.settings.sidebarOpen && !app.mcpFold}
      <Sidebar />
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="rz" onpointerdown={startResize}></div>
    {/if}
    <main>
      <TopBar />
      <div class="area">
        {#key app.activeId}<Grid />{/key}
        <!-- MCP y Consumo son capas sobre la misma zona: se abre una sola (TopBar cierra la otra). -->
        {#if app.mcpOpen}<McpView />{:else if app.consumoOpen}<ConsumoView />{/if}
      </div>
    </main>
    {#if app.settings.statusBar}<StatusBar />{/if}
  </div>
  {#if app.hostDialog}<HostDialog />{/if}
  {#if app.settingsOpen}<SettingsDialog />{/if}
  {#if app.accountDialog}<AccountDialog />{/if}
  {#if app.paletteOpen}<Palette />{/if}
  {#if app.hostKeyPrompt}<ConfirmHostKey />{/if}
  {#if app.mcpApprovals.length}<McpApproval />{/if}
  <ContextMenu />
  <SubagentDrawer />
  <ConsumoSession />
  {#if app.toastMsg}<div class="toast">{app.toastMsg}</div>{/if}
  {/key}
{:else}
  <div class="boot">Orchestra…</div>
{/if}

<style>
  .shell { display: grid; height: 100%; grid-template-rows: minmax(0, 1fr) auto; }
  /* Cajón de consumo de sesión abierto: el área de paneles se encoge en vez de quedar tapada (la cabecera del
     terminal que se mira sigue entera). Por debajo de 1200 px el cajón vuelve a ir por encima (si no, el terminal quedaría en ~100 px). */
  :global(:root) { --consumo-drawer: min(560px, 100vw); }
  @media (min-width: 1200px) {
    :global(:root) { --consumo-drawer: clamp(380px, 40vw, 560px); }
    .shell.drawer { padding-right: var(--consumo-drawer); }
  }
  main { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; }
  .area { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .rz { cursor: col-resize; background: transparent; margin-left: -3px; }
  .rz:hover { background: color-mix(in srgb, var(--accent) 40%, transparent); }
  .boot { height: 100%; display: grid; place-items: center; color: var(--muted); }
</style>
