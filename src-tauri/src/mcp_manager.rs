//! Gestor de MCP por cuenta. Este fichero: LECTURA (listar lo configurado y sondear un servidor bajo demanda).
//! La escritura (F2: añadir, quitar, copiar, copia de seguridad y deshacer) está en `mcp_manager/write.rs`.
//!
//! No confundir con `mcp.rs` (el servidor MCP propio de Orchestra).
//!
//! Qué se lee (aquí nunca se escribe nada):
//! - Claude: `<CLAUDE_CONFIG_DIR>\.claude.json` (la cuenta por defecto, `%USERPROFILE%\.claude.json`):
//!   `mcpServers` (ámbito user) y `projects[<ruta>].mcpServers` (ámbito local). No se usa `claude mcp list`
//!   porque arranca todos los servidores.
//! - Codex: `codex mcp list --json` con `CODEX_HOME` de la cuenta (no arranca servidores).
//! - opencode: clave `mcp` de `%USERPROFILE%\.config\opencode\opencode.json(c)` (JSONC); es global.
//!
//! Secretos: los valores de env y cabeceras, los valores de la query de las URLs, la contraseña de la URL y los
//! argumentos con pinta de clave se quedan en Rust. A la interfaz solo llegan los nombres y `•••`. La huella
//! (`fingerprint`) se calcula con la definición real (los valores secretos entran como hash con clave aleatoria
//! del proceso), así que es estable durante la ejecución de Orchestra y distingue «misma definición» de «distinta»
//! sin permitir comprobar una clave por fuerza bruta fuera del proceso.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::hash::{BuildHasher, Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

#[cfg(test)]
mod tests;
pub mod write;

/// Lo que se muestra en lugar de un valor secreto.
pub(crate) const MASK: &str = "•••";
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const CODEX_TIMEOUT: Duration = Duration::from_secs(10);
const MSG_CAP: usize = 200;

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(Into::into)
}

// ---------- tipos ----------

/// Definición real (con secretos). Nunca se serializa.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct RawDef {
    pub name: String,
    /// "stdio" | "http" | "sse"
    pub transport: &'static str,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    /// Variables que la herramienta pasa desde su propio entorno (Codex `env_vars`, `bearer_token_env_var`,
    /// `env_http_headers`): solo nombres.
    pub env_passthrough: Vec<String>,
    /// Cabeceras cuyo valor sale de una variable de entorno: (cabecera, variable). Codex.
    pub env_headers: Vec<(String, String)>,
    pub enabled: Option<bool>,
    /// "user" | "local" | "project" | "global" | "plugin" | "claudeai"
    pub scope: &'static str,
    pub project_path: Option<String>,
    /// Tipo tal como lo escribe la herramienta ("stdio", "http", "streamable_http", "local", "remote"…).
    pub raw_kind: String,
    /// Codex: `auth_status` de `codex mcp list` ("unsupported", "unknown", "o_auth", …).
    pub auth_status: Option<String>,
    /// Proyectos en los que Claude lo tiene apagado (`projects[p].disabledMcpServers`), para ámbitos no locales.
    pub disabled_in: Vec<String>,
    /// Quién lo gestiona si no es la config de la cuenta: `plugin:<id>` o `claude.ai`. Orchestra no lo edita.
    pub managed_by: Option<String>,
}

/// Definición para la interfaz: sin ningún valor secreto.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpDef {
    pub name: String,
    pub transport: &'static str,
    pub command: Option<String>,
    /// Argumentos con los que parecen claves sustituidos por `•••` (o `--flag=•••`).
    pub args: Vec<String>,
    /// URL con los valores de la query y la contraseña sustituidos por `•••`.
    pub url: Option<String>,
    pub cwd: Option<String>,
    /// Nombres de las variables de entorno fijadas en la definición (su valor es siempre `•••`).
    pub env_keys: Vec<String>,
    /// Nombres de las cabeceras HTTP fijadas (valor `•••`), incluidas las que salen de una variable.
    pub header_keys: Vec<String>,
    /// Variables que la herramienta toma de su entorno (solo nombres).
    pub env_passthrough: Vec<String>,
    pub enabled: Option<bool>,
    pub scope: &'static str,
    pub project_path: Option<String>,
    pub raw_kind: String,
    pub auth_status: Option<String>,
    /// Proyectos en los que Claude lo tiene apagado aunque esté definido arriba (ámbito user/plugin/claude.ai).
    pub disabled_in: Vec<String>,
    /// `plugin:<id>` | `claude.ai` | null. Gestionado fuera de la config de la cuenta.
    pub managed_by: Option<String>,
    /// Huella de la definición (16 hex). Misma huella = misma definición.
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpAccount {
    /// "claude:<dir>" | "codex:<dir>" | "opencode:global"
    pub id: String,
    /// "claude" | "codex" | "opencode"
    pub provider: &'static str,
    /// Carpeta de la cuenta (CLAUDE_CONFIG_DIR / CODEX_HOME); opencode: carpeta de la config.
    pub dir: String,
    pub is_default: bool,
    /// Email de la cuenta (solo Claude).
    pub label: Option<String>,
    /// Fichero o comando del que sale la lista.
    pub source: String,
    pub servers: Vec<McpDef>,
    /// Fallo de esta cuenta (fichero ilegible, codex no instalado, tiempo agotado…). El resto de cuentas sigue.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ProbeResult {
    #[serde(rename_all = "camelCase")]
    Ok {
        tools: usize,
        server_name: Option<String>,
        version: Option<String>,
        /// Bytes del JSON compacto de todas las definiciones de herramientas (`tools/list`, todas las páginas).
        tools_bytes: usize,
        /// Estimación de tokens que cuestan esas definiciones en cada sesión: `tools_bytes / 4` (redondeo arriba).
        tokens_est: usize,
    },
    NeedsAuth,
    Failed { msg: String },
    Timeout,
}

// ---------- secretos y huella ----------

/// Clave aleatoria por proceso para el hash de los valores secretos.
static HASH_KEY: LazyLock<std::collections::hash_map::RandomState> = LazyLock::new(Default::default);

fn h64(parts: &[&str]) -> u64 {
    let mut h = HASH_KEY.build_hasher();
    for p in parts {
        h.write(p.as_bytes());
        h.write_u8(0xff);
    }
    h.finish()
}

fn secret_word(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    ["key", "token", "secret", "password", "passwd", "pwd", "auth", "bearer", "credential", "cookie", "session"]
        .iter()
        .any(|w| l.contains(w))
}

/// ¿Tiene pinta de clave por sí mismo? (prefijos conocidos o un bloque largo sin separadores de ruta).
fn looks_like_token(s: &str) -> bool {
    let t = s.trim();
    let prefixes = ["sk-", "sk_", "pk_", "rk_", "ghp_", "gho_", "ghu_", "ghs_", "github_pat_", "xox", "glpat-", "AKIA", "AIza", "eyJ"];
    if prefixes.iter().any(|p| t.starts_with(p)) && t.len() >= 12 {
        return true;
    }
    t.len() >= 32
        && !t.contains(['/', '\\', ' ', ':', '@'])
        && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '=' | '+'))
        && t.chars().any(|c| c.is_ascii_digit())
        && t.chars().any(|c| c.is_ascii_alphabetic())
}

/// Índices de argumentos secretos: valor tras `--api-key`, `--token`… y argumentos que parecen claves.
/// Devuelve los argumentos enmascarados.
pub(crate) fn mask_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut prev_flag_secret = false;
    for a in args {
        let is_flag = a.starts_with('-');
        if let Some((k, v)) = a.split_once('=') {
            if (k.starts_with('-') && secret_word(k)) || looks_like_token(v) || (!k.starts_with('-') && secret_word(k) && !k.contains(['/', '\\'])) {
                out.push(format!("{k}={MASK}"));
                prev_flag_secret = false;
                continue;
            }
        }
        if (prev_flag_secret && !is_flag) || looks_like_token(a) || a.to_ascii_lowercase().starts_with("bearer ") {
            out.push(MASK.to_string());
        } else {
            out.push(a.clone());
        }
        prev_flag_secret = is_flag && !a.contains('=') && secret_word(a);
    }
    out
}

/// URL sin secretos: valores de la query → `•••`, contraseña → `•••`, fragmento fuera.
pub(crate) fn mask_url(url: &str) -> String {
    let (no_frag, _) = url.split_once('#').unwrap_or((url, ""));
    let (base, query) = match no_frag.split_once('?') {
        Some((b, q)) => (b, Some(q)),
        None => (no_frag, None),
    };
    let mut base = base.to_string();
    if let Some(scheme_end) = base.find("://") {
        let rest_start = scheme_end + 3;
        let auth_end = base[rest_start..].find('/').map(|i| rest_start + i).unwrap_or(base.len());
        if let Some(at) = base[rest_start..auth_end].rfind('@') {
            let userinfo = &base[rest_start..rest_start + at];
            let user = userinfo.split(':').next().unwrap_or("");
            let masked = if userinfo.contains(':') { format!("{user}:{MASK}") } else { MASK.to_string() };
            base = format!("{}{}{}", &base[..rest_start], masked, &base[rest_start + at..]);
        }
    }
    match query {
        Some(q) if !q.is_empty() => {
            let parts: Vec<String> = q
                .split('&')
                .map(|p| match p.split_once('=') {
                    Some((k, _)) => format!("{k}={MASK}"),
                    None => p.to_string(),
                })
                .collect();
            format!("{base}?{}", parts.join("&"))
        }
        _ => base,
    }
}

/// Huella: transporte, comando, argumentos, URL, cwd, nombres de env/cabeceras y hash de sus valores.
/// No entran el nombre, el ámbito, `enabled` ni datos propios de cada herramienta.
pub(crate) fn fingerprint(d: &RawDef) -> String {
    let mut parts: Vec<String> = vec![d.transport.to_string()];
    let norm_cmd = |c: &str| {
        let c = c.trim().replace('\\', "/");
        if cfg!(windows) {
            c.to_lowercase()
        } else {
            c
        }
    };
    // Comando + argumentos como una sola lista (opencode los guarda juntos).
    let mut cmdline: Vec<String> = Vec::new();
    if let Some(c) = &d.command {
        cmdline.push(norm_cmd(c));
    }
    cmdline.extend(d.args.iter().cloned());
    parts.push(format!("cmd:{}", cmdline.join("\u{1}")));
    parts.push(format!("url:{}", d.url.as_deref().map(|u| u.trim_end_matches('/')).unwrap_or("")));
    parts.push(format!("cwd:{}", d.cwd.as_deref().map(norm_cmd).unwrap_or_default()));
    let sorted = |v: &[(String, String)]| {
        let m: BTreeMap<String, u64> = v.iter().map(|(k, val)| (k.to_ascii_lowercase(), h64(&["v", val]))).collect();
        m.into_iter().map(|(k, h)| format!("{k}={h:x}")).collect::<Vec<_>>().join(",")
    };
    parts.push(format!("env:{}", sorted(&d.env)));
    let mut hdr = d.headers.clone();
    hdr.extend(d.env_headers.iter().map(|(h, var)| (h.clone(), format!("$env:{var}"))));
    parts.push(format!("hdr:{}", sorted(&hdr)));
    let mut pass: Vec<String> = d.env_passthrough.iter().map(|s| s.to_ascii_uppercase()).collect();
    pass.sort();
    pass.dedup();
    parts.push(format!("pass:{}", pass.join(",")));
    let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
    format!("{:016x}", h64(&refs))
}

pub(crate) fn to_public(d: &RawDef) -> McpDef {
    let mut header_keys: Vec<String> = d.headers.iter().map(|(k, _)| k.clone()).collect();
    for (h, _) in &d.env_headers {
        if !header_keys.iter().any(|k| k.eq_ignore_ascii_case(h)) {
            header_keys.push(h.clone());
        }
    }
    McpDef {
        name: d.name.clone(),
        transport: d.transport,
        command: d.command.clone(),
        args: mask_args(&d.args),
        url: d.url.as_deref().map(mask_url),
        cwd: d.cwd.clone(),
        env_keys: d.env.iter().map(|(k, _)| k.clone()).collect(),
        header_keys,
        env_passthrough: d.env_passthrough.clone(),
        enabled: d.enabled,
        scope: d.scope,
        project_path: d.project_path.clone(),
        raw_kind: d.raw_kind.clone(),
        auth_status: d.auth_status.clone(),
        disabled_in: d.disabled_in.clone(),
        managed_by: d.managed_by.clone(),
        fingerprint: fingerprint(d),
    }
}

/// Quita de un texto (stderr, mensaje de error) los secretos conocidos y lo que tenga pinta de clave; una línea,
/// truncada.
pub(crate) fn scrub_msg(text: &str, secrets: &[&str]) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let mut s = line.to_string();
    for sec in secrets {
        if sec.len() >= 4 {
            s = s.replace(sec, MASK);
        }
    }
    let words: Vec<String> = s
        .split(' ')
        .map(|w| {
            let core = w.trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | ';' | '(' | ')' | '[' | ']'));
            if let Some((k, v)) = core.split_once('=') {
                if secret_word(k) || looks_like_token(v) {
                    return w.replace(core, &format!("{k}={MASK}"));
                }
            }
            if looks_like_token(core) {
                w.replace(core, MASK)
            } else {
                w.to_string()
            }
        })
        .collect();
    let mut s = words.join(" ");
    if s.chars().count() > MSG_CAP {
        s = s.chars().take(MSG_CAP).collect::<String>() + "…";
    }
    s
}

// ---------- lectura: Claude ----------

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

fn kv_of(v: &Value) -> Vec<(String, String)> {
    v.as_object()
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn strings_of(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())).collect())
        .unwrap_or_default()
}

/// Una entrada de `mcpServers` de Claude (también vale para `.mcp.json`).
pub(crate) fn claude_entry(name: &str, v: &Value, scope: &'static str, project: Option<&str>) -> RawDef {
    let kind = v["type"].as_str().unwrap_or(if v.get("url").is_some() { "http" } else { "stdio" }).to_string();
    let transport = match kind.as_str() {
        "sse" => "sse",
        "http" | "streamable-http" | "streamable_http" => "http",
        _ => "stdio",
    };
    RawDef {
        name: name.to_string(),
        transport,
        command: str_of(&v["command"]),
        args: strings_of(&v["args"]),
        url: str_of(&v["url"]),
        cwd: str_of(&v["cwd"]),
        env: kv_of(&v["env"]),
        headers: kv_of(&v["headers"]),
        scope,
        project_path: project.map(str::to_string),
        raw_kind: kind,
        ..Default::default()
    }
}

/// Lo que Claude guarda por proyecto en `.claude.json` sobre qué MCP están apagados o aprobados.
#[derive(Debug, Clone, Default)]
pub(crate) struct ClaudeProject {
    /// `disabledMcpServers`: nombres (user, local, plugin o «claude.ai X») apagados en ese proyecto.
    pub disabled: Vec<String>,
    /// `enabledMcpjsonServers` / `disabledMcpjsonServers`: aprobación de los MCP de `.mcp.json`.
    pub mcpjson_on: Vec<String>,
    pub mcpjson_off: Vec<String>,
    pub mcpjson_all: bool,
}

/// `.claude.json` de una cuenta, ya leído.
#[derive(Debug, Clone, Default)]
pub(crate) struct ClaudeFile {
    pub defs: Vec<RawDef>,
    pub email: Option<String>,
    /// Clave = ruta del proyecto tal como la escribe Claude.
    pub projects: Vec<(String, ClaudeProject)>,
    /// `claudeAiMcpEverConnected`: conectores de claude.ai que se conectaron alguna vez (solo nombres).
    pub connectors: Vec<String>,
}

fn names_of(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

/// Ruta comparable: barras `/`, sin barra final y (Windows) en minúsculas.
pub(crate) fn norm_path(p: &str) -> String {
    let s = p.trim().replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

impl ClaudeFile {
    fn project(&self, path: &str) -> Option<&ClaudeProject> {
        let n = norm_path(path);
        self.projects.iter().find(|(p, _)| norm_path(p) == n).map(|(_, x)| x)
    }
}

pub(crate) fn parse_claude_file(text: &str) -> Result<ClaudeFile, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("malformed .claude.json (line {})", e.line()))?;
    let mut out = ClaudeFile::default();
    if let Some(m) = v["mcpServers"].as_object() {
        for (name, d) in m {
            out.defs.push(claude_entry(name, d, "user", None));
        }
    }
    if let Some(projects) = v["projects"].as_object() {
        for (path, p) in projects {
            let st = ClaudeProject {
                disabled: names_of(&p["disabledMcpServers"]),
                mcpjson_on: names_of(&p["enabledMcpjsonServers"]),
                mcpjson_off: names_of(&p["disabledMcpjsonServers"]),
                mcpjson_all: p["enableAllProjectMcpServers"].as_bool().unwrap_or(false),
            };
            if let Some(m) = p["mcpServers"].as_object() {
                for (name, d) in m {
                    let mut def = claude_entry(name, d, "local", Some(path));
                    def.enabled = Some(!st.disabled.contains(name));
                    out.defs.push(def);
                }
            }
            out.projects.push((path.clone(), st));
        }
    }
    out.email = v["oauthAccount"]["emailAddress"].as_str().map(str::to_string);
    out.connectors = names_of(&v["claudeAiMcpEverConnected"]);
    Ok(out)
}

/// Lee el `.claude.json` (texto) de una cuenta: ámbito user y local por proyecto. `Err` = JSON malformado.
#[cfg_attr(not(test), allow(dead_code))] // lo usan las pruebas
pub(crate) fn parse_claude_json(text: &str) -> Result<(Vec<RawDef>, Option<String>), String> {
    let f = parse_claude_file(text)?;
    Ok((f.defs, f.email))
}

fn read_json(path: &Path) -> Option<Value> {
    let t = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()
}

/// `mcpServers` de un JSON de MCP: `{ "mcpServers": {…} }` o el mapa directamente (formato de plugins).
fn servers_map(v: &Value) -> Option<&serde_json::Map<String, Value>> {
    v["mcpServers"]
        .as_object()
        .or_else(|| v.as_object().filter(|m| m.values().all(|x| x.is_object() && (x.get("command").is_some() || x.get("url").is_some()))))
}

/// Aprobación de un MCP de `.mcp.json` en un proyecto: `Some(false)` rechazado, `Some(true)` aprobado, `None`
/// Claude aún no ha preguntado. Mira `.claude.json` de la cuenta, `settings.json` de la cuenta y los del proyecto.
fn mcpjson_enabled(name: &str, st: Option<&ClaudeProject>, settings: &[Value]) -> Option<bool> {
    let n = name.to_string();
    let off = st.is_some_and(|p| p.mcpjson_off.contains(&n)) || settings.iter().any(|s| names_of(&s["disabledMcpjsonServers"]).contains(&n));
    if off {
        return Some(false);
    }
    let on = st.is_some_and(|p| p.mcpjson_all || p.mcpjson_on.contains(&n))
        || settings.iter().any(|s| s["enableAllProjectMcpServers"].as_bool() == Some(true) || names_of(&s["enabledMcpjsonServers"]).contains(&n));
    if on {
        Some(true)
    } else {
        None
    }
}

/// MCP de `.mcp.json` de los proyectos dados (ámbito project), con su aprobación en esta cuenta.
/// Devuelve también los ficheros que no se pudieron leer.
pub(crate) fn project_defs(cf: &ClaudeFile, account_settings: Option<&Value>, projects: &[String]) -> (Vec<RawDef>, Vec<String>) {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for p in projects {
        let key = norm_path(p);
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let file = Path::new(p).join(".mcp.json");
        if !file.is_file() {
            continue;
        }
        let Some(v) = read_json(&file) else {
            errors.push(format!("malformed {}", file.to_string_lossy()));
            continue;
        };
        let mut settings: Vec<Value> = account_settings.cloned().into_iter().collect();
        for f in ["settings.json", "settings.local.json"] {
            if let Some(s) = read_json(&Path::new(p).join(".claude").join(f)) {
                settings.push(s);
            }
        }
        let st = cf.project(p);
        if let Some(m) = v["mcpServers"].as_object() {
            for (name, d) in m {
                let mut def = claude_entry(name, d, "project", Some(p));
                def.enabled = mcpjson_enabled(name, st, &settings);
                out.push(def);
            }
        }
    }
    (out, errors)
}

/// MCP que traen los plugins instalados de una cuenta (`plugins/installed_plugins.json` + `enabledPlugins` de
/// `settings.json` + `mcpServers` de `.claude-plugin/plugin.json` o `.mcp.json` del plugin). No arranca nada.
pub(crate) fn plugin_defs(dir: &Path, account_settings: Option<&Value>) -> Vec<RawDef> {
    let Some(inst) = read_json(&dir.join("plugins").join("installed_plugins.json")) else {
        return vec![];
    };
    let Some(plugins) = inst["plugins"].as_object() else {
        return vec![];
    };
    let mut out = Vec::new();
    for (id, entries) in plugins {
        let list = entries.as_array().cloned().unwrap_or_default();
        // Primero la instalación de ámbito user; si no hay, la primera.
        let Some(e) = list.iter().find(|e| e["scope"] == "user").or(list.first()) else {
            continue;
        };
        let Some(install) = e["installPath"].as_str() else {
            continue;
        };
        let root = Path::new(install);
        let manifest = read_json(&root.join(".claude-plugin").join("plugin.json"));
        let mcpjson = read_json(&root.join(".mcp.json"));
        let map = manifest.as_ref().and_then(|m| m["mcpServers"].as_object()).or_else(|| mcpjson.as_ref().and_then(servers_map));
        let Some(map) = map else {
            continue;
        };
        let enabled = account_settings.and_then(|s| s["enabledPlugins"][id.as_str()].as_bool()).unwrap_or(false);
        let project = if e["scope"] == "user" { None } else { e["projectPath"].as_str() };
        for (name, d) in map {
            let mut def = claude_entry(name, d, "plugin", project);
            def.enabled = Some(enabled);
            def.managed_by = Some(format!("plugin:{id}"));
            out.push(def);
        }
    }
    out
}

/// Conectores de claude.ai vistos alguna vez en la cuenta (sin definición: los gestiona claude.ai).
fn connector_defs(cf: &ClaudeFile) -> Vec<RawDef> {
    cf.connectors
        .iter()
        .map(|n| RawDef {
            name: n.clone(),
            transport: "http",
            scope: "claudeai",
            raw_kind: "claudeai".into(),
            managed_by: Some("claude.ai".into()),
            ..Default::default()
        })
        .collect()
}

/// Todas las definiciones de una cuenta de Claude: user, local, project (`.mcp.json` de `projects`), plugins y
/// conectores, con `disabled_in` puesto. Sin `.claude.json` = solo plugins. Devuelve (defs, email, avisos).
pub(crate) fn claude_raws(dir: &Path, file: &Path, projects: &[String]) -> Result<(Vec<RawDef>, Option<String>, Vec<String>), String> {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::from("{}"),
        Err(_) => return Err("could not read .claude.json".into()),
    };
    let cf = parse_claude_file(&text)?;
    let settings = read_json(&dir.join("settings.json"));
    let (proj, errors) = project_defs(&cf, settings.as_ref(), projects);
    let mut defs = cf.defs.clone();
    defs.extend(proj);
    defs.extend(plugin_defs(dir, settings.as_ref()));
    defs.extend(connector_defs(&cf));
    for d in defs.iter_mut().filter(|d| d.scope != "local" && d.scope != "project") {
        d.disabled_in = cf.projects.iter().filter(|(_, p)| p.disabled.contains(&d.name)).map(|(k, _)| k.clone()).collect();
    }
    Ok((defs, cf.email, errors))
}

/// Carpetas de cuenta de Claude: (`dir`, fichero `.claude.json`, por defecto). Igual que `accounts::scan`.
pub(crate) fn claude_dirs(home: &Path) -> Vec<(PathBuf, PathBuf, bool)> {
    let mut out = Vec::new();
    let default_dir = home.join(".claude");
    if default_dir.is_dir() {
        // La carpeta por defecto guarda su .claude.json en el HOME, no dentro de .claude.
        out.push((default_dir, home.join(".claude.json"), true));
    }
    if let Ok(rd) = std::fs::read_dir(home) {
        let mut dirs: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir() && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(".claude-")))
            .collect();
        dirs.sort();
        for d in dirs {
            let f = d.join(".claude.json");
            out.push((d, f, false));
        }
    }
    out
}

fn claude_account(dir: &Path, file: &Path, is_default: bool, projects: &[String]) -> (McpAccount, Vec<RawDef>) {
    let mut acc = McpAccount {
        id: format!("claude:{}", dir.to_string_lossy()),
        provider: "claude",
        dir: dir.to_string_lossy().into_owned(),
        is_default,
        label: None,
        source: file.to_string_lossy().into_owned(),
        servers: vec![],
        error: None,
    };
    let mut raws = vec![];
    match claude_raws(dir, file, projects) {
        Ok((defs, email, errors)) => {
            acc.label = email;
            raws = defs;
            if !errors.is_empty() {
                acc.error = Some(errors.join("; "));
            }
        }
        Err(e) => acc.error = Some(e),
    }
    acc.servers = raws.iter().map(to_public).collect();
    (acc, raws)
}

// ---------- lectura: Codex ----------

/// Salida de `codex mcp list --json` (codex 0.167.0: lista de `{name, enabled, transport:{type,…}, auth_status}`).
pub(crate) fn parse_codex_list(text: &str) -> Result<Vec<RawDef>, String> {
    let start = text.find('[').ok_or("codex mcp list: no JSON in the output")?;
    let mut it = serde_json::Deserializer::from_str(&text[start..]).into_iter::<Value>();
    let v = match it.next() {
        Some(Ok(v)) => v,
        _ => return Err("codex mcp list: unreadable JSON".into()),
    };
    let arr = v.as_array().ok_or("codex mcp list: unexpected JSON")?;
    let mut out = Vec::new();
    for e in arr {
        let Some(name) = e["name"].as_str() else { continue };
        let t = &e["transport"];
        let kind = t["type"].as_str().unwrap_or("").to_string();
        let mut d = RawDef {
            name: name.to_string(),
            transport: match kind.as_str() {
                "stdio" => "stdio",
                "sse" => "sse",
                _ => "http",
            },
            enabled: e["enabled"].as_bool(),
            scope: "user",
            raw_kind: kind.clone(),
            auth_status: str_of(&e["auth_status"]),
            ..Default::default()
        };
        if kind == "stdio" {
            d.command = str_of(&t["command"]);
            d.args = strings_of(&t["args"]);
            d.env = kv_of(&t["env"]);
            d.env_passthrough = strings_of(&t["env_vars"]);
            d.cwd = str_of(&t["cwd"]);
        } else {
            d.url = str_of(&t["url"]);
            d.headers = kv_of(&t["http_headers"]);
            for (h, var) in kv_of(&t["env_http_headers"]) {
                d.env_passthrough.push(var.clone());
                d.env_headers.push((h, var));
            }
            if let Some(var) = t["bearer_token_env_var"].as_str() {
                d.env_passthrough.push(var.to_string());
                d.env_headers.push(("Authorization".into(), var.to_string()));
            }
        }
        out.push(d);
    }
    Ok(out)
}

/// Carpetas de Codex: `~/.codex` (por defecto) y `~/.codex-*` válidas.
pub(crate) fn codex_dirs(home: &Path) -> Vec<(PathBuf, bool)> {
    let mut out = Vec::new();
    if home.join(".codex").is_dir() {
        out.push((home.join(".codex"), true));
    }
    if let Ok(rd) = std::fs::read_dir(home) {
        let mut dirs: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir() && crate::providers::valid_account_dir("codex", &p.to_string_lossy(), home).is_ok())
            .collect();
        dirs.sort();
        out.extend(dirs.into_iter().map(|d| (d, false)));
    }
    out
}

fn codex_env(dir: &Path, is_default: bool) -> Vec<(String, String)> {
    if is_default {
        vec![]
    } else {
        vec![("CODEX_HOME".into(), dir.to_string_lossy().into_owned())]
    }
}

fn codex_installed() -> bool {
    crate::providers::on_path(std::env::var_os("PATH").as_deref(), &["codex.exe", "codex.cmd", "codex.bat"])
}

fn codex_raw(dir: &Path, is_default: bool) -> Result<Vec<RawDef>, String> {
    if !codex_installed() {
        return Err("codex is not installed (not on PATH)".into());
    }
    let env = codex_env(dir, is_default);
    match crate::providers::run_capture("codex", &["mcp", "list", "--json"], &env, CODEX_TIMEOUT) {
        None => Err("codex mcp list: timed out or could not start".into()),
        Some((ok, text)) => match parse_codex_list(&text) {
            Ok(d) => Ok(d),
            Err(e) if ok => Err(e),
            Err(_) => Err(format!("codex mcp list failed: {}", scrub_msg(&text, &[]))),
        },
    }
}

fn codex_account(dir: &Path, is_default: bool) -> (McpAccount, Vec<RawDef>) {
    let mut acc = McpAccount {
        id: format!("codex:{}", dir.to_string_lossy()),
        provider: "codex",
        dir: dir.to_string_lossy().into_owned(),
        is_default,
        label: None,
        source: "codex mcp list --json".into(),
        servers: vec![],
        error: None,
    };
    let raws = match codex_raw(dir, is_default) {
        Ok(r) => r,
        Err(e) => {
            acc.error = Some(e);
            vec![]
        }
    };
    acc.servers = raws.iter().map(to_public).collect();
    (acc, raws)
}

// ---------- lectura: opencode ----------

/// JSONC → JSON: quita comentarios `//` y `/* */` (fuera de cadenas) y comas finales.
pub(crate) fn strip_jsonc(text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let c: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_str = false;
    while i < c.len() {
        let ch = c[i];
        if in_str {
            out.push(ch);
            if ch == '\\' && i + 1 < c.len() {
                out.push(c[i + 1]);
                i += 2;
                continue;
            }
            if ch == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match ch {
            '"' => {
                in_str = true;
                out.push(ch);
                i += 1;
            }
            '/' if c.get(i + 1) == Some(&'/') => {
                while i < c.len() && c[i] != '\n' {
                    i += 1;
                }
            }
            '/' if c.get(i + 1) == Some(&'*') => {
                i += 2;
                while i + 1 < c.len() && !(c[i] == '*' && c[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
                out.push(' ');
            }
            ',' => {
                // ¿Coma final? (solo espacios hasta `}` o `]`; los comentarios ya se habrán quitado en la salida
                // si vienen después, así que se mira el texto de entrada saltando espacios y comentarios).
                let mut j = i + 1;
                loop {
                    while j < c.len() && c[j].is_whitespace() {
                        j += 1;
                    }
                    if c.get(j) == Some(&'/') && c.get(j + 1) == Some(&'/') {
                        while j < c.len() && c[j] != '\n' {
                            j += 1;
                        }
                    } else if c.get(j) == Some(&'/') && c.get(j + 1) == Some(&'*') {
                        j += 2;
                        while j + 1 < c.len() && !(c[j] == '*' && c[j + 1] == '/') {
                            j += 1;
                        }
                        j += 2;
                    } else {
                        break;
                    }
                }
                if !matches!(c.get(j), Some('}') | Some(']')) {
                    out.push(ch);
                }
                i += 1;
            }
            _ => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

/// `mcp` de la config de opencode (`{name: {type: "local", command: [...], environment, enabled} |
/// {type: "remote", url, headers, enabled}}`).
pub(crate) fn parse_opencode(text: &str) -> Result<Vec<RawDef>, String> {
    let v: Value = serde_json::from_str(&strip_jsonc(text)).map_err(|e| format!("malformed opencode config (line {})", e.line()))?;
    let mut out = Vec::new();
    // opencode 2.2.5 (`opencode mcp add`) escribe `mcp.servers.<name>`; también vale el formato clásico `mcp.<name>`.
    let mut entries: Vec<(&String, &Value)> = Vec::new();
    if let Some(m) = v["mcp"].as_object() {
        for (name, d) in m {
            let container = name == "servers" && d.is_object() && d.get("type").is_none() && d.get("command").is_none() && d.get("url").is_none();
            if container {
                entries.extend(d.as_object().into_iter().flatten());
            } else {
                entries.push((name, d));
            }
        }
    }
    {
        for (name, d) in entries {
            let kind = d["type"].as_str().unwrap_or("").to_string();
            let mut def = RawDef {
                name: name.clone(),
                transport: if kind == "remote" { "http" } else { "stdio" },
                enabled: d["enabled"].as_bool(),
                scope: "global",
                raw_kind: kind.clone(),
                ..Default::default()
            };
            if kind == "remote" {
                def.url = str_of(&d["url"]);
                def.headers = kv_of(&d["headers"]);
            } else {
                let mut cmd = strings_of(&d["command"]);
                if !cmd.is_empty() {
                    def.command = Some(cmd.remove(0));
                }
                def.args = cmd;
                def.env = kv_of(&d["environment"]);
            }
            out.push(def);
        }
    }
    Ok(out)
}

/// Carpeta de la config de opencode: `XDG_CONFIG_HOME\opencode` si está definida (opencode la respeta también en
/// Windows), si no `%USERPROFILE%\.config\opencode`.
fn opencode_config_dir(home: &Path) -> PathBuf {
    match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        Some(x) => PathBuf::from(x).join("opencode"),
        None => home.join(".config").join("opencode"),
    }
}

fn opencode_account(home: &Path) -> Option<(McpAccount, Vec<RawDef>)> {
    let dir = opencode_config_dir(home);
    let files = [dir.join("opencode.jsonc"), dir.join("opencode.json")];
    let installed = crate::providers::on_path(std::env::var_os("PATH").as_deref(), &["opencode.exe", "opencode.cmd", "opencode.bat"]);
    let mut acc = McpAccount {
        id: "opencode:global".into(),
        provider: "opencode",
        dir: dir.to_string_lossy().into_owned(),
        is_default: true,
        label: None,
        source: String::new(),
        servers: vec![],
        error: None,
    };
    let mut raws = Vec::new();
    let mut found = false;
    for f in files.iter().filter(|f| f.is_file()) {
        found = true;
        if !acc.source.is_empty() {
            acc.source.push_str(" + ");
        }
        acc.source.push_str(&f.to_string_lossy());
        match std::fs::read_to_string(f).map_err(|_| "could not read the opencode config".to_string()).and_then(|t| parse_opencode(&t)) {
            Ok(mut d) => {
                // Si están los dos, opencode mezcla; aquí el primero (jsonc) gana por nombre.
                d.retain(|x| !raws.iter().any(|r: &RawDef| r.name == x.name));
                raws.extend(d);
            }
            Err(e) => acc.error = Some(e),
        }
    }
    if !found && !installed {
        return None;
    }
    acc.servers = raws.iter().map(to_public).collect();
    Some((acc, raws))
}

// ---------- listado ----------

/// Todas las cuentas con sus definiciones reales (para la sonda) y públicas (para la interfaz).
fn list_all(home: &Path, projects: &[String]) -> Vec<(McpAccount, Vec<RawDef>)> {
    let mut out: Vec<(McpAccount, Vec<RawDef>)> = claude_dirs(home).iter().map(|(d, f, def)| claude_account(d, f, *def, projects)).collect();
    // Codex: un proceso por cuenta, en paralelo (cada uno hasta 10 s).
    let handles: Vec<_> = codex_dirs(home)
        .into_iter()
        .map(|(d, def)| std::thread::spawn(move || codex_account(&d, def)))
        .collect();
    for h in handles {
        if let Ok(r) = h.join() {
            out.push(r);
        }
    }
    if let Some(o) = opencode_account(home) {
        out.push(o);
    }
    out
}

#[cfg_attr(not(test), allow(dead_code))] // lo usan las pruebas
pub(crate) fn list_in(home: &Path) -> Vec<McpAccount> {
    list_with(home, &[])
}

/// Listado con los `.mcp.json` de los proyectos dados (carpetas de los paneles abiertos en Orchestra).
pub(crate) fn list_with(home: &Path, projects: &[String]) -> Vec<McpAccount> {
    list_all(home, projects).into_iter().map(|(a, _)| a).collect()
}

/// Ficheros de los que sale el listado (para el refresco por mtime). Codex: su `config.toml`.
pub(crate) fn watched_files(home: &Path, projects: &[String]) -> Vec<PathBuf> {
    let mut v = Vec::new();
    for (d, f, _) in claude_dirs(home) {
        v.push(f);
        v.push(d.join("settings.json"));
        v.push(d.join("plugins").join("installed_plugins.json"));
    }
    for (d, _) in codex_dirs(home) {
        v.push(d.join("config.toml"));
    }
    let oc = opencode_config_dir(home);
    v.push(oc.join("opencode.jsonc"));
    v.push(oc.join("opencode.json"));
    for p in projects {
        let p = Path::new(p);
        v.push(p.join(".mcp.json"));
        v.push(p.join(".claude").join("settings.json"));
        v.push(p.join(".claude").join("settings.local.json"));
    }
    v
}

/// Firma barata (rutas + mtime + tamaño) de los ficheros vigilados: si cambia, hay que volver a listar.
pub(crate) fn stamp_in(home: &Path, projects: &[String]) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for f in watched_files(home, projects) {
        f.hash(&mut h);
        if let Ok(m) = std::fs::metadata(&f) {
            m.len().hash(&mut h);
            if let Ok(t) = m.modified() {
                t.hash(&mut h);
            }
        }
    }
    format!("{:016x}", h.finish())
}

#[tauri::command]
pub async fn mcpm_stamp(projects: Option<Vec<String>>) -> Result<String, String> {
    let home = home().ok_or("No user folder")?;
    let projects = projects.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || stamp_in(&home, &projects)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mcpm_list(projects: Option<Vec<String>>) -> Result<Vec<McpAccount>, String> {
    let home = home().ok_or("No user folder")?;
    let projects = projects.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || list_with(&home, &projects)).await.map_err(|e| e.to_string())
}

// ---------- sonda ----------

/// Busca la definición real de un MCP en una cuenta y el entorno de esa cuenta.
fn find_def(
    home: &Path,
    account_id: &str,
    scope: &str,
    name: &str,
    project_path: Option<&str>,
) -> Result<(RawDef, Vec<(String, String)>), String> {
    let (provider, dir) = account_id.split_once(':').ok_or("Unknown account")?;
    let (raws, acc_env): (Vec<RawDef>, Vec<(String, String)>) = match provider {
        "claude" => {
            let (d, f, def) = claude_dirs(home)
                .into_iter()
                .find(|(d, _, _)| d.to_string_lossy().eq_ignore_ascii_case(dir))
                .ok_or("Unknown account")?;
            let env = if def { vec![] } else { vec![("CLAUDE_CONFIG_DIR".into(), d.to_string_lossy().into_owned())] };
            let projects: Vec<String> = project_path.filter(|_| scope == "project").map(str::to_string).into_iter().collect();
            (claude_raws(&d, &f, &projects)?.0, env)
        }
        "codex" => {
            let (d, def) = codex_dirs(home)
                .into_iter()
                .find(|(d, _)| d.to_string_lossy().eq_ignore_ascii_case(dir))
                .ok_or("Unknown account")?;
            (codex_raw(&d, def)?, codex_env(&d, def))
        }
        "opencode" if dir == "global" => (opencode_account(home).map(|(_, r)| r).unwrap_or_default(), vec![]),
        _ => return Err("Unknown account".into()),
    };
    let def = raws
        .into_iter()
        .find(|r| {
            r.name == name
                && r.scope == scope
                && (!matches!(scope, "local" | "project") || r.project_path.as_deref().map(norm_path) == project_path.map(norm_path))
        })
        .ok_or("MCP not found in that account")?;
    Ok((def, acc_env))
}

#[tauri::command]
pub async fn mcpm_probe(account_id: String, scope: String, name: String, project_path: Option<String>) -> Result<ProbeResult, String> {
    let home = home().ok_or("No user folder")?;
    tauri::async_runtime::spawn_blocking(move || {
        if scope == "claudeai" {
            return Err("Managed by claude.ai: Orchestra cannot test it".into());
        }
        let (def, env) = find_def(&home, &account_id, &scope, &name, project_path.as_deref())?;
        Ok(probe_def(&def, &env, PROBE_TIMEOUT))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Valores secretos de una definición (para quitarlos de los mensajes).
fn secret_values(d: &RawDef) -> Vec<String> {
    let mut v: Vec<String> = d.env.iter().chain(d.headers.iter()).map(|(_, x)| x.clone()).collect();
    for (_, var) in &d.env_headers {
        if let Ok(x) = std::env::var(var) {
            v.push(x);
        }
    }
    if let Some(u) = &d.url {
        if let Some((_, q)) = u.split_once('?') {
            v.extend(q.split('&').filter_map(|p| p.split_once('=').map(|(_, x)| x.to_string())));
        }
    }
    v.retain(|x| x.len() >= 4);
    v
}

pub(crate) fn probe_def(d: &RawDef, acc_env: &[(String, String)], timeout: Duration) -> ProbeResult {
    let secrets = secret_values(d);
    let refs: Vec<&str> = secrets.iter().map(String::as_str).collect();
    let r = match d.transport {
        "stdio" => probe_stdio(d, acc_env, timeout, &refs),
        "http" => probe_http(d, timeout, &refs),
        _ => probe_sse(d, timeout, &refs),
    };
    match r {
        ProbeResult::Failed { msg } => ProbeResult::Failed { msg: scrub_msg(&msg, &refs) },
        x => x,
    }
}

fn init_request() -> Value {
    json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "orchestra-probe", "version": env!("CARGO_PKG_VERSION")}
        }
    })
}

fn tools_request(id: u64, cursor: Option<&str>) -> Value {
    match cursor {
        Some(c) => json!({"jsonrpc": "2.0", "id": id, "method": "tools/list", "params": {"cursor": c}}),
        None => json!({"jsonrpc": "2.0", "id": id, "method": "tools/list", "params": {}}),
    }
}

fn is_auth_error(msg: &str) -> bool {
    let l = msg.to_ascii_lowercase();
    ["unauthorized", "401", "403", "forbidden", "oauth", "authenticat", "invalid token", "invalid_token", "api key"].iter().any(|w| l.contains(w))
}

/// Error JSON-RPC → resultado.
fn rpc_error(v: &Value) -> ProbeResult {
    let msg = v["error"]["message"].as_str().unwrap_or("error").to_string();
    if is_auth_error(&msg) {
        ProbeResult::NeedsAuth
    } else {
        ProbeResult::Failed { msg }
    }
}

/// Diálogo común: `initialize` → `notifications/initialized` → `tools/list` (con páginas). `rpc` envía un mensaje y,
/// si lleva id, devuelve su respuesta.
fn dialog(mut rpc: impl FnMut(&Value) -> Result<Option<Value>, ProbeResult>) -> ProbeResult {
    let init = match rpc(&init_request()) {
        Ok(Some(v)) => v,
        Ok(None) => return ProbeResult::Failed { msg: "no answer to initialize".into() },
        Err(e) => return e,
    };
    if init.get("error").is_some() {
        return rpc_error(&init);
    }
    let info = &init["result"]["serverInfo"];
    let server_name = str_of(&info["name"]);
    let version = str_of(&info["version"]);
    if let Err(e) = rpc(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"})) {
        return e;
    }
    let mut all_tools: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    for page in 0..20u64 {
        let v = match rpc(&tools_request(2 + page, cursor.as_deref())) {
            Ok(Some(v)) => v,
            Ok(None) => return ProbeResult::Failed { msg: "no answer to tools/list".into() },
            Err(e) => return e,
        };
        if v.get("error").is_some() {
            return rpc_error(&v);
        }
        if let Some(a) = v["result"]["tools"].as_array() {
            all_tools.extend(a.iter().cloned());
        }
        cursor = v["result"]["nextCursor"].as_str().filter(|c| !c.is_empty()).map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    let tools = all_tools.len();
    let tools_bytes = if tools == 0 { 0 } else { serde_json::to_vec(&Value::Array(all_tools)).map(|b| b.len()).unwrap_or(0) };
    ProbeResult::Ok { tools, server_name, version, tools_bytes, tokens_est: tools_bytes.div_ceil(4) }
}

// --- stdio ---

/// Busca un comando sin ruta en PATH con PATHEXT (como haría cmd) para poder lanzar `npx` (un .cmd) directamente.
pub(crate) fn resolve_command(cmd: &str, path: Option<&std::ffi::OsStr>, cwd: Option<&Path>) -> PathBuf {
    let p = Path::new(cmd);
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| e.to_ascii_lowercase())
        .collect();
    let with_ext = |base: &Path| -> Option<PathBuf> {
        if base.extension().is_some() && base.is_file() {
            return Some(base.to_path_buf());
        }
        exts.iter().map(|e| PathBuf::from(format!("{}{}", base.display(), e))).find(|c| c.is_file())
    };
    if p.is_absolute() || cmd.contains(['/', '\\']) {
        let base = match cwd {
            Some(c) if !p.is_absolute() => c.join(p),
            _ => p.to_path_buf(),
        };
        return with_ext(&base).unwrap_or(base);
    }
    if let Some(path) = path {
        for d in std::env::split_paths(path) {
            if let Some(f) = with_ext(&d.join(cmd)) {
                return f;
            }
        }
    }
    p.to_path_buf()
}

#[cfg(windows)]
mod job {
    //! Job Object con KILL_ON_JOB_CLOSE: al cerrarlo muere el árbol entero (npx → node → …).
    use std::os::windows::io::AsRawHandle;

    type Handle = *mut core::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimit {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        v: [u64; 6],
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *const core::ffi::c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const core::ffi::c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn CloseHandle(h: Handle) -> i32;
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtResumeProcess(process: Handle) -> i32;
    }

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    pub const CREATE_SUSPENDED: u32 = 0x0000_0004;

    pub struct Job(Handle);
    // El handle solo se usa desde el hilo que hace la sonda; se mueve, no se comparte.
    unsafe impl Send for Job {}

    impl Job {
        /// Mete un hijo lanzado con CREATE_SUSPENDED en un job nuevo y lo reanuda.
        pub fn adopt(child: &std::process::Child) -> Option<Job> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return None;
                }
                let job = Job(h);
                let mut info = ExtendedLimit::default();
                info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    h,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<ExtendedLimit>() as u32,
                ) != 0
                    && AssignProcessToJobObject(h, child.as_raw_handle() as Handle) != 0;
                NtResumeProcess(child.as_raw_handle() as Handle);
                ok.then_some(job)
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                TerminateJobObject(self.0, 1);
                CloseHandle(self.0);
            }
        }
    }
}

fn probe_stdio(d: &RawDef, acc_env: &[(String, String)], timeout: Duration, secrets: &[&str]) -> ProbeResult {
    let deadline = Instant::now() + timeout;
    let Some(command) = d.command.as_deref().filter(|c| !c.trim().is_empty()) else {
        return ProbeResult::Failed { msg: "no command".into() };
    };
    let cwd = d.cwd.as_deref().map(PathBuf::from).filter(|p| p.is_dir());
    // PATH del entorno resultante (la definición puede cambiarlo).
    let path = d
        .env
        .iter()
        .chain(acc_env.iter())
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| std::ffi::OsString::from(v))
        .or_else(|| std::env::var_os("PATH"));
    let exe = resolve_command(command, path.as_deref(), cwd.as_deref());
    let mut cmd = Command::new(&exe);
    cmd.args(&d.args);
    for (k, v) in acc_env.iter().chain(d.env.iter()) {
        cmd.env(k, v);
    }
    if let Some(c) = &cwd {
        cmd.current_dir(c);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000 | job::CREATE_SUSPENDED); // CREATE_NO_WINDOW
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return ProbeResult::Failed { msg: format!("could not start {command}: {e}") },
    };
    #[cfg(windows)]
    let job = job::Job::adopt(&child);
    let result = (|| {
        let mut stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");
        let (tx, rx) = mpsc::channel::<Value>();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                    if tx.send(v).is_err() {
                        break;
                    }
                }
            }
        });
        let err_buf = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<u8>::new()));
        {
            let err_buf = err_buf.clone();
            std::thread::spawn(move || {
                let mut r = stderr;
                let mut chunk = [0u8; 2048];
                while let Ok(n) = r.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    let mut b = err_buf.lock();
                    if b.len() < 8192 {
                        b.extend_from_slice(&chunk[..n]);
                    }
                }
            });
        }
        let stderr_line = |exit: Option<i32>| -> ProbeResult {
            std::thread::sleep(Duration::from_millis(100));
            let text = String::from_utf8_lossy(&err_buf.lock()).into_owned();
            let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string();
            if is_auth_error(&first) {
                return ProbeResult::NeedsAuth;
            }
            let msg = if first.is_empty() {
                match exit {
                    Some(c) => format!("exited with code {c}"),
                    None => "closed its output".into(),
                }
            } else {
                first
            };
            ProbeResult::Failed { msg: scrub_msg(&msg, secrets) }
        };
        let mut rpc = |msg: &Value| -> Result<Option<Value>, ProbeResult> {
            let mut line = msg.to_string();
            line.push('\n');
            if stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).is_err() {
                let code = child.try_wait().ok().flatten().and_then(|s| s.code());
                return Err(stderr_line(code));
            }
            let Some(id) = msg.get("id").cloned() else { return Ok(None) };
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(ProbeResult::Timeout);
                }
                match rx.recv_timeout(left.min(Duration::from_millis(200))) {
                    Ok(v) if v.get("id") == Some(&id) && v.get("method").is_none() => return Ok(Some(v)),
                    Ok(v) => {
                        // Petición del servidor (roots/list, sampling…): se contesta que no.
                        if let (Some(rid), Some(_)) = (v.get("id"), v.get("method")) {
                            let r = json!({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "not supported by the probe"}});
                            let _ = stdin.write_all(format!("{r}\n").as_bytes());
                            let _ = stdin.flush();
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if let Ok(Some(st)) = child.try_wait() {
                            return Err(stderr_line(st.code()));
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        let st = child.try_wait().ok().flatten();
                        return Err(stderr_line(st.and_then(|s| s.code())));
                    }
                }
            }
        };
        dialog(&mut rpc)
    })();
    #[cfg(windows)]
    {
        if job.is_none() {
            // Sin job (no debería pasar): se mata el árbol por PID.
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        drop(job);
    }
    let _ = child.kill();
    let _ = child.wait();
    result
}

// --- http ---

fn http_agent(url: &str, timeout: Duration) -> ureq::Agent {
    let loopback = {
        let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
        let host = rest.split(['/', '?']).next().unwrap_or("");
        let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host);
        let host = if host.starts_with('[') { host.split(']').next().unwrap_or("").trim_start_matches('[') } else { host.split(':').next().unwrap_or("") };
        host.eq_ignore_ascii_case("localhost") || host.starts_with("127.") || host == "::1"
    };
    let mut cfg = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .max_redirects(3)
        .http_status_as_error(false);
    if loopback {
        cfg = cfg.proxy(None);
    }
    cfg.build().into()
}

fn real_headers(d: &RawDef) -> Vec<(String, String)> {
    let mut h = d.headers.clone();
    for (name, var) in &d.env_headers {
        if let Ok(v) = std::env::var(var) {
            let v = if name.eq_ignore_ascii_case("authorization") && !v.contains(' ') { format!("Bearer {v}") } else { v };
            h.push((name.clone(), v));
        }
    }
    h
}

fn net_error(e: &ureq::Error) -> ProbeResult {
    match e {
        ureq::Error::Timeout(_) => ProbeResult::Timeout,
        ureq::Error::Io(io) if io.kind() == std::io::ErrorKind::TimedOut => ProbeResult::Timeout,
        _ => ProbeResult::Failed { msg: format!("network error: {e}") },
    }
}

/// Lee eventos SSE (`data:`) de un cuerpo y devuelve el primero que sea la respuesta con ese id.
fn sse_find(reader: impl Read, id: &Value) -> Option<Value> {
    let mut data = String::new();
    for line in BufReader::new(reader).lines() {
        let line = line.ok()?;
        if let Some(d) = line.strip_prefix("data:") {
            data.push_str(d.trim_start());
        } else if line.is_empty() && !data.is_empty() {
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                if v.get("id") == Some(id) && v.get("method").is_none() {
                    return Some(v);
                }
            }
            data.clear();
        }
    }
    None
}

fn probe_http(d: &RawDef, timeout: Duration, _secrets: &[&str]) -> ProbeResult {
    let Some(url) = d.url.clone() else { return ProbeResult::Failed { msg: "no url".into() } };
    let deadline = Instant::now() + timeout;
    let headers = real_headers(d);
    let mut session: Option<String> = None;
    let mut proto: Option<String> = None;
    let rpc = |msg: &Value| -> Result<Option<Value>, ProbeResult> {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(ProbeResult::Timeout);
        }
        let agent = http_agent(&url, left);
        let mut req = agent
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("User-Agent", format!("Orchestra/{}", env!("CARGO_PKG_VERSION")));
        for (k, v) in &headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(s) = &session {
            req = req.header("Mcp-Session-Id", s.as_str());
        }
        if let Some(p) = &proto {
            req = req.header("MCP-Protocol-Version", p.as_str());
        }
        let mut resp = req.send(msg.to_string()).map_err(|e| net_error(&e))?;
        let status = resp.status().as_u16();
        if status == 401 || status == 403 {
            return Err(ProbeResult::NeedsAuth);
        }
        if let Some(s) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            session = Some(s.to_string());
        }
        let Some(id) = msg.get("id") else { return Ok(None) };
        if !(200..300).contains(&status) {
            return Err(ProbeResult::Failed { msg: format!("HTTP {status}") });
        }
        let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
        let reader = resp.body_mut().as_reader().take(4 * 1024 * 1024);
        let v = if ctype.contains("text/event-stream") {
            sse_find(reader, id)
        } else {
            let mut s = String::new();
            let mut r = reader;
            r.read_to_string(&mut s).map_err(|e| if e.kind() == std::io::ErrorKind::TimedOut { ProbeResult::Timeout } else { ProbeResult::Failed { msg: "unreadable answer".into() } })?;
            serde_json::from_str::<Value>(&s).ok()
        };
        let v = v.ok_or(if Instant::now() >= deadline { ProbeResult::Timeout } else { ProbeResult::Failed { msg: "the answer is not JSON-RPC".into() } })?;
        if proto.is_none() {
            proto = v["result"]["protocolVersion"].as_str().map(str::to_string);
        }
        Ok(Some(v))
    };
    dialog(rpc)
}

// --- sse (transporte antiguo: GET con eventos + POST al «endpoint») ---

fn join_url(base: &str, rel: &str) -> String {
    if rel.starts_with("http://") || rel.starts_with("https://") {
        return rel.to_string();
    }
    let (scheme, rest) = base.split_once("://").unwrap_or(("http", base));
    let host_end = rest.find('/').unwrap_or(rest.len());
    let origin = format!("{scheme}://{}", &rest[..host_end]);
    if rel.starts_with('/') {
        return format!("{origin}{rel}");
    }
    let path = rest[host_end..].split('?').next().unwrap_or("");
    let dir = path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    format!("{origin}{dir}/{rel}")
}

fn probe_sse(d: &RawDef, timeout: Duration, _secrets: &[&str]) -> ProbeResult {
    let Some(url) = d.url.clone() else { return ProbeResult::Failed { msg: "no url".into() } };
    let deadline = Instant::now() + timeout;
    let headers = real_headers(d);
    let agent = http_agent(&url, timeout);
    let mut req = agent.get(&url).header("Accept", "text/event-stream");
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let resp = match req.call() {
        Ok(r) => r,
        Err(e) => return net_error(&e),
    };
    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return ProbeResult::NeedsAuth;
    }
    if !(200..300).contains(&status) {
        return ProbeResult::Failed { msg: format!("HTTP {status}") };
    }
    // Hilo que lee eventos: (event, data).
    let (tx, rx) = mpsc::channel::<(String, String)>();
    let body = resp.into_body();
    std::thread::spawn(move || {
        let mut ev = String::new();
        let mut data = String::new();
        for line in BufReader::new(body.into_reader()).lines() {
            let Ok(line) = line else { break };
            if let Some(e) = line.strip_prefix("event:") {
                ev = e.trim().to_string();
            } else if let Some(x) = line.strip_prefix("data:") {
                data.push_str(x.trim_start());
            } else if line.is_empty() && !data.is_empty() {
                if tx.send((std::mem::take(&mut ev), std::mem::take(&mut data))).is_err() {
                    break;
                }
            }
        }
    });
    let endpoint = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok((e, data)) if e == "endpoint" => break join_url(&url, data.trim()),
            Ok(_) => continue,
            Err(mpsc::RecvTimeoutError::Timeout) => return ProbeResult::Timeout,
            Err(_) => return ProbeResult::Failed { msg: "the event stream closed".into() },
        }
    };
    let rpc = |msg: &Value| -> Result<Option<Value>, ProbeResult> {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(ProbeResult::Timeout);
        }
        let mut req = http_agent(&endpoint, left).post(&endpoint).header("Content-Type", "application/json");
        for (k, v) in &headers {
            req = req.header(k.as_str(), v.as_str());
        }
        let resp = req.send(msg.to_string()).map_err(|e| net_error(&e))?;
        let st = resp.status().as_u16();
        if st == 401 || st == 403 {
            return Err(ProbeResult::NeedsAuth);
        }
        if !(200..300).contains(&st) {
            return Err(ProbeResult::Failed { msg: format!("HTTP {st}") });
        }
        let Some(id) = msg.get("id") else { return Ok(None) };
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok((_, data)) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&data) {
                        if v.get("id") == Some(id) && v.get("method").is_none() {
                            return Ok(Some(v));
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => return Err(ProbeResult::Timeout),
                Err(_) => return Err(ProbeResult::Failed { msg: "the event stream closed".into() }),
            }
        }
    };
    dialog(rpc)
}
