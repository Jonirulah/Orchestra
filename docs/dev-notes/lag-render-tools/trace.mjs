// Uso: node trace.mjs <puerto> <segundos>  → resumen del hilo principal del renderizador por nombre de evento (ms/s, propio aprox.)
const port = process.argv[2], secs = +process.argv[3];
const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map(); const events = [];
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
  if (m.method === 'Tracing.dataCollected') events.push(...m.params.value);
  else if (m.method === 'Tracing.tracingComplete') done();
  else if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const my = ++id; pend.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); });
let done; const fin = new Promise((r) => (done = r));
await new Promise((r) => ws.addEventListener('open', r));
await send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'gpu', 'v8'] }, transferMode: 'ReportEvents' });
await new Promise((r) => setTimeout(r, secs * 1000));
await send('Tracing.end'); await fin;
// hilo principal: el de CrRendererMain
const tn = events.filter((e) => e.name === 'thread_name');
const main = tn.find((e) => e.args?.name === 'CrRendererMain');
const comp = tn.find((e) => e.args?.name === 'Compositor');
const sum = (tid) => { const by = {}; for (const e of events) if (e.tid === tid && e.ph === 'X' && e.dur) by[e.name] = (by[e.name] || 0) + e.dur; return Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => (v / 1000 / secs).toFixed(1) + ' ' + k); };
console.log(JSON.stringify({ main: main && sum(main.tid), compositor: comp && sum(comp.tid) }, null, 1));
ws.close(); process.exit(0);