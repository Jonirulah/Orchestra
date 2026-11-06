//! Cuentas (suscripciones) de Claude Code: cada una es una carpeta CLAUDE_CONFIG_DIR.
//! Aquí solo se LEE la identidad (email, plan) para mostrarla; nunca se tocan tokens.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProfile {
    /// Ruta de la carpeta de configuración.
    pub dir: String,
    /// `true` si es la carpeta por defecto (~/.claude): no necesita CLAUDE_CONFIG_DIR.
    pub is_default: bool,
    pub logged_in: bool,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub org: Option<String>,
    pub account_uuid: Option<String>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(Into::into)
}

fn identity(json_path: &Path) -> (bool, Option<String>, Option<String>, Option<String>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(json_path) else {
        return (false, None, None, None, None);
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (false, None, None, None, None);
    };
    let o = &v["oauthAccount"];
    if !o.is_object() {
        return (false, None, None, None, None);
    }
    let s = |k: &str| o[k].as_str().map(str::to_string);
    (true, s("emailAddress"), s("planDisplayName").or_else(|| s("billingType")), s("organizationName"), s("accountUuid"))
}

pub fn scan() -> Vec<ClaudeProfile> {
    let Some(home) = home() else { return vec![] };
    let mut out = Vec::new();
    // La carpeta por defecto guarda su .claude.json en el HOME, no dentro de .claude.
    let default_dir = home.join(".claude");
    if default_dir.is_dir() {
        let (ok, email, plan, org, uuid) = identity(&home.join(".claude.json"));
        out.push(ClaudeProfile {
            dir: default_dir.to_string_lossy().into_owned(),
            is_default: true,
            logged_in: ok,
            email,
            plan,
            org,
            account_uuid: uuid,
        });
    }
    if let Ok(rd) = std::fs::read_dir(&home) {
        let mut dirs: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_dir()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with(".claude-"))
            })
            .collect();
        dirs.sort();
        for d in dirs {
            let (ok, email, plan, org, uuid) = identity(&d.join(".claude.json"));
            out.push(ClaudeProfile {
                dir: d.to_string_lossy().into_owned(),
                is_default: false,
                logged_in: ok,
                email,
                plan,
                org,
                account_uuid: uuid,
            });
        }
    }
    out
}

/// Crea una carpeta de cuenta nueva que comparte historial, agentes, skills y plugins con
/// ~/.claude (junctions: no necesitan permisos de administrador) y copia CLAUDE.md y
/// settings.json. El login se hace después, abriendo `claude` con esa carpeta.
pub fn prepare(dir: &str) -> Result<(), String> {
    let home = home().ok_or("No user folder")?;
    let base = home.join(".claude");
    let target = PathBuf::from(dir);
    if target == base {
        return Err("That is the default folder".into());
    }
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    for name in ["projects", "agents", "skills", "plugins"] {
        let src = base.join(name);
        let link = target.join(name);
        if !src.is_dir() || link.exists() {
            continue;
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let st = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&src)
                .creation_flags(0x0800_0000)
                .output()
                .map_err(|e| e.to_string())?;
            if !st.status.success() {
                return Err(format!("Could not link {name}"));
            }
        }
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(&src, &link).map_err(|e| e.to_string())?;
    }
    for name in ["CLAUDE.md", "settings.json"] {
        let (src, dst) = (base.join(name), target.join(name));
        if src.is_file() && !dst.exists() {
            std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn claude_profiles() -> Vec<ClaudeProfile> {
    scan()
}

#[tauri::command]
pub fn prepare_claude_dir(dir: String) -> Result<(), String> {
    prepare(&dir)
}
