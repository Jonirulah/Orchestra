// Lista de fuentes de Ajustes → Terminal: las instaladas en el sistema (DirectWrite, desde Rust) más las de la lista de
// siempre (FONT_PRESETS). Solo se ofrece lo que el WebView puede pintar de verdad (`usable`, medido en un canvas): una
// fuente instalada con Orchestra abierto la lista Rust, pero el WebView no la ve hasta reiniciar Orchestra. Si es
// monoespaciada también se mide (`mono`): el dato de Windows falla con fuentes reales.

/** Una familia instalada, como la devuelve `list_fonts`. */
export interface InstalledFont {
  name: string;
  /** Instalada después de arrancar Orchestra. */
  newSinceStart: boolean;
}

export interface FontGroups {
  /** Monoespaciadas que se pueden usar ya. */
  mono: string[];
  /** Instaladas y usables, pero no monoespaciadas (las letras no cuadran en columnas). */
  other: string[];
  /** Instaladas con Orchestra abierto: hay que reiniciarlo para usarlas. */
  restart: string[];
  /** De la lista de siempre, sin instalar. */
  missing: string[];
}

const low = (s: string) => s.toLowerCase();
const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' });

function uniq(names: string[], skip: Set<string> = new Set()): string[] {
  const seen = new Set(skip);
  const out: string[] = [];
  for (const n of names) {
    if (seen.has(low(n))) continue;
    seen.add(low(n));
    out.push(n);
  }
  return out.sort(byName);
}

export function groupFonts(system: readonly InstalledFont[], presets: readonly string[], usable: (name: string) => boolean,
  mono: (name: string) => boolean): FontGroups {
  const restart = uniq(system.filter((f) => f.newSinceStart && !usable(f.name)).map((f) => f.name));
  const restartSet = new Set(restart.map(low));
  const ok = system.filter((f) => !restartSet.has(low(f.name)) && usable(f.name));
  const monoList = uniq([...ok.filter((f) => mono(f.name)).map((f) => f.name), ...presets.filter((p) => usable(p))]);
  const monoSet = new Set(monoList.map(low));
  const other = uniq(ok.filter((f) => !mono(f.name)).map((f) => f.name), monoSet);
  const missing = uniq(presets.filter((p) => !usable(p) && !restartSet.has(low(p))));
  return { mono: monoList, other, restart, missing };
}

/** El primer nombre de una lista CSS de fuentes, sin comillas. */
export function firstFamily(css: string): string {
  return css.split(',')[0].replace(/['"]/g, '').trim();
}
