<script lang="ts">
  // "Git" card of Settings -> Terminal: the branch chip in pane headers (src/components/GitChip.svelte).
  import { onMount } from 'svelte';
  import { app } from '../lib/store.svelte.ts';
  import { LIMITS } from '../lib/settings.ts';
  import { t } from '../lib/i18n.ts';
  import * as be from '../lib/backend.ts';
  import Toggle from './Toggle.svelte';
  import Slider from './Slider.svelte';

  const s = $derived(app.settings);
  let hasGit = $state(true);
  onMount(() => { void be.gitAvailable().then((ok) => (hasGit = ok)); });
</script>

<h4 class="grp">{t('git.settings.title')}</h4>
{#if !hasGit}<p class="s-warnline">{t('git.settings.missing')}</p>{/if}
<div class="s-row">
  <div class="lbl"><b>{t('git.settings.chipLabel')}</b><small>{t('git.settings.chipHint')}</small></div>
  <div class="ctl"><Toggle value={s.gitChip} label={t('git.settings.chipLabel')} onchange={(v) => app.setting('gitChip', v)} /></div>
</div>
{#if s.gitChip}
  <div class="s-row">
    <div class="lbl"><b>{t('git.settings.countsLabel')}</b><small>{t('git.settings.countsHint')}</small></div>
    <div class="ctl"><Toggle value={s.gitCounts} label={t('git.settings.countsLabel')} onchange={(v) => app.setting('gitCounts', v)} /></div>
  </div>
  <div class="s-row">
    <div class="lbl"><b>{t('git.settings.intervalLabel')}</b><small>{t('git.settings.intervalHint')}</small></div>
    <div class="ctl"><Slider value={s.gitIntervalSec} min={LIMITS.gitIntervalSec[0]} max={LIMITS.gitIntervalSec[1]} unit=" s" onchange={(v) => app.setting('gitIntervalSec', v)} /></div>
  </div>
{/if}
<div class="s-row">
  <div class="lbl"><b>{t('git.settings.trackLabel')}</b><small>{t('git.settings.trackHint')}</small></div>
  <div class="ctl"><Toggle value={s.gitTrackFolder} label={t('git.settings.trackLabel')} onchange={(v) => app.setting('gitTrackFolder', v)} /></div>
</div>

<style>
  .grp { margin: 22px 0 4px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
</style>
