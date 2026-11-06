<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '../lib/store.svelte.ts';
  import * as be from '../lib/backend.ts';
  import { APP_VERSION, parseImport } from '../lib/settings.ts';
  import { t } from '../lib/i18n.ts';
  import {
    ALL_PICKS, MAX_BACKUP_BYTES, anyPicked, backupFileName, buildBackup, mergeBackup, parseBackup, replaceFromBackup, serializeBackup,
  } from '../lib/backup.ts';
  import type { BackupPicks, BackupSection, ParseBackupResult } from '../lib/backup.ts';
  import Icon from './Icon.svelte';

  const IMPORT_EXAMPLE = '{ "fontSize": 14, "theme": "dracula" }'; // i18n-ignore: JSON example
  let dir = $state('…');
  let importText = $state('');
  let msg = $state<{ ok: boolean; text: string } | null>(null);
  let armed = $state(false);
  let armTimer: number | undefined;

  const build = t('settings.data.build', {
    kind: import.meta.env.DEV ? t('settings.data.buildDev') : t('settings.data.buildRelease'),
    where: be.inTauri ? t('settings.data.buildDesktop') : t('settings.data.buildBrowser'),
  });

  onMount(() => { void be.dataDir().then((d) => (dir = d)).catch((e) => (dir = String(e))); });

  const snapshot = () => $state.snapshot(app.settings);

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot(), null, 2));
      msg = { ok: true, text: t('settings.data.copied') };
    } catch (e) {
      msg = { ok: false, text: t('settings.data.copyFailed', { error: String(e) }) };
    }
  }
  function apply() {
    const r = parseImport(importText, snapshot());
    if (!r.ok) { msg = { ok: false, text: r.error }; return; }
    app.replaceSettings(r.settings);
    const n = r.applied.length;
    const ignored = r.ignored.join(', ');
    msg = {
      ok: true,
      text: r.ignored.length
        ? (n === 1 ? t('settings.data.appliedOneIgnored', { ignored }) : t('settings.data.appliedManyIgnored', { n, ignored }))
        : (n === 1 ? t('settings.data.appliedOne') : t('settings.data.appliedMany', { n })),
    };
    importText = '';
  }
  // ---------- copia de seguridad completa ----------
  let bMsg = $state<{ ok: boolean; text: string } | null>(null);
  let bText = $state('');
  let parsed = $state<Extract<ParseBackupResult, { ok: true }> | null>(null);
  let picks = $state<BackupPicks>({ ...ALL_PICKS });
  let mode = $state<'merge' | 'replace'>('merge');
  let bArmed = $state(false);
  let bArmTimer: number | undefined;
  let fileInput = $state<HTMLInputElement>();

  const backupJson = () => serializeBackup(buildBackup(app.backupState(), { appVersion: APP_VERSION }));

  function saveBackup() {
    const file = backupFileName();
    const url = URL.createObjectURL(new Blob([backupJson()], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    bMsg = { ok: true, text: t('settings.data.backup.saved', { file }) };
  }
  async function copyBackup() {
    try {
      await navigator.clipboard.writeText(backupJson());
      bMsg = { ok: true, text: t('settings.data.backup.copied') };
    } catch (e) {
      bMsg = { ok: false, text: t('settings.data.backup.copyFailed', { error: String(e) }) };
    }
  }

  function loadBackupText(text: string) {
    bArmed = false;
    const r = parseBackup(text);
    if (!r.ok) { parsed = null; bMsg = { ok: false, text: r.error }; return; }
    parsed = r;
    mode = 'merge';
    picks = {
      settings: r.summary.hasSettings, hosts: r.summary.hosts > 0, accounts: r.summary.accounts > 0,
      themes: r.summary.themes > 0, workspaces: r.summary.workspaces > 0,
    };
    bMsg = null;
  }
  async function onBackupFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    if (f.size > MAX_BACKUP_BYTES) { parsed = null; bMsg = { ok: false, text: t('settings.data.backup.errTooBig', { mb: Math.round(MAX_BACKUP_BYTES / 1048576) }) }; return; }
    try { loadBackupText(await f.text()); } catch (err) { parsed = null; bMsg = { ok: false, text: t('settings.data.backup.errRead', { error: String(err) }) }; }
  }
  function discardBackup() { parsed = null; bText = ''; bArmed = false; }
  function setMode(m: 'merge' | 'replace') { mode = m; bArmed = false; }

  function applyBackup() {
    if (!parsed) return;
    if (mode === 'replace' && !bArmed) {
      bArmed = true;
      clearTimeout(bArmTimer);
      bArmTimer = window.setTimeout(() => (bArmed = false), 2800);
      return;
    }
    bArmed = false;
    const cur = app.backupState();
    const sections = $state.snapshot(parsed.sections);
    const chosen = $state.snapshot(picks);
    const { state, report } = (mode === 'merge' ? mergeBackup : replaceFromBackup)(cur, sections, chosen);
    // Reemplazar espacios de trabajo: sus terminales se cierran y las del archivo se lanzan al montarse (sin recargar la ventana).
    const closing = mode === 'replace' && chosen.workspaces && sections.workspaces.length ? cur.workspaces.flatMap((w) => w.panes.map((p) => p.id)) : [];
    app.applyBackupState(state, closing);
    const skipped = report.hostsSkipped + report.accountsSkipped + report.themesSkipped + report.workspacesSkipped;
    const vars = { hosts: report.hostsAdded, accounts: report.accountsAdded, themes: report.themesAdded, workspaces: report.workspacesAdded, panes: report.panesAdded, skipped };
    const head = t(mode === 'merge' ? 'settings.data.backup.doneMerge' : 'settings.data.backup.doneReplace', vars);
    bMsg = { ok: true, text: report.settings ? `${head} ${t('settings.data.backup.doneSettings')}` : head };
    discardBackup();
  }
  const sectionRows = $derived(parsed ? ([
    { id: 'settings', label: t('settings.data.backup.secSettings'), n: parsed.summary.hasSettings ? 1 : 0 },
    { id: 'hosts', label: t('settings.data.backup.secHosts', { n: parsed.summary.hosts }), n: parsed.summary.hosts },
    { id: 'accounts', label: t('settings.data.backup.secAccounts', { n: parsed.summary.accounts }), n: parsed.summary.accounts },
    { id: 'themes', label: t('settings.data.backup.secThemes', { n: parsed.summary.themes }), n: parsed.summary.themes },
    { id: 'workspaces', label: t('settings.data.backup.secWorkspaces', { n: parsed.summary.workspaces, panes: parsed.summary.panes }), n: parsed.summary.workspaces },
  ] as { id: BackupSection; label: string; n: number }[]) : []);
  const canApply = $derived(!!parsed && anyPicked(parsed.sections, picks));

  function resetAll() {
    if (!armed) {
      armed = true;
      clearTimeout(armTimer);
      armTimer = window.setTimeout(() => (armed = false), 2800);
      return;
    }
    armed = false;
    app.resetAllSettings();
    msg = { ok: true, text: t('settings.data.resetDone') };
  }
</script>

<div class="s-row stack">
  <div class="lbl"><b>{t('settings.data.stateLabel')}</b><small>{t('settings.data.stateHint')}</small></div>
  <div class="s-path"><code>{dir}{dir.includes('\\') ? '\\' : '/'}state.json</code></div> <!-- i18n-ignore: path -->
  <div class="s-actions">
    <button class="btn" onclick={() => be.openDataDir()}><Icon name="layers" size={13} /> {t('settings.data.openFolder')}</button>
    <button class="btn" onclick={copyJson}>{t('settings.data.copyJson')}</button>
  </div>
</div>

<h4 class="grp">{t('settings.data.backup.title')}</h4>
<p class="bk-hint">{t('settings.data.backup.hint')}</p>

<div class="s-row stack">
  <div class="lbl"><b>{t('settings.data.backup.exportLabel')}</b><small>{t('settings.data.backup.exportHint')}</small></div>
  <div class="s-actions">
    <button class="btn primary" onclick={saveBackup}>{t('settings.data.backup.save')}</button>
    <button class="btn" onclick={copyBackup}>{t('settings.data.backup.copy')}</button>
  </div>
  <small class="bk-note">{t('settings.data.backup.exportNote')}</small>
</div>

<div class="s-row stack">
  <div class="lbl"><b>{t('settings.data.backup.importLabel')}</b><small>{t('settings.data.backup.importHint')}</small></div>
  <div class="s-actions">
    <button class="btn" onclick={() => fileInput?.click()}>{t('settings.data.backup.chooseFile')}</button>
    <input bind:this={fileInput} type="file" accept=".json,application/json" hidden onchange={onBackupFile} />
  </div>
  <textarea rows="3" placeholder={t('settings.data.backup.pastePlaceholder')} bind:value={bText} spellcheck="false"></textarea>
  <div class="s-actions">
    <button class="btn" disabled={!bText.trim()} onclick={() => loadBackupText(bText)}>{t('settings.data.backup.read')}</button>
  </div>

  {#if parsed}
    <div class="bk-box">
      <b>{t('settings.data.backup.contains', { version: parsed.summary.appVersion, date: parsed.summary.exportedAt.slice(0, 10) || '?' })}</b>
      <div class="bk-checks">
        {#each sectionRows as r (r.id)}
          <label class="chk"><input type="checkbox" bind:checked={picks[r.id]} disabled={r.n === 0} /> {r.label}</label>
        {/each}
      </div>

      <b>{t('settings.data.backup.modeLabel')}</b>
      <div class="s-radios" role="radiogroup" aria-label={t('settings.data.backup.modeLabel')}>
        <button type="button" role="radio" aria-checked={mode === 'merge'} class:on={mode === 'merge'} onclick={() => setMode('merge')}>
          <span class="dot"></span>
          <span class="bk-t"><b>{t('settings.data.backup.modeMerge')}</b><small>{t('settings.data.backup.modeMergeHint')}</small></span>
        </button>
        <button type="button" role="radio" aria-checked={mode === 'replace'} class:on={mode === 'replace'} onclick={() => setMode('replace')}>
          <span class="dot"></span>
          <span class="bk-t"><b>{t('settings.data.backup.modeReplace')}</b><small>{t('settings.data.backup.modeReplaceHint')}</small></span>
        </button>
      </div>

      {#if picks.workspaces && parsed.summary.workspaces > 0}
        <p class="s-msg err" role="alert">{t('settings.data.backup.warnPanes')}</p>
      {/if}
      {#if picks.hosts && parsed.summary.hostsWithCommand > 0}
        <p class="s-msg err" role="alert">{t('settings.data.backup.warnHosts', { n: parsed.summary.hostsWithCommand })}</p>
      {/if}
      {#if parsed.summary.droppedPanes || parsed.summary.droppedHosts}
        <p class="bk-note">{t('settings.data.backup.dropped', { panes: parsed.summary.droppedPanes, hosts: parsed.summary.droppedHosts })}</p>
      {/if}

      <div class="s-actions">
        {#if mode === 'merge'}
          <button class="btn primary" disabled={!canApply} onclick={applyBackup}>{t('settings.data.backup.apply')}</button>
        {:else}
          <button class="btn danger" class:armed={bArmed} disabled={!canApply} onclick={applyBackup}>{bArmed ? t('settings.data.backup.applyConfirm') : t('settings.data.backup.applyReplace')}</button>
        {/if}
        <button class="btn" onclick={discardBackup}>{t('settings.data.backup.discard')}</button>
      </div>
    </div>
  {/if}
  {#if bMsg}<p class="s-msg" class:err={!bMsg.ok} role="status">{bMsg.text}</p>{/if}
</div>

<div class="s-row stack">
  <div class="lbl"><b>{t('settings.data.importLabel')}</b><small>{t('settings.data.importHint')}</small></div>
  <textarea rows="6" placeholder={IMPORT_EXAMPLE} bind:value={importText} spellcheck="false"></textarea>
  <div class="s-actions">
    <button class="btn primary" disabled={!importText.trim()} onclick={apply}>{t('settings.data.apply')}</button>
  </div>
</div>

{#if msg}<p class="s-msg" class:err={!msg.ok} role="status">{msg.text}</p>{/if}

<div class="s-row stack">
  <div class="lbl"><b>{t('settings.data.resetLabel')}</b><small>{t('settings.data.resetHint')}</small></div>
  <div class="s-actions">
    <button class="btn danger" class:armed onclick={resetAll}>{armed ? t('settings.data.resetConfirm') : t('settings.data.resetButton')}</button>
  </div>
</div>

<div class="s-about">
  <b>Orchestra</b> {APP_VERSION} <span>· {build}</span>
  <div class="s-credit">{t('settings.data.createdBy', { author: '@jonirulah' })}</div> <!-- i18n-ignore: handle -->
</div>

<style>
  .grp { margin: 18px 0 0; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .bk-hint { margin: 4px 0 0; color: var(--muted); font-size: 11.5px; }
  .bk-note { color: var(--muted); font-size: 11.5px; line-height: 1.4; margin: 0; }
  .bk-box { display: grid; gap: 10px; padding: 11px 13px; border-radius: 9px; border: 1px solid var(--border-strong); background: var(--panel-2); }
  .bk-checks { display: grid; gap: 6px; }
  .chk { display: flex; gap: 8px; align-items: center; color: var(--text); font-size: 12.5px; }
  .bk-t { display: grid; gap: 2px; }
  .bk-t small { color: var(--muted); font-size: 11.5px; line-height: 1.35; }
  .bk-box .s-msg { margin: 0; }
</style>
