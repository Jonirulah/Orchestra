# Status bar — estado (2026-11-06)
Hecho: metrics.rs (sysinfo 0.37 + features disk,network; comandos metrics_sample/metrics_reset), statusbar.ts (+ statusbar.test.ts, 24 tests),
settings (statusBar, statusBarItems, statusBarInterval; en SECTION_KEYS.general), StatusBar.svelte (App.svelte: fila `auto` del grid),
SettingsStatusBar.svelte (en SettingsGeneral), locales en/es statusbar.ts, backend.ts (metricsSample con demo), docs README/ARCHITECTURE/SECURITY.
Comprobado: cargo test --bin orchestra metrics (5 ok + real_sample #[ignore]); node --test; demo Vite (scratchpad/statusbar-ui.mjs, sb/*.png):
huecos estables, menu contextual con 8 items + settings + hide, recorte a 520 px = 3 items.
Plantados (todos fallan y se restauran con cmp): tasa sin tiempo, loopback contado, duplicados, umbral >=85, fitItems sin recorte, contador que baja.
Pendiente: fase 2 (metricas remotas SSH) NO hecha; IOPS reales no disponibles con sysinfo; barra real en el exe sin ver.
Ajenos que fallan ahora (no son mios): agents.sub.error (es=en), subtranscript.test, backup.test (credenciales), GitChip cwd, i18n git.*.

## Fase 1b: barra por pestaña (2026-11-06)
Hecho: `Workspace.statusBarItems?` (lista propia; ausente = global), `itemsFor/toggleFor/moveFor/cleanOverride/customizeList/adaptedItems/sshTarget` en statusbar.ts;
6 items de contexto (pane, target, branch, latency, account, agentState); ajuste `statusBarAdapt` (off); menu contextual "Customize for this tab"/"Use default for all tabs";
tarjeta de Ajustes con nota + "Reset this tab to default" + toggle de adaptar; normaliza al cargar (store.init) y en backup (export+import); fade 120 ms de los huecos de contexto; nota "local" en tooltips de metricas con panel SSH.
Comprobado: npm test 426 pass (413 antes; +12 statusbar, +1 backup); svelte-check 0; i18n OK; demo Chrome CDP (scratchpad/sb-tabs.mjs): pestana dev (rama+cpu+ram+net+uptime), prod SSH (root@db.example.com:2222, 34 ms, cpu, ram, net), notes (override pane+uptime, "bogus" descartado); customizar+quitar uptime en dev no toca prod ni la lista global; persistido en localStorage; "Use default" restaura.
Plantados (todos fallan, restaurados con cmp): toggle del override edita la global; ids desconocidos aceptados; adapt ignora SSH; backup pierde el campo (import / export, 2 plantas); override ignorado.
Pendiente / sin ver: exe real (solo demo del navegador); account/agentState con datos reales (en demo el agente no casa con una cuenta); metricas remotas siguen sin hacer; con adapt activo y sin override, marcar un item edita la lista GLOBAL (la barra muestra la adaptada); solo fade-in, no cross-fade con salida.


## Fase 2: metricas del servidor por SSH (2026-11-06)
Hecho: `src-tauri/src/remote_metrics.rs` (Dest + validacion, `build_args`/`build_env`, guion POSIX por stdin `sh -s`, `parse_line`/`compute`/`Throttle`/`read_line_capped`, `classify`,
`ChildGuard` (kill al soltar), `Manager` con recuento por destino, gracia 10 s, `reap` cada 500 ms, `shutdown` al salir, soltar enlace con ventana oculta >60 s; comandos
`rmetrics_start/stop/sample/hidden` en main.rs); `src/lib/remotemetrics.ts` (rmReq/rmKey/desiredMonitors/RmController), `statusbar.ts` (cleanRmInterval, metricSource, REMOTE_CAPABLE),
`Host.remoteMetrics` (model.normalizeHost, backup HOST_KEYS + sanitizado), ajuste `remoteMetricsInterval` (settings, SECTION_KEYS.general), casilla en HostDialog, slider en SettingsStatusBar,
StatusBar.svelte (marca SSH, tooltips "Server <host>: ...", CPU con nucleos y carga, marcadores `...`/`n/a`), backend.ts (demo: muestras falsas; host `bad.*` = huella no fiable), locales en/es, docs README/ARCHITECTURE/SECURITY.
Regla (ajuste del usuario): UN monitor por destino, vive mientras haya algun panel SSH vivo de ese host en cualquier pestana (visible o no); no depende del foco; para ~10 s tras el ultimo; ventana oculta >60 s suelta el enlace.
Comprobado: cargo test --bin orchestra remote_metrics: 23 ok + 2 #[ignore] (ssh real a 127.0.0.1:1 y a no-such-host.invalid: estado unavailable/network, sin muestra, 0 hijos tras stop; known_hosts intacto) ok;
guion ejecutado en WSL2 Ubuntu (dash `sh -s`), su salida real es un fixture del test (cpu/red/uptime/host). npm test 444 pass; svelte-check 0; i18n OK. Demo Chrome (scratchpad/sb-remote.mjs):
prod y prod 2 (mismo host) -> `SSH | db-prod-01 | CPU ..` con tooltip "Server db-prod-01: Server CPU: 9% · 8 cores · load 1.27"; host con fallo -> `n/a` + motivo; host sin la casilla -> local + nota; dev -> local. docs/screenshots/statusbar-remote-{ok,unavailable}.png.
Plantados (todos fallan, restaurados con cmp): StrictHostKeyChecking=no; secreto en el entorno; tasa sin tiempo real; linea parcial aceptada (quitando end=1 Y el recuento de claves; solo end=1 no basta: defensa doble);
ssh huerfano al parar (reap sin kill: el hijo falso sigue vivo, el test falla); un proceso por panel (start ignora el existente); host con '-' aceptado; backup pierde remoteMetrics; metricSource cae a local si no hay datos; panel terminado sigue contando.
SIN VERIFICAR: ninguna ejecucion contra un servidor SSH real (no hay sshd local ni se toco ningun host del usuario). No probado: el exe real (solo demo del navegador y tests), 2FA real, ProxyJump real, askpass real con ssh.
Pendiente / dudas: el constructor de argumentos esta en Rust (estructurado, validado) y NO reutiliza `sshArgs` de model.ts (sale de los mismos campos del Host; si cambia sshArgs hay que mirar rmReq); alias de ~/.ssh/config sin ajuste -> sin metricas de servidor;
sin Job object en Windows: si la app muere de golpe ssh sale al siguiente tick por tuberia rota (<=10 s); con enlace caido y backoff, el "stale" solo se ve si llega a haber muestra previa.
