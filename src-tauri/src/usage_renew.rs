//! Renovar el inicio de sesión de una cuenta de Claude SIN tocar sus credenciales.
//!
//! Cuando la consulta de uso encuentra el token caducado, se ejecuta `claude auth status --json` con la carpeta de esa
//! cuenta: es Claude Code quien, al ver el token caducado, lo renueva con su propio token de refresco (lo mismo que pasa
//! al abrir Claude en esa cuenta). Orchestra no lee el token de refresco, no escribe en la carpeta de la cuenta y no
//! interpreta la salida del comando (ni la guarda): después solo vuelve a leer `expiresAt` como siempre.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// `claude auth status` tarda < 1 s; el tope es por si se queda colgado (se mata el árbol).
const TIMEOUT: Duration = Duration::from_secs(20);

/// Entorno del `claude` hijo: (variables que se ponen, variables que se quitan).
/// La cuenta de serie (`~/.claude`) va SIN `CLAUDE_CONFIG_DIR` (con ella Claude buscaría `.claude.json` dentro de la carpeta);
/// las demás, con su carpeta tal cual la guarda Orchestra. Nunca se heredan las marcas de otra sesión de Claude.
pub(crate) fn child_env(dir: &str, is_default: bool, inherited: impl Iterator<Item = String>) -> (Vec<(String, String)>, Vec<String>) {
    let mut remove: Vec<String> = inherited.filter(|k| crate::pty::is_session_marker(k)).collect();
    let mut set = Vec::new();
    if is_default {
        remove.push("CLAUDE_CONFIG_DIR".into());
    } else {
        set.push(("CLAUDE_CONFIG_DIR".into(), dir.to_string()));
    }
    (set, remove)
}

fn default_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    std::fs::canonicalize(PathBuf::from(home).join(".claude")).ok()
}

/// `true` si `dir` es la carpeta de serie `~/.claude` (comparando rutas canónicas).
fn is_default_dir(dir: &str) -> bool {
    match (std::fs::canonicalize(Path::new(dir)), default_dir()) {
        (Ok(a), Some(b)) => a == b,
        _ => false,
    }
}

/// Pide a Claude Code que renueve el token de la cuenta de `dir` (ruta ya validada por `usage_query::read_token`).
/// `true` si `claude` terminó bien; quien llama comprueba la nueva caducidad leyendo el fichero.
pub fn renew_with_claude(dir: &str) -> bool {
    let inherited = std::env::vars_os().filter_map(|(k, _)| k.into_string().ok());
    let (set, remove) = child_env(dir, is_default_dir(dir), inherited);
    matches!(crate::providers::run_capture_env("claude", &["auth", "status", "--json"], &set, &remove, TIMEOUT), Some((true, _)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[&str]) -> std::vec::IntoIter<String> {
        v.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter()
    }

    #[test]
    fn other_accounts_get_their_folder_and_lose_session_markers() {
        let (set, remove) = child_env(r"C:\Users\u\.claude-b", false, names(&["CLAUDECODE", "PATH", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_USE_BEDROCK"]));
        assert_eq!(set, vec![("CLAUDE_CONFIG_DIR".to_string(), r"C:\Users\u\.claude-b".to_string())]);
        assert!(remove.contains(&"CLAUDECODE".to_string()));
        assert!(remove.contains(&"CLAUDE_CODE_SESSION_ID".to_string()));
        assert!(!remove.contains(&"PATH".to_string()), "la configuración del usuario se respeta");
        assert!(!remove.contains(&"CLAUDE_CODE_USE_BEDROCK".to_string()));
        assert!(!remove.contains(&"CLAUDE_CONFIG_DIR".to_string()));
    }

    #[test]
    fn the_default_account_runs_without_claude_config_dir() {
        let (set, remove) = child_env(r"C:\Users\u\.claude", true, names(&["CLAUDE_CONFIG_DIR"]));
        assert!(set.is_empty());
        assert!(remove.contains(&"CLAUDE_CONFIG_DIR".to_string()));
    }

    #[test]
    fn a_missing_folder_is_never_the_default() {
        assert!(!is_default_dir(r"Z:\no\such\folder\.claude"));
    }
}
