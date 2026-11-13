import { invoke, Channel } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { UsageResult } from './usageQuery.ts';
import { demoHistory, type HistPoint } from './history.ts';
import type { InstalledFont } from './fontlist.ts';
import type { ClaudeThemeFile } from './claudetheme.ts';
import { demoAccounts, demoMcpBase, demoMcpDef, demoQuery, DEMO_CODEX_DEFAULT } from './demodata.ts';
import { demoScanReport, demoSessionReport, demoAdvice, demoReport } from './consumodemo.ts';

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface SpawnSpec {
  id: string;
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
}
export interface ShellProfile { id: string; name: string; program: string; args: string[] }
export interface SshConfigHost {
  alias: string; hostname?: string; user?: string; port?: number;
  identityFile?: string; proxyJump?: string; proxyCommand?: string;
}

// ---------- modo demo (navegador sin Tauri): permite iterar la interfaz sin compilar Rust ----------
const demo = new Map<string, (b: Uint8Array) => void>();
const demoExit = new Set<(id: string, code: number) => void>();
const enc = new TextEncoder();
const demoCwd = new Map<string, string>();
function demoOut(id: string, s: string) { demo.get(id)?.(enc.encode(s)); }

// Demo de la caída SSH: `?drop=N` hace que cada panel SSH de la demo se caiga a los N s de conectar (una vez), falle el
// 1.er reintento y vuelva en el 2.º. `&dropfail=1` = la red no vuelve (se rinde por intentos); `&dropfail=auth` = el
// 2.º reintento lo rechaza el servidor (se rinde por autenticación). Solo en el navegador, nunca en la app.
const demoSsh = new Set<string>();
const demoAttaches = new Map<string, number>();
function demoParam(k: string): string | null { return typeof location === 'undefined' ? null : new URLSearchParams(location.search).get(k); }
/** Segundos de `?drop=` (0 = apagado; mínimo 2). Siempre 0 dentro de Tauri. */
export function demoDrop(): number {
  if (inTauri) return 0;
  const n = Number(demoParam('drop')) || 0;
  return n > 0 ? Math.max(2, Math.min(n, 600)) : 0;
}
/** Ajustes de reconexión que usa la demo con `?drop=`: la sesión cuenta como establecida, y los reintentos se ven sin esperar minutos. */
export function demoDropSettings(s: { sshReconnectMaxAttempts: number }): { sshAutoReconnect: true; sshReconnectMinUpSec: number; sshReconnectFirstDelaySec: number; sshReconnectFactor: number; sshReconnectMaxAttempts: number } {
  return {
    sshAutoReconnect: true, sshReconnectMinUpSec: demoDrop() - 1, sshReconnectFirstDelaySec: 5, sshReconnectFactor: 1.2,
    sshReconnectMaxAttempts: demoParam('dropfail') === '1' ? 3 : s.sshReconnectMaxAttempts,
  };
}
function demoExitNow(id: string, code: number) { for (const cb of demoExit) cb(id, code); }
/** Un panel SSH de la demo con `?drop=`: conecta, se cae, falla, vuelve (o no). */
function demoSshAttach(id: string, dropSec: number): void {
  const n = demoAttaches.get(id) ?? 0;
  demoAttaches.set(id, n + 1);
  const ok = () => demoOut(id, '\x1b[2mLinux demo-host 6.8.0 x86_64\x1b[0m\r\nLast login: Sat Nov  7 17:04:11 2026 from 10.0.0.5\r\n\x1b[32mdemo@demo-host\x1b[0m:\x1b[34m~\x1b[0m$ ');
  const fail = (msg: string) => setTimeout(() => {
    if (!demo.has(id)) return;
    demoOut(id, msg + '\r\n');
    setTimeout(() => demoExitNow(id, 255), 300);
  }, 700);
  if (n === 0) {
    ok();
    setTimeout(() => {
      if (!demo.has(id)) return;
      demoOut(id, '\r\nclient_loop: send disconnect: Connection reset\r\n');
      demoExitNow(id, 255);
    }, dropSec * 1000);
    return;
  }
  const mode = demoParam('dropfail');
  if (mode === 'auth' && n >= 2) { fail('demo@demo-host: Permission denied (publickey,password).'); return; }
  if (mode || n === 1) { fail('ssh: connect to host demo-host port 22: Connection timed out'); return; }
  ok();
}

// Demo con salida REAL de Claude Code: `?claude=claude-2.1.322-dark` reproduce esa captura de docs/dev-notes/fixtures_claude/
// (solo con el servidor de Vite) en los paneles de Claude, a trozos, hasta antes de salir. Sirve para ver el color del markdown.
const demoClaude = new Set<string>();
function demoClaudeReplay(id: string, name: string): void {
  if (!/^[a-z0-9.-]+$/.test(name)) return;
  void fetch(`/docs/dev-notes/fixtures_claude/${name}.bin`).then((r) => r.arrayBuffer()).then((buf) => {
    let text = new TextDecoder().decode(buf);
    // Hasta el último fotograma antes de «Press Ctrl-C again to exit» (la captura termina con dos Ctrl+C).
    const end = text.indexOf('Press Ctrl-C');
    if (end > 0) text = text.slice(0, text.lastIndexOf('(B', end));
    const b = enc.encode(text);
    let i = 0;
    const step = () => { if (i >= b.length) return; demo.get(id)?.(b.slice(i, i + 997)); i += 997; setTimeout(step, 0); };
    step();
  }).catch(() => demoOut(id, `demo: no ${name}
`));
}
export async function ptySpawn(spec: SpawnSpec): Promise<number> {
  if (!inTauri) { if (spec.cwd) demoCwd.set(spec.id, spec.cwd); if (spec.program === 'ssh') demoSsh.add(spec.id); if ((spec.args ?? []).join(' ').includes('& claude')) demoClaude.add(spec.id); return 0; }
  return invoke<number>('pty_spawn', { spec });
}

export async function ptyAttach(id: string, onData: (b: Uint8Array) => void): Promise<number | null> {
  if (!inTauri) {
    demo.set(id, onData);
    if (demoSsh.has(id) && demoDrop() > 0) { demoSshAttach(id, demoDrop()); return null; }
    if (demoClaude.has(id) && demoParam('claude')) { demoClaudeReplay(id, demoParam('claude')!); return null; }
    // `?slow=3000` en la URL de la demo retrasa la primera salida: sirve para ver el aviso «conectando…» de los paneles SSH.
    const slow = Number(new URLSearchParams(location.search).get('slow')) || 0;
    // La demo también «avisa» de su carpeta (OSC 9;9) para ejercitar el manejador real de xterm (etiqueta de git).
    const dirs = ['C:\\Users\\demo', 'C:\\Dev\\orchestra', 'C:\\Dev\\rebase-fix', 'C:\\Dev\\clean-app'];
    const osc = demoCwd.has(id) ? `\x1b]9;9;${dirs[[...demoCwd.keys()].indexOf(id) % dirs.length]}\x07` : '';
    const first = () => demoOut(id, `\x1b[33mOrchestra · demo mode (no backend)\x1b[0m\r\n$ ${osc}`);
    if (slow > 0) setTimeout(first, Math.min(slow, 60000)); else first();
    // Panel SSH de la demo: un servidor de desarrollo «arranca» en el remoto (aviso de puerto detectado; ver portdetect.ts).
    if (demoSsh.has(id)) setTimeout(() => demoOut(id, 'npm run dev\r\n\r\n  \x1b[32m\x1b[1mVITE\x1b[22m v5.4.2\x1b[39m  \x1b[2mready in \x1b[0m\x1b[1m312\x1b[22m\x1b[2m\x1b[0m ms\r\n\r\n  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n  \x1b[32m➜\x1b[39m  \x1b[1mNetwork\x1b[22m: \x1b[2muse \x1b[22m\x1b[1m--host\x1b[22m\x1b[2m to expose\x1b[22m\r\n'), Math.max(slow, 0) + 1500);
    return null;
  }
  const ch = new Channel<ArrayBuffer | number[]>();
  ch.onmessage = (m) => onData(m instanceof ArrayBuffer ? new Uint8Array(m) : Uint8Array.from(m));
  return invoke<number | null>('pty_attach', { id, onData: ch });
}

export function ptyWrite(id: string, data: string): void {
  if (!inTauri) {
    demoOut(id, data === '\r' ? '\r\n$ ' : data === '\x7f' ? '\b \b' : data);
    return;
  }
  void invoke('pty_write', { id, data });
}
export function ptyResize(id: string, cols: number, rows: number): void {
  if (inTauri) void invoke('pty_resize', { id, cols, rows });
}
export function ptyKill(id: string): void { if (inTauri) void invoke('pty_kill', { id }); }
export function ptyClose(id: string): void {
  demo.delete(id);
  if (inTauri) void invoke('pty_close', { id });
}
export async function onPtyExit(cb: (id: string, code: number) => void): Promise<UnlistenFn> {
  if (!inTauri) { demoExit.add(cb); return () => demoExit.delete(cb); }
  return listen<{ id: string; code: number }>('pty-exit', (e) => cb(e.payload.id, e.payload.code));
}

export async function detectShells(): Promise<ShellProfile[]> {
  if (!inTauri) return [{ id: 'powershell', name: 'Windows PowerShell', program: 'powershell.exe', args: [] },
    { id: 'cmd', name: 'Command Prompt', program: 'cmd.exe', args: [] },
    { id: 'gitbash', name: 'Git Bash', program: 'bash.exe', args: [] }];
  return invoke('detect_shells');
}
export interface ClaudeThemesResult { dir: string; ok: boolean; written: number; removed: number; error: string | null }
/** Escribe los temas de Claude en `<cuenta>/themes/orchestra-*.json` de cada cuenta. */
export async function claudeThemesWrite(dirs: string[], files: ClaudeThemeFile[]): Promise<ClaudeThemesResult[]> {
  if (!inTauri) return dirs.map((dir) => ({ dir, ok: true, written: files.length, removed: 0, error: null }));
  return invoke('claude_themes_write', { dirs, files });
}
export interface ClaudeThemeSetResult { dir: string; ok: boolean; action: 'set' | 'kept' | 'manual' | 'restored' | 'none'; error: string | null }
/** Pone (`on`) o devuelve (`!on`) el tema de Claude en `<cuenta>/settings.json` de cada cuenta (claude_theme_choice.rs). */
export async function claudeThemeSet(dirs: string[], on: boolean, theme: string): Promise<ClaudeThemeSetResult[]> {
  if (!inTauri) return dirs.map((dir) => ({ dir, ok: true, action: on ? 'set' : 'none', error: null }));
  return invoke('claude_theme_set', { dirs, on, theme });
}
/** Fuentes instaladas en el sistema (DirectWrite). En la demo, unas cuantas para ver los grupos de la lista. */
export async function listFonts(): Promise<InstalledFont[]> {
  if (!inTauri) return [{ name: 'Consolas', newSinceStart: false }, { name: 'Arial', newSinceStart: false }, { name: 'Fuente Nueva Demo', newSinceStart: true }];
  return invoke('list_fonts');
}
export async function sshConfigHosts(): Promise<SshConfigHost[]> {
  if (!inTauri) return [{ alias: 'prod-web', hostname: '10.0.0.5', user: 'deploy' }];
  return invoke('ssh_config_hosts');
}
export async function homeDir(): Promise<string> { return inTauri ? invoke('home_dir') : 'C:\\Users\\demo'; }
export async function loadState(): Promise<string | null> {
  if (!inTauri) return localStorage.getItem('orchestra-state');
  return invoke('load_state');
}
export async function saveState(json: string): Promise<void> {
  if (!inTauri) { localStorage.setItem('orchestra-state', json); return; }
  await invoke('save_state', { json });
}
/** Carpeta del estado (en el navegador de pruebas no hay: se usa localStorage). */
export async function dataDir(): Promise<string> {
  return inTauri ? invoke<string>('data_dir') : '(browser demo: localStorage)';
}
export function openDataDir(): void {
  if (inTauri) void invoke('open_data_dir');
}
/** Abre en el Explorador la carpeta de una cuenta (el backend solo acepta carpetas de cuentas guardadas). */
export async function openAccountDir(dir: string): Promise<void> {
  if (inTauri) await invoke('open_account_dir', { dir });
}
export function openUrl(url: string): void {
  if (inTauri) void invoke('open_url', { url }); else window.open(url, '_blank');
}
export function setCloseToTray(enabled: boolean): void {
  if (inTauri) void invoke('set_close_to_tray', { enabled });
}
/** Textos del menú de la bandeja del sistema (los del idioma elegido). */
export function setTrayLabels(show: string, quit: string): void {
  if (inTauri) void invoke('set_tray_labels', { show, quit });
}

// ---------- bóveda de secretos y claves SSH ----------
// Solo escritura desde la interfaz: ningún comando devuelve un secreto.
export interface SshKeyInfo {
  name: string; pubPath: string; privatePath?: string; hasPrivate: boolean;
  keyType: string; bits?: number; fingerprint: string; comment: string;
  publicKey: string; hasSavedPassphrase: boolean;
}
/** Modo demo: solo recuerda los NOMBRES de lo "guardado" (nunca el valor). */
const demoSecrets = new Set<string>();
const demoKeys: SshKeyInfo[] = [
  { name: 'id_ed25519', pubPath: 'C:\\Users\\demo\\.ssh\\id_ed25519.pub', privatePath: 'C:\\Users\\demo\\.ssh\\id_ed25519', hasPrivate: true,
    keyType: 'ED25519', bits: 256, fingerprint: 'SHA256:Zk3w9mQ2hX0nT7yLr1PqVbN5aCdE8fGhJkLmNoPqRsT', comment: 'demo@laptop',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemo demo@laptop', hasSavedPassphrase: false },
  { name: 'work_rsa', pubPath: 'C:\\Users\\demo\\.ssh\\work_rsa.pub', hasPrivate: false,
    keyType: 'RSA', bits: 3072, fingerprint: 'SHA256:Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLlMmNnOoPpQ', comment: 'work',
    publicKey: 'ssh-rsa AAAAB3NzaC1yc2EDemoDemoDemoDemo work', hasSavedPassphrase: true },
];
export async function secretSet(key: string, value: string): Promise<void> {
  if (!inTauri) { demoSecrets.add(key); return; }
  await invoke('secret_set', { key, value });
}
export async function secretExists(key: string): Promise<boolean> {
  if (!inTauri) return demoSecrets.has(key);
  return invoke<boolean>('secret_exists', { key });
}
export async function secretDelete(key: string): Promise<void> {
  if (!inTauri) { demoSecrets.delete(key); return; }
  await invoke('secret_delete', { key });
}
/** Copia un secreto guardado a otra entrada sin que pase por la interfaz. */
export async function secretCopy(from: string, to: string): Promise<void> {
  if (!inTauri) { demoSecrets.add(to); return; }
  await invoke('secret_copy', { from, to });
}
export async function sshKeysList(): Promise<SshKeyInfo[]> {
  if (!inTauri) return demoKeys.map((k) => ({ ...k }));
  return invoke<SshKeyInfo[]>('ssh_keys_list');
}
export async function sshKeygen(name: string, comment: string, passphrase: string | undefined, savePassphrase: boolean): Promise<SshKeyInfo> {
  if (!inTauri) {
    if (demoKeys.some((k) => k.name === name)) throw new Error(`A key named «${name}» already exists; pick another name`);
    const k: SshKeyInfo = {
      name, pubPath: `C:\\Users\\demo\\.ssh\\${name}.pub`, privatePath: `C:\\Users\\demo\\.ssh\\${name}`, hasPrivate: true,
      keyType: 'ED25519', bits: 256, fingerprint: 'SHA256:DemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemo', comment,
      publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAADemo ${comment}`, hasSavedPassphrase: !!passphrase && savePassphrase,
    };
    demoKeys.push(k);
    return { ...k };
  }
  return invoke<SshKeyInfo>('ssh_keygen', { name, comment, passphrase: passphrase || null, savePassphrase });
}
export function sshKeyReveal(name: string): Promise<void> {
  return inTauri ? invoke('ssh_key_reveal', { name }) : Promise.resolve();
}
export async function sshKeyForgetPassphrase(name: string): Promise<void> {
  if (!inTauri) { const k = demoKeys.find((x) => x.name === name); if (k) k.hasSavedPassphrase = false; return; }
  await invoke('ssh_key_forget_passphrase', { name });
}
// ---------- huella del servidor (hosts con secreto guardado) ----------
export interface ScannedKey { keyType: string; algo: string; fingerprint: string; line: string }
export interface HostKeyProbe {
  status: 'known' | 'unknown' | 'jump' | 'alias';
  /** Nombre y puerto REALES a los que se conecta (tras resolver ~/.ssh/config). */
  host: string; port: number;
  /** Nombre como lo escribe known_hosts: `host` o `[host]:puerto`. */
  pattern: string;
  keys: ScannedKey[];
}
/** Modo demo: nombres «confiados» en esta sesión. Un host que contiene «known» ya es conocido; «down» no responde. */
const demoTrusted = new Set<string>();
export async function hostKeyProbe(host: string, port: number | undefined, user: string | undefined, proxyJump: string | undefined): Promise<HostKeyProbe> {
  if (!inTauri) {
    await new Promise((r) => setTimeout(r, 600));
    const h = host.trim().toLowerCase().replace(/\.$/, '');
    const p = port || 22;
    const pattern = p === 22 ? h : `[${h}]:${p}`;
    const base = { host: h, port: p, pattern };
    if (h.includes('known') || demoTrusted.has(pattern)) return { ...base, status: 'known', keys: [] };
    if (proxyJump?.trim()) return { ...base, status: 'jump', keys: [] };
    if (h.includes('down')) throw new Error(`Could not read the host key of ${h}:${p} (timed out). Check the address and port, and that the server is reachable.`);
    return {
      ...base, status: 'unknown',
      keys: [
        { keyType: 'ED25519', algo: 'ssh-ed25519', fingerprint: 'SHA256:QdmizYy61MB96NGyVJthrCS+ez63ogtKD+yCvF/Dbl8', line: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAADemo' },
        { keyType: 'RSA', algo: 'ssh-rsa', fingerprint: 'SHA256:Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLlMmNnOoPpQ', line: 'ssh-rsa AAAAB3NzaC1yc2EDemo' },
      ],
    };
  }
  return invoke<HostKeyProbe>('hostkey_probe', { host, port: port ?? null, user: user ?? null, proxyJump: proxyJump ?? null });
}
/** Añade las claves aceptadas por el usuario a ~/.ssh/known_hosts (solo añade, nunca reescribe). */
export async function hostKeyTrust(host: string, port: number, lines: string[]): Promise<void> {
  if (!inTauri) { demoTrusted.add(port === 22 ? host : `[${host}]:${port}`); return; }
  await invoke('hostkey_trust', { host, port, lines });
}
/** Segundos sin teclado ni ratón en el sistema (GetLastInputInfo). En modo demo: 0 (siempre «activo»). */
export async function systemIdleSeconds(): Promise<number> {
  if (!inTauri) return 0;
  return invoke<number>('system_idle_seconds');
}
/** Solo desarrollo: valor de `ORCHESTRA_DEV_AUTOCOMPACT` (null = sin variable). */
export async function devAutocompactOverride(): Promise<string | null> {
  if (!inTauri) return null;
  return invoke<string | null>('dev_autocompact_override');
}
/** Solo desarrollo: línea en `autocompact-dev.log` (el backend no hace nada sin la variable). */
export function devAutocompactLog(line: string): void {
  if (inTauri) void invoke('dev_autocompact_log', { line }).catch(() => {});
}

export interface ClaudeProfile {
  dir: string; isDefault: boolean; loggedIn: boolean;
  email?: string; plan?: string; org?: string; accountUuid?: string;
}
export async function claudeProfiles(): Promise<ClaudeProfile[]> {
  if (!inTauri) return demoAccounts().filter((a) => a.provider === 'claude').map((a) => ({ dir: a.dir, isDefault: a.isDefault, loggedIn: true, email: a.email, plan: a.plan }));
  return invoke('claude_profiles');
}
/** Solo modo demo (navegador): cuentas de Codex y opencode inventadas para ver la barra lateral agrupada por proveedor. En la app real, vacío. */
export function demoProviderAccounts(): { name: string; dir: string; provider: 'codex' | 'opencode'; color: string }[] {
  if (inTauri) return [];
  return demoAccounts().flatMap((a) => (a.provider !== 'claude' && a.name && a.color ? [{ name: a.name, dir: a.dir, provider: a.provider, color: a.color }] : []));
}
/** Límites de uso (5 h / 7 d) que el envoltorio de statusline guardó para una cuenta. */
export interface QuotaEntry {
  accountId: string; fiveHour?: { used: number; resetsAt: number }; sevenDay?: { used: number; resetsAt: number }; at?: number;
  /** Límites extra (p. ej. el semanal de un modelo); solo los escribe la consulta opcional a Anthropic. */
  limits?: { kind: string; percent: number; resetsAt: number; scope?: string; active: boolean }[];
}

/** Prepara el envoltorio de statusline y devuelve la ruta del `--settings` para `claude` (null si no se pudo). */
export async function quotaPrepare(): Promise<string | null> {
  if (!inTauri) return 'C:\\Users\\demo\\AppData\\Roaming\\dev.orchestra.app\\bin\\orchestra-settings.json';
  try { return (await invoke<{ settingsPath: string }>('quota_prepare')).settingsPath; } catch { return null; }
}

/** Última cuota conocida de cada cuenta. En modo demo se inventa para las cuentas dadas (por carpeta). */
export async function quotaRead(accts: { id: string; dir: string }[] = []): Promise<QuotaEntry[]> {
  if (inTauri) return invoke<QuotaEntry[]>('quota_read');
  const now = Math.floor(Date.now() / 1000);
  const out: QuotaEntry[] = [];
  for (const a of accts) {
    const d = a.dir.replace(/\\/g, '/');
    if (/\/\.claude$/.test(d)) {
      out.push({ accountId: a.id, at: now, fiveHour: { used: 62, resetsAt: now + 2 * 3600 + 10 * 60 }, sevenDay: { used: 31, resetsAt: now + 4 * 86400 + 3 * 3600 },
        limits: [{ kind: 'weekly_scoped', percent: 48, resetsAt: now + 4 * 86400 + 3 * 3600, scope: 'Fable', active: true }] });
    } else if (/\/\.claude-b$/.test(d)) {
      out.push({ accountId: a.id, at: now, fiveHour: { used: 96, resetsAt: now + 38 * 60 }, sevenDay: { used: 78, resetsAt: now + 2 * 86400 + 5 * 3600 } });
    }
  }
  return out;
}

/**
 * Consulta opcional de uso a Anthropic (ver docs/SECURITY.md). El backend lee el token de la carpeta de cada cuenta;
 * aquí solo viajan el id y la carpeta, y vuelven estados y porcentajes (nunca el token). Quien llama debe haberlo
 * pedido el usuario (ajuste `usageQuery`, el botón «Probar ahora» o el de refrescar).
 * `force` = a mano (el backend baja su suelo de 60 s a 10 s); `renew` = si el token caducó, pedir a Claude Code que lo renueve.
 */
export async function usageFetch(accts: { id: string; dir: string }[], intervalMin: number, opts: { force?: boolean; renew?: boolean } = {}): Promise<UsageResult[]> {
  if (inTauri) return invoke<UsageResult[]>('usage_fetch', { accounts: accts, intervalMin, force: !!opts.force, renew: !!opts.renew });
  const now = Math.floor(Date.now() / 1000);
  return accts.map((a) => ({ accountId: a.id, status: 'ok' as const, fetchedAt: now, fiveHour: { used: 42, resetsAt: now + 3 * 3600 }, sevenDay: { used: 18, resetsAt: now + 3 * 86400 } }));
}

/**
 * Latencia de los paneles SSH: tiempo de conexión TCP (se abre y se cierra, no se envía nada). Solo se llama con las direcciones
 * de los paneles SSH del propio usuario. `error` es genérico: 'timeout' | 'unreachable' | 'invalid'.
 */
export interface PingResult { id: string; ms: number | null; error: 'timeout' | 'unreachable' | 'invalid' | null }
/** Cuántas llamadas se han hecho (solo la demo la usa, para comprobar la cadencia del sondeo). */
export const demoPingCalls = { n: 0 };
export async function netPing(targets: { id: string; host: string; port: number }[], timeoutSec: number): Promise<PingResult[]> {
  if (inTauri) return invoke<PingResult[]>('net_ping', { targets, timeoutMs: Math.round(timeoutSec * 1000) });
  // Demo: 20–60 ms con un poco de ruido. `?lat=250` fija el centro (para ver los colores); `?latfail=1` hace que falle siempre.
  demoPingCalls.n++;
  const q = new URLSearchParams(location.search);
  const centre = Number(q.get('lat')) || 40;
  const fail = q.get('latfail') === '1';
  return targets.map((t, i) => fail
    ? { id: t.id, ms: null, error: 'timeout' as const }
    : { id: t.id, ms: Math.max(1, centre + (((demoPingCalls.n * 7 + i * 13) % 41) - 20) * (centre > 100 ? 0.2 : 0.5)), error: null });
}

if (!inTauri && typeof window !== 'undefined') {
  // Solo demo: simula que se caen todas las conexiones (código 255), para ver la reconexión automática sin red.
  (window as unknown as Record<string, unknown>).__orchestraDemoDrop = (code = 255) => { for (const id of [...demo.keys()]) for (const cb of demoExit) cb(id, code); };
  (window as unknown as Record<string, unknown>).__orchestraDemoPingCalls = () => demoPingCalls.n;
}

/** Parpadeo del botón de la barra de tareas hasta que la ventana pase delante. Nunca lanza; en la demo no hace nada. */
export async function requestAttention(): Promise<void> {
  if (!inTauri) return;
  try {
    const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
    await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
  } catch { /* sin permiso o sin ventana: no pasa nada */ }
}

/** Notificación del sistema (Windows: notificación del centro de actividades, plugin notification). Nunca lanza. */
export async function notify(title: string, body: string): Promise<void> {
  if (!inTauri) { (globalThis as Record<string, unknown>).__orchestraLastNotify = { title, body }; return; }
  try { await invoke('plugin:notification|notify', { options: { title, body } }); } catch { /* sin plugin o sin permiso */ }
}

export async function prepareClaudeDir(dir: string): Promise<void> {
  if (inTauri) await invoke('prepare_claude_dir', { dir });
}

/** Qué se sabe de las instalaciones de Codex y opencode (solo existencia de carpetas y del programa; no se lee nada dentro). */
export interface ProviderDetect {
  codexInstalled: boolean; codexDir?: string;
  opencodeInstalled: boolean; opencodeDir?: string;
}
export async function providerDetect(): Promise<ProviderDetect> {
  if (!inTauri) return { codexInstalled: !demoQuery()?.has('mcpnone'), codexDir: DEMO_CODEX_DEFAULT, opencodeInstalled: true, opencodeDir: 'C:/Users/demo/.local/share/opencode' };
  return invoke<ProviderDetect>('provider_detect');
}
/** Crea la carpeta de una cuenta de Codex u opencode (solo dentro de tu carpeta de usuario y con el prefijo esperado).
 *  Codex: si la carpeta es nueva, escribe en SU config.toml la línea cli_auth_credentials_store = "file". */
export interface ProviderPrepared { created: boolean; wroteConfig: boolean }
export async function providerPrepare(provider: 'codex' | 'opencode', dir: string): Promise<ProviderPrepared> {
  if (!inTauri) return { created: true, wroteConfig: provider === 'codex' };
  return invoke<ProviderPrepared>('provider_prepare', { provider, dir });
}
/** Estado de la sesión de una cuenta, sin leer secretos: "codex login status" / "opencode auth list" con el entorno de esa cuenta.
 *  El backend devuelve solo el veredicto (nunca la salida del comando). */
export type ProviderLoginStatus = 'signedIn' | 'notSignedIn' | 'unknown';
export interface ProviderStatus { status: ProviderLoginStatus; /** chatgpt | apikey | other (Codex) */ method?: string; /** nº de integraciones (opencode) */ count?: number }
export async function providerStatus(provider: 'codex' | 'opencode', dir: string, isDefault: boolean): Promise<ProviderStatus> {
  if (!inTauri) return { status: provider === 'codex' ? 'signedIn' : 'notSignedIn', method: provider === 'codex' ? 'chatgpt' : undefined, count: provider === 'opencode' ? 0 : undefined };
  return invoke<ProviderStatus>('provider_status', { provider, dir, isDefault });
}

// ---------- gestor de MCP por cuenta (mcp_manager.rs: lectura; mcp_manager/write.rs: escritura) ----------
/** Un MCP configurado en una cuenta. Los valores de env/cabeceras nunca llegan aquí: solo sus nombres (se pintan como `•••`). */
export interface McpDef {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string | null;
  /** Argumentos con los que parecen claves ya cambiados por `•••`. */
  args: string[];
  /** URL con los valores de la query y la contraseña cambiados por `•••`. */
  url: string | null;
  cwd: string | null;
  envKeys: string[];
  headerKeys: string[];
  /** Variables que la herramienta toma de su entorno (Codex `env_vars`, `bearer_token_env_var`). */
  envPassthrough: string[];
  /** `null`: la herramienta no dice nada (en `.mcp.json`: Claude aún no ha preguntado si se aprueba). */
  enabled: boolean | null;
  /** `plugin` y `claudeai` = gestionados fuera de la config de la cuenta (solo se muestran). */
  scope: 'user' | 'local' | 'project' | 'global' | 'plugin' | 'claudeai';
  projectPath: string | null;
  rawKind: string;
  /** Codex: `auth_status` de `codex mcp list`. */
  authStatus: string | null;
  /** Proyectos en los que Claude lo tiene apagado (`disabledMcpServers`) aunque esté definido arriba. */
  disabledIn: string[];
  /** `plugin:<id>` | `claude.ai` | null. */
  managedBy: string | null;
  /** Misma huella = misma definición (válida mientras Orchestra sigue abierto). */
  fingerprint: string;
}
export interface McpAccount {
  /** `claude:<dir>` | `codex:<dir>` | `opencode:global` */
  id: string;
  provider: 'claude' | 'codex' | 'opencode';
  dir: string;
  isDefault: boolean;
  label: string | null;
  source: string;
  servers: McpDef[];
  /** Fallo de esta cuenta; las demás se listan igual. */
  error: string | null;
}
export type McpProbeResult =
  /** `toolsBytes`: JSON compacto de las definiciones de `tools/list`; `tokensEst` ≈ toolsBytes / 4 (lo que cuestan en cada sesión). */
  | { status: 'ok'; tools: number; serverName: string | null; version: string | null; toolsBytes: number; tokensEst: number }
  | { status: 'needsAuth' }
  | { status: 'failed'; msg: string }
  | { status: 'timeout' };
/** `projects`: carpetas de los paneles abiertos (para leer su `.mcp.json`). */
export async function mcpmList(projects: string[] = []): Promise<McpAccount[]> {
  if (!inTauri) return demoMcpAccounts();
  return invoke<McpAccount[]>('mcpm_list', { projects });
}
/** Firma barata (mtime + tamaño) de los ficheros que lee `mcpmList`: si cambia, toca volver a listar. */
export async function mcpmStamp(projects: string[] = []): Promise<string> {
  if (!inTauri) return 'demo';
  return invoke<string>('mcpm_stamp', { projects });
}
export async function mcpmProbe(accountId: string, scope: McpDef['scope'], name: string, projectPath?: string | null): Promise<McpProbeResult> {
  if (!inTauri) return demoMcpProbe(accountId, name);
  return invoke<McpProbeResult>('mcpm_probe', { accountId, scope, name, projectPath: projectPath ?? null });
}

// --- F2: escribir (mcp_manager/write.rs). Nada se ejecuta sin `mcpmApply`, que la interfaz solo llama tras la vista previa. ---
export interface McpKvInput { key: string; value: string }
/** Definición del formulario. Los valores van a Rust una vez (para escribirlos); nunca vuelven. */
export interface McpDefInput {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string | null;
  args: string[];
  url: string | null;
  env: McpKvInput[];
  headers: McpKvInput[];
  bearerEnvVar: string | null;
  /** Claude: `user` (toda la cuenta), `local` (solo tú, en `projectPath`) o `project` (`.mcp.json` de `projectPath`).
   *  Codex y opencode solo tienen ámbito global: con otro, la vista previa lo dice y ese paso no se aplica. */
  scope?: 'user' | 'local' | 'project';
  projectPath?: string | null;
}
export interface McpSourceRef { accountId: string; scope: McpDef['scope']; name: string; projectPath: string | null }
export type McpChange =
  | { kind: 'add'; def: McpDefInput; targets: string[]; replace: boolean }
  /** «Aplicar a…» (replace false) e «Igualar a esta» (true): Rust lee la definición (con sus valores) de la cuenta origen. */
  | { kind: 'copy'; from: McpSourceRef; targets: string[]; replace: boolean; includeLocal?: boolean }
  /** `includeLocal`: Claude, también las copias del ámbito local de cada proyecto (`claude mcp remove --scope local` en esa carpeta). */
  | { kind: 'remove'; name: string; targets: string[]; includeLocal?: boolean }
  /** Aprobar un MCP de `.mcp.json` (Claude): `enabledMcpjsonServers` de `<proyecto>\.claude\settings.local.json`. */
  | { kind: 'approve'; accountId: string; name: string; projectPath: string }
  /** Encender / apagar: Claude `projects[carpeta].disabledMcpServers` de `.claude.json`; opencode `enabled`. */
  | { kind: 'setEnabled'; accountId: string; name: string; scope: McpDef['scope']; projectPath: string | null; on: boolean };
export interface McpPlanStep {
  accountId: string;
  provider: McpAccount['provider'];
  action: 'add' | 'replace' | 'remove' | 'skip' | 'state';
  /** Fichero que la herramienta va a modificar (se copia antes). */
  file: string;
  /** Comando exacto por cuenta (secretos como •••) o cambio de fichero (opencode). */
  lines: string[];
  /** No se puede hacer en esta cuenta (y por qué); no se aplica nada de este paso. */
  blocked: string | null;
  note: string | null;
}
export interface McpStepResult { accountId: string; status: 'ok' | 'failed' | 'skipped'; msg: string; verified: boolean | null }
export interface McpApplyResult { steps: McpStepResult[]; undoId: number | null }
export interface McpUndoInfo { id: number; summary: string; files: string[] }

export async function mcpmPlan(change: McpChange): Promise<McpPlanStep[]> {
  if (!inTauri) return demoMcpPlan(change);
  return invoke<McpPlanStep[]>('mcpm_plan', { change });
}
export async function mcpmApply(change: McpChange): Promise<McpApplyResult> {
  if (!inTauri) return demoMcpApply(change);
  return invoke<McpApplyResult>('mcpm_apply', { change });
}
export async function mcpmUndoInfo(): Promise<McpUndoInfo | null> {
  if (!inTauri) return demoUndo;
  return invoke<McpUndoInfo | null>('mcpm_undo_info');
}
export async function mcpmUndo(): Promise<McpUndoInfo> {
  if (!inTauri) {
    const u = demoUndo;
    if (!u) throw new Error('Nothing to undo');
    demoUndo = null;
    // Como la copia de Rust: vuelve al estado de antes del cambio.
    if (demoUndoSnap) {
      demoEdits.clear();
      for (const [k, m] of demoUndoSnap.edits) demoEdits.set(k, new Map(m));
      demoLocalGone.clear();
      for (const k of demoUndoSnap.gone) demoLocalGone.add(k);
      demoState.clear();
      for (const [k, v] of demoUndoSnap.state) demoState.set(k, v);
      demoUndoSnap = null;
    }
    return u;
  }
  return invoke<McpUndoInfo>('mcpm_undo');
}

// Demo de la escritura: imita lo que devuelve Rust (mismas formas de comando), sin tocar nada.
let demoUndo: McpUndoInfo | null = null;
/** Cambios aplicados en modo demo (para que el listado posterior los refleje): cuenta → nombre → añadido (def) o quitado (null). */
const demoEdits = new Map<string, Map<string, McpDef | null>>();
/** Copias del ámbito local quitadas en la demo (`includeLocal`): `cuenta|nombre|carpeta`. */
const demoLocalGone = new Set<string>();
let demoUndoSnap: { edits: [string, Map<string, McpDef | null>][]; gone: string[]; state: [string, boolean][] } | null = null;
const demoLocalKey = (accountId: string, name: string, path: string | null) => `${accountId}|${name}|${(path ?? '').replace(/\\/g, '/')}`;
const demoWin = (p: string) => p.replace(/\//g, '\\');
/** «Abrir fichero»: el fichero de configuración de esa cuenta en el Explorador. */
export async function mcpmReveal(accountId: string): Promise<void> {
  if (inTauri) await invoke('mcpm_reveal', { accountId });
}
function demoQuote(a: string): string {
  return /^[A-Za-z0-9_./:=\\@,+%•-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`;
}
const changeName = (c: McpChange) => (c.kind === 'add' ? c.def.name : c.kind === 'copy' ? c.from.name : c.name);
/** Estado encendido/aprobado puesto en la demo: `cuenta|nombre|ámbito|carpeta` → enabled. */
const demoState = new Map<string, boolean>();
const demoStateKey = (accountId: string, name: string, scope: string, path: string | null) => `${accountId}|${name}|${scope}|${(path ?? '').replace(/\\/g, '/')}`;
/** Demo de Aprobar / Encender / Apagar: las mismas líneas que Rust (ruta de claves = valor). */
function demoStatePlan(change: Extract<McpChange, { kind: 'approve' | 'setEnabled' }>): McpPlanStep[] {
  const a = demoMcpAccounts().find((x) => x.id === change.accountId);
  if (!a) throw new Error('Unknown account');
  const name = change.name;
  const proj = change.projectPath;
  const projectFile = (p: string) => `${demoWin(p)}\\.claude\\settings.local.json`;
  const claudeFile = a.isDefault ? 'C:\\Users\\demo\\.claude.json' : `${demoWin(a.dir)}\\.claude.json`;
  const base: McpPlanStep = { accountId: a.id, provider: a.provider, action: 'state', file: '', lines: [], blocked: null, note: null };
  const on = change.kind === 'approve' ? true : change.on;
  if (a.provider === 'codex') return [{ ...base, file: `${demoWin(a.dir)}\\config.toml`, blocked: `Codex has no command to turn a server on or off: change \`enabled\` under [mcp_servers.${name}] in ${demoWin(a.dir)}\\config.toml` }];
  if (a.provider === 'opencode') return [{ ...base, file: `${demoWin(a.dir)}\\opencode.json`, lines: [`["mcp"]["${name}"]["enabled"] = ${on}`] }];
  if (change.kind === 'approve' || change.scope === 'project') return [{ ...base, file: projectFile(proj ?? ''), lines: on ? [`["enabledMcpjsonServers"] = ["${name}"]`] : [`["disabledMcpjsonServers"] = ["${name}"]`] }];
  return [{ ...base, file: claudeFile, lines: [`["projects"]["${(proj ?? '').replace(/\\/g, '/')}"]["disabledMcpServers"] = ${on ? '[]' : `["${name}"]`}`] }];
}
function demoMcpPlan(change: McpChange): McpPlanStep[] {
  if (change.kind === 'approve' || change.kind === 'setEnabled') return demoStatePlan(change);
  const accs = demoMcpAccounts();
  const name = changeName(change);
  // Copiar / igualar: la definición de la cuenta origen (como hace Rust), no una inventada.
  const src = change.kind === 'copy' ? accs.find((a) => a.id === change.from.accountId)?.servers.find((d) => d.name === name && d.scope === change.from.scope && (d.projectPath ?? null) === (change.from.projectPath ?? null)) : undefined;
  const def: McpDefInput = change.kind === 'add' ? change.def
    : { name, transport: src?.transport ?? 'stdio', command: src?.command ?? 'npx', args: src?.args ?? [], url: src?.url ?? null, env: (src?.envKeys ?? []).map((key) => ({ key, value: 'x' })), headers: (src?.headerKeys ?? []).map((key) => ({ key, value: 'x' })), bearerEnvVar: null };
  return change.targets.map((id): McpPlanStep => {
    const a = accs.find((x) => x.id === id)!;
    const cur = a.servers.find((d) => d.name === name && (d.scope === 'user' || d.scope === 'global'));
    const has = !!cur;
    const alsoLocal = a.provider === 'claude' && a.servers.some((d) => d.name === name && d.scope === 'local');
    const envPre = a.provider === 'claude' && !a.isDefault ? `CLAUDE_CONFIG_DIR=${demoWin(a.dir)} ` : a.provider === 'codex' ? `CODEX_HOME=${demoWin(a.dir)} ` : '';
    const file = a.provider === 'claude' ? (a.isDefault ? 'C:\\Users\\demo\\.claude.json' : `${demoWin(a.dir)}\\.claude.json`) : a.provider === 'codex' ? `${demoWin(a.dir)}\\config.toml` : `${demoWin(a.dir)}\\opencode.json`;
    const base: McpPlanStep = { accountId: id, provider: a.provider, action: 'add', file, lines: [], blocked: null, note: null };
    const locals = a.provider === 'claude' ? a.servers.filter((d) => d.name === name && d.scope === 'local' && d.projectPath) : [];
    const localLines = (ls: McpDef[]) => ls.map((d) => `cd ${demoQuote(d.projectPath ?? '')} && ${envPre}claude mcp remove ${name} --scope local`);
    if (change.kind === 'remove') {
      const inc = !!change.includeLocal && locals.length > 0;
      if (!has) return inc ? { ...base, action: 'remove', lines: localLines(locals), note: 'Only in the local scope of its projects: removes those' } : { ...base, action: 'skip', note: 'Not in this account' };
      const lines = a.provider === 'claude' ? [`${envPre}claude mcp remove ${name} --scope user`] : a.provider === 'codex' ? [`${envPre}codex mcp remove ${name}`] : [`opencode.json: remove mcp.${name}`];
      if (inc) return { ...base, action: 'remove', lines: [...lines, ...localLines(locals)], note: 'Also removes the copies in the local scope of its projects' };
      return { ...base, action: 'remove', lines, note: alsoLocal ? 'Also in the local scope of a project: that one stays' : null };
    }
    const otherLocals = change.kind === 'copy' && change.replace && change.includeLocal && src ? locals.filter((d) => d.fingerprint !== src.fingerprint) : [];
    const scope = change.kind === 'add' ? (change.def.scope ?? 'user') : 'user';
    if (scope !== 'user') {
      if (a.provider !== 'claude') return { ...base, blocked: `Only Claude Code has a ${scope} scope; ${a.provider === 'codex' ? 'Codex' : 'opencode'} only has a global one` };
      const proj = demoWin((change.kind === 'add' && change.def.projectPath) || '');
      const j = def.transport === 'stdio' ? { args: def.args, command: def.command, ...(def.env.length ? { env: Object.fromEntries(def.env.map((e) => [e.key, '•••'])) } : {}), type: 'stdio' } : { type: def.transport, url: def.url };
      return { ...base, file: scope === 'project' ? `${proj}\\.mcp.json` : file, lines: [`cd ${demoQuote(proj)} && ${envPre}claude mcp add-json ${name} '${JSON.stringify(j)}' --scope ${scope}`] };
    }
    if (src && cur && cur.fingerprint === src.fingerprint && a.provider !== 'codex') {
      return otherLocals.length ? { ...base, action: 'remove', lines: localLines(otherLocals), note: 'Already there with the same definition; removes the local-scope copies that differ' } : { ...base, action: 'skip', note: 'Already there with the same definition' };
    }
    const replace = change.replace && has;
    if (has && !change.replace) return { ...base, blocked: 'An MCP with this name already exists in this account' };
    const env = Object.fromEntries(def.env.map((e) => [e.key, '•••']));
    const headers: Record<string, string> = Object.fromEntries(def.headers.map((h) => [h.key, '•••']));
    if (a.provider === 'codex' && def.headers.length) {
      return { ...base, blocked: `Codex CLI cannot set HTTP headers (${def.headers[0].key}); use a bearer-token variable or add it by hand in config.toml` };
    }
    let lines: string[];
    if (a.provider === 'claude') {
      if (def.bearerEnvVar) headers.Authorization = `Bearer \${${def.bearerEnvVar}}`;
      const j = def.transport === 'stdio'
        ? { args: def.args, command: def.command, ...(def.env.length ? { env } : {}), type: 'stdio' }
        : { ...(Object.keys(headers).length ? { headers } : {}), type: def.transport, url: def.url };
      lines = [...(replace ? [`${envPre}claude mcp remove ${name} --scope user`] : []), `${envPre}claude mcp add-json ${name} '${JSON.stringify(j)}' --scope user`, ...localLines(otherLocals)];
    } else if (a.provider === 'codex') {
      lines = [def.transport === 'stdio'
        ? `${envPre}codex mcp add ${name} ${def.env.map((e) => `--env ${e.key}=•••`).join(' ')}${def.env.length ? ' ' : ''}-- ${[def.command ?? '', ...def.args].map(demoQuote).join(' ')}`
        : `${envPre}codex mcp add ${name} --url ${def.url}${def.bearerEnvVar ? ` --bearer-token-env-var ${def.bearerEnvVar}` : ''}`];
    } else {
      if (def.bearerEnvVar) headers.Authorization = `Bearer {env:${def.bearerEnvVar}}`;
      const v = def.transport === 'stdio'
        ? { command: [def.command, ...def.args], enabled: true, ...(def.env.length ? { environment: env } : {}), type: 'local' }
        : { enabled: true, ...(Object.keys(headers).length ? { headers } : {}), type: 'remote', url: def.url };
      lines = [`opencode.json: mcp.${name} = ${JSON.stringify(v)}`];
    }
    return { ...base, action: replace ? 'replace' : 'add', lines };
  });
}
async function demoMcpApply(change: McpChange): Promise<McpApplyResult> {
  await new Promise((r) => setTimeout(r, 1200));
  const name = changeName(change);
  const plan = demoMcpPlan(change);
  const snap = { edits: [...demoEdits].map(([k, m]) => [k, new Map(m)] as [string, Map<string, McpDef | null>]), gone: [...demoLocalGone], state: [...demoState] };
  if (change.kind === 'approve' || change.kind === 'setEnabled') {
    const ok = plan.filter((s) => !s.blocked);
    const scope = change.kind === 'approve' ? 'project' : change.scope;
    const on = change.kind === 'approve' ? true : change.on;
    if (ok.length) demoState.set(demoStateKey(change.accountId, change.name, scope, change.projectPath), on);
    const files = ok.map((s) => s.file);
    if (files.length) { demoUndo = { id: Date.now(), summary: `${change.kind === 'approve' ? 'approve' : on ? 'turn on' : 'turn off'} ${change.name}`, files }; demoUndoSnap = snap; }
    return { steps: plan.map((s) => (s.blocked ? { accountId: s.accountId, status: 'skipped', msg: s.blocked, verified: null } : { accountId: s.accountId, status: 'ok', msg: 'written', verified: true })), undoId: files.length ? demoUndo!.id : null };
  }
  const steps = plan.map((s): McpStepResult => {
    if (s.blocked) return { accountId: s.accountId, status: 'skipped', msg: s.blocked, verified: null };
    if (s.action === 'skip') return { accountId: s.accountId, status: 'skipped', msg: s.note ?? '', verified: null };
    // Capturas: un fallo de escritura en Codex para ver el resultado parcial.
    if (s.provider === 'codex' && name === 'brave-search') return { accountId: s.accountId, status: 'failed', msg: 'Error: failed to write C:\\Users\\demo\\.codex-work\\config.toml: Access is denied. (os error 5)', verified: null }; // i18n-ignore: demo data
    const msg = s.provider === 'claude' ? (s.action === 'remove' ? `Removed MCP server ${name} from user config` : `Added stdio MCP server ${name} to user config`)
      : s.provider === 'codex' ? (s.action === 'remove' ? `Removed global MCP server '${name}'.` : `Added global MCP server '${name}'.`) : 'written';
    for (const l of s.lines) {
      const lm = l.match(/^cd (.+?) && .*--scope local$/);
      if (lm) demoLocalGone.add(demoLocalKey(s.accountId, name, lm[1].replace(/^'|'$/g, '')));
    }
    if (s.lines.every((l) => l.endsWith('--scope local'))) return { accountId: s.accountId, status: 'ok', msg: `Removed MCP server ${name} from local config`, verified: true };
    const m = demoEdits.get(s.accountId) ?? new Map<string, McpDef | null>();
    m.set(name, s.action === 'remove' ? null : demoMcpDef(name, 'demo' + name, { scope: s.provider === 'opencode' ? 'global' : 'user' }));
    demoEdits.set(s.accountId, m);
    return { accountId: s.accountId, status: 'ok', msg, verified: true };
  });
  const files = plan.filter((s) => !s.blocked && s.action !== 'skip').map((s) => s.file);
  if (files.length) { demoUndo = { id: Date.now(), summary: `${change.kind} ${name}`, files }; demoUndoSnap = snap; }
  return { steps, undoId: files.length ? demoUndo!.id : null };
}

function demoMcpAccounts(): McpAccount[] {
  const list = demoMcpBase();
  for (const a of list) {
    for (const [name, d] of demoEdits.get(a.id) ?? []) {
      a.servers = a.servers.filter((x) => !(x.name === name && (x.scope === 'user' || x.scope === 'global')));
      if (d) a.servers.push(d);
    }
    a.servers = a.servers.filter((x) => x.scope !== 'local' || !demoLocalGone.has(demoLocalKey(a.id, x.name, x.projectPath)));
    a.servers = a.servers.map((x) => { const k = demoStateKey(a.id, x.name, x.scope, x.projectPath); return demoState.has(k) ? { ...x, enabled: demoState.get(k)! } : x; });
  }
  return list;
}
async function demoMcpProbe(accountId: string, name: string): Promise<McpProbeResult> {
  await new Promise((r) => setTimeout(r, accountId.startsWith('codex:') ? 2200 : 900));
  if (name === 'linear' && !demoQuery()?.has('mcpauth')) return { status: 'needsAuth' };
  if (name === 'playwright' && accountId.startsWith('codex:')) return { status: 'timeout' };
  if (name === 'postgres') return { status: 'failed', msg: 'the server exited before answering initialize (exit code 1). stderr: error: Failed to spawn: `mcp-server-postgres` Caused by: could not connect to server: Connection refused (os error 10061). Is the server running on host "127.0.0.1" and accepting TCP/IP connections on port 5432?' }; // i18n-ignore: demo data
  const tools: Record<string, [number, number]> = { github: [26, 47_200], filesystem: [14, 9_800], playwright: [21, 28_400], sentry: [18, 21_600], unity: [9, 6_100] };
  const [n, bytes] = tools[name] ?? [3, 1_200];
  return { status: 'ok', tools: n, serverName: name, version: '1.0.0', toolsBytes: bytes, tokensEst: Math.ceil(bytes / 4) };
}

export interface AgentTodo { content: string; status: string; activeForm?: string }
export interface AgentSub { id: string; kind: string; description: string; state: 'running' | 'done'; background: boolean }
export interface Tokens { input: number; output: number; cacheRead: number; cacheCreate: number; thinking: number; requests: number }
export interface AgentInfo {
  paneId: string; agent: 'claude' | 'codex' | 'opencode'; pid: number;
  sessionId?: string; name?: string; title?: string; cwd?: string;
  status: 'busy' | 'idle' | 'waiting' | 'running' | 'shell' | 'new';
  configDir?: string; current?: string; ctxTokens: number;
  lastRequestAt?: number; cacheTtl: number;
  tokens: Tokens; subTokens: Tokens;
  todos: AgentTodo[]; subagents: AgentSub[];
  /** Modelo de la última respuesta, último pedido del usuario (recortado), inicio de la sesión (epoch s) y herramienta que espera permiso. */
  model?: string; lastPrompt?: string; startedAt?: number; waitingFor?: string;
}

/** ¿Existe la transcripción `<id>.jsonl` de esa sesión bajo `<dir>/projects`? (`dir` = carpeta de una cuenta guardada, `id` = UUID.) Solo mira que exista. */
export async function claudeSessionExists(dir: string, id: string): Promise<boolean> {
  if (!inTauri) return true; // modo demo: no hay disco que mirar
  return invoke<boolean>('claude_session_exists', { dir, id });
}
export async function agentScan(ids: string[], dirs: string[]): Promise<AgentInfo[]> {
  if (inTauri) return invoke('agent_scan', { ids, dirs });
  // Modo demo: datos de ejemplo para los dos primeros paneles. `?agents=N` = los N primeros; `?waiting=0,2` = cuáles esperan.
  const now = Math.floor(Date.now() / 1000);
  const nAgents = Math.max(1, Math.min(8, Number(demoParam('agents')) || 2));
  const waitIdx = new Set((demoParam('waiting') ?? '1').split(',').filter((x) => x.trim() !== '').map(Number));
  return ids.slice(0, nAgents).map((id, i): AgentInfo => ({
    paneId: id, agent: 'claude', pid: 1000 + i, status: waitIdx.has(i) ? 'waiting' : 'busy',
    title: i === 0 ? 'Map editor' : i === 1 ? 'SSH terminal manager' : `Demo agent ${i + 1}`, cwd: i === 0 ? 'C:/Users/demo/code/maps' : 'C:/Users/demo', ctxTokens: i === 0 ? 289000 : 121000,
    current: i === 0 ? 'Bash: cargo test --release' : undefined, lastRequestAt: now - (i === 0 ? 120 : 3300), cacheTtl: 3600,
    configDir: i === 0 ? 'C:/Users/demo/.claude' : 'C:/Users/demo/.claude-b',
    model: i === 0 ? 'claude-opus-5-5' : 'claude-sonnet-5-5', startedAt: now - (i === 0 ? 2 * 3600 + 840 : 3 * 3600 + 20 * 60),
    lastPrompt: i === 0 ? 'Make the parser handle multi-line strings and add tests with the real transcripts from last week'
      : 'Add an SSH host list with a ping badge next to each name',
    waitingFor: !waitIdx.has(i) ? undefined : i === 0 ? 'Edit: src/parser.ts' : i === 1 ? 'Bash: ssh-keygen -t ed25519 -f ~/.ssh/orchestra' : 'Bash: npm publish',
    tokens: i === 0 ? { input: 2400, output: 1521000, cacheRead: 230356000, cacheCreate: 4706000, thinking: 312000, requests: 927 }
      : { input: 900, output: 210000, cacheRead: 18000000, cacheCreate: 900000, thinking: 100000, requests: 140 },
    subTokens: i === 0 ? { input: 0, output: 16300000, cacheRead: 2360000000, cacheCreate: 31000000, thinking: 0, requests: 16466 }
      : { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0, requests: 0 },
    todos: i === 0 ? [
      { content: 'Write the parser', status: 'completed' },
      { content: 'Test with real data', status: 'in_progress', activeForm: 'Testing with real data' },
      { content: 'Quota panel', status: 'pending' }] : [],
    subagents: i === 0 ? [
      { id: 'a1', kind: 'implementer', description: 'Build the login form', state: 'running', background: true },
      { id: 'a2', kind: 'reviewer', description: 'Review the API changes', state: 'running', background: true },
      { id: 'a3', kind: 'verifier', description: 'Verify the test suite', state: 'done', background: true }] : [],
  }));
}

/** Un evento ya reducido del transcript de un subagente (el backend nunca manda las líneas JSON en bruto). */
export interface SubEvent {
  kind: 'prompt' | 'text' | 'tool' | 'result'; text: string;
  tool?: string | null; summary?: string | null; ts?: string | null; id?: string | null; error: boolean;
}
export interface SubChunk { events: SubEvent[]; nextOffset: number; done: boolean }

/** Eventos nuevos del transcript de un subagente (solo lectura). `afterOffset` null = carga inicial (el final). Solo ids: la ruta la deriva el backend. */
export async function agentTranscript(paneId: string, subagentId: string, afterOffset: number | null): Promise<SubChunk> {
  if (inTauri) return invoke<SubChunk>('agent_transcript', { paneId, subagentId, afterOffset });
  return demoTranscript(subagentId, afterOffset);
}

// Modo demo: un transcript falso que va creciendo (cada llamada añade un evento mientras «corre»).
const DEMO_SUB: SubEvent[] = [ // i18n-ignore: demo data, only outside Tauri (dev browser)
  { kind: 'prompt', text: 'Build the login form: email + password, validate on blur, show inline errors. Do not touch the API client.', error: false }, // i18n-ignore: demo data
  { kind: 'text', text: 'I will start by looking at how existing forms are structured.', error: false }, // i18n-ignore: demo data
  { kind: 'tool', text: '', tool: 'Glob', summary: 'src/**/*Form*.svelte', id: 'd1', error: false }, // i18n-ignore: demo data
  { kind: 'result', id: 'd1', text: 'src/components/HostDialog.svelte\nsrc/components/AccountDialog.svelte', error: false }, // i18n-ignore: demo data
  { kind: 'tool', text: '', tool: 'Read', summary: 'src/components/HostDialog.svelte', id: 'd2', error: false }, // i18n-ignore: demo data
  { kind: 'result', id: 'd2', text: '<script lang="ts">\n  import { app } from "../lib/store.svelte.ts";\n' + '  // <b>not html</b> **not markdown**\n'.repeat(30), error: false }, // i18n-ignore: demo data
  { kind: 'text', text: 'The dialogs share one pattern: a form, a `valid` derived and an `Esc` handler. I will mirror it.', error: false }, // i18n-ignore: demo data
  { kind: 'tool', text: '', tool: 'Bash', summary: 'npm run check', id: 'd3', error: false }, // i18n-ignore: demo data
  { kind: 'result', id: 'd3', text: 'svelte-check found 1 error\nsrc/components/Login.svelte:12 Type string is not assignable to number', error: true }, // i18n-ignore: demo data
  { kind: 'text', text: 'One type error; fixing it now.', error: false }, // i18n-ignore: demo data
  { kind: 'tool', text: '', tool: 'Edit', summary: 'src/components/Login.svelte', id: 'd4', error: false }, // i18n-ignore: demo data
  { kind: 'result', id: 'd4', text: 'File edited.', error: false }, // i18n-ignore: demo data
  { kind: 'tool', text: '', tool: 'Bash', summary: 'npm test -- login', id: 'd5', error: false }, // i18n-ignore: demo data
  { kind: 'result', id: 'd5', text: '3 passed', error: false }, // i18n-ignore: demo data
  { kind: 'text', text: 'Done: the login form validates on blur and shows inline errors.', error: false }, // i18n-ignore: demo data
];
const demoSeen: Record<string, number> = {};
function demoTranscript(sub: string, after: number | null): SubChunk {
  const running = sub !== 'a3';
  const total = running ? Math.min(DEMO_SUB.length, (demoSeen[sub] = (demoSeen[sub] ?? 5) + (after == null ? 0 : 1))) : DEMO_SUB.length;
  const from = after == null ? 0 : Math.min(after, total);
  return { events: DEMO_SUB.slice(from, total), nextOffset: total, done: !running || total >= DEMO_SUB.length };
}

// ---------- MCP (servidor local para agentes) ----------

export interface McpInfo {
  enabled: boolean; running: boolean; port: number | null; url: string | null;
  error: string | null; configPath: string;
  /** Aviso no fatal (p. ej. no se pudo restringir el acceso a los archivos del token). */
  warning?: string | null;
}
export interface McpAuditEntry {
  ts: string; tool: string; target: string | null; host: string | null;
  outcome: 'allowed' | 'denied'; bytes: number; reason: string | null;
  /** Solo run_command. */
  mode?: string; decision?: 'auto' | 'approved' | 'denied' | 'expired'; command?: string;
  exit_code?: number; duration_ms?: number; output_head?: string;
}
/** Un agente pide ejecutar `command` en un host con acceso `ask`: la interfaz debe contestar con `mcpApprovalAnswer`. */
export interface McpApprovalReq {
  id: string; host: string; address: string; command: string; timeoutSecs: number; expiresInSecs: number;
}
const mcpOff = (enabled: boolean): McpInfo => ({ enabled, running: false, port: null, url: null, error: 'Not available in the browser demo', configPath: '' }); // i18n-ignore: demo data, only outside Tauri (dev browser)

export async function mcpConfigure(enabled: boolean, exposeLocal: boolean): Promise<McpInfo> {
  return inTauri ? invoke<McpInfo>('mcp_configure', { enabled, exposeLocal }) : mcpOff(enabled);
}
export async function mcpInfo(): Promise<McpInfo> {
  return inTauri ? invoke<McpInfo>('mcp_info') : mcpOff(false);
}
export async function mcpToken(): Promise<string> {
  return inTauri ? invoke<string>('mcp_token') : '';
}
export async function mcpRegenerateToken(): Promise<McpInfo> {
  return inTauri ? invoke<McpInfo>('mcp_regenerate_token') : mcpOff(false);
}
export async function mcpSync(snapshot: unknown): Promise<void> {
  if (inTauri) await invoke('mcp_sync', { snapshot });
}
export async function mcpApprovalAnswer(id: string, approve: boolean): Promise<boolean> {
  return inTauri ? invoke<boolean>('mcp_approval_answer', { id, approve }) : false;
}
/** Peticiones de aprobación (`mcp-approval`) y su caducidad (`mcp-approval-end`). Sin Tauri no hay ninguna. */
export async function onMcpApproval(onReq: (r: McpApprovalReq) => void, onEnd: (id: string) => void): Promise<UnlistenFn> {
  if (!inTauri) return () => {};
  const a = await listen<McpApprovalReq>('mcp-approval', (e) => onReq(e.payload));
  const b = await listen<string>('mcp-approval-end', (e) => onEnd(e.payload));
  return () => { a(); b(); };
}
export async function mcpAudit(limit: number): Promise<McpAuditEntry[]> {
  return inTauri ? invoke<McpAuditEntry[]>('mcp_audit', { limit }) : [];
}

// ---------- barra de estado: métricas del equipo (ver metrics.rs y statusbar.ts) ----------
/** Una muestra de métricas locales. La primera devuelve `ready: false` (sin tasas todavía). En modo demo son inventadas. */
export async function metricsSample(): Promise<import('./statusbar.ts').Metrics> {
  if (inTauri) return invoke('metrics_sample');
  const t = Date.now() / 1000;
  const GB = 1024 ** 3;
  return {
    ready: true, cpu: 30 + 25 * Math.sin(t / 7) + 10 * Math.sin(t / 1.3),
    ramUsed: (21 + 1.5 * Math.sin(t / 30)) * GB, ramTotal: 32 * GB, swapUsed: 2 * GB, swapTotal: 8 * GB,
    diskRead: Math.max(0, 8e6 * (1 + Math.sin(t / 3))), diskWrite: Math.max(0, 2e6 * (1 + Math.sin(t / 5))),
    netIn: Math.max(0, 1.2e6 * (1 + Math.sin(t / 2))), netOut: Math.max(0, 2.5e5 * (1 + Math.sin(t / 4))),
    uptime: 3 * 86400 + 5 * 3600 + Math.floor(t % 3600), hostname: 'demo-host',
  };
}
/** Suelta el muestreador del lado Rust (al apagar la barra); también para y vacía el histórico. */
export function metricsReset(): void { if (inTauri) void invoke('metrics_reset'); }
/** Última hora de métricas locales (un punto cada ~5 s). En modo demo: 42 min inventados, con un hueco. */
export async function metricsHistory(): Promise<HistPoint[]> {
  if (inTauri) return invoke('metrics_history');
  return demoHistory(Date.now() / 1000, 42, { seed: 1, ramGB: 32 });
}

// ---------- métricas del servidor por SSH (ver remote_metrics.rs y remotemetrics.ts) ----------
/** Un panel SSH vivo más de este destino: crea (o reutiliza) el monitor. Devuelve su clave. */
export async function rmetricsStart(req: import('./remotemetrics.ts').RmReq): Promise<string> {
  if (inTauri) return invoke<string>('rmetrics_start', { req });
  return `${req.user ?? ''}@${req.host}:${req.port}|${req.jump ?? ''}`;
}
/** Un panel menos; con 0 el monitor se para ~10 s después. */
export function rmetricsStop(key: string): void { if (inTauri) void invoke('rmetrics_stop', { key }); }
/** Ventana oculta/visible: oculta más de 60 s suelta el enlace. */
export function rmetricsHidden(hidden: boolean): void { if (inTauri) void invoke('rmetrics_hidden', { hidden }); }
/** Última hora del servidor de este monitor (vacío si no existe). En modo demo: una hora inventada, sin swap. */
export async function rmetricsHistory(key: string): Promise<HistPoint[]> {
  if (inTauri) return invoke('rmetrics_history', { key });
  if (key.includes('@bad.')) return [];
  return demoHistory(Date.now() / 1000, 60, { seed: 4, swap: false, ramGB: 16 });
}
/** Última muestra del monitor. En modo demo es inventada (un servidor Linux de 8 núcleos). */
export async function rmetricsSample(key: string): Promise<import('./statusbar.ts').RemoteSnap> {
  if (inTauri) return invoke('rmetrics_sample', { key });
  if (key.includes('@bad.')) return { state: 'unavailable', kind: 'hostkey', reason: 'host key not trusted yet: connect with a normal pane first' }; // demo: un host que falla
  const t = Date.now() / 1000;
  const GB = 1024 ** 3;
  return {
    state: 'ok', ageMs: 300,
    sample: {
      ready: true, cpu: 42 + 30 * Math.sin(t / 5) + 8 * Math.sin(t / 1.1),
      ramUsed: (5.2 + 0.4 * Math.sin(t / 20)) * GB, ramTotal: 16 * GB, swapUsed: 0.3 * GB, swapTotal: 2 * GB,
      diskRead: Math.max(0, 3e6 * (1 + Math.sin(t / 4))), diskWrite: Math.max(0, 1.5e6 * (1 + Math.sin(t / 6))),
      netIn: Math.max(0, 6e5 * (1 + Math.sin(t / 3))), netOut: Math.max(0, 9e4 * (1 + Math.sin(t / 2))),
      uptime: 41 * 86400 + 3 * 3600 + Math.floor(t % 3600), hostname: 'db-prod-01', cores: 8, load: 1.27,
    },
  };
}

// ---------- git (branch chip in the pane header; see src-tauri/src/git.rs) ----------
export type { GitInfo } from './gitinfo.ts';
import type { GitInfo as GitInfoT } from './gitinfo.ts';

/** Demo (browser): invented states keyed by the last folder name, so the chip's variants show up in the Vite demo. */
function demoGit(cwd: string): GitInfoT | null {
  const name = cwd.replace(/[\/]+$/, '').split(/[\/]/).pop() ?? '';
  const b: GitInfoT = { repoRoot: cwd, branch: 'main', detached: false, hasUpstream: true, ahead: 0, behind: 0, dirtyCount: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, worktree: false, inProgress: null };
  if (/demo$/i.test(name)) return { ...b, branch: 'feature/git-branch-in-header', dirtyCount: 3, untracked: 1, ahead: 2, behind: 1 };
  if (/orchestra/i.test(name)) return { ...b, branch: 'main', dirtyCount: 2, ahead: 1 };
  if (/clean/i.test(name)) return b;
  if (/rebase/i.test(name)) return { ...b, branch: 'fix/merge-conflicts-in-the-sidebar', dirtyCount: 4, conflicts: 2, inProgress: 'rebase' };
  if (/detached/i.test(name)) return { ...b, branch: '3f9a1c2', detached: true };
  if (/tree/i.test(name)) return { ...b, branch: 'wt-experiment', worktree: true, untracked: 2 };
  return null;
}
/** Git state of a local folder, or null (not a repo, git missing, too slow). Never throws. */
export async function gitInfo(cwd: string): Promise<GitInfoT | null> {
  if (!inTauri) return demoGit(cwd);
  try { return await invoke<GitInfoT | null>('git_info', { cwd }); } catch { return null; }
}
export async function gitAvailable(): Promise<boolean> {
  if (!inTauri) return true;
  try { return await invoke<boolean>('git_available'); } catch { return false; }
}

// ---------- pegar y soltar imágenes en los terminales (ver clipimg.rs e imagepaste.ts) ----------
export interface ImgInfo { width: number; height: number }
export interface SavedImage extends ImgInfo { path: string; bytes: number }

/** Tamaño de la imagen del portapapeles, o null si no hay. */
export async function clipboardImageInfo(): Promise<ImgInfo | null> {
  if (!inTauri) return null;
  return invoke<ImgInfo | null>('clipboard_image_info');
}
/** Guarda la imagen del portapapeles en PNG en la caché; null si no hay imagen. Error «too-large:<bytes>» si pasa del tope. */
export async function clipboardImageToFile(): Promise<SavedImage | null> {
  if (!inTauri) return null;
  return invoke<SavedImage | null>('clipboard_image_to_file');
}
/**
 * Copia texto al portapapeles: por Rust (arboard, clipimg.rs) y, si eso falla, por `navigator.clipboard`.
 * Lanza el error de Rust si fallan los dos: quien llama tiene que avisar, nunca tragárselo.
 */
export async function copyText(text: string): Promise<void> {
  if (!inTauri) return navigator.clipboard.writeText(text);
  try {
    await invoke('clipboard_write_text', { text });
  } catch (e) {
    try { await navigator.clipboard.writeText(text); } catch { throw e; }
  }
}
/** Sube un archivo de imagen local a ~/.cache/orchestra-paste/ del host y devuelve la ruta remota. */
export async function sshUploadImage(dest: import('./imagepaste.ts').UploadDest, path: string): Promise<string> {
  if (!inTauri) throw new Error('not available in the browser');
  return invoke<string>('ssh_upload_image', { dest, path });
}
/** Archivos soltados en un panel desde el Explorador (rutas reales que da WebView2; ver terminals.ts). */
export async function onFileDrop(cb: (pane: string, paths: string[]) => void): Promise<UnlistenFn> {
  if (!inTauri) return () => {};
  return listen<{ pane: string; paths: string[] }>('orchestra-file-drop', (e) => cb(e.payload.pane, e.payload.paths));
}
// ── Consumo (consumo.rs): a qué se van los tokens. Tipos en camelCase como los serializa Rust. ──
export type ConsumoCat = 'base' | 'read' | 'bash' | 'search' | 'mcp' | 'image' | 'subagent' | 'reminder'
  | 'user' | 'compact' | 'otherTool' | 'output' | 'thinking' | 'unattributed';
export interface ConsumoUsage { input: number; cacheCreate: number; cache5m: number; cache1h: number; cacheRead: number; output: number; thinking: number }
/** `eq`: coste real en tokens de entrada equivalentes; `usd`: el mismo a precio de API (solo para comparar modelos). */
export interface ConsumoCatAgg { cat: ConsumoCat; count: number; t: number; eq: number; usd: number }
export interface ConsumoTopBlock {
  cat: ConsumoCat; tool?: string; detail?: string; req: number; ts: number; t: number; eq: number; usd: number;
  /** Fórmula comprobable: eq = t × w + t × n × r (w escritura/token, n relecturas en el periodo, r lectura/token). */
  w?: number; n?: number; r?: number;
  rereads: number; session?: string; who?: string;
}
export interface ConsumoEvent {
  kind: 'compaction' | 'cacheBroken' | 'coldStart'; req: number; ts: number; tokens: number;
  cause?: 'expired' | 'modelChanged' | 'prefixChanged'; extra: number; cost: number;
}
export interface ConsumoSummary {
  requests: number; base: number; lastContext: number; maxContext: number; usage: ConsumoUsage;
  cats: ConsumoCatAgg[]; top: ConsumoTopBlock[]; events: ConsumoEvent[]; models: string[];
  badLines: number; shrink: number; firstTs: number; lastTs: number;
}
export interface ConsumoWho { agentType: string | null; description: string | null }
export interface ConsumoFileReport { path: string; who: ConsumoWho; summary: ConsumoSummary }
export interface ConsumoSessionReport {
  main: ConsumoFileReport; contextLine: [number, number, number][]; baseParts: [string, number][]; subagents: ConsumoFileReport[];
  /** Consejos de la sesión (consumo/consejos.rs), ya sin los descartados. */
  advice?: ConsumoAdvice[];
  /** C11: ahorro si se aplican todos los consejos, sin doble conteo: [usd, eq]. */
  adviceTotal?: [number, number];
  /** Bloques agrupados por origen (los más caros y los que cita algún consejo). */
  origins?: ConsumoOrigin[];
}
export type ConsumoSeverity = 'info' | 'low' | 'medium' | 'high';
/** Prueba de un consejo: `session` = ruta del transcript (se abre en el cajón), `req` = petición. */
export interface ConsumoEvidence {
  session?: string; req?: number; who?: string; label: string; tokens: number; rereads: number; usd: number;
  /** C10: etiqueta traducible (`consumo.adv.ev.<labelId>` con `lp`). */
  labelId?: string; lp?: Record<string, string | number>;
}
export interface ConsumoAdvice {
  id: string; rule: string; severity: ConsumoSeverity; title: string; why: string; action: string;
  /** C10: texto por clave de i18n (`consumo.adv.<textId>.<campo>[<Variante>]`) y sus parámetros (consumo.ts adviceText). */
  textId?: string; params?: Record<string, string | number>;
  evidence: ConsumoEvidence[];
  /** Ahorro estimado: tokens de entrada equivalentes, USD y parte (0..1) del total del periodo. */
  saveEq: number; saveUsd: number; savePct: number;
  /** Tarjeta de la que sale (`cat:<categoría>` | `event:<tipo>`) y su cifra, de los MISMOS hechos del periodo/sesión. */
  card?: string; cardUsd?: number; cardEq?: number; cardN?: number;
  /** Cifras con nombre que cita el texto (n, baseMain, baseSub, nMain, nSub, rowN, rowT, outT, thinkT, genShare…). */
  nums?: Record<string, number>;
  /**
   * Origen o partida que cita (C9): `read|<proyecto>|<ruta>`, `bash|<comando>`, `reminder|<skill>`, `image|<sesión>`
   * (= clave de una fila de `origins`), `gen|<quién>|<modelo>`, `cat:…`/`event:…` (tarjeta), `who|…`, `session|…`.
   * El ahorro nunca pasa de su coste; los consejos con el mismo origen no suman más que él.
   */
  origin?: string; originLabel?: string; originUsd?: number; originEq?: number; originN?: number; originT?: number;
  /** Total del periodo o de la sesión (el «de Y» de «calculado sobre X de Y»). */
  totalUsd?: number; totalEq?: number;
  /** Consejo de una sesión. */
  session?: boolean;
  /** C11: lo que quedaría del origen tras aplicarlo (= origen − ahorro) y la suposición que lo modela
   *  (`consumo.adv.assume.<assume>` con `assumeP`). */
  afterUsd?: number; afterEq?: number; assume?: string; assumeP?: Record<string, string | number>;
}
/** Bloques agrupados por origen (consejos.rs `origins`): LA agregación de los consejos, la pantalla y el informe. */
export interface ConsumoOrigin { key: string; cat: ConsumoCat; label: string; project?: string; n: number; t: number; eq: number; usd: number }
/** Lo que la interfaz manda al motor de consejos. */
export interface ConsumoAdviceOpts { lang: string; dismissed: string[]; thresholds?: Record<string, number> }
export interface ConsumoScanReport {
  /** Inicio del periodo (epoch s; recorte por horas). */
  since?: number;
  /** EL total del periodo [eq, usd]: categorías, quién, modelo, proyecto y horas suman esto. */
  total?: [number, number];
  /** Total del periodo anterior de igual duración [eq, usd]. */
  prevTotal?: [number, number];
  /** C10: hay datos de antes del periodo anterior (si no, el Δ % no se enseña). */
  prevComplete?: boolean;
  /** Sobrecoste por tipo de suceso: [expired|modelChanged|prefixChanged|coldStart|compaction, eq, usd, veces]. */
  eventCost?: [string, number, number, number][];
  days: number; files: number; mainFiles: number; subFiles: number; filesRead: number; bytesRead: number; elapsedMs: number;
  cancelled: boolean; requests: number; badLines: number; shrink: number; usage: ConsumoUsage; cats: ConsumoCatAgg[]; top: ConsumoTopBlock[];
  baseMeanMain: number; baseMeanSub: number; byWho: [string, number, number, number][]; byModel: [string, number, number, number][];
  compactions: number; cacheBreaks: number; breakCauses: [number, number, number]; coldStarts: number;
  /** Sobrecoste de las cachés rotas: [eq, usd]. */
  breakCost: [number, number];
  /** Coste por hora epoch UTC (ts / 3600): [hora, eq, usd, peticiones]; el mismo coste atribuido que las categorías. */
  byHour: [number, number, number, number][];
  /** La misma factura por hora partida por categoría: [hora UTC, categoría, eq, usd] (columnas apiladas). */
  byHourCat?: [number, ConsumoCat, number, number][];
  /** Pesos por modelo de la tabla de precios de Rust: [modelo, lectura de caché, escritura 5 min, escritura 1 h, salida] (× entrada). */
  modelWeights?: [string, number, number, number, number][];
  /** Factura por carpeta de proyecto (`C--Users-x-app`): [carpeta, eq, usd, peticiones]; dentro del periodo. */
  byProject: [string, number, number, number][];
  pruned: number; indexBytes: number;
  advice?: ConsumoAdvice[];
  /** C11: ahorro si se aplican todos los consejos, sin doble conteo: [usd, eq]. */
  adviceTotal?: [number, number];
  /** Bloques agrupados por origen (los más caros y los que cita algún consejo). */
  origins?: ConsumoOrigin[];
  historyBytes?: number;
}
/** Consumo de una sesión (.jsonl) y sus subagentes. Fuera de Tauri: null. */
export async function consumoSession(path: string, opts?: ConsumoAdviceOpts): Promise<ConsumoSessionReport | null> {
  if (!inTauri) return { ...demoSessionReport(Math.floor(Date.now() / 1000)), advice: demoAdvice(opts, true) };
  return invoke<ConsumoSessionReport | null>('consumo_session', { path, opts });
}
/** Consumo de la sesión de un panel (`dir` = carpeta de la cuenta, `id` = UUID de la sesión). Modo demo: datos de ejemplo. */
export async function consumoPane(dir: string, id: string, opts?: ConsumoAdviceOpts): Promise<ConsumoSessionReport | null> {
  if (!inTauri) return { ...demoSessionReport(Math.floor(Date.now() / 1000)), advice: demoAdvice(opts, true) };
  return invoke<ConsumoSessionReport | null>('consumo_pane', { dir, id, opts });
}
/** Informe Markdown para pegar a una IA (el mismo que devuelve la herramienta MCP `usage_report`). */
export async function consumoReport(days: number, detail: 'summary' | 'full', opts?: ConsumoAdviceOpts): Promise<string> {
  if (!inTauri) { await new Promise((r) => setTimeout(r, 120)); return demoReport(days, detail, opts); }
  return invoke<string>('consumo_report', { days, detail, opts });
}
/** Guarda el informe como .md en Descargas; devuelve la ruta. */
export async function consumoSaveReport(markdown: string): Promise<string> {
  if (!inTauri) return 'C:\\Users\\demo\\Downloads\\orchestra-usage-demo.md';
  return invoke<string>('consumo_save_report', { markdown });
}
/** Escaneo global (por defecto 7 días, todas las cuentas). Progreso por `consumo-progress`. */
export async function consumoScan(days?: number, accounts?: string[], onProgress?: (done: number, total: number) => void, opts?: ConsumoAdviceOpts, since?: number): Promise<ConsumoScanReport | null> {
  if (!inTauri) {
    // Modo demo: un escaneo de mentira con progreso (para ver la barra y el botón de cancelar).
    demoCancel = false;
    for (let i = 1; i <= 8; i++) {
      await new Promise((r) => setTimeout(r, 60));
      if (demoCancel) return { ...demoScanReport(days ?? 7, Math.floor(Date.now() / 1000)), cancelled: true, advice: demoAdvice(opts, false, days ?? 7) };
      onProgress?.(i * 40, 320);
    }
    // `?consumo=empty` / `?consumo=error`: estados vacío y de error (capturas).
    const flag = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('consumo') : null;
    if (flag === 'error') throw new Error('demo: could not read ~/.claude/projects (access denied)');
    const rep = demoScanReport(days ?? 7, Math.floor(Date.now() / 1000));
    if (flag === 'empty') {
      return { ...rep, cats: [], top: [], byWho: [], byModel: [], byHour: [], byHourCat: [], byProject: [], eventCost: [], requests: 0, files: 0, mainFiles: 0, subFiles: 0,
        total: [0, 0], prevTotal: [0, 0], compactions: 0, cacheBreaks: 0, coldStarts: 0, breakCauses: [0, 0, 0], breakCost: [0, 0], baseMeanMain: 0, baseMeanSub: 0, modelWeights: [], advice: [] };
    }
    return { ...rep, advice: demoAdvice(opts, false, days ?? 7) };
  }
  const un = onProgress ? await listen<{ done: number; total: number }>('consumo-progress', (e) => onProgress(e.payload.done, e.payload.total)) : null;
  try { return await invoke<ConsumoScanReport>('consumo_scan', { days, accounts, opts, since }); } finally { un?.(); }
}
export async function consumoCancel(): Promise<void> { if (inTauri) await invoke('consumo_cancel'); else demoCancel = true; }
let demoCancel = false;
