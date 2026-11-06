# Estado i18n UI principal
Hecho: Sidebar, TopBar, Grid, PaneView, Palette, AgentTree, UsageBars migrados; App.svelte sin textos propios (solo "Orchestra…", nombre de producto) -> app.ts queda vacio.
Areas: sidebar(25) topbar(9) grid(7) pane(19) palette(9) agents(25) usage(1). Registro en index.ts de en/es ya existia.
Comprobado: i18n-check (c) 0 hallazgos en mis ficheros; svelte-check sin errores en mis ficheros (errores ajenos: shortcuts.ts, settingsTerminal.ts es L39, SettingsDialog...); scripts/i18n-ui-switch.test.mjs 5/5.
i18n-ignore usados: Sidebar `· tmux` (nombre de producto), Sidebar `Codex (ChatGPT)`, PaneView `--continue` (flag CLI).
Pendiente / dudas: PRESETS.label (model.ts) y POLICIES.label/hint (policy.ts), usageViews tip/left (policy.ts) siguen en ingles: dueno agente 3. grid.empty.autoTitle en es cita «Manual / Round-robin / …» tal cual.
Archivos: src/components/{Sidebar,TopBar,Grid,PaneView,Palette,AgentTree,UsageBars}.svelte, src/lib/locales/{en,es}/{sidebar,topbar,grid,pane,palette,agents,usage}.ts, scripts/i18n-ui-switch.test.mjs
