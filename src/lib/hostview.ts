// Vista de la lista de hosts SSH de la barra lateral: carpetas (campo `group`), orden manual o A-Z, plegado y reordenación.
// Módulo puro (sin Svelte ni Tauri): se prueba con node --test. Nunca muta lo que recibe: devuelve copias.
//
// Modelo de datos (compatible con lo que ya hay guardado):
// - El orden manual de los hosts ES el orden del array `hosts` (dentro de cada carpeta se respeta ese orden). Los hosts antiguos
//   conservan así el orden que tienen hoy y la copia total / el export lo llevan sin cambiar el formato.
// - El orden de las carpetas va aparte (`folders`, ajuste interno). Las carpetas que no estén en esa lista (todas, con datos
//   antiguos) van detrás en orden alfabético: con la lista vacía se ve exactamente lo de antes. «Sin carpeta» va siempre al final.
// - Una carpeta de la lista sin hosts se sigue enseñando (la creó «Nueva carpeta» o se vació al arrastrar) hasta que se borre.
import type { Host } from './model.ts';

/** Orden de la lista: el guardado (arrastrando) o por nombre. No hay «último uso»: no se guarda ese dato de los hosts. */
export type HostsSort = 'manual' | 'name';
export const HOSTS_SORTS: readonly HostsSort[] = ['manual', 'name'];

/** Clave de «sin carpeta». */
export const UNGROUPED = '';

/** Topes de las listas guardadas en ajustes (nombres de carpeta). */
export const MAX_FOLDERS = 200;
export const MAX_FOLDER_NAME = 100;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** Compara sin distinguir mayúsculas ni acentos («Álamo» = «alamo»), con números naturales («web2» < «web10»). */
export const compareNames = (a: string, b: string): number => collator.compare(a, b);

/** Carpeta de un host ('' = sin carpeta). */
export const folderOf = (h: Pick<Host, 'group'>): string => h.group?.trim() || UNGROUPED;
/** Lo que se lee en la fila. */
export const hostTitle = (h: Pick<Host, 'name' | 'host'>): string => h.name || h.host;

/** Limpia una lista de nombres de carpeta leída de los ajustes: solo textos, sin espacios sobrantes, sin vacíos ni repetidos. */
export function cleanFolderList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = x.trim().slice(0, MAX_FOLDER_NAME);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_FOLDERS) break;
  }
  return out;
}

/** Orden completo de las carpetas con nombre: las guardadas primero (en su orden) y luego las de los hosts que falten, A-Z. */
export function folderOrder(hosts: readonly Host[], saved: readonly string[]): string[] {
  const out = cleanFolderList(saved);
  const extra = [...new Set(hosts.map(folderOf))].filter((g) => g !== UNGROUPED && !out.includes(g)).sort(compareNames);
  return [...out, ...extra];
}

/** Filtro de texto de la barra (ya en minúsculas): nombre, destino, usuario, carpeta o etiquetas. */
export function hostMatches(h: Host, q: string): boolean {
  if (!q) return true;
  return [h.name, h.host, h.user, h.group, ...h.tags].some((x) => x?.toLowerCase().includes(q));
}

export interface FolderView {
  /** '' = sin carpeta. */
  name: string;
  /** Hosts visibles, ya en el orden de la vista. */
  hosts: Host[];
  /** Cuántos hosts tiene la carpeta (sin filtro). */
  total: number;
  /** Plegada (con filtro de texto nunca: se ven los resultados). */
  collapsed: boolean;
}

export interface HostViewOpts {
  sort: HostsSort;
  /** Orden guardado de carpetas (ajuste `hostFolders`). */
  folders: readonly string[];
  /** Carpetas plegadas (ajuste `hostFoldersCollapsed`). */
  collapsed: readonly string[];
  /** Texto del filtro, ya recortado y en minúsculas. */
  text?: string;
}

/** Ordena una COPIA por nombre visible; los empates conservan el orden guardado. */
export function sortHosts(list: readonly Host[], sort: HostsSort): Host[] {
  const out = [...list];
  if (sort === 'manual') return out;
  const idx = new Map(list.map((h, i) => [h, i] as const));
  return out.sort((a, b) => compareNames(hostTitle(a), hostTitle(b)) || idx.get(a)! - idx.get(b)!);
}

/** Carpetas a pintar, en orden. Sin texto: todas las carpetas con nombre (también vacías) y «sin carpeta» si tiene hosts.
 *  Con texto: solo las carpetas con algún resultado, desplegadas. */
export function buildHostView(hosts: readonly Host[], o: HostViewOpts): FolderView[] {
  const q = o.text ?? '';
  const named = folderOrder(hosts, o.folders);
  const order = o.sort === 'name' ? [...named].sort(compareNames) : named;
  const out: FolderView[] = [];
  for (const name of [...order, UNGROUPED]) {
    const all = hosts.filter((h) => folderOf(h) === name);
    const shown = all.filter((h) => hostMatches(h, q));
    if (q ? !shown.length : name === UNGROUPED && !all.length) continue;
    out.push({ name, hosts: sortHosts(shown, o.sort), total: all.length, collapsed: !q && name !== UNGROUPED && o.collapsed.includes(name) });
  }
  return out;
}

const withFolder = (h: Host, folder: string): Host => {
  const c = { ...h };
  if (folder) c.group = folder; else delete c.group;
  return c;
};

/** Congela la vista actual como orden manual: hosts en el orden que se ven (carpeta a carpeta) y la lista de carpetas tal como se
 *  ve. Con orden manual no cambia nada visible; con A-Z deja guardado ese A-Z (para pasar a Manual sin que nada salte). */
export function freezeOrder(hosts: readonly Host[], folders: readonly string[], sort: HostsSort): { hosts: Host[]; folders: string[] } {
  const named = folderOrder(hosts, folders);
  const order = sort === 'name' ? [...named].sort(compareNames) : named;
  const out: Host[] = [];
  for (const name of [...order, UNGROUPED]) out.push(...sortHosts(hosts.filter((h) => folderOf(h) === name), sort));
  return { hosts: out, folders: order };
}

/** Mueve un host a `folder`, justo antes de `beforeId` (que debe estar en esa carpeta) o al final de la carpeta si es null.
 *  Cambia su carpeta si hace falta. Ids desconocidos: devuelve una copia sin cambios. */
export function moveHost(hosts: readonly Host[], id: string, folder: string, beforeId: string | null): Host[] {
  const from = hosts.findIndex((h) => h.id === id);
  if (from < 0 || id === beforeId) return [...hosts];
  const moved = withFolder(hosts[from], folder.trim());
  const rest = hosts.filter((h) => h.id !== id);
  let at = beforeId ? rest.findIndex((h) => h.id === beforeId && folderOf(h) === folderOf(moved)) : -1;
  if (at < 0) {
    // al final de la carpeta: detrás de su último host (o al final de todo si está vacía)
    let last = -1;
    rest.forEach((h, i) => { if (folderOf(h) === folderOf(moved)) last = i; });
    at = last >= 0 ? last + 1 : rest.length;
  }
  rest.splice(at, 0, moved);
  return rest;
}

/** Alt+↑ / Alt+↓ (o «Subir» / «Bajar»): un puesto arriba o abajo dentro de su carpeta. En el borde salta a la carpeta
 *  vecina (al final de la anterior o al principio de la siguiente). Trabaja sobre el orden manual. */
export function stepHost(hosts: readonly Host[], folders: readonly string[], id: string, dir: -1 | 1): Host[] {
  const h = hosts.find((x) => x.id === id);
  if (!h) return [...hosts];
  const f = folderOf(h);
  const mates = hosts.filter((x) => folderOf(x) === f);
  const i = mates.indexOf(h);
  if (dir < 0 && i > 0) return moveHost(hosts, id, f, mates[i - 1].id);
  if (dir > 0 && i < mates.length - 1) return moveHost(hosts, id, f, mates[i + 2]?.id ?? null);
  const order = [...folderOrder(hosts, folders), UNGROUPED];
  const fi = order.indexOf(f);
  const target = order[fi + dir];
  if (target === undefined) return [...hosts];
  if (dir < 0) return moveHost(hosts, id, target, null);
  const first = hosts.find((x) => folderOf(x) === target && x.id !== id);
  return moveHost(hosts, id, target, first?.id ?? null);
}

/** ¿Se puede mover un puesto en esa dirección? (para desactivar «Subir» / «Bajar» en el menú). */
export function canStepHost(hosts: readonly Host[], folders: readonly string[], id: string, dir: -1 | 1): boolean {
  const next = stepHost(hosts, folders, id, dir);
  return next.some((h, i) => h.id !== hosts[i]?.id || folderOf(h) !== folderOf(hosts[i]));
}

/** Mueve una carpeta antes de `before` (o al final si es null). Devuelve el orden completo de carpetas con nombre. */
export function moveFolder(hosts: readonly Host[], folders: readonly string[], name: string, before: string | null): string[] {
  const order = folderOrder(hosts, folders);
  if (!order.includes(name) || name === before) return order;
  const rest = order.filter((g) => g !== name);
  const at = before ? rest.indexOf(before) : -1;
  rest.splice(at < 0 ? rest.length : at, 0, name);
  return rest;
}

/** Una carpeta un puesto arriba o abajo. */
export function stepFolder(hosts: readonly Host[], folders: readonly string[], name: string, dir: -1 | 1): string[] {
  const order = folderOrder(hosts, folders);
  const i = order.indexOf(name);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return order;
  [order[i], order[j]] = [order[j], order[i]];
  return order;
}

/** Nombre libre para una carpeta nueva: «base», «base 2», «base 3»… (sin distinguir mayúsculas ni acentos). */
export function freeFolderName(hosts: readonly Host[], folders: readonly string[], base: string): string {
  const taken = folderOrder(hosts, folders);
  const used = (n: string) => taken.some((g) => compareNames(g, n) === 0);
  if (!used(base)) return base;
  for (let i = 2; ; i++) if (!used(`${base} ${i}`)) return `${base} ${i}`;
}

/** Añade una carpeta vacía al final. */
export function addFolder(hosts: readonly Host[], folders: readonly string[], name: string): string[] {
  const order = folderOrder(hosts, folders);
  const n = name.trim().slice(0, MAX_FOLDER_NAME);
  return n && !order.includes(n) ? [...order, n] : order;
}

export interface FolderState { hosts: Host[]; folders: string[]; collapsed: string[] }

/** Renombra una carpeta (sus hosts cambian de `group`). Si el nombre nuevo ya existe, se juntan en esa (en su sitio).
 *  Nombre vacío o igual: sin cambios. */
export function renameFolder(hosts: readonly Host[], folders: readonly string[], collapsed: readonly string[], from: string, to: string): FolderState {
  const order = folderOrder(hosts, folders);
  const n = to.trim().slice(0, MAX_FOLDER_NAME);
  if (!from || !n || n === from || !order.includes(from)) return { hosts: [...hosts], folders: order, collapsed: [...collapsed] };
  const merge = order.includes(n);
  return {
    hosts: hosts.map((h) => (folderOf(h) === from ? withFolder(h, n) : h)),
    folders: merge ? order.filter((g) => g !== from) : order.map((g) => (g === from ? n : g)),
    collapsed: merge ? collapsed.filter((g) => g !== from) : collapsed.map((g) => (g === from ? n : g)),
  };
}

/** Borra una carpeta: sus hosts pasan a «sin carpeta» (nunca se borran) y conservan su orden relativo. */
export function deleteFolder(hosts: readonly Host[], folders: readonly string[], collapsed: readonly string[], name: string): FolderState {
  return {
    hosts: hosts.map((h) => (name && folderOf(h) === name ? withFolder(h, UNGROUPED) : h)),
    folders: folderOrder(hosts, folders).filter((g) => g !== name),
    collapsed: collapsed.filter((g) => g !== name),
  };
}

/** Pliega o despliega una carpeta. */
export function toggleCollapsed(collapsed: readonly string[], name: string): string[] {
  return collapsed.includes(name) ? collapsed.filter((g) => g !== name) : [...collapsed, name];
}
