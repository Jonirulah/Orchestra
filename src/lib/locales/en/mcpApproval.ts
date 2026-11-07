export default {
  // Dialog that asks the user to approve a command an agent wants to run on an `ask` host (McpApproval.svelte).
  'mcp.approval.aria': 'An agent wants to run a command',
  'mcp.approval.title': 'An agent wants to run a command',
  'mcp.approval.intro': 'An AI agent connected through Orchestra asks to run this command on {host}.',
  'mcp.approval.hostLabel': 'Host',
  'mcp.approval.commandLabel': 'Command (exactly as it will run)',
  'mcp.approval.timeoutNote': 'It will be stopped after {secs} s.',
  'mcp.approval.expires': 'If you do not answer in {secs} s it will NOT run.',
  'mcp.approval.queue': '{n} more waiting',
  'mcp.approval.warning': 'Only approve it if you understand what it does. The command runs on the remote host with your account there.',
  'mcp.approval.deny': 'Deny',
  'mcp.approval.allow': 'Run it',
} as const;
