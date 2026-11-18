# Herramientas de medida del renderizador (rama lag-render)

Montaje usado para reproducir el lag con varios paneles «Claude» activos sin gastar tokens. Copia la carpeta a E:/_cache/lagr-test
(las rutas están fijadas ahí) y compila un exe release con `--features tauri/custom-protocol`.

- `emu.cjs <cuentaDir> <n>`: TUI parecida a Claude Code 2.1 (pantalla alterna, truecolor, spinner, streaming con markdown, 15 Hz; EMU_HZ)
  y escribe `sessions/<pid>.json` + una transcripción que crece (Task/TodoWrite) en una cuenta falsa: el escáner lo trata como agente Claude.
- `seed.cjs <N> <datos> <ignoredDirs>`: state.json con N paneles del emulador y los ajustes del usuario que importan (consulta de uso y
  claudeThemeSet apagados para no tocar cuentas reales; las ~/.claude* reales van a ignoredDirs).
- `launch.sh <exe> <etiqueta> <puerto> <N>`: instancia aislada (ORCHESTRA_DATA_DIR + WEBVIEW2_USER_DATA_FOLDER + puerto CDP).
- `prof.mjs <puerto> <s> <salida> [noprof]`: % del hilo principal (Performance.getMetrics TaskDuration/Style/Layout) y perfil de CPU.
- `cpu.ps1 -Tag <etiqueta>`: CPU (% de un núcleo) de renderer/gpu-process de esa instancia. Muy ruidosa con la máquina cargada.
- `trace.mjs <puerto> <s>`: reparto del hilo principal y del compositor por evento de Chromium.
- `gc.mjs <puerto>`: montón tras GC forzado. `longlog.sh`: una toma cada ~2 min. `cdp.mjs`: evalúa una expresión (CDP_PORT).
- `left.ps1`: mata lo que quede (emuladores huérfanos tras `taskkill /F`, WebView2 de prueba, exes `orch-*`).
- `window.__orchWebgl()` en la página: {webgl, mounted, retries} de los terminales.
