//! Pruebas del ConPTY incluido. Las que abren un PTY real corren cada una en SU PROCESO (se relanza este
//! mismo binario de pruebas): portable-pty elige el ConPTY una sola vez por proceso.

use super::imp::{extract, preload, sha256_hex, DLL_SHA256, HOST_SHA256};
use super::*;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::ffi::c_void;
use std::io::{Read, Write};
use std::os::windows::io::AsRawHandle;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Papel del proceso relanzado: "bundled", "system" o "hijo" (el programa que corre DENTRO del PTY).
const ROLE_VAR: &str = "ORCHESTRA_CONPTY_INTERNO";

// ---------- puras ----------

#[test]
fn la_decision_depende_de_la_build_y_de_la_variable() {
    // Sin variable: Windows 10 usa el incluido, Windows 11 el del sistema.
    assert_eq!(decide(19045, None), Choice::Bundled);
    assert_eq!(decide(19041, None), Choice::Bundled);
    assert_eq!(decide(17763, None), Choice::Bundled);
    assert_eq!(decide(21999, None), Choice::Bundled);
    assert_eq!(decide(22000, None), Choice::System);
    assert_eq!(decide(26200, None), Choice::System);
    // Build desconocida: no se toca nada.
    assert_eq!(decide(0, None), Choice::System);
    // La variable manda en los dos sentidos, sin distinguir mayúsculas ni espacios.
    assert_eq!(decide(26200, Some("bundled")), Choice::Bundled);
    assert_eq!(decide(26200, Some(" Bundled ")), Choice::Bundled);
    assert_eq!(decide(19045, Some("system")), Choice::System);
    assert_eq!(decide(19045, Some("SYSTEM")), Choice::System);
    // Valor desconocido o vacío = como si no estuviera.
    assert_eq!(decide(19045, Some("")), Choice::Bundled);
    assert_eq!(decide(26200, Some("si")), Choice::System);
}

#[test]
fn la_build_real_se_lee() {
    let b = windows_build();
    assert!(b >= 17763, "build leída: {b}");
}

#[test]
fn los_binarios_incrustados_son_los_del_readme() {
    let dll = include_bytes!("../vendor/conpty/conpty.dll");
    let host = include_bytes!("../vendor/conpty/OpenConsole.exe");
    assert_eq!(sha256_hex(dll), DLL_SHA256);
    assert_eq!(sha256_hex(host), HOST_SHA256);
    let readme = include_str!("../vendor/conpty/README.md");
    assert!(readme.contains(DLL_SHA256) && readme.contains(HOST_SHA256) && readme.contains(PACKAGE_VERSION), "README de vendor desfasado");
}

#[test]
fn extraer_es_idempotente_y_repara_un_archivo_roto() {
    let base = std::env::temp_dir().join(format!("orchestra-conpty-extraer-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let dir = extract(&base).unwrap();
    assert!(dir.starts_with(base.join("conpty")), "carpeta: {dir:?}");
    assert!(dir.file_name().unwrap().to_string_lossy().starts_with(PACKAGE_VERSION));
    let dll = dir.join("conpty.dll");
    let host = dir.join("OpenConsole.exe");
    assert_eq!(sha256_hex(&std::fs::read(&dll).unwrap()), DLL_SHA256);
    assert_eq!(sha256_hex(&std::fs::read(&host).unwrap()), HOST_SHA256);
    // Segunda vez: no reescribe (misma fecha de modificación).
    let antes = std::fs::metadata(&host).unwrap().modified().unwrap();
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(extract(&base).unwrap(), dir);
    assert_eq!(std::fs::metadata(&host).unwrap().modified().unwrap(), antes, "reescribió un archivo que estaba bien");
    // Archivo manipulado o a medias: se reescribe antes de cargarlo.
    std::fs::write(&dll, b"no soy una dll").unwrap();
    std::fs::write(&host, &std::fs::read(&host).unwrap()[..1000]).unwrap();
    extract(&base).unwrap();
    assert_eq!(sha256_hex(&std::fs::read(&dll).unwrap()), DLL_SHA256);
    assert_eq!(sha256_hex(&std::fs::read(&host).unwrap()), HOST_SHA256);
    // No quedan temporales.
    let sobras: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(sobras.len(), 2, "sobras: {sobras:?}");
    // Sin OpenConsole.exe al lado no se precarga (conpty.dll se iría al conhost del sistema sin avisar).
    std::fs::remove_file(&host).unwrap();
    assert!(preload(&dir).is_err());
    // Carpeta imposible: error, no pánico.
    let archivo = base.join("soy-un-archivo");
    std::fs::write(&archivo, b"x").unwrap();
    assert!(extract(&archivo).is_err());
    let _ = std::fs::remove_dir_all(&base);
}

// ---------- utilidades de las pruebas con PTY real ----------

/// Un PTY abierto con portable-pty, haciendo de terminal: contesta la consulta de cursor (ESC[6n).
struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    rx: mpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
    answered: usize,
    /// Si además contesta DA1 (ESC[c), como hace xterm.js.
    answer_da1: bool,
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= hay.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|i| i + from)
}

impl Pty {
    fn open(cmd: CommandBuilder, cols: u16, rows: u16) -> Pty {
        let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).unwrap();
        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut b = [0u8; 8192];
            while let Ok(n) = reader.read(&mut b) {
                if n == 0 || tx.send(b[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        Pty { master: pair.master, writer, child, rx, buf: vec![], answered: 0, answer_da1: false }
    }

    fn send(&mut self, bytes: &[u8]) {
        self.writer.write_all(bytes).unwrap();
        self.writer.flush().unwrap();
    }

    /// Lee hasta ver el patrón (buscando desde from) o agotar el plazo. Contesta las consultas por el camino.
    fn wait_for(&mut self, pat: &[u8], from: usize, timeout: Duration) -> Option<usize> {
        let end = Instant::now() + timeout;
        loop {
            while let Some(i) = find(&self.buf, b"\x1b[6n", self.answered) {
                self.answered = i + 4;
                self.send(b"\x1b[1;1R");
            }
            if self.answer_da1 {
                if let Some(i) = find(&self.buf, b"\x1b[c", 0) {
                    self.answer_da1 = false;
                    let _ = i;
                    self.send(b"\x1b[?61;4c");
                }
            }
            if let Some(i) = find(&self.buf, pat, from) {
                return Some(i);
            }
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            if let Ok(chunk) = self.rx.recv_timeout(left.min(Duration::from_millis(50))) {
                self.buf.extend(chunk);
            }
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.buf).into_owned()
    }
}

/// Procesos anfitriones de consola hijos de este proceso: (nombre, ruta).
fn hosts() -> Vec<(String, PathBuf)> {
    use sysinfo::{ProcessesToUpdate, System};
    let me = sysinfo::Pid::from_u32(std::process::id());
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys.processes()
        .values()
        .filter(|p| p.parent() == Some(me))
        .map(|p| (p.name().to_string_lossy().to_ascii_lowercase(), p.exe().map(PathBuf::from).unwrap_or_default()))
        .filter(|(n, _)| n == "openconsole.exe" || n == "conhost.exe")
        .collect()
}

/// Papel de este proceso. None = no es un proceso relanzado: la prueba interna no hace nada.
fn role() -> Option<String> {
    std::env::var(ROLE_VAR).ok().filter(|v| !v.is_empty())
}

/// En el proceso relanzado: precarga el ConPTY incluido si el papel lo pide. Devuelve true si es bundled.
fn prepare(role: &str) -> bool {
    match role {
        "bundled" => {
            let dir = use_bundled(&test_dir()).expect("precarga");
            assert!(loaded_dll().is_some_and(|p| p.starts_with(&dir)), "conpty.dll cargado: {:?}", loaded_dll());
            true
        }
        "system" => {
            assert_eq!(loaded_dll(), None, "no debería haber conpty.dll cargado");
            false
        }
        other => panic!("papel desconocido: {other}"),
    }
}

/// Relanza este binario para correr UNA prueba interna en proceso propio. Devuelve (verde, salida).
fn run_inner(test: &str, role: &str) -> (bool, String) {
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &format!("conpty_bundle::tests::{test}"), "--ignored", "--nocapture", "--test-threads=1"])
        .env(ROLE_VAR, role)
        .env_remove(ENV_VAR)
        .output()
        .unwrap();
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    // «1 passed»: si el nombre no casara, libtest daría verde con 0 pruebas.
    let ok = out.status.success() && text.contains("1 passed");
    for l in text.lines().filter(|l| l.contains("RESULTADO")) {
        eprintln!("{l}");
    }
    (ok, text)
}

// ---------- anfitrión, eco y redimensionar ----------

#[test]
fn con_el_incluido_el_anfitrion_es_el_openconsole_extraido() {
    let (ok, out) = run_inner("interno_anfitrion", "bundled");
    assert!(ok, "{out}");
}

#[test]
fn con_el_del_sistema_el_anfitrion_es_conhost() {
    let (ok, out) = run_inner("interno_anfitrion", "system");
    assert!(ok, "{out}");
}

#[test]
#[ignore = "interna: la lanzan las pruebas de anfitrión en un proceso propio"]
fn interno_anfitrion() {
    let Some(role) = role() else { return };
    let bundled = prepare(&role);
    let mut pty = Pty::open(CommandBuilder::new("cmd.exe"), 80, 24);
    assert!(pty.wait_for(b">", 0, Duration::from_secs(15)).is_some(), "sin prompt: {:?}", pty.text());
    let hs = hosts();
    println!("RESULTADO anfitrion papel={role} hosts={hs:?}");
    if bundled {
        let dir = std::fs::canonicalize(test_dir()).unwrap();
        assert!(
            hs.iter().any(|(n, p)| n == "openconsole.exe" && std::fs::canonicalize(p).is_ok_and(|p| p.starts_with(&dir))),
            "falta el OpenConsole.exe extraído: {hs:?}"
        );
        assert!(!hs.iter().any(|(n, _)| n == "conhost.exe"), "hay un conhost.exe: {hs:?}");
    } else {
        assert!(hs.iter().any(|(n, _)| n == "conhost.exe"), "falta conhost.exe: {hs:?}");
        assert!(!hs.iter().any(|(n, _)| n == "openconsole.exe"), "hay un OpenConsole.exe: {hs:?}");
    }
    // El hijo escribe y se lee su salida.
    let from = pty.buf.len();
    pty.send(b"echo marca-%OS%\r");
    assert!(pty.wait_for(b"marca-Windows_NT", from, Duration::from_secs(10)).is_some(), "sin eco: {:?}", pty.text());
    // Redimensionar: el hijo ve el tamaño nuevo.
    pty.master.resize(PtySize { rows: 40, cols: 132, pixel_width: 0, pixel_height: 0 }).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let from = pty.buf.len();
    pty.send(b"mode con\r");
    assert!(pty.wait_for(b"132", from, Duration::from_secs(10)).is_some(), "mode con no ve 132 columnas: {:?}", pty.text());
    pty.send(b"exit\r");
    let end = Instant::now() + Duration::from_secs(10);
    while pty.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < end, "cmd no salió");
        std::thread::sleep(Duration::from_millis(50));
    }
}

// ---------- si el incluido no arranca, se sigue con el del sistema ----------

#[test]
fn si_openconsole_no_arranca_se_sigue_con_el_del_sistema() {
    let (ok, out) = run_inner("interno_respaldo", "respaldo");
    assert!(ok, "{out}");
}

#[test]
#[ignore = "interna: la lanza la prueba de respaldo en un proceso propio"]
fn interno_respaldo() {
    if role().as_deref() != Some("respaldo") {
        return;
    }
    // Un OpenConsole.exe que no se puede ejecutar (como si lo bloqueara un antivirus): la precarga lo nota,
    // descarga conpty.dll y deja el motivo en el registro.
    let base = std::env::temp_dir().join(format!("orchestra-conpty-respaldo-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let dir = extract(&base).unwrap();
    std::fs::write(dir.join("OpenConsole.exe"), b"esto no es un ejecutable").unwrap();
    let err = preload(&dir).unwrap_err();
    println!("RESULTADO respaldo: precarga rechazada: {err}");
    assert_eq!(loaded_dll(), None, "conpty.dll sigue cargado tras fallar la prueba de arranque");
    // init() entero con una carpeta de datos imposible (es un archivo): no revienta y no carga nada.
    let archivo = base.join("no-soy-carpeta");
    std::fs::write(&archivo, b"x").unwrap();
    std::env::set_var(ENV_VAR, "bundled");
    init(&archivo);
    std::env::remove_var(ENV_VAR);
    assert_eq!(loaded_dll(), None);
    // Y el PTY sigue funcionando con el del sistema.
    let mut pty = Pty::open(CommandBuilder::new("cmd.exe"), 80, 24);
    assert!(pty.wait_for(b">", 0, Duration::from_secs(15)).is_some(), "sin prompt: {:?}", pty.text());
    let hs = hosts();
    println!("RESULTADO respaldo: hosts={hs:?}");
    assert!(hs.iter().any(|(n, _)| n == "conhost.exe") && !hs.iter().any(|(n, _)| n == "openconsole.exe"), "hosts: {hs:?}");
    let from = pty.buf.len();
    pty.send(b"echo marca-%OS%\r");
    assert!(pty.wait_for(b"marca-Windows_NT", from, Duration::from_secs(10)).is_some(), "sin eco: {:?}", pty.text());
    let _ = pty.child.kill();
    drop(pty);
    let _ = std::fs::remove_dir_all(&base);
}

/// init() deja una línea en conpty.log con lo que se decidió.
#[test]
fn init_en_modo_sistema_no_carga_nada_y_lo_apunta() {
    let (ok, out) = run_inner("interno_init_sistema", "init");
    assert!(ok, "{out}");
}

#[test]
#[ignore = "interna: la lanza la prueba de init en un proceso propio"]
fn interno_init_sistema() {
    if role().as_deref() != Some("init") {
        return;
    }
    let base = std::env::temp_dir().join(format!("orchestra-conpty-init-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::env::set_var(ENV_VAR, "system");
    init(&base);
    let log = std::fs::read_to_string(base.join("conpty.log")).unwrap();
    println!("RESULTADO init system: {}", log.trim());
    assert!(log.starts_with("conpty: system "), "{log}");
    assert_eq!(loaded_dll(), None);
    assert!(!base.join("conpty").exists(), "en modo system no se extrae nada");
    // Y con bundled: extrae dentro de la carpeta de datos, carga y lo apunta.
    std::env::set_var(ENV_VAR, "bundled");
    let t0 = Instant::now();
    init(&base);
    let frio = t0.elapsed();
    let log = std::fs::read_to_string(base.join("conpty.log")).unwrap();
    println!("RESULTADO init bundled ({} ms en frío): {}", frio.as_millis(), log.trim());
    assert!(log.starts_with("conpty: bundled ") && !log.contains("FAILED"), "{log}");
    // En caliente (ya extraído): solo comprobar los SHA-256. La carga ya está hecha en este proceso.
    let t1 = Instant::now();
    extract(&base).unwrap();
    println!("RESULTADO init: extraer en caliente {} ms", t1.elapsed().as_millis());
    assert!(loaded_dll().is_some_and(|p| p.starts_with(base.join("conpty"))), "{:?}", loaded_dll());
    std::env::remove_var(ENV_VAR);
}

// ---------- ratón de punta a punta ----------

const CLICK: &[u8] = b"\x1b[<0;10;5M\x1b[<0;10;5m";

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn el_raton_llega_al_hijo_con_el_incluido() {
    let (ok, out) = run_inner("interno_raton", "bundled");
    assert!(ok, "{out}");
}

/// Con el ConPTY del sistema. En Windows 11 pasa; en Windows 10 (conhost anterior al ratón por ConPTY) es
/// justo el fallo de la issue #1, así que allí solo se informa del resultado.
#[test]
fn el_raton_llega_al_hijo_con_el_del_sistema() {
    let (ok, out) = run_inner("interno_raton", "system");
    if windows_build() >= 22000 {
        assert!(ok, "{out}");
    } else {
        eprintln!("RESULTADO raton sistema en build {}: {}", windows_build(), if ok { "llega" } else { "NO llega (fallo de la issue #1)" });
    }
}

#[test]
#[ignore = "interna: la lanzan las pruebas de ratón en un proceso propio"]
fn interno_raton() {
    let Some(role) = role() else { return };
    prepare(&role);
    let mut cmd = CommandBuilder::new(std::env::current_exe().unwrap());
    cmd.args(["--exact", "conpty_bundle::tests::hijo_raton", "--ignored", "--nocapture", "--test-threads=1"]);
    cmd.env(ROLE_VAR, "hijo");
    let mut pty = Pty::open(cmd, 80, 24);
    assert!(pty.wait_for(b"LISTO", 0, Duration::from_secs(20)).is_some(), "el hijo no arrancó: {:?}", pty.text());
    // 1) La petición de ratón del hijo tiene que salir hacia el terminal: sin ella xterm.js no manda clics.
    let pide_1000 = pty.wait_for(b"\x1b[?1000h", 0, Duration::from_secs(2)).is_some();
    let pide_1006 = pty.wait_for(b"\x1b[?1006h", 0, Duration::from_secs(2)).is_some();
    // 2) El clic escrito por el lado maestro tiene que llegar al hijo tal cual.
    pty.send(CLICK);
    let llega = pty.wait_for(format!("RX={}", hex(CLICK)).as_bytes(), 0, Duration::from_secs(10)).is_some();
    let rx = pty.text().lines().find(|l| l.contains("RX=")).unwrap_or("").trim().to_string();
    println!("RESULTADO raton papel={role} build={} modo_1000_sale={pide_1000} modo_1006_sale={pide_1006} clic_llega={llega} {rx}", windows_build());
    assert!(pide_1000 && pide_1006, "la petición de ratón no sale por el PTY: {:?}", pty.text());
    assert!(llega, "el clic no llegó al hijo: {:?}", pty.text());
}

#[link(name = "kernel32")]
extern "system" {
    fn GetConsoleMode(handle: *mut c_void, mode: *mut u32) -> i32;
    fn SetConsoleMode(handle: *mut c_void, mode: u32) -> i32;
}

/// El programa que corre DENTRO del PTY: activa el ratón (1000 + SGR 1006), pone la entrada en crudo con
/// ENABLE_VIRTUAL_TERMINAL_INPUT y devuelve en hexadecimal lo que le llega por la entrada.
#[test]
#[ignore = "interna: es el hijo de la prueba de ratón"]
fn hijo_raton() {
    if role().as_deref() != Some("hijo") {
        return;
    }
    const ENABLE_PROCESSED_OUTPUT: u32 = 0x1;
    const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x4;
    const ENABLE_VIRTUAL_TERMINAL_INPUT: u32 = 0x200;
    let mut conin = std::fs::OpenOptions::new().read(true).write(true).open("CONIN$").unwrap();
    let mut conout = std::fs::OpenOptions::new().read(true).write(true).open("CONOUT$").unwrap();
    let mut out_mode = 0u32;
    // SAFETY: asas de consola válidas mientras vivan los File.
    unsafe {
        assert_ne!(SetConsoleMode(conin.as_raw_handle() as _, ENABLE_VIRTUAL_TERMINAL_INPUT), 0, "modo de entrada");
        assert_ne!(GetConsoleMode(conout.as_raw_handle() as _, &mut out_mode), 0);
        assert_ne!(SetConsoleMode(conout.as_raw_handle() as _, out_mode | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING), 0, "modo de salida");
    }
    // Para el humo dentro de la app: deja constancia en un archivo y espera más al clic (que allí es de verdad).
    let log = std::env::var_os("ORCHESTRA_CONPTY_HIJO_LOG").map(PathBuf::from);
    let wait = std::env::var("ORCHESTRA_CONPTY_HIJO_ESPERA").ok().and_then(|v| v.parse().ok()).unwrap_or(6u64);
    let note = |line: String| {
        if let Some(p) = &log {
            let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(p).unwrap();
            writeln!(f, "{ms} {line}").unwrap();
        }
    };
    conout.write_all(b"\x1b[?1000h\x1b[?1006hLISTO\r\n").unwrap();
    note("LISTO".into());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut b = [0u8; 256];
        while let Ok(n) = conin.read(&mut b) {
            if n == 0 || tx.send(b[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut got = vec![];
    let end = Instant::now() + Duration::from_secs(wait);
    // Acaba al llegar el clic de la prueba o, en el humo, la primera pulsación + suelta en formato SGR.
    let done = |got: &[u8]| find(got, CLICK, 0).is_some() || (log.is_some() && find(got, b"\x1b[<", 0).is_some() && got.ends_with(b"m"));
    while Instant::now() < end && !done(&got) {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
            got.extend(chunk);
        }
    }
    conout.write_all(format!("\x1b[?1000l\x1b[?1006lRX={}\r\n", hex(&got)).as_bytes()).unwrap();
    note(format!("RX={}", hex(&got)));
    std::thread::sleep(Duration::from_millis(300));
}

// ---------- toda la batería con el incluido ----------

/// Con ORCHESTRA_CONPTY=bundled en el entorno de cargo test, pty::spawn (y con él hostkey, vault, mcp…)
/// usa de verdad el OpenConsole extraído. Sin la variable no comprueba nada.
#[test]
fn con_la_variable_toda_la_bateria_usa_el_incluido() {
    if decide(22000, std::env::var(ENV_VAR).ok().as_deref()) != Choice::Bundled {
        return;
    }
    let spec = crate::pty::SpawnSpec { id: "conpty".into(), program: "cmd.exe".into(), args: vec![], cwd: None, env: Default::default(), cols: 80, rows: 24 };
    let s = crate::pty::spawn(spec, Box::new(|_, _| {})).unwrap();
    std::thread::sleep(Duration::from_millis(500));
    let hs = hosts();
    let dir = std::fs::canonicalize(test_dir()).unwrap();
    s.kill();
    eprintln!("RESULTADO bateria con el incluido: hosts={hs:?}");
    assert!(hs.iter().any(|(n, p)| n == "openconsole.exe" && std::fs::canonicalize(p).is_ok_and(|p| p.starts_with(&dir))), "hosts: {hs:?}");
    assert!(!hs.iter().any(|(n, _)| n == "conhost.exe"), "algún PTY de la batería usó conhost: {hs:?}");
}

// ---------- medida: tiempo hasta el primer prompt ----------

/// ## HERRAMIENTA (medida de una vez): cargo test --bin orchestra medida_primer_prompt -- --ignored --nocapture
#[test]
#[ignore = "medida: tiempo hasta el primer prompt, sistema frente a incluido"]
fn medida_primer_prompt() {
    if role().is_some() {
        return;
    }
    for role in ["system", "bundled", "system", "bundled"] {
        let (ok, out) = run_inner("interno_prompt", role);
        assert!(ok, "{out}");
    }
}

#[test]
#[ignore = "interna: la lanza medida_primer_prompt"]
fn interno_prompt() {
    let Some(role) = role() else { return };
    prepare(&role);
    for (prog, args, pat) in [("cmd.exe", &[][..], &b">"[..]), ("powershell.exe", &["-NoLogo", "-NoProfile"][..], &b"PS "[..])] {
        for da1 in [false, true] {
            let mut ms = vec![];
            let mut first = String::new();
            for i in 0..5 {
                let t0 = Instant::now();
                let mut cmd = CommandBuilder::new(prog);
                cmd.args(args);
                let mut pty = Pty::open(cmd, 80, 24);
                pty.answer_da1 = da1;
                assert!(pty.wait_for(pat, 0, Duration::from_secs(30)).is_some(), "sin prompt: {:?}", pty.text());
                ms.push(t0.elapsed().as_millis());
                if i == 0 {
                    first = pty.text().chars().take(160).collect();
                }
                let _ = pty.child.kill();
            }
            ms.sort();
            println!("RESULTADO prompt papel={role} {prog} contesta_da1={da1} ms={ms:?} mediana={} inicio={first:?}", ms[2]);
        }
    }
}
