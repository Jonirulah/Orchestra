// Textos de store.*, policy.*, model.* y dialogs.account.*: español distinto del inglés y comportamiento por idioma.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from './i18n.ts';
import { en } from './locales/en/index.ts';
import { es } from './locales/es/index.ts';
import { POLICIES, policyLabel, policyHint, pickAccount, fmtDuration, fmtWhen, windowView } from './policy.ts';
import type { Candidate } from './policy.ts';
import { PRESETS, displayName, hostKeyBlockedMsg, HOSTKEY_JUMP_MSG, HOSTKEY_ALIAS_MSG } from './model.ts';
import { parseImport, DEFAULTS } from './settings.ts';

afterEach(() => setLocale('en'));

const MINE = /^(store|policy|model|dialogs\.account)\./;
// Iguales en los dos idiomas a propósito (nombres propios, símbolos o palabra idéntica).
const SAME = new Set([
  'policy.manualLabel',          // «Manual» se escribe igual
  'store.toast.accountPicked',   // «Claude · {name} — {reason}»: solo nombres y datos
]);

test('store/policy/model/dialogs.account: Spanish differs from English (except the listed ones)', () => {
  const keys = (Object.keys(en) as (keyof typeof en)[]).filter((k) => MINE.test(k));
  assert.ok(keys.length >= 60, `only ${keys.length} keys`);
  const same = keys.filter((k) => en[k] === es[k]);
  assert.deepEqual(same.filter((k) => !SAME.has(k)), []);
  for (const k of SAME) assert.equal(en[k as keyof typeof en], es[k as keyof typeof en], `${k} is no longer identical: drop it from SAME`);
});

test('policy labels and hints: English by default, Spanish after setLocale, POLICIES keeps its shape', () => {
  assert.deepEqual(POLICIES.map((p) => p.id), ['manual', 'round-robin', 'reset-soonest', 'most-free']);
  assert.equal(POLICIES[1].label, 'Round-robin');
  assert.equal(policyHint('most-free'), 'The one that has used the least quota');
  setLocale('es');
  assert.equal(POLICIES[1].label, 'Por turnos');       // getters: se resuelve al leer
  assert.equal(policyLabel('reset-soonest'), 'Reinicio más próximo');
  assert.equal(policyHint('manual'), 'Eliges la cuenta en cada terminal');
});

test('pickAccount reasons follow the language', () => {
  const NOW = 1_000_000;
  const acc = (id: string) => ({ id, name: id, dir: `C:\${id}`, isDefault: false, color: '#fff' });
  const cs: Candidate[] = [
    { acc: acc('a'), loggedIn: true, quota: { fiveHour: { used: 90, resetsAt: NOW + 3600 } } },
    { acc: acc('b'), loggedIn: true, quota: { fiveHour: { used: 50, resetsAt: NOW + 7200 } } },
  ];
  assert.equal(pickAccount('most-free', cs, undefined, NOW)!.reason, 'most free (50 % used)');
  assert.equal(pickAccount('reset-soonest', cs, undefined, NOW)!.reason, 'resets soonest (in 1h 0m)');
  assert.equal(pickAccount('round-robin', cs, undefined, NOW)!.reason, 'round-robin');
  setLocale('es');
  assert.equal(pickAccount('most-free', cs, undefined, NOW)!.reason, 'la más libre (50 % usado)');
  assert.equal(pickAccount('reset-soonest', cs, undefined, NOW)!.reason, 'se reinicia antes (en 1h 0m)');
  assert.equal(pickAccount('round-robin', cs, undefined, NOW)!.reason, 'por turnos');
  assert.equal(pickAccount('reset-soonest', [{ acc: acc('a'), loggedIn: true }], undefined, NOW)!.reason, 'por turnos (aún sin datos de cuota)');
  const dead: Candidate[] = cs.map((c) => ({ ...c, quota: { fiveHour: { used: 100, resetsAt: NOW + 600 } } }));
  assert.match(pickAccount('most-free', dead, undefined, NOW)!.reason, /^todas agotadas; «[ab]» es la primera en liberarse \(en 10m\)$/);
});

test('policy: durations, weekdays and window tooltips are localized', () => {
  const NOW = 1_000_000;
  const d = new Date(2026, 0, 1, 14, 5); // jueves
  assert.equal(fmtWhen(d.getTime() / 1000), 'Thu 14:05');
  assert.equal(fmtDuration(0), 'now');
  assert.equal(windowView({ used: 3, resetsAt: NOW - 1 }, NOW)!.left, 'reset');
  setLocale('es');
  assert.equal(fmtWhen(d.getTime() / 1000), 'jue 14:05');
  assert.equal(fmtDuration(0), 'ahora');
  const v = windowView({ used: 3, resetsAt: NOW - 1 }, NOW)!;
  assert.equal(v.left, 'reinicio');
  assert.equal(v.tip, '0 % usado · la ventana se ha reiniciado');
  assert.equal(windowView({ used: 62.4, resetsAt: NOW + 3600 }, NOW)!.tip.startsWith('62 % usado · se reinicia '), true);
});

test('model: presets, default names and host-key messages', () => {
  const p = (id: string) => PRESETS.find((x) => x.id === id)!;
  assert.equal(p('2x1').label, '2 × 1 (two columns)');
  assert.equal(p('1x2').label, '1 × 2 (two rows)');
  assert.equal(displayName('Main'), 'Main');
  assert.equal(displayName('Workspace 3'), 'Workspace 3');
  assert.equal(displayName('Mi proyecto'), 'Mi proyecto');
  assert.equal(hostKeyBlockedMsg('jump'), HOSTKEY_JUMP_MSG);   // el inglés del diccionario = constante de referencia
  assert.equal(hostKeyBlockedMsg('alias'), HOSTKEY_ALIAS_MSG);
  setLocale('es');
  assert.equal(p('2x1').label, '2 × 1 (dos columnas)');
  assert.equal(p('3x3').label, '3 × 3');
  assert.equal(displayName('Main'), 'Principal');
  assert.equal(displayName('Workspace 3'), 'Espacio de trabajo 3');
  assert.equal(displayName('Workspace tres'), 'Workspace tres');
  assert.equal(displayName('Mi proyecto'), 'Mi proyecto');
  assert.match(hostKeyBlockedMsg('jump'), /^A este host se llega/);
});

test('settings import errors follow the language', () => {
  assert.match((parseImport('{', DEFAULTS) as { error: string }).error, /^Invalid JSON: /);
  assert.equal((parseImport('[]', DEFAULTS) as { error: string }).error, 'Expected a JSON object with settings, like {"fontSize": 14}');
  setLocale('es');
  assert.match((parseImport('{', DEFAULTS) as { error: string }).error, /^JSON no válido: /);
  assert.equal((parseImport('{"zzz":1}', DEFAULTS) as { error: string }).error, 'No se ha encontrado ningún ajuste conocido en ese JSON');
  assert.equal((parseImport('[]', DEFAULTS) as { error: string }).error, 'Se esperaba un objeto JSON con ajustes, como {"fontSize": 14}');
});
