//! `net_ping`: tiempo de conexión TCP al puerto SSH de los hosts de los paneles del usuario (insignia de latencia).
//!
//! Solo abre la conexión y la cierra al instante: NO envía ni lee ningún byte, no hay banner, no hay autenticación.
//! Los errores son genéricos ('timeout' | 'unreachable' | 'invalid'), nunca el texto del sistema operativo, y no se
//! registra ningún host. Ver docs/SECURITY.md.

use std::collections::VecDeque;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// Máximo de objetivos por llamada (más = la llamada entera se rechaza).
pub const MAX_TARGETS: usize = 32;
/// Hilos en paralelo.
pub const MAX_THREADS: usize = 8;
/// Tiempo máximo de cada conexión por defecto (el ajuste del usuario va de 1 a 10 s).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
pub const MIN_TIMEOUT_MS: u64 = 500;
pub const MAX_TIMEOUT_MS: u64 = 10_000;

/// Tiempo pedido por la interfaz (ms), recortado a 0,5..10 s; sin valor = 2 s.
pub fn clamp_timeout(ms: Option<u64>) -> Duration {
    ms.map_or(CONNECT_TIMEOUT, |m| Duration::from_millis(m.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)))
}

#[derive(Debug, Clone, Deserialize)]
pub struct PingTarget {
    pub id: String,
    pub host: String,
    /// i64 a propósito: un puerto 0, negativo o > 65535 sale como 'invalid' y no como error de deserialización.
    pub port: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PingResult {
    pub id: String,
    pub ms: Option<f64>,
    pub error: Option<&'static str>,
}

/// Host aceptable: no vacío, ≤ 255, sin espacios ni controles ni `/` ni `@`.
pub fn valid_host(h: &str) -> bool {
    !h.is_empty() && h.len() <= 255 && !h.chars().any(|c| c.is_whitespace() || c.is_control() || c == '/' || c == '@')
}

pub fn valid_port(p: i64) -> bool {
    (1..=65535).contains(&p)
}

/// Mide una conexión TCP. Solo cuenta el `connect` (no la resolución de nombres). No escribe nada en el socket.
fn ping_one(host: &str, port: i64, timeout: Duration) -> Result<f64, &'static str> {
    if !valid_host(host) || !valid_port(port) {
        return Err("invalid");
    }
    let addrs: Vec<_> = (host, port as u16).to_socket_addrs().map_err(|_| "unreachable")?.collect();
    if addrs.is_empty() {
        return Err("unreachable");
    }
    let mut timed_out = false;
    for a in addrs {
        let t0 = Instant::now();
        match TcpStream::connect_timeout(&a, timeout) {
            Ok(s) => {
                let ms = t0.elapsed().as_secs_f64() * 1000.0;
                drop(s); // se cierra sin enviar nada
                return Ok(ms);
            }
            Err(e) => {
                if matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock) {
                    timed_out = true;
                }
            }
        }
    }
    Err(if timed_out { "timeout" } else { "unreachable" })
}

/// Todos los objetivos, en paralelo (≤ 8 hilos). Rechaza más de 32. Un objetivo que no responde a tiempo
/// (p. ej. un DNS colgado) sale como 'timeout' sin retener la respuesta de los demás.
pub fn ping_all(targets: Vec<PingTarget>, timeout: Duration) -> Result<Vec<PingResult>, String> {
    if targets.len() > MAX_TARGETS {
        return Err("too many targets".into());
    }
    let n = targets.len();
    if n == 0 {
        return Ok(vec![]);
    }
    let ids: Vec<String> = targets.iter().map(|t| t.id.chars().take(200).collect()).collect();
    let queue: Arc<Mutex<VecDeque<(usize, PingTarget)>>> = Arc::new(Mutex::new(targets.into_iter().enumerate().collect()));
    let (tx, rx) = mpsc::channel::<(usize, Result<f64, &'static str>)>();
    let workers = n.min(MAX_THREADS);
    for _ in 0..workers {
        let (q, tx) = (queue.clone(), tx.clone());
        std::thread::spawn(move || loop {
            let job = q.lock().pop_front();
            let Some((i, t)) = job else { break };
            let _ = tx.send((i, ping_one(&t.host, t.port, timeout)));
        });
    }
    drop(tx);
    // Tope total: tandas de CONNECT_TIMEOUT + 1 s de margen para la resolución de nombres.
    let rounds = n.div_ceil(workers) as u32;
    let deadline = Instant::now() + timeout * rounds + Duration::from_secs(1);
    let mut out: Vec<Option<Result<f64, &'static str>>> = vec![None; n];
    while out.iter().any(|r| r.is_none()) {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok((i, r)) => out[i] = Some(r),
            Err(_) => break,
        }
    }
    Ok(out
        .into_iter()
        .zip(ids)
        .map(|(r, id)| match r.unwrap_or(Err("timeout")) {
            Ok(ms) => PingResult { id, ms: Some(ms), error: None },
            Err(e) => PingResult { id, ms: None, error: Some(e) },
        })
        .collect())
}

#[tauri::command]
pub async fn net_ping(targets: Vec<PingTarget>, timeout_ms: Option<u64>) -> Result<Vec<PingResult>, String> {
    let timeout = clamp_timeout(timeout_ms);
    tauri::async_runtime::spawn_blocking(move || ping_all(targets, timeout))
        .await
        .map_err(|_| "ping failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    fn t(id: &str, host: &str, port: i64) -> PingTarget {
        PingTarget { id: id.into(), host: host.into(), port }
    }

    #[test]
    fn local_listener_answers_with_small_ms() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port() as i64;
        let r = ping_all(vec![t("a", "127.0.0.1", port)], CONNECT_TIMEOUT).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "a");
        assert_eq!(r[0].error, None);
        let ms = r[0].ms.expect("ms");
        assert!((0.0..500.0).contains(&ms), "ms = {ms}");
    }

    #[test]
    fn closed_port_is_a_generic_error() {
        // Se reserva un puerto y se libera: nadie escucha.
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() as i64;
        let r = ping_all(vec![t("x", "127.0.0.1", port)], CONNECT_TIMEOUT).unwrap();
        assert_eq!(r[0].ms, None);
        assert!(matches!(r[0].error, Some("unreachable") | Some("timeout")), "{:?}", r[0].error);
    }

    #[test]
    fn invalid_hosts_and_ports() {
        let bad_hosts = ["", "a b", "a\tb", "a/b", "user@host", "a\u{7}b", &"x".repeat(256)];
        for h in bad_hosts {
            let r = ping_all(vec![t("i", h, 22)], CONNECT_TIMEOUT).unwrap();
            assert_eq!(r[0].error, Some("invalid"), "host {h:?}");
            assert_eq!(r[0].ms, None);
        }
        for p in [0, -1, 65536, 1_000_000] {
            let r = ping_all(vec![t("p", "127.0.0.1", p)], CONNECT_TIMEOUT).unwrap();
            assert_eq!(r[0].error, Some("invalid"), "port {p}");
        }
        assert!(valid_host(&"x".repeat(255)));
        assert!(valid_host("::1") && valid_host("example.com") && valid_host("10.0.0.5"));
    }

    #[test]
    fn more_than_the_cap_is_rejected_and_exactly_the_cap_is_fine() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port() as i64;
        let many: Vec<_> = (0..=MAX_TARGETS).map(|i| t(&i.to_string(), "127.0.0.1", port)).collect();
        assert_eq!(many.len(), MAX_TARGETS + 1);
        assert!(ping_all(many, CONNECT_TIMEOUT).is_err());
        let ok: Vec<_> = (0..MAX_TARGETS).map(|i| t(&i.to_string(), "127.0.0.1", port)).collect();
        let r = ping_all(ok, CONNECT_TIMEOUT).unwrap();
        assert_eq!(r.len(), MAX_TARGETS);
        assert!(r.iter().all(|x| x.ms.is_some()), "{r:?}");
        // Mismo orden que la entrada.
        assert!(r.iter().enumerate().all(|(i, x)| x.id == i.to_string()));
    }

    #[test]
    fn nothing_is_written_to_the_socket() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port() as i64;
        let srv = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_millis(1500))).unwrap();
            let mut buf = [0u8; 64];
            // Ok(0) = el cliente cerró sin enviar nada. Un error de timeout = se quedó abierto (también falla el test).
            s.read(&mut buf)
        });
        let r = ping_all(vec![t("w", "127.0.0.1", port)], CONNECT_TIMEOUT).unwrap();
        assert!(r[0].ms.is_some());
        let n = srv.join().unwrap().expect("la conexión debe cerrarse limpiamente, no quedarse abierta");
        assert_eq!(n, 0, "net_ping no debe enviar ningún byte");
    }

    #[test]
    fn mixed_batch_keeps_order_and_each_result() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port() as i64;
        let r = ping_all(vec![t("bad", "a b", 22), t("ok", "127.0.0.1", port), t("port0", "127.0.0.1", 0)], CONNECT_TIMEOUT).unwrap();
        assert_eq!(r[0].error, Some("invalid"));
        assert!(r[1].ms.is_some());
        assert_eq!(r[2].error, Some("invalid"));
    }

    #[test]
    fn empty_batch_is_empty() {
        assert!(ping_all(vec![], CONNECT_TIMEOUT).unwrap().is_empty());
    }

    #[test]
    fn timeout_setting_is_clamped_and_used() {
        assert_eq!(clamp_timeout(None), CONNECT_TIMEOUT);
        assert_eq!(clamp_timeout(Some(0)), Duration::from_millis(MIN_TIMEOUT_MS));
        assert_eq!(clamp_timeout(Some(1000)), Duration::from_secs(1));
        assert_eq!(clamp_timeout(Some(99_999_999)), Duration::from_millis(MAX_TIMEOUT_MS));
        // Un destino que no responde (TEST-NET-1, no enrutable) termina dentro del tiempo pedido y con error genérico.
        let t0 = Instant::now();
        let r = ping_all(vec![t("n", "192.0.2.1", 22)], Duration::from_millis(600)).unwrap();
        assert!(t0.elapsed() < Duration::from_millis(3500), "tardó {:?}", t0.elapsed());
        assert_eq!(r[0].ms, None);
        assert!(matches!(r[0].error, Some("timeout") | Some("unreachable")), "{:?}", r[0].error);
    }
}
