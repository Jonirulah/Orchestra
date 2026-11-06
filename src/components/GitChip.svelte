<script lang="ts">
  // Branch chip in a local pane's header. Mounted only while the pane is visible, so refreshing here means
  // "visible panes only"; it also stops while the window is hidden. All git work is in src-tauri/src/git.rs.
  import { app } from '../lib/store.svelte.ts';
  import { t, tk } from '../lib/i18n.ts';
  import { gitState, refreshGit, forgetGit } from '../lib/gitstate.svelte.ts';
  import { chipText, cwdForPane, gitLevel } from '../lib/gitinfo.ts';
  import type { Pane } from '../lib/model.ts';

  let { pane }: { pane: Pane } = $props();

  const live = $derived(app.live[pane.id]);
  const ag = $derived(app.agentOf(pane.id));
  const focused = $derived(app.active.focusId === pane.id);
  const on = $derived(app.settings.gitChip && pane.kind !== 'ssh' && live?.state !== 'exited');
  const cwd = $derived(cwdForPane(live?.cwd, ag?.cwd, pane.spec.cwd));
  const interval = $derived(app.settings.gitIntervalSec * 1000);
  const g = $derived(on ? gitState.byPane[pane.id] : null);

  // New folder, focus or settings change: ask now. Then every N seconds while the window is visible.
  $effect(() => {
    if (!on || !cwd) return;
    void focused;
    const dir = cwd;
    const tick = () => { if (document.visibilityState === 'visible') void refreshGit(pane.id, dir); };
    tick();
    const iv = window.setInterval(tick, interval);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', tick); };
  });
  $effect(() => { if (!on || !cwd) forgetGit(pane.id); });

  const txt = $derived(g ? chipText(g, app.settings.gitCounts) : null);
  const level = $derived(g ? gitLevel(g) : 'clean');
  const opName = (op: string) => { const key = op === 'cherry-pick' ? 'cherryPick' : op; const r = tk(`git.op.${key}`); return r.startsWith('git.op.') ? op : r; };
  const tip = $derived.by(() => {
    if (!g) return '';
    const l: string[] = [t('git.tip.repo', { root: g.repoRoot })];
    if (g.detached) l.push(t('git.tip.detached', { name: g.branch ?? '?' }));
    else if (!g.hasUpstream) l.push(t('git.tip.noUpstream'));
    else if (g.ahead || g.behind) l.push(t('git.tip.aheadBehind', { ahead: g.ahead, behind: g.behind, upstream: t('git.tip.upstream') }));
    if (g.dirtyCount + g.untracked === 0) l.push(t('git.tip.clean'));
    else l.push(t('git.tip.changes', { staged: g.staged, unstaged: g.unstaged, untracked: g.untracked }));
    if (g.conflicts) l.push(t('git.tip.conflicts', { n: g.conflicts }));
    if (g.worktree) l.push(t('git.tip.worktree'));
    if (g.inProgress) l.push(t('git.tip.inProgress', { op: opName(g.inProgress) }));
    l.push(t('git.chip.copyHint'));
    return l.join('\n');
  });

  function copy(e: MouseEvent) {
    e.stopPropagation();
    if (!g?.branch) return;
    void navigator.clipboard.writeText(g.branch).then(() => app.toast(t('git.chip.copied', { name: g.branch! }))).catch(() => {});
  }
</script>

{#if g && txt}
  <button class="gchip {level}" class:detached={g.detached} title={tip} aria-label={t('git.chip.aria', { name: g.branch ?? '' })}
    onclick={copy} ondblclick={(e) => e.stopPropagation()} draggable="false">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.4" /><circle cx="6" cy="19" r="2.4" /><circle cx="18" cy="8" r="2.4" />
      <path d="M6 7.4v9.2" /><path d="M18 10.4c0 4-6 3.2-11 7" />
    </svg>
    <span class="gname">{txt.name}</span>
    {#if txt.changes}<span class="gn"><i class="gd"></i>{txt.changes}</span>{/if}
    {#if txt.ahead}<span class="gn">{txt.ahead}</span>{/if}
    {#if txt.behind}<span class="gn">{txt.behind}</span>{/if}
    {#if g.inProgress}<span class="gn">{opName(g.inProgress)}</span>{/if}
  </button>
{/if}

<style>
  .gchip { display: inline-flex; align-items: center; gap: 4px; min-width: 0; flex: 0 1 auto; padding: 0 5px; height: 17px;
    font-size: 10.5px; color: var(--muted); border: 1px solid transparent; border-radius: 4px; background: none;
    white-space: nowrap; font-variant-numeric: tabular-nums; cursor: pointer; }
  .gchip:hover { background: var(--raise); border-color: var(--faint); }
  .gname { overflow: hidden; text-overflow: ellipsis; max-width: 22ch; min-width: 7ch; }
  .gn { display: inline-flex; align-items: center; gap: 3px; flex: none; }
  .gd { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }
  .gchip.dirty { color: var(--text); }
  .gchip.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, transparent); }
  .gchip.bad .gd { background: var(--bad); }
  .gchip.detached .gname { font-family: var(--mono, monospace); }
</style>
