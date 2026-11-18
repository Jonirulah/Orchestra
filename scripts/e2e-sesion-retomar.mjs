// HERRAMIENTA (rama sesion-retomar): prueba de punta a punta de «cada panel de Claude retoma SU sesión», al reabrir y al Reiniciar.
// No gasta cuota: «claude» es un doble (stub.ps1) que escribe sessions/<pid>.json como Claude Code (sessionId, procStart, startedAt)
// y crea la transcripción. Instancia AISLADA (ORCHESTRA_DATA_DIR + WEBVIEW2_USER_DATA_FOLDER propios), manejada por CDP.
// Uso: node scripts/e2e-sesion-retomar.mjs <orchestra.exe> <carpeta de trabajo>   (borra y rehace la carpeta de trabajo)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [exe, work] = process.argv.slice(2);
if (!exe || !work) { console.error('uso: e2e-sesion-retomar.mjs <exe> <workdir>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = 'aaaaaaaa-0000-4000-8000-00000000000a', B = 'bbbbbbbb-0000-4000-8000-00000000000b', C = 'cccccccc-0000-4000-8000-00000000000c', D = 'dddddddd-0000-4000-8000-00000000000d';
const P = (...x) => path.join(work, ...x);
fs.rmSync(work, { recursive: true, force: true });
for (const d of ['bin', 'acc/sessions', 'acc/projects/e2e', 'data', 'wv', 'proj']) fs.mkdirSync(P(d), { recursive: true });
for (const id of [A, B, C, D]) fs.writeFileSync(P('acc/projects/e2e', id + '.jsonl'), '{}\n');
fs.writeFileSync(P('bin/claude.cmd'), '@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stub.ps1" %*\r\n');
fs.writeFileSync(P('bin/stub.ps1'), [
  '$dir = $env:CLAUDE_CONFIG_DIR; $id = $null; $a = @($args)',
  'for ($i = 0; $i -lt $a.Count; $i++) { if ($a[$i] -eq "--resume") { $id = $a[$i + 1] } }',
  'if (-not $id) { $id = [guid]::NewGuid().ToString() }',
  '$me = Get-Process -Id $PID; $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId; $root = (Get-CimInstance Win32_Process -Filter "ProcessId=$cmd").ParentProcessId',
  '$proj = Join-Path $dir "projects\\e2e"',
  'function W($sid) { if (-not (Test-Path "$proj\\$sid.jsonl")) { "{}" | Set-Content "$proj\\$sid.jsonl" }; $o = [ordered]@{ pid = $PID; sessionId = $sid; cwd = (Get-Location).Path; startedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); procStart = "$($me.StartTime.ToFileTimeUtc())"; kind = "interactive"; status = "idle" }; ($o | ConvertTo-Json -Compress) | Set-Content -Encoding ascii (Join-Path $dir "sessions\\$PID.json") }',
  'W $id',
  'Add-Content (Join-Path $dir "stub.log") ("START pane=" + $env:ORCHESTRA_TERM_ID + " pid=" + $PID + " root=" + $root + " id=" + $id + " args=" + ($a -join " "))',
  'Write-Host "STUB CLAUDE session $id"',
  'while ($true) { Start-Sleep -Milliseconds 500; $sw = Join-Path $dir "switch-$PID.txt"; if (Test-Path $sw) { $n = (Get-Content $sw).Trim(); Remove-Item $sw; W $n; Add-Content (Join-Path $dir "stub.log") ("SWITCH pane=" + $env:ORCHESTRA_TERM_ID + " pid=" + $PID + " id=" + $n) } }',
].join('\r\n'));

const accId = 'acc-e2e';
const acc = { id: accId, name: 'E2E', dir: P('acc'), isDefault: false, provider: 'claude', color: '#c58af9' };
const pane = (id, col, row, last, resumeFlag = '') => ({
  id, col, row, colSpan: 1, rowSpan: 1, parked: false, kind: 'agent', icon: 'bot', title: 'Claude · E2E', ref: accId,
  spec: { program: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', '& claude' + resumeFlag], cwd: P('proj'), env: { CLAUDE_CONFIG_DIR: P('acc'), ORCHESTRA_ACCOUNT: accId } },
  ...(last ? { lastSession: last } : {}),
});
const state = {
  version: 1, activeId: 'ws-e2e', hosts: [], accounts: [acc], ignoredDirs: [], customThemes: [], savedWorkspaces: [],
  settings: { restoreClaudeSessions: true, scanIntervalSec: 1, closeToTray: false, captureUsage: false, usageQuery: false, autoCompact: false, language: 'en',
    // portable-pty relee PATH del registro: el doble de «claude» entra por las variables de agente (Ajustes → Agentes).
    agentEnv: [{ key: 'PATH', value: [P('bin'), 'C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'].join(';') }] },
  workspaces: [{ id: 'ws-e2e', name: 'E2E', cols: [0.5, 0.5], rows: [0.5, 0.5], focusId: 't-p1', panes: [
    pane('t-p1', 0, 0, { id: A, dir: P('acc'), since: 10 }),
    pane('t-p2', 1, 0, { id: B, dir: P('acc'), since: 20 }),           // dos paneles con la misma sesión: gana el más reciente (p3)
    pane('t-p3', 0, 1, { id: B, dir: P('acc'), since: 30 }),
    pane('t-p4', 1, 1, { id: D, dir: P('acc'), ended: true }, ' --continue'), // cambió de cuenta sin sesión: quedó --continue
  ] }],
};
fs.writeFileSync(P('data/state.json'), JSON.stringify(state, null, 2));

const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|NO_COLOR|ORCHESTRA_|TERM$|WEBVIEW2_)/i.test(k)) env[k] = v;
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
env[pathKey] = P('bin') + ';' + env[pathKey];
Object.assign(env, { ORCHESTRA_DATA_DIR: P('data'), WEBVIEW2_USER_DATA_FOLDER: P('wv'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9347' });

const log = () => (fs.existsSync(P('acc/stub.log')) ? fs.readFileSync(P('acc/stub.log'), 'utf8').trim().split(/\r?\n/) : []);
const starts = () => log().filter((l) => l.startsWith('START')).map((l) => Object.fromEntries(l.split(' ').slice(1, 5).map((kv) => kv.split('='))) );
const waitFor = async (fn, ms, what) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(300); } throw new Error('timeout: ' + what); };
let app;
const launch = () => { app = spawn(exe, [], { env, detached: false, stdio: 'ignore' }); };
const killApp = () => { try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ya muerta */ } };
async function cdp() {
  let targets;
  for (let i = 0; i < 60 && !targets; i++) { try { targets = (await (await fetch('http://127.0.0.1:9347/json')).json()).filter((t) => t.type === 'page'); if (!targets.length) targets = undefined; } catch { await sleep(500); } }
  if (!targets) throw new Error('sin CDP');
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let n = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  try { const w = await send('Browser.getWindowForTarget'); if (w.result) await send('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { windowState: 'minimized' } }); } catch { /* sin minimizar */ }
  return { ev, close: () => ws.close() };
}
const byPane = (rows) => Object.fromEntries(rows.map((r) => [r.pane, r]));
const label = (r) => (r.args.includes('--continue') ? 'CONTINUE' : r.args.includes('--resume') ? r.id : 'fresh:' + r.id);
const out = { ok: true, checks: [] };
const check = (name, got, want) => { const ok = got === want; out.checks.push({ name, ok, got, want }); if (!ok) out.ok = false; };

try {
  // ---- 1) reabrir ----
  launch();
  await waitFor(() => new Set(starts().map((s) => s.pane)).size >= 4, 60000, '4 paneles arrancados');
  const s1 = byPane(starts().map((s) => ({ ...s, args: log().find((l) => l.includes('pid=' + s.pid)).split(' args=')[1] ?? '' })));
  check('reabrir p1 retoma A', label(s1['t-p1']), A);
  check('reabrir p2 (duplicado, perdió) NO retoma B', label(s1['t-p2']).startsWith('fresh:'), true);
  check('reabrir p3 (duplicado, ganó) retoma B', label(s1['t-p3']), B);
  check('reabrir p4 (--continue viejo, sesión cerrada) empieza nueva', label(s1['t-p4']).startsWith('fresh:'), true);
  check('ningún --continue', Object.values(s1).some((r) => r.args.includes('--continue')), false);
  const { ev, close } = await cdp();
  // ---- 2) /resume dentro de p1 (A -> C) y luego Reiniciar ----
  fs.writeFileSync(P('acc', 'switch-' + s1['t-p1'].pid + '.txt'), C);
  await waitFor(() => log().some((l) => l.startsWith('SWITCH') && l.includes('pane=t-p1')), 10000, 'switch');
  await sleep(4000); // escaneos (1 s) -> lastSession = C
  execFileSync('taskkill', ['/PID', s1['t-p1'].root, '/T', '/F'], { stdio: 'ignore' }); // el shell del panel muere -> botón Reiniciar
  const n0 = starts().filter((s) => s.pane === 't-p1').length;
  const clicked = await (async () => { for (let i = 0; i < 30; i++) { const c = await ev("(() => { const b = [...document.querySelectorAll('button')].find((b) => /^\\s*(Restart|Reiniciar)\\s*$/.test(b.textContent || '') && b.offsetParent); if (b) { b.click(); return true; } return false; })()"); if (c) return true; await sleep(500); } return false; })();
  check('botón Reiniciar encontrado', clicked, true);
  await waitFor(() => starts().filter((s) => s.pane === 't-p1').length > n0, 20000, 'p1 relanzado');
  const r1 = starts().filter((s) => s.pane === 't-p1').at(-1);
  r1.args = log().find((l) => l.includes('pid=' + r1.pid)).split(' args=')[1] ?? '';
  check('Reiniciar p1 retoma C (la sesión de AHORA, no la A horneada)', label(r1), C);
  // ---- 3) reabrir otra vez: cada uno la suya ----
  await sleep(4000); // que se guarde el estado (persist con retardo)
  close(); killApp(); await sleep(2000);
  const before = starts().length;
  launch();
  await waitFor(() => starts().length >= before + 4, 60000, '4 paneles otra vez');
  const s3 = byPane(starts().slice(before).map((s) => ({ ...s, args: log().find((l) => l.includes('pid=' + s.pid)).split(' args=')[1] ?? '' })));
  check('2.ª reapertura p1 retoma C', label(s3['t-p1']), C);
  check('2.ª reapertura p2 retoma la suya (nueva de la 1.ª)', label(s3['t-p2']), s1['t-p2'].id);
  check('2.ª reapertura p3 retoma B', label(s3['t-p3']), B);
  check('2.ª reapertura p4 retoma la suya', label(s3['t-p4']), s1['t-p4'].id);
  const ids = Object.values(s3).map(label);
  check('4 sesiones distintas', new Set(ids).size, 4);
} catch (e) { out.ok = false; out.error = String(e); }
finally { killApp(); out.log = log(); console.log(JSON.stringify(out, null, 1)); }
