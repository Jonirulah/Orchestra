# i18n SSH (HostDialog, SettingsKeys, ConfirmHostKey) - estado

Hecho (todo):
- Areas nuevas (en+es, registradas en locales/*/index.ts): hostDialog.ts (host.dialog.*, 51 claves), settingsKeys.ts (settings.keys.*, 37), hostkeyConfirm.ts (hostkey.confirm.*, 10).
  El archivo es hostkeyConfirm.ts (no confirmHostKey.ts) porque el check exige que el prefijo de clave sea el nombre de archivo (o camelCase partido por puntos): hostkeyConfirm -> hostkey.confirm.
- Componentes migrados: HostDialog.svelte, SettingsKeys.svelte, ConfirmHostKey.svelte. {@html} solo en 2 textos estaticos (tmux <b>, *.pub <code>). Errores del backend (`error`, `msg` de catch, p.message) siguen literales.
- store.svelte.ts: titulo del panel "Install key -> X" ahora t('store.pane.installKey') (en/es en locales store.ts).
- model.ts: model.hostKey.jump/alias ya estaban bien (es usa «Confiar en el primer uso»); HOSTKEY_*_MSG intactas (test en ingles).
- Sidebar: el check da 0 hallazgos (ya migrado).
- i18n-ignore (6, ejemplos tecnicos en placeholder): HostDialog L92 (root), L106 (ruta C:\Users\you\.ssh\id_ed25519), L148 (user@bastion), L151 (cd /srv/app && bash -l); SettingsKeys L132 (id_ed25519_work), L133 (you@laptop).
- Test: src/lib/i18n-ssh.test.ts (es != en salvo host.dialog.colorLabel, {vars} iguales, HTML permitido, jerga SSH, politicas coherentes).

Comprobado:
- svelte-check: 178 files 0 errors 0 warnings.
- node --test src/lib/*.test.ts: 136 pass, 0 fail.
- i18n-check de los 3 componentes: 0 hallazgos; global: (a)(b) OK, 466 claves en/es.
