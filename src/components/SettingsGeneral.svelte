<script lang="ts">
  import { app } from '../lib/store.svelte.ts';
  import { ACCOUNT_COLORS } from '../lib/model.ts';
  import { t } from '../lib/i18n.ts';
  import type { LanguageSetting } from '../lib/i18n.ts';
  import Seg from './Seg.svelte';
  import Toggle from './Toggle.svelte';
  import Icon from './Icon.svelte';
  import SettingsStatusBar from './SettingsStatusBar.svelte';
  import SettingsUpdates from './SettingsUpdates.svelte';

  const s = $derived(app.settings);
  // Los nombres de idioma se escriben en su propio idioma (así se reconocen aunque la interfaz esté en otro).
  const LANG_OPTIONS: { id: LanguageSetting; label: string }[] = [
    { id: 'en', label: t('settings.general.languageEn') },
    { id: 'es', label: t('settings.general.languageEs') },
    { id: 'system', label: t('settings.general.languageSystem') },
  ];
</script>

<div class="s-row">
  <div class="lbl">
    <b>{t('settings.general.languageLabel')}</b>
    <small>{t('settings.general.languageHint')}</small>
  </div>
  <div class="ctl">
    <Seg value={s.language} options={LANG_OPTIONS} onchange={(v) => app.setting('language', v)} />
  </div>
</div>

<!-- Actualizaciones automáticas (componente propio: SettingsUpdates.svelte) -->
<SettingsUpdates />

<div class="s-row">
  <div class="lbl">
    <b>{t('settings.general.closeLabel')}</b>
    <small>{t('settings.general.closeHint')}</small>
  </div>
  <div class="ctl">
    <Seg value={s.closeToTray ? 'tray' : 'quit'} options={[{ id: 'tray', label: t('settings.general.closeHide') }, { id: 'quit', label: t('settings.general.closeQuit') }]}
      onchange={(v) => app.setting('closeToTray', v === 'tray')} />
  </div>
</div>

<div class="s-row">
  <div class="lbl">
    <b>{t('settings.general.confirmLabel')}</b>
    <small>{t('settings.general.confirmHint')}</small>
  </div>
  <div class="ctl"><Toggle value={s.confirmClose} label={t('settings.general.confirmLabel')} onchange={(v) => app.setting('confirmClose', v)} /></div>
</div>

<div class="s-row">
  <div class="lbl">
    <b>{t('settings.general.accentLabel')}</b>
    <small>{t('settings.general.accentHint')}</small>
  </div>
  <div class="ctl">
    <div class="s-swatches">
      {#each ACCOUNT_COLORS as c (c)}
        <button type="button" class="sw" class:on={s.accent === c} style:background={c} title={c} aria-label={t('settings.general.accentAria', { color: c })} onclick={() => app.setting('accent', c)}>
          {#if s.accent === c}<Icon name="check" size={13} />{/if}
        </button>
      {/each}
    </div>
  </div>
</div>

<!-- Barra de estado inferior (componente propio: SettingsStatusBar.svelte) -->
<SettingsStatusBar />
