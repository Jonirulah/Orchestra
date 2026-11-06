<script lang="ts">
  import { app } from '../lib/store.svelte.ts';
  import { statusText, statusTone } from '../lib/usageQuery.ts';
  import type { UsageResult } from '../lib/usageQuery.ts';
  import { onMount } from 'svelte';
  import { ACCOUNT_COLORS, providerLabel, providerOf } from '../lib/model.ts';
  import type { Account } from '../lib/model.ts';
  import { statusLabel, statusTone as loginTone } from '../lib/providers.ts';
  import { t } from '../lib/i18n.ts';
  import Icon from './Icon.svelte';
  import { ctxmenu } from '../lib/ctxmenu.svelte.ts';
  import { isMenuKey } from '../lib/ctxmenu.ts';
  import { accountMenuFor } from '../lib/ctxaccount.ts';
  import UsageBars from './UsageBars.svelte';
  import { buildAccountView } from '../lib/accountview.ts';
  import type { AccountsSort } from '../lib/accountview.ts';
  import Seg from './Seg.svelte';
  import Toggle from './Toggle.svelte';

  let { onclose }: { onclose: () => void } = $props();

  // Al abrir Ajustes → Cuentas se pregunta (como mucho cada 30 s por cuenta) si Codex / opencode tienen sesión.
  onMount(() => { void app.refreshProviderStatus(); });
  const hasOther = $derived(app.accounts.some((a) => providerOf(a) !== 'claude'));
  // Mismo orden y agrupación que la barra lateral; el filtro por proveedor NO se aplica aquí (esta pantalla gestiona todas las cuentas).
  const sections = $derived(buildAccountView(
    app.accounts,
    { filter: 'all', sort: app.settings.accountsSort, group: app.settings.accountsGroup },
    { quota: app.quota, now: app.nowSec, hasDefaultCodex: true, specialRows: false, emailOf: (a) => app.profileOf(a)?.email },
  ));

  let armed = $state<string | null>(null);
  let armTimer: number | undefined;
  let busy = $state(false);

  function remove(id: string) {
    if (armed === id) { armed = null; app.removeAccount(id); return; }
    armed = id;
    clearTimeout(armTimer);
    armTimer = window.setTimeout(() => (armed = null), 2600);
  }
  function rename(id: string, ev: Event) {
    const el = ev.currentTarget as HTMLInputElement;
    app.renameAccount(id, el.value);
    el.value = app.accountById(id)?.name ?? el.value;
  }
  function setColor(id: string, c: string) {
    const a = app.accountById(id);
    if (a) { a.color = c; app.persist(); }
  }
  function openClaude(id: string) {
    app.open({ kind: 'claude', accountId: id });
    onclose();
  }
  function openAccount(id: string, login = false) {
    app.open({ kind: 'account', accountId: id, login });
    onclose();
  }
  // «Probar ahora»: una consulta de esa cuenta, con el resultado a la vista.
  let testing = $state<string | null>(null);
  let tested = $state<Record<string, UsageResult | undefined>>({});
  async function testNow(id: string) {
    testing = id;
    try {
      const r = await app.testUsage(id);
      tested[id] = r.find((x) => x.accountId === id);
    } finally {
      testing = null;
    }
  }
  const pct = (w?: { used: number }) => (w ? t('settings.usage.testPct', { pct: Math.round(w.used) }) : t('settings.usage.testNoData'));
  /** Menú contextual de la cabecera de la tarjeta: lo mismo que en la barra lateral; «Rename» enfoca el campo del nombre. */
  function cardMenu(a: Account, head: HTMLElement) {
    const sig = providerOf(a) !== 'claude';
    return accountMenuFor(a, () => { const el = head.querySelector<HTMLInputElement>('input.name'); el?.focus(); el?.select(); }, {
      openTerminal: () => (sig ? openAccount(a.id) : openClaude(a.id)),
      signIn: () => (sig ? openAccount(a.id, true) : openClaude(a.id)),
    });
  }
  function headCtx(ev: MouseEvent, a: Account) {
    const head = ev.currentTarget as HTMLElement;
    ctxmenu.openFromEvent(ev, cardMenu(a, head), head);
  }
  function headKey(ev: KeyboardEvent, a: Account) {
    if (!isMenuKey(ev)) return;
    ev.preventDefault();
    const head = ev.currentTarget as HTMLElement;
    ctxmenu.openBelow(head, cardMenu(a, head));
  }
  async function rescan() {
    busy = true;
    try { await app.rescanAccounts(); } finally { busy = false; }
  }
</script>

<div class="s-row">
  <div class="lbl"><b>{t('settings.accounts.sortLabel')}</b><small>{t('settings.accounts.sortHint')}</small></div>
  <div class="ctl">
    <Seg value={app.settings.accountsSort}
      options={[{ id: 'manual', label: t('settings.accounts.sortManual') }, { id: 'name', label: t('settings.accounts.sortName') }, { id: 'free', label: t('settings.accounts.sortFree') }, { id: 'reset', label: t('settings.accounts.sortReset') }]}
      onchange={(v) => app.setting('accountsSort', v as AccountsSort)} />
  </div>
</div>
<div class="s-row">
  <div class="lbl"><b>{t('settings.accounts.groupLabel')}</b></div>
  <div class="ctl"><Toggle value={app.settings.accountsGroup} label={t('settings.accounts.groupLabel')} onchange={(v) => app.setting('accountsGroup', v)} /></div>
</div>

{#each sections as sec (sec.provider ?? 'flat')}
{#if sec.heading && sec.labelKey}<h4 class="acc-grp">{t('sidebar.accounts.groupHead', { label: t(sec.labelKey), n: sec.accounts.length })}</h4>{/if}
{#each sec.accounts as a (a.id)}
  {@const pr = app.profileOf(a)}
  {@const prov = providerOf(a)}
  <div class="s-acct">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="top" oncontextmenu={(e) => headCtx(e, a)} onkeydown={(e) => headKey(e, a)}>
      <span class="cdot" style:background={a.color}></span>
      <input class="name" value={a.name} aria-label={t('settings.accounts.nameAria')} spellcheck="false"
        onchange={(e) => rename(a.id, e)} onkeydown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      <span class="tag">{providerLabel(providerOf(a))}</span>
      {#if prov === 'claude'}
        <span class="status" class:ok={pr?.loggedIn}>
          {pr?.loggedIn ? [pr.email, pr.plan].filter(Boolean).join(' · ') || t('settings.accounts.signedIn') : t('settings.accounts.notSignedIn')}
        </span>
      {:else}
        {@const e = app.providerStatus[a.id]}
        <span class="status" class:ok={loginTone(e) === 'ok'} class:warn={loginTone(e) === 'warn'}>{statusLabel(e, !!app.statusChecking[a.id])}</span>
      {/if}
    </div>
    {#if prov === 'claude'}<div style="max-width: 340px"><UsageBars accountId={a.id} /></div>{/if}
    {#if prov === 'claude' && app.settings.usageQuery}
      {@const q = app.usageStatus[a.id]}
      {@const r = tested[a.id]}
      <div class="uq">
        <span class="uq-line {statusTone(q)}">{statusText(q, app.nowSec, !!pr?.loggedIn)}</span>
        <button class="btn ghost small" disabled={testing === a.id || !pr?.loggedIn} onclick={() => testNow(a.id)}>
          {testing === a.id ? t('settings.usage.testing') : t('settings.usage.testNow')}
        </button>
      </div>
      {#if r}
        <div class="uq-res {statusTone({ status: r.status, at: r.fetchedAt })}">
          <span>{statusText({ status: r.status, at: r.fetchedAt }, app.nowSec, true)}</span>
          {#if r.status === 'ok'}<span class="uq-pct">{t('settings.usage.testResult', { five: pct(r.fiveHour), seven: pct(r.sevenDay) })}</span>{/if}
        </div>
      {/if}
    {/if}
    <div class="s-swatches small">
      {#each ACCOUNT_COLORS as c (c)}
        <button type="button" class="sw" class:on={a.color === c} style:background={c} title={c} aria-label={t('settings.accounts.colorAria', { color: c })} onclick={() => setColor(a.id, c)}>
          {#if a.color === c}<Icon name="check" size={11} />{/if}
        </button>
      {/each}
    </div>
    <div class="path"><span>{t('settings.accounts.folderLabel')}</span><input readonly value={a.dir} aria-label={t('settings.accounts.folderAria')} /></div>
    {#if prov === 'opencode' && a.isDefault}<p class="hint">{t('settings.accounts.sharedNote')}</p>{/if}
    <div class="acts">
      {#if prov === 'claude'}
        <button class="btn" onclick={() => openClaude(a.id)}><Icon name="bot" size={13} /> {pr?.loggedIn ? t('settings.accounts.openClaude') : t('settings.accounts.openLogin')}</button>
      {:else}
        {@const e = app.providerStatus[a.id]}
        <button class="btn" onclick={() => openAccount(a.id)}><Icon name="bot" size={13} /> {t('settings.accounts.openAgent', { name: providerLabel(prov) })}</button>
        {#if e?.status !== 'signedIn'}<button class="btn" onclick={() => openAccount(a.id, true)}>{t('settings.accounts.signIn')}</button>{/if}
        <button class="btn ghost" disabled={!!app.statusChecking[a.id]} title={t('settings.accounts.checkTitle')} onclick={() => void app.refreshProviderStatus({ id: a.id, force: true })}>
          {app.statusChecking[a.id] ? t('settings.accounts.checking') : t('settings.accounts.check')}
        </button>
      {/if}
      <button class="btn ghost danger" class:armed={armed === a.id} onclick={() => remove(a.id)}
        title={t('settings.accounts.removeTitle')}>
        {armed === a.id ? t('settings.accounts.removeConfirm') : t('settings.accounts.remove')}
      </button>
    </div>
  </div>
{/each}
{/each}
{#if !app.accounts.length}<p class="hint">{@html t('settings.accounts.empty')}</p>{/if}

<div class="s-actions">
  <button class="btn" disabled={busy} onclick={rescan}><Icon name="refresh" size={13} /> {t('settings.accounts.rescan')}</button>
  <button class="btn primary" onclick={() => (app.accountDialog = true)}><Icon name="plus" size={13} /> {t('settings.accounts.add')}</button>
  {#if app.ignoredDirs.length}
    <button class="btn ghost" onclick={() => void app.restoreIgnored()} title={t('settings.accounts.restoreTitle')}>{t('settings.accounts.restore', { n: app.ignoredDirs.length })}</button>
  {/if}
</div>
<p class="hint">{t('settings.accounts.removeHint')}</p>
{#if hasOther}<p class="hint">{t('settings.accounts.claudeOnlyHint')}</p>{/if}

<style>
  .acc-grp { margin: 10px 0 2px; color: var(--faint); font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
  .tag { font-size: 10.5px; color: var(--muted); border: 1px solid var(--border-strong); border-radius: 5px; padding: 0 6px; flex: none; }
  .status.warn { color: var(--warn); }
  .uq { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .uq-line, .uq-res { font-size: 11.5px; color: var(--muted); }
  .uq-line.ok, .uq-res.ok { color: var(--ok); }
  .uq-line.warn, .uq-res.warn { color: var(--warn); }
  .uq-line.bad, .uq-res.bad { color: var(--bad); }
  .uq .btn { padding: 2px 9px; font-size: 11.5px; flex: none; }
  .uq-res { display: flex; gap: 10px; flex-wrap: wrap; }
  .uq-pct { color: var(--text); font-variant-numeric: tabular-nums; }
</style>
