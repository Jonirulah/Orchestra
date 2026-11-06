# Estado: diálogo de Ajustes (Settings)

## Hecho
- `src/lib/settings.ts` (puro): interfaz `Settings` ampliada, `DEFAULTS`, `clampSettings`, `resetSection`, `parseImport`, `fontStack`, `hexAlpha`, `cacheThresholds`, `APP_VERSION`.
- `src/lib/themes.ts` (5 temas), `src/lib/shortcuts.ts` (tabla de atajos), `src/lib/settings.test.ts` (13 pruebas nuevas).
- `terminals.ts`: `TermOptions` completa, `applyOptions()` (+fitNow), `create()` usa las opciones vivas (copyOnSelect, clic derecho, campana); `setFontSize` sigue funcionando.
- `store.svelte.ts`: carga con `clampSettings`; `setting/patchSettings/replaceSettings/resetSettingsSection/resetAllSettings`; efectos en vivo (xterm, CSS --accent/--accent-soft/--term-bg, closeToTray, temporizador de escaneo re-armable `armScan`); avisos filtrados por `notifyPermission/notifyDone`; `removeAccount`, `rescanAccounts`, `restoreIgnored`; `settingsOpen`; Ctrl+, en `handleShortcut` (alterna).
- Cuentas quitadas se guardan en `ignoredDirs` (nivel superior del estado, no en settings) para que `syncAccounts` no las vuelva a añadir.
- UI: `SettingsDialog` + `SettingsGeneral/Terminal/Agents/Accounts/Data` + `Toggle/Seg/Slider`; icono `gear` y `check`; botón engranaje en Sidebar, comando "Settings…" en Palette; `PaneView` respeta `confirmClose`; `AgentTree` usa `cacheThresholds`.
- Rust: `data_dir` y `open_data_dir` en `store.rs`, registrados en `main.rs`.
- README: añadido Ctrl+, a la lista de atajos.

## Cómo se comprobó
- svelte-check: 118 archivos, 0 errores, 0 avisos.
- `node --test src/lib/*.test.ts`: 31 pruebas, 31 ok (antes 18; +13).
- `cargo test`: 9 ok, 3 ignoradas.
- `npx vite build`: ok (156 módulos).
- `npx tauri build --debug --no-bundle`: ok, pero con `CARGO_TARGET_DIR=<cache>` porque `src-tauri\target\debug\orchestra.exe` está en uso (PID 154132, otra instancia en marcha) y daba "Acceso denegado". Resultado: `<cache>\debug\orchestra.exe`.
- Auditoría de cadenas en español en componentes: solo comentarios.

## Pendiente / dudas
- Sin comprobación visual (lo hace el orquestador). Nada ejecutado: ni app, ni vite dev, ni capturas.
- "Reset section" solo en General, Terminal y Agents (Accounts, Shortcuts y Data no tienen ajustes de sección; Data tiene "Reset ALL").
- Los colores del resaltado de búsqueda (terminals.findNext) siguen fijos en ámbar.
- `APP_VERSION` es una constante; una prueba comprueba que coincide con tauri.conf.json.

## Archivos tocados
src/lib: settings.ts, themes.ts, shortcuts.ts, settings.test.ts (nuevos); terminals.ts, store.svelte.ts, backend.ts.
src/components: SettingsDialog, SettingsGeneral, SettingsTerminal, SettingsAgents, SettingsAccounts, SettingsData, Toggle, Seg, Slider (nuevos); Icon, Sidebar, Palette, PaneView, AgentTree.
src: App.svelte, app.css. src-tauri/src: store.rs, main.rs. README.md.
