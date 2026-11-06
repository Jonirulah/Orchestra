// Barra de estado: ayudas puras (formato, orden y validación de elementos, niveles, recorte por ancho).
// Sin Svelte ni Tauri: se prueba con node --test. No importa settings.ts (settings.ts importa este módulo).

/** Elementos que siguen al panel con foco de la pestaña activa (no miden el equipo). */
export const CONTEXT_IDS = ['pane', 'target', 'branch', 'latency', 'account', 'agentState'] as const;
export const ITEM_IDS = ['hostname', 'cpu', 'ram', 'disk', 'net', 'uptime', 'agents', 'usage', ...CONTEXT_IDS] as const;
/** Métricas del equipo LOCAL: con un panel SSH enfocado no son las del servidor (la ayuda lo avisa). */
export const LOCAL_METRIC_IDS = ['cpu', 'ram', 'disk', 'net', 'uptime'] as const;
export type ItemId = (typeof ITEM_IDS)[number];
export const DEFAULT_ITEMS: readonly ItemId[] = ['hostname', 'cpu', 'ram', 'net', 'uptime'];
/** Segundos entre muestras. */
export const INTERVAL_LIMITS = [1, 10] as const;
export const DEFAULT_INTERVAL = 2;
/** Segundos entre líneas de las métricas del SERVIDOR (conexión SSH aparte): 2–10, por defecto 3. */
export const RM_INTERVAL_LIMITS = [2, 10] as const;
export const DEFAULT_RM_INTERVAL = 3;

/** Lo que devuelve `metrics_sample` (Rust). Tasas en bytes/s; tamaños en bytes. */
export interface Metrics {
  ready: boolean;
  cpu: number;
  ramUsed: number; ramTotal: number;
  swapUsed: number; swapTotal: number;
  diskRead: number; diskWrite: number;
  netIn: number; netOut: number;
  uptime: number;
  hostname: string;
}

export const isContextItem = (id: ItemId): boolean => (CONTEXT_IDS as readonly string[]).includes(id);

export const isItemId = (v: unknown): v is ItemId => typeof v === 'string' && (ITEM_IDS as readonly string[]).includes(v);

/**
 * Lista de elementos válida: se quitan los desconocidos y los repetidos (gana el primero) y se conserva el orden.
 * Algo que no es una lista cae a los de por defecto; una lista vacía es válida (el usuario los apagó todos).
 */
export function cleanItems(v: unknown): ItemId[] {
  if (!Array.isArray(v)) return [...DEFAULT_ITEMS];
  const out: ItemId[] = [];
  for (const x of v) if (isItemId(x) && !out.includes(x)) out.push(x);
  return out;
}

export function cleanInterval(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_INTERVAL;
  return Math.min(INTERVAL_LIMITS[1], Math.max(INTERVAL_LIMITS[0], Math.round(v)));
}

export function cleanRmInterval(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_RM_INTERVAL;
  return Math.min(RM_INTERVAL_LIMITS[1], Math.max(RM_INTERVAL_LIMITS[0], Math.round(v)));
}

/** Mueve `id` una posición (−1 = antes, +1 = después). Fuera de rango o ausente: igual. */
export function moveItem(list: readonly ItemId[], id: ItemId, dir: -1 | 1): ItemId[] {
  const i = list.indexOf(id);
  const j = i + dir;
  const out = [...list];
  if (i < 0 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Enciende (al final) o apaga un elemento. */
export function toggleItem(list: readonly ItemId[], id: ItemId, on: boolean): ItemId[] {
  const has = list.includes(id);
  if (on) return has ? [...list] : [...list, id];
  return list.filter((x) => x !== id);
}

// ---------- formato ----------

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** «1.5 GB». Tamaños (RAM). */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) n = 0;
  let u = 0;
  while (n >= 1024 && u < UNITS.length - 1) { n /= 1024; u++; }
  return `${u === 0 ? Math.round(n) : n >= 100 ? Math.round(n) : n.toFixed(1)} ${UNITS[u]}`;
}

/**
 * Tasa en bytes/s con unidad compacta y precisión fija (cabe en un hueco de ancho fijo): «0 B/s», «12 KB/s», «3.4 MB/s».
 */
export function fmtRate(bps: number): string {
  if (!Number.isFinite(bps) || bps < 0) bps = 0;
  return `${fmtBytes(bps)}/s`;
}

/** «12m», «5h 03m», «2d 5h». */
export function fmtUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/** Porcentaje entero 0–100 («7%»). */
export function fmtPct(p: number): string {
  if (!Number.isFinite(p)) p = 0;
  return `${Math.round(Math.min(100, Math.max(0, p)))}%`;
}

export function pctOf(used: number, total: number): number {
  if (!(total > 0) || !Number.isFinite(used)) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

// ---------- niveles ----------

export type Level = 'ok' | 'warn' | 'bad';
export const WARN_AT = 85;
export const BAD_AT = 95;

/** > 85 % aviso, > 95 % malo (estrictamente por encima). */
export function levelFor(pct: number): Level {
  if (!Number.isFinite(pct)) return 'ok';
  if (pct > BAD_AT) return 'bad';
  if (pct > WARN_AT) return 'warn';
  return 'ok';
}

// ---------- ancho ----------

/** Ancho fijo (px) de cada hueco: la barra no baila cuando cambian los números. */
export const SLOT_PX: Record<ItemId, number> = {
  hostname: 132, cpu: 82, ram: 128, disk: 180, net: 180, uptime: 92, agents: 100, usage: 112,
  pane: 150, target: 220, branch: 230, latency: 84, account: 130, agentState: 150,
};
export const SEP_PX = 1 + 2 * 10;

/** Elementos que caben en `width` px: se quitan por la derecha. Si ni el primero cabe, ninguno. */
export function fitItems(items: readonly ItemId[], width: number): ItemId[] {
  const out: ItemId[] = [];
  let used = 0;
  for (const id of items) {
    const need = SLOT_PX[id] + (out.length ? SEP_PX : 0);
    if (used + need > width) break;
    used += need;
    out.push(id);
  }
  return out;
}

// ---------- uso de Claude ----------

/** El mayor de los dos porcentajes (5 h / 7 d) ya calculados, con cuál es. `null` si no hay ninguno. */
export function topUsage(five: number | null | undefined, seven: number | null | undefined): { pct: number; window: '5h' | '7d' } | null {
  const f = typeof five === 'number' && Number.isFinite(five) ? five : null;
  const s = typeof seven === 'number' && Number.isFinite(seven) ? seven : null;
  if (f === null && s === null) return null;
  if (s === null || (f !== null && f >= s)) return { pct: f as number, window: '5h' };
  return { pct: s, window: '7d' };
}

/** Contadores de agentes: trabajando (busy) y esperando (waiting). */
export function countAgents(list: readonly { status: string }[]): { working: number; waiting: number } {
  let working = 0, waiting = 0;
  for (const a of list) { if (a.status === 'busy') working++; else if (a.status === 'waiting') waiting++; }
  return { working, waiting };
}

// ---------- por pestaña ----------

/** Lista propia de una pestaña: `undefined` si no hay (ausente o no es una lista); si la hay, se limpia como la global. */
export function cleanOverride(v: unknown): ItemId[] | undefined {
  return Array.isArray(v) ? cleanItems(v) : undefined;
}

/** Lo que el panel con foco dice de sí mismo: tipo (null = ninguno) y si está en un repositorio git. */
export interface FocusCtx { kind: 'shell' | 'ssh' | 'agent' | null; repo?: boolean }

export const ADAPT_SSH: readonly ItemId[] = ['target', 'latency', 'cpu', 'ram', 'net'];
export const ADAPT_REPO: readonly ItemId[] = ['branch', 'cpu', 'ram', 'net', 'uptime'];

/** Juego «inteligente» según el panel: SSH → destino y latencia; local con repo → rama. Otro caso: `null` (sigue la lista global). */
export function adaptedItems(ctx: FocusCtx | null | undefined): ItemId[] | null {
  if (!ctx) return null;
  if (ctx.kind === 'ssh') return [...ADAPT_SSH];
  if (ctx.kind && ctx.repo) return [...ADAPT_REPO];
  return null;
}

/**
 * Elementos de la barra para una pestaña: su lista propia si la tiene; si no, la adaptada al panel (solo con `statusBarAdapt`);
 * si no, la global. Siempre una copia: no se muta nada de lo recibido.
 */
export function itemsFor(
  ws: { statusBarItems?: unknown } | null | undefined,
  s: { statusBarItems: readonly ItemId[]; statusBarAdapt?: boolean },
  ctx?: FocusCtx | null,
): ItemId[] {
  const own = ws ? cleanOverride(ws.statusBarItems) : undefined;
  if (own) return own;
  if (s.statusBarAdapt) { const a = adaptedItems(ctx); if (a) return a; }
  return [...s.statusBarItems];
}

/** Marcar/desmarcar un elemento: edita la lista de la pestaña si la tiene, si no la global. Devuelve dónde y la lista nueva. */
export function toggleFor(
  ws: { statusBarItems?: unknown } | null | undefined, globalItems: readonly ItemId[], id: ItemId, on: boolean,
): { scope: 'tab' | 'global'; list: ItemId[] } {
  const own = ws ? cleanOverride(ws.statusBarItems) : undefined;
  return own ? { scope: 'tab', list: toggleItem(own, id, on) } : { scope: 'global', list: toggleItem(globalItems, id, on) };
}

/** Mover un elemento dentro de la lista que esté en uso (la de la pestaña o la global). */
export function moveFor(
  ws: { statusBarItems?: unknown } | null | undefined, globalItems: readonly ItemId[], id: ItemId, dir: -1 | 1,
): { scope: 'tab' | 'global'; list: ItemId[] } {
  const own = ws ? cleanOverride(ws.statusBarItems) : undefined;
  return own ? { scope: 'tab', list: moveItem(own, id, dir) } : { scope: 'global', list: moveItem(globalItems, id, dir) };
}

/** «Personalizar para esta pestaña»: copia de la lista que se estaba viendo. */
export const customizeList = (shown: readonly ItemId[]): ItemId[] => cleanItems([...shown]);

// ---------- destino SSH ----------

interface SshPaneLike { kind: string; ref?: string; spec: { program: string; args: string[] } }
interface SshHostLike { id: string; host: string; user?: string; port?: number }
interface SshCfgLike { alias: string; hostname?: string; port?: number }

/** «usuario@host:puerto» de un panel SSH, sacado de lo que la app ya sabe (host guardado, alias de ~/.ssh/config o argumentos). `null` si no es SSH. */
export function sshTarget(pane: SshPaneLike, hosts: readonly SshHostLike[], cfg: readonly SshCfgLike[]): string | null {
  if (pane.kind !== 'ssh') return null;
  const ref = pane.ref;
  if (ref?.startsWith('cfg:')) {
    const alias = ref.slice(4);
    const c = cfg.find((x) => x.alias === alias);
    return `${c?.hostname || alias}:${c?.port ?? 22}`;
  }
  if (ref) {
    const h = hosts.find((x) => x.id === ref);
    return h ? `${h.user ? `${h.user}@` : ''}${h.host}:${h.port ?? 22}` : null;
  }
  if (pane.spec.program !== 'ssh') return null;
  const a = pane.spec.args;
  const last = a[a.length - 1];
  if (!last || last.startsWith('-')) return null;
  const pi = a.indexOf('-p');
  const port = pi >= 0 && Number.isInteger(Number(a[pi + 1])) ? Number(a[pi + 1]) : 22;
  return `${last}:${port}`;
}

// ---------- métricas del servidor (SSH) ----------

/** Muestra del servidor (`rmetrics_sample`, Rust): como `Metrics` más núcleos y carga. */
export interface RemoteSample extends Metrics { cores: number; load: number }
/** Estado del monitor de un host. `none` = no hay monitor. */
export type RemoteState = 'none' | 'connecting' | 'ok' | 'unavailable' | 'stale';
export type RemoteFailKind = 'hostkey' | 'auth' | 'unsupported' | 'network' | 'other';
export interface RemoteSnap { state: RemoteState; reason?: string | null; kind?: RemoteFailKind | string | null; sample?: RemoteSample | null; ageMs?: number | null }

/** De dónde salen CPU/RAM/disco/red/uptime/hostname de la barra. */
export type MetricSource =
  | { kind: 'local' }
  | { kind: 'remote'; sample: RemoteSample }
  | { kind: 'remote-pending'; state: RemoteState; failKind: string | null; reason: string | null };

/**
 * Fuente de las métricas: las del servidor solo si el panel con foco es SSH de un host con «métricas del servidor» encendidas.
 * Con el monitor sin datos (conectando, caído, desfasado) NO se vuelve al equipo local —sería engañoso—: se enseña un marcador.
 * No muta nada de lo recibido.
 */
export function metricSource(remoteOn: boolean, snap: RemoteSnap | null | undefined): MetricSource {
  if (!remoteOn) return { kind: 'local' };
  if (snap && snap.state === 'ok' && snap.sample) return { kind: 'remote', sample: snap.sample };
  const state = snap?.state ?? 'none';
  return { kind: 'remote-pending', state: state === 'ok' ? 'connecting' : state, failKind: typeof snap?.kind === 'string' ? snap.kind : null, reason: snap?.reason ?? null };
}

/** Elementos de métricas que cambian de fuente con un panel SSH enfocado. */
export const REMOTE_CAPABLE: readonly ItemId[] = ['hostname', 'cpu', 'ram', 'disk', 'net', 'uptime'];
/** Ancho (px) de la marca «ssh» que precede al primer elemento de servidor. */
export const SRV_PX = 30;
