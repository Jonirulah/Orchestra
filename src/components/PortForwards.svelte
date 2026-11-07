<script lang="ts">
  // Reenvío de puertos: mantiene los túneles al día con los paneles (sync), enseña el aviso de «puerto detectado» y el
  // diálogo «Reenviar un puerto…». La lista de cada host está en PortsChip.svelte (cabecera del panel SSH).
  import { app } from '../lib/store.svelte.ts';
  import { forwards } from '../lib/forwards.svelte.ts';
  import { parsePort } from '../lib/portdetect.ts';
  import { t } from '../lib/i18n.ts';
  import Icon from './Icon.svelte';

  $effect(() => { forwards.sync(app.workspaces, app.hosts, app.live); });

  // ---------- diálogo ----------
  let remote = $state('');
  let local = $state('');
  let save = $state(false);
  let openIt = $state(true);
  let lastNonce: object | null = null;
  $effect(() => {
    const d = forwards.dialog;
    if (d && d !== lastNonce) { lastNonce = d; remote = d.remote ? String(d.remote) : ''; local = ''; save = false; openIt = true; }
  });
  const rPort = $derived(parsePort(remote));
  const lPort = $derived(local.trim() ? parsePort(local) : null);
  const localBad = $derived(local.trim() !== '' && lPort === null);
  const canGo = $derived(rPort !== null && !localBad);
  const dlgHost = $derived(forwards.dialog ? forwards.host(forwards.dialog.hostId) : undefined);

  function go(): void {
    const d = forwards.dialog;
    if (!d || rPort === null || localBad) return;
    forwards.dialog = null;
    void forwards.forward(d.hostId, rPort, { ...(lPort ? { local: lPort } : {}), open: openIt, save });
  }
  function focusMe(el: HTMLElement) { el.focus(); }
</script>

<svelte:window onkeydown={(e) => { if (forwards.dialog && e.key === 'Escape') { e.preventDefault(); forwards.dialog = null; } }} />

{#if forwards.notices.length}
  <div class="pnotes" role="status" aria-live="polite">
    {#each forwards.notices as n (n.key)}
      <div class="pn" data-testid="port-notice">
        <span class="ico"><Icon name="tunnel" size={15} /></span>
        <span class="txt"><b>{n.hostName}</b><span>{t('ports.notice.text', { port: n.port })}</span></span>
        <button class="btn primary sm" onclick={() => void forwards.forward(n.hostId, n.port, { open: true })}>{t('ports.notice.open')}</button>
        <button class="btn sm" onclick={() => void forwards.forward(n.hostId, n.port)}>{t('ports.notice.forward')}</button>
        <button class="btn ghost sm" onclick={() => forwards.dismiss(n.key)}>{t('ports.notice.ignore')}</button>
      </div>
    {/each}
  </div>
{/if}

{#if forwards.dialog && dlgHost}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-back" onpointerdown={(e) => { if (e.target === e.currentTarget) forwards.dialog = null; }}>
    <div class="modal fwd" role="dialog" aria-modal="true" aria-label={t('ports.dialog.title')}><form class="fwdf" onsubmit={(e) => { e.preventDefault(); go(); }}>
      <h2>{t('ports.dialog.title')}</h2>
      <div class="body">
        <p class="hint">{t('ports.dialog.hint', { host: dlgHost.name || dlgHost.host })}</p>
        <div class="row2">
          <label class="fld"><span>{t('ports.dialog.remote')}</span>
            <input use:focusMe inputmode="numeric" placeholder="3000" bind:value={remote} aria-invalid={remote.trim() !== '' && rPort === null} />
          </label>
          <span class="arrow">→</span>
          <label class="fld"><span>{t('ports.dialog.local')}</span>
            <input inputmode="numeric" placeholder={rPort ? String(rPort) : t('ports.dialog.localSame')} bind:value={local} aria-invalid={localBad} />
          </label>
        </div>
        <p class="sub">{t('ports.dialog.localHint')}</p>
        <label class="chk"><input type="checkbox" bind:checked={openIt} /> {t('ports.dialog.open')}</label>
        <label class="chk"><input type="checkbox" bind:checked={save} /> {t('ports.dialog.save')}</label>
      </div>
      <div class="foot">
        <button type="button" class="btn ghost" onclick={() => (forwards.dialog = null)}>{t('ports.dialog.cancel')}</button>
        <button type="submit" class="btn primary" disabled={!canGo}>{t('ports.dialog.go')}</button>
      </div>
    </form></div>
  </div>
{/if}

<style>
  .pnotes { position: fixed; right: 16px; bottom: 34px; z-index: 60; display: flex; flex-direction: column; gap: 8px; max-width: min(560px, calc(100vw - 32px)); }
  .pn {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 12px; border-radius: 10px;
    background: var(--panel-2); border: 1px solid var(--border-strong); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45); font-size: 12.5px;
  }
  .ico { color: var(--accent); display: inline-flex; }
  .txt { display: flex; gap: 6px; align-items: baseline; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .txt b { font-weight: 600; }
  .txt span { color: var(--muted); }
  .btn.sm { padding: 4px 9px; font-size: 12px; }
  .fwd { width: min(440px, 92vw); }
  .fwdf { display: contents; }
  .row2 { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 10px; align-items: end; }
  .fld { display: grid; gap: 5px; font-size: 12px; color: var(--muted); }
  .fld { min-width: 0; }
  .fld input { font: 13px 'Cascadia Mono', Consolas, monospace; width: 100%; min-width: 0; box-sizing: border-box; }
  .fld input[aria-invalid='true'] { border-color: var(--bad); }
  .arrow { color: var(--faint); padding-bottom: 7px; }
  .hint { margin: 0 0 4px; font-size: 12.5px; color: var(--text); }
  .sub { margin: 0; font-size: 11.5px; color: var(--muted); }
  .chk { display: flex; gap: 8px; align-items: center; font-size: 12.5px; }
</style>
