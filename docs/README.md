# Documentation

Start with the [README](../README.md) ([en español](../README.es.md)). The rest, by audience:

## For users

| Document | What it covers |
|---|---|
| [USER_GUIDE.md](USER_GUIDE.md) | Task-oriented recipes: accounts, SSH and the vault, status bar, git chip, subagent viewer, usage bars, themes, backup and restore, troubleshooting. |
| [SECURITY.md](SECURITY.md) | The security and privacy model, feature by feature: what is stored where, what never leaves the machine, what each helper can and cannot do. |
| [../CHANGELOG.md](../CHANGELOG.md) | What changed in each release. |

## For contributors

| Document | What it covers |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, scripts, test commands, code and security conventions. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the app is built: terminals, accounts, agents, usage, MCP, vault, status bar, tests, directory map. |
| [i18n.md](i18n.md) | Internationalization: how dictionaries work, adding a string or a language, naming and writing rules, checks. |
| [../SECURITY.md](../SECURITY.md) | How to report a vulnerability. |

## Internal working notes (Spanish)

These files are the maintainer's own working notes. They are kept for history and are **not** documentation: they are written in
Spanish, may describe superseded intermediate states, and mention local paths and test machines. For how things work, read
[ARCHITECTURE.md](ARCHITECTURE.md) instead.

| Document | What it is |
|---|---|
| [DISENO.md](DISENO.md) | Original design decisions and roadmap (Spanish). |
| [dev-notes/](dev-notes/) | One status file per feature, written while building it: what was done, how it was verified, what was pending (Spanish). Index in [dev-notes/README.md](dev-notes/README.md). |

## Screenshots

[screenshots/](screenshots/) holds the images used by the README and the guide. They are taken in the built-in demo mode
(`npm run dev`, fake data only).
