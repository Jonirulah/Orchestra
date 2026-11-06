# Orchestra — diseño y hoja de ruta

Gestor de terminales, SSH y agentes de IA para Windows. Tauri 2 (Rust) + Svelte 5 + xterm.js.
Prioridades del usuario: (1) terminales en cuadrícula ajustable, (2) bóveda de SSH «como Termius pero mejor»,
(3) **elegir y cambiar la suscripción de Claude por terminal** (puede haber varias), (4) ver qué hace cada agente y
controlar cuotas, (5) que los Claude puedan conectarse a las máquinas.

## Decisiones

| Tema | Decisión | Por qué |
|---|---|---|
| Base | Tauri 2 + WebView2 | 12 MB de exe, poca RAM (convive con Godot); Rust y MSVC ya estaban instalados |
| Terminal | xterm.js 6 + WebGL (máx. 12 contextos) | Estándar de facto; Chromium limita ~16 contextos WebGL |
| PTY | `portable-pty` (ConPTY) en Rust | El backend es dueño de los procesos: cerrar la ventana no los mata |
| SSH | `ssh.exe` del sistema dentro del PTY | Hereda ssh-agent, ~/.ssh/config, ProxyJump, claves; cero criptografía propia |
| Persistencia de sesiones | Cerrar con la X oculta a la bandeja si hay procesos vivos | Los agentes corren horas; salir solo desde la bandeja |
| Estado | JSON opaco en `%APPDATA%\dev.orchestra.app\state.json` | El frontend manda; el backend solo escribe atómico |
| Disco | Todo en E: (`CARGO_HOME`, caché npm) | La unidad del sistema tiene poco espacio libre |

**Reenganche**: cada PTY guarda 2 MiB de salida en un anillo; `pty_attach` reenvía el histórico y luego lo vivo bajo
el mismo cerrojo (sin huecos ni duplicados). **ConPTY pregunta `ESC[6n` y no avanza hasta recibir respuesta**: en la
app contesta xterm; en pruebas hay que contestar a mano.

## Modelo de la cuadrícula
`Workspace{cols[], rows[] (fracciones), panes[]}`; cada panel tiene `col,row,colSpan,rowSpan,parked`.
Plantillas = tamaño N×M. Al reducir, los paneles que no caben pasan a `parked` (**siguen vivos**, sección
«Segundo plano»). Divisores alineados con mínimo de 140 px; doble clic iguala. Spans (fusionar celdas) ya están en el
modelo, falta la interfaz.

## Cuentas de Claude (hecho)
Cuenta = carpeta `CLAUDE_CONFIG_DIR`. Se detectan `~/.claude` y `~/.claude-*` y se lee su identidad de
`.claude.json → oauthAccount` (la de `.claude` está en `~/.claude.json`). Añadir cuenta crea la carpeta con
**junctions** a `projects/agents/skills/plugins` de `~/.claude` (sin admin) y copia `CLAUDE.md`/`settings.json`.
Como `projects` es común, **una conversación se puede continuar con otra cuenta**: cambiar la cuenta de un panel
relanza `claude --continue` con el `CLAUDE_CONFIG_DIR` nuevo.
Pendiente: `--resume <sessionId>` exacto en vez de `--continue` (necesita F1).

## Agentes en la barra lateral (F1, hecho)
`agent_scan` (Rust, cada 2 s): panel -> pid del PTY -> árbol de procesos (`sysinfo`) -> `claude.exe` -> `<cuenta>/sessions/<pid>.json`
-> transcript. Devuelve estado (`busy/idle/waiting/shell`; `new` si el programa corre pero aún no hay conversación: **la sesión
se registra al enviar el primer mensaje**), título, herramienta en curso, contexto, subagentes (llamadas `Agent`; los de fondo se
dan por activos si su `subagents/agent-<id>.jsonl` se tocó hace <25 s), tareas (`TodoWrite`, solo si Claude lo usa) y tokens.
Clic en un agente/subagente enfoca su terminal (cambia de espacio, saca de segundo plano). Avisos al pasar a `waiting` y al terminar.
Validado con 8 sesiones vivas reales (`cargo test real_claude_link -- --ignored --nocapture`).
- **Tokens por sesión**: suma incremental (recuerda el byte leído; 44 MB: 0,46 s la primera vez, 91 µs después), deduplicada por
  `message.id` con máximo por campo. Coincide con una medición independiente en Python (927 vs 919 peticiones, 230,4 vs 229,6 M).
  Los subagentes se suman aparte en un hilo de fondo (una sesión tenía 16.466 peticiones de subagentes: 16,3 M de salida frente a
  1,5 M del hilo principal, 2.360 M leídos de caché).
- **Caché de prompt** (medido en 8 sesiones grandes): todas usan TTL de **1 h** (5 min: 0). 866 M leídos vs 21,6 M creados. Solo 46 de
  3.872 peticiones llegan tras >60 min de hueco, pero son ~1/3 de lo creado (reescriben todo el contexto). Un refrescador de 5 min no
  sirve; refrescar de verdad exige mandar un mensaje DENTRO de la sesión (la caché depende del prefijo), así que NO se automatiza.
  Se muestra la cuenta atrás de la caché por agente y el coste de reescribirla. Razonamiento: 28 % de la salida (47-55 % en 2 sesiones)
  -> idea pendiente: esfuerzo de razonamiento por terminal (a verificar el mecanismo: `effortLevel` en settings vía `--settings`).
- **Elección de cuenta al crear terminal** (`policy.ts`, probado): manual / round-robin / la que se reinicia antes / la más libre.
  Descarta cuentas sin sesión o agotadas; si todas lo están, la que se libera antes. Sin datos de cuota (hasta F2) cae a round-robin.
- La interfaz está en **inglés** (decisión del usuario, 2026-11-06); los comentarios del código y estos documentos, en español.

## Estado a 2026-11-06 (qué hay hecho y qué no)
| Hecho | Cómo se comprobó |
|---|---|
| F0 cuadrícula, PTY, hosts, cuentas, cambio de cuenta por panel | pruebas Rust (PTY real) y de modelo |
| F1 árbol de agentes, tokens por sesión, caché | 8 sesiones vivas reales + modo demo |
| Interfaz en inglés | svelte-check, grep de textos, captura de la ventana real |
| Ajustes (6 secciones, cambios en vivo, temas, importar/exportar) | pruebas + modo demo en navegador |
| F2 barras de uso 5 h / 7 d con cuenta atrás (envoltorio de statusline) | prueba extremo a extremo con cargas de muestra; **sin payload real de Claude** |
| Auto-compact en inactividad (apagado por defecto) | pruebas de la decisión + `GetLastInputInfo` real; **sin `/compact` real** |
| F4 fase 1: servidor MCP de solo lectura, permiso por host, auditoría | 38 pruebas incl. servidor HTTP real y ConPTY real; **sin cliente Claude real** |
| F3 fase 1: secretos en Credential Manager, askpass, gestor de claves | en curso (ver `docs/dev-notes/_estado_vault.md`) |

**Pendiente**: MCP fase 2 (`send_input`, `run_command`, `open_ssh`, confirmación en la UI para `ask`), túneles, snippets y
broadcast, SFTP, restaurar agentes con `--resume` al reabrir, nota de relevo al cambiar de cuenta, esfuerzo de razonamiento por
terminal (`--effort` existe en la CLI), lectura de sesiones de Codex, instalador, arranque con Windows, licencia.

**Límites conocidos**: la salida de aplicaciones a pantalla completa (incluido Claude) llega a `read_terminal` con repeticiones
(ConPTY reescribe la pantalla); el token del MCP está en claro en la carpeta de datos del usuario; terminales de Claude abiertas
antes de activar MCP o la captura de uso no llevan los parámetros hasta reabrirse; el envoltorio de statusline añade ~110 ms.

## Hoja de ruta

- **F0 (hecho)**: cuadrícula, espacios de trabajo, PTY, shells, bóveda básica de hosts, cuentas y cambio por panel,
  paleta, búsqueda, bandeja. Backend: 5 pruebas Rust; modelo: 9 pruebas; svelte-check limpio.
- **F1 — Qué hace cada agente.** Fuentes verificadas:
  - `~/.claude/sessions/<pid>.json`: registro vivo (`pid, sessionId, cwd, status, name, updatedAt`). Se enlaza con el
    panel recorriendo el árbol de procesos desde el pid del shell (o por `ORCHESTRA_TERM_ID`).
  - Transcripts `projects/*/<id>.jsonl`: `tool_use` (qué herramienta y argumentos), `message.usage` (tokens),
    `session-owner{accountUuid}` (**atribuye cada sesión a su cuenta aunque `projects` sea común**), `ai-title`.
  - Codex: `~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl` (`task_started/complete`, `function_call`, `token_count`).
  - Hooks de Claude vía `--settings` propio (sin tocar el global): `PreToolUse`, `Notification` (pide permiso),
    `Stop`, `SubagentStop` → ficheros de eventos que Orchestra vigila; helper nativo `orchestra-hook.exe` (rápido).
  - UI: insignia de estado por panel, panel lateral de línea de tiempo, vista «control de misión» con una tarjeta por
    agente, aviso de Windows al terminar o pedir permiso.
- **F2 — Cuotas.**
  - Claude: el script de statusline recibe `rate_limits.five_hour` y `seven_day` (`used_percentage`, `resets_at`).
    Se inyecta un statusline-envoltorio con `--settings` que reenvía el JSON a Orchestra y luego ejecuta el del
    usuario. Sin credenciales ni endpoints no documentados.
  - Codex: `token_count.rate_limits` (`used_percent`, `window_minutes`, `resets_at`, créditos, plan) ya está en sus ficheros.
  - Panel: barras 5 h / 7 d por cuenta con cuenta atrás al reinicio, tokens por cuenta, historial, avisos al 80/95 %,
    y «mejor cuenta ahora» para cambiar un panel con un clic.
  - **Auto-compact en inactividad (opcional, apagado por defecto; Settings → Agents).** Idea del usuario: si está AFK >1 h nadie
    compacta. Compactar ANTES de que caduque la caché (lee el contexto caliente + escribe un resumen) es más barato que reescribir el
    contexto entero en frío al volver. Condiciones (todas): agente `idle`, ~50 min sin peticiones, contexto > umbral (150 k por
    defecto), inactividad del sistema del usuario (GetLastInputInfo). Escribe `/compact` una vez y avisa; el transcript queda en disco.
    Riesgos: teclear en una terminal que el usuario podría estar usando (mitigado por las condiciones) y perder detalle si vuelve
    antes de 1 h. NO verificado cómo cuenta la suscripción lecturas vs escrituras de caché: evaluar con las barras de uso (A/B).
    **Estado: implementado (apagado por defecto); falta A/B de coste.** Código: `idle.rs`, `autocompact.ts`, bloque en Settings → Agents.
- **F3 — Bóveda SSH nivel Termius+.** Contraseñas y passphrases en el Administrador de credenciales de Windows
  (crate `keyring`), nunca en el JSON; gestor de claves (generar, importar, copiar al servidor); **túneles**
  (-L/-R/-D) con estado; **SFTP** de dos paneles; **snippets** con variables y envío a varios paneles
  (broadcast); reconexión automática con tmux; importar/exportar (`~/.ssh/config`, JSON cifrado); grupos anidados.
- **F4 — Conexión de los agentes a las máquinas (MCP).** Servidor MCP local (127.0.0.1 + token) con herramientas
  `list_hosts`, `list_terminals`, `open_ssh`, `run_command`, `read_terminal`, `send_input`. Permiso por host
  (`agentAccess`: none / read / ask / full, ya en el modelo y el diálogo), confirmación en la interfaz para `ask`,
  registro de auditoría. **Las credenciales no salen de Orchestra**: el agente actúa sobre tu sesión sin verlas.
- **F5**: agentes de otros orígenes (Gemini, Qwen, Copilot), observar agentes dentro de SSH remoto, vista web/móvil
  por Tailscale, temas.

## Proyectos y memoria conjunta (idea del usuario, 2026-11-06; grandes: voice-service, BackseatDrivers)
Principio: **no crear un segundo sistema de memoria**; el usuario ya tiene `CLAUDE.md`, `memory/`, `_estado/` y briefs.
Orchestra añade una capa de *Proyecto* que los enlaza, no los copia:
- Proyecto = carpeta de trabajo + cuadrícula guardada + cuentas habituales + agentes/terminales. Abrirlo recompone todo.
- Panel del proyecto: lista y abre sus `CLAUDE.md`, `memory/*.md`, `_estado/`; búsqueda sobre ellos.
- **Relevo**: al cambiar de cuenta o cortarse un agente por límite, genera una nota de estado (qué hacía, tareas,
  subagentes vivos, archivos tocados) para que la siguiente cuenta no empiece de cero.
- Vía MCP (F4): leer/añadir notas del proyecto con permisos y consultar qué hacen los demás agentes del proyecto
  (evita que dos agentes pisen los mismos archivos; encaja con «pocos frentes»).

## Riesgos conocidos
- `rate_limits` del statusline solo existe en cuentas de suscripción y tras la primera respuesta de la sesión: validar
  con un payload real al empezar F2 (las cadenas están en el binario, no se ha visto un payload).
- 16 terminales en WebGL están al límite; el presupuesto de 12 y el respaldo DOM están implementados pero no medidos.
- Cambio de cuenta con `--continue` toma la última conversación de esa carpeta, no necesariamente la del panel (F1 lo cierra).
