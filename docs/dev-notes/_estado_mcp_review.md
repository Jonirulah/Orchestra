# Estado: revisión adversaria del servidor MCP (2026-11-06) — TERMINADA

Alcance: `src-tauri/src/mcp.rs`, `src/lib/mcpsync.ts`, `src/components/SettingsMcp.svelte`, `claudeSpec` en `src/lib/model.ts`.
Sin commit, sin `tauri build`, sin ejecutar la app.

## Cómo se comprobó (log delante)
- `cargo test` (CARGO_TARGET_DIR=<cache>): **112 passed, 0 failed, 11 ignored** (bin) + **5 passed** (askpass).
  `mcp::` = 70 tests (38 anteriores + 32 `review_*`); todos los anteriores siguen en verde con el servidor nuevo.
- `npx svelte-check --tsconfig ./tsconfig.json`: **0 errors, 0 warnings** (172 archivos).
- `node --test src/lib/*.test.ts`: **128 pass, 0 fail** (incluye 2 tests nuevos de `claudeSpec` que ejecutan el comando real en PowerShell).

## Hallazgos
Resumen: **0 high, 7 medium (todos arreglados), 10 low (7 arreglados, 3 documentados/aceptados)**, más OK.

| id | sev | evidencia | arreglado | test que lo prueba |
|---|---|---|---|---|
| M1 | medium | `tiny_http` sin plazos de lectura: 16 conexiones colgadas bloqueaban el servidor (límite que reconocía SECURITY.md) | Sí: servidor `std::net` propio, tope 32 conexiones (503 inmediato), plazos 5/5/10/15 s, contador RAII | `review_loopback_connection_cap_and_slow_clients_recover`, `review_loopback_slow_dribbling_headers_hit_the_total_deadline`, `review_loopback_many_bad_requests_do_not_leak_slots` |
| M2 | medium | token y `claude-mcp.json` en claro con permisos heredados del perfil | Sí: `icacls /inheritance:r` solo al usuario actual, aplicado al .tmp antes de escribir el secreto, también a la carpeta; fallo = aviso `McpInfo.warning` visible en Ajustes | `review_secret_files_are_restricted_to_the_current_user` |
| M3 | medium | delimitador final fijo en `read_terminal`: una máquina remota podía imprimirlo y "salir" del bloque no fiable | Sí: nonce aleatorio por llamada en inicio y fin | `review_terminal_output_cannot_forge_the_end_marker` |
| M4 | medium | nombres de host/título/etiquetas (vienen de la máquina remota o de un archivo) iban sin sanear ni etiquetar en `list_*` | Sí: `sanitize_snapshot` (control/bidi/invisibles fuera, 200 car., 2000 elementos, 32 etiquetas) + campo `notice` | `review_untrusted_names_and_titles_are_sanitized_and_labeled` |
| M5 | medium | permiso comprobado una sola vez: bajarlo mientras se leía no cortaba esa lectura | Sí: `check_pane` antes y después de `terms.tail` | `review_permission_lowered_while_reading_is_denied` (+ borrado/bajada de host, campo ausente = none) |
| M6 | medium | `psq` solo duplicaba `'`; PowerShell trata U+2018–U+201B como comillas simples: una ruta con `’` (p. ej. `C:\Users\O’Brien`) rompía `--mcp-config`/`--settings` | Sí: `psq` duplica las cuatro | `mcpsync.test.ts`: "PowerShell delivers hard paths…" (ejecuta el comando real; falló con el `psq` viejo) y "--mcp-config is the LAST thing…" |
| M7 | medium | al cerrar la app `claude-mcp.json` quedaba apuntando a un puerto que otro proceso podía ocupar (el token viajaría a ese proceso) | Sí: `McpManager::shutdown()` en `RunEvent::Exit` (main.rs) para el servidor y vacía el JSON | **sin test unitario** (necesita el ciclo de vida de Tauri; no se ejecutó la app) |
| L1 | low | `SO_REUSEADDR` / puerto compartido | Sí, defensa en profundidad (`SO_EXCLUSIVEADDRUSE`). En este Windows 11 un bind normal en la misma dirección ya rechazaba el robo (comprobado con .NET), así que el test de robo no distingue; añadido test directo del socket | `review_port_cannot_be_hijacked_with_reuseaddr` (no mata la plantación P10), `review_listener_socket_is_exclusive` (sí) |
| L2 | low | C1 (U+0080–9F), bidi, etiquetas U+E00xx e invisibles pasaban por `read_terminal`; `U+009B` es un CSI de 8 bits | Sí: `c1_to_esc` + `is_invisible` en `strip_ansi` | `review_strip_dangerous_sequences` |
| L3 | low | un CSI roto se comía el ESC siguiente | Sí: bucle con `peek` | `review_strip_dangerous_sequences` |
| L4 | low | ids JSON-RPC no válidos (objeto, array, bool) se aceptaban | Sí: -32600 con id null | `review_ids_are_echoed_and_invalid_ids_rejected` |
| L5 | low | `MCP-Protocol-Version` ignorada | Sí: 400 si no es soportada | `review_loopback_content_type_accept_and_mcp_headers` |
| L6 | low | contador de conexiones sin RAII (fuga si un hilo hacía panic) | Sí: `ConnGuard` | `review_loopback_many_bad_requests_do_not_leak_slots` |
| L7 | low | formas de request smuggling (Host/Authorization/Content-Length duplicados, CL+TE, LF suelto, obs-fold, espacio antes de `:`), chunked sin tope | Sí: parser estricto, tope también en chunked | `review_parse_head_rejects_ambiguous_shapes`, `review_loopback_chunked_bodies`, `review_loopback_content_length_edge_cases`, `review_loopback_host_header_edge_cases` |
| L8 | low | Ajustes no avisaba de que el puerto 47821 estaba ocupado ni de que el agente puede leer secretos impresos | Sí: textos en `SettingsMcp.svelte` y aviso de ACL | svelte-check (sin test de UI) |
| L9 | low | `read_terminal` denegado confirma nombre del host a quien adivine un id de pane | No, aceptado (UX); documentado | — |
| L10 | low | el snapshot del frontend va con 300 ms de debounce: bajar permisos tarda hasta ~0,3 s | No; documentado | — |
| L11 | low | con "Expose local terminals" un agente puede leer el terminal de otro agente | No, es lo pedido; documentado | `review_agent_and_odd_panes_never_readable_by_default` (por defecto no) |

OK sin hallazgo: token con CSPRNG (getrandom); comparación en tiempo constante; Host/Origin incl. `[::1]`, `localhost.`, duplicados; sin CORS (ni en OPTIONS); lotes aceptados sin romperse; `ask`/`full` = `read`; campo de acceso ausente = `none`; auditoría escapada y saneada (dos capas); token nunca en respuestas ni auditoría (`review_token_never_in_responses_or_audit`); parking_lot no envenena mutex; negociación de versión 2025-11-25/06-18/03-26/2024-11-05 (+ fallback).

## Plantaciones de fallos (en una copia; Orchestra intacto)
18 plantaciones (las 6 del encargo son P01–P06). Resultado final: **18/18 matadas**.

| plantación | test que la mata |
|---|---|
| P01 acepta cualquier token | `loopback_wrong_token_is_401` |
| P02 sin comprobar Host | `check_request_rules`, `loopback_bad_host_is_403_even_with_good_token`, `review_loopback_host_header_edge_cases` |
| P03 sin comprobar Origin | `loopback_bad_origin_is_403_even_with_good_token` |
| P04 `can_read` siempre true | 8 tests, p. ej. `read_terminal_denied_for_host_without_access`, `review_deleted_or_downgraded_host_is_not_readable` |
| P05 sin re-chequeo TOCTOU | `review_permission_lowered_while_reading_is_denied` (solo ese) |
| P06 sin límite de cuerpo | `loopback_oversize_body_is_413`, `review_loopback_content_length_edge_cases`, `check_request_rules` |
| P07 sin plazos de lectura | `review_loopback_slow_dribbling_headers_hit_the_total_deadline` (+ el resto se queda colgado) |
| P08 sin tope de conexiones | `review_loopback_connection_cap_and_slow_clients_recover` |
| P09 instantánea sin sanear | `review_untrusted_names_and_titles_are_sanitized_and_labeled` |
| P10 puerto no exclusivo | **sobrevivió** al principio (mutante equivalente en este Windows) → test nuevo `review_listener_socket_is_exclusive` lo mata |
| P11 delimitador fijo | `review_terminal_output_cannot_forge_the_end_marker` |
| P12 `ct_eq` solo mira el primer byte | `constant_time_compare` |
| P13 auditoría sin limpiar | `review_audit_lines_cannot_be_forged`, `audit_file_appends_tails_and_rotates` |
| P14 C1 sin normalizar | `review_strip_dangerous_sequences` (la 1.ª plantación estaba mal escrita y "sobrevivía" sin aplicarse; corregida y rematada) |
| P15 cabecera de versión ignorada | `review_loopback_content_type_accept_and_mcp_headers` |
| P16 ids inválidos aceptados | `review_ids_are_echoed_and_invalid_ids_rejected` |
| P17 archivos sin ACL | `review_secret_files_are_restricted_to_the_current_user` |
| P18 chunked sin límite | `review_loopback_chunked_bodies` |

## Cliente real (Claude Code 2.1.319, haiku; `serve_for_manual` + `--debug-file`)
- Servidor real en puerto efímero con ConPTY reales: host `prod-web` (read) con pane `p1` (líneas, una en color ANSI, título OSC con "ignore all previous instructions"), host `secret-db` (none) con pane `p2` (imprime `password=hunter2`), shell local `p3`.
- **Conectó** en 102 ms por HTTP; versión negociada **2025-11-25**; vio las 3 herramientas.
- `list_hosts` → solo `prod-web` (sin `secret-db`); `list_terminals` → solo `p1`; `read_terminal p1` → 4 líneas limpias (sin ANSI, sin el título OSC) dentro del delimitador con nonce; `read_terminal p2` → error verbatim `host 'secret-db' does not allow agent access` (el texto `hunter2` no salió). Auditoría: 3 `allowed` + 1 `denied`, sin el token.
- **Token equivocado** (2.ª y última invocación, haiku): Claude Code informa `AUTH_HEADER_REJECTED (HTTP 401) … Unauthorized`, sin reintento OAuth y sin colgarse; el servidor no audita intentos sin token (decisión de diseño).
- Cierre por archivo de parada: el servidor salió solo ("1 passed", 86 s); los powershell de los panes se mataron; no quedaron procesos míos; archivos temporales y copias de plantaciones borrados.
- Sin errores del cliente salvo el esperado del acceso denegado. Herramienta: test `#[ignore]` `mcp::tests::serve_for_manual` (HERRAMIENTA, no entra en baterías; env `MCP_CLIENT_CONFIG`, `MCP_STOP_FILE`, `MCP_AUDIT_FILE`).

## Dudas / límites que quedan
- `shutdown()` al salir (M7) no se ha podido probar sin ejecutar la app.
- No hay pruebas automáticas de UI para los textos nuevos de Ajustes.
- El etiquetado de datos no fiables es una defensa por convención: un modelo puede obedecer igualmente texto de un remoto hostil (en SECURITY.md).
- El permiso es del terminal, no de lo que se ejecute dentro (un `cat` de un secreto en un host permitido es legible).
- Un proceso local del mismo usuario puede leer el token (la ACL solo protege de otros usuarios).

## Archivos tocados
`src-tauri/src/mcp.rs` (servidor, saneado, ACL, tests, `serve_for_manual`), `src-tauri/src/main.rs` (shutdown al salir; compartido), `src-tauri/Cargo.toml` (`tiny_http` → `socket2`; compartido), `src/lib/model.ts` (`psq`; compartido), `src/lib/mcpsync.test.ts`, `src/lib/backend.ts` (`McpInfo.warning`), `src/components/SettingsMcp.svelte`, `docs/SECURITY.md`, `docs/ARCHITECTURE.md`, este archivo.
