# Estado: lag del renderizador (rama lag-render, worktree E:/Orchestra-wt/lag-render)

Brief: el renderizador WebView2 de Orchestra gastaba ~108 % de un núcleo tras 14 h con 5 paneles Claude activos.

## Criterio de hecho
- Misma carga (6 paneles «Claude» emulados, ajustes del brief), A/B intercalado y repetido: el % del hilo principal (CDP
  Performance.getMetrics, TaskDuration) y la CPU del proceso renderer bajan claramente; toma larga ≥ 20 min sin crecer.
- npm test, svelte-check 0/0, i18n:check, cargo test --bin orchestra; commit local.

## Montaje (docs/dev-notes/lag-render-tools/, README allí; se usó desde E:/_cache/lagr-test)
Emulador de la TUI de Claude 2.1 (pantalla alterna, truecolor, spinner, markdown, 15 Hz) que además escribe sessions/<pid>.json y una
transcripción que crece en una cuenta falsa (el escáner lo trata como agente Claude con subagentes y todos). Exes release con
custom-protocol: base = master 3d4bb75, arreglo = esta rama. Instancias aisladas (ORCHESTRA_DATA_DIR/WEBVIEW2_USER_DATA_FOLDER propios).

## Causa (medida)
1. PRINCIPAL: animaciones CSS infinitas de la barra lateral. `.st.busy` de AgentTree animaba `box-shadow` (aro): no lo puede mover el
   compositor, así que con un agente ocupado el hilo principal recalcula estilo y REPINTA a la frecuencia del monitor (240 Hz en esta
   máquina: 240 recálculos/s). Traza: Paint 90 ms/s y ciclo de pintado 123 ms/s en base; 0 en el arreglo.
   Ablación en la misma instancia (CSS inyectado por CDP, 2 rondas): con todo 26-34 % del hilo; sin ninguna animación 7-8 %;
   aro como ::after con transform/opacity 9-14 %; sin aro 10-17 %.
   El coste no depende del nº de agentes ocupados (1 basta para forzar los 240 fotogramas/s) y sí del tamaño de ventana y la frecuencia.
2. Pérdida de contexto WebGL: el panel se quedaba en el renderizador DOM para siempre (loseContext → canvas 0, 6 .xterm-rows);
   coste medido: hilo 14 % → 21-23 % con 6 paneles. Mecanismo que sí crece con las horas (GPU cargada por los Godot de pruebas).
3. Descartado: fuga de JS (montón tras GC forzado = 10 MB en base y arreglo tras 20-30 min); JS propio ~2-3 % del hilo (mdColorsFor,
   paneById < 1 ms/s); relojes de PaneView solo en SSH. No reproduje crecimiento con el tiempo en 30 min salvo por 1-2.

## Arreglo
- AgentTree.svelte: aro en `.st.busy::after` (transform+opacity, lo anima el compositor). PaneView.svelte: barra indeterminada con transform.
- terminals.ts + webglretry.ts: tras perder el contexto (o no poder crearlo) se reintenta a 1 s, 5 s, 30 s, 2 min y luego cada 5 min
  (la racha se reinicia tras 10 min estable). `window.__orchWebgl()` = {webgl, mounted, retries}.
- Guardián animguard.test.ts: toda animación infinita solo puede animar transform/opacity.

## Cómo se comprobó
- A/B final, las dos instancias arrancadas a la vez (misma fase del emulador, 18-19 animaciones), 5 pares intercalados de 6 s:
  base hilo 32-35 % (uno a 19 % con 6 animaciones), renderer 63-80 %, gpu 36-44 %; arreglo hilo 11-14 %, renderer 18-45 %, gpu 28-49 %.
- Tomas largas a la vez (cada ~2,5 min): base 26 min hilo 12-29 % (240 recálculos/s con algún agente ocupado), sin crecer;
  arreglo 22 min hilo 11-16 %, 46-85 recálculos/s, sin crecer. Montón tras GC al final: 10,4 / 10,7 MB.
- WebGL: loseContext en los 6 paneles del exe arreglado → a los 5 s webgl=6, retries=6, 0 filas DOM.
- Pruebas que fallan antes: animguard en master 1 FAIL («ring anima box-shadow», «orch-indet anima left») / rama 2 PASS;
  webglretry plantado (índice sin tope) 1 FAIL / 2 PASS, restaurado 3 PASS.
- Captura del aro antes/después (aspecto equivalente): E:/_cache/lagr-test/ring_lamina.png (fuera del repo).
- npm test 801/801; svelte-check 307 archivos 0/0; i18n:check OK (3 avisos de texto fijo que ya estaban);
  cargo test --bin orchestra 400 ok + vault::genera_y_lista_claves 1 ok tras `cargo build` (pide el exe debug), 30 ignoradas.

## No probado / flojo
- No pude perfilar la instancia del usuario: que su 108 % sea esto es inferencia (mismo monitor de 240 Hz, agentes casi siempre
  ocupados). Su ventana es probablemente mayor: el ahorro de pintado debería ser mayor, no menor.
- Lo que queda (hilo 11-14 %) es sobre todo xterm pintando 6 paneles a 15 Hz y las animaciones compuestas que aún piden fotogramas.
- La CPU del proceso renderer es muy ruidosa (máquina al 77-97 %); la cifra fiable es el % del hilo por CDP.
- Al matar el exe con taskkill /F quedan los emuladores huérfanos: lag-render-tools/left.ps1.

## Archivos
src/components/AgentTree.svelte, src/components/PaneView.svelte, src/lib/terminals.ts, src/lib/webglretry.ts (+test),
src/lib/animguard.test.ts, docs/dev-notes/lag-render-tools/*, este archivo.
