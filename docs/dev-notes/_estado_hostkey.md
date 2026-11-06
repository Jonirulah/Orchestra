# Estado: política de huella SSH (hosts con secreto guardado)

## Criterio de hecho (medible)
1. svelte-check 0/0.  2. node --test src/lib/*.test.ts verde con tests nuevos.  3. cargo test verde + e2e ignorados con sshd temporal en WSL (a/b/c).  4. SECURITY.md + _estado_vault.md actualizados.

## Diseño
- Rust nuevo `src-tauri/src/hostkey.rs` (módulo propio; vault.rs solo expone `ssh_dir`/`friendly_type`). Comandos `hostkey_probe` (known? -> jump? -> keyscan + huellas) y `hostkey_trust` (append a known_hosts, nunca reescribe).
- TS: `model.ts` (HostKeyPolicy, effectiveHostKeyPolicy, hostKeyPreflight, sshArgs con política), `settings.ts` (sshHostKeyPolicy + sección `keys`), store (guardia en open()/restartPane()), `ConfirmHostKey.svelte` montado en App.svelte.
- Paneles restaurados al arrancar la app: van con `StrictHostKeyChecking=yes` (fallan cerrado si la clave no está en known_hosts; Restart pasa por el diálogo).

## Hecho
(nada aún)

## Pendiente
todo

## Archivos tocados
(ninguno aún)

## Avance (paso ~45)
- HECHO: hostkey.rs (13 tests Rust verdes), model.ts (HostKeyPolicy, hostKeyAction, sshArgs(h, policy)), settings.ts (sshHostKeyPolicy + sección `sshkeys`), backend.ts (hostKeyProbe/Trust + demo), store.svelte.ts (hostKeyGate en open()/restartPane(), acceptHostKey/cancelHostKey), ConfirmHostKey.svelte + App.svelte, SettingsKeys (bloque superior), HostDialog (select), SettingsDialog (`resettable` incluye 'sshkeys'), tests TS (model/settings) 43 verdes.
- svelte-check: sin errores en mis archivos; hay 42 errores de otros agentes (shortcuts.ts, themeimport.ts, SettingsDialog i18n en curso).
- PENDIENTE: e2e con sshd WSL (a/b/c), FAIL-antes de los tests nuevos (plantar), docs SECURITY + _estado_vault, re-ejecutar svelte-check al final.

## Avance (paso ~85): e2e HECHO
- sshd temporal en WSL (usuario orchtest, 127.0.0.1:2222, claves ed25519+ecdsa+rsa, juegos A y B), ya desmontado (usuario borrado, /tmp/orch_sshd borrado, sin sshd).
- HALLAZGO REAL: el ssh-keyscan de Windows OpenSSH 9.5p2 NO funciona contra sshd modernos ("choose_kex: unsupported KEX method sntrup761x25519-sha512@openssh.com"). Añadido reintento con el propio ssh (`scan_via_ssh`: known_hosts/config temporales, sin autenticar) cuando keyscan vio el banner pero 0 claves. Un known_hosts nuevo por familia (con una clave aprendida ssh rechaza las de otro tipo).
- e2e (cargo test e2e_a_|e2e_c1_|e2e_b_|e2e_c2_ -- --ignored): a OK (3 huellas = las del servidor; yes sin confiar -> "Host key verification failed", no escribe; tras trust -> LOGIN_OK), c1 OK (accept-new aprende), b OK (clave cambiada -> REMOTE HOST IDENTIFICATION HAS CHANGED, known_hosts intacto), c2 OK (accept-new también rechaza). ssh_e2e_login previo sigue OK.
- PENDIENTE: FAIL-antes (plantar), docs SECURITY/_estado_vault, cargo test completo, svelte-check final, limpiar <cache>.

## FINAL (paso ~110)
- svelte-check: 172 files, 0 errors, 0 warnings. node --test src/lib/*.test.ts: 128/128. cargo test: 111 ok + 5 ok (tests/askpass.rs), 11 ignored (e2e).
- FAIL-antes (plantado): model.ts con `strict = 'accept-new'` fijo -> 3 tests nuevos FAIL (pass 21 / fail 3); restaurado -> 43/43. hostkey.rs con `known_hosts_pattern` ignorando el puerto -> 3 tests FAIL (12 ok / 3 fail); restaurado. e2e (a): primer intento FAIL ("las huellas escaneadas no son las del servidor", solo 1 de 3 claves) -> PASS tras scan_via_ssh por familia.
- NO verificado: el diálogo en pantalla real (no se arrancó la app ni capturas, por brief); Restart/arranque de la app con panes restaurados (lógica en store.svelte.ts sin test automático); ssh-keyscan "bueno" (el de este Windows falla contra sshd 10.x; solo se probó la vía de reintento con ssh).
- Archivos: src-tauri/src/hostkey.rs (nuevo), vault.rs (ssh_dir/friendly_type pub(crate)), main.rs (mod + 2 comandos), src/lib/{model,settings,backend,store.svelte}.ts, model.test.ts, settings.test.ts, src/components/{ConfirmHostKey(nuevo),SettingsKeys,HostDialog,SettingsDialog(resettable),App}.svelte, docs/SECURITY.md, docs/dev-notes/_estado_vault.md.
