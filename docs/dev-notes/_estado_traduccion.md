# Estado de la traducción al inglés (Orchestra)

## Hecho
- Componentes Svelte: AgentTree, PaneView, Sidebar, Grid, HostDialog, Palette, TopBar, AccountDialog.
- Lógica y textos: model.ts (PRESETS), policy.ts (POLICIES y motivos), store.svelte.ts (toasts, nombres por defecto), terminals.ts (avisos en terminal), backend.ts (modo demo).
- policy.test.ts: solo se cambiaron las regex a los textos nuevos (mismas aserciones, mismos nombres de test).
- index.html: `lang="en"`.
- Rust: main.rs (menú de la bandeja, `expect`), commands.rs, pty.rs, shells.rs (`Command Prompt`), accounts.rs, agents.rs (`subagent: ...`, tipo por defecto `agent`).
- Migración en store.svelte.ts `init()`: cuenta por defecto y espacio «Principal» pasan a «Main».
- Estados nuevos `shell` y `new` añadidos a los dos mapas de estado (AgentTree y PaneView).

## Cómo se comprobó (2026-11-06)
- svelte-check: 106 ficheros, 0 errores, 0 avisos.
- node --test src/lib/*.test.ts: 18 pass, 0 fail.
- cargo test: 9 passed, 0 failed, 3 ignored.
- npx vite build: correcto.
- Auditoría con grep: acentos en src/ y src-tauri/src/ solo en comentarios, código de test y una línea de depuración (`eprintln!` de agents.rs). Palabras sueltas en español: solo la migración de «Principal».

## Pendiente / dudas
- `kind` de los subagentes (obrero, critico, verificador) en backend.ts (modo demo) se dejan tal cual: son valores de datos. Si se muestran en la interfaz, habría que traducirlos.
- `agent` como tipo por defecto en agents.rs (antes `agente`) y `kind` de los subagentes pueden verse en la interfaz: revisar.
- AccountDialog.svelte: el nombre de carpeta por defecto cuando el nombre está vacío pasa de `nombre` a `name` (cambia la carpeta propuesta, no la lógica).
- Los identificadores de cuenta/espacio guardados (`Principal`) se migran solo al arrancar; no se ha probado con un state.json real.
- No se ha ejecutado la app ni el dev server.

## Archivos tocados
src/components/{AgentTree,PaneView,Sidebar,Grid,HostDialog,Palette,TopBar,AccountDialog}.svelte; src/lib/{model,policy,policy.test,store.svelte,terminals,backend}.ts; index.html; src-tauri/src/{main,commands,pty,shells,accounts,agents}.rs; docs/_estado_traduccion.md (nuevo).
