import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshRetry, webglLost, webglOk, WEBGL_RETRY_MS, WEBGL_STABLE_MS } from './webglretry.ts';

test('tras perder el contexto siempre hay un nuevo intento (nunca se queda en DOM para siempre)', () => {
  let s = freshRetry();
  const delays: number[] = [];
  for (let i = 0; i < 12; i++) { const r = webglLost(s, 1000 * i); delays.push(r.delayMs); s = r.state; }
  assert.ok(delays.every((d) => Number.isFinite(d) && d > 0));
  assert.deepEqual(delays.slice(0, 5), [...WEBGL_RETRY_MS]);
  assert.ok(delays.slice(5).every((d) => d === WEBGL_RETRY_MS[WEBGL_RETRY_MS.length - 1]), 'en racha, la espera se queda en la más larga');
});

test('las esperas crecen en una racha de pérdidas (no machaca la GPU)', () => {
  let s = freshRetry();
  let prev = 0;
  for (let i = 0; i < WEBGL_RETRY_MS.length; i++) {
    const r = webglLost(webglOk(s, 10 * i), 10 * i + 5);
    assert.ok(r.delayMs > prev);
    prev = r.delayMs; s = r.state;
  }
});

test('tras un rato estable con WebGL, la siguiente pérdida vuelve a la espera corta', () => {
  let s = freshRetry();
  for (let i = 0; i < 4; i++) s = webglLost(s, i).state;
  s = webglOk(s, 100);
  assert.equal(webglLost(s, 100 + WEBGL_STABLE_MS - 1).delayMs, WEBGL_RETRY_MS[4], 'sin rato estable sigue la racha');
  assert.equal(webglLost(s, 100 + WEBGL_STABLE_MS).delayMs, WEBGL_RETRY_MS[0]);
});
