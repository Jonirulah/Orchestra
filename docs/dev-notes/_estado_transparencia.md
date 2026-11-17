# Estado: transparencia de la ventana (rama `transparencia`, worktree E:/Orchestra-wt/transparencia)

Brief: docs/dev-notes/brief_transparencia.md.

## Diseño (hecho)
- Ajustes nuevos `windowOpacity` (30..100, defecto 100) y `windowEffect` ('none'|'acrylic'|'mica', defecto 'none'), en General (Restablecer sección los incluye). Viajan en export/import (backup copia todos los ajustes).
- La ventana NO se crea transparente (tauri.conf.json igual): a 100 % no hay clase ni llamada → idéntico a hoy.
  Por debajo de 100 %: `set_window_glass` (src-tauri/src/glass.rs) en vivo = DwmEnableBlurBehindWindow con región vacía (lo mismo que tao con `transparent: true`) + fondo del WebView2 a alfa 0 + Acrílico/Mica con window-vibrancy (Mica cae a Acrílico; si no, Ninguno). Al volver a 100: se deshace y el fondo vuelve a #0d0f12.
- Página: `html.glass` + `--win-a`; cada píxel UN solo pintor translúcido (`--bg-g`, `--panel-g`, `--term-bg-g`): body transparente; pintan barra lateral, pestañas, barra de estado, cabecera y cuerpo de cada panel; los márgenes entre paneles los cubre una sombra sin desenfoque de 3 px (paneles con esquinas rectas en cristal para que encajen sin agujeros). xterm: `allowTransparency` + fondo del tema con alfa 0 (el color se conserva) → texto opaco. Menús, diálogos, ajustes, fichas, cajones, vistas MCP/Consumo: sin tocar (opacos).

## Hecho y comprobado (2026-11-17)
- Pruebas: glass.test.ts 7/7 (falla con el fallo plantado DEFAULTS.windowOpacity=90: 2 FAIL / 5 PASS; en master no existe glass.ts). npm test 787/787, svelte-check 304 ficheros 0/0, i18n:check OK (3 avisos de texto fijo que ya estaban: McpView, StatusBar, sftpbackend), cargo test --bin orchestra 400 ok / 0 fallos (glass::tests incluidos; el de vault pide antes `cargo build` del exe debug).
- Exe real (release, CARGO_TARGET_DIR=E:\_cache\orchestra-target-transp; copia en E:\_cache\transp-test\orchestra-transp.exe), aislado (ORCHESTRA_DATA_DIR/WEBVIEW2_USER_DATA_FOLDER en E:\_cache\transp-test), manejado por CDP moviendo el deslizador real de Ajustes:
  - En vivo: 100 → sin clase, laterales rgb(19,22,27) (= hoy); 80/60 → clase glass, fondos con alfa 0,8/0,6, diálogo de ajustes opaco rgb(19,22,27). Al arrancar con 80 guardado sale ya en cristal (se guarda en state.json).
  - Medida de brillo en un panel vacío (fondo real detrás): 100 % = 15,3; 60 % = 27,2; tras Mica → 100 → 60 vuelve a 15,3 / 27,2 (ida y vuelta sin restos).
  - Rendimiento: 40 000 líneas en PowerShell, rAF 240 fps tanto a 100 como a 60 (tope del monitor): sin caída visible.
- Capturas (exe real): fuera del repo (enseñan datos locales); no se publican.
- Arreglo hallado probando: xterm.css pinta `.xterm-viewport` de #000 → con cristal el terminal salía negro opaco; regla `html.glass .xterm .xterm-viewport { transparent }`.

## No comprobado / flojo
- Faltan capturas completas a 80 y 60 sin efecto: las buenas se sobrescribieron y el fondo de prueba se retiró a petición del usuario; las tomas sobre el escritorio real enseñan su Discord (no se suben).
- Mica: se aplica (sin errores) pero se ve casi opaca (Mica tiñe con el fondo de pantalla, no transparenta: igual que en Windows Terminal). Acrílico/Mica de Windows 11 se vuelven color sólido con la ventana sin foco (lo hace el sistema).
- Windows 10 (Mica → Acrílico) no probado: no hay máquina. Temas claros: solo comprobado por prueba unitaria (fondo de los 21 temas), no a ojo.

## Pendiente
- Que lo juegue el usuario; fusionar (no lo hace este obrero).
## Archivos
src-tauri/src/glass.rs (nuevo), src-tauri/src/main.rs, src-tauri/Cargo.toml/.lock, src/lib/glass.ts + glass.test.ts (nuevos), settings.ts, store.svelte.ts, terminals.ts, backend.ts, locales en/es settings.ts, app.css, App.svelte, Sidebar, TopBar, StatusBar, PaneView, Grid, SettingsGeneral.
