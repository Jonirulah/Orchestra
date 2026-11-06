# Estado i18n core (2026-11-06)

## Hecho
- `src/lib/i18n.ts` (puro): `Locale`, `LanguageSetting`, `Key`, `t`, `tk`, `setLocale/getLocale`, `resolveLanguage`.
  Búsqueda: idioma actual -> inglés -> la clave (con hasOwnProperty: `tk('constructor')` devuelve la clave).
- `src/lib/locales/{en,es}/<área>.ts` x15 áreas + `index.ts`; `es` tipado `Record<Key,string>`.
  Migrados: `settings.general.*` (14 claves) y `tray.*` (2). Resto de áreas vacías (`{}`).
- Ajuste `language: 'en'|'es'|'system'` (settings.ts: tipo, DEFAULTS, clampSettings, sección `general` del reset; test nuevo en settings.test.ts).
- Store: `applyLanguage()` (setLocale + `<html lang>` + `be.setTrayLabels`), llamada en `init()` justo tras leer los ajustes (antes de `ready=true`, sin parpadeo)
  y en `applyEffects` cuando cambia `language` (cubre `setting`, `patchSettings`, `replaceSettings`, reset, import). Nuevo `app.settingsTab`.
- `App.svelte`: `{#key app.settings.language}` alrededor de todo el contenido de `{#if app.ready}`.
  Seguro con los terminales: los xterm viven en el registro `entries` de terminals.ts; `PaneView.onMount` devuelve un cleanup que solo hace
  `T.unmount(id)` (guarda el DOM en el stash, no `dispose`) y el nuevo `PaneView` hace `T.ensure` (ya existe -> false, no relanza) + `T.mount`. Los procesos no se tocan.
- `SettingsDialog.svelte`: `tab` se inicializa desde `app.settingsTab` y se vuelca con un `$effect` (sigue en la misma sección tras cambiar de idioma; recuerda la última sección al reabrir).
- `SettingsGeneral.svelte` migrado entero + fila nueva «Language» (Seg: English / Español / System default) arriba del todo.
- Rust: `set_tray_labels(app, show, quit)` en main.rs (reconstruye el menú con `tray.set_menu`, ids `show`/`quit` intactos; defaults en inglés en constantes `TRAY_SHOW/TRAY_QUIT`);
  `backend.ts::setTrayLabels`.
- `scripts/i18n-check.mjs` + `npm run i18n:check`; `docs/i18n.md`; `ARCHITECTURE.md` (sección Internationalization).
- Tests `src/lib/i18n.test.ts` (8) + 1 en settings.test.ts.

## Cómo se comprobó
- svelte-check: `156 FILES 0 ERRORS 0 WARNINGS`. Con la clave `tray.quit` borrada de `es/tray.ts`: `1 ERROR` en `locales/es/index.ts 19:14 Property '"tray.quit"' is missing in type ...` (restaurado: vuelve a 0).
- `node --test src/lib/*.test.ts`: 77 pass / 0 fail (68 antes + 9 nuevos).
- i18n-check plantado (FAIL): faltaba `tray.quit` en es, `{name}` solo en en, `t('tray.nope')` -> `FAIL: 3 error(s)`, exit 1. Restaurado: `OK: (a) dictionaries and (b) usage`, exit 0.
- cargo: `cargo check` OK con mis cambios (aviso previo de quota.rs ajeno). `cargo test` (con CARGO_TARGET_DIR aparte): 78 passed + 5 passed, 0 failed (tras reintentar cuando mcp.rs dejó de estar a medias). orchestra.exe en ejecución (PID de la app del orquestador) bloquea `target\debug`;
  se usó `CARGO_TARGET_DIR=<cache>`. Un intento falló por errores en mcp.rs/pty (agente de la bóveda editando: `MAX_INFLIGHT`, `c1_to_esc`), no míos.

## Backlog de migración (heurística de `node scripts/i18n-check.mjs --summary`, 404 textos)
| Fichero | Textos | Área sugerida | Notas |
|---|---|---|---|
| components/HostDialog.svelte | 51 | dialogs | NO TOCAR hasta que acabe el agente de la bóveda SSH |
| components/SettingsAgents.svelte | 35 | settings | `settings.agents.*` |
| components/SettingsMcp.svelte | 35 | settings | `settings.mcp.*` |
| components/SettingsKeys.svelte | 34 | settings | `settings.keys.*`; agente SSH-vault lo toca |
| components/SettingsTerminal.svelte | 56 (otro agente añadió importación de temas; antes 31) | settings | `settings.terminal.*` |
| components/Sidebar.svelte | 25 | sidebar | agente SSH-vault lo toca |
| components/SettingsDialog.svelte | 24 | settings | `settings.dialog.*`; TABS ya es de instancia, vale `t()` ahí |
| components/AgentTree.svelte | 20 | agents | |
| lib/shortcuts.ts | 19 | settings | `SHORTCUTS` es constante de módulo: pasar a función o `tk` en la vista |
| components/PaneView.svelte | 18 | pane | `AGST` mapa de estados -> `tk('pane.status.${s}')` |
| components/SettingsAccounts.svelte | 18 | settings | |
| components/SettingsData.svelte | 17 | settings | |
| lib/store.svelte.ts | 13 | store | toasts con `{name}` |
| components/AccountDialog.svelte | 12 | dialogs | |
| lib/themeimport.ts | 11 | settings | fichero nuevo de otro agente (mensajes de error) |
| components/Palette.svelte | 9 | palette | |
| components/TopBar.svelte | 9 | topbar | |
| components/Grid.svelte | 8 | grid | líneas 99/103 YA están en español («Arrastra para ajustar...»): mezcla de idiomas |
| lib/policy.ts | 8 | policy | `POLICIES` const de módulo (label/desc) -> función o `tk`; policy.test.ts asserta inglés: no romperlo |
| lib/settings.ts | 3 | settings | mensajes de `parseImport` (módulo puro: usar `t()`; ojo a settings.test.ts) |
| lib/model.ts | 2 | model | etiquetas de layouts |
| components/UsageBars.svelte | 1 | usage | |
| lib/backend.ts | 1 | app | «Not available in the browser demo» |
| TOTAL | 429 (11-06 tarde; era 404) | | |

Falsos positivos conocidos: `themes.ts` (nombres propios) ignorado por el script. Si algo debe quedarse en inglés: comentario `i18n-ignore` en esa línea.
Las interpolaciones salen como `{…}` en el listado. Filtrar por fichero: `node scripts/i18n-check.mjs components/Sidebar`.

## Dudas / pendiente
- `app.settingsTab` conserva la última sección al reabrir Ajustes (comportamiento nuevo, deliberado).
- Cambiar 'system' <-> 'es' remonta la UI aunque el idioma resuelto no cambie (inocuo).
- Para quien migre: nada de `t()` a nivel de módulo (se evalúa una vez, en inglés). Ver docs/i18n.md.
- `package.json "test"` ya cubre `i18n.test.ts` (glob `src/lib/*.test.ts`).

## Archivos tocados
Propios: src/lib/i18n.ts, src/lib/i18n.test.ts, src/lib/locales/**, scripts/i18n-check.mjs, docs/i18n.md.
Compartidos (ediciones pequeñas): src/lib/settings.ts(+test), src/lib/store.svelte.ts, src/lib/backend.ts, src/App.svelte, src/components/SettingsGeneral.svelte,
src/components/SettingsDialog.svelte, src-tauri/src/main.rs, package.json, docs/ARCHITECTURE.md.
