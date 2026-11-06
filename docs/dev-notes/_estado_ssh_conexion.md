# Estado: SSH latency badge + auto-reconnect  (ENTREGA TERMINADA; falta solo la prueba con una caída de red real)

## Criterio de hecho y resultados
| Criterio | Resultado |
|---|---|
| svelte-check 0/0 | 199 ficheros, 0 errores, 0 avisos (antes 194) |
| `npm test` | 298 pasan, 0 fallan (antes 209: +89) |
| `npm run i18n:check` | OK, 653 claves en en y es, 0 textos fijos |
| `cargo test --bin orchestra` | 194 pasan, 0 fallan, 11 ignorados, 0 avisos de compilación, saltando UN test: `vault::tests::genera_y_lista_claves_en_carpeta_temporal` se queda colgado en esta máquina (probablemente ssh-keygen; vault.rs no está tocado por esta entrega; no investigado) | |
| bichos plantados | los 4 hacen fallar un test con nombre (tabla abajo) |
| capturas | 4 en `docs/dev-notes/img/` (insignia ok/warn/bad y barra de reconexión) |

## Bichos plantados (cada uno se revirtió y se comprobó con `diff`)
| Bicho | Dónde | Tests que lo cazan |
|---|---|---|
| (a) reconectar con código 0 | `reconnect.ts` decide(): quitada la guarda `clean-exit` | `exit code 0 (the user typed exit) never reconnects`, `exit codes: 'nonzero' reconnects on any non-zero…` |
| (b) reconectar con uptime < mínimo | quitada la guarda `short-session` | `a session that never produced output…`, `custom minimum uptime…`, `wrong password / unknown host / refused: session shorter than 10 s…` |
| (c) sin tope de intentos | quitada la guarda `max-attempts` | `max 8 attempts: 1..8 reconnect, the 9th does not`, `the 8 attempts follow the default backoff…`, `custom attempts: cap of 3…`, `custom settings drive the loop…`, `decide never returns a delay outside the table…` |
| (d) `net_ping` envía bytes | `net.rs`: `write_all(b"ping")` tras conectar | `net::tests::nothing_is_written_to_the_socket` (FAILED; los otros 7 de net:: pasan) |

## Ajustes finales (Settings, pestaña SSH keys; DEFAULTS, LIMITS, clamp, reset de sección, import, i18n en/es)
Reconexión: `sshAutoReconnect` true · `sshReconnectMaxAttempts` 8 [0-50, 0 = sin límite] · `sshReconnectFirstDelaySec` 2 [1-60] ·
`sshReconnectFactor` 2 [1-4; 1 = espera fija] · `sshReconnectMaxDelaySec` 30 [5-600] · `sshReconnectMinUpSec` 10 [0-300] ·
`sshReconnectCodes` 'nonzero' ('nonzero' | '255') · `sshReconnectFlash` true.
Latencia: `latencyBadge` true · `latencyIntervalSec` 5 [2-60] · `latencyTimeoutSec` 2 [1-10] · `latencyWarnMs` 80 [1-2000] ·
`latencyBadMs` 200 [2-5000, siempre > warn: el clamp lo corrige] · `latencySamples` 30 [5-120] · `latencyFailsBad` 3 [1-10] · `latencyShowUnit` true.

## Predicción de coste y confirmación
Predicción: 1 llamada `net_ping` por tick (5 s) para todos los hosts distintos, 0 con ventana oculta o insignia apagada; 0 coste en reposo
de la reconexión (1 temporizador por panel en cuenta atrás); nada por fotograma.
Confirmado con recuento (test `arm: polls every latencyIntervalSec…`): 1 llamada inmediata + 6 en 6 ticks = 7; ventana oculta: 0 más en 6 ticks;
insignia apagada: 0 más; intervalo 20 s: 0 a los 19,999 s y 1 a los 20 s. Una llamada por tick aunque dos paneles apunten al mismo host
(`tick: ONE call for all measurable panes, same address once`). En la demo del navegador, 11,5 s de panel vivo = 2 llamadas. Predicción acertada.

## Hecho (archivos)
- Rust: `src-tauri/src/net.rs` (nuevo, `net_ping`, 8 tests), `main.rs` (registro), `sshcfg.rs` (`proxy_command` + 1 test).
- TS puro: `latency.ts`, `reconnect.ts`, `sshconn.ts` (controlador con contexto inyectable) con sus `*.test.ts`.
- `settings.ts` (+16 claves) y `settings.test.ts`; `backend.ts` (`netPing`, demo con `?lat=N`, `?latfail=1`, `window.__orchestraDemoDrop`).
- `store.svelte.ts` (instancia `conn`, `onState`/`onOutput` ampliados, `restartPane` -> `restartNow` que busca en todos los espacios,
  limpieza en `closePane`/`closeWorkspace`, `beforeunload`, `visibilitychange`, `applyEffects`), `terminals.ts` (`tailText`).
- UI: `PaneView.svelte` (insignia, barra, destello de cabecera con `prefers-reduced-motion`), `SettingsKeys.svelte` (dos grupos).
- i18n en/es: `settingsKeys.ts`, `pane.ts`, `settingsDialog.ts`, `store.ts`. Docs: README, ARCHITECTURE.md, SECURITY.md.

## Decisiones y dudas
- «Sesión establecida» = tiempo desde la PRIMERA salida del proceso (no desde el lanzamiento): esperar mucho ante un prompt de contraseña o un
  timeout de conexión no cuenta. Una contraseña mala tras esperar mucho se detecta además leyendo el final del terminal («Permission denied»,
  fallo de huella) y no entra en bucle.
- Dentro de una racha, un reintento que falla enseguida sigue reintentando con espera creciente hasta el tope (red caída); uno que se mantiene
  >= `minUp` s reinicia la cuenta.
- Paneles aparcados, de otro espacio de trabajo o con la app cerrándose NO se reconectan (se tratan como parada del usuario). Decisión de diseño.
- Insignia en paneles con ProxyJump/ProxyCommand: «via jump», sin número.
- La tooltip dice «window: 1 samples» (el i18n del proyecto no tiene plurales).

## NO verificado
- Una caída REAL de ssh.exe (cable, VPN, servidor reiniciando): solo simulada (demo con `__orchestraDemoDrop` y tests con contexto falso).
- `tailText` con xterm real no tiene test automático (se ejercita en la demo del navegador, que solo muestra texto de demo).
- `net_ping` contra un servidor SSH remoto real: probado con listeners locales y puertos cerrados.
- Ventana de Tauri real (solo navegador + Vite). Tema claro no mirado.

## Capturas (`docs/dev-notes/img/`)
`latency-warn.png` (1200x700: dos paneles SSH, ● 157 ms y ● 160 ms con punto ámbar), `latency-ok.png` y `latency-bad.png` (tiras de
cabecera: verde 34/40 ms, rojo 397/400 ms con texto rojo), `reconnect-bar.png` (tras soltar la conexión: punto de estado rojo, insignia «—»,
barra ámbar inferior «Connection lost — reconnecting in 2 s (attempt 1 of 8) [Reconnect now] [Cancel]»).
