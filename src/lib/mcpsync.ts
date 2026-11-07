// Instantánea que Orchestra empuja al servidor MCP del backend. Módulo puro (sin Svelte ni Tauri).
// Regla de oro: se construye COPIANDO CAMPOS UNO A UNO (lista blanca). Nunca se esparce un Host entero:
// contraseñas, comandos y notas no salen de la interfaz. Excepción acotada (run_command, v0.2.0): de un host con acceso `ask`/`full`
// viajan al backend LOCAL los datos para lanzar `ssh` (ruta de la clave, salto y el NOMBRE de la entrada de la bóveda, nunca el
// secreto). El backend no los devuelve nunca por MCP (list_hosts arma su respuesta campo a campo).
import { activeSecretKey } from './model.ts';
import type { AgentAccess, Host, Pane, Provider, Workspace } from './model.ts';

export interface McpHost {
  id: string;
  name: string;
  host: string;
  user?: string;
  port?: number;
  group?: string;
  tags: string[];
  agentAccess: AgentAccess;
  /** Solo con acceso `ask`/`full`: cómo conectar para `run_command`. */
  identity?: string;
  identitiesOnly?: boolean;
  jump?: string;
  /** NOMBRE de la entrada de la bóveda (nunca el secreto). */
  secretKey?: string;
}

export type McpPaneKind = 'ssh' | 'shell' | 'claude' | 'codex';

export interface McpPane {
  id: string;
  title: string;
  kind: McpPaneKind;
  /** Solo en terminales SSH de un host guardado. */
  hostId?: string;
  workspace: string;
  state: string;
}

export interface McpSnapshot {
  hosts: McpHost[];
  panes: McpPane[];
}

const ACCESS: readonly AgentAccess[] = ['none', 'read', 'ask', 'full'];

/** `providers`: proveedor de cada cuenta por id (el `ref` de un panel de agente). El servidor MCP solo conoce shell/claude/codex:
 *  los paneles de opencode salen como `shell` (terminal local, solo lectura y bajo el mismo ajuste). */
export function paneKind(p: Pick<Pane, 'kind' | 'ref'>, providers: Readonly<Record<string, Provider>> = {}): McpPaneKind {
  if (p.kind === 'ssh') return 'ssh';
  if (p.kind === 'agent') {
    const prov = p.ref === 'codex' ? 'codex' : (p.ref ? providers[p.ref] : undefined) ?? 'claude';
    return prov === 'codex' ? 'codex' : prov === 'opencode' ? 'shell' : 'claude';
  }
  return 'shell';
}

export function mcpHost(h: Host): McpHost {
  const out: McpHost = {
    id: h.id,
    name: h.name || h.host,
    host: h.host,
    tags: Array.isArray(h.tags) ? h.tags.filter((t) => typeof t === 'string') : [],
    // Lo desconocido cae a 'none': el permiso falla cerrado.
    agentAccess: ACCESS.includes(h.agentAccess) ? h.agentAccess : 'none',
  };
  if (h.user) out.user = h.user;
  if (h.port) out.port = h.port;
  if (h.group) out.group = h.group;
  if (out.agentAccess === 'ask' || out.agentAccess === 'full') {
    const jump = h.proxyJump?.trim();
    const sk = activeSecretKey(h);
    if (h.identityFile) out.identity = h.identityFile;
    if (h.authMethod === 'key' && h.identityFile) out.identitiesOnly = true;
    if (jump) out.jump = jump;
    if (sk) out.secretKey = sk;
  }
  return out;
}

export function buildMcpSnapshot(input: {
  hosts: readonly Host[];
  workspaces: readonly Workspace[];
  live: Readonly<Record<string, { state: string } | undefined>>;
  providers?: Readonly<Record<string, Provider>>;
}): McpSnapshot {
  const hosts = input.hosts.map(mcpHost);
  const known = new Set(hosts.map((h) => h.id));
  const panes: McpPane[] = [];
  for (const ws of input.workspaces) {
    for (const p of ws.panes) {
      const kind = paneKind(p, input.providers);
      const pane: McpPane = {
        id: p.id,
        title: p.title,
        kind,
        workspace: ws.name,
        state: input.live[p.id]?.state ?? 'starting',
      };
      if (kind === 'ssh' && p.ref && known.has(p.ref)) pane.hostId = p.ref;
      panes.push(pane);
    }
  }
  return { hosts, panes };
}

/** Texto del comando para registrar el servidor a mano en Claude Code (uso global). */
export function claudeAddCommand(url: string, token: string): string {
  return `claude mcp add --transport http orchestra ${url} --header "Authorization: Bearer ${token}"`;
}
