//! Métricas locales para la barra de estado (CPU, RAM, disco, red, uptime, host).
//!
//! Todo se lee del sistema operativo con `sysinfo`; nada sale de la máquina. Un único `System`/`Networks`/`Disks`
//! vive detrás de un Mutex y solo se refresca lo que hace falta. Las tasas (bytes/s) salen de la diferencia entre
//! dos lecturas de los contadores acumulados y del tiempo REAL transcurrido, no del intervalo configurado.
//! La primera muestra devuelve `ready: false` y tasas a cero (no hay con qué comparar).

use parking_lot::Mutex;
use serde::Serialize;
use std::time::Instant;
use sysinfo::{DiskRefreshKind, Disks, Networks, System};

/// Contadores acumulados de disco y red (suma de todos los dispositivos que cuentan).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    pub disk_read: u64,
    pub disk_write: u64,
    pub net_in: u64,
    pub net_out: u64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    /// `false` en la primera muestra: las tasas y la CPU aún no tienen referencia.
    pub ready: bool,
    pub cpu: f32,
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
}

/// Bytes por segundo entre dos lecturas de un contador acumulado.
/// Tiempo no positivo o contador que baja (vuelta a cero, interfaz que desaparece) = 0, nunca un número enorme o negativo.
pub fn rate_per_sec(prev: u64, cur: u64, elapsed_secs: f64) -> f64 {
    if !(elapsed_secs > 0.0) || !elapsed_secs.is_finite() || cur < prev {
        return 0.0;
    }
    (cur - prev) as f64 / elapsed_secs
}

/// ¿Esta interfaz de red cuenta? El bucle local (loopback) se excluye: no es tráfico de red.
pub fn counts_iface(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if n.contains("loopback") || n == "lo" {
        return false;
    }
    // lo0, lo1…
    if let Some(rest) = n.strip_prefix("lo") {
        if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }
    true
}

/// Tasas entre dos lecturas.
pub fn rates(prev: &Counters, cur: &Counters, elapsed_secs: f64) -> (f64, f64, f64, f64) {
    (
        rate_per_sec(prev.disk_read, cur.disk_read, elapsed_secs),
        rate_per_sec(prev.disk_write, cur.disk_write, elapsed_secs),
        rate_per_sec(prev.net_in, cur.net_in, elapsed_secs),
        rate_per_sec(prev.net_out, cur.net_out, elapsed_secs),
    )
}

struct Sampler {
    sys: System,
    nets: Networks,
    disks: Disks,
    last: Option<(Instant, Counters)>,
    hostname: String,
}

impl Sampler {
    fn new() -> Self {
        Sampler {
            sys: System::new(),
            nets: Networks::new_with_refreshed_list(),
            disks: Disks::new_with_refreshed_list_specifics(DiskRefreshKind::nothing().with_io_usage()),
            last: None,
            hostname: System::host_name().unwrap_or_default(),
        }
    }

    fn sample(&mut self) -> Metrics {
        let now = Instant::now();
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.nets.refresh(true);
        self.disks.refresh_specifics(true, DiskRefreshKind::nothing().with_io_usage());

        let mut cur = Counters::default();
        for (name, data) in self.nets.iter() {
            if counts_iface(name) {
                cur.net_in = cur.net_in.saturating_add(data.total_received());
                cur.net_out = cur.net_out.saturating_add(data.total_transmitted());
            }
        }
        for d in self.disks.list() {
            let u = d.usage();
            cur.disk_read = cur.disk_read.saturating_add(u.total_read_bytes);
            cur.disk_write = cur.disk_write.saturating_add(u.total_written_bytes);
        }

        let mut m = Metrics {
            ready: false,
            cpu: self.sys.global_cpu_usage().clamp(0.0, 100.0),
            ram_used: self.sys.used_memory(),
            ram_total: self.sys.total_memory(),
            swap_used: self.sys.used_swap(),
            swap_total: self.sys.total_swap(),
            uptime: System::uptime(),
            hostname: self.hostname.clone(),
            ..Default::default()
        };
        if let Some((t0, prev)) = self.last {
            let (dr, dw, ni, no) = rates(&prev, &cur, now.duration_since(t0).as_secs_f64());
            m.ready = true;
            m.disk_read = dr;
            m.disk_write = dw;
            m.net_in = ni;
            m.net_out = no;
        }
        self.last = Some((now, cur));
        m
    }
}

static SAMPLER: Mutex<Option<Sampler>> = Mutex::new(None);

/// Una muestra. `async` para que Tauri la ejecute en su pool y no en el hilo de la ventana.
#[tauri::command(async)]
pub fn metrics_sample() -> Metrics {
    SAMPLER.lock().get_or_insert_with(Sampler::new).sample()
}

/// Libera el muestreador (al apagar la barra): la siguiente muestra vuelve a empezar sin referencia.
#[tauri::command(async)]
pub fn metrics_reset() {
    *SAMPLER.lock() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_uses_elapsed_time() {
        assert_eq!(rate_per_sec(1000, 3000, 2.0), 1000.0);
        assert_eq!(rate_per_sec(1000, 3000, 0.5), 4000.0);
    }

    #[test]
    fn rate_zero_or_bad_elapsed_is_zero() {
        assert_eq!(rate_per_sec(0, 100, 0.0), 0.0);
        assert_eq!(rate_per_sec(0, 100, -1.0), 0.0);
        assert_eq!(rate_per_sec(0, 100, f64::NAN), 0.0);
        assert_eq!(rate_per_sec(0, 100, f64::INFINITY), 0.0);
    }

    #[test]
    fn rate_counter_wrap_is_zero() {
        assert_eq!(rate_per_sec(u64::MAX - 5, 10, 1.0), 0.0);
        assert_eq!(rate_per_sec(500, 100, 1.0), 0.0);
        assert_eq!(rate_per_sec(7, 7, 1.0), 0.0);
    }

    #[test]
    fn loopback_is_excluded() {
        assert!(!counts_iface("Loopback Pseudo-Interface 1"));
        assert!(!counts_iface("lo"));
        assert!(!counts_iface("lo0"));
        assert!(counts_iface("Ethernet"));
        assert!(counts_iface("Wi-Fi"));
        assert!(counts_iface("eth0"));
        assert!(counts_iface("local-area")); // empieza por «lo» pero no es loopback
    }

    #[test]
    fn rates_map_each_counter() {
        let a = Counters { disk_read: 0, disk_write: 100, net_in: 1000, net_out: 50 };
        let b = Counters { disk_read: 400, disk_write: 300, net_in: 3000, net_out: 50 };
        assert_eq!(rates(&a, &b, 2.0), (200.0, 100.0, 1000.0, 0.0));
    }

    /// Lectura real dos veces con 1 s de diferencia. `cargo test --bin orchestra real_sample -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_sample() {
        let mut s = Sampler::new();
        let first = s.sample();
        assert!(!first.ready);
        std::thread::sleep(std::time::Duration::from_millis(1000));
        let m = s.sample();
        println!("{m:#?}");
        assert!(m.ready);
        assert!((0.0..=100.0).contains(&m.cpu));
        assert!(m.ram_total > 0 && m.ram_used <= m.ram_total);
        assert!(m.swap_used <= m.swap_total);
        assert!(m.disk_read >= 0.0 && m.disk_write >= 0.0 && m.net_in >= 0.0 && m.net_out >= 0.0);
        assert!(m.uptime > 0);
        assert!(!m.hostname.is_empty());
    }
}
