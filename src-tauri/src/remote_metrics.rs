//! Métricas del SERVIDOR para la barra de estado de los paneles SSH (a la MobaXterm).
//!
//! Una conexión `ssh` pequeña, separada y sin terminal por DESTINO (usuario@host:puerto + salto), compartida por todos
//! los paneles de ese host (recuento de referencias). Vive mientras exista algún panel SSH vivo de ese host (lo cuenta
//! el frontend con `rmetrics_start`/`rmetrics_stop`), se para ~10 s después del último y al salir de la app.
//! Con la ventana oculta más de 60 s el enlace se suelta y se retoma al volver.
//!
//! Seguridad (ver docs/SECURITY.md): el comando remoto es una constante (`sh -s`; el guion viaja por stdin y solo
//! cambia un entero validado); los argumentos son un ARRAY (sin shell) y se validan; la huella NUNCA se acepta sola
//! (`StrictHostKeyChecking=yes`); el secreto nunca va en argumentos ni en el entorno (solo el NOMBRE de la bóveda);
//! lo que llega del servidor son DATOS: se analizan con un formato estricto y nunca se ejecutan ni se pintan como HTML.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use crate::metrics::rate_per_sec;

/// Tope de una línea del servidor (bytes): más larga se descarta.
pub const MAX_LINE: usize = 4096;
/// Como mucho una línea cada 500 ms se procesa.
pub const MIN_GAP: Duration = Duration::from_millis(500);
pub const INTERVAL_MIN: u64 = 2;
pub const INTERVAL_MAX: u64 = 10;
pub const REASON_HOSTKEY: &str = "host key not trusted yet: connect with a normal pane first";
pub const REASON_AUTH: &str = "needs interactive login";
pub const REASON_UNSUPPORTED: &str = "Remote metrics need a Linux server";

pub fn clamp_interval(v: u64) -> u64 {
    v.clamp(INTERVAL_MIN, INTERVAL_MAX)
}

// ---------- destino ----------

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Dest {
    pub user: Option<String>,
    pub host: String,
    pub port: u16,
    pub identity: Option<String>,
    pub identities_only: bool,
    pub jump: Option<String>,
    /// NOMBRE de la entrada de la bóveda (nunca el secreto).
    pub secret_key: Option<String>,
}

fn word_ok(s: &str, max: usize, extra: &[char]) -> bool {
    !s.is_empty() && s.len() <= max && !s.starts_with('-') && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') || extra.contains(&c))
}

impl Dest {
    /// Rechaza lo que no sea un destino normal: nada que empiece por `-` (ssh lo leería como opción), sin espacios ni caracteres de control.
    pub fn validate(&self) -> Result<(), String> {
        if !word_ok(&self.host, 255, &[':', '%']) {
            return Err("invalid host".into());
        }
        if let Some(u) = &self.user {
            if !word_ok(u, 64, &[]) {
                return Err("invalid user".into());
            }
        }
        if self.port == 0 {
            return Err("invalid port".into());
        }
        if let Some(i) = &self.identity {
            if i.is_empty() || i.len() > 512 || i.starts_with('-') || i.chars().any(|c| c.is_control()) {
                return Err("invalid identity file".into());
            }
        }
        if let Some(j) = &self.jump {
            if j.len() > 512 || j.split(',').any(|p| !word_ok(p, 255, &['@', ':', '%'])) {
                return Err("invalid jump host".into());
            }
        }
        if let Some(k) = &self.secret_key {
            if k.len() > 200 || !k.starts_with("host:") || !k.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '_' | '-')) {
                return Err("invalid credential name".into());
            }
        }
        Ok(())
    }

    /// Identidad del monitor: un solo enlace por destino (el secreto no cuenta: es el mismo servidor).
    pub fn key(&self) -> String {
        format!("{}@{}:{}|{}", self.user.as_deref().unwrap_or(""), self.host, self.port, self.jump.as_deref().unwrap_or(""))
    }
}

/// Argumentos de `ssh` (array, sin shell). El destino va tras `--`. `BatchMode=yes` solo si NO hay secreto guardado.
/// `StrictHostKeyChecking` es siempre `yes`: la huella no se acepta sola.
pub fn build_args(d: &Dest) -> Vec<String> {
    let mut a = base_args(d);
    // Comando remoto constante: el guion llega por stdin.
    a.push("sh".into());
    a.push("-s".into());
    a
}

/// Todo lo de `build_args` salvo el comando remoto (lo añade quien llama: `sh -s` aquí, el comando del agente en `mcp`).
pub fn base_args(d: &Dest) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let mut o = |k: &str| {
        a.push("-o".into());
        a.push(k.into());
    };
    o(if d.secret_key.is_some() { "BatchMode=no" } else { "BatchMode=yes" });
    o("ConnectTimeout=8");
    o("ServerAliveInterval=5");
    o("ServerAliveCountMax=2");
    o("StrictHostKeyChecking=yes");
    o("LogLevel=ERROR");
    o("ControlPath=none");
    o("RemoteCommand=none");
    o("ClearAllForwardings=yes");
    o("ForwardAgent=no");
    o("ForwardX11=no");
    if d.secret_key.is_some() {
        o("NumberOfPasswordPrompts=1");
    }
    if d.identities_only && d.identity.is_some() {
        o("IdentitiesOnly=yes");
    }
    a.insert(0, "-T".into());
    a.push("-p".into());
    a.push(d.port.to_string());
    if let Some(i) = &d.identity {
        a.push("-i".into());
        a.push(i.clone());
    }
    if let Some(j) = &d.jump {
        a.push("-J".into());
        a.push(j.clone());
    }
    a.push("--".into());
    a.push(match &d.user {
        Some(u) => format!("{u}@{}", d.host),
        None => d.host.clone(),
    });
    a
}

/// Entorno extra del hijo: solo el askpass de la bóveda (con el NOMBRE del secreto), nunca el secreto.
pub fn build_env(d: &Dest) -> Vec<(String, String)> {
    match &d.secret_key {
        Some(k) => crate::vault::askpass_env(k),
        None => vec![],
    }
}

/// Guion POSIX que se envía por stdin a `sh -s`: una línea `clave=valor;…;end=1` por tick. Constante salvo el entero.
pub fn remote_script(interval: u64) -> String {
    let n = clamp_interval(interval);
    format!(
        r#"[ -r /proc/stat ] || {{ echo unsupported; exit 0; }}
H=$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-')
C=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)
while :; do
awk -v H="$H" -v C="$C" '
FILENAME=="/proc/stat" && $1=="cpu" {{ cpu=sprintf("%.0f,%.0f,%.0f,%.0f,%.0f,%.0f,%.0f,%.0f",$2+0,$3+0,$4+0,$5+0,$6+0,$7+0,$8+0,$9+0) }}
FILENAME=="/proc/meminfo" {{ if($1=="MemTotal:")mt=$2; else if($1=="MemAvailable:")ma=$2; else if($1=="MemFree:")mf=$2; else if($1=="Buffers:")bu=$2; else if($1=="Cached:")ca=$2; else if($1=="SwapTotal:")st=$2; else if($1=="SwapFree:")sf=$2 }}
FILENAME=="/proc/net/dev" {{ i=index($0,":"); if(i>0){{ n=substr($0,1,i-1); gsub(/ /,"",n); if(n!="lo"){{ split(substr($0,i+1),a," "); ni+=a[1]; no+=a[9] }} }} }}
FILENAME=="/proc/diskstats" {{ d=$3; if(d ~ /^(sd|vd|xvd|hd)[a-z]+$/ || d ~ /^nvme[0-9]+n[0-9]+$/ || d ~ /^mmcblk[0-9]+$/) {{ dr+=$6; dw+=$10 }} }}
FILENAME=="/proc/uptime" {{ up=$1 }}
FILENAME=="/proc/loadavg" {{ la=$1 }}
END {{ if(ma=="") ma=mf+bu+ca; printf "cpu=%s;mt=%.0f;ma=%.0f;st=%.0f;sf=%.0f;ni=%.0f;no=%.0f;dr=%.0f;dw=%.0f;up=%.0f;la=%s;nc=%.0f;h=%s;end=1\n", cpu, mt+0, ma+0, st+0, sf+0, ni+0, no+0, dr+0, dw+0, up+0, la+0, C+0, H }}
' /proc/stat /proc/meminfo /proc/net/dev /proc/diskstats /proc/uptime /proc/loadavg </dev/null 2>/dev/null
sleep {n} </dev/null
done
"#
    )
}

// ---------- análisis (puro) ----------

/// Contadores tal como salen del servidor.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Raw {
    pub cpu: [u64; 8],
    pub mem_total_kb: u64,
    pub mem_avail_kb: u64,
    pub swap_total_kb: u64,
    pub swap_free_kb: u64,
    pub net_in: u64,
    pub net_out: u64,
    pub disk_read_sectors: u64,
    pub disk_write_sectors: u64,
    pub uptime: u64,
    pub load: f64,
    pub cores: u32,
    pub host: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    /// `false` en la primera línea de una conexión: sin referencia para CPU y tasas.
    pub ready: bool,
    pub cpu: f64,
    pub ram_used: u64,
    pub ram_total: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    pub disk_read: f64,
    pub disk_write: f64,
    pub net_in: f64,
    pub net_out: f64,
    pub uptime: u64,
    pub hostname: String,
    pub cores: u32,
    pub load: f64,
}

fn num(v: &str) -> Option<u64> {
    if v.is_empty() || v.len() > 20 || !v.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    v.parse().ok()
}

/// Una línea del servidor -> contadores. Estricto: toda clave presente una sola vez, números sin signo, `end=1` al final
/// (una línea cortada a medias no se acepta) y como mucho 4 KB. Cualquier otra cosa: `None`.
pub fn parse_line(line: &str) -> Option<Raw> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.len() > MAX_LINE || !line.ends_with(";end=1") {
        return None;
    }
    let mut m: HashMap<&str, &str> = HashMap::new();
    for part in line.split(';') {
        let (k, v) = part.split_once('=')?;
        if m.insert(k, v).is_some() {
            return None;
        }
    }
    if m.len() != 14 {
        return None;
    }
    let g = |k: &str| m.get(k).copied();
    let n = |k: &str| g(k).and_then(num);
    let mut cpu = [0u64; 8];
    let parts: Vec<&str> = g("cpu")?.split(',').collect();
    if parts.len() != 8 {
        return None;
    }
    for (i, p) in parts.iter().enumerate() {
        cpu[i] = num(p)?;
    }
    let load: f64 = g("la")?.parse().ok().filter(|l: &f64| l.is_finite() && *l >= 0.0)?;
    let host: String = g("h")?.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')).take(255).collect();
    Some(Raw {
        cpu,
        mem_total_kb: n("mt")?,
        mem_avail_kb: n("ma")?,
        swap_total_kb: n("st")?,
        swap_free_kb: n("sf")?,
        net_in: n("ni")?,
        net_out: n("no")?,
        disk_read_sectors: n("dr")?,
        disk_write_sectors: n("dw")?,
        uptime: n("up")?,
        load,
        cores: n("nc")?.min(100_000) as u32,
        host,
    })
}

/// (ocupado, total) de /proc/stat: ocupado = user+nice+system+irq+softirq; inactivo = idle+iowait+steal.
fn busy_total(c: &[u64; 8]) -> (u64, u64) {
    let busy = c[0].saturating_add(c[1]).saturating_add(c[2]).saturating_add(c[5]).saturating_add(c[6]);
    let idle = c[3].saturating_add(c[4]).saturating_add(c[7]);
    (busy, busy.saturating_add(idle))
}

/// CPU % entre dos lecturas. Contadores que bajan o sin avance: 0.
pub fn cpu_pct(prev: &[u64; 8], cur: &[u64; 8]) -> f64 {
    let (pb, pt) = busy_total(prev);
    let (cb, ct) = busy_total(cur);
    if ct <= pt || cb < pb {
        return 0.0;
    }
    ((cb - pb) as f64 / (ct - pt) as f64 * 100.0).clamp(0.0, 100.0)
}

/// Muestra a partir de la lectura actual y la anterior. `elapsed` = tiempo REAL (marcas locales de recepción) entre ambas.
pub fn compute(prev: Option<&Raw>, cur: &Raw, elapsed: f64) -> Sample {
    let ram_total = cur.mem_total_kb.saturating_mul(1024);
    let swap_total = cur.swap_total_kb.saturating_mul(1024);
    let mut s = Sample {
        ready: false,
        ram_total,
        ram_used: ram_total.saturating_sub(cur.mem_avail_kb.saturating_mul(1024)),
        swap_total,
        swap_used: swap_total.saturating_sub(cur.swap_free_kb.saturating_mul(1024)),
        uptime: cur.uptime,
        hostname: cur.host.clone(),
        cores: cur.cores,
        load: cur.load,
        ..Default::default()
    };
    if let Some(p) = prev {
        if elapsed > 0.0 && elapsed.is_finite() {
            s.ready = true;
            s.cpu = cpu_pct(&p.cpu, &cur.cpu);
            s.net_in = rate_per_sec(p.net_in, cur.net_in, elapsed);
            s.net_out = rate_per_sec(p.net_out, cur.net_out, elapsed);
            s.disk_read = rate_per_sec(p.disk_read_sectors.saturating_mul(512), cur.disk_read_sectors.saturating_mul(512), elapsed);
            s.disk_write = rate_per_sec(p.disk_write_sectors.saturating_mul(512), cur.disk_write_sectors.saturating_mul(512), elapsed);
        }
    }
    s
}

/// Máximo una línea cada `MIN_GAP`.
#[derive(Default)]
pub struct Throttle {
    last: Option<Instant>,
}
impl Throttle {
    pub fn accept(&mut self, now: Instant) -> bool {
        if let Some(l) = self.last {
            if now.saturating_duration_since(l) < MIN_GAP {
                return false;
            }
        }
        self.last = Some(now);
        true
    }
}

#[derive(Debug, PartialEq)]
pub enum Line {
    Ok(String),
    TooLong,
    Eof,
}

/// Lee una línea con tope de memoria: una línea más larga que `cap` se consume entera y se descarta. Una línea sin `\n` al EOF se descarta.
pub fn read_line_capped<R: BufRead>(r: &mut R, cap: usize) -> std::io::Result<Line> {
    let mut acc: Vec<u8> = Vec::new();
    let mut over = false;
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            return Ok(Line::Eof);
        }
        let (take, found) = match buf.iter().position(|b| *b == b'\n') {
            Some(i) => (i + 1, true),
            None => (buf.len(), false),
        };
        if !over {
            if acc.len() + take > cap + 1 {
                over = true;
                acc.clear();
            } else {
                acc.extend_from_slice(&buf[..take]);
            }
        }
        r.consume(take);
        if found {
            return Ok(if over { Line::TooLong } else { Line::Ok(String::from_utf8_lossy(&acc).into_owned()) });
        }
    }
}

// ---------- fallos ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    HostKey,
    Auth,
    Unsupported,
    Network,
    Other,
}
impl Kind {
    pub fn retriable(self) -> bool {
        self == Kind::Network
    }
    fn name(self) -> &'static str {
        match self {
            Kind::HostKey => "hostkey",
            Kind::Auth => "auth",
            Kind::Unsupported => "unsupported",
            Kind::Network => "network",
            Kind::Other => "other",
        }
    }
}

/// Qué falló, mirando lo que ssh dijo por stderr y su código de salida. Solo los fallos de red se reintentan.
pub fn classify(stderr: &str, code: Option<i32>, unsupported: bool) -> (Kind, String) {
    let e = stderr.to_ascii_lowercase();
    if unsupported {
        return (Kind::Unsupported, REASON_UNSUPPORTED.into());
    }
    if e.contains("host key verification failed") || e.contains("remote host identification has changed") || e.contains("no matching host key") {
        return (Kind::HostKey, REASON_HOSTKEY.into());
    }
    if e.contains("permission denied") || e.contains("authentication failed") || e.contains("too many authentication failures") || e.contains("no more authentication methods") {
        return (Kind::Auth, REASON_AUTH.into());
    }
    if e.contains("command not found") || e.contains("not recognized") || e.contains("sh: ") && e.contains("not found") {
        return (Kind::Unsupported, REASON_UNSUPPORTED.into());
    }
    let net = ["connection refused", "timed out", "no route to host", "could not resolve", "network is unreachable", "connection reset", "broken pipe", "closed by", "connection closed", "kex_exchange"];
    if net.iter().any(|n| e.contains(n)) || code == Some(255) || code.is_none() {
        let first: String = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("connection lost").chars().take(160).collect();
        return (Kind::Network, first);
    }
    let first: String = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("ssh failed").chars().take(160).collect();
    (Kind::Other, first)
}

// ---------- hijo ----------

/// Dueño del proceso `ssh`: lo mata al soltarse (nada de ssh huérfanos).
#[derive(Default)]
pub struct ChildGuard {
    child: Mutex<Option<Child>>,
}
impl ChildGuard {
    fn set(&self, c: Child) {
        *self.child.lock() = Some(c);
    }
    pub fn kill(&self) {
        if let Some(c) = self.child.lock().as_mut() {
            let _ = c.kill();
        }
    }
    /// ¿Ha terminado (o no hay hijo)?
    pub fn exited(&self) -> bool {
        match self.child.lock().as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(Some(_))),
            None => true,
        }
    }
    /// Espera hasta 2 s a que termine; si no, lo mata. Devuelve el código.
    fn finish(&self) -> Option<i32> {
        let end = Instant::now() + Duration::from_secs(2);
        loop {
            {
                let mut g = self.child.lock();
                match g.as_mut().map(|c| c.try_wait()) {
                    Some(Ok(Some(st))) => {
                        g.take();
                        return st.code();
                    }
                    None => return None,
                    _ => {}
                }
                if Instant::now() >= end {
                    if let Some(mut c) = g.take() {
                        let _ = c.kill();
                        return c.wait().ok().and_then(|s| s.code());
                    }
                    return None;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.lock().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Cómo se lanza el hijo. El real es `ssh`; las pruebas ponen un sustituto.
pub trait Launcher: Send + Sync {
    fn spawn(&self, d: &Dest) -> std::io::Result<Child>;
}

pub struct SshLauncher;
impl Launcher for SshLauncher {
    fn spawn(&self, d: &Dest) -> std::io::Result<Child> {
        let mut c = Command::new("ssh");
        c.args(build_args(d)).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (k, v) in build_env(d) {
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

// ---------- monitor ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum St {
    Connecting,
    Ok,
    Unavailable,
}

struct Snap {
    st: St,
    reason: Option<String>,
    kind: Option<Kind>,
    sample: Option<Sample>,
    last_line: Option<Instant>,
}

struct Shared {
    stop: AtomicBool,
    suspend: AtomicBool,
    /// Reconectar ya (cambió el intervalo / reintento pedido).
    restart: AtomicBool,
    interval: AtomicU64,
    guard: ChildGuard,
    snap: Mutex<Snap>,
    spawns: AtomicU64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// `none` (clave desconocida) | `connecting` | `ok` | `unavailable` | `stale`.
    pub state: String,
    pub reason: Option<String>,
    /// `hostkey` | `auth` | `unsupported` | `network` | `other` (solo con `unavailable`).
    pub kind: Option<String>,
    pub sample: Option<Sample>,
    pub age_ms: Option<u64>,
}

fn set_snap(sh: &Shared, st: St, kind: Option<Kind>, reason: Option<String>) {
    let mut s = sh.snap.lock();
    s.st = st;
    s.kind = kind;
    s.reason = reason;
    if st != St::Ok {
        s.sample = None;
    }
}

fn supervise(sh: Arc<Shared>, launcher: Arc<dyn Launcher>, dest: Dest) {
    let mut backoff: u64 = 5;
    'outer: loop {
        if sh.stop.load(Ordering::Relaxed) {
            return;
        }
        if sh.suspend.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }
        sh.restart.store(false, Ordering::Relaxed);
        set_snap(&sh, St::Connecting, None, None);
        let interval = sh.interval.load(Ordering::Relaxed);
        let mut child = match launcher.spawn(&dest) {
            Ok(c) => c,
            Err(e) => {
                set_snap(&sh, St::Unavailable, Some(Kind::Other), Some(format!("could not run ssh: {e}")));
                // Fallo definitivo: se espera a que lo paren o pidan reintento.
                while !sh.stop.load(Ordering::Relaxed) {
                    if sh.restart.swap(false, Ordering::Relaxed) {
                        continue 'outer;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                return;
            }
        };
        sh.spawns.fetch_add(1, Ordering::Relaxed);
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        sh.guard.set(child);
        if sh.stop.load(Ordering::Relaxed) || sh.suspend.load(Ordering::Relaxed) {
            sh.guard.kill();
        }
        // El guion por stdin; el pipe se queda abierto mientras viva el hijo.
        let mut stdin = stdin;
        if let Some(si) = stdin.as_mut() {
            let _ = si.write_all(remote_script(interval).as_bytes());
            let _ = si.flush();
        }
        let err_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        if let Some(mut se) = stderr {
            let eb = err_buf.clone();
            std::thread::spawn(move || {
                let mut b = [0u8; 512];
                while let Ok(n) = se.read(&mut b) {
                    if n == 0 {
                        break;
                    }
                    let mut g = eb.lock();
                    if g.len() < 2048 {
                        g.push_str(&String::from_utf8_lossy(&b[..n]));
                    }
                }
            });
        }
        let mut unsupported = false;
        let mut got_sample = false;
        if let Some(so) = stdout {
            let mut rd = std::io::BufReader::new(so);
            let mut thr = Throttle::default();
            let mut prev: Option<(Raw, Instant)> = None;
            loop {
                match read_line_capped(&mut rd, MAX_LINE) {
                    Ok(Line::Ok(l)) => {
                        let now = Instant::now();
                        if l.trim() == "unsupported" {
                            unsupported = true;
                            break;
                        }
                        if !thr.accept(now) {
                            continue;
                        }
                        let Some(raw) = parse_line(&l) else { continue };
                        let s = compute(prev.as_ref().map(|p| &p.0), &raw, prev.as_ref().map(|p| now.duration_since(p.1).as_secs_f64()).unwrap_or(0.0));
                        {
                            let mut g = sh.snap.lock();
                            g.st = St::Ok;
                            g.kind = None;
                            g.reason = None;
                            g.sample = Some(s);
                            g.last_line = Some(now);
                        }
                        prev = Some((raw, now));
                        got_sample = true;
                        backoff = 5;
                    }
                    Ok(Line::TooLong) => continue,
                    Ok(Line::Eof) | Err(_) => break,
                }
            }
        }
        sh.guard.kill();
        let code = sh.guard.finish();
        drop(stdin);
        if sh.stop.load(Ordering::Relaxed) {
            return;
        }
        if sh.suspend.load(Ordering::Relaxed) || sh.restart.load(Ordering::Relaxed) {
            continue;
        }
        std::thread::sleep(Duration::from_millis(50)); // deja que el hilo de stderr vacíe lo último
        let (kind, reason) = classify(&err_buf.lock(), code, unsupported);
        let _ = got_sample;
        set_snap(&sh, St::Unavailable, Some(kind), Some(reason));
        if kind.retriable() {
            let mut waited = 0;
            while waited < backoff * 1000 {
                if sh.stop.load(Ordering::Relaxed) || sh.restart.load(Ordering::Relaxed) || sh.suspend.load(Ordering::Relaxed) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
                waited += 100;
            }
            backoff = (backoff * 2).min(60);
        } else {
            while !sh.stop.load(Ordering::Relaxed) {
                if sh.restart.swap(false, Ordering::Relaxed) {
                    continue 'outer;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            return;
        }
    }
}

struct Mon {
    refs: usize,
    stop_at: Option<Instant>,
    shared: Arc<Shared>,
    dest: Dest,
}

#[derive(Clone, Copy)]
pub struct Cfg {
    /// Gracia tras el último panel antes de parar el monitor.
    pub grace: Duration,
    /// Ventana oculta más de esto: se sueltan los enlaces.
    pub hidden_drop: Duration,
}
impl Default for Cfg {
    fn default() -> Self {
        Cfg { grace: Duration::from_secs(10), hidden_drop: Duration::from_secs(60) }
    }
}

#[derive(Default)]
struct Inner {
    mons: HashMap<String, Mon>,
    hidden_since: Option<Instant>,
    dropped: bool,
}

pub struct Manager {
    inner: Mutex<Inner>,
    launcher: Arc<dyn Launcher>,
    cfg: Cfg,
}

impl Manager {
    pub fn new(launcher: Arc<dyn Launcher>, cfg: Cfg) -> Arc<Self> {
        Arc::new(Manager { inner: Mutex::new(Inner::default()), launcher, cfg })
    }

    /// Un panel SSH vivo más de este destino. Crea el monitor si no existe (un solo hijo por destino); si estaba
    /// en su gracia de parada, la cancela. Devuelve la clave.
    pub fn start(&self, d: Dest, interval: u64) -> Result<String, String> {
        d.validate()?;
        let interval = clamp_interval(interval);
        let key = d.key();
        let mut g = self.inner.lock();
        let dropped = g.dropped;
        if let Some(m) = g.mons.get_mut(&key) {
            m.refs += 1;
            m.stop_at = None;
            if m.shared.interval.swap(interval, Ordering::Relaxed) != interval {
                m.shared.restart.store(true, Ordering::Relaxed);
                m.shared.guard.kill();
            } else if m.refs == 1 && m.shared.snap.lock().st == St::Unavailable {
                // Panel nuevo tras una caída definitiva: un intento más.
                m.shared.restart.store(true, Ordering::Relaxed);
            }
            return Ok(key);
        }
        let shared = Arc::new(Shared {
            stop: AtomicBool::new(false),
            suspend: AtomicBool::new(dropped),
            restart: AtomicBool::new(false),
            interval: AtomicU64::new(interval),
            guard: ChildGuard::default(),
            snap: Mutex::new(Snap { st: St::Connecting, reason: None, kind: None, sample: None, last_line: None }),
            spawns: AtomicU64::new(0),
        });
        let (sh, l, dd) = (shared.clone(), self.launcher.clone(), d.clone());
        std::thread::spawn(move || supervise(sh, l, dd));
        g.mons.insert(key.clone(), Mon { refs: 1, stop_at: None, shared, dest: d });
        Ok(key)
    }

    /// Un panel menos. Con 0, el monitor se para tras la gracia (`reap`).
    pub fn stop(&self, key: &str) {
        let mut g = self.inner.lock();
        if let Some(m) = g.mons.get_mut(key) {
            m.refs = m.refs.saturating_sub(1);
            if m.refs == 0 {
                m.stop_at = Some(Instant::now() + self.cfg.grace);
            }
        }
    }

    pub fn snapshot(&self, key: &str) -> Snapshot {
        let g = self.inner.lock();
        let Some(m) = g.mons.get(key) else {
            return Snapshot { state: "none".into(), reason: None, kind: None, sample: None, age_ms: None };
        };
        let s = m.shared.snap.lock();
        let interval = m.shared.interval.load(Ordering::Relaxed);
        let age = s.last_line.map(|l| l.elapsed());
        let stale = s.st == St::Ok && age.map(|a| a > Duration::from_secs(3 * interval)).unwrap_or(false);
        let state = match s.st {
            St::Connecting => "connecting",
            St::Ok if stale => "stale",
            St::Ok => "ok",
            St::Unavailable => "unavailable",
        };
        Snapshot {
            state: state.into(),
            reason: s.reason.clone(),
            kind: s.kind.map(|k| k.name().to_string()),
            sample: s.sample.clone(),
            age_ms: age.map(|a| a.as_millis() as u64),
        }
    }

    /// Ventana oculta/visible. Oculta más de `hidden_drop`: se sueltan los enlaces; al volver se retoman.
    pub fn set_hidden(&self, hidden: bool) {
        let mut g = self.inner.lock();
        if hidden {
            g.hidden_since.get_or_insert_with(Instant::now);
        } else {
            g.hidden_since = None;
            if g.dropped {
                g.dropped = false;
                for m in g.mons.values() {
                    m.shared.suspend.store(false, Ordering::Relaxed);
                }
            }
        }
    }

    /// Tareas periódicas: gracia vencida -> parar y quitar; ventana oculta mucho tiempo -> soltar enlaces.
    pub fn reap(&self, now: Instant) {
        let mut g = self.inner.lock();
        let due: Vec<String> = g.mons.iter().filter(|(_, m)| m.refs == 0 && m.stop_at.map(|t| now >= t).unwrap_or(false)).map(|(k, _)| k.clone()).collect();
        for k in due {
            if let Some(m) = g.mons.remove(&k) {
                m.shared.stop.store(true, Ordering::Relaxed);
                m.shared.guard.kill();
            }
        }
        if let Some(h) = g.hidden_since {
            if !g.dropped && now.saturating_duration_since(h) >= self.cfg.hidden_drop {
                g.dropped = true;
                for m in g.mons.values() {
                    m.shared.suspend.store(true, Ordering::Relaxed);
                    m.shared.guard.kill();
                }
            }
        }
    }

    /// Al salir de la app: todo fuera.
    pub fn shutdown(&self) {
        let mut g = self.inner.lock();
        for (_, m) in g.mons.drain() {
            m.shared.stop.store(true, Ordering::Relaxed);
            m.shared.guard.kill();
        }
    }

    /// Para pruebas: cuántos monitores hay y cuántos hijos se han lanzado en total.
    pub fn counts(&self) -> (usize, u64) {
        let g = self.inner.lock();
        (g.mons.len(), g.mons.values().map(|m| m.shared.spawns.load(Ordering::Relaxed)).sum())
    }

    fn guard_of(&self, key: &str) -> Option<Arc<Shared>> {
        self.inner.lock().mons.get(key).map(|m| m.shared.clone())
    }
    #[allow(dead_code)]
    fn dest_of(&self, key: &str) -> Option<Dest> {
        self.inner.lock().mons.get(key).map(|m| m.dest.clone())
    }
}

/// Hilo que llama a `reap` cada 500 ms mientras el gestor exista.
pub fn spawn_reaper(m: &Arc<Manager>) {
    let w: Weak<Manager> = Arc::downgrade(m);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        match w.upgrade() {
            Some(m) => m.reap(Instant::now()),
            None => return,
        }
    });
}

// ---------- comandos ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartReq {
    #[serde(flatten)]
    pub dest: Dest,
    pub interval: u64,
}

#[tauri::command(async)]
pub fn rmetrics_start(m: tauri::State<'_, Arc<Manager>>, req: StartReq) -> Result<String, String> {
    m.start(req.dest, req.interval)
}

#[tauri::command(async)]
pub fn rmetrics_stop(m: tauri::State<'_, Arc<Manager>>, key: String) {
    m.stop(&key)
}

#[tauri::command(async)]
pub fn rmetrics_sample(m: tauri::State<'_, Arc<Manager>>, key: String) -> Snapshot {
    m.snapshot(&key)
}

#[tauri::command(async)]
pub fn rmetrics_hidden(m: tauri::State<'_, Arc<Manager>>, hidden: bool) {
    m.set_hidden(hidden)
}

// ---------- pruebas ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn dest() -> Dest {
        Dest { user: Some("root".into()), host: "db.example.com".into(), port: 2222, ..Default::default() }
    }

    fn line(cpu: &str, ni: u64, dr: u64, up: u64) -> String {
        format!("cpu={cpu};mt=16000000;ma=4000000;st=2000000;sf=1500000;ni={ni};no=1000;dr={dr};dw=200;up={up};la=0.52;nc=8;h=web-01;end=1\n")
    }

    // ---- análisis ----

    #[test]
    fn parsea_una_linea_real() {
        let r = parse_line(&line("1000,10,500,8000,100,0,50,0", 123456, 5000, 90061)).unwrap();
        assert_eq!(r.cpu, [1000, 10, 500, 8000, 100, 0, 50, 0]);
        assert_eq!(r.mem_total_kb, 16000000);
        assert_eq!(r.host, "web-01");
        assert_eq!(r.cores, 8);
        assert!((r.load - 0.52).abs() < 1e-9);
    }

    #[test]
    fn linea_parcial_o_basura_se_ignora() {
        let full = line("1,2,3,4,5,6,7,8", 1, 1, 1);
        // cortada a medias (sin end=1)
        assert!(parse_line(&full[..full.len() - 10]).is_none());
        // cortada dentro del último dato (todas las claves presentes pero sin `end=1`): tampoco
        assert!(parse_line(&full.replace("web-01;end=1
", "web-0")).is_none());
        assert!(parse_line("").is_none());
        assert!(parse_line("hola;mundo;end=1").is_none());
        assert!(parse_line("unsupported").is_none());
        // número negativo / no numérico / clave repetida / falta una clave
        assert!(parse_line(&full.replace("ni=1", "ni=-1")).is_none());
        assert!(parse_line(&full.replace("mt=16000000", "mt=abc")).is_none());
        assert!(parse_line(&full.replace("la=0.52", "la=0.52;la=0.6")).is_none());
        assert!(parse_line(&full.replace("nc=8;", "")).is_none());
        // cpu con menos campos
        assert!(parse_line(&line("1,2,3", 1, 1, 1)).is_none());
    }

    #[test]
    fn el_nombre_del_host_se_limpia_y_no_es_html() {
        let l = line("1,2,3,4,5,6,7,8", 1, 1, 1).replace("h=web-01", "h=<img src=x onerror=1>");
        let r = parse_line(&l).unwrap();
        assert!(!r.host.contains('<') && !r.host.contains('>') && !r.host.contains(' '));
    }

    #[test]
    fn salida_real_de_un_linux_wsl_ubuntu_dash() {
        // Capturada ejecutando remote_script(2) con `sh -s` (dash) en WSL2 Ubuntu.
        let a = parse_line("cpu=158,0,390,19136,8820,0,105,0;mt=22545028;ma=21823664;st=16777216;sf=16777216;ni=11560;no=7741;dr=696262;dw=9336;up=24;la=1.61;nc=12;h=DESKTOP-8J3DGI9;end=1
").unwrap();
        let b = parse_line("cpu=170,0,398,20802,9536,0,107,0;mt=22545028;ma=21786672;st=16777216;sf=16777216;ni=12520;no=8701;dr=714382;dw=9488;up=26;la=1.96;nc=12;h=DESKTOP-8J3DGI9;end=1
").unwrap();
        let s = compute(Some(&a), &b, 2.0);
        assert!(s.ready && s.cpu > 0.0 && s.cpu < 20.0, "{s:?}");
        assert_eq!(s.net_in, (12520.0 - 11560.0) / 2.0);
        assert_eq!(s.cores, 12);
        assert_eq!(s.hostname, "DESKTOP-8J3DGI9");
    }

    #[test]
    fn linea_demasiado_larga_se_descarta() {
        let long = format!("{}{}", "a".repeat(MAX_LINE + 10), ";end=1");
        assert!(parse_line(&long).is_none());
        let mut c = Cursor::new(format!("{}\nok\n", "x".repeat(10_000)).into_bytes());
        assert_eq!(read_line_capped(&mut c, MAX_LINE).unwrap(), Line::TooLong);
        assert_eq!(read_line_capped(&mut c, MAX_LINE).unwrap(), Line::Ok("ok\n".into()));
        assert_eq!(read_line_capped(&mut c, MAX_LINE).unwrap(), Line::Eof);
    }

    #[test]
    fn linea_sin_salto_al_eof_no_cuenta() {
        let mut c = Cursor::new(b"cpu=1;end=1".to_vec());
        assert_eq!(read_line_capped(&mut c, MAX_LINE).unwrap(), Line::Eof);
    }

    #[test]
    fn tasas_con_tiempo_real() {
        let a = parse_line(&line("1000,0,1000,8000,0,0,0,0", 1_000_000, 1000, 100)).unwrap();
        let b = parse_line(&line("1500,0,1500,8500,0,0,0,0", 3_000_000, 3000, 102)).unwrap();
        // 2 s reales
        let s = compute(Some(&a), &b, 2.0);
        assert!(s.ready);
        assert_eq!(s.net_in, 1_000_000.0);
        assert_eq!(s.disk_read, 2000.0 * 512.0 / 2.0);
        // 4 s reales: las tasas se reparten por el tiempo REAL
        let s4 = compute(Some(&a), &b, 4.0);
        assert_eq!(s4.net_in, 500_000.0);
        // CPU: ocupado +1000 de +1500 totales
        assert!((s.cpu - 100.0 * 1000.0 / 1500.0).abs() < 1e-9);
        assert_eq!(s.ram_used, (16000000 - 4000000) * 1024);
        assert_eq!(s.swap_used, 500000 * 1024);
    }

    #[test]
    fn primera_linea_sin_tasas_y_contadores_que_bajan_a_cero() {
        let a = parse_line(&line("1000,0,1000,8000,0,0,0,0", 5_000_000, 9000, 100)).unwrap();
        let s0 = compute(None, &a, 0.0);
        assert!(!s0.ready);
        assert_eq!((s0.cpu, s0.net_in, s0.disk_read), (0.0, 0.0, 0.0));
        let reset = parse_line(&line("10,0,10,80,0,0,0,0", 100, 10, 5)).unwrap(); // reinicio: todo baja
        let s = compute(Some(&a), &reset, 2.0);
        assert!(s.ready);
        assert_eq!((s.cpu, s.net_in, s.net_out, s.disk_read), (0.0, 0.0, 0.0, 0.0));
        // tiempo no positivo: sin tasas
        assert!(!compute(Some(&a), &a, 0.0).ready);
    }

    #[test]
    fn cpu_cuenta_steal_e_iowait_como_inactivo() {
        let p = [0u64; 8];
        // user=100, idle=0, iowait=100, steal=100 -> ocupado 100 de 300
        let c = [100, 0, 0, 0, 100, 0, 0, 100];
        assert!((cpu_pct(&p, &c) - 100.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn maximo_una_linea_cada_500ms() {
        let mut t = Throttle::default();
        let t0 = Instant::now();
        assert!(t.accept(t0));
        assert!(!t.accept(t0 + Duration::from_millis(100)));
        assert!(!t.accept(t0 + Duration::from_millis(499)));
        assert!(t.accept(t0 + Duration::from_millis(600)));
    }

    #[test]
    fn clasifica_fallos() {
        assert_eq!(classify("Host key verification failed.", Some(255), false).0, Kind::HostKey);
        assert_eq!(classify("root@h: Permission denied (publickey,password).", Some(255), false).0, Kind::Auth);
        assert_eq!(classify("", Some(0), true).0, Kind::Unsupported);
        assert_eq!(classify("ssh: connect to host x port 22: Connection refused", Some(255), false).0, Kind::Network);
        assert_eq!(classify("ssh: Could not resolve hostname nope: No such host is known.", Some(255), false).0, Kind::Network);
        assert_eq!(classify("'sh' is not recognized as an internal or external command", Some(1), false).0, Kind::Unsupported);
        assert!(Kind::Network.retriable());
        for k in [Kind::HostKey, Kind::Auth, Kind::Unsupported, Kind::Other] {
            assert!(!k.retriable());
        }
    }

    // ---- constructor de argumentos ----

    #[test]
    fn la_huella_nunca_se_acepta_sola() {
        for d in [dest(), Dest { secret_key: Some("host:abc:password".into()), ..dest() }, Dest { jump: Some("bastion".into()), ..dest() }] {
            let a = build_args(&d);
            let joined = a.join(" ").to_ascii_lowercase();
            assert!(a.contains(&"StrictHostKeyChecking=yes".to_string()));
            assert!(!joined.contains("stricthostkeychecking=no"));
            assert!(!joined.contains("accept-new"));
            assert_eq!(a.iter().filter(|x| x.to_ascii_lowercase().starts_with("stricthostkeychecking")).count(), 1);
        }
    }

    #[test]
    fn args_array_sin_shell_y_comando_constante() {
        let a = build_args(&Dest { identity: Some("C:\\Users\\a b\\.ssh\\id".into()), identities_only: true, jump: Some("j@bastion:22".into()), ..dest() });
        // el destino va tras `--` y lo último es el comando constante
        let dd = a.iter().position(|x| x == "--").unwrap();
        assert_eq!(a[dd + 1], "root@db.example.com");
        assert_eq!(&a[dd + 2..], ["sh", "-s"]);
        assert_eq!(a[0], "-T");
        assert!(!a.iter().any(|x| x == "-N"));
        // una ruta con espacios viaja como UN argumento
        assert!(a.iter().any(|x| x == "C:\\Users\\a b\\.ssh\\id"));
        assert!(a.windows(2).any(|w| w[0] == "-J" && w[1] == "j@bastion:22"));
        assert!(a.windows(2).any(|w| w[0] == "-p" && w[1] == "2222"));
        assert!(a.contains(&"IdentitiesOnly=yes".to_string()));
        for x in ["BatchMode=yes", "ConnectTimeout=8", "ServerAliveInterval=5", "ServerAliveCountMax=2", "LogLevel=ERROR"] {
            assert!(a.contains(&x.to_string()), "falta {x}");
        }
    }

    #[test]
    fn batchmode_solo_sin_secreto_y_el_secreto_no_va_en_args_ni_en_entorno() {
        let sin = build_args(&dest());
        assert!(sin.contains(&"BatchMode=yes".to_string()) && !sin.contains(&"BatchMode=no".to_string()));
        let con_d = Dest { secret_key: Some("host:h1:password".into()), ..dest() };
        let con = build_args(&con_d);
        assert!(con.contains(&"BatchMode=no".to_string()) && !con.contains(&"BatchMode=yes".to_string()));
        assert!(con.contains(&"NumberOfPasswordPrompts=1".to_string()));
        // El «secreto» real vive en la bóveda: aquí solo existe su nombre. Un valor centinela no puede aparecer.
        let env = build_env(&con_d);
        assert!(env.iter().any(|(k, v)| k == "SSH_ASKPASS_REQUIRE" && v == "force"));
        assert!(env.iter().any(|(k, v)| k == "ORCHESTRA_ASKPASS_KEY" && v == "host:h1:password"));
        for (_, v) in &env {
            assert!(!v.contains("hunter2"));
        }
        // Solo el askpass y el NOMBRE de la entrada: nada más viaja por el entorno.
        let exe = std::env::current_exe().unwrap_or_default().to_string_lossy().into_owned();
        for (k, v) in &env {
            assert!(matches!(k.as_str(), "SSH_ASKPASS" | "SSH_ASKPASS_REQUIRE" | "ORCHESTRA_ASKPASS_MODE" | "ORCHESTRA_ASKPASS_KEY") || k.starts_with("ORCHESTRA_"), "variable inesperada {k}");
            assert!(*v == exe || v == "force" || v == "1" || v == "host:h1:password", "valor inesperado en {k}");
        }
        assert!(build_env(&dest()).is_empty());
        let all = format!("{con:?}{env:?}");
        assert!(!all.contains("hunter2"));
    }

    #[test]
    fn destinos_peligrosos_se_rechazan() {
        let ok = |d: Dest| d.validate().is_ok();
        assert!(ok(dest()));
        assert!(!ok(Dest { host: "-oProxyCommand=calc".into(), ..dest() }));
        assert!(!ok(Dest { host: "-x".into(), ..dest() }));
        assert!(!ok(Dest { host: "a b".into(), ..dest() }));
        assert!(!ok(Dest { host: "".into(), ..dest() }));
        assert!(!ok(Dest { host: "h;rm -rf /".into(), ..dest() }));
        assert!(!ok(Dest { host: "h\nx".into(), ..dest() }));
        assert!(!ok(Dest { user: Some("-l".into()), ..dest() }));
        assert!(!ok(Dest { user: Some("a b".into()), ..dest() }));
        assert!(!ok(Dest { user: Some("".into()), ..dest() }));
        assert!(!ok(Dest { port: 0, ..dest() }));
        assert!(!ok(Dest { jump: Some("-oProxyCommand=x".into()), ..dest() }));
        assert!(!ok(Dest { jump: Some("a, b".into()), ..dest() }));
        assert!(!ok(Dest { identity: Some("-oFoo".into()), ..dest() }));
        assert!(!ok(Dest { identity: Some("a\nb".into()), ..dest() }));
        assert!(!ok(Dest { secret_key: Some("ssh-agent".into()), ..dest() }));
        assert!(!ok(Dest { secret_key: Some("host:a b".into()), ..dest() }));
        assert!(ok(Dest { host: "::1".into(), ..dest() }));
        assert!(ok(Dest { jump: Some("u@j1:22,j2".into()), ..dest() }));
    }

    #[test]
    fn guion_constante_con_entero_validado() {
        let s = remote_script(3);
        assert!(s.contains("sleep 3 "));
        assert!(remote_script(0).contains("sleep 2 "));
        assert!(remote_script(999).contains("sleep 10 "));
        assert!(s.contains("echo unsupported"));
        // Nada del guion depende de datos del usuario: dos llamadas iguales son idénticas.
        assert_eq!(remote_script(5), remote_script(5));
    }

    // ---- el guion de verdad, en un sh local (Linux/WSL: ver pruebas ignoradas) ----

    #[cfg(unix)]
    #[test]
    fn el_guion_corre_en_un_linux_y_se_parsea() {
        use std::process::Command;
        let mut c = Command::new("sh").args(["-c", "exit 0"]).spawn().unwrap();
        let _ = c.wait();
        // Un solo tick: se corta el bucle con timeout.
        let script = remote_script(2);
        let mut child = Command::new("sh").arg("-s").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
        let mut rd = std::io::BufReader::new(child.stdout.take().unwrap());
        let Line::Ok(l) = read_line_capped(&mut rd, MAX_LINE).unwrap() else { panic!("sin línea") };
        let _ = child.kill();
        let _ = child.wait();
        let r = parse_line(&l).unwrap_or_else(|| panic!("no parsea: {l}"));
        assert!(r.mem_total_kb > 0);
    }

    // ---- gestor con un sustituto de ssh ----

    /// Sustituto: un proceso largo que escribe una línea válida cada 0,6 s. Cuenta los lanzamientos.
    struct Fake {
        n: std::sync::atomic::AtomicUsize,
    }
    impl Launcher for Fake {
        fn spawn(&self, _d: &Dest) -> std::io::Result<Child> {
            self.n.fetch_add(1, Ordering::SeqCst);
            let body = "cpu=10,0,10,80,0,0,0,0;mt=1000;ma=500;st=0;sf=0;ni=10;no=10;dr=1;dw=1;up=5;la=0.1;nc=2;h=fake;end=1";
            #[cfg(windows)]
            let mut c = {
                let mut c = Command::new("powershell.exe");
                c.args(["-NoProfile", "-Command", &format!("while($true){{ '{body}'; Start-Sleep -Milliseconds 600 }}")]);
                use std::os::windows::process::CommandExt;
                c.creation_flags(0x0800_0000);
                c
            };
            #[cfg(not(windows))]
            let mut c = {
                let mut c = Command::new("sh");
                c.args(["-c", &format!("while :; do echo '{body}'; sleep 0.6; done")]);
                c
            };
            c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        }
    }

    fn mgr(grace_ms: u64) -> (Arc<Manager>, Arc<Fake>) {
        let f = Arc::new(Fake { n: Default::default() });
        let m = Manager::new(f.clone(), Cfg { grace: Duration::from_millis(grace_ms), hidden_drop: Duration::from_millis(300) });
        (m, f)
    }

    fn wait_for(mut f: impl FnMut() -> bool, ms: u64) -> bool {
        let end = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < end {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        f()
    }

    #[test]
    fn varios_paneles_del_mismo_host_un_solo_proceso_y_el_ultimo_lo_para() {
        let (m, f) = mgr(200);
        let k1 = m.start(dest(), 3).unwrap();
        let k2 = m.start(dest(), 3).unwrap();
        let k3 = m.start(dest(), 3).unwrap();
        assert_eq!((k1.clone(), k2.clone()), (k2, k3));
        assert!(wait_for(|| m.snapshot(&k1).state == "ok", 15_000), "sin muestra: {:?}", m.snapshot(&k1));
        assert_eq!(f.n.load(Ordering::SeqCst), 1, "un solo ssh para 3 paneles");
        assert_eq!(m.counts().0, 1);
        let sh = m.guard_of(&k1).unwrap();
        // se cierran 2 de 3: sigue vivo tras la gracia
        m.stop(&k1);
        m.stop(&k1);
        m.reap(Instant::now() + Duration::from_secs(5));
        assert_eq!(m.counts().0, 1);
        assert!(!sh.guard.exited(), "sigue vivo con un panel abierto");
        // cierra el último: tras la gracia se para y el hijo muere
        m.stop(&k1);
        m.reap(Instant::now()); // aún dentro de la gracia
        assert_eq!(m.counts().0, 1);
        m.reap(Instant::now() + Duration::from_secs(1));
        assert_eq!(m.counts().0, 0);
        assert!(wait_for(|| sh.guard.exited(), 5000), "el hijo debe estar muerto (sin huérfanos)");
        assert_eq!(m.snapshot(&k1).state, "none");
    }

    #[test]
    fn otro_host_otro_monitor() {
        let (m, f) = mgr(200);
        let a = m.start(dest(), 3).unwrap();
        let b = m.start(Dest { host: "other.example.com".into(), ..dest() }, 3).unwrap();
        let c = m.start(Dest { port: 22, ..dest() }, 3).unwrap();
        assert!(a != b && a != c && b != c);
        assert!(wait_for(|| f.n.load(Ordering::SeqCst) == 3, 15_000));
        assert_eq!(m.counts().0, 3);
        m.shutdown();
        assert_eq!(m.counts().0, 0);
    }

    #[test]
    fn reabrir_dentro_de_la_gracia_no_reconecta() {
        let (m, f) = mgr(5000);
        let k = m.start(dest(), 3).unwrap();
        assert!(wait_for(|| m.snapshot(&k).state == "ok", 15_000));
        m.stop(&k);
        m.reap(Instant::now() + Duration::from_secs(1)); // dentro de la gracia
        let k2 = m.start(dest(), 3).unwrap(); // vuelve un panel
        m.reap(Instant::now() + Duration::from_secs(60)); // la gracia cancelada ya no vence
        assert_eq!(k, k2);
        assert_eq!(m.counts().0, 1);
        assert_eq!(f.n.load(Ordering::SeqCst), 1);
        m.shutdown();
    }

    #[test]
    fn shutdown_mata_los_hijos() {
        let (m, _f) = mgr(200);
        let k = m.start(dest(), 3).unwrap();
        assert!(wait_for(|| m.snapshot(&k).state == "ok", 15_000));
        let sh = m.guard_of(&k).unwrap();
        m.shutdown();
        assert!(wait_for(|| sh.guard.exited(), 5000));
    }

    #[test]
    fn soltar_el_guardian_mata_al_hijo() {
        let f = Fake { n: Default::default() };
        let child = f.spawn(&dest()).unwrap();
        let g = ChildGuard::default();
        g.set(child);
        assert!(!g.exited());
        drop(g); // Drop: kill + wait; si no matara, el proceso quedaría huérfano
    }

    #[test]
    fn ventana_oculta_suelta_el_enlace_y_al_volver_se_retoma() {
        let (m, f) = mgr(5000);
        let k = m.start(dest(), 3).unwrap();
        assert!(wait_for(|| m.snapshot(&k).state == "ok", 15_000));
        m.set_hidden(true);
        m.reap(Instant::now() + Duration::from_secs(1)); // supera hidden_drop (300 ms)
        let sh = m.guard_of(&k).unwrap();
        assert!(wait_for(|| sh.guard.exited(), 5000), "oculta: el enlace se suelta");
        m.set_hidden(false);
        assert!(wait_for(|| f.n.load(Ordering::SeqCst) >= 2, 15_000), "al volver se reconecta");
        assert!(wait_for(|| m.snapshot(&k).state == "ok", 15_000));
        m.shutdown();
    }

    #[test]
    fn destino_invalido_no_arranca_nada() {
        let (m, f) = mgr(200);
        assert!(m.start(Dest { host: "-oProxyCommand=calc".into(), ..dest() }, 3).is_err());
        assert_eq!(m.counts(), (0, 0));
        assert_eq!(f.n.load(Ordering::SeqCst), 0);
    }

    // ---- caminos de fallo reales con el ssh del sistema (sin tocar ningún servidor) ----

    fn real(grace_ms: u64) -> Arc<Manager> {
        Manager::new(Arc::new(SshLauncher), Cfg { grace: Duration::from_millis(grace_ms), ..Cfg::default() })
    }

    #[test]
    #[ignore = "usa el ssh del sistema: 127.0.0.1:1 (rechazado) y un nombre que no existe"]
    fn ssh_real_rechazado_y_nombre_desconocido_y_sin_huerfanos() {
        let m = real(100);
        let k1 = m.start(Dest { host: "127.0.0.1".into(), port: 1, user: Some("nobody".into()), ..Default::default() }, 2).unwrap();
        let k2 = m.start(Dest { host: "no-such-host.invalid".into(), port: 22, user: Some("nobody".into()), ..Default::default() }, 2).unwrap();
        for k in [&k1, &k2] {
            assert!(wait_for(|| m.snapshot(k).state == "unavailable", 30_000), "{k}: {:?}", m.snapshot(k));
            let s = m.snapshot(k);
            assert_eq!(s.kind.as_deref(), Some("network"), "{s:?}");
            assert!(s.sample.is_none(), "nunca ceros falsos");
        }
        let sh = m.guard_of(&k1).unwrap();
        m.stop(&k1);
        m.stop(&k2);
        m.reap(Instant::now() + Duration::from_secs(1));
        assert_eq!(m.counts().0, 0);
        assert!(sh.guard.exited());
    }

    #[test]
    #[ignore = "usa el ssh del sistema contra 127.0.0.1:1"]
    fn ssh_real_huella_desconocida_no_se_acepta_sola() {
        // Un puerto cerrado no llega a la huella; este test solo comprueba que NO se escribe en known_hosts.
        let kh = dirs_known_hosts();
        let before = std::fs::metadata(&kh).map(|m| m.len()).ok();
        let m = real(100);
        let k = m.start(Dest { host: "127.0.0.1".into(), port: 1, user: Some("nobody".into()), ..Default::default() }, 2).unwrap();
        assert!(wait_for(|| m.snapshot(&k).state == "unavailable", 30_000));
        m.shutdown();
        assert_eq!(std::fs::metadata(&kh).map(|m| m.len()).ok(), before, "known_hosts intacto");
    }

    fn dirs_known_hosts() -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).unwrap_or_default()).join(".ssh").join("known_hosts")
    }
}
