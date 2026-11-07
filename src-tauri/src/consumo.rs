//! Consumo: a qué se van los tokens de una sesión de Claude Code (fase C1, solo lectura).
//!
//! Para cada transcript (.jsonl) se saca la lista de peticiones (usage por petición, deduplicado por
//! `message.id` como en `tokens.rs`) y los bloques que entran al contexto entre una petición y la
//! siguiente (resultados de herramientas, adjuntos, mensajes, salida…). El tamaño de cada bloque se
//! estima con el crecimiento del contexto entre dos peticiones, repartido por caracteres.
//!
//! Coste real de un bloque de t tokens que entra en la petición k: t·w_escritura(k) + t·Σ w_lectura(j)
//! para las peticiones j > k del mismo tramo (hasta compactar o acabar). Los pesos van por modelo.
//!
//! Lectura en streaming por líneas (nunca el fichero entero en memoria) e incremental: el estado del
//! analizador se guarda en un índice en disco y solo se procesa lo añadido. En el índice no hay
//! contenido: solo nombres de herramienta, rutas y como mucho 80 caracteres de vista previa.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ───────────────────────────── precios ─────────────────────────────

/// Precio en USD por millón de tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub write_5m: f64,
    pub write_1h: f64,
    pub read: f64,
    pub output: f64,
}

/// Tabla de precios por modelo.
///
/// Fuente: skill `claude-api` (tabla «Current Models», cacheada 2026-10-06, y `shared/prompt-caching.md`
/// § Economics), consultada el 2026-11-07: escritura de caché = 1,25× la entrada (TTL 5 min) y 2× (TTL 1 h);
/// lectura de caché ~0,1× la entrada, salvo Opus 5.5 (0,20 $), Sonnet 5.5 (0,20 $), Fable 5.1 (0,25 $) y
/// Fable 5 (1 $). Haiku 5.5: 0,10/0,50 $ hasta 100K de prompt y 0,50/2,50 $ por encima; su lectura de caché
/// no viene en la skill y se supone 0,1×. Modelo desconocido → precios de Opus 5.5 (el de por defecto).
pub fn price(model: &str, context: u64) -> Price {
    let m = model.to_ascii_lowercase();
    let m = m.split('[').next().unwrap_or("");
    let (input, output, read) = if m.contains("fable-5-1") || m.contains("mythos-5-1") {
        (10.0, 50.0, 0.25)
    } else if m.contains("fable") || m.contains("mythos") {
        (10.0, 50.0, 1.0)
    } else if m.contains("opus-5-5") {
        (4.0, 20.0, 0.20)
    } else if m.contains("opus") {
        (5.0, 25.0, 0.50)
    } else if m.contains("sonnet-5") {
        (2.0, 10.0, 0.20)
    } else if m.contains("sonnet") {
        (3.0, 15.0, 0.30)
    } else if m.contains("haiku-5-5") {
        if context > 100_000 { (0.50, 2.50, 0.05) } else { (0.10, 0.50, 0.01) }
    } else if m.contains("haiku") {
        (1.0, 5.0, 0.10)
    } else {
        (4.0, 20.0, 0.20)
    };
    Price { input, write_5m: input * 1.25, write_1h: input * 2.0, read, output }
}

// ───────────────────────────── tipos ─────────────────────────────

/// Categoría de lo que entra al contexto.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord, Default)]
#[serde(rename_all = "camelCase")]
pub enum Cat {
    /// Contexto de la primera petición (instrucciones, herramientas, MCP, CLAUDE.md, memoria, primer mensaje).
    Base,
    Read,
    Bash,
    /// Grep y Glob.
    Search,
    Mcp,
    Image,
    /// Resultado de un subagente (Agent/Task) en el hilo padre.
    Subagent,
    /// system-reminder, hooks y adjuntos.
    Reminder,
    User,
    /// Resumen de una compactación.
    Compact,
    OtherTool,
    Output,
    Thinking,
    /// Crecimiento del contexto sin ningún bloque visible que lo explique.
    #[default]
    Unattributed,
}

/// Usage de una petición (máximo por campo entre las líneas del mismo mensaje).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub cache_create: u64,
    /// De `cache_create`, lo escrito con TTL de 5 min / 1 h (si viene desglosado).
    pub cache_5m: u64,
    pub cache_1h: u64,
    pub cache_read: u64,
    pub output: u64,
    /// De `output`, lo dedicado a razonar.
    pub thinking: u64,
}

impl Usage {
    fn max_with(&mut self, o: &Usage) {
        self.input = self.input.max(o.input);
        self.cache_create = self.cache_create.max(o.cache_create);
        self.cache_5m = self.cache_5m.max(o.cache_5m);
        self.cache_1h = self.cache_1h.max(o.cache_1h);
        self.cache_read = self.cache_read.max(o.cache_read);
        self.output = self.output.max(o.output);
        self.thinking = self.thinking.max(o.thinking);
    }
    /// Tamaño del contexto enviado en la petición.
    pub fn context(&self) -> u64 {
        self.input + self.cache_create + self.cache_read
    }
    fn is_zero(&self) -> bool {
        self.context() == 0 && self.output == 0
    }
}

/// Una petición al modelo. En el índice va con nombres cortos y sin los pesos (se recalculan al cargar).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    /// Segundos epoch (UTC).
    #[serde(rename = "t")]
    pub ts: u64,
    #[serde(rename = "m")]
    pub model: String,
    #[serde(rename = "u", with = "usage_arr")]
    pub usage: Usage,
    /// Tramo (sube con cada compactación).
    #[serde(rename = "g")]
    pub seg: u32,
    /// Peso de escritura del contenido nuevo en esta petición (en «tokens de entrada» del modelo y en USD/token).
    #[serde(skip)]
    w_write: f64,
    #[serde(skip)]
    w_write_usd: f64,
    /// Suma acumulada (dentro del tramo, incluida esta) del peso de lectura de caché.
    #[serde(skip)]
    s_read: f64,
    #[serde(skip)]
    s_read_usd: f64,
}

impl Request {
    /// Factura de la petición a precio de API: (tokens de entrada equivalentes de su modelo, USD).
    /// Entrada + escritura de caché (5 min / 1 h; sin desglose, 1 h) + lectura de caché + salida.
    pub fn bill(&self) -> (f64, f64) {
        let p = price(&self.model, self.usage.context());
        let u = &self.usage;
        let (c5, c1) = if u.cache_5m + u.cache_1h > 0 { (u.cache_5m, u.cache_1h) } else { (0, u.cache_create) };
        let usd = (u.input as f64 * p.input
            + c5 as f64 * p.write_5m
            + c1 as f64 * p.write_1h
            + u.cache_read as f64 * p.read
            + u.output as f64 * p.output)
            / 1e6;
        (usd * 1e6 / p.input, usd)
    }

    /// Calcula los pesos a partir del modelo, el usage y la petición anterior del mismo tramo.
    fn weigh(&mut self, prev_same_seg: Option<&Request>) {
        let p = price(&self.model, self.usage.context());
        let u = &self.usage;
        // Peso de escritura de lo nuevo: mezcla de entrada normal y escritura de caché 5 min / 1 h.
        let (c5, c1) = if u.cache_5m + u.cache_1h > 0 {
            (u.cache_5m, u.cache_1h)
        } else {
            (0, u.cache_create) // sin desglose: Claude Code usa 1 h
        };
        let den = (u.input + c5 + c1) as f64;
        self.w_write_usd = if den > 0.0 {
            (u.input as f64 * p.input + c5 as f64 * p.write_5m + c1 as f64 * p.write_1h) / den / 1e6
        } else {
            p.write_1h / 1e6
        };
        self.w_write = self.w_write_usd * 1e6 / p.input;
        let (r_eq, r_usd) = (p.read / p.input, p.read / 1e6);
        (self.s_read, self.s_read_usd) = match prev_same_seg {
            Some(r) => (r.s_read + r_eq, r.s_read_usd + r_usd),
            None => (r_eq, r_usd),
        };
    }
}

/// `Usage` como array de 7 números (índice más pequeño).
mod usage_arr {
    use super::Usage;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<S: Serializer>(u: &Usage, s: S) -> Result<S::Ok, S::Error> {
        [u.input, u.cache_create, u.cache_5m, u.cache_1h, u.cache_read, u.output, u.thinking].serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Usage, D::Error> {
        let a = <[u64; 7]>::deserialize(d)?;
        Ok(Usage { input: a[0], cache_create: a[1], cache_5m: a[2], cache_1h: a[3], cache_read: a[4], output: a[5], thinking: a[6] })
    }
}

/// Un bloque que entra al contexto (los de salida y thinking van siempre agregados).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Block {
    #[serde(rename = "c")]
    pub cat: Cat,
    /// Herramienta (Read, Bash, mcp__srv__tool…) o tipo de adjunto.
    #[serde(rename = "h", skip_serializing_if = "Option::is_none", default)]
    pub tool: Option<String>,
    /// Ruta (Read), comando (Bash, ≤80), patrón, tipo de subagente… Nunca contenido.
    #[serde(rename = "d", skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
    /// Índice de la petición en la que entra.
    #[serde(rename = "r")]
    pub req: u32,
    #[serde(rename = "n")]
    pub chars: u64,
    /// Tokens estimados.
    pub t: u64,
}

/// Agregado de los bloques pequeños de un tramo y categoría (para no guardarlos uno a uno).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SmallAgg {
    #[serde(rename = "g")]
    seg: u32,
    #[serde(rename = "c")]
    cat: Cat,
    #[serde(rename = "k")]
    count: u64,
    t: u64,
    /// Parte fija del coste (escritura y, en salida/thinking, la generación).
    #[serde(rename = "f")]
    fixed: f64,
    #[serde(rename = "fu")]
    fixed_usd: f64,
    /// Σ t·S_lectura(k) al entrar: el coste de lectura es t·S_final − esto.
    #[serde(rename = "s")]
    ts: f64,
    #[serde(rename = "su")]
    ts_usd: f64,
}

/// Coste de una categoría en una hora y un modelo: escritura de lo que entró, relecturas de lo que ya estaba y
/// generación. De aquí salen TODOS los repartos recortados a un periodo (la suma de las celdas de un fichero es
/// exactamente la suma de los costes de sus bloques; lo comprueba `celdas_cuadran_con_los_bloques`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Cell {
    /// Hora epoch UTC (ts / 3600).
    h: u64,
    /// Índice en `Analysis::cell_models`.
    m: u16,
    c: Cat,
    /// Bloques que entraron (no cuenta relecturas).
    k: u64,
    t: u64,
    e: f64,
    u: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    Compaction,
    CacheBroken,
    ColdStart,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BreakCause {
    /// Hueco mayor que el TTL de la caché.
    Expired,
    ModelChanged,
    /// El prefijo cambió (herramientas, sistema, historia editada…).
    PrefixChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub kind: EventKind,
    /// Petición afectada (para la compactación, la primera después).
    pub req: u32,
    pub ts: u64,
    /// Compactación: tokens antes; caché rota: tokens reescritos sin explicación; arranque: contexto.
    pub tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cause: Option<BreakCause>,
    /// Compactación: tokens después. Caché rota: segundos de hueco.
    #[serde(default)]
    pub extra: u64,
    /// Sobrecoste estimado (caché rota: reescribir en vez de leer), en tokens de entrada equivalentes.
    #[serde(default)]
    pub cost: f64,
}

/// Bloque visto pero aún sin petición que lo cuente.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pending {
    cat: Cat,
    tool: Option<String>,
    detail: Option<String>,
    chars: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ToolCall {
    name: String,
    detail: Option<String>,
}

/// Peso en caracteres de una imagen (no se cuentan los bytes en base64): ~1600 tokens × 4.
const IMG_CHARS: u64 = 6400;
/// Bloques por debajo de este tamaño se guardan agregados (el índice no crece con miles de bloques diminutos).
const SMALL_T: u64 = 400;
/// Caché rota: lo reescrito sin explicación tiene que pasar de esto y del 20 % del contexto.
const BREAK_MIN: u64 = 4000;

/// Estado del analizador de un fichero. Se puede guardar y seguir más tarde (incremental).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    /// Bytes ya procesados (siempre al final de una línea completa).
    pub offset: u64,
    pub lines: u64,
    pub bad_lines: u64,
    pub requests: Vec<Request>,
    pub blocks: Vec<Block>,
    small: Vec<SmallAgg>,
    pub events: Vec<Event>,
    /// Desglose de la base (lo que había antes de la primera petición): (etiqueta, caracteres).
    pub base_parts: Vec<(String, u64)>,
    /// Tokens de contexto que desaparecieron sin compactación (edición de contexto, thinking descartado).
    pub shrink: u64,
    /// `permissionMode` de las entradas del usuario: (modo, veces).
    #[serde(default)]
    pub perms: Vec<(String, u64)>,
    /// Índice de la petición siguiente a cada mensaje escrito (no resultados de herramienta): el primero es el encargo;
    /// en un subagente, los siguientes son mensajes que llegaron después (SendMessage).
    #[serde(default)]
    pub user_turns: Vec<u32>,
    /// Coste por (hora, modelo, categoría): ver `Cell`.
    #[serde(default)]
    cells: Vec<Cell>,
    #[serde(default)]
    cell_models: Vec<String>,
    /// Tokens vivos por categoría en el tramo actual (se releen en cada petición nueva del tramo).
    #[serde(default)]
    alive: Vec<(Cat, u64)>,
    #[serde(default)]
    alive_seg: u32,
    seg: u32,
    pending: Vec<Pending>,
    /// Hora de la última línea no-asistente (inicio aproximado de la próxima petición).
    last_input_ts: u64,
    tools: HashMap<String, ToolCall>,
    /// Compactación vista y aún sin petición posterior: (preTokens, postTokens, ts).
    compact_pending: Option<(u64, u64, u64)>,
    /// `message.id` de la última petición (para deduplicar aunque el mensaje quede partido entre dos lecturas).
    last_id: String,
    /// Fichero de subagente: sus líneas son todas sidechain y cuentan.
    sidechain_ok: bool,
    /// Pesos de las peticiones calculados (no van al índice).
    #[serde(skip)]
    hydrated: bool,
}

// ───────────────────────────── líneas del jsonl ─────────────────────────────

#[derive(Deserialize, Default)]
#[serde(default)]
struct Line {
    #[serde(rename = "type")]
    kind: String,
    subtype: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "isSidechain")]
    is_sidechain: bool,
    #[serde(rename = "isMeta")]
    is_meta: bool,
    #[serde(rename = "isCompactSummary")]
    is_compact_summary: bool,
    message: Option<Msg>,
    attachment: Option<Att>,
    rendered: Option<Vec<Rendered>>,
    #[serde(rename = "compactMetadata")]
    compact: Option<CompactMeta>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    uuid: Option<String>,
    #[serde(rename = "permissionMode")]
    permission_mode: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Msg {
    id: Option<String>,
    model: Option<String>,
    content: Value,
    usage: Option<RawUsage>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_creation: Option<RawCacheCreation>,
    output_tokens_details: Option<RawOutDetails>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawCacheCreation {
    ephemeral_5m_input_tokens: Option<u64>,
    ephemeral_1h_input_tokens: Option<u64>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawOutDetails {
    thinking_tokens: Option<u64>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Att {
    #[serde(rename = "type")]
    kind: String,
    /// `invoked_skills`: las skills cargadas (C11: el consejo dice su nombre, no «invoked_skills»).
    #[serde(default)]
    skills: Vec<AttSkill>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct AttSkill {
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Rendered {
    content: Value,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct CompactMeta {
    #[serde(rename = "preTokens")]
    pre: u64,
    #[serde(rename = "postTokens")]
    post: u64,
}

fn usage_of(u: &RawUsage) -> Usage {
    let cc = u.cache_creation.as_ref();
    Usage {
        input: u.input_tokens.unwrap_or(0),
        cache_create: u.cache_creation_input_tokens.unwrap_or(0),
        cache_5m: cc.and_then(|c| c.ephemeral_5m_input_tokens).unwrap_or(0),
        cache_1h: cc.and_then(|c| c.ephemeral_1h_input_tokens).unwrap_or(0),
        cache_read: u.cache_read_input_tokens.unwrap_or(0),
        output: u.output_tokens.unwrap_or(0),
        thinking: u.output_tokens_details.as_ref().and_then(|d| d.thinking_tokens).unwrap_or(0),
    }
}

/// Primeros `n` caracteres, en una línea.
/// Primeros `n` caracteres en una línea; si corta, acaba en «…» (el anonimizador quita el trozo de ruta cortado).
fn clip(s: &str, n: usize) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= n {
        return one;
    }
    one.chars().take(n - 1).chain(std::iter::once('…')).collect()
}

/// Como `clip` pero se queda con el final (en una ruta, lo que distingue un fichero de otro es el final).
fn clip_tail(s: &str, n: usize) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let len = one.chars().count();
    if len <= n {
        return one;
    }
    std::iter::once('…').chain(one.chars().skip(len - (n - 1))).collect()
}

fn text_len(v: &Value) -> (u64, u64) {
    // (caracteres de texto, imágenes)
    match v {
        Value::String(s) => (s.len() as u64, 0),
        Value::Array(a) => a.iter().fold((0, 0), |(c, i), b| match b["type"].as_str() {
            Some("image") => (c, i + 1),
            Some("text") => (c + b["text"].as_str().map_or(0, |s| s.len() as u64), i),
            _ => (c + b.to_string().len() as u64, i),
        }),
        Value::Null => (0, 0),
        o => (o.to_string().len() as u64, 0),
    }
}

fn tool_cat(name: &str) -> Cat {
    match name {
        "Read" => Cat::Read,
        "Bash" | "PowerShell" => Cat::Bash,
        "Grep" | "Glob" => Cat::Search,
        "Agent" | "Task" => Cat::Subagent,
        n if n.starts_with("mcp__") => Cat::Mcp,
        _ => Cat::OtherTool,
    }
}

fn tool_detail(name: &str, input: &Value) -> Option<String> {
    let s = |k: &str| input[k].as_str().map(|x| clip(x, 80));
    let tail = |k: &str| input[k].as_str().map(|x| clip_tail(x, 80));
    match name {
        "Read" | "Edit" | "Write" | "NotebookEdit" => tail("file_path").or_else(|| tail("notebook_path")),
        "Bash" | "PowerShell" => s("command"),
        "Grep" | "Glob" => s("pattern"),
        "Agent" | "Task" => {
            let k = input["subagent_type"].as_str().unwrap_or("agent");
            let d = input["description"].as_str().unwrap_or("");
            Some(clip(&format!("{k}: {d}"), 80))
        }
        "Skill" => s("skill"),
        "WebFetch" => s("url"),
        "WebSearch" => s("query"),
        _ => None,
    }
}

/// Categoría de un texto del «usuario»: lo que escribe la persona, o algo inyectado (recordatorios,
/// comandos, avisos de fin de un subagente en segundo plano).
fn user_text_cat(s: &str, base: Cat) -> Cat {
    if base != Cat::User {
        return base;
    }
    let t = s.trim_start();
    if t.starts_with("<task-notification>") {
        Cat::Subagent
    } else if t.starts_with("<system-reminder>") || t.starts_with("<command-") || t.starts_with("<local-command") || t.starts_with("Caveat:") {
        Cat::Reminder
    } else {
        Cat::User
    }
}

/// Vista previa (≤80 caracteres) de un texto inyectado (skill cargada, recordatorio, aviso). Lo que escribe la
/// persona no se guarda.
fn preview(cat: Cat, s: &str) -> Option<String> {
    (cat != Cat::User).then(|| clip(s, 80))
}

// ───────────────────────────── analizador ─────────────────────────────

impl Analysis {
    /// `sidechain_ok`: true para ficheros de subagente (todas sus líneas son sidechain).
    pub fn new(sidechain_ok: bool) -> Self {
        Analysis { sidechain_ok, hydrated: true, ..Default::default() }
    }

    /// Recalcula los pesos de las peticiones tras cargar del índice (misma aritmética, mismo resultado).
    pub fn rehydrate(&mut self) {
        if self.hydrated {
            return;
        }
        for i in 0..self.requests.len() {
            let (head, tail) = self.requests.split_at_mut(i);
            let r = &mut tail[0];
            r.weigh(head.last().filter(|p| p.seg == r.seg));
        }
        self.hydrated = true;
    }

    fn push_pending(&mut self, cat: Cat, tool: Option<String>, detail: Option<String>, chars: u64) {
        if chars > 0 {
            self.pending.push(Pending { cat, tool, detail, chars });
        }
    }

    /// Procesa una línea completa (sin el salto). Devuelve false si no es JSON válido.
    pub fn feed_line(&mut self, line: &str) -> bool {
        self.lines += 1;
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            return true;
        }
        // Copias de la petición (muy grandes) y otros registros que no son conversación.
        if line.starts_with(r#"{"type":"api-"#) || line.starts_with(r#"{"type":"file-history"#) {
            return true;
        }
        let v: Line = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                self.bad_lines += 1;
                return false;
            }
        };
        if v.is_sidechain && !self.sidechain_ok {
            return true;
        }
        let ts = v.timestamp.as_deref().and_then(crate::agents::iso_to_epoch).unwrap_or(0);
        match v.kind.as_str() {
            "assistant" => self.on_assistant(v, ts),
            "user" => {
                if let Some(m) = v.permission_mode.as_deref() {
                    let m = clip(m, 24);
                    match self.perms.iter_mut().find(|(k, _)| *k == m) {
                        Some(e) => e.1 += 1,
                        None => self.perms.push((m, 1)),
                    }
                }
                self.on_user(&v);
                if ts > 0 {
                    self.last_input_ts = ts;
                }
            }
            "attachment" => {
                if let Some(r) = &v.rendered {
                    let chars: u64 = r.iter().map(|x| text_len(&x.content).0).sum();
                    let kind = v
                        .attachment
                        .as_ref()
                        .map(|a| {
                            let names: Vec<&str> = a.skills.iter().map(|s| s.name.as_str()).filter(|n| !n.is_empty()).collect();
                            if names.is_empty() { a.kind.clone() } else { format!("skill {}", names.join(", ")) }
                        })
                        .unwrap_or_default();
                    self.push_pending(Cat::Reminder, Some(kind), None, chars);
                }
                if ts > 0 {
                    self.last_input_ts = ts;
                }
            }
            "system" if v.subtype.as_deref() == Some("compact_boundary") => {
                let (pre, post) = v.compact.as_ref().map(|c| (c.pre, c.post)).unwrap_or((0, 0));
                self.compact_pending = Some((pre, post, ts));
                // Lo que quedaba pendiente iba al contexto viejo: se descarta.
                self.pending.clear();
            }
            _ => {}
        }
        true
    }

    fn note_turn(&mut self, cat: Cat) {
        let k = self.requests.len() as u32;
        if cat == Cat::User && self.user_turns.last() != Some(&k) {
            self.user_turns.push(k);
        }
    }

    fn on_user(&mut self, v: &Line) {
        let Some(m) = &v.message else { return };
        let base_cat = if v.is_compact_summary {
            Cat::Compact
        } else if v.is_meta {
            Cat::Reminder
        } else {
            Cat::User
        };
        match &m.content {
            Value::String(s) => {
                let cat = user_text_cat(s, base_cat);
                self.note_turn(cat);
                self.push_pending(cat, None, preview(cat, s), s.len() as u64);
            }
            Value::Array(a) => {
                for b in a {
                    match b["type"].as_str() {
                        Some("tool_result") => {
                            let id = b["tool_use_id"].as_str().unwrap_or("");
                            let call = self.tools.remove(id);
                            let (name, detail) = match call {
                                Some(c) => (c.name, c.detail),
                                None => ("?".to_string(), None),
                            };
                            let cat = tool_cat(&name);
                            let (chars, imgs) = text_len(&b["content"]);
                            // Un resultado vacío también ocupa algo (la envoltura del bloque).
                            self.push_pending(cat, Some(name.clone()), detail.clone(), chars.max(20));
                            for _ in 0..imgs {
                                self.push_pending(Cat::Image, Some(name.clone()), detail.clone(), IMG_CHARS);
                            }
                        }
                        Some("image") => self.push_pending(Cat::Image, None, None, IMG_CHARS),
                        Some("text") => {
                            let s = b["text"].as_str().unwrap_or("");
                            let cat = user_text_cat(s, base_cat);
                            self.note_turn(cat);
                            self.push_pending(cat, None, preview(cat, s), s.len() as u64);
                        }
                        _ => {
                            let n = b.to_string().len() as u64;
                            self.push_pending(base_cat, None, None, n);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn on_assistant(&mut self, v: Line, ts: u64) {
        let Some(m) = v.message else { return };
        if let Value::Array(a) = &m.content {
            for b in a {
                if b["type"].as_str() == Some("tool_use") {
                    if let (Some(id), Some(name)) = (b["id"].as_str(), b["name"].as_str()) {
                        let detail = tool_detail(name, &b["input"]);
                        self.tools.insert(id.to_string(), ToolCall { name: name.to_string(), detail });
                    }
                }
            }
        }
        let Some(u) = m.usage.as_ref() else { return };
        let usage = usage_of(u);
        let id = m.id.or(v.request_id).or(v.uuid).unwrap_or_default();
        if let Some(last) = self.requests.last_mut() {
            if !id.is_empty() && self.last_id == id {
                last.usage.max_with(&usage);
                return;
            }
        }
        // Respuestas sintéticas (errores de API, límites): no son peticiones reales.
        if usage.is_zero() {
            return;
        }
        let model = m.model.unwrap_or_default();
        self.last_id = id;
        self.new_request(model, usage, ts);
    }

    fn new_request(&mut self, model: String, usage: Usage, ts: u64) {
        // Antes de abrir la petición nueva se cierra la anterior: ya se conoce su salida definitiva.
        let k = self.requests.len() as u32;
        let ctx = usage.context();
        let compacted = self.compact_pending.take();
        if compacted.is_some() && k > 0 {
            self.seg += 1;
        }
        let seg = self.seg;
        let prev = self.requests.last().cloned();
        let mut req = Request { ts, model: model.clone(), usage: usage.clone(), seg, w_write: 0.0, w_write_usd: 0.0, s_read: 0.0, s_read_usd: 0.0 };
        req.weigh(prev.as_ref().filter(|r| r.seg == seg));
        let p = price(&model, ctx);
        let r_eq = p.read / p.input;
        let w_write = req.w_write;
        let start_ts = if self.last_input_ts > 0 { self.last_input_ts } else { ts };
        // Relectura de lo que ya estaba en el contexto del tramo (lo de un tramo anterior ya no se lee).
        if self.alive_seg != seg {
            self.alive.clear();
            self.alive_seg = seg;
        }
        let r_usd = p.read / 1e6;
        let alive = std::mem::take(&mut self.alive);
        for &(cat, t) in &alive {
            self.add_cell(ts, &model, cat, 0, 0, t as f64 * r_eq, t as f64 * r_usd);
        }
        self.alive = alive;

        let pending = std::mem::take(&mut self.pending);
        match (&prev, compacted) {
            (None, _) => {
                // Primera petición: todo su contexto es la base fija.
                self.base_parts = pending
                    .iter()
                    .map(|p| (p.tool.clone().unwrap_or_else(|| format!("{:?}", p.cat).to_lowercase()), p.chars))
                    .collect();
                self.add_block(&req, k, Cat::Base, None, None, pending.iter().map(|p| p.chars).sum(), ctx);
                if usage.cache_read * 10 < ctx {
                    // Sobrecoste: escribir lo que no estaba en caché en vez de leerlo.
                    let cost = ctx.saturating_sub(usage.cache_read) as f64 * (w_write - r_eq).max(0.0);
                    self.events.push(Event { kind: EventKind::ColdStart, req: k, ts, tokens: ctx, cause: None, extra: 0, cost });
                }
            }
            (Some(pr), Some((pre, post, cts))) => {
                // Tras compactar se reescribe la base y entra el resumen.
                let base0 = self.blocks.iter().find(|b| b.cat == Cat::Base).map(|b| b.t).unwrap_or(0);
                let base_t = base0.min(ctx);
                self.add_block(&req, k, Cat::Base, Some("compact".into()), None, 0, base_t);
                self.spread(&req, k, pending, ctx - base_t, Cat::Compact);
                self.add_output_of(pr, &req, k, 0);
                // Sobrecoste: la petición siguiente reescribe todo su contexto (base + resumen) en vez de leerlo.
                let cost = ctx.saturating_sub(usage.cache_read) as f64 * (w_write - r_eq).max(0.0);
                self.events.push(Event { kind: EventKind::Compaction, req: k, ts: cts, tokens: pre, cause: None, extra: post, cost });
            }
            (Some(pr), None) => {
                let grow = ctx as i64 - pr.usage.context() as i64;
                if grow < 0 {
                    self.shrink += (-grow) as u64;
                }
                let grow = grow.max(0) as u64;
                // La salida anterior entra primero; si el contexto creció menos (thinking descartado), se recorta.
                let out_t = self.add_output_of(pr, &req, k, grow);
                self.spread(&req, k, pending, grow - out_t, Cat::Unattributed);
                // Caché rota: escritura de caché que no explica el contenido nuevo.
                let unexplained = usage.cache_create.saturating_sub(grow + 1024);
                if unexplained > BREAK_MIN && unexplained * 5 > ctx {
                    let ttl = if pr.usage.cache_1h > 0 || pr.usage.cache_5m == 0 { 3600 } else { 300 };
                    let gap = start_ts.saturating_sub(pr.ts);
                    let cause = if gap > ttl {
                        BreakCause::Expired
                    } else if pr.model != model {
                        BreakCause::ModelChanged
                    } else {
                        BreakCause::PrefixChanged
                    };
                    let cost = unexplained as f64 * (w_write - r_eq);
                    self.events.push(Event { kind: EventKind::CacheBroken, req: k, ts, tokens: unexplained, cause: Some(cause), extra: gap, cost });
                }
            }
        }
        self.requests.push(req);
    }

    /// Mete como bloques la salida (y el thinking) de la petición `pr`, que entra en `req`: como mucho
    /// `cap` tokens (si el contexto creció menos que la salida, sobra thinking descartado). Devuelve lo metido.
    /// El coste de generar se carga a la salida completa, entre o no en el contexto.
    fn add_output_of(&mut self, pr: &Request, req: &Request, k: u32, cap: u64) -> u64 {
        let p = price(&pr.model, pr.usage.context());
        let think_full = pr.usage.thinking.min(pr.usage.output);
        let out_full = pr.usage.output - think_full;
        let (mut think, mut out) = (think_full, out_full);
        if out + think > cap {
            let cut = out + think - cap;
            let dt = cut.min(think);
            think -= dt;
            out -= (cut - dt).min(out);
        }
        let gen_eq = p.output / p.input;
        let gen_usd = p.output / 1e6;
        self.add_block_fixed(req, k, Cat::Output, None, None, 0, out, out_full as f64 * gen_eq, out_full as f64 * gen_usd);
        self.add_block_fixed(req, k, Cat::Thinking, None, None, 0, think, think_full as f64 * gen_eq, think_full as f64 * gen_usd);
        out + think
    }

    /// Reparte `t` tokens entre los bloques pendientes por caracteres. Sin bloques → `fallback`.
    fn spread(&mut self, req: &Request, k: u32, pending: Vec<Pending>, t: u64, fallback: Cat) {
        let total: u64 = pending.iter().map(|p| p.chars).sum();
        if total == 0 {
            if t > 0 {
                self.add_block(req, k, fallback, None, None, 0, t);
            }
            return;
        }
        let mut given = 0u64;
        let n = pending.len();
        for (i, p) in pending.into_iter().enumerate() {
            let share = if i + 1 == n { t - given } else { ((t as u128 * p.chars as u128) / total as u128) as u64 };
            given += share;
            self.add_block(req, k, p.cat, p.tool, p.detail, p.chars, share);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn add_block(&mut self, req: &Request, k: u32, cat: Cat, tool: Option<String>, detail: Option<String>, chars: u64, t: u64) {
        self.add_block_fixed(req, k, cat, tool, detail, chars, t, 0.0, 0.0);
    }

    #[allow(clippy::too_many_arguments)]
    fn add_block_fixed(&mut self, req: &Request, k: u32, cat: Cat, tool: Option<String>, detail: Option<String>, chars: u64, t: u64, gen: f64, gen_usd: f64) {
        if t == 0 && gen == 0.0 {
            return;
        }
        let fixed = t as f64 * req.w_write + gen;
        let fixed_usd = t as f64 * req.w_write_usd + gen_usd;
        self.add_cell(req.ts, &req.model, cat, 1, t, fixed, fixed_usd);
        if t > 0 {
            match self.alive.iter_mut().find(|a| a.0 == cat) {
                Some(a) => a.1 += t,
                None => self.alive.push((cat, t)),
            }
        }
        // La salida y el thinking no salen en el top: siempre agregados.
        if (t >= SMALL_T || cat == Cat::Base) && cat != Cat::Output && cat != Cat::Thinking {
            self.blocks.push(Block { cat, tool, detail, req: k, chars, t });
        } else {
            let seg = req.seg;
            let i = match self.small.iter().position(|s| s.seg == seg && s.cat == cat) {
                Some(i) => i,
                None => {
                    self.small.push(SmallAgg { seg, cat, ..Default::default() });
                    self.small.len() - 1
                }
            };
            let s = &mut self.small[i];
            s.count += 1;
            s.t += t;
            s.fixed += fixed;
            s.fixed_usd += fixed_usd;
            s.ts += t as f64 * req.s_read;
            s.ts_usd += t as f64 * req.s_read_usd;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn add_cell(&mut self, ts: u64, model: &str, cat: Cat, k: u64, t: u64, e: f64, u: f64) {
        let m = match self.cell_models.iter().position(|x| x == model) {
            Some(i) => i,
            None => {
                self.cell_models.push(model.to_string());
                self.cell_models.len() - 1
            }
        } as u16;
        let h = ts / 3600;
        // Las celdas de la hora actual están al final: se busca solo en las últimas.
        let n = self.cells.len();
        if let Some(c) = self.cells[n.saturating_sub(48)..].iter_mut().rev().find(|c| c.h == h && c.m == m && c.c == cat) {
            c.k += k;
            c.t += t;
            c.e += e;
            c.u += u;
            return;
        }
        self.cells.push(Cell { h, m, c: cat, k, t, e, u });
    }

    /// Lee lo nuevo de `path` desde `self.offset`, línea a línea. Una línea a medias (el fichero se está
    /// escribiendo) se deja para la próxima vez. Devuelve los bytes leídos.
    pub fn feed_file(&mut self, path: &Path, cancel: Option<&AtomicBool>) -> std::io::Result<u64> {
        self.rehydrate();
        let mut f = File::open(path)?;
        let len = f.metadata()?.len();
        if len < self.offset {
            // El fichero se ha rehecho: se empieza de cero.
            *self = Analysis::new(self.sidechain_ok);
        }
        f.seek(SeekFrom::Start(self.offset))?;
        let mut r = BufReader::with_capacity(256 * 1024, f);
        let mut buf = Vec::with_capacity(64 * 1024);
        let start = self.offset;
        loop {
            if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                break;
            }
            buf.clear();
            let n = r.read_until(b'\n', &mut buf)?;
            if n == 0 || buf.last() != Some(&b'\n') {
                break;
            }
            self.offset += n as u64;
            match std::str::from_utf8(&buf) {
                Ok(s) => {
                    self.feed_line(s);
                }
                Err(_) => {
                    self.lines += 1;
                    self.bad_lines += 1;
                }
            }
        }
        Ok(self.offset - start)
    }

    /// S de lectura final de cada tramo.
    #[cfg(test)]
    fn seg_end(&self) -> HashMap<u32, (f64, f64)> {
        let mut m = HashMap::new();
        for r in &self.requests {
            m.insert(r.seg, (r.s_read, r.s_read_usd));
        }
        m
    }

    /// Coste (tokens de entrada equivalentes, USD) de un bloque.
    #[cfg(test)]
    pub fn block_cost(&self, b: &Block, ends: &HashMap<u32, (f64, f64)>) -> (f64, f64) {
        let r = &self.requests[b.req as usize];
        let (se, su) = ends.get(&r.seg).copied().unwrap_or((r.s_read, r.s_read_usd));
        let t = b.t as f64;
        (t * r.w_write + t * (se - r.s_read), t * r.w_write_usd + t * (su - r.s_read_usd))
    }

    /// Costes por categoría a partir de los bloques (forma lenta; los tests la comparan con las celdas).
    #[cfg(test)]
    pub fn cats_from_blocks(&self) -> Vec<CatAgg> {
        let ends = self.seg_end();
        let mut cats: HashMap<Cat, CatAgg> = HashMap::new();
        for b in &self.blocks {
            let (eq, usd) = self.block_cost(b, &ends);
            let c = cats.entry(b.cat).or_insert_with(|| CatAgg { cat: b.cat, ..Default::default() });
            c.count += 1;
            c.t += b.t;
            c.eq += eq;
            c.usd += usd;
        }
        for s in &self.small {
            let (se, su) = ends.get(&s.seg).copied().unwrap_or((0.0, 0.0));
            let c = cats.entry(s.cat).or_insert_with(|| CatAgg { cat: s.cat, ..Default::default() });
            c.count += s.count;
            c.t += s.t;
            c.eq += s.fixed + s.t as f64 * se - s.ts;
            c.usd += s.fixed_usd + s.t as f64 * su - s.ts_usd;
        }
        if let Some(last) = self.requests.last() {
            let p = price(&last.model, last.usage.context());
            let think = last.usage.thinking.min(last.usage.output);
            let out = last.usage.output - think;
            for (cat, n) in [(Cat::Output, out), (Cat::Thinking, think)] {
                if n > 0 {
                    let c = cats.entry(cat).or_insert_with(|| CatAgg { cat, ..Default::default() });
                    c.eq += n as f64 * p.output / p.input;
                    c.usd += n as f64 * p.output / 1e6;
                }
            }
        }
        let mut cats: Vec<CatAgg> = cats.into_values().collect();
        cats.sort_by_key(|c| c.cat);
        cats
    }

    /// Reparto del fichero recortado al periodo (horas desde `since`; `since` = 0 → todo). Sale de las celdas:
    /// categorías, modelos y horas suman exactamente lo mismo (`eq`, `usd`).
    pub fn slice(&self, since: u64) -> PeriodSlice {
        let h0 = since / 3600;
        let mut cats: HashMap<Cat, CatAgg> = HashMap::new();
        let mut models: HashMap<u16, (f64, f64)> = HashMap::new();
        let mut hours: HashMap<u64, (f64, f64, u64)> = HashMap::new();
        let mut hour_cat: HashMap<(u64, Cat), (f64, f64)> = HashMap::new();
        let mut add = |h: u64, m: u16, cat: Cat, k: u64, t: u64, e: f64, u: f64| {
            let hc = hour_cat.entry((h, cat)).or_default();
            hc.0 += e;
            hc.1 += u;
            let c = cats.entry(cat).or_insert_with(|| CatAgg { cat, ..Default::default() });
            c.count += k;
            c.t += t;
            c.eq += e;
            c.usd += u;
            let x = models.entry(m).or_default();
            x.0 += e;
            x.1 += u;
            let y = hours.entry(h).or_default();
            y.0 += e;
            y.1 += u;
        };
        for c in self.cells.iter().filter(|c| c.h >= h0) {
            add(c.h, c.m, c.c, c.k, c.t, c.e, c.u);
        }
        // La salida de la última petición no ha entrado aún en ningún contexto, pero ya se generó.
        if let Some(last) = self.requests.last().filter(|r| r.ts / 3600 >= h0) {
            let p = price(&last.model, last.usage.context());
            let think = last.usage.thinking.min(last.usage.output);
            let out = last.usage.output - think;
            let m = self.cell_models.iter().position(|x| *x == last.model).unwrap_or(u16::MAX as usize) as u16;
            for (cat, n) in [(Cat::Output, out), (Cat::Thinking, think)] {
                if n > 0 {
                    add(last.ts / 3600, m, cat, 0, 0, n as f64 * p.output / p.input, n as f64 * p.output / 1e6);
                }
            }
        }
        let mut usage = Usage::default();
        let mut requests = 0u64;
        let mut per_model: HashMap<&str, u64> = HashMap::new();
        for r in self.requests.iter().filter(|r| r.ts / 3600 >= h0) {
            requests += 1;
            usage.input += r.usage.input;
            usage.cache_create += r.usage.cache_create;
            usage.cache_5m += r.usage.cache_5m;
            usage.cache_1h += r.usage.cache_1h;
            usage.cache_read += r.usage.cache_read;
            usage.output += r.usage.output;
            usage.thinking += r.usage.thinking;
            *per_model.entry(r.model.as_str()).or_default() += 1;
            hours.entry(r.ts / 3600).or_default().2 += 1;
        }
        let mut cats: Vec<CatAgg> = cats.into_values().collect();
        cats.sort_by_key(|c| c.cat);
        let by_model = models
            .into_iter()
            .map(|(m, (e, u))| {
                let name = self.cell_models.get(m as usize).cloned().unwrap_or_default();
                let n = per_model.get(name.as_str()).copied().unwrap_or(0);
                (name, e, u, n)
            })
            .collect();
        let mut by_hour: Vec<(u64, f64, f64, u64)> = hours.into_iter().map(|(h, (e, u, n))| (h, e, u, n)).collect();
        by_hour.sort_by_key(|x| x.0);
        let mut by_hour_cat: Vec<(u64, Cat, f64, f64)> = hour_cat.into_iter().map(|((h, c), (e, u))| (h, c, e, u)).collect();
        by_hour_cat.sort_by_key(|x| (x.0, x.1));
        PeriodSlice { eq: cats.iter().map(|c| c.eq).sum(), usd: cats.iter().map(|c| c.usd).sum(), cats, by_model, by_hour, by_hour_cat, requests, usage }
    }

    /// Coste de cada bloque grande dentro del periodo: su escritura si entró en el periodo y las relecturas de
    /// las peticiones del periodo. `since` = 0 → coste entero (== `block_cost`).
    pub fn block_costs_in(&self, since: u64) -> Vec<(f64, f64)> {
        let h0 = since / 3600;
        // Peso de lectura acumulado de las peticiones del periodo (todas las peticiones, en orden).
        let mut acc = Vec::with_capacity(self.requests.len());
        let mut seg_last: HashMap<u32, usize> = HashMap::new();
        let (mut ae, mut au) = (0.0f64, 0.0f64);
        for (i, r) in self.requests.iter().enumerate() {
            let (pe, pu) = match i.checked_sub(1).map(|j| &self.requests[j]) {
                Some(q) if q.seg == r.seg => (q.s_read, q.s_read_usd),
                _ => (0.0, 0.0),
            };
            if r.ts / 3600 >= h0 {
                ae += r.s_read - pe;
                au += r.s_read_usd - pu;
            }
            acc.push((ae, au));
            seg_last.insert(r.seg, i);
        }
        self.blocks
            .iter()
            .map(|b| {
                let k = b.req as usize;
                let r = &self.requests[k];
                let last = seg_last.get(&r.seg).copied().unwrap_or(k);
                let t = b.t as f64;
                let (we, wu) = if r.ts / 3600 >= h0 { (r.w_write, r.w_write_usd) } else { (0.0, 0.0) };
                (t * we + t * (acc[last].0 - acc[k].0), t * wu + t * (acc[last].1 - acc[k].1))
            })
            .collect()
    }

    /// Bloques más caros dentro del periodo (sin base, salida ni thinking).
    pub fn top_in(&self, since: u64, top_n: usize) -> Vec<TopBlock> {
        let h0 = since / 3600;
        let costs = self.block_costs_in(since);
        // Relecturas dentro del periodo: peticiones del periodo acumuladas, y última petición de cada tramo.
        let mut cnt = Vec::with_capacity(self.requests.len());
        let mut seg_last: HashMap<u32, usize> = HashMap::new();
        let mut c = 0u32;
        for (i, r) in self.requests.iter().enumerate() {
            if r.ts / 3600 >= h0 {
                c += 1;
            }
            cnt.push(c);
            seg_last.insert(r.seg, i);
        }
        let mut scored: Vec<(f64, f64, &Block)> = self
            .blocks
            .iter()
            .zip(costs)
            .filter(|(b, (e, _))| *e > 0.0 && b.cat != Cat::Base && b.cat != Cat::Output && b.cat != Cat::Thinking)
            .map(|(b, (e, u))| (u, e, b))
            .collect();
        scored.sort_by(|a, b| b.0.total_cmp(&a.0));
        scored
            .into_iter()
            .take(top_n)
            .map(|(usd, eq, b)| {
                let k = b.req as usize;
                let rq = &self.requests[k];
                let last = seg_last.get(&rq.seg).copied().unwrap_or(k);
                let n = cnt[last] - cnt[k];
                let w = if rq.ts / 3600 >= h0 { rq.w_write } else { 0.0 };
                let t = b.t as f64;
                let r = if n > 0 && t > 0.0 { (eq - t * w) / (t * n as f64) } else { 0.0 };
                TopBlock {
                    cat: b.cat,
                    tool: b.tool.clone(),
                    detail: b.detail.clone(),
                    req: b.req,
                    ts: rq.ts,
                    t: b.t,
                    eq,
                    usd,
                    rereads: self.rereads(b.req),
                    w,
                    n,
                    r,
                    session: None,
                    who: None,
                }
            })
            .collect()
    }

    /// Resumen con costes (todo el fichero).
    pub fn summary(&self, top_n: usize) -> Summary {
        let sl = self.slice(0);
        let top = self.top_in(0, top_n);
        let total = sl.usage;
        let cats = sl.cats;
        let mut models: Vec<String> = Vec::new();
        for r in &self.requests {
            if !models.contains(&r.model) {
                models.push(r.model.clone());
            }
        }
        Summary {
            requests: self.requests.len() as u64,
            base: self.blocks.iter().find(|b| b.cat == Cat::Base).map(|b| b.t).unwrap_or(0),
            last_context: self.requests.last().map(|r| r.usage.context()).unwrap_or(0),
            max_context: self.requests.iter().map(|r| r.usage.context()).max().unwrap_or(0),
            usage: total,
            cats,
            top,
            events: self.events.clone(),
            models,
            bad_lines: self.bad_lines,
            shrink: self.shrink,
            first_ts: self.requests.first().map(|r| r.ts).unwrap_or(0),
            last_ts: self.requests.last().map(|r| r.ts).unwrap_or(0),
        }
    }

    /// Hechos del fichero para el motor de consejos (bloques grandes con su coste, contexto por petición…).
    pub fn facts(&self, session: &str, project: &str, who: &Who) -> consejos::FileFacts {
        self.facts_in(session, project, who, 0)
    }

    /// Hechos recortados al periodo (desde `since`): costes, bloques, eventos y peticiones del periodo. `reqs` sigue
    /// teniendo una entrada por petición (los índices `req` valen), con coste 0 fuera del periodo.
    pub fn facts_in(&self, session: &str, project: &str, who: &Who, since: u64) -> consejos::FileFacts {
        let h0 = since / 3600;
        let inp = |ts: u64| ts / 3600 >= h0;
        let sm = self.summary(0);
        let sl = self.slice(since);
        let costs = self.block_costs_in(since);
        let blocks = self
            .blocks
            .iter()
            .zip(costs)
            .filter(|(b, (e, _))| *e > 0.0 && matches!(b.cat, Cat::Read | Cat::Bash | Cat::Image | Cat::Reminder | Cat::Mcp | Cat::Search | Cat::OtherTool))
            .map(|(b, (eq, usd))| {
                consejos::FactBlock {
                    cat: b.cat,
                    tool: b.tool.clone(),
                    detail: b.detail.clone(),
                    req: b.req,
                    chars: b.chars,
                    t: b.t,
                    eq,
                    usd,
                    rereads: self.rereads(b.req),
                }
            })
            .collect();
        let mut per: HashMap<&str, u64> = HashMap::new();
        for r in &self.requests {
            *per.entry(r.model.as_str()).or_default() += 1;
        }
        let model = per.into_iter().max_by_key(|x| x.1).map(|x| x.0.to_string()).unwrap_or_default();
        let events = self
            .events
            .iter()
            .filter(|e| inp(e.ts))
            .map(|e| {
                let usd = self.requests.get(e.req as usize).map(|r| r.bill()).map_or(0.0, |(eq, usd)| if eq > 0.0 { e.cost * usd / eq } else { 0.0 });
                (e.clone(), usd)
            })
            .collect();
        // Coste de generar la salida y el thinking de las peticiones del periodo (sin escrituras ni relecturas).
        let (mut gen_out, mut gen_think) = ((0.0, 0.0), (0.0, 0.0));
        for r in self.requests.iter().filter(|r| inp(r.ts)) {
            let p = price(&r.model, r.usage.context());
            let th = r.usage.thinking.min(r.usage.output);
            let out = r.usage.output - th;
            gen_out.0 += out as f64 * p.output / p.input;
            gen_out.1 += out as f64 * p.output / 1e6;
            gen_think.0 += th as f64 * p.output / p.input;
            gen_think.1 += th as f64 * p.output / 1e6;
        }
        consejos::FileFacts {
            gen_out,
            gen_think,
            session: session.to_string(),
            project: project.to_string(),
            agent: who.agent_type.clone(),
            model,
            requests: sl.requests,
            base: sm.base,
            max_context: sm.max_context,
            first_ts: sm.first_ts,
            last_ts: sm.last_ts,
            eq: sl.eq,
            usd: sl.usd,
            output: sl.usage.output,
            thinking: sl.usage.thinking,
            cats: sl.cats,
            blocks,
            events,
            base_parts: self.base_parts.iter().map(|(k, c)| (k.clone(), c.div_ceil(4))).collect(),
            reqs: self
                .requests
                .iter()
                .map(|r| {
                    let (eq, usd) = if inp(r.ts) { r.bill() } else { (0.0, 0.0) };
                    (r.usage.context(), eq, usd)
                })
                .collect(),
            user_turns: self.user_turns.clone(),
            perms: self.perms.clone(),
        }
    }

    /// Peticiones posteriores del mismo tramo (veces que se relee un bloque que entra en `k`).
    fn rereads(&self, k: u32) -> u32 {
        let seg = self.requests[k as usize].seg;
        self.requests[k as usize + 1..].iter().take_while(|r| r.seg == seg).count() as u32
    }

    /// Σ t de los bloques (grandes y pequeños) de un tramo, base incluida.
    #[cfg(test)]
    pub fn attributed_tokens(&self, seg: u32) -> u64 {
        let big: u64 = self.blocks.iter().filter(|b| self.requests[b.req as usize].seg == seg).map(|b| b.t).sum();
        let small: u64 = self.small.iter().filter(|s| s.seg == seg).map(|s| s.t).sum();
        big + small
    }
}

// ───────────────────────────── resúmenes ─────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatAgg {
    pub cat: Cat,
    pub count: u64,
    /// Tokens que entraron al contexto.
    pub t: u64,
    /// Coste real en tokens de entrada equivalentes (del modelo de cada petición).
    pub eq: f64,
    /// Coste real en USD a precio de API (solo para comparar entre modelos; es suscripción).
    pub usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopBlock {
    pub cat: Cat,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
    pub req: u32,
    pub ts: u64,
    pub t: u64,
    pub eq: f64,
    pub usd: f64,
    /// Peticiones posteriores en las que se releyó.
    pub rereads: u32,
    /// Fórmula del coste (comprobable): eq = t × w + t × n × r. `w` = peso de escritura por token (0 si entró antes
    /// del periodo), `n` = relecturas dentro del periodo, `r` = peso medio de lectura de caché por token y relectura.
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub n: u32,
    #[serde(default)]
    pub r: f64,
    /// Fichero de la sesión (solo en el informe global).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub who: Option<String>,
}

/// Reparto de un fichero dentro de un periodo (ver `Analysis::slice`).
#[derive(Debug, Clone, Default)]
pub struct PeriodSlice {
    pub cats: Vec<CatAgg>,
    /// (modelo, eq, usd, peticiones).
    pub by_model: Vec<(String, f64, f64, u64)>,
    /// (hora epoch UTC, eq, usd, peticiones).
    pub by_hour: Vec<(u64, f64, f64, u64)>,
    /// (hora epoch UTC, categoría, eq, usd): las mismas celdas que `by_hour`, partidas por categoría.
    pub by_hour_cat: Vec<(u64, Cat, f64, f64)>,
    pub eq: f64,
    pub usd: f64,
    pub requests: u64,
    pub usage: Usage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub requests: u64,
    /// Contexto de la primera petición.
    pub base: u64,
    pub last_context: u64,
    pub max_context: u64,
    pub usage: Usage,
    pub cats: Vec<CatAgg>,
    pub top: Vec<TopBlock>,
    pub events: Vec<Event>,
    pub models: Vec<String>,
    pub bad_lines: u64,
    pub shrink: u64,
    pub first_ts: u64,
    pub last_ts: u64,
}

/// Quién hace las peticiones de un fichero.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Who {
    /// None = hilo principal.
    pub agent_type: Option<String>,
    pub description: Option<String>,
}

impl Who {
    fn label(&self) -> String {
        self.agent_type.clone().map(|t| format!("sub:{t}")).unwrap_or_else(|| "main".into())
    }
}

/// `agent-x.jsonl` → lee `agent-x.meta.json` (agentType, description). Fichero principal → `Who::default()`.
pub fn who_of(path: &Path) -> Who {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !name.starts_with("agent-") {
        return Who::default();
    }
    let meta = path.with_extension("meta.json");
    let v: Value = std::fs::read_to_string(meta).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    Who {
        agent_type: Some(v["agentType"].as_str().unwrap_or("agent").to_string()),
        description: v["description"].as_str().map(|d| clip(d, 80)),
    }
}

fn is_sub(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("agent-"))
}

/// Ficheros de subagente de una sesión: `<sesión>/subagents/**/agent-*.jsonl`.
pub fn subagent_files(session: &Path) -> Vec<PathBuf> {
    let dir = session.with_extension("").join("subagents");
    let mut out = Vec::new();
    let mut stack = vec![dir];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "jsonl") && is_sub(&p) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// Analiza un fichero entero, en streaming.
pub fn analyze_file(path: &Path) -> std::io::Result<Analysis> {
    let mut a = Analysis::new(is_sub(path));
    a.feed_file(path, None)?;
    Ok(a)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReport {
    pub path: String,
    pub who: Who,
    pub summary: Summary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReport {
    pub main: FileReport,
    /// Contexto por petición del hilo principal (para la línea de tamaño): (ts, contexto, tramo).
    pub context_line: Vec<(u64, u64, u32)>,
    pub base_parts: Vec<(String, u64)>,
    pub subagents: Vec<FileReport>,
    /// Consejos de la sesión (los pone el comando).
    pub advice: Vec<consejos::Consejo>,
    /// C11: ahorro si se aplican todos los consejos, sin doble conteo (usd, eq): `consejos::total_saving`.
    #[serde(default)]
    pub advice_total: (f64, f64),
    /// Bloques agrupados por origen (LA agregación de los consejos y del informe), los más caros.
    #[serde(default)]
    pub origins: Vec<consejos::Origen>,
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn session_report(path: &Path, top_n: usize) -> std::io::Result<SessionReport> {
    session_with_facts(path, top_n).map(|x| x.0)
}

/// Informe de una sesión y los hechos de sus ficheros (para los consejos de la sesión).
pub fn session_with_facts(path: &Path, top_n: usize) -> std::io::Result<(SessionReport, consejos::Facts)> {
    let a = analyze_file(path)?;
    let proj = project_of(path);
    let key = path.to_string_lossy().into_owned();
    let who = who_of(path);
    let mut facts = consejos::Facts { files: vec![a.facts(&key, &proj, &who)], history_bytes: None, session: true };
    let mut subagents = Vec::new();
    for p in subagent_files(path) {
        if let Ok(s) = analyze_file(&p) {
            let k = p.to_string_lossy().into_owned();
            let w = who_of(&p);
            facts.files.push(s.facts(&k, &proj, &w));
            subagents.push(FileReport { path: k, who: w, summary: s.summary(10) });
        }
    }
    let rep = SessionReport {
        main: FileReport { path: key, who, summary: a.summary(top_n) },
        context_line: a.requests.iter().map(|r| (r.ts, r.usage.context(), r.seg)).collect(),
        base_parts: a.base_parts.clone(),
        subagents,
        advice: Vec::new(),
        advice_total: (0.0, 0.0),
        origins: consejos::top_origins(&facts, ORIGINS_SHOWN),
    };
    Ok((rep, facts))
}

// ───────────────────────────── índice y escaneo ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexEntry {
    size: u64,
    mtime: u64,
    who: Who,
    analysis: Analysis,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Index {
    version: u32,
    files: HashMap<String, IndexEntry>,
}

const INDEX_VERSION: u32 = 5;

fn load_index(path: &Path) -> Index {
    let idx: Index = File::open(path)
        .ok()
        .and_then(|f| serde_json::from_reader(BufReader::new(f)).ok())
        .unwrap_or_default();
    if idx.version != INDEX_VERSION {
        return Index { version: INDEX_VERSION, files: HashMap::new() };
    }
    let mut idx = idx;
    for e in idx.files.values_mut() {
        e.analysis.rehydrate();
    }
    idx
}

fn save_index(path: &Path, idx: &Index) -> std::io::Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let f = File::create(&tmp)?;
        let mut w = std::io::BufWriter::new(f);
        serde_json::to_writer(&mut w, idx).map_err(std::io::Error::other)?;
        std::io::Write::flush(&mut w)?;
    }
    std::fs::rename(&tmp, path)
}

fn mtime_secs(md: &std::fs::Metadata) -> u64 {
    md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

/// Transcripts (principales y de subagente) modificados en los últimos `days` días, bajo las carpetas
/// `projects` de las cuentas dadas. Las cuentas comparten `projects` por junction: se deduplica por ruta canónica.
pub fn list_files(config_dirs: &[PathBuf], days: u64) -> Vec<(PathBuf, u64, u64)> {
    list_files_ex(config_dirs, days).0
}

/// `list_files` + si hay algún transcript más viejo que la ventana (para saber si el periodo anterior está entero).
pub fn list_files_ex(config_dirs: &[PathBuf], days: u64) -> (Vec<(PathBuf, u64, u64)>, bool) {
    let older = std::cell::Cell::new(false);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let since = now.saturating_sub(days * 86400);
    let mut roots: Vec<PathBuf> = Vec::new();
    for d in config_dirs {
        if let Ok(c) = std::fs::canonicalize(d.join("projects")) {
            if !roots.contains(&c) {
                roots.push(c);
            }
        }
    }
    let mut out = Vec::new();
    let take = |p: PathBuf, out: &mut Vec<(PathBuf, u64, u64)>| {
        if let Ok(md) = std::fs::metadata(&p) {
            let mt = mtime_secs(&md);
            if mt >= since {
                out.push((p, md.len(), mt));
            } else {
                older.set(true);
            }
        }
    };
    for root in roots {
        let Ok(projects) = std::fs::read_dir(&root) else { continue };
        for pr in projects.flatten() {
            let pdir = pr.path();
            let Ok(rd) = std::fs::read_dir(&pdir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().is_some_and(|x| x == "jsonl") {
                    take(p, &mut out);
                } else if p.is_dir() {
                    // Una carpeta de sesión vieja puede tener subagentes recientes: se miran siempre.
                    for s in subagent_files(&p.with_extension("jsonl")) {
                        take(s, &mut out);
                    }
                }
            }
        }
    }
    (out, older.get())
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub days: u64,
    /// Inicio del periodo (segundos epoch); el recorte es por horas enteras (ts / 3600 >= since / 3600).
    pub since: u64,
    /// Total del periodo (eq, usd): Σ categorías = Σ quién = Σ modelo = Σ proyecto = Σ horas.
    pub total: (f64, f64),
    /// Total del periodo anterior de la misma duración (para el Δ %).
    pub prev_total: (f64, f64),
    /// C10: true si hay datos de ANTES del periodo anterior (el anterior está entero). Si no, el Δ % compara con un
    /// periodo a medias (+8512 %) y la interfaz no lo enseña.
    #[serde(default)]
    pub prev_complete: bool,
    /// Sobrecoste por tipo de suceso: (expired|modelChanged|prefixChanged|coldStart|compaction, eq, usd, veces).
    pub event_cost: Vec<(String, f64, f64, u64)>,
    pub files: u64,
    pub main_files: u64,
    pub sub_files: u64,
    /// Ficheros que se han leído (enteros o solo lo añadido) en este escaneo.
    pub files_read: u64,
    pub bytes_read: u64,
    pub elapsed_ms: u64,
    pub cancelled: bool,
    pub requests: u64,
    pub bad_lines: u64,
    /// Tokens de contexto que desaparecieron sin compactación (ver `Analysis::shrink`).
    pub shrink: u64,
    pub usage: Usage,
    pub cats: Vec<CatAgg>,
    pub top: Vec<TopBlock>,
    /// Media de la base (contexto de la primera petición) del hilo principal y de los subagentes.
    pub base_mean_main: u64,
    pub base_mean_sub: u64,
    /// (quién: "main" o "sub:<tipo>", eq, usd, peticiones).
    pub by_who: Vec<(String, f64, f64, u64)>,
    /// (modelo, eq, usd, peticiones).
    pub by_model: Vec<(String, f64, f64, u64)>,
    /// Pesos de cada modelo del periodo, de la tabla `price` (para el (i) de la unidad): (modelo, lectura de caché,
    /// escritura 5 min, escritura 1 h, salida), todos en veces la entrada sin caché de ese modelo.
    pub model_weights: Vec<(String, f64, f64, f64, f64)>,
    pub compactions: u64,
    pub cache_breaks: u64,
    /// Caché rota por causa: (caducada, cambio de modelo, prefijo).
    pub break_causes: (u64, u64, u64),
    pub cold_starts: u64,
    /// Sobrecoste estimado de las cachés rotas (tokens de entrada equivalentes, USD).
    pub break_cost: (f64, f64),
    /// Factura por hora (hora epoch UTC = ts / 3600, eq, usd, peticiones). Solo peticiones dentro del periodo:
    /// la interfaz las agrupa en días locales.
    pub by_hour: Vec<(u64, f64, f64, u64)>,
    /// La misma factura por hora partida por categoría (hora, categoría, eq, usd): columnas apiladas por día.
    pub by_hour_cat: Vec<(u64, Cat, f64, f64)>,
    /// Factura por proyecto (carpeta bajo `projects`, p. ej. `C--Users-x-app`; eq, usd, peticiones), dentro del periodo.
    pub by_project: Vec<(String, f64, f64, u64)>,
    /// Entradas del índice quitadas en este escaneo (fichero borrado o sin tocar en más de `INDEX_MAX_AGE_DAYS`).
    pub pruned: u64,
    pub index_bytes: u64,
    /// Consejos del periodo (los pone el comando).
    pub advice: Vec<consejos::Consejo>,
    /// C11: ahorro si se aplican todos los consejos, sin doble conteo (usd, eq): `consejos::total_saving`.
    #[serde(default)]
    pub advice_total: (f64, f64),
    /// Bloques agrupados por origen (LA agregación de los consejos y del informe), los más caros.
    pub origins: Vec<consejos::Origen>,
    /// Bytes de todo el historial en disco (todas las fechas).
    pub history_bytes: u64,
}

/// Orígenes que se mandan a la pantalla (los más caros en USD y en eq).
pub const ORIGINS_SHOWN: usize = 40;

/// Días tras los que una entrada del índice sin tocar se quita.
pub const INDEX_MAX_AGE_DAYS: u64 = 90;

/// Quita del índice las entradas cuyo fichero ya no existe o cuyo mtime es anterior a `now − max_age_days`.
/// Devuelve cuántas quitó.
fn prune_index(idx: &mut Index, now: u64, max_age_days: u64) -> u64 {
    let since = now.saturating_sub(max_age_days * 86400);
    let before = idx.files.len();
    idx.files.retain(|k, e| e.mtime >= since && Path::new(k).exists());
    (before - idx.files.len()) as u64
}

/// Carpeta del proyecto (la que cuelga de `projects`) de un transcript.
pub fn project_of(path: &Path) -> String {
    let comps: Vec<String> = path.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    match comps.iter().rposition(|c| c.eq_ignore_ascii_case("projects")) {
        Some(i) if i + 1 < comps.len() => comps[i + 1].clone(),
        _ => String::new(),
    }
}

/// Mientras vive, el hilo actual corre con prioridad por debajo de lo normal (Windows); al soltarse la restaura.
/// El escaneo va en el pool de `spawn_blocking`, cuyos hilos se reutilizan: por eso se restaura.
pub struct LowPriority {
    #[cfg(windows)]
    prev: i32,
}

#[cfg(windows)]
mod prio {
    pub const THREAD_PRIORITY_BELOW_NORMAL: i32 = -1;
    pub const THREAD_PRIORITY_ERROR_RETURN: i32 = 0x7fff_ffff;
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetCurrentThread() -> isize;
        pub fn GetThreadPriority(h: isize) -> i32;
        pub fn SetThreadPriority(h: isize, p: i32) -> i32;
    }
}

impl LowPriority {
    pub fn enter() -> Self {
        #[cfg(windows)]
        unsafe {
            let h = prio::GetCurrentThread();
            let prev = prio::GetThreadPriority(h);
            let prev = if prev == prio::THREAD_PRIORITY_ERROR_RETURN { 0 } else { prev };
            prio::SetThreadPriority(h, prio::THREAD_PRIORITY_BELOW_NORMAL);
            LowPriority { prev }
        }
        #[cfg(not(windows))]
        LowPriority {}
    }
    /// Prioridad actual del hilo (Windows; 0 = normal, −1 = por debajo). Fuera de Windows, 0.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn current() -> i32 {
        #[cfg(windows)]
        unsafe {
            prio::GetThreadPriority(prio::GetCurrentThread())
        }
        #[cfg(not(windows))]
        0
    }
}

impl Drop for LowPriority {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            prio::SetThreadPriority(prio::GetCurrentThread(), self.prev);
        }
    }
}

/// Escanea, actualiza el índice (en `index_path`) y agrega. `progress(hechos, total)`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn scan(config_dirs: &[PathBuf], days: u64, index_path: &Path, cancel: &AtomicBool, progress: impl FnMut(u64, u64)) -> ScanReport {
    scan_full(config_dirs, days, index_path, cancel, progress).0
}

/// Como `scan`, y además los hechos de cada fichero para los consejos y el informe.
pub fn scan_full(
    config_dirs: &[PathBuf],
    days: u64,
    index_path: &Path,
    cancel: &AtomicBool,
    progress: impl FnMut(u64, u64),
) -> (ScanReport, consejos::Facts) {
    scan_period(config_dirs, days, None, index_path, cancel, progress)
}

/// Escaneo de un periodo: desde `since` (segundos epoch; p. ej. la medianoche local para «hoy») o, sin él, los
/// últimos `days` días. TODO sale recortado al periodo (por horas) desde las celdas de cada fichero: categorías,
/// quién, modelo, proyecto, horas, top y sucesos; `total` es la suma de todo y cada reparto suma `total`.
/// Lee también el periodo anterior de la misma duración para `prev_total`.
pub fn scan_period(
    config_dirs: &[PathBuf],
    days: u64,
    since: Option<u64>,
    index_path: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> (ScanReport, consejos::Facts) {
    let mut facts = consejos::Facts::default();
    let _prio = LowPriority::enter();
    let t0 = std::time::Instant::now();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let since = since.unwrap_or_else(|| now.saturating_sub(days * 86400)).min(now);
    // Periodo anterior de la misma duración (en horas enteras, como el recorte).
    let (h0, hn) = (since / 3600, now / 3600 + 1);
    let prev_since = h0.saturating_sub(hn - h0) * 3600;
    let list_days = (now - prev_since).div_ceil(86400).max(1);
    let mut idx = load_index(index_path);
    let (files, older) = list_files_ex(config_dirs, list_days);
    let total = files.len() as u64;
    let mut rep = ScanReport { days, since, prev_complete: older, ..Default::default() };
    let mut cats: HashMap<Cat, CatAgg> = HashMap::new();
    let mut top: Vec<TopBlock> = Vec::new();
    let mut by_who: HashMap<String, (f64, f64, u64)> = HashMap::new();
    let mut by_model: HashMap<String, (f64, f64, u64)> = HashMap::new();
    let mut by_hour: HashMap<u64, (f64, f64, u64)> = HashMap::new();
    let mut by_hour_cat: HashMap<(u64, Cat), (f64, f64)> = HashMap::new();
    let mut by_project: HashMap<String, (f64, f64, u64)> = HashMap::new();
    let mut ev_cost: HashMap<String, (f64, f64, u64)> = HashMap::new();
    let (mut base_main, mut n_main, mut base_sub, mut n_sub) = (0u64, 0u64, 0u64, 0u64);
    for (i, (p, size, mtime)) in files.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            rep.cancelled = true;
            break;
        }
        let key = p.to_string_lossy().into_owned();
        let entry = idx.files.entry(key.clone()).or_insert_with(|| IndexEntry {
            size: 0,
            mtime: 0,
            who: who_of(p),
            analysis: Analysis::new(is_sub(p)),
        });
        if entry.size != *size || entry.mtime != *mtime {
            if *size < entry.analysis.offset {
                entry.analysis = Analysis::new(is_sub(p));
            }
            if let Ok(n) = entry.analysis.feed_file(p, Some(cancel)) {
                rep.bytes_read += n;
                rep.files_read += 1;
            }
            entry.size = *size;
            entry.mtime = *mtime;
            if entry.who.agent_type.is_some() && entry.who.description.is_none() {
                entry.who = who_of(p); // el .meta.json puede llegar después
            }
        }
        let a = &entry.analysis;
        // Periodo anterior: solo su total (prev − actual = lo que hay entre prev_since y since).
        let prev = a.slice(prev_since);
        let s = a.slice(since);
        if !rep.prev_complete && a.slice(0).eq > prev.eq + 1e-9 {
            rep.prev_complete = true;
        }
        rep.prev_total.0 += prev.eq - s.eq;
        rep.prev_total.1 += prev.usd - s.usd;
        if s.requests == 0 && s.eq == 0.0 {
            progress(i as u64 + 1, total);
            continue;
        }
        rep.files += 1;
        let base = a.blocks.iter().find(|b| b.cat == Cat::Base).map(|b| b.t).unwrap_or(0);
        let who = entry.who.label();
        if entry.who.agent_type.is_some() {
            rep.sub_files += 1;
            if s.requests > 0 {
                base_sub += base;
                n_sub += 1;
            }
        } else {
            rep.main_files += 1;
            if s.requests > 0 {
                base_main += base;
                n_main += 1;
            }
        }
        rep.requests += s.requests;
        rep.bad_lines += a.bad_lines;
        rep.shrink += a.shrink;
        let u = &s.usage;
        rep.usage.input += u.input;
        rep.usage.cache_create += u.cache_create;
        rep.usage.cache_5m += u.cache_5m;
        rep.usage.cache_1h += u.cache_1h;
        rep.usage.cache_read += u.cache_read;
        rep.usage.output += u.output;
        rep.usage.thinking += u.thinking;
        for c in &s.cats {
            let g = cats.entry(c.cat).or_insert_with(|| CatAgg { cat: c.cat, ..Default::default() });
            g.count += c.count;
            g.t += c.t;
            g.eq += c.eq;
            g.usd += c.usd;
        }
        rep.total.0 += s.eq;
        rep.total.1 += s.usd;
        let w = by_who.entry(who.clone()).or_default();
        w.0 += s.eq;
        w.1 += s.usd;
        w.2 += s.requests;
        for (m, e, u, n) in &s.by_model {
            let x = by_model.entry(m.clone()).or_default();
            x.0 += e;
            x.1 += u;
            x.2 += n;
        }
        for &(h, e, u, n) in &s.by_hour {
            let x = by_hour.entry(h).or_default();
            x.0 += e;
            x.1 += u;
            x.2 += n;
        }
        for &(h, c, e, u) in &s.by_hour_cat {
            let x = by_hour_cat.entry((h, c)).or_default();
            x.0 += e;
            x.1 += u;
        }
        let proj = project_of(p);
        let x = by_project.entry(proj.clone()).or_default();
        x.0 += s.eq;
        x.1 += s.usd;
        x.2 += s.requests;
        facts.files.push(a.facts_in(&key, &proj, &entry.who, since));
        for e in a.events.iter().filter(|e| e.ts / 3600 >= h0) {
            let usd = match a.requests.get(e.req as usize).map(|r| r.bill()) {
                Some((eq, usd)) if eq > 0.0 => e.cost * usd / eq,
                _ => 0.0,
            };
            let kind = match (e.kind, &e.cause) {
                (EventKind::Compaction, _) => {
                    rep.compactions += 1;
                    "compaction"
                }
                (EventKind::ColdStart, _) => {
                    rep.cold_starts += 1;
                    "coldStart"
                }
                (EventKind::CacheBroken, cause) => {
                    rep.cache_breaks += 1;
                    rep.break_cost.0 += e.cost;
                    rep.break_cost.1 += usd;
                    match cause {
                        Some(BreakCause::Expired) => {
                            rep.break_causes.0 += 1;
                            "expired"
                        }
                        Some(BreakCause::ModelChanged) => {
                            rep.break_causes.1 += 1;
                            "modelChanged"
                        }
                        _ => {
                            rep.break_causes.2 += 1;
                            "prefixChanged"
                        }
                    }
                }
            };
            let x = ev_cost.entry(kind.to_string()).or_default();
            x.0 += e.cost;
            x.1 += usd;
            x.2 += 1;
        }
        for mut b in a.top_in(since, 20) {
            b.session = Some(key.clone());
            b.who = Some(who.clone());
            top.push(b);
        }
        if top.len() > 400 {
            top.sort_by(|a, b| b.usd.total_cmp(&a.usd));
            top.truncate(50);
        }
        progress(i as u64 + 1, total);
    }
    rep.pruned = prune_index(&mut idx, now, INDEX_MAX_AGE_DAYS);
    idx.version = INDEX_VERSION;
    let _ = save_index(index_path, &idx);
    rep.index_bytes = std::fs::metadata(index_path).map(|m| m.len()).unwrap_or(0);
    top.sort_by(|a, b| b.usd.total_cmp(&a.usd));
    top.truncate(50);
    rep.top = top;
    let mut cats: Vec<CatAgg> = cats.into_values().collect();
    cats.sort_by_key(|c| c.cat);
    rep.cats = cats;
    rep.base_mean_main = if n_main > 0 { base_main / n_main } else { 0 };
    rep.base_mean_sub = if n_sub > 0 { base_sub / n_sub } else { 0 };
    let sorted = |m: HashMap<String, (f64, f64, u64)>| {
        let mut v: Vec<(String, f64, f64, u64)> = m.into_iter().map(|(k, (a, b, c))| (k, a, b, c)).collect();
        v.sort_by(|a, b| b.2.total_cmp(&a.2));
        v
    };
    rep.by_who = sorted(by_who);
    rep.by_model = sorted(by_model);
    rep.model_weights = rep
        .by_model
        .iter()
        .map(|(m, ..)| {
            let p = price(m, 0);
            (m.clone(), p.read / p.input, p.write_5m / p.input, p.write_1h / p.input, p.output / p.input)
        })
        .collect();
    rep.by_project = sorted(by_project);
    rep.event_cost = sorted(ev_cost);
    let mut h: Vec<(u64, f64, f64, u64)> = by_hour.into_iter().map(|(k, (a, b, c))| (k, a, b, c)).collect();
    h.sort_by_key(|x| x.0);
    rep.by_hour = h;
    let mut hc: Vec<(u64, Cat, f64, f64)> = by_hour_cat.into_iter().map(|((h, c), (e, u))| (h, c, e, u)).collect();
    hc.sort_by_key(|x| (x.0, x.1));
    rep.by_hour_cat = hc;
    rep.origins = consejos::top_origins(&facts, ORIGINS_SHOWN);
    rep.elapsed_ms = t0.elapsed().as_millis() as u64;
    (rep, facts)
}

/// Bytes de todos los ficheros bajo `projects` de las cuentas (todas las fechas; rutas canónicas sin repetir).
pub fn history_bytes(config_dirs: &[PathBuf]) -> u64 {
    let mut seen = std::collections::HashSet::new();
    let mut total = 0u64;
    for d in config_dirs {
        let root = d.join("projects");
        let Ok(canon) = std::fs::canonicalize(&root) else { continue };
        if !seen.insert(canon.clone()) {
            continue;
        }
        let mut stack = vec![canon];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() {
                    stack.push(e.path());
                } else if ft.is_file() {
                    total += e.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
    }
    total
}

/// Nombres de los servidores MCP configurados en las cuentas (`.claude.json`: global y por proyecto; y
/// `settings.json`). Solo nombres: nada de comandos, URLs ni variables.
pub fn mcp_servers(config_dirs: &[PathBuf]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut add = |v: &Value| {
        if let Some(o) = v.as_object() {
            for k in o.keys() {
                let k = clip(k, 40);
                if !names.contains(&k) {
                    names.push(k);
                }
            }
        }
    };
    for d in config_dirs {
        let mut files = vec![d.join(".claude.json"), d.join("settings.json")];
        if let Some(parent) = d.parent() {
            if d.file_name().is_some_and(|n| n == ".claude") {
                files.push(parent.join(".claude.json"));
            }
        }
        for f in files {
            let Ok(t) = std::fs::read_to_string(&f) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
            add(&v["mcpServers"]);
            if let Some(ps) = v["projects"].as_object() {
                for p in ps.values() {
                    add(&p["mcpServers"]);
                }
            }
        }
    }
    names.sort();
    names
}

/// Opciones de consejos e informe que manda la interfaz (o el MCP).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AdviceOpts {
    pub lang: String,
    pub dismissed: Vec<String>,
    pub thresholds: Option<consejos::Umbrales>,
}

impl AdviceOpts {
    pub fn run(&self, facts: &consejos::Facts) -> Vec<consejos::Consejo> {
        let set: std::collections::HashSet<String> = self.dismissed.iter().cloned().collect();
        consejos::advise(facts, &self.thresholds.clone().unwrap_or_default(), consejos::Lang::parse(&self.lang), &set)
    }
}

/// Entorno del informe: carpeta personal, nº de cuentas y MCP configurados.
pub fn report_env(config_dirs: &[PathBuf]) -> informe::Entorno {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    let users = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).into_iter().collect();
    informe::Entorno { home, users, accounts: config_dirs.len() as u64, mcp_servers: mcp_servers(config_dirs) }
}

/// Escanea (con el índice) y devuelve el informe Markdown. Lo usan el comando de la interfaz y el MCP.
pub fn usage_report(config_dirs: &[PathBuf], days: u64, index_path: &Path, detail: informe::Detalle, opts: &AdviceOpts) -> String {
    let cancel = AtomicBool::new(false);
    let (rep, mut facts) = scan_full(config_dirs, days, index_path, &cancel, |_, _| {});
    facts.history_bytes = Some(history_bytes(config_dirs));
    let advice = opts.run(&facts);
    informe::markdown(&facts, &rep, &advice, &report_env(config_dirs), consejos::Lang::parse(&opts.lang), detail)
}

// ───────────────────────────── comandos Tauri ─────────────────────────────

static CANCEL: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    done: u64,
    total: u64,
}

fn index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::store::base_dir(app).map(|d| d.join("consumo").join("index.json"))
}

/// ¿Es un transcript (.jsonl) bajo la carpeta `projects` de alguna de esas cuentas? (ruta canónica)
pub fn is_account_transcript(path: &Path, config_dirs: &[PathBuf]) -> bool {
    if path.extension().is_none_or(|x| x != "jsonl") {
        return false;
    }
    let Ok(canon) = std::fs::canonicalize(path) else { return false };
    config_dirs.iter().filter_map(|d| std::fs::canonicalize(d.join("projects")).ok()).any(|root| canon.starts_with(root))
}

/// Consumo de una sesión (y sus subagentes), leído del .jsonl en el momento. Solo transcripts de las cuentas (las
/// pruebas de los consejos de la vista global abren su sesión por ruta).
#[tauri::command]
pub async fn consumo_session(path: String, opts: Option<AdviceOpts>) -> Result<Option<SessionReport>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        if !is_account_transcript(p, &account_dirs()) {
            return Ok(None);
        }
        session_with_facts(p, 10)
            .map(|(mut r, f)| {
                r.advice = opts.unwrap_or_default().run(&f);
                consejos::cover_origins(&mut r.origins, &f, &r.advice);
                r.advice_total = consejos::total_saving(&f, &r.advice);
                Some(r)
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Guarda el informe en Descargas (o en la carpeta personal) como `orchestra-usage-<fecha>.md`; devuelve la ruta.
#[tauri::command]
pub fn consumo_save_report(markdown: String) -> Result<String, String> {
    if markdown.len() > 4 * 1024 * 1024 {
        return Err("report too large".into());
    }
    let home = PathBuf::from(std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map_err(|e| e.to_string())?);
    let dir = [home.join("Downloads"), home.clone()].into_iter().find(|d| d.is_dir()).ok_or("no folder to save to")?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let day = informe::day_of(now);
    let mut path = dir.join(format!("orchestra-usage-{day}.md"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("orchestra-usage-{day}-{n}.md"));
        n += 1;
    }
    std::fs::write(&path, markdown).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Escaneo global de los últimos `days` días (7 por defecto) de las cuentas dadas (todas si no se dan).
/// En segundo plano; emite `consumo-progress` {done, total}. Se cancela con `consumo_cancel`.
#[tauri::command]
pub async fn consumo_scan(
    app: tauri::AppHandle,
    days: Option<u64>,
    accounts: Option<Vec<String>>,
    opts: Option<AdviceOpts>,
    since: Option<u64>,
) -> Result<ScanReport, String> {
    use tauri::Emitter;
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A scan is already running".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    let idx = index_path(&app)?;
    let dirs: Vec<PathBuf> = match accounts {
        Some(a) if !a.is_empty() => a.into_iter().map(PathBuf::from).collect(),
        _ => crate::accounts::scan().into_iter().map(|p| PathBuf::from(p.dir)).collect(),
    };
    let r = tauri::async_runtime::spawn_blocking(move || {
        let mut last = std::time::Instant::now();
        let (mut rep, mut facts) = scan_period(&dirs, days.unwrap_or(7), since, &idx, &CANCEL, |done, total| {
            if done == total || last.elapsed().as_millis() > 200 {
                last = std::time::Instant::now();
                let _ = app.emit("consumo-progress", Progress { done, total });
            }
        });
        rep.history_bytes = history_bytes(&dirs);
        facts.history_bytes = Some(rep.history_bytes);
        rep.advice = opts.unwrap_or_default().run(&facts);
        consejos::cover_origins(&mut rep.origins, &facts, &rep.advice);
        rep.advice_total = consejos::total_saving(&facts, &rep.advice);
        rep
    })
    .await
    .map_err(|e| e.to_string());
    RUNNING.store(false, Ordering::SeqCst);
    r
}

/// Consumo de la sesión de un panel: `<dir>/projects/*/<id>.jsonl`. `dir` tiene que ser una cuenta guardada e `id` un UUID.
#[tauri::command]
pub async fn consumo_pane(app: tauri::AppHandle, dir: String, id: String, opts: Option<AdviceOpts>) -> Result<Option<SessionReport>, String> {
    let state = std::fs::read_to_string(crate::store::state_path(&app)?).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        if !crate::agents::is_session_id(&id) || !crate::store::is_account_dir(&state, &dir) {
            return Ok(None);
        }
        match crate::agents::find_transcript(Path::new(dir.trim()), &id) {
            Some(p) => session_with_facts(&p, 10)
                .map(|(mut r, f)| {
                    r.advice = opts.unwrap_or_default().run(&f);
                    consejos::cover_origins(&mut r.origins, &f, &r.advice);
                    r.advice_total = consejos::total_saving(&f, &r.advice);
                    Some(r)
                })
                .map_err(|e| e.to_string()),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Informe Markdown para pegar a una IA (mismo texto que la herramienta MCP `usage_report`).
#[tauri::command]
pub async fn consumo_report(app: tauri::AppHandle, days: Option<u64>, detail: Option<String>, opts: Option<AdviceOpts>) -> Result<String, String> {
    let idx = index_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _prio = LowPriority::enter();
        usage_report_guarded(&idx, days.unwrap_or(7), informe::Detalle::parse(detail.as_deref().unwrap_or("")), &opts.unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Carpetas de todas las cuentas de Claude.
pub fn account_dirs() -> Vec<PathBuf> {
    crate::accounts::scan().into_iter().map(|p| PathBuf::from(p.dir)).collect()
}

/// Informe con el índice de la app, si no hay otro escaneo en marcha (interfaz y MCP).
pub fn usage_report_guarded(index_path: &Path, days: u64, detail: informe::Detalle, opts: &AdviceOpts) -> Result<String, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A usage scan is already running in Orchestra; try again in a few seconds".into());
    }
    let r = usage_report(&account_dirs(), days.clamp(1, 90), index_path, detail, opts);
    RUNNING.store(false, Ordering::SeqCst);
    Ok(r)
}

#[tauri::command]
pub fn consumo_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

pub mod consejos;
pub mod informe;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod periodo_tests;
#[cfg(test)]
mod demo_gen;
#[cfg(test)]
mod coherencia_tests;
#[cfg(test)]
#[path = "consumo/invariantes_tests.rs"]
mod invariantes_tests;
