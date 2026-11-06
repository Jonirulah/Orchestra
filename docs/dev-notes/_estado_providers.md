# Estado: cuentas de Codex y opencode (fase 1)

Objetivo: añadir y lanzar varias cuentas de Codex (login ChatGPT) y opencode como las de Claude. Fuera de esta fase: barras de uso,
inyección MCP, auto-compact y lectura de sesiones de Codex/opencode.

## Verificado con los binarios reales (2026-11-06, carpetas temporales en <cache>)
- Codex 0.167.0: `CODEX_HOME=<tmp>` aísla de verdad. `codex login status` en una carpeta vacía -> "Not logged in", exit 1, MIENTRAS que el ~/.codex real tiene sesión (si leyera el real diría "Logged in"). Los ficheros nuevos (`tmp/arg0-windows/...`) nacen en la carpeta temporal y no en la real (nombres de carpetas antes/después de una ejecución: 0 nuevos en la real, 1 nuevo en la temporal). El `config.toml` de ESA carpeta se lee: `cli_auth_credentials_store = "file"` se acepta y `"bogus"` da error "expected one of file, keyring, auto, ephemeral" (prueba de que se lee). No se probó dónde guarda el login (no se hizo login).
- opencode v2.2.5: `opencode debug paths` (solo local) respeta `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME` y `OPENCODE_CONFIG_DIR`. `auth.json` vive en `<XDG_DATA_HOME>/opencode/`. `opencode auth list --format json --standalone` con XDG temporal -> `[]`, exit 0, y crea su base de datos (11 MB, migraciones) en la carpeta temporal, no en la real (que sí tiene sesión).
- TRAMPA opencode v2: hay un servicio compartido en segundo plano (`opencode service status` -> http://127.0.0.1:28894). Sin `--standalone`, un `opencode` con otro XDG_DATA_HOME intenta arrancar SU servicio gestionado y falla ("Managed service port 28894 on 127.0.0.1 is already in use"): no aísla ni funciona. Con `--standalone` (servidor privado) usa el XDG_DATA_HOME del panel. Por eso las cuentas aisladas de opencode lanzan `opencode --standalone` (y `auth login --standalone`).
- `opencode auth export` imprime credenciales con secretos: no se usa nunca.
- Comprobación de mtimes en las reales (hay un codex y un opencode del usuario vivos que cambian sus propios ficheros): `~/.local/share/opencode/auth.json` (16-ago), `opencode.db` y `.db-wal` (20:28, anterior a mis pruebas) sin cambios; `~/.codex/auth.json` (18:12) y `config.toml` (20-oct) sin cambios. Solo cambian ficheros de los procesos vivos (log, models_cache, wal) y 0 carpetas `arg0` nuevas por mis ejecuciones. No es una prueba total (no hay monitor de E/S), pero la sesión "Not logged in" / "[]" frente a la real con sesión es prueba fuerte de lectura aislada.
- Dónde viven los procesos en Windows: opencode instalado con npm -> `opencode.cmd` ejecuta `opencode.exe` directamente (binario propio, sin node); Codex es `codex.exe` (+ `codex-code-mode-host.exe`, `codex-exec-server.exe`). La detección va por nombre de proceso `opencode*` / `codex*` en el árbol del panel.
- Incidente mío: un comando bash con comillas dobles ejecutó por error `codex login status\` y `opencode auth list\` (sustitución de backticks) contra el entorno real; ambos fallaron por la `\` sobrante (subcomando no reconocido) sin leer nada. Lección: nada de backticks en `node -e "..."`.

## Hecho
Modelo y política (TS)
- `model.ts`: `Provider`, `Account.provider`, `normalizeAccounts` (estados viejos -> 'claude', campos intactos), `providerOf/providerLabel/accountTitle/accountDir/providerEnv/providerSpec` (codex: `CODEX_HOME`; opencode: `XDG_DATA_HOME=<raíz>\data`, `XDG_STATE_HOME=<raíz>\state` + `--standalone`; las cuentas Default no ponen variable). `codexSpec` suelto intacto.
- `policy.ts`: `pickAccount` descarta lo que no es Claude (segunda barrera). `mcpsync.ts`: Codex de cuenta -> 'codex', opencode -> 'shell' (mcp.rs no se toca).
- `providers.ts` (nuevo, puro): `toProviderEntry` (lista blanca), `shouldRefresh` (30 s), `checkable`, `statusLabel/statusTone`.
- `store.svelte.ts`: `accounts` con todas; `claudeAccounts` para cuota, consulta de uso, agentScan, política, alertas, rescan, selector de cuenta del panel; `addProviderAccount`, `signIn`, `refreshProviderStatus`, `detectProviders`, `hasDefaultAccount`, `OpenReq {kind:'account', accountId, login?}`; quitar una cuenta de Codex/opencode no entra en `ignoredDirs`.
- `backend.ts`: `providerDetect/providerPrepare/providerStatus` (+ modo demo), `AgentInfo.agent` incluye 'opencode'.
Backend (Rust)
- `providers.rs` + `providers/tests.rs` (nuevo): `provider_detect`, `provider_prepare` (carpeta hija directa del usuario con prefijo `.codex-`/`.opencode-`; solo en carpeta nueva o vacía escribe `cli_auth_credentials_store = "file"` en SU config.toml), `provider_status` (`codex login status` / `opencode auth list --format json [--standalone]` por `cmd /C`, tope 64 KB y 10/20 s con matado del árbol; devuelve solo veredicto).
- `agents.rs`: `detect_plain` (codex y opencode por nombre de proceso) + prueba con árbol falso.
- `main.rs`: `mod providers` + 3 comandos.
UI
- `AccountDialog` (selector Claude / Codex (ChatGPT) / opencode, casilla "usar mi carpeta de siempre", pasos de Iniciar sesión), `SettingsAccounts` (etiqueta de proveedor, estado de sesión, Abrir / Iniciar sesión / Comprobar sesión; sin barras ni consulta de uso para no-Claude; al abrir comprueba), `Sidebar` (todas las cuentas con "Codex · x"; sin barras para no-Claude), `Grid` (chips), `Palette` (cuentas + "Iniciar sesión · x"), `PaneView` (el selector solo para Claude), `AgentTree` (etiqueta opencode).
- Decisión sobre el lanzador suelto "Codex (ChatGPT)": se queda como lanzador sin cuenta (sidebar, palette, arrastrar); se oculta cuando existe una cuenta "Default Codex" (la que apunta a ~/.codex).
- i18n: área nueva `providers` + claves en dialogs, settingsAccounts, sidebar, grid, palette, store (en+es).
Docs: README (features + tabla "What is verified"), ARCHITECTURE (Accounts by provider, agentes), SECURITY (Codex and opencode accounts), i18n.md (área providers).

## Cómo se comprobó (cifras)
- svelte-check: 187 archivos, 0 errores, 0 avisos.
- npm test: 181/181 (166 antes de añadir pruebas propias; +15 pruebas nuevas en `accounts.test.ts` y `providers.test.ts`) — sin fallos.
- `node scripts/i18n-check.mjs`: OK, 573 claves en/es, 0 textos fijos.
- cargo (solo `--bin orchestra`, porque `cargo test` normal no puede enlazar `orchestra.exe` bloqueado por la app abierta): 179 ok, 11 ignoradas (ya existentes), 0 avisos (`cargo check` y `test --no-run`). `cargo test` completo en un directorio target aparte (ya borrado): 179 + 5 de `tests/askpass.rs`, todo ok. Nuevas: 12 en `providers::tests` + 1 en `agents::tests`.
- Bichos plantados (todos detectados y revertidos).
  - TS: política sin filtro de Claude -> `pickAccount never picks...` FALLA; variable `CODEX_DIR` en vez de `CODEX_HOME` -> 2 fallan; sin `--standalone` -> falla; migración sin `provider` -> 2 fallan; `quotaRead` con todas las cuentas -> falla el escaneo del almacén; `agentScan` con todas -> falla; MCP opencode como claude -> falla; `method` arbitrario en la entrada -> falla.
  - Rust: sin comprobación de carpeta hija del usuario -> `account_dir_validation` FALLA; config escrita en carpeta con contenido -> `codex_prepare_writes_config_only...` FALLA; sin `--standalone` -> 2 fallan; exit 0 = con sesión -> `codex_status_parsing` FALLA; `println!` / lectura de `auth.json` en producción -> `the_module_never_touches_credential_files` FALLA (la primera versión de esa prueba NO lo detectaba por cortar en el primer `#[cfg(test)]`; corregida y vuelta a plantar); opencode no detectado -> `detecta_codex_y_opencode...` FALLA.

## Pendiente / no verificado
- Un login real (ChatGPT en el navegador, `opencode auth login`) dentro de un panel; qué imprime `codex login status` con sesión (supuesto: "Logged in using ChatGPT" / "... an API key"); la forma real de `opencode auth list --format json` con sesión (supuesto: lista JSON; si fuese otra cosa el veredicto es "desconocido", no un error).
- Paneles reales corriendo Codex y opencode con las variables (no se arrancó la app ni se lanzó ningún agente interactivo); TUI de `opencode --standalone` con XDG propio (solo se probaron `debug paths` y `auth list`).
- `opencode auth list` de la cuenta Default (sin `--standalone`, contra el servicio real): no se ejecutó sobre datos reales; puede arrancar el servicio en segundo plano si no estaba.
- Aspecto visual (diálogo, ajustes, barra lateral): sin capturas, solo svelte-check y pruebas; no se levantó ningún servidor de desarrollo.
- Los paneles de inicio de sesión se vuelven a lanzar al reiniciar Orchestra (como cualquier panel): relanzarían `codex login`.
- Nombres por defecto "Codex principal" / "Default Codex" se guardan en el idioma del momento.
- opencode: la configuración (`~/.config/opencode`) y la caché se comparten a propósito; si el usuario quiere configuración por cuenta habría que añadir `XDG_CONFIG_HOME` / `OPENCODE_CONFIG_DIR`.

## Archivos tocados
src-tauri: src/providers.rs y src/providers/tests.rs (nuevos), src/agents.rs, src/main.rs.
src/lib: providers.ts, providers.test.ts, accounts.test.ts (nuevos); model.ts, policy.ts, mcpsync.ts, backend.ts, autocompact.ts (tipo), store.svelte.ts; locales/{en,es}/providers.ts (nuevos) y dialogs, settingsAccounts, sidebar, grid, palette, store, index.
src/components: AccountDialog, SettingsAccounts, Sidebar, Grid, Palette, PaneView, AgentTree.
docs: README.md, ARCHITECTURE.md, SECURITY.md, i18n.md, este archivo.
