# Gestor de MCP por cuenta — diseño (borrador 2026-11-07, sin construir)

## Problema
Instalar un MCP una vez es fácil (`claude mcp add`). Lo pesado es:
- tenerlo en **varias cuentas** (cada una con su CLAUDE_CONFIG_DIR / CODEX_HOME),
- con **tres formatos** distintos (Claude JSON, Codex TOML, opencode JSON),
- con **claves en texto plano** en esos ficheros,
- copiando la línea del README de cada MCP y adaptándola a mano.

## Principios
1. **Orchestra no edita los ficheros de las herramientas**: escribe con sus CLI oficiales
   (`claude mcp add-json`, `codex mcp add`, `opencode mcp add`) lanzadas con el entorno de la cuenta.
   Leer sí puede (para listar), siempre de forma tolerante.
2. **Sin catálogo propio.** La fuente es lo que pegue el usuario.
3. **Antes de escribir, enseñar**: vista previa con el comando exacto por cuenta y confirmar.
4. **Nunca tocar la cuenta por defecto** (~/.claude, ~/.codex) si no está marcada.
5. **Copia de seguridad** del fichero de config de la cuenta antes de cada cambio (rotación corta).

## Modelo
- `McpDef` (en el store de Orchestra): nombre, transporte (stdio | http), comando+args o URL,
  variables/cabeceras; cada valor puede ser literal o **referencia a la bóveda** (`vault:<clave>`).
- `Asignación`: McpDef × cuenta (+ ámbito en Claude: user o proyecto). Estado: aplicado / pendiente /
  distinto (alguien lo cambió a mano) / falta.

## Pantalla (pestaña «MCP» en Cuentas)
- Tabla: filas = MCP, columnas = cuentas, celda = ✓ / ✗ / ⚠ distinto / ● conectado-o-no.
- «Añadir»: **pegar** lo que trae el README (línea `claude mcp add …`, `codex mcp add …`, bloque JSON
  `mcpServers`, bloque TOML `[mcp_servers.x]`) → se analiza → formulario prellenado → marcar cuentas.
- «Probar»: `claude mcp get/list`, `codex mcp list`, `opencode mcp list` en esa cuenta.
- «Iniciar sesión» (MCP con OAuth): abre un terminal de esa cuenta con `codex mcp login x` /
  `opencode mcp auth x` / `claude` → `/mcp`. Cada herramienta guarda su propio token; Orchestra no.
- «Adoptar»: los MCP que ya existen en las cuentas aparecen y se pueden pasar a McpDef con un clic.
- «Orchestra MCP»: atajo para añadir el servidor MCP de Orchestra a las cuentas elegidas.

## Claves fuera de los ficheros (la parte delicada)
- **stdio**: en lugar del comando real se registra `orchestra --mcp-launch <id>`; ese modo (como el
  askpass que ya existe) saca las claves de la bóveda, las pone en el entorno y ejecuta el servidor
  real pasando stdin/stdout. Contra: si se desinstala Orchestra, esos MCP dejan de arrancar
  (opcional por MCP: «claves en la bóveda» o «claves en el fichero»).
- **http con cabecera**: Codex tiene `--bearer-token-env-var`; Claude, comprobar `headersHelper`
  en la versión instalada (2.1.319); si no, el mismo lanzador hace de puente stdio→http.

## Avisos conocidos
- **opencode**: las cuentas de Orchestra separan data/state, pero la config (y los MCP) está en
  ~/.config/opencode, **compartida**. O se acepta «MCP de opencode = global», o la cuenta también
  separa XDG_CONFIG_HOME (cambia cómo se crean esas cuentas).
- Los formatos cambian a menudo (sobre todo Codex): probar con las versiones reales
  (claude 2.1.319, codex 0.167.0, opencode 2.2.5), no solo con tests de ficheros de ejemplo.
- `npx paquete@latest` de terceros: avisar de que ejecuta código ajeno con tu usuario.
- Claude `.mcp.json` de proyecto se comparte por git: nunca meter claves ahí (solo `${VAR}`).

## Listado (F1), decidido 2026-11-07: solo Windows
Dos capas: **configurado** (barato, sin arrancar nada) y **estado** (bajo demanda).

Configurado, por herramienta:
- Claude: `claude mcp list` NO tiene JSON y hace health-check de todo (arranca cada servidor) → no
  sirve para listar. Se lee en solo lectura `<CLAUDE_CONFIG_DIR>\.claude.json` (por defecto
  `%USERPROFILE%\.claude.json`): `mcpServers` (ámbito user) y `projects[<ruta>].mcpServers` (local);
  y `.mcp.json` de los proyectos abiertos en Orchestra. Los MCP de plugins y conectores de claude.ai
  solo salen en `claude mcp list`: se muestran aparte, «gestionado fuera», sin editar.
- Codex: `codex mcp list --json` con CODEX_HOME de la cuenta (no arranca servidores).
- opencode: leer `mcp` de `%USERPROFILE%\.config\opencode\opencode.json(c)` (JSONC); `opencode mcp
  list` solo para estado.
Normalizar a McpDef: misma definición en varias cuentas = misma fila; mismo nombre y distinta = ⚠.
Valores de env/cabeceras se enmascaran en Rust (`API_KEY=•••`); nunca llegan a la interfaz.
Refresco: al abrir la pestaña y al cambiar el mtime de esos ficheros (sondeo cada pocos s con la
pestaña visible).

Estado («Probar», por casilla o columna): sonda propia de Orchestra igual para las tres:
MCP `initialize` + `tools/list` (stdio: lanzar con el env de la cuenta; http: POST), plazo 10 s,
matar el árbol de procesos al acabar. Resultado: conecta (n herramientas) / pide login (401) /
falla (primera línea de stderr) / tiempo agotado. Nunca automático al abrir.

## Fases
- F1 Leer: listar MCP por cuenta (las tres herramientas), tabla y «Probar». Solo lectura.
- F2 Escribir: añadir/quitar/aplicar a varias cuentas vía CLI, vista previa, copia de seguridad.
- F3 Pegar del README: analizador de las cuatro formas + tests con ejemplos reales.
- F4 Bóveda: lanzador `--mcp-launch`, puente http si hace falta.
- F5 Distinto/sincronizar, adoptar, OAuth desde terminal, atajo «Orchestra MCP».
- Linux: el lanzador y las rutas también (va con el frente Linux).
