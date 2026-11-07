// Panes that need you: SSH drop/reconnect look and the agents waiting for an answer.
export default {
  // SSH pane while the connection is down
  'attention.ssh.retrying': 'Reconnecting… (attempt {n})',
  'attention.ssh.downFor': 'down for {dur}',
  'attention.ssh.dotDown': 'SSH connection lost: reconnecting',
  'attention.ssh.dotGaveUp': 'SSH connection lost: gave up reconnecting',
  // Written locally in the terminal (never sent to the remote shell)
  'attention.ssh.separator': '── reconnected {time} · down {dur} ──',
  'attention.ssh.retryBanner': '── reconnecting (attempt {n}) ──',
  'attention.ssh.gaveUp': 'Gave up after {n} attempts: {why}',
  'attention.ssh.gaveUpOne': 'Gave up after 1 attempt: {why}',
  'attention.ssh.paused': 'Reconnecting stopped: the pane was hidden while it waited',
  'attention.ssh.gaveUpWhen': 'at {time} · offline for {dur}',
  'attention.ssh.restart': 'Restart',
  'attention.ssh.close': 'Close',
  'attention.ssh.cause.auth': 'the server rejected the login (password or key)',
  'attention.ssh.cause.hostkey': 'the host key changed or is not trusted',
  'attention.ssh.cause.dns': 'the host name cannot be resolved',
  'attention.ssh.cause.refused': 'the server refused the connection',
  'attention.ssh.cause.timeout': 'the network does not answer (timed out)',
  'attention.ssh.cause.unreachable': 'the network or host is unreachable',
  'attention.ssh.cause.closed': 'the server keeps closing the connection',
  'attention.ssh.cause.max': 'the connection could not be restored',
  // Agents waiting for you
  'attention.block.title': 'Need attention ({n})',
  'attention.block.rowTitle': 'Go to this pane',
  'attention.block.waiting': 'waiting for you',
  'attention.tab.waiting': '{n} agent(s) waiting in this tab',
  'attention.none': 'No agent is waiting for you',
  'attention.notify.title': '{name} needs you',
  'attention.notify.body': 'Waiting for your answer: {what}',
  'attention.notify.bodyGeneric': 'An agent is waiting for your answer',
};
