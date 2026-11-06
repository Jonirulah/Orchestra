# Estado i18n Ajustes (agente settings)

## Hecho
- Migrados: SettingsTerminal, SettingsAgents, SettingsDialog, SettingsAccounts, SettingsData, lib/shortcuts.ts, lib/themeimport.ts (themes.ts: sin textos de UI propios, nombres propios; sin cambios).
- Areas nuevas en locales/{en,es}: settingsTerminal, settingsAgents, settingsDialog, settingsAccounts, settingsData, shortcuts, themeimport (registradas en ambos index.ts). Claves: settings.terminal.*, settings.agents.*, settings.dialog.*, settings.accounts.*, settings.data.*, shortcuts.*, themeimport.*.
- SHORTCUTS: ahora guarda claves (`titleKey`, `whatKey`, tipo Key) y SettingsDialog llama a t() al pintar. Test de settings.test.ts (Ctrl+,) intacto.
- themeimport: t() dentro de las funciones (nunca a nivel de modulo). Variables locales `t` renombradas (body/toml) para no tapar el import.
- scripts/i18n-check.mjs: AREAS ahora se deduce de los ficheros de locales/en (ya no hay lista fija) y acepta claves `settings.terminal.*` en `settingsTerminal.ts` (nombre camelCase partido en segmentos).
- Test nuevo: src/lib/settingsi18n.test.ts (es != en salvo lista; SHORTCUTS con claves reales; themeimport sigue el idioma).

## Comprobado
- svelte-check: 0 errores, 0 avisos. node --test src/lib/*.test.ts: todo pasa. i18n-check de mis ficheros: (a)(b) OK, (c) 0 hallazgos.

## Notas
- `{@html t(...)}` en SettingsAccounts (empty) y SettingsAgents (autoCompactHint): el diccionario lleva <code> estatico (la frase no se parte). Variables solo numericas.
- i18n-ignore (3): SettingsData ruta state.json, ejemplo JSON del placeholder, SettingsTerminal linea de ejemplo del preview.
- Iguales en es y en (intencionado): tabGeneral, tabTerminal, tabMcp, cursorLabel, fileError, experimental, compactLogLine, data.build, accounts.colorAria.
- Nombres por defecto de temas importados (Imported theme, iTerm2 theme, Alacritty theme, Pasted theme) tambien se traducen (se guardan como nombre del tema).
- Pendiente fuera de mi alcance: POLICIES (policy.ts) y r.error de parseImport (settings.ts) los traduce el agente 3; SettingsAgents pinta p.label/p.hint tal cual.
- scrollback `toLocaleString('en-US')` se deja igual.
