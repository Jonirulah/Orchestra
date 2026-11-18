# Estado: sesion-retomar (cada panel retoma SU sesión de Claude)

## Criterio de hecho
- Prueba nueva que falla en master y pasa en la rama por cada causa confirmada (TS: src/lib/resume.test.ts; Rust: agents.rs tests).
- E2E aislado (ORCHESTRA_DATA_DIR propio): state.json con 3+ paneles Claude misma cuenta/carpeta → al reabrir y al Reiniciar, cada uno con su --resume.
- npm test, svelte-check 0/0, i18n:check, cargo test --bin orchestra verdes. Commit local.

## Datos medidos (instancia del usuario, solo lectura, 18-11 18:07)
- Árbol de procesos: panel 230852 lanzado 16:47:03 con --resume 3ef950e6; 35 s después el usuario abre «claude -r» y elige f249483e.
  Panel 228984 lanzado 16:47:22 con --resume f249483e; el usuario abre «claude -r» y elige 3ef950e6. => Orchestra CRUZÓ las dos sesiones.
- Archivos huérfanos sessions/<pid>.json (procesos muertos, nunca limpiados): <cuenta-A> tiene 3 (pids 151696/224168/294648)
  con sessionId 08824622/3ef950e6/f249483e; <cuenta-B> 1, <cuenta-C> 1, .claude 1+. Claude Code solo limpia los de su carpeta.
- scan_one acepta CUALQUIER pid del árbol del panel (powershell, git, node, godot...) que tenga sessions/<pid>.json en CUALQUIER cuenta:
  con un pid reutilizado por Windows, el panel «adopta» la sesión de un Claude muerto de otro panel. El BFS mira primero la raíz (powershell).
- sessions/<pid>.json trae procStart = FILETIME de creación del proceso (comprobado: 103544 → 16:49:10 = CreationDate).

## Causas (estado)
1. [x] Rust scan_one: pid reutilizado + huérfano → sesión ajena. Arreglo: procStart (o startedAt) debe casar con el arranque del proceso.
2. [x] restart()/Reiniciar usa pane.spec con --resume viejo; debe salir de lastSession.
3. [x] stripResume no quita --continue (switchAccount sin id deja --continue → reabrir = «la última»).
4. [x] Dos paneles con el mismo lastSession → los dos retoman la misma (dos claude en el mismo .jsonl).

## Hecho / cómo se comprobó
- Causa 1 (Rust): session_file_fits() en agents.rs; scan_one descarta archivos cuyo procStart/startedAt no casa con el arranque del pid.
  Tests: un_pid_reutilizado_no_hereda_la_sesion_de_un_claude_muerto (plantado sin el check → FAILED; con él → ok),
  la_marca_de_arranque_decide... (muestra real 103544). real_claude_link (ignored, ORCH_REAL_DIR=<cuenta-D>) → 5/5 sesiones vivas siguen enlazadas.
- Causas 2-4 (TS): model.ts withResume, duplicateResumeLosers, stripResume quita --continue, restoreSpecFor({taken}), trackSession({since}).
  store: resumeSavedSessions desduplica (gana el since más reciente; sin since, el primero) y avisa (toast sessionShared);
  restartNow → refreshClaudeResume (rehace --resume desde lastSession, no si otro panel vivo la tiene); PaneView: prepareLaunch antes del 1.er lanzamiento;
  switchAccount sin sesión → nueva (no --continue) + toast paneSwitchedFresh.
  resume.test.ts 25/25; plantados: stripResume con --continue → 4 fallan; withResume inerte → 2; sin desduplicar → 2; taken ignorado → 2.
  En master el archivo de test no carga (faltan exports) → falla.
- E2E: scripts/e2e-sesion-retomar.mjs (HERRAMIENTA; doble de claude, instancia aislada, CDP). Rama (exe debug custom-protocol): 12/12 checks OK.
  Ojo: portable-pty relee PATH del registro → el doble entra por settings.agentEnv PATH.

- E2E master (exe 3d4bb75 mismo arnés): 6/12 fallan — p2 retoma B a la vez que p3; p4 arranca con --continue; Reiniciar p1 retoma A (no C)
  y en la 2.ª reapertura p1 vuelve a A (el --resume horneado contamina lastSession); 3 sesiones distintas para 4 paneles. Rama: 12/12.
- Baterías finales: npm test 802/802; svelte-check 0/0; i18n:check OK (3 avisos previos, ajenos); cargo test 402+1 (vault::ida_y_vuelta
  falla en paralelo, sola 2/2 ok); avisos de cargo = los 6 de master.
- Hipótesis b (medido en vivo): --resume X mantiene X en sessions/<pid>.json (38800); «claude -r» escribe el id elegido (241872, 103544).
  No medido: el id transitorio antes de elegir en el selector (inocuo: sin transcripción → nueva; no gana duplicados).

## Pendiente / no probado
- Con Claude real (solo doble). Robo por pid reutilizado: reproducido en test Rust, no observado en vivo (los huérfanos de <cuenta-A>
  existen, pero no se pudo ver la reutilización en el momento).
- Cambio de cuenta (switchAccount) sin sesión: ahora nueva + aviso; sin E2E.

## Archivos tocados
src-tauri/src/agents.rs, src/lib/model.ts, src/lib/store.svelte.ts, src/components/PaneView.svelte, src/lib/locales/{en,es}/store.ts,
src/lib/resume.test.ts, scripts/e2e-sesion-retomar.mjs, docs/ARCHITECTURE.md, CHANGELOG.md, este estado.
