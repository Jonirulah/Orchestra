// Uso: node prof.mjs <puerto> <segundos> <salida-sin-ext> [noprof]
// Mide con Performance.getMetrics (delta de TaskDuration/ScriptDuration/...) y, salvo noprof, perfil de CPU.
import fs from 'fs';
const [port, secs, outp, noprof] = [process.argv[2], +process.argv[3], process.argv[4], process.argv[5] === 'noprof'];
const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const my = ++id; pend.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); });
await new Promise((r) => ws.addEventListener('open', r));
await send('Performance.enable', { timeDomain: 'threadTicks' });
const met = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
if (!noprof) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 500 }); await send('Profiler.start'); }
const a = await met(); const t0 = Date.now();
await new Promise((r) => setTimeout(r, secs * 1000));
const b = await met(); const wall = (Date.now() - t0) / 1000;
const d = (k) => +(((b[k] - a[k]) / wall) * 100).toFixed(1);
const res = { wall, taskPct: d('TaskDuration'), scriptPct: d('ScriptDuration'), layoutPct: d('LayoutDuration'), stylePct: d('RecalcStyleDuration'),
  layouts_s: +((b.LayoutCount - a.LayoutCount) / wall).toFixed(1), styles_s: +((b.RecalcStyleCount - a.RecalcStyleCount) / wall).toFixed(1),
  heapMB: +(b.JSHeapUsedSize / 1048576).toFixed(1), nodes: b.Nodes, listeners: b.JSEventListeners, docs: b.Documents };
if (!noprof) {
  const { profile } = await send('Profiler.stop');
  fs.writeFileSync(outp + '.cpuprofile', JSON.stringify(profile));
  // tiempo propio por función
  const dt = {}; const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  for (let i = 0; i < profile.samples.length; i++) dt[profile.samples[i]] = (dt[profile.samples[i]] || 0) + (profile.timeDeltas[i] || 0);
  const self = {}; let tot = 0;
  for (const [nid, us] of Object.entries(dt)) { const n = byId.get(+nid); const cf = n.callFrame; const k = (cf.functionName || '(anon)') + ' ' + (cf.url.split('/').pop() || '') + ':' + cf.lineNumber + ':' + cf.columnNumber; self[k] = (self[k] || 0) + us; tot += us; }
  res.top = Object.entries(self).sort((x, y) => y[1] - x[1]).slice(0, 25).map(([k, us]) => (us / 1000 / wall).toFixed(1) + 'ms/s ' + k);
}
fs.writeFileSync(outp + '.json', JSON.stringify(res, null, 1));
console.log(JSON.stringify(res));
ws.close(); process.exit(0);
