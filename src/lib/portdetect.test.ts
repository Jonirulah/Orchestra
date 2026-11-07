import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoTunnelsToStop, cleanForwards, destKey, detectPorts, fwdDest, localUrl, parsePort, portAllowed, PortScanner, savedToStart,
  shouldOffer, stripAnsi, tunnelId, tunnelLook,
} from './portdetect.ts';
import { normalizeHost, type Host } from './model.ts';

const E = '\x1b';

// Líneas REALES de servidores de desarrollo (copiadas de su salida) -> puerto que deben dar.
const REAL: [string, number[]][] = [
  // Vite / SvelteKit / Astro (con colores y el puerto en negrita)
  [`  ${E}[32m➜${E}[39m  ${E}[1mLocal${E}[22m:   ${E}[36mhttp://localhost:${E}[1m5173${E}[22m/${E}[39m`, [5173]],
  ['  ➜  Network: http://192.168.1.34:5173/', [5173]],
  ['  ┃ Local    http://localhost:4321/', [4321]],
  // Next.js
  ['ready - started server on 0.0.0.0:3000, url: http://localhost:3000', [3000]],
  ['   - Local:        http://localhost:3000', [3000]],
  // Create React App / webpack-dev-server
  ['  Local:            http://localhost:3000', [3000]],
  ['<i> [webpack-dev-server] Project is running at:', []],
  ['<i> [webpack-dev-server] Loopback: http://localhost:8080/, http://[::1]:8080/', [8080]],
  // Angular
  ['** Angular Live Development Server is listening on localhost:4200, open your browser on http://localhost:4200/ **', [4200]],
  // Django
  ['Starting development server at http://127.0.0.1:8000/', [8000]],
  // Flask
  [' * Running on http://127.0.0.1:5000', [5000]],
  [`${E}[31m${E}[1m * Running on all addresses (0.0.0.0)${E}[0m`, []],
  // uvicorn / FastAPI
  [`INFO:     Uvicorn running on ${E}[1mhttp://0.0.0.0:8000${E}[0m (Press CTRL+C to quit)`, [8000]],
  // gunicorn
  ['[2026-11-07 17:04:11 +0000] [1234] [INFO] Listening at: http://127.0.0.1:8001 (1234)', [8001]],
  // Rails / Puma
  ['* Listening on http://127.0.0.1:3000', [3000]],
  ['* Listening on tcp://0.0.0.0:3000', [3000]],
  // python -m http.server
  ['Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...', [8000]],
  ['Serving HTTP on :: port 8080 (http://[::]:8080/) ...', [8080]],
  // Express y Node a mano
  ['Server listening on port 4000', [4000]],
  ['Example app listening on port 3000', [3000]],
  ['Server running at http://127.0.0.1:3000/', [3000]],
  // Go
  ['2026/11/07 17:04:11 Listening on :8080', [8080]],
  // Spring Boot
  ['Tomcat started on port(s): 8080 (http) with context path \'\'', [8080]],
  ['Netty started on port 8081', [8081]],
  // Jupyter
  ['    http://localhost:8888/tree?token=3f1c2a9b0d', [8888]],
  ['[I 17:04:11.123 NotebookApp] http://127.0.0.1:8888/?token=abc', [8888]],
  // Hugo
  ['Web Server is available at http://localhost:1313/ (bind address 127.0.0.1)', [1313]],
  // Streamlit / Gradio
  ['  Local URL: http://localhost:8501', [8501]],
  ['Running on local URL:  http://127.0.0.1:7860', [7860]],
  // Phoenix
  ['[info] Running MyAppWeb.Endpoint with cowboy 2.10.0 at 127.0.0.1:4000 (http)', [4000]],
  // Deno / Bun
  ['Listening on http://0.0.0.0:8000/', [8000]],
  ['Started development server: http://localhost:3000', [3000]],
  // PHP
  ['[Sat Nov  7 17:04:11 2026] PHP 8.3.0 Development Server (http://localhost:8000) started', [8000]],
  // Ollama
  ['time=2026-11-07T17:04:11Z level=INFO source=routes.go msg="Listening on 127.0.0.1:11434 (version 0.4.0)"', [11434]],
  // nginx/caddy en el 80 y 443
  ['caddy: serving initial configuration on https://localhost:443', [443]],
  ['http://localhost:80/', [80]],
];

test('detecta los puertos en líneas reales de servidores de desarrollo', () => {
  assert.ok(REAL.filter(([, p]) => p.length).length >= 25);
  for (const [line, want] of REAL) assert.deepEqual(detectPorts(line), want, JSON.stringify(line));
});

// Lo que NO debe saltar.
const NOPE = [
  'Last login: Sat Nov  7 17:04:11 2026 from 10.0.0.5',
  '12:30:45 up 3 days,  2:01,  1 user,  load average: 0.00, 0.01, 0.05',
  'ratio 3:1 at 16:9',
  'src/server.ts:3000:12 - error TS2345',
  'cat /var/www/localhost:3000/index.html',
  '/srv/app/logs/127.0.0.1:8080.log',
  'ssh: connect to host example.org port 22: Connection refused',
  'Server listening on 0.0.0.0 port 22.',
  'debug1: Local connections to LOCALHOST:22 forwarded',
  "2026-11-07 17:04:11.123 UTC [1] LOG:  listening on IPv4 address \"0.0.0.0\", port 5432",
  'Ready to accept connections tcp on port 6379',
  'curl http://example.com:8080/api',
  'git clone git@github.com:user/repo.git',
  'listening on port 99999',
  'version 1.2.3:4567',
  'drwxr-xr-x  2 root root 4096 Nov  7 12:30 3000',
  'PID 3000 listening',
  'commit 3000abc localhost',
];

test('no salta con horas, rutas, ratios ni el 22 del propio ssh', () => {
  for (const line of NOPE) assert.deepEqual(detectPorts(line), [], line);
});

test('stripAnsi quita colores, OSC y controles', () => {
  assert.equal(stripAnsi(`${E}[1;32mok${E}[0m ${E}]0;título${E}\\fin${E}]8;;http://x${E}\\link${E}]8;;${E}\\`), 'ok finlink');
  assert.equal(stripAnsi(`a${E}[2Kb\x07c`), 'abc');
});

test('portAllowed', () => {
  assert.equal(portAllowed(3000), true);
  assert.equal(portAllowed(80), true);
  assert.equal(portAllowed(443), true);
  for (const p of [0, 22, 21, 1023, 5432, 65536, 3.5, -1, Number.NaN]) assert.equal(portAllowed(p), false, String(p));
});

test('PortScanner junta líneas partidas en trozos y no repite en el mismo trozo', () => {
  const s = new PortScanner();
  assert.deepEqual(s.feed('  ➜  Local:   http://local'), []);
  assert.deepEqual(s.feed(`host:${E}[1m51`), []);
  assert.deepEqual(s.feed(`73${E}[22m/\r\n  ➜  Network: http://10.0.0.2:5173/\r\n`), [5173]);
  assert.deepEqual(s.feed('Listening on :8080\rmore'), [8080]);
  assert.deepEqual(s.feed('x'.repeat(5000)), []);
  assert.deepEqual(s.feed('\n'), []); // la línea gigante sin terminar se descartó
});

test('destKey y tunnelId coinciden con Rust (Dest::key / tunnel_id)', () => {
  const d = { user: 'demo', host: 'example.org', port: 2222, jump: 'bastion' };
  assert.equal(destKey(d), 'demo@example.org:2222|bastion');
  assert.equal(tunnelId(d, 3000), 'demo@example.org:2222|bastion#3000');
  assert.equal(tunnelId({ host: 'h', port: 22 }, 80), '@h:22|#80');
  assert.equal(localUrl(5174), 'http://localhost:5174/');
});

const host = (id: string, extra: Partial<Host> = {}): Host => normalizeHost({ id, name: id, host: `${id}.lan`, tags: [], authMethod: 'agent', agentAccess: 'none', ...extra } as Host);

test('fwdDest solo lleva el NOMBRE del secreto', () => {
  const h = host('web', { user: 'u', port: 2200, authMethod: 'key', identityFile: 'C:\\k', proxyJump: ' bastion ' });
  assert.deepEqual(fwdDest(h), { host: 'web.lan', port: 2200, user: 'u', identity: 'C:\\k', identitiesOnly: true, jump: 'bastion' });
});

test('reenvíos guardados: validación y normalizeHost', () => {
  assert.deepEqual(cleanForwards([{ remote: 3000 }, { remote: '8080', local: 18080 }, { remote: 3000, local: 1 }, { remote: 0 }, { remote: 70000 }, 'x', null, { remote: 5000, local: 5000 }]),
    [{ remote: 3000 }, { remote: 8080, local: 18080 }, { remote: 5000 }]);
  assert.equal(cleanForwards([]), undefined);
  assert.equal(cleanForwards('3000'), undefined);
  assert.equal(cleanForwards(Array.from({ length: 50 }, (_, i) => ({ remote: 3000 + i })))!.length, 20);
  assert.deepEqual(host('a', { forwards: [{ remote: 3000 }] }).forwards, [{ remote: 3000 }]);
  assert.equal('forwards' in host('b', { forwards: [] }), false);
  assert.equal(parsePort(' 443 '), 443);
  assert.equal(parsePort('4e3'), null);
  assert.equal(parsePort('0'), null);
});

test('al cerrar el último panel del host se paran sus túneles automáticos, no los guardados', () => {
  const hosts = [host('a', { forwards: [{ remote: 8080 }] }), host('b')];
  const tunnels = [{ id: 'A#3000', remotePort: 3000 }, { id: 'A#8080', remotePort: 8080 }, { id: 'B#5173', remotePort: 5173 }, { id: 'X#1', remotePort: 1 }];
  const meta = { 'A#3000': { hostId: 'a', auto: true }, 'A#8080': { hostId: 'a', auto: false }, 'B#5173': { hostId: 'b', auto: true } };
  assert.deepEqual(autoTunnelsToStop(tunnels, meta, hosts, new Set(['a', 'b'])), []);
  assert.deepEqual(autoTunnelsToStop(tunnels, meta, hosts, new Set(['b'])), ['A#3000']);
  assert.deepEqual(autoTunnelsToStop(tunnels, meta, hosts, new Set()), ['A#3000', 'B#5173']);
});

test('los guardados arrancan al conectar y solo una vez', () => {
  const a = host('a', { forwards: [{ remote: 8080 }, { remote: 3000, local: 13000 }] });
  const hosts = [a, host('b')];
  assert.deepEqual(savedToStart(hosts, new Set(), new Set()), []);
  const s = savedToStart(hosts, new Set(['a', 'b']), new Set());
  assert.deepEqual(s.map((x) => [x.id, x.remote, x.local]), [['@a.lan:22|#8080', 8080, undefined], ['@a.lan:22|#3000', 3000, 13000]]);
  assert.deepEqual(savedToStart(hosts, new Set(['a']), new Set(['@a.lan:22|#8080', '@a.lan:22|#3000'])), []);
});

test('un puerto no avisa dos veces ni si ya está reenviado', () => {
  assert.equal(shouldOffer('a', 3000, new Set(), new Set()), true);
  assert.equal(shouldOffer('a', 3000, new Set(['a:3000']), new Set()), false);
  assert.equal(shouldOffer('a', 3000, new Set(), new Set(['a:3000'])), false);
  assert.equal(shouldOffer('b', 3000, new Set(['a:3000']), new Set()), true);
  assert.equal(shouldOffer('a', 22, new Set(), new Set()), false);
});

test('aspecto de cada estado', () => {
  assert.equal(tunnelLook({ state: 'up' }), 'ok');
  assert.equal(tunnelLook({ state: 'connecting' }), 'wait');
  assert.equal(tunnelLook({ state: 'down' }), 'down');
  assert.equal(tunnelLook({ state: 'error' }), 'bad');
});

test('los reenvíos guardados viajan en la copia de seguridad (solo números) y la basura se limpia al leerla', async () => {
  const { buildBackup, serializeBackup, parseBackup } = await import('./backup.ts');
  const { DEFAULTS } = await import('./settings.ts');
  const h = host('h1', { forwards: [{ remote: 3000 }, { remote: 8080, local: 18080 }] });
  const state = { settings: { ...DEFAULTS }, hosts: [h], accounts: [], customThemes: [], workspaces: [], activeId: '', ignoredDirs: [] };
  const txt = serializeBackup(buildBackup(state, { appVersion: '0.3.0' }));
  const r = parseBackup(txt);
  assert.ok(r.ok);
  assert.deepEqual(r.sections.hosts?.[0].forwards, [{ remote: 3000 }, { remote: 8080, local: 18080 }]);
  const dirty = txt.replace('"remote": 3000', '"remote": "x; rm -rf /"');
  assert.notEqual(dirty, txt);
  const r2 = parseBackup(dirty);
  assert.ok(r2.ok);
  assert.deepEqual(r2.sections.hosts?.[0].forwards, [{ remote: 8080, local: 18080 }]);
});
