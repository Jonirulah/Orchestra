# Changelog

All notable changes to Orchestra are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project follows [Semantic Versioning](https://semver.org/) (0.x: anything may change between minor versions).

## [Unreleased]

## [0.4.1] - 2026-11-10

### Added
- **Letter spacing** for the terminal (Settings → Terminal), from -2 to +8 px.

### Fixed
- **Installed fonts missing from the font list**: it only offered a fixed set of 22 fonts, so any other font you installed
  (Asterisk Mono, for example) never showed up. It now lists every installed font, monospaced ones first (measured, not taken
  from the font's own flag, which is often wrong), then the rest. A font installed while Orchestra is open is shown apart with a
  note: Windows only hands new fonts to Orchestra when it starts, so quit it from the tray and open it again.

## [0.4.0] - 2026-11-07

### Added
- **Automatic updates** from the GitHub releases (installed version): checks at startup and every 6 hours, shows a notice in the
  top bar with the release notes, and *Update* downloads the installer, verifies its signature, installs it and restarts
  Orchestra, warning first if agents are working or SSH sessions are open. Settings → General: turn the automatic check off or
  *Check now*. The portable exe only offers to open the download page.
- **MCP view** (top bar → MCP): one table with every MCP server of every account (Claude user and local scopes, Codex, opencode).
  Test servers and see their tools or why they fail; install one in several accounts at once from a form or a command pasted from a
  README; compare two versions of the same server and make the others equal to one; remove it; approve, turn on or sign in where an
  account needs it. Every change shows the exact edit first and the last one can be undone. Each server shows roughly how many
  tokens its tool definitions add to every session.
- **Consumption view** (top bar → Consumption): where Claude Code tokens go, computed locally from the transcripts, by period
  (today, 7 or 30 days), session, project, model and subagent, in input-token equivalents or estimated USD. A drawer per pane shows
  the current session. Advice cards rank the biggest wastes with the saving as "before → after" and the assumption behind it.
- **Copy report for your AI**: a Markdown summary of the consumption analysis to paste into a chat, also available to agents as the
  read-only MCP tool **`usage_report`**.
- **Paste images into terminals**: `Ctrl+V` / right click with an image in the clipboard, or drop image files on a pane. Local
  panes get the path of a PNG saved in a cache folder (cleaned after 24 hours, 25 MB limit); SSH panes upload it to
  `~/.cache/orchestra-paste/` on the server first and get the remote path.
- **Reliable copy**: copying goes through the system clipboard (Rust, with the browser API as fallback) and always shows a
  *Copied (N)* notice or the error. Works in apps that capture the mouse (hold `Shift` to select; a hint says so), with right
  click on a selection, and with OSC 52 sent by remote apps (write only, 1 MiB limit).
- **Visible SSH reconnection**: a dropped pane is veiled with its state (reconnecting, attempt N, countdown; or gave up and why:
  login rejected, host key, refused, timeout, unreachable) with *Restart* / *Close*, and a separator in the terminal marks when it
  came back and how long it was down.
- **Need attention**: `Ctrl+Shift+A` jumps to the next agent waiting for you, across tabs; a sidebar block lists them all. When the
  window is not in front, Orchestra flashes the taskbar and can show a Windows notification.
- **Files drawer (SFTP)** per SSH host: browse, filter, hidden files, upload (button or drop), download, new folder, rename, delete,
  with progress and cancel. Own SFTP v3 client over the same `ssh.exe` (keys, vault, jump host, strict host-key checking).
- **Port forwarding**: ports announced in an SSH pane's output (for example a dev server on `localhost:3000`) offer *Forward* /
  *Open in browser* / *Ignore*; the ports chip lists tunnels (open, copy URL, keep for every connection, stop). One `ssh -N` per
  tunnel bound to `127.0.0.1`, reconnects with backoff and keeps the same local port; another one is picked if it is busy.
- Release tooling: `scripts/release.mjs` (version bump, signed build, `latest.json`, the `gh release create` line),
  `bump-version.mjs` and `latest-json.mjs` with tests; process in `docs/dev-notes/actualizaciones.md`.

### Fixed
- `Ctrl+Shift+C` with nothing selected no longer empties the clipboard, and copy errors are no longer silently lost.
- Auto-compact no longer types `/compact` over a prompt that has unsent text, and Settings → Agents now explains why it is not
  acting on each running agent.

### Known limitations / not yet tested on real hardware
- 0.2.0 and 0.3.0 do not include the updater: install 0.4.0 by hand once; from then on updates are offered automatically.
- Tested with unit tests, fake servers, a local sshd and the browser demo, but not yet in the real window against real servers:
  the Files drawer (SFTP) from the interface, port-forwarding tunnels in the app window, uploading a pasted image over SSH, a
  real network drop during reconnection, the Windows notification and taskbar flash, and Codex with these features.
- If Orchestra is killed abruptly (crash, Task Manager), the helper `ssh` processes of tunnels, SFTP and server metrics can be left
  running.
- Clicking the Windows notification does not focus the pane. Uploads over SFTP with Windows' `ssh.exe` are slow (about 12 MB/s).

## [0.3.0] - 2026-11-07

### Added
- **Usage history** in the status bar: a chart button next to the host name opens the last 60 minutes (or as long as the app has
  been open) of CPU, RAM and swap, network and disk, with current, max and average values and a shared cursor. Samples are taken
  every 5 s in the background while the status bar is on; gaps are shown as gaps. On an SSH pane with server metrics enabled it
  shows the server's history.
- **SSH host folders and ordering**: drag hosts within and between folders, drag folders, or use Alt+↑/↓ and the context menu.
  Sort by manual order or name A-Z. Folders can be created, renamed, collapsed (remembered) and deleted (their hosts move to
  "No folder"). The host dialog suggests existing folders.
- **Saved workspaces**: right-click a tab to rename (also F2 or double-click), duplicate, save, close or close the others. Saved
  workspaces keep the grid and how each pane starts (folder, command, host, account), never secrets or terminal output, and can be
  opened, renamed, overwritten or deleted from the button next to "+" and from the command palette. Claude panes start a new
  conversation when a saved workspace is opened. Included in the full backup.
- **Agent card**: hovering an active agent for a moment shows its model, state and for how long, context use against the model
  window, cache time left, current tool, your last prompt, todos, subagents and session totals. Delay configurable in Settings →
  Agents, can be turned off.
- **Notification sounds** (synthesised, no audio files) when an agent needs attention or finishes, with choice of sound and volume.

## [0.2.0] - 2026-11-07

### Added
- MCP tool **`run_command`**: agents can run one command on a saved SSH host and get stdout, stderr, exit code, a `truncated` flag
  and the duration back. It follows the host's agent access level: `read` refuses (naming the mode), `ask` shows a dialog with the
  host and the exact command and runs only if you approve (denied or unanswered after 120 s means it does not run), `full` runs
  directly. Default timeout 60 s (max 600 s, then `ssh` is killed), output capped at 64 KB per stream, host keys are never accepted
  automatically, credentials never leave the vault or appear in results.
- Every `run_command` attempt, including refused ones, is written to the MCP audit log (time, host, mode, decision, command, exit
  code, duration, first 2 KB of output). Settings → MCP shows the command and the decision.
- English and Spanish text for the approval dialog and the new access level descriptions.

### Changed
- The MCP server is no longer read-only: its instructions and tool descriptions say so, and tell the model that command output is
  untrusted data. Host access levels `ask` and `full` now mean what their labels say.
- For hosts at `ask`/`full` the interface now also sends the local backend the key path, jump host and vault entry name needed to
  start `ssh`. They are never returned over MCP.

## [0.1.0] - 2026-11-07

First public release. Windows 10/11 only. Distributed as a portable `Orchestra.exe` and a per-user NSIS installer
(`Orchestra_0.1.0_x64-setup.exe`, English / Spanish). The binaries are not code-signed.

### Terminals and layouts
- Adjustable grid with draggable aligned splitters, workspaces, maximize, in-pane search, drag and drop.
- Real PTYs (ConPTY) owned by the Rust backend: closing the window hides Orchestra to the tray and keeps processes running;
  output is buffered (2 MiB per terminal) and replayed.
- Automatic detection of PowerShell, cmd, Git Bash and WSL distributions.
- Context menus, command palette, 21 built-in color themes, theme import (Windows Terminal, iTerm2, Alacritty, Orchestra JSON) and
  export, fonts, cursor, scrollback, accent color, notifications.

### SSH
- Host list with groups, tags, jump host, optional tmux persistence, `~/.ssh/config` import and quick connect.
- Vault: passwords and key passphrases in the Windows Credential Manager, delivered to `ssh.exe` through an `SSH_ASKPASS` helper.
- Host-key policy (confirm new host keys, or trust on first use) with per-host override.
- SSH key manager (list, generate ed25519, copy public key, install on a server).
- Auto-reconnect with backoff and a latency badge in every SSH pane (both on by default, fully adjustable).
- Optional per-host server metrics (Linux) in the status bar over a second SSH connection.

### AI agents
- Claude accounts (one config folder per subscription), Codex accounts (`CODEX_HOME`) and opencode accounts, with sign-in and
  sign-in check from inside Orchestra; sidebar accounts can be filtered, grouped by provider and sorted.
- Account chosen per terminal; Claude conversations resume after a restart.
- Active-agents tree (status, tool, context size, cache countdown, tasks, subagents, tokens) and a read-only live subagent viewer.
- Usage bars (5 h and 7 d) captured from Claude Code's status line; optional, opt-in usage query to Anthropic.
- Account selection policies and experimental auto-compact while away.
- Local MCP server (read-only) exposing the hosts and terminals you allow, with an audit log.

### Status bar and git
- Status bar with local metrics, agent counts and Claude usage; per-tab item lists; context items that follow the focused pane.
- Git branch chip in local panes (changes, ahead / behind, conflicts, operation in progress), read-only.

### Data
- Full backup: export / import of settings, hosts, accounts, themes and workspaces (no secrets), merge or replace.
- State in `%APPDATA%\dev.orchestra.app\`, overridable with `ORCHESTRA_DATA_DIR`.
- Interface in English and Spanish.

### Known limitations
- Real SSH drop reconnect, server metrics against real servers and the installer on a clean machine have not been verified in the
  field; CI has not run yet. No SFTP, no MCP write access. See the README for the full list.

[0.1.0]: ../../releases/tag/v0.1.0
