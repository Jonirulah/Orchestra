# Estado: bóveda SSH fase 1 (terminada)

## Hecho
- Rust: `src-tauri/src/vault.rs` (secret_set/exists/delete/copy; askpass; ssh_keys_list, ssh_keygen, ssh_key_reveal, ssh_key_forget_passphrase), `src-tauri/tests/askpass.rs`; main.rs (askpass antes de Tauri + 8 comandos), pty.rs (si el env trae ORCHESTRA_ASKPASS_KEY inyecta SSH_ASKPASS=exe actual, SSH_ASKPASS_REQUIRE=force, ORCHESTRA_ASKPASS_MODE=1; respeta un SSH_ASKPASS ya presente), Cargo.toml (`keyring` 3, windows-native).
- Askpass: ssh llama al exe con UN solo argumento (el prompt), no con `--askpass`; se detecta por ORCHESTRA_ASKPASS_MODE=1 + 1 arg (también acepta `--askpass`). Solo contesta a prompts del tipo de la clave (…:password -> "password"; …:passphrase -> "passphrase"); nunca a yes/no, huellas ni 2FA (exit 1, stdout vacío).
- ssh-keygen con passphrase: sin `-N`; entrada temporal `tmp:keygen-…:passphrase` en la bóveda + el mismo askpass; se borra siempre.
- TS: model.ts (AuthMethod, Host.authMethod/hasPassword/hasPassphrase, activeSecretKey, sshArgs, sshSpec, sshInstallKeySpec, normalizeHost, exportHosts, hostFromSshConfig, newConfigEntries), backend.ts (secret*, sshKeys*, modo demo), store.svelte.ts (normalizeHost al cargar, refreshSshSpec al arrancar/reiniciar paneles, deleteHost borra secretos, importSshConfig, exportHosts, OpenReq `sshinstall`), HostDialog (bloque Authentication), SettingsKeys.svelte + pestaña «SSH keys», Sidebar (menú Import/Export en la sección SSH).
- DECISIÓN a revisar: hosts con secreto guardado llevan `-o StrictHostKeyChecking=accept-new` (el askpass no puede contestar «yes/no»; una huella CAMBIADA se sigue rechazando). Hosts sin secreto: idéntico a antes.
- Importar ~/.ssh/config copia los datos ya resueltos (hostname, user, port, identityFile, proxyJump) en grupo «Imported»; omite alias que ya existen como nombre de host.

## Cómo se comprobó
- `cargo test` (CARGO_TARGET_DIR=<cache> porque src-tauri\target\debug\orchestra.exe está en uso): 65 ok + 5 ok (tests/askpass.rs), 6 ignoradas (2 son los e2e SSH; el resto ya estaban).
- `node --test src/lib/*.test.ts`: 69 ok (14 nuevas en model.test.ts). svelte-check: 156 archivos, 0 errores, 0 avisos.
- FAIL antes / PASS después: el test de passphrase falló («la clave no está cifrada») con el askpass apuntando al binario de pruebas; pasó con el exe real. El e2e SSH se colgó 40 s con la ruta de known_hosts con espacios (ssh parte `-o K=V` por espacios), pasó al moverla.
- Askpass GUI: la prueba compila un exe `windows_subsystem="windows"` (cabecera PE Subsystem=2 comprobada) y su stdout llega por la tubería heredada. El exe real de producción NO se ha construido en release aquí (lo hace el orquestador): vale ejecutar un e2e tras el build.
- E2E REAL (ignorados; `cargo test --bin orchestra ssh_e2e -- --ignored`): sshd 10.2 en WSL Ubuntu (127.0.0.1:2222, usuario temporal), ConPTY real vía pty::spawn, exe copiado a «carpeta con espacios»:
  - login por contraseña guardada: OK con OpenSSH de Windows 9.5 y con el ssh de Git 10.2; la contraseña no sale en pantalla, ssh no pide nada por la terminal; contraseña errónea -> 1 solo «Permission denied».
  - login con clave ed25519 con passphrase (guardada) -> OK; passphrase errónea -> denegado.
  - «Install on server»: el panel PowerShell generado por sshInstallKeySpec, con la contraseña por askpass, deja la .pub en authorized_keys del remoto UNA vez, sin CR, permisos 700/600.
  - Limpieza hecha: sshd parado, usuario borrado, entradas de la bóveda de prueba borradas (cmdkey vacío), known_hosts sin la entrada. Queda instalado `openssh-server` en WSL Ubuntu (servicio ssh deshabilitado).
- Seguridad: test de que el JSON guardado/exportado de un Host no tiene campos password/passphrase/secret ni banderas en el export; el entorno del panel solo lleva el nombre de la entrada; ningún comando devuelve secretos (grep: solo `get` interno usado por el askpass y tests).

## No verificado / dudas
- Binario release real como askpass (subsistema GUI) y el flujo completo con la interfaz (no se lanza la app aquí).
- Generar clave desde la UI y «Reveal in Explorer»: solo comprobada la lógica Rust de keygen/lista; el reveal (explorer /select) no se ha ejecutado.
- Los paneles ya abiertos antes de cambiar el host no cambian hasta reiniciarlos (se rehace el spec al reiniciar/arrancar).
- Otro agente parece estar internacionalizando la UI: mis textos están en inglés y fuera de claves de traducción.
