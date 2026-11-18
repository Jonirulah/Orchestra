// Emulador de la TUI de Claude Code (pantalla alternativa, como 2.1.x) para medir Orchestra.
// Uso: node emu.cjs <cuentaDir> <n>   (escribe sessions/<pid>.json y una transcripción que crece)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const acct = process.argv[2], n = +process.argv[3] || 0;
const sid = crypto.randomUUID();
const proj = path.join(acct, 'projects', 'E--fake-proj' + n);
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(path.join(acct, 'sessions'), { recursive: true });
const tp = path.join(proj, sid + '.jsonl');
const sessF = path.join(acct, 'sessions', process.pid + '.json');
let status = 'busy';
const writeSess = () => fs.writeFileSync(sessF, JSON.stringify({ pid: process.pid, sessionId: sid, cwd: 'E:\\fake\\proj' + n, startedAt: Date.now(), status, name: 'emu' + n }));
writeSess();
process.on('exit', () => { try { fs.unlinkSync(sessF); } catch {} });
process.on('SIGINT', () => process.exit(0));
// transcripción inicial grande (~4 MB) para parecerse a las reales
const now = () => new Date().toISOString();
let turn = 0;
const openTasks = [];
function entry(kind, closeAll) {
  turn++;
  if (kind === 'user') {
    const ids = closeAll ? openTasks.splice(0) : openTasks.splice(0, Math.max(0, openTasks.length - 1));
    const content = ids.length ? ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'hecho' })) : 'Haz la tarea ' + turn + ' ' + 'x'.repeat(200);
    return { type: 'user', sessionId: sid, timestamp: now(), uuid: crypto.randomUUID(), message: { role: 'user', content } };
  }
  const content = [{ type: 'text', text: 'Respuesta ' + turn + ' ' + 'lorem ipsum '.repeat(60) }];
  if (turn % 7 === 0) openTasks.push('toolu_' + turn), content.push({ type: 'tool_use', id: 'toolu_' + turn, name: 'Task', input: { description: 'Subagente ' + turn, subagent_type: 'general-purpose', prompt: 'p' } });
  if (turn % 5 === 0) content.push({ type: 'tool_use', id: 'toolu_t' + turn, name: 'TodoWrite', input: { todos: [{ content: 'Paso A ' + turn, status: 'completed', activeForm: 'A' }, { content: 'Paso B ' + turn, status: 'in_progress', activeForm: 'Haciendo B' }, { content: 'Paso C', status: 'pending', activeForm: 'C' }] } });
  return { type: 'assistant', sessionId: sid, timestamp: now(), uuid: crypto.randomUUID(), message: { model: 'claude-opus-5-5', role: 'assistant', content, usage: { input_tokens: 5, cache_read_input_tokens: 50000 + turn * 50, cache_creation_input_tokens: 300, output_tokens: 400, cache_creation: { ephemeral_1h_input_tokens: 300, ephemeral_5m_input_tokens: 0 } } } };
}
{
  const parts = [JSON.stringify({ type: 'ai-title', sessionId: sid, aiTitle: 'Emulador ' + n }) + '\n'];
  for (let i = 0; i < 2500; i++) parts.push(JSON.stringify(entry(i % 2 ? 'assistant' : 'user', true)) + '\n');
  fs.writeFileSync(tp, parts.join(''));
}
let alt = 0;
setInterval(() => { fs.appendFileSync(tp, JSON.stringify(entry(alt++ % 2 ? 'assistant' : 'user', false)) + '\n'); }, 1500 + n * 200);
// ciclo de estado: 50 s busy, 8 s idle, cada 4.º ciclo 5 s waiting
let cyc = 0;
(function cycle() {
  status = 'busy'; writeSess();
  setTimeout(() => {
    status = (cyc++ % 4 === 3) ? 'waiting' : 'idle'; writeSess();
    setTimeout(cycle, status === 'waiting' ? 5000 : 8000);
  }, 50000);
})();
// ---- pantalla ----
const out = (s) => process.stdout.write(s);
const cols = () => process.stdout.columns || 100, rows = () => process.stdout.rows || 30;
const C = (r, g, b) => '\x1b[38;2;' + r + ';' + g + ';' + b + 'm';
const words = 'el renderizador de la ventana consume tiempo cuando cada trozo de salida dispara trabajo extra en el hilo principal y eso se nota tras horas'.split(' ');
const lines = [];
let lineBuf = '';
function mdLine(i) {
  const k = i % 9;
  if (k === 0) return C(215,119,87) + '\x1b[1m## Sección ' + i + '\x1b[22m\x1b[39m';
  if (k === 3) return '  - ' + '\x1b[1m' + 'Punto ' + i + '\x1b[22m: ' + words.slice(0, 8).join(' ');
  if (k === 5) return C(153,153,153) + '  ⎿ ' + 'Read(src/lib/file' + i + '.ts)' + '\x1b[39m';
  if (k === 7) return '\x1b[3m' + words.slice(3, 10).join(' ') + '\x1b[23m ' + C(177,185,249) + '\x1b[48;2;55;55;55m code_' + i + ' \x1b[49m\x1b[39m';
  return null;
}
let li = 0;
const spin = ['·', '✢', '✳', '✶', '✻', '✽'];
let frame = 0, t0 = Date.now();
out('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[?1000h\x1b[?1006h');
let topDirty = true;
function render() {
  frame++;
  const R = rows(), W = cols();
  const area = R - 6;
  // streaming: unas palabras por fotograma mientras está ocupado
  if (status === 'busy') {
    const md = mdLine(li);
    if (md && lineBuf === '') { lines.push(md); li++; topDirty = true; }
    else {
      lineBuf += (lineBuf ? ' ' : '') + words[(frame * 7 + n) % words.length];
      if (lineBuf.length > W - 10) { lines.push(lineBuf); lineBuf = ''; li++; topDirty = true; }
    }
    if (lines.length > 400) lines.splice(0, lines.length - 400);
  }
  let s = '\x1b[?2026h';
  const view = lines.slice(-(area - 1));
  if (topDirty) { // desplazamiento: se repinta toda la zona de mensajes
    for (let r = 0; r < area - 1; r++) s += '\x1b[' + (r + 1) + ';1H\x1b[2K' + (view[r] ?? '');
    topDirty = false;
  }
  s += '\x1b[' + area + ';1H\x1b[2K' + C(255,255,255) + '⏺ \x1b[39m' + lineBuf;
  const el = ((Date.now() - t0) / 1000) | 0;
  s += '\x1b[' + (area + 1) + ';1H\x1b[2K';
  if (status === 'busy') s += C(215,119,87) + spin[frame % spin.length] + ' ' + 'Pensando…'.slice(0, 3 + frame % 7) + '\x1b[39m ' + C(153,153,153) + '(' + el + 's · ↓ ' + (frame * 3) + ' tokens · esc para interrumpir)\x1b[39m';
  s += '\x1b[' + (area + 2) + ';1H\x1b[2K' + C(136,136,136) + '─'.repeat(W) + '\x1b[39m';
  s += '\x1b[' + (area + 3) + ';1H\x1b[2K> ';
  s += '\x1b[' + (area + 4) + ';1H\x1b[2K' + C(136,136,136) + '─'.repeat(W) + '\x1b[39m';
  s += '\x1b[' + (area + 5) + ';1H\x1b[2K' + C(153,153,153) + '  ⏵⏵ auto mode on · ' + status + '\x1b[39m';
  s += '\x1b[?2026l';
  out(s);
}
process.stdout.on('resize', () => { topDirty = true; out('\x1b[2J'); });
setInterval(render, 1000 / (+process.env.EMU_HZ || 15));
process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdin.on('data', () => {});
