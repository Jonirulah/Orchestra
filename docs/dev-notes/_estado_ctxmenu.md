# Estado: menús contextuales (clic derecho)

## Objetivo
Menú en las cuentas de la barra lateral (y en la cabecera de la tarjeta en Ajustes → Cuentas) y en el fondo de la cuadrícula
(celda vacía / hueco entre paneles) y de la barra lateral. Un solo componente reutilizable.

## Hecho
- `src/lib/ctxmenu.ts` (puro): `MenuItem`, `clampPosition`, `placeSubmenu`, `moveActive`, `activate` (confirmación en dos pasos), `shownLabel`, `tidy`, `keepsNativeMenu`, `isMenuKey`.
- `src/lib/ctxitems.ts` (puro): `accountMenu`, `backgroundMenu`, `sidebarMenu` (el modelo de cada menú; solo ofrece lo que existe por proveedor).
- `src/lib/ctxmenu.svelte.ts`: estado global (un menú a la vez), `openFromEvent` / `openBelow` (teclado).
- `src/lib/ctxaccount.ts`: acciones reales de una cuenta (store + backend), compartidas por Sidebar y SettingsAccounts.
- `src/components/ContextMenu.svelte`: montado una vez en App.svelte. role=menu/menuitem(radio), foco real, submenú de un nivel, Esc / clic fuera / scroll / rueda / blur / resize cierran, prefers-reduced-motion.
- Sidebar: clic derecho en fila de cuenta, Shift+F10 / tecla Menú, F2 = renombrar en línea; clic derecho en hueco de la barra.
- Grid: clic derecho en celda vacía (usa esa celda como destino) o hueco; sobre un panel no hace nada (el terminal conserva su menú); campos de texto conservan el nativo.
- SettingsAccounts: menú en la cabecera de la tarjeta.
- Rust: `store::open_account_dir` (solo abre la carpeta si es `dir` de una cuenta del state.json y existe) + 2 tests; `backend.openAccountDir`.
- i18n: área `ctx` (en + es), 36 claves.

## Cómo se comprobó (ver informe final para cifras)
- svelte-check, npm test, i18n:check, cargo test --bin orchestra store::.
- CDP con Chrome headless contra el Vite de demo (script `scratchpad/ctx-ui.mjs`), capturas en scratchpad.

## Pendiente / dudas
- No se probó en la app real (orchestra.exe no se toca): abrir carpeta en el Explorador y copiar al portapapeles solo se comprobaron por código / test Rust.
- Fila del Claude «auto» y las de SSH / shells no tienen menú (fuera de lo pedido).
