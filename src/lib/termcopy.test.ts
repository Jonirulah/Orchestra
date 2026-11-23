import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copiedCount, COPY_DEDUPE_MS, ctrlCAction, DRAG_MIN_PX, isDuplicateCopy, OSC52_MAX, parseOsc52, rightClickAction, rightClickOwner, shouldHintShift, type CopyMark, type MouseTracking, type RightClickMode } from './termcopy.ts';

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

// --- «pega dos veces»: un gesto de pegar = el texto llega UNA vez al PTY ---
// Modelo de lo medido (Claude Code 2.1.331 en un ConPTY): la app, al recibir el botón derecho sin selección suya,
// pega el portapapeles por su cuenta; Orchestra, en `contextmenu`, hace su acción (pegar si no hay selección de xterm).
function pastesOnRightClick(mode: RightClickMode, tracking: MouseTracking, shift: boolean, appPastesOnRightClick: boolean): number {
  const owner = rightClickOwner(mode, tracking, shift);
  const appSeesClick = tracking !== 'none' && !shift && owner === 'app'; // sin el arreglo: tracking !== 'none' && !shift
  const byApp = appSeesClick && appPastesOnRightClick ? 1 : 0;
  const byOrchestra = owner === 'orchestra' && rightClickAction(mode, false) === 'paste' ? 1 : 0;
  return byApp + byOrchestra;
}

test('clic derecho con una app que tiene el ratón y pega sola (Claude Code): el texto se pega UNA vez', () => {
  for (const tracking of ['x10', 'vt200', 'drag', 'any'] as MouseTracking[]) {
    assert.equal(pastesOnRightClick('smart', tracking, false, true), 1, `smart/${tracking}`);
    assert.equal(pastesOnRightClick('paste', tracking, false, true), 1, `paste/${tracking}`);
    assert.equal(pastesOnRightClick('none', tracking, false, true), 1, `none/${tracking}: lo hace la app`);
  }
  // Sin ratón en la app o con Mayús, xterm no manda el clic: pega Orchestra, como siempre.
  assert.equal(pastesOnRightClick('smart', 'none', false, true), 1);
  assert.equal(pastesOnRightClick('smart', 'any', true, true), 1);
  // Una app que no hace nada con el botón derecho no pierde el pegado de Orchestra.
  assert.equal(pastesOnRightClick('smart', 'any', false, false), 1);
});

test('rightClickOwner: Orchestra atiende el clic derecho salvo en modo none con el ratón de la app', () => {
  assert.equal(rightClickOwner('smart', 'any', false), 'orchestra');
  assert.equal(rightClickOwner('paste', 'vt200', false), 'orchestra');
  assert.equal(rightClickOwner('none', 'any', false), 'app');
  assert.equal(rightClickOwner('none', 'none', false), 'orchestra');
  assert.equal(rightClickOwner('none', 'any', true), 'orchestra');
});

// --- copia doble ---
/** copyOut en pequeño: cuenta escrituras con un reloj inyectado. */
function copies(seq: CopyMark[]): number {
  let last: CopyMark | null = null, n = 0;
  for (const m of seq) { if (isDuplicateCopy(last, m)) continue; last = m; n++; }
  return n;
}

test('isDuplicateCopy: el mismo texto del mismo panel dentro de la ventana es UNA copia', () => {
  assert.equal(copies([{ id: 'a', text: 'alfa beta', at: 1000 }, { id: 'a', text: 'alfa beta', at: 1005 }]), 1);
  assert.equal(copies([{ id: 'a', text: 'x', at: 0 }, { id: 'a', text: 'x', at: 100 }, { id: 'a', text: 'x', at: COPY_DEDUPE_MS - 1 }]), 1);
});

test('isDuplicateCopy: textos distintos seguidos son DOS copias (triple clic de Claude Code: palabra y luego línea)', () => {
  assert.equal(copies([{ id: 'a', text: 'beta', at: 1000 }, { id: 'a', text: 'alfa beta gamma', at: 1080 }]), 2);
});

test('isDuplicateCopy: el mismo texto pasada la ventana (a propósito) son DOS copias; otro panel también', () => {
  assert.equal(copies([{ id: 'a', text: 'x', at: 1000 }, { id: 'a', text: 'x', at: 1000 + COPY_DEDUPE_MS }]), 2);
  assert.equal(copies([{ id: 'a', text: 'x', at: 1000 }, { id: 'a', text: 'x', at: 2000 }]), 2);
  assert.equal(copies([{ id: 'a', text: 'x', at: 1000 }, { id: 'b', text: 'x', at: 1001 }]), 2);
  assert.equal(isDuplicateCopy(null, { id: 'a', text: 'x', at: 0 }), false);
  // Reloj que retrocede: no se descarta nada.
  assert.equal(isDuplicateCopy({ id: 'a', text: 'x', at: 500 }, { id: 'a', text: 'x', at: 100 }), false);
});
