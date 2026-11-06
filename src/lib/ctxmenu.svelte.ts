// Estado del menú contextual: solo uno abierto a la vez en toda la app. Lo pinta ContextMenu.svelte (montado una vez en App).
import { keepsNativeMenu } from './ctxmenu.ts';
import type { MenuItem } from './ctxmenu.ts';

export interface OpenMenu {
  items: MenuItem[];
  x: number;
  y: number;
  /** Abierto con el teclado: se resalta ya el primer elemento. */
  keyboard: boolean;
  /** Dónde devolver el foco al cerrar. */
  returnTo: HTMLElement | null;
  /** Se cambia en cada apertura para que el componente reinicie su estado interno. */
  seq: number;
}

class CtxMenuState {
  current = $state<OpenMenu | null>(null);
  private n = 0;

  close(): void { this.current = null; }

  /** Abre `items` en un punto de la ventana. Sustituye cualquier menú abierto. */
  openAt(x: number, y: number, items: MenuItem[], opts: { keyboard?: boolean } = {}): void {
    if (!items.length) return;
    const ae = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    this.current = { items, x, y, keyboard: !!opts.keyboard, returnTo: ae && ae !== document.body ? ae : null, seq: ++this.n };
  }

  /**
   * Abre `items` para un `contextmenu` del ratón o del teclado (tecla Menú, Shift+F10).
   * Con teclado el menú sale bajo el elemento. Devuelve false (y no hace nada) si el clic fue sobre un campo de texto o el terminal.
   */
  openFromEvent(ev: MouseEvent, items: MenuItem[], anchor?: HTMLElement | null): boolean {
    if (keepsNativeMenu(ev.target as HTMLElement | null)) return false;
    ev.preventDefault();
    ev.stopPropagation();
    const fromKeyboard = ev.button !== 2; // clic derecho = botón 2; tecla Menú / Shift+F10 llegan con botón 0
    if (fromKeyboard && anchor) this.openBelow(anchor, items);
    else this.openAt(ev.clientX, ev.clientY, items);
    return true;
  }

  /** Para Shift+F10 / tecla Menú sobre un elemento enfocado. */
  openBelow(anchor: HTMLElement, items: MenuItem[]): void {
    const r = anchor.getBoundingClientRect();
    this.openAt(r.left + Math.min(24, r.width / 2), r.bottom - 4, items, { keyboard: true });
  }
}

export const ctxmenu = new CtxMenuState();
