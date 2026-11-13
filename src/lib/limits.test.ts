import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exhausted, extraViews, MAX_EXTRA_ROWS, nextReset, pickAccount, pressure, usageViews } from './policy.ts';
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

test('extraViews: every scoped limit not renewed shows, active or not, above or below weekly-all', () => {
  const base = { sevenDay: { used: 29, resetsAt: NOW + D } };
  const v = extraViews({ ...base, limits: [scoped(40)] }, NOW);
  assert.equal(v.length, 1);
  assert.equal(v[0].label, 'Fable');
  assert.equal(v[0].view.pct, 40);
  assert.equal(extraViews({ ...base, limits: [scoped(29)] }, NOW)[0]?.view.pct, 29, 'equal to weekly-all still shows');
  assert.equal(extraViews({ ...base, limits: [scoped(20)] }, NOW)[0]?.view.pct, 20, 'below weekly-all still shows');
  assert.equal(extraViews({ ...base, limits: [scoped(60, { active: false })] }, NOW)[0]?.view.pct, 60, 'is_active=false still shows');
  assert.deepEqual(extraViews({ ...base, limits: [scoped(60, { scope: undefined })] }, NOW), [], 'no model name, no row');
  assert.deepEqual(extraViews({ ...base, limits: [scoped(60, { resetsAt: NOW - 1 })] }, NOW), [], 'renewed, no row');
  assert.deepEqual(extraViews(undefined, NOW), []);
  // the most used first, one row per model, capped
  const many = extraViews({ ...base, limits: [scoped(50, { scope: 'A' }), scoped(80, { scope: 'B' }), scoped(60, { scope: 'C' }), scoped(90, { scope: 'B' })] }, NOW);
  assert.equal(many.length, MAX_EXTRA_ROWS);
  assert.deepEqual(many.map((x) => [x.label, x.view.pct]), [['B', 90], ['C', 60]]);
});

test('extraViews: the real answers that hid Fable before now show it', () => {
  // weekly-all at 100 % binds, so Anthropic marks Fable (also 100 %) as not active
  const weeklyFull: Quota = { sevenDay: { used: 100, resetsAt: NOW + 4 * D }, limits: [scoped(100, { active: false, resetsAt: NOW + 4 * D })] };
  assert.equal(extraViews(weeklyFull, NOW)[0]?.view.pct, 100);
  // Fable below weekly-all
  const belowWeekly: Quota = { sevenDay: { used: 100, resetsAt: NOW + 2 * D }, limits: [scoped(70, { active: false, resetsAt: NOW + 2 * D })] };
  assert.equal(extraViews(belowWeekly, NOW)[0]?.view.pct, 70);
});

test('usageViews: no empty 5h row when five_hour is absent; extra rows appear; nothing at all stays null', () => {
  const v = usageViews({ sevenDay: { used: 29, resetsAt: NOW + D }, limits: [scoped(40)] }, NOW);
  assert.equal(v?.five, null);
  assert.equal(v?.seven?.pct, 29);
  assert.equal(v?.extras[0]?.label, 'Fable');
  const w = usageViews({ sevenDay: { used: 29, resetsAt: NOW + D } }, NOW);
  assert.equal(w?.five, null);
  assert.deepEqual(w?.extras, []);
  assert.equal(usageViews({ limits: [scoped(40)] }, NOW)?.extras[0]?.label, 'Fable');
  assert.equal(usageViews({ limits: [scoped(40, { active: false })] }, NOW)?.extras[0]?.label, 'Fable');
  assert.equal(usageViews({ limits: [scoped(40, { resetsAt: NOW - 1 })] }, NOW), null);
  assert.equal(usageViews({}, NOW), null);
  assert.equal(usageViews(undefined, NOW), null);
});
