//! Observación de agentes (Claude Code, Codex, opencode) que corren dentro de los paneles.
//!
//! Enlace panel -> agente: el PTY tiene un pid; se recorre el árbol de procesos hasta
//! encontrar un `claude` cuyo pid tenga `<config>/sessions/<pid>.json`. De ahí salen el
//! estado (busy/idle/waiting), la sesión y su transcript. Solo se LEE; nunca se escribe en ~/.claude*.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use sysinfo::{ProcessesToUpdate, System};
use tauri::State;

use crate::pty::PtyManager;
use crate::tokens::{self, Tokens};

const TAIL_BYTES: u64 = 1_500_000;
const SUB_ACTIVE_SECS: u64 = 25;
/// Un subagente terminado se queda en la lista este rato (para ver que acabó) y luego desaparece.
const HIDE_DONE_SECS: u64 = 90;
/// Un subagente que su `.meta.json` da por vivo pero cuyo fichero no se toca desde hace este rato se da por muerto
/// (se mató la sesión o se cortó): sin esto se quedaría «activo» para siempre.
const SUB_STALE_SECS: u64 = 3600;
/// Largo máximo del último pedido que se manda a la interfaz (ella lo recorta otra vez para la ficha).
const PROMPT_CHARS: usize = 300;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub content: String,
    pub status: String,
    pub active_form: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sub {
    pub id: String,
    pub kind: String,
    pub description: String,
    /// "running" | "done"
    pub state: String,
    pub background: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub pane_id: String,
    /// "claude" | "codex" | "opencode"
    pub agent: String,
    pub pid: u32,
    pub session_id: Option<String>,
    pub name: Option<String>,
    pub title: Option<String>,
    pub cwd: Option<String>,
    /// "busy" | "idle" | "waiting" | "running"
    pub status: String,
    pub config_dir: Option<String>,
    pub current: Option<String>,
    pub ctx_tokens: u64,
    pub last_request_at: Option<u64>,
    pub cache_ttl: u64,
    /// Modelo de la última respuesta (p. ej. "claude-opus-5-5"), si se sabe.
    pub model: Option<String>,
    /// Último pedido del usuario (primera parte, ya recortada).
    pub last_prompt: Option<String>,
    /// Epoch (s) en que arrancó la sesión (`startedAt` de sessions/<pid>.json).
    pub started_at: Option<u64>,
    /// Herramienta que espera permiso cuando el estado es "waiting".
    pub waiting_for: Option<String>,
    /// Gasto de la sesión (hilo principal) y de sus subagentes.
    pub tokens: Tokens,
    pub sub_tokens: Tokens,
    pub todos: Vec<Todo>,
    pub subagents: Vec<Sub>,
}

// ---------- árbol de procesos ----------

fn descendants(sys: &System, root: u32) -> Vec<(u32, String)> {
    let mut kids: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, p) in sys.processes() {
        if let Some(pp) = p.parent() {
            kids.entry(pp.as_u32()).or_default().push(pid.as_u32());
        }
    }
    let mut out = Vec::new();
    let mut q = VecDeque::from([root]);
    let mut seen = HashSet::new();
    while let Some(pid) = q.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        let name = sys
            .process(sysinfo::Pid::from_u32(pid))
            .map(|p| p.name().to_string_lossy().to_lowercase())
            .unwrap_or_default();
        out.push((pid, name));
        if let Some(k) = kids.get(&pid) {
            q.extend(k.iter().copied());
        }
    }
    out
}

// ---------- transcript ----------

#[derive(Debug, Clone, Default)]
struct Call {
    id: String,
    kind: String,
    description: String,
    background: bool,
    agent_id: Option<String>,
    finished: bool,
    /// Epoch (s) en que Claude Code avisó del final (`<task-notification>`): fin exacto, sin adivinar por fechas de ficheros.
    done_at: Option<u64>,
    /// Llegó el aviso de fin: es definitivo (no se vuelve a «running» por una escritura tardía del fichero del subagente).
    notified: bool,
}

/// `<task-notification>` que Claude Code añade al transcript cuando termina un subagente en segundo plano:
/// devuelve (id de la llamada `Agent`, estado). Solo mira el principio del texto: el resumen puede ser largo.
fn parse_notification(txt: &str) -> Option<(String, String)> {
    let t = txt.trim_start();
    if !t.starts_with("<task-notification>") {
        return None;
    }
    let tag = |name: &str| -> Option<String> {
        let open = format!("<{name}>");
        let s = t.find(&open)? + open.len();
        let e = t[s..].find(&format!("</{name}>"))? + s;
        Some(t[s..e].trim().to_string())
    };
    Some((tag("tool-use-id")?, tag("status").unwrap_or_default()))
}

#[derive(Debug, Clone, Default)]
pub struct Parsed {
    pub title: Option<String>,
    pub current: Option<String>,
    pub ctx_tokens: u64,
    /// Epoch (s) de la última petición al modelo y TTL de su caché (3600 o 300).
    pub last_request_at: Option<u64>,
    pub cache_ttl: u64,
    pub todos: Vec<Todo>,
    /// Modelo de la última respuesta real (se ignoran las `<synthetic>`).
    pub model: Option<String>,
    /// Último pedido escrito por el usuario (sin resultados de herramientas, avisos ni comandos locales).
    pub last_prompt: Option<String>,
    calls: Vec<Call>,
}

/// Texto de un mensaje de usuario si es un pedido escrito por una persona; `None` para metadatos, avisos de
/// subagentes, mensajes de otras sesiones, resúmenes de compactación, comandos locales y resultados de herramientas.
fn human_prompt(v: &Value) -> Option<String> {
    if v["isMeta"].as_bool() == Some(true) || v["isCompactSummary"].as_bool() == Some(true) {
        return None;
    }
    if let Some(kind) = v["origin"]["kind"].as_str() {
        if kind != "human" {
            return None;
        }
    }
    let content = &v["message"]["content"];
    let txt = match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            if items.iter().any(|it| it["type"] == "tool_result") {
                return None;
            }
            items.iter().filter(|it| it["type"] == "text").filter_map(|it| it["text"].as_str()).collect::<Vec<_>>().join(" ")
        }
        _ => return None,
    };
    let t = txt.trim();
    if t.is_empty() || t.starts_with('<') || t.starts_with("[Request interrupted") {
        return None;
    }
    // Solo la primera línea con texto: basta para recordar de qué va.
    let first = t.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(t);
    Some(short(first, PROMPT_CHARS))
}

/// "2026-11-06T18:24:11.123Z" -> segundos epoch (UTC), sin dependencias.
pub fn iso_to_epoch(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19 { return None; }
    let n = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, m, d, hh, mm, ss) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?, n(17, 19)?);
    // días desde 1970-01-01 (algoritmo de Howard Hinnant)
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(days * 86400 + hh * 3600 + mm * 60 + ss).ok()
}

fn short(s: &str, n: usize) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > n {
        format!("{}…", one.chars().take(n).collect::<String>())
    } else {
        one
    }
}

fn base(p: &str) -> &str {
    p.rsplit(['\\', '/']).next().unwrap_or(p)
}

fn summarize(name: &str, input: &Value) -> String {
    let s = |k: &str| input[k].as_str().unwrap_or("");
    match name {
        "Bash" | "PowerShell" => format!("{name}: {}", short(s("command"), 70)),
        "Read" | "Write" | "Edit" | "NotebookEdit" => format!("{name}: {}", base(s("file_path"))),
        "Grep" | "Glob" => format!("{name}: {}", short(s("pattern"), 50)),
        "Agent" | "Task" => format!("subagent: {}", short(s("description"), 60)),
        "WebFetch" | "WebSearch" => format!("{name}: {}", short(&format!("{}{}", s("url"), s("query")), 60)),
        _ => name.to_string(),
    }
}

/// Interpreta las líneas de un transcript (puede empezar a mitad de sesión).
pub fn parse_transcript(text: &str) -> Parsed {
    let mut out = Parsed::default();
    let mut results: HashSet<String> = HashSet::new();
    let mut last_tool: Option<(String, String)> = None; // (id, resumen)
    for line in text.lines() {
        // Las líneas enormes que no aportan nada ni se deserializan.
        if line.starts_with(r#"{"type":"api-request"#)
            || line.starts_with(r#"{"type":"file-history"#)
            || line.starts_with(r#"{"type":"queue-operation"#)
        {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v["isSidechain"].as_bool() == Some(true) {
            continue;
        }
        match v["type"].as_str() {
            Some("ai-title") => out.title = v["aiTitle"].as_str().map(str::to_string),
            Some("assistant") => {
                if let Some(m) = v["message"]["model"].as_str() {
                    if !m.is_empty() && !m.starts_with('<') {
                        out.model = Some(m.to_string());
                    }
                }
                let u = &v["message"]["usage"];
                if u.is_object() {
                    out.last_request_at = v["timestamp"].as_str().and_then(iso_to_epoch);
                    out.cache_ttl = if u["cache_creation"]["ephemeral_5m_input_tokens"].as_u64().unwrap_or(0) > 0 { 300 } else { 3600 };
                    out.ctx_tokens = u["input_tokens"].as_u64().unwrap_or(0)
                        + u["cache_read_input_tokens"].as_u64().unwrap_or(0)
                        + u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                }
                for it in v["message"]["content"].as_array().into_iter().flatten() {
                    if it["type"] != "tool_use" {
                        continue;
                    }
                    let name = it["name"].as_str().unwrap_or("");
                    let id = it["id"].as_str().unwrap_or("").to_string();
                    let input = &it["input"];
                    last_tool = Some((id.clone(), summarize(name, input)));
                    match name {
                        "Agent" | "Task" => out.calls.push(Call {
                            id,
                            kind: input["subagent_type"].as_str().unwrap_or("agent").to_string(),
                            description: input["description"].as_str().unwrap_or("").to_string(),
                            background: input["run_in_background"].as_bool().unwrap_or(false),
                            ..Default::default()
                        }),
                        "TodoWrite" => {
                            out.todos = input["todos"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .map(|t| Todo {
                                    content: t["content"].as_str().unwrap_or("").to_string(),
                                    status: t["status"].as_str().unwrap_or("pending").to_string(),
                                    active_form: t["activeForm"].as_str().map(str::to_string),
                                })
                                .collect();
                        }
                        _ => {}
                    }
                }
            }
            Some("user") => {
                if let Some(p) = human_prompt(&v) {
                    out.last_prompt = Some(p);
                }
                // Aviso de fin de un subagente en segundo plano (texto suelto, no un tool_result).
                let content = &v["message"]["content"];
                let note = content
                    .as_str()
                    .and_then(parse_notification)
                    .or_else(|| content.as_array().into_iter().flatten().filter_map(|it| it["text"].as_str()).find_map(parse_notification));
                if let Some((call_id, status)) = note {
                    if status != "running" {
                        if let Some(c) = out.calls.iter_mut().find(|c| c.id == call_id) {
                            c.finished = true;
                            c.notified = true;
                            c.done_at = v["timestamp"].as_str().and_then(iso_to_epoch);
                        }
                    }
                }
                for it in v["message"]["content"].as_array().into_iter().flatten() {
                    if it["type"] != "tool_result" {
                        continue;
                    }
                    let Some(id) = it["tool_use_id"].as_str() else { continue };
                    results.insert(id.to_string());
                    if let Some(c) = out.calls.iter_mut().find(|c| c.id == id) {
                        let r = &v["toolUseResult"];
                        if let Some(a) = r["agentId"].as_str() {
                            c.agent_id = Some(a.to_string());
                        }
                        match r["status"].as_str() {
                            Some("async_launched") => c.background = true,
                            Some("completed") | Some("failed") => c.finished = true,
                            _ => {
                                if !c.background {
                                    c.finished = true;
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out.current = last_tool.and_then(|(id, s)| if results.contains(&id) { None } else { Some(s) });
    out
}

fn read_tail(path: &Path) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf).ok()?;
    let mut s = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        // La primera línea está cortada: se descarta.
        if let Some(i) = s.find('\n') {
            s.drain(..=i);
        }
    }
    Some(s)
}

type CacheKey = (SystemTime, u64);
static CACHE: OnceLock<Mutex<HashMap<PathBuf, (CacheKey, Parsed)>>> = OnceLock::new();

fn parsed_cached(path: &Path) -> Option<Parsed> {
    let md = std::fs::metadata(path).ok()?;
    let key = (md.modified().ok()?, md.len());
    let cache = CACHE.get_or_init(Default::default);
    if let Some((k, p)) = cache.lock().get(path) {
        if *k == key {
            return Some(p.clone());
        }
    }
    let p = parse_transcript(&read_tail(path)?);
    cache.lock().insert(path.to_path_buf(), (key, p.clone()));
    Some(p)
}

pub(crate) fn find_transcript(config_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let projects = config_dir.join("projects");
    let file = format!("{session_id}.jsonl");
    std::fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|e| e.path().join(&file))
        .find(|p| p.is_file())
}

fn subagents(parsed: &Parsed, transcript: &Path, session_id: &str) -> Vec<Sub> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    subagents_at(parsed, transcript, session_id, now)
}

/// Lo que Claude Code guarda junto a cada subagente en `subagents/agent-<id>.meta.json`.
#[derive(Debug, Clone, Default)]
struct Meta {
    agent_id: String,
    kind: String,
    description: String,
    tool_use_id: Option<String>,
    background: bool,
    finished: bool,
}

static META_CACHE: OnceLock<Mutex<HashMap<PathBuf, (CacheKey, Meta)>>> = OnceLock::new();

fn read_meta(path: &Path, agent_id: &str) -> Option<Meta> {
    let md = std::fs::metadata(path).ok()?;
    let key = (md.modified().ok()?, md.len());
    let cache = META_CACHE.get_or_init(Default::default);
    if let Some((k, m)) = cache.lock().get(path) {
        if *k == key {
            return Some(m.clone());
        }
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let m = Meta {
        agent_id: agent_id.to_string(),
        kind: v["agentType"].as_str().unwrap_or("agent").to_string(),
        description: v["description"].as_str().unwrap_or("").to_string(),
        tool_use_id: v["toolUseId"].as_str().map(str::to_string),
        background: v["requestShape"].as_str() == Some("background"),
        finished: v["finished"].as_bool().unwrap_or(false),
    };
    cache.lock().insert(path.to_path_buf(), (key, m.clone()));
    Some(m)
}

/// Todos los `.meta.json` de la carpeta de subagentes, en el orden en que se lanzaron (fecha de creación).
fn read_metas(dir: &Path) -> Vec<Meta> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut v: Vec<(SystemTime, Meta)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let id = name.strip_prefix("agent-")?.strip_suffix(".meta.json")?.to_string();
            if !crate::subtranscript::valid_id(&id) {
                return None;
            }
            let p = e.path();
            let born = e.metadata().ok().and_then(|m| m.created().or_else(|_| m.modified()).ok()).unwrap_or(SystemTime::UNIX_EPOCH);
            read_meta(&p, &id).map(|m| (born, m))
        })
        .collect();
    v.sort_by_key(|(t, _)| *t);
    v.into_iter().map(|(_, m)| m).collect()
}

fn subagents_at(parsed: &Parsed, transcript: &Path, session_id: &str, now: u64) -> Vec<Sub> {
    let dir = transcript.parent().map(|p| p.join(session_id).join("subagents"));
    let mut out: Vec<Sub> = Vec::new();
    let file_age_of = |a: &str| -> Option<u64> {
        let d = dir.as_ref()?;
        std::fs::metadata(d.join(format!("agent-{a}.jsonl"))).and_then(|m| m.modified()).ok()?.elapsed().ok().map(|e| e.as_secs())
    };
    // 1) Los `.meta.json`: cubren TODA la sesión (la transcripción solo se lee por el final) y dicen si ya acabó.
    let metas = dir.as_deref().map(read_metas).unwrap_or_default();
    let mut seen: HashSet<String> = HashSet::new();
    for m in &metas {
        let call = parsed.calls.iter().find(|c| m.tool_use_id.as_deref() == Some(c.id.as_str()) || c.agent_id.as_deref() == Some(m.agent_id.as_str()));
        if let Some(c) = call {
            seen.insert(c.id.clone());
        }
        let notified = call.is_some_and(|c| c.notified);
        let file_age = file_age_of(&m.agent_id);
        let running = !m.finished && !notified && file_age.is_some_and(|a| a < SUB_STALE_SECS);
        let ended_ago = if running { None } else { call.and_then(|c| c.done_at).map(|t| now.saturating_sub(t)).or(file_age) };
        if ended_ago.is_some_and(|s| s > HIDE_DONE_SECS) {
            continue;
        }
        out.push(Sub {
            id: m.agent_id.clone(),
            kind: m.kind.clone(),
            description: m.description.clone(),
            state: if running { "running" } else { "done" }.into(),
            background: m.background || call.is_some_and(|c| c.background),
        });
    }
    // 2) Llamadas de la transcripción sin `.meta.json` (aún no escrito, o versiones de Claude Code que no lo tienen).
    for c in parsed.calls.iter().filter(|c| !seen.contains(&c.id)) {
        if c.agent_id.as_ref().is_some_and(|a| metas.iter().any(|m| &m.agent_id == a)) {
            continue;
        }
        // Edad del fichero del subagente (última escritura), si se conoce.
        let file_age = c.agent_id.as_deref().and_then(file_age_of);
        let running = if c.notified {
            false // el aviso de fin manda: no hay que esperar a que «se enfríe» el fichero
        } else if c.agent_id.is_some() && dir.is_some() && (!c.finished || c.background) {
            file_age.is_some_and(|a| a < SUB_ACTIVE_SECS)
        } else {
            !c.finished
        };
        // Cuánto hace que terminó: por el aviso si lo hay; si no, por la fecha del fichero.
        let ended_ago = if running { None } else { c.done_at.map(|t| now.saturating_sub(t)).or(file_age) };
        if ended_ago.is_some_and(|s| s > HIDE_DONE_SECS) {
            continue; // terminó hace rato: ya no hace falta enseñarlo
        }
        out.push(Sub {
            id: c.agent_id.clone().unwrap_or_else(|| c.id.clone()),
            kind: c.kind.clone(),
            description: c.description.clone(),
            state: if running { "running" } else { "done" }.into(),
            background: c.background,
        });
    }
    // Todos los que corren + los 5 últimos terminados.
    let done: Vec<usize> = out.iter().enumerate().filter(|(_, s)| s.state == "done").map(|(i, _)| i).collect();
    let drop_n = done.len().saturating_sub(5);
    let drop: HashSet<usize> = done.into_iter().take(drop_n).collect();
    let mut i = 0;
    out.retain(|_| {
        i += 1;
        !drop.contains(&(i - 1))
    });
    out
}

// ---------- API ----------

/// Segundos entre 1601-01-01 (FILETIME de Windows) y 1970-01-01.
const FILETIME_EPOCH_SECS: u64 = 11_644_473_600;
/// Holgura entre el arranque del proceso según el sistema (segundos enteros) y el que apunta Claude Code.
const START_SLACK_SECS: u64 = 3;
/// Sin `procStart` (versiones viejas de Claude Code): `startedAt` se escribe poco después de arrancar el proceso.
const STARTED_AT_MAX_LAG_SECS: u64 = 600;

/// ¿Es el sessions/<pid>.json de ESTE proceso (arrancado en `proc_start`, epoch en s) y no de uno muerto con el mismo pid?
/// `procStart` = FILETIME (100 ns desde 1601) de la creación del proceso; si falta, `startedAt` (ms) no puede ser anterior
/// al arranque del proceso ni muy posterior. Sin proceso o sin ninguna de las dos marcas, no se fía.
pub(crate) fn session_file_fits(v: &Value, proc_start: Option<u64>) -> bool {
    let Some(ps) = proc_start else { return false };
    let ft = v["procStart"].as_str().and_then(|s| s.parse::<u64>().ok()).or_else(|| v["procStart"].as_u64());
    if let Some(ft) = ft {
        let secs = (ft / 10_000_000).saturating_sub(FILETIME_EPOCH_SECS);
        return secs.abs_diff(ps) <= START_SLACK_SECS;
    }
    match v["startedAt"].as_u64() {
        Some(ms) => {
            let s = ms / 1000;
            s + START_SLACK_SECS >= ps && s <= ps + STARTED_AT_MAX_LAG_SECS
        }
        None => false,
    }
}

fn scan_one(sys: &System, pane_id: &str, root_pid: u32, dirs: &[PathBuf]) -> Option<AgentInfo> {
    let tree = descendants(sys, root_pid);
    // Claude: algún pid del árbol con sessions/<pid>.json en alguna carpeta de cuenta.
    for (pid, _) in &tree {
        for dir in dirs {
            let f = dir.join("sessions").join(format!("{pid}.json"));
            let Ok(txt) = std::fs::read_to_string(&f) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&txt) else { continue };
            // Un sessions/<pid>.json huérfano (Claude muerto sin limpiar) con un pid que Windows ya ha dado a otro proceso
            // del panel haría que el panel «adoptase» la sesión de otro: solo vale si el archivo es de ESTE proceso.
            if !session_file_fits(&v, sys.process(sysinfo::Pid::from_u32(*pid)).map(|p| p.start_time())) {
                continue;
            }
            let sid = v["sessionId"].as_str().map(str::to_string);
            let mut info = AgentInfo {
                pane_id: pane_id.into(),
                agent: "claude".into(),
                pid: *pid,
                session_id: sid.clone(),
                name: v["name"].as_str().map(str::to_string),
                cwd: v["cwd"].as_str().map(str::to_string),
                status: v["status"].as_str().unwrap_or("idle").to_string(),
                config_dir: Some(dir.to_string_lossy().into_owned()),
                started_at: v["startedAt"].as_u64().map(|ms| ms / 1000),
                ..Default::default()
            };
            if let Some(sid) = sid {
                if let Some(tp) = find_transcript(dir, &sid) {
                    crate::subtranscript::track(pane_id, &tp, &sid);
                    info.tokens = tokens::session_tokens(&tp, true);
                    if let Some(d) = tp.parent().map(|d| d.join(&sid).join("subagents")) {
                        info.sub_tokens = tokens::subagents_tokens_cached(&d);
                    }
                    if let Some(p) = parsed_cached(&tp) {
                        info.subagents = subagents(&p, &tp, &sid);
                        info.title = p.title;
                        if info.status == "waiting" {
                            info.waiting_for = p.current.clone();
                        }
                        info.current = if info.status == "busy" { p.current } else { None };
                        info.model = p.model;
                        info.last_prompt = p.last_prompt;
                        info.ctx_tokens = p.ctx_tokens;
                        info.last_request_at = p.last_request_at;
                        info.cache_ttl = if p.cache_ttl == 0 { 3600 } else { p.cache_ttl };
                        info.todos = p.todos;
                    }
                }
            }
            return Some(info);
        }
    }
    // Claude ya arrancó pero aún no hay sesión (p. ej. espera «¿confías en esta carpeta?»).
    if let Some((pid, _)) = tree.iter().find(|(_, n)| n.starts_with("claude")) {
        return Some(AgentInfo {
            pane_id: pane_id.into(),
            agent: "claude".into(),
            pid: *pid,
            status: "new".into(),
            ..Default::default()
        });
    }
    detect_plain(&tree, pane_id)
}

/// Agentes sin sesión que observar (Codex, opencode): solo se detecta que corren, por el nombre del proceso.
/// opencode instalado con npm: el `opencode.cmd` lanza `opencode.exe` (binario propio, sin node) bajo el shell del panel;
/// Codex es `codex.exe` (y ayudantes `codex-*.exe`). Se mira el árbol completo del panel.
pub(crate) fn detect_plain(tree: &[(u32, String)], pane_id: &str) -> Option<AgentInfo> {
    for (agent, prefix) in [("codex", "codex"), ("opencode", "opencode")] {
        if let Some((pid, _)) = tree.iter().find(|(_, n)| n.starts_with(prefix)) {
            return Some(AgentInfo {
                pane_id: pane_id.into(),
                agent: agent.into(),
                pid: *pid,
                status: "running".into(),
                ..Default::default()
            });
        }
    }
    None
}

/// Devuelve el agente (si hay) de cada panel. Se consulta cada ~2 s desde la interfaz.
#[tauri::command]
pub async fn agent_scan(
    ptys: State<'_, PtyManager>,
    ids: Vec<String>,
    dirs: Vec<String>,
) -> Result<Vec<AgentInfo>, String> {
    let panes: Vec<(String, u32)> = ids
        .into_iter()
        .filter_map(|id| ptys.get(&id).and_then(|s| s.pid).map(|p| (id, p)))
        .collect();
    let dirs: Vec<PathBuf> = dirs.into_iter().map(PathBuf::from).collect();
    tauri::async_runtime::spawn_blocking(move || {
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        let found: Vec<AgentInfo> = panes
            .iter()
            .filter_map(|(id, pid)| scan_one(&sys, id, *pid, &dirs))
            .collect();
        // El visor de subagentes solo puede leer de los paneles que tienen agente ahora mismo.
        crate::subtranscript::retain_tracked(&found.iter().map(|a| a.pane_id.clone()).collect::<Vec<_>>());
        found
    })
    .await
    .map_err(|e| e.to_string())
}

/// UUID de sesión tal como lo escribe Claude (`[0-9a-f-]{36}`). Es lo único que se admite antes de usarlo como
/// nombre de archivo o como argumento de `claude --resume`.
pub(crate) fn is_session_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

/// ¿Existe `<dir>/projects/*/<id>.jsonl`? Solo se comprueba la existencia del archivo (no se lee). `dir` debe ser la
/// carpeta de una cuenta del estado guardado (`state_json`) e `id` un UUID de sesión; si no, `false`.
fn session_exists(state_json: &str, dir: &str, id: &str) -> bool {
    if !is_session_id(id) || !crate::store::is_account_dir(state_json, dir) {
        return false;
    }
    find_transcript(Path::new(dir.trim()), id).is_some()
}

/// ¿Sigue existiendo la transcripción de esta sesión de Claude? La interfaz lo pregunta antes de relanzar un panel con
/// `claude --resume <id>`: sin transcripción, `--resume` no encontraría nada y el panel arrancaría con un error.
#[tauri::command]
pub async fn claude_session_exists(app: tauri::AppHandle, dir: String, id: String) -> Result<bool, String> {
    let state = std::fs::read_to_string(crate::store::state_path(&app)?).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || session_exists(&state, &dir, &id))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(v: Value) -> String {
        v.to_string()
    }

    #[test]
    fn subagentes_tareas_y_actividad() {
        let l = [
            line(serde_json::json!({"type":"ai-title","aiTitle":"Gestor de terminales"})),
            line(serde_json::json!({"type":"assistant","isSidechain":false,"message":{
                "usage":{"input_tokens":2,"cache_read_input_tokens":1000,"cache_creation_input_tokens":300},
                "content":[
                  {"type":"tool_use","id":"a1","name":"Agent","input":{"description":"Revisar red","subagent_type":"critico","run_in_background":true}},
                  {"type":"tool_use","id":"a2","name":"Agent","input":{"description":"Medir fps","subagent_type":"peon"}},
                  {"type":"tool_use","id":"t1","name":"TodoWrite","input":{"todos":[
                      {"content":"Escribir parser","status":"completed","activeForm":"Escribiendo parser"},
                      {"content":"Probar","status":"in_progress","activeForm":"Probando"}]}},
                  {"type":"tool_use","id":"b1","name":"Bash","input":{"command":"cargo test"}}]}})),
            line(serde_json::json!({"type":"user","isSidechain":false,
                "toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"ag-1"},
                "message":{"content":[{"type":"tool_result","tool_use_id":"a1"}]}})),
            // lo de un subagente (sidechain) no cuenta
            line(serde_json::json!({"type":"assistant","isSidechain":true,"message":{"content":[
                {"type":"tool_use","id":"zz","name":"Bash","input":{"command":"ignorar"}}]}})),
            r#"{"type":"api-request-blob","hash":"x"}"#.into(),
        ]
        .join("\n");
        let p = parse_transcript(&l);
        assert_eq!(p.title.as_deref(), Some("Gestor de terminales"));
        assert_eq!(p.ctx_tokens, 1302);
        assert_eq!(p.todos.len(), 2);
        assert_eq!(p.todos[1].status, "in_progress");
        assert_eq!(p.current.as_deref(), Some("Bash: cargo test")); // b1 sin resultado
        assert_eq!(p.calls.len(), 2);
        assert!(p.calls[0].background && p.calls[0].agent_id.as_deref() == Some("ag-1"));
        assert!(!p.calls[1].finished); // a2 sigue en primer plano
        let subs = subagents(&p, Path::new("x/x.jsonl"), "s");
        assert_eq!(subs.iter().filter(|s| s.state == "running").count(), 1); // a2; ag-1 sin fichero => inactivo
        assert_eq!(subs[1].kind, "peon");
    }

    #[test]
    fn modelo_y_ultimo_pedido_del_usuario() {
        let l = [
            line(serde_json::json!({"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":"Arregla el login
y luego los tests"}})),
            line(serde_json::json!({"type":"assistant","message":{"model":"claude-opus-5-5","usage":{"input_tokens":1},"content":[]}})),
            // Nada de esto es un pedido de la persona:
            line(serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x"}]}})),
            line(serde_json::json!({"type":"user","isMeta":true,"message":{"content":"<system-reminder>hola</system-reminder>"}})),
            line(serde_json::json!({"type":"user","origin":{"kind":"task-notification"},"message":{"content":"<task-notification>
</task-notification>"}})),
            line(serde_json::json!({"type":"user","isMeta":true,"origin":{"kind":"peer"},"message":{"content":"Another Claude session sent a message"}})),
            line(serde_json::json!({"type":"user","isCompactSummary":true,"message":{"content":"This session is being continued"}})),
            line(serde_json::json!({"type":"user","message":{"content":"<command-name>/login</command-name>"}})),
            line(serde_json::json!({"type":"user","message":{"content":"[Request interrupted by user]"}})),
            // Una respuesta sintética no pisa el modelo real.
            line(serde_json::json!({"type":"assistant","message":{"model":"<synthetic>","content":[]}})),
        ]
        .join("
");
        let p = parse_transcript(&l);
        assert_eq!(p.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(p.last_prompt.as_deref(), Some("Arregla el login"));

        // El pedido más reciente gana, también en formato de lista con imagen; y se recorta.
        let largo = "palabra ".repeat(100);
        let l2 = [
            line(serde_json::json!({"type":"user","message":{"content":"primero"}})),
            line(serde_json::json!({"type":"user","message":{"content":[{"type":"image"},{"type":"text","text":largo}]}})),
        ]
        .join("
");
        let p2 = parse_transcript(&l2);
        let lp = p2.last_prompt.unwrap();
        assert!(lp.starts_with("palabra palabra") && lp.ends_with('…'));
        assert_eq!(lp.chars().count(), PROMPT_CHARS + 1);
        // Sin mensajes: nada inventado.
        let vacio = parse_transcript("");
        assert!(vacio.model.is_none() && vacio.last_prompt.is_none());
    }

    fn lineas_subagente_en_segundo_plano(con_aviso: Option<(&str, &str)>) -> String {
        let mut t = String::new();
        t.push_str(r#"{"type":"assistant","timestamp":"2026-11-06T18:00:00Z","message":{"usage":{"input_tokens":1},"content":[{"type":"tool_use","id":"toolu_A","name":"Agent","input":{"subagent_type":"obrero","description":"Haz algo"}}]}}"#);
        t.push('\n');
        t.push_str(r#"{"type":"user","timestamp":"2026-11-06T18:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_A"}]},"toolUseResult":{"status":"async_launched","agentId":"ag-9"}}"#);
        t.push('\n');
        if let Some((ts, status)) = con_aviso {
            let nota = format!(
                "<task-notification>\\n<task-id>ag-9</task-id>\\n<tool-use-id>toolu_A</tool-use-id>\\n<status>{status}</status>\\n<summary>Agent \\\"Haz algo\\\" finished</summary>\\n</task-notification>"
            );
            t.push_str(&format!(r#"{{"type":"user","timestamp":"{ts}","isSidechain":false,"message":{{"role":"user","content":"{nota}"}}}}"#));
            t.push('\n');
        }
        t
    }

    #[test]
    fn el_aviso_de_fin_cierra_el_subagente_al_instante() {
        let now = iso_to_epoch("2026-11-06T18:05:00Z").unwrap();
        // Sin aviso y sin fichero de subagente: no hay nada que diga que sigue vivo.
        let sin = parse_transcript(&lineas_subagente_en_segundo_plano(None));
        assert!(sin.calls[0].background && !sin.calls[0].notified);
        // Con aviso «completed» hace 10 s: terminado, y se sigue enseñando un rato.
        let con = parse_transcript(&lineas_subagente_en_segundo_plano(Some(("2026-11-06T18:04:50Z", "completed"))));
        assert!(con.calls[0].notified && con.calls[0].finished);
        let subs = subagents_at(&con, Path::new("x/x.jsonl"), "s", now);
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].state, "done");
        assert_eq!(subs[0].kind, "obrero");
    }

    #[test]
    fn un_subagente_terminado_hace_rato_desaparece_de_la_lista() {
        let now = iso_to_epoch("2026-11-06T18:30:00Z").unwrap();
        let p = parse_transcript(&lineas_subagente_en_segundo_plano(Some(("2026-11-06T18:04:50Z", "completed"))));
        assert!(subagents_at(&p, Path::new("x/x.jsonl"), "s", now).is_empty());
        // Un aviso que no es de fin (texto normal del usuario) no cierra nada.
        assert!(parse_notification("hola <task-notification> no empieza así").is_none());
        assert_eq!(
            parse_notification("<task-notification>\n<tool-use-id>toolu_Z</tool-use-id>\n<status>failed</status>\n</task-notification>"),
            Some(("toolu_Z".to_string(), "failed".to_string()))
        );
    }

    /// Sesión larga: los subagentes lanzados antes del trozo final de la transcripción salen por su `.meta.json`, y uno
    /// que lleva minutos sin escribir (esperando a un comando largo) sigue «activo» mientras su meta no diga `finished`.
    #[test]
    fn los_meta_json_cuentan_todos_los_subagentes_vivos() {
        let base = std::env::temp_dir().join(format!("orch-meta-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("s").join("subagents");
        std::fs::create_dir_all(&dir).unwrap();
        let meta = |id: &str, desc: &str, fin: bool, tu: &str| {
            let v = serde_json::json!({"agentType":"obrero","description":desc,"toolUseId":tu,"requestShape":"background","finished":fin});
            std::fs::write(dir.join(format!("agent-{id}.meta.json")), v.to_string()).unwrap();
            std::fs::write(dir.join(format!("agent-{id}.jsonl")), "{}\n").unwrap();
        };
        for i in 0..17 {
            meta(&format!("a{i:02}"), &format!("vivo {i}"), false, &format!("toolu_{i}"));
        }
        meta("b01", "acabado", true, "toolu_x");
        // La transcripción (su final) solo ve uno de los 17, y además sin fichero reciente según la regla vieja.
        let p = parse_transcript(&lineas_subagente_en_segundo_plano(None));
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let subs = subagents_at(&p, &base.join("s.jsonl"), "s", now);
        assert_eq!(subs.iter().filter(|s| s.state == "running").count(), 17);
        assert!(subs.iter().any(|s| s.description == "acabado" && s.state == "done"));
        assert!(subs.iter().all(|s| s.kind == "obrero" && s.background));
        // La llamada de la transcripción («ag-9», sin meta) no se pierde.
        assert!(subs.iter().any(|s| s.id == "ag-9"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Contra datos reales: `cargo test real -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_transcript_mas_reciente() {
        let home = std::env::var("USERPROFILE").unwrap();
        let projects = Path::new(&home).join(".claude").join("projects");
        let mut files: Vec<PathBuf> = std::fs::read_dir(projects)
            .unwrap()
            .flatten()
            .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
            .collect();
        files.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).unwrap());
        // La más reciente que tenga subagentes (si no hay ninguna, la más reciente).
        let con_agent = files
            .iter()
            .rev()
            .take(25)
            .find(|p| read_tail(p).is_some_and(|t| t.contains(r#""name":"Agent","input""#)));
        let f = con_agent.unwrap_or_else(|| files.last().unwrap());
        let t0 = std::time::Instant::now();
        let p = parse_transcript(&read_tail(f).unwrap());
        let sid = f.file_stem().unwrap().to_string_lossy().to_string();
        let subs = subagents(&p, f, &sid);
        eprintln!("archivo: {} ({} KB)", f.file_name().unwrap().to_string_lossy(), std::fs::metadata(f).unwrap().len() / 1024);
        eprintln!("parseo: {:?} | título: {:?} | ctx: {} | actual: {:?}", t0.elapsed(), p.title, p.ctx_tokens, p.current);
        eprintln!("llamadas Agent: {} | todos: {}", p.calls.len(), p.todos.len());
        eprintln!("modelo: {:?} | último pedido: {:?}", p.model, p.last_prompt);
        for s in subs.iter().rev().take(6) {
            eprintln!("  [{}] {} · {} (bg={})", s.state, s.kind, s.description, s.background);
        }
    }

    /// Enlace real sobre una sesión de Claude YA viva (no lanza nada, no gasta cuota):
    /// toma un claude.exe con sessions/<pid>.json, usa su proceso padre como si fuera el PTY de un
    /// panel y comprueba que scan_one lo encuentra con estado, título, tokens y subagentes.
    /// `cargo test real_claude_link -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_claude_link() {
        let home = std::env::var("USERPROFILE").unwrap();
        let dir = Path::new(&home).join(std::env::var("ORCH_REAL_DIR").unwrap_or(".claude".into()));
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        let mut probados = 0;
        for e in std::fs::read_dir(dir.join("sessions")).unwrap().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(pid) = name.strip_suffix(".json").and_then(|n| n.parse::<u32>().ok()) else { continue };
            let Some(p) = sys.process(sysinfo::Pid::from_u32(pid)) else { continue }; // fichero huérfano
            let Some(parent) = p.parent() else { continue };
            let t0 = std::time::Instant::now();
            let a = scan_one(&sys, "test", parent.as_u32(), std::slice::from_ref(&dir))
                .unwrap_or_else(|| panic!("no se encontró la sesión del pid {pid} desde su padre {parent}"));
            eprintln!(
                "pid {pid}: estado={} título={:?} ctx={} subagentes={} (activos {}) tokens: salida {} lectura {} | subagentes: salida {} ({:?})",
                a.status,
                a.title,
                a.ctx_tokens,
                a.subagents.len(),
                a.subagents.iter().filter(|s| s.state == "running").count(),
                a.tokens.output,
                a.tokens.cache_read,
                a.sub_tokens.output,
                t0.elapsed()
            );
            assert_eq!(a.agent, "claude");
            assert_eq!(a.pid, pid);
            assert!(a.session_id.is_some());
            probados += 1;
        }
        assert!(probados > 0, "no hay ninguna sesión de Claude viva con la que probar");
        eprintln!("sesiones vivas verificadas: {probados}");
    }

    #[test]
    fn fechas_iso() {
        assert_eq!(iso_to_epoch("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_to_epoch("2026-11-06T18:24:11.123Z"), Some(1793989451));
        assert_eq!(iso_to_epoch("2024-02-29T12:00:00Z"), Some(1709208000)); // bisiesto
        assert_eq!(iso_to_epoch("basura"), None);
    }

    #[test]
    fn linea_cortada_y_basura() {
        let p = parse_transcript("{\"type\":\"assis\n\nno json\n{\"type\":\"ai-title\",\"aiTitle\":\"ok\"}");
        assert_eq!(p.title.as_deref(), Some("ok"));
        assert!(p.current.is_none());
    }

    fn tree(names: &[&str]) -> Vec<(u32, String)> {
        names.iter().enumerate().map(|(i, n)| (100 + i as u32, n.to_string())).collect()
    }

    #[test]
    fn detecta_codex_y_opencode_en_el_arbol_del_panel() {
        // Panel con powershell -> opencode.exe (npm global: opencode.cmd lanza el binario propio).
        let a = detect_plain(&tree(&["powershell.exe", "conhost.exe", "opencode.exe"]), "p1").unwrap();
        assert_eq!((a.agent.as_str(), a.pid, a.status.as_str(), a.pane_id.as_str()), ("opencode", 102, "running", "p1"));
        // Con el shim por medio (cmd.exe -> opencode.exe).
        let a = detect_plain(&tree(&["powershell.exe", "cmd.exe", "opencode.exe"]), "p2").unwrap();
        assert_eq!(a.agent, "opencode");
        // Codex: el ejecutable y sus ayudantes.
        let a = detect_plain(&tree(&["powershell.exe", "codex.exe", "codex-code-mode-host.exe"]), "p3").unwrap();
        assert_eq!((a.agent.as_str(), a.pid), ("codex", 101));
        // Sin agente (un shell normal, node de otra cosa): nada.
        assert!(detect_plain(&tree(&["powershell.exe", "node.exe", "git.exe"]), "p4").is_none());
        assert!(detect_plain(&[], "p5").is_none());
        // Un agente no se confunde con el otro.
        assert_eq!(detect_plain(&tree(&["pwsh.exe", "opencode.exe"]), "p6").unwrap().agent, "opencode");
    }

    // ---------- claude_session_exists ----------

    const SID: &str = "0b1f6c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";

    fn fixture(tag: &str, with_transcript: bool) -> (PathBuf, String) {
        let d = std::env::temp_dir().join(format!("orch-resume-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let proj = d.join("acc").join("projects").join("C--work-demo");
        std::fs::create_dir_all(&proj).unwrap();
        if with_transcript {
            std::fs::write(proj.join(format!("{SID}.jsonl")), "{}
").unwrap();
        }
        let acc = d.join("acc");
        let state = serde_json::json!({ "accounts": [{ "id": "a1", "dir": acc.to_string_lossy() }] }).to_string();
        (d, state)
    }

    #[test]
    fn la_sesion_existe_si_hay_transcripcion_en_algun_proyecto() {
        let (d, state) = fixture("ok", true);
        let acc = d.join("acc");
        assert!(session_exists(&state, &acc.to_string_lossy(), SID));
        // Mismo resultado con otras barras y mayúsculas (como en `open_account_dir`).
        if cfg!(windows) {
            assert!(session_exists(&state, &acc.to_string_lossy().replace('\\', "/").to_uppercase(), SID));
        }
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn sin_transcripcion_no_existe() {
        let (d, state) = fixture("missing", false);
        assert!(!session_exists(&state, &d.join("acc").to_string_lossy(), SID));
        // Otro id (válido) que no esta en disco.
        let (d2, state2) = fixture("other", true);
        assert!(!session_exists(&state2, &d2.join("acc").to_string_lossy(), "ffffffff-ffff-ffff-ffff-ffffffffffff"));
        let _ = std::fs::remove_dir_all(d);
        let _ = std::fs::remove_dir_all(d2);
    }

    #[test]
    fn un_id_con_ruta_o_mal_formado_se_rechaza_sin_tocar_el_disco() {
        let (d, state) = fixture("badid", true);
        let acc = d.join("acc").to_string_lossy().into_owned();
        for bad in ["", "..", "../acc", "..\\..\\x", &format!("{SID}/.."), &format!("{SID}.jsonl"), "0B1F6C1E-2A3D-4E5F-8A9B-0C1D2E3F4A5B",
                    "0b1f6c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5", "0b1f6c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5bb", "0b1f6c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5g"] {
            assert!(!is_session_id(bad), "{bad}");
            assert!(!session_exists(&state, &acc, bad), "{bad}");
        }
        assert!(is_session_id(SID));
        let _ = std::fs::remove_dir_all(d);
    }

    /// Un sessions/<pid>.json huérfano cuyo pid ha reutilizado otro proceso del panel no da su sesión al panel
    /// (causa de que dos paneles acabasen con la sesión cruzada al reabrir).
    #[test]
    fn un_pid_reutilizado_no_hereda_la_sesion_de_un_claude_muerto() {
        let me = std::process::id();
        let d = std::env::temp_dir().join(format!("orch-reuse-{me}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("sessions")).unwrap();
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        let start = sys.process(sysinfo::Pid::from_u32(me)).unwrap().start_time();
        let ft = |s: u64| ((s + FILETIME_EPOCH_SECS) * 10_000_000 + 1_234_567).to_string();
        let put = |extra: &str| {
            let txt = format!(r#"{{"pid":{me},"sessionId":"{SID}","cwd":"C:\\x","status":"idle","kind":"interactive"{extra}}}"#);
            std::fs::write(d.join("sessions").join(format!("{me}.json")), txt).unwrap();
        };
        let dirs = [d.clone()];
        // Huérfano de un Claude que arrancó hace una hora con este mismo pid.
        put(&format!(r#","procStart":"{}","startedAt":{}"#, ft(start - 3600), (start - 3600) * 1000));
        assert!(scan_one(&sys, "p", me, &dirs).is_none(), "huérfano con procStart ajeno");
        // El de este proceso.
        put(&format!(r#","procStart":"{}","startedAt":{}"#, ft(start), start * 1000 + 800));
        assert_eq!(scan_one(&sys, "p", me, &dirs).and_then(|a| a.session_id).as_deref(), Some(SID));
        // Sin procStart (Claude Code viejo): manda startedAt.
        put(&format!(r#","startedAt":{}"#, (start - 3600) * 1000));
        assert!(scan_one(&sys, "p", me, &dirs).is_none(), "huérfano sin procStart");
        put(&format!(r#","startedAt":{}"#, start * 1000 + 1500));
        assert!(scan_one(&sys, "p", me, &dirs).is_some());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn la_marca_de_arranque_decide_si_el_archivo_es_del_proceso() {
        let v = |s: &str| serde_json::from_str::<Value>(s).unwrap();
        // Muestra real: pid 103544, procStart 134394905506739305 = 2026-11-18 15:49:10 UTC = epoch 1795016950.
        let real = v(r#"{"procStart":"134394905506739305","startedAt":1795016952878}"#);
        assert!(session_file_fits(&real, Some(1_795_016_950)));
        assert!(session_file_fits(&real, Some(1_795_016_952)));
        assert!(!session_file_fits(&real, Some(1_795_016_950 + 60)));
        assert!(!session_file_fits(&real, Some(1_795_016_950 - 3600)));
        assert!(!session_file_fits(&real, None), "sin proceso no se fía");
        assert!(!session_file_fits(&v("{}"), Some(1_795_016_950)), "sin marcas no se fía");
    }

    #[test]
    fn una_carpeta_que_no_es_de_cuenta_se_rechaza() {
        let (d, state) = fixture("notacc", true);
        // La carpeta existe y tiene la transcripcion, pero no es la de una cuenta guardada.
        let proj_parent = d.join("acc").join("projects");
        assert!(!session_exists(&state, &proj_parent.to_string_lossy(), SID));
        assert!(!session_exists(&state, &d.to_string_lossy(), SID));
        assert!(!session_exists(&state, &format!("{}/../acc", d.join("acc").to_string_lossy()), SID));
        assert!(!session_exists(&state, "", SID));
        assert!(!session_exists("no es json", &d.join("acc").to_string_lossy(), SID));
        let _ = std::fs::remove_dir_all(d);
    }
}
