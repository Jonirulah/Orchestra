# Estado: servidor MCP (F4, fase 1, solo lectura)

## Hecho
- `src-tauri/src/mcp.rs` (nuevo): `handle_rpc` + `strip_ansi` + `check_request` puras; servidor `tiny_http` en hilo
  (127.0.0.1, puerto 47821 o efímero si está ocupado); token 32 bytes hex (`getrandom`) en `<appdata>\mcp\token`;
  `claude-mcp.json`; auditoría `audit.jsonl` (rota a 1 MB, `.jsonl.1`); `McpManager` + comandos
  `mcp_configure / mcp_info / mcp_token / mcp_regenerate_token / mcp_sync / mcp_audit`.
- Herramientas: `list_hosts`, `list_terminals`, `read_terminal {pane_id, lines 1..500 (80)}`. Denegado = resultado con `isError:true`.
  `ask`/`full` se comportan como `read` (ganchos `// FASE 2` en `Access::can_read` y en `tool_defs`).
- Seguridad: bind 127.0.0.1; Bearer en tiempo constante; Origin solo http(s)://localhost|127.0.0.1; Host solo
  127.0.0.1:PORT / localhost:PORT; cuerpo <= 256 KB (413); GET/DELETE 405; ruta distinta de /mcp 404; la instantánea
  se deserializa con lista blanca (serde ignora campos extra) y un `agentAccess` desconocido cuenta como `none`.
- `pty.rs`: solo `Session::tail_bytes(max)`.
- Front: `src/lib/mcpsync.ts` (+ `mcpsync.test.ts`): `buildMcpSnapshot` copia campos uno a uno (sin secretos),
  `claudeAddCommand`. `model.ts`: `claudeSpec(..., {mcpConfig})` añade `--mcp-config '<ruta>'` (al final, tras `--settings`).
  `settings.ts`: `mcpEnabled` (true), `mcpExposeLocal` (false). `backend.ts`: envoltorios `mcp*`. `store.svelte.ts`:
  `mcp`, `mcpConfigPath`, `applyMcp()` (en init y al cambiar los ajustes), `syncMcp()` (debounce 300 ms, desde `persist()` y
  `setLive` cuando cambia `state`; no manda si el JSON no cambió).
- UI: `SettingsMcp.svelte` (activar, estado, copiar token, regenerar con doble clic, exponer locales, comando
  `claude mcp add` con `<token>` visible y token real al copiar, últimas 50 entradas, refresco cada 4 s) +
  entrada «MCP» en `SettingsDialog.svelte`. `HostDialog.svelte`: solo las etiquetas y el texto de ayuda de `agentAccess`.

## Cómo se comprobó (2026-11-06)
- svelte-check: 123 archivos, 0 errores, 0 avisos.
- `node --test src/lib/*.test.ts`: 68 pruebas, 68 ok (6 nuevas en mcpsync.test.ts, 1 en settings.test.ts).
- `cargo test` (con `CARGO_TARGET_DIR=<cache>`, porque `src-tauri\target\debug\orchestra.exe` está en uso
  por otra instancia y da «Acceso denegado»): 65 ok + 5 ok (askpass), 4 ignoradas; de ellas 38 son de `mcp::`.
- Pruebas que FALLAN con el fallo plantado (sed sobre mcp.rs, revertido y comparado con cmp):
  token acepta cualquiera -> `loopback_wrong_token_is_401` FAIL; Host sin comprobar -> `loopback_bad_host...` y
  `check_request_rules` FAIL; Origin sin comprobar -> `loopback_bad_origin...` FAIL; `can_read` siempre true -> 5 FAIL
  (list_hosts, list_terminals, read_terminal denegado, snapshot, loopback); método sin comprobar -> `loopback_get_and_delete_are_405`
  FAIL; límite de tamaño x100 -> `loopback_oversize_body_is_413` FAIL. Front: `mcpHost` con `...h` -> 2 FAIL.
  Sin planta: todo PASS (4 pasadas seguidas, sin parpadeos).
- Prueba real con ConPTY (`real_conpty_output_is_readable_through_tail_bytes`): `cmd /c echo ...` -> `"hola-mcp-real\nsegunda-linea"`.

## NO probado
- Ningún cliente Claude real contra el servidor (ni `claude --mcp-config`, ni `claude mcp add`). No se ha arrancado la app.
- No se ha visto la pantalla «MCP» (sin capturas, por encargo).
- Pantallas completas de TUI (Claude, vim) en `read_terminal`: ConPTY reescribe la pantalla con movimientos de cursor; la limpieza
  es de «mejor esfuerzo» (`H/f/B/E/d` -> salto de línea, `C` -> espacios, `K` borra) y puede repetir líneas.

## Dudas / límites conocidos
- `--mcp-config` en Claude Code es variádico: va al final del comando; si alguien añade argumentos posicionales después, los tragaría.
- Los paneles de Claude restaurados de una sesión anterior conservan el `spec` guardado: si se crearon antes de activar MCP no llevan
  el flag; si lo llevan y luego se apaga MCP, `claude-mcp.json` queda con `mcpServers: {}` (no intentan conectar a un puerto muerto).
  Tras regenerar el token, los Claude abiertos siguen con el viejo (401) hasta reiniciarlos (la UI lo avisa).
- Un cliente local malicioso puede mantener hasta 16 conexiones colgadas (tope `MAX_INFLIGHT`) y bloquear el servidor: sin timeout de lectura en tiempo real (tiny_http no lo expone).
- El token se guarda en claro en `<appdata>\mcp\token` y en `claude-mcp.json` (por usuario de Windows; no se aplican ACL).
- `resetAllSettings` ya reaplica MCP (pasa por `replaceSettings` -> `applyEffects`).
- No añadí `mcp` a `SECTION_KEYS` (la pestaña no tiene «Reset section»).
- Aviso de compilación ajeno: `quota.rs` import `serde_json::Value` sin usar.

## FASE 2 (no hecho)
`send_input`, `run_command`, `open_ssh`, confirmación en la interfaz para `ask`. Ganchos: `Access::can_read`, `tool_defs`, `call_tool`.

## Archivos tocados
Nuevos: `src-tauri/src/mcp.rs`, `src/components/SettingsMcp.svelte`, `src/lib/mcpsync.ts`, `src/lib/mcpsync.test.ts`.
Compartidos (ediciones pequeñas): `src-tauri/Cargo.toml` (tiny_http, getrandom), `src-tauri/src/main.rs`, `src-tauri/src/pty.rs`
(solo `tail_bytes`), `src/lib/model.ts`, `settings.ts`, `settings.test.ts`, `backend.ts`, `store.svelte.ts`,
`src/components/SettingsDialog.svelte`, `HostDialog.svelte`.
