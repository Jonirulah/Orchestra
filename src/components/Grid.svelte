<script lang="ts">
  import { app } from '../lib/store.svelte.ts';
  import { emptyCells, MIN_TRACK_PX, accountTitle, displayName, providerOf } from '../lib/model.ts';
  import { t } from '../lib/i18n.ts';
  import PaneView from './PaneView.svelte';
  import Icon from './Icon.svelte';
  import { ctxmenu } from '../lib/ctxmenu.svelte.ts';
  import { backgroundMenu } from '../lib/ctxitems.ts';

  let gridEl: HTMLDivElement;
  let dragging = $state(false);

  const ws = $derived(app.active);
  const maxId = $derived(ws.maximizedId);
  const visible = $derived(ws.panes.filter((p) => !p.parked && (!maxId || p.id === maxId)));
  const empties = $derived(maxId ? [] : emptyCells(ws));
  const cum = (arr: number[]) => arr.slice(0, -1).map((_, i) => arr.slice(0, i + 1).reduce((a, b) => a + b, 0));
  const vLines = $derived(maxId ? [] : cum(ws.cols));
  const hLines = $derived(maxId ? [] : cum(ws.rows));

  function startDrag(axis: 'col' | 'row', i: number, ev: PointerEvent) {
    ev.preventDefault();
    const rect = gridEl.getBoundingClientRect();
    const total = axis === 'col' ? rect.width : rect.height;
    const start = axis === 'col' ? ev.clientX : ev.clientY;
    const minFrac = MIN_TRACK_PX / total;
    const base = axis === 'col' ? [...ws.cols] : [...ws.rows];
    const el = ev.currentTarget as HTMLElement;
    el.setPointerCapture(ev.pointerId);
    dragging = true;
    const move = (e: PointerEvent) => {
      const d = ((axis === 'col' ? e.clientX : e.clientY) - start) / total;
      const t = [...base];
      const a = Math.max(minFrac - base[i], Math.min(base[i + 1] - minFrac, d));
      t[i] = base[i] + a;
      t[i + 1] = base[i + 1] - a;
      if (axis === 'col') ws.cols = t; else ws.rows = t;
    };
    const up = () => {
      dragging = false;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      app.persist();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  function resetPair(axis: 'col' | 'row', i: number) {
    const t = [...(axis === 'col' ? ws.cols : ws.rows)];
    const s = t[i] + t[i + 1];
    t[i] = t[i + 1] = s / 2;
    if (axis === 'col') ws.cols = t; else ws.rows = t;
    app.persist();
  }

  function dropOnEmpty(e: DragEvent, col: number, row: number) {
    const other = e.dataTransfer?.getData('application/x-orchestra-pane');
    const open = e.dataTransfer?.getData('application/x-orchestra-open');
    if (other) { e.preventDefault(); app.moveTo(other, col, row); }
    else if (open) { e.preventDefault(); app.open(JSON.parse(open), { col, row }); }
  }
  function overEmpty(e: DragEvent) {
    const t = e.dataTransfer?.types ?? [];
    if (t.includes('application/x-orchestra-pane') || t.includes('application/x-orchestra-open')) e.preventDefault();
  }

  /** Clic derecho en una celda vacía o en un hueco entre paneles. Sobre un panel (su terminal tiene su propio menú) no hace nada. */
  function bgMenu(ev: MouseEvent) {
    const el = ev.target as HTMLElement;
    const cellEl = el.closest?.<HTMLElement>('.empty');
    if (!cellEl && el !== gridEl) return;
    const cell = cellEl ? { col: Number(cellEl.dataset.col), row: Number(cellEl.dataset.row) } : undefined;
    ctxmenu.openFromEvent(ev, backgroundMenu({
      accounts: app.accounts,
      hasShell: app.shells.length > 0,
      hasClaude: app.claudeAccounts.length > 0,
      cols: ws.cols.length,
      rows: ws.rows.length,
      newTerminal: () => app.shells[0] && app.open({ kind: 'shell', id: app.shells[0].id }, cell),
      newSsh: () => app.newHost(),
      newClaudeAuto: () => app.openAuto(cell),
      openAccount: (a) => app.open(providerOf(a) === 'claude' ? { kind: 'claude', accountId: a.id } : { kind: 'account', accountId: a.id }, cell),
      setLayout: (c, r) => app.setLayout(c, r),
      equalize: () => app.equalize(),
    }));
  }
  const track = (a: number[]) => a.map((f) => `minmax(0, ${f}fr)`).join(' ');
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="grid" class:dragging bind:this={gridEl} oncontextmenu={bgMenu}
  style:grid-template-columns={track(ws.cols)} style:grid-template-rows={track(ws.rows)}>

  {#each visible as p (p.id)}
    <PaneView pane={p} maximized={!!maxId} />
  {/each}

  {#each empties as c (`${c.col},${c.row}`)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="empty" data-col={c.col} data-row={c.row} style:grid-column={c.col + 1} style:grid-row={c.row + 1}
      ondragover={overEmpty} ondrop={(e) => dropOnEmpty(e, c.col, c.row)}>
      <button class="add" title={t('grid.empty.addTitle')}
        onclick={() => app.shells[0] && app.open({ kind: 'shell', id: app.shells[0].id }, c)}>
        <Icon name="plus" size={18} />
        <span>{t('grid.empty.add')}</span>
        <small>{t('grid.empty.dragHint')}</small>
      </button>
      {#if app.accounts.length}
        <div class="quick">
          {#each app.accounts as a (a.id)}
            <button class="qchip" onclick={() => app.open(providerOf(a) === 'claude' ? { kind: 'claude', accountId: a.id } : { kind: 'account', accountId: a.id }, c)}
              title={providerOf(a) === 'claude' ? t('grid.empty.claudeTitle', { name: a.name }) : t('grid.empty.accountTitle', { title: accountTitle(a) })}>
              <span class="qd" style:background={a.color}></span>{providerOf(a) === 'claude' ? displayName(a.name) : accountTitle(a)}
            </button>
          {/each}
          <button class="qchip auto" onclick={() => app.openAuto(c)} title={t('grid.empty.autoTitle')}>{t('grid.empty.auto')}</button>
        </div>
      {/if}
    </div>
  {/each}

  {#each vLines as f, i (i)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="split v" style:left="calc({f * 100}% - 4px)" onpointerdown={(e) => startDrag('col', i, e)} ondblclick={() => resetPair('col', i)} title={t('grid.splitTitle')}></div>
  {/each}
  {#each hLines as f, i (i)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="split h" style:top="calc({f * 100}% - 4px)" onpointerdown={(e) => startDrag('row', i, e)} ondblclick={() => resetPair('row', i)} title={t('grid.splitTitle')}></div>
  {/each}
</div>

<style>
  .grid { position: relative; display: grid; flex: 1; min-height: 0; min-width: 0; padding: 0; }
  .grid.dragging { user-select: none; }
  .empty { margin: 3px; border: 1px dashed var(--border-strong); border-radius: var(--radius); display: grid; place-items: center; align-content: center; min-width: 0; min-height: 0; }
  .empty:hover { border-color: var(--accent); background: var(--accent-soft); }
  .add { display: grid; justify-items: center; gap: 4px; color: var(--muted); padding: 20px; }
  .add:hover { color: var(--accent); }
  .add small { color: var(--faint); font-size: 11px; text-align: center; }
  .empty { container-type: size; overflow: hidden; }
  @container (max-width: 230px) { .add small { display: none; } .add { padding: 8px; } .quick { margin-top: 0; padding-bottom: 8px; } }
  @container (max-height: 150px) { .add small { display: none; } .quick { margin-top: -6px; } }
  .quick { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; margin-top: -14px; padding: 0 12px 14px; }
  .qchip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 12px; border: 1px solid var(--border-strong); color: var(--muted); font-size: 11.5px; }
  .qchip:hover { color: var(--text); border-color: var(--accent); }
  .qchip.auto { border-style: dashed; }
  .qd { width: 8px; height: 8px; border-radius: 50%; }
  .split { position: absolute; z-index: 10; background: transparent; }
  .split.v { top: 0; bottom: 0; width: 8px; cursor: col-resize; }
  .split.h { left: 0; right: 0; height: 8px; cursor: row-resize; }
  .split:hover, .dragging .split:active { background: color-mix(in srgb, var(--accent) 45%, transparent); }
</style>
