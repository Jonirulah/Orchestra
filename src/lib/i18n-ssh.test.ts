// Textos del área SSH: host.dialog.*, settings.keys.*, hostkey.confirm.* (+ store.pane.installKey y model.hostKey.*).
// Español distinto del inglés (salvo lo listado) y mismas {variables} en los dos idiomas.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t } from './i18n.ts';
import { en } from './locales/en/index.ts';
import { es } from './locales/es/index.ts';
import { hostKeyBlockedMsg } from './model.ts';

afterEach(() => setLocale('en'));

const MINE = /^(host\.dialog|settings\.keys|hostkey\.confirm|store\.pane\.installKey|model\.hostKey)/;
// Iguales en los dos idiomas a propósito.
const SAME = new Set([
  'host.dialog.colorLabel',        // «Color» se escribe igual
]);
const vars = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
const keys = (Object.keys(en) as (keyof typeof en)[]).filter((k) => MINE.test(k));

test('SSH keys: there are many and the three areas are present', () => {
  assert.ok(keys.length >= 90, `only ${keys.length} keys`);
  for (const p of ['host.dialog.', 'settings.keys.', 'hostkey.confirm.']) assert.ok(keys.some((k) => k.startsWith(p)), p);
});

test('SSH keys: Spanish differs from English (except the listed ones)', () => {
  const same = keys.filter((k) => en[k] === es[k]);
  assert.deepEqual(same.filter((k) => !SAME.has(k)), []);
  for (const k of SAME) assert.equal(en[k as keyof typeof en], es[k as keyof typeof en], `${k} is no longer identical: drop it from SAME`);
});

test('SSH keys: the {vars} match between English and Spanish', () => {
  for (const k of keys) assert.deepEqual(vars(es[k]), vars(en[k]), k);
  assert.deepEqual(vars(en['settings.keys.createdMsg']), ['name', 'type']);
  assert.deepEqual(vars(en['host.dialog.usePickedPassphrase']), ['name']);
  assert.deepEqual(vars(en['store.pane.installKey']), ['name']);
});

test('SSH keys: static HTML keys keep only the allowed tags in both languages', () => {
  const html = ['host.dialog.tmuxLabel', 'settings.keys.empty'] as const;
  for (const k of html) for (const d of [en, es]) {
    const tags = [...d[k].matchAll(/<\/?(\w+)/g)].map((m) => m[1]);
    assert.ok(tags.length >= 2 && tags.every((x) => x === (k === 'settings.keys.empty' ? 'code' : 'b')), `${k}: ${tags}`);
  }
  // Los demás textos no llevan marcas HTML (se pintan como texto).
  for (const k of keys) if (!(html as readonly string[]).includes(k)) assert.doesNotMatch(en[k] + es[k], /<[a-z/]/i, k);
});

test('SSH jargon is never translated', () => {
  for (const k of keys) for (const w of ['ed25519', 'ProxyJump', 'authorized_keys', 'known_hosts', 'tmux']) {
    if (en[k].includes(w)) assert.ok(es[k].includes(w), `${k} lost "${w}"`);
  }
  for (const k of keys) if (en[k].includes('~/.ssh')) assert.ok(es[k].includes('~/.ssh'), k);
});

test('policy names are consistent with the rest of the app (es-ES)', () => {
  setLocale('es');
  assert.equal(t('host.dialog.hostKeyConfirm'), 'Confirmar hosts nuevos');
  assert.equal(t('host.dialog.hostKeyAccept'), 'Confiar en el primer uso');
  assert.equal(t('settings.keys.policyAcceptTitle'), 'Confiar en el primer uso');
  assert.match(hostKeyBlockedMsg('jump'), /«Confiar en el primer uso»/);
  assert.match(hostKeyBlockedMsg('alias'), /«Confiar en el primer uso»/);
});

test('interpolation follows the language', () => {
  assert.equal(t('settings.keys.createdMsg', { name: 'id_x', type: 'ED25519' }), 'Created id_x (ED25519). Install the public key on your servers; the private key never leaves this PC.');
  assert.equal(t('host.dialog.usePickedPassphrase', { name: 'k' }), 'Use the passphrase saved for «k»');
  setLocale('es');
  assert.equal(t('host.dialog.usePickedPassphrase', { name: 'k' }), 'Usar la frase de contraseña guardada para «k»');
  assert.equal(t('store.pane.installKey', { name: 'srv' }), 'Instalar clave → srv');
  assert.equal(t('settings.keys.copyFailedMsg', { error: 'x' }), 'No se pudo copiar: x');
});

test('every dialog/section title picks the language (English default, Spanish after setLocale)', () => {
  assert.equal(t('host.dialog.titleNew'), 'New SSH host');
  assert.equal(t('hostkey.confirm.titleConfirm'), 'Trust this server?');
  assert.equal(t('settings.keys.generateLabel'), 'Generate a new key');
  setLocale('es');
  assert.equal(t('host.dialog.titleNew'), 'Nuevo host SSH');
  assert.equal(t('hostkey.confirm.titleConfirm'), '¿Confiar en este servidor?');
  assert.equal(t('settings.keys.generateLabel'), 'Generar una clave nueva');
});
