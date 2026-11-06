# Security model

Orchestra runs on your machine, with your user's permissions, and talks only to `127.0.0.1` and to the SSH hosts you configure.
It sends no telemetry. The single exception is the **opt-in usage query** (off by default, see below), which makes one read-only
request to `api.anthropic.com` per signed-in account when you turn it on.

## What is stored and where

| Data | Location | Notes |
|---|---|---|
| Layout, hosts, accounts, settings | `%APPDATA%\dev.orchestra.app\state.json` | **No secrets.** Hosts store only flags such as "has a saved password". |
| SSH passwords / passphrases | Windows Credential Manager, service `dev.orchestra.app` | Write-only from the UI: no command returns a secret to the frontend. |
| Usage snapshots | `…\quota\<account>.json` (+ `.raw.txt`, `.query-raw.txt`) | Percentages and reset times only. `.query-raw.txt` is the body of the last usage-query answer (max 4 KB, never the token). |
| MCP token and client config | `…\mcp\token`, `…\mcp\claude-mcp.json` | Plain text, but both files and the `mcp` folder are restricted to your Windows user with `icacls` (inheritance removed). If that fails, Settings → MCP shows a warning and the files keep the inherited permissions. |
| MCP audit log | `…\mcp\audit.jsonl` | One line per agent call; rotated at 1 MB. |
| Last Claude session per pane | in `state.json` (`lastSession`: session UUID + account folder) | Not secret. Only used to build `claude --resume <id>` on restart (see below). |
| Claude credentials | untouched | Orchestra never writes Claude's files. By default it never reads OAuth tokens either (only the identity block of `.claude.json`). The one exception is the opt-in usage query below. |

## The MCP server

Goal: let agents use the hosts you choose, without handing them credentials.

Transport and authentication:

- Listens on `127.0.0.1` only, on a port nobody else can share (`SO_EXCLUSIVEADDRUSE`: another program cannot bind the same port
  with `SO_REUSEADDR` and steal the traffic). If the preferred port is busy a free one is used and `claude-mcp.json` is rewritten.
- Requires `Authorization: Bearer <token>` (32 random bytes from the OS CSPRNG, constant-time comparison). A wrong token gets a
  plain 401 and is not audited.
- Rejects any `Origin` that is not localhost, any `Host` that is not the loopback address (DNS-rebinding defense) and an
  unsupported `MCP-Protocol-Version`. No CORS headers are ever sent, not even for `OPTIONS`.
- The HTTP server is Orchestra's own small `std::net` server, not a library. Ambiguous request shapes (request smuggling) are
  rejected: duplicate `Host`/`Authorization`/`Content-Length`, `Content-Length` together with `Transfer-Encoding`, bare LF/CR,
  obsolete line folding, a space before the colon. Head ≤ 16 KB and ≤ 64 headers; body ≤ 256 KB (also when chunked).
- Slow or idle clients cannot stall it: at most 32 concurrent connections (the 33rd gets an immediate 503), 5 s for the first
  byte, 5 s for the whole header, 10 s for the body, 15 s idle on keep-alive, 5 s to accept a response.
- The token and the client config are written to a temporary file that is restricted to your user *before* the secret is put in it,
  then renamed. When Orchestra exits it stops the server and empties `claude-mcp.json`, so no stale file points at a port that
  another process could take later.

What agents can see:

- Access is **per host** (`none` by default, also for hosts saved before the setting existed). `ask` and `full` behave as `read`
  for now. Read-only tools only. Local shells and agent (Claude/Codex) terminals are hidden unless you enable "Expose local
  terminals"; with it on, an agent can read another agent's terminal.
- The permission is checked again after the output is taken from the terminal, so lowering a host's access while a read is in
  flight cannot leak that read. The frontend publishes changes with a 300 ms debounce: a change can take up to ~0.3 s to apply.
- Responses never contain credentials, key paths or jump hosts: the snapshot is a fixed whitelist of fields.
- Host names, titles and tags can come from a remote machine or a config file and are **untrusted**: control, bidi and invisible
  characters are removed, lengths and counts are capped, and list results carry a notice that they are data. Terminal output is
  returned between per-call random-nonce markers (`<<<TERMINAL-OUTPUT-<nonce> …>>>` / `<<<END-TERMINAL-OUTPUT-<nonce>>>>`), so the
  text cannot forge the end marker, under a header saying it is untrusted data. ANSI/OSC sequences, C1 controls and invisible
  characters are stripped from it.
- Every call, allowed or denied, is appended to `audit.jsonl`, JSON-escaped and sanitized, so a pane title cannot forge a line.

Remaining limits:

- The permission applies to the *terminal*, not to what you run inside it. If you `cat` a secret in a terminal of an allowed
  host, the agent can read it: Orchestra cannot recognise secrets in output. Output of full-screen (TUI) programs is best effort.
- The untrusted-data label is not a guarantee: a model may still follow text printed by a hostile remote. Do not give an agent
  access to a host you do not trust to talk to your agent.
- A malicious local process running as **your user** can read the token (an ACL cannot stop the same user) and call the server.
  Other Windows users cannot.
- If `icacls` is missing or fails, the files stay readable by whoever the folder inherits from; this is only reported as a warning.
- `Origin` and `Accept` are not required (non-browser clients are the normal case); browsers are stopped by the token and the
  Origin/Host rules.
- A denied `read_terminal` tells someone who already guessed a pane id the name of the host that owns it.
- Regenerating the token invalidates already-open Claude sessions until they restart.

## The SSH helper

When a host has a saved secret, the PTY environment contains `SSH_ASKPASS=<orchestra.exe>`, `SSH_ASKPASS_REQUIRE=force` and
`ORCHESTRA_ASKPASS_KEY=<credential name>` — never the secret itself. The `--askpass` mode looks the credential up and prints it
for `ssh.exe`; it opens no window and logs nothing. It only answers prompts that match the saved secret's kind
(`…password:` or `…passphrase:`); it never answers a host-key "yes/no" question, a fingerprint prompt or a 2FA code.

### Host key verification for hosts with a saved secret

Because the helper cannot answer ssh's "trust this server?" question, Orchestra decides it **before** opening the terminal. This is
a setting (Settings → SSH keys, "Host key verification"), with an optional per-host override in the host's dialog.
Hosts **without** a saved secret are not affected: ssh asks you in the terminal, as always.

| Policy | Default | What happens |
|---|---|---|
| **Confirm new hosts** (`confirm`) | yes | Orchestra checks `~/.ssh/known_hosts` (`ssh-keygen -F`). If the key is known, ssh is started with `StrictHostKeyChecking=yes`. If not, it reads the server's host keys (`ssh-keyscan`, or `ssh` itself without authenticating if `ssh-keyscan` cannot negotiate), computes the SHA256 fingerprints with `ssh-keygen -lf -` and shows them in a dialog. Only after **Trust and connect** are the key lines appended to `~/.ssh/known_hosts` (append only, never rewritten) and the terminal started with `StrictHostKeyChecking=yes`. Cancel changes nothing. |
| **Trust on first use** (`accept-new`) | no | ssh is started with `StrictHostKeyChecking=accept-new`: an unknown key is accepted silently the first time; a **changed** key is still rejected by ssh. |

Details and limits:

- The dialog shows only public data (host, address:port, key types, fingerprints). No secret is read, logged or shown by this flow.
- `confirm` is only as good as the comparison you make: compare the fingerprint with one from the server's administrator or another
  trusted channel. If you cannot, you are no better off than with Trust on first use.
- **Residual risk of Trust on first use:** an attacker who can intercept the very first connection to a host can impersonate it from
  then on, and with a saved password Orchestra would hand that password to the impostor. Later connections are protected.
  `confirm` removes this only if you actually verify the fingerprint.
- A **changed** key is never accepted automatically in either policy; ssh prints its standard warning in the terminal and refuses.
  If `ssh-keygen -F` finds the host, Orchestra starts ssh with `yes` and lets ssh report the change.
- Hosts behind a `ProxyJump` / `ProxyCommand`, or with a `HostKeyAlias` in `~/.ssh/config`, cannot be scanned in advance. If their key
  is not already known, Orchestra says so and does not connect; set that host to Trust on first use, or connect once without a saved password.
- Panes restored when the app starts are launched with `StrictHostKeyChecking=yes` and are not scanned; if the key has disappeared from
  `known_hosts` they fail closed. Use the pane's restart button to go through the dialog again.
- Only the default `known_hosts` file is used (`UserKnownHostsFile` set in `~/.ssh/config` is not followed). Names are written in the
  form ssh expects (`host`, or `[host]:port` for non-22 ports; hostnames lower-cased, no trailing dot).

## Codex and opencode accounts

What Orchestra reads: **nothing from the agents' credential files and nothing from the OS keyring.** To show "signed in / not signed
in" it runs the agent's own command with that account's environment, only when you open Settings → Accounts (at most once per 30 s
per account), press *Check sign-in*, or right after you create an account:

- Codex: `codex login status` (with `CODEX_HOME` = the account folder). The exit code and the first words ("Logged in using
  ChatGPT" / "... an API key" / "Not logged in") are classified and the text is thrown away.
- opencode: `opencode auth list --format json --standalone` (with `XDG_DATA_HOME` / `XDG_STATE_HOME` = the account folder). Only the
  length of the JSON list is kept. Orchestra never runs `opencode auth export` (it prints secrets). For the shared "default" opencode
  account the same command runs without `--standalone`, against your normal background service (not verified on real data).

The Rust side returns only a verdict (`signedIn` / `notSignedIn` / `unknown`, plus method or count). Output is capped at 64 KB, the
command runs under a 10 s (Codex) / 20 s (opencode) timeout and its process tree is killed on timeout, and the frontend filters the
verdict again with an allow-list. A test scans `providers.rs` for any mention of the credential file, `read_to_string`, `File::open`,
`println!` or the keyring.

What Orchestra writes: only a **new** `~\.codex-<name>` or `~\.opencode-<name>` folder (the Rust command refuses any path that is not a
direct child of your user folder with that prefix, and anything with `..`). In a new or empty Codex folder it writes one line,
`cli_auth_credentials_store = "file"`, into that folder's own `config.toml` (never over an existing `config.toml`, never in `~/.codex`),
so the sign-in is a file inside the account folder instead of an entry in the shared Windows credential store. It never writes into
`~/.codex`, `~/.config/opencode`, `~/.local/share/opencode` or `~/.claude*`.

Environment variables are set **per pane** (the PTY spec), never on the Orchestra process. Choosing "use my existing folder" creates a
*default* account that sets no folder variable at all.

## The status line wrapper

Only Claude terminals launched by Orchestra get `--settings <wrapper>`. The wrapper copies the `rate_limits` block to disk and
then runs your own status line command with the same input. It cannot reach the network.

## Usage query (opt-in)

**Off by default.** Settings → Agents → *Usage from Anthropic*. Turning it on needs an explicit confirmation that explains the points
below. It exists so the usage bars work for every signed-in account, including those with no open terminal (the status line
wrapper above only sees accounts running a session started from Orchestra, and stays as the fallback).

**This is the only place where Orchestra reads Claude's OAuth token** (`src-tauri/src/usage_query.rs`).

What it reads: from `<account folder>/.credentials.json`, only two fields, `claudeAiOauth.accessToken` and `claudeAiOauth.expiresAt`.
The refresh token and everything else in the file are never deserialized. The account folder comes from the account list; it is
canonicalized, a relative path or one with `..` is refused, and the file must live directly inside that folder (a symlinked
`.credentials.json` pointing elsewhere is not followed). Files over 64 KB are refused.

What it does: one `GET https://api.anthropic.com/api/oauth/usage` per account, sequentially, with `Authorization: Bearer <token>`,
`anthropic-beta: oauth-2025-04-20`, `User-Agent: Orchestra/<version>`. TLS certificates are validated (rustls). Timeouts: 5 s connect,
10 s total. Redirects are never followed. The response is capped at 256 KB. Never more than one request per account per 60 s, even if
the UI asks more often; after a 429, a 5xx or a network failure that account is skipped for twice the interval (growing, max 30 min).
Only `https://api.anthropic.com/api/oauth/usage` is a valid destination. The only override, for tests, is
`ORCHESTRA_USAGE_URL`, and it is rejected unless it is plain `http://127.0.0.1:<port>/…` or `http://localhost:<port>/…`.

What it stores: the percentages and reset times of the 5 h and 7 d windows and up to 8 extra limits (kind, percent, reset time, model
display name, active flag; texts capped at 40 characters), in `quota\<account>.json` next to what the status line wrapper writes.

What it does **not** do:
- It never renews tokens: no refresh call, no use of the refresh token. If `expiresAt` is within 60 s or past, **no request is sent**
  and the account shows "Sign-in token expired; showing last data" until Claude Code itself refreshes the token (open Claude in that account).
- The token is never returned to the frontend, written to disk, logged or put in an error message. In Rust it lives in a wrapper type
  whose `Debug`/`Display` print `***`; the module has no print/log macros (a test reads the source to enforce it) and all error
  texts are fixed strings. The raw dump is the response body only (also with the token redacted if a server ever echoed it).
- It writes nothing to Claude's folders and changes no Claude setting. It writes only `quota\<account>.json` and `.query-raw.txt` in
  Orchestra's data folder. Importing a settings JSON can never switch the query on.

Risks you should weigh yourself:
- The endpoint is **undocumented**; it can change, return other shapes or stop working. The parser is tolerant and falls back to
  "unrecognized response" (look at `.query-raw.txt` to see what came back). Real endpoint: verified once by hand on 2026-11-06 for
  one Max account (HTTP 200; `five_hour` was `null`, `seven_day` and a `limits` list were present); nothing in the test suite calls it.
- Using an OAuth token outside Claude Code itself may fall under Anthropic's terms of service or usage policies. Orchestra makes no
  claim about that; it is your call.
- Any local process running as your user could already read the same file; this feature does not widen that, but it does make
  Orchestra a network client of Anthropic's API with that token.

Turn it off: the same switch (or *Reset section*). The polling stops immediately; nothing else needs cleaning up.

## SSH latency probe

`net_ping` only contacts `host:port` pairs of the user's own open SSH panes (stored Host, `~/.ssh/config` alias or the quick-connect
address): the frontend builds the list, the backend validates it (host charset, port 1–65535, at most 32 targets, 8 threads,
timeout clamped to 1–10 s). It opens a TCP connection and closes it **without sending a single byte** (a Rust test asserts that a
listener receives nothing), returns only a time or a generic error (`timeout` / `unreachable` / `invalid`) and logs nothing. Hosts
behind a jump host are never probed. Turn it off with *Latency badge* (polling stops at once).

## SSH auto-reconnect

Re-runs the pane's own, already-approved launch spec through the normal Restart path, so the host-key policy and askpass flow are
unchanged. It never reconnects after a clean exit (code 0), a short/never-established session, an authentication or host-key failure,
a user action (close, Restart, Cancel) or while the app is closing. The number of attempts is capped (default 8).

## Status bar metrics

The status bar reads only local, aggregate numbers through `sysinfo`: global CPU %, memory and swap totals, summed disk read/write and
network byte counters, uptime and the computer name. No process list, file name, address or packet content is read; nothing is stored,
logged or sent anywhere (no network code is involved). Sampling runs only while the bar is on and the window is visible. The usage
item reuses the quota data Orchestra already holds. There is no remote sampling unless you enable it per host (next section).

## Remote (server) metrics

Off by default; enabled per saved host in its dialog ("Show server metrics in the status bar"). It opens a SECOND, small, non-interactive SSH
connection to that server, shared by all panes of the host and kept while any SSH pane of it is open. Consequences the dialog states: it
counts toward `fail2ban` / `MaxSessions` limits, and it reuses the same saved credentials.

- **Host key never auto-accepted.** The monitor always runs with `StrictHostKeyChecking=yes` (never `no`, never `accept-new`, whatever the
  host's policy). A host whose key is not already in `known_hosts` fails with "host key not trusted yet: connect with a normal pane
  first" and does not retry; the monitor never writes `known_hosts`. Tests assert the argument list never contains `no`/`accept-new`.
- **Same vault and askpass.** With a saved password/passphrase the child gets only `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force` and the
  credential NAME (`ORCHESTRA_ASKPASS_KEY`), exactly as a normal pane; the secret is never in arguments or environment values
  (`BatchMode=no`, one prompt). Without a secret it runs with `BatchMode=yes`. Interactive logins (2FA, keyboard-interactive) are reported
  once as "needs interactive login" and are not retried, which also avoids lockout loops.
- **Fixed remote command, data only.** The remote command is the constant `sh -s`; the script comes from a constant in the binary (only a
  clamped integer 2-10 changes). Nothing the user or the server sends is ever interpolated into a command. What the server prints is
  data: parsed with a strict format, capped at 4 KB per line and 1 line per 500 ms, never executed and never rendered as HTML (the
  hostname is reduced to letters, digits and `. _ -`).
- **Hardening of the child.** Arguments are an array (no shell); host, user, jump host and identity path are validated (a leading `-` or
  whitespace is rejected); `ClearAllForwardings`, `ForwardAgent=no`, `ForwardX11=no`, `ControlPath=none`, `RemoteCommand=none`.
  The ssh process is killed when its last pane closes (10 s grace), when the window stays hidden over 60 s and when the app exits.
- **Reads only** the six `/proc` files listed in ARCHITECTURE.md (aggregate numbers); nothing is written on the server; no process list
  or file content is read. Linux only: other systems get "Remote metrics need a Linux server" and no other command is tried.

## Git branch chip

The chip runs the system `git` on local folders, read-only: only `status --porcelain=v2 --branch -z` and `rev-parse` are ever invoked, with a fixed argument
array (no shell, nothing from the terminal is concatenated into a command line). Safeguards: `--no-optional-locks` and `GIT_OPTIONAL_LOCKS=0` (never
takes the index lock, so it cannot disturb the user's own git commands), `-c core.fsmonitor=false` (a repository's config can name an fsmonitor
program, which would otherwise run on `status`), `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, inherited `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` removed, no
network command (no fetch, so ahead/behind reflect the last fetch), hooks do not run for these commands, stderr discarded, a hidden window, a 2 s hard
timeout that kills the process and a 1 MiB output cap. The folder comes from the shell's own OSC 9;9 / OSC 7 report or from the pane spec, so it is
untrusted terminal output: it is length-limited, must be a plain absolute path (no UNC, no `..`, no control characters, no leading `-`), and the Rust side
re-validates it (exists, is a directory, canonicalized) before use. A hostile repository can still be opened by `git status`, as with any prompt that
shows the branch; the main known vector (fsmonitor) is disabled. `safe.directory` is not overridden: repositories git considers unsafe simply show
no chip. Nothing is stored or sent anywhere; branch names live only in memory. The optional PowerShell prompt wrapper (`gitTrackFolder`) is a fixed
constant string without user input, applied only to plain PowerShell shell panes; it keeps the user's own `prompt` function and only appends an escape
sequence with the current folder.

## Subagent viewer (read-only)

`agent_transcript` only reads. The frontend sends a pane id and a subagent id, **never a path**. The backend looks the pane up in
the agents it is already tracking (set by `agent_scan` from `<config>/sessions/<pid>.json` + `projects/*/<session>.jsonl`), checks
the ids (`[A-Za-z0-9_-]{1,64}` for the subagent, a lowercase UUID for the session) and builds
`<proj>/<session>/subagents/agent-<id>.jsonl` itself. If the file exists it is canonicalized and must stay inside the `projects/`
folder (a symlink/junction leading out is refused). Reads are incremental and capped (256 KB / 200 events per call). Only reduced
events with truncated text are returned, never the raw lines. The drawer renders them as plain text (no `{@html}`, no markdown, no
`eval`); a test fails if `SubagentDrawer.svelte` ever contains one. Transcripts may contain secrets the agent saw (command output,
file contents); they are shown only in the local window and are not logged or sent anywhere.

## Auto-compact

Off by default. When enabled, Orchestra types `/compact` into an idle Claude prompt after you have been away. It never types
anything else and never when an agent is busy or waiting for permission.

## Resuming Claude sessions

With *Resume Claude conversations on restart* (on by default) a pane is relaunched with `claude --resume <id>`. The id comes from the
agent scan and from `state.json`, so both are treated as untrusted before reaching a command line: it must match `^[0-9a-f-]{36}$`
(checked in the frontend before it is put into the command, and again in the backend), otherwise a fresh `claude` starts. The new
command `claude_session_exists(dir, id)` only checks that `<dir>/projects/*/<id>.jsonl` **exists**; it never opens or reads the
transcript or any credential file. `dir` must be the folder of an account saved in `state.json` (same rule as `open_account_dir`), so the
interface cannot make the backend look at arbitrary paths, and an id with `..` or separators is rejected before touching the disk.

## Full backup (export / import everything)

The backup file is plain JSON in a place you choose, so it is built from allow-lists and contains **no secrets**: no SSH passwords or
passphrases (they stay in Windows Credential Manager; the `hasPassword` / `hasPassphrase` flags and the vault entry name
`ORCHESTRA_ASKPASS_KEY` are dropped too), nothing from the Claude/Codex account folders (tokens, `.credentials.json`, `.claude.json`),
no usage-query flag or token, and no live pane state (`lastSession`). Keys whose name looks like a secret are scrubbed as a second layer.
On the new computer you enter the passwords again and sign in to each agent again.

A file you import is **untrusted data**, because pane specs are executed when the panes launch. Before anything changes, the file is
parsed and checked: size <= 5 MB, `app` and `format` (a newer format is refused), list sizes, and every pane spec (program string, args
`string[]`, cwd string, env map of strings, unknown keys dropped, absurd sizes reject the pane). Host destinations that start with `-`
or contain spaces are rejected (they would be read by `ssh` as options), host/account/workspace ids are restricted to simple characters,
and `ORCHESTRA_ASKPASS_KEY` is never taken from a file (it would let a file point a pane at another host's saved secret; panes of a vault
host get their spec rebuilt from the host at load time anyway). Settings go through `clampSettings`; `usageQuery` is never imported.
The summary shows a warning while *Workspaces* is ticked (and when hosts carry a remote command or jump host): only import backups you
made yourself. *Replace* needs the usual second click.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting (Security tab of the repository → *Report a vulnerability*). Please do not file public
issues for security problems. See [../SECURITY.md](../SECURITY.md).
