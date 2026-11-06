//! Visor de solo lectura del transcript de un subagente (`<sesión>/subagents/agent-<id>.jsonl`).
//!
//! - La interfaz solo manda ids (panel + id del subagente); la ruta la deriva este módulo del agente que `agents.rs`
//!   ya está siguiendo (`track`), valida los ids y comprueba con `canonicalize` que el fichero queda dentro de `projects/`.
//! - Se lee de forma incremental por desplazamiento en bytes (nunca el fichero entero): la primera llamada devuelve solo
//!   el final (~100 eventos) y las siguientes lo añadido desde `next_offset`. Una línea a medio escribir se deja para la
//!   siguiente llamada (el desplazamiento no avanza más allá de la última línea completa).
//! - Nunca se devuelven las líneas JSON en bruto: solo `SubEvent` (tipo, texto recortado, herramienta, resumen, fecha).

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

/// Tope de bytes que se leen por llamada.
pub const CHUNK_BYTES: u64 = 256 * 1024;
/// Tope de eventos por llamada incremental.
pub const MAX_EVENTS: usize = 200;
/// Eventos que devuelve la primera llamada (el final de la conversación).
pub const FIRST_EVENTS: usize = 100;
const TEXT_MAX: usize = 2000;
const PROMPT_MAX: usize = 4000;
const SUMMARY_MAX: usize = 120;
const HEAD_BYTES: u64 = 64 * 1024;
/// Igual que `agents::SUB_ACTIVE_SECS`: sin escrituras durante este rato, el subagente se da por terminado.
const DONE_AFTER_SECS: u64 = 25;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubEvent {
    /// "prompt" | "text" | "tool" | "result"
    pub kind: String,
    pub text: String,
    pub tool: Option<String>,
    pub summary: Option<String>,
    pub ts: Option<String>,
    /// `tool_use.id` en las llamadas y `tool_use_id` en los resultados (para emparejarlos).
    pub id: Option<String>,
    pub error: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub events: Vec<SubEvent>,
    pub next_offset: u64,
    pub done: bool,
    /// Bytes leídos del disco en esta llamada (para comprobar que la lectura es incremental).
    #[serde(skip)]
    pub bytes_read: u64,
}

// ---------- ids y rutas ----------

/// `[A-Za-z0-9_-]{1,64}`
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_session(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

/// Ruta del transcript del subagente derivada de la sesión seguida. `Err` si algún id es inválido o si el fichero
/// (cuando existe) cae fuera de `projects/` tras resolver enlaces simbólicos.
pub fn resolve_sub_file(transcript: &Path, session_id: &str, sub_id: &str) -> Result<PathBuf, String> {
    if !valid_id(sub_id) || !valid_session(session_id) {
        return Err("invalid id".into());
    }
    let proj_dir = transcript.parent().ok_or("invalid transcript")?;
    let projects = proj_dir.parent().ok_or("invalid transcript")?;
    let file = proj_dir.join(session_id).join("subagents").join(format!("agent-{sub_id}.jsonl"));
    match std::fs::canonicalize(&file) {
        Ok(real) => {
            let root = std::fs::canonicalize(projects).map_err(|e| e.to_string())?;
            if !real.starts_with(&root) {
                return Err("path outside the projects folder".into());
            }
            Ok(real)
        }
        // Aún no existe (el subagente acaba de empezar): la ruta se compuso solo con ids validados.
        Err(_) => Ok(file),
    }
}

// ---------- seguimiento de los agentes que ve `agent_scan` ----------

static TRACKED: OnceLock<Mutex<HashMap<String, (PathBuf, String)>>> = OnceLock::new();

fn tracked() -> &'static Mutex<HashMap<String, (PathBuf, String)>> {
    TRACKED.get_or_init(Default::default)
}

/// `agents.rs` anota aquí el transcript principal de cada panel con un agente de Claude.
pub(crate) fn track(pane_id: &str, transcript: &Path, session_id: &str) {
    tracked().lock().insert(pane_id.to_string(), (transcript.to_path_buf(), session_id.to_string()));
}

/// Olvida los paneles que ya no tienen agente.
pub(crate) fn retain_tracked(live: &[String]) {
    tracked().lock().retain(|k, _| live.iter().any(|l| l == k));
}

// ---------- análisis (puro) ----------

/// Recorta a `n` caracteres (con «…»).
pub fn clip(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n).collect::<String>())
    } else {
        s.to_string()
    }
}

fn one_line(s: &str, n: usize) -> String {
    clip(&s.split_whitespace().collect::<Vec<_>>().join(" "), n)
}

fn tool_summary(name: &str, input: &Value) -> String {
    let s = |k: &str| input[k].as_str().unwrap_or("");
    let raw = match name {
        "Bash" | "PowerShell" => s("command").to_string(),
        "Read" | "Write" | "Edit" | "NotebookEdit" | "MultiEdit" => s("file_path").to_string(),
        "Grep" | "Glob" => {
            let p = s("path");
            if p.is_empty() { s("pattern").to_string() } else { format!("{} ({})", s("pattern"), p) }
        }
        "Agent" | "Task" => s("description").to_string(),
        "WebFetch" => s("url").to_string(),
        "WebSearch" => s("query").to_string(),
        _ => input
            .as_object()
            .and_then(|o| o.values().find_map(|v| v.as_str().map(str::to_string)))
            .unwrap_or_default(),
    };
    one_line(&raw, SUMMARY_MAX)
}

/// Texto de un `tool_result.content`: cadena, o lista de bloques `{type:"text", text}`.
fn result_text(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn ev(kind: &str, text: String, ts: &Option<String>) -> SubEvent {
    SubEvent { kind: kind.into(), text, ts: ts.clone(), ..Default::default() }
}

/// Eventos de UNA línea del jsonl. Formas desconocidas o JSON roto → nada.
pub fn parse_line(line: &str) -> Vec<SubEvent> {
    let line = line.trim();
    if line.is_empty() || line.len() as u64 > CHUNK_BYTES {
        return vec![];
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return vec![] };
    let ts = v["timestamp"].as_str().map(str::to_string);
    let content = &v["message"]["content"];
    let mut out = Vec::new();
    match v["type"].as_str() {
        Some("assistant") => match content {
            Value::String(s) if !s.trim().is_empty() => out.push(ev("text", clip(s, TEXT_MAX), &ts)),
            Value::Array(blocks) => {
                for b in blocks {
                    match b["type"].as_str() {
                        Some("text") => {
                            let t = b["text"].as_str().unwrap_or("");
                            if !t.trim().is_empty() {
                                out.push(ev("text", clip(t, TEXT_MAX), &ts));
                            }
                        }
                        Some("tool_use") => {
                            let name = b["name"].as_str().unwrap_or("tool");
                            out.push(SubEvent {
                                kind: "tool".into(),
                                tool: Some(clip(name, 64)),
                                summary: Some(tool_summary(name, &b["input"])),
                                id: b["id"].as_str().map(|s| clip(s, 64)),
                                ts: ts.clone(),
                                ..Default::default()
                            });
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        },
        Some("user") => match content {
            Value::String(s) if !s.trim().is_empty() => out.push(ev("prompt", clip(s, PROMPT_MAX), &ts)),
            Value::Array(blocks) => {
                for b in blocks {
                    match b["type"].as_str() {
                        Some("text") => {
                            let t = b["text"].as_str().unwrap_or("");
                            if !t.trim().is_empty() {
                                out.push(ev("prompt", clip(t, PROMPT_MAX), &ts));
                            }
                        }
                        Some("tool_result") => out.push(SubEvent {
                            kind: "result".into(),
                            text: clip(&result_text(&b["content"]), TEXT_MAX),
                            id: b["tool_use_id"].as_str().map(|s| clip(s, 64)),
                            error: b["is_error"].as_bool().unwrap_or(false),
                            ts: ts.clone(),
                            ..Default::default()
                        }),
                        _ => {}
                    }
                }
            }
            _ => {}
        },
        _ => {}
    }
    out
}

/// Eventos de varias líneas completas (CRLF tolerado).
pub fn parse_events(text: &str) -> Vec<SubEvent> {
    text.split('\n').flat_map(parse_line).collect()
}

// ---------- lectura incremental ----------

fn read_range(f: &mut File, start: u64, len: u64) -> Option<Vec<u8>> {
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len).read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Primer evento de usuario del fichero (el prompt con el que arrancó el subagente), leyendo solo su primera línea.
fn head_prompt(f: &mut File, file_len: u64, bytes_read: &mut u64) -> Vec<SubEvent> {
    let n = file_len.min(HEAD_BYTES);
    let Some(buf) = read_range(f, 0, n) else { return vec![] };
    *bytes_read += buf.len() as u64;
    let Some(end) = buf.iter().position(|&b| b == b'\n') else { return vec![] };
    parse_line(&String::from_utf8_lossy(&buf[..end]))
        .into_iter()
        .filter(|e| e.kind == "prompt")
        .collect()
}

/// Lee lo nuevo de `path`. `after = None` (o un desplazamiento mayor que el fichero, p. ej. si se rehízo): carga inicial
/// con el final del fichero. `Some(off)`: solo desde `off`. Fichero inexistente → vacío.
pub fn read_chunk(path: &Path, after: Option<u64>) -> Chunk {
    let mut chunk = Chunk { next_offset: after.unwrap_or(0), ..Default::default() };
    let Ok(mut f) = File::open(path) else { return chunk };
    let Ok(len) = f.metadata().map(|m| m.len()) else { return chunk };
    match after {
        Some(off) if off <= len => incremental(&mut f, off, len, &mut chunk),
        _ => tail_first(&mut f, len, &mut chunk),
    }
    chunk
}

fn tail_first(f: &mut File, len: u64, chunk: &mut Chunk) {
    chunk.next_offset = 0;
    if len == 0 {
        return;
    }
    let mut start = len.saturating_sub(CHUNK_BYTES);
    let Some(mut buf) = read_range(f, start, len - start) else { return };
    chunk.bytes_read += buf.len() as u64;
    if start > 0 {
        // La primera línea está cortada: se descarta.
        match buf.iter().position(|&b| b == b'\n') {
            Some(i) => {
                buf.drain(..=i);
                start += i as u64 + 1;
            }
            None => {
                chunk.next_offset = len; // una sola línea gigantesca: se salta
                return;
            }
        }
    }
    let cut = buf.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
    chunk.next_offset = start + cut as u64;
    let mut events = parse_events(&String::from_utf8_lossy(&buf[..cut]));
    if events.len() > FIRST_EVENTS {
        events.drain(..events.len() - FIRST_EVENTS);
    }
    if start > 0 && events.first().map(|e| e.kind.as_str()) != Some("prompt") {
        let mut head = head_prompt(f, len, &mut chunk.bytes_read);
        head.append(&mut events);
        events = head;
    }
    chunk.events = events;
    chunk.done = false;
}

fn incremental(f: &mut File, off: u64, len: u64, chunk: &mut Chunk) {
    chunk.next_offset = off;
    if off == len {
        return;
    }
    let want = (len - off).min(CHUNK_BYTES);
    let Some(buf) = read_range(f, off, want) else { return };
    chunk.bytes_read += buf.len() as u64;
    let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
        // Sin salto de línea: línea a medio escribir (se reintenta), salvo que ya ocupe todo el tope (se salta).
        if want == CHUNK_BYTES {
            chunk.next_offset = off + want;
        }
        return;
    };
    let mut pos = 0usize;
    while pos <= last_nl {
        let end = pos + buf[pos..].iter().position(|&b| b == b'\n').unwrap_or(0);
        chunk.events.extend(parse_line(&String::from_utf8_lossy(&buf[pos..end])));
        pos = end + 1;
        chunk.next_offset = off + pos as u64;
        if chunk.events.len() >= MAX_EVENTS {
            break;
        }
    }
}

// ---------- comando ----------

fn age_secs(p: &Path) -> Option<u64> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|e| e.as_secs())
}

fn transcript_for(pane_id: &str, sub_id: &str, after: Option<u64>) -> Result<Chunk, String> {
    let (tp, sid) = tracked().lock().get(pane_id).cloned().ok_or("no agent in that pane")?;
    let file = resolve_sub_file(&tp, &sid, sub_id)?;
    let mut chunk = read_chunk(&file, after);
    chunk.done = age_secs(&file).is_some_and(|a| a >= DONE_AFTER_SECS);
    Ok(chunk)
}

/// Eventos nuevos del subagente `subagent_id` del agente que corre en `pane_id`. Solo lectura.
#[tauri::command]
pub async fn agent_transcript(pane_id: String, subagent_id: String, after_offset: Option<u64>) -> Result<Chunk, String> {
    tauri::async_runtime::spawn_blocking(move || transcript_for(&pane_id, &subagent_id, after_offset))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn l(v: Value) -> String {
        v.to_string()
    }
    fn asst(blocks: Value) -> String {
        l(json!({"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"role":"assistant","content":blocks}}))
    }
    fn user(c: Value) -> String {
        l(json!({"type":"user","message":{"role":"user","content":c}}))
    }
    const SID: &str = "0b1f6c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("orch-subtr-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn texto_y_herramientas_del_asistente() {
        let e = parse_line(&asst(json!([
            {"type":"thinking","thinking":"x"},
            {"type":"text","text":"Voy a mirar"},
            {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cargo   test\n --release"}},
            {"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"C:/a/b.rs"}},
            {"type":"tool_use","id":"t3","name":"Grep","input":{"pattern":"foo"}},
            {"type":"tool_use","id":"t4","name":"Raro","input":{"n":1,"q":"hola"}}
        ])));
        assert_eq!(e.len(), 5);
        assert_eq!(e[0].kind, "text");
        assert_eq!(e[1].tool.as_deref(), Some("Bash"));
        assert_eq!(e[1].summary.as_deref(), Some("cargo test --release"));
        assert_eq!(e[1].id.as_deref(), Some("t1"));
        assert_eq!(e[2].summary.as_deref(), Some("C:/a/b.rs"));
        assert_eq!(e[3].summary.as_deref(), Some("foo"));
        assert_eq!(e[4].summary.as_deref(), Some("hola"));
        assert_eq!(e[0].ts.as_deref(), Some("2026-01-01T00:00:00Z"));
    }

    #[test]
    fn resultados_en_cadena_y_en_lista() {
        let a = parse_line(&user(json!([{"type":"tool_result","tool_use_id":"t1","content":"ok"}])));
        assert_eq!((a[0].kind.as_str(), a[0].text.as_str(), a[0].id.as_deref()), ("result", "ok", Some("t1")));
        let b = parse_line(&user(json!([{"type":"tool_result","tool_use_id":"t2","is_error":true,
            "content":[{"type":"text","text":"uno"},{"type":"image"},{"type":"text","text":"dos"}]}])));
        assert_eq!(b[0].text, "uno\ndos");
        assert!(b[0].error);
    }

    #[test]
    fn prompt_como_cadena_y_como_lista() {
        assert_eq!(parse_line(&user(json!("haz esto")))[0].kind, "prompt");
        assert_eq!(parse_line(&user(json!([{"type":"text","text":"y esto"}])))[0].text, "y esto");
    }

    #[test]
    fn formas_desconocidas_se_ignoran() {
        for s in ["", "   ", "no es json", "{\"type\":\"summary\"}", "{\"type\":\"user\"}", "[1,2]",
                  &asst(json!(42)), &asst(json!([{"type":"image"}, 7, null])), &user(json!({"a":1}))] {
            assert!(parse_line(s).is_empty(), "{s}");
        }
    }

    #[test]
    fn los_campos_enormes_se_recortan() {
        let big = "x".repeat(50_000);
        let e = parse_line(&asst(json!([{"type":"text","text":big}])));
        assert!(e[0].text.chars().count() <= TEXT_MAX + 1 && e[0].text.ends_with('…'));
        let r = parse_line(&user(json!([{"type":"tool_result","tool_use_id":"t","content":"y".repeat(50_000)}])));
        assert!(r[0].text.chars().count() <= TEXT_MAX + 1);
        // Una línea mayor que el tope de lectura no se interpreta.
        let huge = asst(json!([{"type":"text","text":"z".repeat(CHUNK_BYTES as usize + 10)}]));
        assert!(parse_line(&huge).is_empty());
    }

    #[test]
    fn crlf_y_texto_con_html_se_conserva_como_texto() {
        let t = format!("{}\r\n{}\r\n", asst(json!([{"type":"text","text":"<b>hola</b> **x**"}])), user(json!("p")));
        let e = parse_events(&t);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].text, "<b>hola</b> **x**"); // sin tocar: la interfaz lo pinta como texto
    }

    #[test]
    fn linea_a_medias_se_retiene_y_no_se_duplica() {
        let d = tmp("partial");
        let p = d.join("a.jsonl");
        let l1 = user(json!("uno"));
        let l2 = asst(json!([{"type":"text","text":"dos"}]));
        // Primera línea completa + mitad de la segunda.
        let half = &l2[..l2.len() / 2];
        std::fs::write(&p, format!("{l1}\n{half}")).unwrap();
        let c1 = read_chunk(&p, None);
        assert_eq!(c1.events.len(), 1);
        assert_eq!(c1.next_offset, l1.len() as u64 + 1);
        // Misma situación en modo incremental: sin novedades y el desplazamiento no se mueve.
        let c2 = read_chunk(&p, Some(c1.next_offset));
        assert!(c2.events.is_empty());
        assert_eq!(c2.next_offset, c1.next_offset);
        // Se completa la línea.
        std::fs::write(&p, format!("{l1}\n{l2}\n")).unwrap();
        let c3 = read_chunk(&p, Some(c2.next_offset));
        assert_eq!(c3.events.len(), 1);
        assert_eq!(c3.events[0].text, "dos");
        let c4 = read_chunk(&p, Some(c3.next_offset));
        assert!(c4.events.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn lo_incremental_solo_lee_lo_anadido() {
        let d = tmp("incr");
        let p = d.join("a.jsonl");
        let mut body = String::new();
        for i in 0..400 {
            body += &asst(json!([{"type":"text","text":format!("mensaje {i} {}", "r".repeat(300))}]));
            body.push('\n');
        }
        std::fs::write(&p, &body).unwrap();
        let c1 = read_chunk(&p, None);
        assert_eq!(c1.events.len(), FIRST_EVENTS);
        assert!(c1.events.last().unwrap().text.starts_with("mensaje 399"));
        assert!(c1.bytes_read <= CHUNK_BYTES + HEAD_BYTES);
        assert_eq!(c1.next_offset, body.len() as u64);
        let extra = format!("{}\n", asst(json!([{"type":"text","text":"nuevo"}])));
        std::fs::write(&p, format!("{body}{extra}")).unwrap();
        let c2 = read_chunk(&p, Some(c1.next_offset));
        assert_eq!(c2.events.len(), 1);
        assert_eq!(c2.bytes_read, extra.len() as u64, "no debe releer lo ya visto");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn tope_de_eventos_y_de_bytes_por_llamada() {
        let d = tmp("cap");
        let p = d.join("a.jsonl");
        let mut body = String::new();
        for i in 0..500 {
            body += &asst(json!([{"type":"text","text":format!("m{i}")}]));
            body.push('\n');
        }
        std::fs::write(&p, &body).unwrap();
        let c = read_chunk(&p, Some(0));
        assert_eq!(c.events.len(), MAX_EVENTS);
        assert_eq!(c.events[199].text, "m199");
        let c2 = read_chunk(&p, Some(c.next_offset));
        assert_eq!(c2.events[0].text, "m200");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn la_carga_inicial_incluye_el_prompt_del_principio() {
        let d = tmp("head");
        let p = d.join("a.jsonl");
        let mut body = format!("{}\n", user(json!("PROMPT INICIAL")));
        for i in 0..2000 {
            body += &asst(json!([{"type":"text","text":format!("m{i} {}", "q".repeat(200))}]));
            body.push('\n');
        }
        std::fs::write(&p, &body).unwrap();
        let c = read_chunk(&p, None);
        assert_eq!(c.events[0].text, "PROMPT INICIAL");
        assert_eq!(c.events.len(), FIRST_EVENTS + 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn fichero_inexistente_o_rehecho() {
        let d = tmp("none");
        let c = read_chunk(&d.join("nada.jsonl"), None);
        assert!(c.events.is_empty() && c.next_offset == 0);
        let p = d.join("a.jsonl");
        std::fs::write(&p, format!("{}\n", user(json!("hola")))).unwrap();
        // Desplazamiento mayor que el fichero (se rehízo): vuelve a cargar el final.
        let c = read_chunk(&p, Some(99_999));
        assert_eq!(c.events.len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ids_validos_y_rutas() {
        assert!(valid_id("a1b2C3_-x"));
        for bad in ["", "..", "../x", "a/b", "a\\b", "a b", "a.b", &"x".repeat(65), "é"] {
            assert!(!valid_id(bad), "{bad}");
        }
        let d = tmp("res");
        let proj = d.join("projects").join("C--demo");
        std::fs::create_dir_all(proj.join(SID).join("subagents")).unwrap();
        let tp = proj.join(format!("{SID}.jsonl"));
        std::fs::write(&tp, "").unwrap();
        // Todavía no existe: se compone la ruta.
        assert!(resolve_sub_file(&tp, SID, "abc123").unwrap().ends_with("agent-abc123.jsonl"));
        assert!(resolve_sub_file(&tp, SID, "..").is_err());
        assert!(resolve_sub_file(&tp, SID, "../../x").is_err());
        assert!(resolve_sub_file(&tp, "..\\..", "abc").is_err());
        assert!(resolve_sub_file(&tp, SID, "a/b").is_err());
        // Existe: se acepta.
        std::fs::write(proj.join(SID).join("subagents").join("agent-abc123.jsonl"), "x").unwrap();
        assert!(resolve_sub_file(&tp, SID, "abc123").is_ok());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn un_enlace_que_sale_de_projects_se_rechaza() {
        let d = tmp("link");
        let proj = d.join("projects").join("C--demo");
        std::fs::create_dir_all(proj.join(SID)).unwrap();
        let outside = d.join("fuera");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("agent-evil.jsonl"), "x").unwrap();
        let link = proj.join(SID).join("subagents");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&outside, &link).or_else(|_| {
            // Sin privilegio de symlink: una «junction» no necesita permisos especiales.
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .output()
                .map(|_| ())
        });
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(&outside, &link);
        if made.is_err() || !link.exists() {
            eprintln!("SKIP: no se pudo crear el enlace");
            return;
        }
        let tp = proj.join(format!("{SID}.jsonl"));
        assert!(resolve_sub_file(&tp, SID, "evil").is_err(), "el enlace saca el fichero de projects/");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn el_comando_exige_un_agente_seguido() {
        assert!(transcript_for("no-existe", "abc", None).is_err());
        let d = tmp("cmd");
        let proj = d.join("projects").join("C--demo");
        let sub = proj.join(SID).join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        let tp = proj.join(format!("{SID}.jsonl"));
        std::fs::write(&tp, "").unwrap();
        track("pane-test", &tp, SID);
        let c = transcript_for("pane-test", "zz1", None).unwrap(); // aún no existe
        assert!(c.events.is_empty() && !c.done);
        std::fs::write(sub.join("agent-zz1.jsonl"), format!("{}\n", user(json!("hola")))).unwrap();
        let c = transcript_for("pane-test", "zz1", None).unwrap();
        assert_eq!(c.events.len(), 1);
        assert!(transcript_for("pane-test", "../zz1", None).is_err());
        retain_tracked(&[]);
        assert!(transcript_for("pane-test", "zz1", None).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
