<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '../lib/store.svelte.ts';
  import { t } from '../lib/i18n.ts';
  import * as be from '../lib/backend.ts';
  import Icon from './Icon.svelte';
  import Toggle from './Toggle.svelte';
  import Slider from './Slider.svelte';
  import Seg from './Seg.svelte';
  import { sftpPick } from '../lib/sftpbackend.ts';
  import { LIMITS } from '../lib/settings.ts';
  import type { Settings } from '../lib/settings.ts';
  import type { ReconnectCodes } from '../lib/reconnect.ts';
  import type { HostKeyPolicy } from '../lib/model.ts';

  let { onclose }: { onclose: () => void } = $props();

  const s = $derived(app.settings);
  type NumKey = keyof typeof LIMITS & keyof Settings;
  interface NumRow { key: NumKey; label: string; hint: string; unit: string; step?: number; digits?: number }
  /** Reconexión automática: números ajustables (se enseñan con el ajuste encendido). */
  const reconnectRows: NumRow[] = $derived([
    { key: 'sshReconnectMaxAttempts', label: t('settings.keys.reconnectAttemptsLabel'), hint: t('settings.keys.reconnectAttemptsHint'), unit: '' },
    { key: 'sshReconnectFirstDelaySec', label: t('settings.keys.reconnectFirstLabel'), hint: t('settings.keys.reconnectFirstHint'), unit: ' s' },
    { key: 'sshReconnectFactor', label: t('settings.keys.reconnectFactorLabel'), hint: t('settings.keys.reconnectFactorHint'), unit: '×', step: 0.1, digits: 1 },
    { key: 'sshReconnectMaxDelaySec', label: t('settings.keys.reconnectMaxDelayLabel'), hint: t('settings.keys.reconnectMaxDelayHint'), unit: ' s' },
    { key: 'sshReconnectMinUpSec', label: t('settings.keys.reconnectMinUpLabel'), hint: t('settings.keys.reconnectMinUpHint'), unit: ' s' },
  ]);
  const latencyRows: NumRow[] = $derived([
    { key: 'latencyIntervalSec', label: t('settings.keys.latencyIntervalLabel'), hint: t('settings.keys.latencyIntervalHint'), unit: ' s' },
    { key: 'latencyTimeoutSec', label: t('settings.keys.latencyTimeoutLabel'), hint: t('settings.keys.latencyTimeoutHint'), unit: ' s' },
    { key: 'latencyWarnMs', label: t('settings.keys.latencyWarnLabel'), hint: t('settings.keys.latencyWarnHint'), unit: ' ms' },
    { key: 'latencyBadMs', label: t('settings.keys.latencyBadLabel'), hint: t('settings.keys.latencyBadHint'), unit: ' ms' },
    { key: 'latencySamples', label: t('settings.keys.latencySamplesLabel'), hint: t('settings.keys.latencySamplesHint'), unit: '' },
    { key: 'latencyFailsBad', label: t('settings.keys.latencyFailsLabel'), hint: t('settings.keys.latencyFailsHint'), unit: '' },
  ]);
  const codeOptions: { id: ReconnectCodes; label: string }[] = $derived([
    { id: 'nonzero', label: t('settings.keys.reconnectCodesAny') },
    { id: '255', label: t('settings.keys.reconnectCodes255') },
  ]);

  const POLICY_CARDS: { id: HostKeyPolicy; title: string; hint: string }[] = $derived([
    { id: 'confirm', title: t('settings.keys.policyConfirmTitle'), hint: t('settings.keys.policyConfirmHint') },
    { id: 'accept-new', title: t('settings.keys.policyAcceptTitle'), hint: t('settings.keys.policyAcceptHint') },
  ]);

  let keys = $state<be.SshKeyInfo[]>([]);
  let loading = $state(true);
  let msg = $state<{ ok: boolean; text: string } | null>(null);
  /** Host elegido para «Install on server», por clave. */
  let target = $state<Record<string, string>>({});

  // Formulario «Generate»
  let name = $state('');
  let comment = $state('');
  let pass = $state('');
  let savePass = $state(false);
  let busy = $state(false);
  const nameOk = $derived(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(name) && !name.endsWith('.pub'));

  async function load() {
    loading = true;
    try { keys = await be.sshKeysList(); } catch (e) { msg = { ok: false, text: String(e) }; }
    loading = false;
  }
  onMount(() => { void load(); });

  async function generate() {
    if (!nameOk || busy) return;
    busy = true;
    msg = null;
    try {
      const k = await be.sshKeygen(name, comment.trim(), pass || undefined, savePass && !!pass);
      msg = { ok: true, text: t('settings.keys.createdMsg', { name: k.name, type: k.keyType }) };
      name = ''; comment = ''; pass = ''; savePass = false;
      await load();
    } catch (e) {
      msg = { ok: false, text: String(e) };
    } finally {
      busy = false;
      pass = '';
    }
  }

  async function copyPub(k: be.SshKeyInfo) {
    try {
      await be.copyText(k.publicKey);
      msg = { ok: true, text: t('settings.keys.copiedMsg', { name: k.name }) };
    } catch (e) {
      msg = { ok: false, text: t('settings.keys.copyFailedMsg', { error: String(e) }) };
    }
  }
  function install(k: be.SshKeyInfo) {
    const hostId = target[k.name];
    if (!hostId) return;
    app.open({ kind: 'sshinstall', hostId, pubPath: k.pubPath });
    onclose();
  }
  async function reveal(k: be.SshKeyInfo) {
    try { await be.sshKeyReveal(k.name); } catch (e) { msg = { ok: false, text: String(e) }; }
  }
  async function forget(k: be.SshKeyInfo) {
    try {
      await be.sshKeyForgetPassphrase(k.name);
      msg = { ok: true, text: t('settings.keys.forgottenMsg', { name: k.name }) };
      await load();
    } catch (e) { msg = { ok: false, text: String(e) }; }
  }
</script>

<div class="s-row stack">
  <div class="lbl">
    <b>{t('settings.keys.policyLabel')}</b>
    <small>{t('settings.keys.policyHint')}</small>
  </div>
  <div class="s-radios" role="radiogroup" aria-label={t('settings.keys.policyAria')}>
    {#each POLICY_CARDS as c (c.id)}
      <button type="button" role="radio" aria-checked={app.settings.sshHostKeyPolicy === c.id} class:on={app.settings.sshHostKeyPolicy === c.id}
        onclick={() => app.setting('sshHostKeyPolicy', c.id)}>
        <span class="dot"></span>
        <span class="t"><b>{c.title}</b><small>{c.hint}</small></span>
      </button>
    {/each}
  </div>
</div>

<h4 class="grp">{t('files.set.title')}</h4>
<div class="s-row">
  <div class="lbl"><b>{t('files.set.dirLabel')}</b><small>{s.sftpDownloadDir || t('files.set.dirDefault')}</small></div>
  <div class="ctl">
    <button type="button" class="btn" onclick={async () => { const p = await sftpPick(true); if (p[0]) app.setting('sftpDownloadDir', p[0]); }}>{t('files.set.choose')}</button>
    {#if s.sftpDownloadDir}<button type="button" class="btn" onclick={() => app.setting('sftpDownloadDir', '')}>{t('files.set.reset')}</button>{/if}
  </div>
</div>
<div class="s-row">
  <div class="lbl"><b>{t('files.set.askLabel')}</b><small>{t('files.set.askHint')}</small></div>
  <div class="ctl"><Toggle value={s.sftpAskDownload} label={t('files.set.askLabel')} onchange={(v) => app.setting('sftpAskDownload', v)} /></div>
</div>

<h4 class="grp">{t('ports.set.title')}</h4>
<div class="s-row">
  <div class="lbl"><b>{t('ports.set.detectLabel')}</b><small>{t('ports.set.detectHint')}</small></div>
  <div class="ctl"><Toggle value={s.portsDetect} label={t('ports.set.detectLabel')} onchange={(v) => app.setting('portsDetect', v)} /></div>
</div>
{#if s.portsDetect}
  <div class="s-row">
    <div class="lbl"><b>{t('ports.set.autoOpenLabel')}</b><small>{t('ports.set.autoOpenHint')}</small></div>
    <div class="ctl"><Toggle value={s.portsAutoOpen} label={t('ports.set.autoOpenLabel')} onchange={(v) => app.setting('portsAutoOpen', v)} /></div>
  </div>
{/if}

<h4 class="grp">{t('settings.keys.reconnectTitle')}</h4>
<div class="s-row">
  <div class="lbl"><b>{t('settings.keys.reconnectLabel')}</b><small>{t('settings.keys.reconnectHint')}</small></div>
  <div class="ctl"><Toggle value={s.sshAutoReconnect} label={t('settings.keys.reconnectLabel')} onchange={(v) => app.setting('sshAutoReconnect', v)} /></div>
</div>
{#if s.sshAutoReconnect}
  {#each reconnectRows as r (r.key)}
    <div class="s-row">
      <div class="lbl"><b>{r.label}</b><small>{r.hint}</small></div>
      <div class="ctl"><Slider value={s[r.key]} min={LIMITS[r.key][0]} max={LIMITS[r.key][1]} step={r.step ?? 1} digits={r.digits ?? 0} unit={r.unit} onchange={(v) => app.setting(r.key, v)} /></div>
    </div>
  {/each}
  <div class="s-row">
    <div class="lbl"><b>{t('settings.keys.reconnectCodesLabel')}</b><small>{t('settings.keys.reconnectCodesHint')}</small></div>
    <div class="ctl"><Seg options={codeOptions} value={s.sshReconnectCodes} onchange={(id) => app.setting('sshReconnectCodes', id)} /></div>
  </div>
  <div class="s-row">
    <div class="lbl"><b>{t('settings.keys.reconnectFlashLabel')}</b><small>{t('settings.keys.reconnectFlashHint')}</small></div>
    <div class="ctl"><Toggle value={s.sshReconnectFlash} label={t('settings.keys.reconnectFlashLabel')} onchange={(v) => app.setting('sshReconnectFlash', v)} /></div>
  </div>
{/if}

<h4 class="grp">{t('settings.keys.latencyTitle')}</h4>
<div class="s-row">
  <div class="lbl"><b>{t('settings.keys.latencyLabel')}</b><small>{t('settings.keys.latencyHint')}</small></div>
  <div class="ctl"><Toggle value={s.latencyBadge} label={t('settings.keys.latencyLabel')} onchange={(v) => app.setting('latencyBadge', v)} /></div>
</div>
{#if s.latencyBadge}
  {#each latencyRows as r (r.key)}
    <div class="s-row">
      <div class="lbl"><b>{r.label}</b><small>{r.hint}</small></div>
      <div class="ctl"><Slider value={s[r.key]} min={LIMITS[r.key][0]} max={LIMITS[r.key][1]} step={r.step ?? 1} digits={r.digits ?? 0} unit={r.unit} onchange={(v) => app.setting(r.key, v)} /></div>
    </div>
  {/each}
  <div class="s-row">
    <div class="lbl"><b>{t('settings.keys.latencyUnitLabel')}</b><small>{t('settings.keys.latencyUnitHint')}</small></div>
    <div class="ctl"><Toggle value={s.latencyShowUnit} label={t('settings.keys.latencyUnitLabel')} onchange={(v) => app.setting('latencyShowUnit', v)} /></div>
  </div>
{/if}

<div class="s-row stack">
  <div class="lbl"><b>{t('settings.keys.listLabel')}</b><small>{t('settings.keys.listHint')}</small></div>
  {#if loading}
    <p class="hint">{t('settings.keys.loading')}</p>
  {:else if !keys.length}
    <p class="hint">{@html t('settings.keys.empty')}</p>
  {/if}
  {#each keys as k (k.name)}
    <div class="key">
      <div class="top">
        <b>{k.name}</b>
        <span class="tag">{k.keyType}{k.bits ? ' ' + k.bits : ''}</span>
        {#if !k.hasPrivate}<span class="tag warn" title={t('settings.keys.noPrivateTitle')}>{t('settings.keys.noPrivateTag')}</span>{/if}
        {#if k.hasSavedPassphrase}<span class="tag ok" title={t('settings.keys.passSavedTitle')}>{t('settings.keys.passSavedTag')}</span>{/if}
      </div>
      <div class="fp"><code>{k.fingerprint || t('settings.keys.fingerprintUnavailable')}</code>{#if k.comment} · <span>{k.comment}</span>{/if}</div>
      <div class="s-actions">
        <button class="btn" onclick={() => copyPub(k)}>{t('settings.keys.copyPublic')}</button>
        <button class="btn" onclick={() => reveal(k)}>{t('settings.keys.reveal')}</button>
        {#if k.hasSavedPassphrase}<button class="btn ghost" onclick={() => forget(k)}>{t('settings.keys.forgetPassphrase')}</button>{/if}
      </div>
      <div class="s-actions">
        <select aria-label={t('settings.keys.installAria')} bind:value={target[k.name]}>
          <option value="">{t('settings.keys.installPlaceholder')}</option>
          {#each app.hosts as h (h.id)}<option value={h.id}>{h.name || h.host}</option>{/each}
        </select>
        <button class="btn primary" disabled={!target[k.name]} onclick={() => install(k)}
          title={t('settings.keys.installTitle')}>{t('settings.keys.install')}</button>
      </div>
    </div>
  {/each}
</div>

<div class="s-row stack">
  <div class="lbl"><b>{t('settings.keys.generateLabel')}</b><small>{t('settings.keys.generateHint')}</small></div>
  <div class="form">
    <label class="field"><span>{t('settings.keys.fileNameLabel')}</span><input bind:value={name} placeholder="id_ed25519_work" spellcheck="false" /></label> <!-- i18n-ignore: example file name -->
    <label class="field"><span>{t('settings.keys.commentLabel')}</span><input bind:value={comment} placeholder="you@laptop" spellcheck="false" /></label> <!-- i18n-ignore: example value -->
    <label class="field"><span>{t('settings.keys.passphraseLabel')}</span>
      <input type="password" autocomplete="new-password" spellcheck="false" bind:value={pass} placeholder={t('settings.keys.passphrasePlaceholder')} />
    </label>
    <label class="chk"><input type="checkbox" bind:checked={savePass} disabled={!pass} /> {t('settings.keys.savePassphrase')}</label>
  </div>
  {#if name && !nameOk}<p class="s-msg err">{t('settings.keys.nameInvalid')}</p>{/if}
  <div class="s-actions">
    <button class="btn primary" disabled={!nameOk || busy} onclick={generate}><Icon name="plus" size={13} /> {t('settings.keys.generate')}</button>
    <button class="btn ghost" onclick={load}><Icon name="refresh" size={13} /> {t('settings.keys.refresh')}</button>
  </div>
</div>

{#if msg}<p class="s-msg" class:err={!msg.ok} role="status">{msg.text}</p>{/if}

<style>
  .grp { margin: 18px 0 0; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .key { display: grid; gap: 6px; padding: 9px 11px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--border); }
  .top { display: flex; align-items: center; gap: 8px; }
  .tag { font-size: 10.5px; padding: 1px 7px; border-radius: 9px; background: var(--raise); color: var(--muted); }
  .tag.ok { color: var(--ok); }
  .tag.warn { color: var(--bad); }
  .fp { color: var(--muted); font-size: 11.5px; overflow-wrap: anywhere; }
  .form { display: grid; gap: 8px; }
  .chk { display: flex; gap: 8px; align-items: center; color: var(--text); font-size: 12px; }
  select { max-width: 320px; }
  .btn:disabled { opacity: 0.4; pointer-events: none; }
</style>
