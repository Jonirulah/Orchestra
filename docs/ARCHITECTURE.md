# Architecture

## Overview

| Layer | Technology | Notes |
|---|---|---|
| Shell | Tauri 2 + WebView2 | tray icon, close-to-tray, single window |
| UI | Svelte 5 (runes), Vite 8, TypeScript | pure logic lives in `src/lib/*.ts` modules testable with `node --test` |
| Terminal | xterm.js 6 (+ fit, search, web-links, unicode11, WebGL) | WebGL budget of 12 contexts, DOM renderer fallback |
| Processes | `portable-pty` (ConPTY) in Rust | the backend owns the processes, not the window |
| SSH | system `ssh.exe` inside a PTY | inherits ssh-agent, `~/.ssh/config`, `ProxyJump`; no custom crypto |

The Rust backend is deliberately thin: it spawns and buffers PTYs, scans agents, reads/writes a few files and runs the local
MCP server. State (workspaces, hosts, accounts, settings) is an opaque JSON owned by the frontend; the backend only writes it
atomically.

## Terminals and the grid

- `Workspace { cols[], rows[], panes[] }` — track sizes are fractions; each pane has `col,row,colSpan,rowSpan,parked`.
- Layout presets resize the grid. Panes that no longer fit become **parked**: still alive, listed under "Background".
- Splitters are aligned across the whole grid (minimum 140 px). Reflow, placement, swapping and neighbor navigation are pure
  functions in `src/lib/model.ts`.
- Each PTY keeps a 2 MiB ring buffer. `pty_attach` replays the buffer and then streams live output under the same lock, so a
  reconnecting view sees no gaps or duplicates. Output travels as raw bytes over a Tauri `Channel`.
- ConPTY sends a cursor-position query (`ESC[6n`) and blocks until it is answered; in the app xterm answers, in Rust tests the
  test answers.

## Claude accounts

An account is a `CLAUDE_CONFIG_DIR`: `~/.claude` plus any `~/.claude-*`. Identity is read from `.claude.json → oauthAccount`.
Creating an account makes the folder with **junctions** (no admin needed) to `projects/agents/skills/plugins` of the main one
and copies `CLAUDE.md` and `settings.json`. Because `projects` is shared, a conversation can be continued by another account:
switching relaunches the pane's session with the other config dir: `claude --resume <id>` when the pane's session id is known and its
transcript exists under the new account's folder, `claude --continue` otherwise.

### Restoring Claude sessions on restart

Processes do not survive a restart, so every pane is relaunched when it mounts. For Claude panes the store decides what to launch:

1. **Remember.** Each agent scan (`pollOnce`) that reports `sessionId` + `configDir` for a pane stores `pane.lastSession = { id, dir }`
   (`trackSession`; only written when it changes, then the normal debounced `persist()`). It is saved in `state.json`; files saved before
   the field existed simply have no `lastSession` and restore as before.
2. **Ended by the user.** The agent runs inside a PowerShell that stays open, so `/exit` does not make the pane "exited". When a scan stops
   seeing a Claude that an earlier scan saw in a still-running pane, `lastSession.ended` is set and `--resume <id>` is stripped from the pane
   command (*Restart* then starts a fresh conversation). A pane saved while shown as exited with code 0 is also written as `ended`
   (`sessionForSave`). Closing the window with the sessions running (the normal case, it hides to the tray) leaves them resumable.
3. **Decide.** In `init`, after the usage wrapper and MCP config are ready (`resumeSavedSessions`), each `kind: 'agent'` pane whose account
   (`pane.ref`) is a Claude account goes through the pure `restoreSpecFor(pane, { setting, account, exists })`: `resume(id)` only with
   `restoreClaudeSessions` on, a valid UUID id, `lastSession.dir` equal to the pane account's folder, not `ended`, and the backend command
   `claude_session_exists(dir, id)` true; anything else is `fresh`. Resume builds `claudeSpec(acc, { resumeId })`:
   `& claude --resume <id> [--settings …] [--mcp-config …]` (`--mcp-config` is variadic and must stay last).
4. **Each pane its own.** The id, not `--continue`, is what makes two panes in the same folder resume different conversations.

`claude_session_exists` (in `agents.rs`) answers whether `<account dir>/projects/*/<id>.jsonl` exists, the same lookup as `find_transcript`.

`src/lib/policy.ts` picks an account when a terminal is created (manual / round-robin / soonest reset / most free). It skips
logged-out and exhausted accounts and falls back to round-robin when no quota data exists.

## Accounts by provider

`Account.provider` is `'claude' | 'codex' | 'opencode'` (`model.ts`). A state saved before this field existed has accounts without it;
`normalizeAccounts` loads them as `'claude'` and changes nothing else (tested with a realistic old `state.json`). All providers share
one list (`app.accounts`); everything that is Claude-only (quota polling, usage query, the config folders given to the agent scan, the
account policy `pickAccount`, the pane switcher, `~/.claude*` rescans) goes through `app.claudeAccounts`, and `pickAccount` filters
again as a second barrier. Tests scan the store for those call sites.

| Provider | Account = | Env in the pane (PTY spec only) | Command |
|---|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` folder | `CLAUDE_CONFIG_DIR` (none for the default) | `claude` (`claudeSpec`) |
| codex | `CODEX_HOME` folder, e.g. `~\.codex-work` | `CODEX_HOME` (none for the default `~/.codex`) | `codex` / `codex login` |
| opencode | root folder `~\.opencode-work` with `data\` and `state\` | `XDG_DATA_HOME=<root>\data`, `XDG_STATE_HOME=<root>\state` (none for the default) | `opencode --standalone` / `opencode auth login --standalone` (default account: plain `opencode`) |

Verified with the real binaries: `CODEX_HOME` isolates Codex completely (credentials, `config.toml`, temp files), and opencode's data,
state, cache and config paths follow `XDG_*` (`opencode debug paths`). But opencode v2 keeps **one shared background service** per
machine (`opencode service status`); a client with another data folder tries to start its own service on the same port and fails.
`--standalone` makes the pane use a private server that honours `XDG_DATA_HOME`, so isolated opencode accounts always launch with it
(cost: one server per pane). Config (`~/.config/opencode`) and cache are deliberately left shared. The *default* opencode account
(checkbox "use my existing data") shares data and service with the opencode you already run and is labelled as not isolated.

`providers.rs` (Rust) has three commands: `provider_detect` (is `codex` / `opencode` on PATH, do `~/.codex` and the opencode data folder
exist), `provider_prepare` (creates the new folder, validated; writes the Codex `config.toml` line only into a new/empty folder) and
`provider_status` (sign-in verdict, see SECURITY.md). The frontend keeps the verdicts in `app.providerStatus` (`providers.ts`:
allow-list filter, 30 s debounce) and refreshes them when Settings → Accounts opens or on demand.

The old loose "Codex (ChatGPT)" launcher (`{kind: 'codex'}`, panes with `ref: 'codex'`) keeps working as a no-account launcher; its sidebar
and palette entries hide once a *Default Codex* account exists. Sign-in panes (`{kind: 'account', login: true}`) are ordinary agent
panes whose command is the login; like any pane they are relaunched when Orchestra restarts.

**Account list view** (`accountview.ts`, pure): the sidebar's Accounts section can be filtered by provider (chips, plus a menu from the
sort button), grouped by provider (headings appear only when two or more providers have accounts) and sorted (`manual` = stored order,
`name`, `free` = lowest `policy.pressure`, `reset` = earliest `policy.nextReset`; the last two only rank Claude accounts with data, everything
else keeps its relative order at the end). `buildAccountView(accounts, opts, ctx)` returns sections `{provider, labelKey, heading, accounts,
specialRows}`: `Claude · auto` goes in the Claude section and the loose Codex launcher in the Codex one, so the sidebar renders sections
instead of special-casing rows. It never mutates `app.accounts` (so the stored order is untouched). The three choices live in settings
(`accountsFilter`, `accountsSort`, `accountsGroup`, reset by the `accounts` section; a filter whose provider has no accounts any more acts as
All). Settings → Accounts reuses the same sort and grouping but never the provider filter (it is the page to manage every account).
`ctxitems.accountsViewMenu` builds the menu.

MCP: Codex panes of any account are reported to the MCP server as `codex`, opencode panes as `shell` (the server only knows
shell/claude/codex and `mcp.rs` was left alone); both obey "Expose local terminals".

## Agent observation (`agents.rs`, `tokens.rs`)

Every poll (default 2 s):

1. Pane PTY pid → process tree (`sysinfo`) → `claude.exe`. Codex (`codex*.exe`) and opencode (`opencode*.exe`; the npm shim `opencode.cmd` runs `opencode.exe` directly, no node) are detected by process name only (`detect_plain` in `agents.rs`, status `running`, no tokens or session data).
2. `<config>/sessions/<pid>.json` → status (`busy / idle / waiting`), session id. The file is created lazily at the first
   message, so a fresh Claude shows as `new`.
3. `projects/*/<sessionId>.jsonl` (tail) → title, current tool, `TodoWrite` tasks, `Agent` subagent calls (background ones are
   considered running if their `subagents/agent-<id>.jsonl` changed in the last 25 s), context size, last request time,
   cache TTL (1 h unless `ephemeral_5m` is used).
4. Token totals are summed **incrementally** (remembering the byte offset), de-duplicated by `message.id` taking the maximum
   per field. Subagent totals are computed on a background thread and cached.

## Usage capture (`quota.rs`)

Claude Code pipes a JSON payload to the status line command; it includes `rate_limits.five_hour` and `seven_day`
(`used_percentage`, `resets_at`). For Claude panes started by Orchestra, `claudeSpec` adds `--settings <file>` whose `statusLine`
points to a small PowerShell wrapper. The wrapper:

1. writes the rate-limit block atomically to `quota\<accountId>.json`;
2. runs the user's original status line command with the same stdin and relays its output unchanged.

The user's own `settings.json` is never modified. The frontend polls `quota_read` every 5 s and feeds the sidebar bars and the
account policy. Added latency of the wrapper: about 110 ms in the default (in-process) path.

### Usage query (`usage_query.rs`, opt-in)

When `usageQuery` is on (off by default, explicit confirmation in the UI), the store calls `usage_fetch(accounts, intervalMin)` right
away and then every `usageQueryMin` minutes (2..30). For each signed-in account the backend reads the OAuth token from the account
folder (see `SECURITY.md`), does one `GET /api/oauth/usage`, parses the answer tolerantly (`parse_usage`) and **merges**
the windows into the same `quota\<accountId>.json` the status line wrapper writes (same schema, atomic temp + rename, a window that
did not come back keeps its old value, `at` updated). So `quota_read`, the bars and the account policy need no change: whichever source
wrote last wins. The command returns per-account `{status: ok|expired|nocreds|unauthorized|rate_limited|error, fiveHour?, sevenDay?,
fetchedAt, message?}`; the store keeps it in `app.usageStatus` for Settings → Accounts (status line + *Test now*) and for a "last data
Xm ago" tooltip on the bars when the token is expired. State (60 s floor, backoff) is kept in memory per account. The pure UI helpers
are in `usageQuery.ts`.

Real response shape (seen once, Max 20x account, 2026-11-06; everything not listed is ignored, including ~25 obfuscated keys and
`seven_day_opus/sonnet/oauth_apps/cowork/omelette`, `extra_usage`, `spend`, `seven_day_breakdown`):

- `five_hour`: `null` when no 5 h window is running (= absent, **not** 0 %), otherwise `{utilization, resets_at}`;
- `seven_day`: `{utilization: 29.0, resets_at: "2026-11-13T13:00:00.230794+00:00", …}` (percentage 0..100; ISO-8601 with 6 fractional
  digits and offset; epoch s / ms and `Z` are accepted too);
- `limits`: list of `{kind, group, percent, severity, resets_at, scope, is_active}`; `kind: "weekly_all"` is the general weekly window
  (already in `seven_day`), `kind: "weekly_scoped"` has `scope: {model: {display_name: "Fable"}}` and `is_active`. Any `kind`/`group`
  containing `five`, `hour` or `session` (without a model scope) is read as the 5 h window if `five_hour` is missing. Everything
  else is an extra limit.

Extra limits are stored in `quota\<account>.json` as `limits: [{kind, percent, resetsAt, scope?, active}]` (max 8, texts ≤ 40 chars).
The query replaces them only when the answer has a `limits` field; the status line wrapper never writes them but copies them back
when it rewrites the file, so neither source erases what only the other knows. The UI (`UsageBars`) shows the 5 h row only if
there is 5 h data, the 7 d row, and one thin extra row named after the model when an **active** scoped limit is higher than the
weekly one. `policy.ts` (`pressure`, `exhausted`, `nextReset`) takes the max over the 5 h window, the 7 d window and all active limits.

## MCP server (`mcp.rs`)

MCP **Streamable HTTP**, JSON responses only, on `127.0.0.1:<port>/mcp`, implemented with a minimal `std::net` server (a thread per connection, 32-connection cap, per-phase read deadlines, strict request parser, exclusive port bind) in background threads. Negotiates 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05.
The frontend pushes a sanitized snapshot (`mcp_sync`) of hosts and panes — no secrets, key paths or jump hosts. Tools in phase 1:
`list_hosts`, `list_terminals`, `read_terminal` (ANSI stripped, tail of the PTY ring buffer). Access is decided per host
(`agentAccess: none | read | ask | full`; `ask` and `full` behave as `read` until phase 2). Every call is appended to an audit
log. Claude panes launched by Orchestra receive `--mcp-config <file>` (always the last argument: the flag is variadic) so no global configuration is touched.
Untrusted text (names, titles, terminal output) is sanitized in the core before it is stored or returned, terminal output is fenced with a per-call nonce, and the host permission is re-checked after the output is read. The token and config files are restricted to the current user via `icacls`; `McpManager::shutdown` (on app exit) stops the server and empties `claude-mcp.json`. See SECURITY.md for the threat model and remaining limits.

## MCP manager (`mcp_manager.rs`, read-only so far)

Not the server above: this lists the MCP servers *configured in each account* and probes one on demand (design and phases in
`docs/dev-notes/diseno_gestor_mcp.md`). `mcpm_list` reads, without starting anything: Claude `<CLAUDE_CONFIG_DIR>\.claude.json`
(default account: `%USERPROFILE%\.claude.json`) → `mcpServers` (user) and `projects[<path>].mcpServers` (local); Codex
`codex mcp list --json` with the account's `CODEX_HOME` (10 s, hidden window, accounts in parallel); opencode `mcp` of
`~/.config/opencode/opencode.json(c)` (JSONC, one global account). Each entry becomes an `McpDef`; env and header **values never
leave Rust** (only names), URL query values, URL passwords and key-looking arguments become `•••`. `fingerprint` hashes the real
definition with a per-process random key, so it groups identical definitions during the session without letting anyone test a
guessed key. Per-account failures go in `McpAccount.error`. `mcpm_probe` re-reads the definition, runs `initialize` +
`tools/list` (stdio: spawned suspended into a Job Object with KILL_ON_JOB_CLOSE, so the whole `npx → node` tree dies; http:
POST, JSON or SSE answers; legacy sse: GET stream + endpoint), 10 s total, and returns `ok | needsAuth | failed | timeout`
(the failure message is the first stderr line with known secrets and key-looking words removed). An `ok` result also carries
`toolsBytes` (compact JSON of every tool definition, all pages) and `tokensEst` (≈ bytes / 4): what the server adds to each session.

Also read without starting anything (Claude): `.mcp.json` of the folders of the open local panes (`mcpm_list(projects)`, scope
`project`, approval from `enabled/disabledMcpjsonServers` and `enableAllProjectMcpServers`), `projects[p].disabledMcpServers`
(→ `McpDef.disabledIn`), plugin MCP servers (`plugins/installed_plugins.json` + `enabledPlugins` + the plugin's
`.claude-plugin/plugin.json` or `.mcp.json`, scope `plugin`) and claude.ai connectors seen before (`claudeAiMcpEverConnected`,
scope `claudeai`, name only, cannot be probed). `mcpm_stamp(projects)` hashes path + mtime + size of every file read; the UI
(Settings → MCP servers, `SettingsMcpServers.svelte` + pure `src/lib/mcpmatrix.ts`) polls it every 4 s while visible and re-lists on
change. Probe results live only in that component.

## SSH vault (`vault.rs`)

Secrets are stored in the Windows Credential Manager (`keyring` crate, service `dev.orchestra.app`) and are write-only from
the UI. To log in without typing, the Orchestra executable doubles as an `SSH_ASKPASS` helper (`--askpass`): the PTY environment
holds only the *name* of the credential, never the secret. A key manager lists `~/.ssh/*.pub`, generates ed25519 keys and
installs a public key on a server.

## Settings

`src/lib/settings.ts` is a pure module: the `Settings` type, `DEFAULTS`, `clampSettings` (never throws; unknown keys are dropped,
out-of-range values clamped; old saved states load with defaults for new fields) and per-section reset. The store applies
changes live (terminal options through `terminals.applyOptions`, accent through CSS variables, timers re-armed).

### Full backup (`backup.ts`)

`src/lib/backup.ts` is a pure module behind *Settings -> Data -> Full backup*: `buildBackup(state)` -> `{ app:'orchestra-backup', format:1, appVersion,
exportedAt, settings, hosts, accounts, customThemes, workspaces, activeId, ignoredDirs }`; `parseBackup(text)` validates a file without touching
anything and returns a summary plus sanitized sections; `mergeBackup` / `replaceFromBackup(current, sections, picks)` return the next state and a
report (they never mutate their inputs). The store only writes the result (`AppState.backupState()` / `applyBackupState()`), then re-syncs
accounts, MCP and usage like `init()` does. Merge dedupes by id, then by `user@host:port` (hosts), account folder (accounts) or theme
content, and gives colliding entries new ids, remapping pane `ref`s. Replace swaps the ticked sections. Workspaces are applied **in place**,
not with a window reload: the panes being replaced are disposed (`T.dispose` kills their PTY) and the new ones launch when mounted; a reload
would leave the old PTYs running in the backend. The `format` number gates future changes (a newer file is refused with a clear message).

## Internationalization

English base + Spanish; `src/lib/i18n.ts` (`t`, `tk`) with per-area dictionaries in `src/lib/locales/`. The UI is re-mounted when
`settings.language` changes. See `docs/i18n.md` and `npm run i18n:check`.

### Subagent viewer (`subtranscript.rs`, `SubagentDrawer.svelte`, `subtranscript.ts`)

Clicking a subagent row in the sidebar's Active Agents tree opens a read-only drawer (right side, ~420 px, Esc / X closes) with
that subagent's transcript, live. The small terminal icon on the row is the old "go to pane" action.

Data flow: `agent_scan` records, per pane, the main transcript path and session id it just found (`subtranscript::track`;
panes without an agent are forgotten). While the drawer is open and the window visible, the frontend calls
`agent_transcript(paneId, subagentId, afterOffset)` every 1.5 s (5 s once the subagent is done). The backend derives
`<projects>/<proj>/<sessionId>/subagents/agent-<id>.jsonl` from the tracked agent and reads it **by byte offset**:
the first call (`afterOffset = null`) returns only the tail (last ~100 events, plus the first prompt), later calls return what
was appended since `nextOffset` (cap 200 events / 256 KB per call). Only whole lines are consumed: a half-written last line
is left for the next call (the offset does not move past it); a missing file returns an empty chunk. The result is a list of
reduced `SubEvent`s (`prompt | text | tool | result`, truncated text, tool name + one-line summary, timestamp) and `done`
(file idle for 25 s). The raw JSON lines never reach the frontend. `subtranscript.ts` is a pure reducer (max 500 events in memory,
tool results paired with their call, offset going backwards = file rebuilt) and the drawer renders everything as text nodes.
State: `app.subagentView = { paneId, subId } | null`; it is cleared when its agent disappears from the scan.

## Auto-compact (`autocompact.ts`, `idle.rs`)

`decideCompact` is a pure function: agent is a Claude and idle, context above a threshold, time since the last request is
inside the window `[afterMin, cacheTtl − 3 min)`, the user has been away (Windows `GetLastInputInfo`), and this
`(sessionId, lastRequestAt)` was not handled yet. If everything holds, `/compact` is typed once. Off by default.

- **Unsent draft (`user-typed`).** `terminals.ts` reports every `term.onData` chunk (keyboard and paste only; what the app writes with
  `ptyWrite` does not go through it) and `nextDraft` keeps per pane whether there is unsent text: a chunk ending in Enter submits,
  Ctrl+C alone clears (Claude empties its prompt), terminal replies (focus, mouse, cursor/DA reports, OSC) and a lone Esc change
  nothing, anything else (text, paste, Backspace, arrows that recall history) leaves a draft. Time alone is not enough: a draft typed
  while the agent was busy is older than `lastRequestAt` and still in the prompt. Conservative: deleting a draft with Backspace still
  counts as a draft until Enter or Ctrl+C.
- **`ttl-too-short`.** When `afterMin ≥ ttl − 3` (the 5 min cache) the window is empty and the reason says so instead of
  too-early/too-late.
- **Settings** shows, per running Claude agent, the last reason in plain words (`app.compactReasons`, refreshed each scan).
- **Dev override.** `ORCHESTRA_DEV_AUTOCOMPACT=ctxK=1,afterSec=15,idleSec=0` (read by `dev_autocompact_override`) bypasses the
  Settings limits so the real flow can be tested in seconds; with it set, decisions and writes are appended to
  `<data dir>/autocompact-dev.log`. Without the variable nothing changes.

## SSH latency badge and auto-reconnect (`sshconn.ts`, `latency.ts`, `reconnect.ts`, `net.rs`)

Pure, parameterised modules (all numbers come from Settings; tested with `node --test`): `latency.ts` (target resolution from the
stored Host / `cfg:` alias / quick-connect args, dedupe by `host:port`, ring buffer, stats, level) and `reconnect.ts` (`backoff`,
`decide`, `isAuthFailure`). `sshconn.ts` is the controller (plain TS, a context object instead of the store, fake timers in tests).

- **Latency.** One `net_ping` call per tick (default 5 s) for all running, visible SSH panes; skipped while the document is hidden or
  the badge is off. `net_ping` is a TCP `connect_timeout` that sends nothing: ≤ 32 targets, ≤ 8 threads, generic errors only.
  Panes behind ProxyJump/ProxyCommand show "via jump" and are not measured.
- **Reconnect.** Only for ssh panes, non-zero exit code, a session that produced output at least `minUp` s before dropping, and not
  user-initiated (Cancel, parked, other workspace, app shutdown). A wrong-password / host-key failure is detected from the terminal
  tail at exit time and never loops. It goes through the same restart path as the Restart button (host-key gate, askpass,
  `refreshSshSpec`). Within a streak quick failures keep retrying with backoff until the cap; a session that stays up resets it.

## Status bar (`metrics.rs`, `statusbar.ts`, `StatusBar.svelte`)

Bottom bar, mounted only while `statusBar` is on. `StatusBar.svelte` calls the Rust command `metrics_sample` every `statusBarInterval`
seconds (1–10, default 2) while the window is visible (`visibilitychange` stops/restarts the timer) and only if at least one item needs
OS data (the `agents` and `usage` items read the store). `metrics.rs` keeps ONE `sysinfo` `System`/`Networks`/`Disks` behind a mutex and
refreshes only CPU, memory, interface counters and per-disk I/O counters. Rates (disk, network) are deltas of the cumulative counters
divided by the real elapsed time (`rate_per_sec`: zero elapsed or a counter that goes down = 0). Loopback interfaces are excluded.
The first sample after start has `ready:false` and zero rates. Disk figures are bytes/s: Windows exposes bytes (`IOCTL_DISK_PERFORMANCE`
via sysinfo), so there is no real IOPS. `statusbar.ts` is pure (formatting, `cleanItems`, `fitItems`, `levelFor`); `clampSettings` validates
`statusBar`, `statusBarItems` (unknown ids and duplicates dropped) and `statusBarInterval`. Items drop from the right when the bar is narrower
than the fixed slot widths. In the browser demo `backend.ts` returns invented metrics. Remote (SSH) metrics: see the next section.

Per tab: `Workspace.statusBarItems?` is an optional own list (absent = the global `statusBarItems`). `itemsFor(workspace, settings, focusCtx)`
resolves the list: own list, else (with `statusBarAdapt`, default off) the set for the focused pane (SSH: target, latency, cpu, ram, net;
local pane in a repo: branch, cpu, ram, net, uptime), else global. `toggleFor`/`moveFor` edit the own list when there is one, never both.
`cleanOverride` is the single validator (store load, backup import and export). Context items (`pane`, `target`, `branch`, `latency`,
`account`, `agentState`) are built from the focused pane of the active tab (`ws.focusId`, else the first visible pane) and are hidden
when they have nothing to show; git comes from `gitState` (the bar refreshes it itself when the header chip is off), latency from
`app.conn.view`. cpu/ram/disk/net/uptime stay local: with an SSH pane focused their tooltip says so. Changed context slots re-mount on
tab/focus change and fade in (120 ms, 0 with prefers-reduced-motion); slots have fixed widths so nothing jitters.

## Remote (server) metrics (`remote_metrics.rs`, `remotemetrics.ts`, `statusbar.ts`)

Opt-in per saved host (`Host.remoteMetrics`, default off; global `remoteMetricsInterval` 2-10 s, default 3). Flow: `StatusBar.svelte`
computes `desiredMonitors(workspaces, hosts, live, interval)` (pure): one entry per distinct destination `user@host:port|jump` that has at
least one live (not exited) SSH pane of a host with the flag on, in ANY tab, visible or parked, focus-independent. `RmController.sync`
diffs that set against what it already started and calls `rmetrics_start` / `rmetrics_stop` once per destination. In Rust a `Manager`
keeps one `Mon` per key with a reference count: `start` creates the monitor (a supervisor thread that spawns the system `ssh`) or just bumps
the count and cancels a pending stop; `stop` decrements and, at 0, arms a 10 s grace; `reap` (a 500 ms thread) kills and removes monitors
whose grace expired. Switching tabs or panes of the same host changes nothing: the bar polls `rmetrics_sample(key)` (1 s) and the key
is unchanged, so the last sample is reused with no reconnect. `metricSource(remoteOn, snap)` (pure) chooses local vs remote vs a dim
`...` / `n/a` placeholder with the reason as tooltip (never fake zeros, never a silent fall back to local values).

Process lifecycle: the ssh child lives in a `ChildGuard` (kill + wait on drop). It is killed on `reap` after the grace, on `shutdown`
(app exit, `RunEvent::Exit`), when the window has been hidden for more than 60 s (`rmetrics_hidden`; the link is resumed on show) and
when the interval changes (reconnects with the new one). If the app dies hard, ssh writes to a closed pipe on its next tick (at most
10 s) and exits. Transient network failures retry with backoff 5 -> 60 s; host key, auth, unsupported and spawn errors do not retry.
States: `connecting | ok | unavailable(kind, reason) | stale` (no line for 3 x interval).

Transport: `ssh -T -o BatchMode=yes|no -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 -o StrictHostKeyChecking=yes
-o LogLevel=ERROR -o ControlPath=none ... -p PORT [-i KEY] [-J JUMP] -- user@host sh -s`; arguments are an array, the destination is
validated (no leading `-`, no whitespace). The POSIX script is sent on stdin (the remote command is the constant `sh -s`) and loops
`awk` over `/proc/{stat,meminfo,net/dev,diskstats,uptime,loadavg}` printing one `key=value;...;end=1` line per tick (only the sleep
integer is substituted, after clamping). No `/proc/stat`: it prints `unsupported`. Parsing (`parse_line`, `compute`) is strict and pure:
a line must have every key once, unsigned integers, end with `end=1` and be at most 4 KB; at most one line per 500 ms is processed;
CPU % comes from /proc/stat deltas (busy = user+nice+system+irq+softirq vs idle+iowait+steal), RAM used = total - available, net and
disk rates use the REAL local time between received lines, a counter that goes down gives 0 and the first line has no rates.
The demo (`backend.ts`) fakes samples, and a host named `bad.*` fakes a host-key failure.

## Git branch chip (`git.rs`, `gitinfo.ts`, `GitChip.svelte`, `SettingsGit.svelte`)

Phase 1: local panes only (`pane.kind !== 'ssh'`). The design has three independent parts so a remote phase can reuse two of them.

1. **Which folder.** `terminals.ts` registers xterm OSC handlers for **9** (`9;9;<path>`, ConEmu / Windows Terminal) and **7** (`file://host/path`).
   `gitinfo.ts` parses and validates them (`parseOsc9`, `parseOsc7`: percent-decoding, `/C:/x` to `C:\x`, no UNC, no `..`, no control characters,
   no leading `-`, max 1 KB) and the store keeps the result in `LiveInfo.cwd`. Fallback chain (`cwdForPane`): shell report, then the agent's folder
   from the session scan (`AgentInfo.cwd`), then `PaneSpec.cwd`. Only Windows drive paths are used (a WSL `/home/x` cannot be handed to the Windows `git`).
   Default PowerShell emits no OSC, so `withCwdTracking` (setting `gitTrackFolder`, default on) relaunches a **plain** PowerShell shell pane as
   `powershell -NoLogo -NoExit -Command <wrapper>`. The wrapper saves `$function:prompt` and defines a new `prompt` that calls it and appends
   `ESC ] 9;9;<ProviderPath> BEL` (FileSystem locations only). It applies only when `kind === 'shell'`, the program is powershell/pwsh and the args are
   nothing but `-NoLogo`; agents, login flows, `-Command ...` panes and SSH keep their exact command line. The saved `PaneSpec` is never mutated.
   *Why not poll the process cwd from Rust:* reading another process's current directory needs `NtQueryInformationProcess` + `ReadProcessMemory`
   on its PEB (undocumented structures, breaks across bitness, needs a process handle with VM-read rights) and follows only the shell, not a
   `cd` inside a sub-shell. The prompt wrapper is documented, user-visible and degrades to the start folder.
2. **Git state (Rust).** `git_info(cwd)` validates the folder (`validate_cwd`: absolute, exists, directory, canonicalized, no leading `-`, no NUL, <= 1 KB),
   then runs two commands through `run_capped` (no shell; hidden window; 2 s hard timeout that kills the child; 1 MiB output cap):
   `rev-parse --path-format=absolute --show-toplevel --absolute-git-dir --git-common-dir` (root; linked worktree = git dir differs from common dir) and
   `status --porcelain=v2 --branch -z --no-renames --ignore-submodules=dirty`. `parse_status` is pure and tested on fixtures. The in-progress state is
   read from marker files in the git dir (`rebase-merge`, `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`). The result is cached
   1.5 s per canonical folder (not per repo root: the root is only known after the first call). `git_available` runs `git --version` once.
3. **UI.** `GitChip.svelte` (one per mounted = visible pane) refreshes on folder change, on focus, and every `gitIntervalSec` (2-30, default 5) while
   `document.visibilityState === 'visible'`. Results land in `gitstate.svelte.ts` (`gitState.byPane`), which the sidebar `AgentTree` reads for its sub-line.
   Settings: `gitChip`, `gitCounts`, `gitIntervalSec`, `gitTrackFolder` (Settings -> Terminal -> Git, `SettingsGit.svelte`). Browser demo: `backend.ts`
   returns invented states keyed by the folder name and the demo shell announces a folder with a real OSC 9;9.
   The command palette has no per-pane entries today, so the branch is not added there.
   Remote phase (not built): a remote pane needs its own folder source (OSC 7 from the remote shell works unchanged) and a way to run git
   on the server; `GitInfo` and `gitinfo.ts` are transport-agnostic.

## Testing strategy

- Pure TypeScript modules (`model`, `policy`, `settings`, `autocompact`, `usage`, `usageQuery`, `mcpsync`, `i18n`) → `node --test`, no DOM.
- Rust → real ConPTY processes, a real loopback HTTP server for MCP, a real wrapper script run end to end for the quota capture,
  and "plant a bug and see the test fail" checks for the security-relevant tests. The usage query is tested only against fake
  credentials in temp folders and a fake server on 127.0.0.1; no test touches a real credential file or the real endpoint.
- UI → demo mode in a normal browser (`backend.ts` returns fake data when Tauri is absent).

## Directory map

```
src/            Svelte app (components/, lib/)
src-tauri/src/  main.rs, pty.rs, shells.rs, sshcfg.rs, accounts.rs, agents.rs, tokens.rs,
                quota.rs, usage_query.rs, providers.rs, mcp.rs, vault.rs, idle.rs, store.rs, commands.rs,
                net.rs, metrics.rs, remote_metrics.rs, git.rs, subtranscript.rs
docs/           ARCHITECTURE.md, SECURITY.md, DISENO.md (design notes, ES), dev-notes/, screenshots/
```
