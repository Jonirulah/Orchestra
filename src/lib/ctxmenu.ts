// Menú contextual: modelo de elementos, colocación en pantalla y navegación con teclado.
// Módulo puro (sin Svelte ni Tauri): se prueba con node --test. El componente es ContextMenu.svelte.

export interface MenuItem {
  id: string;
  label: string;
  /** Texto de atajo o nota a la derecha («/login», «F2»…). */
  hint?: string;
  disabled?: boolean;
  /** Rojo: acción destructiva. */
  danger?: boolean;
  /** Fila separadora (el resto de campos no se usa). */
  separator?: boolean;
  /** Si está, hacen falta dos clics: el primero muestra este texto («Click again to confirm»). */
  confirm?: string;
  /** Punto de color a la izquierda. */
  swatch?: string;
  /** Marca de «elegido» (capa de colores, disposición actual…). */
  checked?: boolean;
  /** Submenú de un nivel. */
  children?: MenuItem[];
  run?: () => void;
}

/** Cuánto tarda en deshacerse la primera pulsación de un elemento «confirm». */
export const CONFIRM_MS = 2000;
/** Separación mínima con el borde de la ventana. */
export const EDGE = 4;

export const sep = (id = 'sep'): MenuItem => ({ id, label: '', separator: true });

/** ¿Se puede elegir? (no es separador ni está desactivado). */
export const isEnabled = (it: MenuItem): boolean => !it.separator && !it.disabled;

/** Filas elegibles (sin separadores) — el tope de «filas visibles» habla de estas. */
export function entryCount(items: MenuItem[]): number { return items.filter((i) => !i.separator).length; }

/** Quita separadores al principio, al final y los repetidos (un menú armado a trozos puede dejarlos sueltos). */
export function tidy(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (it.separator && (out.length === 0 || out[out.length - 1].separator)) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

/**
 * Esquina superior izquierda para un menú de `w`×`h` pedido en (`x`,`y`) dentro de una ventana `vw`×`vh`:
 * se queda donde se pidió si cabe; si no, se desplaza hacia dentro (nunca queda fuera ni pasa del margen).
 * Si el menú es más grande que la ventana, gana el borde superior/izquierdo.
 */
export function clampPosition(x: number, y: number, w: number, h: number, vw: number, vh: number, margin = EDGE): { x: number; y: number } {
  const maxX = vw - w - margin;
  const maxY = vh - h - margin;
  return { x: Math.max(margin, Math.min(x, maxX)), y: Math.max(margin, Math.min(y, maxY)) };
}

export interface Box { left: number; top: number; right: number; bottom: number }

/** Dónde abrir un submenú junto a la fila `parent`: a la derecha si cabe, si no a la izquierda; arriba alineado con la fila. */
export function placeSubmenu(parent: Box, w: number, h: number, vw: number, vh: number, margin = EDGE): { x: number; y: number; side: 'right' | 'left' } {
  const overlap = 4; // se solapa un poco con el padre para que el puntero no cruce un hueco
  let x = parent.right - overlap;
  let side: 'right' | 'left' = 'right';
  if (x + w > vw - margin) {
    const left = parent.left - w + overlap;
    if (left >= margin) { x = left; side = 'left'; }
  }
  const c = clampPosition(x, parent.top - 5, w, h, vw, vh, margin);
  return { x: c.x, y: c.y, side };
}

/** Siguiente índice elegible al pulsar ↑ ↓ Home End (con vuelta). `-1` si no hay ninguno. `cur` = -1: nada resaltado aún. */
export function moveActive(items: MenuItem[], cur: number, key: string): number {
  const n = items.length;
  if (!items.some(isEnabled)) return -1;
  if (key === 'Home') return items.findIndex(isEnabled);
  if (key === 'End') { for (let i = n - 1; i >= 0; i--) if (isEnabled(items[i])) return i; return -1; }
  const step = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
  if (!step) return cur;
  let i = cur;
  for (let k = 0; k < n; k++) {
    i = i < 0 ? (step > 0 ? 0 : n - 1) : (i + step + n) % n;
    if (isEnabled(items[i])) return i;
  }
  return cur;
}

/** Primer elemento elegible (para enfocar al abrir con teclado). */
export const firstEnabled = (items: MenuItem[]): number => items.findIndex(isEnabled);

export type Activation =
  | { kind: 'none'; armed: string | null }
  | { kind: 'arm'; armed: string }
  | { kind: 'sub'; armed: string | null }
  | { kind: 'run'; armed: null };

/**
 * Qué pasa al pulsar un elemento. `armed` = id del elemento «confirm» ya pulsado una vez (o null).
 * Desactivado y separador: nada. Con submenú: lo abre. Con `confirm`: la primera vez se arma, la segunda se ejecuta.
 */
export function activate(item: MenuItem, armed: string | null): Activation {
  if (!isEnabled(item)) return { kind: 'none', armed };
  if (item.children?.length) return { kind: 'sub', armed: null };
  if (item.confirm && armed !== item.id) return { kind: 'arm', armed: item.id };
  return { kind: 'run', armed: null };
}

/** Texto que se pinta ahora: el de confirmación si el elemento está armado. */
export const shownLabel = (item: MenuItem, armed: string | null): string => (item.confirm && armed === item.id ? item.confirm : item.label);

/** Elementos nativos que conservan su menú del sistema (copiar/pegar) y el terminal, que tiene el suyo. */
export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (sel: string) => unknown;
}
export function keepsNativeMenu(el: TargetLike | null | undefined): boolean {
  if (!el) return false;
  const tag = String(el.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  return !!el.closest?.('.xterm');
}

/** ¿Es la pulsación que abre el menú del elemento enfocado? (tecla Menú o Shift+F10) */
export const isMenuKey = (e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): boolean =>
  e.key === 'ContextMenu' || (e.key === 'F10' && !!e.shiftKey && !e.ctrlKey && !e.altKey);
