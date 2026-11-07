import { invoke, Channel } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { UsageResult } from './usageQuery.ts';
import { demoHistory, type HistPoint } from './history.ts';

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

export async function ptySpawn(spec: SpawnSpec): Promise<number> {
  if (!inTauri) { if (spec.cwd) demoCwd.set(spec.id, spec.cwd); return 0; }
  return invoke<number>('pty_spawn', { spec });
}

export async function ptyAttach(id: string, onData: (b: Uint8Array) => void): Promise<number | null> {
  if (!inTauri) {
    demo.set(id, onData);
    // `?slow=3000` en la URL de la demo retrasa la primera salida: sirve para ver el aviso «conectando…» de los paneles SSH.
    const slow = Number(new URLSearchParams(location.search).get('slow')) || 0;
    // La demo también «avisa» de su carpeta (OSC 9;9) para ejercitar el manejador real de xterm (etiqueta de git).
    const dirs = ['C:\\Users\\demo', 'C:\\Dev\\orchestra', 'C:\\Dev\\rebase-fix', 'C:\\Dev\\clean-app'];
    const osc = demoCwd.has(id) ? `\x1b]9;9;${dirs[[...demoCwd.keys()].indexOf(id) % dirs.length]}\x07` : '';
    const first = () => demoOut(id, `\x1b[33mOrchestra · demo mode (no backend)\x1b[0m\r\n$ ${osc}`);
    if (slow > 0) setTimeout(first, Math.min(slow, 60000)); else first();
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

export interface ClaudeProfile {
  dir: string; isDefault: boolean; loggedIn: boolean;
  email?: string; plan?: string; org?: string; accountUuid?: string;
}
export async function claudeProfiles(): Promise<ClaudeProfile[]> {
  if (!inTauri) return [
    { dir: 'C:/Users/demo/.claude', isDefault: true, loggedIn: true, email: 'me@example.com', plan: 'Max 20x' },
    { dir: 'C:/Users/demo/.claude-b', isDefault: false, loggedIn: true, email: 'work@example.com', plan: 'Pro' },
  ];
  return invoke('claude_profiles');
}
/** Solo modo demo (navegador): cuentas de Codex y opencode inventadas para ver la barra lateral agrupada por proveedor. En la app real, vacío. */
export function demoProviderAccounts(): { name: string; dir: string; provider: 'codex' | 'opencode'; color: string }[] {
  if (inTauri) return [];
  return [
    { name: 'Work', dir: 'C:/Users/demo/.codex-work', provider: 'codex', color: '#10a37f' },
    { name: 'Side', dir: 'C:/Users/demo/.opencode-side', provider: 'opencode', color: '#c58af9' },
  ];
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
 * pedido el usuario (ajuste `usageQuery` o el botón «Probar ahora»).
 */
export async function usageFetch(accts: { id: string; dir: string }[], intervalMin: number): Promise<UsageResult[]> {
  if (inTauri) return invoke<UsageResult[]>('usage_fetch', { accounts: accts, intervalMin });
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

export async function prepareClaudeDir(dir: string): Promise<void> {
  if (inTauri) await invoke('prepare_claude_dir', { dir });
}

/** Qué se sabe de las instalaciones de Codex y opencode (solo existencia de carpetas y del programa; no se lee nada dentro). */
export interface ProviderDetect {
  codexInstalled: boolean; codexDir?: string;
  opencodeInstalled: boolean; opencodeDir?: string;
}
export async function providerDetect(): Promise<ProviderDetect> {
  if (!inTauri) return { codexInstalled: true, codexDir: 'C:/Users/demo/.codex', opencodeInstalled: true, opencodeDir: 'C:/Users/demo/.local/share/opencode' };
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
  // Modo demo: datos de ejemplo para los dos primeros paneles.
  const now = Math.floor(Date.now() / 1000);
  return ids.slice(0, 2).map((id, i): AgentInfo => ({
    paneId: id, agent: 'claude', pid: 1000 + i, status: i === 0 ? 'busy' : 'waiting',
    title: i === 0 ? 'Maps -3-4-5-6' : 'SSH terminal manager', cwd: i === 0 ? 'C:/Users/demo/code/maps' : 'C:/Users/demo', ctxTokens: i === 0 ? 289000 : 121000,
    current: i === 0 ? 'Bash: cargo test --release' : undefined, lastRequestAt: now - (i === 0 ? 120 : 3300), cacheTtl: 3600,
    configDir: i === 0 ? 'C:/Users/demo/.claude' : 'C:/Users/demo/.claude-b',
    model: i === 0 ? 'claude-opus-5-5' : 'claude-sonnet-5-5', startedAt: now - (i === 0 ? 2 * 3600 + 840 : 3 * 3600 + 20 * 60),
    lastPrompt: i === 0 ? 'Make the parser handle multi-line strings and add tests with the real transcripts from last week'
      : 'Add an SSH host list with a ping badge next to each name',
    waitingFor: i === 0 ? undefined : 'Bash: ssh-keygen -t ed25519 -f ~/.ssh/orchestra',
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
