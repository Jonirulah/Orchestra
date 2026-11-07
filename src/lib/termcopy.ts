// Copiar del terminal: decisiones puras (sin DOM ni Tauri) para poder probarlas. Los efectos están en terminals.ts.
//
// Por qué existe (fallo «no se me copia», 0.2.0 reproducido en vivo):
// - Las apps a pantalla completa que activan el ratón (opencode, Codex; Claude Code también) se quedan el arrastre:
//   xterm no crea selección, Ctrl+C llega a la app como SIGINT (opencode se cierra) y el clic derecho pega.
//   En xterm.js, Mayús+arrastrar fuerza la selección aunque la app tenga el ratón: hay que decírselo al usuario.
// - Las apps remotas (Claude Code por SSH, tmux, nvim) copian con OSC 52, que Orchestra no atendía.

export interface CopyKey { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey?: boolean; code: string }

/** Qué hace una pulsación de C con Ctrl: copiar la selección, nada (Ctrl+Mayús+C sin selección) o pasarla al terminal. */
export type CtrlCAction = 'copy' | 'nothing' | 'pass';

export function ctrlCAction(ev: CopyKey, hasSelection: boolean): CtrlCAction {
  if (!ev.ctrlKey || ev.altKey || ev.metaKey || ev.code !== 'KeyC') return 'pass';
  if (hasSelection) return 'copy';
  // Ctrl+Mayús+C sin selección: antes copiaba '' y vaciaba el portapapeles. Ctrl+C solo sigue siendo interrumpir.
  return ev.shiftKey ? 'nothing' : 'pass';
}

export type RightClickMode = 'smart' | 'paste' | 'none';

/** Clic derecho: en modo «smart» copia si hay selección y si no pega; «paste» siempre pega. */
export function rightClickAction(mode: RightClickMode, hasSelection: boolean): 'copy' | 'paste' | 'none' {
  if (mode === 'none') return 'none';
  if (mode === 'smart' && hasSelection) return 'copy';
  return 'paste';
}

/** Modos de seguimiento del ratón de xterm (`term.modes.mouseTrackingMode`). */
export type MouseTracking = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

/** Distancia mínima (px) para contar un arrastre y no un clic. */
export const DRAG_MIN_PX = 8;

/**
 * ¿Avisar «mantén Mayús para seleccionar»? Solo si la app tiene el ratón, se arrastró de verdad sin Mayús y
 * xterm no seleccionó nada. Una vez por sesión de la app (`alreadyHinted`).
 */
export function shouldHintShift(o: { tracking: MouseTracking; shift: boolean; movedPx: number; hasSelection: boolean; alreadyHinted: boolean }): boolean {
  return o.tracking !== 'none' && !o.shift && o.movedPx >= DRAG_MIN_PX && !o.hasSelection && !o.alreadyHinted;
}

/** Tope de texto que se acepta por OSC 52 (1 MiB descodificado). */
export const OSC52_MAX = 1 << 20;

/**
 * OSC 52 (`ESC ] 52 ; Pc ; Pd BEL`): `data` es «Pc;Pd». Devuelve el texto a copiar o null si no hay que copiar nada.
 * Nunca se atiende la LECTURA (`Pd` = `?`): una app remota no debe poder leer el portapapeles local.
 * `Pd` vacío (borrar) también se ignora. Base64 inválido o demasiado grande -> null.
 */
export function parseOsc52(data: string, max = OSC52_MAX): string | null {
  const i = data.indexOf(';');
  if (i < 0) return null;
  const sel = data.slice(0, i);
  const b64 = data.slice(i + 1).replace(/\s+/g, '');
  if (!/^[cpqs0-7]*$/.test(sel)) return null;
  if (!b64 || b64 === '?') return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) return null;
  if (Math.floor(b64.length * 3 / 4) - (b64.match(/=*$/)?.[0].length ?? 0) > max) return null;
  let bin: string;
  try { bin = atob(b64); } catch { return null; }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.length > max ? null : text;
}

/** Texto del aviso tras copiar: número de caracteres (se cuentan puntos de código, no unidades UTF-16). */
export function copiedCount(text: string): number {
  return Array.from(text).length;
}
