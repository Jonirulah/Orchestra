# Estado: retomar sesiones de Claude al reabrir (resume)

## Hecho
- Rust: `claude_session_exists(dir, id)` en agents.rs (id `[0-9a-f-]{36}`, `dir` = carpeta de cuenta guardada via `store::is_account_dir`, existe `projects/*/<id>.jsonl`; solo existencia). Registrado en main.rs. `store::state_path/is_account_dir` pasan a `pub(crate)`.
- model.ts: `Pane.lastSession {id,dir,ended?}`, `isSessionId`, `resumeCandidate`, `restoreSpecFor`, `stripResume`, `trackSession`, `sessionForSave`, `claudeSpec({resumeId})` (`--resume <id>` antes de `--settings`/`--mcp-config`; id invalido = ignorado).
- store.svelte.ts: `resumeSavedSessions` (init, tras applyMcp), `trackSessions` (pollOnce; marca `ended` cuando un Claude visto desaparece con el panel vivo), `persistNow` usa `sessionForSave`, `switchAccount` usa el id si existe en la cuenta nueva (si no `--continue`).
- Ajuste `restoreClaudeSessions` (default true): settings.ts (tipo, DEFAULTS, clamp, SECTION_KEYS.agents), SettingsAgents.svelte, locales en/es.
- Docs: README, ARCHITECTURE (Restoring Claude sessions), SECURITY.

## Como se comprobo
- `npm run check` 0 errores 0 avisos; `npm test` 254/254 (mis tests: 19 en src/lib/resume.test.ts); `npm run i18n:check` OK, 0 hard-coded; `cargo test --bin orchestra` 194 ok, 0 avisos (mis tests: 4 en agents.rs).
- Bugs plantados (copia en scratchpad/plant, repo intacto): (a) id invalido -> 4 tests fallan; (b) ignorar ended -> 2; (c) mcp-config antes de resume -> 1; (d) sin comprobar exists -> 1. Rust: sin validar id -> 1; sin check de cuenta -> 1; siempre true -> 1.

## Pendiente / no verificado
- Restauracion real con un Claude vivo (prohibido lanzar Claude). El flujo store (init/pollOnce) no tiene test automatico (usa runas/Tauri); solo las funciones puras.
- Sin commit/push.
