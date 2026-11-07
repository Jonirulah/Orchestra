# Estado: MCP run_command (fase 2 del MCP, v0.2.0)

## Brief (para el obrero)
Objetivo: que el MCP de Orchestra (`src-tauri/src/mcp.rs`) permita ejecutar comandos en hosts SSH, respetando el nivel de acceso por host (`read` / `ask` / `full`, ya existente y devuelto por `list_hosts`).

Entrega:
1. Herramienta MCP `run_command(host, cmd, timeout_secs?)`.
   - `read` -> rechaza con error claro que nombra el modo del host y dice que el usuario debe subirlo a `ask`/`full`.
   - `ask` -> muestra al usuario un diálogo/aviso en la app con host + comando exacto; solo ejecuta si aprueba; si rechaza o expira (p. ej. 120 s) -> error "denied by user"/"timed out".
   - `full` -> ejecuta directo.
   - Devuelve stdout, stderr, exit_code, truncated (tope de salida, p. ej. 64 KB por flujo) y duración. Timeout por defecto 60 s, máximo 600 s; al vencer se mata el proceso.
   - Reutiliza la bóveda/credenciales y la política de host key (StrictHostKey=yes) existentes; NUNCA devuelve credenciales.
2. Registro de auditoría: cada intento (también rechazados) se guarda con hora, host, comando, modo, decisión (auto/aprobado/denegado/expirado), exit_code, duración. Fichero local en el data dir (respeta ORCHESTRA_DATA_DIR), con rotación simple, permisos restringidos como los demás secretos. No guardar la salida completa, solo primeras líneas (p. ej. 2 KB).
3. Descripciones de las tools y mensajes de error: la salida remota es dato no fiable. Las instrucciones del servidor MCP deben decir que ya no es solo lectura.
4. i18n EN + ES para cualquier texto de UI nuevo (diálogo de aprobación). `npm run i18n:check` debe pasar.
5. Docs: README (EN/ES) y SECURITY.md actualizados (qué puede hacer cada nivel, auditoría). CHANGELOG entrada 0.2.0. Subir versión a 0.2.0 en package.json, Cargo.toml, tauri.conf.json (y lockfiles que correspondan). NO commitear, NO push, NO crear release: eso lo hace el orquestador.

Criterio de hecho (medible): 
- Tests nuevos: read rechaza; ask sin aprobación no ejecuta y con aprobación sí; full ejecuta; timeout mata; truncado; auditoría escrita en los tres casos; host inexistente -> error. 
- `svelte-check` 0/0, `npm test` verde, `cargo test --bin orchestra` verde, `npm run i18n:check` OK.
- Ejecución real contra un host: NO hay host real autorizado; probar con un servidor SSH local de prueba si es posible, y decirlo honestamente si no.

Cómo probar / compilar: `CARGO_TARGET_DIR=E:\_cache\orchestra-target`. Instancia aislada con `ORCHESTRA_DATA_DIR` + `WEBVIEW2_USER_DATA_FOLDER`. Hay una instancia de prueba del usuario abierta: no cerrarla. `Copy-Item` conserva mtime -> usar touch si cargo no recompila. Vigilar Latin-1 y CRLF en los ficheros editados.

No tocar: lógica de terminales, cuentas, temas, release/CI, nada fuera de mcp, ajustes de acceso y su UI mínima, i18n, docs.

Fuera de alcance (fase 3): request_access, send_to_terminal, upload/download.

## Estado (final del obrero)
- hecho: backend run_command (mcp.rs + mcp_exec.rs, remote_metrics::base_args), auditoria ampliada en audit.jsonl, ApprovalHub (eventos mcp-approval / mcp-approval-end, comando mcp_approval_answer), frontend (McpApproval.svelte, store.mcpApprovals, backend.ts, mcpsync.ts con datos de conexion solo ask/full, tabla de auditoria), i18n EN/ES (mcpApproval.ts + textos de acceso), docs (README EN/ES, docs/SECURITY.md, SECURITY.md, CHANGELOG 0.2.0), version 0.2.0 (package.json, package-lock, Cargo.toml, Cargo.lock, tauri.conf.json, settings.ts APP_VERSION).
- cómo se comprobó: svelte-check 0/0 (218 ficheros); npm test 445/445; cargo test --bin orchestra 265 ok, 0 fallos, 15 ignorados; i18n:check OK (863/863 claves). Planta: con Read permitido, run_command_read_mode_is_rejected... FALLA; restaurado y verde.
- NO verificado: ejecucion contra un servidor SSH real (no hay sshd local ni host autorizado); el dialogo en la app real (no se abrio la GUI; solo svelte-check); ApprovalHub con AppHandle real (la aprobacion se prueba con un Approver falso); expiracion de 120 s real; request_user_attention.
- pendiente para el orquestador: probar a mano con instancia aislada + un host real; commit/release.
- archivos: ver git status (src-tauri/src/{mcp.rs,mcp_exec.rs,remote_metrics.rs,main.rs}, src/lib/{mcpsync.ts,backend.ts,store.svelte.ts,settings.ts}, src/components/{McpApproval,SettingsMcp}.svelte, src/App.svelte, locales, docs, versiones).
