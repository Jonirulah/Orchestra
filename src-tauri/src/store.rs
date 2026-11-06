//! Persistencia del estado de la interfaz (JSON opaco para el backend).

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Carpeta alternativa pedida con `ORCHESTRA_DATA_DIR` (pruebas aisladas, modo portátil). Vacía = sin cambio.
fn override_dir(var: Option<std::ffi::OsString>) -> Option<PathBuf> {
    var.filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Carpeta de datos de la app: `ORCHESTRA_DATA_DIR` si está definida, si no la de Windows
/// (`%APPDATA%\dev.orchestra.app`). Todo (estado, cuotas, MCP, ayudantes) cuelga de aquí.
/// Ojo: Tauri usa la API de Windows, así que cambiar la variable `APPDATA` NO aísla nada.
pub fn base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(d) = override_dir(std::env::var_os("ORCHESTRA_DATA_DIR")) {
        return Ok(d);
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

pub(crate) fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    base_dir(app).map(|d| d.join("state.json"))
}

#[tauri::command]
pub fn load_state(app: AppHandle) -> Result<Option<String>, String> {
    match std::fs::read_to_string(state_path(&app)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    let path = state_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Escritura atómica: nunca queda un state.json a medias.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Carpeta donde se guarda el estado (`state.json`).
#[tauri::command]
pub fn data_dir(app: AppHandle) -> Result<String, String> {
    base_dir(&app).map(|d| d.to_string_lossy().into_owned())
}

/// Abre la carpeta de datos en el explorador de archivos (sin shell de por medio).
#[tauri::command]
pub fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = base_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let r = std::process::Command::new("explorer.exe").arg(&dir).spawn();
    #[cfg(not(windows))]
    let r = std::process::Command::new("xdg-open").arg(&dir).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

/// Forma comparable de una ruta de Windows: barras normales, sin barra final, sin distinguir mayúsculas.
fn norm_dir(p: &str) -> String {
    p.trim().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// ¿Es `dir` la carpeta de alguna de las cuentas del estado guardado (`accounts[].dir`)?
pub(crate) fn is_account_dir(state_json: &str, dir: &str) -> bool {
    let want = norm_dir(dir);
    if want.is_empty() {
        return false;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(state_json) else { return false };
    v.get("accounts")
        .and_then(|a| a.as_array())
        .map(|list| list.iter().filter_map(|a| a.get("dir")?.as_str()).any(|d| norm_dir(d) == want))
        .unwrap_or(false)
}

/// Abre en el explorador de archivos la carpeta de una cuenta. Solo vale una carpeta que sea `dir` de una cuenta
/// guardada (nada de rutas arbitrarias desde la interfaz) y que exista; sin shell de por medio.
#[tauri::command]
pub fn open_account_dir(app: AppHandle, dir: String) -> Result<(), String> {
    let state = std::fs::read_to_string(state_path(&app)?).map_err(|e| e.to_string())?;
    if !is_account_dir(&state, &dir) {
        return Err("That folder is not an account folder".into());
    }
    let path = PathBuf::from(dir.trim());
    if !path.is_absolute() || !path.is_dir() {
        return Err("The folder does not exist".into());
    }
    #[cfg(windows)]
    let r = std::process::Command::new("explorer.exe").arg(&path).spawn();
    #[cfg(not(windows))]
    let r = std::process::Command::new("xdg-open").arg(&path).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{is_account_dir, norm_dir, override_dir};
    use std::ffi::OsString;
    use std::path::PathBuf;

    #[test]
    fn la_variable_vacia_o_ausente_no_cambia_nada() {
        assert_eq!(override_dir(None), None);
        assert_eq!(override_dir(Some(OsString::new())), None);
    }

    #[test]
    fn una_ruta_definida_se_usa_tal_cual() {
        let p = r"E:\tmp\orch aislado (1)";
        assert_eq!(override_dir(Some(OsString::from(p))), Some(PathBuf::from(p)));
    }

    const STATE: &str = r#"{"accounts":[{"id":"a","dir":"C:\\Users\\me\\.claude"},{"id":"b","dir":"C:\\Users\\me\\.codex-work\\"}]}"#;

    #[test]
    fn solo_se_abre_la_carpeta_de_una_cuenta_guardada() {
        assert!(is_account_dir(STATE, r"C:\Users\me\.claude"));
        assert!(is_account_dir(STATE, "c:/users/ME/.claude/"));
        assert!(is_account_dir(STATE, r"C:\Users\me\.codex-work"));
        assert!(!is_account_dir(STATE, r"C:\Users\me"));
        assert!(!is_account_dir(STATE, r"C:\Windows\System32"));
        assert!(!is_account_dir(STATE, r"C:\Users\me\.claude\..\.."));
        assert!(!is_account_dir(STATE, ""));
        assert!(!is_account_dir("no es json", r"C:\Users\me\.claude"));
        assert!(!is_account_dir("{}", r"C:\Users\me\.claude"));
    }

    #[test]
    fn la_normalizacion_quita_barra_final_y_mayusculas() {
        assert_eq!(norm_dir(" C:/A/B/ "), r"c:\a\b");
    }
}
