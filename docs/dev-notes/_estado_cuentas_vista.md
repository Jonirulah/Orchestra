# Estado: Accounts list view (filter / group / sort)

## Hecho
- `src/lib/accountview.ts` (puro): `buildAccountView(accounts, opts, ctx) -> Section[]`, `sortAccounts`, `effectiveFilter`, `providerCounts`, `matchesText`, tipos `AccountsFilter` / `AccountsSort`.
  - Filtro `all|claude|codex|opencode` (si el proveedor ya no tiene cuentas -> All), agrupar por proveedor (encabezados solo con >= 2 proveedores con cuentas y >= 2 secciones visibles),
    orden `manual|name|free|reset` (free/reset solo ordenan Claude con dato; el resto va al final en su orden relativo; estable; no muta la entrada).
  - Filas sueltas: `auto` dentro de Claude, lanzador `codex` dentro de Codex (solo sin cuenta Default Codex). Con agrupar apagado: una sola seccion plana, filas al final.
- Ajustes (`settings.ts`): `accountsFilter`, `accountsSort`, `accountsGroup` (defaults all / manual / true), validados en `clampSettings`, seccion `accounts` en `SECTION_KEYS`
  (el boton «Reset section» ya sale tambien en Ajustes -> Cuentas: `SettingsDialog.svelte`).
- `ctxitems.accountsViewMenu` (Sort by submenu 4 radios, Group by provider, Show: All/Claude/ChatGPT/opencode; sin cuentas = deshabilitado).
- `Sidebar.svelte`: chips (solo con >= 2 proveedores), boton `sort` (icono nuevo en `Icon.svelte`) junto al `+` (acento si la vista no es la de siempre), secciones con encabezado `.grp`.
- `SettingsAccounts.svelte`: mismo orden y agrupacion (NO el filtro por proveedor: es la pantalla para gestionarlas todas) + fila Seg de orden y Toggle de agrupar.
- Demo (navegador): `backend.demoProviderAccounts()` (Codex «Work», opencode «Side») que `store.svelte.ts` anade tras `syncAccounts()` solo fuera de Tauri.
- i18n: `sidebar.accounts.{viewTitle,filterAria,chip.*,group.*,groupHead}`, `ctx.accountsView.*`, `settings.accounts.{sortLabel,sortHint,sort*,groupLabel}` en en + es.
  Allow-lists de «idénticos» ampliadas en `scripts/i18n-ui-switch.test.mjs` y `src/lib/settingsi18n.test.ts` (nombres de producto, «Manual»).
- Docs: README (linea de funciones), `docs/ARCHITECTURE.md` (parrafo en «Accounts by provider»).

## Como se comprobo
- `node --test src/lib/accountview.test.ts`: 33 pruebas (filtros, proveedor desaparecido, agrupar on/off, cada orden con empates y sin datos, texto, estabilidad, inmutabilidad con entradas congeladas, ajustes, menu).
- Tabla de bugs plantados (scratchpad `plant_av.py`): 13 bugs en accountview.ts / ctxitems.ts, los 13 hacen fallar >= 1 prueba (1 a 8 fallos cada uno); restaurado y `cmp` identico a la copia previa.
- Demo en Chrome headless (CDP, `acct-view.mjs`): vista agrupada con encabezados, chip ChatGPT con teclado (Enter), menu con submenu, ordenes Name / Most free, agrupar OFF, texto «work» sobre el filtro,
  ajustes persistidos en localStorage (`accountsFilter/Sort/Group`). Capturas: scratchpad `av-1-grouped.png`, `av-2-filtered.png`, `av-3-menu.png`.

## Pendiente / dudas
- No se planto ningun bug en `settings.ts` (otro agente lo edita a la vez); la validacion la cubren las pruebas de `accountview.test.ts` pero sin tabla de plantado propia.
- Settings -> Accounts: comprobado solo compilando y por la logica compartida (la pagina de la demo se rompio por un cambio ajeno en `backend.ts` mientras lo miraba).
- Arrastrar para reordenar no esta hecho (no se pedia); con orden != manual, el orden guardado no cambia.
- El menu marca «Group by provider» con la misma marca que los radios (el componente usa `menuitemradio` para cualquier `checked`).
