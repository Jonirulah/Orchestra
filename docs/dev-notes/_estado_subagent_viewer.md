# Estado: visor de subagentes (cajón de solo lectura)

## Objetivo
Clic en un subagente del árbol «Active agents» -> cajón a la derecha (420 px, Esc/X, 180 ms respetando reduced-motion) con su
transcripción en vivo (encargo, texto, llamadas a herramientas con resumen, resultados colapsados/expandibles), «seguir» al final.

## Hecho
- `src-tauri/src/subtranscript.rs` (nuevo): `agent_transcript(pane_id, subagent_id, after_offset) -> {events, nextOffset, done}`;
  parser puro `parse_line/parse_events`; `read_chunk` incremental por bytes (primera llamada = final, ~100 eventos + primer prompt;
  tope 200 eventos / 256 KB); línea a medias retenida; ids validados; ruta derivada del agente seguido + canonicalize dentro de `projects/`.
- `agents.rs`: 2 líneas (`subtranscript::track` en `scan_one`, `retain_tracked` en `agent_scan`). `main.rs`: `mod` + comando.
- Frontend: `src/lib/subtranscript.ts` (reductor puro) + test, `SubagentDrawer.svelte`, `app.subagentView` en el store (se cierra si
  desaparece el agente), `AgentTree.svelte` (fila = abrir visor; icono terminal = «Ir al panel»), `App.svelte` (monta el cajón),
  demo con transcript falso que crece (`backend.ts`).
- i18n en+es: `agents.sub.*` (18 claves). Docs: README, ARCHITECTURE, SECURITY.

## Cómo se comprobó
- `cargo test --bin orchestra subtranscript`: 14 ok (incluye enlace simbólico real que sale de projects/). `agents::` 10 ok.
- `npm test`: 411 ok + 1 roja ajena (`hosts hostiles`, ssh; no es mía). svelte-check 0 errores. i18n:check: sin errores míos
  (quedan `git.*` sin usar, de otro agente).
- Demo con Chrome CDP (`scratchpad/sub-ui.mjs`, capturas `sub-1-open.png`, `sub-2-expanded.png`): desliza (x 1087 -> 860), 420 px,
  HTML/markdown como texto (0 nodos b/img), crece 1 evento/1,5 s, scroll arriba apaga «seguir» y no arrastra, el botón lo
  reactiva, Esc y X cierran, abrir otro reemplaza (1 solo cajón).
- Plantadas (fallan y se restauran con cmp): ids sin validar (2 rojas), comprobación de canonicalize quitada (1), relee desde 0 (3),
  línea a medias saltada (1), línea duplicada (2), `{@html}` en el cajón (1, test estático).

## Pendiente / dudas
- NO probado con un subagente real de Claude en la app real (solo fixtures sintéticos y demo): el formato real puede traer bloques
  que se ignoran.
- Tokens en la cabecera: no se muestran (los totales ya están en el árbol; por subagente haría falta dedupe por message.id).
- `done` = fichero sin escrituras 25 s; la cabecera usa el estado de la lista (`running/done`) mientras el subagente siga en ella.
- Si el subagente aún no tiene `agent_id` (su id es el de la llamada) el fichero no existe: el cajón muestra «Esperando…».
