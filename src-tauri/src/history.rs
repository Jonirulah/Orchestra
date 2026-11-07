//! Histórico corto de métricas (última hora) para el panel de gráficas de la barra de estado.
//!
//! Un anillo de puntos con poda por TIEMPO (más de `MAX_AGE_SECS` fuera) y por NÚMERO (`MAX_POINTS`), y un hueco
//! mínimo entre puntos (`MIN_GAP_SECS`) para que un muestreo más rápido no llene el tope antes de la hora.
//! Lo usan el muestreador local (metrics.rs) y cada monitor remoto (remote_metrics.rs). Todo en memoria: nada se guarda.

use serde::Serialize;
use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

/// Ventana del histórico: una hora.
pub const MAX_AGE_SECS: u64 = 3600;
/// Hueco mínimo entre dos puntos guardados (s). Con muestras cada 5 s se guardan todas; cada 2-3 s, una de cada dos.
pub const MIN_GAP_SECS: u64 = 4;
/// Tope de puntos: una hora a un punto cada `MIN_GAP_SECS`.
pub const MAX_POINTS: usize = (MAX_AGE_SECS / MIN_GAP_SECS) as usize;

/// Un punto del histórico. `swap*` y `disk*` son `None` cuando la fuente no los da (sin swap, sin datos de disco):
/// la gráfica los omite en vez de pintar ceros falsos.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    /// Segundos Unix.
    pub t: u64,
    pub cpu: f64,
    pub ram_used: u64,
    pub ram_total: u64,
    pub swap_used: Option<u64>,
    pub swap_total: Option<u64>,
    pub net_in: f64,
    pub net_out: f64,
    pub disk_read: Option<f64>,
    pub disk_write: Option<f64>,
}

/// Segundos Unix de ahora (0 si el reloj está antes de 1970).
pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Default, Debug)]
pub struct Ring {
    pts: VecDeque<Point>,
}

impl Ring {
    pub const fn new() -> Self {
        Ring { pts: VecDeque::new() }
    }

    /// Añade un punto (si respeta el hueco mínimo) y poda lo viejo respecto a su marca de tiempo.
    /// Devuelve `true` si se guardó. Un reloj que va hacia atrás descarta los puntos «del futuro».
    pub fn push(&mut self, p: Point) -> bool {
        while self.pts.back().map(|b| b.t > p.t).unwrap_or(false) {
            self.pts.pop_back();
        }
        if let Some(b) = self.pts.back() {
            if p.t < b.t + MIN_GAP_SECS {
                return false;
            }
        }
        let now = p.t;
        self.pts.push_back(p);
        self.prune(now);
        while self.pts.len() > MAX_POINTS {
            self.pts.pop_front();
        }
        true
    }

    /// Quita los puntos de hace más de una hora respecto a `now`.
    pub fn prune(&mut self, now: u64) {
        while self.pts.front().map(|f| f.t.saturating_add(MAX_AGE_SECS) < now).unwrap_or(false) {
            self.pts.pop_front();
        }
    }

    pub fn clear(&mut self) {
        self.pts.clear();
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.pts.len()
    }

    /// Copia de los puntos de la última hora respecto a `now`, del más viejo al más nuevo.
    pub fn snapshot(&self, now: u64) -> Vec<Point> {
        self.pts.iter().filter(|p| p.t.saturating_add(MAX_AGE_SECS) >= now).cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(t: u64) -> Point {
        Point { t, cpu: 1.0, ..Default::default() }
    }

    #[test]
    fn poda_por_tiempo() {
        let mut r = Ring::new();
        for i in 0..10 {
            assert!(r.push(pt(1000 + i * 600))); // uno cada 10 min: 0..90 min
        }
        // el último está en 1000+5400; solo quedan los de la última hora (>= 1000+1800)
        let s = r.snapshot(1000 + 5400);
        assert_eq!(s.first().unwrap().t, 1000 + 1800);
        assert_eq!(s.len(), 7);
        assert_eq!(r.len(), 7);
        // vista más tarde, sin puntos nuevos: la instantánea también filtra
        assert_eq!(r.snapshot(1000 + 5400 + 3600 + 1).len(), 0);
    }

    #[test]
    fn tope_de_puntos_y_hueco_minimo() {
        let mut r = Ring::new();
        assert!(r.push(pt(100)));
        assert!(!r.push(pt(101)), "demasiado pronto");
        assert!(!r.push(pt(103)));
        assert!(r.push(pt(104)));
        let mut t = 104;
        for _ in 0..(MAX_POINTS * 2) {
            t += MIN_GAP_SECS;
            r.push(pt(t));
        }
        assert!(r.len() <= MAX_POINTS);
        assert_eq!(r.len(), MAX_POINTS);
        assert_eq!(r.snapshot(t).last().unwrap().t, t);
    }

    #[test]
    fn reloj_hacia_atras_no_deja_puntos_del_futuro() {
        let mut r = Ring::new();
        r.push(pt(1000));
        r.push(pt(1005));
        r.push(pt(1010));
        assert!(r.push(pt(1004)));
        let ts: Vec<u64> = r.snapshot(1004).iter().map(|p| p.t).collect();
        assert_eq!(ts, vec![1000, 1004]);
    }

    #[test]
    fn vaciar() {
        let mut r = Ring::new();
        r.push(pt(10));
        r.push(pt(20));
        r.clear();
        assert_eq!(r.len(), 0);
        assert!(r.snapshot(20).is_empty());
        assert!(r.push(pt(21)), "tras vaciar no hay hueco mínimo que respetar");
    }

    #[test]
    fn serializa_en_camel_case_y_none_como_null() {
        let p = Point { t: 5, swap_used: None, disk_read: Some(2.0), ..Default::default() };
        let j = serde_json::to_string(&p).unwrap();
        assert!(j.contains("\"ramUsed\":0") && j.contains("\"swapUsed\":null") && j.contains("\"diskRead\":2.0"), "{j}");
    }
}
