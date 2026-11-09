use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

use crate::pty::{self, PtyManager, Sink, SpawnSpec};
use crate::{shells, sshcfg, Prefs};

struct ChanSink(Channel);

impl Sink for ChanSink {
    fn data(&self, bytes: Vec<u8>) {
        let _ = self.0.send(InvokeResponseBody::Raw(bytes));
    }
}

#[derive(Serialize, Clone)]
struct ExitEvent {
    id: String,
    code: i32,
}

/// Lanza un proceso en un PTY nuevo. Devuelve el pid.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    spec: SpawnSpec,
) -> Result<u32, String> {
    if let Some(old) = state.remove(&spec.id) {
        // Reemplazo intencionado (relanzar, cambiar de cuenta): su fin no es un fallo del panel.
        old.supersede();
        old.kill();
    }
    let id = spec.id.clone();
    let app2 = app.clone();
    let session = pty::spawn(
        spec,
        Box::new(move |id, code| {
            let _ = app2.emit("pty-exit", ExitEvent { id, code });
        }),
    )?;
    let pid = session.pid.unwrap_or(0);
    state.insert(id, session);
    Ok(pid)
}

/// Engancha la interfaz a un PTY (recibe primero el histórico). Devuelve el código de
/// salida si el proceso ya había terminado.
#[tauri::command]
pub fn pty_attach(
    state: State<'_, PtyManager>,
    id: String,
    on_data: Channel,
) -> Result<Option<i32>, String> {
    let s = state.get(&id).ok_or_else(|| format!("Terminal {id} does not exist"))?;
    s.attach(Arc::new(ChanSink(on_data)));
    Ok(s.exit_code())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    state
        .get(&id)
        .ok_or_else(|| format!("Terminal {id} does not exist"))?
        .write(data.as_bytes())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    match state.get(&id) {
        Some(s) => s.resize(cols, rows),
        None => Ok(()),
    }
}

/// Mata el proceso pero deja la sesión (para mostrar «terminado» y poder reiniciar).
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>, id: String) {
    if let Some(s) = state.get(&id) {
        s.kill();
    }
}

/// Mata y olvida la sesión.
#[tauri::command]
pub fn pty_close(state: State<'_, PtyManager>, id: String) {
    if let Some(s) = state.remove(&id) {
        s.kill();
    }
}

#[tauri::command]
pub fn pty_list(state: State<'_, PtyManager>) -> Vec<String> {
    state.ids()
}

#[tauri::command]
pub async fn detect_shells() -> Vec<shells::ShellProfile> {
    tauri::async_runtime::spawn_blocking(shells::detect)
        .await
        .unwrap_or_default()
}

/// Escribe los temas de Claude que genera Orchestra en la carpeta `themes` de cada cuenta.
#[tauri::command]
pub async fn claude_themes_write(
    dirs: Vec<String>,
    files: Vec<crate::claude_themes::ThemeFile>,
) -> Result<Vec<crate::claude_themes::DirResult>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::claude_themes::write_all(dirs, files))
        .await
        .map_err(|e| e.to_string())?
}

/// Fuentes instaladas (para la lista de Ajustes → Terminal).
#[tauri::command]
pub async fn list_fonts() -> Vec<crate::fonts::FontFamily> {
    tauri::async_runtime::spawn_blocking(crate::fonts::list)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub fn ssh_config_hosts() -> Vec<sshcfg::SshHost> {
    let Some(home) = home() else {
        return vec![];
    };
    std::fs::read_to_string(home.join(".ssh").join("config"))
        .map(|t| sshcfg::parse(&t))
        .unwrap_or_default()
}

fn home() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(Into::into)
}

#[tauri::command]
pub fn home_dir() -> String {
    home()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Abre una URL http(s) en el navegador por defecto. Sin shell de por medio.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http(s) links can be opened".into());
    }
    #[cfg(windows)]
    let r = std::process::Command::new("explorer.exe").arg(&url).spawn();
    #[cfg(not(windows))]
    let r = std::process::Command::new("xdg-open").arg(&url).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_close_to_tray(prefs: State<'_, Prefs>, enabled: bool) {
    prefs.close_to_tray.store(enabled, Ordering::Relaxed);
}
