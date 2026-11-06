// Git info for the pane header: pure helpers (no Svelte, no Tauri), tested with node --test.
//  - OSC 9;9 / OSC 7 parsing (the shell tells the terminal its current folder)
//  - the PowerShell prompt wrapper that emits OSC 9;9
//  - chip text / level / tooltip data / truncation

export interface GitInfo {
  repoRoot: string;
  /** Branch name; when detached, the short commit id. */
  branch: string | null;
  detached: boolean;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
  dirtyCount: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  worktree: boolean;
  inProgress: string | null;
}

export const MAX_CWD_LEN = 1024;
const WIN_DRIVE = /^[A-Za-z]:[\\/]/;

/** A folder reported by the shell is accepted only when it is a plain absolute path. Returns the normalized path or null. */
export function normalizeCwd(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p || p.length > MAX_CWD_LEN) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return null;
  if (p.startsWith('-')) return null;
  // Strip the quotes some shells put around the path.
  if (p.length >= 2 && p[0] === '"' && p[p.length - 1] === '"') p = p.slice(1, -1);
  if (WIN_DRIVE.test(p)) {
    // C:\a\b or C:/a/b -> C:\a\b, drive letter upper-case, no trailing slash (except the root).
    let q = p.replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
    if (q.length > 3) q = q.replace(/\\+$/, '');
    if (q.split('\\').some((s) => s === '..')) return null;
    return q[0].toUpperCase() + q.slice(1);
  }
  // UNC (\\server\share): not supported (git over the network is slow), reject.
  if (p.startsWith('\\\\') || p.startsWith('//')) return null;
  // Drive-less Windows-style relative or other garbage.
  if (p.includes('\\')) return null;
  if (p.startsWith('/')) {
    if (p.split('/').some((s) => s === '..')) return null;
    return p.length > 1 ? p.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/' : p;
  }
  return null;
}

/** OSC 9;9;<path> (ConEmu / Windows Terminal). `data` is what follows `9;`, i.e. `9;<path>`. */
export function parseOsc9(data: string): string | null {
  if (!data.startsWith('9;')) return null;
  return normalizeCwd(data.slice(2));
}

/** OSC 7 file://host/path (bash, zsh, WSL, many others). Percent-decoded; `/C:/x` becomes `C:\x`. */
export function parseOsc7(data: string): string | null {
  if (typeof data !== 'string' || data.length > MAX_CWD_LEN * 3 + 64) return null;
  const m = /^file:\/\/([^/]*)(\/.*)$/i.exec(data.trim());
  if (!m) return null;
  let path: string;
  try { path = decodeURIComponent(m[2]); } catch { return null; }
  // A host other than empty/localhost means a remote machine's folder: not ours to run git in.
  const host = m[1].toLowerCase();
  if (host && host !== 'localhost' && !/^[a-z0-9._-]+$/.test(host)) return null;
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  return normalizeCwd(path);
}

/** Does the path look like a Windows one? (git_info runs on the local Windows machine; WSL paths such as /home/x can't be used.) */
export function isLocalUsable(p: string, platformWindows = true): boolean {
  return platformWindows ? WIN_DRIVE.test(p) : p.startsWith('/');
}

// ---------- PowerShell prompt wrapper ----------

const PS_PROGRAM = /(^|[\\/])(powershell|pwsh)(\.exe)?$/i;

/**
 * Prompt wrapper: keeps the user's own `prompt` function and appends an OSC 9;9 with the current folder.
 * Written in one line so it survives `-Command`. Only FileSystem locations are reported.
 */
export const PS_WRAPPER =
  "$global:__orchPrompt = $function:prompt; " +
  "function global:prompt { " +
  "$p = $(if ($global:__orchPrompt) { & $global:__orchPrompt } else { 'PS ' + $executionContext.SessionState.Path.CurrentLocation + '> ' }); " +
  "if ($executionContext.SessionState.Path.CurrentLocation.Provider.Name -eq 'FileSystem') { " +
  "$p + [char]27 + ']9;9;' + $executionContext.SessionState.Path.CurrentLocation.ProviderPath + [char]7 } else { $p } }";

interface SpecLike { program: string; args: string[]; cwd?: string; env?: Record<string, string> }

/**
 * Adds the folder-reporting wrapper to a PowerShell shell pane. Only when the pane has NO custom args beyond
 * -NoLogo (agents, login flows, `-Command ...` and SSH keep their exact command line).
 */
export function withCwdTracking<S extends SpecLike>(spec: S, enabled: boolean, kind?: string): S {
  if (!enabled) return spec;
  if (kind && kind !== 'shell') return spec;
  if (!PS_PROGRAM.test(spec.program)) return spec;
  const args = spec.args.filter((a) => a.toLowerCase() !== '-nologo');
  if (args.length > 0) return spec;
  return { ...spec, args: ['-NoLogo', '-NoExit', '-Command', PS_WRAPPER] };
}

// ---------- chip ----------

export type GitLevel = 'clean' | 'dirty' | 'bad';

export function truncateBranch(name: string, max = 22): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  return chars.slice(0, max - 1).join('') + '…';
}

export function gitLevel(g: GitInfo): GitLevel {
  if (g.conflicts > 0 || g.inProgress) return 'bad';
  if (g.dirtyCount + g.untracked > 0) return 'dirty';
  return 'clean';
}

export interface ChipText {
  name: string;
  /** Pieces for the chip in order; empty ones are left out. */
  changes: string;
  ahead: string;
  behind: string;
}

/** Texts shown in the chip: `±3`, `↑2`, `↓1`. `counts` = the "show change counts" setting. */
export function chipText(g: GitInfo, counts = true, maxName = 22): ChipText {
  const n = g.dirtyCount + g.untracked;
  return {
    name: truncateBranch(g.branch ?? '?', maxName),
    changes: counts && n > 0 ? `±${n}` : '',
    ahead: g.ahead > 0 ? `↑${g.ahead}` : '',
    behind: g.behind > 0 ? `↓${g.behind}` : '',
  };
}

/** Folder to ask git about: the shell's own report, else the agent's folder (from the session scan), else the pane's start folder. */
export function cwdForPane(reported: string | undefined, agentCwd: string | undefined, specCwd: string | undefined): string | undefined {
  for (const c of [reported, agentCwd, specCwd]) {
    const n = c ? normalizeCwd(c) : null;
    if (n && isLocalUsable(n)) return n;
  }
  return undefined;
}

/** Equality used to avoid re-rendering when nothing changed. */
export function sameGit(a: GitInfo | null | undefined, b: GitInfo | null | undefined): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}
