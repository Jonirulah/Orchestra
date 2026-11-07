// Datos de la demo del navegador (sin Tauri): UNA sola fuente para las cuentas de la barra lateral y para los MCP de
// cada cuenta en la vista MCP, para que las columnas de la vista sean exactamente las cuentas de la barra lateral.
// Nada de aquí sale de un fichero real. Sin dependencias (lo usan backend.ts y los tests).
import type { McpAccount, McpDef } from './backend.ts';

export interface DemoAccount {
  provider: 'claude' | 'codex' | 'opencode';
  dir: string;
  isDefault: boolean;
  /** Codex / opencode: nombre y color con que se crean en la barra lateral (Claude: los pone `syncAccounts`). */
  name?: string;
  color?: string;
  email?: string;
  plan?: string;
}

/** Variantes de la demo por la URL (solo capturas): `?mcp6` dos cuentas más (una sin MCP), `?mcp8` ocho cuentas y 18 MCP. */
export function demoQuery(): URLSearchParams | null {
  return typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
}

/** Cuentas de la demo, en el orden en que salen en la barra lateral. Codex por defecto (~/.codex) NO es una cuenta: en
 *  la barra lateral es el lanzador suelto «Codex (ChatGPT)»; en la vista MCP es la columna de esa carpeta. */
export function demoAccounts(q: URLSearchParams | null = demoQuery()): DemoAccount[] {
  if (q?.has('mcpnone')) return []; // sin cuentas: tampoco en la barra lateral
  const many = !!q?.has('mcp6') || !!q?.has('mcp8');
  const list: DemoAccount[] = [
    { provider: 'claude', dir: 'C:/Users/demo/.claude', isDefault: true, email: 'me@example.com', plan: 'Max 20x' },
    { provider: 'claude', dir: 'C:/Users/demo/.claude-b', isDefault: false, email: 'work@example.com', plan: 'Pro' },
  ];
  if (many) list.push({ provider: 'claude', dir: 'C:/Users/demo/.claude-ops', isDefault: false, email: 'ops@example.com', plan: 'Team' });
  if (q?.has('mcp8')) list.push(
    { provider: 'claude', dir: 'C:/Users/demo/.claude-client', isDefault: false, email: 'client@example.com', plan: 'Pro' },
    { provider: 'claude', dir: 'C:/Users/demo/.claude-lab', isDefault: false, email: 'lab@example.com', plan: 'Max 5x' },
  );
  list.push({ provider: 'codex', dir: 'C:/Users/demo/.codex-work', isDefault: false, name: 'Work', color: '#ff9f6b' });
  if (many) list.push({ provider: 'codex', dir: 'C:/Users/demo/.codex-personal', isDefault: false, name: 'personal', color: '#5fd4d4' });
  list.push({ provider: 'opencode', dir: 'C:/Users/demo/.opencode-side', isDefault: false, name: 'Side', color: '#c58af9' });
  return list;
}
/** Carpeta del Codex por defecto (lanzador «Codex (ChatGPT)» de la barra lateral). */
export const DEMO_CODEX_DEFAULT = 'C:/Users/demo/.codex';
/** Config global de opencode (una para todas las cuentas de opencode). */
export const DEMO_OPENCODE_CONFIG = 'C:/Users/demo/.config/opencode';

export function demoMcpDef(name: string, fp: string, over: Partial<McpDef> = {}): McpDef {
  return {
    name, transport: 'stdio', command: 'npx', args: ['-y', `@modelcontextprotocol/server-${name}`], url: null, cwd: null,
    envKeys: [], headerKeys: [], envPassthrough: [], enabled: true, scope: 'user', projectPath: null, rawKind: 'stdio',
    authStatus: null, disabledIn: [], managedBy: null, fingerprint: fp, ...over,
  };
}

/** MCP de cada cuenta de la demo (columnas de la vista MCP), sin los cambios aplicados en la sesión. */
export function demoMcpBase(q: URLSearchParams | null = demoQuery()): McpAccount[] {
  const gh = demoMcpDef('github', 'a1b2c3d4e5f60718', { envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'] });
  const ghOld = demoMcpDef('github', '0f9e8d7c6b5a4932', { args: ['-y', '@modelcontextprotocol/server-github@0.5.0'], envKeys: ['GITHUB_TOKEN'] });
  const fs = demoMcpDef('filesystem', '1122334455667788', { args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Dev'] });
  const pw = demoMcpDef('playwright', '99aabbccddeeff00', { args: ['@playwright/mcp@latest'] });
  const linear = demoMcpDef('linear', '5566778899aabbcc', { transport: 'http', command: null, args: [], url: 'https://mcp.linear.app/mcp', headerKeys: ['Authorization'], rawKind: 'http' });
  const unity = demoMcpDef('unity', 'ddeeff0011223344', { command: 'uvx', args: ['mcp-unity'], scope: 'local', projectPath: 'C:\\Dev\\game', enabled: false });
  const db = demoMcpDef('postgres', '7788990011aabbcc', { command: 'uvx', args: ['mcp-server-postgres', '--dsn', '•••'], envKeys: ['PGPASSWORD'], scope: 'project', projectPath: 'C:\\Dev\\orchestra', enabled: null });
  const sentry = demoMcpDef('sentry', '3344556677889900', { transport: 'http', command: null, args: [], url: 'https://mcp.sentry.dev/mcp', scope: 'plugin', managedBy: 'plugin:sentry@anthropic-plugin-directory', rawKind: 'http' });
  const trello = demoMcpDef('claude.ai Trello', '0000000000000000', { transport: 'http', command: null, args: [], scope: 'claudeai', managedBy: 'claude.ai', rawKind: 'claudeai', enabled: null, disabledIn: ['C:/Dev/game'] });
  const src = (provider: McpAccount['provider'], dir: string) => (provider === 'codex' ? 'codex mcp list --json' : provider === 'opencode' ? `${dir}/opencode.json` : `${dir}.json`);
  const servers: Record<string, McpDef[]> = {
    'claude:C:/Users/demo/.claude': [gh, { ...gh, scope: 'local', projectPath: 'C:/Dev/game' }, fs, pw, unity, db, sentry, trello],
    'claude:C:/Users/demo/.claude-b': [ghOld, linear, { ...db, enabled: true }, { ...gh, scope: 'local', projectPath: 'C:/Dev/orchestra' }],
    'claude:C:/Users/demo/.claude-ops': [],
    'claude:C:/Users/demo/.claude-client': [gh, linear],
    'claude:C:/Users/demo/.claude-lab': [ghOld, fs],
    'codex:C:/Users/demo/.codex-work': [{ ...gh, enabled: true, authStatus: 'unsupported' }, { ...pw }],
    'codex:C:/Users/demo/.codex-personal': [{ ...fs }, { ...ghOld }],
    [`codex:${DEMO_CODEX_DEFAULT}`]: [{ ...pw }],
    'opencode:global': [{ ...fs, scope: 'global' }],
  };
  // `?mcpauth`: linear con la sesión OAuth ya iniciada en la cuenta b.
  if (q?.has('mcpauth')) servers['claude:C:/Users/demo/.claude-b'][1] = { ...linear, authStatus: 'signedIn' };
  // `?mcp8`: 18 MCP repartidos entre las cuentas (scroll en los dos ejes).
  if (q?.has('mcp8')) {
    const extra = ['brave-search', 'fetch', 'memory', 'slack', 'notion', 'figma', 'stripe', 'docker', 'kubernetes', 'sqlite'];
    extra.forEach((n, i) => {
      const d = demoMcpDef(n, `e${i.toString(16).padStart(15, '0')}`);
      const ids = Object.keys(servers).filter((id, j) => (j + i) % 3 !== 2 && !id.endsWith('.claude-ops')); // ops: sin ningún MCP
      for (const id of ids) servers[id].push(id.startsWith('opencode') ? { ...d, scope: 'global' } : { ...d });
    });
  }
  const accs: McpAccount[] = [];
  for (const a of demoAccounts(q)) {
    if (a.provider === 'opencode') continue;
    const id = `${a.provider}:${a.dir}`;
    accs.push({ id, provider: a.provider, dir: a.dir, isDefault: a.isDefault, label: a.email ?? null, source: src(a.provider, a.dir), servers: servers[id] ?? [], error: null });
  }
  // El Codex por defecto detrás de las cuentas de Codex (como el lanzador en la barra lateral); opencode, una (global), al final.
  accs.push({ id: `codex:${DEMO_CODEX_DEFAULT}`, provider: 'codex', dir: DEMO_CODEX_DEFAULT, isDefault: true, label: null, source: src('codex', DEMO_CODEX_DEFAULT), servers: servers[`codex:${DEMO_CODEX_DEFAULT}`], error: null });
  accs.push({ id: 'opencode:global', provider: 'opencode', dir: DEMO_OPENCODE_CONFIG, isDefault: true, label: null, source: src('opencode', DEMO_OPENCODE_CONFIG), servers: servers['opencode:global'], error: null });
  // `?mcp0`: cuentas sin ningún MCP; `?mcpnone`: ninguna cuenta.
  if (q?.has('mcpnone')) return [];
  if (q?.has('mcp0')) for (const a of accs) a.servers = [];
  return accs;
}
