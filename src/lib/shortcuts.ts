// Lista de atajos para el diálogo de ajustes (solo lectura). Debe reflejar store.handleShortcut y terminals.ts.
// Los textos se guardan como CLAVES de i18n (no como texto) porque esto es una constante de módulo: el componente
// llama a t() al pintar. Las combinaciones de teclas no se traducen.
import { t, type Key } from './i18n.ts';

/** `keys` es la combinación tal cual salvo el marcador `{arrows}` (la palabra «Arrow keys» / «flechas»), que sale de una clave de i18n. */
export interface ShortcutGroup { titleKey: Key; items: { keys: string; whatKey: Key }[] }

/** Texto de una combinación listo para pintar: resuelve `{arrows}` en el idioma actual. Llamar al pintar, no a nivel de módulo. */
export function comboText(keys: string): string {
  return keys.replace('{arrows}', () => t('shortcuts.keyArrows'));
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    titleKey: 'shortcuts.groupApp',
    items: [
      { keys: 'Ctrl+,', whatKey: 'shortcuts.openSettings' },
      { keys: 'Ctrl+Shift+P', whatKey: 'shortcuts.palette' },
      { keys: 'Ctrl+Shift+B', whatKey: 'shortcuts.toggleSidebar' },
      { keys: 'Esc', whatKey: 'shortcuts.closeDialog' },
    ],
  },
  {
    titleKey: 'shortcuts.groupPanes',
    items: [
      { keys: 'Ctrl+Shift+T', whatKey: 'shortcuts.newTerminal' },
      { keys: 'Ctrl+Shift+W', whatKey: 'shortcuts.closePane' },
      { keys: 'Ctrl+Shift+Enter', whatKey: 'shortcuts.maximizePane' },
      { keys: 'Ctrl+Shift+F', whatKey: 'shortcuts.searchPane' },
      { keys: 'Alt+{arrows}', whatKey: 'shortcuts.movePaneFocus' },
      { keys: 'Alt+1 … Alt+9', whatKey: 'shortcuts.gotoPane' },
      { keys: 'Ctrl+PageUp / PageDown', whatKey: 'shortcuts.switchWorkspace' },
    ],
  },
  {
    titleKey: 'shortcuts.groupText',
    items: [
      { keys: 'Ctrl+Plus  /  Ctrl+Minus', whatKey: 'shortcuts.fontSize' },
      { keys: 'Ctrl+0', whatKey: 'shortcuts.fontReset' },
      { keys: 'Ctrl+C', whatKey: 'shortcuts.copySmart' },
      { keys: 'Ctrl+Shift+C', whatKey: 'shortcuts.copy' },
      { keys: 'Ctrl+V', whatKey: 'shortcuts.paste' },
    ],
  },
];
