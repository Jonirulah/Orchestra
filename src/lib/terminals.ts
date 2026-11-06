// Registro de terminales xterm.js. Cada panel tiene UNA instancia de xterm que vive
// aunque el panel se desmonte (cambio de espacio, maximizar...): solo se reparenta su DOM.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import * as be from './backend.ts';
import type { Pane } from './model.ts';
import { DEFAULTS, fontStack } from './settings.ts';
import { themeOf } from './themes.ts';
import type { TermTheme } from './themes.ts';
import { parseOsc7, parseOsc9, withCwdTracking } from './gitinfo.ts';

export interface TermHooks {
  /** La shell avisa de su carpeta (OSC 9;9 o OSC 7); ya validada. */
  onCwd?(id: string, cwd: string): void;
  /** ¿Añadir a los paneles de PowerShell el aviso de carpeta en el prompt? (ajuste «Track folder»). */
  trackFolder?(): boolean;
  onTitle(id: string, title: string): void;
  onState(id: string, state: 'running' | 'exited', code?: number): void;
  onBell(id: string): void;
  /** `false` al lanzar o relanzar el proceso; `true` cuando llega su primera salida (para el aviso «conectando…»). */
  onOutput(id: string, seen: boolean): void;
  /** Devuelve true si la tecla es un atajo de la app (no se envía al terminal). */
  onShortcut(ev: KeyboardEvent, id: string): boolean;
}

/** Opciones ya resueltas (lista CSS de fuentes y tema completo): las construye el store a partir de los ajustes. */
export interface TermOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: 'bar' | 'block' | 'underline';
  cursorBlink: boolean;
  scrollback: number;
  theme: TermTheme;
  copyOnSelect: boolean;
  rightClick: 'smart' | 'paste' | 'none';
  bell: 'flash' | 'none';
}

interface Entry {
  id: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLDivElement;
  webgl?: WebglAddon;
  mounted: boolean;
  lastCols: number;
  lastRows: number;
  resizeTimer?: number;
}

const entries = new Map<string, Entry>();
let hooks: TermHooks;
const MAX_WEBGL = 12; // WebView2/Chromium admite ~16 contextos WebGL a la vez
let webglCount = 0;

/** Tema y fuente de siempre (los ajustes por defecto). */
export const termTheme: TermTheme = themeOf(DEFAULTS.theme);
export const FONT_FAMILY = fontStack(DEFAULTS.fontFamily);

let opts: TermOptions = {
  fontFamily: FONT_FAMILY, fontSize: DEFAULTS.fontSize, lineHeight: DEFAULTS.lineHeight,
  cursorStyle: DEFAULTS.cursorStyle, cursorBlink: DEFAULTS.cursorBlink, scrollback: DEFAULTS.scrollback,
  theme: termTheme, copyOnSelect: DEFAULTS.copyOnSelect, rightClick: DEFAULTS.rightClick, bell: DEFAULTS.bell,
};

export function initTerminals(h: TermHooks, o: TermOptions): void {
  hooks = h;
  opts = o;
  void be.onPtyExit((id, code) => {
    const e = entries.get(id);
    if (!e) return;
    e.term.write(`\r\n\x1b[2m[process exited · code ${code}]\x1b[0m\r\n`);
    hooks.onState(id, 'exited', code);
  });
}

let stash: HTMLDivElement | null = null;
function getStash(): HTMLDivElement {
  if (!stash) {
    stash = document.createElement('div');
    stash.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:500px;overflow:hidden;visibility:hidden';
    document.body.appendChild(stash);
  }
  return stash;
}

export function has(id: string): boolean { return entries.has(id); }

/** Últimas líneas con texto del terminal, tras vaciar la cola de escritura de xterm (sirve para ver cómo terminó ssh). */
export function tailText(id: string, lines = 6): Promise<string> {
  const e = entries.get(id);
  if (!e) return Promise.resolve('');
  return new Promise((resolve) => {
    const bail = window.setTimeout(() => resolve(''), 500);
    e.term.write('', () => {
      clearTimeout(bail);
      const b = e.term.buffer.active;
      const out: string[] = [];
      for (let y = b.length - 1; y >= 0 && out.length < lines; y--) {
        const l = b.getLine(y)?.translateToString(true);
        if (l) out.unshift(l);
      }
      resolve(out.join('\n'));
    });
  });
}

function create(id: string): Entry {
  const term = new Terminal({
    fontFamily: opts.fontFamily,
    fontSize: opts.fontSize,
    lineHeight: opts.lineHeight,
    cursorBlink: opts.cursorBlink,
    cursorStyle: opts.cursorStyle,
    scrollback: opts.scrollback,
    allowProposedApi: true,
    theme: { ...opts.theme },
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => be.openUrl(uri)));
  const uni = new Unicode11Addon();
  term.loadAddon(uni);
  term.unicode.activeVersion = '11';

  const el = document.createElement('div');
  el.className = 'term-host';
  el.style.cssText = 'width:100%;height:100%';
  getStash().appendChild(el);
  term.open(el);

  const entry: Entry = { id, term, fit, search, el, mounted: false, lastCols: 0, lastRows: 0 };

  term.onData((d) => be.ptyWrite(id, d));
  term.onTitleChange((t) => hooks.onTitle(id, t));
  term.onBell(() => { if (opts.bell === 'flash') hooks.onBell(id); });
  registerCwdOsc(term, id);
  // Copiar al seleccionar: se espera a que el usuario suelte (la selección cambia en cada movimiento del ratón).
  let selTimer: number | undefined;
  term.onSelectionChange(() => {
    if (!opts.copyOnSelect) return;
    clearTimeout(selTimer);
    selTimer = window.setTimeout(() => {
      if (opts.copyOnSelect && term.hasSelection()) void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
    }, 180);
  });
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    // Copiar: Ctrl+C con selección, o Ctrl+Shift+C.
    if (ev.ctrlKey && !ev.altKey && ev.code === 'KeyC' && (ev.shiftKey || term.hasSelection())) {
      void navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    // Pegar: dejamos que el navegador dispare el evento `paste` (xterm hace bracketed paste).
    if (ev.ctrlKey && !ev.altKey && ev.code === 'KeyV') return false;
    if (hooks.onShortcut(ev, id)) return false;
    return true;
  });
  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (opts.rightClick === 'none') return;
    if (opts.rightClick === 'smart' && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
    } else {
      void navigator.clipboard.readText().then((t) => t && term.paste(t)).catch(() => {});
    }
  });
  entries.set(id, entry);
  return entry;
}

/** Crea el xterm del panel si no existe. Devuelve true si es nuevo (hay que lanzarlo). */
export function ensure(pane: Pane): boolean {
  if (entries.has(pane.id)) return false;
  create(pane.id);
  return true;
}

/** Argumentos reales de lanzamiento: en un PowerShell sin argumentos propios se añade el aviso de carpeta del prompt (gitinfo.ts). */
function spawnArgs(pane: Pane): string[] {
  return withCwdTracking(pane.spec, hooks.trackFolder?.() ?? false, pane.kind).args;
}

/** OSC 9;9;<ruta> (PowerShell/ConEmu) y OSC 7 file://… (bash, zsh): la shell dice en qué carpeta está. */
function registerCwdOsc(term: Terminal, id: string): void {
  const emit = (p: string | null) => { if (p) hooks.onCwd?.(id, p); return !!p; };
  term.parser.registerOscHandler(9, (data) => emit(parseOsc9(data)));
  term.parser.registerOscHandler(7, (data) => emit(parseOsc7(data)));
}

/** Lanza el proceso con el tamaño ya ajustado al panel. */
export async function launch(pane: Pane): Promise<void> {
  const entry = entries.get(pane.id);
  if (!entry) return;
  try {
    hooks.onOutput(pane.id, false);
    await be.ptySpawn({
      id: pane.id, program: pane.spec.program, args: spawnArgs(pane),
      cwd: pane.spec.cwd, env: pane.spec.env,
      cols: entry.term.cols, rows: entry.term.rows,
    });
    await attach(entry);
    hooks.onState(pane.id, 'running');
  } catch (err) {
    entry.term.write(`[31m${String(err)}[0m
`);
    hooks.onState(pane.id, 'exited', -1);
  }
}

async function attach(entry: Entry): Promise<void> {
  let seen = false;
  const code = await be.ptyAttach(entry.id, (b) => {
    if (!seen) { seen = true; hooks.onOutput(entry.id, true); }
    entry.term.write(b);
  });
  if (code !== null && code !== undefined) hooks.onState(entry.id, 'exited', code);
}

/** Relanza el mismo panel tras terminar su proceso. */
export async function restart(pane: Pane): Promise<void> {
  const e = entries.get(pane.id);
  if (!e) { ensure(pane); return launch(pane); }
  e.term.write('\r\n\x1b[2m── restarted ──\x1b[0m\r\n');
  hooks.onOutput(pane.id, false);
  await be.ptySpawn({
    id: pane.id, program: pane.spec.program, args: spawnArgs(pane), cwd: pane.spec.cwd,
    env: pane.spec.env, cols: e.term.cols, rows: e.term.rows,
  });
  await attach(e);
  hooks.onState(pane.id, 'running');
}

function acquireWebgl(e: Entry): void {
  if (e.webgl || webglCount >= MAX_WEBGL) return;
  try {
    const w = new WebglAddon();
    w.onContextLoss(() => { w.dispose(); if (e.webgl === w) { e.webgl = undefined; webglCount--; } });
    e.term.loadAddon(w);
    e.webgl = w;
    webglCount++;
  } catch { /* se queda con el renderizador DOM */ }
}
function releaseWebgl(e: Entry): void {
  if (!e.webgl) return;
  try { e.webgl.dispose(); } catch { /* ya liberado */ }
  e.webgl = undefined;
  webglCount--;
}

export function fitNow(id: string): void {
  const e = entries.get(id);
  if (!e || !e.mounted || !e.el.isConnected || e.el.clientWidth < 20 || e.el.clientHeight < 20) return;
  try { e.fit.fit(); } catch { return; }
  const { cols, rows } = e.term;
  if (cols !== e.lastCols || rows !== e.lastRows) {
    e.lastCols = cols; e.lastRows = rows;
    clearTimeout(e.resizeTimer);
    e.resizeTimer = window.setTimeout(() => be.ptyResize(id, cols, rows), 50);
  }
}

/** Cuelga el DOM del xterm en el contenedor del panel. */
export function mount(id: string, container: HTMLElement): void {
  const e = entries.get(id);
  if (!e) return;
  container.appendChild(e.el);
  e.mounted = true;
  requestAnimationFrame(() => {
    fitNow(id);
    acquireWebgl(e);
    e.term.refresh(0, e.term.rows - 1);
  });
}

export function unmount(id: string): void {
  const e = entries.get(id);
  if (!e) return;
  e.mounted = false;
  releaseWebgl(e);
  getStash().appendChild(e.el);
}

export function focus(id: string): void { entries.get(id)?.term.focus(); }

export function dispose(id: string): void {
  const e = entries.get(id);
  if (!e) return;
  releaseWebgl(e);
  e.term.dispose();
  e.el.remove();
  entries.delete(id);
  be.ptyClose(id);
}

export function setFontSize(size: number): void {
  applyOptions({ ...opts, fontSize: size });
}

/** Aplica las opciones a todas las terminales abiertas (y a las que se creen después) y reajusta su tamaño. */
export function applyOptions(o: TermOptions): void {
  const themeChanged = o.theme !== opts.theme; // themeOf() devuelve siempre el mismo objeto por tema
  opts = o;
  for (const e of entries.values()) {
    const t = e.term.options;
    if (t.fontFamily !== o.fontFamily) t.fontFamily = o.fontFamily;
    if (t.fontSize !== o.fontSize) t.fontSize = o.fontSize;
    if (t.lineHeight !== o.lineHeight) t.lineHeight = o.lineHeight;
    if (t.cursorStyle !== o.cursorStyle) t.cursorStyle = o.cursorStyle;
    if (t.cursorBlink !== o.cursorBlink) t.cursorBlink = o.cursorBlink;
    if (t.scrollback !== o.scrollback) t.scrollback = o.scrollback;
    if (themeChanged) t.theme = { ...o.theme };
    fitNow(e.id);
  }
}

export function findNext(id: string, q: string, back = false): boolean {
  const e = entries.get(id);
  if (!e || !q) return false;
  const o = { decorations: { matchBackground: '#f5b94255', activeMatchBackground: '#f5b942', matchOverviewRuler: '#f5b942', activeMatchColorOverviewRuler: '#f5b942' } };
  return back ? e.search.findPrevious(q, o) : e.search.findNext(q, o);
}
export function clearSearch(id: string): void { entries.get(id)?.search.clearDecorations(); }
export function paste(id: string, text: string): void { entries.get(id)?.term.paste(text); }
export function selection(id: string): string { return entries.get(id)?.term.getSelection() ?? ''; }
