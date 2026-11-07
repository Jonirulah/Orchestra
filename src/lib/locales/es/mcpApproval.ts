export default {
  // Diálogo que pide al usuario aprobar un comando que un agente quiere ejecutar en un host `ask` (McpApproval.svelte).
  'mcp.approval.aria': 'Un agente quiere ejecutar un comando',
  'mcp.approval.title': 'Un agente quiere ejecutar un comando',
  'mcp.approval.intro': 'Un agente de IA conectado a través de Orchestra pide ejecutar este comando en {host}.',
  'mcp.approval.hostLabel': 'Host',
  'mcp.approval.commandLabel': 'Comando (tal cual se ejecutará)',
  'mcp.approval.timeoutNote': 'Se detendrá a los {secs} s.',
  'mcp.approval.expires': 'Si no contestas en {secs} s NO se ejecutará.',
  'mcp.approval.queue': '{n} más esperando',
  'mcp.approval.warning': 'Apruébalo solo si entiendes lo que hace. El comando se ejecuta en el host remoto con tu cuenta allí.',
  'mcp.approval.deny': 'Denegar',
  'mcp.approval.allow': 'Ejecutar',
} as const;
