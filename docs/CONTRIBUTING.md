# Contributing to Orchestra

Thanks for helping. Orchestra is a small project with one maintainer ([@jonirulah](https://github.com/Jonirulah)), so small,
focused pull requests with a clear description are the easiest to review. For a big change, open an issue first so we can agree on
the direction.

By contributing you agree that your work is released under the [MIT license](../LICENSE).

## Setup

Requirements: Windows 10/11, Node.js 20.19+ or 22.12+ (CI uses 22), Rust stable with the MSVC toolchain, and the WebView2 runtime.

```powershell
git clone <your fork>
cd Orchestra
npm install
npm run tauri dev          # the real app, hot reload
npm run dev                # UI only, in a browser, demo mode with fake data (http://127.0.0.1:1420/)
```

Demo mode (`src/lib/backend.ts` returns fake data when Tauri is absent) is the fastest way to work on the UI. It cannot exercise PTYs,
SSH, the vault or the MCP server; use `npm run tauri dev` for those.

Low on disk space on `C:`? Point the caches elsewhere before building, for example
`$env:CARGO_HOME='D:\cache\cargo'; $env:npm_config_cache='D:\cache\npm'` (optionally `CARGO_TARGET_DIR` too).

To try the real app without touching your own data, set `ORCHESTRA_DATA_DIR` to an empty folder (and `WEBVIEW2_USER_DATA_FOLDER` to
another one) before starting it. Changing `APPDATA` does not isolate anything: Tauri asks Windows for the folder. The MCP server
prefers port 47821, so two instances cannot both have it.

## Scripts and checks

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on port 1420 (demo mode in a browser) |
| `npm run build` | Build the web UI into `dist/` |
| `npm run tauri dev` | Run the desktop app with hot reload |
| `npx tauri build --debug --no-bundle` | Debug executable without installer |
| `npx tauri build --bundles nsis` | Release build and NSIS installer |
| `npm run check` | `svelte-check`: TypeScript and Svelte types (a missing Spanish key is a type error) |
| `npm test` | `node --test` over `src/lib/*.test.ts` and `scripts/*.test.mjs` |
| `npm run i18n:check` | Dictionary parity, unused or undefined keys, hard-coded text heuristic ([i18n.md](i18n.md)) |
| `cd src-tauri; cargo test` | Rust unit and integration tests (real ConPTY, loopback HTTP, parsers, security checks) |

Run `npm run check`, `npm test`, `npm run i18n:check` and `cargo test` before opening a pull request; CI runs the
first two, `npm run build` and `cargo test`. Some Rust tests are `#[ignore]`d because they need real software (a real sshd, the
real `codex` / `opencode` binaries, live Claude sessions); run them by hand with `cargo test <name> -- --ignored` when you touch that
area, and say so in the PR. If `cargo test` fails because `orchestra.exe` is running and locked, use another target folder:
`$env:CARGO_TARGET_DIR='D:\cache\orchestra-target'`.

`npm run i18n:check` reports hard-coded text as warnings; keep the count from growing (`--strict` makes them fail).

## Code conventions

- **Files:** UTF-8 without BOM, **LF** line endings. Do not commit Latin-1 or CRLF files (set `git config core.autocrlf input` on
  Windows). Spanish text in comments must be valid UTF-8.
- **Where logic goes:** pure logic (settings, policies, parsers, formatting, decisions) lives in `src/lib/*.ts`, with no Svelte and no
  Tauri imports, so it can be tested with `node --test` and no DOM. Components stay thin. The Rust backend stays thin as well: it
  owns processes and files, the frontend owns the state.
- **Strings and i18n:** no hard-coded user-visible text. Every string is a key in `src/lib/locales/en/<area>.ts` **and**
  `src/lib/locales/es/<area>.ts` with identical `{vars}`. Key shape `area.component.thing`; no string concatenation; no plurals
  inside keys. Details: [i18n.md](i18n.md). Documentation is in English; code comments may be in Spanish or English.
- **Settings:** new settings go through `src/lib/settings.ts` (type, default, validation and clamping). Imported data is untrusted.
- **Tests:** write tests with a *planted-bug mindset*: a test that cannot fail proves nothing. For anything security-relevant, plant
  the bug (break the check on purpose), confirm that the test fails, then restore the code. Cover the negative case (what must *not*
  happen) as well as the happy path. Tests for pure modules sit next to them as `src/lib/<name>.test.ts`.
- **Security rules** (full model in [SECURITY.md](SECURITY.md)):
  - Secrets (SSH passwords, passphrases, tokens) never go to `state.json`, logs, command-line arguments, environment values,
    backups, error messages or any command's return value. Only the vault entry *name* travels.
  - Run child processes with an argument array, never through a shell string; validate anything that could be read as an option
    (a leading `-`, whitespace).
  - Treat files the user imports, terminal output, server output and agent transcripts as data: validate, cap sizes, never
    execute or render as HTML.
  - The usage query is the only code that reads a Claude OAuth token, and the only outbound request besides SSH. Do not add
    another network call without discussing it first.
  - No telemetry.
- **Commits and PRs:** small, one topic each, with the reason in the message. Update [CHANGELOG.md](../CHANGELOG.md) for
  user-visible changes and the relevant `docs/` page (and `README.md` / `README.es.md` when a feature or limitation changes).

## Project layout

```
src/                 Svelte 5 app (components/) and pure TypeScript (lib/)
src/lib/locales/     en/ (base) and es/ dictionaries, one file per area
src-tauri/src/       Rust backend (pty, ssh helpers, vault, agents, quota, usage_query, mcp, git, metrics ...)
src-tauri/tests/     Rust integration tests
scripts/             i18n checker and its tests
docs/                Documentation (see docs/README.md)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together.

## Reporting bugs and vulnerabilities

Bugs and feature requests go through the issue templates. Security problems do **not**: follow [../SECURITY.md](../SECURITY.md).
