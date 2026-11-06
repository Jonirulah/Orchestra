//! Tokens gastados por sesión, sumados de forma incremental.
//!
//! Un transcript es un JSONL que solo crece: se recuerda hasta qué byte se leyó y en cada
//! escaneo solo se procesa lo nuevo. Cada respuesta del modelo puede aparecer en varias líneas
//! (una por bloque de contenido) con el mismo `message.id`, así que se deduplica por id
//! quedándose con el máximo de cada campo (la salida se va completando).

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    /// Entrada nueva (sin caché).
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    /// Tokens escritos en la caché (cuestan más que una entrada normal).
    pub cache_create: u64,
    /// De `output`, los dedicados a razonar.
    pub thinking: u64,
    pub requests: u64,
}

impl Tokens {
    fn max_with(&mut self, o: &Tokens) {
        self.input = self.input.max(o.input);
        self.output = self.output.max(o.output);
        self.cache_read = self.cache_read.max(o.cache_read);
        self.cache_create = self.cache_create.max(o.cache_create);
        self.thinking = self.thinking.max(o.thinking);
    }
    pub fn add(&mut self, o: &Tokens) {
        self.input += o.input;
        self.output += o.output;
        self.cache_read += o.cache_read;
        self.cache_create += o.cache_create;
        self.thinking += o.thinking;
        self.requests += o.requests;
    }
}

#[derive(Default)]
struct Inc {
    offset: u64,
    carry: Vec<u8>,
    by_msg: HashMap<String, Tokens>,
}

static INC: OnceLock<Mutex<HashMap<PathBuf, Inc>>> = OnceLock::new();

fn usage_of(v: &Value) -> Tokens {
    let u = &v["message"]["usage"];
    let g = |k: &str| u[k].as_u64().unwrap_or(0);
    Tokens {
        input: g("input_tokens"),
        output: g("output_tokens"),
        cache_read: g("cache_read_input_tokens"),
        cache_create: g("cache_creation_input_tokens"),
        thinking: u["output_tokens_details"]["thinking_tokens"].as_u64().unwrap_or(0),
        requests: 1,
    }
}

fn feed(inc: &mut Inc, text: &str, skip_sidechain: bool) {
    for line in text.lines() {
        if !line.contains(r#""usage""#) || line.starts_with(r#"{"type":"api-"#) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["type"] != "assistant" || (skip_sidechain && v["isSidechain"].as_bool() == Some(true)) {
            continue;
        }
        let id = v["message"]["id"]
            .as_str()
            .or_else(|| v["requestId"].as_str())
            .or_else(|| v["uuid"].as_str());
        let Some(id) = id else { continue };
        let u = usage_of(&v);
        inc.by_msg
            .entry(id.to_string())
            .and_modify(|t| t.max_with(&u))
            .or_insert(u);
    }
}

fn total(inc: &Inc) -> Tokens {
    let mut t = Tokens::default();
    for u in inc.by_msg.values() {
        t.add(u);
    }
    t
}

/// Total de la sesión en `path`. La primera llamada lee el fichero entero; las siguientes, solo lo añadido.
/// `skip_sidechain`: ignora las líneas de subagentes (en el transcript principal van aparte).
pub fn session_tokens(path: &Path, skip_sidechain: bool) -> Tokens {
    let Ok(md) = std::fs::metadata(path) else { return Tokens::default() };
    let len = md.len();
    let map = INC.get_or_init(Default::default);
    let mut guard = map.lock();
    let inc = guard.entry(path.to_path_buf()).or_default();
    if len < inc.offset {
        *inc = Inc::default(); // el fichero se ha rehecho
    }
    if len > inc.offset {
        if let Ok(mut f) = File::open(path) {
            if f.seek(SeekFrom::Start(inc.offset)).is_ok() {
                let mut buf = std::mem::take(&mut inc.carry);
                let mut fresh = Vec::new();
                if f.take(len - inc.offset).read_to_end(&mut fresh).is_ok() {
                    buf.extend_from_slice(&fresh);
                    inc.offset += fresh.len() as u64;
                    // Solo se consumen líneas completas; el resto queda para la próxima.
                    let cut = buf.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
                    let text = String::from_utf8_lossy(&buf[..cut]).into_owned();
                    inc.carry = buf[cut..].to_vec();
                    feed(inc, &text, skip_sidechain);
                }
            }
        }
    }
    total(inc)
}

/// Suma de todos los subagentes de una sesión (`<sesión>/subagents/agent-*.jsonl`).
pub fn subagents_tokens(dir: &Path) -> Tokens {
    let mut t = Tokens::default();
    let Ok(rd) = std::fs::read_dir(dir) else { return t };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "jsonl") {
            t.add(&session_tokens(&p, false));
        }
    }
    t
}

type SubCache = Mutex<HashMap<PathBuf, (Tokens, bool)>>;
static SUBS: OnceLock<SubCache> = OnceLock::new();

/// Igual que `subagents_tokens`, pero sin bloquear: devuelve lo ya sumado (ceros la primera vez) y
/// refresca en un hilo aparte. Los subagentes de una sesión larga pueden ser miles de ficheros.
pub fn subagents_tokens_cached(dir: &Path) -> Tokens {
    let m = SUBS.get_or_init(Default::default);
    let mut g = m.lock();
    let e = g.entry(dir.to_path_buf()).or_insert((Tokens::default(), false));
    let out = e.0.clone();
    if !e.1 {
        e.1 = true;
        let d = dir.to_path_buf();
        std::thread::spawn(move || {
            let t = subagents_tokens(&d);
            if let Some(m) = SUBS.get() {
                if let Some(e) = m.lock().get_mut(&d) {
                    *e = (t, false);
                }
            }
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn linea(id: &str, out: u64, sidechain: bool) -> String {
        serde_json::json!({"type":"assistant","isSidechain":sidechain,"message":{"id":id,"usage":{
            "input_tokens":2,"output_tokens":out,"cache_read_input_tokens":1000,"cache_creation_input_tokens":50,
            "output_tokens_details":{"thinking_tokens":out/2}}}})
        .to_string()
    }

    /// `cargo test real_tokens -- --ignored --nocapture` (compara con la medición de Python: 919 pet., 229,6M lect., 4,6M creac.)
    #[test]
    #[ignore]
    fn real_tokens() {
        let home = std::env::var("USERPROFILE").unwrap();
        let root = Path::new(&home).join(".claude").join("projects");
        let f = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|d| d.path().join("a06f8c4a-9182-487f-aed9-5dd0c4b329e2.jsonl"))
            .find(|p| p.is_file())
            .expect("no está la sesión de referencia");
        let t0 = std::time::Instant::now();
        let t = session_tokens(&f, true);
        let primera = t0.elapsed();
        let t1 = std::time::Instant::now();
        let _ = session_tokens(&f, true);
        let segunda = t1.elapsed();
        let subs = subagents_tokens(&f.parent().unwrap().join("a06f8c4a-9182-487f-aed9-5dd0c4b329e2").join("subagents"));
        eprintln!("principal: {t:?}");
        eprintln!("  -> lectura {:.1}M creación {:.2}M salida {:.2}M razonamiento {:.0}%", t.cache_read as f64 / 1e6, t.cache_create as f64 / 1e6, t.output as f64 / 1e6, 100.0 * t.thinking as f64 / t.output.max(1) as f64);
        eprintln!("subagentes: {} peticiones, salida {:.2}M, lectura {:.1}M", subs.requests, subs.output as f64 / 1e6, subs.cache_read as f64 / 1e6);
        eprintln!("tiempo: primera lectura {primera:?}, siguiente {segunda:?}");
    }

    #[test]
    fn dedup_por_mensaje_e_incremental() {
        let p = std::env::temp_dir().join(format!("orch-tok-{}.jsonl", std::process::id()));
        let mut f = File::create(&p).unwrap();
        // El mismo mensaje en dos líneas (salida parcial y completa) + otro mensaje + uno de subagente.
        writeln!(f, "{}", linea("m1", 10, false)).unwrap();
        writeln!(f, "{}", linea("m1", 40, false)).unwrap();
        writeln!(f, "{}", linea("m2", 5, false)).unwrap();
        writeln!(f, "{}", linea("s1", 999, true)).unwrap();
        f.flush().unwrap();
        let t = session_tokens(&p, true);
        assert_eq!((t.requests, t.output, t.input, t.cache_read, t.cache_create), (2, 45, 4, 2000, 100));
        assert_eq!(t.thinking, 22); // 20 + 2

        // Se añade una línea COMPLETA y media línea: la media no cuenta hasta que se complete.
        let nueva = linea("m3", 7, false);
        let (a, b) = nueva.split_at(30);
        write!(f, "{}\n{}", nueva, a).unwrap();
        f.flush().unwrap();
        let t = session_tokens(&p, true);
        assert_eq!((t.requests, t.output), (3, 52));
        write!(f, "{}\n", b).unwrap(); // completa la línea cortada: es m3 otra vez, se deduplica
        f.flush().unwrap();
        let t = session_tokens(&p, true);
        assert_eq!((t.requests, t.output), (3, 52));
        // Para un fichero de subagente (todo es sidechain) se usa skip_sidechain = false.
        let q = std::env::temp_dir().join(format!("orch-sub-{}.jsonl", std::process::id()));
        std::fs::write(&q, format!("{}\n{}\n", linea("s1", 100, true), linea("s2", 50, true))).unwrap();
        assert_eq!(session_tokens(&q, false).output, 150);
        std::fs::remove_file(&p).ok();
        std::fs::remove_file(&q).ok();
    }
}
