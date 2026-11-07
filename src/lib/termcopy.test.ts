import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copiedCount, ctrlCAction, DRAG_MIN_PX, OSC52_MAX, parseOsc52, rightClickAction, shouldHintShift } from './termcopy.ts';

const k = (o: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; code: string }> = {}) =>
  ({ ctrlKey: true, shiftKey: false, altKey: false, code: 'KeyC', ...o });
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

test('ctrlCAction: Ctrl+C con selección copia; sin selección pasa al terminal (interrumpir)', () => {
  assert.equal(ctrlCAction(k(), true), 'copy');
  assert.equal(ctrlCAction(k(), false), 'pass');
});

test('ctrlCAction: Ctrl+Mayús+C copia si hay selección y sin selección no hace nada (no vacía el portapapeles)', () => {
  assert.equal(ctrlCAction(k({ shiftKey: true }), true), 'copy');
  assert.equal(ctrlCAction(k({ shiftKey: true }), false), 'nothing');
});

test('ctrlCAction: otras teclas o modificadores no son copiar', () => {
  assert.equal(ctrlCAction(k({ code: 'KeyV' }), true), 'pass');
  assert.equal(ctrlCAction(k({ ctrlKey: false }), true), 'pass');
  assert.equal(ctrlCAction(k({ altKey: true }), true), 'pass');
  assert.equal(ctrlCAction(k({ metaKey: true }), true), 'pass');
});

test('rightClickAction: smart copia con selección y pega sin ella; paste siempre pega; none nada', () => {
  assert.equal(rightClickAction('smart', true), 'copy');
  assert.equal(rightClickAction('smart', false), 'paste');
  assert.equal(rightClickAction('paste', true), 'paste');
  assert.equal(rightClickAction('paste', false), 'paste');
  assert.equal(rightClickAction('none', true), 'none');
  assert.equal(rightClickAction('none', false), 'none');
});

test('shouldHintShift: solo con la app usando el ratón, arrastre real sin Mayús y sin selección, una vez', () => {
  const base = { tracking: 'any' as const, shift: false, movedPx: 40, hasSelection: false, alreadyHinted: false };
  assert.equal(shouldHintShift(base), true);
  for (const t of ['x10', 'vt200', 'drag'] as const) assert.equal(shouldHintShift({ ...base, tracking: t }), true);
  assert.equal(shouldHintShift({ ...base, tracking: 'none' }), false, 'shell normal: arrastrar ya selecciona');
  assert.equal(shouldHintShift({ ...base, shift: true }), false, 'con Mayús ya selecciona');
  assert.equal(shouldHintShift({ ...base, movedPx: DRAG_MIN_PX - 1 }), false, 'un clic no es arrastrar');
  assert.equal(shouldHintShift({ ...base, hasSelection: true }), false);
  assert.equal(shouldHintShift({ ...base, alreadyHinted: true }), false);
});

test('parseOsc52: copia texto UTF-8 del destino c (y vacío, p, s, 0-7)', () => {
  assert.equal(parseOsc52(`c;${b64('hola ñandú 😀')}`), 'hola ñandú 😀');
  assert.equal(parseOsc52(`;${b64('x')}`), 'x');
  assert.equal(parseOsc52(`pc;${b64('y')}`), 'y');
  assert.equal(parseOsc52(`s0;${b64('z')}`), 'z');
  assert.equal(parseOsc52(`c;${b64('ab').replace(/=+$/, '')}`), 'ab', 'sin relleno');
});

test('parseOsc52: nunca atiende la lectura, ni borrar, ni basura', () => {
  assert.equal(parseOsc52('c;?'), null, 'lectura del portapapeles: jamás');
  assert.equal(parseOsc52('c;'), null);
  assert.equal(parseOsc52('c'), null);
  assert.equal(parseOsc52('c;%%%%'), null);
  assert.equal(parseOsc52('c;abcde'), null, 'longitud imposible en base64');
  assert.equal(parseOsc52(`x;${b64('a')}`), null, 'destino desconocido');
});

test('parseOsc52: respeta el tope de tamaño', () => {
  assert.equal(parseOsc52(`c;${b64('a'.repeat(100))}`, 50), null);
  assert.equal(parseOsc52(`c;${b64('a'.repeat(50))}`, 50), 'a'.repeat(50));
  assert.equal(OSC52_MAX, 1048576);
});

test('copiedCount cuenta caracteres, no unidades UTF-16', () => {
  assert.equal(copiedCount('abc'), 3);
  assert.equal(copiedCount('😀ñ'), 2);
  assert.equal(copiedCount(''), 0);
});
