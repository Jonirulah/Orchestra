import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOW_SEC, demoHistory, gapOf, minutesAgo, nearestIndex, niceBytes, niceMax, pct, segments, seriesPaths, spanMinutes, stats, stepOf, tAtX,
  timeDomain, xOf, yOf,
} from './history.ts';
import type { Box } from './history.ts';

const P = (ts: number[]) => ts.map((t) => ({ t }));

test('stepOf: median spacing, robust to a gap; default 5 without data', () => {
  assert.equal(stepOf(P([0, 5, 10, 15, 400, 405])), 5);
  assert.equal(stepOf(P([])), 5);
  assert.equal(stepOf(P([7])), 5);
  assert.equal(stepOf(P([0, 4, 8, 12])), 4);
  assert.equal(gapOf(5), 15);
});

test('timeDomain: last hour up to the last point, or from the first one if shorter', () => {
  assert.deepEqual(timeDomain(P([100, 105, 200])), { t0: 100, t1: 200 });
  assert.deepEqual(timeDomain(P([0, 1000, 5000])), { t0: 5000 - WINDOW_SEC, t1: 5000 });
  assert.deepEqual(timeDomain(P([42])), { t0: 42, t1: 43 }, 'one point: non-empty span');
  assert.equal(spanMinutes({ t0: 0, t1: 3600 }), 60);
  assert.equal(spanMinutes({ t0: 0, t1: 10 }), 1);
  assert.equal(spanMinutes({ t0: 0, t1: 25 * 60 + 20 }), 25);
});

test('niceMax: 1 / 2 / 2.5 / 5 x 10^k above the value, with a floor', () => {
  assert.equal(niceMax(0.7), 1);
  assert.equal(niceMax(1.3), 2);
  assert.equal(niceMax(2.2), 2.5);
  assert.equal(niceMax(3), 5);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(120), 200);
  assert.equal(niceMax(5000), 5000);
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(NaN), 1);
  assert.equal(niceMax(3, 100), 100);
});

test('niceBytes: round binary units, at least 1 KB/s', () => {
  const K = 1024, M = K * K;
  assert.equal(niceBytes(0), K);
  assert.equal(niceBytes(300), K);
  assert.equal(niceBytes(3 * K), 5 * K);
  assert.equal(niceBytes(900 * K), M, '900 KB -> 1 MB, not 1000 KB');
  assert.equal(niceBytes(1.3 * M), 2 * M);
  assert.equal(niceBytes(40 * M), 50 * M);
  for (const v of [1, 999, 5e3, 7.7e5, 3e6, 9.9e8, 2e10]) assert.ok(niceBytes(v) >= v, `${v}`);
});

test('xOf / yOf map into the box, values clamped; tAtX inverts xOf', () => {
  const b: Box = { w: 400, h: 40, t0: 1000, t1: 2000, yMax: 100, pad: 0 };
  assert.equal(xOf(1000, b), 0);
  assert.equal(xOf(2000, b), 400);
  assert.equal(xOf(1500, b), 200);
  assert.equal(yOf(0, b), 40);
  assert.equal(yOf(100, b), 0);
  assert.equal(yOf(250, b), 0, 'above the top is clamped');
  assert.equal(yOf(-5, b), 40);
  assert.equal(tAtX(200, b), 1500);
  assert.equal(tAtX(-50, b), 1000);
  assert.equal(tAtX(9999, b), 2000);
});

test('segments: a jump over 3x the step cuts the line (no interpolation)', () => {
  const pts = P([0, 5, 10, 15, 100, 105, 110]);
  const segs = segments(pts, (i) => i * 10, gapOf(stepOf(pts)));
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0].map((p) => p.t), [0, 5, 10, 15]);
  assert.deepEqual(segs[1].map((p) => p.t), [100, 105, 110]);
});

test('segments: missing values (null) cut too and are never drawn as zero', () => {
  const pts = P([0, 5, 10, 15, 20]);
  const vals = [1, 2, null, 4, 5];
  const segs = segments(pts, (i) => vals[i], 15);
  assert.equal(segs.length, 2);
  assert.ok(segs.flat().every((p) => p.v !== 0));
  assert.deepEqual(segments(pts, () => null, 15), []);
  assert.deepEqual(segments(pts, () => NaN, 15), []);
});

test('seriesPaths: one subpath per segment; area closes on the baseline; single point is a dot', () => {
  const b: Box = { w: 100, h: 20, t0: 0, t1: 100, yMax: 10, pad: 0 };
  const two = seriesPaths([[{ t: 0, v: 0 }, { t: 50, v: 10 }], [{ t: 100, v: 5 }]], b);
  assert.equal(two.line, 'M0 20L50 0M100 10h0.1');
  assert.equal(two.area, 'M0 20L50 0L50 20L0 20Z');
  assert.equal((two.line.match(/M/g) ?? []).length, 2, 'a gap is a new M, never an L across it');
  assert.deepEqual(seriesPaths([], b), { line: '', area: '' });
});

test('stats: current = last present value; max and mean ignore nulls', () => {
  assert.deepEqual(stats([1, null, 3, 2]), { cur: 2, max: 3, avg: 2 });
  assert.deepEqual(stats([5, null]), { cur: 5, max: 5, avg: 5 });
  assert.equal(stats([null, null]), null);
  assert.equal(stats([]), null);
});

test('nearestIndex: closest point in time (ties go to the earlier one)', () => {
  const pts = P([0, 10, 20, 30]);
  assert.equal(nearestIndex(pts, -100), 0);
  assert.equal(nearestIndex(pts, 4), 0);
  assert.equal(nearestIndex(pts, 5), 0);
  assert.equal(nearestIndex(pts, 6), 1);
  assert.equal(nearestIndex(pts, 29), 3);
  assert.equal(nearestIndex(pts, 1e9), 3);
  assert.equal(nearestIndex([], 5), -1);
});

test('pct: null when the total is missing or zero; clamped 0..100', () => {
  assert.equal(pct(5, 10), 50);
  assert.equal(pct(5, 0), null);
  assert.equal(pct(null, 10), null);
  assert.equal(pct(5, null), null);
  assert.equal(pct(20, 10), 100);
  assert.equal(minutesAgo(1000, 1000 + 125), 2);
  assert.equal(minutesAgo(2000, 1000), 0);
});

test('demoHistory: ordered, inside the window, with a gap, swap optional', () => {
  const h = demoHistory(1_700_000_000, 42);
  assert.ok(h.length > 100);
  for (let i = 1; i < h.length; i++) assert.ok(h[i].t > h[i - 1].t);
  assert.ok(h[h.length - 1].t - h[0].t <= 42 * 60);
  assert.equal(segments(h, (i) => h[i].cpu, gapOf(stepOf(h))).length, 2, 'one gap');
  assert.ok(h.every((p) => p.cpu >= 0 && p.cpu <= 100 && p.ramUsed <= p.ramTotal));
  assert.ok(demoHistory(1_700_000_000, 10, { swap: false }).every((p) => p.swapTotal === null && p.swapUsed === null));
});
