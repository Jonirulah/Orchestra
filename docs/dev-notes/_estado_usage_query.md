# Estado: consulta de uso opcional (usage query)

## Hecho
Backend (Rust)
- `src-tauri/src/usage_query.rs` + `usage_query/tests.rs`; comando `usage_fetch(accounts, interval_min?)` en main.rs; `ureq 3` (rustls, sin features por defecto) en Cargo.toml; `quota::write_if_changed` ahora `pub(crate)`.
- Token solo en `Secret` (Debug/Display = `***`); solo `claudeAiOauth.accessToken` y `expiresAt` (el refresh token ni se deserializa); carpeta canonicalizada, sin `..`, el fichero debe estar directamente dentro; caducado o a <60 s => `expired` y CERO peticiones; nunca se renueva; sin redirecciones; destino fijo HTTPS salvo desvio loopback (`ORCHESTRA_USAGE_URL`, rechazado si no es `http://127.0.0.1:<puerto>` o `localhost:<puerto>`); timeouts 5/10 s; cuerpo <= 256 KB; suelo de 60 s por cuenta; espera 2x intervalo (max 30 min) tras 429/5xx/red; volcado `quota/<id>.query-raw.txt` (<= 4 KB, con el token tachado si el servidor lo repitiera).
- Forma REAL (vista una vez por el orquestador, 2026-11-06, Max 20x): `five_hour: null` = ausente (no 0 %); `seven_day {utilization, resets_at ISO con 6 decimales +00:00}`; `limits[] {kind, group, percent, resets_at, scope{model{display_name}}, is_active}`. `weekly_all` = semanal general; lo demas pasa a extras (max 8, textos <= 40). `kind`/`group` con five/hour/session (sin alcance de modelo) = ventana de 5 h si falta.
- `quota.rs`: `QuotaFile.limits: Option<Vec<Limit>>` (compatible hacia atras; `read_dir` limpia y limita; ficheros solo con limits tambien se leen). La consulta sustituye `limits` solo si la respuesta los trae; el envoltorio `.ps1` (ASCII) ahora los copia al reescribir el fichero.
Frontend
- settings.ts (`usageQuery` false, `usageQueryMin` 5 clamp 2..30, seccion agents, `parseImport` nunca enciende `usageQuery`), `usageQuery.ts` (+ tests), backend.ts `usageFetch` (+ demo, `QuotaEntry.limits`), store (`usageStatus`, `armUsageQuery`, `runUsageQuery`, `testUsage`, `limits` en `pollQuota`), SettingsAgents (interruptor + confirmacion de dos pasos + slider), SettingsAccounts (linea de estado + "Probar ahora"), UsageBars (5 h solo si hay dato, 7 d, fila fina del modelo si su limite activo supera al semanal, tooltip "ultimos datos" si caducado), policy.ts (`pressure/exhausted/nextReset` con limites activos, `extraView`, `usageViews.extra`), i18n `settingsUsage.ts` en/es + `usage.bars.lastData/scopedTip`.
Docs: SECURITY, ARCHITECTURE (usage query + forma real + limits), README (fila "real endpoint: verified once").

## Como se comprobo (cifras)
- svelte-check: 183 archivos, 0 errores, 0 avisos.
- npm test: 163/163 (145 + 18 nuevas).
- i18n-check: OK, 531 claves en/es, 0 textos fijos.
- cargo test: 162 + 5 ok (11 ignorados ya existentes), sin avisos.
- Bichos plantados (todos detectados salvo el 6): 1 enviar con token caducado -> expired_* (3 pruebas); 2 token en mensaje de error -> slow_response, connection_refused, source scan; 3 seguir redireccion -> redirects_are_never_followed; 4 sin `..` -> path_traversal_*, traversal_dir_sends_zero_requests; 5 sin contencion -> containment_*, credentials_symlink_*; 6 quitar el tope de lectura 256 KB -> NO detectado (el flag `truncated` se calcula despues; el tope solo protege memoria); 7 sin suelo/espera -> per_account_floor, rate_limit_backs_off, unauthorized_...floor; 8 el .ps1 no conserva limits -> wrapper_keeps_the_limits_the_usage_query_wrote; 9 five_hour null como 0 % -> real_shape_* y otras 6; 11 la consulta borra limits si no vienen -> query_keeps_existing_limits...; 12 policy sin limites activos -> 5 pruebas de limits.test.ts.
- Greps: `.credentials.json` solo en usage_query.rs y sus pruebas (carpetas temporales) y en el test del frontend que lo prohibe; docstring en mcp.rs; `usage_query.rs` sin println/eprintln/dbg/log/tracing (lo vigila una prueba); `expose()` solo en la cabecera Authorization y en el tachado del volcado.

## No verificado
- El endpoint real solo lo vio el orquestador una vez (Max 20x). No se ha visto una ventana de 5 h activa ni otros planes; el nombre del limite de 5 h en `limits[]` es suposicion defensiva.
- TLS real contra api.anthropic.com, proxy corporativo, aspecto visual (subgrid en UsageBars, sin capturas), flujo de dos pasos en la app real, `tauri build`.

## Dudas
- "Probar ahora" dentro de los 60 s de la ultima peticion devuelve el ultimo resultado (suelo duro).
- Con `five_hour: null` se conserva el valor de 5 h que escribio el envoltorio (puede ser viejo; la ventana vencida se muestra como 0 por la logica existente).
- `active` por defecto false si falta; `exhausted()` ahora evita cuentas con un modelo agotado aunque se use otro.
- 401/403 no activan espera larga (solo el suelo de 60 s).

## Archivos tocados
src-tauri: Cargo.toml, src/usage_query.rs y src/usage_query/tests.rs (nuevos), src/quota.rs, src/orchestra-statusline.ps1, src/main.rs.
src/lib: usageQuery.ts, usageQuery.test.ts, limits.test.ts (nuevos); settings.ts, settings.test.ts, policy.ts, backend.ts, store.svelte.ts; locales/{en,es}/settingsUsage.ts (nuevos), usage.ts, index.ts.
src/components: UsageBars, SettingsAgents, SettingsAccounts. docs: SECURITY, ARCHITECTURE, README, este archivo.
