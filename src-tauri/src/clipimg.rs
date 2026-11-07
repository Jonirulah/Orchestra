//! Pegar imágenes en los terminales (ver src/lib/imagepaste.ts).
//!
//! - `clipboard_image_info`: ¿hay una imagen en el portapapeles? (y su tamaño). Lo usan los paneles de Claude Code, que
//!   leen ellos mismos el portapapeles con su atajo (Alt+V en Windows).
//! - `clipboard_image_to_file`: guarda la imagen del portapapeles en PNG en `<caché>/paste/img-AAAAMMDD-HHMMSS-xxxx.png`
//!   y devuelve la ruta, que el frontend pega en el panel (Codex, opencode, shells).
//! - `ssh_upload_image`: sube un archivo de imagen al remoto (`~/.cache/orchestra-paste/`) por ssh con los mismos
//!   argumentos y el mismo askpass de la bóveda que las métricas del servidor; el archivo entra por stdin a `cat`.
//! - Al arrancar se borran las imágenes guardadas de más de 24 h.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::remote_metrics::{base_args, build_env, Dest};

/// Tope del PNG guardado (y del archivo que se sube por SSH).
pub const MAX_BYTES: u64 = 25 * 1024 * 1024;
/// Tope de píxeles antes de codificar (evita reservar gigas con un portapapeles absurdo).
pub const MAX_PIXELS: u64 = 100_000_000;
/// Antigüedad a partir de la cual se borran las imágenes guardadas.
pub const MAX_AGE: Duration = Duration::from_secs(24 * 3600);
/// Prefijo de los archivos propios (la limpieza solo toca estos).
const PREFIX: &str = "img-";
/// Carpeta remota (relativa al HOME) donde se suben las imágenes.
pub const REMOTE_DIR: &str = ".cache/orchestra-paste";
/// Extensiones que se aceptan como imagen al arrastrar o subir.
pub const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImgInfo {
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

// ---------- nombres y fechas (puro) ----------

/// Fecha civil (UTC) de unos segundos desde 1970: (año, mes, día, hora, minuto, segundo). Algoritmo de H. Hinnant.
fn civil(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d, (rem / 3600) as u32, ((rem % 3600) / 60) as u32, (rem % 60) as u32)
}

/// `img-AAAAMMDD-HHMMSS-xxxx.<ext>` (hora UTC; `xxxx` = 4 hexadecimales al azar para no pisar dos del mismo segundo).
pub fn file_name(secs: u64, rand: u16, ext: &str) -> String {
    let (y, mo, d, h, mi, s) = civil(secs);
    format!("{PREFIX}{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}-{rand:04x}.{ext}")
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn rand16() -> u16 {
    let mut b = [0u8; 2];
    let _ = getrandom::fill(&mut b);
    u16::from_le_bytes(b)
}

/// Extensión de imagen admitida (en minúsculas) de una ruta, o `None`.
pub fn image_ext(path: &str) -> Option<String> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_EXTS.contains(&ext.as_str()).then_some(ext)
}

// ---------- guardado (puro sobre una carpeta) ----------

/// Codifica RGBA8 en PNG.
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut w = enc.write_header().map_err(|e| e.to_string())?;
        w.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Guarda una imagen RGBA como PNG en `dir` con nombre propio. Falla (sin escribir nada) si los datos no cuadran o si el
/// PNG pasa de `max_bytes`. El error de tamaño empieza por `too-large:` seguido de los bytes, para que la interfaz lo traduzca.
pub fn save_rgba(dir: &Path, width: u32, height: u32, rgba: &[u8], max_bytes: u64, secs: u64, rand: u16) -> Result<Saved, String> {
    if width == 0 || height == 0 {
        return Err("empty image".into());
    }
    let px = width as u64 * height as u64;
    if px > MAX_PIXELS {
        return Err(format!("too-large:{}", px * 4));
    }
    if rgba.len() as u64 != px * 4 {
        return Err("bad image data".into());
    }
    let png = encode_png(width, height, rgba)?;
    if png.len() as u64 > max_bytes {
        return Err(format!("too-large:{}", png.len()));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(file_name(secs, rand, "png"));
    // Escritura atómica: el agente nunca ve un PNG a medias.
    let tmp = path.with_extension("png.tmp");
    std::fs::write(&tmp, &png).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(Saved { path: path.to_string_lossy().into_owned(), width, height, bytes: png.len() as u64 })
}

/// Borra de `dir` los archivos propios (`img-*`) modificados hace más de `max_age`. Devuelve cuántos borró.
pub fn cleanup(dir: &Path, now: SystemTime, max_age: Duration) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    let mut n = 0;
    for e in rd.flatten() {
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(PREFIX) {
            continue;
        }
        let Ok(md) = e.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        let old = md.modified().ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age > max_age);
        if old && std::fs::remove_file(e.path()).is_ok() {
            n += 1;
        }
    }
    n
}

/// Carpeta de las imágenes pegadas: `<ORCHESTRA_DATA_DIR>/cache/paste` en modo aislado; si no, la caché de la app
/// (`%LOCALAPPDATA%\dev.orchestra.app\paste`).
pub fn paste_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(d) = std::env::var_os("ORCHESTRA_DATA_DIR").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(d).join("cache").join("paste"));
    }
    app.path().app_cache_dir().map(|d| d.join("paste")).map_err(|e| e.to_string())
}

/// Limpieza al arrancar (en otro hilo: no retrasa la ventana).
pub fn cleanup_on_start(app: &AppHandle) {
    if let Ok(dir) = paste_dir(app) {
        std::thread::spawn(move || {
            cleanup(&dir, SystemTime::now(), MAX_AGE);
        });
    }
}

// ---------- portapapeles ----------

fn read_clipboard_image() -> Option<arboard::ImageData<'static>> {
    let mut cb = arboard::Clipboard::new().ok()?;
    cb.get_image().ok()
}

#[tauri::command(async)]
pub fn clipboard_image_info() -> Option<ImgInfo> {
    read_clipboard_image().map(|i| ImgInfo { width: i.width as u32, height: i.height as u32 })
}

/// Copia texto al portapapeles del sistema (copiar del terminal y demás «Copiar» de la app). Se hace desde Rust y no
/// con `navigator.clipboard.writeText`, que depende del foco del documento de WebView2 y cuyos fallos se perdían.
#[tauri::command(async)]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

/// `Ok(None)` si el portapapeles no trae imagen.
#[tauri::command(async)]
pub fn clipboard_image_to_file(app: AppHandle) -> Result<Option<Saved>, String> {
    let Some(img) = read_clipboard_image() else { return Ok(None) };
    let dir = paste_dir(&app)?;
    save_rgba(&dir, img.width as u32, img.height as u32, &img.bytes, MAX_BYTES, now_secs(), rand16()).map(Some)
}

// ---------- subida por SSH ----------

/// Orden remota: limpia las de más de 24 h, crea la carpeta, escribe stdin en el archivo y devuelve su ruta absoluta.
/// `name` ya viene saneado (solo `[A-Za-z0-9._-]`), así que no hace falta citarlo. Vale en sh, bash, zsh y fish ≥ 3.
pub fn remote_upload_cmd(name: &str) -> String {
    format!(
        "find ~/{REMOTE_DIR} -name '{PREFIX}*' -mmin +1440 -delete 2>/dev/null; \
         mkdir -p ~/{REMOTE_DIR} && cat > ~/{REMOTE_DIR}/{name} && printf '%s\\n' \"$HOME/{REMOTE_DIR}/{name}\""
    )
}

fn safe_name(n: &str) -> bool {
    !n.is_empty() && !n.starts_with('-') && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Orden `ssh` completa (sin secretos: el askpass va por el entorno con el NOMBRE de la entrada de la bóveda).
pub fn upload_command(dest: &Dest, name: &str) -> std::process::Command {
    let mut a = base_args(dest);
    a.push(remote_upload_cmd(name));
    let mut c = std::process::Command::new("ssh");
    c.args(a);
    for (k, v) in build_env(dest) {
        c.env(k, v);
    }
    c
}

/// Sube `path` (imagen local de hasta 25 MB) a `~/.cache/orchestra-paste/` del host y devuelve la ruta remota.
#[tauri::command(async)]
pub fn ssh_upload_image(dest: Dest, path: String) -> Result<String, String> {
    dest.validate()?;
    let ext = image_ext(&path).ok_or_else(|| "not-image".to_string())?;
    let md = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if md.len() > MAX_BYTES {
        return Err(format!("too-large:{}", md.len()));
    }
    let name = file_name(now_secs(), rand16(), &ext);
    debug_assert!(safe_name(&name));
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let out = crate::mcp_exec::run_process_stdin(upload_command(&dest, &name), file.into(), Duration::from_secs(90), 16 * 1024);
    if let Some(e) = out.spawn_error {
        return Err(e);
    }
    if out.timed_out {
        return Err("timeout".into());
    }
    let remote = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.exit_code != Some(0) || !remote.ends_with(&name) {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("ssh exit {:?}", out.exit_code) } else { err });
    }
    Ok(remote)
}

// ---------- arrastrar archivos desde el Explorador ----------
//
// Con `dragDropEnabled: false` (necesario para el arrastre interno HTML5 en Windows) Tauri no da las rutas de lo que se
// suelta. WebView2 sí: la página llama a `chrome.webview.postMessageWithAdditionalObjects(msg, files)` y aquí llegan los
// `ICoreWebView2File` con su ruta. Se emite el evento `orchestra-file-drop` con `{ pane, paths }`.
// El mensaje TIENE que ser una cadena: el manejador IPC de wry va primero y, con un objeto, devuelve error y WebView2 ya
// no llama a los siguientes (medido). Con la cadena `orchestra-drop:<id>` wry se la pasa a Tauri, que no la entiende y
// solo deja un console.error inofensivo; luego llega aquí.

#[derive(Serialize, Clone)]
struct DropPaths {
    pane: String,
    paths: Vec<String>,
}

/// `orchestra-drop:<id del panel>` -> id (puro, para probarlo).
pub fn drop_pane_of(msg: &str) -> Option<String> {
    let id = msg.strip_prefix("orchestra-drop:")?;
    (!id.is_empty() && id.len() <= 128).then(|| id.to_string())
}

#[cfg(windows)]
pub fn install_drop_bridge(app: &AppHandle) {
    use tauri::Emitter;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use webview2_com::WebMessageReceivedEventHandler;
    use windows_core::{Interface, PWSTR};

    let Some(win) = app.get_webview_window("main") else { return };
    let app2 = app.clone();
    let _ = win.with_webview(move |wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut js = PWSTR::null();
            if args.TryGetWebMessageAsString(&mut js).is_err() {
                return Ok(());
            }
            let msg = take_pwstr(js);
            let Some(pane) = drop_pane_of(&msg) else { return Ok(()) };
            let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() else { return Ok(()) };
            let objs = args2.AdditionalObjects()?;
            let mut n = 0u32;
            objs.Count(&mut n)?;
            let mut paths = Vec::new();
            for i in 0..n.min(64) {
                let Ok(obj) = objs.GetValueAtIndex(i) else { continue };
                let Ok(f) = obj.cast::<ICoreWebView2File>() else { continue };
                let mut p = PWSTR::null();
                if f.Path(&mut p).is_ok() {
                    let s = take_pwstr(p);
                    if !s.is_empty() {
                        paths.push(s);
                    }
                }
            }
            if !paths.is_empty() {
                let _ = app2.emit("orchestra-file-drop", DropPaths { pane, paths });
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core.add_WebMessageReceived(&handler, &mut token);
    });
}

#[cfg(not(windows))]
pub fn install_drop_bridge(_app: &AppHandle) {}

/// PWSTR reservada por WebView2 -> String (y se libera).
#[cfg(windows)]
unsafe fn take_pwstr(p: windows_core::PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let s = p.to_string().unwrap_or_default();
    windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _));
    s
}

// ---------- pruebas ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("orchestra-clipimg-{tag}-{}", rand16()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn rgba(w: u32, h: u32) -> Vec<u8> {
        (0..w * h).flat_map(|i| [(i % 251) as u8, (i % 13) as u8 * 19, 200, 255]).collect()
    }

    #[test]
    fn file_name_has_date_time_and_random_suffix() {
        // 2026-10-31 13:45:09 UTC
        assert_eq!(file_name(1_793_454_309, 0x0a1b, "png"), "img-20261031-134509-0a1b.png");
        assert_eq!(file_name(0, 0, "jpg"), "img-19700101-000000-0000.jpg");
        // 29 de febrero de un bisiesto
        assert_eq!(file_name(951_782_400, 0xffff, "png"), "img-20000229-000000-ffff.png");
        assert!(safe_name(&file_name(1_793_454_309, 7, "png")));
    }

    #[test]
    fn saves_a_valid_png_with_same_dimensions() {
        let d = tmpdir("save");
        let s = save_rgba(&d, 37, 21, &rgba(37, 21), MAX_BYTES, 1_793_454_309, 1).unwrap();
        assert!(s.path.ends_with("img-20261031-134509-0001.png"));
        assert_eq!((s.width, s.height), (37, 21));
        let bytes = std::fs::read(&s.path).unwrap();
        assert_eq!(bytes.len() as u64, s.bytes);
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        let dec = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut r = dec.read_info().unwrap();
        let mut buf = vec![0; r.output_buffer_size().unwrap()];
        let info = r.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (37, 21));
        assert_eq!(&buf[..info.buffer_size()], &rgba(37, 21)[..]);
        // sin restos del guardado atómico
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rejects_bad_data_and_oversize_without_writing() {
        let d = tmpdir("cap");
        assert!(save_rgba(&d, 4, 4, &[0; 10], MAX_BYTES, 0, 0).is_err());
        assert!(save_rgba(&d, 0, 4, &[], MAX_BYTES, 0, 0).is_err());
        let e = save_rgba(&d, 64, 64, &rgba(64, 64), 100, 0, 0).unwrap_err();
        assert!(e.starts_with("too-large:"), "{e}");
        let e = save_rgba(&d, 20_000, 10_000, &[], MAX_BYTES, 0, 0).unwrap_err();
        assert!(e.starts_with("too-large:"), "{e}");
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn cleanup_only_removes_own_old_files() {
        let d = tmpdir("clean");
        let own = d.join("img-20200101-000000-0000.png");
        let other = d.join("notes.txt");
        std::fs::write(&own, b"x").unwrap();
        std::fs::write(&other, b"x").unwrap();
        // Recién creados: nada que borrar.
        assert_eq!(cleanup(&d, SystemTime::now(), MAX_AGE), 0);
        // «Ahora» dentro de 25 h: el propio sí, el ajeno no.
        let later = SystemTime::now() + Duration::from_secs(25 * 3600);
        assert_eq!(cleanup(&d, later, MAX_AGE), 1);
        assert!(!own.exists());
        assert!(other.exists());
        assert_eq!(cleanup(&d.join("no-existe"), later, MAX_AGE), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn image_ext_only_accepts_images() {
        assert_eq!(image_ext(r"C:\a b\Shot.PNG").as_deref(), Some("png"));
        assert_eq!(image_ext("/x/y.jpeg").as_deref(), Some("jpeg"));
        assert_eq!(image_ext("/x/y.txt"), None);
        assert_eq!(image_ext("/x/png"), None);
    }

    #[test]
    fn upload_command_uses_strict_hostkey_and_no_secret_in_args() {
        let d = Dest { user: Some("me".into()), host: "srv.example.com".into(), port: 2222, secret_key: Some("host:h1:password".into()), ..Default::default() };
        let c = upload_command(&d, "img-20261031-134509-0001.png");
        let args: Vec<String> = c.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.iter().any(|a| a == "StrictHostKeyChecking=yes"));
        assert!(args.iter().any(|a| a == "RemoteCommand=none"));
        let target = args.iter().position(|a| a == "me@srv.example.com").unwrap();
        assert_eq!(args[target - 1], "--");
        assert_eq!(args.len(), target + 2, "la orden remota es UN solo argumento al final");
        let remote = &args[target + 1];
        assert!(remote.contains("cat > ~/.cache/orchestra-paste/img-20261031-134509-0001.png"));
        assert!(remote.contains("\"$HOME/.cache/orchestra-paste/img-20261031-134509-0001.png\""));
        assert!(!args.iter().any(|a| a.contains("password") && a != "host:h1:password"));
        assert!(!args.iter().any(|a| a == "host:h1:password"), "el nombre del secreto va por el entorno");
        let envs: Vec<(String, String)> = c.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()).unwrap_or_default())).collect();
        assert!(envs.iter().any(|(k, v)| k == "ORCHESTRA_ASKPASS_KEY" && v == "host:h1:password"));
    }

    #[test]
    fn drop_message_parsing() {
        assert_eq!(drop_pane_of("orchestra-drop:p-1").as_deref(), Some("p-1"));
        assert_eq!(drop_pane_of("orchestra-drop:"), None);
        assert_eq!(drop_pane_of(r#"{"cmd":"x"}"#), None);
        assert_eq!(drop_pane_of("p-1"), None);
        assert_eq!(drop_pane_of(&format!("orchestra-drop:{}", "x".repeat(200))), None);
    }

    /// Prueba manual con el portapapeles REAL: guarda lo que hubiera (texto o imagen), pone una imagen de 123×45 con
    /// PowerShell (System.Windows.Forms.Clipboard.SetImage), la lee como lo hace el comando y lo restaura al final.
    /// `cargo test --bin orchestra clipboard_real -- --ignored --nocapture`
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn clipboard_real_roundtrip_png_same_size() {
        let mut cb = arboard::Clipboard::new().unwrap();
        let saved_text = cb.get_text().ok();
        let saved_img = cb.get_image().ok().map(|i| i.to_owned_img());
        drop(cb);
        let ps = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; \
                  $b = New-Object System.Drawing.Bitmap 123,45; \
                  $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::FromArgb(255,30,144,255)); $g.Dispose(); \
                  [System.Windows.Forms.Clipboard]::SetImage($b)";
        let st = std::process::Command::new("powershell.exe").args(["-NoProfile", "-STA", "-Command", ps]).status().unwrap();
        assert!(st.success());
        let img = read_clipboard_image();
        // Restaurar SIEMPRE antes de comprobar nada.
        let mut cb = arboard::Clipboard::new().unwrap();
        match (&saved_img, &saved_text) {
            (Some(i), _) => { let _ = cb.set_image(i.clone()); }
            (None, Some(t)) => { let _ = cb.set_text(t.clone()); }
            _ => { let _ = cb.clear(); }
        }
        let img = img.expect("no se leyó la imagen del portapapeles");
        let d = tmpdir("real");
        let s = save_rgba(&d, img.width as u32, img.height as u32, &img.bytes, MAX_BYTES, now_secs(), rand16()).unwrap();
        println!("PNG {} {}x{} {} bytes", s.path, s.width, s.height, s.bytes);
        assert_eq!((s.width, s.height), (123, 45));
        let dec = png::Decoder::new(std::io::Cursor::new(std::fs::read(&s.path).unwrap()));
        let r = dec.read_info().unwrap();
        assert_eq!((r.info().width, r.info().height), (123, 45));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Prueba manual con el portapapeles REAL: copia texto con acentos y emoji por el comando, lo lee con PowerShell
    /// (Get-Clipboard) y restaura lo que hubiera. `cargo test --bin orchestra clipboard_real_text -- --ignored --nocapture`
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn clipboard_real_text_write() {
        let mut cb = arboard::Clipboard::new().unwrap();
        let saved_text = cb.get_text().ok();
        let saved_img = cb.get_image().ok().map(|i| i.to_owned_img());
        drop(cb);
        let want = "copia ñandú 😀\nlínea 2";
        let r = clipboard_write_text(want.to_string());
        let out = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-STA", "-Command", "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw"])
            .output()
            .unwrap();
        // Restaurar SIEMPRE antes de comprobar nada.
        let mut cb = arboard::Clipboard::new().unwrap();
        match (&saved_img, &saved_text) {
            (Some(i), _) => { let _ = cb.set_image(i.clone()); }
            (None, Some(t)) => { let _ = cb.set_text(t.clone()); }
            _ => { let _ = cb.clear(); }
        }
        r.unwrap();
        let got = String::from_utf8_lossy(&out.stdout).replace("\r\n", "\n");
        println!("leído: {got:?}");
        assert_eq!(got.trim_end_matches('\n'), want);
    }
}
