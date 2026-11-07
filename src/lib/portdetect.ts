// Reenvío de puertos SSH: detectar en la salida de un panel SSH que algo escucha en un puerto del remoto
// («Local: http://localhost:5173/» de Vite, «Listening on port 4000», «Uvicorn running on http://127.0.0.1:8000»…)
// y el estado de cada túnel. Módulo PURO (sin Svelte ni Tauri): se prueba con node --test.
import { activeSecretKey } from './model.ts';
import type { Host } from './model.ts';

// ---------- limpiar la salida ----------

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

/** Quita los códigos ANSI (colores, OSC, movimientos) y los caracteres de control. Vite pinta el puerto en negrita. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

// ---------- qué puertos valen ----------

/**
 * Puertos que no se ofrecen solos aunque salgan: el 22 (el propio ssh) y los de bases de datos y servicios que no se abren
 * en un navegador (Postgres avisa «listening on … port 5432»). Se pueden reenviar a mano igual.
 */
export const IGNORED_PORTS: ReadonlySet<number> = new Set([22, 25, 53, 111, 2049, 3306, 5432, 6379, 9042, 11211, 27017]);

/** ¿Tiene sentido ofrecer este puerto? 1024–65535 salvo los de arriba; por debajo de 1024 solo 80 y 443. */
export function portAllowed(p: number): boolean {
  if (!Number.isInteger(p) || p < 1 || p > 65535) return false;
  if (IGNORED_PORTS.has(p)) return false;
  return p >= 1024 || p === 80 || p === 443;
}

// ---------- detección ----------

/** Hosts de una URL que son «este servidor»: localhost, 127.x, 0.0.0.0, [::], [::1] y las IP privadas (línea «Network:» de Vite). */
const LOCAL_HOST = String.raw`(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|\[::ffff:127\.0\.0\.1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})`;
/** URL con esquema: http(s):// o tcp:// (Puma) seguido de un host local y puerto. */
const URL_RE = new RegExp(String.raw`\b(?:https?|tcp|ws)://${LOCAL_HOST}:(\d{1,5})(?![\d.])`, 'gi');
/** host:puerto sin esquema (Angular «listening on localhost:4200», Next «started server on 0.0.0.0:3000», Ollama «127.0.0.1:11434»).
 *  No vale si va pegado a una ruta o palabra (`/srv/localhost:3000/x`, `foo127.0.0.1:80`). `[::]` sin `\b` delante. */
const BARE_RE = new RegExp(String.raw`(?:^|[\s"'(=,>])(?:${LOCAL_HOST}|\*):(\d{1,5})(?![\d.:/\w])`, 'gi');
/** Frases: «listening on port 4000», «Tomcat started on port(s): 8080», «Serving HTTP on 0.0.0.0 port 8000», «running at port 3000». */
const PHRASE_RE = /\b(?:listen(?:ing)?|running|serving|started|start(?:ing)?|available|ready|bound|server(?:\s+is)?)\b[^\n]{0,48}?\bports?(?:\(s\))?\s*[:=]?\s*(\d{2,5})\b(?![.:]\d)/gi;
/** Go y similares: «Listening on :8080», «serving on :3000». */
const COLON_RE = /\b(?:listen(?:ing)?|serving|running|started)\b(?:\s+\w+){0,2}\s+(?:on|at)\s+:(\d{2,5})\b/gi;

/** Puertos que anuncia UNA línea (ya sin ANSI o no: se limpia aquí). Sin repetir y solo los que valen. */
export function detectPorts(line: string): number[] {
  const s = stripAnsi(line);
  if (s.length > 2000 || !/\d/.test(s)) return [];
  const out: number[] = [];
  const add = (v: string) => {
    const p = Number(v);
    if (portAllowed(p) && !out.includes(p)) out.push(p);
  };
  for (const re of [URL_RE, BARE_RE, PHRASE_RE, COLON_RE]) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) add(m[1]);
  }
  return out;
}

/**
 * Lector por panel: la salida llega a trozos que parten líneas. Junta hasta el final de línea (\n o \r) y devuelve los puertos
 * nuevos de las líneas completas. Una línea sin terminar de más de `MAX_PENDING` caracteres se descarta (no es un aviso de servidor).
 */
export class PortScanner {
  static readonly MAX_PENDING = 4096;
  private pending = '';
  feed(chunk: string): number[] {
    const buf = this.pending + chunk;
    const parts = buf.split(/\r\n|\r|\n/);
    this.pending = parts.pop() ?? '';
    if (this.pending.length > PortScanner.MAX_PENDING) this.pending = '';
    const out: number[] = [];
    for (const l of parts) for (const p of detectPorts(l)) if (!out.includes(p)) out.push(p);
    return out;
  }
}

// ---------- túneles ----------

/** Lo que manda Rust (`portfwd::Snap`). */
export type TunnelState = 'connecting' | 'up' | 'down' | 'error';
export interface TunnelSnap {
  id: string; destKey: string; remotePort: number; localPort: number; state: TunnelState;
  error?: string | null; attempt: number; retryIn?: number | null; pid?: number | null;
}

/** Destino SSH de un host guardado (mismos campos que `Dest` de Rust; solo el NOMBRE del secreto). */
export interface FwdDest { user?: string; host: string; port: number; identity?: string; identitiesOnly: boolean; jump?: string; secretKey?: string }
export function fwdDest(h: Host): FwdDest {
  const jump = h.proxyJump?.trim();
  const sk = activeSecretKey(h);
  return {
    host: h.host, port: h.port ?? 22,
    ...(h.user ? { user: h.user } : {}),
    ...(h.identityFile ? { identity: h.identityFile } : {}),
    identitiesOnly: h.authMethod === 'key' && !!h.identityFile,
    ...(jump ? { jump } : {}),
    ...(sk ? { secretKey: sk } : {}),
  };
}

/** Misma clave que `Dest::key()` de Rust y que el id del túnel (`portfwd::tunnel_id`). */
export const destKey = (d: Pick<FwdDest, 'user' | 'host' | 'port' | 'jump'>): string => `${d.user ?? ''}@${d.host}:${d.port}|${d.jump ?? ''}`;
export const tunnelId = (d: Pick<FwdDest, 'user' | 'host' | 'port' | 'jump'>, remote: number): string => `${destKey(d)}#${remote}`;

/** URL que se abre en el navegador. */
export const localUrl = (localPort: number): string => `http://localhost:${localPort}/`;

export { parsePort, cleanForwards } from './model.ts';

/** Cómo se ve cada túnel en la lista: «ok», «conectando», «caído (reintenta en 4 s)» o «error». */
export type TunnelLook = 'ok' | 'wait' | 'down' | 'bad';
export function tunnelLook(s: Pick<TunnelSnap, 'state'>): TunnelLook {
  return s.state === 'up' ? 'ok' : s.state === 'connecting' ? 'wait' : s.state === 'down' ? 'down' : 'bad';
}

/** Lo que el frontend sabe de un túnel además de lo de Rust. */
export interface TunnelMeta { hostId: string; auto: boolean }

/**
 * Túneles que hay que parar porque su host ya no tiene ningún panel SSH vivo: solo los AUTOMÁTICOS (los de la detección o
 * los pedidos a mano), nunca los guardados en el host. `liveHosts` = ids de host con algún panel vivo.
 */
export function autoTunnelsToStop(
  tunnels: readonly Pick<TunnelSnap, 'id' | 'remotePort'>[],
  meta: Readonly<Record<string, TunnelMeta | undefined>>,
  hosts: readonly Pick<Host, 'id' | 'forwards'>[],
  liveHosts: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const t of tunnels) {
    const m = meta[t.id];
    if (!m || liveHosts.has(m.hostId)) continue;
    const saved = hosts.find((h) => h.id === m.hostId)?.forwards?.some((f) => f.remote === t.remotePort);
    if (!saved) out.push(t.id);
  }
  return out;
}

/** Reenvíos guardados que deben arrancar: los de los hosts con algún panel vivo que aún no tienen túnel. */
export function savedToStart(
  hosts: readonly Host[],
  liveHosts: ReadonlySet<string>,
  have: ReadonlySet<string>,
): { host: Host; remote: number; local?: number; id: string }[] {
  const out: { host: Host; remote: number; local?: number; id: string }[] = [];
  for (const h of hosts) {
    if (!liveHosts.has(h.id) || !h.forwards?.length) continue;
    const d = fwdDest(h);
    for (const f of h.forwards) {
      const id = tunnelId(d, f.remote);
      if (!have.has(id)) out.push({ host: h, remote: f.remote, ...(f.local ? { local: f.local } : {}), id });
    }
  }
  return out;
}

/** ¿Hay que avisar de este puerto? No si se ignoró o avisó ya en esta sesión, ni si ya hay un túnel a ese puerto del host. */
export function shouldOffer(hostId: string, port: number, seen: ReadonlySet<string>, tunneled: ReadonlySet<string>): boolean {
  return portAllowed(port) && !seen.has(`${hostId}:${port}`) && !tunneled.has(`${hostId}:${port}`);
}
