// Casos sacados de los README reales de servidores MCP conocidos (texto tal cual se copia de la página).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameFromPackage, parsePasted, runnerPackage, shellSplit } from './mcppaste.ts';

const kinds = (r: ReturnType<typeof parsePasted>, k: string) => r.warnings.filter((w) => w.kind === k).map((w) => w.detail);

test('github/github-mcp-server: claude mcp add --transport http … -H "Authorization: Bearer …"', () => {
  const r = parsePasted('claude mcp add --transport http github https://api.githubcopilot.com/mcp -H "Authorization: Bearer YOUR_GITHUB_PAT"');
  assert.equal(r.source, 'claude');
  assert.equal(r.drafts.length, 1);
  const d = r.drafts[0];
  assert.equal(d.name, 'github');
  assert.equal(d.transport, 'http');
  assert.equal(d.url, 'https://api.githubcopilot.com/mcp');
  assert.deepEqual(d.headers, [{ key: 'Authorization', value: 'Bearer YOUR_GITHUB_PAT' }]);
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(kinds(r, 'placeholder'), ['Authorization']);
});

test('microsoft/playwright-mcp: claude mcp add playwright npx @playwright/mcp@latest (sin --)', () => {
  const r = parsePasted('claude mcp add playwright npx @playwright/mcp@latest');
  const d = r.drafts[0];
  assert.deepEqual([d.name, d.transport, d.command, d.args], ['playwright', 'stdio', 'npx', ['@playwright/mcp@latest']]);
  assert.deepEqual(kinds(r, 'thirdParty'), ['npx @playwright/mcp@latest']);
  assert.deepEqual(r.unknown, []);
});

test('microsoft/playwright-mcp: codex mcp add playwright npx "@playwright/mcp@latest"', () => {
  const r = parsePasted('codex mcp add playwright npx "@playwright/mcp@latest"');
  assert.equal(r.source, 'codex');
  const d = r.drafts[0];
  assert.deepEqual([d.name, d.command, d.args], ['playwright', 'npx', ['@playwright/mcp@latest']]);
});

test('upstash/context7: claude mcp add … -- npx -y … --api-key YOUR_API_KEY, y la versión http con --header', () => {
  let r = parsePasted('claude mcp add context7 -- npx -y @upstash/context7-mcp --api-key YOUR_API_KEY');
  let d = r.drafts[0];
  assert.deepEqual([d.name, d.command, d.args], ['context7', 'npx', ['-y', '@upstash/context7-mcp', '--api-key', 'YOUR_API_KEY']]);
  assert.deepEqual(kinds(r, 'placeholder'), ['--api-key']);
  assert.deepEqual(kinds(r, 'thirdParty'), ['npx @upstash/context7-mcp']);
  r = parsePasted('claude mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: YOUR_API_KEY"');
  d = r.drafts[0];
  assert.deepEqual([d.name, d.transport, d.url], ['context7', 'http', 'https://mcp.context7.com/mcp']);
  assert.deepEqual(d.headers, [{ key: 'CONTEXT7_API_KEY', value: 'YOUR_API_KEY' }]);
});

test('upstash/context7: TOML de Codex con startup_timeout_ms y la versión http', () => {
  const r = parsePasted(`[mcp_servers.context7]
args = ["-y", "@upstash/context7-mcp", "--api-key", "YOUR_API_KEY"]
command = "npx"
startup_timeout_ms = 20_000

[mcp_servers.context7-http]
url = "https://mcp.context7.com/mcp"
http_headers = { "CONTEXT7_API_KEY" = "YOUR_API_KEY" }`);
  assert.equal(r.source, 'toml');
  assert.equal(r.drafts.length, 2);
  assert.deepEqual([r.drafts[0].name, r.drafts[0].command, r.drafts[0].args], ['context7', 'npx', ['-y', '@upstash/context7-mcp', '--api-key', 'YOUR_API_KEY']]);
  assert.deepEqual(r.drafts[1].headers, [{ key: 'CONTEXT7_API_KEY', value: 'YOUR_API_KEY' }]);
  assert.ok(kinds(r, 'ignored').includes('context7.startup_timeout_ms'));
  assert.deepEqual(r.unknown, []);
});

test('Codex TOML con subtabla env, array en varias líneas, comentario y bearer_token_env_var', () => {
  const r = parsePasted(`# ~/.codex/config.toml
[mcp_servers.github]
command = "npx"
args = [
  "-y",
  "@modelcontextprotocol/server-github", # oficial
]

[mcp_servers.github.env]
GITHUB_PERSONAL_ACCESS_TOKEN = "<YOUR_TOKEN>"

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
cwd = "C:/x"`);
  const [gh, fig] = r.drafts;
  assert.deepEqual(gh.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.deepEqual(gh.env, [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: '<YOUR_TOKEN>' }]);
  assert.equal(fig.bearerEnvVar, 'FIGMA_OAUTH_TOKEN');
  // cwd no lo puede escribir Orchestra: se marca, no se inventa.
  assert.deepEqual(r.unknown, ['figma.cwd']);
});

test('modelcontextprotocol/servers (filesystem): {"mcpServers": …} de Claude Desktop', () => {
  const r = parsePasted(`{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/username/Desktop",
        "/path/to/other/allowed/dir"
      ]
    }
  }
}`);
  assert.equal(r.source, 'json');
  const d = r.drafts[0];
  assert.equal(d.name, 'filesystem');
  assert.equal(d.args.length, 4);
  assert.deepEqual(kinds(r, 'thirdParty'), ['npx @modelcontextprotocol/server-filesystem']);
});

test('server-github (antiguo): JSON con env y valor <YOUR_TOKEN>; varios servidores; campos desconocidos marcados', () => {
  const r = parsePasted(`{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<YOUR_TOKEN>" },
      "autoApprove": []
    },
    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"], "weird": 1 },
  }
}`);
  assert.deepEqual(r.drafts.map((d) => d.name), ['github', 'fetch']);
  assert.deepEqual(r.drafts[0].env, [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: '<YOUR_TOKEN>' }]);
  assert.deepEqual(kinds(r, 'placeholder'), ['GITHUB_PERSONAL_ACCESS_TOKEN']);
  assert.deepEqual(kinds(r, 'ignored'), ['github.autoApprove']);
  assert.deepEqual(r.unknown, ['fetch.weird']);
  assert.deepEqual(kinds(r, 'thirdParty'), ['npx @modelcontextprotocol/server-github', 'uvx mcp-server-fetch']);
});

test('trozo sin llaves de fuera ("name": {…}) y objeto suelto de un servidor', () => {
  let r = parsePasted(`"sentry": {
  "url": "https://mcp.sentry.dev/mcp"
}`);
  assert.deepEqual([r.drafts[0].name, r.drafts[0].transport, r.drafts[0].url], ['sentry', 'http', 'https://mcp.sentry.dev/mcp']);
  r = parsePasted('{ "command": "uvx", "args": ["mcp-server-time", "--local-timezone=Europe/Madrid"] }');
  assert.deepEqual([r.drafts[0].name, r.drafts[0].command], ['time', 'uvx']);
});

test('VS Code ({"servers"} y {"mcp":{"servers"}}) y opencode ({"mcp": {type: local, command: [...]}})', () => {
  let r = parsePasted('{"servers": {"github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": {"Authorization": "Bearer ${input:github_mcp_pat}"}}}}');
  assert.equal(r.drafts[0].url, 'https://api.githubcopilot.com/mcp/');
  r = parsePasted('{"mcp": {"servers": {"x": {"command": "node", "args": ["s.js"]}}}}');
  assert.equal(r.drafts[0].name, 'x');
  r = parsePasted(`{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp", "headers": { "Authorization": "Bearer {env:CONTEXT7_TOKEN}" }, "enabled": true },
    "local1": { "type": "local", "command": ["npx", "-y", "my-mcp"], "environment": { "K": "v" } }
  }
}`);
  assert.equal(r.drafts[0].bearerEnvVar, 'CONTEXT7_TOKEN');
  assert.deepEqual(r.drafts[0].headers, []);
  assert.deepEqual([r.drafts[1].command, r.drafts[1].args, r.drafts[1].env], ['npx', ['-y', 'my-mcp'], [{ key: 'K', value: 'v' }]]);
});

test('brave-search: -e K=V antes de --; sse de Linear; --scope project va al selector de ámbito', () => {
  let r = parsePasted('claude mcp add brave-search -e BRAVE_API_KEY=YOUR_KEY -- npx -y @modelcontextprotocol/server-brave-search');
  assert.deepEqual(r.drafts[0].env, [{ key: 'BRAVE_API_KEY', value: 'YOUR_KEY' }]);
  assert.deepEqual(r.drafts[0].args, ['-y', '@modelcontextprotocol/server-brave-search']);
  r = parsePasted('claude mcp add --transport sse linear-server https://mcp.linear.app/sse --scope project');
  assert.deepEqual([r.drafts[0].transport, r.drafts[0].url], ['sse', 'https://mcp.linear.app/sse']);
  assert.deepEqual(kinds(r, 'ignored'), []);
  assert.equal(r.scope, 'project');
  assert.equal(parsePasted(`claude mcp add-json x '{"command":"a"}' -s local`).scope, 'local');
  assert.equal(parsePasted('claude mcp add x -- npx y').scope, null);
});

test('claude mcp add-json y codex --url --bearer-token-env-var; prompt $ y continuaciones', () => {
  let r = parsePasted(`claude mcp add-json weather '{"type":"stdio","command":"/path/to/weather-cli","args":["--api-key","abc123"],"env":{"CACHE_DIR":"/tmp"}}'`);
  assert.deepEqual([r.drafts[0].name, r.drafts[0].command, r.drafts[0].env], ['weather', '/path/to/weather-cli', [{ key: 'CACHE_DIR', value: '/tmp' }]]);
  r = parsePasted('$ codex mcp add figma --url https://mcp.figma.com/mcp --bearer-token-env-var FIGMA_OAUTH_TOKEN');
  assert.deepEqual([r.drafts[0].name, r.drafts[0].transport, r.drafts[0].url, r.drafts[0].bearerEnvVar], ['figma', 'http', 'https://mcp.figma.com/mcp', 'FIGMA_OAUTH_TOKEN']);
  r = parsePasted('codex mcp add context7 \\\n  --env K=1 \\\n  -- npx -y @upstash/context7-mcp');
  assert.deepEqual([r.drafts[0].env, r.drafts[0].args], [[{ key: 'K', value: '1' }], ['-y', '@upstash/context7-mcp']]);
});

test('npx / uvx / docker sueltos: nombre sacado del paquete, aviso de terceros', () => {
  let r = parsePasted('npx -y @modelcontextprotocol/server-memory');
  assert.deepEqual([r.source, r.drafts[0].name, r.drafts[0].command], ['command', 'memory', 'npx']);
  assert.deepEqual(kinds(r, 'thirdParty'), ['npx @modelcontextprotocol/server-memory']);
  r = parsePasted('uvx mcp-server-git --repository path/to/git/repo');
  assert.equal(r.drafts[0].name, 'git');
  r = parsePasted('docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server');
  assert.deepEqual(kinds(r, 'thirdParty'), ['docker ghcr.io/github/github-mcp-server']);
  assert.equal(r.drafts[0].name, 'github');
});

test('lo que no se entiende se marca y no se inventa', () => {
  let r = parsePasted('Install it from the marketplace and restart.');
  assert.deepEqual(r.drafts, []);
  assert.equal(r.unknown.length, 1);
  r = parsePasted('claude mcp add --frobnicate x npx pkg');
  assert.deepEqual(r.unknown, ['--frobnicate']);
  r = parsePasted('{"foo": 1}');
  assert.deepEqual(r.drafts, []);
  assert.deepEqual(r.unknown, ['foo']);
  r = parsePasted('');
  assert.deepEqual([r.source, r.drafts, r.unknown], [null, [], []]);
});

test('utilidades: shellSplit, runnerPackage, nameFromPackage', () => {
  assert.deepEqual(shellSplit(`a "b c" 'd "e"' f\\ g`), ['a', 'b c', 'd "e"', 'f\\', 'g']);
  assert.deepEqual(shellSplit('x ""'), ['x', '']);
  assert.equal(runnerPackage('npx', ['-y', '@a/b']), '@a/b');
  assert.equal(runnerPackage('C:\\Program Files\\nodejs\\npx.cmd', ['pkg']), 'pkg');
  assert.equal(runnerPackage('pnpm', ['dlx', 'pkg']), 'pkg');
  assert.equal(runnerPackage('uvx', ['--from', 'git+https://x', 'tool']), 'tool');
  assert.equal(runnerPackage('node', ['s.js']), null);
  assert.equal(nameFromPackage('@playwright/mcp@latest'), 'playwright');
  assert.equal(nameFromPackage('@modelcontextprotocol/server-github'), 'github');
  assert.equal(nameFromPackage('@upstash/context7-mcp'), 'context7');
  assert.equal(nameFromPackage('mcp-server-fetch'), 'fetch');
});

test('trozo de README con texto y vallas: se salta la prosa, no se inventa', () => {
  // brave-search (README de modelcontextprotocol/servers): frase + bloque con la orden.
  const r = parsePasted('Add it to Claude Code:\n\n```bash\nclaude mcp add brave-search -e BRAVE_API_KEY=YOUR_API_KEY_HERE -- npx -y @modelcontextprotocol/server-brave-search\n```');
  assert.equal(r.source, 'claude');
  assert.equal(r.drafts[0].name, 'brave-search');
  assert.deepEqual(r.drafts[0].env, [{ key: 'BRAVE_API_KEY', value: 'YOUR_API_KEY_HERE' }]);
  assert.ok(r.warnings.some((w) => w.kind === 'placeholder'));
  // JSON tras una frase («Add this to your claude_desktop_config.json:»).
  const j = parsePasted('Add this to your claude_desktop_config.json:\n```json\n{\n  "mcpServers": {\n    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }\n  }\n}\n```');
  assert.equal(j.source, 'json');
  assert.equal(j.drafts[0].name, 'memory');
  // Solo prosa: nada.
  const n = parsePasted('Install the package and restart your client.');
  assert.equal(n.drafts.length, 0);
  assert.equal(n.unknown.length, 1);
});
