# Estado i18n MCP

## Hecho
- SettingsMcp.svelte migrado: 37 claves `settings.mcp.*` en locales/{en,es}/settingsMcp.ts (registradas en ambos index.ts). Variable local `t` (timer/token) renombrada para no tapar el import.
- Texto con `<code>`: `settings.mcp.statusListening` via `{@html}` con `port` numerico (Number()). El puerto por defecto 47821 va como `{port}` en `portTaken`.
- Textos del backend (info.error, info.warning, audit tool/target/reason) se muestran tal cual; solo se traduce el prefijo ("Not running: {error}", "Security warning: {warning}").
- mcpsync.ts: sin texto visible (solo el comando `claude mcp add`, no se toca).
- Atajo: `keys: 'Alt+{arrows}'` en shortcuts.ts + `comboText()` (resuelve el marcador con `shortcuts.keyArrows`: en "Arrow keys", es "flechas"); SettingsDialog pinta `comboText(part)`. Ctrl+, intacto.
- Test nuevo src/lib/i18n-mcp.test.ts (4 tests).

## Comprobado
- svelte-check: 180 files, 0 errors, 0 warnings.
- node --test src/lib/*.test.ts: 140 pass, 0 fail (136 + 4 nuevos).
- i18n-check de los 3 ficheros: 0 hallazgos; completo: OK (504 en / 504 es).
- Unico `i18n-ignore`: `'<token>'` (marcador dentro del comando mostrado).
- Iguales en es y en (intencionado): `settings.mcp.tokenLabel` ("Token").

## Pendiente
- Nada. No se ejecuto la app ni capturas (segun brief).

## Archivos
src/components/SettingsMcp.svelte, src/components/SettingsDialog.svelte, src/lib/shortcuts.ts, src/lib/locales/{en,es}/{settingsMcp.ts (nuevos),index.ts,shortcuts.ts}, src/lib/i18n-mcp.test.ts
