// Visor de solo lectura de un subagente: reductor puro que junta los eventos que llegan del backend + ayudas de formato.
// Todo lo que viene del transcript se trata como TEXTO (nunca HTML ni markdown); aquí no se interpreta nada.
import type { SubChunk, SubEvent } from './backend.ts';

export const MAX_EVENTS = 500;
export const RESULT_PREVIEW = 400;

export interface Row extends SubEvent { key: number }
export interface SubState {
  rows: Row[];
  /** Desplazamiento en bytes que se devolvió en la última respuesta (null = aún no se ha cargado nada). */
  offset: number | null;
  done: boolean;
  /** Eventos antiguos descartados por el tope de memoria. */
  dropped: number;
  seq: number;
}

export const emptyState = (): SubState => ({ rows: [], offset: null, done: false, dropped: 0, seq: 0 });

/** Junta una respuesta: añade al final (máx. `max` en memoria). Si el desplazamiento retrocede (el fichero se rehízo), empieza de cero. */
export function mergeChunk(st: SubState, chunk: SubChunk, max = MAX_EVENTS): SubState {
  const reset = st.offset != null && chunk.nextOffset < st.offset;
  let rows = reset ? [] : st.rows;
  let seq = reset ? 0 : st.seq;
  let dropped = reset ? 0 : st.dropped;
  if (chunk.events.length) {
    rows = rows.concat(chunk.events.map((e) => ({ ...e, key: seq++ })));
    if (rows.length > max) { dropped += rows.length - max; rows = rows.slice(rows.length - max); }
  }
  return { rows, offset: chunk.nextOffset, done: chunk.done, dropped, seq };
}

export interface Item {
  key: number;
  kind: 'prompt' | 'text' | 'tool' | 'result';
  text: string;
  tool?: string;
  summary?: string;
  ts?: string;
  /** Resultado emparejado con la llamada (solo en `tool`). */
  result?: { text: string; error: boolean };
}

/** Empareja cada resultado con su llamada (por id). Un resultado huérfano (su llamada ya se descartó) sale suelto. */
export function buildItems(rows: Row[]): Item[] {
  const byId = new Map<string, Item>();
  const out: Item[] = [];
  for (const r of rows) {
    if (r.kind === 'tool') {
      const it: Item = { key: r.key, kind: 'tool', text: '', tool: r.tool ?? '', summary: r.summary ?? '', ts: r.ts ?? undefined };
      if (r.id) byId.set(r.id, it);
      out.push(it);
    } else if (r.kind === 'result') {
      const call = r.id ? byId.get(r.id) : undefined;
      if (call && !call.result) call.result = { text: r.text, error: r.error };
      else out.push({ key: r.key, kind: 'result', text: r.text, ts: r.ts ?? undefined, result: { text: r.text, error: r.error } });
    } else {
      out.push({ key: r.key, kind: r.kind, text: r.text, ts: r.ts ?? undefined });
    }
  }
  return out;
}

/** Primeros `n` caracteres de un resultado (colapsado) y si hay más. */
export function preview(text: string, n = RESULT_PREVIEW): { head: string; more: boolean } {
  const chars = Array.from(text);
  return chars.length > n ? { head: chars.slice(0, n).join(''), more: true } : { head: text, more: false };
}

/** Hora local HH:MM:SS de una fecha ISO ('' si no es válida). */
export function fmtTime(ts?: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** ¿Está el scroll pegado al final (con un margen)? Si no, el usuario subió y no se le arrastra. */
export function atBottom(scrollTop: number, clientHeight: number, scrollHeight: number, slack = 24): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= slack;
}

/** Cuánto esperar entre consultas: nada si el visor está cerrado o la ventana oculta; más lento cuando el subagente ya acabó. */
export function pollDelay(open: boolean, visible: boolean, done: boolean): number | null {
  if (!open || !visible) return null;
  return done ? 5000 : 1500;
}
