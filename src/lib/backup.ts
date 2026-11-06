// Copia de seguridad completa («Export everything» / «Import everything»). Módulo puro (sin Svelte ni Tauri): se prueba con `node --test`.
//
// Un archivo de copia es DATO, no código de confianza: los paneles que trae se ejecutan al lanzarlos, así que todo lo que entra pasa por
// los validadores de aquí (lista blanca de campos, tamaños acotados, cadenas limpias) y por los de siempre (clampSettings, normalizeHost,
// normalizeAccounts, sanitizeCustomThemes). Nunca se escribe ni se lee un secreto: contraseñas y passphrases viven en el Administrador de
// credenciales, las cuentas de Claude/Codex son carpetas que no se tocan, y `usageQuery` (que lee un token) jamás viaja.
import { ACCOUNT_COLORS, normalizeAccounts, normalizeHost, providerOf, restorableSpec, uid } from './model.ts';
import type { Account, AgentAccess, Host, Pane, PaneKind, PaneSpec, Workspace } from './model.ts';
import { clampSettings } from './settings.ts';
import { cleanOverride } from './statusbar.ts';
import type { Settings } from './settings.ts';
import { DEFAULT_THEME, MAX_CUSTOM_THEMES, hasTheme } from './themes.ts';
import type { ThemeDef } from './themes.ts';
import { sanitizeCustomThemes, withUniqueIds } from './themeimport.ts';
import { t } from './i18n.ts';

export const BACKUP_APP = 'orchestra-backup';
export const BACKUP_FORMAT = 1;
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

/** Tope de cada lista: un archivo con más es absurdo (o hostil) y se rechaza entero. */
export const BACKUP_LIMITS = {
  hosts: 500, accounts: 100, ignoredDirs: 200, workspaces: 50, panesPerWorkspace: 64, tracks: 8,
  program: 520, args: 64, arg: 8192, cwd: 1024, envVars: 64, envKey: 128, envValue: 8192, title: 200,
} as const;

export type BackupSection = 'settings' | 'hosts' | 'accounts' | 'themes' | 'workspaces';
export const BACKUP_SECTIONS: readonly BackupSection[] = ['settings', 'hosts', 'accounts', 'themes', 'workspaces'];
export type BackupPicks = Record<BackupSection, boolean>;
export const ALL_PICKS: BackupPicks = { settings: true, hosts: true, accounts: true, themes: true, workspaces: true };

/** Lo que el almacén le da a `buildBackup` y recibe de `mergeBackup` / `replaceFromBackup` (siempre copias planas, nunca proxies). */
export interface BackupState {
  settings: Settings;
  hosts: Host[];
  accounts: Account[];
  customThemes: ThemeDef[];
  workspaces: Workspace[];
  activeId: string;
  ignoredDirs: string[];
}

export interface BackupFile {
  app: typeof BACKUP_APP;
  format: number;
  appVersion: string;
  exportedAt: string;
  settings: Partial<Settings>;
  hosts: Host[];
  accounts: Account[];
  customThemes: ThemeDef[];
  workspaces: Workspace[];
  activeId: string;
  ignoredDirs: string[];
}

/** Ya validado y limpio: lo que ofrece el diálogo de importación. */
export interface BackupSections {
  settings: Settings | null;
  hosts: Host[];
  accounts: Account[];
  customThemes: ThemeDef[];
  workspaces: Workspace[];
  activeId?: string;
  ignoredDirs: string[];
}

export interface BackupSummary {
  hosts: number;
  accounts: number;
  themes: number;
  workspaces: number;
  panes: number;
  hasSettings: boolean;
  /** Paneles descartados por no pasar la validación (programa, argumentos o entorno absurdos). */
  droppedPanes: number;
  /** Hosts descartados por tener un destino no válido (p. ej. empezar por «-»). */
  droppedHosts: number;
  /** Hosts que traen un comando remoto o un salto (se ejecutan al conectar). */
  hostsWithCommand: number;
  appVersion: string;
  exportedAt: string;
}

export type ParseBackupResult =
  | { ok: true; summary: BackupSummary; sections: BackupSections }
  | { ok: false; error: string };

export interface BackupReport {
  mode: 'merge' | 'replace';
  settings: boolean;
  hostsAdded: number; hostsSkipped: number;
  accountsAdded: number; accountsSkipped: number;
  themesAdded: number; themesSkipped: number;
  workspacesAdded: number; workspacesSkipped: number;
  panesAdded: number;
}

// ---------- utilidades ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
const CTRL_KEEP_NL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Texto de una línea sin caracteres de control ni invisibles, recortado. */
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(CTRL, '').trim();
  return s ? s.slice(0, max) : undefined;
}
function longText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(CTRL_KEEP_NL, '').trim();
  return s ? s.slice(0, max) : undefined;
}
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v);
/** Ids que acaban en el nombre de una entrada de la bóveda o en el entorno de un panel: solo caracteres sencillos. */
const goodId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(v);
const normDir = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Claves cuyo nombre sugiere un secreto: nunca salen en una copia (defensa en profundidad además de las listas blancas). */
const SECRETISH = /pass(word|phrase)|secret|token|credential/i;
/** Lo que el arranque ya regenera a partir del host: es el NOMBRE de la entrada de la bóveda, no un secreto, pero tampoco viaja. */
const ASKPASS_ENV = 'ORCHESTRA_ASKPASS_KEY';

function scrub<T>(v: T): T {
  if (Array.isArray(v)) return v.map(scrub) as unknown as T;
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (SECRETISH.test(k) || FORBIDDEN_KEYS.has(k)) continue;
    out[k] = scrub(val);
  }
  return out as T;
}

// Si alguien añade un campo a Host o Account y no lo apunta aquí, svelte-check lo dice (la copia lo perdería en silencio).
const HOST_KEYS = ['id', 'name', 'group', 'tags', 'color', 'host', 'user', 'port', 'authMethod', 'identityFile', 'hasPassword', 'hasPassphrase',
  'hostKeyPolicy', 'proxyJump', 'command', 'tmux', 'remoteMetrics', 'notes', 'agentAccess'] as const satisfies readonly (keyof Host)[];
const ACCOUNT_KEYS = ['id', 'name', 'dir', 'isDefault', 'color', 'provider'] as const satisfies readonly (keyof Account)[];
const _hostKeysComplete: Exclude<keyof Host, (typeof HOST_KEYS)[number]> extends never ? true : never = true;
const _accountKeysComplete: Exclude<keyof Account, (typeof ACCOUNT_KEYS)[number]> extends never ? true : never = true;
void _hostKeysComplete; void _accountKeysComplete;

// ---------- paneles ----------

/** Lo que se guarda de un panel: la especificación restaurable, sin el nombre de la entrada de la bóveda. */
function exportSpec(spec: PaneSpec): PaneSpec {
  const s = restorableSpec(spec);
  const out: PaneSpec = { program: s.program, args: [...(s.args ?? [])] };
  if (s.cwd) out.cwd = s.cwd;
  if (s.env) {
    const env = Object.fromEntries(Object.entries(s.env).filter(([k]) => k !== ASKPASS_ENV));
    if (Object.keys(env).length) out.env = env;
  }
  return out;
}

/** Valida un PaneSpec que viene de un archivo. null = descartar el panel entero. */
export function sanitizeSpec(raw: unknown): PaneSpec | null {
  if (!isObj(raw)) return null;
  const L = BACKUP_LIMITS;
  const program = typeof raw.program === 'string' ? raw.program.replace(CTRL, '').trim() : '';
  if (!program || program.length > L.program) return null;
  if (!Array.isArray(raw.args) || raw.args.length > L.args) return null;
  const args: string[] = [];
  for (const a of raw.args) {
    if (typeof a !== 'string' || a.length > L.arg || a.includes('\u0000')) return null;
    args.push(a);
  }
  const spec: PaneSpec = { program, args };
  if (raw.cwd !== undefined && raw.cwd !== null) {
    if (typeof raw.cwd !== 'string' || raw.cwd.length > L.cwd || raw.cwd.includes('\u0000')) return null;
    if (raw.cwd) spec.cwd = raw.cwd;
  }
  if (raw.env !== undefined && raw.env !== null) {
    if (!isObj(raw.env)) return null;
    const entries = Object.entries(raw.env);
    if (entries.length > L.envVars) return null;
    const env: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (typeof v !== 'string' || v.length > L.envValue || v.includes('\u0000')) return null;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || k.length > L.envKey) return null;
      if (k === ASKPASS_ENV) continue; // se regenera desde el host, jamás se toma de un archivo
      env[k] = v;
    }
    if (Object.keys(env).length) spec.env = env;
  }
  return spec;
}

const PANE_KINDS: readonly PaneKind[] = ['shell', 'ssh', 'agent'];
const cellInt = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : dflt;

function tracksOf(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > BACKUP_LIMITS.tracks) return null;
  if (!v.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) return null;
  const sum = (v as number[]).reduce((a, b) => a + b, 0);
  return (v as number[]).map((n) => n / sum);
}

function sanitizePane(raw: unknown, cols: number, rows: number, taken: Set<string>): Pane | null {
  if (!isObj(raw)) return null;
  const spec = sanitizeSpec(raw.spec);
  if (!spec) return null;
  const kind = PANE_KINDS.includes(raw.kind as PaneKind) ? (raw.kind as PaneKind) : null;
  if (!kind) return null;
  let id = goodId(raw.id) && !taken.has(raw.id) ? raw.id : uid('t');
  while (taken.has(id)) id = uid('t');
  taken.add(id);
  const col = cellInt(raw.col, 0, cols - 1, 0);
  const row = cellInt(raw.row, 0, rows - 1, 0);
  const pane: Pane = {
    id, col, row,
    colSpan: cellInt(raw.colSpan, 1, cols - col, 1),
    rowSpan: cellInt(raw.rowSpan, 1, rows - row, 1),
    parked: raw.parked === true,
    kind,
    icon: text(raw.icon, 40) ?? 'terminal',
    title: text(raw.title, BACKUP_LIMITS.title) ?? '',
    spec,
  };
  const ref = text(raw.ref, 200);
  if (ref) pane.ref = ref;
  return pane;
}

interface WsResult { workspaces: Workspace[]; dropped: number }

function sanitizeWorkspaces(raw: unknown): WsResult {
  const out: Workspace[] = [];
  let dropped = 0;
  if (!Array.isArray(raw)) return { workspaces: out, dropped };
  const wsIds = new Set<string>();
  const paneIds = new Set<string>();
  for (const w of raw) {
    if (!isObj(w)) continue;
    const cols = tracksOf(w.cols);
    const rows = tracksOf(w.rows);
    if (!cols || !rows || !Array.isArray(w.panes)) continue;
    if (w.panes.length > BACKUP_LIMITS.panesPerWorkspace) throw new Error('panes');
    let id = goodId(w.id) && !wsIds.has(w.id) ? w.id : uid('ws');
    while (wsIds.has(id)) id = uid('ws');
    wsIds.add(id);
    const panes: Pane[] = [];
    for (const p of w.panes) {
      const pane = sanitizePane(p, cols.length, rows.length, paneIds);
      if (pane) panes.push(pane); else dropped++;
    }
    const ws: Workspace = { id, name: text(w.name, 60) ?? 'Workspace', cols, rows, panes };
    if (typeof w.focusId === 'string' && panes.some((p) => p.id === w.focusId)) ws.focusId = w.focusId;
    const sbi = cleanOverride(w.statusBarItems);
    if (sbi) ws.statusBarItems = sbi;
    out.push(ws);
  }
  return { workspaces: out, dropped };
}

// ---------- hosts y cuentas ----------

const ACCESS: readonly AgentAccess[] = ['none', 'read', 'ask', 'full'];
/** Un destino de ssh que empiece por «-» sería una opción de ssh (`-oProxyCommand=…`), no un host. */
const sshWord = (s: string | undefined): s is string => !!s && !/^-/.test(s) && !/\s/.test(s);

function sanitizeHost(raw: unknown): Host | null {
  if (!isObj(raw)) return null;
  const host = text(raw.host, 253);
  if (!sshWord(host)) return null;
  let user: string | undefined;
  if (raw.user !== undefined && raw.user !== null && raw.user !== '') {
    user = text(raw.user, 64);
    if (!sshWord(user) || user.includes('@')) return null;
  }
  const base: Record<string, unknown> = {
    id: goodId(raw.id) ? raw.id : uid('h'),
    name: text(raw.name, 100) ?? '',
    tags: Array.isArray(raw.tags) ? raw.tags.map((x) => text(x, 40)).filter((x): x is string => !!x).slice(0, 30) : [],
    host,
    authMethod: raw.authMethod,
    agentAccess: ACCESS.includes(raw.agentAccess as AgentAccess) ? raw.agentAccess : 'none',
    tmux: raw.tmux === true ? true : undefined,
    remoteMetrics: raw.remoteMetrics === true ? true : undefined,
    hostKeyPolicy: raw.hostKeyPolicy,
  };
  if (user) base.user = user;
  const group = text(raw.group, 60); if (group) base.group = group;
  if (isHex(raw.color)) base.color = raw.color;
  if (typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535) base.port = raw.port;
  const idf = text(raw.identityFile, 500); if (idf) base.identityFile = idf;
  const pj = text(raw.proxyJump, 300); if (sshWord(pj)) base.proxyJump = pj;
  const cmd = text(raw.command, 2000); if (cmd) base.command = cmd;
  const notes = longText(raw.notes, 4000); if (notes) base.notes = notes;
  if (base.tmux === undefined) delete base.tmux;
  if (base.remoteMetrics === undefined) delete base.remoteMetrics;
  if (base.hostKeyPolicy === undefined) delete base.hostKeyPolicy;
  // Sin hasPassword / hasPassphrase: el secreto no viaja, así que la bandera no tiene sentido en otro equipo (normalizeHost las quita).
  return normalizeHost(base as unknown as Host);
}

function sanitizeAccounts(raw: unknown): Account[] {
  const out: Account[] = [];
  const ids = new Set<string>();
  for (const a of normalizeAccounts(raw)) {
    const r = a as unknown as Record<string, unknown>;
    const dir = typeof r.dir === 'string' ? r.dir.replace(CTRL, '').trim().slice(0, 500) : '';
    if (!dir) continue;
    let id = goodId(r.id) && !ids.has(r.id) ? r.id : uid('acc');
    while (ids.has(id)) id = uid('acc');
    ids.add(id);
    out.push({
      id, dir,
      name: text(r.name, 60) ?? (dir.replace(/\\/g, '/').split('/').pop() || 'account'),
      isDefault: r.isDefault === true,
      color: isHex(r.color) ? r.color : ACCOUNT_COLORS[out.length % ACCOUNT_COLORS.length],
      provider: providerOf(r),
    });
  }
  return out;
}

// ---------- exportar ----------

export function backupFileName(now: Date = new Date()): string {
  return `orchestra-backup-${now.toISOString().slice(0, 10)}.json`;
}

/** Construye el archivo. No muta `state`. Sin secretos, sin `usageQuery`, sin estado vivo de los paneles. */
export function buildBackup(state: BackupState, meta: { appVersion: string; now?: Date }): BackupFile {
  const settings = { ...clone(state.settings) } as Partial<Settings>;
  delete settings.usageQuery; // lee un token: se enciende solo desde su diálogo
  const hosts = state.hosts.map((h) => {
    const o: Record<string, unknown> = {};
    for (const k of HOST_KEYS) if (k !== 'hasPassword' && k !== 'hasPassphrase' && h[k] !== undefined) o[k] = clone(h[k]);
    return o as unknown as Host;
  });
  const accounts = state.accounts.map((a) => {
    const o: Record<string, unknown> = {};
    for (const k of ACCOUNT_KEYS) if (a[k] !== undefined) o[k] = a[k];
    return o as unknown as Account;
  });
  const workspaces: Workspace[] = state.workspaces.map((w) => {
    const ws: Workspace = {
      id: w.id, name: w.name, cols: [...w.cols], rows: [...w.rows],
      panes: w.panes.map((p) => {
        const pane: Pane = {
          id: p.id, col: p.col, row: p.row, colSpan: p.colSpan, rowSpan: p.rowSpan, parked: p.parked,
          kind: p.kind, icon: p.icon, title: p.title, spec: exportSpec(p.spec),
        };
        if (p.ref) pane.ref = p.ref;
        return pane;
      }),
    };
    if (w.focusId) ws.focusId = w.focusId;
    const sbi = cleanOverride(w.statusBarItems);
    if (sbi) ws.statusBarItems = sbi;
    return ws;
  });
  return scrub({
    app: BACKUP_APP, format: BACKUP_FORMAT, appVersion: meta.appVersion, exportedAt: (meta.now ?? new Date()).toISOString(),
    settings, hosts, accounts, customThemes: clone(state.customThemes), workspaces,
    activeId: state.activeId, ignoredDirs: state.ignoredDirs.filter((d) => typeof d === 'string'),
  });
}

export function serializeBackup(b: BackupFile): string {
  return JSON.stringify(b, null, 2);
}

// ---------- importar: leer y validar (sin tocar nada) ----------

const fail = (error: string): ParseBackupResult => ({ ok: false, error });

export function parseBackup(input: string): ParseBackupResult {
  if (typeof input !== 'string' || !input.trim()) return fail(t('settings.data.backup.errEmpty'));
  const bytes = new TextEncoder().encode(input).length;
  if (bytes > MAX_BACKUP_BYTES) return fail(t('settings.data.backup.errTooBig', { mb: Math.round(MAX_BACKUP_BYTES / 1048576) }));
  let raw: unknown;
  try { raw = JSON.parse(input); } catch (e) { return fail(t('settings.data.backup.errJson', { message: (e as Error).message })); }
  if (!isObj(raw) || raw.app !== BACKUP_APP) return fail(t('settings.data.backup.errNotBackup'));
  const format = raw.format;
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) return fail(t('settings.data.backup.errFormat'));
  if (format > BACKUP_FORMAT) return fail(t('settings.data.backup.errFuture', { format }));

  const L = BACKUP_LIMITS;
  const list = (v: unknown, max: number): unknown[] | null => (Array.isArray(v) ? (v.length > max ? null : v) : []);
  const hostsRaw = list(raw.hosts, L.hosts);
  const accountsRaw = list(raw.accounts, L.accounts);
  const themesRaw = list(raw.customThemes, MAX_CUSTOM_THEMES);
  const dirsRaw = list(raw.ignoredDirs, L.ignoredDirs);
  const wsRaw = list(raw.workspaces, L.workspaces);
  if (!hostsRaw) return fail(t('settings.data.backup.errTooMany', { what: 'hosts' }));
  if (!accountsRaw) return fail(t('settings.data.backup.errTooMany', { what: 'accounts' }));
  if (!themesRaw) return fail(t('settings.data.backup.errTooMany', { what: 'themes' }));
  if (!dirsRaw) return fail(t('settings.data.backup.errTooMany', { what: 'ignoredDirs' }));
  if (!wsRaw) return fail(t('settings.data.backup.errTooMany', { what: 'workspaces' }));

  let ws: WsResult;
  try { ws = sanitizeWorkspaces(wsRaw); } catch { return fail(t('settings.data.backup.errTooMany', { what: 'panes' })); }

  const hosts: Host[] = [];
  const hostIds = new Set<string>();
  let droppedHosts = 0;
  for (const h of hostsRaw) {
    const c = sanitizeHost(h);
    if (!c) { droppedHosts++; continue; }
    while (hostIds.has(c.id)) c.id = uid('h');
    hostIds.add(c.id);
    hosts.push(c);
  }

  const hasSettings = isObj(raw.settings) && Object.keys(raw.settings).length > 0;
  const sections: BackupSections = {
    settings: hasSettings ? clampSettings({ ...(raw.settings as Record<string, unknown>), usageQuery: false }) : null,
    hosts,
    accounts: sanitizeAccounts(accountsRaw),
    customThemes: sanitizeCustomThemes(themesRaw),
    workspaces: ws.workspaces,
    ignoredDirs: dirsRaw.filter((d): d is string => typeof d === 'string').map((d) => d.slice(0, 500)),
  };
  if (typeof raw.activeId === 'string' && ws.workspaces.some((w) => w.id === raw.activeId)) sections.activeId = raw.activeId;

  const summary: BackupSummary = {
    hosts: hosts.length, accounts: sections.accounts.length, themes: sections.customThemes.length,
    workspaces: ws.workspaces.length, panes: ws.workspaces.reduce((n, w) => n + w.panes.length, 0),
    hasSettings: sections.settings !== null, droppedPanes: ws.dropped, droppedHosts,
    hostsWithCommand: hosts.filter((h) => h.command || h.proxyJump).length,
    appVersion: text(raw.appVersion, 30) ?? '?', exportedAt: text(raw.exportedAt, 40) ?? '',
  };
  if (!summary.hasSettings && !summary.hosts && !summary.accounts && !summary.themes && !summary.workspaces) {
    return fail(t('settings.data.backup.errNothing'));
  }
  return { ok: true, summary, sections };
}

// ---------- importar: aplicar (puro; el almacén escribe el resultado) ----------

const hostKey = (h: Pick<Host, 'host' | 'user' | 'port'>): string => `${(h.user ?? '').toLowerCase()}@${h.host.toLowerCase()}:${h.port ?? 22}`;
const themeSig = (d: ThemeDef): string => JSON.stringify([d.name, d.background, d.foreground, d.cursor, d.selection, d.ansi]);

function emptyReport(mode: BackupReport['mode']): BackupReport {
  return {
    mode, settings: false, hostsAdded: 0, hostsSkipped: 0, accountsAdded: 0, accountsSkipped: 0,
    themesAdded: 0, themesSkipped: 0, workspacesAdded: 0, workspacesSkipped: 0, panesAdded: 0,
  };
}

/** Ajustes del archivo sobre los actuales: `usageQuery` y `mcpExposeLocal` se quedan como están; un tema propio que no exista cae al de serie. */
function importedSettings(cur: Settings, imp: Settings, themes: readonly ThemeDef[], themeMap: Map<string, string>): Settings {
  const s = clampSettings({ ...imp, usageQuery: cur.usageQuery, mcpExposeLocal: cur.mcpExposeLocal }); // ambos dan acceso a datos o terminales: solo se cambian desde sus diálogos
  const mapped = themeMap.get(s.theme);
  if (mapped) s.theme = mapped;
  if (!hasTheme(s.theme, themes)) s.theme = DEFAULT_THEME;
  return s;
}

function remapPane(p: Pane, hostMap: Map<string, string>, accMap: Map<string, string>): void {
  if (p.ref && p.kind === 'ssh' && hostMap.has(p.ref)) p.ref = hostMap.get(p.ref);
  if (p.ref && p.kind === 'agent' && accMap.has(p.ref)) {
    const old = p.ref;
    p.ref = accMap.get(old);
    if (p.spec.env?.ORCHESTRA_ACCOUNT === old) p.spec.env.ORCHESTRA_ACCOUNT = p.ref as string;
  }
}

/** Mezcla: añade lo que no está (dedupe por id y luego por destino/carpeta), con ids nuevos en las colisiones. No muta `current` ni `backup`. */
export function mergeBackup(current: BackupState, backup: BackupSections, picks: BackupPicks): { state: BackupState; report: BackupReport } {
  const state = clone(current);
  const src = clone(backup);
  const report = emptyReport('merge');
  const hostMap = new Map<string, string>();
  const accMap = new Map<string, string>();
  const themeMap = new Map<string, string>();

  if (picks.hosts) {
    const byId = new Map(state.hosts.map((h) => [h.id, h]));
    const byKey = new Map(state.hosts.map((h) => [hostKey(h), h]));
    for (const h of src.hosts) {
      const same = byId.get(h.id);
      const dupe = (same && hostKey(same) === hostKey(h) ? same : undefined) ?? byKey.get(hostKey(h));
      if (dupe) { hostMap.set(h.id, dupe.id); report.hostsSkipped++; continue; }
      const oldId = h.id;
      if (byId.has(h.id)) h.id = uid('h');
      hostMap.set(oldId, h.id);
      state.hosts.push(h); byId.set(h.id, h); byKey.set(hostKey(h), h);
      report.hostsAdded++;
    }
  }

  if (picks.accounts) {
    const byId = new Map(state.accounts.map((a) => [a.id, a]));
    const byDir = new Map(state.accounts.map((a) => [`${providerOf(a)}|${normDir(a.dir)}`, a]));
    for (const a of src.accounts) {
      const p = providerOf(a);
      const same = byId.get(a.id);
      let dupe = (same && normDir(same.dir) === normDir(a.dir) ? same : undefined) ?? byDir.get(`${p}|${normDir(a.dir)}`);
      // La cuenta «de siempre» de otro equipo (otra ruta de usuario) es la que ya hay aquí, no una segunda por defecto.
      if (!dupe && a.isDefault) dupe = state.accounts.find((x) => x.isDefault && providerOf(x) === p);
      if (dupe) { accMap.set(a.id, dupe.id); report.accountsSkipped++; continue; }
      const oldId = a.id;
      if (byId.has(a.id)) a.id = uid('acc');
      accMap.set(oldId, a.id);
      state.accounts.push(a); byId.set(a.id, a); byDir.set(`${p}|${normDir(a.dir)}`, a);
      report.accountsAdded++;
    }
    const have = new Set(state.ignoredDirs.map(normDir));
    for (const d of src.ignoredDirs) if (!have.has(normDir(d))) { state.ignoredDirs.push(d); have.add(normDir(d)); }
  }

  if (picks.themes) {
    const sigs = new Map(state.customThemes.map((d) => [themeSig(d), d.id]));
    const fresh: ThemeDef[] = [];
    for (const d of src.customThemes) {
      const dupId = sigs.get(themeSig(d));
      if (dupId) { themeMap.set(d.id, dupId); report.themesSkipped++; continue; }
      fresh.push(d);
    }
    const room = Math.max(0, MAX_CUSTOM_THEMES - state.customThemes.length);
    const take = fresh.slice(0, room);
    const named = withUniqueIds(take, state.customThemes);
    take.forEach((d, i) => themeMap.set(d.id, named[i].id));
    state.customThemes.push(...named);
    report.themesAdded = named.length;
    report.themesSkipped += fresh.length - take.length;
  }

  if (picks.workspaces) {
    const wsIds = new Set(state.workspaces.map((w) => w.id));
    const paneIds = new Set(state.workspaces.flatMap((w) => w.panes.map((p) => p.id)));
    for (const w of src.workspaces) {
      const same = state.workspaces.find((x) => x.id === w.id);
      if (same && same.name === w.name) { report.workspacesSkipped++; continue; }
      if (wsIds.has(w.id)) w.id = uid('ws');
      wsIds.add(w.id);
      const renamed = new Map<string, string>();
      for (const p of w.panes) {
        if (paneIds.has(p.id)) { const n = uid('t'); renamed.set(p.id, n); p.id = n; }
        paneIds.add(p.id);
        remapPane(p, hostMap, accMap);
      }
      if (w.focusId && renamed.has(w.focusId)) w.focusId = renamed.get(w.focusId);
      state.workspaces.push(w);
      report.workspacesAdded++;
      report.panesAdded += w.panes.length;
    }
  }

  if (picks.settings && src.settings) {
    state.settings = importedSettings(current.settings, src.settings, state.customThemes, themeMap);
    report.settings = true;
  } else if (!hasTheme(state.settings.theme, state.customThemes)) {
    state.settings = { ...state.settings, theme: DEFAULT_THEME };
  }
  return { state, report };
}

/** Sustituye las secciones marcadas por las del archivo (lo demás queda igual). No muta `current` ni `backup`. */
export function replaceFromBackup(current: BackupState, backup: BackupSections, picks: BackupPicks): { state: BackupState; report: BackupReport } {
  const state = clone(current);
  const src = clone(backup);
  const report = emptyReport('replace');

  if (picks.hosts) {
    const old = new Map(current.hosts.map((h) => [h.id, h]));
    // Si el host ya estaba con el mismo método de acceso, su secreto guardado (en la bóveda, bajo ese id) sigue valiendo.
    state.hosts = src.hosts.map((h) => {
      const prev = old.get(h.id);
      if (prev && prev.authMethod === h.authMethod) {
        if (prev.hasPassword) h.hasPassword = true;
        if (prev.hasPassphrase) h.hasPassphrase = true;
      }
      return h;
    });
    report.hostsAdded = state.hosts.length;
  }
  if (picks.accounts) {
    state.accounts = src.accounts;
    state.ignoredDirs = src.ignoredDirs;
    report.accountsAdded = src.accounts.length;
  }
  if (picks.themes) {
    state.customThemes = src.customThemes;
    report.themesAdded = src.customThemes.length;
  }
  if (picks.workspaces && src.workspaces.length) {
    state.workspaces = src.workspaces;
    state.activeId = src.activeId ?? src.workspaces[0].id;
    report.workspacesAdded = src.workspaces.length;
    report.panesAdded = src.workspaces.reduce((n, w) => n + w.panes.length, 0);
  }
  if (picks.settings && src.settings) {
    state.settings = importedSettings(current.settings, src.settings, state.customThemes, new Map());
    report.settings = true;
  } else if (!hasTheme(state.settings.theme, state.customThemes)) {
    state.settings = { ...state.settings, theme: DEFAULT_THEME };
  }
  return { state, report };
}

/** ¿Hay algo que aplicar con estas casillas? (el botón se apaga si no). */
export function anyPicked(sections: BackupSections, picks: BackupPicks): boolean {
  return (picks.settings && !!sections.settings) || (picks.hosts && sections.hosts.length > 0) || (picks.accounts && sections.accounts.length > 0)
    || (picks.themes && sections.customThemes.length > 0) || (picks.workspaces && sections.workspaces.length > 0);
}
