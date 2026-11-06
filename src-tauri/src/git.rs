//! Read-only git status for the pane header (branch, ahead/behind, change counts).
//!
//! Security model (see docs/SECURITY.md): the system `git` is run with a fixed argument array (no shell),
//! `-C <validated cwd>`, `--no-optional-locks`, `core.fsmonitor=false` (a repo config could otherwise name a
//! program to run), no network, no prompts, a hard timeout and an output cap. Only `status` and `rev-parse` are
//! ever invoked; git hooks do not run for those commands.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

const TIMEOUT: Duration = Duration::from_millis(2000);
const OUTPUT_CAP: usize = 1 << 20; // 1 MiB of `status` output is already a hopeless repo
const CACHE_TTL: Duration = Duration::from_millis(1500);
const MAX_CWD_LEN: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub repo_root: String,
    /// Branch name; when detached, the short commit id; `None` only for an unborn detached state.
    pub branch: Option<String>,
    pub detached: bool,
    pub has_upstream: bool,
    pub ahead: u32,
    pub behind: u32,
    /// Tracked files with any change (staged, unstaged or conflicted), each file counted once.
    pub dirty_count: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicts: u32,
    /// A linked worktree (not the main one).
    pub worktree: bool,
    /// `rebase` | `merge` | `cherry-pick` | `revert` | `bisect`.
    pub in_progress: Option<String>,
}

// ---------- cwd validation ----------

/// Checks that `cwd` is something safe to hand to `git -C`: a non-empty, short, absolute path of an existing
/// directory that does not look like an option. Returns the canonical path (without the `\\?\` prefix).
pub fn validate_cwd(cwd: &str) -> Result<PathBuf, String> {
    if cwd.is_empty() {
        return Err("cwd is empty".into());
    }
    if cwd.len() > MAX_CWD_LEN {
        return Err("cwd is too long".into());
    }
    if cwd.contains('\0') {
        return Err("cwd contains a NUL byte".into());
    }
    if cwd.starts_with('-') {
        return Err("cwd must not start with '-'".into());
    }
    let p = Path::new(cwd);
    if !p.is_absolute() {
        return Err("cwd must be an absolute path".into());
    }
    let canon = std::fs::canonicalize(p).map_err(|_| "cwd does not exist".to_string())?;
    if !canon.is_dir() {
        return Err("cwd is not a directory".into());
    }
    Ok(strip_verbatim(canon))
}

/// `\\?\C:\x` -> `C:\x` (git handles the plain form better); `\\?\UNC\...` is kept as it is.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if !rest.starts_with("UNC\\") {
            return PathBuf::from(rest);
        }
    }
    p
}

// ---------- running a child with a deadline ----------

#[derive(Debug, PartialEq, Eq)]
pub enum RunError {
    Spawn(String),
    Timeout,
    TooMuchOutput,
    Failed(Option<i32>),
}

/// Runs `cmd` (stdout piped, stderr discarded), killing it after `timeout` or when stdout exceeds `cap` bytes.
pub fn run_capped(mut cmd: Command, timeout: Duration, cap: usize) -> Result<Vec<u8>, RunError> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| RunError::Spawn(e.to_string()))?;
    let mut out = child.stdout.take().ok_or_else(|| RunError::Spawn("no stdout".into()))?;
    let (tx, rx) = std::sync::mpsc::channel::<(Vec<u8>, bool)>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        let mut over = false;
        loop {
            match out.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if buf.len() + n > cap {
                        over = true;
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
            }
        }
        let _ = tx.send((buf, over));
    });
    let deadline = Instant::now() + timeout;
    let mut early: Option<(Vec<u8>, bool)> = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                return Err(RunError::Spawn(e.to_string()));
            }
        }
        // The reader gives up on its own when the cap is exceeded: stop the child then too.
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(RunError::Timeout);
        }
        if early.is_none() {
            early = rx.try_recv().ok();
        }
        if matches!(early, Some((_, true))) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(RunError::TooMuchOutput);
        }
        std::thread::sleep(Duration::from_millis(8));
    };
    let remain = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(200));
    let (buf, over) = match early {
        Some(r) => r,
        None => rx.recv_timeout(remain).map_err(|_| RunError::Timeout)?,
    };
    if over {
        return Err(RunError::TooMuchOutput);
    }
    if !status.success() {
        return Err(RunError::Failed(status.code()));
    }
    Ok(buf)
}

fn git_cmd(cwd: &Path) -> Command {
    let mut c = Command::new("git");
    c.arg("--no-optional-locks")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("status.submoduleSummary=false")
        .arg("-C")
        .arg(cwd);
    c.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .env("GIT_PAGER", "cat");
    for k in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"] {
        c.env_remove(k);
    }
    c
}

// ---------- parsing ----------

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Status {
    pub oid: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub has_upstream: bool,
    pub ahead: u32,
    pub behind: u32,
    pub dirty_count: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicts: u32,
}

/// Parses `git status --porcelain=v2 --branch -z` (records separated by NUL).
pub fn parse_status(raw: &[u8]) -> Status {
    let text = String::from_utf8_lossy(raw);
    let mut st = Status::default();
    let mut recs = text.split('\0');
    while let Some(rec) = recs.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(h) = rec.strip_prefix("# ") {
            let (k, v) = h.split_once(' ').unwrap_or((h, ""));
            match k {
                "branch.oid" => st.oid = (v != "(initial)").then(|| v.to_string()),
                "branch.head" => {
                    if v == "(detached)" {
                        st.detached = true;
                    } else {
                        st.head = Some(v.to_string());
                    }
                }
                "branch.upstream" => st.has_upstream = true,
                "branch.ab" => {
                    // "+A -B": A commits ahead, B behind.
                    for part in v.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            st.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            st.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = rec.as_bytes()[0];
        match kind {
            b'1' | b'2' | b'u' => {
                let xy = rec.split(' ').nth(1).unwrap_or("..").as_bytes();
                let (x, y) = (*xy.first().unwrap_or(&b'.'), *xy.get(1).unwrap_or(&b'.'));
                st.dirty_count += 1;
                if kind == b'u' {
                    st.conflicts += 1;
                } else {
                    if x != b'.' {
                        st.staged += 1;
                    }
                    if y != b'.' {
                        st.unstaged += 1;
                    }
                }
                if kind == b'2' {
                    recs.next(); // the original path of a rename/copy is its own record
                }
            }
            b'?' => st.untracked += 1,
            _ => {} // '!' ignored files and anything unknown
        }
    }
    st
}

/// First line of `rev-parse --show-toplevel --absolute-git-dir --git-common-dir` (all absolute with `--path-format=absolute`).
pub fn parse_revparse(raw: &str) -> Option<(String, String, String)> {
    let mut l = raw.lines().map(|s| s.trim_end_matches('\r')).filter(|s| !s.is_empty());
    Some((l.next()?.to_string(), l.next()?.to_string(), l.next()?.to_string()))
}

fn norm(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/');
    #[cfg(windows)]
    {
        return s.to_ascii_lowercase();
    }
    #[cfg(not(windows))]
    s.to_string()
}

/// Is `git_dir` a linked worktree's private dir (differs from the shared common dir)?
pub fn is_linked_worktree(git_dir: &str, common_dir: &str) -> bool {
    norm(git_dir) != norm(common_dir)
}

/// Looks for the marker files git leaves inside the git dir while an operation is half done.
pub fn detect_in_progress(git_dir: &Path) -> Option<String> {
    let has = |n: &str| git_dir.join(n).exists();
    if has("rebase-merge") || has("rebase-apply") {
        Some("rebase".into())
    } else if has("MERGE_HEAD") {
        Some("merge".into())
    } else if has("CHERRY_PICK_HEAD") {
        Some("cherry-pick".into())
    } else if has("REVERT_HEAD") {
        Some("revert".into())
    } else if has("BISECT_LOG") {
        Some("bisect".into())
    } else {
        None
    }
}

fn short(oid: &str) -> String {
    oid.chars().take(7).collect()
}

fn display_path(p: &str) -> String {
    #[cfg(windows)]
    {
        return p.replace('/', "\\");
    }
    #[cfg(not(windows))]
    p.to_string()
}

// ---------- the query ----------

/// Gathers the git state for `cwd`. `Ok(None)` = not inside a work tree; `Err` = git missing/failed/too slow.
pub fn query(cwd: &Path) -> Result<Option<GitInfo>, RunError> {
    let mut rp = git_cmd(cwd);
    rp.args(["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]);
    let rev = match run_capped(rp, TIMEOUT, 64 * 1024) {
        Ok(b) => b,
        Err(RunError::Failed(_)) => return Ok(None), // not a repo, or a bare repo
        Err(e) => return Err(e),
    };
    let Some((root, git_dir, common)) = parse_revparse(&String::from_utf8_lossy(&rev)) else {
        return Ok(None);
    };
    let mut sc = git_cmd(cwd);
    sc.args(["status", "--porcelain=v2", "--branch", "-z", "--no-renames", "--ignore-submodules=dirty"]);
    let st = parse_status(&run_capped(sc, TIMEOUT, OUTPUT_CAP)?);
    let branch = match (&st.head, &st.oid) {
        (Some(h), _) => Some(h.clone()),
        (None, Some(o)) => Some(short(o)),
        _ => None,
    };
    Ok(Some(GitInfo {
        repo_root: display_path(&root),
        branch,
        detached: st.detached,
        has_upstream: st.has_upstream,
        ahead: st.ahead,
        behind: st.behind,
        dirty_count: st.dirty_count,
        staged: st.staged,
        unstaged: st.unstaged,
        untracked: st.untracked,
        conflicts: st.conflicts,
        worktree: is_linked_worktree(&git_dir, &common),
        in_progress: detect_in_progress(Path::new(&git_dir)),
    }))
}

// ---------- commands ----------

type CacheMap = HashMap<PathBuf, (Instant, Option<GitInfo>)>;
fn cache() -> &'static Mutex<CacheMap> {
    static C: OnceLock<Mutex<CacheMap>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn info_cached(cwd: &str) -> Option<GitInfo> {
    let dir = validate_cwd(cwd).ok()?;
    {
        let c = cache().lock().ok()?;
        if let Some((at, v)) = c.get(&dir) {
            if at.elapsed() < CACHE_TTL {
                return v.clone();
            }
        }
    }
    let v = query(&dir).ok().flatten();
    if let Ok(mut c) = cache().lock() {
        if c.len() > 64 {
            c.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
        }
        c.insert(dir, (Instant::now(), v.clone()));
    }
    v
}

/// Git state of a folder, or null when it is not a repo, `git` is missing, or git is too slow. Never throws.
#[tauri::command]
pub async fn git_info(cwd: String) -> Option<GitInfo> {
    tauri::async_runtime::spawn_blocking(move || info_cached(&cwd)).await.ok().flatten()
}

/// Is a runnable `git` on PATH? (Asked once; the settings card shows a hint when not.)
#[tauri::command]
pub async fn git_available() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        static A: OnceLock<bool> = OnceLock::new();
        *A.get_or_init(|| {
            let mut c = Command::new("git");
            c.arg("--version");
            run_capped(c, TIMEOUT, 4096).is_ok()
        })
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nul(parts: &[&str]) -> Vec<u8> {
        let mut v = Vec::new();
        for p in parts {
            v.extend_from_slice(p.as_bytes());
            v.push(0);
        }
        v
    }

    #[test]
    fn parses_branch_headers_and_ahead_behind() {
        let s = parse_status(&nul(&[
            "# branch.oid 1234567890abcdef",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +3 -1",
        ]));
        assert_eq!(s.head.as_deref(), Some("main"));
        assert!(s.has_upstream);
        assert_eq!((s.ahead, s.behind), (3, 1)); // ahead is the +, behind the -
        assert!(!s.detached);
    }

    #[test]
    fn parses_entries_of_each_kind() {
        let s = parse_status(&nul(&[
            "# branch.head main",
            "1 .M N... 100644 100644 100644 aaaa bbbb src/a.rs",
            "1 M. N... 100644 100644 100644 aaaa bbbb src/b.rs",
            "1 MM N... 100644 100644 100644 aaaa bbbb src/c rs.rs",
            "2 R. N... 100644 100644 100644 aaaa bbbb R100 new.rs",
            "old.rs",
            "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.rs",
            "? untracked.txt",
            "? dir/other.txt",
            "! ignored.log",
        ]));
        assert_eq!(s.dirty_count, 5); // a, b, c, rename, conflict
        assert_eq!(s.staged, 3); // b, c, rename
        assert_eq!(s.unstaged, 2); // a, c
        assert_eq!(s.conflicts, 1);
        assert_eq!(s.untracked, 2); // the ignored file is not counted, nor is the rename's old path
    }

    #[test]
    fn detached_head_and_unborn_branch() {
        let s = parse_status(&nul(&["# branch.oid abcdef0123456789", "# branch.head (detached)"]));
        assert!(s.detached);
        assert_eq!(s.head, None);
        assert_eq!(s.oid.as_deref(), Some("abcdef0123456789"));
        assert_eq!(short(s.oid.as_deref().unwrap()), "abcdef0");
        let u = parse_status(&nul(&["# branch.oid (initial)", "# branch.head main", "? f"]));
        assert_eq!(u.oid, None);
        assert_eq!(u.head.as_deref(), Some("main"));
        assert_eq!(u.untracked, 1);
        assert!(!u.has_upstream);
        assert_eq!((u.ahead, u.behind), (0, 0));
    }

    #[test]
    fn garbage_does_not_panic() {
        let _ = parse_status(b"\0\0# \0# branch.ab +x -y\0\xff\xfe\0?");
        let s = parse_status(b"");
        assert_eq!(s, Status::default());
    }

    #[test]
    fn revparse_and_worktree_detection() {
        let (r, g, c) = parse_revparse("E:/repo\nE:/repo/.git/worktrees/w1\nE:/repo/.git\n").unwrap();
        assert_eq!(r, "E:/repo");
        assert!(is_linked_worktree(&g, &c));
        assert!(!is_linked_worktree("E:/repo/.git", "E:/repo/.git/"));
        assert!(parse_revparse("only-one\n").is_none());
    }

    #[test]
    fn in_progress_markers() {
        let d = std::env::temp_dir().join(format!("orch-git-ip-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(detect_in_progress(&d), None);
        std::fs::write(d.join("CHERRY_PICK_HEAD"), "x").unwrap();
        assert_eq!(detect_in_progress(&d).as_deref(), Some("cherry-pick"));
        std::fs::write(d.join("MERGE_HEAD"), "x").unwrap();
        assert_eq!(detect_in_progress(&d).as_deref(), Some("merge"));
        std::fs::create_dir_all(d.join("rebase-merge")).unwrap();
        assert_eq!(detect_in_progress(&d).as_deref(), Some("rebase"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn cwd_validation() {
        let tmp = std::env::temp_dir();
        assert!(validate_cwd(tmp.to_str().unwrap()).is_ok());
        assert!(validate_cwd("").is_err());
        assert!(validate_cwd("relative/dir").unwrap_err().contains("absolute"));
        assert!(validate_cwd("-C").unwrap_err().contains("'-'"));
        assert!(validate_cwd("--upload-pack=calc").unwrap_err().contains("'-'"));
        assert!(validate_cwd(&"a".repeat(2000)).unwrap_err().contains("long"));
        assert!(validate_cwd("a\0b").unwrap_err().contains("NUL"));
        let missing = tmp.join("orch-git-definitely-missing-dir");
        assert!(validate_cwd(missing.to_str().unwrap()).unwrap_err().contains("exist"));
        let f = tmp.join(format!("orch-git-file-{}.txt", std::process::id()));
        std::fs::write(&f, "x").unwrap();
        assert!(validate_cwd(f.to_str().unwrap()).unwrap_err().contains("directory"));
        let _ = std::fs::remove_file(&f);
    }

    #[test]
    fn timeout_kills_the_child() {
        #[cfg(windows)]
        let cmd = {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 20"]);
            c
        };
        #[cfg(not(windows))]
        let cmd = {
            let mut c = Command::new("sleep");
            c.arg("20");
            c
        };
        let t0 = Instant::now();
        let r = run_capped(cmd, Duration::from_millis(400), 1024);
        assert_eq!(r, Err(RunError::Timeout));
        assert!(t0.elapsed() < Duration::from_secs(5), "the child was not killed in time: {:?}", t0.elapsed());
    }

    #[test]
    fn output_cap_kills_the_child() {
        #[cfg(windows)]
        let cmd = {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoProfile", "-Command", "while($true){'x'*4000}"]);
            c
        };
        #[cfg(not(windows))]
        let cmd = Command::new("yes");
        let r = run_capped(cmd, Duration::from_secs(10), 50_000);
        assert_eq!(r, Err(RunError::TooMuchOutput));
    }

    fn git_ok() -> bool {
        Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
    }
    fn g(dir: &Path, args: &[&str]) {
        let o = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    }

    #[test]
    fn real_repo_states() {
        if !git_ok() {
            return;
        }
        let base = std::env::temp_dir().join(format!("orch-git-real-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let up = base.join("up");
        let work = base.join("work");
        std::fs::create_dir_all(&up).unwrap();
        g(&up, &["init", "-q", "-b", "main"]);
        std::fs::write(up.join("a.txt"), "1").unwrap();
        g(&up, &["add", "."]);
        g(&up, &["commit", "-q", "-m", "one"]);
        g(&base, &["clone", "-q", up.to_str().unwrap(), "work"]);
        let w = validate_cwd(work.to_str().unwrap()).unwrap();

        let clean = query(&w).unwrap().unwrap();
        assert_eq!(clean.branch.as_deref(), Some("main"));
        assert!(clean.has_upstream && (clean.ahead, clean.behind) == (0, 0));
        assert_eq!((clean.dirty_count, clean.untracked), (0, 0));

        std::fs::write(work.join("a.txt"), "2").unwrap();
        std::fs::write(work.join("new.txt"), "n").unwrap();
        std::fs::write(work.join("staged.txt"), "s").unwrap();
        g(&work, &["add", "staged.txt"]);
        g(&work, &["commit", "-q", "-am", "ahead"]);
        std::fs::write(work.join("a.txt"), "3").unwrap();
        let d = query(&w).unwrap().unwrap();
        assert_eq!((d.ahead, d.behind), (1, 0));
        assert_eq!((d.dirty_count, d.unstaged, d.untracked, d.staged), (1, 1, 1, 0));
        // from a subdirectory the root is still the repo root
        std::fs::create_dir_all(work.join("sub")).unwrap();
        let sub = query(&validate_cwd(work.join("sub").to_str().unwrap()).unwrap()).unwrap().unwrap();
        assert_eq!(norm(&sub.repo_root), norm(&d.repo_root));

        let wt = base.join("wt");
        g(&work, &["worktree", "add", "-q", "-b", "other", wt.to_str().unwrap()]);
        let wi = query(&validate_cwd(wt.to_str().unwrap()).unwrap()).unwrap().unwrap();
        assert!(wi.worktree);
        assert_eq!(wi.branch.as_deref(), Some("other"));
        assert!(!d.worktree);

        g(&work, &["checkout", "-q", "--detach", "HEAD"]);
        let det = query(&w).unwrap().unwrap();
        assert!(det.detached);
        assert_eq!(det.branch.as_ref().map(|b| b.len()), Some(7));

        // not a repo
        let plain = base.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(query(&validate_cwd(plain.to_str().unwrap()).unwrap()).unwrap(), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Manual probe: `ORCH_GIT_PROBE=<dir>[;<dir>...] cargo test --bin orchestra probe_from_env -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn probe_from_env() {
        for d in std::env::var("ORCH_GIT_PROBE").unwrap_or_default().split(';').filter(|d| !d.is_empty()) {
            let r = validate_cwd(d).map(|p| query(&p));
            println!("PROBE {d} => {}", match r {
                Ok(Ok(v)) => serde_json::to_string(&v).unwrap(),
                Ok(Err(e)) => format!("error {e:?}"),
                Err(e) => format!("invalid cwd: {e}"),
            });
        }
    }
}
