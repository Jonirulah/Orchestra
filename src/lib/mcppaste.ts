// «Pegar del README» del gestor de MCP: entiende lo que suelen traer los README de los servidores MCP y lo convierte
// en borradores del formulario. Módulo puro (sin Svelte ni Tauri). Lo que no entiende lo devuelve en `unknown`: no se
// inventa nada. Formas:
//   a) `claude mcp add [--transport http|sse] [-e K=V] [-H "K: V"] [-s …] name [--] cmd args…` / con URL
//      y `claude mcp add-json name '{…}'`
//   b) `codex mcp add name [--env K=V]… [--] cmd args…` / `--url U [--bearer-token-env-var V]`
//   c) JSON `{"mcpServers": {…}}` (Claude Desktop, Cursor), `{"servers": {…}}` / `{"mcp": {"servers": …}}` (VS Code),
//      `{"mcp": {…}}` (opencode), un solo servidor `"name": {…}` o el objeto suelto `{ "command": … }`
//   d) TOML `[mcp_servers.name]` de Codex (con sus subtablas `.env` / `.http_headers`)
//   e) una línea suelta `npx -y paquete` / `uvx paquete` / `docker run …`

export type McpTransport = 'stdio' | 'http' | 'sse';
export interface McpKv { key: string; value: string }
export interface McpDraft {
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  env: McpKv[];
  headers: McpKv[];
  /** Variable con el token (`Authorization: Bearer $VAR`). */
  bearerEnvVar: string;
}
export type PasteSource = 'claude' | 'codex' | 'json' | 'toml' | 'command';
export type PasteWarning =
  /** Ejecuta un paquete de terceros (npx/uvx/bunx/pnpm dlx/docker/pipx) con tu usuario. */
  | { kind: 'thirdParty'; detail: string }
  /** Un valor parece un hueco por rellenar (`YOUR_API_KEY`, `<token>`…). */
  | { kind: 'placeholder'; detail: string }
  /** Opción entendida pero que Orchestra no aplica (p. ej. `--scope project`: Orchestra escribe en user). */
  | { kind: 'ignored'; detail: string };
export interface PasteResult {
  source: PasteSource | null;
  drafts: McpDraft[];
  /** Trozos que no se entendieron (opciones, campos, líneas). Si no hay borradores, todo el texto. */
  unknown: string[];
  warnings: PasteWarning[];
  /** `--scope` del comando pegado (Claude): el formulario lo pone en su selector de ámbito. `null` = no lo dice. */
  scope: PasteScope | null;
}
export type PasteScope = 'user' | 'local' | 'project';
const asScope = (v: string | undefined): PasteScope | null => (v === 'user' || v === 'local' || v === 'project' ? v : null);

export function emptyDraft(): McpDraft {
  return { name: '', transport: 'stdio', command: '', args: [], url: '', env: [], headers: [], bearerEnvVar: '' };
}

// ---------- utilidades ----------

/** Parte una línea como lo haría un shell (comillas simples y dobles, `\` de continuación, `^` y `` ` `` de cmd/PowerShell). */
export function shellSplit(text: string): string[] {
  const s = text
    .replace(/\\\r?\n/g, ' ')
    .replace(/\^\r?\n/g, ' ')
    .replace(/`\r?\n/g, ' ');
  const out: string[] = [];
  let cur = '';
  let has = false;
  let q: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

const PLACEHOLDER = /^<[^>]*>$|^\$\{?[A-Z_]+\}?$|your[_-]|^x{3,}|\.\.\.|replace[_-]?me|^\[.*\]$|^api[_-]?key$|^token$/i;
const isPlaceholder = (v: string) => PLACEHOLDER.test(v.trim()) || /YOUR|<.+>/.test(v);

const RUNNERS = ['npx', 'uvx', 'bunx', 'pipx', 'docker', 'pnpm', 'yarn', 'deno'];
const baseCmd = (c: string) => c.replace(/\\/g, '/').split('/').pop()!.replace(/\.(cmd|exe|bat)$/i, '').toLowerCase();

/** Paquete que se descarga y ejecuta, si el comando es un lanzador (`npx -y pkg` → `pkg`). */
export function runnerPackage(command: string, args: string[]): string | null {
  const c = baseCmd(command);
  if (!RUNNERS.includes(c)) return null;
  let rest = args;
  if (c === 'pnpm' || c === 'yarn') {
    if (rest[0] !== 'dlx') return null;
    rest = rest.slice(1);
  }
  if (c === 'docker') {
    if (rest[0] !== 'run') return null;
    // la imagen: primer argumento que no es opción ni valor de -e/-v/--name…
    for (let i = 1; i < rest.length; i++) {
      const a = rest[i];
      if (/^-(e|v|p|w|-env|-volume|-name|-network|-mount|-user)$/.test(a)) { i++; continue; }
      if (!a.startsWith('-')) return a;
    }
    return null;
  }
  if (c === 'deno') return rest.find((a) => /^(npm|jsr):|^https?:/.test(a)) ?? null;
  if (c === 'pipx' && rest[0] === 'run') rest = rest.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--from' || a === '--package' || a === '-p' || a === '--python' || a === '--with') { i++; continue; }
    if (!a.startsWith('-')) return a;
  }
  return null;
}

/** Nombre corto a partir del paquete: `@modelcontextprotocol/server-github` → `github`, `@playwright/mcp@latest` → `playwright`. */
export function nameFromPackage(pkg: string): string {
  let p = pkg.replace(/^(npm|jsr):/, '');
  p = p.replace(/(.)@[^/]*$/, '$1'); // versión
  const scoped = p.match(/^@([^/]+)\/(.+)$/);
  let n = scoped ? scoped[2] : p.split('/').pop()!.split(':')[0];
  if (scoped && /^(mcp|server|mcp-server)$/.test(n)) n = scoped[1];
  n = n.replace(/^(mcp-server-|server-|mcp-)/, '').replace(/(-mcp-server|-mcp|_mcp|-server)$/, '');
  if (scoped && !n) n = scoped[1];
  if (scoped && scoped[1] === 'modelcontextprotocol' && !n) n = 'mcp';
  return n.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[-.]+/, '').slice(0, 64) || 'mcp';
}

function kvSplit(s: string, sep: '=' | ':'): McpKv | null {
  const i = s.indexOf(sep);
  if (i <= 0) return null;
  return { key: s.slice(0, i).trim(), value: s.slice(i + 1).trim() };
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

/** `Authorization: Bearer ${VAR}` / `Bearer $VAR` / `{env:VAR}` → `VAR`. */
function bearerVarOf(h: McpKv): string | null {
  if (h.key.toLowerCase() !== 'authorization') return null;
  const m = h.value.match(/^Bearer\s+(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\{env:([A-Za-z_][A-Za-z0-9_]*)\})$/i);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

function finish(r: PasteResult): PasteResult {
  for (const d of r.drafts) {
    // Cabecera de token con variable → campo «token en variable» (Codex lo escribe con --bearer-token-env-var).
    const i = d.headers.findIndex((h) => bearerVarOf(h));
    if (i >= 0 && !d.bearerEnvVar) {
      d.bearerEnvVar = bearerVarOf(d.headers[i])!;
      d.headers.splice(i, 1);
    }
    if (d.transport === 'stdio') {
      const pkg = runnerPackage(d.command, d.args);
      if (pkg) r.warnings.push({ kind: 'thirdParty', detail: `${baseCmd(d.command)} ${pkg}` });
      if (!d.name && pkg) d.name = nameFromPackage(pkg);
    }
    for (const kv of [...d.env, ...d.headers]) if (isPlaceholder(kv.value)) r.warnings.push({ kind: 'placeholder', detail: kv.key });
    for (let j = 0; j < d.args.length; j++) {
      const a = d.args[j];
      if (/^<.+>$|YOUR_|your[-_](api|token|key)/i.test(a)) r.warnings.push({ kind: 'placeholder', detail: d.args[j - 1]?.startsWith('-') ? d.args[j - 1] : a });
    }
  }
  return r;
}

// ---------- a) claude mcp add ----------

function parseClaude(tokens: string[], r: PasteResult): void {
  r.source = 'claude';
  const sub = tokens[2];
  if (sub === 'add-json') {
    const rest = tokens.slice(3);
    const pos: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '-s' || a === '--scope') { const v = rest[++i]; r.scope = asScope(v); if (v && !r.scope) r.warnings.push({ kind: 'ignored', detail: `--scope ${v}` }); continue; }
      if (a.startsWith('--scope=')) { r.scope = asScope(a.slice(8)); if (!r.scope) r.warnings.push({ kind: 'ignored', detail: a }); continue; }
      if (a === '--client-secret') { r.warnings.push({ kind: 'ignored', detail: a }); continue; }
      if (a.startsWith('-')) { r.unknown.push(a); continue; }
      pos.push(a);
    }
    const [name, json] = pos;
    let v: unknown;
    try { v = JSON.parse(json ?? ''); } catch { r.unknown.push(json ?? ''); return; }
    const d = fromJsonDef(name ?? '', v, r);
    if (d) r.drafts.push(d);
    return;
  }
  const d = emptyDraft();
  let transport: McpTransport | null = null;
  const pos: string[] = [];
  let i = 3;
  for (; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === '--') { i++; break; }
    // Nombre y comando: lo que sigue son argumentos del servidor. Tras una URL sí puede haber opciones (`-H …`).
    if (pos.length >= 2 && !isUrl(pos[1])) break;
    const take = (flag: string): string | undefined => {
      if (a === flag) return tokens[++i];
      if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
      return undefined;
    };
    let v: string | undefined;
    if ((v = take('--transport') ?? take('-t')) !== undefined) {
      if (v === 'stdio' || v === 'http' || v === 'sse') transport = v;
      else r.unknown.push(`--transport ${v}`);
    } else if ((v = take('--env') ?? take('-e')) !== undefined) {
      const kv = kvSplit(v, '=');
      if (kv) d.env.push(kv); else r.unknown.push(`-e ${v}`);
    } else if ((v = take('--header') ?? take('-H')) !== undefined) {
      const kv = kvSplit(v, ':');
      if (kv) d.headers.push(kv); else r.unknown.push(`-H ${v}`);
    } else if ((v = take('--scope') ?? take('-s')) !== undefined) {
      r.scope = asScope(v);
      if (!r.scope) r.warnings.push({ kind: 'ignored', detail: `--scope ${v}` });
    } else if ((v = take('--client-id') ?? take('--callback-port')) !== undefined) {
      r.warnings.push({ kind: 'ignored', detail: `${a} ${v}` });
    } else if (a === '--client-secret') {
      r.warnings.push({ kind: 'ignored', detail: a });
    } else if (a.startsWith('-')) {
      r.unknown.push(a);
    } else {
      pos.push(a);
    }
  }
  const rest = tokens.slice(i);
  d.name = pos[0] ?? '';
  let target = pos[1];
  let args = rest;
  if (target === undefined && rest.length) { target = rest[0]; args = rest.slice(1); }
  if (target === undefined) { r.unknown.push(tokens.join(' ')); return; }
  if (isUrl(target) && transport !== 'stdio') {
    d.transport = transport ?? 'http';
    d.url = target;
    if (args.length) r.unknown.push(...args);
    if (d.env.length) { r.unknown.push(...d.env.map((e) => `-e ${e.key}=…`)); d.env = []; }
  } else {
    d.transport = 'stdio';
    d.command = target;
    d.args = args;
    if (d.headers.length) { r.unknown.push(...d.headers.map((h) => `-H ${h.key}: …`)); d.headers = []; }
  }
  r.drafts.push(d);
}

// ---------- b) codex mcp add ----------

function parseCodex(tokens: string[], r: PasteResult): void {
  r.source = 'codex';
  const d = emptyDraft();
  let i = 3;
  const pos: string[] = [];
  for (; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === '--') { i++; break; }
    if (pos.length >= 1 && !a.startsWith('-')) break; // `codex mcp add name cmd args` (sin `--`)
    const take = (flag: string): string | undefined => {
      if (a === flag) return tokens[++i];
      if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
      return undefined;
    };
    let v: string | undefined;
    if ((v = take('--env')) !== undefined) {
      const kv = kvSplit(v, '=');
      if (kv) d.env.push(kv); else r.unknown.push(`--env ${v}`);
    } else if ((v = take('--url')) !== undefined) {
      d.url = v;
      d.transport = 'http';
    } else if ((v = take('--bearer-token-env-var')) !== undefined) {
      d.bearerEnvVar = v;
    } else if ((v = take('--oauth-client-id') ?? take('--oauth-resource') ?? take('--oauth-client-registration') ?? take('-c') ?? take('--config')) !== undefined) {
      r.warnings.push({ kind: 'ignored', detail: `${a} ${v}` });
    } else if (a.startsWith('-')) {
      r.unknown.push(a);
    } else {
      pos.push(a);
    }
  }
  d.name = pos[0] ?? '';
  const rest = tokens.slice(i);
  if (d.transport === 'stdio') {
    if (!rest.length) { r.unknown.push(tokens.join(' ')); return; }
    d.command = rest[0];
    d.args = rest.slice(1);
  } else if (rest.length) {
    r.unknown.push(...rest);
  }
  r.drafts.push(d);
}

// ---------- c) JSON ----------

/** Quita comentarios `//` y `/* *\/` y comas finales (fuera de cadenas). */
export function stripJsonc(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; }
    else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const looksLikeServer = (v: unknown) => isObj(v) && ('command' in v || 'url' in v || 'serverUrl' in v || 'httpUrl' in v);
const KNOWN_JSON = new Set(['type', 'transport', 'command', 'args', 'env', 'environment', 'url', 'serverUrl', 'httpUrl', 'headers', 'enabled']);
const IGNORED_JSON = new Set(['disabled', 'autoApprove', 'alwaysAllow', 'timeout', 'description', 'trust', 'tools', 'startup_timeout_ms', 'startup_timeout_sec', 'tool_timeout_sec']);

function strMap(v: unknown, where: string, r: PasteResult): McpKv[] {
  if (!isObj(v)) { if (v !== undefined) r.unknown.push(where); return []; }
  return Object.entries(v).map(([key, x]) => ({ key, value: typeof x === 'string' ? x : JSON.stringify(x) }));
}

function fromJsonDef(name: string, v: unknown, r: PasteResult): McpDraft | null {
  if (!isObj(v)) { r.unknown.push(name || JSON.stringify(v)); return null; }
  const d = emptyDraft();
  d.name = name;
  const type = String(v.type ?? v.transport ?? '').toLowerCase();
  const url = v.url ?? v.serverUrl ?? v.httpUrl;
  if (typeof url === 'string') {
    d.transport = type === 'sse' ? 'sse' : 'http';
    d.url = url;
    d.headers = strMap(v.headers, `${name}.headers`, r);
  } else if (Array.isArray(v.command)) {
    // opencode: command = [cmd, ...args]
    const parts = v.command.map(String);
    d.command = parts[0] ?? '';
    d.args = parts.slice(1);
    d.env = strMap(v.environment ?? v.env, `${name}.environment`, r);
  } else if (typeof v.command === 'string') {
    d.command = v.command;
    d.args = Array.isArray(v.args) ? v.args.map(String) : [];
    if (v.args !== undefined && !Array.isArray(v.args)) r.unknown.push(`${name}.args`);
    d.env = strMap(v.env ?? v.environment, `${name}.env`, r);
  } else {
    r.unknown.push(name || 'command/url');
    return null;
  }
  if (type && !['stdio', 'http', 'sse', 'streamable-http', 'streamable_http', 'streamablehttp', 'local', 'remote'].includes(type)) r.unknown.push(`${name}.type: ${type}`);
  for (const k of Object.keys(v)) {
    if (KNOWN_JSON.has(k)) continue;
    if (IGNORED_JSON.has(k)) r.warnings.push({ kind: 'ignored', detail: `${name ? name + '.' : ''}${k}` });
    else r.unknown.push(`${name ? name + '.' : ''}${k}`);
  }
  return d;
}

function parseJson(text: string, r: PasteResult): boolean {
  let v: unknown;
  const clean = stripJsonc(text.trim());
  try { v = JSON.parse(clean); } catch {
    // Trozo de README sin las llaves de fuera: `"name": { … }` o `"mcpServers": { … }`.
    try { v = JSON.parse(`{${clean.replace(/,\s*$/, '')}}`); } catch { return false; }
  }
  if (!isObj(v)) return false;
  r.source = 'json';
  let servers: Record<string, unknown> | null = null;
  if (isObj(v.mcpServers)) servers = v.mcpServers;
  else if (isObj(v.servers)) servers = v.servers;
  else if (isObj(v.mcp) && isObj(v.mcp.servers)) servers = v.mcp.servers;
  else if (isObj(v.mcp)) servers = v.mcp;
  else if (isObj(v.context_servers)) servers = v.context_servers;
  if (servers) {
    for (const [name, def] of Object.entries(servers)) {
      const d = fromJsonDef(name, def, r);
      if (d) r.drafts.push(d);
    }
    return true;
  }
  if (looksLikeServer(v)) {
    const d = fromJsonDef('', v, r);
    if (d) r.drafts.push(d);
    return true;
  }
  const entries = Object.entries(v);
  if (entries.length && entries.every(([, x]) => looksLikeServer(x))) {
    for (const [name, def] of entries) {
      const d = fromJsonDef(name, def, r);
      if (d) r.drafts.push(d);
    }
    return true;
  }
  r.unknown.push(Object.keys(v).join(', '));
  return true;
}

// ---------- d) TOML de Codex ----------

/** Valor TOML sencillo: cadena "…" / '…', número, booleano, array de cadenas o tabla en línea `{ K = "v" }`. */
function tomlValue(src: string): { v: unknown; ok: boolean } {
  const s = src.trim();
  let i = 0;
  const ws = () => { while (i < s.length && /[\s,]/.test(s[i])) i++; };
  const str = (): string | null => {
    const q = s[i];
    if (q !== '"' && q !== "'") return null;
    i++;
    let out = '';
    while (i < s.length && s[i] !== q) {
      if (q === '"' && s[i] === '\\') {
        const n = s[++i];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      } else out += s[i];
      i++;
    }
    i++;
    return out;
  };
  const key = (): string | null => {
    const q = str();
    if (q !== null) return q;
    const m = s.slice(i).match(/^[A-Za-z0-9_-]+/);
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const val = (): unknown => {
    ws();
    if (s[i] === '"' || s[i] === "'") return str();
    if (s[i] === '[') {
      i++;
      const arr: unknown[] = [];
      for (ws(); i < s.length && s[i] !== ']'; ws()) { const x = val(); if (x === undefined) return undefined; arr.push(x); }
      i++;
      return arr;
    }
    if (s[i] === '{') {
      i++;
      const o: Record<string, unknown> = {};
      for (ws(); i < s.length && s[i] !== '}'; ws()) {
        const k = key();
        if (k === null) return undefined;
        ws();
        if (s[i] !== '=') return undefined;
        i++;
        o[k] = val();
      }
      i++;
      return o;
    }
    const m = s.slice(i).match(/^(true|false|[-+]?[0-9_]+(\.[0-9]+)?)/);
    if (!m) return undefined;
    i += m[0].length;
    return m[1] === 'true' ? true : m[1] === 'false' ? false : Number(m[0].replace(/_/g, ''));
  };
  const v = val();
  ws();
  return { v, ok: v !== undefined && i >= s.length };
}

function parseToml(text: string, r: PasteResult): boolean {
  if (!/^\s*\[mcp_servers\./m.test(text)) return false;
  r.source = 'toml';
  const tables = new Map<string, Record<string, unknown>>();
  let cur: Record<string, unknown> | null = null;
  let curName = '';
  let sub: string | null = null;
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li].replace(/^\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const h = line.match(/^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\.([A-Za-z_]+))?\]\s*(#.*)?$/);
    if (h) {
      curName = h[1] ?? h[2];
      sub = h[3] ?? null;
      if (!tables.has(curName)) tables.set(curName, {});
      cur = tables.get(curName)!;
      if (sub) cur[sub] = isObj(cur[sub]) ? cur[sub] : {};
      continue;
    }
    if (line.startsWith('[')) { cur = null; r.unknown.push(line.trim()); continue; }
    if (!cur) { r.unknown.push(line.trim()); continue; }
    const eq = line.indexOf('=');
    if (eq <= 0) { r.unknown.push(line.trim()); continue; }
    const k = line.slice(0, eq).trim().replace(/^"(.*)"$/, '$1');
    let raw = line.slice(eq + 1).replace(/\s+#[^"']*$/, '');
    // Arrays en varias líneas.
    let depth = (raw.match(/\[/g) ?? []).length - (raw.match(/\]/g) ?? []).length;
    while (depth > 0 && li + 1 < lines.length) {
      const next = lines[++li].replace(/\s+#[^"']*$/, '');
      raw += ' ' + next;
      depth += (next.match(/\[/g) ?? []).length - (next.match(/\]/g) ?? []).length;
    }
    const { v, ok } = tomlValue(raw);
    if (!ok) { r.unknown.push(`${curName}.${k}`); continue; }
    if (sub) (cur[sub] as Record<string, unknown>)[k] = v;
    else cur[k] = v;
  }
  for (const [name, t] of tables) {
    const d = emptyDraft();
    d.name = name;
    if (typeof t.url === 'string') {
      d.transport = 'http';
      d.url = t.url;
      d.headers = strMap(t.http_headers, `${name}.http_headers`, r);
      if (typeof t.bearer_token_env_var === 'string') d.bearerEnvVar = t.bearer_token_env_var;
    } else if (typeof t.command === 'string') {
      d.command = t.command;
      d.args = Array.isArray(t.args) ? t.args.map(String) : [];
      d.env = strMap(t.env, `${name}.env`, r);
    } else {
      r.unknown.push(name);
      continue;
    }
    for (const k of Object.keys(t)) {
      if (['url', 'http_headers', 'bearer_token_env_var', 'command', 'args', 'env'].includes(k)) continue;
      if (['startup_timeout_ms', 'startup_timeout_sec', 'tool_timeout_sec', 'enabled', 'enabled_tools', 'disabled_tools'].includes(k)) r.warnings.push({ kind: 'ignored', detail: `${name}.${k}` });
      else r.unknown.push(`${name}.${k}`);
    }
    r.drafts.push(d);
  }
  return true;
}

// ---------- entrada ----------

/** Analiza lo pegado. Nunca lanza. */
export function parsePasted(text: string): PasteResult {
  const r: PasteResult = { source: null, drafts: [], unknown: [], warnings: [], scope: null };
  // Fuera las vallas de Markdown (```json … ```): se pega tal cual del README.
  const t = text.replace(/^[ \t]*```.*$/gm, '').trim();
  if (!t) return r;
  if (/^[{"]/.test(t) && parseJson(t, r)) return finish(r);
  if (parseToml(t, r)) return finish(r);
  // Línea de comandos: unir continuaciones (\ ^ `), quitar el prompt ($, >, PS C:\…>) y quedarse con la primera
  // orden reconocible; las líneas de texto del README que vengan antes se saltan.
  const lines = t.replace(/(\\|\^|`)\r?\n/g, ' ').split(/\r?\n(?![ \t])/).map((l) => l.replace(/^\s*(PS [^>]*>|\$|>)\s*/, ''));
  for (const line of lines) {
    const tokens = shellSplit(line);
    const head = tokens[0] ? baseCmd(tokens[0]) : '';
    if (head === 'claude' && tokens[1] === 'mcp' && (tokens[2] === 'add' || tokens[2] === 'add-json')) parseClaude(tokens, r);
    else if (head === 'codex' && tokens[1] === 'mcp' && tokens[2] === 'add') parseCodex(tokens, r);
    else if (RUNNERS.includes(head) || /^(node|python3?|uv|deno|bun)$/.test(head)) {
      r.source = 'command';
      const d = emptyDraft();
      d.command = tokens[0];
      d.args = tokens.slice(1);
      r.drafts.push(d);
    } else continue;
    return finish(r);
  }
  // Un bloque JSON después de texto («Add this to your config: { … }»).
  const brace = t.search(/^[ \t]*\{/m);
  if (brace > 0 && parseJson(t.slice(brace).trim(), r)) return finish(r);
  r.unknown.push(t.length > 200 ? t.slice(0, 200) + '…' : t);
  return r;
}
