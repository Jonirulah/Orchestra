// Ajustes de la aplicación. Módulo puro (sin Svelte ni Tauri): se prueba con node --test.
import type { AccountPolicy } from './policy.ts';
import { HOST_KEY_POLICIES } from './model.ts';
import type { HostKeyPolicy } from './model.ts';
import { THEME_IDS, isCustomThemeId } from './themes.ts';
import { LANGUAGE_SETTINGS, t } from './i18n.ts';
import type { LanguageSetting } from './i18n.ts';
import { RECONNECT_CODES } from './reconnect.ts';
import type { ReconnectCodes } from './reconnect.ts';
import { ACCOUNTS_FILTERS, ACCOUNTS_SORTS } from './accountview.ts';
import type { AccountsFilter, AccountsSort } from './accountview.ts';
import { HOSTS_SORTS, cleanFolderList } from './hostview.ts';
import type { HostsSort } from './hostview.ts';
import { DEFAULT_ITEMS, DEFAULT_INTERVAL, DEFAULT_RM_INTERVAL, INTERVAL_LIMITS, RM_INTERVAL_LIMITS, cleanInterval, cleanItems, cleanRmInterval } from './statusbar.ts';
import type { ItemId } from './statusbar.ts';
import { cleanSoundId } from './sounds.ts';
import type { SoundId } from './sounds.ts';

/** Debe coincidir con `version` de src-tauri/tauri.conf.json (lo vigila una prueba). */
export const APP_VERSION = '0.2.0';

export type CursorStyle = 'bar' | 'block' | 'underline';
export type RightClick = 'smart' | 'paste' | 'none';
export type BellMode = 'flash' | 'none';

export interface Settings {
  // --- General ---
  closeToTray: boolean;
  /** Pedir un segundo clic al cerrar un panel con el proceso vivo. */
  confirmClose: boolean;
  /** Color de acento (#rrggbb). */
  accent: string;
  /** Idioma de la interfaz: 'en', 'es' o 'system' (el del sistema). */
  language: LanguageSetting;
  /** Barra de estado inferior con métricas del equipo (ver statusbar.ts). */
  statusBar: boolean;
  /** Elementos de la barra, en orden. */
  statusBarItems: ItemId[];
  /** Segundos entre muestras (1..10). */
  statusBarInterval: number;
  /** Sin lista propia en la pestaña, adaptar la barra al panel con foco (SSH / repo git). */
  statusBarAdapt: boolean;
  /** Segundos entre líneas de las métricas remotas del servidor (2..10). */
  remoteMetricsInterval: number;
  // --- Terminal ---
  /** Nombre de una fuente (o una lista CSS si es personalizada). */
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  copyOnSelect: boolean;
  rightClick: RightClick;
  bell: BellMode;
  theme: string;
  // --- Agentes ---
  /** Cómo se elige la cuenta al crear una terminal de Claude con «automática». */
  accountPolicy: AccountPolicy;
  /** Carpeta de trabajo de los agentes nuevos (vacío = carpeta de usuario). */
  agentCwd: string;
  scanIntervalSec: number;
  notifyPermission: boolean;
  notifyDone: boolean;
  /** Sonido cuando un agente necesita al usuario (pasa a 'waiting'). Independiente del aviso en pantalla; 'none' lo apaga. */
  soundAttention: SoundId;
  /** Sonido cuando un agente termina (busy → idle). Independiente del aviso en pantalla. */
  soundDone: SoundId;
  /** Volumen de los sonidos (0..100). */
  soundVolume: number;
  /** Al reabrir Orchestra, cada panel de Claude retoma su conversación (`claude --resume <id>`) en vez de empezar una nueva. */
  restoreClaudeSessions: boolean;
  /** Minutos de caché por debajo de los cuales se marca «a punto de enfriarse». */
  cacheWarnMin: number;
  /** Ficha flotante al dejar el ratón sobre un agente de la barra lateral. */
  agentCard: boolean;
  /** Retardo (ms) antes de abrir la ficha. */
  agentCardDelayMs: number;
  /** Añade un envoltorio de statusline a los Claude lanzados desde Orchestra para leer los límites de uso (5 h / 7 d). */
  captureUsage: boolean;
  /** Aviso al cruzar el 80 % y el 95 % de la ventana de 5 h de una cuenta. */
  notifyQuota: boolean;
  /** Consulta opcional a Anthropic (lee el token de cada cuenta; ver docs/SECURITY.md). Apagada por defecto; solo se enciende desde el diálogo, con confirmación. */
  usageQuery: boolean;
  /** Cada cuántos minutos se consulta el uso (2..30). */
  usageQueryMin: number;
  /** Auto-compact en inactividad (experimental, apagado por defecto). */
  autoCompact: boolean;
  /** Contexto mínimo (miles de tokens) para compactar. */
  autoCompactCtxK: number;
  /** Minutos desde la última petición a partir de los cuales se compacta. */
  autoCompactAfterMin: number;
  /** Minutos sin tocar teclado ni ratón en el sistema para dar al usuario por ausente. */
  autoCompactUserIdleMin: number;
  // --- MCP (servidor local para que los agentes vean tus hosts y terminales) ---
  mcpEnabled: boolean;
  /** Mostrar también las terminales locales (shell, Claude, Codex) a los agentes, solo lectura. */
  mcpExposeLocal: boolean;
  // --- SSH keys ---
  /** Huella de servidores con contraseña/passphrase guardada: 'confirm' = Orchestra pregunta con la huella; 'accept-new' = confía la primera vez. */
  sshHostKeyPolicy: HostKeyPolicy;
  // --- SSH: reconexión automática (ver reconnect.ts) ---
  /** Reconectar solo un panel SSH cuya sesión establecida se cae. */
  sshAutoReconnect: boolean;
  /** Intentos máximos por racha (0 = sin límite). */
  sshReconnectMaxAttempts: number;
  /** Espera antes del primer intento (s). */
  sshReconnectFirstDelaySec: number;
  /** Cada intento espera «factor» veces el anterior (1 = espera fija). */
  sshReconnectFactor: number;
  /** Tope de la espera (s). */
  sshReconnectMaxDelaySec: number;
  /** Segundos que debe haber durado la sesión para que su caída cuente como «se cayó» y no como «no llegó a conectar». */
  sshReconnectMinUpSec: number;
  /** Qué códigos de salida disparan la reconexión: 'nonzero' = cualquiera ≠ 0; '255' = solo los errores de conexión de ssh. */
  sshReconnectCodes: ReconnectCodes;
  /** Parpadeo breve de la cabecera cuando una reconexión vuelve a conectar. */
  sshReconnectFlash: boolean;
  // --- SSH: insignia de latencia (ver latency.ts) ---
  /** Tiempo de conexión TCP al puerto SSH en la cabecera de los paneles SSH. */
  latencyBadge: boolean;
  latencyIntervalSec: number;
  /** Tiempo máximo de cada sonda (s). */
  latencyTimeoutSec: number;
  /** Desde aquí (ms) la insignia pasa a ámbar. */
  latencyWarnMs: number;
  /** Desde aquí (ms) pasa a rojo. Siempre mayor que `latencyWarnMs`. */
  latencyBadMs: number;
  /** Muestras que se guardan por panel (la ventana de min/media/máx/pérdida). */
  latencySamples: number;
  /** Fallos seguidos para que la insignia se ponga roja. */
  latencyFailsBad: number;
  /** «42 ms» (true) o solo «42» (false). */
  latencyShowUnit: boolean;
  // --- Git (chip with the branch in the pane header; local panes only) ---
  /** Show the git branch chip in the header of local panes. */
  gitChip: boolean;
  /** Show the number of changed files and the ahead/behind arrows in the chip. */
  gitCounts: boolean;
  /** Seconds between refreshes of the visible panes (2..30). */
  gitIntervalSec: number;
  /** Make PowerShell shell panes report their folder (OSC 9;9 from the prompt). */
  gitTrackFolder: boolean;
  // --- Cuentas: vista de la lista (barra lateral y Ajustes → Cuentas; ver accountview.ts) ---
  /** Qué proveedor se enseña ('all' = todos). Si ya no hay cuentas de ese proveedor, se comporta como 'all'. */
  accountsFilter: AccountsFilter;
  /** Orden dentro de cada grupo: el guardado, por nombre, más libre o la que se renueva antes (las dos últimas solo ordenan Claude). */
  accountsSort: AccountsSort;
  /** Separar por proveedor, con encabezados cuando hay varios. */
  accountsGroup: boolean;
  // --- Hosts SSH: vista de la barra lateral (ver hostview.ts) ---
  /** Orden de los hosts: el guardado arrastrando ('manual') o por nombre ('name', carpetas también A-Z). */
  hostsSort: HostsSort;
  /** Orden de las carpetas (las que falten van detrás, A-Z). También guarda las carpetas vacías creadas a mano. */
  hostFolders: string[];
  /** Carpetas plegadas en la barra. */
  hostFoldersCollapsed: string[];
  // --- Interna (no aparece en el diálogo) ---
  sidebarWidth: number;
  sidebarOpen: boolean;
  lastAccountId?: string;
}

export const DEFAULTS: Settings = {
  closeToTray: true,
  confirmClose: true,
  accent: '#f5b942',
  language: 'en',
  statusBar: true,
  statusBarItems: [...DEFAULT_ITEMS],
  statusBarInterval: DEFAULT_INTERVAL,
  statusBarAdapt: false,
  remoteMetricsInterval: DEFAULT_RM_INTERVAL,
  fontFamily: 'Cascadia Code',
  fontSize: 13,
  lineHeight: 1.12,
  cursorStyle: 'bar',
  cursorBlink: true,
  scrollback: 5000,
  copyOnSelect: false,
  rightClick: 'smart',
  bell: 'flash',
  theme: 'orchestra',
  accountPolicy: 'manual',
  agentCwd: '',
  scanIntervalSec: 2,
  notifyPermission: true,
  notifyDone: true,
  soundAttention: 'chime',
  soundDone: 'bell',
  soundVolume: 60,
  restoreClaudeSessions: true,
  cacheWarnMin: 5,
  agentCard: true,
  agentCardDelayMs: 600,
  captureUsage: true,
  notifyQuota: true,
  usageQuery: false,
  usageQueryMin: 5,
  autoCompact: false,
  autoCompactCtxK: 150,
  autoCompactAfterMin: 50,
  autoCompactUserIdleMin: 5,
  mcpEnabled: true,
  mcpExposeLocal: false,
  sshHostKeyPolicy: 'confirm',
  sshAutoReconnect: true,
  sshReconnectMaxAttempts: 8,
  sshReconnectFirstDelaySec: 2,
  sshReconnectFactor: 2,
  sshReconnectMaxDelaySec: 30,
  sshReconnectMinUpSec: 10,
  sshReconnectCodes: 'nonzero',
  sshReconnectFlash: true,
  latencyBadge: true,
  latencyIntervalSec: 5,
  latencyTimeoutSec: 2,
  latencyWarnMs: 80,
  latencyBadMs: 200,
  latencySamples: 30,
  latencyFailsBad: 3,
  latencyShowUnit: true,
  gitChip: true,
  gitCounts: true,
  gitIntervalSec: 5,
  gitTrackFolder: true,
  accountsFilter: 'all',
  accountsSort: 'manual',
  accountsGroup: true,
  hostsSort: 'manual',
  hostFolders: [],
  hostFoldersCollapsed: [],
  sidebarWidth: 290,
  sidebarOpen: true,
};

/** Fuentes de terminal que se ofrecen en la lista (las que no estén instaladas se marcan y se avisa). */
export const FONT_PRESETS = [
  'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', 'JetBrainsMono Nerd Font', 'JetBrainsMono NF', 'Consolas', 'Fira Code', 'FiraCode Nerd Font',
  'Source Code Pro', 'Hack', 'IBM Plex Mono', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Iosevka', 'Victor Mono', 'Geist Mono',
  'Monaspace Neon', 'Inconsolata', 'Roboto Mono', 'Lucida Console', 'Courier New',
] as const;
export const SCROLLBACK_CHOICES = [1000, 5000, 10000, 25000, 50000] as const;
export const CURSOR_STYLES: readonly CursorStyle[] = ['bar', 'block', 'underline'];
export const RIGHT_CLICKS: readonly RightClick[] = ['smart', 'paste', 'none'];
export const BELL_MODES: readonly BellMode[] = ['flash', 'none'];
export const POLICY_IDS: readonly AccountPolicy[] = ['manual', 'round-robin', 'reset-soonest', 'most-free'];

export const LIMITS = {
  fontSize: [9, 24],
  lineHeight: [1.0, 1.6],
  scanIntervalSec: [1, 10],
  soundVolume: [0, 100],
  cacheWarnMin: [1, 30],
  agentCardDelayMs: [300, 2000],
  usageQueryMin: [2, 30],
  sshReconnectMaxAttempts: [0, 50],
  sshReconnectFirstDelaySec: [1, 60],
  sshReconnectFactor: [1, 4],
  sshReconnectMaxDelaySec: [5, 600],
  sshReconnectMinUpSec: [0, 300],
  latencyIntervalSec: [2, 60],
  latencyTimeoutSec: [1, 10],
  latencyWarnMs: [1, 2000],
  latencyBadMs: [2, 5000],
  latencySamples: [5, 120],
  latencyFailsBad: [1, 10],
  gitIntervalSec: [2, 30],
  autoCompactCtxK: [50, 800],
  autoCompactAfterMin: [20, 55],
  autoCompactUserIdleMin: [1, 60],
  sidebarWidth: [210, 520],
  statusBarInterval: INTERVAL_LIMITS,
  remoteMetricsInterval: RM_INTERVAL_LIMITS,
} as const;

/** Claves que reinicia «Reset section» en cada sección con ajustes. */
export const SECTION_KEYS = {
  general: ['closeToTray', 'confirmClose', 'accent', 'language', 'statusBar', 'statusBarItems', 'statusBarInterval', 'statusBarAdapt', 'remoteMetricsInterval'],
  terminal: ['fontFamily', 'fontSize', 'lineHeight', 'cursorStyle', 'cursorBlink', 'scrollback', 'copyOnSelect', 'rightClick', 'bell', 'theme', 'gitChip', 'gitCounts', 'gitIntervalSec', 'gitTrackFolder'],
  agents: ['accountPolicy', 'agentCwd', 'scanIntervalSec', 'notifyPermission', 'notifyDone', 'soundAttention', 'soundDone', 'soundVolume', 'restoreClaudeSessions', 'cacheWarnMin', 'agentCard', 'agentCardDelayMs', 'captureUsage', 'notifyQuota', 'usageQuery', 'usageQueryMin', 'autoCompact', 'autoCompactCtxK', 'autoCompactAfterMin', 'autoCompactUserIdleMin'],
  accounts: ['accountsFilter', 'accountsSort', 'accountsGroup'],
  sshkeys: [
    'sshHostKeyPolicy',
    'sshAutoReconnect', 'sshReconnectMaxAttempts', 'sshReconnectFirstDelaySec', 'sshReconnectFactor', 'sshReconnectMaxDelaySec',
    'sshReconnectMinUpSec', 'sshReconnectCodes', 'sshReconnectFlash',
    'latencyBadge', 'latencyIntervalSec', 'latencyTimeoutSec', 'latencyWarnMs', 'latencyBadMs', 'latencySamples', 'latencyFailsBad', 'latencyShowUnit',
  ],
} as const satisfies Record<string, readonly (keyof Settings)[]>;
export type SectionId = keyof typeof SECTION_KEYS;

/** Las que afectan a los xterm abiertos (aplicarlas es más caro que el resto). */
export const TERMINAL_KEYS: readonly (keyof Settings)[] = [...SECTION_KEYS.terminal];

// ---------- validación ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

function num(v: unknown, [lo, hi]: readonly [number, number], d: number, digits = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return d;
  const x = Math.min(hi, Math.max(lo, v));
  const k = 10 ** digits;
  return Math.round(x * k) / k;
}

/** Quita lo que rompería una lista CSS de fuentes. */
export function cleanFont(v: unknown, d: string): string {
  if (typeof v !== 'string') return d;
  const s = v.replace(/[;{}<>"\\\u0000-\u001f]/g, '').trim().slice(0, 200);
  return s || d;
}

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

/**
 * Valida cualquier cosa y devuelve unos ajustes completos y válidos. Nunca lanza:
 * lo inválido cae al valor por defecto, lo fuera de rango se recorta y las claves
 * desconocidas se ignoran.
 */
export function clampSettings(raw: unknown): Settings {
  const r = isObj(raw) ? raw : {};
  const D = DEFAULTS;
  const s: Settings = {
    closeToTray: bool(r.closeToTray, D.closeToTray),
    confirmClose: bool(r.confirmClose, D.confirmClose),
    accent: isHexColor(r.accent) ? r.accent.toLowerCase() : D.accent,
    language: oneOf(r.language, LANGUAGE_SETTINGS, D.language),
    statusBar: bool(r.statusBar, D.statusBar),
    statusBarItems: cleanItems(r.statusBarItems),
    statusBarInterval: cleanInterval(r.statusBarInterval),
    statusBarAdapt: bool(r.statusBarAdapt, D.statusBarAdapt),
    remoteMetricsInterval: cleanRmInterval(r.remoteMetricsInterval),
    fontFamily: cleanFont(r.fontFamily, D.fontFamily),
    fontSize: num(r.fontSize, LIMITS.fontSize, D.fontSize),
    lineHeight: num(r.lineHeight, LIMITS.lineHeight, D.lineHeight, 2),
    cursorStyle: oneOf(r.cursorStyle, CURSOR_STYLES, D.cursorStyle),
    cursorBlink: bool(r.cursorBlink, D.cursorBlink),
    scrollback: (SCROLLBACK_CHOICES as readonly unknown[]).includes(r.scrollback) ? (r.scrollback as number) : D.scrollback,
    copyOnSelect: bool(r.copyOnSelect, D.copyOnSelect),
    rightClick: oneOf(r.rightClick, RIGHT_CLICKS, D.rightClick),
    bell: oneOf(r.bell, BELL_MODES, D.bell),
    // Un tema propio puede venir de otro equipo: se acepta el id y, si no existe aquí, themes.resolveTheme cae a Orchestra Dark.
    theme: isCustomThemeId(r.theme) ? r.theme : oneOf(r.theme, THEME_IDS as readonly string[], D.theme),
    accountPolicy: oneOf(r.accountPolicy, POLICY_IDS, D.accountPolicy),
    agentCwd: typeof r.agentCwd === 'string' ? r.agentCwd.slice(0, 500) : D.agentCwd,
    scanIntervalSec: num(r.scanIntervalSec, LIMITS.scanIntervalSec, D.scanIntervalSec),
    notifyPermission: bool(r.notifyPermission, D.notifyPermission),
    notifyDone: bool(r.notifyDone, D.notifyDone),
    soundAttention: cleanSoundId(r.soundAttention, D.soundAttention),
    soundDone: cleanSoundId(r.soundDone, D.soundDone),
    soundVolume: num(r.soundVolume, LIMITS.soundVolume, D.soundVolume),
    restoreClaudeSessions: bool(r.restoreClaudeSessions, D.restoreClaudeSessions),
    cacheWarnMin: num(r.cacheWarnMin, LIMITS.cacheWarnMin, D.cacheWarnMin),
    agentCard: bool(r.agentCard, D.agentCard),
    agentCardDelayMs: num(r.agentCardDelayMs, LIMITS.agentCardDelayMs, D.agentCardDelayMs),
    captureUsage: bool(r.captureUsage, D.captureUsage),
    notifyQuota: bool(r.notifyQuota, D.notifyQuota),
    usageQuery: bool(r.usageQuery, D.usageQuery),
    usageQueryMin: num(r.usageQueryMin, LIMITS.usageQueryMin, D.usageQueryMin),
    autoCompact: bool(r.autoCompact, D.autoCompact),
    autoCompactCtxK: num(r.autoCompactCtxK, LIMITS.autoCompactCtxK, D.autoCompactCtxK),
    autoCompactAfterMin: num(r.autoCompactAfterMin, LIMITS.autoCompactAfterMin, D.autoCompactAfterMin),
    autoCompactUserIdleMin: num(r.autoCompactUserIdleMin, LIMITS.autoCompactUserIdleMin, D.autoCompactUserIdleMin),
    mcpEnabled: bool(r.mcpEnabled, D.mcpEnabled),
    mcpExposeLocal: bool(r.mcpExposeLocal, D.mcpExposeLocal),
    sshHostKeyPolicy: oneOf(r.sshHostKeyPolicy, HOST_KEY_POLICIES, D.sshHostKeyPolicy),
    sshAutoReconnect: bool(r.sshAutoReconnect, D.sshAutoReconnect),
    sshReconnectMaxAttempts: num(r.sshReconnectMaxAttempts, LIMITS.sshReconnectMaxAttempts, D.sshReconnectMaxAttempts),
    sshReconnectFirstDelaySec: num(r.sshReconnectFirstDelaySec, LIMITS.sshReconnectFirstDelaySec, D.sshReconnectFirstDelaySec),
    sshReconnectFactor: num(r.sshReconnectFactor, LIMITS.sshReconnectFactor, D.sshReconnectFactor, 1),
    sshReconnectMaxDelaySec: num(r.sshReconnectMaxDelaySec, LIMITS.sshReconnectMaxDelaySec, D.sshReconnectMaxDelaySec),
    sshReconnectMinUpSec: num(r.sshReconnectMinUpSec, LIMITS.sshReconnectMinUpSec, D.sshReconnectMinUpSec),
    sshReconnectCodes: oneOf(r.sshReconnectCodes, RECONNECT_CODES, D.sshReconnectCodes),
    sshReconnectFlash: bool(r.sshReconnectFlash, D.sshReconnectFlash),
    latencyBadge: bool(r.latencyBadge, D.latencyBadge),
    latencyIntervalSec: num(r.latencyIntervalSec, LIMITS.latencyIntervalSec, D.latencyIntervalSec),
    latencyTimeoutSec: num(r.latencyTimeoutSec, LIMITS.latencyTimeoutSec, D.latencyTimeoutSec),
    latencyWarnMs: num(r.latencyWarnMs, LIMITS.latencyWarnMs, D.latencyWarnMs),
    latencyBadMs: num(r.latencyBadMs, LIMITS.latencyBadMs, D.latencyBadMs),
    latencySamples: num(r.latencySamples, LIMITS.latencySamples, D.latencySamples),
    latencyFailsBad: num(r.latencyFailsBad, LIMITS.latencyFailsBad, D.latencyFailsBad),
    latencyShowUnit: bool(r.latencyShowUnit, D.latencyShowUnit),
    gitChip: bool(r.gitChip, D.gitChip),
    gitCounts: bool(r.gitCounts, D.gitCounts),
    gitIntervalSec: num(r.gitIntervalSec, LIMITS.gitIntervalSec, D.gitIntervalSec),
    gitTrackFolder: bool(r.gitTrackFolder, D.gitTrackFolder),
    accountsFilter: oneOf(r.accountsFilter, ACCOUNTS_FILTERS, D.accountsFilter),
    accountsSort: oneOf(r.accountsSort, ACCOUNTS_SORTS, D.accountsSort),
    accountsGroup: bool(r.accountsGroup, D.accountsGroup),
    hostsSort: oneOf(r.hostsSort, HOSTS_SORTS, D.hostsSort),
    hostFolders: cleanFolderList(r.hostFolders),
    hostFoldersCollapsed: cleanFolderList(r.hostFoldersCollapsed),
    sidebarWidth: num(r.sidebarWidth, LIMITS.sidebarWidth, D.sidebarWidth),
    sidebarOpen: bool(r.sidebarOpen, D.sidebarOpen),
  };
  // Los umbrales de la insignia van en orden: «malo» siempre por encima de «aviso».
  if (s.latencyBadMs <= s.latencyWarnMs) s.latencyBadMs = s.latencyWarnMs + 1; // warn ≤ 2000 < 5000: cabe siempre
  if (typeof r.lastAccountId === 'string' && r.lastAccountId) s.lastAccountId = r.lastAccountId.slice(0, 100);
  return s;
}

/** Devuelve `cur` con las claves de una sección puestas a su valor por defecto. */
export function resetSection(cur: Settings, section: SectionId): Settings {
  const out: Settings = { ...cur };
  for (const k of SECTION_KEYS[section]) (out as unknown as Record<string, unknown>)[k] = DEFAULTS[k];
  return out;
}

export type ImportResult =
  | { ok: true; settings: Settings; applied: string[]; ignored: string[] }
  | { ok: false; error: string };

/** Lee un JSON pegado por el usuario y lo mezcla sobre los ajustes actuales (validado con clampSettings). */
export function parseImport(text: string, cur: Settings): ImportResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: t('store.import.invalidJson', { message: (e as Error).message }) }; }
  if (!isObj(raw)) return { ok: false, error: t('store.import.notAnObject') };
  const known = new Set(Object.keys(DEFAULTS).concat('lastAccountId'));
  // La consulta de uso lee un token: solo se enciende desde el diálogo (con su confirmación), nunca con un JSON pegado.
  const NEVER_IMPORTED = ['usageQuery'];
  const applied = Object.keys(raw).filter((k) => known.has(k) && !NEVER_IMPORTED.includes(k));
  const ignored = Object.keys(raw).filter((k) => !known.has(k) || NEVER_IMPORTED.includes(k));
  if (!applied.length) return { ok: false, error: t('store.import.noKnownSettings') };
  const merged = { ...cur, ...raw, usageQuery: cur.usageQuery };
  return { ok: true, settings: clampSettings(merged), applied, ignored };
}

// ---------- derivados ----------

/** Lista CSS de fuentes: la elegida primero y los respaldos de siempre detrás. */
export function fontStack(family: string): string {
  const parts = family.split(',').map((p) => p.replace(/['"]/g, '').trim()).filter((p) => p && p.toLowerCase() !== 'monospace');
  const all = [...parts, 'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', 'Consolas'];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of all) {
    if (seen.has(f.toLowerCase())) continue;
    seen.add(f.toLowerCase());
    out.push(`'${f}'`);
  }
  return [...out, 'monospace'].join(', ');
}

/** `#rrggbb` -> `rgba(r, g, b, a)`. */
export function hexAlpha(hex: string, alpha: number): string {
  const h = isHexColor(hex) ? hex : DEFAULTS.accent;
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Umbrales de la caché de prompt (segundos): `hot` = N min, `warm` = 4×N min. */
export function cacheThresholds(warnMin: number): { hot: number; warm: number } {
  const m = num(warnMin, LIMITS.cacheWarnMin, DEFAULTS.cacheWarnMin);
  return { hot: m * 60, warm: m * 4 * 60 };
}
