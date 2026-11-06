# Estado: barras de cuota por cuenta (F2)

## Hecho
- `src-tauri/src/orchestra-statusline.ps1` (envoltorio, PS 5.1, ASCII): guarda `<datos>\quota\<cuenta>.json` (+ `<cuenta>.raw.txt` con el bloque `rate_limits` crudo, para ver la forma real del payload) y ejecuta el statusline original. Busca el original en `<proyecto>\.claude\settings.local.json`, `settings.json` y `<CLAUDE_CONFIG_DIR o ~\.claude>\settings.json`. Camino rapido en el mismo proceso si el original es `powershell ... -File x.ps1` que lee stdin con `[Console]::OpenStandardInput()` (como el del usuario); si no, hijo via cmd.
- `src-tauri/src/quota.rs`: `quota_prepare` (escribe `bin\orchestra-statusline.ps1` y `bin\orchestra-settings.json` solo si cambian), `quota_read`, `parse_payload` (solo pruebas), `read_dir`. Registrado en main.rs.
- Frontend: policy.ts (`fmtDuration`, `usageLevel`, `fmtWhen`, `windowView`, `usageViews`, `nextAlert`, `pressure(q, now)` ignora ventanas ya renovadas), model.ts `claudeSpec` con `settingsPath`, backend.ts `quotaPrepare/quotaRead` (+demo), settings.ts `captureUsage`/`notifyQuota`, store (`quota`, `nowSec`, sondeo cada 5 s, reloj cada 30 s, avisos 80/95 %), `UsageBars.svelte` en Sidebar y SettingsAccounts, dos interruptores en SettingsAgents, `--warn` en app.css.

## Como se comprobo
- svelte-check: 120 archivos, 0 errores, 0 avisos.
- node --test: 51 ok (incluye 12 nuevas en `src/lib/usage.test.ts`).
- cargo test quota: 8 ok. (La suite completa tiene ademas modulos de otro agente, p.ej. `vault`, con una prueba que fallo en una pasada: no es de cuotas.)
- E2E del envoltorio sin sesion de Claude (scratchpad `wtest/e2e.ps1`): 16 PASS / 0 FAIL: fichero escrito, valores, `at`, stdout igual byte a byte, fusion cuando solo viene five_hour, basura / sin rate_limits no escribe y saca lo del original, fallback de id por CLAUDE_CONFIG_DIR, sin id se salta, sin original no imprime, camino hijo.
- Latencia (mediana de 10, dentro de cmd): original 171 ms, envoltorio 281 ms (+110 ms, camino rapido); camino hijo 166 -> 400 ms (+234 ms).
- Tambien con el statusline real del usuario (solo lectura): salida identica.
- vite build ok; `tauri build --debug --no-bundle` ok (CARGO_TARGET_DIR=<cache>).
- `claude --help` confirma `--settings <file-or-json>`.

## No verificado
- El payload real de una sesion de Claude (nunca visto). Tras la primera respuesta de una sesion arrancada desde Orchestra deberia aparecer `%APPDATA%\dev.orchestra.app\quota\<cuenta>.json` y `.raw.txt`.
- Precedencia de `--settings` sobre el `statusLine` del proyecto (se asume que gana la CLI).
- Aspecto visual de las barras.

## Pendiente / dudas
- Los paneles ya guardados conservan sus args: solo capturan los que se abran de nuevo (o se cambien de cuenta).
- Si la barra no aparece en una cuenta con la sesion abierta, mirar `.raw.txt` y la forma real de `rate_limits`.

## Archivos tocados
src-tauri/src: quota.rs, orchestra-statusline.ps1 (nuevos); main.rs.
src/lib: usage.test.ts (nuevo); policy.ts, model.ts, backend.ts, settings.ts, store.svelte.ts.
src/components: UsageBars.svelte (nuevo); Sidebar, SettingsAccounts, SettingsAgents. src/app.css (`--warn`).
