<script lang="ts">
  // Cajón lateral del explorador de archivos por SFTP de un host guardado. Los nombres del servidor se pintan como texto
  // (nunca como HTML). Las transferencias viven en files.svelte.ts y siguen aunque se cierre el cajón.
  import { tick, untrack } from 'svelte';
  import { fly } from 'svelte/transition';
  import { app } from '../lib/store.svelte.ts';
  import { files, DROP_ID } from '../lib/files.svelte.ts';
  import * as sb from '../lib/sftpbackend.ts';
  import { inTauri } from '../lib/backend.ts';
  import { t } from '../lib/i18n.ts';
  import {
    crumbs, errorKey, filterEntries, fmtDate, fmtPerm, fmtSize, joinPath, localBase, parentPath, pct, resolveClash, sftpDest, shellQuote,
    sortEntries, validName,
  } from '../lib/sftp.ts';
  import type { Clash, Entry, SortKey, Transfer } from '../lib/sftp.ts';
  import Icon from './Icon.svelte';

  const dur = (ms: number) => (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms);

  const view = $derived(files.view);
  const host = $derived(view ? files.host(view.hostId) : undefined);

  let path = $state('');
  let pathInput = $state('');
  let entries = $state<Entry[]>([]);
  let loading = $state(false);
  let error = $state<{ key: ReturnType<typeof errorKey>['key']; detail: string } | null>(null);
  let query = $state('');
  let showHidden = $state(false);
  let sortKey = $state<SortKey>('name');
  let sortDesc = $state(false);
  let selected = $state<Set<string>>(new Set());
  let anchor = $state<string | null>(null);
  let renaming = $state<string | null>(null);
  let renameText = $state('');
  let creating = $state(false);
  let newName = $state('');
  let confirmDel = $state<string[] | null>(null);
  let busy = $state(false);
  let clash = $state<{ name: string; left: number; resolve: (r: { choice: Clash; all: boolean }) => void } | null>(null);
  let clashAll = $state(false);
  let dragOver = $state(false);
  let opMsg = $state<string | null>(null);
  let panel = $state<HTMLElement>();
  let listEl = $state<HTMLDivElement>();
  let token = 0;

  const shown = $derived(sortEntries(filterEntries(entries, query, showHidden), sortKey, sortDesc));
  const sel = $derived(shown.filter((e) => selected.has(e.name)));
  const selFiles = $derived(sel.filter((e) => !e.isDir));
  const pane = $derived(view?.paneId ? app.paneById(view.paneId) : undefined);
  const active = $derived(files.items.filter((x) => x.state === 'run' || x.state === 'queued').length);
  const finished = $derived(files.items.length - active);

  async function load(p: string, keepSel = false): Promise<void> {
    const h = host;
    if (!h) return;
    const my = ++token;
    loading = true;
    try {
      const l = await sb.sftpList(sftpDest(h), p);
      if (my !== token) return;
      path = l.path; pathInput = l.path; entries = l.entries; error = null;
      if (!keepSel) { selected = new Set(); anchor = null; }
      else selected = new Set([...selected].filter((n) => l.entries.some((e) => e.name === n)));
    } catch (e) {
      if (my !== token) return;
      error = errorKey(String(e));
      pathInput = path || p;
    } finally {
      if (my === token) loading = false;
    }
  }

  // Al abrir (o cambiar de host): empieza en la carpeta del panel si se conoce; si no, en el home remoto.
  $effect(() => {
    const v = files.view;
    if (!v) return;
    untrack(() => {
      path = ''; pathInput = ''; entries = []; error = null; query = ''; selected = new Set(); renaming = null; creating = false; confirmDel = null; opMsg = null;
      void load(v.start ?? '').then(() => { if (error && v.start) void load(''); });
    });
    files.onDrop = (paths) => void uploadPaths(paths);
    void tick().then(() => panel?.focus());
    return () => { files.onDrop = null; };
  });

  // Recarga si acaba una subida a la carpeta que se ve.
  $effect(() => {
    const c = files.changed;
    untrack(() => { if (c.n && view && c.hostId === view.hostId && c.dir === path) void load(path, true); });
  });

  function close() { files.close(); }

  function go(p: string) { if (p.trim()) void load(p.trim()); }

  function open(e: Entry) {
    if (e.isDir) go(joinPath(path, e.name));
    else if (host) void files.download(host, joinPath(path, e.name), e.name);
  }

  function click(ev: MouseEvent, e: Entry) {
    if (renaming) return;
    const s = new Set(ev.ctrlKey || ev.metaKey ? selected : []);
    if (ev.shiftKey && anchor) {
      const a = shown.findIndex((x) => x.name === anchor), b = shown.findIndex((x) => x.name === e.name);
      if (a >= 0 && b >= 0) for (const x of shown.slice(Math.min(a, b), Math.max(a, b) + 1)) s.add(x.name);
    } else if ((ev.ctrlKey || ev.metaKey) && s.has(e.name)) s.delete(e.name);
    else { s.add(e.name); anchor = e.name; }
    selected = s;
  }

  function setSort(k: SortKey) {
    if (sortKey === k) sortDesc = !sortDesc;
    else { sortKey = k; sortDesc = k !== 'name'; }
  }

  async function op(fn: () => Promise<unknown>, after?: () => void): Promise<boolean> {
    busy = true; opMsg = null;
    try {
      await fn();
      after?.();
      await load(path, true);
      return true;
    } catch (e) {
      const k = errorKey(String(e));
      opMsg = t(k.key, { detail: k.detail });
      return false;
    } finally { busy = false; }
  }

  function startRename() {
    if (sel.length !== 1) return;
    renaming = sel[0].name; renameText = sel[0].name;
    void tick().then(() => { const i = listEl?.querySelector<HTMLInputElement>('input.ren'); if (i) { i.focus(); const dot = renameText.lastIndexOf('.'); i.setSelectionRange(0, dot > 0 && !sel[0]?.isDir ? dot : renameText.length); } });
  }

  async function commitRename() {
    const from = renaming, to = renameText.trim();
    if (!from || !host) return;
    if (to === from || !to) { renaming = null; return; }
    if (!validName(to)) { opMsg = t('files.badName'); return; }
    const d = sftpDest(host);
    if (await op(() => sb.sftpRename(d, path, from, to))) { renaming = null; selected = new Set([to]); }
  }

  function startNew() {
    creating = true; newName = '';
    void tick().then(() => listEl?.querySelector<HTMLInputElement>('input.newdir')?.focus());
  }

  async function commitNew() {
    const n = newName.trim();
    if (!n) { creating = false; return; }
    if (!validName(n) || !host) { opMsg = t('files.badName'); return; }
    const d = sftpDest(host);
    if (await op(() => sb.sftpMkdir(d, path, n))) { creating = false; selected = new Set([n]); }
  }

  async function doDelete() {
    const names = confirmDel;
    if (!names?.length || !host) return;
    const d = sftpDest(host);
    if (await op(() => sb.sftpRemove(d, path, names))) confirmDel = null;
  }

  function downloadSel() { if (host) for (const e of selFiles) void files.download(host, joinPath(path, e.name), e.name); }

  function remotePaths(): string[] { return (sel.length ? sel.map((e) => joinPath(path, e.name)) : [path]); }

  function copyPaths() { void files.copyPath(remotePaths().join('\n')); }

  function pastePaths() { if (pane) files.pasteToPane(pane.id, remotePaths().map(shellQuote).join(' ') + ' '); }

  function askClash(name: string, left: number): Promise<{ choice: Clash; all: boolean }> {
    clashAll = false;
    return new Promise((resolve) => { clash = { name, left, resolve }; });
  }

  function answerClash(choice: Clash) {
    const c = clash;
    clash = null;
    c?.resolve({ choice, all: clashAll });
  }

  /** Sube rutas locales (archivos o carpetas) a la carpeta que se ve, preguntando si ya existe. */
  async function uploadPaths(paths: string[]) {
    const h = host;
    if (!h || !path || !paths.length) return;
    const dir = path;
    const taken = new Set(entries.map((e) => e.name));
    let all: Clash | null = null;
    for (let i = 0; i < paths.length; i++) {
      const name = localBase(paths[i]);
      if (!validName(name)) continue;
      const exists = taken.has(name);
      let choice: Clash | null = all;
      if (exists && !choice) {
        const r = await askClash(name, paths.length - i - 1);
        choice = r.choice;
        if (r.all) all = r.choice;
      }
      const res = resolveClash(name, exists, choice, taken);
      if (!res) continue;
      taken.add(res.name);
      files.upload(h, paths[i], dir, res.name, res.overwrite);
    }
  }

  async function pickUpload() { const p = await sb.sftpPick(false); if (p.length) void uploadPaths(p); }

  // ---------- arrastrar desde el Explorador ----------
  const external = (ev: DragEvent) => { const ty = ev.dataTransfer?.types ?? []; return ty.includes('Files') && !ty.some((x) => x.startsWith('application/x-orchestra-')); };
  function onDragOver(ev: DragEvent) {
    if (!external(ev) || !path) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    dragOver = true;
  }
  function onDragLeave(ev: DragEvent) { if (!panel?.contains(ev.relatedTarget as Node)) dragOver = false; }
  function onDrop(ev: DragEvent) {
    dragOver = false;
    if (!external(ev) || !ev.dataTransfer?.files.length) return;
    ev.preventDefault();
    ev.stopPropagation();
    const wv = (window as unknown as { chrome?: { webview?: { postMessageWithAdditionalObjects?(m: string, f: FileList): void } } }).chrome?.webview;
    if (wv?.postMessageWithAdditionalObjects) wv.postMessageWithAdditionalObjects(`orchestra-drop:${DROP_ID}`, ev.dataTransfer.files);
    else if (!inTauri) void uploadPaths([...ev.dataTransfer.files].map((f) => `C:\\demo\\${f.name}`)); // demo del navegador
    else files.say(t('imagepaste.noDrop'), undefined, true);
  }

  function onListKey(ev: KeyboardEvent) {
    if (renaming || creating || (ev.target as HTMLElement)?.tagName === 'INPUT') return;
    if (ev.key === 'F2') { ev.preventDefault(); startRename(); }
    else if (ev.key === 'Delete' && sel.length) { ev.preventDefault(); confirmDel = sel.map((e) => e.name); }
    else if (ev.key === 'Enter' && sel.length === 1) { ev.preventDefault(); open(sel[0]); }
    else if (ev.key === 'Backspace') { ev.preventDefault(); go(parentPath(path)); }
    else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') { ev.preventDefault(); selected = new Set(shown.map((e) => e.name)); }
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const i = shown.findIndex((e) => e.name === anchor);
      const j = Math.max(0, Math.min(shown.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)));
      if (shown[j]) { selected = new Set([shown[j].name]); anchor = shown[j].name; listEl?.querySelector(`[data-i="${j}"]`)?.scrollIntoView({ block: 'nearest' }); }
    }
  }

  function onWindowKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !files.view) return;
    if ((e.target as HTMLElement)?.closest?.('.xterm')) return;
    if (app.settingsOpen || app.hostDialog || app.accountDialog || app.paletteOpen || app.hostKeyPrompt) return;
    e.preventDefault();
    if (clash) answerClash('skip');
    else if (confirmDel) confirmDel = null;
    else if (renaming) renaming = null;
    else if (creating) creating = false;
    else close();
  }

  const speed = (b: number) => (b > 0 ? `${fmtSize(Math.round(b))}/s` : '');
  const runText = (x: Transfer) => [`${fmtSize(x.done)} / ${fmtSize(x.total)}`, `${pct(x)}%`, speed(x.speed)].filter(Boolean).join(' · ');
</script>

<svelte:window onkeydown={onWindowKey} />

{#if view && host}
  <aside class="drawer" bind:this={panel} tabindex="-1" aria-label={t('files.aria', { host: host.name })} transition:fly={{ x: 520, duration: dur(180) }}
    ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop}>
    <header>
      <div class="top">
        <Icon name="folder" size={14} />
        <span class="hn" title={`${host.user ? host.user + '@' : ''}${host.host}`}>{host.name}</span>
        <span class="proto">SFTP</span>
        <span class="sp"></span>
        <button class="ib" class:on={showHidden} aria-pressed={showHidden} title={t('files.hidden')} aria-label={t('files.hidden')} onclick={() => (showHidden = !showHidden)}><Icon name="eye" size={13} /></button>
        <button class="ib" title={t('files.close')} aria-label={t('files.close')} onclick={close}><Icon name="x" size={13} /></button>
      </div>
      <div class="nav">
        <button class="ib" title={t('files.up')} aria-label={t('files.up')} disabled={!path || path === '/'} onclick={() => go(parentPath(path))}><Icon name="up" size={13} /></button>
        <button class="ib" class:spin={loading} title={t('files.refresh')} aria-label={t('files.refresh')} onclick={() => void load(path || '', true)}><Icon name="refresh" size={13} /></button>
        <input class="path" spellcheck="false" aria-label={t('files.path')} bind:value={pathInput} onkeydown={(e) => { if (e.key === 'Enter') go(pathInput); }} />
      </div>
      <nav class="crumbs" aria-label={t('files.path')}>
        {#each crumbs(path) as c, i (c.path)}
          {#if i > 1}<span class="sep">/</span>{/if}
          <button class="crumb" class:last={c.path === path} onclick={() => go(c.path)}>{c.label}</button>
        {/each}
      </nav>
      <div class="tools">
        <div class="filter"><Icon name="search" size={12} /><input placeholder={t('files.filter')} aria-label={t('files.filter')} bind:value={query} /></div>
        <button class="tb" title={t('files.uploadTitle')} disabled={!path} onclick={pickUpload}><Icon name="upload" size={13} />{t('files.upload')}</button>
        <button class="ib" title={t('files.newFolder')} aria-label={t('files.newFolder')} disabled={!path} onclick={startNew}><Icon name="folderplus" size={13} /></button>
      </div>
      <!-- Siempre visible (aunque no haya selección): si apareciera al seleccionar, la lista saltaría bajo el ratón. -->
      <div class="selbar">
        <span class="cnt" class:none={!sel.length}>{sel.length === 1 ? t('files.selectedOne') : sel.length ? t('files.selected', { n: sel.length }) : t('files.noneSelected')}</span>
        <span class="sp"></span>
        <button class="ib" title={t('files.download')} aria-label={t('files.download')} disabled={!selFiles.length} onclick={downloadSel}><Icon name="download" size={13} /></button>
        <button class="ib" title={t('files.rename')} aria-label={t('files.rename')} disabled={sel.length !== 1} onclick={startRename}><Icon name="edit" size={13} /></button>
        <button class="ib" title={t('files.copyPath')} aria-label={t('files.copyPath')} disabled={!path} onclick={copyPaths}><Icon name="copy" size={13} /></button>
        {#if pane}<button class="ib" title={t('files.pastePath')} aria-label={t('files.pastePath')} disabled={!path} onclick={pastePaths}><Icon name="terminal" size={13} /></button>{/if}
        <button class="ib danger" title={t('files.delete')} aria-label={t('files.delete')} disabled={!sel.length} onclick={() => (confirmDel = sel.map((e) => e.name))}><Icon name="trash" size={13} /></button>
      </div>
    </header>

    <div class="cols" role="row">
      <button class="c-name" onclick={() => setSort('name')}>{t('files.col.name')}{sortKey === 'name' ? (sortDesc ? ' ↓' : ' ↑') : ''}</button>
      <button class="c-size" onclick={() => setSort('size')}>{t('files.col.size')}{sortKey === 'size' ? (sortDesc ? ' ↓' : ' ↑') : ''}</button>
      <button class="c-date" onclick={() => setSort('mtime')}>{t('files.col.date')}{sortKey === 'mtime' ? (sortDesc ? ' ↓' : ' ↑') : ''}</button>
      <span class="c-perm">{t('files.col.perm')}</span>
    </div>

    <div class="list" bind:this={listEl} tabindex="0" role="listbox" aria-multiselectable="true" aria-label={t('files.aria', { host: host.name })} onkeydown={onListKey}>
      {#if creating}
        <div class="row editing">
          <span class="ic dir"><Icon name="folder" size={14} /></span>
          <input class="newdir" placeholder={t('files.newFolderName')} bind:value={newName} onkeydown={(e) => { if (e.key === 'Enter') void commitNew(); else if (e.key === 'Escape') { e.stopPropagation(); creating = false; } }} onblur={() => { if (!busy && !newName.trim()) creating = false; }} />
        </div>
      {/if}
      {#if error}
        <div class="err">
          <b>{t(error.key, { detail: error.detail })}</b>
          {#if error.key === 'files.err.hostkey' || error.key === 'files.err.auth'}
            <small>{t('files.hostkeyHint')}</small>
            <button class="btn" onclick={() => { app.open({ kind: 'host', id: host.id }); close(); }}>{t('files.openTerminal')}</button>
          {:else}
            <button class="btn" onclick={() => void load(pathInput || path || '')}>{t('files.retry')}</button>
          {/if}
        </div>
      {:else if loading && !entries.length}
        <div class="note">{t('files.loading')}</div>
      {:else if !shown.length && !creating}
        <div class="note">{query ? t('files.noMatch') : t('files.empty')}</div>
      {/if}
      {#each shown as e, i (e.name)}
        <div class="row" class:sel={selected.has(e.name)} data-i={i} role="option" aria-selected={selected.has(e.name)} tabindex="-1"
          onclick={(ev) => click(ev, e)} ondblclick={() => open(e)} onkeydown={() => {}}>
          <span class="ic" class:dir={e.isDir}><Icon name={e.isDir ? 'folder' : 'file'} size={14} /></span>
          {#if renaming === e.name}
            <input class="ren" bind:value={renameText} onkeydown={(k) => { if (k.key === 'Enter') void commitRename(); else if (k.key === 'Escape') { k.stopPropagation(); renaming = null; } }} onblur={() => { if (!busy) renaming = null; }} />
          {:else}
            <span class="nm" title={e.name}>{e.name}{#if e.isLink}<span class="lnk">↗</span>{/if}</span>
          {/if}
          <span class="sz">{e.isDir ? '' : fmtSize(e.size)}</span>
          <span class="dt">{fmtDate(e.mtime)}</span>
          <span class="pm">{fmtPerm(e.perm)}</span>
        </div>
      {/each}
    </div>
    {#if opMsg}<div class="opmsg" role="alert">{opMsg}<button class="ib" aria-label={t('files.close')} onclick={() => (opMsg = null)}><Icon name="x" size={11} /></button></div>{/if}

    {#if files.items.length}
      <section class="queue" aria-label={t('files.queue')}>
        <div class="qh">
          <b>{t('files.queue')}</b>
          {#if active}<span class="qs">{t('files.active', { n: active })}</span>{/if}
          <span class="sp"></span>
          {#if finished}<button class="lnkbtn" onclick={() => files.clearFinished()}>{t('files.clear')}</button>{/if}
        </div>
        <div class="qlist">
          {#each [...files.items].reverse() as x (x.id)}
            <div class="qi {x.state}">
              <div class="ql">
                <Icon name={x.dir === 'up' ? 'upload' : 'download'} size={12} />
                <span class="qn" title={x.name}>{x.name}</span>
                {#if x.hostId !== view.hostId}<span class="qhost">{x.hostName}</span>{/if}
                <span class="sp"></span>
                {#if x.state === 'run' || x.state === 'queued'}
                  <button class="ib" title={t('files.cancel')} aria-label={t('files.cancel')} onclick={() => files.cancel(x.id)}><Icon name="x" size={11} /></button>
                {:else if x.state === 'error' || x.state === 'cancelled'}
                  <button class="ib" title={t('files.retry')} aria-label={t('files.retry')} onclick={() => files.retry(x.id)}><Icon name="refresh" size={11} /></button>
                {:else if x.state === 'done' && x.path}
                  <button class="lnkbtn" onclick={() => void sb.sftpReveal(x.path!)}>{t('files.openFolder')}</button>
                {/if}
              </div>
              {#if x.state === 'run' || x.state === 'queued'}
                <div class="bar"><span style="width: {pct(x)}%"></span></div>
                <div class="qm">
                  {x.state === 'queued' ? t('files.queued') : runText(x)}
                </div>
              {:else if x.state === 'error'}
                {@const k = errorKey(x.error ?? '')}
                <div class="qm bad">{t(k.key, { detail: k.detail })}</div>
              {:else if x.state === 'cancelled'}
                <div class="qm">{t('files.cancelled')}</div>
              {:else}
                <div class="qm ok">{[t('files.done', { size: fmtSize(x.total) }), speed(x.speed)].filter(Boolean).join(' · ')}</div>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/if}

    {#if dragOver}
      <div class="dropzone"><Icon name="upload" size={22} /><b>{t('files.dropHere')}</b><small>{path}</small></div>
    {/if}

    {#if confirmDel}
      <div class="modal-in" role="dialog" aria-modal="true" aria-label={t('files.delete')}>
        <div class="box">
          <b>{confirmDel.length === 1 ? t('files.delOne', { name: confirmDel[0] }) : t('files.delMany', { n: confirmDel.length })}</b>
          <small>{t('files.delHint')}</small>
          <div class="btns">
            <button class="btn ghost" onclick={() => (confirmDel = null)}>{t('files.cancel')}</button>
            <button class="btn danger" disabled={busy} onclick={doDelete}>{t('files.delete')}</button>
          </div>
        </div>
      </div>
    {/if}

    {#if clash}
      <div class="modal-in" role="dialog" aria-modal="true" aria-label={t('files.clashTitle')}>
        <div class="box">
          <b>{t('files.clashTitle')}</b>
          <small>{t('files.clashBody', { name: clash.name, dir: path })}</small>
          {#if clash.left > 0}
            <label class="chk"><input type="checkbox" bind:checked={clashAll} />{t('files.clashAll', { n: clash.left })}</label>
          {/if}
          <div class="btns">
            <button class="btn ghost" onclick={() => answerClash('skip')}>{t('files.skip')}</button>
            <button class="btn" onclick={() => answerClash('rename')}>{t('files.keepBoth')}</button>
            <button class="btn primary" onclick={() => answerClash('overwrite')}>{t('files.overwrite')}</button>
          </div>
        </div>
      </div>
    {/if}
  </aside>
{/if}

{#if files.notice}
  <div class="notice" class:bad={files.notice.bad} role="status">
    <span>{files.notice.text}</span>
    {#if files.notice.path}<button class="lnkbtn" onclick={() => { void sb.sftpReveal(files.notice!.path!); files.notice = null; }}>{t('files.openFolder')}</button>{/if}
    <button class="ib" aria-label={t('files.close')} onclick={() => (files.notice = null)}><Icon name="x" size={11} /></button>
  </div>
{/if}

<style>
  .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(520px, 100vw); z-index: 50; display: flex; flex-direction: column; background: var(--panel); border-left: 1px solid var(--border-strong); box-shadow: -14px 0 40px rgba(0, 0, 0, 0.45); outline: none; }
  header { padding: 8px 10px 6px 12px; border-bottom: 1px solid var(--border); display: grid; gap: 6px; flex: none; }
  .top, .nav, .tools, .selbar, .ql, .qh { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .top { color: var(--accent); }
  .sp { flex: 1; }
  .hn { color: var(--text); font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proto { font-size: 10px; color: var(--faint); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; }
  .ib { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 5px; color: var(--muted); flex: none; }
  .ib:hover:not(:disabled) { background: var(--raise); color: var(--text); }
  .ib:disabled { opacity: 0.35; cursor: default; }
  .ib.on { color: var(--accent); background: var(--accent-soft); }
  .ib.danger:hover { color: var(--bad); }
  .ib.spin :global(svg) { animation: orch-files-spin 0.9s linear infinite; }
  @keyframes orch-files-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .ib.spin :global(svg) { animation: none; } }
  .path { flex: 1; min-width: 0; font-family: var(--mono, ui-monospace, Consolas, monospace); font-size: 11.5px; padding: 4px 7px; }
  .crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 1px; font-size: 11.5px; min-height: 18px; }
  .crumb { color: var(--muted); padding: 0 3px; border-radius: 4px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .crumb:hover { color: var(--text); background: var(--raise); }
  .crumb.last { color: var(--text); font-weight: 600; }
  .sep { color: var(--faint); }
  .filter { flex: 1; display: flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: 6px; padding: 0 7px; color: var(--faint); min-width: 0; }
  .filter input { border: none; background: none; padding: 4px 0; flex: 1; min-width: 0; font-size: 12px; }
  .tb { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 4px 9px; border-radius: 6px; background: var(--accent-soft); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); flex: none; }
  .tb:hover:not(:disabled) { filter: brightness(1.15); }
  .tb:disabled { opacity: 0.4; }
  .selbar { background: var(--raise); border-radius: 6px; padding: 2px 4px 2px 9px; }
  .cnt { font-size: 11.5px; color: var(--muted); }
  .cnt.none { color: var(--faint); }
  .cols { display: grid; grid-template-columns: 1fr 72px 112px 82px; gap: 8px; padding: 4px 12px 4px 34px; border-bottom: 1px solid var(--border); flex: none; font-size: 10.5px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint); }
  .cols button { text-align: left; color: inherit; text-transform: inherit; letter-spacing: inherit; font-size: inherit; padding: 0; }
  .cols button:hover { color: var(--text); }
  .cols .c-size { text-align: right; }
  .list { flex: 1; min-height: 0; overflow-y: auto; padding: 3px 0 8px; outline: none; }
  .row { display: grid; grid-template-columns: 16px 1fr 72px 112px 82px; gap: 8px; align-items: center; padding: 3px 12px; font-size: 12.5px; cursor: default; user-select: none; }
  .row:hover { background: color-mix(in srgb, var(--raise) 70%, transparent); }
  .row.sel { background: var(--accent-soft); }
  .row.editing { grid-template-columns: 16px 1fr; }
  .ic { color: var(--faint); display: grid; place-items: center; }
  .ic.dir { color: var(--info); }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
  .lnk { color: var(--faint); margin-left: 4px; font-size: 10px; }
  .sz, .dt, .pm { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
  .sz { text-align: right; }
  .pm { font-family: var(--mono, ui-monospace, Consolas, monospace); font-size: 10.5px; color: var(--faint); }
  .ren, .newdir { font-size: 12.5px; padding: 1px 5px; min-width: 0; }
  .note { color: var(--faint); font-size: 12px; text-align: center; padding: 18px 0; }
  .err { margin: 16px 14px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--bad) 45%, transparent); border-radius: 8px; display: grid; gap: 6px; justify-items: start; font-size: 12.5px; }
  .err b { color: var(--bad); font-weight: 600; overflow-wrap: anywhere; }
  .err small { color: var(--muted); }
  .opmsg { display: flex; align-items: center; gap: 6px; margin: 0 10px 6px; padding: 5px 4px 5px 10px; border-radius: 6px; background: color-mix(in srgb, var(--bad) 16%, transparent); color: #ffc2c6; font-size: 12px; flex: none; }
  .opmsg .ib { margin-left: auto; }
  .queue { border-top: 1px solid var(--border-strong); flex: none; max-height: 38vh; display: flex; flex-direction: column; background: color-mix(in srgb, var(--bg) 40%, var(--panel)); }
  .qh { padding: 6px 12px; font-size: 11.5px; }
  .qh b { font-weight: 600; color: var(--text); }
  .qs { color: var(--accent); }
  .qlist { overflow-y: auto; padding: 0 8px 8px; display: grid; gap: 4px; }
  .qi { padding: 5px 6px 6px; border-radius: 6px; background: var(--raise); font-size: 12px; display: grid; gap: 4px; }
  .ql { color: var(--muted); }
  .qi.run .ql { color: var(--accent); }
  .qi.error .ql { color: var(--bad); }
  .qi.done .ql { color: var(--ok); }
  .qn { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .qhost { font-size: 10px; color: var(--faint); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; flex: none; }
  .qi .ib { width: 20px; height: 20px; }
  .bar { height: 4px; border-radius: 3px; background: var(--border); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--accent); transition: width 0.15s linear; }
  .qm { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .qm.bad { color: #ffc2c6; }
  .qm.ok { color: var(--muted); }
  .lnkbtn { color: var(--info); font-size: 11.5px; padding: 0 2px; flex: none; }
  .lnkbtn:hover { text-decoration: underline; }
  .dropzone { position: absolute; inset: 8px; border: 2px dashed var(--accent); border-radius: 10px; background: color-mix(in srgb, var(--panel) 82%, transparent); display: grid; place-content: center; justify-items: center; gap: 6px; color: var(--accent); pointer-events: none; z-index: 3; }
  .dropzone small { color: var(--muted); font-family: var(--mono, ui-monospace, Consolas, monospace); }
  .modal-in { position: absolute; inset: 0; background: rgba(5, 6, 8, 0.55); display: grid; place-items: center; z-index: 4; padding: 16px; }
  .box { width: min(400px, 100%); background: var(--panel); border: 1px solid var(--border-strong); border-radius: 10px; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55); padding: 14px 16px 12px; display: grid; gap: 8px; }
  .box b { font-size: 13.5px; overflow-wrap: anywhere; }
  .box small { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .chk { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--muted); }
  .btns { display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px; }
  .btn.danger { background: var(--bad); border-color: var(--bad); color: #1a0a0b; font-weight: 600; }
  .notice { position: fixed; right: 16px; bottom: 34px; z-index: 60; display: flex; align-items: center; gap: 8px; max-width: min(460px, 90vw); padding: 7px 6px 7px 12px; border-radius: 8px; background: var(--panel); border: 1px solid var(--border-strong); box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5); font-size: 12.5px; color: var(--text); }
  .notice.bad { border-color: color-mix(in srgb, var(--bad) 55%, transparent); }
  .notice span { overflow-wrap: anywhere; }
</style>
