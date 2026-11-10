// Color para el markdown de Claude Code, pintado «por encima» en el propio terminal. Módulo puro: se prueba con node --test.
//
// Claude Code (2.1.322, comprobado con capturas reales en docs/dev-notes/fixtures_claude/) no da color al markdown, solo
// estilo, y el texto va en el primer plano POR DEFECTO del terminal (SGR 39), no en truecolor:
//   título `#`  = ESC[1m ESC[3m ESC[4m   (negrita + cursiva + subrayado)
//   `##`…       = ESC[1m                 (como la negrita)
//   **negrita** = ESC[1m … ESC[22m
//   *cursiva*   = ESC[3m … ESC[23m
//   `código`    = truecolor propio (no se toca)
// El reescritor sigue el estado SGR de la salida y, cuando el texto no trae color propio (primer plano por defecto o el
// color «text» de Claude), añade tras cada SGR un color de la paleta del tema para el título, la negrita o la cursiva, y lo
// quita (vuelve al color real) cuando deja de aplicar. Nunca modifica ni quita bytes de la salida: solo inserta SGR
// completos detrás de un SGR ya terminado, así que un trozo partido a mitad de secuencia o de un carácter UTF-8 pasa tal
// cual (xterm lo junta) y el estado del analizador se conserva entre trozos.

import { contrast, luminance, mix, parseColor } from './claudetheme.ts';
import type { TermTheme } from './themes.ts';
import { providerOf } from './model.ts';
import type { Account, Pane } from './model.ts';

type RGB = [number, number, number];

export interface MdPalette {
  /** Título `#` (negrita + cursiva + subrayado). */
  h1: RGB;
  /** Negrita (y títulos `##`…). */
  bold: RGB;
  /** Cursiva. */
  italic: RGB;
  /** Colores truecolor que cuentan como «sin color propio» (el «text» de Claude: el primer plano del tema, blanco, negro). */
  text: RGB[];
}

// ---------- paleta ----------

type AnsiKey = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'brightRed' | 'brightGreen' | 'brightYellow'
  | 'brightBlue' | 'brightMagenta' | 'brightCyan';

/** Candidatos de cada uso, por orden. El azul/violeta lo usa ya Claude para el código en línea: va el último. */
export const MD_CANDIDATES: Record<'h1' | 'bold' | 'italic', AnsiKey[]> = {
  h1: ['magenta', 'brightMagenta', 'red', 'brightRed', 'blue', 'brightBlue'],
  bold: ['yellow', 'brightYellow', 'red', 'brightRed', 'green', 'brightGreen'],
  italic: ['cyan', 'brightCyan', 'green', 'brightGreen', 'blue', 'brightBlue'],
};
/** Contraste mínimo contra el fondo (WCAG AA para texto). */
export const MD_MIN_CONTRAST = 4.5;

const same = (a: RGB, b: RGB) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** Claridad CIE L* (0 negro … 100 blanco) a partir de la luminancia relativa. */
function lstar(c: RGB): number {
  const y = luminance(c);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}
/** Gris o casi gris (los «brillantes» de Solarized son grises): no sirve para dar color. */
function neutral(c: RGB): boolean {
  const mx = Math.max(...c), mn = Math.min(...c);
  if (mx - mn < 24) return true;
  const l = (mx + mn) / 510;
  return (mx - mn) / 255 / (1 - Math.abs(2 * l - 1) || 1) < 0.16;
}

/**
 * Colores del markdown para un tema: para cada uso, el primer candidato de su paleta ANSI (no gris, distinto de los ya
 * elegidos) con contraste ≥ 4,5:1 contra el fondo que además se distinga del texto: claro (L* ≥ 60, el tono se ve) o a ≥ 15
 * de claridad del texto. En los temas claros esto descarta los «amarillos» marrón oscuro (GitHub Light: #4d2d00 junto a un
 * texto #24292f se lee como texto). Si ninguno se distingue, el primero con contraste; si ninguno llega a 4,5:1, el de más
 * contraste acercado al color del texto lo justo para llegar (sigue siendo de su tono).
 */
export function mdPalette(t: TermTheme): MdPalette {
  const bg = parseColor(t.background) ?? [0, 0, 0];
  const fg = parseColor(t.foreground) ?? [255, 255, 255];
  const lfg = lstar(fg);
  const taken: RGB[] = [];
  const readable = (c: RGB) => contrast(c, bg) >= MD_MIN_CONTRAST;
  const visible = (c: RGB) => lstar(c) >= 60 || Math.abs(lstar(c) - lfg) >= 15;
  const pick = (keys: AnsiKey[]): RGB => {
    const cands = keys.map((k) => parseColor(t[k])).filter((c): c is RGB => !!c && !neutral(c) && !taken.some((x) => same(x, c)));
    // (taken guarda también el candidato del que sale una mezcla: dos usos no salen del mismo color)
    let c = cands.find((x) => readable(x) && visible(x)) ?? cands.find(readable);
    if (!c) {
      const best = cands.reduce<RGB | null>((a, x) => (!a || contrast(x, bg) > contrast(a, bg) ? x : a), null) ?? fg;
      c = best;
      for (let i = 1; !readable(c) && i <= 20; i++) c = mix(best, fg, i / 20);
      taken.push(best);
    }
    taken.push(c);
    return c;
  };
  const h1 = pick(MD_CANDIDATES.h1);
  const bold = pick(MD_CANDIDATES.bold);
  const italic = pick(MD_CANDIDATES.italic);
  return { h1, bold, italic, text: [fg, [255, 255, 255], [0, 0, 0]] };
}

/**
 * ¿Es un panel de Claude Code? Paneles de agente cuya cuenta es de Claude (como el pegado de imágenes: una cuenta que ya
 * no existe cuenta como Claude). Codex, opencode, shells y SSH: nunca.
 */
export function isClaudePane(p: Pick<Pane, 'kind' | 'ref'>, accounts: readonly Pick<Account, 'id' | 'provider'>[]): boolean {
  if (p.kind !== 'agent' || p.ref === 'codex') return false;
  return providerOf(accounts.find((a) => a.id === p.ref)) === 'claude';
}

// ---------- reescritor ----------

const ESC = 0x1b;
const LBRACKET = 0x5b; // [
const MAX_CSI = 96; // un SGR real cabe de sobra; más largo = no se analiza (pasa tal cual)

// Estados del analizador y del primer plano (constantes: node --test solo quita tipos, no admite enum).
const GROUND = 0, IN_ESC = 1, IN_CSI = 2;
/** Primer plano real (el que pide la salida): por defecto, el «text» de Claude (con su SGR para restaurarlo) u otro color. */
const Fg = { Default: 0, Text: 1, Other: 2 } as const;

export class MdColorizer {
  private st: number = GROUND;
  /** Parámetros del CSI en curso (pueden llegar en varios trozos). */
  private buf = new Uint8Array(MAX_CSI);
  private len = 0;
  private bad = false;
  private P = new Int32Array(32);
  private S = new Uint8Array(32);
  // Estado SGR real
  private bold = false;
  private italic = false;
  private under = false;
  private inverse = false;
  private fg: number = Fg.Default;
  private fgSgr = '';
  /** Color que hemos puesto encima (null = el terminal tiene el primer plano real). */
  private painted: RGB | null = null;
  /** Inserciones del último `feed` (posición en el trozo de entrada y SGR): para las pruebas. */
  lastInserts: { at: number; s: string }[] | null = null;
  /** Colores «text» de la última paleta (sirven aunque se apague el color, para restaurar bien). */
  private textCols: RGB[] = [];

  /** Reinicia el estado (proceso nuevo en el panel). */
  reset(): void {
    this.st = GROUND; this.len = 0; this.bad = false;
    this.bold = this.italic = this.under = this.inverse = false;
    this.fg = Fg.Default; this.fgSgr = ''; this.painted = null;
  }

  /**
   * Procesa un trozo de salida. `pal` = null: no se pinta (si había color puesto, se quita en el siguiente SGR).
   * Devuelve el mismo array si no hay nada que insertar.
   */
  feed(b: Uint8Array, pal: MdPalette | null): Uint8Array {
    this.lastInserts = null;
    let st = this.st;
    // Camino rápido: sin ESC y fuera de una secuencia no hay nada que mirar.
    if (st === GROUND && b.indexOf(ESC) < 0) return b;
    if (pal) this.textCols = pal.text;
    const buf = this.buf;
    let len = this.len, bad = this.bad;
    let inserts: { at: number; s: string }[] | null = null;
    const n = b.length;
    for (let i = 0; i < n; i++) {
      const c = b[i];
      if (st === GROUND) {
        if (c !== ESC) {
          // Hasta el siguiente ESC: a mano (los tramos de texto de Claude son cortos y la llamada a indexOf pesa más).
          let j = i + 1;
          while (j < n && b[j] !== ESC) j++;
          if (j >= n) break;
          i = j;
        }
        st = IN_ESC;
      } else if (st === IN_ESC) {
        if (c === LBRACKET) {
          st = IN_CSI; len = 0; bad = false;
          // Parámetros seguidos, sin pasar por el despacho de cada byte.
          let j = i + 1;
          for (let d = b[j]; j < n && d >= 0x30 && d <= 0x3b; d = b[++j]) { if (len < MAX_CSI) buf[len++] = d; else bad = true; }
          i = j - 1;
        }
        else if (c !== ESC) st = GROUND;
      } else if (c >= 0x30 && c <= 0x3b) {
        // Parámetros: dígitos, «:» y «;».
        if (len < MAX_CSI) buf[len++] = c; else bad = true;
      } else if (c >= 0x40 && c <= 0x7e) {
        st = GROUND;
        if (c === 0x6d /* m */ && !bad) {
          this.len = len;
          const s = this.sgr(pal);
          if (s) (inserts ??= []).push({ at: i + 1, s });
        }
      } else if (c === ESC) {
        st = IN_ESC;
      } else if (c === 0x18 || c === 0x1a) {
        st = GROUND; // CAN / SUB cancelan la secuencia
      } else if (c >= 0x20) {
        // Prefijo privado (? > < =) o intermedios: no es un SGR que nos importe. Un control C0 se ejecuta y la secuencia sigue.
        bad = true;
      }
    }
    this.st = st; this.len = len; this.bad = bad;
    this.lastInserts = inserts;
    if (!inserts) return b;
    let extra = 0;
    for (const x of inserts) extra += x.s.length;
    const out = new Uint8Array(n + extra);
    let from = 0, o = 0;
    for (const x of inserts) {
      out.set(b.subarray(from, x.at), o); o += x.at - from; from = x.at;
      for (let k = 0; k < x.s.length; k++) out[o++] = x.s.charCodeAt(k); // los SGR insertados son ASCII
    }
    out.set(b.subarray(from), o);
    return out;
  }

  /** Aplica el SGR recogido (buf[0..len)) al estado y devuelve el SGR a insertar detrás (o ''). */
  private sgr(pal: MdPalette | null): string {
    // Parámetros a números: P = valor (-1 = vacío), S = 1 si es subparámetro («:») del anterior.
    const P = this.P, S = this.S, buf = this.buf, len = this.len;
    let np = 0, v = -1, sub = 0;
    for (let i = 0; i <= len; i++) {
      const c = i < len ? buf[i] : 0x3b;
      if (c >= 0x30 && c <= 0x39) v = (v < 0 ? 0 : v * 10) + (c - 0x30);
      else {
        if (np < P.length) { P[np] = v > 99999 ? 99999 : v; S[np] = sub; np++; }
        v = -1; sub = c === 0x3a ? 1 : 0;
      }
    }
    let fgTouched = false;
    for (let k = 0; k < np;) {
      const n = P[k] < 0 ? 0 : P[k];
      let e = k + 1;
      while (e < np && S[e]) e++;
      const subs = e - k - 1;
      if (n === 0) {
        this.bold = this.italic = this.under = this.inverse = false;
        this.fg = Fg.Default; this.fgSgr = ''; fgTouched = true;
      } else if (n === 1) this.bold = true;
      else if (n === 22) this.bold = false;
      else if (n === 3) this.italic = true;
      else if (n === 23) this.italic = false;
      else if (n === 4) this.under = !subs || P[k + 1] > 0;
      else if (n === 21) this.under = true;
      else if (n === 24) this.under = false;
      else if (n === 7) this.inverse = true;
      else if (n === 27) this.inverse = false;
      else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) { this.fg = Fg.Other; fgTouched = true; }
      else if (n === 39) { this.fg = Fg.Default; this.fgSgr = ''; fgTouched = true; }
      else if (n === 38 || n === 48 || n === 58) {
        // Color extendido: con «:» va todo en este parámetro (38:2:r:g:b o 38:2:<espacio>:r:g:b); con «;» se come los siguientes.
        let r = -1, g = -1, bl = -1;
        if (subs) {
          if (P[k + 1] === 2) { const o = subs >= 5 ? k + 3 : k + 2; r = P[o]; g = P[o + 1]; bl = P[o + 2]; }
        } else if (P[k + 1] === 5) {
          e = k + 3;
        } else if (P[k + 1] === 2) {
          r = P[k + 2]; g = P[k + 3]; bl = P[k + 4];
          e = k + 5;
        }
        if (n === 38) {
          fgTouched = true;
          let text = false;
          if (r >= 0 && r <= 255 && g >= 0 && g <= 255 && bl >= 0 && bl <= 255) {
            for (const t of this.textCols) if (t[0] === r && t[1] === g && t[2] === bl) { text = true; break; }
          }
          if (text) { this.fg = Fg.Text; this.fgSgr = `\x1b[38;2;${r};${g};${bl}m`; }
          else { this.fg = Fg.Other; this.fgSgr = ''; }
        }
      }
      k = e;
    }
    // Tras este SGR el terminal tiene el primer plano real si lo tocó; si no, sigue con el nuestro.
    if (fgTouched) this.painted = null;
    const want = this.want(pal);
    if (want) {
      if (this.painted && same(this.painted, want)) return '';
      this.painted = want;
      return `\x1b[38;2;${want[0]};${want[1]};${want[2]}m`;
    }
    if (!this.painted) return '';
    this.painted = null;
    return this.fg === Fg.Text ? this.fgSgr : '\x1b[39m';
  }

  private want(pal: MdPalette | null): RGB | null {
    if (!pal || this.inverse || this.fg === Fg.Other) return null;
    if (this.bold && this.italic && this.under) return pal.h1;
    if (this.bold) return pal.bold;
    if (this.italic) return pal.italic;
    return null;
  }
}
