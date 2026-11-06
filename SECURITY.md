# Security policy

## Supported versions

Only the latest release receives security fixes. Orchestra is currently at 0.1.x.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's **private vulnerability reporting**: on the repository page open the **Security** tab and choose **Report a
vulnerability** (a private security advisory). Include the Orchestra version (Settings → Data), what you did, what you expected and
what happened, and a proof of concept if you have one. Do not include real passwords, tokens or private keys.

This is a one-person project, so please be patient; the maintainer will acknowledge the report as soon as possible, work on a fix
and credit you in the release notes if you wish.

## What is in scope

Anything in this repository that could expose secrets (SSH passwords and passphrases, Claude / Codex / opencode credentials, the MCP
token), run commands or read files the user did not intend, or make Orchestra talk to an unexpected host. The local MCP server, the
SSH askpass helper, backup import and the opt-in usage query are the most sensitive parts.

## Security model

How Orchestra stores data, what it protects and what it deliberately does not is described in
[docs/SECURITY.md](docs/SECURITY.md). In short: no telemetry, no secrets in the state file or in backups, secrets live in the
Windows Credential Manager, the MCP server listens on `127.0.0.1` only, and the only outbound request besides SSH is the opt-in
usage query.
