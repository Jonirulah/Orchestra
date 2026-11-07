# Actualizaciones automáticas y proceso de release

Orchestra se actualiza sola desde las releases de GitHub con el plugin oficial `tauri-plugin-updater` (Tauri 2).

## Cómo funciona

- **Endpoint**: `https://github.com/Jonirulah/Orchestra/releases/latest/download/latest.json` (en `src-tauri/tauri.conf.json`,
  `plugins.updater.endpoints`). GitHub redirige `releases/latest/download/<archivo>` al archivo de la última release que **no** es
  prerelease, así que `latest.json` tiene que subirse a esa release.
- **Firma**: `tauri build` firma el instalador NSIS con minisign si ve `TAURI_SIGNING_PRIVATE_KEY` y deja un `.sig` al lado
  (`bundle.createUpdaterArtifacts: true`). La clave pública va en `plugins.updater.pubkey`; la app solo instala lo que verifica con
  ella. La privada vive **fuera del repo**, en `<home>/.tauri/orchestra-updater.key` (sin contraseña; si algún día tiene, va en
  `<home>/.tauri/orchestra-updater.key.password`). **Si se pierde la privada, las versiones ya instaladas no podrán actualizarse
  más**: habría que publicar una versión con otra clave y que cada usuario la instale a mano. Haz copia de la clave.
- **Modo de instalación**: `plugins.updater.windows.installMode = "passive"`. El instalador es NSIS por usuario
  (`installMode: currentUser`, sin administrador): `passive` enseña solo una barra de progreso, no pide nada y no necesita
  permisos. `quiet` tampoco pediría permisos, pero no se ve nada durante los segundos en que Orchestra está cerrada y parece que se
  ha colgado; `basicUi` haría pulsar «Siguiente». El plugin lanza el instalador con `/UPDATE` y sale con `exit(0)`; el instalador
  vuelve a abrir Orchestra al terminar.
- **Backend** (`src-tauri/src/updater.rs`): `update_env` (versión y si es portable), `update_check` (guarda la actualización
  encontrada) y `update_install` (descarga con progreso por un `Channel`, verifica la firma e instala). Antes de salir
  (`on_before_exit`) para el servidor MCP y las métricas remotas, igual que `RunEvent::Exit`, que no llega a ejecutarse. Los errores
  llevan prefijo `signature:` o `network:` para que la interfaz los traduzca. No se expone ningún permiso del plugin al frontend
  (las capabilities siguen en `core:default`): todo pasa por esos tres comandos propios.
- **Portable**: se considera instalada si junto al exe está `uninstall.exe` (lo deja el NSIS). El portable de la release no lo
  tiene: el aviso ofrece solo «Descargar», que abre la página de la release. `update_install` se niega con `portable`.
- **Interfaz**: `src/lib/updatecheck.ts` (lógica pura con pruebas), `src/lib/updater.svelte.ts` (estado), `UpdateChip.svelte`
  (aviso en la barra superior + diálogo con notas, aviso de agentes trabajando y SSH abiertos, barra de progreso) y
  `SettingsUpdates.svelte` (Ajustes → General: «Buscar actualizaciones automáticamente» y «Buscar ahora»). La primera
  comprobación va 8 s después de arrancar; luego un tic cada 15 min mira si han pasado 6 h (así funciona aunque el equipo duerma).
  Antes de instalar se guarda el estado (`persistNow`) para que al volver se restauren paneles y sesiones de Claude.
- **Endpoint de pruebas**: en builds de depuración `ORCHESTRA_UPDATER_ENDPOINT=<url>` cambia el endpoint. En release no hay
  variable: las builds de prueba lo cambian al compilar con `tauri build --config <json>` (ver «Probar el ciclo»).

## Hacer una release

1. Escribe la sección `## [X.Y.Z] - AAAA-MM-DD` en `CHANGELOG.md` (sus líneas son las notas que verá el usuario en el aviso).
2. `node scripts/release.mjs X.Y.Z`:
   - sube la versión en `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
     `src-tauri/Cargo.lock`, `APP_VERSION` de `src/lib/settings.ts` y los README (insignia, nombres del instalador y del portable y
     la primera línea del párrafo de estado) con `scripts/bump-version.mjs`. La frase «New in …» / «Novedades de la …» del párrafo
     de estado se revisa a mano;
   - compila con `CARGO_TARGET_DIR` (opción `--target`; por defecto el del entorno o `src-tauri/target`) y `TAURI_SIGNING_PRIVATE_KEY` leída de la clave;
   - genera `latest.json` (`scripts/latest-json.mjs`: versión, notas del CHANGELOG, `pub_date`, firma y URL del instalador en la
     release) y copia instalador, `.sig`, portable, `latest.json` y `notes.md` a `<repo>/../Orchestra-release/vX.Y.Z/` (opción `--out`);
   - imprime el comando `gh release create …` **sin lanzarlo**.
3. `npm run check`, `npm test`, `cargo test --bin orchestra`; revisa el diff y haz commit de la subida de versión.
4. Lanza el `gh release create` impreso. La release tiene que quedar como *latest* (no prerelease).
5. Comprueba con `curl -L https://github.com/Jonirulah/Orchestra/releases/latest/download/latest.json` que sale la versión nueva.

Opciones del script: `--no-bump`, `--skip-build`, `--key`, `--out`, `--target`, `--repo`, y para pruebas `--tauri-config`,
`--url-base`, `--product`, `--binary`.

## Probar el ciclo sin GitHub

Las builds de prueba usan otro `productName`, `identifier` y `mainBinaryName` para **no pisar la instalación real** (el NSIS
cierra los procesos con el mismo nombre de exe y comparte la clave de desinstalación), y un endpoint local:

```json
{
  "productName": "OrchestraUpdTest",
  "identifier": "dev.orchestra.updtest",
  "mainBinaryName": "orchestra-updtest",
  "plugins": { "updater": { "endpoints": ["http://127.0.0.1:18777/latest.json"], "dangerousInsecureTransportProtocol": true } }
}
```

1. En un worktree aparte: `node scripts/release.mjs 0.3.0 --no-bump --tauri-config <json> --product OrchestraUpdTest
   --binary orchestra-updtest --url-base http://127.0.0.1:18777/v030 --out <carpeta>`.
2. Añade una sección de prueba al CHANGELOG del worktree y repite con `0.3.1` (sube la versión solo en el worktree).
3. Sirve `<carpeta>` con un servidor http en el puerto 18777 y copia el `latest.json` de la 0.3.1 a la raíz.
4. Instala la 0.3.0 de prueba (`OrchestraUpdTest_0.3.0_x64-setup.exe /S`), arráncala con `ORCHESTRA_DATA_DIR` y
   `WEBVIEW2_USER_DATA_FOLDER` en una carpeta temporal y deja que avise; «Actualizar» tiene que acabar con la 0.3.1 abierta.
5. Firma mala: firma el instalador con otra clave (`npx tauri signer sign -f <otra clave> <instalador>`) y pon ese `.sig` en el
   `latest.json`: la descarga tiene que fallar con el error de firma y no instalar nada.
6. Desinstala (`<LOCALAPPDATA>\OrchestraUpdTest\uninstall.exe /S`) y borra el worktree.
