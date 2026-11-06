import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exhausted, extraView, nextReset, pickAccount, pressure, usageViews } from './policy.ts';
import type { Quota, QuotaLimit } from './policy.ts';
import type { Account } from './model.ts';
import { setLocale } from './i18n.ts';

const NOW = 1_800_000_000;
const H = 3600;
const D = 86400;
const acc = (id: string): Account => ({ id, name: id, dir: `C:/${id}`, isDefault: false, color: '#fff' });
const scoped = (percent: number, over: Partial<QuotaLimit> = {}): QuotaLimit => ({ kind: 'weekly_scoped', percent, resetsAt: NOW + 3 * D, scope: 'Fable', active: true, ...over });

test('pressure takes the MAX over 5h, 7d and ACTIVE limits; inactive limits are ignored', () => {
  const q: Quota = { sevenDay: { used: 29, resetsAt: NOW + D }, limits: [scoped(40)] };
  assert.equal(pressure(q, NOW), 40);
  assert.equal(pressure({ ...q, limits: [scoped(40, { active: false })] }, NOW), 29);
  assert.equal(pressure({ ...q, fiveHour: { used: 55, resetsAt: NOW + H } }, NOW), 55);
  assert.equal(pressure({ limits: [scoped(70)] }, NOW), 70, 'a scoped limit alone is enough');
  assert.equal(pressure({ limits: [scoped(70, { active: false })] }, NOW), Infinity);
  // an already renewed limit counts as 0 %
  assert.equal(pressure({ sevenDay: { used: 10, resetsAt: NOW + D }, limits: [scoped(90, { resetsAt: NOW - 5 })] }, NOW), 10);
});

test('exhausted: a scoped limit at 99 % that has not reset exhausts the account', () => {
  assert.equal(exhausted({ sevenDay: { used: 10, resetsAt: NOW + D }, limits: [scoped(99)] }, NOW), true);
  assert.equal(exhausted({ sevenDay: { used: 10, resetsAt: NOW + D }, limits: [scoped(99, { active: false })] }, NOW), false);
  assert.equal(exhausted({ sevenDay: { used: 10, resetsAt: NOW + D }, limits: [scoped(99, { resetsAt: NOW - 1 })] }, NOW), false);
  assert.equal(exhausted({ sevenDay: { used: 10, resetsAt: NOW + D }, limits: [scoped(80)] }, NOW), false);
});

test('nextReset also considers the active limits', () => {
  const q: Quota = { sevenDay: { used: 10, resetsAt: NOW + 5 * D }, limits: [scoped(50, { resetsAt: NOW + 2 * D })] };
  assert.equal(nextReset(q, NOW), NOW + 2 * D);
  assert.equal(nextReset({ ...q, limits: [scoped(50, { resetsAt: NOW + 2 * D, active: false })] }, NOW), NOW + 5 * D);
  assert.equal(nextReset({ limits: [scoped(50, { resetsAt: NOW - 1 })] }, NOW), Infinity);
});

test('most-free: the account whose scoped limit is the bottleneck loses to one with a lower scoped %', () => {
  setLocale('en');
  const a = { acc: acc('a'), loggedIn: true, quota: { sevenDay: { used: 20, resetsAt: NOW + D }, limits: [scoped(90)] } as Quota };
  const b = { acc: acc('b'), loggedIn: true, quota: { sevenDay: { used: 35, resetsAt: NOW + D }, limits: [scoped(50)] } as Quota };
  // without the limits a would win (20 < 35); with them b wins (50 < 90)
  assert.equal(pickAccount('most-free', [a, b], undefined, NOW)?.acc.id, 'b');
  const plain = (c: typeof a) => ({ ...c, quota: { sevenDay: c.quota.sevenDay } });
  assert.equal(pickAccount('most-free', [plain(a), plain(b)], undefined, NOW)?.acc.id, 'a');
});

test('reset-soonest follows an active scoped limit that resets first', () => {
  const a = { acc: acc('a'), loggedIn: true, quota: { sevenDay: { used: 20, resetsAt: NOW + 6 * D } } as Quota };
  const b = { acc: acc('b'), loggedIn: true, quota: { sevenDay: { used: 20, resetsAt: NOW + 6 * D }, limits: [scoped(30, { resetsAt: NOW + D })] } as Quota };
  assert.equal(pickAccount('reset-soonest', [a, b], undefined, NOW)?.acc.id, 'b');
});

test('extraView: only an ACTIVE scoped limit above weekly-all, not renewed, with a model name', () => {
  const base = { sevenDay: { used: 29, resetsAt: NOW + D } };
  const v = extraView({ ...base, limits: [scoped(40)] }, NOW);
  assert.equal(v?.label, 'Fable');
  assert.equal(v?.view.pct, 40);
  assert.equal(extraView({ ...base, limits: [scoped(29)] }, NOW), null, 'equal is not higher');
  assert.equal(extraView({ ...base, limits: [scoped(20)] }, NOW), null);
  assert.equal(extraView({ ...base, limits: [scoped(60, { active: false })] }, NOW), null);
  assert.equal(extraView({ ...base, limits: [scoped(60, { scope: undefined })] }, NOW), null);
  assert.equal(extraView({ ...base, limits: [scoped(60, { resetsAt: NOW - 1 })] }, NOW), null);
  assert.equal(extraView(undefined, NOW), null);
  // the highest one wins
  assert.equal(extraView({ ...base, limits: [scoped(50, { scope: 'A' }), scoped(80, { scope: 'B' }), scoped(60, { scope: 'C' })] }, NOW)?.label, 'B');
  // without weekly-all any active scoped limit shows
  assert.equal(extraView({ limits: [scoped(5)] }, NOW)?.label, 'Fable');
});

test('usageViews: no empty 5h row when five_hour is absent; extra row appears; nothing at all stays null', () => {
  const v = usageViews({ sevenDay: { used: 29, resetsAt: NOW + D }, limits: [scoped(40)] }, NOW);
  assert.equal(v?.five, null);
  assert.equal(v?.seven?.pct, 29);
  assert.equal(v?.extra?.label, 'Fable');
  const w = usageViews({ sevenDay: { used: 29, resetsAt: NOW + D } }, NOW);
  assert.equal(w?.five, null);
  assert.equal(w?.extra, null);
  assert.equal(usageViews({ limits: [scoped(40)] }, NOW)?.extra?.label, 'Fable');
  assert.equal(usageViews({ limits: [scoped(40, { active: false })] }, NOW), null);
  assert.equal(usageViews({}, NOW), null);
  assert.equal(usageViews(undefined, NOW), null);
});
