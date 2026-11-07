//! Motor de consejos (C4). PURO: recibe los hechos de los ficheros del periodo (o de una sesión) y devuelve
//! consejos ordenados por ahorro estimado. Sin E/S, sin Tauri: se prueba con hechos construidos.
//!
//! Por qué en Rust y no en TS: la misma lista tiene que salir en la interfaz, en el informe Markdown y en la
//! herramienta MCP `usage_report` (que vive en el backend). Un solo motor, una sola cifra. Los textos van en
//! inglés y español aquí mismo (`Lang`), porque el informe y el MCP no pasan por el i18n de la interfaz.
//!
//! Unidades: `usd` a precio de API (para comparar entre modelos); `eq` = tokens de entrada equivalentes. El
//! denominador de TODOS los porcentajes es UNO: `Facts::total_usd()` (Σ del coste de los ficheros del periodo).
//! Todo ahorro es una ESTIMACIÓN y así se rotula.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{price, BreakCause, Cat, CatAgg, Event, EventKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Es,
}

impl Lang {
    pub fn parse(s: &str) -> Lang {
        if s.to_ascii_lowercase().starts_with("es") {
            Lang::Es
        } else {
            Lang::En
        }
    }
    pub fn pick<'a>(self, en: &'a str, es: &'a str) -> &'a str {
        match self {
            Lang::En => en,
            Lang::Es => es,
        }
    }
}

/// Un bloque grande (≥ 400 tokens) de un fichero, con su coste real.
#[derive(Debug, Clone, Default)]
pub struct FactBlock {
    pub cat: Cat,
    pub tool: Option<String>,
    pub detail: Option<String>,
    pub req: u32,
    pub chars: u64,
    pub t: u64,
    pub eq: f64,
    pub usd: f64,
    pub rereads: u32,
}

/// Hechos de un fichero (hilo principal o subagente).
#[derive(Debug, Clone, Default)]
pub struct FileFacts {
    /// Ruta del transcript (clave; en el informe nunca sale entera).
    pub session: String,
    pub project: String,
    /// None = hilo principal.
    pub agent: Option<String>,
    /// Modelo con más peticiones.
    pub model: String,
    pub requests: u64,
    pub base: u64,
    pub max_context: u64,
    #[allow(dead_code)]
    pub first_ts: u64,
    pub last_ts: u64,
    pub eq: f64,
    pub usd: f64,
    pub cats: Vec<CatAgg>,
    pub blocks: Vec<FactBlock>,
    pub output: u64,
    pub thinking: u64,
    /// Coste de GENERAR (sin escrituras ni relecturas posteriores) la salida visible y el thinking de las peticiones
    /// del periodo: (eq, usd). La partida «Salida»/«Razonamiento» = esto + lo que cuesta tenerlo en el contexto.
    pub gen_out: (f64, f64),
    pub gen_think: (f64, f64),
    /// Evento y su sobrecoste en USD.
    pub events: Vec<(Event, f64)>,
    /// Partes visibles de la base: (etiqueta, tokens ≈ caracteres/4).
    pub base_parts: Vec<(String, u64)>,
    /// Por petición: (contexto, eq, usd).
    pub reqs: Vec<(u64, f64, f64)>,
    pub user_turns: Vec<u32>,
    pub perms: Vec<(String, u64)>,
}

impl FileFacts {
    pub fn cat(&self, c: Cat) -> CatAgg {
        self.cats.iter().find(|x| x.cat == c).cloned().unwrap_or(CatAgg { cat: c, ..Default::default() })
    }
    /// Llamadas a herramientas (todas las categorías de herramienta, grandes y pequeñas).
    pub fn tool_calls(&self) -> u64 {
        self.cats.iter().filter(|c| matches!(c.cat, Cat::Read | Cat::Bash | Cat::Search | Cat::Mcp | Cat::OtherTool)).map(|c| c.count).sum()
    }
}

#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub files: Vec<FileFacts>,
    /// Bytes de todo el historial en disco (todas las fechas), si se midió.
    pub history_bytes: Option<u64>,
    /// Hechos de UNA sesión (los textos dicen «de la sesión»).
    pub session: bool,
}

impl Facts {
    /// EL denominador de todos los porcentajes.
    pub fn total_usd(&self) -> f64 {
        self.files.iter().map(|f| f.usd).sum()
    }
    pub fn total_eq(&self) -> f64 {
        self.files.iter().map(|f| f.eq).sum()
    }
}

/// Umbrales (todos ajustables; serde con valores por defecto para aceptar objetos parciales).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Umbrales {
    /// 1. Salida de Bash mayor que esto (tokens) sin filtrar.
    pub bash_tokens: u64,
    /// Lo que quedaría tras filtrar (tokens).
    pub bash_keep: u64,
    /// 2. Read mayor que esto (bytes ≈ caracteres).
    pub read_bytes: u64,
    /// Lo que costaría leer solo un rango (tokens).
    pub read_keep: u64,
    /// 2. Mismo fichero leído al menos estas veces en la sesión.
    pub reread_times: u64,
    /// 3. Imágenes en el hilo principal por sesión.
    pub images_main: u64,
    /// 4. Subagente reanudado con más de este contexto.
    pub resume_context: u64,
    /// 4. Fork (o subagente) cuya base heredada pasa de esto.
    pub fork_context: u64,
    /// Contexto de un subagente nuevo con el estado (tokens).
    pub fresh_context: u64,
    /// 5. Subagente mecánico: al menos estas llamadas a herramientas…
    pub mech_tool_calls: u64,
    /// …y menos de estos tokens de salida (sin thinking) por petición.
    pub mech_output_per_req: u64,
    /// 8. Sesión con contexto mayor que esto.
    pub long_context: u64,
    /// 8. O con más peticiones que esto.
    pub long_requests: u64,
    /// 9. Thinking / salida visible por encima de esto…
    pub thinking_ratio: f64,
    /// …con al menos estos tokens de thinking.
    pub thinking_min: u64,
    /// 6. Recordatorio/skill inyectado de más de esto (tokens).
    pub skill_tokens: u64,
    /// 10. Historial en disco (GB).
    pub disk_gb: f64,
    /// Casos por regla como mucho.
    pub per_rule: usize,
    /// C11 «después» de la base fija y de las skills: cada parte recortable o skill entera queda en un índice de
    /// esto (tokens).
    pub index_keep: u64,
    /// C11 «después» de salida y razonamiento (SUPUESTOS, no medidos; ver `rule_gen`): razonamiento que se quita con
    /// effort low (trabajo mecánico) / medium (el resto), y salida visible que se quita pidiendo respuestas ≤ 20 líneas.
    pub think_cut_low: f64,
    pub think_cut_medium: f64,
    pub out_cut: f64,
    /// C11 «después» de las cachés rotas por prefijo: fracción que se puede evitar (SUPUESTO: parte de los cambios de
    /// prefijo, p. ej. un MCP que se reconecta solo, no dependen de quien trabaja).
    pub prefix_avoidable: f64,
}

impl Default for Umbrales {
    fn default() -> Self {
        Umbrales {
            bash_tokens: 3000,
            bash_keep: 3000,
            read_bytes: 30_000,
            read_keep: 4000,
            reread_times: 3,
            images_main: 6,
            resume_context: 300_000,
            fork_context: 150_000,
            fresh_context: 40_000,
            mech_tool_calls: 25,
            mech_output_per_req: 150,
            long_context: 450_000,
            long_requests: 800,
            thinking_ratio: 3.0,
            thinking_min: 20_000,
            skill_tokens: 10_000,
            disk_gb: 10.0,
            per_rule: 3,
            index_keep: 2000,
            think_cut_low: 0.30,
            think_cut_medium: 0.15,
            out_cut: 0.20,
            prefix_avoidable: 0.5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Gravedad {
    Info,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Regla {
    BashOutput,
    BigRead,
    Reread,
    Images,
    Resume,
    Fork,
    MechModel,
    BaseFixed,
    SkillWhole,
    CacheExpired,
    CachePrefix,
    LongSession,
    /// Ya no se emite (C9: va dentro de `Output`, salida + razonamiento); se queda por los ids guardados.
    #[allow(dead_code)]
    Thinking,
    /// Respuestas largas (salida visible) en los agentes que más escriben.
    Output,
    Disk,
}

/// Prueba de un consejo: dónde mirar. `session` es la ruta del transcript (la interfaz la abre; el informe no la
/// muestra); `label` es una descripción ya abreviada por quien la pinta.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prueba {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub req: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub who: Option<String>,
    pub label: String,
    pub tokens: u64,
    pub rereads: u32,
    pub usd: f64,
    /// C10: etiqueta traducible en la interfaz (`consumo.adv.ev.<label_id>` con `lp`); `label` queda para el informe.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub label_id: Option<String>,
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty", default)]
    pub lp: std::collections::BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Consejo {
    /// Estable: regla + caso (se usa para «Ya lo sé»).
    pub id: String,
    pub rule: Regla,
    pub severity: Gravedad,
    pub title: String,
    pub why: String,
    pub action: String,
    pub evidence: Vec<Prueba>,
    /// Ahorro estimado.
    pub save_eq: f64,
    pub save_usd: f64,
    /// Sobre `Facts::total_usd()` (0..1).
    pub save_pct: f64,
    /// Tarjeta de la pantalla de la que sale el consejo: `cat:<categoría>` (reparto por categoría) o
    /// `event:<expired|prefixChanged>` (sucesos). None = sin tarjeta propia (se compara con el total).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub card: Option<String>,
    /// Cifras de esa tarjeta, calculadas de los MISMOS hechos del periodo/sesión: coste USD y eq, y nº de veces o
    /// bloques. El ahorro nunca pasa de `card_usd`.
    #[serde(default)]
    pub card_usd: f64,
    #[serde(default)]
    pub card_eq: f64,
    #[serde(default)]
    pub card_n: u64,
    /// Parámetros con nombre de las cifras que cita el texto (para comprobarlos y traducirlos en la interfaz).
    #[serde(default)]
    pub nums: std::collections::BTreeMap<String, f64>,
    /// Origen o partida que cita el consejo (C9): clave de `Origen::key` («read|<proyecto>|<ruta>», «bash|cargo
    /// test», «reminder|<skill>», «image|<sesión>»), «gen|<quién>|<modelo>» (salida y razonamiento), la tarjeta
    /// («cat:base», «event:expired») o «who|<tipo>». El ahorro nunca pasa de `origin_usd`/`origin_eq`, y la suma de
    /// los ahorros de los consejos con el mismo origen tampoco (el segundo descuenta lo del primero).
    #[serde(default)]
    pub origin: String,
    /// Lo que se enseña del origen (ruta completa, comando normalizado, skill, «obrero · Opus 5.5»…).
    #[serde(default)]
    pub origin_label: String,
    #[serde(default)]
    pub origin_usd: f64,
    #[serde(default)]
    pub origin_eq: f64,
    /// Veces y tokens del origen: = la fila de «Bloques más caros» cuando el origen es un bloque.
    #[serde(default)]
    pub origin_n: u64,
    #[serde(default)]
    pub origin_t: u64,
    /// Total del periodo/sesión (el «de Y» de «calculado sobre X de Y»).
    #[serde(default)]
    pub total_usd: f64,
    #[serde(default)]
    pub total_eq: f64,
    /// true = consejo de una sesión (los textos dicen «de la sesión», no «del periodo»).
    #[serde(default)]
    pub session: bool,
    /// C10: el texto por clave de i18n. La interfaz traduce `consumo.adv.<text_id>.<title|why|action>` (con
    /// `<Variante>` si `params` trae `titleV`/`whyV`/`actionV`) con `params`: nombres tal cual, `…Tok` tokens,
    /// `…Pct` fracción, `…Dec` un decimal, número = entero, «@x» = fragmento `consumo.adv.frag.x`. `title`, `why` y
    /// `action` siguen en el idioma pedido (informe y respaldo).
    #[serde(default)]
    pub text_id: String,
    #[serde(default)]
    pub params: std::collections::BTreeMap<String, Value>,
    /// C11: coste que QUEDARÍA del origen tras aplicar la acción (= origen − ahorro), con la suposición que lo modela:
    /// `consumo.adv.assume.<assume>` con `assume_p` (mismas convenciones que `params`).
    #[serde(default)]
    pub after_usd: f64,
    #[serde(default)]
    pub after_eq: f64,
    #[serde(default)]
    pub assume: String,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub assume_p: std::collections::BTreeMap<String, Value>,
    /// C11: de qué partes del coste sale el ahorro (para el «ahorro total si aplicas todo» sin doble conteo). No se
    /// manda a la interfaz: la cifra sale ya hecha en el informe (`total_saving`).
    #[serde(skip)]
    pub cells: Vec<Cell>,
}

/// C11: una parte del ahorro de un consejo: fichero (índice en `Facts::files`), partida (`Cat` en camelCase o «*» =
/// todas las del fichero) y cuánto. `frac` = la acción REDUCE esa partida en una fracción (se compone con otras:
/// modelo más barato, sesión más corta, caché…); si no, el ahorro es de bloques concretos de esa partida (bloques de
/// orígenes distintos no se solapan y se suman).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Cell {
    pub file: usize,
    pub part: String,
    pub usd: f64,
    pub eq: f64,
    pub frac: bool,
}

/// C11: ahorro total si se aplican TODOS los consejos, sin contar dos veces el mismo coste: en cada fichero y partida,
/// los ahorros de bloques se suman (son bloques distintos) y las reducciones en fracción se componen
/// (1 − Π(1 − fᵢ)) sobre lo que queda. Siempre ≤ Σ ahorros y ≤ total. Devuelve (usd, eq).
pub fn total_saving(facts: &Facts, advice: &[Consejo]) -> (f64, f64) {
    let cat_name = |c: Cat| serde_json::to_value(c).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    let mut out = (0.0, 0.0);
    for (fi, f) in facts.files.iter().enumerate() {
        let cells: Vec<&Cell> = advice.iter().flat_map(|a| a.cells.iter()).filter(|c| c.file == fi).collect();
        if cells.is_empty() {
            continue;
        }
        for k in &f.cats {
            let name = cat_name(k.cat);
            for (unit, cost) in [(0usize, k.usd), (1, k.eq)] {
                if cost <= 0.0 {
                    continue;
                }
                let v = |c: &Cell| if unit == 0 { c.usd } else { c.eq };
                let base_cost = |c: &Cell| if unit == 0 { if c.part == "*" { f.usd } else { k.usd } } else if c.part == "*" { f.eq } else { k.eq };
                let blocks: f64 = cells.iter().filter(|c| !c.frac && c.part == name).map(|c| v(c)).sum();
                let mut keep = 1.0 - (blocks / cost).clamp(0.0, 1.0);
                for c in cells.iter().filter(|c| c.frac && (c.part == "*" || c.part == name)) {
                    let bc = base_cost(c);
                    if bc > 0.0 {
                        keep *= 1.0 - (v(c) / bc).clamp(0.0, 1.0);
                    }
                }
                let saved = cost * (1.0 - keep);
                if unit == 0 {
                    out.0 += saved;
                } else {
                    out.1 += saved;
                }
            }
        }
    }
    out
}

/// Un origen de bloques: LA agregación que usan los consejos, «Bloques más caros» (pantalla) y el informe.
/// Read se agrupa por proyecto + ruta COMPLETA (dos `store.svelte.ts` de proyectos distintos son dos orígenes);
/// Bash por comando normalizado (`command_key`); skills/recordatorios por nombre; imágenes por sesión; el resto por
/// herramienta. Cuenta TODOS los bloques grandes (≥ 400 tokens) del periodo, no solo los del top.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Origen {
    pub key: String,
    pub cat: Cat,
    /// Ruta completa (Read, sin anonimizar: la anonimiza quien la pinta), comando normalizado, skill o herramienta.
    pub label: String,
    /// Carpeta del proyecto (Read; vacío en el resto).
    #[serde(default)]
    pub project: String,
    pub n: u64,
    pub t: u64,
    pub eq: f64,
    pub usd: f64,
}

/// Clave y etiqueta del origen de un bloque (ver `Origen`).
pub fn origin_of(f: &FileFacts, b: &FactBlock) -> (String, String) {
    let what = b.detail.clone().or_else(|| b.tool.clone()).unwrap_or_default();
    match b.cat {
        Cat::Read => (format!("read|{}|{what}", f.project), what),
        Cat::Bash => {
            let k = command_key(&what);
            let k = if k.is_empty() { what } else { k };
            (format!("bash|{k}"), k)
        }
        Cat::Image => (format!("image|{}", f.session), "image".into()),
        _ => {
            let name = b.tool.clone().unwrap_or_else(|| what.clone());
            let cat = serde_json::to_value(b.cat).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
            (format!("{cat}|{name}"), name)
        }
    }
}

/// Todos los orígenes del conjunto, ordenados por coste (USD) de mayor a menor.
pub fn origins(facts: &Facts) -> Vec<Origen> {
    let mut m: HashMap<String, Origen> = HashMap::new();
    for f in &facts.files {
        for b in &f.blocks {
            let (key, label) = origin_of(f, b);
            let o = m.entry(key.clone()).or_insert_with(|| Origen {
                key,
                cat: b.cat,
                label,
                project: if b.cat == Cat::Read { f.project.clone() } else { String::new() },
                ..Default::default()
            });
            o.n += 1;
            o.t += b.t;
            o.eq += b.eq;
            o.usd += b.usd;
        }
    }
    let mut v: Vec<Origen> = m.into_values().collect();
    v.sort_by(|a, b| b.usd.total_cmp(&a.usd).then(a.key.cmp(&b.key)));
    v
}

/// Añade a la lista de la pantalla los orígenes que cita algún consejo y no estaban (cada consejo enlaza a su fila).
pub fn cover_origins(shown: &mut Vec<Origen>, facts: &Facts, advice: &[Consejo]) {
    let block_origin = |k: &str| ["read|", "bash|", "image|", "reminder|"].iter().any(|p| k.starts_with(p));
    let missing: HashSet<&str> = advice.iter().map(|a| a.origin.as_str()).filter(|k| block_origin(k) && !shown.iter().any(|o| o.key == *k)).collect();
    if missing.is_empty() {
        return;
    }
    shown.extend(origins(facts).into_iter().filter(|o| missing.contains(o.key.as_str())));
    shown.sort_by(|a, b| b.usd.total_cmp(&a.usd).then(a.key.cmp(&b.key)));
}

/// Los orígenes que se mandan a la pantalla: los `n` más caros en USD y en eq (la vista ordena por su unidad).
pub fn top_origins(facts: &Facts, n: usize) -> Vec<Origen> {
    let all = origins(facts);
    let mut by_eq: Vec<&Origen> = all.iter().collect();
    by_eq.sort_by(|a, b| b.eq.total_cmp(&a.eq));
    let keep: HashSet<&str> = all.iter().take(n).chain(by_eq.into_iter().take(n)).map(|o| o.key.as_str()).collect();
    all.iter().filter(|o| keep.contains(o.key.as_str())).cloned().collect()
}

/// Cifra de una tarjeta calculada de los hechos: (usd, eq, n). `cat:<camelCase>` o `event:<tipo>`.
pub fn card_value(facts: &Facts, card: &str) -> (f64, f64, u64) {
    let (mut usd, mut eq, mut n) = (0.0, 0.0, 0u64);
    if let Some(list) = card.strip_prefix("cat:") {
        let want: Vec<&str> = list.split(',').collect();
        for f in &facts.files {
            for c in f.cats.iter().filter(|c| serde_json::to_value(c.cat).ok().and_then(|v| v.as_str().map(String::from)).is_some_and(|k| want.contains(&k.as_str()))) {
                usd += c.usd;
                eq += c.eq;
                n += c.count;
            }
        }
    } else if let Some(kind) = card.strip_prefix("event:") {
        for f in &facts.files {
            for (e, u) in &f.events {
                if event_kind(e) == kind {
                    usd += u;
                    eq += e.cost;
                    n += 1;
                }
            }
        }
    }
    (usd, eq, n)
}

/// Tipo de suceso con la misma clave que `ScanReport::event_cost`.
pub fn event_kind(e: &Event) -> &'static str {
    match (e.kind, &e.cause) {
        (EventKind::Compaction, _) => "compaction",
        (EventKind::ColdStart, _) => "coldStart",
        (EventKind::CacheBroken, Some(BreakCause::Expired)) => "expired",
        (EventKind::CacheBroken, Some(BreakCause::ModelChanged)) => "modelChanged",
        (EventKind::CacheBroken, _) => "prefixChanged",
    }
}

/// Tarjeta de cada regla.
fn card_of(rule: Regla) -> Option<&'static str> {
    Some(match rule {
        Regla::BashOutput => "cat:bash",
        Regla::BigRead | Regla::Reread => "cat:read",
        Regla::Images => "cat:image",
        Regla::BaseFixed | Regla::Fork => "cat:base",
        Regla::SkillWhole => "cat:reminder",
        Regla::CacheExpired => "event:expired",
        Regla::CachePrefix => "event:prefixChanged",
        Regla::Thinking | Regla::Output => "cat:output,thinking",
        _ => return None,
    })
}

// ───────────────────────────── utilidades ─────────────────────────────

fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:08x}", h as u32)
}

pub fn fmt_tok(n: f64) -> String {
    let n = n.max(0.0);
    if n >= 1e9 {
        format!("{:.1}G", n / 1e9)
    } else if n >= 1e6 {
        format!("{:.1}M", n / 1e6)
    } else if n >= 1e3 {
        format!("{:.0}k", n / 1e3)
    } else {
        format!("{n:.0}")
    }
}

/// Coma decimal en los textos en español («18.0 %» → «18,0 %», «2.3M» → «2,3M»): solo un punto entre dos cifras.
fn es_decimals(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    (0..c.len()).map(|i| if c[i] == '.' && i > 0 && i + 1 < c.len() && c[i - 1].is_ascii_digit() && c[i + 1].is_ascii_digit() { ',' } else { c[i] }).collect()
}

/// Porcentaje a un decimal (como en la pantalla).
pub fn fmt_pct(p: f64) -> String {
    format!("{:.1} %", p * 100.0)
}

/// Partes de un total redondeadas a décimas de punto que suman exactamente 100,0 (método del mayor resto).
/// Devuelve fracciones (0..1). Total cero → todo cero.
pub fn round_shares(xs: &[f64]) -> Vec<f64> {
    let total: f64 = xs.iter().map(|x| x.max(0.0)).sum();
    if total <= 0.0 {
        return vec![0.0; xs.len()];
    }
    let raw: Vec<f64> = xs.iter().map(|x| x.max(0.0) / total * 1000.0).collect();
    let mut units: Vec<i64> = raw.iter().map(|r| r.floor() as i64).collect();
    let mut left = 1000 - units.iter().sum::<i64>();
    let mut order: Vec<usize> = (0..xs.len()).collect();
    order.sort_by(|&a, &b| (raw[b] - raw[b].floor()).total_cmp(&(raw[a] - raw[a].floor())).then(a.cmp(&b)));
    for &i in order.iter().cycle().take(xs.len() * 2) {
        if left <= 0 {
            break;
        }
        units[i] += 1;
        left -= 1;
    }
    units.into_iter().map(|u| u as f64 / 1000.0).collect()
}

fn who_label(f: &FileFacts) -> String {
    f.agent.clone().unwrap_or_else(|| "main".into())
}

/// Quién, para un texto: el tipo de agente o «hilo principal» (nunca «main» en un texto).
pub fn who_text(lang: Lang, who: &str) -> String {
    if who == "main" { lang.pick("main thread", "hilo principal").into() } else { who.into() }
}

/// Plural sencillo: «1 fichero» / «3 ficheros».
pub fn pl(lang: Lang, n: u64, en: (&str, &str), es: (&str, &str)) -> String {
    let (one, other) = if lang == Lang::Es { es } else { en };
    format!("{n} {}", if n == 1 { one } else { other })
}

/// ¿El comando ya filtra su salida?
fn filtered(cmd: &str) -> bool {
    let c = cmd.to_ascii_lowercase();
    ["| grep", "|grep", "| tail", "|tail", "| head", "|head", "| wc", "| rg", "| select-object", "| select-string", "| findstr", "-first ", "-last ", "--quiet", " -q "]
        .iter()
        .any(|p| c.contains(p))
}

/// Clave de agrupación de un comando: quita `cd x &&`, variables `A=b` delante, rutas (se queda el nombre)
/// y se queda con las dos primeras palabras («cargo test», «npm run», «runbench.sh»).
pub fn command_key(cmd: &str) -> String {
    let mut s = cmd.trim();
    loop {
        let lower = s.to_ascii_lowercase();
        if lower.starts_with("cd ") {
            match s.find("&&").map(|i| (i, 2)).or_else(|| s.find(';').map(|i| (i, 1))) {
                Some((i, n)) => s = s[i + n..].trim(),
                None => break,
            }
        } else {
            break;
        }
    }
    let mut words = s.split_whitespace().skip_while(|w| w.contains('=') && !w.starts_with('-') && !w.contains('/'));
    let base = |w: &str| w.trim_matches(['"', '\'']).rsplit(['/', '\\']).next().unwrap_or(w).to_string();
    let Some(w1) = words.next() else { return String::new() };
    let mut key = base(w1);
    if let Some(w2) = words.next() {
        let w2c = w2.trim_matches(['"', '\'']);
        if !w2c.starts_with('-') && !w2c.contains(['/', '\\', '.', '|', '>', '<', '$']) && w2c.len() <= 24 {
            key.push(' ');
            key.push_str(w2c);
        }
    }
    key
}

fn severity_of(pct: f64) -> Gravedad {
    if pct >= 0.05 {
        Gravedad::High
    } else if pct >= 0.01 {
        Gravedad::Medium
    } else {
        Gravedad::Low
    }
}

struct Ctx<'a> {
    facts: &'a Facts,
    total_usd: f64,
    eq_per_usd: f64,
    lang: Lang,
    u: &'a Umbrales,
    out: Vec<Consejo>,
}

impl Ctx<'_> {
    #[allow(clippy::too_many_arguments)]
    fn push(&mut self, rule: Regla, case: &str, save_usd: f64, save_eq: Option<f64>, title: String, why: String, action: String, evidence: Vec<Prueba>) {
        let card = card_of(rule);
        let (card_usd, card_eq, card_n) = card.map(|k| card_value(self.facts, k)).unwrap_or((self.total_usd, self.total_usd * self.eq_per_usd, 0));
        // El ahorro nunca pasa del coste de su partida.
        let ratio = if save_usd > card_usd && save_usd > 0.0 { card_usd / save_usd } else { 1.0 };
        let save_usd = save_usd * ratio;
        let save_eq = save_eq.map(|e| e * ratio);
        let pct = if self.total_usd > 0.0 { save_usd / self.total_usd } else { 0.0 };
        let (title, why) = if self.lang == Lang::Es { (es_decimals(&title), es_decimals(&why)) } else { (title, why) };
        let sev = if rule == Regla::Disk { Gravedad::Info } else { severity_of(pct) };
        self.out.push(Consejo {
            id: format!("{}:{}", serde_json::to_value(rule).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default(), fnv(case)),
            rule,
            severity: sev,
            title,
            why,
            action,
            evidence,
            save_eq: save_eq.unwrap_or(save_usd * self.eq_per_usd),
            save_usd,
            save_pct: pct,
            card: card.map(String::from),
            card_usd,
            card_eq,
            card_n,
            nums: Default::default(),
            origin: card.map(String::from).unwrap_or_default(),
            origin_label: card.map(String::from).unwrap_or_default(),
            origin_usd: card_usd,
            origin_eq: card_eq,
            origin_n: card_n,
            origin_t: 0,
            total_usd: self.total_usd,
            total_eq: self.total_usd * self.eq_per_usd,
            session: self.facts.session,
            text_id: String::new(),
            params: Default::default(),
            after_usd: 0.0,
            after_eq: 0.0,
            assume: String::new(),
            assume_p: Default::default(),
            cells: Vec::new(),
        });
    }
    /// Pone el origen del último consejo y recorta su ahorro a lo que cuesta ese origen.
    fn at(&mut self, key: &str, label: &str, usd: f64, eq: f64, n: u64, t: u64) {
        if let Some(c) = self.out.last_mut() {
            c.origin = key.into();
            c.origin_label = label.into();
            c.origin_usd = usd;
            c.origin_eq = eq;
            c.origin_n = n;
            c.origin_t = t;
            cap(c, usd, eq);
            c.save_pct = if self.total_usd > 0.0 { c.save_usd / self.total_usd } else { 0.0 };
        }
    }
    /// «en el periodo» / «en la sesión».
    fn scope_in(&self) -> &'static str {
        match (self.lang, self.facts.session) {
            (Lang::En, false) => "in the period",
            (Lang::En, true) => "in the session",
            (Lang::Es, false) => "en el periodo",
            (Lang::Es, true) => "en la sesión",
        }
    }
    /// Texto según el ámbito: «del periodo» o «de la sesión».
    fn scope(&self) -> &'static str {
        match (self.lang, self.facts.session) {
            (Lang::En, false) => "of the period",
            (Lang::En, true) => "of the session",
            (Lang::Es, false) => "del periodo",
            (Lang::Es, true) => "de la sesión",
        }
    }
    /// Clave de i18n y parámetros del texto del último consejo (la interfaz lo traduce).
    fn tx(&mut self, id: &str, p: Value) {
        if let Some(c) = self.out.last_mut() {
            c.text_id = id.into();
            if let Value::Object(m) = p {
                c.params = m.into_iter().collect();
            }
        }
    }
    /// «@inPeriod» / «@ofSession»…: fragmento del ámbito para `params`.
    fn scope_frag(&self, of: bool) -> String {
        format!("@{}{}", if of { "of" } else { "in" }, if self.facts.session { "Session" } else { "Period" })
    }
    /// Apunta una cifra citada en el texto del último consejo.
    fn num(&mut self, k: &str, v: f64) {
        if let Some(c) = self.out.last_mut() {
            c.nums.insert(k.into(), v);
        }
    }
    fn l<'a>(&self, en: &'a str, es: &'a str) -> &'a str {
        self.lang.pick(en, es)
    }
    /// C11: suposición que modela el «después» del último consejo.
    fn assume(&mut self, id: &str, p: Value) {
        if let Some(c) = self.out.last_mut() {
            c.assume = id.into();
            if let Value::Object(m) = p {
                c.assume_p = m.into_iter().collect();
            }
        }
    }
    /// C11: partes del ahorro del último consejo (ver `Cell`).
    fn cells(&mut self, cells: Vec<Cell>) {
        if let Some(c) = self.out.last_mut() {
            c.cells = cells;
        }
    }
}

/// C11: el ahorro de un fichero entero repartido como fracción de todas sus partidas.
fn whole(fi: usize, usd: f64, eq: f64) -> Vec<Cell> {
    vec![Cell { file: fi, part: "*".into(), usd, eq, frac: true }]
}

fn cell(fi: usize, cat: Cat, usd: f64, eq: f64, frac: bool) -> Cell {
    let part = serde_json::to_value(cat).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    Cell { file: fi, part, usd, eq, frac }
}

/// C11: modelo más barato para el trabajo mecánico (el de la misma generación un escalón por debajo).
pub fn cheaper_model(model: &str) -> &'static str {
    let m = model.to_ascii_lowercase();
    if m.contains("opus-5") || m.contains("fable") || m.contains("mythos") {
        "claude-sonnet-5-5"
    } else {
        "claude-sonnet"
    }
}

/// C11: reglas cuyo ahorro puede pasar del 90 % de su origen porque quitarlo casi todo es real:
/// - Bash: una salida de 100 k recortada a 3 k deja el 3 %; lo que se quita es log que nadie lee.
/// - Read: una relectura en la misma sesión se quita entera (el contenido ya está en el contexto).
/// - Reanudar/fork: un agente nuevo con un brief de ~40 k no arrastra los cientos de k del viejo.
/// - Imágenes: con 4 por sesión, 40 imágenes dejan el 10 %.
/// - Cachés caducadas: el origen es SOLO el sobrecoste de reescribir en frío y el «después» es la alternativa
///   modelada (leer en caliente + reescribir el resumen, con la fracción medida en las compactaciones, C8); con
///   resúmenes pequeños, la alternativa cuesta menos del 10 % del sobrecoste.
pub fn may_exceed_90(rule: Regla) -> bool {
    matches!(rule, Regla::BashOutput | Regla::BigRead | Regla::Reread | Regla::Resume | Regla::Fork | Regla::Images | Regla::CacheExpired)
}

/// Recorta el ahorro (usd y eq, en la misma proporción) a un tope.
fn cap(c: &mut Consejo, usd: f64, eq: f64) {
    let ru = if c.save_usd > usd.max(0.0) && c.save_usd > 0.0 { usd.max(0.0) / c.save_usd } else { 1.0 };
    let re = if c.save_eq > eq.max(0.0) && c.save_eq > 0.0 { eq.max(0.0) / c.save_eq } else { 1.0 };
    let r = ru.min(re);
    c.save_usd *= r;
    c.save_eq *= r;
}

fn ev(f: &FileFacts, req: Option<u32>, label: String, tokens: u64, rereads: u32, usd: f64) -> Prueba {
    Prueba { session: Some(f.session.clone()), req, who: Some(who_label(f)), label, tokens, rereads, usd, ..Default::default() }
}

// ───────────────────────────── reglas ─────────────────────────────

/// Consejos del periodo/sesión, sin los descartados, ordenados por ahorro (USD) de mayor a menor.
pub fn advise(facts: &Facts, u: &Umbrales, lang: Lang, dismissed: &HashSet<String>) -> Vec<Consejo> {
    let total_usd = facts.total_usd();
    let eq_per_usd = if total_usd > 0.0 { facts.total_eq() / total_usd } else { 0.0 };
    let mut c = Ctx { facts, total_usd, eq_per_usd, lang, u, out: Vec::new() };
    rule_bash(facts, &mut c);
    rule_reads(facts, &mut c);
    rule_images(facts, &mut c);
    rule_resume_fork(facts, &mut c);
    rule_mech(facts, &mut c);
    rule_base(facts, &mut c);
    rule_skills(facts, &mut c);
    rule_cache(facts, &mut c);
    rule_long(facts, &mut c);
    rule_gen(facts, &mut c);
    rule_disk(facts, &mut c);
    let mut out = c.out;
    out.sort_by(|a, b| b.save_usd.total_cmp(&a.save_usd).then(a.id.cmp(&b.id)));
    // Sin dobles cuentas: los consejos que citan el mismo origen o la misma tarjeta no suman más que ese origen o
    // esa tarjeta, y todos juntos no pasan del total. Por orden de ahorro: el segundo descuenta lo del primero.
    let total_eq = facts.total_eq();
    let mut used: HashMap<String, (f64, f64)> = HashMap::new();
    let mut used_t = (0.0, 0.0);
    for x in out.iter_mut() {
        let (ou, oe) = used.get(&format!("o:{}", x.origin)).copied().unwrap_or_default();
        let card = x.card.clone().unwrap_or_default();
        let (cu, ce) = used.get(&format!("c:{card}")).copied().unwrap_or_default();
        let mut lim_u = (total_usd - used_t.0).min(x.origin_usd - ou);
        let mut lim_e = (total_eq - used_t.1).min(x.origin_eq - oe);
        if !card.is_empty() {
            lim_u = lim_u.min(x.card_usd - cu);
            lim_e = lim_e.min(x.card_eq - ce);
        }
        cap(x, lim_u, lim_e);
        x.save_pct = if total_usd > 0.0 { x.save_usd / total_usd } else { 0.0 };
        if x.rule != Regla::Disk {
            x.severity = severity_of(x.save_pct);
        }
        for k in [format!("o:{}", x.origin), format!("c:{card}")] {
            let e = used.entry(k).or_default();
            e.0 += x.save_usd;
            e.1 += x.save_eq;
        }
        used_t.0 += x.save_usd;
        used_t.1 += x.save_eq;
    }
    for x in out.iter_mut() {
        // C11: lo que queda del origen tras aplicarlo, y las partes del ahorro escaladas a lo que quedó tras los topes.
        x.after_usd = (x.origin_usd - x.save_usd).max(0.0);
        x.after_eq = (x.origin_eq - x.save_eq).max(0.0);
        let (cu, ce) = x.cells.iter().fold((0.0, 0.0), |a, c| (a.0 + c.usd, a.1 + c.eq));
        for c in x.cells.iter_mut() {
            c.usd = if cu > 0.0 { c.usd * x.save_usd / cu } else { 0.0 };
            c.eq = if ce > 0.0 { c.eq * x.save_eq / ce } else { 0.0 };
        }
    }
    let mut out: Vec<Consejo> = out.into_iter().filter(|x| !dismissed.contains(&x.id) && (x.save_usd > 1e-9 || x.rule == Regla::Disk)).collect();
    out.sort_by(|a, b| b.save_usd.total_cmp(&a.save_usd).then(a.id.cmp(&b.id)));
    out
}

/// Orígenes de una categoría, por clave.
fn origins_of(facts: &Facts, cat: Cat) -> HashMap<String, Origen> {
    origins(facts).into_iter().filter(|o| o.cat == cat).map(|o| (o.key.clone(), o)).collect()
}

/// 1. Salidas de Bash grandes sin filtrar, por ORIGEN (comando normalizado, = fila de «Bloques más caros»).
fn rule_bash(facts: &Facts, c: &mut Ctx) {
    let u = c.u;
    let all = origins_of(facts, Cat::Bash);
    // origen → (ahorro usd, ahorro eq, nº, tokens, ejemplos, partes)
    // «Después» (C11): cada salida de más de `bash_tokens` recortada a `bash_keep` tokens: su coste × min(t, N)/t.
    let mut groups: HashMap<String, (f64, f64, u64, u64, Vec<Prueba>, Vec<Cell>)> = HashMap::new();
    for (fi, f) in facts.files.iter().enumerate() {
        for b in f.blocks.iter().filter(|b| b.cat == Cat::Bash && b.t > u.bash_tokens) {
            let cmd = b.detail.clone().unwrap_or_default();
            if filtered(&cmd) {
                continue;
            }
            let keep = 1.0 - (u.bash_keep as f64 / b.t as f64).min(1.0);
            let g = groups.entry(origin_of(f, b).0).or_default();
            g.0 += b.usd * keep;
            g.1 += b.eq * keep;
            g.2 += 1;
            g.3 += b.t;
            g.4.push(ev(f, Some(b.req), cmd, b.t, b.rereads, b.usd));
            g.5.push(cell(fi, Cat::Bash, b.usd * keep, b.eq * keep, false));
        }
    }
    let mut v: Vec<_> = groups.into_iter().filter(|(k, _)| all.contains_key(k) && k != "bash|").collect();
    v.sort_by(|a, b| b.1 .0.total_cmp(&a.1 .0).then(a.0.cmp(&b.0)));
    for (okey, (usd, eq, n, t, mut exs, cells)) in v.into_iter().take(u.per_rule) {
        let o = &all[&okey];
        let key = o.label.clone();
        exs.sort_by(|a, b| b.usd.total_cmp(&a.usd));
        exs.truncate(3);
        // cat/sed/head/Get-Content: es leer ficheros por Bash, no un log.
        let reads = matches!(key.split(' ').next().unwrap_or(""), "cat" | "sed" | "head" | "type" | "less" | "more" | "Get-Content" | "gc" | "awk" | "nl");
        let lim = fmt_tok(u.bash_tokens as f64);
        let (rn, rt) = (o.n, fmt_tok(o.t as f64));
        let title = match (c.lang, reads) {
            (Lang::En, false) => format!("Filter the output of «{key}»: {n} of its {rn} outputs ({rt} tokens) are over {lim} tokens"),
            (Lang::Es, false) => format!("Filtra la salida de «{key}»: {n} de sus {rn} salidas ({rt} tokens) pasan de {lim} tokens"),
            (Lang::En, true) => format!("Read less with «{key}»: {n} of its {rn} dumps ({rt} tokens) are over {lim} tokens"),
            (Lang::Es, true) => format!("Lee menos con «{key}»: {n} de sus {rn} volcados ({rt} tokens) pasan de {lim} tokens"),
        };
        let why = match c.lang {
            Lang::En => format!("Those {n} outputs put {} tokens into the context unfiltered and were re-read in every later request. Cutting each one to ~{} tokens saves the rest.", fmt_tok(t as f64), u.bash_keep),
            Lang::Es => format!("Esas {n} salidas metieron {} tokens al contexto sin filtrar y se releyeron en cada petición posterior. Recortar cada una a ~{} tokens ahorra el resto.", fmt_tok(t as f64), u.bash_keep),
        };
        let action = if reads {
            c.l(
                "Find the place first with grep -n and print short ranges (sed -n 'a,bp' of tens of lines, not hundreds); do not cat whole files.",
                "Busca antes el sitio con grep -n e imprime rangos cortos (sed -n 'a,bp' de decenas de líneas, no cientos); no hagas cat de ficheros enteros.",
            )
        } else {
            c.l(
                "Pipe it through grep/tail/head (or Select-Object -Last N), or write the log to a file and search it.",
                "Pásala por grep/tail/head (o Select-Object -Last N), o escribe el log a un fichero y busca en él.",
            )
        };
        c.push(Regla::BashOutput, &key, usd, Some(eq), title, why, action.into(), exs);
        c.at(&o.key, &o.label, o.usd, o.eq, o.n, o.t);
        c.num("rowN", o.n as f64);
        c.num("rowT", o.t as f64);
        c.num("big", n as f64);
        let v = if reads { "read" } else { "filter" };
        c.tx("bash", json!({ "titleV": v, "actionV": v, "key": key, "n": n, "nPl": n, "rn": rn, "rnPl": rn, "rtTok": o.t, "limTok": u.bash_tokens, "tTok": t, "keepTok": u.bash_keep }));
        c.assume("bash", json!({ "keepTok": u.bash_keep }));
        c.cells(cells);
    }
}

/// 2. Read por ORIGEN (proyecto + ruta completa, = fila de «Bloques más caros»). Un solo consejo por fichero que
/// junta «leído entero» y «leído varias veces en una sesión» sin contar dos veces un bloque: una relectura en la
/// misma sesión ahorra el bloque entero; la lectura que se queda, si es grande, ahorra lo que pasa de un rango.
fn rule_reads(facts: &Facts, c: &mut Ctx) {
    let u = c.u;
    let all = origins_of(facts, Cat::Read);
    // origen → (ahorro usd, ahorro eq, enteras grandes, repetidas, ejemplos, partes)
    // «Después» (C11): en cada sesión, una sola lectura (la PRIMERA, la más cara: es la que se relee más veces) y, si
    // el fichero pasa de `read_bytes`, por rango de ~`read_keep` tokens; las repetidas (≥ `reread_times` en la
    // sesión) se quitan enteras; el resto se queda como está.
    let mut g: HashMap<String, (f64, f64, u64, u64, Vec<Prueba>, Vec<Cell>)> = HashMap::new();
    for (fi, f) in facts.files.iter().enumerate() {
        let mut per: HashMap<String, Vec<&FactBlock>> = HashMap::new();
        for b in f.blocks.iter().filter(|b| b.cat == Cat::Read && b.detail.is_some()) {
            per.entry(origin_of(f, b).0).or_default().push(b);
        }
        for (key, bs) in per {
            let again = bs.len() as u64 >= u.reread_times;
            let keep_i = bs.iter().enumerate().max_by(|a, b| a.1.usd.total_cmp(&b.1.usd)).map(|x| x.0).unwrap_or(0);
            let e = g.entry(key).or_default();
            for (i, b) in bs.iter().enumerate() {
                let big = b.chars > u.read_bytes;
                if big {
                    e.2 += 1;
                }
                let (su, se) = if again && i != keep_i {
                    e.3 += 1;
                    (b.usd, b.eq)
                } else if big {
                    let keep = 1.0 - (u.read_keep as f64 / b.t as f64).min(1.0);
                    (b.usd * keep, b.eq * keep)
                } else {
                    (0.0, 0.0)
                };
                if su > 0.0 {
                    e.0 += su;
                    e.1 += se;
                    e.4.push(ev(f, Some(b.req), b.detail.clone().unwrap_or_default(), b.t, b.rereads, b.usd));
                    e.5.push(cell(fi, Cat::Read, su, se, false));
                }
            }
        }
    }
    let mut v: Vec<_> = g.into_iter().filter(|x| x.1 .0 > 0.0 && all.contains_key(&x.0)).collect();
    v.sort_by(|a, b| b.1 .0.total_cmp(&a.1 .0).then(a.0.cmp(&b.0)));
    for (key, (usd, eq, whole, again, mut exs, cells)) in v.into_iter().take(u.per_rule) {
        let o = &all[&key];
        exs.sort_by(|a, b| b.usd.total_cmp(&a.usd));
        exs.truncate(3);
        let name = o.label.rsplit(['/', '\\']).next().unwrap_or(&o.label).to_string();
        let kb = u.read_bytes / 1000;
        let (rn, rt) = (o.n, fmt_tok(o.t as f64));
        let parts = match c.lang {
            Lang::En => [(whole, format!("{whole} whole (over {kb} KB)")), (again, format!("{again} repeated in the same session"))],
            Lang::Es => [(whole, format!("{whole} enteras (de más de {kb} KB)")), (again, format!("{again} repetidas en la misma sesión"))],
        };
        let parts: Vec<String> = parts.into_iter().filter(|p| p.0 > 0).map(|p| p.1).collect();
        let title = match c.lang {
            Lang::En => format!("Read «{name}» in ranges and once: {rn} reads ({rt} tokens), {}", parts.join(" and ")),
            Lang::Es => format!("Lee «{name}» por rangos y una vez: {rn} lecturas ({rt} tokens), {}", parts.join(" y ")),
        };
        let why = c.l(
            "Each read adds another copy to the context and stays there, re-read on every request. The saving counts each read once: a repeated read saves all of it; the read you keep saves what goes beyond a range.",
            "Cada lectura añade otra copia al contexto y se queda ahí, releída en cada petición. El ahorro cuenta cada lectura una vez: una repetida ahorra entera; la que se queda ahorra lo que pasa de un rango.",
        );
        let action = c.l(
            "Use grep -n to find the place and Read with offset/limit (a few hundred lines); read it once per session and note what you need.",
            "Usa grep -n para encontrar el sitio y Read con offset/limit (unos cientos de líneas); léelo una vez por sesión y apunta lo que necesitas.",
        );
        let rule = if whole > 0 { Regla::BigRead } else { Regla::Reread };
        c.push(rule, &key, usd, Some(eq), title, why.into(), action.into(), exs);
        c.at(&o.key, &o.label, o.usd, o.eq, o.n, o.t);
        c.num("rowN", o.n as f64);
        c.num("rowT", o.t as f64);
        c.num("whole", whole as f64);
        c.num("again", again as f64);
        let v = match (whole > 0, again > 0) { (true, true) => "both", (true, false) => "whole", _ => "again" };
        c.tx("read", json!({ "titleV": v, "name": name, "rn": rn, "rnPl": rn, "rtTok": o.t, "whole": whole, "wholePl": whole, "again": again, "againPl": again, "kb": kb }));
        c.assume("read", json!({ "keepTok": u.read_keep }));
        c.cells(cells);
    }
}

/// 3. Muchas imágenes en el hilo principal.
fn rule_images(facts: &Facts, c: &mut Ctx) {
    let u = c.u;
    let images = origins_of(facts, Cat::Image);
    let mut v: Vec<(f64, f64, &FileFacts, u64, Vec<Prueba>, usize)> = Vec::new();
    for (fi, f) in facts.files.iter().enumerate().filter(|f| f.1.agent.is_none()) {
        let imgs: Vec<&FactBlock> = f.blocks.iter().filter(|b| b.cat == Cat::Image).collect();
        let n = imgs.len() as u64;
        if n <= u.images_main {
            continue;
        }
        let frac = (n - u.images_main.min(4)) as f64 / n as f64;
        let usd = imgs.iter().map(|b| b.usd).sum::<f64>() * frac;
        let eq = imgs.iter().map(|b| b.eq).sum::<f64>() * frac;
        let mut exs: Vec<Prueba> = imgs.iter().map(|b| ev(f, Some(b.req), b.tool.clone().unwrap_or_else(|| "image".into()), b.t, b.rereads, b.usd)).collect();
        exs.sort_by(|a, b| b.usd.total_cmp(&a.usd));
        exs.truncate(3);
        v.push((usd, eq, f, n, exs, fi));
    }
    v.sort_by(|a, b| b.0.total_cmp(&a.0));
    for (usd, eq, f, n, exs, fi) in v.into_iter().take(u.per_rule) {
        let title = match c.lang {
            Lang::En => format!("{n} images in the main thread of one session"),
            Lang::Es => format!("{n} imágenes en el hilo principal de una sesión"),
        };
        let why = match c.lang {
            Lang::En => format!("Every image stays in the main context (~1.6k tokens each) and is re-read until the session ends or compacts; more than {} per session adds up.", u.images_main),
            Lang::Es => format!("Cada imagen se queda en el contexto principal (~1,6k tokens) y se relee hasta que la sesión acaba o compacta; más de {} por sesión suma mucho.", u.images_main),
        };
        let action = c.l(
            "Let a reviewer subagent look at the screenshots and return text, or look at 4-6 at most, small or as a contact sheet.",
            "Deja que un subagente revisor mire las capturas y te devuelva texto, o mira 4-6 como mucho, pequeñas o en lámina.",
        );
        c.push(Regla::Images, &f.session, usd, Some(eq), title, why, action.into(), exs);
        if let Some(o) = images.get(&format!("image|{}", f.session)) {
            c.at(&o.key, &o.label, o.usd, o.eq, o.n, o.t);
            c.num("rowN", o.n as f64);
        }
        c.tx("images", json!({ "n": n, "nPl": n, "max": u.images_main }));
        c.assume("images", json!({ "keep": u.images_main.min(4) }));
        c.cells(vec![cell(fi, Cat::Image, usd, eq, false)]);
    }
}

/// 4. Subagente reanudado con contexto enorme y forks que heredan un contexto grande.
fn rule_resume_fork(facts: &Facts, c: &mut Ctx) {
    let u = c.u;
    let mut resumes: Vec<(f64, f64, &FileFacts, u64, u32, usize)> = Vec::new();
    let mut forks: Vec<(f64, f64, &FileFacts, usize)> = Vec::new();
    for (fi, f) in facts.files.iter().enumerate().filter(|f| f.1.agent.is_some()) {
        // Primer mensaje escrito (no el encargo) que llega con el contexto por encima del umbral.
        let hit = f.user_turns.iter().skip(1).copied().find(|&k| {
            let prev = (k as usize).checked_sub(1).and_then(|i| f.reqs.get(i)).map(|r| r.0).unwrap_or(0);
            prev > u.resume_context
        });
        if let Some(k) = hit {
            let (mut usd, mut eq) = (0.0, 0.0);
            for &(ctx, req_eq, req_usd) in f.reqs.iter().skip(k as usize) {
                if ctx > 0 {
                    let fr = 1.0 - (u.fresh_context as f64 / ctx as f64).min(1.0);
                    usd += req_usd * fr;
                    eq += req_eq * fr;
                }
            }
            let ctx = f.reqs.get(k.saturating_sub(1) as usize).map(|r| r.0).unwrap_or(0);
            resumes.push((usd, eq, f, ctx, k, fi));
        }
        if f.base > u.fork_context {
            let base = f.cat(Cat::Base);
            let fr = 1.0 - (u.fresh_context as f64 / f.base as f64).min(1.0);
            forks.push((base.usd * fr, base.eq * fr, f, fi));
        }
    }
    resumes.sort_by(|a, b| b.0.total_cmp(&a.0));
    for (usd, eq, f, ctx, k, fi) in resumes.into_iter().take(u.per_rule) {
        let who = who_label(f);
        let title = match c.lang {
            Lang::En => format!("Subagent «{who}» resumed with {} of context", fmt_tok(ctx as f64)),
            Lang::Es => format!("Subagente «{who}» reanudado con {} de contexto", fmt_tok(ctx as f64)),
        };
        let why = match c.lang {
            Lang::En => format!("A message reached it (SendMessage) with more than {} already in context: every later request re-reads all of it.", fmt_tok(u.resume_context as f64)),
            Lang::Es => format!("Le llegó un mensaje (SendMessage) con más de {} ya en el contexto: cada petición posterior lo relee entero.", fmt_tok(u.resume_context as f64)),
        };
        let action = c.l(
            "Do not resume a loaded agent: write a state file (done / how it was checked / pending / files) and launch a new one with it.",
            "No reanudes un agente cargado: deja un archivo de estado (hecho / cómo se comprobó / pendiente / archivos) y lanza otro con él.",
        );
        let e = vec![ev(f, Some(k), f.agent.clone().unwrap_or_default(), ctx, 0, usd)];
        c.push(Regla::Resume, &f.session, usd, Some(eq), title, why, action.into(), e);
        c.at(&format!("session|{}", f.session), &who, f.usd, f.eq, f.requests, f.max_context);
        c.tx("resume", json!({ "who": who, "ctxTok": ctx, "limTok": u.resume_context }));
        c.assume("fresh", json!({ "freshTok": u.fresh_context }));
        c.cells(whole(fi, usd, eq));
    }
    forks.sort_by(|a, b| b.0.total_cmp(&a.0));
    for (usd, eq, f, fi) in forks.into_iter().take(u.per_rule) {
        let title = match c.lang {
            Lang::En => format!("Subagent «{}» started with {} inherited", who_label(f), fmt_tok(f.base as f64)),
            Lang::Es => format!("Subagente «{}» arrancó con {} heredados", who_label(f), fmt_tok(f.base as f64)),
        };
        let why = match c.lang {
            Lang::En => format!("A fork inherits the whole parent context; above {} that is paid again in every request of the fork.", fmt_tok(u.fork_context as f64)),
            Lang::Es => format!("Un fork hereda todo el contexto del padre; por encima de {} se vuelve a pagar en cada petición del fork.", fmt_tok(u.fork_context as f64)),
        };
        let action = c.l(
            "When the parent context is large, write a short brief and launch a fresh agent instead of a fork.",
            "Cuando el contexto del padre es grande, escribe un brief corto y lanza un agente nuevo en vez de un fork.",
        );
        let e = vec![ev(f, Some(0), "base".into(), f.base, f.requests.saturating_sub(1) as u32, usd)];
        c.push(Regla::Fork, &f.session, usd, Some(eq), title, why, action.into(), e);
        c.tx("fork", json!({ "who": who_label(f), "baseTok": f.base, "limTok": u.fork_context }));
        let b = f.cat(Cat::Base);
        c.at(&format!("base|{}", f.session), &who_label(f), b.usd, b.eq, f.requests, f.base);
        c.assume("fresh", json!({ "freshTok": u.fresh_context }));
        c.cells(vec![cell(fi, Cat::Base, usd, eq, true)]);
    }
}

/// 5. Subagentes de trabajo mecánico en un modelo caro (Opus): muchas herramientas y poca salida.
fn rule_mech(facts: &Facts, c: &mut Ctx) {
    let u = c.u;
    // «Después» (C11): el mismo trabajo a precios del modelo más barato (`cheaper_model`): coste × entrada barata /
    // entrada cara (las partidas de contexto dominan: herramientas y relecturas).
    let mut groups: HashMap<String, (f64, u64, u64, u64, Vec<Prueba>, Vec<Cell>)> = HashMap::new();
    let mut cheap_name = String::new();
    for (fi, f) in facts.files.iter().enumerate().filter(|f| f.1.agent.is_some() && f.1.model.contains("opus") && f.1.requests > 0) {
        let calls = f.tool_calls();
        let out_per = f.output.saturating_sub(f.thinking) / f.requests;
        if calls < u.mech_tool_calls || out_per >= u.mech_output_per_req {
            continue;
        }
        let p_opus = price(&f.model, 0);
        let p_cheap = price(cheaper_model(&f.model), 0);
        cheap_name = model_name(cheaper_model(&f.model));
        let save = f.usd * (1.0 - p_cheap.input / p_opus.input).max(0.0);
        let save_eq = f.eq * (1.0 - p_cheap.input / p_opus.input).max(0.0);
        let g = groups.entry(who_label(f)).or_default();
        g.0 += save;
        g.1 += 1;
        g.2 += calls;
        g.3 += out_per;
        let mut e = ev(f, None, format!("{calls} tools, {out_per} out/req"), f.max_context, 0, f.usd);
        e.label_id = Some("mech".into());
        e.lp = [("calls".to_string(), json!(calls)), ("outPer".to_string(), json!(out_per))].into_iter().collect();
        g.4.push(e);
        g.5.extend(whole(fi, save, save_eq));
    }
    let mut v: Vec<_> = groups.into_iter().collect();
    v.sort_by(|a, b| b.1 .0.total_cmp(&a.1 .0));
    for (who, (usd, n, calls, out_sum, mut exs, cells)) in v.into_iter().take(u.per_rule) {
        exs.sort_by(|a, b| b.usd.total_cmp(&a.usd));
        exs.truncate(3);
        let title = match c.lang {
            Lang::En => format!("{n} «{who}» subagents doing mechanical work on Opus"),
            Lang::Es => format!("{n} subagentes «{who}» haciendo trabajo mecánico en Opus"),
        };
        let why = match c.lang {
            Lang::En => format!("{calls} tool calls and ~{} output tokens per request on average: running commands and reading, little writing. The saving is computed with Sonnet prices (Haiku saves more).", out_sum / n.max(1)),
            Lang::Es => format!("{calls} llamadas a herramientas y ~{} tokens de salida por petición de media: ejecutar y leer, poca escritura. El ahorro se calcula con precios de Sonnet (Haiku ahorra más).", out_sum / n.max(1)),
        };
        let action = c.l(
            "Give mechanical agents (batteries of tests, bakes, captures, measuring with an existing probe) a cheaper model in their definition (model: haiku or sonnet).",
            "Pon a los agentes mecánicos (baterías de tests, horneados, capturas, medir con una sonda que ya existe) un modelo más barato en su definición (model: haiku o sonnet).",
        );
        let eq = cells.iter().map(|x| x.eq).sum::<f64>();
        c.push(Regla::MechModel, &who, usd, Some(eq), title, why, action.into(), exs);
        let (ou, oe, on) = facts
            .files
            .iter()
            .filter(|f| f.agent.is_some() && who_label(f) == who && f.model.contains("opus"))
            .fold((0.0, 0.0, 0u64), |a, f| (a.0 + f.usd, a.1 + f.eq, a.2 + 1));
        c.at(&format!("who|{who}"), &who, ou, oe, on, 0);
        c.tx("mech", json!({ "n": n, "nPl": n, "who": who, "calls": calls, "outPer": out_sum / n.max(1) }));
        c.assume("mech", json!({ "model": cheap_name }));
        c.cells(cells);
    }
}

/// Desglose de la base fija del conjunto: (etiqueta, tokens medios, ficheros, coste usd, coste eq).
/// La parte no visible en el transcript (sistema, herramientas, MCP) va como «system+tools».
pub fn base_breakdown(facts: &Facts) -> Vec<(String, u64, u64, f64, f64)> {
    let mut m: HashMap<String, (u64, u64, f64, f64)> = HashMap::new();
    for f in facts.files.iter().filter(|f| f.base > 0) {
        let base = f.cat(Cat::Base);
        let visible: u64 = f.base_parts.iter().map(|p| p.1).sum::<u64>().min(f.base);
        let mut parts: Vec<(String, u64)> = f.base_parts.clone();
        parts.push(("system+tools".into(), f.base - visible));
        let scale = if visible > f.base { f.base as f64 / visible as f64 } else { 1.0 };
        for (k, t) in parts {
            let t = if k == "system+tools" { t } else { (t as f64 * scale) as u64 };
            if t == 0 {
                continue;
            }
            let share = t as f64 / f.base as f64;
            let e = m.entry(k).or_default();
            e.0 += t;
            e.1 += 1;
            e.2 += base.usd * share;
            e.3 += base.eq * share;
        }
    }
    let mut v: Vec<_> = m.into_iter().map(|(k, (t, n, usd, eq))| (k, t / n.max(1), n, usd, eq)).collect();
    v.sort_by(|a, b| b.3.total_cmp(&a.3));
    v
}

/// Partes de la base que se pueden recortar (memoria, listados, instrucciones) frente a las que no (sistema,
/// herramientas, el encargo).
fn trimmable(label: &str) -> bool {
    !matches!(label, "system+tools" | "user" | "base")
}

/// 6. Base fija alta: cuánto cuesta lo que se inyecta siempre × nº de sesiones y subagentes.
fn rule_base(facts: &Facts, c: &mut Ctx) {
    let parts = base_breakdown(facts);
    let base_usd: f64 = facts.files.iter().map(|f| f.cat(Cat::Base).usd).sum();
    let n = facts.files.iter().filter(|f| f.base > 0).count();
    if n == 0 || base_usd <= 0.0 || base_usd < 0.10 * c.total_usd {
        return;
    }
    // «Después» (C11): cada parte recortable de más de `index_keep` tokens queda en un índice de `index_keep`
    // (CLAUDE.md/MEMORY.md con enlaces, listados de skills y agentes cortos); el resto de la base no cambia.
    let keep = c.u.index_keep;
    let cut: Vec<_> = parts.iter().filter(|p| trimmable(&p.0) && p.1 > keep).take(4).collect();
    let frac = |t: u64| 1.0 - (keep as f64 / t.max(1) as f64).min(1.0);
    let usd: f64 = cut.iter().map(|p| p.3 * frac(p.1)).sum::<f64>();
    let eq: f64 = cut.iter().map(|p| p.4 * frac(p.1)).sum::<f64>();
    if cut.is_empty() {
        return;
    }
    // Partes por fichero: el ahorro de la base en proporción a la base de cada fichero.
    let base_eq: f64 = facts.files.iter().map(|f| f.cat(Cat::Base).eq).sum();
    let cells: Vec<Cell> = facts
        .files
        .iter()
        .enumerate()
        .filter(|(_, f)| f.base > 0)
        .map(|(fi, f)| {
            let b = f.cat(Cat::Base);
            cell(fi, Cat::Base, usd * b.usd / base_usd, if base_eq > 0.0 { eq * b.eq / base_eq } else { 0.0 }, false)
        })
        .collect();
    // Las mismas medias que la tarjeta «Base fija» (ScanReport::base_mean_main/sub): ficheros con peticiones en el
    // periodo, hilo principal y subagentes por separado.
    let mean_of = |sub: bool| {
        let v: Vec<u64> = facts.files.iter().filter(|f| f.requests > 0 && f.agent.is_some() == sub).map(|f| f.base).collect();
        (if v.is_empty() { 0 } else { v.iter().sum::<u64>() / v.len() as u64 }, v.len() as u64)
    };
    let ((m_main, n_main), (m_sub, n_sub)) = (mean_of(false), mean_of(true));
    let exs: Vec<Prueba> = parts
        .iter()
        .take(5)
        .map(|p| Prueba { label: format!("{} ×{}", p.0, p.2), tokens: p.1, usd: p.3, ..Default::default() })
        .collect();
    let title = match c.lang {
        Lang::En => format!("Fixed base: ~{} per main session ({n_main}) and ~{} per subagent ({n_sub})", fmt_tok(m_main as f64), fmt_tok(m_sub as f64)),
        Lang::Es => format!("Base fija: ~{} por sesión principal ({n_main}) y ~{} por subagente ({n_sub})", fmt_tok(m_main as f64), fmt_tok(m_sub as f64)),
    };
    let why = match c.lang {
        Lang::En => format!("The fixed base is the context of the first request of every file, paid again in each one. The biggest parts you can trim: {}. ", cut.iter().map(|p| p.0.as_str()).collect::<Vec<_>>().join(", ")),
        Lang::Es => format!("La base fija es el contexto de la primera petición de cada fichero, que se vuelve a pagar en cada uno. Las partes más grandes que se pueden recortar: {}. ", cut.iter().map(|p| p.0.as_str()).collect::<Vec<_>>().join(", ")),
    };
    let action = c.l(
        "Trim CLAUDE.md and MEMORY.md to an index with links, keep nested CLAUDE.md files short, disable MCP servers and skills a project does not use, and give subagents only the tools they need.",
        "Recorta CLAUDE.md y MEMORY.md a un índice con enlaces, deja cortos los CLAUDE.md anidados, desactiva los MCP y skills que el proyecto no usa y da a los subagentes solo las herramientas que necesitan.",
    );
    c.push(Regla::BaseFixed, "base", usd, Some(eq), title, why, action.into(), exs);
    c.num("baseMain", m_main as f64);
    c.num("baseSub", m_sub as f64);
    c.num("nMain", n_main as f64);
    c.num("nSub", n_sub as f64);
    c.num("share", base_usd / c.total_usd);
    let names: Vec<&str> = cut.iter().map(|p| p.0.as_str()).collect();
    c.tx("base", json!({ "mainTok": m_main, "subTok": m_sub, "nMain": n_main, "nSub": n_sub, "parts": names.join(", ") }));
    c.assume("base", json!({ "keepTok": keep }));
    c.cells(cells);
}

/// 6b. Skills y recordatorios grandes inyectados enteros a mitad de sesión.
fn rule_skills(facts: &Facts, c: &mut Ctx) {
    let u = c.u;
    // «Después» (C11): la skill entera pasa a un índice de `index_keep` tokens (lo demás, en archivos por tema que se
    // leen cuando hacen falta).
    let mut groups: HashMap<String, (f64, f64, u64, u64, Vec<Prueba>, Vec<Cell>)> = HashMap::new();
    for (fi, f) in facts.files.iter().enumerate() {
        for b in f.blocks.iter().filter(|b| b.cat == Cat::Reminder && b.t > u.skill_tokens) {
            let key = origin_of(f, b).0;
            let fr = 1.0 - (u.index_keep as f64 / b.t as f64).min(1.0);
            let g = groups.entry(key.clone()).or_default();
            g.0 += b.usd * fr;
            g.1 += b.eq * fr;
            g.5.push(cell(fi, Cat::Reminder, b.usd * fr, b.eq * fr, false));
            g.2 += 1;
            g.3 += b.t;
            g.4.push(ev(f, Some(b.req), b.tool.clone().unwrap_or_else(|| "reminder".into()), b.t, b.rereads, b.usd));
        }
    }
    let all = origins_of(facts, Cat::Reminder);
    let mut v: Vec<_> = groups.into_iter().filter(|x| all.contains_key(&x.0)).collect();
    v.sort_by(|a, b| b.1 .0.total_cmp(&a.1 .0).then(a.0.cmp(&b.0)));
    for (okey, (usd, eq, n, t, mut exs, cells)) in v.into_iter().take(u.per_rule) {
        let o = &all[&okey];
        let key = o.label.clone();
        exs.sort_by(|a, b| b.usd.total_cmp(&a.usd));
        exs.truncate(3);
        let title = match c.lang {
            Lang::En => format!("«{key}» injected whole {n} of its {} times (≈{} tokens each)", o.n, fmt_tok((t / n.max(1)) as f64)),
            Lang::Es => format!("«{key}» inyectado entero {n} de sus {} veces (≈{} tokens cada vez)", o.n, fmt_tok((t / n.max(1)) as f64)),
        };
        let why = c.l(
            "Large skills, memories or reminders enter the context in full and are re-read until the end.",
            "Las skills, memorias o recordatorios grandes entran enteros al contexto y se releen hasta el final.",
        );
        let action = c.l(
            "Split big skills into a short index plus topic files read on demand; avoid loading reference skills in agents that do not need them.",
            "Parte las skills grandes en un índice corto y archivos por tema que se leen cuando hacen falta; no cargues skills de referencia en agentes que no las necesitan.",
        );
        c.push(Regla::SkillWhole, &key, usd, Some(eq), title, why.into(), action.into(), exs);
        c.at(&o.key, &o.label, o.usd, o.eq, o.n, o.t);
        c.num("rowN", o.n as f64);
        c.num("big", n as f64);
        c.tx("skill", json!({ "key": key, "n": n, "rn": o.n, "rnPl": o.n, "eachTok": t / n.max(1) }));
        c.assume("skill", json!({ "keepTok": u.index_keep }));
        c.cells(cells);
    }
}

/// Fracción del contexto que queda tras compactar (tokens después / antes), medida en las compactaciones del
/// periodo; sin compactaciones, `POST_COMPACT_DEFAULT`. Devuelve (fracción, compactaciones medidas).
pub fn post_compact_ratio(facts: &Facts) -> (f64, u64) {
    let (mut pre, mut post, mut n) = (0u64, 0u64, 0u64);
    for f in &facts.files {
        for (e, _) in f.events.iter().filter(|(e, _)| e.kind == EventKind::Compaction && e.tokens > 0 && e.extra > 0) {
            pre += e.tokens;
            post += e.extra.min(e.tokens);
            n += 1;
        }
    }
    if n == 0 { (POST_COMPACT_DEFAULT, 0) } else { (post as f64 / pre as f64, n) }
}
pub const POST_COMPACT_DEFAULT: f64 = 0.35;

/// Ahorro realista (en eq) de UNA caché caducada: el sobrecoste de reescribir en frío (`cost_eq` = U·(w − r))
/// MENOS lo que costaría la alternativa, compactar antes de la pausa: leer en caliente el contexto (U·r) y
/// volver a escribir tras la pausa solo el resumen (post·U·w). `r_eq` = lectura de caché / entrada del modelo.
pub fn expired_saving(tokens: u64, cost_eq: f64, r_eq: f64, post: f64) -> f64 {
    if tokens == 0 || cost_eq <= 0.0 {
        return 0.0;
    }
    let u = tokens as f64;
    let w = cost_eq / u + r_eq;
    (cost_eq - (u * r_eq + post * u * w)).max(0.0)
}

/// 7. Cachés caducadas y rotas por prefijo cambiado.
fn rule_cache(facts: &Facts, c: &mut Ctx) {
    let mut exp: (f64, f64, u64, Vec<Prueba>) = Default::default();
    let mut pre: (f64, f64, u64, Vec<Prueba>) = Default::default();
    // Caducadas: ahorro realista (eq, usd) y sobrecoste entero (usd), para rotularlo.
    let (post, n_comp) = post_compact_ratio(facts);
    let (mut exp_save_eq, mut exp_save_usd) = (0.0, 0.0);
    let mut model: u64 = 0;
    let (mut exp_cells, mut pre_cells) = (Vec::new(), Vec::new());
    let avoid = c.u.prefix_avoidable;
    for (fi, f) in facts.files.iter().enumerate() {
        for (e, usd) in f.events.iter().filter(|(e, _)| e.kind == EventKind::CacheBroken) {
            let slot = match e.cause {
                Some(BreakCause::Expired) => &mut exp,
                Some(BreakCause::ModelChanged) => {
                    model += 1;
                    continue;
                }
                _ => &mut pre,
            };
            if e.cause == Some(BreakCause::Expired) {
                let p = price(&f.model, e.tokens);
                let s = expired_saving(e.tokens, e.cost, p.read / p.input, post);
                let su = if e.cost > 0.0 { s * usd / e.cost } else { 0.0 };
                exp_save_eq += s;
                exp_save_usd += su;
                exp_cells.extend(whole(fi, su, s));
            } else {
                pre_cells.extend(whole(fi, usd * avoid, e.cost * avoid));
            }
            slot.0 += usd;
            slot.1 += e.cost;
            slot.2 += 1;
            let expired = e.cause == Some(BreakCause::Expired);
            let gap = if expired { format!("{} min", e.extra / 60) } else { c.l("prefix changed", "prefijo cambiado").to_string() };
            let mut p = ev(f, Some(e.req), gap, e.tokens, 0, *usd);
            if !expired {
                p.label_id = Some("prefix".into());
            }
            slot.3.push(p);
        }
    }
    let _ = model;
    for (rule, (usd, eq, n, mut exs)) in [(Regla::CacheExpired, exp), (Regla::CachePrefix, pre)] {
        if n == 0 {
            continue;
        }
        exs.sort_by(|a, b| b.usd.total_cmp(&a.usd));
        exs.truncate(3);
        let pc = (post * 100.0).round();
        let measured = match (c.lang, n_comp) {
            (Lang::En, 0) => format!("{pc:.0} % of the context, no compactions {} to measure it", c.scope_in()),
            (Lang::Es, 0) => format!("{pc:.0} % del contexto, sin compactaciones {} para medirlo", c.scope_in()),
            (Lang::En, k) => format!("{pc:.0} % of the context, measured in {k} compactions {}", c.scope()),
            (Lang::Es, k) => format!("{pc:.0} % del contexto, medido en {k} compactaciones {}", c.scope()),
        };
        let (title, why, action) = if rule == Regla::CacheExpired {
            (
                match c.lang {
                    Lang::En => format!("{n} expired caches: the whole context was written again"),
                    Lang::Es => format!("{n} cachés caducadas: se volvió a escribir el contexto entero"),
                },
                match c.lang {
                    Lang::En => format!("After a pause longer than the cache lifetime (5 min or 1 h), the next request rewrites the whole context instead of reading it. The saving is that extra cost minus what compacting before the pause would cost (reading the context once and writing a summary of ≈{measured})."),
                    Lang::Es => format!("Tras una pausa más larga que la vida de la caché (5 min o 1 h), la siguiente petición reescribe el contexto entero en vez de leerlo. El ahorro es ese sobrecoste menos lo que costaría compactar antes de la pausa (leer el contexto una vez y escribir un resumen de ≈{measured})."),
                },
                c.l(
                    "Come back before the cache expires, compact (/compact) or start a new session before a long pause, and lower the auto-compact threshold so the context you leave idle is small.",
                    "Vuelve antes de que caduque, compacta (/compact) o abre sesión nueva antes de una pausa larga, y baja el umbral de auto-compact para que lo que dejas parado sea pequeño.",
                )
                .to_string(),
            )
        } else {
            (
                match c.lang {
                    Lang::En => format!("{n} caches broken because the prefix changed"),
                    Lang::Es => format!("{n} cachés rotas porque cambió el prefijo"),
                },
                c.l(
                    "The cache was written again without a pause or a model change. The transcript does not say what changed; usual causes: an MCP server connecting or disconnecting, tools or permissions changed mid-session, CLAUDE.md or memory edited, effort or settings switched.",
                    "La caché se reescribió sin pausa ni cambio de modelo. El transcript no dice qué cambió; causas habituales: un MCP que se conecta o desconecta, herramientas o permisos que cambian a mitad de sesión, CLAUDE.md o la memoria editados, esfuerzo o ajustes cambiados.",
                )
                .to_string(),
                c.l(
                    "Keep MCP servers, tools and instructions stable during a session; make those changes between sessions.",
                    "Mantén estables los MCP, herramientas e instrucciones durante una sesión; haz esos cambios entre sesiones.",
                )
                .to_string(),
            )
        };
        let case = if rule == Regla::CacheExpired { "expired" } else { "prefix" };
        // «Después» (C11) de las rotas por prefijo: queda la parte que no se puede evitar (`prefix_avoidable`).
        let (save_usd, save_eq) = if rule == Regla::CacheExpired { (exp_save_usd, exp_save_eq) } else { (usd * avoid, eq * avoid) };
        c.push(rule, case, save_usd, Some(save_eq), title, why, action, exs);
        if rule == Regla::CacheExpired {
            c.assume("compact", json!({ "pc": pc }));
            c.cells(std::mem::take(&mut exp_cells));
        } else {
            c.assume("prefix", json!({ "avoidPct": avoid }));
            c.cells(std::mem::take(&mut pre_cells));
        }
        c.num("n", n as f64);
        if rule == Regla::CacheExpired {
            c.num("post", post);
            c.num("compactions", n_comp as f64);
            let sc = c.scope_frag(n_comp > 0);
            c.tx("cacheExpired", json!({ "whyV": if n_comp == 0 { "none" } else { "measured" }, "n": n, "nPl": n, "pc": pc, "k": n_comp, "kPl": n_comp, "scope": sc }));
        } else {
            c.tx("cachePrefix", json!({ "n": n, "nPl": n }));
        }
    }
}

/// 8. Sesiones con contexto enorme o muchísimas peticiones.
fn rule_long(facts: &Facts, c: &mut Ctx) {
    let u = c.u;
    let mut v: Vec<(f64, f64, &FileFacts, usize)> = Vec::new();
    for (fi, f) in facts.files.iter().enumerate() {
        if f.max_context <= u.long_context && f.requests <= u.long_requests {
            continue;
        }
        let (mut usd, mut eq) = (0.0, 0.0);
        for &(ctx, req_eq, req_usd) in &f.reqs {
            if ctx > u.long_context {
                let fr = (ctx - u.long_context) as f64 / ctx as f64;
                usd += req_usd * fr;
                eq += req_eq * fr;
            }
        }
        v.push((usd, eq, f, fi));
    }
    v.sort_by(|a, b| b.0.total_cmp(&a.0).then(b.2.requests.cmp(&a.2.requests)));
    for (usd, eq, f, fi) in v.into_iter().take(u.per_rule) {
        let title = match c.lang {
            Lang::En => format!("Long session ({}): {} of context, {} requests", who_text(c.lang, &who_label(f)), fmt_tok(f.max_context as f64), f.requests),
            Lang::Es => format!("Sesión larga ({}): {} de contexto, {} peticiones", who_text(c.lang, &who_label(f)), fmt_tok(f.max_context as f64), f.requests),
        };
        let why = match c.lang {
            Lang::En => format!("Everything above {} is re-read in every request. The estimate is what was paid above that line.", fmt_tok(u.long_context as f64)),
            Lang::Es => format!("Todo lo que pasa de {} se relee en cada petición. La estimación es lo pagado por encima de esa raya.", fmt_tok(u.long_context as f64)),
        };
        let action = c.l(
            "Open a new session when the topic changes or the context passes the line; memory and state files carry what matters.",
            "Abre otra sesión cuando cambie el tema o el contexto pase la raya; la memoria y los archivos de estado guardan lo importante.",
        );
        let e = vec![ev(f, None, who_label(f), f.max_context, 0, f.usd)];
        c.push(Regla::LongSession, &f.session, usd, Some(eq), title, why, action.into(), e);
        c.at(&format!("session|{}", f.session), &who_label(f), f.usd, f.eq, f.requests, f.max_context);
        c.tx("long", json!({ "who": who_label(f), "ctxTok": f.max_context, "reqs": f.requests, "limTok": u.long_context }));
        c.assume("long", json!({ "limTok": u.long_context }));
        c.cells(whole(fi, usd, eq));
    }
}

/// «claude-opus-5-5» → «Opus 5.5» (para los textos).
pub fn model_name(m: &str) -> String {
    let s = m.strip_prefix("claude-").unwrap_or(m);
    let mut it = s.split('-').filter(|p| !(p.len() >= 8 && p.chars().all(|c| c.is_ascii_digit())));
    let Some(fam) = it.next() else { return m.to_string() };
    let mut name: String = fam.chars().take(1).flat_map(|c| c.to_uppercase()).chain(fam.chars().skip(1)).collect();
    let ver: Vec<&str> = it.collect();
    if !ver.is_empty() {
        name.push(' ');
        name.push_str(&ver.join("."));
    }
    name
}

/// 9. Salida y razonamiento (lo que GENERA el modelo, ≈ un tercio del gasto), por tipo de agente y modelo. El coste
/// citado es su parte de las partidas «Salida» + «Razonamiento» de la misma vista (generar + tenerlo en el contexto
/// después), y dice cuánto es generar y cuánto relecturas. Ahorro: razonamiento a la mitad si el trabajo es
/// mecánico (o piensa ≥ `thinking_ratio`× lo que escribe), un cuarto si no; salida visible un tercio más corta.
fn rule_gen(facts: &Facts, c: &mut Ctx) {
    #[derive(Default)]
    struct G {
        o: (f64, f64),
        th: (f64, f64),
        gen: (f64, f64),
        out_t: u64,
        th_t: u64,
        n: u64,
        mech: u64,
        exs: Vec<Prueba>,
        files: Vec<(usize, CatAgg, CatAgg)>,
    }
    let u = c.u;
    let mut groups: HashMap<(String, String), G> = HashMap::new();
    for (fi, f) in facts.files.iter().enumerate() {
        let (o, th) = (f.cat(Cat::Output), f.cat(Cat::Thinking));
        if o.usd + th.usd <= 0.0 {
            continue;
        }
        let g = groups.entry((who_label(f), f.model.clone())).or_default();
        g.files.push((fi, o.clone(), th.clone()));
        g.o.0 += o.usd;
        g.o.1 += o.eq;
        g.th.0 += th.usd;
        g.th.1 += th.eq;
        // Generar no puede pasar de la partida (borde del periodo: la salida entra en la petición siguiente).
        g.gen.0 += (f.gen_out.1 + f.gen_think.1).min(o.usd + th.usd);
        g.gen.1 += (f.gen_out.0 + f.gen_think.0).min(o.eq + th.eq);
        let vis = f.output.saturating_sub(f.thinking);
        g.out_t += vis;
        g.th_t += f.thinking;
        g.n += 1;
        // Mecánico = la MISMA definición que `rule_mech` (muchas herramientas y poca salida por petición) o un tipo de
        // agente mecánico; C11: antes bastaban 12 herramientas y casi todo «obrero» salía mecánico.
        let out_per = vis / f.requests.max(1);
        if (f.agent.is_some() && f.tool_calls() >= u.mech_tool_calls && out_per < u.mech_output_per_req) || matches!(f.agent.as_deref(), Some("peon") | Some("Explore")) {
            g.mech += 1;
        }
        let mut e = ev(f, None, match c.lang {
            Lang::En => format!("output {} / thinking {}", fmt_tok(vis as f64), fmt_tok(f.thinking as f64)),
            Lang::Es => format!("salida {} / razonamiento {}", fmt_tok(vis as f64), fmt_tok(f.thinking as f64)),
        }, vis + f.thinking, 0, o.usd + th.usd);
        e.label_id = Some("gen".into());
        e.lp = [("outTok".to_string(), json!(vis)), ("thinkTok".to_string(), json!(f.thinking))].into_iter().collect();
        g.exs.push(e);
    }
    let mut v: Vec<_> = groups.into_iter().collect();
    v.sort_by(|a, b| (b.1.o.0 + b.1.th.0).total_cmp(&(a.1.o.0 + a.1.th.0)).then(a.0.cmp(&b.0)));
    for ((who, model), mut g) in v.into_iter().take(u.per_rule) {
        let (usd, eq) = (g.o.0 + g.th.0, g.o.1 + g.th.1);
        if c.total_usd <= 0.0 || usd < 0.03 * c.total_usd {
            continue;
        }
        // El hilo principal no tiene definición de agente: su consejo es bajar el esfuerzo de la sesión y delegar.
        let main = who == "main";
        let mech = !main && g.mech * 2 >= g.n;
        let heavy = g.th_t as f64 >= u.thinking_ratio * g.out_t.max(1) as f64 && g.th_t >= u.thinking_min;
        let opus = model.contains("opus");
        // «Después» (C11). SUPUESTOS (no medidos; ajustables en Umbrales): effort low quita `think_cut_low` del
        // razonamiento (mecánico o que piensa ≥ `thinking_ratio`× lo que escribe), medium `think_cut_medium`; pedir
        // respuestas ≤ 20 líneas quita `out_cut` de la salida visible. Mecánico en Opus: además, todo a precio de
        // salida del modelo más barato (`cheaper_model`, tabla `price`): Opus 5.5 → Sonnet 5.5 = 10/20 $/M.
        let th_cut = if mech || heavy { u.think_cut_low } else { u.think_cut_medium };
        let pr = if mech && opus { price(cheaper_model(&model), 0).output / price(&model, 0).output } else { 1.0 };
        let keep_th = (1.0 - th_cut) * pr;
        let keep_o = (1.0 - u.out_cut) * pr;
        let (su, se) = (g.th.0 * (1.0 - keep_th) + g.o.0 * (1.0 - keep_o), g.th.1 * (1.0 - keep_th) + g.o.1 * (1.0 - keep_o));
        let cells: Vec<Cell> = g
            .files
            .iter()
            .flat_map(|(fi, o, th)| [cell(*fi, Cat::Output, o.usd * (1.0 - keep_o), o.eq * (1.0 - keep_o), true), cell(*fi, Cat::Thinking, th.usd * (1.0 - keep_th), th.eq * (1.0 - keep_th), true)])
            .collect();
        g.exs.sort_by(|a, b| b.usd.total_cmp(&a.usd));
        g.exs.truncate(3);
        let mn = model_name(&model);
        let gen_share = if usd > 0.0 { (g.gen.0 / usd).min(1.0) } else { 0.0 };
        let n = g.n;
        let title = match c.lang {
            Lang::En if main => format!("The main thread on {mn} generates {} of output and {} of thinking ({})", fmt_tok(g.out_t as f64), fmt_tok(g.th_t as f64), pl(c.lang, n, ("session", "sessions"), ("", ""))),
            Lang::Es if main => format!("El hilo principal en {mn} genera {} de salida y {} de razonamiento ({})", fmt_tok(g.out_t as f64), fmt_tok(g.th_t as f64), pl(c.lang, n, ("", ""), ("sesión", "sesiones"))),
            Lang::En => format!("«{who}» on {mn} generates {} of output and {} of thinking ({})", fmt_tok(g.out_t as f64), fmt_tok(g.th_t as f64), pl(c.lang, n, ("file", "files"), ("", ""))),
            Lang::Es => format!("«{who}» en {mn} genera {} de salida y {} de razonamiento ({})", fmt_tok(g.out_t as f64), fmt_tok(g.th_t as f64), pl(c.lang, n, ("", ""), ("fichero", "ficheros"))),
        };
        let (gs, rs) = (fmt_pct(gen_share), fmt_pct(1.0 - gen_share));
        let why = match c.lang {
            Lang::En => format!(
                "It is billed at output price (5× the input). Of its cost, {gs} is generating it and {rs} is re-reading it in the following requests{}.",
                if mech { " (mechanical work)" } else { "" }
            ),
            Lang::Es => format!(
                "Se cobra a precio de salida (5× la entrada). De su coste, el {gs} es generarlo y el {rs} releerlo en las peticiones siguientes{}.",
                if mech { " (trabajo mecánico)" } else { "" }
            ),
        };
        let action = match (c.lang, mech, opus) {
            _ if main => c.l(
                "In the main thread: lower the session effort for routine work (/effort medium or low), delegate long reads and command runs to a cheaper subagent, and ask for short answers (≤ 20 lines).",
                "En el hilo principal: baja el esfuerzo de la sesión para lo rutinario (/effort medium o low), delega las lecturas y los comandos largos a un subagente más barato y pide respuestas cortas (≤ 20 líneas).",
            )
            .to_string(),
            (Lang::En, true, true) => format!("Set effort: low and model: sonnet (or haiku) in the definition of «{who}», and ask it for reports of ≤ 20 lines."),
            (Lang::Es, true, true) => format!("Pon effort: low y model: sonnet (o haiku) en la definición de «{who}», y pídele informes de ≤ 20 líneas."),
            (Lang::En, true, false) => format!("Set effort: low in the definition of «{who}» and ask it for reports of ≤ 20 lines."),
            (Lang::Es, true, false) => format!("Pon effort: low en la definición de «{who}» y pídele informes de ≤ 20 líneas."),
            (Lang::En, false, _) => format!("Ask «{who}» for shorter answers (≤ 20 lines, no code or whole files pasted back, edits instead of rewrites) and use effort: medium for routine work."),
            (Lang::Es, false, _) => format!("Pide a «{who}» respuestas más cortas (≤ 20 líneas, sin pegar código ni ficheros enteros, editar en vez de reescribir) y effort: medium para lo rutinario."),
        };
        let key = format!("gen|{who}|{model}");
        c.push(Regla::Output, &key, su, Some(se), title, why, action, g.exs);
        c.at(&key, &format!("{who} · {mn}"), usd, eq, n, g.out_t + g.th_t);
        if let Some(x) = c.out.last_mut() {
            // «Opus 5.5» es un nombre, no un decimal.
            x.title = x.title.replace(&es_decimals(&mn), &mn);
        }
        c.num("outT", g.out_t as f64);
        c.num("thinkT", g.th_t as f64);
        c.num("files", n as f64);
        c.num("genShare", gen_share);
        c.num("genUsd", g.gen.0);
        c.num("genEq", g.gen.1);
        let av = match (main, mech, opus) { (true, ..) => "main", (_, true, true) => "mechOpus", (_, true, false) => "mech", _ => "other" };
        c.tx("gen", json!({ "actionV": av, "titleV": if main { "main" } else { "agent" }, "who": who, "mn": mn, "outTok": g.out_t, "thinkTok": g.th_t, "n": n, "nPl": n, "gsPct": gen_share, "rsPct": 1.0 - gen_share,
            "whyV": if mech { "mech" } else { "plain" }, "nMainPl": n }));
        let cheap = if pr < 1.0 { model_name(cheaper_model(&model)) } else { String::new() };
        c.assume(if pr < 1.0 { "genCheap" } else { "gen" }, json!({ "thinkPct": th_cut, "outPct": u.out_cut, "model": cheap }));
        c.cells(cells);
    }
}

/// 10. Historial en disco grande.
fn rule_disk(facts: &Facts, c: &mut Ctx) {
    let Some(b) = facts.history_bytes else { return };
    let gb = b as f64 / 1e9;
    if gb < c.u.disk_gb {
        return;
    }
    let title = match c.lang {
        Lang::En => format!("{gb:.1} GB of session history on disk"),
        Lang::Es => format!("{gb:.1} GB de historial de sesiones en disco"),
    };
    let why = c.l(
        "Claude Code keeps every transcript under projects/. It does not cost tokens, but it fills the disk and slows down scans.",
        "Claude Code guarda cada transcript en projects/. No cuesta tokens, pero llena el disco y hace más lentos los escaneos.",
    );
    let action = c.l(
        "Set cleanupPeriodDays in settings.json (for example 30) so old transcripts are deleted.",
        "Pon cleanupPeriodDays en settings.json (por ejemplo 30) para que se borren los transcripts viejos.",
    );
    let e = vec![Prueba { label: "projects/".into(), tokens: 0, usd: 0.0, ..Default::default() }];
    c.push(Regla::Disk, "disk", 0.0, Some(0.0), title, why.into(), action.into(), e);
    c.tx("disk", json!({ "gbDec": gb }));
}

#[cfg(test)]
#[path = "consejos_tests.rs"]
mod tests;
