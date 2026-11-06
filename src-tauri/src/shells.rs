//! Detección de los shells instalados (PowerShell, cmd, Git Bash, WSL...).

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
}

fn prof(id: &str, name: &str, program: impl Into<String>, args: &[&str]) -> ShellProfile {
    ShellProfile {
        id: id.into(),
        name: name.into(),
        program: program.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
    }
}

fn which(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(exe))
        .find(|p| p.is_file())
}

#[cfg(windows)]
fn wsl_distros() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    let Ok(out) = std::process::Command::new("wsl.exe")
        .args(["-l", "-q"])
        .creation_flags(0x0800_0000)
        .output()
    else {
        return vec![];
    };
    if !out.status.success() {
        return vec![];
    }
    // `wsl -l` escribe en UTF-16LE.
    let units: Vec<u16> = out
        .stdout
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
        .lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}').to_string())
        .filter(|l| !l.is_empty() && !l.contains(' '))
        .collect()
}

#[cfg(windows)]
pub fn detect() -> Vec<ShellProfile> {
    let mut v = Vec::new();
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());

    let pwsh_candidates = [
        which("pwsh.exe"),
        Some(PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe")),
    ];
    if let Some(p) = pwsh_candidates.into_iter().flatten().find(|p| p.is_file()) {
        v.push(prof("pwsh", "PowerShell 7", p.to_string_lossy(), &["-NoLogo"]));
    }
    let ps5 = format!(r"{sysroot}\System32\WindowsPowerShell\v1.0\powershell.exe");
    if Path::new(&ps5).is_file() {
        v.push(prof("powershell", "Windows PowerShell", ps5, &["-NoLogo"]));
    }
    let cmd = std::env::var("ComSpec").unwrap_or_else(|_| format!(r"{sysroot}\System32\cmd.exe"));
    v.push(prof("cmd", "Command Prompt", cmd, &[]));

    let mut git_bash = vec![
        PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"),
    ];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        git_bash.push(PathBuf::from(local).join(r"Programs\Git\bin\bash.exe"));
    }
    if let Some(p) = git_bash.into_iter().find(|p| p.is_file()) {
        v.push(prof("gitbash", "Git Bash", p.to_string_lossy(), &["--login", "-i"]));
    }

    if Path::new(&format!(r"{sysroot}\System32\wsl.exe")).is_file() {
        for d in wsl_distros() {
            v.push(prof(
                &format!("wsl:{d}"),
                &format!("WSL · {d}"),
                "wsl.exe",
                &["-d", &d],
            ));
        }
    }
    v
}

#[cfg(not(windows))]
pub fn detect() -> Vec<ShellProfile> {
    let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    vec![prof("shell", "Shell", sh, &["-l"])]
}
