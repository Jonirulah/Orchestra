<script lang="ts">
  import { app } from '../lib/store.svelte.ts';
  import { POLICIES } from '../lib/policy.ts';
  import { LIMITS } from '../lib/settings.ts';
  import { t, tk } from '../lib/i18n.ts';
  import Toggle from './Toggle.svelte';
  import Slider from './Slider.svelte';
  import { SOUND_IDS, playSound } from '../lib/sounds.ts';
  import type { SoundId } from '../lib/sounds.ts';

  const s = $derived(app.settings);

  // ▶ se salta el anti-spam: es el usuario quien lo pide.
  const preview = (id: SoundId) => playSound(id, s.soundVolume / 100, true);
  const soundRows = $derived([
    { key: 'soundAttention', label: t('settings.agents.soundAttentionLabel'), hint: t('settings.agents.soundAttentionHint') },
    { key: 'soundDone', label: t('settings.agents.soundDoneLabel'), hint: t('settings.agents.soundDoneHint') },
  ] as const);

  // Encender la consulta pide una confirmación explícita (lee el token de cada cuenta). Apagarla es inmediato.
  let confirming = $state(false);
  function toggleUsageQuery(v: boolean) {
    if (!v) { confirming = false; app.setting('usageQuery', false); return; }
    confirming = !confirming;
  }
  function confirmUsageQuery() {
    confirming = false;
    app.setting('usageQuery', true);
  }
</script>

<div class="s-row stack">
  <div class="lbl">
    <b>{t('settings.agents.policyLabel')}</b>
    <small>{t('settings.agents.policyHint')}</small>
  </div>
  <div class="s-radios">
    {#each POLICIES as p (p.id)}
      <button type="button" role="radio" aria-checked={s.accountPolicy === p.id} class:on={s.accountPolicy === p.id} onclick={() => app.setPolicy(p.id)}>
        <span class="dot"></span>
        <span class="t"><b>{p.label}</b><small>{p.hint}</small></span>
      </button>
    {/each}
  </div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.agents.cwdLabel')}</b><small>{t('settings.agents.cwdHint')}</small></div>
  <div class="ctl col">
    <input placeholder={t('settings.agents.cwdPlaceholder')} value={s.agentCwd} oninput={(e) => app.setting('agentCwd', e.currentTarget.value)} spellcheck="false" />
  </div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.agents.scanLabel')}</b><small>{t('settings.agents.scanHint')}</small></div>
  <div class="ctl"><Slider value={s.scanIntervalSec} min={LIMITS.scanIntervalSec[0]} max={LIMITS.scanIntervalSec[1]} unit=" s" onchange={(v) => app.setting('scanIntervalSec', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.agents.notifyPermissionLabel')}</b></div>
  <div class="ctl"><Toggle value={s.notifyPermission} label={t('settings.agents.notifyPermissionLabel')} onchange={(v) => app.setting('notifyPermission', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.agents.notifyDoneLabel')}</b></div>
  <div class="ctl"><Toggle value={s.notifyDone} label={t('settings.agents.notifyDoneLabel')} onchange={(v) => app.setting('notifyDone', v)} /></div>
</div>

{#each soundRows as { key, label, hint } (key)}
  <div class="s-row">
    <div class="lbl"><b>{label}</b><small>{hint}</small></div>
    <div class="ctl snd">
      <select value={s[key]} aria-label={label} onchange={(e) => app.setting(key, e.currentTarget.value as SoundId)}>
        {#each SOUND_IDS as id (id)}<option value={id}>{tk(`settings.agents.sound.${id}`)}</option>{/each}
      </select>
      <button type="button" class="btn ghost small" disabled={s[key] === 'none' || s.soundVolume === 0} title={t('settings.agents.soundPreview')} aria-label={t('settings.agents.soundPreview')} onclick={() => preview(s[key])}>▶</button>
    </div>
  </div>
{/each}

<div class="s-row">
  <div class="lbl"><b>{t('settings.agents.soundVolumeLabel')}</b></div>
  <div class="ctl"><Slider value={s.soundVolume} min={LIMITS.soundVolume[0]} max={LIMITS.soundVolume[1]} step={5} unit=" %" onchange={(v) => app.setting('soundVolume', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl">
    <b>{t('settings.agents.restoreLabel')}</b>
    <small>{t('settings.agents.restoreHint')}</small>
  </div>
  <div class="ctl"><Toggle value={s.restoreClaudeSessions} label={t('settings.agents.restoreLabel')} onchange={(v) => app.setting('restoreClaudeSessions', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl">
    <b>{t('settings.agents.captureLabel')}</b>
    <small>{t('settings.agents.captureHint')}</small>
  </div>
  <div class="ctl"><Toggle value={s.captureUsage} label={t('settings.agents.captureLabel')} onchange={(v) => app.setting('captureUsage', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl">
    <b>{t('settings.agents.quotaLabel')}</b>
    <small>{t('settings.agents.quotaHint')}</small>
  </div>
  <div class="ctl"><Toggle value={s.notifyQuota} label={t('settings.agents.quotaLabel')} onchange={(v) => app.setting('notifyQuota', v)} /></div>
</div>

<h4 class="uq-head">{t('settings.usage.title')}</h4>
<div class="s-row">
  <div class="lbl">
    <b>{t('settings.usage.toggleLabel')}</b>
    <small>{t('settings.usage.toggleHint')}</small>
  </div>
  <div class="ctl"><Toggle value={s.usageQuery} label={t('settings.usage.toggleLabel')} onchange={toggleUsageQuery} /></div>
</div>

{#if confirming}
  <div class="s-row stack">
    <div class="lbl">
      <b>{t('settings.usage.confirmTitle')}</b>
      <small>{t('settings.usage.confirmBody')}</small>
    </div>
    <div class="uq-acts">
      <button class="btn primary" onclick={confirmUsageQuery}>{t('settings.usage.confirmSecond')}</button>
      <button class="btn ghost" onclick={() => (confirming = false)}>{t('settings.usage.cancel')}</button>
    </div>
  </div>
{/if}

{#if s.usageQuery}
  <div class="s-row">
    <div class="lbl"><b>{t('settings.usage.intervalLabel')}</b><small>{t('settings.usage.intervalHint')}</small></div>
    <div class="ctl"><Slider value={s.usageQueryMin} min={LIMITS.usageQueryMin[0]} max={LIMITS.usageQueryMin[1]} unit=" min" onchange={(v) => app.setting('usageQueryMin', v)} /></div>
  </div>
{/if}

<div class="s-row">
  <div class="lbl">
    <b>{t('settings.agents.cacheLabel')}</b>
    <small>{t('settings.agents.cacheHint', { red: s.cacheWarnMin, amber: s.cacheWarnMin * 4 })}</small>
  </div>
  <div class="ctl"><Slider value={s.cacheWarnMin} min={LIMITS.cacheWarnMin[0]} max={LIMITS.cacheWarnMin[1]} unit=" min" onchange={(v) => app.setting('cacheWarnMin', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.agents.cardLabel')}</b><small>{t('settings.agents.cardHint')}</small></div>
  <div class="ctl"><Toggle value={s.agentCard} label={t('settings.agents.cardLabel')} onchange={(v) => app.setting('agentCard', v)} /></div>
</div>

{#if s.agentCard}
  <div class="s-row">
    <div class="lbl"><b>{t('settings.agents.cardDelayLabel')}</b><small>{t('settings.agents.cardDelayHint')}</small></div>
    <div class="ctl"><Slider value={s.agentCardDelayMs} min={LIMITS.agentCardDelayMs[0]} max={LIMITS.agentCardDelayMs[1]} step={100} unit=" ms" onchange={(v) => app.setting('agentCardDelayMs', v)} /></div>
  </div>
{/if}

<div class="s-row">
  <div class="lbl">
    <b>{t('settings.agents.autoCompactLabel')} <span class="hint">{t('settings.agents.experimental')}</span></b>
    <small>{@html t('settings.agents.autoCompactHint', { after: s.autoCompactAfterMin })}</small>
  </div>
  <div class="ctl"><Toggle value={s.autoCompact} label={t('settings.agents.autoCompactLabel')} onchange={(v) => app.setting('autoCompact', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.agents.ctxLabel')}</b><small>{t('settings.agents.ctxHint')}</small></div>
  <div class="ctl"><Slider value={s.autoCompactCtxK} min={LIMITS.autoCompactCtxK[0]} max={LIMITS.autoCompactCtxK[1]} step={10} unit=" k" onchange={(v) => app.setting('autoCompactCtxK', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.agents.afterLabel')}</b><small>{t('settings.agents.afterHint')}</small></div>
  <div class="ctl"><Slider value={s.autoCompactAfterMin} min={LIMITS.autoCompactAfterMin[0]} max={LIMITS.autoCompactAfterMin[1]} unit=" min" onchange={(v) => app.setting('autoCompactAfterMin', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.agents.idleLabel')}</b><small>{t('settings.agents.idleHint')}</small></div>
  <div class="ctl"><Slider value={s.autoCompactUserIdleMin} min={LIMITS.autoCompactUserIdleMin[0]} max={LIMITS.autoCompactUserIdleMin[1]} unit=" min" onchange={(v) => app.setting('autoCompactUserIdleMin', v)} /></div>
</div>

<div class="s-row stack">
  <div class="lbl">
    <b>{t('settings.agents.recentLabel')}</b>
    <small>{t('settings.agents.recentHint')}</small>
  </div>
  {#if app.compactLog.length}
    <ul class="hint compact-log">
      {#each app.compactLog as e (e.at)}
        <li>{t('settings.agents.compactLogLine', { time: new Date(e.at).toLocaleTimeString(), title: e.title, k: Math.round(e.ctxTokens / 1000) })}</li>
      {/each}
    </ul>
  {:else}
    <span class="hint">{t('settings.agents.recentEmpty')}</span>
  {/if}
</div>

<style>
  .snd select { width: 200px; }
  .compact-log { margin: 0; padding-left: 16px; display: grid; gap: 2px; }
  .uq-acts { display: flex; gap: 8px; }
  .uq-head { margin: 18px 0 0; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
</style>
