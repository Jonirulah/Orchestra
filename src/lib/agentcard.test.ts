import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOW_1M, WINDOW_200K, cardPosition, cardSections, fmtWindow, prettyModel, clampPrompt, contextWindow, ctxBar, fmtDuration, shortCwd, todoProgress, trackStatus,
} from './agentcard.ts';
import type { CardAgent } from './agentcard.ts';

test('ventana por modelo: 1m en el id, deducida por el uso, 200k para Claude y nada si no se sabe', () => {
  assert.equal(contextWindow('claude-opus-5-5[1m]', 10_000), WINDOW_1M);
  assert.equal(contextWindow('claude-sonnet-5-5-1m', 10_000), WINDOW_1M);
  assert.equal(contextWindow('claude-opus-5-5', 150_000), WINDOW_200K);
  assert.equal(contextWindow('claude-opus-5-5', 289_000), WINDOW_1M); // más de 200k: por fuerza es de 1M
  assert.equal(contextWindow(undefined, 289_000), WINDOW_1M);
  assert.equal(contextWindow(undefined, 50_000), null);
  assert.equal(contextWindow('gpt-5-codex', 50_000), null);
  assert.equal(contextWindow('claude-1mini', 50_000), WINDOW_200K); // «1m» suelto, no dentro de otra palabra
});

test('barra de contexto: % redondeado y marca de auto-compact solo si cae dentro', () => {
  assert.deepEqual(ctxBar(121_000, WINDOW_200K, 150_000), { window: WINDOW_200K, pct: 61, markPct: 75 });
  assert.deepEqual(ctxBar(289_000, WINDOW_1M, null), { window: WINDOW_1M, pct: 29, markPct: null });
  assert.equal(ctxBar(289_000, WINDOW_1M, 1_200_000)?.markPct, null);
  assert.equal(ctxBar(250_000, WINDOW_200K, null)?.pct, 100); // nunca más del 100 %
  assert.equal(ctxBar(0, WINDOW_200K, 150_000), null); // sin contexto no hay barra
  assert.equal(ctxBar(100_000, null, 150_000), null); // sin ventana, solo la cifra
});

test('pedido: primera línea con texto, recortado con «…»; vacío → null', () => {
  assert.equal(clampPrompt('\n\n  Arregla el login  \ny los tests'), 'Arregla el login');
  assert.equal(clampPrompt('a  b\tc'), 'a b c');
  const largo = 'x'.repeat(200);
  const r = clampPrompt(largo, 140)!;
  assert.equal(Array.from(r).length, 141);
  assert.ok(r.endsWith('…'));
  assert.equal(clampPrompt('ñ'.repeat(140), 140), 'ñ'.repeat(140)); // justo en el límite, sin «…»
  assert.equal(clampPrompt(''), null);
  assert.equal(clampPrompt('  \n '), null);
  assert.equal(clampPrompt(undefined), null);
});

test('duración corta', () => {
  assert.equal(fmtDuration(45), '45 s');
  assert.equal(fmtDuration(180), '3 min');
  assert.equal(fmtDuration(2 * 3600 + 14 * 60), '2 h 14 min');
  assert.equal(fmtDuration(3600), '1 h');
  assert.equal(fmtDuration(3 * 86400 + 4 * 3600), '3 d 4 h');
  assert.equal(fmtDuration(-1), null);
  assert.equal(fmtDuration(null), null);
  assert.equal(fmtDuration(Number.NaN), null);
});

test('carpeta acortada', () => {
  assert.equal(shortCwd('C:\\Users\\demo'), '~');
  assert.equal(shortCwd('C:\\Users\\demo\\proj\\app'), '~/proj/app');
  assert.equal(shortCwd('E:\\Orchestra\\src-tauri\\src\\deep\\more'), 'E:/…/src/deep/more');
  assert.equal(shortCwd('/home/ana/work/x/'), '~/work/x');
  assert.equal(shortCwd(undefined), null);
});

test('duración del estado: cambio = ahora; primera vez solo se deduce para inactivo/esperando', () => {
  const now = 10_000;
  let m = trackStatus({}, [
    { paneId: 'a', status: 'busy', lastRequestAt: 9_000 },
    { paneId: 'b', status: 'waiting', lastRequestAt: 9_800 },
    { paneId: 'c', status: 'idle' },
  ], now);
  assert.deepEqual(m, { a: { status: 'busy', since: null }, b: { status: 'waiting', since: 9_800 }, c: { status: 'idle', since: null } });
  m = trackStatus(m, [{ paneId: 'a', status: 'waiting', lastRequestAt: 10_050 }, { paneId: 'b', status: 'waiting' }], now + 60);
  assert.deepEqual(m.a, { status: 'waiting', since: now + 60 }); // cambio visto: desde ahora
  assert.deepEqual(m.b, { status: 'waiting', since: 9_800 }); // mismo estado: se conserva
  assert.equal(m.c, undefined); // el que ya no está se olvida
});

const agent = (over: Partial<CardAgent> = {}): CardAgent => ({ status: 'idle', ctxTokens: 0, todos: [], subagents: [], ...over });
const zero = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, requests: 0 };

test('secciones: sin datos no se enseña nada; cada dato enciende la suya', () => {
  assert.deepEqual(cardSections(agent({ tokens: zero, subTokens: zero })), { ctx: false, now: false, tasks: false, subs: false, session: false });
  const s = cardSections(agent({ ctxTokens: 5, lastPrompt: 'hola', todos: [{ status: 'pending' }], subagents: [{ state: 'done' }] }));
  assert.deepEqual(s, { ctx: true, now: true, tasks: true, subs: true, session: false });
  assert.equal(cardSections(agent({ lastPrompt: '  \n' })).now, false);
  assert.equal(cardSections(agent({ current: 'Bash: ls' })).now, true);
  assert.equal(cardSections(agent(), 'main').session, true);
  assert.equal(cardSections(agent({ tokens: { ...zero, requests: 3 } })).session, true);
  assert.equal(cardSections(agent({ startedAt: 1 })).session, true);
});

test('progreso de tareas', () => {
  assert.deepEqual(todoProgress([{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }]), { done: 1, total: 3, current: 1 });
  assert.deepEqual(todoProgress([]), { done: 0, total: 0, current: -1 });
});

test('posición: a la derecha de la barra; sube si no cabe; nunca fuera de la ventana', () => {
  const view = { width: 1420, height: 860 };
  const card = { width: 320, height: 300 };
  assert.deepEqual(cardPosition({ top: 100, bottom: 130 }, 260, card, view), { left: 268, top: 100 });
  // fila abajo del todo: la ficha sube y acaba a ras del borde inferior de la fila
  assert.deepEqual(cardPosition({ top: 700, bottom: 730 }, 260, card, view), { left: 268, top: 430 });
  // ficha más alta que la ventana: arriba con margen
  assert.equal(cardPosition({ top: 700, bottom: 730 }, 260, { width: 320, height: 2000 }, view).top, 8);
  // ventana estrecha: no se sale por la derecha
  assert.equal(cardPosition({ top: 10, bottom: 40 }, 260, card, { width: 500, height: 860 }).left, 172);
});

test('nombre corto del modelo', () => {
  assert.equal(prettyModel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(prettyModel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(prettyModel('claude-opus-4-20250514'), 'Opus 4');
  assert.equal(prettyModel('claude-opus-5-5[1m]'), 'Opus 5.5 1M');
  assert.equal(prettyModel('gpt-5-codex'), 'gpt-5-codex');
  assert.equal(prettyModel(''), null);
  assert.equal(prettyModel(undefined), null);
});

test('ventana en corto', () => {
  assert.equal(fmtWindow(200_000), '200k');
  assert.equal(fmtWindow(1_000_000), '1M');
  assert.equal(fmtWindow(1_500_000), '1.5M');
});
