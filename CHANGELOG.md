# Changelog

All notable changes to Orchestra are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project follows [Semantic Versioning](https://semver.org/) (0.x: anything may change between minor versions).

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
