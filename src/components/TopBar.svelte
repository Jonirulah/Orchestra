<script lang="ts">
  import { app } from '../lib/store.svelte.ts';
  import { PRESETS, displayName } from '../lib/model.ts';
  import { t } from '../lib/i18n.ts';
  import { ctxmenu } from '../lib/ctxmenu.svelte.ts';
  import { sep } from '../lib/ctxmenu.ts';
  import type { MenuItem } from '../lib/ctxmenu.ts';
  import Icon from './Icon.svelte';
  import SavedWorkspaces from './SavedWorkspaces.svelte';

  let pickerOpen = $state(false);
  let editing = $state<string | null>(null);
  let customCols = $state(2);
  let customRows = $state(2);

  const ws = $derived(app.active);

  function pick(c: number, r: number) {
    app.setLayout(c, r);
    pickerOpen = false;
  }
  function finishRename(id: string, ev: Event) {
    app.renameWorkspace(id, (ev.target as HTMLInputElement).value);
    editing = null;
  }
  function focusOnMount(el: HTMLInputElement) { el.focus(); el.select(); }

  // ---------- menú de la pestaña ----------
  function tabMenu(id: string): MenuItem[] {
    const many = app.workspaces.length > 1;
    return [
      { id: 'rename', label: t('topbar.menu.rename'), hint: 'F2', run: () => (editing = id) },
      { id: 'duplicate', label: t('topbar.menu.duplicate'), run: () => app.duplicateWorkspace(id) },
      { id: 'save', label: t('topbar.menu.save'), run: () => openSave(id) },
      sep(),
      { id: 'close', label: t('topbar.menu.close'), danger: true, disabled: !many, run: () => app.closeWorkspace(id) },
      { id: 'closeOthers', label: t('topbar.menu.closeOthers'), danger: true, disabled: !many, run: () => app.closeOtherWorkspaces(id) },
    ];
  }
  function onTabKey(id: string, e: KeyboardEvent) {
    if (e.key === 'F2') { e.preventDefault(); editing = id; }
  }

  // ---------- guardar espacio ----------
  let savingFor = $state<string | null>(null);
  let saveName = $state('');
  let conflict = $state<string | null>(null);
  function openSave(id: string) {
    const w = app.workspaces.find((x) => x.id === id);
    if (!w) return;
    savingFor = id;
    saveName = displayName(w.name);
    conflict = null;
  }
  function submitSave(overwrite = false) {
    if (!savingFor) return;
    const r = app.saveWorkspace(savingFor, saveName, overwrite);
    if (r.ok) { savingFor = null; return; }
    if (r.reason === 'conflict') conflict = r.existing?.name ?? saveName.trim();
    if (r.reason === 'full') savingFor = null;
  }
</script>

<svelte:window onpointerdown={(e) => { if (pickerOpen && !(e.target as HTMLElement).closest('.picker-wrap')) pickerOpen = false; }} />

<header class="top">
  <button class="iconbtn" title={t('topbar.sidebarTitle')} onclick={() => app.toggleSidebar()}><Icon name="sidebar" /></button>

  <div class="tabs">
    {#each app.workspaces as w (w.id)}
      <div class="tab" class:on={w.id === app.activeId}>
        {#if editing === w.id}
          <input class="rename" value={w.name} use:focusOnMount onblur={(e) => finishRename(w.id, e)}
            onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') editing = null; }} />
        {:else}
          <button class="tname" onclick={() => app.switchWorkspace(w.id)} ondblclick={() => (editing = w.id)} title={t('topbar.renameTitle')}
            onkeydown={(e) => onTabKey(w.id, e)} oncontextmenu={(e) => ctxmenu.openFromEvent(e, tabMenu(w.id), e.currentTarget as HTMLElement)}>
            {displayName(w.name)}<span class="cnt">{w.panes.length}</span>
          </button>
          {#if app.workspaces.length > 1}
            <button class="iconbtn x" title={t('topbar.closeWorkspaceTitle')} onclick={() => app.closeWorkspace(w.id)}><Icon name="x" size={12} /></button>
          {/if}
        {/if}
      </div>
    {/each}
    <button class="iconbtn" title={t('topbar.newWorkspaceTitle')} onclick={() => app.addWorkspace()}><Icon name="plus" /></button>
    <SavedWorkspaces onsave={() => openSave(app.activeId)} />
  </div>

  <span class="grow"></span>

  <div class="picker-wrap">
    <button class="btn" onclick={() => (pickerOpen = !pickerOpen)} title={t('topbar.gridLayoutTitle')}>
      <Icon name="grid" /> {ws.cols.length} × {ws.rows.length}
    </button>
    {#if pickerOpen}
      <div class="picker">
        <div class="presets">
          {#each PRESETS as p (p.id)}
            <button class="preset" class:on={p.cols === ws.cols.length && p.rows === ws.rows.length} onclick={() => pick(p.cols, p.rows)} title={p.label}>
              <span class="mini" style:grid-template-columns="repeat({p.cols}, 1fr)" style:grid-template-rows="repeat({p.rows}, 1fr)">
                {#each Array(p.cols * p.rows) as _, i (i)}<i></i>{/each}
              </span>
              <span class="lbl">{p.cols} × {p.rows}</span>
            </button>
          {/each}
        </div>
        <div class="custom">
          <span class="hint">{t('topbar.columnsRowsHint')}</span>
          <input type="number" min="1" max="8" bind:value={customCols} />
          <span>×</span>
          <input type="number" min="1" max="8" bind:value={customRows} />
          <button class="btn primary" onclick={() => pick(customCols, customRows)}>{t('topbar.apply')}</button>
        </div>
        <button class="btn ghost" onclick={() => { app.equalize(); pickerOpen = false; }}>{t('topbar.equalize')}</button>
        <div class="hint">{t('topbar.overflowHint')}</div>
      </div>
    {/if}
  </div>
</header>

{#if savingFor}
  <div class="modal-back" role="presentation" onpointerdown={(e) => { if (e.target === e.currentTarget) savingFor = null; }}
    onkeydown={(e) => { if (e.key === 'Escape') savingFor = null; }}>
    <div class="modal save-ws" role="dialog" aria-modal="true" aria-labelledby="save-ws-title">
      <h2 id="save-ws-title">{t('topbar.save.title')}</h2>
      <div class="body">
        <label class="field"><span>{t('topbar.save.nameLabel')}</span>
          <input bind:value={saveName} use:focusOnMount oninput={() => (conflict = null)} maxlength="60"
            onkeydown={(e) => { if (e.key === 'Enter') submitSave(!!conflict); }} />
        </label>
        {#if conflict}
          <p class="s-msg err" role="alert">{t('topbar.save.conflict', { name: conflict })}</p>
        {/if}
        <p class="hint">{t('topbar.save.hint')}</p>
      </div>
      <div class="foot">
        <button class="btn ghost" onclick={() => (savingFor = null)}>{t('topbar.save.cancel')}</button>
        {#if conflict}
          <button class="btn primary" onclick={() => submitSave(true)}>{t('topbar.save.overwrite')}</button>
        {:else}
          <button class="btn primary" disabled={!saveName.trim()} onclick={() => submitSave()}>{t('topbar.save.submit')}</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .save-ws { width: min(440px, 92vw); }
  .top { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 10px; background: var(--panel); border-bottom: 1px solid var(--border); }
  .grow { flex: 1; }
  .tabs { display: flex; align-items: center; gap: 3px; min-width: 0; overflow-x: auto; }
  .tab { display: flex; align-items: center; border-radius: 6px; border: 1px solid transparent; }
  .tab.on { background: var(--raise); border-color: var(--border-strong); }
  .tname { padding: 5px 4px 5px 11px; color: var(--muted); white-space: nowrap; display: flex; gap: 7px; align-items: center; }
  .tab.on .tname { color: var(--text); }
  .cnt { font-size: 10.5px; background: #2a313b; border-radius: 9px; padding: 0 6px; color: var(--muted); }
  .x { margin-right: 3px; width: 20px; height: 20px; }
  .rename { width: 130px; padding: 3px 7px; margin: 2px; }
  .picker-wrap { position: relative; }
  .picker { position: absolute; right: 0; top: 36px; width: 330px; background: var(--panel); border: 1px solid var(--border-strong); border-radius: 10px; padding: 12px; display: grid; gap: 10px; z-index: 40; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55); }
  .presets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .preset { display: grid; gap: 6px; justify-items: center; padding: 9px 4px 6px; border-radius: 8px; border: 1px solid var(--border); }
  .preset:hover { border-color: var(--faint); background: var(--raise); }
  .preset.on { border-color: var(--accent); background: var(--accent-soft); }
  .mini { display: grid; gap: 2px; width: 54px; height: 36px; }
  .mini i { background: var(--faint); border-radius: 2px; }
  .preset.on .mini i { background: var(--accent); }
  .lbl { font-size: 11.5px; color: var(--muted); }
  .custom { display: flex; align-items: center; gap: 6px; }
  .custom input { width: 54px; padding: 4px 6px; }
  .custom .hint { margin-right: auto; }
</style>
