# Brief: transparencia de la ventana (2026-11-17)

Pedido del usuario: «le falta transparencia al orchestra, importante». Hoy no hay nada (ni `transparent` en tauri.conf.json, ni efecto de ventana, ni alfa en xterm).

## Objetivo
Ventana de Orchestra translúcida como Windows Terminal: se ve el escritorio detrás.

## Criterio de hecho (medible)
1. Ajustes → Apariencia (o donde estén los temas): 
   - «Opacidad» deslizador 30–100 % (100 = como hoy, valor por defecto 100 para no cambiar a nadie sin querer).
   - «Efecto» Ninguno / Acrílico / Mica (Windows 11; en Windows 10 sin Mica, caer a Acrílico o Ninguno sin romper).
   - Se aplica en vivo, sin reiniciar, y se guarda en state.json. Incluido en export/import de ajustes.
2. Con opacidad < 100: el fondo del terminal (xterm, `allowTransparency: true` + background del tema con alfa), barra lateral, pestañas y barra de estado dejan ver detrás. El TEXTO sigue opaco y legible (nunca bajar la opacidad del texto). Menús, diálogos, ajustes, fichas y cajones siguen opacos (o casi) para leerse.
3. Funciona con los 21 temas (claros y oscuros) sin colores rotos.
4. Rendimiento: xterm con allowTransparency no debe hundir el render (comparar a ojo scroll de un `cat` grande; si va mal, decirlo).
5. Textos en EN y ES (i18n:check OK).
6. Verde: `npm test`, `npx svelte-check` 0/0, `npm run i18n:check`, `cargo test --bin orchestra` (las inestables conocidas: vault::ida_y_vuelta en paralelo).
7. Capturas del exe real (no solo la demo del navegador, porque la transparencia es de la ventana) con opacidad 100, 80 y 60, y con Acrílico, sobre un fondo de escritorio reconocible: guárdalas en docs/dev-notes/img/transparencia-*.png.

## Pistas
- Tauri 2: `"transparent": true` en la ventana + crate `window-vibrancy` (apply_acrylic / apply_mica / clear_*). En Windows, `transparent` + decoraciones propias: comprobar que la barra de título/bordes siguen bien.
- La opacidad se puede hacer con variables CSS (`--bg` con color-mix(... alfa)) en vez de `opacity` global.
- Lee `docs/dev-notes` y la memoria del proyecto para cómo probar aislado.

## Cómo probar sin tocar los datos del usuario
- Worktree: `git -C E:/Orchestra worktree add E:/Orchestra-wt/transparencia -b transparencia master` y trabajar SOLO ahí.
- Compilar con `CARGO_TARGET_DIR=E:\_cache\orchestra-target-transp` (no el target del usuario).
- Lanzar el exe con `ORCHESTRA_DATA_DIR` y `WEBVIEW2_USER_DATA_FOLDER` apuntando a carpetas temporales tuyas; sin NO_COLOR ni CLAUDE_CODE_* heredadas. NUNCA abrir el Orchestra instalado del usuario ni sus datos. Cerrar tus instancias al acabar.

## Qué no tocar
- E:\Orchestra (árbol principal): tiene cambios de otras sesiones sin commit.
- Nada de push, tag, release ni fusión a master: commit LOCAL en la rama `transparencia` y ya.
- No cambiar el aspecto por defecto (opacidad 100 + Ninguno = idéntico a hoy).

## Estado
Escribe el progreso en `E:/Orchestra-wt/transparencia/docs/dev-notes/_estado_transparencia.md` (hecho / cómo se comprobó / pendiente / archivos). Al acabar, resumen corto: commit, cifras de pruebas, rutas de capturas, ruta del exe de prueba, y lo que NO pudiste comprobar.
