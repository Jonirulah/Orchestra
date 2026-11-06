# Estado: Export everything / Import everything (Settings -> Data)

## Hecho
- `src/lib/backup.ts` (puro): `buildBackup`, `serializeBackup`, `backupFileName`, `parseBackup`, `mergeBackup`, `replaceFromBackup`, `sanitizeSpec`, `anyPicked`.
- `src/lib/backup.test.ts`: 38 pruebas (round trip, sin secretos, mutacion, errores, formato futuro, >5 MB, paneles hostiles, hosts hostiles,
  ficheros antiguos, merge/replace, picks, ids en colision, remapeo de refs).
- Store (cambios pequenos, al final de la clase + un import de tipo): `backupState()` y `applyBackupState(next, closePanes)`.
- UI: `SettingsData.svelte` (bloque "Full backup" con exportar/guardar/copiar, importar archivo o pegar, resumen con casillas, modo Merge/Replace,
  avisos, confirmacion armada en Replace). Claves `settings.data.backup.*` en en+es (`settingsData.ts`).
- Docs: README (linea), ARCHITECTURE (nota), SECURITY (nota).

## Decisiones
- Sin `location.reload()`: se aplica en el sitio. Recargar la ventana deja vivos los PTY del backend (pty_spawn con el mismo id solo
  reemplaza la entrada del mapa; los ids viejos quedan huerfanos). En su lugar, Replace de workspaces cierra los paneles actuales con
  `conn.closed` + `T.dispose` (mata el PTY) y los nuevos se lanzan al montarse el panel, como cualquier workspace nuevo. Merge no toca los vivos.
- `lastSession` no viaja (referencia a una conversacion de esa maquina). `maximizedId` tampoco. `ORCHESTRA_ASKPASS_KEY` se quita de los
  specs (se regenera desde el host con `refreshSshSpec`; un archivo hostil podria apuntarla al secreto de otro host).
- Host `host`/`user`/`proxyJump` que empiezan por `-` o con espacios se descartan (inyeccion de opciones de ssh).
- `usageQuery` nunca viaja ni se importa (se queda el valor actual). Otros ajustes sensibles (mcpExposeLocal) SI se importan: duda abierta.
- Listas blancas de campos de Host/Account con guardia de tipos: si alguien anade un campo a `Host`/`Account` sin apuntarlo en backup.ts,
  svelte-check falla (si no, la copia lo perderia en silencio).

## Comprobado
- svelte-check: 0 errors / 0 warnings (214 files). `npm test`: 412 pass, 0 fail (38 are backup.test.ts). `npm run i18n:check`: OK.
- Bugs plantados en backup.ts (cada uno por separado, restaurado con cmp identico): 23/23 detectados por backup.test.ts: export con usageQuery, con
  hasPassword (+scrub apagado: la lista blanca y el scrub son dos capas, una sola no se nota), con ORCHESTRA_ASKPASS_KEY, con lastSession; formato 2
  aceptado; app incorrecta; sin tope de tamano; args no string; env enorme; env no string; askpass tomado del archivo; host `-o...`; merge duplica
  host por destino; merge reutiliza id en colision; merge ignora casilla hosts; merge importa usageQuery; replace ignora casilla cuentas; merge muta
  la entrada; merge sin remapear refs; segunda cuenta por defecto; replace pierde la bandera de la boveda; replace deja 0 espacios; tema inexistente.
- Demo en el navegador (http://127.0.0.1:1420, Chrome headless CDP, scratchpad/backup-ui.mjs): pegar un archivo -> resumen con casillas, avisos y modo;
  Merge anade 1 host + 1 espacio (panel hostil descartado: "Skipped as invalid: 1 (panes)"); repetirlo salta todo ("Already here: 7");
  Replace arma con el primer clic ("Click again to replace") y aplica con el segundo; errores de JSON/app/format 2 con su mensaje.
  Capturas: scratchpad/bk-shots/bk-1-summary.png y bk-2-replace-armed.png.

## Pendiente / no verificado
- Descarga real (Blob URL) y selector de archivo dentro del webview de Tauri: sin probar (no se puede arrancar la app aqui). Precedente: SettingsTerminal.downloadCurrent.
- Replace de cuentas en otro equipo: una cuenta `isDefault` con la ruta de usuario del equipo viejo se queda tal cual (syncAccounts anadira la local).

## Archivos tocados
src/lib/backup.ts, src/lib/backup.test.ts, src/lib/store.svelte.ts (import + 2 metodos al final), src/components/SettingsData.svelte,
src/lib/locales/{en,es}/settingsData.ts, README.md, docs/ARCHITECTURE.md, docs/SECURITY.md, este archivo.
