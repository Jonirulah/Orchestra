// «Qué agente te espera»: a cuál saltar con Ctrl+Shift+A, qué filas enseña el bloque «Necesitan atención» y cuántos
// esperan en cada pestaña. Módulo puro (sin Svelte ni Tauri): se prueba con node --test.

export interface WsLike { id: string; panes: { id: string; parked?: boolean }[] }

/** Paneles en el orden en que se recorren: pestaña a pestaña, y dentro de cada una en su orden. */
export function paneOrder(workspaces: WsLike[]): { paneId: string; wsId: string }[] {
  return workspaces.flatMap((w) => w.panes.map((p) => ({ paneId: p.id, wsId: w.id })));
}

/**
 * Siguiente agente en espera a partir del panel con foco, rotando: el primero que espera DESPUÉS del actual en el orden
 * global (pestañas incluidas) y, al llegar al final, vuelta al principio. Si el actual es el único que espera, él mismo.
 * null = ninguno espera.
 */
export function nextWaiting(order: { paneId: string }[], waiting: ReadonlySet<string>, current: string | undefined): string | null {
  const ids = order.map((o) => o.paneId).filter((id) => waiting.has(id));
  if (!ids.length) return null;
  const pos = current === undefined ? -1 : order.findIndex((o) => o.paneId === current);
  if (pos < 0) return ids[0];
  for (let k = 1; k <= order.length; k++) {
    const id = order[(pos + k) % order.length].paneId;
    if (waiting.has(id)) return id;
  }
  return ids[0];
}

/** Cuántos agentes esperan dentro de cada pestaña (solo las que tienen alguno). */
export function waitingPerWs(workspaces: WsLike[], waiting: ReadonlySet<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of workspaces) {
    const n = w.panes.filter((p) => waiting.has(p.id)).length;
    if (n) out[w.id] = n;
  }
  return out;
}

export interface WaitRow { paneId: string; title: string; asks: string; sinceSec: number }

/** Filas del bloque «Necesitan atención»: el que más lleva esperando, primero. */
export function waitRows(
  agents: { paneId: string; status: string; title?: string; name?: string; waitingFor?: string }[],
  since: Readonly<Record<string, number>>,
  nowMs: number,
  paneTitle: (id: string) => string | undefined,
): WaitRow[] {
  return agents
    .filter((a) => a.status === 'waiting' && paneTitle(a.paneId) !== undefined)
    .map((a) => ({
      paneId: a.paneId,
      title: paneTitle(a.paneId) || a.title || a.name || '',
      asks: (a.waitingFor ?? '').trim(),
      sinceSec: Math.max(0, Math.floor((nowMs - (since[a.paneId] ?? nowMs)) / 1000)),
    }))
    .sort((x, y) => y.sinceSec - x.sinceSec || x.title.localeCompare(y.title));
}

/** «Desde hace cuánto», compacto: «45 s», «3 min», «2 h»; vacío si acaba de empezar (menos de 5 s). */
export function fmtSince(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 5) return '';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

/**
 * Actualiza «desde cuándo espera» con un escaneo nuevo: conserva el instante de los que ya esperaban, apunta `now` para
 * los que acaban de empezar y olvida a los que ya no esperan. Devuelve el mapa nuevo y los que han empezado a esperar.
 */
export function trackWaiting(prev: Readonly<Record<string, number>>, waitingNow: string[], now: number): { since: Record<string, number>; started: string[] } {
  const since: Record<string, number> = {};
  const started: string[] = [];
  for (const id of waitingNow) {
    if (prev[id] !== undefined) since[id] = prev[id];
    else { since[id] = now; started.push(id); }
  }
  return { since, started };
}

/** ¿Hay que llamar la atención fuera de la ventana? Solo si la ventana no está delante. */
export function alertPlan(focused: boolean, notifySetting: boolean): { flash: boolean; notify: boolean } {
  return { flash: !focused, notify: !focused && notifySetting };
}
