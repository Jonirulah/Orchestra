# Consumo de Codex y opencode desde sus ficheros locales — investigación (2026-11-07)

Solo lectura: codex-cli 0.167.0 (las sesiones las escribieron la 0.162.1, la 0.163.0-alpha y la 0.163.0) y opencode v2.2.5 (con datos de la 1.18.18 migrados), en Windows. Complementa `diseno_consumo.md` («Fuera (por ahora): Codex/opencode»).
Cifras **medidas en esta máquina** con scripts de Python en solo lectura sobre los ficheros reales. Las bases SQLite se abrieron
con `immutable=1` o desde una **copia**. No he abierto `auth.json`, la tabla `credential`, `account*` ni `session_share`.
En los ejemplos, todo texto, id y ruta está sustituido por «…»; los números y los nombres de campo son reales.

---

## 1. Codex

### 1.1 Dónde y formato
- Raíz: `%CODEX_HOME%`, por defecto `%USERPROFILE%\.codex`. **No hay carpetas `.codex-*` de otras cuentas** en esta máquina
  (`config.toml` fija `CODEX_HOME = %USERPROFILE%\.codex`). Si Orchestra crea cuentas, cada una será otra raíz `CODEX_HOME`.
- Sesiones: `sessions/AAAA/MM/DD/rollout-AAAA-MM-DDTHH-MM-SS-<uuid>.jsonl`, una línea JSON por evento. No hay `archived_sessions/`.
- Índices SQLite (sqlx). Sirven para listar rápido; la verdad está en el `.jsonl`:
  - `state_5.sqlite` → tabla `threads`: `id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
    tokens_used, git_sha, git_branch, git_origin_url, cli_version, agent_nickname, agent_role, agent_path, model, reasoning_effort,
    thread_source, creator_account_id…`. `tokens_used` coincide con `thread_token_usage.total_tokens` del rollout (en los
    compactados va un 1 % por detrás). La tabla `thread_spawn_edges(parent_thread_id, child_thread_id, status)` da el árbol de subagentes.
  - `thread_history_1.sqlite` → `thread_turns` (con `rollout_byte_offset` y `rollout_end_byte_offset` por turno, útil para
    leer de forma incremental) y `thread_items` (`item_type`, `item_json`). Es una proyección de los `item_completed` del rollout.
    **No contiene tokens.**
  - `logs_2.sqlite` (registro interno), `goals_1.sqlite` (`thread_goals.tokens_used/token_budget`, vacía), `history.jsonl`
    (`session_id, text, ts`: los prompts del usuario) y `session_index.jsonl` (`id, thread_name, updated_at`).
- Cada línea: `{"timestamp": ISO-8601, "ordinal": n, "type": …, "payload": {…}, "metadata"?: {…}}`.
  `ordinal` es monotónico dentro del fichero.

Recuento de tipos en las 39 sesiones (`type` / `payload.type`):
```
17649 event_msg/item_completed     8606 event_msg/token_count      7914 response_item/reasoning
7892 token_usage_record            5629 response_item/custom_tool_call (+ _output)
1966 response_item/function_call (+ _output)   1695 response_item/agent_message (+ inter_agent_communication_metadata)
1191 response_item/message   321 turn_context   273 task_started   242 task_complete   186 world_state
168 thread_settings_applied   63 session_meta   50 compacted   13 turn_aborted   9 response_item/additional_tools
```

### 1.2 Sesión, proyecto y modelo
- **Sesión**: `session_meta` (ordinal 0) → `payload.id` (= thread id, también en el nombre del fichero), `session_id`, `cwd`,
  `originator` (`codex-tui` | `Codex Desktop`), `source` (`vscode` o `{"subagent":{"thread_spawn":{…}}}`), `thread_source`
  (`user` | `subagent`), `cli_version`, `model_provider` (`openai`), `git` (opcional), `creator_account_id` (sirve para separar cuentas).
- **Proyecto** = `cwd` de `session_meta`, o mejor el de cada `turn_context` (puede cambiar).
- **Modelo**: en cada `turn_context.payload.model` y `effort` (`low|medium|high|ultra`). Una sesión puede cambiar de modelo:
  3 de las 39 mezclan `gpt-6-astra` y `gpt-6.1-sol`. Modelos vistos: gpt-6.1-sol (201 turnos), gpt-6-sol (66),
  gpt-6-astra (47) y gpt-6-luna (7).
  `token_usage_record` **no lleva el modelo**: se asigna por el `turn_id` → `turn_context` del mismo turno.

```json
{"timestamp":"…","ordinal":0,"type":"session_meta","payload":{"creator_user_id":"…","creator_account_id":"…","session_id":"…","id":"…","timestamp":"…","cwd":"…","runtime_workspace_roots":["…"],"originator":"…","cli_version":"…","source":"…","thread_source":"…","model_provider":"…","base_instructions":{"text":"…","provenance":{"type":"…","model":"…"}},"history_mode":"…","context_window":{"window_id":"…"}}}
{"timestamp":"…","ordinal":7,"type":"turn_context","payload":{"turn_id":"…","root_turn_id":"…","cwd":"…","model":"…","effort":"…","collaboration_mode":{"mode":"…","settings":{"model":"…","reasoning_effort":"…","developer_instructions":"…"}},"sandbox_policy":{…},"…":"…"}}
```

### 1.3 Tokens por petición
**`token_usage_record` (una línea por llamada al modelo, con `response_id`) es la fuente buena.**
```json
{"timestamp":"…","ordinal":15,"type":"token_usage_record","payload":{"thread_id":"…","turn_id":"…","session_id":"…","root_turn_id":"…","response_id":"…",
 "usage":            {"input_tokens":19533,"cached_input_tokens":13184,"cache_write_input_tokens":0,"output_tokens":271,"reasoning_output_tokens":51,"total_tokens":19804},
 "turn_token_usage": {…mismo esquema, acumulado en el turno…},
 "thread_token_usage":{…mismo esquema, acumulado en el hilo…}}}
```
Comprobado en las 39 sesiones:
- `usage` es **por petición**. La suma de `usage.input_tokens` del fichero es **exactamente** el último `thread_token_usage.input_tokens`
  (39 de 39). `turn_token_usage` es el acumulado del turno (0 discrepancias).
- Semántica de OpenAI: `input_tokens` **incluye** los cacheados (siempre `cached ≤ input`). La parte sin caché es `input − cached`.
  `reasoning_output_tokens` va **dentro** de `output_tokens` (`total = input + output`: 19533 + 271 = 19804).
- `cache_write_input_tokens` vale **0 en las 7892 peticiones**, aunque la tarifa oficial cobra la escritura de caché (ver §1.6):
  no se sabe qué parte de `input − cached` se escribió en caché.
- **Tamaño del contexto en cada petición = `usage.input_tokens`** (el prompt entero). Ventana: `model_context_window`
  en `task_started` y en `token_count` (258 400 o 475 000). Máximo visto: 387 458.
- **Base fija**: la primera petición de cada sesión lleva entre **17 k y 36 k** de entrada (instrucciones, herramientas, MCP y
  skills; ver `world_state` y `additional_tools`).
- Fallback: `event_msg/token_count` repite la información con la forma de versiones anteriores (`info.total_token_usage`,
  `info.last_token_usage`, `info.model_context_window`). Hay más líneas de este tipo que de `token_usage_record` (8606 frente a 7892)
  porque algunas se repiten: si se usan, hay que **deduplicar** cuando `total_token_usage` no cambia.

### 1.4 Herramientas, salidas, subagentes y compactación
- **El modelo tiene una sola herramienta de ejecución, `exec`** (`custom_tool_call`, entrada de texto libre: es **código
  JavaScript**, empieza por `text(`/`const` en el 99 %). Dentro de una `exec` corren comandos, MCP, ediciones y vistas de imagen.
  Lo que entra en el contexto es **`custom_tool_call_output.output[]`** (`input_text` + `input_image`), emparejado por `call_id`
  (5629 de 5629). `metadata.fallback_token_limit_override: 12000` es el tope de truncado de la salida.
- Para **clasificar** el bloque, usa los `item_completed` que caen entre el `custom_tool_call` y su `_output` (orden por `ordinal`;
  no llevan `call_id`). Medido: el 95 % de los comandos y el 100 % de FileChange e ImageView caen **dentro** de una `exec`.
  - `CommandExecution`: `command[]` (powershell/pwsh), `cwd`, `parsed_cmd[{type:"read"|"unknown", cmd, name?, path?}]`,
    `aggregated_output`, `exit_code`, `duration`. `read` con `path` permite atribuir por fichero, pero solo aparece en 88 de 4873:
    para «Read por fichero» habrá que analizar el comando (Get-Content, cat, rg…).
  - `McpToolCall`: `server`, `tool`, `arguments`, `result.content[]`, `isError`, `duration` → **por servidor y herramienta**.
    Vistos: node_repl/js 549, cua_repl/js 31, codex_apps/higgsfield.* y codex_app/*.
  - `FileChange` (`changes{ruta:{unified_diff}}`), `ImageView` (`path`), `Extension` (`web.search`, `clock.sleep`,
    `image_gen.generation`), `Reasoning`, `AgentMessage` (`phase`: `commentary`|`final_answer`), `UserMessage`.
  - Las `function_call` y `function_call_output` (`namespace`/`name`) son sobre todo de colaboración: `collaboration/send_message`,
    `wait_agent`, `spawn_agent`, `followup_task`, `list_agents`, más `mcp__cua_repl/js` y `clock/sleep`.
    `metadata.mcp_attribution.sources[{server_name, tool_name}]` indica qué MCP produjo la salida.
- Tamaños medidos de la salida de `exec`: mediana 1,4 k caracteres, p95 26 k, máx. 40 k; suma 31,6 M caracteres.
  Hay 1044 imágenes `input_image` dentro de esas salidas: el tamaño en tokens de una imagen **no** se deduce de los caracteres
  (se estima con el delta de contexto).
- Razonamiento: `response_item/reasoning` con `encrypted_content` (opaco) y `summary` vacío. Su peso solo se ve en
  `reasoning_output_tokens` y en el delta de entrada de la petición siguiente.
- **Atribución por bloque**: vale el mismo método que en `diseno_consumo.md`. El delta de `input_tokens` entre peticiones
  consecutivas, menos el `output_tokens` anterior, se reparte por caracteres entre los `response_item` nuevos (salida de `exec`,
  mensajes del usuario, `agent_message` entre agentes…).
- **Subagentes** (modo multiagente):
  - Cada subagente tiene **su propio rollout**. Su `session_meta` (ordinal 0) lleva `thread_source:"subagent"`, `agent_path`
    (p. ej. `/root/world_perf`), `agent_nickname`, `parent_thread_id`, `forked_from_id` y `subagent_history_start_ordinal`.
  - En el ordinal 1 hay una **copia del `session_meta` del padre** y, antes de `subagent_history_start_ordinal`, el historial heredado.
  - Los `token_usage_record` del fichero son **solo del hilo del subagente** (comprobado en 4 ficheros: el primer registro está
    después del ordinal de inicio). **No hay doble conteo** si se suma por `thread_id`, pero al atribuir bloques hay que saltarse
    el historial copiado.
  - Mensajes entre agentes: `response_item/agent_message` (`author` y `recipient` son rutas `/root/...`). Ciclo de vida:
    `item_completed/SubAgentActivity` (`kind`: started/interacted/completed/interrupted, `model`, `reasoning_effort`, `agent_thread_id`).
  - 26 de los 63 `session_meta` son de subagentes.
- **Compactación**: línea `compacted`, con `window_number`, `window_id`, `previous_window_id`, `replacement_history[]` (el nuevo
  contexto), `retained_context`, `compaction_response_id` y `latest_token_usage_record` (la última petición antes de compactar).
  También hay un `item_completed/ContextCompaction`. Hubo 50 compactaciones y una sesión llegó a la ventana 9.
  Después, `input_tokens` cae en la petición siguiente.
```json
{"timestamp":"…","ordinal":1000,"type":"compacted","payload":{"message":"…","replacement_history":[{"type":"…","role":"…","content":[{"type":"…","text":"…"}]},"…(+8)"],"replacement_history_metadata":[…],"retained_context":{…},"window_number":1,"first_window_id":"…","previous_window_id":"…","window_id":"…","compaction_response_id":"…","latest_token_usage_record":{"usage":{"input_tokens":203510,"cached_input_tokens":203008,"cache_write_input_tokens":0,"output_tokens":2769,"reasoning_output_tokens":0,"total_tokens":206279},"…":"…"}}}
{"timestamp":"…","ordinal":16,"type":"response_item","payload":{"type":"custom_tool_call_output","id":"…","call_id":"…","output":[{"type":"input_text","text":"…"},"…(+3)"],"internal_chat_message_metadata_passthrough":{"turn_id":"…","create_time":1791863132.93}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}}
{"timestamp":"…","ordinal":…,"type":"event_msg","payload":{"type":"item_completed","thread_id":"…","turn_id":"…","item":{"type":"CommandExecution","id":"…","process_id":"…","command":["…","…(+2)"],"cwd":"…","parsed_cmd":[{"type":"…","cmd":"…"}],"source":"…","status":"…","aggregated_output":"…","exit_code":0,"duration":{"secs":1,"nanos":277387500}},"started_at_ms":…,"completed_at_ms":…}}
{"timestamp":"…","ordinal":…,"type":"event_msg","payload":{"type":"item_completed","…":"…","item":{"type":"McpToolCall","id":"…","server":"…","tool":"…","arguments":{"code":"…","title":"…"},"readOnlyHint":true,"status":"…","result":{"content":[{"type":"…","text":"…"}],"isError":true},"duration":{"secs":30,"nanos":77576000}}}}
```
- Otros eventos útiles: `task_started` (`turn_trigger`: user|composer, `model_context_window`), `task_complete` (`duration_ms`,
  `time_to_first_token_ms`), `turn_aborted` (`reason`: interrupted). El TTL y la caché rota se pueden inferir de huecos
  entre `timestamp` y de caídas de `cached_input_tokens`.

### 1.5 Límites de uso
**Sí se registran**, en cada `event_msg/token_count` (8606 de 8606):
```json
"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":7.0,"window_minutes":10080,"resets_at":1792374113},"secondary":null,
 "credits":{"has_credits":true,"unlimited":false,"balance":"…"},"individual_limit":null,"spend_control_reached":null,"plan_type":"pro","rate_limit_reached_type":null}
```
- En esta cuenta (plan `pro`) solo hay ventana **semanal** (`window_minutes` 10080) y `secondary` siempre es null.
  En otros planes puede haber una ventana de 5 h: no he podido comprobarlo.
- `used_percent` tiene la precisión de un número entero: en una sesión salen 41 pares distintos (porcentaje, reinicio) y la última
  lectura fue 45 %. Sirve para dibujar la cuota y para atribuir el % gastado a cada sesión con precisión de ±1 punto.
  `resets_at` es una marca de tiempo Unix.

### 1.6 Precios (oficial: https://developers.openai.com/api/docs/pricing, consultado el 2026-11-07, tarifa Standard, $/1M tokens)
| modelo | entrada | entrada cacheada | escritura de caché 30 min / 12 h | salida | contexto largo (>272k de entrada) |
|---|---|---|---|---|---|
| gpt-6-sol | 2,00 | 0,20 (×0,10) | 2,50 / 5,00 | 10,00 (×5) | 4,00 / 0,40 / 15,00 |
| gpt-6.1-sol | 2,00 | 0,10 (×0,05) | 2,50 / 5,00 | 10,00 (×5) | 4,00 / 0,20 / 15,00 |
| gpt-6-astra | 10,00 | 1,00 (×0,10) | 12,50 / 25,00 | 50,00 (×5) | 20,00 / 2,00 / 75,00 |
| gpt-6-luna | 0,10 | 0,01 (×0,10) | 0,125 / 0,25 | 0,50 (×5) | 0,20 / 0,02 / 0,75 |

Pesos relativos a la entrada: lectura de caché ×0,1 (×0,05 en la 6.1-sol), escritura ×1,25 (30 min) o ×2,5 (12 h), salida ×5.
La página no explica cuándo se aplica cada escritura y el rollout no registra `cache_write_input_tokens` (siempre 0).
Para calcular la estimación, la entrada sin caché se toma a precio de entrada y se avisa de que la escritura va sin contar.
**El tramo de contexto largo (>272k) duplica la entrada** y en esta máquina se llegó a 387k: la regla de sugerencia
«contexto > 272k cuesta el doble» tiene sentido aquí.
Como Codex va con suscripción (`plan_type: pro`), mostrar el % de `rate_limits` además del «equivalente en tokens».

### 1.7 Disco
- `sessions/`: **667 MB**, 39 rollouts. El mayor ocupa 194 MB y 8 pasan de 20 MB: se lee en streaming con offset por fichero
  (`thread_turns.rollout_byte_offset` ayuda).
- `thread_history_1.sqlite` 97 MB, `logs_2.sqlite` 63 MB, `state_5.sqlite` 0,4 MB.
- `.codex` entero ocupa 4,2 GB, pero la mayor parte no es historial: `packages` 2,4 GB, `plugins` 474 MB, `.sandbox-bin` 326 MB.

---

## 2. opencode

### 2.1 Dónde y formato
- Datos: `%USERPROFILE%\.local\share\opencode\opencode.db` (SQLite en modo WAL, Drizzle). Hay un **WAL de 15 MB sin volcar**:
  leer sin el WAL (`immutable=1`) pierde filas. Para leer bien, abrir en `mode=ro` normal (necesita `-shm`) o sobre una copia de
  `db + -wal + -shm`. `storage/` (el antiguo almacén JSON) está prácticamente vacío: `storage/session_diff/*.json` y `migration`.
  No hay carpetas `.opencode-*`.
- Configuración: `%USERPROFILE%\.config\opencode\opencode.json`. Solo declara el MCP `unityMCP` (remoto); el proveedor no se
  configura ahí, sale de las credenciales (`auth.json` y la tabla `credential`, que no he abierto).
  `service.json` contiene un secreto: Orchestra no debe leerlo ni mostrarlo.
- **Dos generaciones de esquema en la misma base** (`kv: migration.v1-v2`):
  - v1 (sesiones de 1.18.x): `session`, `message(data JSON)` y `part(data JSON)`.
  - v2 (2.x): `session_v2`, `session_message(type, seq, data JSON)` y `session_part`, que en esta base está vacía: las partes
    van dentro de `session_message.data.content[]`.
  - La sesión v1 está duplicada en `session_v2`, con las mismas cifras. **Hay que leer solo v2** (o solo v1 si v2 no existe)
    para no contarla dos veces.

### 2.2 Sesión, proyecto y modelo
- `session_v2`: `id, project_id, parent_id` (subagente/tarea), `fork_session_id`, `directory` (= cwd), `title`, `version`
  (de opencode), `agent` (`build`…), `model` (JSON `{"id","providerID","variant"}`, el último usado), `time_created/updated`
  y `time_compacting`. **Ya trae los totales**: `cost` (USD), `tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
  tokens_cache_write`. Cuadran con la suma de los mensajes; en la sesión activa difieren menos del 0,02 %.
- `project`: `id, worktree, vcs, name`.
- El modelo va **en cada mensaje** (`data.model.{providerID,id,variant}`) y los cambios quedan en `session_message.type='model-switched'`
  (`model` y `previous`).
- Proveedores y modelos vistos: `venice` (z-ai-glm-5-3-flash 385 mensajes, nvidia-nemotron-3-5-lightning-30b-a3b 83,
  deepseek-v4-1-flash-1017-uncensored 25, grok-4-6 18, kimi-k2-7-code 12, mistral-small-2603 1) y `opencode` (Zen:
  deepseek-v4.1-flash-free 5).

### 2.3 Tokens por petición
Cada `session_message` de tipo `assistant` corresponde a **una llamada al modelo** (un paso; `finish:"tool-calls"` encadena el siguiente):
```json
{"time":{"created":…,"streamed":…,"completed":…},"agent":"build","model":{"id":"…","providerID":"venice","variant":"default"},
 "content":[{"type":"reasoning","text":"…","time":{…}},"…(+2)"],"finish":"tool-calls","rawFinish":"…","cost":0.00174065,
 "tokens":{"input":9341,"output":100,"reasoning":579,"cache":{"read":0,"write":0}}}
```
- Los valores son **por petición, no acumulados**. Para v1 está el mismo dato en `part` `step-finish` (`tokens`, `cost`) y en `message`.
- `input` **excluye** la caché: el código de opencode resta `cache.read + cache.write` salvo en Anthropic/Bedrock.
  Se ve en los datos: una sesión suma 4,06 M de `input` y 81,7 M de `cache.read`.
  **Contexto de la petición = `input + cache.read + cache.write`**. Máximo visto: 448 k.
- `reasoning` va **aparte** de `output`: `total = input + output + reasoning + cache.read` (8229 + 129 + 137 + 128 = 8623 en v1).
- **`cost` ya viene calculado en USD** por opencode a partir del catálogo de models.dev (guardado en `kv: models-dev:v2:catalog`).
  Orchestra puede usarlo tal cual o recalcular con ese mismo catálogo.

### 2.4 Herramientas, subagentes y compactación
- v2: las llamadas van en `content[]` del mensaje `assistant`:
```json
{"type":"tool","id":"…","name":"shell","executed":false,"native":{},"state":{"status":"completed","input":{"command":"…"},
 "content":[{"type":"text","text":"…"}],"metadata":{"status":"completed","truncated":false,"exit":0}},"time":{"created":…,"ran":…,"completed":…}}
```
  Herramientas vistas: `shell` 232, `edit` 117, `write` 86, `read` 60 (`input.path`, `limit`, `metadata.truncated`), `grep` 20,
  `bash` 10, `glob` 7 y `todowrite` 2. Los nombres se corresponden directamente con las categorías del diseño (Read por fichero,
  Bash por comando, Grep/Glob). Las herramientas MCP aparecerían con su propio `name`; aquí no hubo ninguna.
  El tamaño del bloque es la longitud de `state.content[].text`.
- v1: `part.type='tool'` con `tool`, `callID`, `state.{status,input,output,metadata,time}` (en v1 `output` es una cadena).
- Otros tipos de `session_message`: `user`, `synthetic` (salidas de trabajos de shell en segundo plano, con `metadata.jobID` y
  `exit`), `system`, `idle`, `model-switched` y `compaction`.
- **Compactación**: `type='compaction'` con `reason:"auto"`, `status`, `summary`, `metadata.keepID`, `model`, `cost` y `tokens`
  (la petición de resumen: `input` 234 882). En la sesión queda `time_compacting`.
- **Subagentes**: la herramienta `task` crea sesiones hijas (`session_v2.parent_id`). La tabla `job` (`child_session_id`, `kind`)
  enlaza trabajos. En esta máquina no hay ninguna sesión hija, así que no se ha podido comprobar el formato de una.
- **Límites de uso**: no hay. opencode no guarda rate limits; con Venice se paga por uso y el dato útil es `cost`.

### 2.5 Precios (catálogo models.dev guardado por opencode en `kv`, $/1M; fuente: https://models.dev)
| proveedor/modelo | entrada | lectura de caché | salida | notas |
|---|---|---|---|---|
| venice/z-ai-glm-5-3-flash | 0,15 | 0,03 (×0,2) | 0,50 (×3,3) | contexto de 1M |
| venice/deepseek-v4-1-flash-1017-uncensored | 0,33 | 0,00825 (×0,025) | 1,32 (×4) | |
| venice/kimi-k2-7-code | 0,75 | 0,16 (×0,21) | 3,50 (×4,7) | |
| venice/grok-4-6 | 2,27 | 0,57 (×0,25) | 6,80 (×3) | >200k: 4,53 / 1,13 / 13,6 |
| opencode/deepseek-v4.1-flash-free | 0 | 0 | 0 | gratis |
No vienen en el catálogo los modelos nemotron ni mistral-small de Venice; para ellos solo cuenta el `cost` guardado.
Los pesos cambian mucho por modelo: la tabla tiene que salir del catálogo, no fijarse en código.

### 2.6 Disco
`.local\share\opencode` ocupa 45 MB: `opencode.db` 30 MB más un WAL de 15 MB, `log` 0,9 MB. En total, 3 sesiones y unos 650 mensajes.

---

## 3. Viabilidad y riesgos
- **Codex: viable con buena precisión.** Tokens exactos por petición (los acumulados cuadran al token) y tamaño de contexto por
  petición. Subagentes con árbol explícito. Compactación marcada. % de cuota semanal registrado.
  La atribución por bloque (salida de `exec` y lo que pasa dentro) es una estimación por caracteres, igual que en Claude.
  Huecos: escritura de caché sin dato, razonamiento cifrado e imágenes sin tamaño.
- **opencode: viable y más sencillo.** Hay tokens y coste en USD por petición y por sesión, y las herramientas tienen nombres
  directos. Huecos: no hay rate limits y no se han visto subagentes reales.
- **Riesgos de formato**:
  1. Codex cambia el rollout entre versiones menores. Aquí hay tres versiones en tres semanas; `token_usage_record`,
     `world_state` y `exec` en modo código son nuevos respecto al formato público antiguo, que solo tenía `token_count`.
     El analizador debe ser tolerante: ignorar tipos desconocidos, usar `token_count` si falta `token_usage_record` y probarse
     con muestras anonimizadas de cada versión.
  2. opencode migró de v1 a v2 dentro de la misma base y `session_part` aún está vacía: puede que las partes se muevan ahí.
     Hay que detectar el esquema con `PRAGMA table_info` y la tabla `migration`.
  3. SQLite en uso: abrir siempre en solo lectura, sin bloquear y con WAL. Nunca escribir ni hacer checkpoint.
  4. Privacidad: las bases y carpetas contienen tokens de autenticación (`auth.json` en ambas, la tabla `credential` y
     `service.json` en opencode). El índice de Orchestra solo debe tocar las tablas y campos listados aquí.
