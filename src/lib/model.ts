// Modelo puro (sin Svelte ni Tauri) para poder probarlo con `node --test`.
// Solo sintaxis TS borrable: sin enums ni namespaces.
import { t } from './i18n.ts';
import type { ItemId } from './statusbar.ts';

export type PaneKind = 'shell' | 'ssh' | 'agent';

export interface PaneSpec {
  program: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface Pane {
  id: string;
  /** Celda en la cuadrícula. `parked` = vivo pero sin hueco visible. */
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  parked: boolean;
  kind: PaneKind;
  icon: string;
  title: string;
  /** Referencia al perfil de origen (host, shell, agente) para reiniciar o mostrar. */
  ref?: string;
  spec: PaneSpec;
  /** Última sesión de Claude que alojó este panel (la ve el escaneo de agentes). Sirve para retomarla al reabrir. */
  lastSession?: LastSession;
}

/** `id` = UUID de la sesión; `dir` = carpeta de la cuenta donde vive su transcripción; `ended` = la cerró el usuario (/exit). */
export interface LastSession { id: string; dir: string; ended?: boolean }

export interface Workspace {
  id: string;
  name: string;
  cols: number[]; // fracciones, suman 1
  rows: number[];
  panes: Pane[];
  focusId?: string;
  maximizedId?: string;
  /** Elementos propios de la barra de estado en esta pestaña (ausente = la lista global). Ver statusbar.ts. */
  statusBarItems?: ItemId[];
}

/** Permiso que se da a los agentes (Claude, Codex...) para usar este host vía MCP. */
export type AgentAccess = 'none' | 'read' | 'ask' | 'full';

export type AuthMethod = 'agent' | 'key' | 'password';
export const AUTH_METHODS: AuthMethod[] = ['agent', 'key', 'password'];

/** Qué hacer con la huella del servidor en hosts con secreto guardado (el askpass no contesta «yes/no»).
 *  'confirm' = Orchestra enseña la huella y pregunta antes de confiar; 'accept-new' = confiar la primera vez. */
export type HostKeyPolicy = 'confirm' | 'accept-new';
export const HOST_KEY_POLICIES: readonly HostKeyPolicy[] = ['confirm', 'accept-new'];
/** Valor por host: 'default' = sigue el ajuste global. */
export type HostKeyChoice = 'default' | HostKeyPolicy;
export const HOST_KEY_CHOICES: readonly HostKeyChoice[] = ['default', 'confirm', 'accept-new'];

export interface Host {
  id: string;
  name: string;
  group?: string;
  tags: string[];
  color?: string;
  host: string;
  user?: string;
  port?: number;
  /** 'agent' = ssh-agent / ~/.ssh/config / lo que pida la terminal (comportamiento clásico). */
  authMethod: AuthMethod;
  identityFile?: string;
  /** Solo banderas: el secreto vive en el Administrador de credenciales de Windows, nunca aquí. */
  hasPassword?: boolean;
  hasPassphrase?: boolean;
  /** Huella del servidor con secreto guardado. Ausente o 'default' = el ajuste global. */
  hostKeyPolicy?: HostKeyChoice;
  proxyJump?: string;
  /** Comando remoto al conectar (ej. `cd /srv/app && bash -l`). */
  command?: string;
  /** Reanuda/crea una sesión tmux persistente en el remoto. */
  tmux?: boolean;
  /** Abre una segunda conexión SSH pequeña (no interactiva) para enseñar CPU/RAM/disco/red del servidor en la barra de estado. Apagado por defecto. */
  remoteMetrics?: boolean;
  notes?: string;
  agentAccess: AgentAccess;
}

export const MIN_TRACK_PX = 140;

export interface LayoutPreset {
  id: string;
  label: string;
  cols: number;
  rows: number;
}

export const PRESETS: LayoutPreset[] = [
  { id: '1x1', label: '1 × 1', cols: 1, rows: 1 },
  // `label` con getter: se traduce al LEER (no al importar el módulo).
  { id: '2x1', get label() { return t('model.preset.twoColumns'); }, cols: 2, rows: 1 },
  { id: '1x2', get label() { return t('model.preset.twoRows'); }, cols: 1, rows: 2 },
  { id: '2x2', label: '2 × 2', cols: 2, rows: 2 },
  { id: '3x1', label: '3 × 1', cols: 3, rows: 1 },
  { id: '3x2', label: '3 × 2', cols: 3, rows: 2 },
  { id: '3x3', label: '3 × 3', cols: 3, rows: 3 },
  { id: '4x2', label: '4 × 2', cols: 4, rows: 2 },
  { id: '4x4', label: '4 × 4', cols: 4, rows: 4 },
];

/** Nombre por defecto guardado en el estado (en inglés; ver `displayName`). */
export const DEFAULT_MAIN_NAME = 'Main';
export const defaultWorkspaceName = (n: number): string => `Workspace ${n}`;

/** Texto para MOSTRAR un nombre de espacio de trabajo o de cuenta: los nombres por defecto («Main»,
 *  «Workspace N»), que se guardan siempre en inglés, salen en el idioma actual; cualquier otro nombre, tal cual. */
export function displayName(name: string): string {
  if (name === DEFAULT_MAIN_NAME) return t('model.defaultName.main');
  const m = /^Workspace (\d+)$/.exec(name);
  return m ? t('model.defaultName.workspace', { n: m[1] }) : name;
}

/** Nombre con que se crea la cuenta de una carpeta ~/.claude* detectada («Main» la de siempre; ~/.claude-b → «b»). */
export function claudeAccountName(dir: string, isDefault: boolean): string {
  const base = dir.replace(/\\/g, '/').split('/').pop() ?? 'claude';
  return isDefault ? DEFAULT_MAIN_NAME : base.replace(/^\.claude-?/, '') || base;
}

export function equalTracks(n: number): number[] {
  const k = Math.max(1, Math.floor(n));
  return Array.from({ length: k }, () => 1 / k);
}

export function uid(prefix = 'p'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

export function newWorkspace(name: string, cols = 2, rows = 2): Workspace {
  return { id: uid('ws'), name, cols: equalTracks(cols), rows: equalTracks(rows), panes: [] };
}

/** Mapa celda -> id de panel, teniendo en cuenta spans. Solo paneles visibles. */
export function occupancy(ws: Workspace): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of ws.panes) {
    if (p.parked) continue;
    for (let r = p.row; r < p.row + p.rowSpan; r++)
      for (let c = p.col; c < p.col + p.colSpan; c++) m.set(`${c},${r}`, p.id);
  }
  return m;
}

export function emptyCells(ws: Workspace): { col: number; row: number }[] {
  const occ = occupancy(ws);
  const out: { col: number; row: number }[] = [];
  for (let r = 0; r < ws.rows.length; r++)
    for (let c = 0; c < ws.cols.length; c++) if (!occ.has(`${c},${r}`)) out.push({ col: c, row: r });
  return out;
}

export function freeCell(ws: Workspace): { col: number; row: number } | null {
  return emptyCells(ws)[0] ?? null;
}

/** Cambia el tamaño de la cuadrícula conservando los paneles: se recolocan por orden
 *  (fila, columna); los que no caben pasan a segundo plano SIN matarlos. Los que
 *  estaban en segundo plano vuelven si hay hueco. */
export function reflow(ws: Workspace, cols: number, rows: number): void {
  const visible = ws.panes
    .filter((p) => !p.parked)
    .sort((a, b) => a.row - b.row || a.col - b.col);
  const parked = ws.panes.filter((p) => p.parked);
  const ordered = [...visible, ...parked];
  ws.cols = equalTracks(cols);
  ws.rows = equalTracks(rows);
  const cap = ws.cols.length * ws.rows.length;
  ordered.forEach((p, i) => {
    p.colSpan = 1;
    p.rowSpan = 1;
    if (i < cap) {
      p.parked = false;
      p.col = i % ws.cols.length;
      p.row = Math.floor(i / ws.cols.length);
    } else {
      p.parked = true;
      p.col = -1;
      p.row = -1;
    }
  });
  if (ws.maximizedId && ws.panes.find((p) => p.id === ws.maximizedId)?.parked) ws.maximizedId = undefined;
}

export function swapPanes(ws: Workspace, aId: string, bId: string): void {
  const a = ws.panes.find((p) => p.id === aId);
  const b = ws.panes.find((p) => p.id === bId);
  if (!a || !b || a === b) return;
  const pa = { col: a.col, row: a.row, colSpan: a.colSpan, rowSpan: a.rowSpan, parked: a.parked };
  const pb = { col: b.col, row: b.row, colSpan: b.colSpan, rowSpan: b.rowSpan, parked: b.parked };
  Object.assign(a, pb);
  Object.assign(b, pa);
}

/** Mueve un panel a una celda; si hay otro ocupándola, intercambian. */
export function movePaneToCell(ws: Workspace, paneId: string, col: number, row: number): void {
  const p = ws.panes.find((x) => x.id === paneId);
  if (!p) return;
  const other = occupancy(ws).get(`${col},${row}`);
  if (other && other !== paneId) {
    swapPanes(ws, paneId, other);
    return;
  }
  p.col = col;
  p.row = row;
  p.colSpan = 1;
  p.rowSpan = 1;
  p.parked = false;
}

/** Mete un panel nuevo. Orden de preferencia: celda pedida, primer hueco, o (si está
 *  llena) sustituye al enfocado, que pasa a segundo plano. Devuelve el panel desplazado. */
export function placePane(
  ws: Workspace,
  pane: Pane,
  target?: { col: number; row: number },
): Pane | null {
  let displaced: Pane | null = null;
  let cell = target ?? freeCell(ws);
  if (target) {
    const occ = occupancy(ws).get(`${target.col},${target.row}`);
    if (occ) displaced = ws.panes.find((p) => p.id === occ) ?? null;
  } else if (!cell) {
    displaced =
      ws.panes.find((p) => p.id === ws.focusId && !p.parked) ?? ws.panes.find((p) => !p.parked) ?? null;
    if (displaced) cell = { col: displaced.col, row: displaced.row };
  }
  if (displaced) {
    displaced.parked = true;
    displaced.col = -1;
    displaced.row = -1;
    displaced.colSpan = 1;
    displaced.rowSpan = 1;
  }
  if (!cell) cell = { col: 0, row: 0 };
  pane.col = cell.col;
  pane.row = cell.row;
  pane.colSpan = 1;
  pane.rowSpan = 1;
  pane.parked = false;
  ws.panes.push(pane);
  ws.focusId = pane.id;
  return displaced;
}

export function removePane(ws: Workspace, id: string): void {
  ws.panes = ws.panes.filter((p) => p.id !== id);
  if (ws.focusId === id) ws.focusId = ws.panes.find((p) => !p.parked)?.id;
  if (ws.maximizedId === id) ws.maximizedId = undefined;
}

/** Reparte `delta` (fracción) entre las pistas i e i+1 respetando un mínimo. */
export function resizeTracks(tracks: number[], i: number, delta: number, minFrac: number): number[] {
  const out = [...tracks];
  const a = out[i];
  const b = out[i + 1];
  if (a === undefined || b === undefined) return out;
  const d = Math.max(minFrac - a, Math.min(b - minFrac, delta));
  out[i] = a + d;
  out[i + 1] = b - d;
  return out;
}

export type Dir = 'left' | 'right' | 'up' | 'down';

/** Panel vecino en una dirección (para Alt+flechas). */
export function neighbor(ws: Workspace, fromId: string, dir: Dir): string | null {
  const from = ws.panes.find((p) => p.id === fromId && !p.parked);
  if (!from) return null;
  const cands = ws.panes.filter((p) => !p.parked && p.id !== fromId);
  let best: { id: string; score: number } | null = null;
  for (const p of cands) {
    const dc = p.col - from.col;
    const dr = p.row - from.row;
    const ok =
      (dir === 'left' && dc < 0) || (dir === 'right' && dc > 0) || (dir === 'up' && dr < 0) || (dir === 'down' && dr > 0);
    if (!ok) continue;
    const along = dir === 'left' || dir === 'right' ? Math.abs(dc) : Math.abs(dr);
    const across = dir === 'left' || dir === 'right' ? Math.abs(dr) : Math.abs(dc);
    const score = along * 10 + across;
    if (!best || score < best.score) best = { id: p.id, score };
  }
  return best?.id ?? null;
}

// ---------- SSH ----------

const KEEPALIVE = ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4'];

export function sshTarget(h: Pick<Host, 'host' | 'user'>): string {
  return h.user ? `${h.user}@${h.host}` : h.host;
}

/** Nombre de la entrada de la bóveda (Administrador de credenciales) de un host. */
export function hostSecretKey(hostId: string, kind: 'password' | 'passphrase'): string {
  return `host:${hostId}:${kind}`;
}

/** Secreto guardado que ssh debe recibir sin teclear (o null: comportamiento clásico). */
export function activeSecretKey(h: Host): string | null {
  if (h.authMethod === 'password' && h.hasPassword) return hostSecretKey(h.id, 'password');
  if (h.authMethod === 'key' && h.hasPassphrase) return hostSecretKey(h.id, 'passphrase');
  return null;
}

/** Política efectiva de un host: la suya si no es 'default'; si no, la global. */
export function effectiveHostKeyPolicy(h: Pick<Host, 'hostKeyPolicy'>, global: HostKeyPolicy): HostKeyPolicy {
  return h.hostKeyPolicy === 'confirm' || h.hostKeyPolicy === 'accept-new' ? h.hostKeyPolicy : global;
}

/** ¿Se llega por un salto (ProxyJump)? Ahí `ssh-keyscan` no puede ver la huella. */
export function hostKeyViaJump(h: Pick<Host, 'proxyJump'>): boolean {
  return !!h.proxyJump?.trim();
}

/** Resultado de la comprobación previa que hace Rust (`hostkey_probe`). */
export type ProbeStatus = 'known' | 'unknown' | 'jump' | 'alias';
export type HostKeyAction = 'spawn' | 'probe' | 'ask' | 'blocked-jump' | 'blocked-alias';

/**
 * Qué hay que hacer antes de abrir un panel SSH de este host.
 * - Sin secreto guardado, o política 'accept-new': 'spawn' (nada previo; ssh pregunta él mismo / confía a la primera).
 * - 'confirm' y aún sin comprobar: 'probe'. Con el resultado: conocida -> 'spawn' (con `yes`),
 *   desconocida -> 'ask' (diálogo con la huella), por salto/alias -> bloqueado con un mensaje.
 */
export function hostKeyAction(h: Host, global: HostKeyPolicy, probe?: ProbeStatus): HostKeyAction {
  if (!activeSecretKey(h) || effectiveHostKeyPolicy(h, global) !== 'confirm') return 'spawn';
  if (!probe) return 'probe';
  if (probe === 'known') return 'spawn';
  if (probe === 'unknown') return 'ask';
  return probe === 'jump' ? 'blocked-jump' : 'blocked-alias';
}

/** Texto del bloqueo en el idioma actual (el diálogo lo muestra; las constantes de abajo son la versión inglesa de referencia, la que fija el test). */
export function hostKeyBlockedMsg(kind: 'jump' | 'alias'): string {
  return kind === 'jump' ? t('model.hostKey.jump') : t('model.hostKey.alias');
}

export const HOSTKEY_JUMP_MSG =
  "This host is reached through a jump host, so its key can't be checked in advance. Set this host to 'Trust on first use' in its settings, or connect once without a saved password.";
export const HOSTKEY_ALIAS_MSG =
  "This host uses a HostKeyAlias in your SSH config, so its key can't be checked in advance. Set this host to 'Trust on first use' in its settings, or connect once without a saved password.";

/** `policy`: la política GLOBAL (el host puede traer la suya). Por defecto la segura. */
export function sshArgs(h: Host, policy: HostKeyPolicy = 'confirm'): string[] {
  const args = [...KEEPALIVE];
  if (h.port) args.push('-p', String(h.port));
  if (h.identityFile) args.push('-i', h.identityFile);
  if (h.authMethod === 'key' && h.identityFile) args.push('-o', 'IdentitiesOnly=yes');
  if (activeSecretKey(h)) {
    // Un solo intento (no bloquea la cuenta). El askpass no puede contestar al «yes/no» de la huella:
    // 'accept-new' confía la primera vez (una huella CAMBIADA sigue rechazándose); 'confirm' exige
    // que la huella ya esté en known_hosts (Orchestra la comprueba/confía ANTES de abrir el panel).
    const strict = effectiveHostKeyPolicy(h, policy) === 'accept-new' ? 'accept-new' : 'yes';
    args.push('-o', 'NumberOfPasswordPrompts=1', '-o', `StrictHostKeyChecking=${strict}`);
  }
  if (h.proxyJump) args.push('-J', h.proxyJump);
  const remote = h.tmux
    ? `tmux new-session -A -s orchestra${h.command ? ` '${h.command.replace(/'/g, `'\\''`)}'` : ''}`
    : h.command;
  if (remote) args.push('-t');
  args.push(sshTarget(h));
  if (remote) args.push(remote);
  return args;
}

/** Alias de ~/.ssh/config: ssh resuelve el resto solo. */
export function sshAliasArgs(alias: string): string[] {
  return [...KEEPALIVE, alias];
}

/** Entorno del panel: solo el NOMBRE del secreto. Rust añade SSH_ASKPASS al lanzar. */
export function sshEnv(h: Host): Record<string, string> | undefined {
  const k = activeSecretKey(h);
  return k ? { ORCHESTRA_ASKPASS_KEY: k } : undefined;
}

export function sshSpec(h: Host, policy: HostKeyPolicy = 'confirm'): PaneSpec {
  const env = sshEnv(h);
  const args = sshArgs(h, policy);
  return env ? { program: 'ssh', args, env } : { program: 'ssh', args };
}

/** Literal entre comillas simples de PowerShell. PowerShell trata como comilla simple también U+2018..U+201B
 *  (‘ ’ ‚ ‛): una ruta con «O’Brien» cerraba la cadena. Todas se duplican. */
export const psq = (s: string) => `'${s.replace(/['‘’‚‛]/g, (c) => c + c)}'`;

/** «ssh-copy-id» para Windows: PowerShell canaliza la clave PÚBLICA a ssh, que la añade a
 *  authorized_keys en el remoto (se quitan los CR que mete PowerShell). */
export function sshInstallKeySpec(h: Host, pubPath: string, policy: HostKeyPolicy = 'confirm'): PaneSpec {
  const args = sshArgs({ ...h, command: undefined, tmux: false }, policy);
  const remote = `umask 077; mkdir -p ~/.ssh && tr -d '\\r' >> ~/.ssh/authorized_keys && echo 'Key installed.'`;
  const cmd = `(Get-Content -Raw -LiteralPath ${psq(pubPath)}).Trim() | ssh ${[...args, remote].map(psq).join(' ')}`;
  const env = sshEnv(h);
  const spec: PaneSpec = { program: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', cmd] };
  if (env) spec.env = env;
  return spec;
}

export function emptyHost(): Host {
  return { id: uid('h'), name: '', tags: [], host: '', authMethod: 'agent', agentAccess: 'none' };
}

/** Hosts guardados con versiones anteriores (sin authMethod ni banderas) se cargan con valores por defecto.
 *  Las banderas solo valen si el método las usa; nunca se conserva nada parecido a un secreto. */
export function normalizeHost(raw: Partial<Host> & { id: string }): Host {
  const r = raw as Record<string, unknown>;
  const method = AUTH_METHODS.includes(r.authMethod as AuthMethod) ? (r.authMethod as AuthMethod) : 'agent';
  const h: Host = {
    ...(raw as Host),
    authMethod: method,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    agentAccess: raw.agentAccess ?? 'none',
  };
  for (const k of ['password', 'passphrase', 'secret']) delete (h as unknown as Record<string, unknown>)[k];
  h.hasPassword = method === 'password' && raw.hasPassword === true ? true : undefined;
  h.hasPassphrase = method === 'key' && raw.hasPassphrase === true ? true : undefined;
  if (h.hasPassword === undefined) delete h.hasPassword;
  if (h.hasPassphrase === undefined) delete h.hasPassphrase;
  // Solo se guarda un valor propio del host; 'default' (o cualquier basura) = seguir el ajuste global.
  if (h.hostKeyPolicy !== 'confirm' && h.hostKeyPolicy !== 'accept-new') delete h.hostKeyPolicy;
  // Solo `true` cuenta; cualquier otra cosa = apagado (campo ausente).
  if ((raw as { remoteMetrics?: unknown }).remoteMetrics === true) h.remoteMetrics = true; else delete h.remoteMetrics;
  return h;
}

/** Lo que se exporta de un host: sin id interno ni banderas de la bóveda, y jamás secretos. */
export function exportHosts(hosts: Host[]): string {
  const out = hosts.map((h) => {
    const { id: _id, hasPassword: _p, hasPassphrase: _q, ...rest } = h;
    return rest;
  });
  return JSON.stringify({ orchestraHosts: 1, hosts: out }, null, 2);
}

export interface SshConfigEntry {
  alias: string; hostname?: string; user?: string; port?: number; identityFile?: string; proxyJump?: string;
}

/** Entrada de ~/.ssh/config -> host de la bóveda (con los datos ya resueltos). */
export function hostFromSshConfig(c: SshConfigEntry): Host {
  const h = emptyHost();
  h.name = c.alias;
  h.host = c.hostname || c.alias;
  if (c.user) h.user = c.user;
  if (c.port) h.port = c.port;
  if (c.proxyJump) h.proxyJump = c.proxyJump;
  if (c.identityFile) { h.identityFile = c.identityFile; h.authMethod = 'key'; }
  h.group = 'Imported';
  return h;
}

/** Entradas de ~/.ssh/config que aún no son hosts de la bóveda (por alias = nombre). */
export function newConfigEntries(cfg: SshConfigEntry[], hosts: Host[]): SshConfigEntry[] {
  const taken = new Set(hosts.map((h) => h.name.toLowerCase()));
  return cfg.filter((c) => !taken.has(c.alias.toLowerCase()));
}

/** Acepta `usuario@host:puerto` para conectar rápido. */
export function parseQuickConnect(text: string): Partial<Host> | null {
  const m = /^\s*(?:([^@\s]+)@)?([^\s:@]+)(?::(\d{1,5}))?\s*$/.exec(text);
  if (!m) return null;
  return { user: m[1], host: m[2], port: m[3] ? Number(m[3]) : undefined };
}

// ---------- Cuentas de agentes ----------

/** Quién es el agente de una cuenta. Solo las de Claude entran en la política automática, el uso y los límites. */
export type Provider = 'claude' | 'codex' | 'opencode';
export const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'opencode'];

/**
 * Una cuenta de agente = una carpeta aislada por proveedor:
 *  - claude: CLAUDE_CONFIG_DIR (`~/.claude` o `~/.claude-*`);
 *  - codex: CODEX_HOME (`~/.codex` o `~/.codex-*`);
 *  - opencode: carpeta raíz `~/.opencode-*` con `data/` (XDG_DATA_HOME) y `state/` (XDG_STATE_HOME), o los datos compartidos.
 * `isDefault` = la carpeta de siempre del usuario (sin variable de entorno).
 */
export interface Account {
  id: string;
  name: string;
  dir: string;
  isDefault: boolean;
  color: string;
  /** Ausente en los estados guardados antiguos = 'claude' (ver `normalizeAccounts`). */
  provider: Provider;
}

/** Nombre del producto (no se traduce). */
export function providerLabel(p: Provider): string {
  return p === 'codex' ? 'Codex' : p === 'opencode' ? 'opencode' : 'Claude';
}

/** Proveedor de una cuenta guardada (por si llega algo sin normalizar). */
export const providerOf = (a: { provider?: unknown } | undefined): Provider =>
  a && (a.provider === 'codex' || a.provider === 'opencode') ? a.provider : 'claude';

/** Estado guardado -> cuentas válidas. Las antiguas (sin `provider`) son de Claude y se cargan tal cual. */
export function normalizeAccounts(raw: unknown): Account[] {
  if (!Array.isArray(raw)) return [];
  const out: Account[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.dir !== 'string') continue;
    out.push({ ...(r as unknown as Account), provider: providerOf(r) });
  }
  return out;
}

/** «Claude · Trabajo», «Codex · Trabajo», «opencode · Trabajo». */
export const accountTitle = (a: Pick<Account, 'name' | 'provider'>): string => `${providerLabel(providerOf(a))} · ${displayName(a.name)}`;

export const ACCOUNT_COLORS = ['#f5b942', '#6cb2ff', '#8fcf7a', '#c58af9', '#ef6b73', '#5fd4d4', '#ff9f6b', '#e08fd0'];

export function slug(name: string): string {
  return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cuenta';
}

/** UUID de sesión de Claude (`[0-9a-f-]{36}`): lo único que puede acabar como argumento de `claude --resume`. */
export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);
}

const normDir = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Id de sesión que este panel puede retomar, o null. Es solo la parte que no necesita mirar el disco. */
export function resumeCandidate(pane: Pick<Pane, 'kind' | 'lastSession'>, setting: boolean, account: Pick<Account, 'dir' | 'provider'> | undefined): string | null {
  if (!setting || pane.kind !== 'agent' || !account || providerOf(account) !== 'claude') return null;
  const ls = pane.lastSession;
  if (!ls || ls.ended || !isSessionId(ls.id) || typeof ls.dir !== 'string') return null;
  return normDir(ls.dir) === normDir(account.dir) ? ls.id : null;
}

/** Sesión que hay que recordar tras un escaneo: `null` si no cambia nada (mismo id y carpeta, y no estaba cerrada). */
export function trackSession(cur: LastSession | undefined, seen: { sessionId?: string; configDir?: string }): LastSession | null {
  if (!isSessionId(seen.sessionId) || !seen.configDir) return null;
  if (cur && cur.id === seen.sessionId && cur.dir === seen.configDir && !cur.ended) return null;
  return { id: seen.sessionId, dir: seen.configDir };
}

/** Lo que se guarda en el disco: si el panel muestra «terminado» con código 0 (el usuario salió de Claude y cerró el shell), la sesión queda cerrada. */
export function sessionForSave(ls: LastSession | undefined, live: { state?: string; code?: number } | undefined): LastSession | undefined {
  if (!ls) return undefined;
  return live?.state === 'exited' && live.code === 0 ? { ...ls, ended: true } : ls;
}

export type RestorePlan = { mode: 'fresh' } | { mode: 'resume'; id: string };

/**
 * Cómo se relanza un panel al reabrir Orchestra. `exists` = la transcripción de la sesión (projects, una carpeta por proyecto, `<id>.jsonl`) sigue en disco
 * (lo comprueba el backend). Solo se retoma con el ajuste encendido, un panel de Claude, una sesión recordada con id válido,
 * de la cuenta del propio panel, que el usuario no cerró y cuya transcripción exista; en cualquier otro caso, Claude nuevo.
 */
export function restoreSpecFor(
  pane: Pick<Pane, 'kind' | 'lastSession'>,
  ctx: { setting: boolean; account: Pick<Account, 'dir' | 'provider'> | undefined; exists: boolean },
): RestorePlan {
  const id = resumeCandidate(pane, ctx.setting, ctx.account);
  return id && ctx.exists ? { mode: 'resume', id } : { mode: 'fresh' };
}

/** Quita `--resume <id>` de la orden de un panel de Claude (el panel se reinicia «nuevo»). */
export function stripResume(spec: PaneSpec): PaneSpec {
  const args = spec.args ?? [];
  const last = args[args.length - 1] ?? '';
  const next = last.replace(/ --resume [0-9a-f-]{36}(?= |$)/, '');
  return next === last ? spec : { ...spec, args: [...args.slice(0, -1), next] };
}

/** Lanza Claude Code dentro de un PowerShell que sigue vivo al salir de claude.
 *  `settingsPath`: ajustes propios de Orchestra (`--settings`) para capturar los límites de uso. */
export function claudeSpec(acc: Account, opts: { cwd?: string; resume?: boolean; resumeId?: string; settingsPath?: string; mcpConfig?: string } = {}): PaneSpec {
  const settings = opts.settingsPath ? ` --settings ${psq(opts.settingsPath)}` : '';
  // `mcpConfig`: archivo de Orchestra con su servidor MCP (no toca la configuración MCP del usuario).
  const mcp = opts.mcpConfig ? ` --mcp-config ${psq(opts.mcpConfig)}` : '';
  // `resumeId` (un UUID válido) retoma ESA conversación; `resume` a secas = `--continue` (la última de la carpeta).
  // `--resume <id>` va antes de `--settings` y de `--mcp-config`, que es variádico y se come lo que le siga: va el último.
  const again = isSessionId(opts.resumeId) ? ` --resume ${opts.resumeId}` : opts.resume ? ' --continue' : '';
  const cmd = `& claude${again}${settings}${mcp}`;
  return {
    program: 'powershell.exe',
    args: ['-NoLogo', '-NoExit', '-Command', cmd],
    cwd: opts.cwd,
    env: acc.isDefault ? { ORCHESTRA_ACCOUNT: acc.id } : { CLAUDE_CONFIG_DIR: acc.dir, ORCHESTRA_ACCOUNT: acc.id },
  };
}

/** Codex sin cuenta (lanzador suelto de siempre): usa el ~/.codex del usuario. */
export function codexSpec(opts: { cwd?: string } = {}): PaneSpec {
  return { program: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', '& codex'], cwd: opts.cwd };
}

const joinWin = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, '')}\\${name}`;

/** Carpeta sugerida de una cuenta nueva: `~\.claude-x`, `~\.codex-x`, `~\.opencode-x`. */
export function accountDir(provider: Provider, home: string, name: string): string {
  return joinWin(home, `.${provider}-${slug(name)}`);
}

/**
 * Variables de entorno SOLO de ese panel (nunca del proceso de Orchestra):
 *  - codex: `CODEX_HOME` = carpeta de la cuenta (la «Default» usa el ~/.codex de siempre, sin variable);
 *  - opencode: `XDG_DATA_HOME` = `<raíz>\data` y `XDG_STATE_HOME` = `<raíz>\state` (auth.json y la base de datos viven en
 *    `<XDG_DATA_HOME>\opencode`); la configuración (`~/.config/opencode`) y la caché se comparten. La «Default» no cambia nada.
 */
export function providerEnv(acc: Pick<Account, 'id' | 'dir' | 'isDefault' | 'provider'>): Record<string, string> {
  const env: Record<string, string> = { ORCHESTRA_ACCOUNT: acc.id };
  const p = providerOf(acc);
  if (acc.isDefault) return env;
  if (p === 'claude') env.CLAUDE_CONFIG_DIR = acc.dir;
  else if (p === 'codex') env.CODEX_HOME = acc.dir;
  else { env.XDG_DATA_HOME = joinWin(acc.dir, 'data'); env.XDG_STATE_HOME = joinWin(acc.dir, 'state'); }
  return env;
}

/**
 * Panel de una cuenta de Codex u opencode. `login` = en vez del agente, el inicio de sesión de ese proveedor
 * (`codex login` / `opencode auth login`) con el entorno de la cuenta, para terminarlo en el navegador desde Orchestra.
 * opencode v2 comparte un servicio en segundo plano entre procesos: con otra carpeta de datos NO aísla, por eso las cuentas
 * propias lanzan `--standalone` (servidor privado). La «Default» usa el servicio de siempre.
 */
export function providerSpec(acc: Account, opts: { cwd?: string; login?: boolean } = {}): PaneSpec {
  const p = providerOf(acc);
  if (p === 'claude') return claudeSpec(acc, { cwd: opts.cwd });
  const standalone = p === 'opencode' && !acc.isDefault ? ' --standalone' : '';
  const cmd = p === 'codex'
    ? (opts.login ? '& codex login' : '& codex')
    : (opts.login ? `& opencode auth login${standalone}` : `& opencode${standalone}`);
  return { program: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', cmd], cwd: opts.cwd, env: providerEnv(acc) };
}

/**
 * Lo que se guarda de un panel para volver a lanzarlo tras reiniciar. Un panel de «Sign in» (`codex login`,
 * `opencode auth login`) no debe repetir el inicio de sesión (abriría el navegador otra vez): vuelve como un
 * PowerShell normal con el entorno de esa cuenta. El resto de paneles quedan igual.
 */
export function restorableSpec(spec: PaneSpec): PaneSpec {
  const last = spec.args?.[spec.args.length - 1] ?? '';
  if (spec.program === 'powershell.exe' && /^&\s*(codex\s+login|opencode\s+auth\s+login)\b/.test(last)) {
    return { ...spec, args: ['-NoLogo'] };
  }
  return spec;
}

/**
 * Inicio de sesión de UN servidor MCP (OAuth) con el entorno de la cuenta: `codex mcp login <x>`, `opencode mcp auth <x>`;
 * Claude Code no tiene comando: se abre `claude` con la indicación de usar `/mcp` (`hint`, ya traducida).
 * Sin cuenta (`acc` null: el lanzador «Codex» de siempre) usa la configuración de siempre.
 */
export function mcpLoginSpec(provider: Provider, acc: Pick<Account, 'id' | 'dir' | 'isDefault' | 'provider'> | null, name: string, opts: { cwd?: string; hint?: string } = {}): PaneSpec {
  const n = psq(name);
  const standalone = provider === 'opencode' && acc && !acc.isDefault ? ' --standalone' : '';
  const cmd = provider === 'codex' ? `& codex mcp login ${n}`
    : provider === 'opencode' ? `& opencode mcp auth ${n}${standalone}`
    : `Write-Host ${psq(opts.hint ?? `/mcp → ${name} → Authenticate`)} -ForegroundColor Yellow; & claude`;
  return { program: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', cmd], cwd: opts.cwd, env: acc ? providerEnv(acc) : undefined };
}
