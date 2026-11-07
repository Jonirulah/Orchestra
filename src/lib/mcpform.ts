// Formulario y vista previa del gestor de MCP (añadir / aplicar a / quitar de / igualar). Módulo puro.
// La interfaz nunca recibe valores secretos de las cuentas: el formulario solo lleva lo que escribe o pega el usuario,
// y «Aplicar a…» / «Igualar a esta» mandan a Rust una referencia a la cuenta origen.
import type { McpAccount, McpChange, McpDef, McpDefInput, McpPlanStep, McpStepResult } from './backend.ts';
import type { McpDraft, McpKv } from './mcppaste.ts';
import type { McpRow, McpRowLike } from './mcpmatrix.ts';
import { isActive } from './mcpmatrix.ts';

export interface McpForm {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string;
  /** Un argumento por línea (sin comillas: lo que hay en la línea es el argumento). */
  argsText: string;
  url: string;
  env: McpKv[];
  headers: McpKv[];
  bearerEnvVar: string;
  /** Ámbito (Claude): `user` en toda la cuenta; `local` y `project` en una carpeta (`project`). Codex y opencode: solo global. */
  scope: 'user' | 'local' | 'project';
  project: string;
}

export function emptyForm(): McpForm {
  return { name: '', transport: 'stdio', command: '', argsText: '', url: '', env: [], headers: [], bearerEnvVar: '', scope: 'user', project: '' };
}

export function formFromDraft(d: McpDraft): McpForm {
  return {
    name: d.name, transport: d.transport, command: d.command, argsText: d.args.join('\n'), url: d.url,
    env: d.env.map((x) => ({ ...x })), headers: d.headers.map((x) => ({ ...x })), bearerEnvVar: d.bearerEnvVar,
    scope: 'user', project: '',
  };
}

export const formArgs = (f: McpForm) => f.argsText.split(/\r?\n/).filter((l) => l.trim() !== '');

/** Claves i18n `settings.mcp.servers.form.err.*` de lo que falta o está mal. Vacío = se puede pedir la vista previa. */
export type McpFormError = 'name' | 'command' | 'url' | 'envKey' | 'headerKey' | 'bearer' | 'project' | 'targets' | 'placeholder';

/** ¿Es el marcador de ejemplo de un README y no un valor de verdad? (YOUR_KEY, <token>, xxx…, sk-..., changeme…)
 *  Las referencias a variables (`${TOKEN}`, `{env:TOKEN}`) NO lo son: las resuelve la herramienta. */
export function isReadmePlaceholder(value: string): boolean {
  const v = value.trim();
  if (!v || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$|^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(v)) return false;
  return [
    /^<[^<>]+>$/, // <token>, <your-api-key>
    /^\[[^\]]+\]$/, // [API_KEY]
    /^\{\{[^}]+\}\}$/, // {{TOKEN}}
    /(^|[^A-Za-z])(your|my)[-_ ]?[a-z0-9_-]*(key|token|secret|password|pass|pat|id)\b/i, // YOUR_KEY, your-api-key, my_token
    /^(x{3,}|\*{3,}|\.{3}|…|-+)$/i, // xxx, ***, ...
    /^[a-z]{2,4}[-_](x{3,}|\.{3}|…)/i, // sk-xxxx, ghp_..., pk_…
    /^(changeme|change[-_]me|replace[-_]?me|placeholder|todo|tbd|insert[-_ ].*|paste[-_ ].*|(api[-_]?)?(key|token)[-_]?here|here)$/i,
  ].some((r) => r.test(v));
}
/** Valores del formulario que son el marcador del README (env, cabeceras, argumentos y la query de la URL). */
export function placeholderFields(f: McpForm): { env: number[]; headers: number[]; args: boolean; url: boolean } {
  const env = f.env.flatMap((e, i) => (isReadmePlaceholder(e.value) ? [i] : []));
  const headers = f.headers.flatMap((h, i) => (isReadmePlaceholder(h.value.replace(/^Bearer\s+/i, '')) ? [i] : []));
  const args = f.transport === 'stdio' && formArgs(f).some((a) => isReadmePlaceholder(a) || isReadmePlaceholder(a.replace(/^--?[A-Za-z0-9-]+=/, '')));
  const url = f.transport !== 'stdio' && (f.url.split('?')[1] ?? '').split('&').some((p) => isReadmePlaceholder(decodeURIComponent(p.split('=')[1] ?? '')));
  return { env, headers, args, url };
}
export function validateForm(f: McpForm, targets: string[]): McpFormError[] {
  const out: McpFormError[] = [];
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(f.name.trim())) out.push('name');
  if (f.transport === 'stdio') {
    if (!f.command.trim()) out.push('command');
    if (f.env.some((e) => (e.key.trim() || e.value) && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key.trim()))) out.push('envKey');
  } else {
    if (!/^https?:\/\/\S+$/i.test(f.url.trim())) out.push('url');
    if (f.headers.some((h) => (h.key.trim() || h.value) && !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(h.key.trim()))) out.push('headerKey');
    if (f.bearerEnvVar.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.bearerEnvVar.trim())) out.push('bearer');
  }
  if (f.scope !== 'user' && !f.project.trim()) out.push('project');
  if (!targets.length) out.push('targets');
  const ph = placeholderFields(f);
  if (ph.env.length || ph.headers.length || ph.args || ph.url) out.push('placeholder');
  return out;
}

/** Errores que se enseñan: ninguno al abrir; el de un campo cuando el usuario sale de él (`touched`); todos al pulsar
 *  «Vista previa» (`tried`). Un formulario recién abierto nunca nace en rojo. */
export function shownErrors(errors: McpFormError[], touched: Partial<Record<McpFormError, boolean>>, tried: boolean): McpFormError[] {
  return tried ? [...errors] : errors.filter((e) => touched[e]);
}

/** Formulario → lo que espera Rust. Las filas vacías se descartan; lo que no aplica al transporte, también. */
export function formToDef(f: McpForm): McpDefInput {
  const rows = (v: McpKv[]) => v.filter((x) => x.key.trim()).map((x) => ({ key: x.key.trim(), value: x.value }));
  const stdio = f.transport === 'stdio';
  return {
    name: f.name.trim(),
    transport: f.transport,
    command: stdio ? f.command.trim() : null,
    args: stdio ? formArgs(f) : [],
    url: stdio ? null : f.url.trim(),
    env: stdio ? rows(f.env) : [],
    headers: stdio ? [] : rows(f.headers),
    bearerEnvVar: stdio || !f.bearerEnvVar.trim() ? null : f.bearerEnvVar.trim(),
    scope: f.scope,
    projectPath: f.scope === 'user' ? null : f.project.trim(),
  };
}

/** Cuentas en las que Orchestra puede escribir (todas las que se listan: Claude/Codex por cuenta, opencode global). */
export const writableAccounts = (accounts: McpAccount[]) => accounts.filter((a) => !a.error || a.provider !== 'codex');

/** Ámbitos que Orchestra edita: user (Claude/Codex) y global (opencode). */
export const editableScope = (d: McpDef) => d.scope === 'user' || d.scope === 'global';

/** Origen de una fila para copiarla: la primera cuenta que la tiene en un ámbito editable (o cualquiera no gestionada). */
export function rowSource(row: McpRowLike, accounts: McpAccount[]): { accountId: string; def: McpDef } | null {
  for (const editable of [true, false]) {
    for (const a of accounts) {
      const d = row.cells[a.id]?.find((x) => !x.managedBy && (!editable || editableScope(x)));
      if (d) return { accountId: a.id, def: d };
    }
  }
  return null;
}

/** «Aplicar a…»: cuentas que aún no tienen este nombre en su ámbito editable. */
export function copyTargets(row: McpRowLike, rows: McpRow[], accounts: McpAccount[]): string[] {
  return accounts.filter((a) => !rows.some((r) => r.name === row.name && r.cells[a.id]?.some(editableScope))).map((a) => a.id);
}

/** «Quitar de…»: cuentas que tienen esta variante en un ámbito editable. */
export function removeTargets(row: McpRowLike, accounts: McpAccount[]): string[] {
  return accounts.filter((a) => row.cells[a.id]?.some(editableScope)).map((a) => a.id);
}

/** «Igualar las demás a esta variante»: cuentas con el mismo nombre pero otra variante (en ámbito editable). */
export function equalizeTargets(row: McpRowLike, rows: McpRow[], accounts: McpAccount[]): string[] {
  return accounts
    .filter((a) => !row.cells[a.id]?.some(editableScope) && rows.some((r) => r.name === row.name && r.cells[a.id]?.some(editableScope)))
    .map((a) => a.id);
}

export function copyChange(row: McpRowLike, accounts: McpAccount[], targets: string[], replace: boolean): McpChange | null {
  const src = rowSource(row, accounts);
  if (!src) return null;
  return { kind: 'copy', from: { accountId: src.accountId, scope: src.def.scope, name: src.def.name, projectPath: src.def.projectPath }, targets, replace };
}

export interface PlanSummary { apply: number; skip: number; blocked: number }
export function planSummary(steps: McpPlanStep[]): PlanSummary {
  const s = { apply: 0, skip: 0, blocked: 0 };
  for (const x of steps) {
    if (x.blocked) s.blocked++;
    else if (x.action === 'skip') s.skip++;
    else s.apply++;
  }
  return s;
}
/** Solo se puede aplicar si hay algo que hacer. Las cuentas bloqueadas se saltan (no se aplica nada a medias en ellas). */
export const canApply = (steps: McpPlanStep[]) => planSummary(steps).apply > 0;

/** Resumen del resultado: cuántas cuentas quedaron bien y cuáles fallaron. */
export function resultSummary(results: McpStepResult[]): { ok: number; failed: number; skipped: number } {
  return {
    ok: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };
}

/** Tras aplicar y volver a listar: ¿aparece (o ya no) el MCP en cada cuenta tocada? */
export function relistCheck(change: McpChange, results: McpStepResult[], accounts: McpAccount[]): Record<string, boolean> {
  const name = change.kind === 'add' ? change.def.name.trim() : change.kind === 'copy' ? change.from.name : change.name;
  const out: Record<string, boolean> = {};
  for (const r of results) {
    if (r.status !== 'ok') continue;
    const a = accounts.find((x) => x.id === r.accountId);
    const present = !!a?.servers.some((d) => d.name === name && editableScope(d));
    out[r.accountId] = change.kind === 'remove' ? !present : present;
  }
  return out;
}

// ---------- vista previa fiel: una línea por cuenta, también las que no cambian ----------

/** Qué le pasa a cada cuenta: sin cambios / sustituye X → Y / añade / quita (ámbito, fichero) / no se puede / se salta. */
export type PreviewKind = 'same' | 'replace' | 'add' | 'remove' | 'blocked' | 'skip';
export interface PreviewEntry {
  accountId: string;
  kind: PreviewKind;
  /** `replace`: letras de las versiones que se van (vacío si la fila no tiene versiones). */
  from: string[];
  /** Versión que queda (letra) o null si la fila no tiene versiones. */
  to: string | null;
  /** Ámbito que se toca (o el que ya tiene la versión, en `same`). */
  scope: McpDef['scope'] | null;
  file: string;
  /** Mismo nombre en otros ámbitos (local / proyecto) de esa cuenta: no se tocan y se quedan. */
  keeps: McpDef[];
  /** `blocked` / `skip`: el motivo de Rust (sin traducir). */
  reason: string | null;
  lines: string[];
  /** La cuenta no estaba en la petición: se lista para que se vea que no cambia. */
  untouched: boolean;
}

const nameOf = (c: McpChange) => (c.kind === 'add' ? c.def.name.trim() : c.kind === 'copy' ? c.from.name : c.name);
const letterOf = (rows: McpRow[], name: string, fp: string | null): string | null => {
  const r = rows.find((x) => x.name === name);
  if (!r || r.variants.length < 2 || !fp) return null;
  return r.variants.find((v) => v.fingerprint === fp)?.letter ?? null;
};

/** Vista previa de un cambio: los pasos de Rust traducidos a una entrada por cuenta. En «Igualar» (copy + replace) se
 *  añaden las cuentas que YA tienen esa versión como «sin cambios», para que la vista previa cuadre con la tabla. */
export function previewEntries(change: McpChange, steps: McpPlanStep[], accounts: McpAccount[], rows: McpRow[], variant?: McpRowLike): PreviewEntry[] {
  const name = nameOf(change);
  const fp = variant?.def.fingerprint ?? null;
  const to = change.kind === 'remove' ? null : letterOf(rows, name, fp);
  const defsIn = (id: string) => accounts.find((a) => a.id === id)?.servers.filter((d) => d.name === name) ?? [];
  const out: PreviewEntry[] = steps.map((s) => {
    const defs = defsIn(s.accountId);
    const ed = defs.find(editableScope) ?? null;
    const keeps = defs.filter((d) => !editableScope(d));
    const base: PreviewEntry = { accountId: s.accountId, kind: 'add', from: [], to, scope: ed?.scope ?? (s.provider === 'opencode' ? 'global' : 'user'), file: s.file, keeps, reason: null, lines: s.lines, untouched: false };
    if (change.kind === 'add' && change.def.scope && change.def.scope !== 'user') base.scope = change.def.scope;
    if (s.blocked) return { ...base, kind: 'blocked', reason: s.blocked };
    if (s.action === 'skip') return { ...base, kind: /Already there/i.test(s.note ?? '') ? 'same' : 'skip', reason: s.note };
    if (s.action === 'replace') {
      const from = defs.filter(editableScope).map((d) => letterOf(rows, name, d.fingerprint)).filter((l): l is string => !!l && l !== to);
      return { ...base, kind: 'replace', from };
    }
    if (s.action === 'remove') return { ...base, kind: 'remove', to: ed ? letterOf(rows, name, ed.fingerprint) : null };
    return base;
  });
  if (change.kind === 'copy' && change.replace && fp) {
    for (const a of accounts) {
      if (steps.some((s) => s.accountId === a.id)) continue;
      const d = a.servers.find((x) => x.name === name && x.fingerprint === fp && editableScope(x));
      if (d) out.push({ accountId: a.id, kind: 'same', from: [], to, scope: d.scope, file: '', keeps: a.servers.filter((x) => x.name === name && !editableScope(x)), reason: null, lines: [], untouched: true });
    }
  }
  const order = accounts.map((a) => a.id);
  return out.sort((a, b) => order.indexOf(a.accountId) - order.indexOf(b.accountId));
}

/** Una línea de la vista previa partida para enseñarla entera: el JSON (argumento de `add-json` o valor de opencode)
 *  va formateado en varias líneas; el resto, tal cual. */
export function formatPlanLine(line: string): { head: string; json: string | null; tail: string } {
  const quoted = line.match(/^(.*? )'(\{.*\})'( .*)?$/s);
  const assigned = !quoted ? line.match(/^(.*? = )(\{.*\})$/s) : null;
  const m = quoted ?? assigned;
  if (m) {
    try {
      return { head: m[1] + (quoted ? "'" : ''), json: JSON.stringify(JSON.parse(m[2]), null, 2), tail: (quoted ? "'" : '') + (m[3] ?? '') };
    } catch { /* no es JSON: tal cual */ }
  }
  return { head: line, json: null, tail: '' };
}

// ---------- lo que sigue activo tras Quitar / Igualar: copias en el ámbito local o de proyecto ----------

/** Copia del mismo MCP en un ámbito que Orchestra no toca por defecto (local o proyecto) y que gana a la de usuario en
 *  su carpeta: tras el cambio, esa cuenta SEGUIRÁ usando esa versión ahí. */
export interface Linger {
  accountId: string;
  /** Letra de la versión que se queda (null si la fila no tiene versiones). */
  letter: string | null;
  scope: 'local' | 'project';
  path: string;
  /** Se puede incluir en el cambio (`includeLocal`): Claude, ámbito local. El de proyecto es el `.mcp.json` del repositorio. */
  removable: boolean;
}

/** Copias local/proyecto activas que quedarían tras un Quitar (todas las de las cuentas destino) o un Igualar (las de
 *  OTRA versión, en cualquier cuenta con ese MCP). `includeLocal`: las del ámbito local se quitan con el cambio. */
export function lingering(change: McpChange, accounts: McpAccount[], rows: McpRow[], variant?: McpRowLike, includeLocal = false): Linger[] {
  if (change.kind === 'add' || (change.kind === 'copy' && !change.replace)) return [];
  const name = nameOf(change);
  const fp = change.kind === 'copy' ? variant?.def.fingerprint ?? null : null;
  const ids = change.kind === 'remove' ? change.targets : accounts.map((a) => a.id);
  const out: Linger[] = [];
  for (const a of accounts) {
    if (!ids.includes(a.id)) continue;
    for (const d of a.servers) {
      if (d.name !== name || (d.scope !== 'local' && d.scope !== 'project') || !isActive(d)) continue;
      if (fp && d.fingerprint === fp) continue; // ya es la versión elegida
      const removable = a.provider === 'claude' && d.scope === 'local';
      if (includeLocal && removable) continue;
      out.push({ accountId: a.id, letter: letterOf(rows, name, d.fingerprint), scope: d.scope, path: d.projectPath ?? '', removable });
    }
  }
  return out;
}
