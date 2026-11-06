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
