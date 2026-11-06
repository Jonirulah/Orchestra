# State: git branch chip in pane headers (phase 1, local panes)

## Done
- `src-tauri/src/git.rs` (new): `git_info(cwd)`, `git_available()`; registered in main.rs. Pure parts: `validate_cwd`, `run_capped` (timeout kill + output cap),
  `parse_status` (porcelain v2 -z), `parse_revparse`, `is_linked_worktree`, `detect_in_progress`.
- `src/lib/gitinfo.ts` (new, pure): OSC 9;9 / OSC 7 parsing, `withCwdTracking` + `PS_WRAPPER`, chip text/level/truncate, `cwdForPane`.
- `src/lib/gitstate.svelte.ts` (new): reactive `gitState.byPane`. `GitChip.svelte`, `SettingsGit.svelte` (new). Locales `git.ts` en+es (area `git`).
- Shared files, tiny edits: PaneView (1 import + 1 line), terminals.ts (optional hooks `onCwd`/`trackFolder`, `registerCwdOsc`, `spawnArgs`), store.svelte.ts
  (`LiveInfo.cwd`, 2 hook lines), settings.ts (4 settings `gitChip/gitCounts/gitIntervalSec[2..30]/gitTrackFolder`, in the terminal section), backend.ts
  (gitInfo/gitAvailable + demo + demo OSC), AgentTree (branch in sub-line), SettingsTerminal (`<SettingsGit />`), locales index en/es, docs/i18n.md area list.
- Docs: README, ARCHITECTURE (new section), SECURITY (new section).

## Decision: folder tracking
Prompt wrapper (not Rust PEB polling): documented, user-visible, cheap, falls back to the start folder; PEB reads need undocumented structs + VM-read handle and
only see the shell process. Wrapper is applied only to plain PowerShell shell panes (args = `-NoLogo` only), never mutates the saved spec, keeps the user's `prompt`.

## Verified
- `cargo test --bin orchestra`: 224 pass, 0 fail (10 new in git::, plus 1 `#[ignore]` probe `probe_from_env`). `npm run check`: 0 errors / 0 warnings.
  `npm test`: 412 pass (14 new in gitinfo.test.ts incl. settings). `npm run i18n:check`: OK.
- Real git_info (probe): <repo> -> branch master, untracked 14, clean otherwise (read-only). Temp repos (deleted): work -> main, ahead 1, dirty 1, unstaged 1,
  untracked 1; wt -> worktree true, branch other; det -> detached, branch = 7-char sha; conf -> conflicts 1, inProgress "merge"; plain dir -> null;
  `-C` / relative / file path -> rejected with clear messages.
- Real PowerShell 5.1 with the exact wrapper: prompt output `PS <repo>> ESC]9;9;<repo> BEL`; a user-defined prompt (`MYPROMPT> `) is kept;
  a registry location (HKCU:) emits no OSC.
- Demo (Vite, headless Chrome): chip renders `feature/git-branch-in-… ±4 ↑2 ↓1` (amber dot), reached via the real xterm OSC 9;9 handler from the demo shell;
  click -> toast "Copied branch name: ..."; sidebar sub-line shows the branch; Settings -> Terminal shows the Git card (4 rows verified through the DOM).
  Screenshots: scratchpad `git-1-headers.png`, `git-2-settings.png` (the Git card is only half visible in the second).

## Planted bugs (each confirmed red, restored, `cmp` identical)
| Plant | Result |
|---|---|
| P1 `validate_cwd` accepts leading dash (check disabled) | FAIL `cwd_validation` |
| P2 porcelain ahead/behind swapped | FAIL `parses_branch_headers_and_ahead_behind`, `real_repo_states` |
| P3 OSC 7 percent-decoding skipped | FAIL 2 tests (`OSC 7` x2) |
| P4 timeout not enforced | FAIL `timeout_kills_the_child` (took 20.9 s: child ran to its end) |
| P5 wrapper added to custom-arg panes | FAIL `withCwdTracking only touches plain...` |
| P6 in-progress state not "bad" | FAIL `gitLevel` |

## Pending / not verified
- NOT verified in the real exe: OSC 9;9 emitted by a real PowerShell prompt reaching the xterm handler inside Tauri (parts verified separately: wrapper output with
  real powershell.exe, handler in the browser demo with a synthetic OSC). Also not run: the Tauri app, `tauri build`.
- SSH panes: nothing (design ready). Command Palette: no per-pane entries exist, so the branch is not added.
- Cache is per folder (not per repo root). WSL / Git Bash `bash` panes report no folder unless the user configures OSC 7; a WSL path is ignored (Windows git cannot use it).
- Wrapper applies to panes opened after the setting changes (spawn time). Other agents' unfinished work (`subtranscript`) once broke the cargo build briefly; resolved by itself.
- Chip may shrink the pane title in narrow panes (gname has min-width 7ch).
