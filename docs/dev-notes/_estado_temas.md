# Estado: temas de color propios (import/export)

## Hecho
- `src/lib/themeimport.ts` (nuevo, puro): `parseTheme(text, fileName?)` autodetecta Orchestra JSON / Windows Terminal (escheme suelto, array, `schemes`, `themes`; JSONC con comentarios y comas finales) / iTerm2 plist (regex) / Alacritty TOML (lector mínimo con tablas en línea). `parseColor`, `exportTheme`, `withUniqueIds`, `sanitizeName`, `slugOf`, `stripJsonc`, `readToml`, `contrastRatio`, `sanitizeCustomThemes` (validador de lo guardado, tope 50). Límites: 256 KB, 50 temas, nombre 40 chars.
- `src/lib/themes.ts`: `ThemeDef` (id `custom:<slug>`, `selection` opaco), `allThemes`, `resolveTheme` (cae a orchestra), `hasTheme`, `selectionCss` (alfa 0.85 si el tono es casi el fondo, 0.3 si es vivo; coherente con los integrados), caché por contenido para que `terminals.applyOptions` (compara por identidad) no repinte al renombrar.
- `settings.ts`: `clampSettings` acepta ids `custom:...` (solo cambio de 1 línea + import). Test añadido en `settings.test.ts`.
- `store.svelte.ts`: `customThemes` (nivel superior del estado, no en settings), carga con `sanitizeCustomThemes`, si el tema elegido no existe vuelve a orchestra, `addCustomThemes` (un solo tema importado queda elegido), `renameCustomTheme`, `deleteCustomTheme`; `termOptions` y `--term-bg` usan `resolveTheme`. `resetSection('terminal')` solo toca `settings.theme`: los temas propios no se borran.
- `SettingsTerminal.svelte`: selector con grupos Built-in / Custom, vista previa, Export (Blob + `<a download>`), Copy JSON, Rename en línea, Delete en dos pasos, zona de soltar (la sección entera acepta archivos), botón Import theme file… (input oculto, múltiple), Paste theme text + Import, mensaje con avisos, texto de ayuda sin enlaces.
- `app.css`: bloque `.s-themes/.s-drop/.s-dropveil`.
- `terminals.ts`: sin cambios (recibe el `TermTheme` ya resuelto desde `termOptions`).

## Comprobado
- `npx svelte-check`: 0 errors 0 warnings (157 files).
- `node --test src/lib/*.test.ts`: 110 pass 0 fail (32 en themeimport.test.ts, +1 en settings.test.ts).
- Mutación: roto a propósito `brightPurple`, umbral de contraste y tope 50 -> 5 tests en rojo; restaurado -> 32 verdes.
- `npx vite build`: OK. `i18n-check`: OK (solo avisos de textos fijos, esperado).

## Pendiente / dudas
- Sin probar en la app real ni en el navegador (no se pedía): drop, descarga por Blob en WebView2, portapapeles.
- Fixtures escritos por mí (Dracula x4, Solarized iTerm generado con el molde de iTerm, WT settings con 3 esquemas): no hay archivos reales descargados.
- iTerm2: se ignora el espacio de color (sRGB/Calibrated).
- Textos en inglés fijos; el agente de i18n deberá moverlos (mensajes con plantilla en `SettingsTerminal.svelte` y avisos en inglés de `themeimport.ts`).

## Archivos tocados
src/lib/themeimport.ts, src/lib/themeimport.test.ts, src/lib/themes.ts, src/lib/settings.ts, src/lib/settings.test.ts, src/lib/store.svelte.ts, src/components/SettingsTerminal.svelte, src/app.css
