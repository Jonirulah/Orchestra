import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_INTERVAL_MS, busyReport, noteSpans, parseNotes, classifyError, compareVersions, errorDetail, isNewer, notesPreview, progressPct, releasePage, shouldCheck,
} from './updatecheck.ts';
import { DEFAULTS, SECTION_KEYS, clampSettings } from './settings.ts';

test('shouldCheck: apagado nunca, la primera vez sí, luego cada 6 h', () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldCheck(false, 0, now), false);
  assert.equal(shouldCheck(true, 0, now), true);
  assert.equal(shouldCheck(true, now - CHECK_INTERVAL_MS + 1000, now), false);
  assert.equal(shouldCheck(true, now - CHECK_INTERVAL_MS, now), true);
  assert.equal(shouldCheck(true, now - 3 * CHECK_INTERVAL_MS, now), true); // equipo que estuvo dormido
  assert.equal(shouldCheck(true, now + 60_000, now), true); // reloj hacia atrás: no se queda bloqueado
});

test('compareVersions: semver con v, prerelease y basura', () => {
  assert.ok(compareVersions('0.3.1', '0.3.0') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0); // numérico, no alfabético
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('v0.3.0', '0.3.0'), 0);
  assert.ok(compareVersions('0.4.0-beta.1', '0.4.0') < 0);
  assert.ok(compareVersions('0.4.0', '0.4.0-rc.1') > 0);
  assert.ok(compareVersions('0.4.0-beta.2', '0.4.0-beta.10') < 0);
  assert.ok(compareVersions('0.4.0-alpha', '0.4.0-beta') < 0);
  assert.equal(compareVersions('0.3.0+build5', '0.3.0'), 0);
  assert.equal(compareVersions('nada', '0.3.0'), 0);
  assert.equal(isNewer('0.3.1', '0.3.0'), true);
  assert.equal(isNewer('0.3.0', '0.3.0'), false);
  assert.equal(isNewer('0.2.9', '0.3.0'), false);
});

test('releasePage y errores clasificados', () => {
  assert.equal(releasePage('0.3.1'), 'https://github.com/Jonirulah/Orchestra/releases/tag/v0.3.1');
  assert.equal(releasePage('v0.3.1'), 'https://github.com/Jonirulah/Orchestra/releases/tag/v0.3.1');
  assert.equal(classifyError('signature:The signature verification failed'), 'signature');
  assert.equal(classifyError('network:error sending request'), 'network');
  assert.equal(classifyError('portable'), 'portable');
  assert.equal(classifyError('algo raro'), 'other');
  assert.equal(errorDetail('signature: mal'), 'mal');
});

test('busyReport: solo cuentan los agentes trabajando y los SSH vivos', () => {
  assert.deepEqual(busyReport({ agentStatuses: ['idle', 'shell', 'new'], sshOpen: 0 }), { agents: 0, ssh: 0, any: false });
  assert.deepEqual(busyReport({ agentStatuses: ['busy', 'waiting', 'idle', 'running'], sshOpen: 2 }), { agents: 3, ssh: 2, any: true });
  assert.equal(busyReport({ agentStatuses: [], sshOpen: 1 }).any, true);
});

test('progressPct y notesPreview', () => {
  assert.equal(progressPct(50, 200), 25);
  assert.equal(progressPct(300, 200), 100);
  assert.equal(progressPct(10, null), null);
  assert.equal(progressPct(10, 0), null);
  assert.equal(notesPreview('  hola\r\n'), 'hola');
  const long = 'x'.repeat(400);
  assert.equal(notesPreview(long, 100).length, 100);
  assert.ok(notesPreview(long, 100).endsWith('…'));
});

test('ajuste autoUpdate: encendido por defecto, validado y en la sección General', () => {
  assert.equal(DEFAULTS.autoUpdate, true);
  assert.equal(clampSettings({}).autoUpdate, true);
  assert.equal(clampSettings({ autoUpdate: false }).autoUpdate, false);
  assert.equal(clampSettings({ autoUpdate: 'no' }).autoUpdate, true);
  assert.ok((SECTION_KEYS.general as readonly string[]).includes('autoUpdate'));
});

test('parseNotes: títulos, viñetas con continuación, negrita y código sin HTML', () => {
  const md = '### Added\n- **Automatic updates** from the\n  GitHub releases.\n- Uses `latest.json`.\n\nPlain <b>text</b>.';
  assert.deepEqual(parseNotes(md), [
    { kind: 'h', spans: [{ text: 'Added' }] },
    { kind: 'li', spans: [{ text: 'Automatic updates', bold: true }, { text: ' from the GitHub releases.' }] },
    { kind: 'li', spans: [{ text: 'Uses ' }, { text: 'latest.json', code: true }, { text: '.' }] },
    { kind: 'p', spans: [{ text: 'Plain <b>text</b>.' }] },
  ]);
  assert.deepEqual(parseNotes(''), []);
  assert.deepEqual(noteSpans('a ** b'), [{ text: 'a ** b' }]);
});
