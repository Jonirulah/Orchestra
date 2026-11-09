<script lang="ts">
  import { app } from '../lib/store.svelte.ts';
  import { FONT_PRESETS, LIMITS, SCROLLBACK_CHOICES } from '../lib/settings.ts';
  import { ANSI_KEYS, DEFAULT_THEME, MAX_CUSTOM_THEMES, allThemes, hasTheme, resolveTheme } from '../lib/themes.ts';
  import type { ThemeDef } from '../lib/themes.ts';
  import { MAX_INPUT_BYTES, exportTheme, parseTheme, slugOf } from '../lib/themeimport.ts';
  import { t } from '../lib/i18n.ts';
  import { copyText, listFonts } from '../lib/backend.ts';
  import { firstFamily, groupFonts, type InstalledFont } from '../lib/fontlist.ts';
  import { isFontInstalled, isMonospaced } from '../lib/fontcheck.ts';
  import Seg from './Seg.svelte';
  import Toggle from './Toggle.svelte';
  import Slider from './Slider.svelte';
  import SettingsGit from './SettingsGit.svelte';

  const s = $derived(app.settings);
  // Todas las instaladas en el sistema (Rust) más las de siempre: monoespaciadas arriba, cada una en su tipografía; luego
  // las demás instaladas, las instaladas con Orchestra abierto (hay que reiniciarlo) y las de siempre sin instalar.
  let systemFonts = $state<InstalledFont[]>([]);
  listFonts().then((f) => { systemFonts = f; }).catch(() => {});
  const groups = $derived(groupFonts(systemFonts, FONT_PRESETS, isFontInstalled, isMonospaced));
  const listed = $derived(new Set([...groups.mono, ...groups.other].map((f) => f.toLowerCase())));
  const currentFont = $derived(firstFamily(s.fontFamily));
  const fontNeedsRestart = $derived(groups.restart.some((f) => f.toLowerCase() === currentFont.toLowerCase()));
  const fontMissingNow = $derived(!!s.fontFamily && !fontNeedsRestart && !isFontInstalled(currentFont));

  // «Custom…» sale si la fuente no está en la lista; una vez elegida (o escribiendo en ella) se queda aunque el texto
  // coincida con una fuente de la lista.
  let custom = $state(false);
  let customText = $state(app.settings.fontFamily);
  const fontChoice = $derived(custom || !listed.has(s.fontFamily.toLowerCase()) ? 'custom' : s.fontFamily);
  const entries = $derived(allThemes(app.customThemes));
  const builtin = $derived(entries.filter((e) => !e.custom));
  const customEntries = $derived(entries.filter((e) => e.custom));
  // Si el tema elegido ya no existe, se muestra (y se usa) Orchestra Dark.
  const themeId = $derived(hasTheme(s.theme, app.customThemes) ? s.theme : DEFAULT_THEME);
  const th = $derived(resolveTheme(s.theme, app.customThemes));
  const current = $derived(app.customThemes.find((d) => d.id === themeId));

  // ---------- importar / exportar temas ----------
  let msg = $state<{ ok: boolean; text: string; details: string[] } | null>(null);
  let pasteOpen = $state(false);
  let pasted = $state('');
  let dragging = $state(false);
  let dragDepth = 0;
  let fileInput: HTMLInputElement | undefined = $state();
  let renaming = $state(false);
  let renameText = $state('');
  let delArmed = $state(false);
  let delTimer: number | undefined;

  function finishImport(defs: ThemeDef[], warnings: string[], errors: string[]): boolean {
    if (!defs.length) {
      msg = { ok: false, text: t('settings.terminal.nothingImported'), details: errors };
      return false;
    }
    const r = app.addCustomThemes(defs);
    const details = [...errors, ...warnings];
    if (r.skipped) details.push(t('settings.terminal.limitReached', { max: MAX_CUSTOM_THEMES, skipped: r.skipped }));
    msg = { ok: r.added > 0, text: r.added === 1 ? t('settings.terminal.importedOne') : t('settings.terminal.importedMany', { n: r.added }), details };
    return r.added > 0;
  }

  async function importFiles(files: File[]) {
    const defs: ThemeDef[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    for (const f of files.slice(0, 20)) {
      if (f.size > MAX_INPUT_BYTES) { errors.push(t('settings.terminal.fileTooLarge', { name: f.name })); continue; }
      try {
        const r = parseTheme(await f.text(), f.name);
        if (r.ok) { defs.push(...r.themes); warnings.push(...r.warnings); } else errors.push(t('settings.terminal.fileError', { name: f.name, error: r.error }));
      } catch {
        errors.push(t('settings.terminal.fileUnreadable', { name: f.name }));
      }
    }
    finishImport(defs, warnings, errors);
  }

  function onPick(e: Event & { currentTarget: HTMLInputElement }) {
    const files = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = ''; // permite volver a elegir el mismo archivo
    if (files.length) void importFiles(files);
  }

  function importPasted() {
    const r = parseTheme(pasted, t('settings.terminal.pastedName'));
    if (!r.ok) { msg = { ok: false, text: t('settings.terminal.nothingImported'), details: [r.error] }; return; }
    if (finishImport(r.themes, r.warnings, [])) { pasted = ''; pasteOpen = false; }
  }

  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  function onDragEnter(e: DragEvent) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dragging = true; }
  function onDragOver(e: DragEvent) { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }
  function onDragLeave(e: DragEvent) { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dragging = false; }
  function onDrop(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dragging = false;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) void importFiles(files);
  }

  function downloadCurrent() {
    if (!current) return;
    const url = URL.createObjectURL(new Blob([exportTheme(current)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugOf(current.name)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    msg = { ok: true, text: t('settings.terminal.downloaded'), details: [] };
  }
  async function copyCurrent() {
    if (!current) return;
    try {
      await copyText(exportTheme(current));
      msg = { ok: true, text: t('settings.terminal.jsonCopied'), details: [] };
    } catch (e) {
      msg = { ok: false, text: t('settings.terminal.copyFailed'), details: [String(e)] };
    }
  }
  function startRename() { if (!current) return; renameText = current.name; renaming = true; }
  function commitRename() {
    if (current && renaming) {
      renaming = false;
      if (!app.renameCustomTheme(current.id, renameText)) msg = { ok: false, text: t('settings.terminal.invalidName'), details: [] };
    }
  }
  function focusSelect(node: HTMLInputElement) { node.focus(); node.select(); }
  function deleteCurrent() {
    if (!current) return;
    if (!delArmed) {
      delArmed = true;
      clearTimeout(delTimer);
      delTimer = window.setTimeout(() => (delArmed = false), 2800);
      return;
    }
    delArmed = false;
    app.deleteCustomTheme(current.id);
    msg = { ok: true, text: t('settings.terminal.deleted'), details: [] };
  }
  // Al cambiar de tema se cancelan el renombrado y la confirmación pendientes.
  $effect(() => { void themeId; renaming = false; delArmed = false; });

  function pickFont(v: string) {
    if (v === 'custom') { custom = true; customText = s.fontFamily; return; }
    custom = false;
    app.setting('fontFamily', v);
  }
  function typeFont() {
    custom = true;
    if (customText.trim()) app.setting('fontFamily', customText);
  }
</script>

<div class="s-row">
  <div class="lbl"><b>{t('settings.terminal.fontLabel')}</b><small>{t('settings.terminal.fontHint')}</small></div>
  <div class="ctl col">
    <select value={fontChoice} onchange={(e) => pickFont(e.currentTarget.value)}>
      <optgroup label={t('settings.terminal.fontInstalled')}>
        {#each groups.mono as f (f)}<option value={f} style:font-family="'{f}', monospace">{f}</option>{/each}
      </optgroup>
      {#if groups.other.length}
        <optgroup label={t('settings.terminal.fontOther')}>
          {#each groups.other as f (f)}<option value={f} style:font-family="'{f}', monospace">{f}</option>{/each}
        </optgroup>
      {/if}
      {#if groups.restart.length}
        <optgroup label={t('settings.terminal.fontNew')}>
          {#each groups.restart as f (f)}<option value={f} disabled>{f}</option>{/each}
        </optgroup>
      {/if}
      {#if groups.missing.length}
        <optgroup label={t('settings.terminal.fontMissing')}>
          {#each groups.missing as f (f)}<option value={f}>{f}</option>{/each}
        </optgroup>
      {/if}
      <option value="custom">{t('settings.terminal.fontCustom')}</option>
    </select>
    {#if fontChoice === 'custom'}
      <input placeholder={t('settings.terminal.fontPlaceholder')} bind:value={customText} oninput={typeFont} spellcheck="false" />
    {/if}
    {#if fontMissingNow}<small class="s-warnline">{t('settings.terminal.fontNotInstalled')}</small>{/if}
    {#if groups.restart.length}<small class="s-warnline">{t('settings.terminal.fontNewHint', { names: groups.restart.join(', ') })}</small>{/if}
  </div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.terminal.sizeLabel')}</b><small>{t('settings.terminal.sizeHint')}</small></div>
  <div class="ctl"><Slider value={s.fontSize} min={LIMITS.fontSize[0]} max={LIMITS.fontSize[1]} unit=" px" onchange={(v) => app.setting('fontSize', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.terminal.lineHeightLabel')}</b></div>
  <div class="ctl"><Slider value={s.lineHeight} min={LIMITS.lineHeight[0]} max={LIMITS.lineHeight[1]} step={0.02} digits={2} onchange={(v) => app.setting('lineHeight', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.terminal.letterSpacingLabel')}</b><small>{t('settings.terminal.letterSpacingHint')}</small></div>
  <div class="ctl"><Slider value={s.letterSpacing} min={LIMITS.letterSpacing[0]} max={LIMITS.letterSpacing[1]} unit=" px" onchange={(v) => app.setting('letterSpacing', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.terminal.cursorLabel')}</b></div>
  <div class="ctl">
    <Seg value={s.cursorStyle} options={[{ id: 'bar', label: t('settings.terminal.cursorBar') }, { id: 'block', label: t('settings.terminal.cursorBlock') }, { id: 'underline', label: t('settings.terminal.cursorUnderline') }]}
      onchange={(v) => app.setting('cursorStyle', v)} />
    <label class="inline"><Toggle value={s.cursorBlink} label={t('settings.terminal.blink')} onchange={(v) => app.setting('cursorBlink', v)} /> {t('settings.terminal.blink')}</label>
  </div>
</div>

<div class="s-row">
  <div class="lbl">
    <b>{t('settings.terminal.scrollbackLabel')}</b>
    <small>{t('settings.terminal.scrollbackHint')}</small>
  </div>
  <div class="ctl">
    <select value={s.scrollback} onchange={(e) => app.setting('scrollback', Number(e.currentTarget.value))}>
      {#each SCROLLBACK_CHOICES as n (n)}<option value={n}>{n.toLocaleString('en-US')}</option>{/each}
    </select>
  </div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.terminal.copyOnSelectLabel')}</b><small>{t('settings.terminal.copyOnSelectHint')}</small></div>
  <div class="ctl"><Toggle value={s.copyOnSelect} label={t('settings.terminal.copyOnSelectLabel')} onchange={(v) => app.setting('copyOnSelect', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.terminal.pasteImagesLabel')}</b><small>{t('settings.terminal.pasteImagesHint')}</small></div>
  <div class="ctl"><Toggle value={s.pasteImages} label={t('settings.terminal.pasteImagesLabel')} onchange={(v) => app.setting('pasteImages', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.terminal.rightClickLabel')}</b><small>{t('settings.terminal.rightClickHint')}</small></div>
  <div class="ctl">
    <Seg value={s.rightClick} options={[{ id: 'smart', label: t('settings.terminal.rightSmart') }, { id: 'paste', label: t('settings.terminal.rightPaste') }, { id: 'none', label: t('settings.terminal.rightNone') }]}
      onchange={(v) => app.setting('rightClick', v)} />
  </div>
</div>

<div class="s-row">
  <div class="lbl"><b>{t('settings.terminal.bellLabel')}</b><small>{t('settings.terminal.bellHint')}</small></div>
  <div class="ctl">
    <Seg value={s.bell} options={[{ id: 'flash', label: t('settings.terminal.bellFlash') }, { id: 'none', label: t('settings.terminal.bellNone') }]} onchange={(v) => app.setting('bell', v)} />
  </div>
</div>

<SettingsGit />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section class="s-themes" class:dragging ondragenter={onDragEnter} ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop}>
  <div class="s-row">
    <div class="lbl"><b>{t('settings.terminal.themeLabel')}</b><small>{t('settings.terminal.themeHint')}</small></div>
    <div class="ctl col">
      <select value={themeId} onchange={(e) => app.setting('theme', e.currentTarget.value)}>
        <optgroup label={t('settings.terminal.themeBuiltin')}>
          {#each builtin as e (e.id)}<option value={e.id}>{e.label}</option>{/each}
        </optgroup>
        {#if customEntries.length}
          <optgroup label={t('settings.terminal.themeCustom')}>
            {#each customEntries as e (e.id)}<option value={e.id}>{e.label}</option>{/each}
          </optgroup>
        {/if}
      </select>
      <div class="s-preview" style:background={th.background} style:color={th.foreground}>
        <div class="line"><span style:color={th.green}>~/project</span> <span style:color={th.blue}>main</span> <span style:color={th.yellow}>$</span> git status<span class="cur" style:background={th.cursor}></span></div> <!-- i18n-ignore: sample terminal line -->
        <div class="strip">
          {#each ANSI_KEYS as k (k)}<span style:background={th[k]} title={k}></span>{/each}
        </div>
      </div>
      {#if current}
        <div class="s-actions tight">
          {#if renaming}
            <input class="s-rename" bind:value={renameText} maxlength="40" aria-label={t('settings.terminal.themeNameAria')} use:focusSelect
              onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') renaming = false; }} onblur={commitRename} />
          {:else}
            <button class="btn" onclick={downloadCurrent}>{t('settings.terminal.export')}</button>
            <button class="btn" onclick={copyCurrent}>{t('settings.terminal.copyJson')}</button>
            <button class="btn" onclick={startRename}>{t('settings.terminal.rename')}</button>
            <button class="btn danger" class:armed={delArmed} onclick={deleteCurrent}>{delArmed ? t('settings.terminal.deleteConfirm') : t('settings.terminal.delete')}</button>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <div class="s-row stack">
    <div class="lbl">
      <b>{t('settings.terminal.importLabel')}</b>
      <small>{t('settings.terminal.importSupported')}</small>
      <small>{t('settings.terminal.importWhere')}</small>
    </div>
    <input bind:this={fileInput} class="s-file" type="file" accept=".json,.itermcolors,.toml,.conf,.txt" multiple onchange={onPick} />
    <button class="s-drop" type="button" onclick={() => fileInput?.click()}>
      <b>{t('settings.terminal.dropTitle')}</b>
      <span>{t('settings.terminal.dropSub')}</span>
    </button>
    <div class="s-actions">
      <button class="btn" onclick={() => fileInput?.click()}>{t('settings.terminal.importFile')}</button>
      <button class="btn ghost" aria-expanded={pasteOpen} onclick={() => (pasteOpen = !pasteOpen)}>{t('settings.terminal.pasteText')}</button>
    </div>
    {#if pasteOpen}
      <textarea rows="7" bind:value={pasted} spellcheck="false" placeholder={t('settings.terminal.pastePlaceholder')}></textarea>
      <div class="s-actions"><button class="btn primary" disabled={!pasted.trim()} onclick={importPasted}>{t('settings.terminal.import')}</button></div>
    {/if}
    {#if msg}
      <div class="s-msg" class:err={!msg.ok} role="status">
        {msg.text}
        {#if msg.details.length}<ul>{#each msg.details as d, i (i)}<li>{d}</li>{/each}</ul>{/if}
      </div>
    {/if}
  </div>
  {#if dragging}<div class="s-dropveil" aria-hidden="true">{t('settings.terminal.dropVeil')}</div>{/if}
</section>
