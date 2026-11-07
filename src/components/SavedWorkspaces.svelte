<script lang="ts">
  // Lista de espacios guardados (botón junto al «+» de la barra de pestañas): abrir, renombrar, sobrescribir y borrar.
  // Borrar y sobrescribir piden confirmación en la propia fila (nunca confirm() del navegador).
  import { app } from '../lib/store.svelte.ts';
  import { filterSaved } from '../lib/savedws.ts';
  import { displayName } from '../lib/model.ts';
  import { t } from '../lib/i18n.ts';
  import Icon from './Icon.svelte';

  let { onsave }: { onsave: () => void } = $props();

  let open = $state(false);
  let query = $state('');
  let renaming = $state<string | null>(null);
  let renameErr = $state('');
  let asking = $state<{ id: string; what: 'delete' | 'overwrite' } | null>(null);

  const list = $derived(filterSaved(app.savedWorkspaces, query));
  const showSearch = $derived(app.savedWorkspaces.length >= 5);

  let left = $state(0);
  function toggle(e: MouseEvent) {
    // La lista va en `fixed`: la fila de pestañas tiene scroll horizontal y la recortaría.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    left = Math.max(8, Math.min(r.left, window.innerWidth - 368));
    open = !open;
    query = ''; renaming = null; asking = null; renameErr = '';
  }
  function close() { open = false; renaming = null; asking = null; }
  function openOne(id: string) { app.openSavedWorkspace(id); close(); }
  function finishRename(id: string, value: string) {
    const r = app.renameSavedWorkspace(id, value);
    if (r.ok || r.reason === 'empty' || r.reason === 'missing') { renaming = null; renameErr = ''; return; } // vacío = se queda el de antes
    renameErr = t('topbar.saved.nameTaken');
  }
  function confirmAsk() {
    if (!asking) return;
    if (asking.what === 'delete') app.deleteSavedWorkspace(asking.id);
    else app.overwriteSavedWorkspace(asking.id, app.activeId);
    asking = null;
  }
  function focusOnMount(el: HTMLElement) { el.focus(); if (el instanceof HTMLInputElement) el.select(); }
  function onSearchKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && list[0]) openOne(list[0].id);
    if (e.key === 'Escape') close();
  }
</script>

<svelte:window
  onpointerdown={(e) => { if (open && !(e.target as HTMLElement).closest('.saved-wrap')) close(); }}
  onkeydown={(e) => { if (open && e.key === 'Escape' && !renaming) close(); }}
/>

<div class="saved-wrap">
  <button class="iconbtn" class:on={open} title={t('topbar.saved.buttonTitle')} aria-expanded={open} onclick={toggle}><Icon name="layers" /></button>
  {#if open}
    <div class="saved" style:left="{left}px" role="dialog" aria-label={t('topbar.saved.title')}>
      <div class="head">
        <b>{t('topbar.saved.title')}</b>
        <button class="btn" onclick={() => { close(); onsave(); }}><Icon name="plus" size={13} /> {t('topbar.saved.saveCurrent')}</button>
      </div>
      {#if showSearch}
        <label class="search">
          <Icon name="search" size={13} />
          <input placeholder={t('topbar.saved.search')} aria-label={t('topbar.saved.search')} bind:value={query} use:focusOnMount onkeydown={onSearchKey} />
        </label>
      {/if}
      {#if !app.savedWorkspaces.length}
        <p class="hint empty">{t('topbar.saved.empty')}</p>
      {:else if !list.length}
        <p class="hint empty">{t('topbar.saved.noMatch', { q: query.trim() })}</p>
      {:else}
        <ul>
          {#each list as s (s.id)}
            <li class:asking={asking?.id === s.id}>
              {#if renaming === s.id}
                <div class="ren">
                  <input value={s.name} use:focusOnMount aria-invalid={!!renameErr}
                    onkeydown={(e) => { if (e.key === 'Enter') finishRename(s.id, (e.target as HTMLInputElement).value); if (e.key === 'Escape') { renaming = null; renameErr = ''; } }}
                    onblur={(e) => finishRename(s.id, (e.target as HTMLInputElement).value)} />
                  {#if renameErr}<small class="err">{renameErr}</small>{/if}
                </div>
              {:else if asking?.id === s.id}
                <span class="ask">{t(asking.what === 'delete' ? 'topbar.saved.deleteAsk' : 'topbar.saved.overwriteAsk', { name: s.name })}</span>
                <button class="btn" class:danger={asking.what === 'delete'} use:focusOnMount onclick={confirmAsk}>{asking.what === 'delete' ? t('topbar.saved.delete') : t('topbar.save.overwrite')}</button>
                <button class="btn ghost" onclick={() => (asking = null)}>{t('topbar.saved.no')}</button>
              {:else}
                <button class="main" title={t('topbar.saved.openTitle')} onclick={() => openOne(s.id)}>
                  <span class="nm">{s.name}</span>
                  <span class="meta">{t(s.panes.length === 1 ? 'topbar.saved.panesOne' : 'topbar.saved.panes', { n: s.panes.length, cols: s.cols.length, rows: s.rows.length })}</span>
                </button>
                <button class="iconbtn" title={t('topbar.saved.rename')} aria-label={t('topbar.saved.rename')} onclick={() => { renaming = s.id; renameErr = ''; }}><Icon name="edit" size={13} /></button>
                <button class="iconbtn" title={t('topbar.saved.overwrite') + ' (' + displayName(app.active.name) + ')'} aria-label={t('topbar.saved.overwrite')} onclick={() => (asking = { id: s.id, what: 'overwrite' })}><Icon name="refresh" size={13} /></button>
                <button class="iconbtn danger" title={t('topbar.saved.delete')} aria-label={t('topbar.saved.delete')} onclick={() => (asking = { id: s.id, what: 'delete' })}><Icon name="trash" size={13} /></button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .saved-wrap { position: relative; }
  .iconbtn.on { color: var(--text); background: #2a313b; }
  .saved { position: fixed; top: 38px; width: 360px; max-height: min(460px, 70vh); background: var(--panel); border: 1px solid var(--border-strong); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px; z-index: 40; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55); }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 2px 0 4px; }
  .head b { font-size: 13px; }
  .search { display: flex; align-items: center; gap: 6px; padding: 0 8px; border: 1px solid var(--border); border-radius: 7px; color: var(--muted); }
  .search input { flex: 1; border: 0; background: transparent; padding: 6px 0; outline: none; }
  .search:focus-within { border-color: var(--accent); }
  .empty { margin: 4px 4px 6px; line-height: 1.45; }
  ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; display: grid; gap: 2px; }
  li { display: flex; align-items: center; gap: 2px; border-radius: 7px; padding: 2px 4px 2px 2px; min-height: 40px; }
  li:hover, li:focus-within { background: var(--raise); }
  li.asking { background: var(--raise); padding-left: 10px; gap: 6px; }
  .main { flex: 1; min-width: 0; display: grid; gap: 1px; text-align: left; padding: 5px 8px; border-radius: 6px; }
  .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
  .meta { font-size: 11px; color: var(--muted); }
  .ask { flex: 1; min-width: 0; font-size: 12.5px; }
  .ren { flex: 1; display: grid; gap: 3px; padding: 4px 6px; }
  .ren input { padding: 4px 7px; }
  .err { color: var(--bad); font-size: 11px; }
  .btn.danger { color: #1a0a0b; background: var(--bad); border-color: var(--bad); }
</style>
