//! Cuentas de Codex y opencode (fase 1: crear carpeta, detectar y saber si hay sesión).
//!
//! Qué se lee y qué no (ver docs/SECURITY.md): NUNCA se abre el fichero de credenciales de ningún proveedor ni el
//! llavero. El estado de sesión sale de los comandos del propio proveedor, ejecutados con el entorno de esa cuenta
//! (`codex login status`, `opencode auth list --format json`); de su salida solo se conserva un veredicto
//! (`signedIn` / `notSignedIn` / `unknown`) y, como mucho, el método (ChatGPT / clave API) o un recuento. El texto de
//! la salida se descarta; no se registra ni se devuelve.
//!
//! Dónde se escribe: solo en carpetas NUEVAS de cuenta (`~/.codex-<x>`, `~/.opencode-<x>`), nunca en `~/.codex`,
//! `~/.config/opencode`, `~/.local/share/opencode` ni `~/.claude*`.

use serde::Serialize;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(test)]
mod tests;

const CODEX_PREFIX: &str = ".codex-";
const OPENCODE_PREFIX: &str = ".opencode-";
/// Línea que se escribe en el config.toml de una carpeta de Codex NUEVA: la sesión vive en esa carpeta
/// (fichero) y no en el llavero compartido de Windows.
const CODEX_CONFIG_LINE: &str = "cli_auth_credentials_store = \"file\"\n";
/// Tope de lo que se lee de la salida de un comando de estado.
const OUTPUT_CAP: u64 = 64 * 1024;

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(Into::into)
}

// ---------- detección ----------

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDetect {
    pub codex_installed: bool,
    /// `~/.codex` si existe (candidata a «Default Codex»).
    pub codex_dir: Option<String>,
    pub opencode_installed: bool,
    /// `~/.local/share/opencode` si existe.
    pub opencode_dir: Option<String>,
}

/// ¿Hay algún `<nombre>` (con alguna de las extensiones) en alguna carpeta de `path`?
pub(crate) fn on_path(path: Option<&OsStr>, names: &[&str]) -> bool {
    let Some(path) = path else { return false };
    std::env::split_paths(path).any(|d| names.iter().any(|n| d.join(n).is_file()))
}

pub(crate) fn detect_in(home: Option<&Path>, path: Option<&OsStr>) -> ProviderDetect {
    let dir = |rel: &str| {
        home.map(|h| h.join(rel))
            .filter(|p| p.is_dir())
            .map(|p| p.to_string_lossy().into_owned())
    };
    ProviderDetect {
        codex_installed: on_path(path, &["codex.exe", "codex.cmd", "codex.bat"]),
        codex_dir: dir(".codex"),
        opencode_installed: on_path(path, &["opencode.exe", "opencode.cmd", "opencode.bat"]),
        opencode_dir: dir(".local/share/opencode"),
    }
}

#[tauri::command]
pub fn provider_detect() -> ProviderDetect {
    detect_in(home().as_deref(), std::env::var_os("PATH").as_deref())
}

// ---------- carpetas de cuenta ----------

fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Carpeta de cuenta aceptable: ruta absoluta sin `..`, hija directa de `home` y con el prefijo del proveedor
/// (`.codex-x` / `.opencode-x`, solo letras, cifras, `.`, `_` y `-`). La interfaz fabrica el nombre; aquí se vuelve a comprobar.
pub(crate) fn valid_account_dir(provider: &str, dir: &str, home: &Path) -> Result<PathBuf, String> {
    let prefix = match provider {
        "codex" => CODEX_PREFIX,
        "opencode" => OPENCODE_PREFIX,
        _ => return Err("Unknown provider".into()),
    };
    let p = PathBuf::from(dir);
    if !p.is_absolute() {
        return Err("The folder must be an absolute path".into());
    }
    if p.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return Err("The folder path must not contain . or ..".into());
    }
    if p.parent().map(norm) != Some(norm(home)) {
        return Err("The folder must be directly inside your user folder".into());
    }
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let rest = name.strip_prefix(prefix).unwrap_or("");
    if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Err(format!("The folder name must look like {prefix}name"));
    }
    Ok(p)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPrepared {
    pub created: bool,
    pub wrote_config: bool,
}

/// Crea la carpeta de una cuenta nueva.
/// - codex: si la carpeta era nueva o estaba vacía y no tiene `config.toml`, lo crea con `cli_auth_credentials_store = "file"`.
///   Si ya tenía contenido no se toca nada.
/// - opencode: crea `data/` y `state/` (XDG_DATA_HOME / XDG_STATE_HOME de esa cuenta).
pub(crate) fn prepare_in(provider: &str, dir: &str, home: &Path) -> Result<ProviderPrepared, String> {
    let p = valid_account_dir(provider, dir, home)?;
    let existed = p.exists();
    let empty = !existed || std::fs::read_dir(&p).map(|mut d| d.next().is_none()).unwrap_or(false);
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    let mut wrote_config = false;
    if provider == "codex" {
        let cfg = p.join("config.toml");
        if empty && !cfg.exists() {
            std::fs::write(&cfg, CODEX_CONFIG_LINE).map_err(|e| e.to_string())?;
            wrote_config = true;
        }
    } else {
        for sub in ["data", "state"] {
            std::fs::create_dir_all(p.join(sub)).map_err(|e| e.to_string())?;
        }
    }
    Ok(ProviderPrepared { created: !existed, wrote_config })
}

#[tauri::command]
pub fn provider_prepare(provider: String, dir: String) -> Result<ProviderPrepared, String> {
    let home = home().ok_or("No user folder")?;
    prepare_in(&provider, &dir, &home)
}

// ---------- estado de sesión ----------

/// Veredicto de sesión. Nunca lleva texto de la salida del proveedor.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    /// "signedIn" | "notSignedIn" | "unknown"
    pub status: &'static str,
    /// Codex: "chatgpt" | "apikey" | "other"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<&'static str>,
    /// opencode: nº de integraciones con sesión.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
}

impl ProviderStatus {
    fn new(status: &'static str) -> Self {
        Self { status, method: None, count: None }
    }
}

/// `codex login status`: «Not logged in» (exit 1) o «Logged in using ChatGPT» / «... an API key ...» (exit 0).
pub(crate) fn parse_codex_status(exit_ok: bool, text: &str) -> ProviderStatus {
    let low = text.to_lowercase();
    if low.contains("not logged in") {
        return ProviderStatus::new("notSignedIn");
    }
    if exit_ok && low.trim_start().starts_with("logged in") {
        let mut s = ProviderStatus::new("signedIn");
        s.method = Some(if low.contains("chatgpt") {
            "chatgpt"
        } else if low.contains("api key") {
            "apikey"
        } else {
            "other"
        });
        return s;
    }
    ProviderStatus::new("unknown")
}

/// `opencode auth list --format json`: `[]` sin sesión; una lista con elementos = hay sesión (solo se cuenta).
/// Sin JSON, el aviso «No authenticated integrations» también vale como «sin sesión».
pub(crate) fn parse_opencode_list(exit_ok: bool, text: &str) -> ProviderStatus {
    if !exit_ok {
        return ProviderStatus::new("unknown");
    }
    let t = text.trim();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
        if let Some(a) = v.as_array() {
            let mut s = ProviderStatus::new(if a.is_empty() { "notSignedIn" } else { "signedIn" });
            s.count = Some(a.len());
            return s;
        }
        return ProviderStatus::new("unknown");
    }
    if t.to_lowercase().contains("no authenticated integrations") {
        let mut s = ProviderStatus::new("notSignedIn");
        s.count = Some(0);
        return s;
    }
    ProviderStatus::new("unknown")
}

/// Ejecuta un comando (por `cmd /C`, para encontrar también los `.cmd` de npm) con tope de tiempo y de salida.
/// Devuelve (salió con éxito, stdout+stderr) o `None` si no arrancó o pasó el tiempo (el árbol del hijo se mata).
pub(crate) fn run_capture(
    program: &str,
    args: &[&str],
    env: &[(String, String)],
    timeout: Duration,
) -> Option<(bool, String)> {
    run_capture_env(program, args, env, &[], timeout)
}

/// Como `run_capture`, pero antes quita del entorno heredado las variables de `remove`.
pub(crate) fn run_capture_env(
    program: &str,
    args: &[&str],
    env: &[(String, String)],
    remove: &[String],
    timeout: Duration,
) -> Option<(bool, String)> {
    let mut cmd = Command::new("cmd");
    cmd.arg("/C").arg(program).args(args);
    for k in remove {
        cmd.env_remove(k);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().ok()?;
    let reader = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let _ = (&mut r).take(OUTPUT_CAP).read_to_end(&mut buf);
                // El resto se descarta leyendo (si no, un hijo muy hablador se queda bloqueado con la tubería llena).
                let _ = std::io::copy(&mut r, &mut std::io::sink());
            }
            buf
        })
    };
    let out = reader(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err = reader(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let mut text = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&err.join().unwrap_or_default()));
    Some((status.success(), text))
}

/// Mata el árbol de un proceso que arrancamos nosotros (el `cmd` de `run_capture` y su hijo).
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    let _ = pid;
}

/// Entorno y argumentos del comando de estado de una cuenta (el mismo entorno que usará su panel).
pub(crate) fn status_command(
    provider: &str,
    dir: &str,
    is_default: bool,
    home: &Path,
) -> Result<(&'static str, Vec<&'static str>, Vec<(String, String)>), String> {
    let mut env = Vec::new();
    match provider {
        "codex" => {
            if !is_default {
                let p = valid_account_dir("codex", dir, home)?;
                env.push(("CODEX_HOME".to_string(), p.to_string_lossy().into_owned()));
            }
            Ok(("codex", vec!["login", "status"], env))
        }
        "opencode" => {
            let mut args = vec!["auth", "list", "--format", "json"];
            if !is_default {
                let p = valid_account_dir("opencode", dir, home)?;
                env.push(("XDG_DATA_HOME".to_string(), p.join("data").to_string_lossy().into_owned()));
                env.push(("XDG_STATE_HOME".to_string(), p.join("state").to_string_lossy().into_owned()));
                // Servidor privado: sin esto, opencode v2 habla con el servicio compartido y no respeta la carpeta.
                args.push("--standalone");
            }
            Ok(("opencode", args, env))
        }
        _ => Err("Unknown provider".into()),
    }
}

pub(crate) fn check_status(provider: &str, dir: &str, is_default: bool, home: &Path) -> Result<ProviderStatus, String> {
    let (prog, args, env) = status_command(provider, dir, is_default, home)?;
    let timeout = Duration::from_secs(if provider == "opencode" { 20 } else { 10 });
    let Some((ok, text)) = run_capture(prog, &args, &env, timeout) else {
        return Ok(ProviderStatus::new("unknown"));
    };
    Ok(if provider == "codex" { parse_codex_status(ok, &text) } else { parse_opencode_list(ok, &text) })
}

#[tauri::command]
pub async fn provider_status(provider: String, dir: String, is_default: bool) -> Result<ProviderStatus, String> {
    let home = home().ok_or("No user folder")?;
    tauri::async_runtime::spawn_blocking(move || check_status(&provider, &dir, is_default, &home))
        .await
        .map_err(|e| e.to_string())?
}
