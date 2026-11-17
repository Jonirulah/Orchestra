// Variables de entorno propias de los terminales de agente (Ajustes → Agentes y cada cuenta). Módulo puro: se prueba con `node --test`.
//
// Se calculan AL LANZAR el proceso (terminals.ts → hook `spawnEnv`), nunca se guardan en `pane.spec.env`: así un panel restaurado o
// reiniciado toma los ajustes de ese momento (quitar una variable la quita también de los paneles guardados).
// Orden: global < cuenta < las que pone Orchestra en el spec (CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_*, ORCHESTRA_ACCOUNT), que además son
// reservadas: una fila propia con ese nombre se avisa y no se aplica.

export interface EnvRow { key: string; value: string }

export type EnvIssue = 'invalid' | 'duplicate' | 'reserved';

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Las que pone Orchestra para aislar cada cuenta: no se dejan pisar. */
export const RESERVED_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'ORCHESTRA_ACCOUNT'] as const;
/** El atajo de Ajustes: «Modo código experimental de Claude Code». */
export const CODE_MODE_ENV = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE';

export const ENV_LIMITS = { rows: 64, key: 128, value: 8192 } as const;

const isReserved = (k: string) => (RESERVED_ENV as readonly string[]).includes(k.toUpperCase());
/** Windows no distingue mayúsculas en los nombres de variable: `Foo` y `FOO` son la misma. */
const norm = (k: string) => k.trim().toUpperCase();

/** Lo guardado → filas válidas como datos (cadenas, sin control, con tope). Las filas a medio escribir se conservan. */
export function cleanEnvRows(raw: unknown): EnvRow[] {
  if (!Array.isArray(raw)) return [];
  const out: EnvRow[] = [];
  for (const r of raw) {
    if (out.length >= ENV_LIMITS.rows) break;
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.key !== 'string' || typeof o.value !== 'string') continue;
    out.push({
      key: o.key.replace(/[\u0000-\u001f\u007f=]/g, '').slice(0, ENV_LIMITS.key),
      value: o.value.replace(/\u0000/g, '').slice(0, ENV_LIMITS.value),
    });
  }
  return out;
}

/** Problema de cada fila (null = se aplica). Una fila vacía (sin nombre ni valor) no es problema: se ignora. */
export function envIssues(rows: readonly EnvRow[]): (EnvIssue | null)[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    const k = r.key.trim();
    if (!k) return r.value ? 'invalid' : null;
    if (!ENV_NAME.test(k)) return 'invalid';
    if (isReserved(k)) return 'reserved';
    if (seen.has(norm(k))) return 'duplicate';
    seen.add(norm(k));
    return null;
  });
}

/** Las filas que de verdad se aplican, como mapa. */
export function envMap(rows: readonly EnvRow[] | undefined): Record<string, string> {
  if (!rows?.length) return {};
  const iss = envIssues(rows);
  const out: Record<string, string> = {};
  rows.forEach((r, i) => { if (!iss[i] && r.key.trim()) out[r.key.trim()] = r.value; });
  return out;
}

/** Une dos mapas con el criterio de Windows (sin distinguir mayúsculas): gana `top`. */
function overlay(base: Record<string, string>, top: Record<string, string>): Record<string, string> {
  const out = { ...base };
  for (const [k, v] of Object.entries(top)) {
    for (const b of Object.keys(out)) if (b !== k && norm(b) === norm(k)) delete out[b];
    out[k] = v;
  }
  return out;
}

export interface EnvPane { kind: string; ref?: string; spec: { env?: Record<string, string> } }
export interface EnvAccount { id: string; env?: EnvRow[] }

/** Cuenta del panel: la que dice el spec (ORCHESTRA_ACCOUNT) o su referencia. */
function accountOf(p: EnvPane, accounts: readonly EnvAccount[]): EnvAccount | undefined {
  const id = p.spec.env?.ORCHESTRA_ACCOUNT ?? p.ref;
  return id ? accounts.find((a) => a.id === id) : undefined;
}

/** Variables propias de un panel: solo los de agente (Claude, Codex, opencode, inicios de sesión MCP). */
export function customEnvFor(p: EnvPane, global: readonly EnvRow[], accounts: readonly EnvAccount[]): Record<string, string> {
  if (p.kind !== 'agent') return {};
  return overlay(envMap(global), envMap(accountOf(p, accounts)?.env));
}

/** Entorno con el que se lanza el proceso: las propias por debajo de las del spec. undefined = sin entorno extra. */
export function spawnEnv(p: EnvPane, global: readonly EnvRow[], accounts: readonly EnvAccount[]): Record<string, string> | undefined {
  const env = overlay(customEnvFor(p, global, accounts), p.spec.env ?? {});
  return Object.keys(env).length ? env : undefined;
}

// ---------- atajo del modo código ----------

export const codeModeOn = (rows: readonly EnvRow[]): boolean => envMap(rows)[CODE_MODE_ENV] === '1';

/** Enciende (fila `=1`, reutilizando la que haya) o apaga (quita todas las filas con ese nombre). Devuelve una lista nueva. */
export function setCodeMode(rows: readonly EnvRow[], on: boolean): EnvRow[] {
  const is = (r: EnvRow) => norm(r.key) === CODE_MODE_ENV;
  if (!on) return rows.filter((r) => !is(r)).map((r) => ({ ...r }));
  let done = false;
  const out: EnvRow[] = [];
  for (const r of rows) {
    if (!is(r)) { out.push({ ...r }); continue; }
    if (!done) { out.push({ key: CODE_MODE_ENV, value: '1' }); done = true; }
  }
  if (!done) out.push({ key: CODE_MODE_ENV, value: '1' });
  return out;
}

// ---------- copia de seguridad ----------

/** Nombres que suenan a secreto: esas filas no salen en una copia (mismo criterio que backup.ts, más «…KEY» de las API). */
const SECRET_ENV = /pass(word|phrase)|secret|token|credential|api_?key|(^|_)key$/i;
export const isSecretEnv = (k: string): boolean => SECRET_ENV.test(k);

/** Filas que viajan en una copia: sin las de nombre secreto y sin las vacías. */
export function exportableEnv(rows: readonly EnvRow[] | undefined): EnvRow[] {
  return (rows ?? []).filter((r) => r.key.trim() && !isSecretEnv(r.key)).map((r) => ({ key: r.key, value: r.value }));
}
