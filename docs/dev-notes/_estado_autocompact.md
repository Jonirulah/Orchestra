# Estado: auto-compact en inactividad

## Hecho
- `src-tauri/src/idle.rs`: `idle_seconds()` (user32 GetLastInputInfo + kernel32 GetTickCount, `extern "system"`, sin crates), `tick_delta_ms` (wrapping_sub), comando `system_idle_seconds`; registrado en main.rs (mod + handler).
- `src/lib/autocompact.ts` (puro): `decideCompact`, `compactKey`, `compactWindow`, `pushLog`. Ventana [afterMin, cacheTtl/60 - 3). `userIdleSec: null` => razón `needs-idle-check` (permite consultar el sistema una sola vez por escaneo, solo si hay candidatos).
- settings.ts: autoCompact(false), autoCompactCtxK(150, 50..800), autoCompactAfterMin(50, 20..55), autoCompactUserIdleMin(5, 1..60); en DEFAULTS, clampSettings, SECTION_KEYS.agents, LIMITS.
- backend.ts: `systemIdleSeconds()` (demo: 0).
- store.svelte.ts: `autoCompactCheck` llamado al final de `pollOnce`; `compactLog` (20), `compactDone` (Set por sesión@lastRequestAt); escribe `/compact\r` con `be.ptyWrite`; toast.
- SettingsAgents.svelte: bloque «Auto-compact when away» (toggle, 3 sliders, registro, aviso experimental).
- DISENO.md: solo la viñeta de auto-compact.

## Cómo se comprobó
- svelte-check: 119 archivos, 0 errores, 0 avisos.
- `node --test src/lib/*.test.ts`: 50 ok, 0 fallos (9 en autocompact.test.ts + 1 nuevo en settings.test.ts).
- `cargo test`: 19 ok, 4 ignoradas (2 nuevas de idle ok).
- Lectura real: `cargo test real_idle -- --ignored --nocapture` => IDLE_SECONDS=0, API_OK=1, idle_ms=15 (usuario activo).

## Pendiente / dudas
- No hay notificaciones del sistema en Orchestra (solo toast); el aviso es toast + registro.
- No se implementó la regla «panel enfocado»: se confía en la inactividad del sistema (permitido por el brief).
- Sin ejecutar la app ni probar `/compact` real; falta el A/B de coste.
- El toast puede taparse con otro; el registro de Settings lo conserva.

## Archivos tocados
Nuevos: src-tauri/src/idle.rs, src/lib/autocompact.ts, src/lib/autocompact.test.ts.
Editados: src-tauri/src/main.rs, src/lib/{settings.ts,settings.test.ts,backend.ts,store.svelte.ts}, src/components/SettingsAgents.svelte, docs/DISENO.md.

## 2026-11-07 arreglo (rama autocompact-fix, desde 9d785d5)

### Criterio de hecho
- `decideCompact` con razones nuevas `user-typed` (borrador pendiente en el panel) y `ttl-too-short` (ventana vacía: afterMin >= ttl-3), con tests que fallan sin el arreglo.
- Entrada del teclado registrada en `terminals.ts` (`term.onData`) -> estado de borrador por panel (puro, `nextDraft`).
- SettingsAgents: último motivo por agente Claude visible (EN/ES) + explicación de qué hace.
- npm test, npm run check, npm run i18n:check, cargo test --bin orchestra verdes.
- Prueba real aislada: positivo (escribe /compact y el .jsonl muestra la compactación) y negativo (borrador -> no compacta).

### Diseño del borrador
- `lastRequestAt` (segundos, timestamp del último mensaje del asistente) no basta: un borrador escrito MIENTRAS Claude trabajaba queda antes de lastRequestAt y sigue en el prompt. Por eso se lleva un estado por panel: `draft` (hay texto sin enviar) y `lastInputAt`.
- Entrada que termina en `\r` = envío (borra el borrador). `\x03` = Ctrl+C (Claude vacía el prompt). Respuestas del terminal (foco `\x1b[I/O`, ratón, CPR, DA, OSC) y un Esc suelto = ruido (no cambian nada). Todo lo demás (texto, pegar, flechas que traen historial, retroceso) = borrador.
- Regla: `user-typed` si hay borrador, o si hubo entrada no-envío después de lastRequestAt.

### Hecho (código)
- `autocompact.ts`: razones `ttl-too-short` (ventana vacía, antes de too-early) y `user-typed` (tras already-done, antes de consultar la inactividad); `classifyInput`/`nextDraft` (borrador por panel); `parseDevOverride`.
- `terminals.ts`: hook `onInput` en `term.onData` (solo teclado/pegar; lo que escribe la app con ptyWrite no pasa).
- `store.svelte.ts`: `drafts` por panel, `compactReasons` (último motivo por panel Claude, también `disabled`), `compactDev` (override), log de desarrollo.
- `idle.rs`: comandos `dev_autocompact_override` (lee `ORCHESTRA_DEV_AUTOCOMPACT`) y `dev_autocompact_log` (append a `<datos>/autocompact-dev.log`, no hace nada sin la variable); registrados en main.rs; `backend.ts` con sus envoltorios.
- `SettingsAgents.svelte`: «Qué hace exactamente» + «Por qué no compacta ahora» por agente Claude + aviso de override; claves EN/ES `settings.agents.{howLabel,howBody,statusLabel,statusHint,statusEmpty,devOverride,reason.*}`.

### Comprobado
- Plantar (quitar las dos líneas nuevas de decideCompact): 3 tests FALLAN (ttl-too-short, user-typed, window follows TTL); restaurado: autocompact.test.ts 14/14.
- npm test 450/450; svelte-check 218 archivos 0/0; i18n:check OK (a)+(b).

### Prueba real (instancia aislada) — POSITIVO: PASA
- Montaje: exe de `cargo build --features tauri/custom-protocol` (CARGO_TARGET_DIR=<cache>\orchestra-target; ojo: `npx tauri build --debug` dejó un exe que cargaba el devUrl 127.0.0.1:1420) copiado a `_scratch/`; `_scratch/launch.sh` quita CLAUDE*/ORCHESTRA_TERM_ID/ORCHESTRA_ACCOUNT/NO_COLOR/TERM y pone ORCHESTRA_DATA_DIR, WEBVIEW2_USER_DATA_FOLDER, `--remote-debugging-port=9339` y `ORCHESTRA_DEV_AUTOCOMPACT=ctxK=1,afterSec=15,idleSec=0`. Panel sembrado (`seed.cjs`) con claude.exe (cuenta por defecto) en `_scratch/proj` vacía. Entrada REAL por CDP (`cdp.mjs`: Input.insertText / dispatchKeyEvent sobre el textarea de xterm -> onData).
- Registro (`_scratch/data/autocompact-dev.log`): 17:32:49 reason=too-early -> 17:33:02.998 `WROTE /compact pane=p_ac session=daabcba0-… ctx=53157 lastRequestAt=1794072767 ttl=3600` -> 17:33:15 reason=already-done (no repite).
- .jsonl `~/.claude/projects/<worktree-key>--scratch-proj/daabcba0-….jsonl`: 17:32:47 assistant «ok»; 17:33:03.423 user `/compact`; 17:33:14.308 `system compact_boundary {"trigger":"manual","preTokens":53161,"postTokens":18505,…}` + COMPACT_SUMMARY + «Compacted».

### Prueba real — NEGATIVO (borrador): PASA
- 17:34:39 se manda «Reply with just: ok3» y, con Claude aún trabajando, se teclea «borrador sin enviar» SIN Enter (el caso difícil: borrador anterior a lastRequestAt). Respuesta 17:34:43.
- Registro: 17:34:44 too-early -> 17:34:58.989 `reason=user-typed`; ningún WROTE durante 45 s con la ventana abierta (captura del prompt con el borrador: `_scratch/shot3.jpg`, borrable).
- 17:35:44 Ctrl+C (vacía el prompt) -> 17:35:44.982 `WROTE /compact`; .jsonl: 17:35:45.009 user `/compact` (limpio), 17:35:57.725 `compact_boundary {"trigger":"manual","preTokens":57200,"postTokens":19018}`. «borrador» aparece 0 veces en el .jsonl.
- Ajustes > Agents (CDP, captura `_scratch/shot4.jpg`): «Why it is not compacting now — ac-test: already compacted for this request.», aviso del override y registro con 3 compactaciones. Corregido tras verla: el texto decía «below» y los controles están encima («above» / «de arriba»).
- Antes del arreglo: sin `user-typed` habría escrito `/compact\r` detrás del borrador (lo demuestra el plantado de los tests; no se repitió con el exe de master).
- Cerrado: Claude con /exit, instancia con taskkill (WM_CLOSE). Ojo Git Bash: `node cdp.mjs … text "/exit"` lo convierte en `C:/Program Files/Git/exit` (MSYS); usar MSYS_NO_PATHCONV=1 (se coló un mensaje de más).
- Coste: 4 mensajes cortos + 3 compactaciones (~53-57 k de contexto, sobre todo el prompt de sistema).

### Comprobación final
- npm test 450/450; svelte-check 218 archivos 0/0; i18n:check OK; cargo test --bin orchestra 266 ok, 0 fallos, 15 ignoradas. Los 2 avisos de cargo son de remote_metrics.rs (no míos).

### Pendiente
- No se probó la caché de 5 min de verdad (la cuenta por defecto escribe 1 h: ttl=3600); `ttl-too-short` solo con tests.
- Borrar un borrador con Retroceso sigue contando como borrador hasta Enter/Ctrl+C (conservador, documentado).
- `_scratch/` (exe, datos, capturas, herramientas cdp.mjs/seed.cjs/jsonl.cjs/launch.sh) está excluido en info/exclude; borrable.

### Archivos (arreglo)
src/lib/{autocompact.ts,autocompact.test.ts,terminals.ts,store.svelte.ts,backend.ts}, src/lib/locales/{en,es}/settingsAgents.ts, src/components/SettingsAgents.svelte, src-tauri/src/{idle.rs,main.rs}, docs/ARCHITECTURE.md, este estado.
