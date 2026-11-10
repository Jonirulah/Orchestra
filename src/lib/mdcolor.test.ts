import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MD_MIN_CONTRAST, MdColorizer, isClaudePane, mdPalette } from './mdcolor.ts';
import type { MdPalette } from './mdcolor.ts';
import { contrast, hex, parseColor } from './claudetheme.ts';
import { allThemes, themeOf } from './themes.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PAL: MdPalette = { h1: [1, 1, 1], bold: [2, 2, 2], italic: [3, 3, 3], text: [[200, 200, 200], [255, 255, 255], [0, 0, 0]] };
const H1 = '\x1b[38;2;1;1;1m', BOLD = '\x1b[38;2;2;2;2m', ITAL = '\x1b[38;2;3;3;3m';

/** Pasa un texto por un reescritor nuevo, en trozos de `step` bytes (0 = de una vez). */
function run(s: string, step = 0, pal: MdPalette | null = PAL, md = new MdColorizer()): string {
  const b = enc.encode(s);
  if (!step) return dec.decode(md.feed(b, pal));
  const parts: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += step) parts.push(md.feed(b.subarray(i, i + step), pal));
  return dec.decode(Buffer.concat(parts));
}
/** Quita los SGR insertados por el reescritor (colores de PAL y las restauraciones que siguen a un SGR). */
function strip(s: string): string {
  return s.replace(/\x1b\[38;2;[123];[123];[123]m/g, '').replace(/(\x1b\[[0-9;:]*m)\x1b\[(39|38;2;200;200;200|38;2;255;255;255)m/g, '$1');
}

test('bold, italic and # title in the default foreground get their colors; the reset puts the default back', () => {
  assert.equal(run('a \x1b[1mB\x1b[22m c'), `a \x1b[1m${BOLD}B\x1b[22m\x1b[39m c`);
  assert.equal(run('\x1b[3mi\x1b[23m'), `\x1b[3m${ITAL}i\x1b[23m\x1b[39m`);
  // Título `#` tal cual lo manda Claude: tres SGR seguidos; pasa por negrita y negrita+cursiva antes de llegar a título.
  assert.equal(run('\x1b[1m\x1b[3m\x1b[4mT\x1b[24m\x1b[23mS\x1b[22mn'),
    `\x1b[1m${BOLD}\x1b[3m\x1b[4m${H1}T\x1b[24m${BOLD}\x1b[23mS\x1b[22m\x1b[39mn`);
  // Todo en un SGR.
  assert.equal(run('\x1b[1;3;4mT\x1b[0mx'), `\x1b[1;3;4m${H1}T\x1b[0mx`);
});

test('every reset: 0, 22, 23, 24 and 39 after an explicit color', () => {
  // 0 ya pone el primer plano por defecto: no hace falta insertar nada.
  assert.equal(run('\x1b[1mB\x1b[0mx'), `\x1b[1m${BOLD}B\x1b[0mx`);
  assert.equal(run('\x1b[mx\x1b[1mB\x1b[mx'), `\x1b[mx\x1b[1m${BOLD}B\x1b[mx`);
  assert.equal(run('\x1b[1;3mB\x1b[22mI\x1b[23mx'), `\x1b[1;3m${BOLD}B\x1b[22m${ITAL}I\x1b[23m\x1b[39mx`);
  assert.equal(run('\x1b[1;3;4mT\x1b[24mB'), `\x1b[1;3;4m${H1}T\x1b[24m${BOLD}B`);
  // Negrita en rojo: no se toca; al volver al primer plano por defecto (39) dentro de la negrita, sí.
  assert.equal(run('\x1b[1m\x1b[31mR\x1b[39mB\x1b[22m'), `\x1b[1m${BOLD}\x1b[31mR\x1b[39m${BOLD}B\x1b[22m\x1b[39m`);
  // 4:0 = sin subrayado (forma con «:»).
  assert.equal(run('\x1b[1;3;4mT\x1b[4:0mB'), `\x1b[1;3;4m${H1}T\x1b[4:0m${BOLD}B`);
});

test('explicit colors are never touched (16, 256, truecolor with ; and :, background does not count)', () => {
  for (const c of ['31', '91', '38;5;196', '38;2;255;0;0', '38:2::255:0:0', '38:2:255:0:0', '38:5:196']) {
    const s = `\x1b[${c}m\x1b[1mB\x1b[3mI\x1b[22;23mx`;
    assert.equal(run(s), s, c);
  }
  // El fondo o el color del subrayado no son color de texto: la negrita se pinta igual.
  assert.equal(run('\x1b[48;2;9;9;9;1mB'), `\x1b[48;2;9;9;9;1m${BOLD}B`);
  assert.equal(run('\x1b[48;5;9;1mB'), `\x1b[48;5;9;1m${BOLD}B`);
  assert.equal(run('\x1b[58:2::9:9:9;1mB'), `\x1b[58:2::9:9:9;1m${BOLD}B`);
  // Vídeo inverso: el primer plano es el fondo de la celda; no se pinta.
  assert.equal(run('\x1b[7;1mB\x1b[27mb'), `\x1b[7;1mB\x1b[27m${BOLD}b`);
});

test('the "text" color of Claude counts as no color, and is what comes back afterwards', () => {
  assert.equal(run('\x1b[38;2;200;200;200m\x1b[1mB\x1b[22mx'), `\x1b[38;2;200;200;200m\x1b[1m${BOLD}B\x1b[22m\x1b[38;2;200;200;200mx`);
  assert.equal(run('\x1b[38;2;255;255;255;3mI\x1b[23m'), `\x1b[38;2;255;255;255;3m${ITAL}I\x1b[23m\x1b[38;2;255;255;255m`);
});

test('split anywhere (escape sequences, UTF-8 characters): same bytes as in one piece', () => {
  const s = 'ñ€😀 \x1b[1mnegrita ñ\x1b[22m \x1b[38:2::255:0:0m\x1b[1mroja\x1b[0m \x1b]0;título\x07\x1b[?25l\x1b[1;3;4m# 標題\x1b[0m \x1b[3mcursiva\x1b[23m';
  const whole = run(s);
  for (const step of [1, 2, 3, 5, 7, 13]) assert.equal(run(s, step), whole, `step ${step}`);
  assert.equal(strip(whole), s, 'solo se insertan SGR completos');
});

test('private and non-SGR CSI sequences pass through without changing the state', () => {
  const s = '\x1b[?1m\x1b[>4m\x1b[1;5H\x1b[2Jx';
  assert.equal(run(s), s);
  assert.equal(run('\x1b[1m\x1b[>0mB'), `\x1b[1m${BOLD}\x1b[>0mB`);
});

test('turning it off restores the real color at the next SGR; non-Claude output is never colored', () => {
  const md = new MdColorizer();
  assert.equal(run('\x1b[1mB', 0, PAL, md), `\x1b[1m${BOLD}B`);
  assert.equal(run('b\x1b[3mI', 0, null, md), 'b\x1b[3m\x1b[39mI');
  assert.equal(run('\x1b[1mB\x1b[3mI\x1b[0m', 0, null), '\x1b[1mB\x1b[3mI\x1b[0m');
  const raw = enc.encode('no escapes here');
  assert.equal(new MdColorizer().feed(raw, PAL), raw, 'mismo array si no hay nada que hacer');
});

test('only Claude agent panes get the rewriter', () => {
  const accs = [{ id: 'c', provider: 'claude' as const }, { id: 'x', provider: 'codex' as const }, { id: 'o', provider: 'opencode' as const }];
  assert.equal(isClaudePane({ kind: 'agent', ref: 'c' }, accs), true);
  assert.equal(isClaudePane({ kind: 'agent', ref: 'x' }, accs), false);
  assert.equal(isClaudePane({ kind: 'agent', ref: 'o' }, accs), false);
  assert.equal(isClaudePane({ kind: 'agent', ref: 'codex' }, accs), false);
  assert.equal(isClaudePane({ kind: 'shell', ref: 'c' }, accs), false);
  assert.equal(isClaudePane({ kind: 'ssh', ref: 'c' }, accs), false);
});

test('all 21 terminal themes: three different markdown colors with contrast >= 4.5:1', () => {
  const themes = allThemes([]);
  assert.equal(themes.length, 21);
  for (const e of themes) {
    const p = mdPalette(e.theme);
    const bg = parseColor(e.theme.background)!;
    for (const k of ['h1', 'bold', 'italic'] as const) assert.ok(contrast(p[k], bg) >= MD_MIN_CONTRAST, `${e.id}.${k} ${contrast(p[k], bg).toFixed(2)}`);
    assert.equal(new Set([p.h1, p.bold, p.italic].map((c) => c.join())).size, 3, e.id);
    assert.deepEqual(p.text[0], parseColor(e.theme.foreground), e.id);
    // De la paleta del tema: cada color es uno de sus 12 ANSI de color o una mezcla de uno con el texto (si no llegaba a 4,5:1).
    const ansi = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'].flatMap((k) => [k, 'bright' + k[0].toUpperCase() + k.slice(1)])
      .map((k) => (e.theme as unknown as Record<string, string>)[k].toLowerCase());
    for (const k of ['h1', 'bold', 'italic'] as const) if (contrast(p[k], bg) >= MD_MIN_CONTRAST + 0.5) assert.ok(ansi.includes(hex(p[k])), `${e.id}.${k} ${hex(p[k])}`);
  }
  // Los «amarillos» marrón oscuro de GitHub Light se leen como el texto: la negrita toma el rojo; la cursiva de Orchestra, el cian.
  assert.equal(hex(mdPalette(themeOf('githublight')).bold), '#cf222e');
  assert.equal(hex(mdPalette(themeOf('orchestra')).italic), '#5fd4d4');
  // Solarized: sus «brillantes» son grises y no cuentan.
  for (const id of ['solarized', 'solarizedlight'] as const) for (const c of Object.values(mdPalette(themeOf(id))).slice(0, 3)) assert.ok(!['#93a1a1', '#586e75', '#839496', '#657b83'].includes(hex(c as never)), id);
});

// ---------- capturas reales de Claude Code 2.1.322 (docs/dev-notes/fixtures_claude/capture.py) ----------

const FIX = new URL('../../docs/dev-notes/fixtures_claude/', import.meta.url);
const FIXTURES: [string, string][] = [
  ['claude-2.1.322-dark.bin', 'orchestra'],
  ['claude-2.1.322-orchestra-terminal.bin', 'orchestra'],
  ['claude-2.1.322-orchestra-githublight.bin', 'githublight'],
];

/** Texto pintado con cada color de la paleta (los saltos de cursor de ConPTY cuentan como espacio). */
function painted(out: string, pal: MdPalette): Record<'h1' | 'bold' | 'italic', string[]> {
  const res = { h1: [] as string[], bold: [] as string[], italic: [] as string[] };
  const key = (p: string) => (['h1', 'bold', 'italic'] as const).find((k) => p === `38;2;${pal[k].join(';')}`);
  let cur: 'h1' | 'bold' | 'italic' | undefined, acc = '';
  const flush = () => { if (cur && acc.trim()) res[cur].push(acc.trim()); acc = ''; };
  const re = /\x1b\[([0-9;:?<>=]*)([@-~])|\x1b[^[]|([^\x1b]+)/g;
  for (let m; (m = re.exec(out));) {
    if (m[3]) { if (cur) acc += m[3].replace(/[\r\n]+/g, ' '); continue; }
    if (m[2] === 'G' || m[2] === 'C') { if (cur) acc += ' '; continue; }
    if (m[2] !== 'm') continue;
    const k = key(m[1]);
    // Solo nuestro SGR exacto marca color nuestro (Claude puede usar a propósito el mismo color, p. ej. «auto mode on»).
    if (k) { flush(); cur = k; } else if (/(^|;)(0|39|3[0-7]|9[0-7]|38)([;:]|$)/.test(m[1]) || m[1] === '') { flush(); cur = undefined; }
  }
  flush();
  return res;
}

test('real Claude Code output: title, bold and italic painted, code and explicit colors untouched, bytes preserved', () => {
  for (const [file, theme] of FIXTURES) {
    const raw = readFileSync(new URL(file, FIX));
    const pal = mdPalette(themeOf(theme as never));
    const md = new MdColorizer();
    const outs: Uint8Array[] = [];
    for (let i = 0; i < raw.length; i += 11) outs.push(md.feed(raw.subarray(i, i + 11), pal));
    const out = Buffer.concat(outs);
    assert.deepEqual(out, Buffer.from(new MdColorizer().feed(raw, pal)), `${file}: trozos = de una vez`);
    // Solo inserciones de SGR completos, siempre justo detrás de un SGR de la captura.
    const md2 = new MdColorizer();
    let n = 0;
    for (let i = 0; i < raw.length; i += 11) {
      md2.feed(raw.subarray(i, i + 11), pal);
      for (const x of md2.lastInserts ?? []) {
        n++;
        assert.match(x.s, /^\x1b\[(39|38;2;\d+;\d+;\d+)m$/, file);
        assert.equal(raw[i + x.at - 1], 0x6d, `${file}: detrás de un SGR`);
      }
    }
    assert.equal(out.length - raw.length, outs.reduce((a, o, k) => a + o.length - Math.min(11, raw.length - k * 11), 0));
    assert.ok(n > 10, `${file}: ${n} inserciones`);
    const p = painted(out.toString('utf8'), pal);
    assert.deepEqual(p.h1, ['Nota de prueba'], `${file}: título #`);
    assert.ok(p.bold.includes('Hola'), `${file}: negrita`);
    assert.ok(p.bold.some((x) => /^(Contenido|Saludo)/.test(x)), `${file}: título ##`);
    assert.ok(p.italic.some((x) => ['breve', 'simple', 'texto'].includes(x)), `${file}: cursiva`);
    // El código en línea (truecolor de Claude) y lo que va en gris explícito no se pintan.
    for (const runs of Object.values(p)) for (const r of runs) assert.ok(!/^nota\.txt$|^Read$|Baked|Cooked|Worked/.test(r), `${file}: ${r}`);
  }
});
