//! Actualización automática desde las releases de GitHub (tauri-plugin-updater).
//!
//! El frontend llama a `update_check` (al arrancar y cada 6 h) y, si el usuario acepta,
//! a `update_install`, que descarga el instalador NSIS, verifica su firma minisign con la
//! clave pública de tauri.conf.json y lo lanza en modo «passive». En Windows el plugin
//! cierra Orchestra con `std::process::exit(0)` y el instalador la vuelve a abrir.
//!
//! El endpoint es el de tauri.conf.json (GitHub). Solo en builds de depuración se puede
//! cambiar con `ORCHESTRA_UPDATER_ENDPOINT`; las builds de prueba del ciclo completo lo
//! cambian al compilar con `tauri build --config` (ver docs/dev-notes/actualizaciones.md).

use std::path::Path;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Actualización encontrada en la última comprobación, a la espera de que el usuario la acepte.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: String,
    pub date: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEnv {
    pub current: String,
    /// Exe suelto (portable): no se instala en el sitio, solo se ofrece la descarga.
    pub portable: bool,
}

/// Progreso de la descarga que se manda al frontend por un `Channel`.
#[derive(Serialize, Clone)]
#[serde(tag = "event", rename_all = "camelCase", content = "data")]
pub enum Progress {
    Started { total: Option<u64> },
    Chunk { got: u64 },
    /// Descargado y con la firma verificada; ahora se lanza el instalador.
    Verified,
}

/// Instalado con el NSIS por usuario: el instalador deja `uninstall.exe` junto al exe.
/// Un exe copiado a mano (el portable de la release) no lo tiene.
pub fn is_installed_layout(exe_dir: &Path) -> bool {
    exe_dir.join("uninstall.exe").is_file()
}

fn is_portable() -> bool {
    match std::env::current_exe() {
        Ok(exe) => exe.parent().map(|d| !is_installed_layout(d)).unwrap_or(true),
        Err(_) => true,
    }
}

/// Clasifica el error para que la interfaz pueda traducirlo: `signature:…`, `network:…` u otro.
fn classify(e: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match e {
        // Firma mala, de otra clave, o firmada para otra versión (manifiesto manipulado para colar otra release).
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion => {
            format!("signature:{e}")
        }
        E::Reqwest(_) | E::Network(_) | E::ReleaseNotFound => format!("network:{e}"),
        _ => e.to_string(),
    }
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    #[allow(unused_mut)]
    let mut b = app.updater_builder();
    // Solo en depuración: probar contra un latest.json local sin recompilar en release.
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("ORCHESTRA_UPDATER_ENDPOINT") {
        let url = url.parse().map_err(|e| format!("ORCHESTRA_UPDATER_ENDPOINT: {e}"))?;
        b = b.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let handle = app.clone();
    b.on_before_exit(move || shutdown_services(&handle))
        .build()
        .map_err(|e| e.to_string())
}

/// Lo mismo que hace `RunEvent::Exit`, que no llega a ejecutarse porque el plugin sale con `exit(0)`.
fn shutdown_services(app: &AppHandle) {
    if let Some(m) = app.try_state::<crate::mcp::McpManager>() {
        m.shutdown();
    }
    if let Some(m) = app.try_state::<std::sync::Arc<crate::remote_metrics::Manager>>() {
        m.shutdown();
    }
}

#[tauri::command]
pub fn update_env(app: AppHandle) -> UpdateEnv {
    UpdateEnv { current: app.package_info().version.to_string(), portable: is_portable() }
}

/// Busca una versión nueva. `None` = ya es la última.
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>) -> Result<Option<UpdateInfo>, String> {
    let found = updater(&app)?.check().await.map_err(|e| classify(&e))?;
    let info = found.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().unwrap_or_default(),
        // RFC 3339 tal cual viene en latest.json (lo entiende `new Date()` del frontend).
        date: u.raw_json.get("pub_date").and_then(|d| d.as_str()).map(str::to_string),
    });
    *pending.0.lock() = found;
    Ok(info)
}

/// Descarga, verifica la firma e instala la versión encontrada por `update_check`.
/// En Windows no vuelve: el instalador cierra y reabre Orchestra.
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>, on_event: Channel<Progress>) -> Result<(), String> {
    if is_portable() {
        return Err("portable".into());
    }
    let update = pending.0.lock().take().ok_or_else(|| "no-update".to_string())?;
    let mut started = false;
    let mut got: u64 = 0;
    let bytes = update
        .download(
            |chunk, total| {
                if !started {
                    started = true;
                    let _ = on_event.send(Progress::Started { total });
                }
                got += chunk as u64;
                let _ = on_event.send(Progress::Chunk { got });
            },
            || {},
        )
        .await
        .map_err(|e| classify(&e))?;
    // `download` solo devuelve los bytes si la firma es válida.
    let _ = on_event.send(Progress::Verified);
    update.install(bytes).map_err(|e| classify(&e))?;
    // Fuera de Windows el plugin no sale solo: reinicio (tauri-plugin-process hace lo mismo).
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_sin_uninstall() {
        let dir = std::env::temp_dir().join(format!("orch-upd-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!is_installed_layout(&dir));
        std::fs::write(dir.join("uninstall.exe"), b"").unwrap();
        assert!(is_installed_layout(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
