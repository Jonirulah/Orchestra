<script lang="ts">
  import { app, type OpenReq } from '../lib/store.svelte.ts';
  import { slide, fly } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';
  import AgentTree from './AgentTree.svelte';
  import NeedsAttention from './NeedsAttention.svelte';
  import UsageBars from './UsageBars.svelte';
  import { POLICIES } from '../lib/policy.ts';
  import { PROVIDERS, accountTitle, providerOf } from '../lib/model.ts';
  import { buildAccountView, effectiveFilter, providerCounts } from '../lib/accountview.ts';
  import type { AccountsFilter } from '../lib/accountview.ts';
  import type { Account } from '../lib/model.ts';
  import { statusLabel } from '../lib/providers.ts';
  import { t, tk } from '../lib/i18n.ts';
  import { ctxmenu } from '../lib/ctxmenu.svelte.ts';
  import { files } from '../lib/files.svelte.ts';
  import { forwards } from '../lib/forwards.svelte.ts';
  import { isMenuKey } from '../lib/ctxmenu.ts';
  import { accountsViewMenu, hostFolderMenu, hostMenu, hostsViewMenu, sidebarMenu } from '../lib/ctxitems.ts';
  import { UNGROUPED, buildHostView, canStepHost, folderOf, folderOrder } from '../lib/hostview.ts';
  import type { Host } from '../lib/model.ts';
  import { accountMenuFor } from '../lib/ctxaccount.ts';

  let quick = $state('');
  let armedClose = $state<string | null>(null);
  let closeTimer = 0;
  /** Cierra un panel de segundo plano; con «confirmar al cerrar» hace falta un segundo clic (igual que en el resto de botones de cierre). */
  function closeParked(id: string) {
    if (armedClose === id || !app.settings.confirmClose) { armedClose = null; app.closePane(id); return; }
    armedClose = id;
    clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => (armedClose = null), 2200);
  }
  let collapsed = $state<Record<string, boolean>>({});
  /** Duración de una animación; 0 si el sistema pide reducir el movimiento. */
  const dur = (ms: number) => (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms);

  const q = $derived(app.filter.trim().toLowerCase());
  const match = (...s: (string | undefined)[]) => !q || s.some((x) => x?.toLowerCase().includes(q));

  // Hosts por carpetas, con el orden elegido (hostview.ts, puro). Con texto en el filtro solo salen las carpetas con resultados.
  const hostView = $derived(buildHostView(app.hosts, {
    sort: app.settings.hostsSort, folders: app.settings.hostFolders, collapsed: app.settings.hostFoldersCollapsed, text: q,
  }));
  const anyHost = $derived(hostView.some((f) => f.hosts.length || f.name));
  /** Carpetas con nombre en el orden en que se ven (para Subir/Bajar y para soltar carpetas). */
  const shownFolders = $derived(hostView.filter((f) => f.name).map((f) => f.name));
  /** «Sin carpeta» lleva cabecera solo si hay carpetas con nombre (si no, la lista es plana como antes). */
  const hasNamed = $derived(shownFolders.length > 0);
  const cfgHosts = $derived(app.sshConfig.filter((h) => match(h.alias, h.hostname, h.user)));
  // Vista de las cuentas: filtro por proveedor + agrupar + orden (accountview.ts, puro). `app.accounts` no se toca.
  const counts = $derived(providerCounts(app.accounts));
  const provList = $derived(PROVIDERS.filter((p) => counts[p] > 0));
  const filterEff = $derived(effectiveFilter(app.settings.accountsFilter, app.accounts));
  /** Con la vista MCP abierta, la cuenta bajo el ratón / el foco resalta su columna. */
  const mcpHover = (id: string | null) => { if (app.mcpOpen || id === null) app.mcpHover = id; };
  const sections = $derived(buildAccountView(
    app.accounts,
    { filter: app.settings.accountsFilter, sort: app.settings.accountsSort, group: app.settings.accountsGroup },
    { quota: app.quota, now: app.nowSec, text: q, emailOf: (a) => app.profileOf(a)?.email, hasDefaultCodex: app.hasDefaultAccount('codex') },
  ));
  /** El botón se resalta cuando la vista no es la de siempre (orden o filtro cambiados). */
  const viewCustom = $derived(app.settings.accountsSort !== 'manual' || filterEff !== 'all');
  const setFilter = (f: AccountsFilter) => app.setting('accountsFilter', f);
  function openViewMenu(ev: MouseEvent) {
    ctxmenu.openBelow(ev.currentTarget as HTMLElement, accountsViewMenu({
      filter: filterEff, sort: app.settings.accountsSort, group: app.settings.accountsGroup, counts,
      setSort: (v) => app.setting('accountsSort', v),
      setGroup: (v) => app.setting('accountsGroup', v),
      setFilter,
    }));
  }
  /** Qué se abre al pulsar o arrastrar una cuenta: las de Claude como siempre (con su reanudación), el resto por proveedor. */
  const reqOf = (a: Account): OpenReq => (providerOf(a) === 'claude' ? { kind: 'claude', accountId: a.id } : { kind: 'account', accountId: a.id });
  const shells = $derived(app.shells.filter((s) => match(s.name)));
  const parked = $derived(app.active.panes.filter((p) => p.parked));

  function dragStart(ev: DragEvent, req: OpenReq) {
    ev.dataTransfer?.setData('application/x-orchestra-open', JSON.stringify(req));
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
  }

  function submitQuick(ev: KeyboardEvent) {
    if (ev.key !== 'Enter' || !quick.trim()) return;
    app.open({ kind: 'quick', text: quick });
    quick = '';
  }
  const toggle = (k: string) => (collapsed[k] = !collapsed[k]);

  // Menú de la sección SSH: orden, nueva carpeta, importar / exportar
  const importable = $derived(
    app.sshConfig.filter((c) => !app.hosts.some((h) => h.name.toLowerCase() === c.alias.toLowerCase())).length,
  );
  function doImport() { app.importSshConfig(); }
  function doExport() { void app.exportHosts(); }
  function openSshMenu(ev: MouseEvent) {
    ctxmenu.openBelow(ev.currentTarget as HTMLElement, hostsViewMenu({
      sort: app.settings.hostsSort, importable, hostCount: app.hosts.length,
      setSort: (v) => app.setting('hostsSort', v),
      newFolder: () => startFolderRename(app.newHostFolder()),
      importHosts: doImport, exportHosts: doExport,
    }));
  }

  // ---------- hosts: carpetas, arrastrar y teclado ----------
  /** Con texto en el filtro no se reordena (la lista está recortada): arrastrar solo abre en la rejilla. */
  const reorderable = $derived(!q);
  type Drag = { kind: 'host'; id: string } | { kind: 'folder'; name: string };
  /** Dónde caerá: `mark` = fila o cabecera que pinta la raya; `after` = raya debajo (si no, encima). */
  type Drop = { kind: 'host'; folder: string; beforeId: string | null; mark: string; after: boolean }
    | { kind: 'folder'; before: string | null; mark: string; after: boolean };
  let drag = $state<Drag | null>(null);
  let drop = $state<Drop | null>(null);
  const lowerHalf = (ev: DragEvent) => { const r = (ev.currentTarget as HTMLElement).getBoundingClientRect(); return ev.clientY > r.top + r.height / 2; };

  function hostDragStart(ev: DragEvent, h: Host) {
    dragStart(ev, { kind: 'host', id: h.id }); // sigue sirviendo para abrirlo en la rejilla
    if (!reorderable || !ev.dataTransfer) return;
    ev.dataTransfer.setData('application/x-orchestra-host', h.id);
    ev.dataTransfer.effectAllowed = 'copyMove';
    drag = { kind: 'host', id: h.id };
  }
  function folderDragStart(ev: DragEvent, name: string) {
    if (!reorderable || !ev.dataTransfer) { ev.preventDefault(); return; }
    ev.dataTransfer.setData('application/x-orchestra-folder', name);
    ev.dataTransfer.effectAllowed = 'move';
    drag = { kind: 'folder', name };
  }
  function dragEnd() { drag = null; drop = null; }
  const accept = (ev: DragEvent) => { ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'; };

  /** Una carpeta arrastrada cae antes de `before` (null = al final); la raya se pinta encima de esa cabecera (o al final). */
  function folderDropBefore(before: string | null) {
    drop = { kind: 'folder', before, mark: before !== null ? `f:${before}` : hostView.some((f) => !f.name) ? 'f:' : 'f:end', after: false };
  }
  const nextFolder = (name: string): string | null => shownFolders[shownFolders.indexOf(name) + 1] ?? null;
  /** Sobre un host: el arrastrado cae antes (mitad de arriba) o después (mitad de abajo). Una carpeta sobre el cuerpo de otra cae detrás de esta. */
  function overHost(ev: DragEvent, folder: string, list: Host[], i: number) {
    if (drag?.kind === 'folder') { accept(ev); folderDropBefore(folder ? nextFolder(folder) : null); return; }
    if (drag?.kind !== 'host') return;
    accept(ev);
    const after = lowerHalf(ev);
    drop = { kind: 'host', folder, beforeId: after ? (list[i + 1]?.id ?? null) : list[i].id, mark: list[i].id, after };
  }
  /** Sobre la cabecera de una carpeta: un host cae al final de esa carpeta; una carpeta, antes o después de esta. */
  function overFolder(ev: DragEvent, name: string) {
    if (!drag) return;
    accept(ev);
    if (drag.kind === 'host') { drop = { kind: 'host', folder: name, beforeId: null, mark: `f:${name}`, after: false }; return; }
    if (name === UNGROUPED) { folderDropBefore(null); return; }
    folderDropBefore(lowerHalf(ev) ? nextFolder(name) : name);
  }
  function doDrop(ev: DragEvent) {
    const d = drag, to = drop;
    dragEnd();
    if (!d || !to) return;
    ev.preventDefault();
    if (d.kind === 'host' && to.kind === 'host') app.moveHostTo(d.id, to.folder, to.beforeId);
    else if (d.kind === 'folder' && to.kind === 'folder') app.moveHostFolder(d.name, to.before);
  }
  /** Al salir de la lista no se marca ningún sitio. */
  function leaveList(ev: DragEvent) {
    const to = ev.relatedTarget as Node | null;
    if (!to || !(ev.currentTarget as HTMLElement).contains(to)) drop = null;
  }
  const markOf = (key: string) => (drop && drop.mark === key ? (drop.after ? 'after' : 'before') : '');

  async function refocus(sel: string) { await tick(); (document.querySelector(sel) as HTMLElement | null)?.focus(); }
  const hostSel = (id: string) => `[data-host="${CSS.escape(id)}"]`;
  const folderSel = (name: string) => `[data-folder="${CSS.escape(name)}"]`;
  function stepHost(h: Host, dir: -1 | 1) { app.stepHost(h.id, dir); void refocus(hostSel(h.id)); }
  function stepFolder(name: string, dir: -1 | 1) { app.stepHostFolder(name, dir); void refocus(folderSel(name)); }
  /** Con A-Z, Subir/Bajar primero congela ese orden (siempre hay algo que hacer); con Manual, solo si no está en el extremo. */
  const canStep = (h: Host, dir: -1 | 1) => app.settings.hostsSort !== 'manual' || canStepHost(app.hosts, app.settings.hostFolders, h.id, dir);
  const editHost = (h: Host) => (app.hostDialog = { ...h, tags: [...h.tags] });

  function hostMenuFor(h: Host) {
    return hostMenu({
      folder: folderOf(h), folders: folderOrder(app.hosts, app.settings.hostFolders),
      canUp: reorderable && canStep(h, -1), canDown: reorderable && canStep(h, 1),
      connect: () => app.open({ kind: 'host', id: h.id }),
      files: () => void files.open(h.id),
      forward: () => forwards.openDialog(h.id),
      edit: () => editHost(h),
      up: () => stepHost(h, -1), down: () => stepHost(h, 1),
      moveTo: (f) => app.moveHostTo(h.id, f, null),
      moveToNew: () => { const f = app.newHostFolder(); app.moveHostTo(h.id, f, null); startFolderRename(f); },
      remove: () => app.deleteHost(h.id),
    });
  }
  function hostCtx(ev: MouseEvent, h: Host) { ctxmenu.openFromEvent(ev, hostMenuFor(h), ev.currentTarget as HTMLElement); }
  function hostKey(ev: KeyboardEvent, h: Host) {
    if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      ev.preventDefault();
      if (reorderable) stepHost(h, ev.key === 'ArrowUp' ? -1 : 1);
    } else if (isMenuKey(ev)) { ev.preventDefault(); ctxmenu.openBelow(ev.currentTarget as HTMLElement, hostMenuFor(h)); }
  }

  function folderMenuFor(name: string, collapsedNow: boolean) {
    const i = shownFolders.indexOf(name);
    const manual = app.settings.hostsSort === 'manual';
    return hostFolderMenu({
      collapsed: collapsedNow,
      canUp: reorderable && (!manual || i > 0), canDown: reorderable && (!manual || i < shownFolders.length - 1),
      toggle: () => app.toggleHostFolder(name),
      rename: () => startFolderRename(name),
      up: () => stepFolder(name, -1), down: () => stepFolder(name, 1),
      newFolder: () => startFolderRename(app.newHostFolder()),
      remove: () => app.deleteHostFolder(name),
    });
  }
  function folderCtx(ev: MouseEvent, name: string, c: boolean) { ctxmenu.openFromEvent(ev, folderMenuFor(name, c), ev.currentTarget as HTMLElement); }
  function folderKey(ev: KeyboardEvent, name: string, c: boolean) {
    if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      ev.preventDefault();
      if (reorderable) stepFolder(name, ev.key === 'ArrowUp' ? -1 : 1);
    } else if (ev.key === 'F2') { ev.preventDefault(); startFolderRename(name); }
    else if (isMenuKey(ev)) { ev.preventDefault(); ctxmenu.openBelow(ev.currentTarget as HTMLElement, folderMenuFor(name, c)); }
  }
  // Renombrar una carpeta en el sitio (como las cuentas: Enter guarda, Esc cancela).
  let renamingFolder = $state<string | null>(null);
  let folderRenameCancelled = false;
  function startFolderRename(name: string) { folderRenameCancelled = false; renamingFolder = name; }
  function finishFolderRename(name: string, ev: Event) {
    if (renamingFolder !== name) return;
    const v = (ev.currentTarget as HTMLInputElement).value;
    renamingFolder = null;
    if (!folderRenameCancelled) app.renameHostFolder(name, v);
    void refocus(folderSel(folderRenameCancelled ? name : v.trim() || name));
  }

  // ---------- menú contextual ----------
  let renaming = $state<string | null>(null);
  let renameCancelled = false;
  function startRename(id: string) { renameCancelled = false; renaming = id; }
  function finishRename(a: Account, ev: Event) {
    if (renaming !== a.id) return;
    const v = (ev.currentTarget as HTMLInputElement).value;
    renaming = null;
    if (!renameCancelled) app.renameAccount(a.id, v);
  }
  function renameKey(ev: KeyboardEvent) {
    ev.stopPropagation();
    if (ev.key === 'Enter') (ev.currentTarget as HTMLInputElement).blur();
    else if (ev.key === 'Escape') { renameCancelled = true; (ev.currentTarget as HTMLInputElement).blur(); }
  }
  function focusSelect(el: HTMLInputElement) { el.focus(); el.select(); }

  function accountCtx(ev: MouseEvent, a: Account) { ctxmenu.openFromEvent(ev, accountMenuFor(a, () => startRename(a.id), { renameHint: 'F2' }), ev.currentTarget as HTMLElement); }
  function accountKey(ev: KeyboardEvent, a: Account) {
    if (isMenuKey(ev)) { ev.preventDefault(); ctxmenu.openBelow(ev.currentTarget as HTMLElement, accountMenuFor(a, () => startRename(a.id), { renameHint: 'F2' })); }
    else if (ev.key === 'F2') { ev.preventDefault(); startRename(a.id); }
  }
  /** Clic derecho en un hueco de la barra (no sobre una fila, un botón ni un campo). */
  function sideCtx(ev: MouseEvent) {
    if ((ev.target as Element).closest?.('button, input, a, .item-wrap')) return;
    ctxmenu.openFromEvent(ev, sidebarMenu({
      addAccount: () => (app.accountDialog = true),
      newHost: () => app.newHost(),
      importable,
      importHosts: doImport,
      settings: () => (app.settingsOpen = true),
    }));
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside class="side" oncontextmenu={sideCtx}>
  <div class="brand">
    <span class="brandlogo"><Logo size={24} /></span>
    <b>Orchestra</b>
    <span class="grow"></span>
    <button class="iconbtn" title={t('sidebar.paletteTitle')} onclick={() => (app.paletteOpen = true)}><Icon name="search" /></button>
    <button class="iconbtn" title={t('sidebar.settingsTitle')} onclick={() => (app.settingsOpen = true)}><Icon name="gear" /></button>
  </div>

  <div class="inputs">
    <input placeholder={t('sidebar.filterPlaceholder')} bind:value={app.filter} />
    <input placeholder={t('sidebar.connectPlaceholder')} bind:value={quick} onkeydown={submitQuick} />
  </div>

  <div class="scroll">
    <!-- NECESITAN ATENCIÓN (solo si algún agente espera) -->
    <NeedsAttention />
    <!-- AGENTES ACTIVOS -->
    {#if app.agents.length}
      <div class="sec">
        <button class="sec-h" onclick={() => toggle('act')}><span class="chev" class:closed={collapsed.act}><Icon name="down" size={12} /></span> {t('sidebar.activeAgents', { n: app.agents.length })}</button>
      </div>
      {#if !collapsed.act}<div class="collapse" transition:slide={{ duration: dur(180) }}><AgentTree /></div>{/if}
    {/if}

    <!-- CUENTAS -->
    <div class="sec">
      <button class="sec-h" onclick={() => toggle('ag')}><span class="chev" class:closed={collapsed.ag}><Icon name="down" size={12} /></span> {t('sidebar.accounts.title')}</button>
      <span class="sshbtns">
        <button class="iconbtn" class:viewon={viewCustom} title={t('sidebar.accounts.viewTitle')} aria-label={t('sidebar.accounts.viewTitle')} aria-haspopup="menu" onclick={openViewMenu}><Icon name="sort" /></button>
        <button class="iconbtn" title={t('sidebar.accounts.addTitle')} onclick={() => (app.accountDialog = true)}><Icon name="plus" /></button>
      </span>
    </div>
    {#if !collapsed.ag}
     <div class="collapse" transition:slide={{ duration: dur(180) }}>
      {#if provList.length >= 2}
        <div class="chips" role="group" aria-label={t('sidebar.accounts.filterAria')}>
          {#each ['all', ...provList] as f (f)}
            <button type="button" class="chip" class:on={filterEff === f} aria-pressed={filterEff === f} onclick={() => setFilter(f as AccountsFilter)}>
              {tk(`sidebar.accounts.chip.${f}`)}<span class="n">{f === 'all' ? app.accounts.length : counts[f as keyof typeof counts]}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#each sections as sec (sec.provider ?? 'flat')}
        {#if sec.heading && sec.labelKey}<div class="grp" in:fly={{ x: -10, duration: dur(150) }}>{t('sidebar.accounts.groupHead', { label: t(sec.labelKey), n: sec.accounts.length })}</div>{/if}
        {#each sec.accounts as a (a.id)}
        {@const pr = app.profileOf(a)}
        {#if renaming === a.id}
        <div class="item renaming">
          <span class="dot" style:background={a.color}></span>
          <input class="rn" value={a.name} aria-label={t('ctx.account.renameAria')} spellcheck="false" use:focusSelect
            onblur={(e) => finishRename(a, e)} onkeydown={renameKey} />
        </div>
        {:else}
        <button class="item" draggable="true" ondragstart={(e) => dragStart(e, reqOf(a))} in:fly={{ x: -10, duration: dur(150) }}
          oncontextmenu={(e) => accountCtx(e, a)} onkeydown={(e) => accountKey(e, a)}
          onmouseenter={() => mcpHover(a.id)} onmouseleave={() => mcpHover(null)} onfocus={() => mcpHover(a.id)} onblur={() => mcpHover(null)}
          onclick={() => app.open(reqOf(a))} title={t('sidebar.accounts.openTitle')}>
          <span class="dot" style:background={a.color}></span>
          <span class="txt wide">
            <span class="name">{accountTitle(a)}</span>
            {#if providerOf(a) === 'claude'}
              <span class="sub">{pr?.loggedIn ? [pr.email, pr.plan].filter(Boolean).join(' · ') : t('sidebar.accounts.notLoggedIn')}</span>
              <UsageBars accountId={a.id} />
            {:else}
              <span class="sub">{app.providerStatus[a.id] ? statusLabel(app.providerStatus[a.id]) : t('sidebar.accounts.unchecked')}</span>
            {/if}
          </span>
        </button>
        {/if}
        {/each}
        {#each sec.specialRows as row (row)}
          {#if row === 'auto'}
          <button class="item auto" onclick={() => app.openAuto()} title={t('sidebar.accounts.autoTitle')}>
            <span class="ico" style="color:var(--accent)"><Icon name="swap" /></span>
            <span class="txt"><span class="name">{t('sidebar.accounts.auto')}</span><span class="sub">{POLICIES.find((p) => p.id === app.settings.accountPolicy)?.label}</span></span>
          </button>
          {:else}<!-- el lanzador suelto de siempre; con una cuenta «Default Codex» sobra (buildAccountView ya lo omite) -->
          <button class="item" draggable="true" ondragstart={(e) => dragStart(e, { kind: 'codex' })} onclick={() => app.open({ kind: 'codex' })}
            onmouseenter={() => mcpHover('codex-launcher')} onmouseleave={() => mcpHover(null)} onfocus={() => mcpHover('codex-launcher')} onblur={() => mcpHover(null)}>
            <span class="dot" style:background="#10a37f"></span>
            <span class="txt"><span class="name">Codex (ChatGPT)</span><!-- i18n-ignore: product name --><span class="sub">{t('sidebar.accounts.codexSub')}</span></span>
          </button>
          {/if}
        {/each}
      {/each}
     </div>
    {/if}

    <!-- SSH -->
    <div class="sec">
      <button class="sec-h" onclick={() => toggle('ssh')}><span class="chev" class:closed={collapsed.ssh}><Icon name="down" size={12} /></span> SSH</button>
      <span class="sshbtns">
        <button class="iconbtn" class:viewon={app.settings.hostsSort !== 'manual'} title={t('sidebar.ssh.menuTitle')} aria-label={t('sidebar.ssh.menuTitle')} aria-haspopup="menu" onclick={openSshMenu}><Icon name="sort" /></button>
        <button class="iconbtn" title={t('sidebar.ssh.newTitle')} onclick={() => app.newHost()}><Icon name="plus" /></button>
      </span>
    </div>
    {#if !collapsed.ssh}
     <!-- svelte-ignore a11y_no_static_element_interactions -->
     <div class="collapse hostlist" class:dragging={!!drag} transition:slide={{ duration: dur(180) }} ondragleave={leaveList} ondrop={doDrop}>
      {#each hostView as f (f.name)}
        {#if f.name}
          {#if renamingFolder === f.name}
          <div class="fold renaming">
            <span class="chev" class:closed={f.collapsed}><Icon name="down" size={11} /></span>
            <input class="rn" value={f.name} aria-label={t('sidebar.ssh.folder.renameAria')} spellcheck="false" use:focusSelect
              onblur={(e) => finishFolderRename(f.name, e)} onkeydown={(e) => { if (e.key === 'Escape') folderRenameCancelled = true; renameKey(e); }} />
          </div>
          {:else}
          <button class="fold" data-folder={f.name} draggable={reorderable} title={t('sidebar.ssh.folder.title')} aria-expanded={!f.collapsed}
            class:drop-before={drag?.kind === 'folder' && drop?.mark === `f:${f.name}`}
            class:drop-into={drag?.kind === 'host' && drop?.mark === `f:${f.name}`} class:lifted={drag?.kind === 'folder' && drag.name === f.name}
            onclick={() => app.toggleHostFolder(f.name)} oncontextmenu={(e) => folderCtx(e, f.name, f.collapsed)} onkeydown={(e) => folderKey(e, f.name, f.collapsed)}
            ondragstart={(e) => folderDragStart(e, f.name)} ondragend={dragEnd} ondragover={(e) => overFolder(e, f.name)}>
            <span class="chev" class:closed={f.collapsed}><Icon name="down" size={11} /></span>
            <span class="fname">{f.name}</span>
            <span class="fcount" title={t('sidebar.ssh.folderCount', { n: f.total })}>{q && f.hosts.length !== f.total ? `${f.hosts.length}/${f.total}` : f.total}</span>
          </button>
          {/if}
        {:else if hasNamed}
          <!-- «Sin carpeta»: cabecera fija (no se pliega ni se mueve); sirve para soltar hosts y para mandar una carpeta al final -->
          <div class="fold none" class:drop-into={drag?.kind === 'host' && drop?.mark === 'f:'} class:drop-before={drag?.kind === 'folder' && drop?.mark === 'f:'}
            ondragover={(e) => overFolder(e, UNGROUPED)}>
            <span class="fname">{t('sidebar.ssh.folder.none')}</span><span class="fcount">{f.total}</span>
          </div>
        {/if}
        {#if !f.collapsed}
        <div class="foldbody" class:indent={!!f.name} class:lifted={drag?.kind === 'folder' && drag.name === f.name} transition:slide={{ duration: dur(150) }}>
        {#each f.hosts as h, i (h.id)}
          <div class="item-wrap" animate:flip={{ duration: dur(160) }} in:fly={{ x: -10, duration: dur(150) }}
            class:drop-before={markOf(h.id) === 'before'} class:drop-after={markOf(h.id) === 'after'}
            ondragover={(e) => overHost(e, f.name, f.hosts, i)}>
            <button class="item" data-host={h.id} draggable="true" class:lifted={drag?.kind === 'host' && drag.id === h.id}
              ondragstart={(e) => hostDragStart(e, h)} ondragend={dragEnd}
              oncontextmenu={(e) => hostCtx(e, h)} onkeydown={(e) => hostKey(e, h)}
              onclick={() => app.open({ kind: 'host', id: h.id })} title={t('sidebar.ssh.hostTitle')}>
              <span class="dot sq" style:background={h.color || 'var(--info)'}></span>
              <span class="txt">
                <span class="name">{h.name || h.host}{#if app.hostDot(h.id)}<span class="hdot {app.hostDot(h.id)}" title={app.hostDot(h.id) === 'red' ? t('attention.ssh.dotGaveUp') : t('attention.ssh.dotDown')}><Icon name="unplug" size={10} /></span>{/if}</span>
                <span class="sub">{h.user ? h.user + '@' : ''}{h.host}{h.port ? ':' + h.port : ''}{h.tmux ? ' · tmux' : ''}</span> <!-- i18n-ignore -->
              </span>
            </button>
            <button class="iconbtn edit" title={t('sidebar.ssh.editTitle')} onclick={() => editHost(h)}><Icon name="edit" size={13} /></button>
          </div>
        {/each}
        </div>
        {/if}
      {/each}
      {#if drag?.kind === 'folder' && drop?.mark === 'f:end'}<div class="endmark"></div>{/if}
      {#if drag?.kind === 'host' && hasNamed && !hostView.some((f) => !f.name)}
        <!-- mientras se arrastra: sitio para sacar un host de su carpeta aunque «Sin carpeta» esté vacía -->
        <div class="fold none" class:drop-into={drop?.mark === 'f:'} ondragover={(e) => overFolder(e, UNGROUPED)}>
          <span class="fname">{t('sidebar.ssh.folder.none')}</span><span class="fcount">0</span>
        </div>
      {/if}
      {#if cfgHosts.length && anyHost}<div class="fold none cfg">{t('sidebar.ssh.fromConfigHead')}</div>{/if}
      {#each cfgHosts as h (h.alias)}
        <button class="item" draggable="true" ondragstart={(e) => dragStart(e, { kind: 'sshconfig', alias: h.alias })}
          onclick={() => app.open({ kind: 'sshconfig', alias: h.alias })} title={t('sidebar.ssh.fromConfigTitle')}>
          <span class="dot sq" style:background="var(--faint)"></span>
          <span class="txt"><span class="name">{h.alias}{#if app.hostDot('cfg:' + h.alias)}<span class="hdot {app.hostDot('cfg:' + h.alias)}" title={app.hostDot('cfg:' + h.alias) === 'red' ? t('attention.ssh.dotGaveUp') : t('attention.ssh.dotDown')}><Icon name="unplug" size={10} /></span>{/if}</span><span class="sub">{h.user ? h.user + '@' : ''}{h.hostname ?? ''} · ssh config</span></span>
        </button>
      {/each}
      {#if !anyHost && !cfgHosts.length}
        <div class="empty">{t('sidebar.ssh.empty')}</div>
      {/if}
     </div>
    {/if}

    <!-- LOCALES -->
    <div class="sec">
      <button class="sec-h" onclick={() => toggle('loc')}><span class="chev" class:closed={collapsed.loc}><Icon name="down" size={12} /></span> {t('sidebar.local.title')}</button>
    </div>
    {#if !collapsed.loc}
     <div class="collapse" transition:slide={{ duration: dur(180) }}>
      {#each shells as s (s.id)}
        <button class="item" draggable="true" ondragstart={(e) => dragStart(e, { kind: 'shell', id: s.id })} onclick={() => app.open({ kind: 'shell', id: s.id })} in:fly={{ x: -10, duration: dur(150) }}>
          <span class="ico"><Icon name="terminal" /></span>
          <span class="txt"><span class="name">{s.name}</span></span>
        </button>
      {/each}
     </div>
    {/if}

    <!-- SEGUNDO PLANO -->
    {#if parked.length}
      <div class="sec"><span class="sec-h"><Icon name="layers" size={12} /> {t('sidebar.background.title', { n: parked.length })}</span></div>
      {#each parked as p (p.id)}
        <div class="item-wrap" in:fly={{ x: -10, duration: dur(150) }}>
          <button class="item" onclick={() => app.unpark(p.id)} title={t('sidebar.background.bringTitle')}>
            <span class="ico"><Icon name={p.icon} /></span>
            <span class="txt"><span class="name">{p.title}</span><span class="sub">{app.live[p.id]?.state === 'exited' ? t('sidebar.background.exited') : t('sidebar.background.running')}</span></span>
          </button>
          <button class="iconbtn edit closebtn" class:armed={armedClose === p.id} title={t('sidebar.background.closeTitle')} aria-label={t('sidebar.background.closeTitle')} onclick={() => closeParked(p.id)}>
            {#if armedClose === p.id}{t('agents.closeConfirm')}{:else}<Icon name="x" size={13} />{/if}
          </button>
        </div>
      {/each}
    {/if}
  </div>
</aside>

<style>
  /* min-height: 0 en el contenedor y en la zona con scroll: sin él, un hijo flex no se encoge por debajo de su contenido y la lista
     se corta en vez de hacer scroll cuando hay muchos agentes o subagentes. */
  .side { background: var(--panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; }
  .brand { display: flex; align-items: center; gap: 9px; padding: 11px 12px 8px; font-size: 14px; letter-spacing: 0.02em; }
  .brandlogo { display: grid; }
  .collapse { overflow: hidden; }
  /* El chevron gira en vez de cambiar de icono. */
  .chev { display: inline-grid; transition: transform 0.18s ease; }
  .chev.closed { transform: rotate(-90deg); }
  .sec-h { cursor: pointer; transition: color 0.12s; }
  .sec-h:hover { color: var(--text); }
  .grow { flex: 1; }
  .inputs { display: grid; gap: 6px; padding: 4px 10px 8px; }
  .inputs input { font-size: 12px; padding: 5px 8px; transition: border-color 0.15s, box-shadow 0.15s; }
  .inputs input:focus { box-shadow: 0 0 0 3px var(--accent-soft); }
  .scroll { overflow-y: auto; overscroll-behavior: contain; flex: 1; min-height: 0; padding-bottom: 12px; }
  .sec { display: flex; align-items: center; justify-content: space-between; padding: 10px 10px 3px 12px; }
  .sec-h { display: flex; align-items: center; gap: 5px; color: var(--muted); font-size: 10.5px; letter-spacing: 0.08em; font-weight: 600; }
  .grp { padding: 7px 14px 2px; color: var(--faint); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; }
  .item-wrap { position: relative; }
  .item-wrap .edit { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); opacity: 0; }
  .item-wrap:hover .edit, .item-wrap .edit:focus-visible { opacity: 1; }
  .item-wrap .closebtn { min-width: 24px; padding: 0 5px; font-size: 11px; }
  .item-wrap .closebtn:hover { color: var(--bad); }
  .item-wrap .closebtn.armed { opacity: 1; background: var(--bad); color: #1a0a0b; font-weight: 600; }
  .item { position: relative; display: flex; align-items: center; gap: 9px; width: calc(100% - 12px); margin: 1px 6px; padding: 5px 8px; border-radius: 6px; text-align: left; transition: background 0.12s, transform 0.12s; }
  /* Barrita de acento que crece desde el centro al pasar el ratón. */
  .item::before { content: ''; position: absolute; left: 0; top: 18%; bottom: 18%; width: 3px; border-radius: 2px; background: var(--accent); transform: scaleY(0); transition: transform 0.16s ease; }
  .item:hover { background: var(--raise); transform: translateX(2px); }
  .item:hover::before { transform: scaleY(1); }
  .item:active { background: var(--accent-soft); transform: translateX(2px) scale(0.985); }
  .item.renaming::before { display: none; }
  .dot { transition: transform 0.15s; }
  .item:hover .dot { transform: scale(1.25); }
  @media (prefers-reduced-motion: reduce) {
    .chev, .item, .item::before, .dot, .chip { transition: none; }
    .item:hover, .item:active { transform: none; }
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; margin: 0 3px; }
  .dot.sq { border-radius: 3px; }
  .ico { color: var(--muted); display: grid; margin: 0 1px; }
  .txt { display: grid; min-width: 0; }
  .txt.wide { flex: 1; }
  .item.renaming:hover { background: none; }
  .rn { flex: 1; min-width: 0; font-size: 12.5px; padding: 3px 6px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Conexión SSH caída en algún panel de este host (ámbar = reconectando, rojo = se rindió). */
  .hdot { display: inline-grid; place-items: center; width: 15px; height: 15px; margin-left: 5px; border-radius: 50%; vertical-align: -3px; }
  .hdot.amber { color: var(--warn); background: color-mix(in srgb, var(--warn) 18%, transparent); }
  .hdot.red { color: var(--bad); background: color-mix(in srgb, var(--bad) 18%, transparent); }
  .sub { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: var(--muted); font-size: 12px; padding: 6px 14px; }
  .sshbtns { display: inline-flex; gap: 2px; }
  .iconbtn.viewon { color: var(--accent); }
  /* Chips de filtro por proveedor: pastillas pequeñas, mismo tamaño que .grp / .sub. */
  .chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 3px 12px 5px; }
  .chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border-strong); color: var(--muted); font-size: 10.5px; line-height: 1.6; transition: background 0.14s, color 0.14s, border-color 0.14s; }
  .chip:hover { color: var(--text); background: var(--raise); }
  .chip.on { color: var(--text); background: var(--accent-soft); border-color: var(--accent); }
  .chip .n { opacity: 0.65; font-variant-numeric: tabular-nums; }
  .chip:focus-visible, .iconbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  /* Carpetas de hosts: cabecera con chevron, nombre y contador; el cuerpo va un poco sangrado. */
  .fold { position: relative; display: flex; align-items: center; gap: 5px; width: calc(100% - 12px); margin: 3px 6px 0; padding: 4px 8px 3px 6px; border-radius: 5px;
    color: var(--faint); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; text-align: left; transition: background 0.12s, color 0.12s; }
  button.fold { cursor: pointer; }
  button.fold:hover { color: var(--text); background: var(--raise); }
  .fold:focus-visible, .item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .fold .chev { color: var(--faint); }
  .fname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fcount { font-variant-numeric: tabular-nums; font-size: 10px; letter-spacing: 0; padding: 0 6px; border-radius: 999px; background: var(--raise); color: var(--muted); }
  .fold.none { cursor: default; }
  .fold.cfg { text-transform: none; letter-spacing: 0.02em; }
  .fold.renaming { text-transform: none; letter-spacing: 0; }
  .foldbody.indent { margin-left: 8px; }
  /* Indicador de dónde caerá: raya de acento entre filas; la carpeta de destino se resalta entera. */
  .item-wrap.drop-before::after, .item-wrap.drop-after::after, .fold.drop-before::after, .endmark {
    content: ''; position: absolute; left: 10px; right: 10px; height: 2px; border-radius: 2px; background: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); pointer-events: none; }
  .item-wrap.drop-before::after, .fold.drop-before::after { top: -2px; }
  .item-wrap.drop-after::after { bottom: -2px; }
  .endmark { position: relative; display: block; margin: 2px 0; }
  .fold.drop-into { background: var(--accent-soft); color: var(--text); box-shadow: inset 0 0 0 1px var(--accent); }
  .lifted { opacity: 0.45; }
  .hostlist.dragging .item:hover { transform: none; }
</style>
