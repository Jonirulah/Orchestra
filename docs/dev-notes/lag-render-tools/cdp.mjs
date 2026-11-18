// Evalúa una expresión en la página del exe de prueba (WebView2 con --remote-debugging-port=9347).
// Uso: node cdp.mjs "<expresión JS>"  -> imprime el resultado (JSON).
const port = +(process.env.CDP_PORT || 9361);
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => new Promise((res) => {
  const my = ++id;
  ws.addEventListener('message', function on(ev) {
    const m = JSON.parse(ev.data);
    if (m.id === my) { ws.removeEventListener('message', on); res(m.result); }
  });
  ws.send(JSON.stringify({ id: my, method, params }));
});
await new Promise((r) => ws.addEventListener('open', r));
if (process.argv[2] === 'type') {
  await send('Runtime.evaluate', { expression: "document.querySelector('.xterm-helper-textarea').focus()" });
  await send('Input.insertText', { text: process.argv[3] });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  console.log('typed'); ws.close(); process.exit(0);
}
const r = await send('Runtime.evaluate', { expression: process.argv[2], awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result?.value ?? r.exceptionDetails ?? r));
ws.close();
