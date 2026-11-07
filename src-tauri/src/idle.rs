//! Inactividad del usuario en el sistema (sin ratón ni teclado), para el auto-compact.
//! Windows: `GetLastInputInfo` (user32) + `GetTickCount` (kernel32), declaradas a mano: sin crates nuevos.

/// Milisegundos entre dos marcas de `GetTickCount` (u32, vuelve a 0 cada ~49,7 días).
pub fn tick_delta_ms(now: u32, last: u32) -> u32 {
    now.wrapping_sub(last)
}

#[cfg(windows)]
mod sys {
    #[repr(C)]
    pub struct LastInputInfo {
        pub cb_size: u32,
        pub dw_time: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        pub fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetTickCount() -> u32;
    }
}

/// Segundos desde la última entrada del usuario. Si la API falla devuelve 0 («activo»): es el lado seguro,
/// porque el auto-compact solo actúa cuando el usuario lleva rato fuera.
#[cfg(windows)]
pub fn idle_seconds() -> u64 {
    let mut info = sys::LastInputInfo {
        cb_size: std::mem::size_of::<sys::LastInputInfo>() as u32,
        dw_time: 0,
    };
    // SAFETY: `info` es un LASTINPUTINFO válido con cbSize rellenado; las dos llamadas no guardan el puntero.
    unsafe {
        if sys::GetLastInputInfo(&mut info) == 0 {
            return 0;
        }
        u64::from(tick_delta_ms(sys::GetTickCount(), info.dw_time)) / 1000
    }
}

#[cfg(not(windows))]
pub fn idle_seconds() -> u64 {
    0
}

#[tauri::command]
pub fn system_idle_seconds() -> u64 {
    idle_seconds()
}

/// Solo desarrollo: `ORCHESTRA_DEV_AUTOCOMPACT=ctxK=1,afterSec=30,idleSec=0` salta los límites de Settings
/// para probar el auto-compact de verdad sin esperar 50 min (ver docs/ARCHITECTURE.md, «Auto-compact»).
const DEV_VAR: &str = "ORCHESTRA_DEV_AUTOCOMPACT";

fn dev_value(v: Option<std::ffi::OsString>) -> Option<String> {
    v.map(|s| s.to_string_lossy().into_owned()).filter(|s| !s.trim().is_empty())
}

#[tauri::command]
pub fn dev_autocompact_override() -> Option<String> {
    dev_value(std::env::var_os(DEV_VAR))
}

/// Con la variable de desarrollo puesta, añade una línea a `autocompact-dev.log` en la carpeta de datos
/// (decisiones y escrituras de `/compact`). Sin la variable no hace nada.
#[tauri::command]
pub fn dev_autocompact_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
    if dev_value(std::env::var_os(DEV_VAR)).is_none() {
        return Ok(());
    }
    use std::io::Write;
    let dir = crate::store::base_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("autocompact-dev.log"))
        .map_err(|e| e.to_string())?;
    let line: String = line.chars().filter(|c| !c.is_control()).take(500).collect();
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_override_empty_is_none() {
        assert_eq!(dev_value(None), None);
        assert_eq!(dev_value(Some("  ".into())), None);
        assert_eq!(dev_value(Some("ctxK=1".into())).as_deref(), Some("ctxK=1"));
    }

    #[test]
    fn tick_delta_plain() {
        assert_eq!(tick_delta_ms(10_000, 4_000), 6_000);
        assert_eq!(tick_delta_ms(5, 5), 0);
    }

    #[test]
    fn tick_delta_wraps_around() {
        // GetTickCount dio la vuelta: now es pequeño y last cercano a u32::MAX.
        assert_eq!(tick_delta_ms(1_000, u32::MAX - 999), 2_000);
        assert_eq!(tick_delta_ms(0, u32::MAX), 1);
    }

    /// Lectura real: `cargo test real_idle -- --ignored --nocapture` (con el usuario activo debe dar un valor pequeño).
    #[test]
    #[ignore]
    fn real_idle_seconds_prints() {
        let v = idle_seconds();
        println!("IDLE_SECONDS={v}");
        #[cfg(windows)]
        {
            let mut info = sys::LastInputInfo { cb_size: std::mem::size_of::<sys::LastInputInfo>() as u32, dw_time: 0 };
            // SAFETY: igual que en idle_seconds.
            let (ok, tick) = unsafe { (sys::GetLastInputInfo(&mut info), sys::GetTickCount()) };
            println!("API_OK={ok} last_input_tick={} now_tick={tick} idle_ms={}", info.dw_time, tick_delta_ms(tick, info.dw_time));
        }
        assert!(v < 86_400 * 30);
    }
}
