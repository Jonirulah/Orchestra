//! Gestión de pseudo-terminales (ConPTY en Windows) con búfer de reconexión.
//!
//! Cada `Session` es dueña de un proceso hijo y de su PTY. La salida se guarda en un
//! anillo (2 MiB) para poder reenganchar la interfaz sin perder lo ya pintado
//! (recarga de la webview, mover un panel de sitio, etc.).

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;

const RING_CAP: usize = 2 * 1024 * 1024;

fn d_cols() -> u16 {
    120
}
fn d_rows() -> u16 {
    30
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSpec {
    pub id: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "d_cols")]
    pub cols: u16,
    #[serde(default = "d_rows")]
    pub rows: u16,
}

/// Destino de la salida del terminal (en la app real, un `Channel` de Tauri).
pub trait Sink: Send + Sync {
    fn data(&self, bytes: Vec<u8>);
}

struct Out {
    buf: VecDeque<u8>,
    sink: Option<Arc<dyn Sink>>,
}

pub struct Session {
    pub pid: Option<u32>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    out: Mutex<Out>,
    exit: Mutex<Option<i32>>,
    /// Lo han reemplazado por otro proceso con el mismo id (relanzar, cambiar de cuenta): su salida y su fin ya no
    /// le importan a nadie. Sin esto, el fin del proceso viejo marcaba como «terminado» al nuevo.
    superseded: AtomicBool,
}

impl Session {
    /// Marca esta sesión como reemplazada: deja de enviar salida y no avisará de su fin.
    pub fn supersede(&self) {
        self.superseded.store(true, Ordering::SeqCst);
        self.out.lock().sink = None;
    }

    fn push_out(&self, chunk: &[u8]) {
        let mut o = self.out.lock();
        o.buf.extend(chunk.iter().copied());
        let over = o.buf.len().saturating_sub(RING_CAP);
        if over > 0 {
            o.buf.drain(..over);
        }
        if !self.superseded.load(Ordering::SeqCst) {
            if let Some(s) = &o.sink {
                s.data(chunk.to_vec());
            }
        }
    }

    /// Engancha un destino: primero recibe el histórico del anillo y después lo vivo.
    /// Todo ocurre bajo el mismo cerrojo que `push_out`, así que no hay huecos ni duplicados.
    pub fn attach(&self, sink: Arc<dyn Sink>) {
        let mut o = self.out.lock();
        if !o.buf.is_empty() {
            let (a, b) = o.buf.as_slices();
            let mut v = Vec::with_capacity(a.len() + b.len());
            v.extend_from_slice(a);
            v.extend_from_slice(b);
            sink.data(v);
        }
        o.sink = Some(sink);
    }

    /// Últimos `max_bytes` bytes del anillo (para el servidor MCP; solo lectura).
    pub fn tail_bytes(&self, max_bytes: usize) -> Vec<u8> {
        let o = self.out.lock();
        let skip = o.buf.len().saturating_sub(max_bytes);
        o.buf.iter().skip(skip).copied().collect()
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut w = self.writer.lock();
        w.write_all(data)
            .and_then(|_| w.flush())
            .map_err(|e| e.to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        match self.master.lock().as_ref() {
            Some(m) => m
                .resize(PtySize {
                    rows: rows.max(2),
                    cols: cols.max(2),
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    /// Mata el proceso y todo su árbol (el shell puede tener hijos: ssh, claude, ...).
    pub fn kill(&self) {
        #[cfg(windows)]
        if let (Some(pid), None) = (self.pid, *self.exit.lock()) {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .output();
        }
        let _ = self.killer.lock().kill();
    }

    pub fn exit_code(&self) -> Option<i32> {
        *self.exit.lock()
    }
}

/// Variables con las que Claude Code marca «esto corre dentro de otra sesión mía» (transcripción apagada, socket de
/// mensajes, id de sesión…). Lista cerrada a propósito: el resto de `CLAUDE_*` / `CLAUDE_CODE_*` es configuración
/// del usuario (Bedrock, límites de salida, carpeta de la cuenta…) y se respeta.
pub(crate) fn is_session_marker(name: &str) -> bool {
    matches!(
        name.to_ascii_uppercase().as_str(),
        "CLAUDECODE"
            | "CLAUDE_PID"
            | "CLAUDE_CODE_CHILD_SESSION"
            | "CLAUDE_CODE_SESSION_ID"
            | "CLAUDE_CODE_SESSION_ATTENDED"
            | "CLAUDE_CODE_ENTRYPOINT"
            | "CLAUDE_CODE_MESSAGING_SOCKET"
            | "CLAUDE_CODE_MESSAGING_TOKEN"
    )
}

pub fn spawn(
    spec: SpawnSpec,
    on_exit: Box<dyn Fn(String, i32) + Send + Sync>,
) -> Result<Arc<Session>, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: spec.rows.max(2),
            cols: spec.cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Could not open the pseudo-terminal: {e}"))?;

    let mut cmd = CommandBuilder::new(&spec.program);
    cmd.args(&spec.args);
    if let Some(cwd) = spec.cwd.as_ref().filter(|c| !c.is_empty()) {
        cmd.cwd(cwd);
    }
    // Si Orchestra se abrió desde una sesión de Claude Code, no heredes sus marcas: cada panel es una sesión nueva.
    for (k, _) in std::env::vars_os() {
        if k.to_str().is_some_and(is_session_marker) {
            cmd.env_remove(&k);
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Orchestra");
    cmd.env("ORCHESTRA_TERM_ID", &spec.id);
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    // Si el panel trae el NOMBRE de un secreto de la bóveda, este exe hace de SSH_ASKPASS.
    // (La interfaz solo manda el nombre; el valor nunca pasa por el entorno.)
    // (Si la petición ya trae su SSH_ASKPASS, p. ej. las pruebas, se respeta.)
    if let Some(key) = spec
        .env
        .get(crate::vault::ENV_KEY)
        .filter(|k| !k.is_empty() && !spec.env.contains_key("SSH_ASKPASS"))
    {
        for (k, v) in crate::vault::askpass_env(key) {
            cmd.env(k, v);
        }
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Could not launch «{}»: {e}", spec.program))?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("PTY has no reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("PTY has no writer: {e}"))?;

    let session = Arc::new(Session {
        pid: child.process_id(),
        writer: Mutex::new(writer),
        master: Mutex::new(Some(pair.master)),
        killer: Mutex::new(child.clone_killer()),
        out: Mutex::new(Out {
            buf: VecDeque::new(),
            sink: None,
        }),
        exit: Mutex::new(None),
        superseded: AtomicBool::new(false),
    });

    // Hilo lector: PTY -> anillo -> destino.
    {
        let s = session.clone();
        let mut reader = reader;
        std::thread::Builder::new()
            .name(format!("pty-read-{}", spec.id))
            .spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => s.push_out(&buf[..n]),
                    }
                }
            })
            .map_err(|e| e.to_string())?;
    }

    // Hilo vigía: espera al hijo, deja drenar la salida y cierra el ConPTY.
    {
        let s = session.clone();
        let id = spec.id.clone();
        std::thread::Builder::new()
            .name(format!("pty-wait-{}", spec.id))
            .spawn(move || {
                let code = match child.wait() {
                    Ok(st) => st.exit_code() as i32,
                    Err(_) => -1,
                };
                std::thread::sleep(Duration::from_millis(250));
                *s.exit.lock() = Some(code);
                s.master.lock().take(); // cierra el pseudo-consola: el lector termina
                if !s.superseded.load(Ordering::SeqCst) {
                    on_exit(id, code);
                }
            })
            .map_err(|e| e.to_string())?;
    }

    Ok(session)
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl PtyManager {
    pub fn insert(&self, id: String, s: Arc<Session>) {
        self.sessions.lock().insert(id, s);
    }
    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().get(id).cloned()
    }
    pub fn remove(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().remove(id)
    }
    pub fn ids(&self) -> Vec<String> {
        self.sessions.lock().keys().cloned().collect()
    }
    pub fn has_live(&self) -> bool {
        self.sessions
            .lock()
            .values()
            .any(|s| s.exit_code().is_none())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::mpsc;

    struct Collect(Mutex<Vec<u8>>);
    impl Sink for Collect {
        fn data(&self, b: Vec<u8>) {
            self.0.lock().extend(b);
        }
    }


    /// Hace de terminal: espera la consulta de cursor de ConPTY (ESC[6n) y la contesta.
    fn responder_cursor(s: &Session, sink: &Collect) {
        for _ in 0..100 {
            if String::from_utf8_lossy(&sink.0.lock()).contains("[6n") {
                s.write(b"[1;1R").unwrap();
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn spec(args: &[&str]) -> SpawnSpec {
        SpawnSpec {
            id: "t".into(),
            program: "cmd.exe".into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            env: HashMap::new(),
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn un_proceso_reemplazado_no_avisa_de_su_fin_pero_uno_normal_si() {
        // Normal: matar un proceso largo sí avisa.
        let (tx, rx) = mpsc::channel();
        let normal = spawn(
            spec(&["/c", "ping -n 30 127.0.0.1 >nul"]),
            Box::new(move |_id, code| {
                let _ = tx.send(code);
            }),
        )
        .unwrap();
        let sink = Arc::new(Collect(Mutex::new(vec![])));
        normal.attach(sink.clone());
        responder_cursor(&normal, &sink);
        normal.kill();
        assert!(rx.recv_timeout(Duration::from_secs(15)).is_ok(), "el fin de un proceso normal debe avisarse");

        // Reemplazado: no avisa (si lo hiciera, la interfaz marcaría como terminado al proceso nuevo).
        let (tx2, rx2) = mpsc::channel();
        let viejo = spawn(
            spec(&["/c", "ping -n 30 127.0.0.1 >nul"]),
            Box::new(move |_id, code| {
                let _ = tx2.send(code);
            }),
        )
        .unwrap();
        let sink2 = Arc::new(Collect(Mutex::new(vec![])));
        viejo.attach(sink2.clone());
        responder_cursor(&viejo, &sink2);
        viejo.supersede();
        viejo.kill();
        std::thread::sleep(Duration::from_secs(3));
        assert!(rx2.try_recv().is_err(), "un proceso reemplazado no debe avisar de su fin");
        assert_eq!(viejo.exit_code().is_some(), true, "pero sí debe haberse cerrado de verdad");
    }

    #[test]
    fn solo_las_marcas_de_sesion_se_reconocen() {
        for n in ["CLAUDECODE", "claudecode", "CLAUDE_PID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_TOKEN"] {
            assert!(is_session_marker(n), "{n}");
        }
        // Configuración del usuario: no se toca.
        for n in ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "ANTHROPIC_API_KEY", "NO_COLOR", "PATH"] {
            assert!(!is_session_marker(n), "{n}");
        }
    }

    #[test]
    fn un_panel_nuevo_no_hereda_las_marcas_de_otra_sesion() {
        std::env::set_var("CLAUDE_CODE_CHILD_SESSION", "canario-marca");
        std::env::set_var("ORCH_TEST_CONFIG_USUARIO", "canario-config");
        let (tx, rx) = mpsc::channel();
        let s = spawn(
            spec(&["/c", "echo M[%CLAUDE_CODE_CHILD_SESSION%] C[%ORCH_TEST_CONFIG_USUARIO%]"]),
            Box::new(move |_id, code| {
                let _ = tx.send(code);
            }),
        )
        .unwrap();
        let sink = Arc::new(Collect(Mutex::new(vec![])));
        s.attach(sink.clone());
        responder_cursor(&s, &sink);
        rx.recv_timeout(Duration::from_secs(15)).expect("no salió");
        let out = String::from_utf8_lossy(&sink.0.lock()).to_string();
        // cmd imprime «%VAR%» tal cual cuando la variable no existe.
        assert!(!out.contains("canario-marca"), "la marca se heredó: {out:?}");
        assert!(out.contains("C[canario-config]"), "la configuración del usuario se perdió: {out:?}");
    }

    #[test]
    fn eco_y_codigo_de_salida() {
        let (tx, rx) = mpsc::channel();
        let s = spawn(
            spec(&["/c", "echo hola-orchestra & exit 3"]),
            Box::new(move |_id, code| {
                let _ = tx.send(code);
            }),
        )
        .unwrap();
        let sink = Arc::new(Collect(Mutex::new(vec![])));
        s.attach(sink.clone());
        responder_cursor(&s, &sink);
        let code = rx.recv_timeout(Duration::from_secs(15)).expect("no salió");
        assert_eq!(code, 3);
        let out = String::from_utf8_lossy(&sink.0.lock()).to_string();
        assert!(out.contains("hola-orchestra"), "salida: {out:?}");
    }

    #[test]
    fn interactivo_y_reenganche() {
        let (tx, rx) = mpsc::channel();
        let s = spawn(
            spec(&[]),
            Box::new(move |_id, code| {
                let _ = tx.send(code);
            }),
        )
        .unwrap();
        let primer = Arc::new(Collect(Mutex::new(vec![])));
        s.attach(primer.clone());
        responder_cursor(&s, &primer);
        s.write(b"echo marca-uno\r").unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        // Reenganche tardío: debe recibir el histórico completo y luego lo vivo.
        let sink = Arc::new(Collect(Mutex::new(vec![])));
        s.attach(sink.clone());
        s.write(b"echo marca-dos\rexit\r").unwrap();
        let r = rx.recv_timeout(Duration::from_secs(15));
        let out = String::from_utf8_lossy(&sink.0.lock()).to_string();
        assert!(r.is_ok(), "no salió; salida: {out:?}");
        assert!(out.contains("marca-uno"), "falta histórico: {out:?}");
        assert!(out.contains("marca-dos"), "falta lo vivo: {out:?}");
    }

    #[test]
    fn kill_mata_el_arbol() {
        let (tx, rx) = mpsc::channel();
        let s = spawn(
            spec(&[]),
            Box::new(move |_id, code| {
                let _ = tx.send(code);
            }),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(500));
        s.kill();
        rx.recv_timeout(Duration::from_secs(15)).expect("no murió");
    }
}
