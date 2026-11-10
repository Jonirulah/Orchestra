# Estado: color del markdown de Claude + tema de Claude sin /theme (0.4.3)

## Criterio de hecho
- Reescritor SGR puro (src/lib/mdcolor.ts) con tests: trozos partidos, resets 0/22/23/24/39, colores explícitos intactos,
  no-Claude intacto, fixtures reales de Claude (dark y custom:orchestra-terminal).
- Test de contraste ≥4,5:1 en los 21 temas.
- settings.json: Rust escribe theme preservando claves, no pisa temas a mano, restaura. cargo test verde.
- npm test, svelte-check 0/0, cargo test, npm run i18n:check verdes.
- 4 capturas antes/después (oscuro y claro) en docs/dev-notes/img.
- MB/s del reescritor con ≥10 MB.
- Versión 0.4.3 en todo, CHANGELOG, un commit local.

## Hecho
- Capturas reales (pywinpty/ConPTY, CLAUDE_CONFIG_DIR temporal en scratchpad con credenciales copiadas SIN refreshToken,
  haiku, tui fullscreen como el usuario): docs/dev-notes/fixtures_claude/claude-2.1.322-{dark,orchestra-terminal,
  orchestra-githublight}.bin + capture.py.
- Lo que manda Claude 2.1.322 (las tres capturas igual): texto del markdown en primer plano POR DEFECTO (39), no truecolor.
  `#` = ESC[1m ESC[3m ESC[4m (separados); `##` = solo 1; **x** = 1…22; *x* = 3…23; `código` = 38;2 (#b1b9f9 en dark y en
  orchestra-terminal, #5769f7 en githublight: el override `permission` (#8ca4fd) NO se aplica al código en línea → el código
  no usa `permission` del tema propio; queda apuntado, no es de esta entrega). La viñeta ● va en truecolor = clave `text`
  (#ffffff dark, #d7dae0 orchestra-terminal, #24292f githublight). «Read 1 file» va en gris explícito con el 1 en negrita.
  ConPTY cambia espacios por ESC[nG y mueve ESC[23m tras el salto: no afecta a un reescritor de SGR.

- src/lib/mdcolor.ts (reescritor + mdPalette + isClaudePane) y src/lib/mdcolor.test.ts: 10 tests verdes
  (`node --test src/lib/mdcolor.test.ts` → pass 10). Plantado: quitar la condición de color explícito → 2 tests FAIL; restaurado → pass 10.
- Pintado de más (según fixtures): cabecera «Claude Code» de bienvenida (negrita), el aviso «Auto mode is now…» (negrita,
  una vez), el contador en negrita de «Reading **1** file…» mientras corre (el «Read 1 file» final va en gris: no se pinta),
  y el markdown del mensaje del usuario (texto #ffffff = «text» → se pinta; es markdown, se deja). «● Bash(…)» no salió en
  la captura (Read se pliega en «Read 1 file»); si Claude pone el nombre de herramienta en negrita sin color, se pintará
  como negrita: distinguirlo exige mirar lo que viene DESPUÉS («(»), no es barato → se deja.
- Rendimiento (scripts/mdcolor-bench.ts, 10 MB de la captura orchestra-terminal repetida, mediana de 7): 216 MB/s en trozos
  de 4 KB, 219 MB/s en 64 KB; salida +2,9 %. (La primera versión con split de strings daba 51 MB/s.)

- Entrega 2 Rust: src-tauri/src/claude_theme_choice.rs + comando claude_theme_set (commands.rs, main.rs); valid_dir pub.
  Claude 2.1.322 (binario): resolveSetting("theme","dark") de settings.json; temas de serie M4e=[auto,dark,light,
  light-daltonized,dark-daltonized,light-ansi,dark-ansi]; `custom:<slug>`; el tema se lee al arrancar (useState inicial),
  los archivos de tema sí se recargan en caliente → el cambio vale para sesiones NUEVAS.
  Copia del valor anterior en <cuenta>/.orchestra-theme.json {previous, applied, released}. Edición textual de la clave.
  `cargo test claude_theme` → 7 passed. Plantado (overwritable siempre true) → never_overwrites FAILED; restaurado → ok.

- Frontend: settings.ts (claudeMarkdownColor on, claudeThemeSet off; en SECTION_KEYS.terminal; backup lo cubre al ir en
  settings), backend.ts claudeThemeSet, store (mdPal $derived, mdColorsFor, aplicar tras escribir temas, syncClaudeThemeOff
  restaura), terminals.ts (hook mdColors, entry.md, reset al relanzar), SettingsTerminal.svelte (toggle hijo + fila nueva),
  i18n EN/ES. npm test 772/772 (+1 de settings → 773), svelte-check 0/0, i18n:check OK.

- Paleta v2: candidatos no grises (Solarized: sus brillantes son grises), contraste ≥ 4,5 y que se distinga del texto
  (L* ≥ 60 o |ΔL*| ≥ 15); si no, el primero con contraste; si no, mezcla hacia el texto. Motivo: en GitHub Light la v1 daba
  negrita #4d2d00 (marrón casi negro, se leía como texto, visto en captura). Ahora #cf222e. Mezclas (sin ANSI ≥ 4,5):
  solarized h1, solarizedlight los 3, catppuccinlatte negrita+cursiva, onelight negrita+cursiva.
- Demo del navegador: `?claude=<captura>` reproduce la captura real en los paneles de Claude (backend.ts, solo sin Tauri).
  Capturas con Playwright + Chrome (scratchpad/shots.py), estado inyectado en localStorage, viewport 1186×860 (110 col).

- Rendimiento final (bucle de texto a mano, parámetros CSI seguidos): Node 272-302 MB/s (scripts/mdcolor-bench.ts, 10 MB,
  salida +2,9 %). Chrome, mismos 10 MB en trozos de 4 KB: reescritor 37 ms = 268 MB/s; term.write de xterm.js 497-532 ms
  = 19-20 MB/s. El reescritor es ~7 % del coste de escribir en el terminal.
- Capturas (recorte del panel, 888×420): docs/dev-notes/img/md-color-{dark,light}-{before,after}.png. dark = tema
  orchestra con el tema de Claude dark; light = githublight con custom:orchestra-githublight. Antes: título, negrita y
  cursiva en el color del texto. Después: título morado subrayado en cursiva, negrita amarilla (oscuro) / roja (claro),
  cursiva cian; código en línea y «Read» sin tocar. (Las dos tandas son capturas reales distintas: el texto difiere.)
- Versión 0.4.3 con scripts/bump-version.mjs (8 archivos) + CHANGELOG + párrafo de estado de los README.
- Comprobado: npm test 773/773, svelte-check 0/0, cargo test 389+5 ok, i18n:check OK (3 avisos que ya estaban en master).
- .gitattributes: *.bin binary (las capturas no se tocan con eol).

## Pendiente
- Nada del brief. Sin probar en la ventana de escritorio con sesiones vivas (publicación: el usuario).

## Archivos tocados
