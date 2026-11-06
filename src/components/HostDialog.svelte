<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '../lib/store.svelte.ts';
  import { t } from '../lib/i18n.ts';
  import * as be from '../lib/backend.ts';
  import { ACCOUNT_COLORS, hostSecretKey } from '../lib/model.ts';
  import type { Host } from '../lib/model.ts';

  let h = $state<Host>({ ...app.hostDialog!, tags: [...app.hostDialog!.tags] });
  let tagsText = $state(h.tags.join(', '));
  const exists = $derived(app.hosts.some((x) => x.id === h.id));
  const valid = $derived(h.host.trim().length > 0);

  // ---- acceso (contraseña / clave): la interfaz solo ESCRIBE secretos, jamás los lee ----
  let keys = $state<be.SshKeyInfo[]>([]);
  let newSecret = $state('');          // lo que se está tecleando; se envía a la bóveda al guardar
  let clearSaved = $state(false);      // «Clear saved secret» pulsado: se borra al guardar
  let usePickedPass = $state(false);   // copiar la passphrase guardada de la clave elegida
  let busy = $state(false);
  let error = $state('');
  const kind = $derived(h.authMethod === 'password' ? 'password' : 'passphrase');
  const hasSaved = $derived(!clearSaved && (kind === 'password' ? !!h.hasPassword : !!h.hasPassphrase));
  const privKeys = $derived(keys.filter((k) => k.hasPrivate && k.privatePath));
  const picked = $derived(keys.find((k) => k.privatePath && k.privatePath === h.identityFile?.trim()));

  onMount(() => { void be.sshKeysList().then((k) => (keys = k)).catch(() => {}); });

  function pickKey(path: string) { h.identityFile = path || undefined; usePickedPass = false; }
  function clearSecret() { clearSaved = true; newSecret = ''; usePickedPass = false; }

  /** Aplica los cambios de secretos en la bóveda y actualiza las banderas. */
  async function syncSecrets(): Promise<void> {
    const pwKey = hostSecretKey(h.id, 'password');
    const ppKey = hostSecretKey(h.id, 'passphrase');
    // Un método que ya no se usa no deja secretos huérfanos.
    if (h.authMethod !== 'password' && h.hasPassword) { await be.secretDelete(pwKey); h.hasPassword = false; }
    if (h.authMethod !== 'key' && h.hasPassphrase) { await be.secretDelete(ppKey); h.hasPassphrase = false; }
    if (h.authMethod === 'agent') return;
    const key = h.authMethod === 'password' ? pwKey : ppKey;
    const flag = h.authMethod === 'password' ? 'hasPassword' : 'hasPassphrase';
    if (clearSaved && !newSecret) { await be.secretDelete(key); h[flag] = false; }
    if (newSecret) { await be.secretSet(key, newSecret); h[flag] = true; }
    else if (usePickedPass && picked) { await be.secretCopy(`key:${picked.name}:passphrase`, key); h[flag] = true; }
    newSecret = '';
  }

  async function save() {
    if (!valid || busy) return;
    busy = true;
    error = '';
    try {
      await syncSecrets();
    } catch (e) {
      error = String(e);
      busy = false;
      return;
    }
    busy = false;
    h.tags = tagsText.split(',').map((s) => s.trim()).filter(Boolean);
    const clean: Host = {
      ...h,
      name: h.name.trim() || h.host.trim(),
      host: h.host.trim(),
      user: h.user?.trim() || undefined,
      group: h.group?.trim() || undefined,
      identityFile: h.identityFile?.trim() || undefined,
      proxyJump: h.proxyJump?.trim() || undefined,
      command: h.command?.trim() || undefined,
      port: h.port ? Number(h.port) : undefined,
      hostKeyPolicy: h.hostKeyPolicy === 'confirm' || h.hostKeyPolicy === 'accept-new' ? h.hostKeyPolicy : undefined,
    };
    app.saveHost(clean);
    app.hostDialog = null;
  }
  function remove() { app.deleteHost(h.id); app.hostDialog = null; }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') app.hostDialog = null; }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-back" onpointerdown={(e) => { if (e.target === e.currentTarget) app.hostDialog = null; }}>
  <div class="modal">
    <h2>{exists ? t('host.dialog.titleEdit') : t('host.dialog.titleNew')}</h2>
    <div class="body">
      <div class="row2">
        <label class="field"><span>{t('host.dialog.nameLabel')}</span><input bind:value={h.name} placeholder={t('host.dialog.namePlaceholder')} /></label>
        <label class="field"><span>{t('host.dialog.groupLabel')}</span><input bind:value={h.group} placeholder={t('host.dialog.groupPlaceholder')} /></label>
      </div>
      <div class="row2">
        <label class="field"><span>{t('host.dialog.hostLabel')}</span><input bind:value={h.host} placeholder={t('host.dialog.hostPlaceholder')} /></label>
        <div class="row2">
          <label class="field"><span>{t('host.dialog.userLabel')}</span><input bind:value={h.user} placeholder="root" /></label> <!-- i18n-ignore: example value -->
          <label class="field"><span>{t('host.dialog.portLabel')}</span><input type="number" bind:value={h.port} placeholder="22" /></label>
        </div>
      </div>
      <div class="auth">
        <label class="field"><span>{t('host.dialog.authLabel')}</span>
          <select bind:value={h.authMethod} onchange={() => { newSecret = ''; clearSaved = false; usePickedPass = false; }}>
            <option value="agent">{t('host.dialog.authAgent')}</option>
            <option value="key">{t('host.dialog.authKey')}</option>
            <option value="password">{t('host.dialog.authPassword')}</option>
          </select>
        </label>
        {#if h.authMethod === 'key' || h.authMethod === 'agent'}
          <label class="field"><span>{h.authMethod === 'agent' ? t('host.dialog.keyPathOptionalLabel') : t('host.dialog.keyPathLabel')}</span>
            <input bind:value={h.identityFile} placeholder="C:\Users\you\.ssh\id_ed25519" /> <!-- i18n-ignore: example path -->
          </label>
        {/if}
        {#if h.authMethod === 'key' && privKeys.length}
          <label class="field"><span>{t('host.dialog.browseKeysLabel')}</span>
            <select value={picked?.privatePath ?? ''} onchange={(e) => pickKey((e.target as HTMLSelectElement).value)}>
              <option value="">{t('host.dialog.pickKey')}</option>
              {#each privKeys as k (k.name)}
                <option value={k.privatePath}>{k.name} · {k.keyType}{k.bits ? ' ' + k.bits : ''}{k.comment ? ' · ' + k.comment : ''}</option>
              {/each}
            </select>
          </label>
        {/if}
        {#if h.authMethod !== 'agent'}
          <div class="field secret">
            <span>{h.authMethod === 'password' ? t('host.dialog.secretPasswordLabel') : t('host.dialog.secretPassphraseLabel')}</span>
            {#if hasSaved}
              <div class="saved"><span class="badge">{t('host.dialog.savedBadge')}</span>
                <button type="button" class="btn ghost" onclick={clearSecret}>{t('host.dialog.clearSecret')}</button></div>
            {:else}
              <input type="password" autocomplete="new-password" spellcheck="false" bind:value={newSecret}
                placeholder={clearSaved ? t('host.dialog.secretClearedPlaceholder') : h.authMethod === 'password' ? t('host.dialog.passwordPlaceholder') : t('host.dialog.passphrasePlaceholder')} />
              {#if h.authMethod === 'key' && picked?.hasSavedPassphrase}
                <label class="chk small"><input type="checkbox" bind:checked={usePickedPass} /> {t('host.dialog.usePickedPassphrase', { name: picked.name })}</label>
              {/if}
            {/if}
            <span class="hint">{t('host.dialog.secretHint')}</span>
          </div>
        {/if}
        {#if h.authMethod !== 'agent' && (hasSaved || newSecret || usePickedPass)}
          <label class="field"><span>{t('host.dialog.hostKeyLabel')}</span>
            <select value={h.hostKeyPolicy ?? 'default'} onchange={(e) => { const v = (e.target as HTMLSelectElement).value; h.hostKeyPolicy = v === 'confirm' || v === 'accept-new' ? v : undefined; }}>
              <option value="default">{app.settings.sshHostKeyPolicy === 'confirm' ? t('host.dialog.hostKeyDefaultConfirm') : t('host.dialog.hostKeyDefaultAccept')}</option>
              <option value="confirm">{t('host.dialog.hostKeyConfirm')}</option>
              <option value="accept-new">{t('host.dialog.hostKeyAccept')}</option>
            </select>
            <span class="hint">{t('host.dialog.hostKeyHint')}</span>
          </label>
        {/if}
        {#if error}<p class="err" role="alert">{error}</p>{/if}
      </div>
      <div class="row2">
        <label class="field"><span>{t('host.dialog.jumpLabel')}</span><input bind:value={h.proxyJump} placeholder="user@bastion" /></label> <!-- i18n-ignore: example value -->
        <label class="field"><span>{t('host.dialog.tagsLabel')}</span><input bind:value={tagsText} placeholder={t('host.dialog.tagsPlaceholder')} /></label>
      </div>
      <label class="field"><span>{t('host.dialog.commandLabel')}</span><input bind:value={h.command} placeholder="cd /srv/app && bash -l" /></label> <!-- i18n-ignore: example command -->
      <label class="chk"><input type="checkbox" bind:checked={h.tmux} /> {@html t('host.dialog.tmuxLabel')}</label>
      <label class="chk"><input type="checkbox" bind:checked={h.remoteMetrics} /> {t('host.dialog.remoteMetricsLabel')}</label>
      <span class="hint">{t('host.dialog.remoteMetricsHint')}</span>
      <div class="field"><span>{t('host.dialog.colorLabel')}</span>
        <div class="colors">
          <button class="sw none" class:on={!h.color} onclick={() => (h.color = undefined)} title={t('host.dialog.noColorTitle')}>∅</button>
          {#each ACCOUNT_COLORS as c (c)}
            <button class="sw" class:on={h.color === c} style:background={c} onclick={() => (h.color = c)} aria-label={c}></button>
          {/each}
        </div>
      </div>
      <label class="field"><span>{t('host.dialog.notesLabel')}</span><textarea rows="2" bind:value={h.notes} placeholder={t('host.dialog.notesPlaceholder')}></textarea></label>
      <label class="field"><span>{t('host.dialog.accessLabel')}</span>
        <select bind:value={h.agentAccess}>
          <option value="none">{t('host.dialog.accessNone')}</option>
          <option value="read">{t('host.dialog.accessRead')}</option>
          <option value="ask">{t('host.dialog.accessAsk')}</option>
          <option value="full">{t('host.dialog.accessFull')}</option>
        </select>
        <span class="hint">{t('host.dialog.accessHint')}</span>
      </label>
    </div>
    <div class="foot">
      {#if exists}<button class="btn ghost" style="margin-right:auto;color:var(--bad)" onclick={remove}>{t('host.dialog.delete')}</button>{/if}
      <button class="btn ghost" onclick={() => (app.hostDialog = null)}>{t('host.dialog.cancel')}</button>
      <button class="btn primary" disabled={!valid || busy} onclick={save}>{t('host.dialog.save')}</button>
    </div>
  </div>
</div>

<style>
  .chk { display: flex; gap: 8px; align-items: center; color: var(--text); }
  .colors { display: flex; gap: 7px; }
  .sw { width: 22px; height: 22px; border-radius: 6px; border: 2px solid transparent; }
  .sw.on { border-color: #fff; }
  .sw.none { background: var(--bg); border: 1px solid var(--border-strong); color: var(--muted); }
  .sw.none.on { border-color: #fff; }
  select { width: 100%; }
  .auth { display: grid; gap: 8px; padding: 8px 10px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--border); }
  .saved { display: flex; align-items: center; gap: 10px; }
  .badge { color: var(--ok, #8fcf7a); font-size: 12px; }
  .chk.small { font-size: 12px; color: var(--muted); }
  .err { color: var(--bad); font-size: 12px; margin: 0; }
  .btn:disabled { opacity: 0.4; pointer-events: none; }
</style>
