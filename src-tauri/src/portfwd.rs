//! Reenvío de puertos por SSH (túneles `-L`, a lo VS Code): un servidor que arranca en el remoto en `localhost:3000`
//! se abre en el navegador de aquí por `http://localhost:<puerto local>`.
//!
//! Un proceso `ssh -N` POR TÚNEL (no uno por host con varios `-L`): con `ExitOnForwardFailure=yes` un puerto local ocupado
//! tumbaría todos los del host; añadir o quitar uno no corta los demás; y si uno se cae, se recupera solo él. El coste es
//! una autenticación más por túnel, que con clave o con la bóveda es invisible.
//!
//! Seguridad: el extremo local SIEMPRE es `127.0.0.1` (nunca 0.0.0.0: nadie de la red entra por el túnel); los argumentos
//! son un ARRAY (sin shell) y salen de `remote_metrics::base_args` (huella estricta, askpass de la bóveda sin secreto en
//! argumentos ni en el entorno, salto `-J`), quitando solo `ClearAllForwardings=yes`, que borraría también nuestro `-L`.
//! El destino remoto es `localhost`: así funciona tanto si el servidor escucha en 127.0.0.1 como solo en ::1 (Vite con Node ≥ 17).

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::remote_metrics::{base_args, build_env, classify, Dest, Kind};

/// Cuántos puertos seguidos se prueban a partir del preferido antes de rendirse.
pub const PORT_SPAN: u16 = 200;
/// Tope del texto de error que se guarda de stderr.
const MAX_ERR: usize = 2048;

// ---------- lógica pura ----------

/// Elige el puerto local: el preferido si está libre; si no, el siguiente libre (sin pasar de 65535 ni repetir uno
/// que ya use otro túnel nuestro). Por debajo de 1024 se empieza igual (Windows no los reserva), pero nunca en 0.
pub fn pick_port(pref: u16, taken: &HashSet<u16>, is_free: impl Fn(u16) -> bool) -> Option<u16> {
    let start = pref.max(1) as u32;
    (start..(start + PORT_SPAN as u32).min(65536)).map(|p| p as u16).find(|p| !taken.contains(p) && is_free(*p))
}

/// ¿Puerto local libre? Se mira 127.0.0.1 y también [::1]: el navegador prueba `localhost` por IPv6 primero y otro
/// servidor local en [::1]:puerto se llevaría la petición.
pub fn local_free(p: u16) -> bool {
    if TcpListener::bind(("127.0.0.1", p)).is_err() {
        return false;
    }
    match TcpListener::bind(("::1", p)) {
        Ok(_) => true,
        Err(e) => e.kind() != std::io::ErrorKind::AddrInUse,
    }
}

/// ¿Alguien escucha ya en 127.0.0.1:p? (el ssh del túnel, una vez arriba).
fn local_bound(p: u16) -> bool {
    TcpListener::bind(("127.0.0.1", p)).is_err()
}

/// Argumentos de `ssh` para un túnel `127.0.0.1:local -> localhost:remote`. Array, sin shell.
pub fn tunnel_args(d: &Dest, local: u16, remote: u16) -> Vec<String> {
    let mut a = base_args(d);
    // `ClearAllForwardings=yes` borra también los -L de la línea de órdenes: fuera.
    if let Some(i) = a.windows(2).position(|w| w[0] == "-o" && w[1] == "ClearAllForwardings=yes") {
        a.drain(i..i + 2);
    }
    let dd = a.iter().position(|x| x == "--").unwrap_or(a.len());
    let extra = [
        "-N".to_string(),
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        "-o".into(),
        "GatewayPorts=no".into(),
        "-L".into(),
        format!("127.0.0.1:{local}:localhost:{remote}"),
    ];
    a.splice(dd..dd, extra);
    a
}

/// ssh no pudo abrir el puerto local (otro programa lo cogió entre que lo elegimos y ssh lo abrió): se prueba otro.
pub fn is_bind_failure(stderr: &str) -> bool {
    let e = stderr.to_ascii_lowercase();
    e.contains("cannot listen to port") || e.contains("could not request local forwarding") || e.contains("address already in use") || e.contains("bind [127.0.0.1]")
}

/// Espera antes del intento `n` (1 = primero): 1, 2, 4, 8, 16, 30, 30… (como `backoff` de reconnect.ts) con tope.
pub fn backoff(n: u32, first: Duration, max: Duration) -> Duration {
    let k = n.max(1).min(16) - 1;
    first.saturating_mul(1u32 << k).min(max)
}

// ---------- estado ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// Lanzando ssh / esperando a que abra el puerto local.
    Connecting,
    /// El puerto local escucha: el túnel funciona.
    Up,
    /// Se cayó por la red: se reintenta solo con espera.
    Down,
    /// No se puede (huella, contraseña, sin puerto libre): no se reintenta.
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snap {
    pub id: String,
    pub dest_key: String,
    pub remote_port: u16,
    pub local_port: u16,
    pub state: State,
    pub error: Option<String>,
    /// Reintentos de la racha actual (0 = funcionando o primer intento).
    pub attempt: u32,
    /// Segundos hasta el próximo intento (solo en `Down`).
    pub retry_in: Option<u64>,
    /// PID del ssh vivo (para las pruebas y el diagnóstico).
    pub pid: Option<u32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FwdReq {
    #[serde(flatten)]
    pub dest: Dest,
    pub remote_port: u16,
    /// Puerto local preferido (por defecto, el mismo que el remoto).
    #[serde(default)]
    pub local_port: Option<u16>,
}

/// Identidad de un túnel: destino + puerto remoto (pedir dos veces el mismo devuelve el que ya hay).
pub fn tunnel_id(d: &Dest, remote: u16) -> String {
    format!("{}#{remote}", d.key())
}

/// Cómo se lanza ssh. El real es `ssh`; las pruebas ponen otro programa.
pub trait Spawner: Send + Sync {
    fn spawn(&self, args: &[String], env: &[(String, String)]) -> std::io::Result<Child>;
}
pub struct SshSpawner;
impl Spawner for SshSpawner {
    fn spawn(&self, args: &[String], env: &[(String, String)]) -> std::io::Result<Child> {
        let prog = std::env::var("ORCH_PFWD_SSH").unwrap_or_else(|_| "ssh".into());
        let mut c = Command::new(prog);
        c.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        for (k, v) in env {
            c.env(k, v);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        c.spawn()
    }
}

#[derive(Clone)]
pub struct Cfg {
    pub first_delay: Duration,
    pub max_delay: Duration,
    /// Cuánto se espera a que ssh abra el puerto local antes de darlo por fallido.
    pub up_timeout: Duration,
}
impl Default for Cfg {
    fn default() -> Self {
        Cfg { first_delay: Duration::from_secs(1), max_delay: Duration::from_secs(30), up_timeout: Duration::from_secs(20) }
    }
}

struct Tun {
    snap: Mutex<Snap>,
    stop: AtomicBool,
    child: Mutex<Option<Child>>,
}
impl Tun {
    fn kill(&self) {
        if let Some(mut c) = self.child.lock().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}
impl Drop for Tun {
    fn drop(&mut self) {
        self.kill();
    }
}

pub struct Manager {
    tuns: Mutex<HashMap<String, Arc<Tun>>>,
    spawner: Arc<dyn Spawner>,
    cfg: Cfg,
}

impl Manager {
    pub fn new(spawner: Arc<dyn Spawner>, cfg: Cfg) -> Arc<Self> {
        Arc::new(Manager { tuns: Mutex::new(HashMap::new()), spawner, cfg })
    }

    fn taken_ports(&self, except: &str) -> HashSet<u16> {
        self.tuns.lock().iter().filter(|(k, _)| k.as_str() != except).map(|(_, t)| t.snap.lock().local_port).filter(|p| *p != 0).collect()
    }

    /// Crea el túnel (o devuelve el que ya existe para ese destino y puerto remoto) y empieza a vigilarlo.
    pub fn start(self: &Arc<Self>, req: FwdReq) -> Result<Snap, String> {
        req.dest.validate()?;
        if req.remote_port == 0 {
            return Err("invalid remote port".into());
        }
        if req.local_port == Some(0) {
            return Err("invalid local port".into());
        }
        let id = tunnel_id(&req.dest, req.remote_port);
        if let Some(t) = self.tuns.lock().get(&id) {
            return Ok(t.snap.lock().clone());
        }
        let snap = Snap {
            id: id.clone(),
            dest_key: req.dest.key(),
            remote_port: req.remote_port,
            local_port: 0,
            state: State::Connecting,
            error: None,
            attempt: 0,
            retry_in: None,
            pid: None,
        };
        let t = Arc::new(Tun { snap: Mutex::new(snap.clone()), stop: AtomicBool::new(false), child: Mutex::new(None) });
        self.tuns.lock().insert(id, t.clone());
        let me = self.clone();
        std::thread::Builder::new().name("orch-pfwd".into()).spawn(move || me.supervise(t, req)).map_err(|e| e.to_string())?;
        Ok(snap)
    }

    pub fn stop(&self, id: &str) {
        let t = self.tuns.lock().remove(id);
        if let Some(t) = t {
            t.stop.store(true, Ordering::SeqCst);
            t.kill();
        }
    }

    pub fn list(&self) -> Vec<Snap> {
        let mut v: Vec<Snap> = self.tuns.lock().values().map(|t| t.snap.lock().clone()).collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    /// Al salir de la app: para y MATA todos los ssh (nada de procesos huérfanos).
    pub fn shutdown(&self) {
        let all: Vec<Arc<Tun>> = self.tuns.lock().drain().map(|(_, t)| t).collect();
        for t in all {
            t.stop.store(true, Ordering::SeqCst);
            t.kill();
        }
    }

    fn set(t: &Tun, f: impl FnOnce(&mut Snap)) {
        f(&mut t.snap.lock());
    }

    /// Duerme `d` en trozos cortos; devuelve false si piden parar.
    fn nap(t: &Tun, d: Duration, mut tick: impl FnMut(Duration)) -> bool {
        let end = Instant::now() + d;
        loop {
            if t.stop.load(Ordering::SeqCst) {
                return false;
            }
            let now = Instant::now();
            if now >= end {
                return true;
            }
            tick(end - now);
            std::thread::sleep((end - now).min(Duration::from_millis(100)));
        }
    }

    fn supervise(self: Arc<Self>, t: Arc<Tun>, req: FwdReq) {
        let pref = req.local_port.unwrap_or(req.remote_port);
        let mut last_local: Option<u16> = None;
        let mut avoid: HashSet<u16> = HashSet::new();
        let mut attempt: u32 = 0;
        let env = build_env(&req.dest);
        while !t.stop.load(Ordering::SeqCst) {
            // Puerto local: el de la última vez si sigue libre (la URL no cambia al reconectar); si no, el preferido o el siguiente.
            let id = t.snap.lock().id.clone();
            let mut taken = self.taken_ports(&id);
            taken.extend(avoid.iter().copied());
            let local = match last_local.filter(|p| !taken.contains(p) && local_free(*p)).or_else(|| pick_port(pref, &taken, local_free)) {
                Some(p) => p,
                None => {
                    Self::set(&t, |s| {
                        s.state = State::Error;
                        s.error = Some(format!("no free local port from {pref}"));
                    });
                    return;
                }
            };
            last_local = Some(local);
            Self::set(&t, |s| {
                s.local_port = local;
                s.state = State::Connecting;
                s.retry_in = None;
            });
            let args = tunnel_args(&req.dest, local, req.remote_port);
            let mut child = match self.spawner.spawn(&args, &env) {
                Ok(c) => c,
                Err(e) => {
                    Self::set(&t, |s| {
                        s.state = State::Error;
                        s.error = Some(format!("cannot run ssh: {e}"));
                    });
                    return;
                }
            };
            // stderr en un hilo (no bloquea; con -N ssh casi no escribe).
            let err_buf = Arc::new(Mutex::new(String::new()));
            let err_done = Arc::new(AtomicBool::new(false));
            if let Some(mut se) = child.stderr.take() {
                let (b, done) = (err_buf.clone(), err_done.clone());
                let _ = std::thread::Builder::new().name("orch-pfwd-err".into()).spawn(move || {
                    let mut chunk = [0u8; 512];
                    while let Ok(n) = se.read(&mut chunk) {
                        if n == 0 {
                            break;
                        }
                        let mut g = b.lock();
                        if g.len() < MAX_ERR {
                            g.push_str(&String::from_utf8_lossy(&chunk[..n]));
                        }
                    }
                    done.store(true, Ordering::SeqCst);
                });
            } else {
                err_done.store(true, Ordering::SeqCst);
            }
            let pid = child.id();
            *t.child.lock() = Some(child);
            Self::set(&t, |s| s.pid = Some(pid));
            if t.stop.load(Ordering::SeqCst) {
                t.kill();
                return;
            }
            // Esperar a que el puerto local escuche (arriba) o a que ssh termine (fallo).
            let t0 = Instant::now();
            let mut up = false;
            let code: Option<i32> = loop {
                if t.stop.load(Ordering::SeqCst) {
                    t.kill();
                    return;
                }
                let exited = match t.child.lock().as_mut() {
                    Some(c) => match c.try_wait() {
                        Ok(Some(st)) => Some(st.code()),
                        Ok(None) => None,
                        Err(_) => Some(None),
                    },
                    None => return, // lo mató stop()
                };
                if let Some(c) = exited {
                    break c;
                }
                if !up && local_bound(local) {
                    up = true;
                    attempt = 0;
                    avoid.clear();
                    Self::set(&t, |s| {
                        s.state = State::Up;
                        s.error = None;
                        s.attempt = 0;
                    });
                }
                if !up && t0.elapsed() > self.cfg.up_timeout {
                    // Colgado sin abrir el puerto (pide contraseña sin bóveda, salto que no responde…).
                    t.kill();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(if up { 250 } else { 50 }));
            };
            t.child.lock().take();
            if t.stop.load(Ordering::SeqCst) {
                return;
            }
            // stderr completo (≤ 1 s) para saber por qué terminó.
            let w = Instant::now();
            while !err_done.load(Ordering::SeqCst) && w.elapsed() < Duration::from_secs(1) {
                std::thread::sleep(Duration::from_millis(20));
            }
            let stderr = err_buf.lock().clone();
            let (kind, mut reason) = if is_bind_failure(&stderr) { (Kind::Network, format!("local port {local} busy")) } else { classify(&stderr, code, false) };
            if stderr.trim().is_empty() {
                reason = match code {
                    Some(c) => format!("ssh exited with code {c}"),
                    None => "ssh did not open the port in time".into(),
                };
            }
            // Puerto cogido por otro: se evita. Si vuelve a estar libre (choque con nuestra propia sonda), se repite el mismo.
            if is_bind_failure(&stderr) && !local_free(local) {
                avoid.insert(local);
                last_local = None;
            }
            // Si llegó a funcionar, cualquier final es una caída (matado, red): se reintenta. Si no, solo los fallos de red.
            if !up && !kind.retriable() && !(code.is_none() && stderr.trim().is_empty()) {
                Self::set(&t, |s| {
                    s.state = State::Error;
                    s.error = Some(reason);
                    s.pid = None;
                });
                return;
            }
            attempt += 1;
            let wait = if is_bind_failure(&stderr) { Duration::from_millis(100) } else { backoff(attempt, self.cfg.first_delay, self.cfg.max_delay) };
            Self::set(&t, |s| {
                s.state = State::Down;
                s.error = Some(reason);
                s.attempt = attempt;
                s.pid = None;
                s.retry_in = Some(wait.as_secs().max(1));
            });
            let tt = t.clone();
            if !Self::nap(&t, wait, |left| Self::set(&tt, |s| s.retry_in = Some(left.as_secs().max(1)))) {
                return;
            }
        }
    }
}

// ---------- comandos ----------

#[tauri::command(async)]
pub fn pfwd_start(m: tauri::State<'_, Arc<Manager>>, req: FwdReq) -> Result<Snap, String> {
    m.start(req)
}

#[tauri::command(async)]
pub fn pfwd_stop(m: tauri::State<'_, Arc<Manager>>, id: String) {
    m.stop(&id)
}

#[tauri::command(async)]
pub fn pfwd_list(m: tauri::State<'_, Arc<Manager>>) -> Vec<Snap> {
    m.list()
}

#[cfg(test)]
#[path = "portfwd_tests.rs"]
mod tests;
