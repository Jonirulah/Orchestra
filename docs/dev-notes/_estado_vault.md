# Estado: bóveda SSH fase 1

## Hecho
- Rust: `vault.rs` (secret_set/exists/delete/copy, askpass, ssh_keys_list, ssh_keygen, ssh_key_reveal, ssh_key_forget_passphrase), `tests/askpass.rs`; main.rs (askpass antes de Tauri + comandos), pty.rs (si env trae ORCHESTRA_ASKPASS_KEY inyecta SSH_ASKPASS=exe actual, SSH_ASKPASS_REQUIRE=force, ORCHESTRA_ASKPASS_MODE=1), Cargo.toml (keyring 3, windows-native).
- Askpass: ssh llama al exe con UN argumento (el prompt), no `--askpass`; se detecta por ORCHESTRA_ASKPASS_MODE=1 + 1 arg (también acepta `--askpass`). Solo contesta a prompts que casan con el tipo (…:password -> "password"; …:passphrase -> "passphrase"); nunca a yes/no, huellas ni 2FA.
- ssh-keygen con passphrase: no usa `-N`; entrada temporal `tmp:keygen-…:passphrase` en la bóveda + el mismo askpass (no aparece en la línea de comandos).
- FAIL antes: test de passphrase falló con "la clave no está cifrada" cuando el exe del askpass era el binario de pruebas; PASS tras pasar el exe real.

## Cómo se comprobó
- cargo test (CARGO_TARGET_DIR=<cache> porque src-tauri\target\debug\orchestra.exe está en uso): 27 ok + 5 ok (tests/askpass.rs) incl. ida y vuelta keyring, askpass real por tubería, negativos, exe GUI (subsistema 2 comprobado en la cabecera PE), ssh-keygen en carpeta temporal.

## Pendiente (ver abajo la lista viva)

## Huella del servidor configurable (2026-11-06) — ver `_estado_hostkey.md`
- Antes: hosts con secreto guardado siempre `StrictHostKeyChecking=accept-new`. Ahora es un AJUSTE: `sshHostKeyPolicy` global (`confirm` por defecto | `accept-new`) + `hostKeyPolicy` por host (`default` | `confirm` | `accept-new`; ausente = global).
- `confirm`: antes de abrir (o reiniciar) el panel, Rust (`hostkey.rs`) mira `ssh-keygen -F`; si es desconocida, `ssh-keyscan` (o, si el keyscan de Windows 9.5 no negocia KEX sntrup761, el propio `ssh` sin autenticar con known_hosts temporal) + `ssh-keygen -lf -`; el modal `ConfirmHostKey.svelte` enseña las huellas; «Trust and connect» AÑADE a `~/.ssh/known_hosts` y el panel arranca con `StrictHostKeyChecking=yes`. Hosts sin secreto: igual que antes.
- Casos: ProxyJump/ProxyCommand/HostKeyAlias y clave desconocida -> mensaje y no se conecta; keyscan inalcanzable -> error claro; clave distinta en known_hosts -> se conecta con `yes` y ssh avisa; `.ssh` ilegible/solo lectura -> error.
- Comprobado: ver `_estado_hostkey.md` (tests TS, Rust y e2e contra sshd real en WSL).
