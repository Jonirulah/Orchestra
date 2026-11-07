<script lang="ts">
  import { tick } from 'svelte';
  import { app, type OpenReq } from '../lib/store.svelte.ts';
  import { PRESETS, accountTitle, providerOf } from '../lib/model.ts';
  import { t } from '../lib/i18n.ts';
  import Icon from './Icon.svelte';

  interface Cmd { label: string; hint?: string; icon: string; run: () => void }

  let q = $state('');
  let sel = $state(0);
  let input = $state<HTMLInputElement>();

  const all = $derived.by<Cmd[]>(() => {
    const open = (req: OpenReq) => () => app.open(req);
    const c: Cmd[] = [];
    for (const a of app.accounts) {
      const claude = providerOf(a) === 'claude';
      c.push({ label: accountTitle(a), hint: claude ? app.profileOf(a)?.email : undefined, icon: 'bot', run: open(claude ? { kind: 'claude', accountId: a.id } : { kind: 'account', accountId: a.id }) });
      if (!claude) c.push({ label: t('palette.signIn', { name: accountTitle(a) }), icon: 'user', run: () => app.signIn(a.id) });
    }
    if (!app.hasDefaultAccount('codex')) c.push({ label: 'Codex', icon: 'bot', run: open({ kind: 'codex' }) }); // i18n-ignore: product name
    for (const h of app.hosts) c.push({ label: `SSH · ${h.name || h.host}`, hint: h.group, icon: 'server', run: open({ kind: 'host', id: h.id }) });
    for (const h of app.sshConfig) c.push({ label: `SSH · ${h.alias}`, hint: 'ssh config', icon: 'server', run: open({ kind: 'sshconfig', alias: h.alias }) });
    for (const s of app.shells) c.push({ label: s.name, icon: 'terminal', run: open({ kind: 'shell', id: s.id }) });
    for (const p of PRESETS) c.push({ label: t('palette.layout', { cols: p.cols, rows: p.rows }), icon: 'grid', run: () => app.setLayout(p.cols, p.rows) });
    c.push({ label: t('palette.newHost'), icon: 'plus', run: () => app.newHost() });
    c.push({ label: t('palette.addAccount'), icon: 'user', run: () => (app.accountDialog = true) });
    c.push({ label: t('palette.newWorkspace'), icon: 'plus', run: () => app.addWorkspace() });
    for (const sw of app.savedWorkspaces) c.push({ label: t('palette.openSaved', { name: sw.name }), hint: t('palette.savedHint'), icon: 'layers', run: () => app.openSavedWorkspace(sw.id) });
    c.push({ label: t('palette.equalize'), icon: 'grid', run: () => app.equalize() });
    c.push({ label: t('palette.settings'), hint: 'Ctrl+,', icon: 'gear', run: () => (app.settingsOpen = true) });
    c.push({ label: t('palette.toggleSidebar'), hint: 'Ctrl+Shift+B', icon: 'sidebar', run: () => app.toggleSidebar() });
    return c;
  });

  const list = $derived.by(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((c) => terms.every((term) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(term))).slice(0, 40);
  });

  $effect(() => { void tick().then(() => input?.focus()); });
  $effect(() => { void q; sel = 0; });

  function run(c?: Cmd) { app.paletteOpen = false; c?.run(); }
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') app.paletteOpen = false;
    else if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, list.length - 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); e.preventDefault(); }
    else if (e.key === 'Enter') run(list[sel]);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-back" onpointerdown={(e) => { if (e.target === e.currentTarget) app.paletteOpen = false; }}>
  <div class="modal pal">
    <input bind:this={input} bind:value={q} placeholder={t('palette.placeholder')} onkeydown={key} />
    <div class="list">
      {#each list as c, i (c.label + i)}
        <button class="opt" class:sel={i === sel} onpointermove={() => (sel = i)} onclick={() => run(c)}>
          <Icon name={c.icon} /> <span class="l">{c.label}</span> {#if c.hint}<span class="h">{c.hint}</span>{/if}
        </button>
      {/each}
      {#if !list.length}<div class="none">{t('palette.empty')}</div>{/if}
    </div>
  </div>
</div>

<style>
  .pal { padding: 10px; }
  .pal input { width: 100%; font-size: 14px; padding: 9px 11px; }
  .list { margin-top: 8px; max-height: 50vh; overflow-y: auto; }
  .opt { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 10px; border-radius: 6px; text-align: left; }
  .opt.sel { background: var(--accent-soft); }
  .l { flex: 1; }
  .h { color: var(--muted); font-size: 11.5px; }
  .none { padding: 14px; color: var(--muted); text-align: center; }
</style>
