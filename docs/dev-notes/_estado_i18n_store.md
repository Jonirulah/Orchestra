# Estado i18n store/policy/model/dialogs (terminado)
Hecho: locales {en,es}/{store,policy,model,dialogs}.ts (68 claves); policy.ts, model.ts, settings.ts, backend.ts, store.svelte.ts, AccountDialog.svelte migrados.
Comprobado: svelte-check 0/0 (172 files); node --test src/lib/*.test.ts 123 pass (incl. nuevo src/lib/i18n-store.test.ts, 6 tests);
i18n-check (c) heuristica 0 hallazgos en mis archivos; sin errores (a)/(b) de mis claves (los 182 errores son de otros agentes en curso).
Archivos: ver informe. Sin commit.
Para otros: displayName(name) de model.ts en sitios que pintan nombre de workspace/cuenta (TopBar:37, Sidebar:79, Grid:88, Palette:16, PaneView:108).
