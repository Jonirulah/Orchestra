<script lang="ts">
  // Tarjeta «Status bar» de Ajustes → General: encender, elegir y ordenar elementos, intervalo y vista previa en vivo.
  import { app } from '../lib/store.svelte.ts';
  import { t, tk } from '../lib/i18n.ts';
  import { ITEM_IDS, INTERVAL_LIMITS, RM_INTERVAL_LIMITS, itemsFor, moveFor, toggleFor } from '../lib/statusbar.ts';
  import type { ItemId } from '../lib/statusbar.ts';
  import Toggle from './Toggle.svelte';
  import Slider from './Slider.svelte';
  import Icon from './Icon.svelte';
  import StatusBar from './StatusBar.svelte';

  const s = $derived(app.settings);
  const name = (id: ItemId) => tk(`statusbar.item.${id}`);
  // Primero los elegidos (en su orden), luego los apagados en el orden de siempre.
  // Con la pestaña activa con lista propia se edita esa; si no, la global.
  const own = $derived(Array.isArray(app.active?.statusBarItems));
  const list = $derived(itemsFor(own ? app.active : null, s));
  const ordered = $derived<ItemId[]>([...list, ...ITEM_IDS.filter((i) => !list.includes(i))]);
  const setItems = (r: { scope: 'tab' | 'global'; list: ItemId[] }) => (r.scope === 'tab' ? app.setTabStatusItems(r.list) : app.setting('statusBarItems', r.list));
  let lastFocus = $state<string>('');
  function move(id: ItemId, dir: -1 | 1) {
    setItems(moveFor(app.active, s.statusBarItems, id, dir));
    lastFocus = `${id}:${dir < 0 ? 'up' : 'down'}`;
    // El botón se vuelve a pintar en otra fila: se devuelve el foco al mismo para seguir con el teclado.
    queueMicrotask(() => queueMicrotask(() => (document.querySelector(`[data-sbk="${lastFocus}"]:not(:disabled)`) as HTMLElement | null)?.focus()));
  }
</script>

<div class="s-row">
  <div class="lbl">
    <b>{t('statusbar.settings.showLabel')}</b>
    <small>{t('statusbar.settings.showHint')}</small>
  </div>
  <div class="ctl"><Toggle value={s.statusBar} label={t('statusbar.settings.showLabel')} onchange={(v) => app.setting('statusBar', v)} /></div>
</div>

{#if s.statusBar}
  <div class="s-row stack">
    <div class="lbl">
      <b>{t('statusbar.settings.itemsLabel')}</b>
      <small>{t('statusbar.settings.itemsHint')} {t('statusbar.settings.diskHint')}</small>
    </div>
    <p class="tabnote" class:own>
      {own ? t('statusbar.settings.tabOwn') : t('statusbar.settings.tabDefault')}
      {#if own}<button type="button" class="btn" onclick={() => app.setTabStatusItems(undefined)}>{t('statusbar.settings.tabReset')}</button>{/if}
    </p>
    <ul class="items">
      {#each ordered as id (id)}
        {@const on = list.includes(id)}
        {@const idx = list.indexOf(id)}
        <li class:off={!on}>
          <label>
            <input type="checkbox" checked={on} aria-label={t('statusbar.settings.show', { item: name(id) })} onchange={(e) => setItems(toggleFor(app.active, s.statusBarItems, id, e.currentTarget.checked))} />
            <span>{name(id)}</span>
          </label>
          <span class="mv">
            <button type="button" class="iconbtn flip" data-sbk="{id}:up" disabled={!on || idx <= 0} title={t('statusbar.settings.up', { item: name(id) })} aria-label={t('statusbar.settings.up', { item: name(id) })} onclick={() => move(id, -1)}><Icon name="down" size={13} /></button>
            <button type="button" class="iconbtn" data-sbk="{id}:down" disabled={!on || idx >= list.length - 1} title={t('statusbar.settings.down', { item: name(id) })} aria-label={t('statusbar.settings.down', { item: name(id) })} onclick={() => move(id, 1)}><Icon name="down" size={13} /></button>
          </span>
        </li>
      {/each}
    </ul>
  </div>

  <div class="s-row">
    <div class="lbl">
      <b>{t('statusbar.settings.adaptLabel')}</b>
      <small>{t('statusbar.settings.adaptHint')}</small>
    </div>
    <div class="ctl"><Toggle value={s.statusBarAdapt} label={t('statusbar.settings.adaptLabel')} onchange={(v) => app.setting('statusBarAdapt', v)} /></div>
  </div>

  <div class="s-row">
    <div class="lbl">
      <b>{t('statusbar.settings.intervalLabel')}</b>
      <small>{t('statusbar.settings.intervalHint')}</small>
    </div>
    <div class="ctl"><Slider value={s.statusBarInterval} min={INTERVAL_LIMITS[0]} max={INTERVAL_LIMITS[1]} unit=" s" onchange={(v) => app.setting('statusBarInterval', v)} /></div>
  </div>

  <div class="s-row">
    <div class="lbl">
      <b>{t('statusbar.settings.rmIntervalLabel')}</b>
      <small>{t('statusbar.settings.rmIntervalHint')}</small>
    </div>
    <div class="ctl"><Slider value={s.remoteMetricsInterval} min={RM_INTERVAL_LIMITS[0]} max={RM_INTERVAL_LIMITS[1]} unit=" s" onchange={(v) => app.setting('remoteMetricsInterval', v)} /></div>
  </div>

  <div class="s-row stack">
    <div class="lbl"><b>{t('statusbar.settings.previewLabel')}</b></div>
    <StatusBar preview />
  </div>
{/if}

<style>
  .tabnote { margin: 0 0 6px; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .tabnote.own { color: var(--text); }
  .items { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  li { display: flex; align-items: center; justify-content: space-between; padding: 3px 6px; border-radius: 5px; }
  li:hover { background: var(--raise); }
  li.off span:not(.mv) { color: var(--muted); }
  label { display: inline-flex; align-items: center; gap: 9px; cursor: pointer; }
  .mv { display: inline-flex; gap: 2px; }
  .mv button:disabled { opacity: 0.3; cursor: default; }
  .flip :global(svg) { transform: rotate(180deg); }
</style>
