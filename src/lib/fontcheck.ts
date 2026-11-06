// ¿Está instalada una fuente? Se mide el ancho de un texto con la fuente y con dos respaldos distintos: si la fuente no existe,
// el navegador usa el respaldo y el ancho coincide con el suyo. (`document.fonts.check` no sirve: dice «sí» para fuentes inexistentes.)

const SAMPLE = 'mmmmmmmmmmlliWWiiOO0@#{}[]';
let ctx: CanvasRenderingContext2D | null | undefined;

function width(font: string): number {
  if (ctx === undefined) ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  if (!ctx) return 0;
  ctx.font = font;
  return ctx.measureText(SAMPLE).width;
}

const cache = new Map<string, boolean>();

/** `true` si la fuente de ese nombre está instalada (o si no se puede medir: entonces no se marca nada como faltante). */
export function isFontInstalled(name: string): boolean {
  const key = name.toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const n = name.replace(/['"\\]/g, '');
  const a = width(`72px '${n}', monospace`);
  const b = width('72px monospace');
  const c = width(`72px '${n}', serif`);
  const d = width('72px serif');
  // Sin canvas (ancho 0) no se puede saber: se da por buena.
  const ok = a === 0 && b === 0 ? true : a !== b || c !== d;
  cache.set(key, ok);
  return ok;
}
