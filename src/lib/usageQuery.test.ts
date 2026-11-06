import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setLocale } from './i18n.ts';
import {
  QUERY_STATUSES, STALE_SEC, agoText, clampIntervalMin, isQueryStatus, queryTargets, staleTip, statusText, statusTone, toEntry,
} from './usageQuery.ts';
import type { QueryEntry } from './usageQuery.ts';

const NOW = 1_800_000_000;

test('clampIntervalMin: 2..30, integers, junk -> 5', () => {
  assert.equal(clampIntervalMin(5), 5);
  assert.equal(clampIntervalMin(0), 2);
  assert.equal(clampIntervalMin(1.4), 2);
  assert.equal(clampIntervalMin(31), 30);
  assert.equal(clampIntervalMin(99999), 30);
  assert.equal(clampIntervalMin(7.6), 8);
  for (const bad of [NaN, Infinity, '5', null, undefined, {}]) assert.equal(clampIntervalMin(bad), 5, String(bad));
});

test('isQueryStatus accepts exactly the six backend statuses', () => {
  assert.deepEqual([...QUERY_STATUSES], ['ok', 'expired', 'nocreds', 'unauthorized', 'rate_limited', 'error']);
  for (const s of QUERY_STATUSES) assert.ok(isQueryStatus(s));
  for (const bad of ['OK', 'rate-limited', '', 'fail', 3, null, undefined]) assert.ok(!isQueryStatus(bad), String(bad));
});

test('toEntry: unknown status becomes error, bad times fall back to now, extra fields are dropped', () => {
  assert.deepEqual(toEntry({ status: 'ok', fetchedAt: NOW - 30 }, NOW), { status: 'ok', at: NOW - 30, message: undefined });
  assert.equal(toEntry({ status: 'weird' as never, fetchedAt: NOW }, NOW).status, 'error');
  assert.equal(toEntry(null, NOW).status, 'error');
  assert.equal(toEntry(undefined, NOW).at, NOW);
  assert.equal(toEntry({ status: 'ok', fetchedAt: NaN }, NOW).at, NOW);
  assert.equal(toEntry({ status: 'ok', fetchedAt: -5 }, NOW).at, NOW);
  assert.equal(toEntry({ status: 'error', fetchedAt: NOW, message: 'x'.repeat(500) }, NOW).message?.length, 200);
  const e = toEntry({ status: 'ok', fetchedAt: NOW, accessToken: 'sk-ant-secret' } as never, NOW);
  assert.deepEqual(Object.keys(e).sort(), ['at', 'message', 'status']);
  assert.ok(!JSON.stringify(e).includes('sk-ant'));
});

test('agoText boundaries (en)', () => {
  setLocale('en');
  assert.equal(agoText(0), 'just now');
  assert.equal(agoText(-20), 'just now');
  assert.equal(agoText(NaN), 'just now');
  assert.equal(agoText(59), 'just now');
  assert.equal(agoText(60), '1 min ago');
  assert.equal(agoText(125), '2 min ago');
  assert.equal(agoText(3599), '59 min ago');
  assert.equal(agoText(3600), '1 h ago');
  assert.equal(agoText(86399), '23 h ago');
  assert.equal(agoText(86400 * 3 + 5), '3 d ago');
});

test('statusText: one message per status, no placeholder left, both languages', () => {
  for (const loc of ['en', 'es'] as const) {
    setLocale(loc);
    const seen = new Set<string>();
    for (const status of QUERY_STATUSES) {
      const txt = statusText({ status, at: NOW - 120 }, NOW, true);
      assert.ok(txt && !txt.includes('{') && !txt.startsWith('settings.usage'), `${loc} ${status}: ${txt}`);
      seen.add(txt);
    }
    assert.equal(seen.size, QUERY_STATUSES.length, `${loc}: every status reads differently`);
    assert.ok(!statusText(undefined, NOW, true).startsWith('settings.usage'));
    assert.equal(statusText({ status: 'ok', at: NOW }, NOW, false), statusText(undefined, NOW, false), `${loc}: not signed in wins`);
  }
  setLocale('en');
  assert.equal(statusText({ status: 'ok', at: NOW - 120 }, NOW, true), 'Updated 2 min ago');
  assert.equal(statusText({ status: 'nocreds', at: NOW }, NOW, true), 'Not signed in');
  assert.equal(statusText({ status: 'rate_limited', at: NOW }, NOW, true), 'Rate limited, retrying later');
  assert.equal(statusText({ status: 'unauthorized', at: NOW }, NOW, true), 'Anthropic rejected the token');
  assert.match(statusText({ status: 'expired', at: NOW }, NOW, true), /expired.*last data.*Open Claude/i);
  setLocale('es');
  assert.equal(statusText({ status: 'ok', at: NOW - 120 }, NOW, true), 'Actualizado hace 2 min');
  setLocale('en');
});

test('statusTone', () => {
  assert.equal(statusTone(undefined), 'muted');
  const tone = (status: QueryEntry['status']) => statusTone({ status, at: NOW });
  assert.deepEqual(QUERY_STATUSES.map(tone), ['ok', 'warn', 'muted', 'bad', 'warn', 'bad']);
});

test('staleTip: only when the token expired AND the data is older than 15 min', () => {
  setLocale('en');
  const exp: QueryEntry = { status: 'expired', at: NOW };
  assert.equal(staleTip(NOW - STALE_SEC + 1, exp, NOW), '');
  assert.equal(staleTip(NOW - STALE_SEC, exp, NOW), 'last data 15 min ago');
  assert.equal(staleTip(NOW - 40 * 60, exp, NOW), 'last data 40 min ago');
  assert.equal(staleTip(NOW - 3 * 3600, exp, NOW), 'last data 3 h ago');
  for (const status of QUERY_STATUSES.filter((s) => s !== 'expired')) {
    assert.equal(staleTip(NOW - 3600, { status, at: NOW }, NOW), '', status);
  }
  assert.equal(staleTip(NOW - 3600, undefined, NOW), '');
  assert.equal(staleTip(undefined, exp, NOW), '');
  assert.equal(staleTip(NaN, exp, NOW), '');
  setLocale('es');
  assert.equal(staleTip(NOW - 40 * 60, exp, NOW), 'últimos datos hace 40 min');
  setLocale('en');
});

test('queryTargets: only signed-in accounts, only id and dir travel', () => {
  const accts = [
    { id: 'a', dir: 'C:/u/.claude', name: 'Main', color: '#fff', secret: 'x' },
    { id: 'b', dir: 'C:/u/.claude-b' },
    { id: 'c', dir: '' },
    { id: '', dir: 'C:/u/.claude-c' },
  ];
  assert.deepEqual(queryTargets(accts, (a) => a.id !== 'b'), [{ id: 'a', dir: 'C:/u/.claude' }]);
  assert.deepEqual(queryTargets(accts, () => true), [{ id: 'a', dir: 'C:/u/.claude' }, { id: 'b', dir: 'C:/u/.claude-b' }]);
  assert.deepEqual(queryTargets(accts, () => false), []);
});

// El token solo lo toca el backend de Rust: ningún fichero del frontend (ni sus pruebas) conoce los campos de las credenciales.
test('the frontend never mentions the credentials file or its fields', () => {
  const root = join(import.meta.dirname, '..');
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|svelte)$/.test(name) || name === 'usageQuery.test.ts') continue;
      const text = readFileSync(p, 'utf8');
      if (/accessToken|refreshToken|claudeAiOauth|\.credentials\.json/.test(text)) hits.push(p);
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});
