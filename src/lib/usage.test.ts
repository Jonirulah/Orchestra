import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDuration, usageLevel, windowView, usageViews, fmtWhen, pressure, pickAccount } from './policy.ts';
import type { Quota } from './policy.ts';
import { claudeSpec } from './model.ts';
import type { Account } from './model.ts';

const NOW = 1_800_000_000;
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

test('fmtDuration: boundaries', () => {
  assert.equal(fmtDuration(0), 'now');
  assert.equal(fmtDuration(-30), 'now');
  assert.equal(fmtDuration(NaN), 'now');
  assert.equal(fmtDuration(1), '1m'); // never "0m" while there is time left
  assert.equal(fmtDuration(38 * MIN), '38m');
  assert.equal(fmtDuration(59 * MIN), '59m');
  assert.equal(fmtDuration(59 * MIN + 1), '1h 0m'); // rounds up to the full hour
  assert.equal(fmtDuration(HOUR), '1h 0m');
  assert.equal(fmtDuration(2 * HOUR + 10 * MIN), '2h 10m');
  assert.equal(fmtDuration(23 * HOUR + 59 * MIN), '23h 59m');
  assert.equal(fmtDuration(DAY), '1d 0h');
  assert.equal(fmtDuration(4 * DAY + 3 * HOUR), '4d 3h');
  assert.equal(fmtDuration(4 * DAY + 3 * HOUR + 59 * MIN), '4d 3h');
});

test('usageLevel: green < 60, amber 60-85, red > 85', () => {
  assert.equal(usageLevel(0), 'ok');
  assert.equal(usageLevel(59.9), 'ok');
  assert.equal(usageLevel(60), 'warn');
  assert.equal(usageLevel(85), 'warn');
  assert.equal(usageLevel(85.1), 'bad');
  assert.equal(usageLevel(100), 'bad');
});

test('windowView: normal, expired and missing windows', () => {
  const v = windowView({ used: 62.4, resetsAt: NOW + 2 * HOUR + 10 * MIN }, NOW)!;
  assert.equal(v.pct, 62.4);
  assert.equal(v.level, 'warn');
  assert.equal(v.left, '2h 10m');
  assert.match(v.tip, /^62 % used · resets (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/);
  // a window whose reset time has passed counts as 0 % used
  const e = windowView({ used: 97, resetsAt: NOW - 5 }, NOW)!;
  assert.equal(e.pct, 0);
  assert.equal(e.level, 'ok');
  assert.equal(e.left, 'reset');
  assert.equal(e.expired, true);
  assert.match(e.tip, /^0 % used/);
  // out-of-range input is clamped
  assert.equal(windowView({ used: 400, resetsAt: NOW + 60 }, NOW)!.pct, 100);
  assert.equal(windowView(undefined, NOW), null);
});

test('usageViews: null when there is no window at all', () => {
  assert.equal(usageViews(undefined, NOW), null);
  assert.equal(usageViews({}, NOW), null);
  assert.equal(usageViews({ at: NOW }, NOW), null);
  const only7 = usageViews({ sevenDay: { used: 5, resetsAt: NOW + DAY } }, NOW)!;
  assert.equal(only7.five, null);
  assert.equal(only7.seven!.left, '1d 0h');
});

test('fmtWhen is "Ddd HH:MM" in local time', () => {
  const d = new Date(2026, 10, 5, 14, 5); // Thu 5 Nov 2026, local
  assert.equal(fmtWhen(d.getTime() / 1000), 'Thu 14:05');
});

test('pressure with now ignores windows that already reset', () => {
  const q: Quota = { fiveHour: { used: 95, resetsAt: NOW - 1 }, sevenDay: { used: 30, resetsAt: NOW + DAY } };
  assert.equal(pressure(q), 95); // old behaviour without now
  assert.equal(pressure(q, NOW), 30);
});

test('most-free prefers the account whose busy window already reset', () => {
  const acc = (id: string): Account => ({ id, name: id, dir: `C:/${id}`, isDefault: false, color: '#fff' });
  const stale: Quota = { fiveHour: { used: 95, resetsAt: NOW - 10 }, sevenDay: { used: 20, resetsAt: NOW + DAY } };
  const busy: Quota = { fiveHour: { used: 50, resetsAt: NOW + HOUR }, sevenDay: { used: 20, resetsAt: NOW + DAY } };
  const p = pickAccount('most-free', [
    { acc: acc('a'), loggedIn: true, quota: busy },
    { acc: acc('b'), loggedIn: true, quota: stale },
  ], undefined, NOW)!;
  assert.equal(p.acc.id, 'b');
});

test('claudeSpec: --settings only when a path is given', () => {
  const acc: Account = { id: 'acc-1', name: 'Main', dir: 'C:/Users/x/.claude', isDefault: true, color: '#fff' };
  const plain = claudeSpec(acc);
  assert.deepEqual(plain.args, ['-NoLogo', '-NoExit', '-Command', '& claude']);
  const withS = claudeSpec(acc, { settingsPath: 'C:\\Users\\x\\AppData\\Roaming\\dev.orchestra.app\\bin\\orchestra-settings.json', resume: true });
  assert.equal(withS.args[3], "& claude --continue --settings 'C:\\Users\\x\\AppData\\Roaming\\dev.orchestra.app\\bin\\orchestra-settings.json'");
  // a single quote in the path must be doubled for PowerShell
  const quoted = claudeSpec(acc, { settingsPath: "C:\\Users\\O'Brien\\s.json" });
  assert.equal(quoted.args[3], "& claude --settings 'C:\\Users\\O''Brien\\s.json'");
  assert.equal(withS.env?.ORCHESTRA_ACCOUNT, 'acc-1');
});

test('settings: captureUsage and notifyQuota default to on, clamp to booleans, reset with the agents section', async () => {
  const { DEFAULTS, clampSettings, resetSection, SECTION_KEYS } = await import('./settings.ts');
  assert.equal(DEFAULTS.captureUsage, true);
  assert.equal(DEFAULTS.notifyQuota, true);
  assert.equal(clampSettings({}).captureUsage, true);
  assert.equal(clampSettings({ captureUsage: false }).captureUsage, false);
  assert.equal(clampSettings({ captureUsage: 'no' }).captureUsage, true); // not a boolean: default
  assert.equal(clampSettings({ notifyQuota: 0 }).notifyQuota, true);
  assert.equal(clampSettings({ notifyQuota: false }).notifyQuota, false);
  const cur = clampSettings({ ...DEFAULTS, captureUsage: false, notifyQuota: false });
  const r = resetSection(cur, 'agents');
  assert.equal(r.captureUsage, true);
  assert.equal(r.notifyQuota, true);
  assert.ok((SECTION_KEYS.agents as readonly string[]).includes('captureUsage'));
});

test('nextAlert: silent baseline, then once per threshold and window', async () => {
  const { nextAlert } = await import('./policy.ts');
  const R = NOW + 3 * HOUR;
  const w = (used: number, resetsAt = R) => ({ used, resetsAt });
  // first sight is only recorded (no toast when the app starts with a busy account)
  let r = nextAlert(undefined, w(90), NOW);
  assert.equal(r.fire, null);
  assert.equal(r.state.level, 80);
  // 95 % crossed later: fires once
  r = nextAlert(r.state, w(96), NOW + 60);
  assert.equal(r.fire, 95);
  r = nextAlert(r.state, w(97), NOW + 120);
  assert.equal(r.fire, null);
  // 80 % crossed from a calm start
  let s = nextAlert(undefined, w(10), NOW);
  s = nextAlert(s.state, w(79.9), NOW + 10);
  assert.equal(s.fire, null);
  s = nextAlert(s.state, w(80), NOW + 20);
  assert.equal(s.fire, 80);
  s = nextAlert(s.state, w(96), NOW + 30);
  assert.equal(s.fire, 95);
  // resetsAt jitter of a few seconds is the same window: no repeat
  s = nextAlert(s.state, w(96, R + 4), NOW + 40);
  assert.equal(s.fire, null);
  // new window (+5 h) starts calm: rearmed, and fires again on the next crossing
  s = nextAlert(s.state, w(3, R + 5 * HOUR), R + 1);
  assert.equal(s.fire, null);
  assert.equal(s.state.level, 0);
  s = nextAlert(s.state, w(81, R + 5 * HOUR), R + 600);
  assert.equal(s.fire, 80);
  // expired window never fires
  assert.equal(nextAlert(s.state, w(99, NOW - 1), NOW).fire, null);
});
