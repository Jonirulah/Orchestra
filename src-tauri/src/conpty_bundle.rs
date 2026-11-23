//! ConPTY propio: conpty.dll + OpenConsole.exe del paquete oficial Microsoft.Windows.Console.ConPTY (MIT),
//! incrustados en el exe y extraídos a la carpeta de datos al arrancar.
//!
//! Por qué: portable-pty usa el ConPTY de kernel32 (el conhost del sistema) salvo que pueda cargar un
//! conpty.dll por nombre. El conhost de Windows 10 (19041-19045) es anterior al soporte de ratón por ConPTY:
//! los clics no llegan a las apps de terminal (Claude Code, vim, htop por ssh…). Con el conpty.dll de este
//! módulo YA CARGADO en el proceso (LoadLibraryW con la ruta completa), el LoadLibrary("conpty.dll") de
//! portable-pty devuelve ese mismo módulo, y conpty.dll lanza el OpenConsole.exe que tiene al lado.
//!
//! Ojo: portable-pty decide una sola vez por proceso (lazy_static), en el primer PTY. Hay que llamar a
//! init() antes de abrir ninguno.
//!
//! Por defecto solo se usa en Windows 10 (build < 22000); en Windows 11 se queda el del sistema.
//! ORCHESTRA_CONPTY=bundled|system lo fuerza. Si algo falla, se sigue con el del sistema y el motivo
//! queda en conpty.log, en la carpeta de datos.

use std::path::Path;

/// Versión del paquete NuGet vendorizado en src-tauri/vendor/conpty (ver su README.md).
pub const PACKAGE_VERSION: &str = "1.25.261109001";
/// Variable de entorno que fuerza la elección: bundled o system.
pub const ENV_VAR: &str = "ORCHESTRA_CONPTY";
/// Primera build de Windows 11: a partir de aquí el ConPTY del sistema ya reenvía el ratón.
const FIRST_GOOD_SYSTEM_BUILD: u32 = 22000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    /// El conpty.dll + OpenConsole.exe incrustados.
    Bundled,
    /// El de kernel32 (conhost del sistema): no se carga nada.
    System,
}

/// Decisión pura. build es la build real de Windows (0 = no se pudo leer) y env el valor de ORCHESTRA_CONPTY.
pub fn decide(build: u32, env: Option<&str>) -> Choice {
    match env.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("bundled") => Choice::Bundled,
        Some("system") => Choice::System,
        // Cualquier otro valor (o ninguno): según la versión de Windows.
        _ if build != 0 && build < FIRST_GOOD_SYSTEM_BUILD => Choice::Bundled,
        _ => Choice::System,
    }
}

/// Decide, extrae y precarga. Llamar una vez al arrancar, antes de abrir ningún PTY. Nunca falla hacia
/// fuera: si no se puede usar el incluido se sigue con el del sistema. Deja una línea en data_dir/conpty.log.
pub fn init(data_dir: &Path) {
    let build = windows_build();
    let env = std::env::var(ENV_VAR).ok();
    let line = match decide(build, env.as_deref()) {
        Choice::System => format!("system (Windows build {build}, {ENV_VAR}={})", env.as_deref().unwrap_or("-")),
        Choice::Bundled => {
            let t0 = std::time::Instant::now();
            match use_bundled(data_dir) {
                Ok(dir) => format!("bundled {PACKAGE_VERSION} (Windows build {build}) from {} in {} ms", dir.display(), t0.elapsed().as_millis()),
                Err(e) => format!("bundled {PACKAGE_VERSION} FAILED, using system (Windows build {build}): {e}"),
            }
        }
    };
    // Registro: una línea por arranque (se reescribe; la app no tiene otro log en disco).
    let _ = std::fs::create_dir_all(data_dir);
    let _ = std::fs::write(data_dir.join("conpty.log"), format!("conpty: {line}\n"));
}

/// Extrae a base/conpty/<versión>-<hash> y precarga conpty.dll. Devuelve la carpeta usada.
pub fn use_bundled(base: &Path) -> Result<std::path::PathBuf, String> {
    let dir = imp::extract(base)?;
    imp::preload(&dir)?;
    Ok(dir)
}

/// Build real de Windows (RtlGetVersion: GetVersionEx miente sin manifiesto). 0 si no se pudo leer.
pub fn windows_build() -> u32 {
    imp::windows_build()
}

/// Ruta del conpty.dll cargado en este proceso, si hay alguno.
#[cfg(test)]
pub fn loaded_dll() -> Option<std::path::PathBuf> {
    imp::loaded_dll()
}

/// En las pruebas no corre main(): con ORCHESTRA_CONPTY=bundled, toda la batería usa el ConPTY incluido
/// (extraído a una carpeta temporal fija). Lo llama pty::spawn. Si falla, revienta: nada de verdes falsos.
#[cfg(test)]
pub fn test_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if decide(FIRST_GOOD_SYSTEM_BUILD, std::env::var(ENV_VAR).ok().as_deref()) == Choice::Bundled {
            use_bundled(&test_dir()).expect("ORCHESTRA_CONPTY=bundled pero no se pudo precargar");
        }
    });
}

/// Carpeta temporal de las pruebas (nunca la de datos de la app).
#[cfg(test)]
pub fn test_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("orchestra-conpty-test")
}

#[cfg(all(windows, target_arch = "x86_64"))]
mod imp {
    use sha2::{Digest, Sha256};
    use std::ffi::c_void;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Path, PathBuf};

    const DLL_NAME: &str = "conpty.dll";
    const HOST_NAME: &str = "OpenConsole.exe";
    static DLL: &[u8] = include_bytes!("../vendor/conpty/conpty.dll");
    static HOST: &[u8] = include_bytes!("../vendor/conpty/OpenConsole.exe");
    /// SHA-256 de los binarios vendorizados (los mismos que en vendor/conpty/README.md; una prueba lo vigila).
    pub const DLL_SHA256: &str = "e971856f89748dc3b458125e9afdd79b5e9574a7c937676116d3cbbd3b71f492";
    pub const HOST_SHA256: &str = "b17e48b07ef153b420f0a6e178bacd31fb4c3390e21ae746586213fc0719a775";

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryW(name: *const u16) -> *mut c_void;
        fn FreeLibrary(module: *mut c_void) -> i32;
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        fn GetModuleFileNameW(module: *mut c_void, buf: *mut u16, len: u32) -> u32;
        fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
        fn CreatePipe(read: *mut *mut c_void, write: *mut *mut c_void, attrs: *const c_void, size: u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetCurrentProcessId() -> u32;
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry) -> i32;
    }

    #[repr(C)]
    struct ProcessEntry {
        size: u32,
        usage: u32,
        pid: u32,
        heap: usize,
        module: u32,
        threads: u32,
        parent: u32,
        priority: i32,
        flags: u32,
        exe: [u16; 260],
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Coord {
        x: i16,
        y: i16,
    }

    type CreateFn = unsafe extern "system" fn(Coord, *mut c_void, *mut c_void, u32, *mut *mut c_void) -> i32;
    type CloseFn = unsafe extern "system" fn(*mut c_void);

    #[repr(C)]
    struct OsVersionInfoW {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        csd: [u16; 128],
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfoW) -> i32;
    }

    pub fn windows_build() -> u32 {
        let mut info = OsVersionInfoW { size: std::mem::size_of::<OsVersionInfoW>() as u32, major: 0, minor: 0, build: 0, platform: 0, csd: [0; 128] };
        // SAFETY: la estructura tiene el tamaño que declara y RtlGetVersion solo la rellena.
        if unsafe { RtlGetVersion(&mut info) } == 0 {
            info.build
        } else {
            0
        }
    }

    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn sha256_hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn file_matches(path: &Path, sha: &str) -> bool {
        std::fs::read(path).map(|b| sha256_hex(&b) == sha).unwrap_or(false)
    }

    /// Deja en disco un archivo con ese contenido exacto. Si ya está bien no lo toca (otra instancia puede
    /// tenerlo abierto); si no, escribe a un temporal propio y lo renombra encima (atómico).
    fn ensure_file(path: &Path, bytes: &[u8], sha: &str) -> Result<(), String> {
        if file_matches(path, sha) {
            return Ok(());
        }
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
        let tmp = path.with_extension(format!("tmp-{}-{nanos}", std::process::id()));
        let written = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, path));
        if let Err(e) = written {
            let _ = std::fs::remove_file(&tmp);
            // Otra instancia pudo ganar la carrera: vale si lo que hay ya es lo correcto.
            if !file_matches(path, sha) {
                return Err(format!("could not write {}: {e}", path.display()));
            }
        }
        if file_matches(path, sha) {
            Ok(())
        } else {
            Err(format!("{} does not match its SHA-256 after writing", path.display()))
        }
    }

    /// Extrae los dos binarios a base/conpty/<versión>-<hash> (una carpeta por versión: una actualización
    /// nunca pisa los que tiene cargados una instancia vieja). Verifica el SHA-256 de lo que queda en disco.
    pub fn extract(base: &Path) -> Result<PathBuf, String> {
        let dir = base.join("conpty").join(format!("{}-{}", super::PACKAGE_VERSION, &DLL_SHA256[..12]));
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        ensure_file(&dir.join(HOST_NAME), HOST, HOST_SHA256)?;
        ensure_file(&dir.join(DLL_NAME), DLL, DLL_SHA256)?;
        Ok(dir)
    }

    pub fn loaded_dll() -> Option<PathBuf> {
        let name = wide(Path::new(DLL_NAME));
        // SAFETY: cadena UTF-16 terminada en cero; el búfer tiene la longitud que se pasa.
        unsafe {
            let module = GetModuleHandleW(name.as_ptr());
            if module.is_null() {
                return None;
            }
            let mut buf = vec![0u16; 1024];
            let n = GetModuleFileNameW(module, buf.as_mut_ptr(), buf.len() as u32) as usize;
            (n > 0 && n < buf.len()).then(|| PathBuf::from(std::ffi::OsString::from_wide(&buf[..n])))
        }
    }

    fn same_file(a: &Path, b: &Path) -> bool {
        match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    }

    /// ¿Tiene este proceso un hijo con ese nombre de ejecutable?
    fn has_child_named(name: &str) -> bool {
        const TH32CS_SNAPPROCESS: u32 = 0x2;
        // SAFETY: API Toolhelp con la estructura del tamaño declarado; la instantánea se cierra al acabar.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap.is_null() || snap as isize == -1 {
                return false;
            }
            let me = GetCurrentProcessId();
            let mut e: ProcessEntry = std::mem::zeroed();
            e.size = std::mem::size_of::<ProcessEntry>() as u32;
            let mut found = false;
            let mut more = Process32FirstW(snap, &mut e) != 0;
            while more {
                let len = e.exe.iter().position(|c| *c == 0).unwrap_or(e.exe.len());
                if e.parent == me && String::from_utf16_lossy(&e.exe[..len]).eq_ignore_ascii_case(name) {
                    found = true;
                    break;
                }
                more = Process32NextW(snap, &mut e) != 0;
            }
            CloseHandle(snap);
            found
        }
    }

    /// Abre y cierra una pseudoconsola de prueba con el conpty.dll recién cargado y mira que el anfitrión que
    /// arranca es OpenConsole.exe. Medido: si conpty.dll no puede lanzar el OpenConsole.exe de su carpeta
    /// (falta, antivirus, AppLocker) cae SIN AVISAR al conhost del sistema, y mezclar el conpty.dll nuevo con
    /// un conhost viejo no está probado. Mejor enterarse aquí y seguir con el del sistema entero.
    fn probe(create: CreateFn, close: CloseFn) -> Result<(), String> {
        // SAFETY: tuberías propias; la pseudoconsola se cierra antes de salir; create/close son los símbolos
        // exportados por conpty.dll con la firma documentada de CreatePseudoConsole/ClosePseudoConsole.
        unsafe {
            let (mut in_r, mut in_w, mut out_r, mut out_w) = (std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
            if CreatePipe(&mut in_r, &mut in_w, std::ptr::null(), 0) == 0 {
                return Err(format!("CreatePipe failed: {}", std::io::Error::last_os_error()));
            }
            if CreatePipe(&mut out_r, &mut out_w, std::ptr::null(), 0) == 0 {
                let e = std::io::Error::last_os_error();
                CloseHandle(in_r);
                CloseHandle(in_w);
                return Err(format!("CreatePipe failed: {e}"));
            }
            let mut con: *mut c_void = std::ptr::null_mut();
            let hr = create(Coord { x: 80, y: 24 }, in_r, out_w, 0, &mut con);
            let ok = if hr != 0 {
                Err(format!("CreatePseudoConsole failed: HRESULT {hr:#x}"))
            } else if has_child_named(HOST_NAME) {
                Ok(())
            } else {
                Err(format!("{HOST_NAME} did not start (blocked by security software?)"))
            };
            // Nadie lee la salida: se cierra ese extremo primero para que el anfitrión no se quede escribiendo.
            CloseHandle(out_r);
            CloseHandle(in_w);
            if hr == 0 {
                close(con);
            }
            CloseHandle(in_r);
            CloseHandle(out_w);
            ok
        }
    }

    /// Carga dir/conpty.dll con su ruta completa. A partir de aquí, cualquier LoadLibrary("conpty.dll") del
    /// proceso (el de portable-pty) devuelve este módulo. El módulo se queda cargado hasta que el proceso acaba.
    pub fn preload(dir: &Path) -> Result<(), String> {
        let dll = dir.join(DLL_NAME);
        if let Some(already) = loaded_dll() {
            return if same_file(&already, &dll) { Ok(()) } else { Err(format!("another conpty.dll is already loaded: {}", already.display())) };
        }
        if !dir.join(HOST_NAME).is_file() {
            return Err(format!("{HOST_NAME} is missing in {}", dir.display()));
        }
        let name = wide(&dll);
        // SAFETY: ruta UTF-16 terminada en cero de un archivo cuyo SHA-256 se acaba de comprobar.
        let module = unsafe { LoadLibraryW(name.as_ptr()) };
        if module.is_null() {
            return Err(format!("LoadLibraryW({}) failed: {}", dll.display(), std::io::Error::last_os_error()));
        }
        // Los tres símbolos que busca portable-pty: si falta alguno se iría al de kernel32 sin avisar.
        let mut syms = [std::ptr::null_mut(); 3];
        for (i, sym) in [&b"CreatePseudoConsole\0"[..], b"ClosePseudoConsole\0", b"ResizePseudoConsole\0"].into_iter().enumerate() {
            // SAFETY: módulo válido y nombre ASCII terminado en cero.
            syms[i] = unsafe { GetProcAddress(module, sym.as_ptr()) };
            if syms[i].is_null() {
                // SAFETY: se libera la referencia tomada arriba; nadie más lo ha cargado aún.
                unsafe { FreeLibrary(module) };
                return Err(format!("conpty.dll does not export {}", String::from_utf8_lossy(&sym[..sym.len() - 1])));
            }
        }
        // SAFETY: punteros no nulos a funciones exportadas con esas firmas (las de la API de ConPTY).
        let (create, close) = unsafe { (std::mem::transmute::<*mut c_void, CreateFn>(syms[0]), std::mem::transmute::<*mut c_void, CloseFn>(syms[1])) };
        if let Err(e) = probe(create, close) {
            // Se descarga: el LoadLibrary("conpty.dll") de portable-pty no lo encontrará y usará kernel32.
            // SAFETY: única referencia al módulo; la pseudoconsola de prueba ya está cerrada.
            unsafe { FreeLibrary(module) };
            return Err(e);
        }
        Ok(())
    }
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
mod imp {
    use std::path::{Path, PathBuf};

    pub fn windows_build() -> u32 {
        0
    }
    pub fn extract(_base: &Path) -> Result<PathBuf, String> {
        Err("no bundled ConPTY for this platform".into())
    }
    pub fn preload(_dir: &Path) -> Result<(), String> {
        Err("no bundled ConPTY for this platform".into())
    }
    #[cfg(test)]
    pub fn loaded_dll() -> Option<PathBuf> {
        None
    }
}

#[cfg(all(test, windows, target_arch = "x86_64"))]
#[path = "conpty_bundle_tests.rs"]
mod tests;
