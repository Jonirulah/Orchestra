import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECIPES, SOUND_GAP_MS, SOUND_IDS, canPlay, cleanSoundId, playSound } from './sounds.ts';
import { DEFAULTS, SECTION_KEYS, clampSettings } from './settings.ts';
import { buildBackup, parseBackup, serializeBackup } from './backup.ts';

test('sound ids: stable list, none first, every real id has a recipe', () => {
  assert.deepEqual([...SOUND_IDS], ['none', 'chime', 'bell', 'pop', 'ping']);
  for (const id of SOUND_IDS) if (id !== 'none') assert.ok(RECIPES[id].length > 0, id);
  assert.deepEqual(Object.keys(RECIPES).sort(), SOUND_IDS.filter((i) => i !== 'none').sort());
});

test('every sound is short (<= 0.8 s) and starts/ends inside its window', () => {
  for (const [id, notes] of Object.entries(RECIPES)) {
    const end = Math.max(...notes.map((n) => n.at + n.dur));
    assert.ok(end <= 0.8, `${id} lasts ${end}s`);
    for (const n of notes) assert.ok(n.f > 20 && n.f < 20000 && n.gain > 0 && n.gain <= 1, id);
  }
});

test('the two default sounds are on and different from each other', () => {
  assert.equal(DEFAULTS.soundAttention, 'chime');
  assert.equal(DEFAULTS.soundDone, 'bell');
  assert.notEqual(DEFAULTS.soundAttention, DEFAULTS.soundDone);
  assert.equal(DEFAULTS.soundVolume, 60);
  for (const k of ['soundAttention', 'soundDone', 'soundVolume'] as const) assert.ok((SECTION_KEYS.agents as readonly string[]).includes(k), k);
});

test('cleanSoundId: unknown values fall back', () => {
  assert.equal(cleanSoundId('pop', 'chime'), 'pop');
  assert.equal(cleanSoundId('none', 'chime'), 'none');
  for (const v of ['airhorn', '', 'CHIME', 3, null, undefined, {}, ['bell']]) assert.equal(cleanSoundId(v, 'bell'), 'bell');
});

test('clampSettings sanitises the sound settings', () => {
  const s = clampSettings({ soundAttention: 'airhorn', soundDone: 42, soundVolume: 250 });
  assert.equal(s.soundAttention, DEFAULTS.soundAttention);
  assert.equal(s.soundDone, DEFAULTS.soundDone);
  assert.equal(s.soundVolume, 100);
  assert.equal(clampSettings({ soundVolume: -5 }).soundVolume, 0);
  assert.equal(clampSettings({ soundVolume: '50' }).soundVolume, DEFAULTS.soundVolume);
  assert.equal(clampSettings({ soundVolume: NaN }).soundVolume, DEFAULTS.soundVolume);
  assert.equal(clampSettings({ soundVolume: 33.7 }).soundVolume, 34);
  const ok = clampSettings({ soundAttention: 'ping', soundDone: 'none', soundVolume: 0 });
  assert.deepEqual([ok.soundAttention, ok.soundDone, ok.soundVolume], ['ping', 'none', 0]);
  // Ajustes viejos sin las claves nuevas: quedan los de serie.
  const old = clampSettings({ notifyDone: false });
  assert.deepEqual([old.soundAttention, old.soundDone, old.soundVolume], ['chime', 'bell', 60]);
});

test('anti-spam: at most one sound every SOUND_GAP_MS', () => {
  assert.equal(SOUND_GAP_MS, 1500);
  assert.equal(canPlay(1000, null), true);
  assert.equal(canPlay(1000, 1000), false);
  assert.equal(canPlay(2499, 1000), false);
  assert.equal(canPlay(2500, 1000), true);
  assert.equal(canPlay(500, 1000), true); // el reloj fue hacia atrás: no se queda mudo
  // Tres agentes que cambian en el mismo escaneo y otro 0,4 s después: suena uno.
  let last: number | null = null, played = 0;
  for (const now of [10_000, 10_000, 10_001, 10_400, 11_600]) if (canPlay(now, last)) { played++; last = now; }
  assert.equal(played, 2); // 10 000 y 11 600
});

test('playSound never throws without Web Audio (node) and reports it did not play', () => {
  assert.equal(playSound('chime', 0.6), false);
  assert.equal(playSound('none', 1, true), false);
  assert.equal(playSound('bogus' as never, 1, true), false);
  assert.equal(playSound('bell', NaN, true), false);
});

test('backup: sound settings survive export/import and bad ones are sanitised', () => {
  const settings = { ...DEFAULTS, soundAttention: 'pop' as const, soundDone: 'none' as const, soundVolume: 25 };
  const state = { settings, hosts: [], accounts: [], customThemes: [], workspaces: [], activeId: '', ignoredDirs: [] };
  const r = parseBackup(serializeBackup(buildBackup(state, { appVersion: '0.2.0' })));
  assert.ok(r.ok && r.sections.settings);
  assert.deepEqual([r.sections.settings.soundAttention, r.sections.settings.soundDone, r.sections.settings.soundVolume], ['pop', 'none', 25]);
  const bad = JSON.parse(serializeBackup(buildBackup(state, { appVersion: '0.2.0' })));
  bad.settings = { soundAttention: 'airhorn', soundVolume: 999 };
  const r2 = parseBackup(JSON.stringify(bad));
  assert.ok(r2.ok && r2.sections.settings);
  assert.deepEqual([r2.sections.settings.soundAttention, r2.sections.settings.soundDone, r2.sections.settings.soundVolume], ['chime', 'bell', 100]);
});
