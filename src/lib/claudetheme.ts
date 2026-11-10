// Temas de Claude Code a partir de los temas del terminal de Orchestra. Módulo puro: se prueba con node --test.
//
// Claude Code (2.1.3xx) lee temas propios de `<CLAUDE_CONFIG_DIR>/themes/<slug>.json`:
//   { "name": "…", "base": "dark" | "light", "overrides": { "<clave>": "#rrggbb", … } }
// y se eligen con /theme (salen como `custom:<slug>`). Cada clave es un uso (texto, código en línea y avisos de permiso =
// `permission`, naranja de Claude, bordes, diffs, fondo de tus mensajes…); el markdown no tiene colores propios: títulos,
// negrita y cursiva van en el color del texto.
//
// La traducción mantiene la función de cada color de serie de Claude y toma el color de la paleta del tema:
// - grises → la mezcla de fondo y texto del tema a la misma altura que el gris de serie entre negro y blanco;
// - colores → el tono de la paleta ANSI del tema más cercano (o la mezcla de los dos vecinos: el naranja de Claude sale de
//   rojo + amarillo del tema); los de primer plano con contraste ≥ 3:1 sobre el fondo, los de fondo (diffs, selección…) en
//   la misma proporción de contraste entre fondo y texto que en Claude;
// - los «shimmer» (brillo de las animaciones) → su color base aclarado.

import { CLAUDE_DARK, CLAUDE_LIGHT } from './claudedefaults.ts';
import { allThemes, resolveTheme } from './themes.ts';
import type { TermTheme, ThemeDef } from './themes.ts';

export interface ClaudeTheme {
  name: string;
  base: 'dark' | 'light';
  overrides: Record<string, string>;
}

type RGB = [number, number, number];

/** Claves que Claude usa de fondo (detrás de texto): se igualan en luminosidad, no en contraste. */
const BG_KEYS = new Set([
  'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed', 'diffAddedWord', 'diffRemovedWord', 'selectionBg',
  'userMessageBackground', 'userMessageBackgroundHover', 'composerSidebarBackground', 'bashMessageBackgroundColor',
  'memoryBackgroundColor', 'rate_limit_empty', 'clawd_background',
]);

const CHROMATIC = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan'] as const;

// ---------- color ----------

export function parseColor(s: string): RGB | null {
  const t = s.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(t);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as RGB;
  m = /^#([0-9a-f]{3})$/i.exec(t);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)) as RGB;
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(t);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.min(255, v)) as RGB;
  return null;
}

export function hex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}

/** Mezcla lineal de dos colores (t = 0 → a, 1 → b). */
export const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as RGB;

function lin(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
/** Luminancia relativa (WCAG). */
export function luminance([r, g, b]: RGB): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function contrast(a: RGB, b: RGB): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** Claridad en escala de contraste: ln(Y + 0.05). La distancia entre dos colores es el logaritmo de su contraste WCAG, así
 *  que repartir aquí conserva la proporción de contraste (un fondo de diff legible en negro sigue siéndolo en Dracula). */
function lightness(c: RGB): number {
  return Math.log(luminance(c) + 0.05);
}
/** Tono (0..360) y saturación (0..1) HSL. */
function hueSat([r, g, b]: RGB): [number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return [0, 0];
  const l = (max + min) / 510;
  const s = d / 255 / (1 - Math.abs(2 * l - 1) || 1);
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, s];
}
const isNeutral = (c: RGB) => Math.max(...c) - Math.min(...c) < 24 || hueSat(c)[1] < 0.12;
const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** Mezcla de `from` hacia `to` cuya claridad queda lo más cerca posible de `target`. */
function mixToLightness(from: RGB, to: RGB, target: number): RGB {
  let lo = 0, hi = 1;
  const up = lightness(to) > lightness(from);
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const l = lightness(mix(from, to, mid));
    if ((l < target) === up) lo = mid; else hi = mid;
  }
  return mix(from, to, (lo + hi) / 2);
}

// ---------- paleta ----------

interface Swatch { c: RGB; h: number }

function palette(t: TermTheme): Swatch[] {
  const out: Swatch[] = [];
  for (const k of CHROMATIC) {
    const c = parseColor(t[k]);
    if (!c || isNeutral(c)) continue;
    out.push({ c, h: hueSat(c)[0] });
  }
  return out;
}

/** El color de la paleta para un tono: el más cercano, o la mezcla de los dos que lo rodean si ninguno está a ≤ 8°. */
function paletteHue(pal: Swatch[], h: number, wantL: number): RGB | null {
  if (!pal.length) return null;
  // Entre colores del mismo tono (normal y brillante), el de claridad más parecida a la de Claude.
  const pick = (cands: Swatch[]) => cands.reduce((a, b) => (Math.abs(lightness(a.c) - wantL) <= Math.abs(lightness(b.c) - wantL) ? a : b));
  const near = pal.filter((s) => hueDist(s.h, h) <= 8);
  if (near.length) return pick(near).c;
  // Vecinos a cada lado del tono pedido.
  const signed = (s: Swatch) => { let d = s.h - h; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
  const below = pal.filter((s) => signed(s) < 0), above = pal.filter((s) => signed(s) > 0);
  if (!below.length || !above.length) return pick(pal.slice().sort((a, b) => hueDist(a.h, h) - hueDist(b.h, h)).slice(0, 2)).c;
  const nb = Math.max(...below.map(signed)), na = Math.min(...above.map(signed));
  // Vecinos demasiado lejos (más de 120° entre ellos): no se inventa un tono, se toma el más cercano.
  if (na - nb > 120) return (Math.abs(nb) <= na ? pick(below.filter((s) => signed(s) === nb)) : pick(above.filter((s) => signed(s) === na))).c;
  const a = pick(below.filter((s) => signed(s) === nb)).c, b = pick(above.filter((s) => signed(s) === na)).c;
  return mix(a, b, -nb / (na - nb));
}

// ---------- traducción ----------

const SHIMMER = /(?:Shimmer|_shimmer)(?=_FOR_|$)/;

/** Clave base de un «shimmer»: claudeShimmer → claude, claudeBlueShimmer_FOR_SYSTEM_SPINNER → claudeBlue_FOR_SYSTEM_SPINNER. */
export function shimmerBase(key: string): string | null {
  return SHIMMER.test(key) ? key.replace(SHIMMER, '') : null;
}

export function claudeThemeFor(name: string, t: TermTheme): ClaudeTheme {
  const bg = parseColor(t.background) ?? [0, 0, 0];
  const fg = parseColor(t.foreground) ?? [255, 255, 255];
  const dark = luminance(bg) < luminance(fg);
  const ref = dark ? CLAUDE_DARK : CLAUDE_LIGHT;
  const refBg: RGB = dark ? [0, 0, 0] : [255, 255, 255];
  const refFg: RGB = dark ? [255, 255, 255] : [0, 0, 0];
  const [lBg, lFg, lRefBg, lRefFg] = [lightness(bg), lightness(fg), lightness(refBg), lightness(refFg)];
  // Altura de un color de Claude entre su fondo y su texto, llevada a la del tema.
  const rel = (c: RGB) => Math.min(1, Math.max(0, (lightness(c) - lRefBg) / (lRefFg - lRefBg)));
  const atRel = (c: RGB) => lBg + rel(c) * (lFg - lBg);
  const pal = palette(t);
  const lighter = lightness(fg) > lightness(bg) ? fg : bg;
  const textMin = Math.min(4.5, 0.8 * contrast(fg, bg));

  const out: Record<string, string> = {};
  const computed: Record<string, RGB> = {};
  const keys = Object.keys(ref);
  // Primero los colores base, después los «shimmer» (salen de su base ya traducida).
  for (const key of [...keys.filter((k) => !shimmerBase(k)), ...keys.filter((k) => shimmerBase(k))]) {
    const c = parseColor(ref[key])!;
    const base = shimmerBase(key);
    let v: RGB;
    if (base && computed[base]) {
      v = mix(computed[base], lighter, 0.35);
    } else if (isNeutral(c)) {
      v = mixToLightness(bg, fg, atRel(c));
    } else if (BG_KEYS.has(key)) {
      // Fondo con el tono de la paleta y la proporción de contraste de Claude (un diff verde oscuro sigue siendo oscuro).
      // Si esa claridad queda entre el fondo y el color, se mezclan los dos; si queda más allá, el color va hacia el texto.
      const want = atRel(c);
      const p = paletteHue(pal, hueSat(c)[0], want) ?? c;
      const lp = lightness(p);
      v = (want - lBg) * (lp - want) >= 0 ? mixToLightness(bg, p, want) : mixToLightness(p, fg, want);
    } else {
      const p = paletteHue(pal, hueSat(c)[0], lightness(c)) ?? c;
      v = p;
      // Primer plano legible: contraste ≥ 3:1 con el fondo; si no llega, se acerca al color del texto.
      for (let i = 1; contrast(v, bg) < 3 && i <= 10; i++) v = mix(p, fg, i / 10);
    }
    if (BG_KEYS.has(key)) {
      // Detrás de texto: el texto encima se tiene que leer (≥ 4.5:1, o el 80 % del contraste del tema si este no da más).
      const from = v;
      for (let i = 1; contrast(fg, v) < textMin && i <= 20; i++) v = mix(from, bg, i / 20);
    }
    computed[key] = v;
    out[key] = hex(v);
  }
  return { name, base: dark ? 'dark' : 'light', overrides: out };
}

/** Nombre del archivo (sin .json) y del tema en Claude: `custom:orchestra-<id>`. */
export function claudeThemeSlug(id: string): string {
  return 'orchestra-' + id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Tema que sigue al del terminal: Orchestra lo reescribe al cambiar de tema; en Claude se elige una vez. */
export const FOLLOW_SLUG = 'orchestra-terminal';

export interface ClaudeThemeFile {
  /** Nombre del archivo sin .json (= `custom:<slug>` en Claude). */
  slug: string;
  json: string;
}

/** Todos los archivos de tema: uno por tema de Orchestra (de serie y propios) y el que sigue al del terminal. */
export function claudeThemeFiles(custom: readonly ThemeDef[], currentId: string, followName: string): ClaudeThemeFile[] {
  const file = (slug: string, name: string, t: TermTheme): ClaudeThemeFile => ({ slug, json: `${JSON.stringify(claudeThemeFor(name, t), null, 2)}
` });
  const out = allThemes(custom).map((e) => file(claudeThemeSlug(e.id), e.id === 'orchestra' ? e.label : `Orchestra · ${e.label}`, e.theme));
  out.push(file(FOLLOW_SLUG, followName, resolveTheme(currentId, custom)));
  // Dos temas propios cuyo nombre da el mismo slug: se queda el primero.
  const seen = new Set<string>();
  return out.filter((f) => !seen.has(f.slug) && seen.add(f.slug));
}
