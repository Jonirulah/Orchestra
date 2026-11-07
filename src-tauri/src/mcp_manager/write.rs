//! Gestor de MCP, fase F2: ESCRIBIR (añadir, quitar, copiar a otras cuentas) con vista previa, copia de seguridad y
//! deshacer.
//!
//! - Claude y Codex: siempre con su CLI oficial (`claude mcp add-json/remove -s user`, `codex mcp add/remove`)
//!   lanzada SIN shell (argumentos tal cual), ventana oculta, entorno de la cuenta y plazo.
//! - opencode: su `mcp add` (2.2.5) escribe `mcp.servers.<name>`, que su propio `mcp list` a veces no ve, y no tiene
//!   `remove`; así que Orchestra edita la clave `mcp.<name>` de `opencode.json(c)` con una edición mínima que
//!   conserva comentarios y formato (ver `jsonc`).
//! - Antes de cada cambio se guarda una copia del fichero que la herramienta va a modificar (rotación de 10 por
//!   fichero) y el contenido que quedó después: «Deshacer» solo restaura si el fichero sigue igual que tras el cambio.
//! - Los valores secretos (env, cabeceras, query de la URL) nunca vuelven a la interfaz: la vista previa los enseña
//!   como `•••` y, al copiar de una cuenta a otra, se leen aquí de la cuenta origen.

use super::*;
use serde::Deserialize;

#[cfg(test)]
#[path = "write_tests.rs"]
mod tests;

const CLI_TIMEOUT: Duration = Duration::from_secs(60);
const KEEP_SNAPSHOTS: usize = 10;

// ---------- entrada ----------

#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
pub struct Kv {
    pub key: String,
    pub value: String,
}

/// Definición que llega del formulario (los valores los ha escrito el usuario).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DefInput {
    pub name: String,
    /// "stdio" | "http" | "sse"
    pub transport: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub env: Vec<Kv>,
    pub headers: Vec<Kv>,
    /// Variable de entorno con el token (cabecera `Authorization: Bearer <valor>`).
    pub bearer_env_var: Option<String>,
    /// Claude: "user" (por defecto), "local" (solo tú, en `project_path`) o "project" (`.mcp.json` de `project_path`).
    /// Codex y opencode solo tienen ámbito global: con otro, ese paso queda bloqueado (la vista previa lo dice).
    pub scope: Option<String>,
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub account_id: String,
    pub scope: String,
    pub name: String,
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Change {
    /// Añadir desde el formulario. `replace`: si ya existe con ese nombre, sustituirlo.
    #[serde(rename_all = "camelCase")]
    Add { def: DefInput, targets: Vec<String>, #[serde(default)] replace: bool },
    /// «Aplicar a…» (replace = false) e «Igualar a esta» (replace = true): la definición se lee de la cuenta origen.
    #[serde(rename_all = "camelCase")]
    /// `include_local`: Claude, también quita las copias del ámbito local (de cada proyecto) que tienen OTRA definición:
    /// si no, en esa carpeta se sigue usando la del local (gana a la de usuario).
    Copy { from: SourceRef, targets: Vec<String>, #[serde(default)] replace: bool, #[serde(default)] include_local: bool },
    /// `include_local`: Claude, también quita las copias del ámbito local (`claude mcp remove --scope local` en esa carpeta).
    #[serde(rename_all = "camelCase")]
    Remove { name: String, targets: Vec<String>, #[serde(default)] include_local: bool },
    /// Aprobar un MCP de `.mcp.json` en un proyecto. Como Claude Code 2.1.319 al pulsar «Use this MCP server»: añade el
    /// nombre a `enabledMcpjsonServers` de `<proyecto>/.claude/settings.local.json` (vale para todas las cuentas de
    /// Claude en esa carpeta) y lo quita de `disabledMcpjsonServers` si estaba rechazado.
    #[serde(rename_all = "camelCase")]
    Approve { account_id: String, name: String, project_path: String },
    /// Encender / apagar. Claude: `projects[<carpeta>].disabledMcpServers` de `.claude.json` de la cuenta (lo que hace
    /// `/mcp` → enable/disable); un MCP de `.mcp.json` rechazado se enciende aprobándolo. opencode: `enabled` del
    /// servidor. Codex: no (bloqueado con el motivo).
    #[serde(rename_all = "camelCase")]
    SetEnabled { account_id: String, name: String, scope: String, #[serde(default)] project_path: Option<String>, on: bool },
}

// ---------- salida ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub account_id: String,
    pub provider: &'static str,
    /// "add" | "replace" | "remove" | "skip"
    pub action: &'static str,
    /// Fichero que se va a modificar (y del que se hace copia).
    pub file: String,
    /// Comandos exactos (secretos como •••) o cambio de fichero, uno por línea.
    pub lines: Vec<String>,
    /// Si no se puede hacer (y por qué). No se aplica nada de este paso.
    pub blocked: Option<String>,
    /// Aviso o motivo de `skip`.
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub account_id: String,
    /// "ok" | "failed" | "skipped"
    pub status: &'static str,
    pub msg: String,
    /// Tras aplicar, releído el fichero: aparece (add/replace) o ya no está (remove). `None` si no se aplicó.
    pub verified: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub steps: Vec<StepResult>,
    /// Id del cambio guardado para «Deshacer» (None si no se tocó ningún fichero).
    pub undo_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UndoInfo {
    pub id: u64,
    pub summary: String,
    pub files: Vec<String>,
}

// ---------- operaciones internas ----------

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CliOp {
    pub program: &'static str,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Carpeta desde la que se lanza (ámbitos local y project de Claude: la CLI usa la carpeta actual).
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Op {
    Cli(CliOp),
    OcSet { name: String, value: Value },
    OcRemove { name: String },
    /// Pone `value` en la ruta de claves `path` de un JSON (solo ese trozo del texto cambia).
    JsonSet { path: Vec<String>, value: Value },
}

#[derive(Debug, Clone)]
pub(crate) struct Step {
    pub public: PlanStep,
    pub ops: Vec<Op>,
    pub file: PathBuf,
    pub secrets: Vec<String>,
    /// Lo que debe quedar: `Some(def)` presente, `None` ausente.
    pub expect: Option<RawDef>,
    pub target: Target,
    /// Acciones de estado: lo que tiene que quedar escrito en el fichero (ruta de claves → valor), para comprobarlo.
    pub check: Vec<(Vec<String>, Value)>,
}

#[derive(Debug, Clone)]
pub(crate) struct Target {
    pub id: String,
    pub provider: &'static str,
    pub file: PathBuf,
    pub env: Vec<(String, String)>,
    /// Ámbito en el que se escribe: "user" (Claude, Codex), "global" (opencode), "local" o "project" (Claude).
    pub scope: &'static str,
    /// Carpeta del proyecto (ámbitos local y project).
    pub project: Option<String>,
}

/// Dónde vive cada cosa (en pruebas, carpetas falsas).
pub(crate) struct Env<'a> {
    pub home: &'a Path,
    pub opencode_dir: PathBuf,
}

impl<'a> Env<'a> {
    pub fn real(home: &'a Path) -> Self {
        Env { home, opencode_dir: opencode_config_dir(home) }
    }
}

// ---------- validación ----------

fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 64 && !n.starts_with(['-', '.']) && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn valid_var(n: &str) -> bool {
    !n.is_empty() && !n.starts_with(|c: char| c.is_ascii_digit()) && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn valid_header(n: &str) -> bool {
    !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
}

/// Formulario → definición real. `Err` con el primer problema.
pub(crate) fn def_from_input(d: &DefInput) -> Result<RawDef, String> {
    let name = d.name.trim();
    if !valid_name(name) {
        return Err("Invalid name: use letters, digits, '-', '_' or '.' (max 64)".into());
    }
    let transport: &'static str = match d.transport.as_str() {
        "stdio" => "stdio",
        "http" => "http",
        "sse" => "sse",
        _ => return Err("Unknown transport".into()),
    };
    let mut r = RawDef { name: name.to_string(), transport, scope: "user", raw_kind: transport.to_string(), ..Default::default() };
    for kv in &d.env {
        if !valid_var(kv.key.trim()) {
            return Err(format!("Invalid variable name: {}", kv.key));
        }
        r.env.push((kv.key.trim().to_string(), kv.value.clone()));
    }
    if transport == "stdio" {
        let cmd = d.command.as_deref().map(str::trim).filter(|c| !c.is_empty()).ok_or("A stdio server needs a command")?;
        r.command = Some(cmd.to_string());
        r.args = d.args.clone();
        if !d.headers.is_empty() || d.bearer_env_var.as_deref().is_some_and(|v| !v.trim().is_empty()) {
            return Err("Headers only apply to HTTP servers".into());
        }
    } else {
        let url = d.url.as_deref().map(str::trim).filter(|u| !u.is_empty()).ok_or("An HTTP server needs a URL")?;
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("The URL must start with http:// or https://".into());
        }
        if !d.env.is_empty() {
            return Err("Environment variables only apply to stdio servers".into());
        }
        r.url = Some(url.to_string());
        for kv in &d.headers {
            if !valid_header(kv.key.trim()) {
                return Err(format!("Invalid header name: {}", kv.key));
            }
            r.headers.push((kv.key.trim().to_string(), kv.value.clone()));
        }
        if let Some(v) = d.bearer_env_var.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            if !valid_var(v) {
                return Err(format!("Invalid variable name: {v}"));
            }
            r.env_passthrough.push(v.to_string());
            r.env_headers.push(("Authorization".into(), v.to_string()));
        }
    }
    Ok(r)
}

// ---------- traducción por herramienta ----------

/// `${VAR}` (Claude) ↔ `{env:VAR}` (opencode).
fn claude_to_opencode_refs(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("${") {
        let after = &rest[i + 2..];
        match after.find('}') {
            Some(j) if valid_var(&after[..j]) => {
                out.push_str(&rest[..i]);
                out.push_str(&format!("{{env:{}}}", &after[..j]));
                rest = &after[j + 1..];
            }
            _ => {
                out.push_str(&rest[..i + 2]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn opencode_to_claude_refs(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("{env:") {
        let after = &rest[i + 5..];
        match after.find('}') {
            Some(j) if valid_var(&after[..j]) => {
                out.push_str(&rest[..i]);
                out.push_str(&format!("${{{}}}", &after[..j]));
                rest = &after[j + 1..];
            }
            _ => {
                out.push_str(&rest[..i + 5]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Valor de cabecera `Bearer ${VAR}` / `Bearer {env:VAR}` → `VAR`.
fn bearer_var(v: &str) -> Option<String> {
    let t = v.trim();
    let rest = t.strip_prefix("Bearer ").or_else(|| t.strip_prefix("bearer "))?.trim();
    let var = rest.strip_prefix("${").and_then(|r| r.strip_suffix('}')).or_else(|| rest.strip_prefix("{env:").and_then(|r| r.strip_suffix('}')))?;
    valid_var(var).then(|| var.to_string())
}

fn header_ref(h: &str, var: &str, style: &str) -> String {
    let r = if style == "claude" { format!("${{{var}}}") } else { format!("{{env:{var}}}") };
    if h.eq_ignore_ascii_case("authorization") {
        format!("Bearer {r}")
    } else {
        r
    }
}

/// Definición genérica → cómo la guardará esa herramienta. `Err` = no se puede expresar ahí (no se aplica a medias).
pub(crate) fn translate(src: &RawDef, provider: &str) -> Result<RawDef, String> {
    if src.cwd.as_deref().is_some_and(|c| !c.is_empty()) {
        return Err("It sets a working directory (cwd), which the CLI cannot write; copy it by hand".into());
    }
    let header_vars: Vec<&str> = src.env_headers.iter().map(|(_, v)| v.as_str()).collect();
    let plain_pass: Vec<&String> = src.env_passthrough.iter().filter(|v| !header_vars.contains(&v.as_str())).collect();
    let mut d = RawDef {
        name: src.name.clone(),
        transport: src.transport,
        command: src.command.clone(),
        args: src.args.clone(),
        url: src.url.clone(),
        scope: if provider == "opencode" { "global" } else { "user" },
        ..Default::default()
    };
    match provider {
        "claude" => {
            d.raw_kind = src.transport.to_string();
            d.env = src.env.iter().map(|(k, v)| (k.clone(), opencode_to_claude_refs(v))).collect();
            for v in &plain_pass {
                d.env.push(((*v).clone(), format!("${{{v}}}")));
            }
            d.headers = src.headers.iter().map(|(k, v)| (k.clone(), opencode_to_claude_refs(v))).collect();
            for (h, var) in &src.env_headers {
                d.headers.push((h.clone(), header_ref(h, var, "claude")));
            }
        }
        "codex" => {
            if src.transport == "sse" {
                return Err("Codex only supports stdio and streamable HTTP servers, not SSE".into());
            }
            if !plain_pass.is_empty() {
                return Err("Codex CLI cannot set pass-through variables (env_vars); add them by hand in config.toml".into());
            }
            d.raw_kind = if src.transport == "stdio" { "stdio".into() } else { "streamable_http".into() };
            d.env = src.env.clone();
            if d.env.iter().any(|(_, v)| v.contains("${") || v.contains("{env:")) {
                return Err("Codex does not expand ${VAR} in env values".into());
            }
            let mut bearer: Option<String> = None;
            for (h, var) in &src.env_headers {
                if h.eq_ignore_ascii_case("authorization") && bearer.is_none() {
                    bearer = Some(var.clone());
                } else {
                    return Err(format!("Codex CLI can only take a bearer token from a variable; header {h} cannot be written"));
                }
            }
            for (h, v) in &src.headers {
                match bearer_var(v) {
                    Some(var) if h.eq_ignore_ascii_case("authorization") && bearer.is_none() => bearer = Some(var),
                    _ => {
                        return Err(format!(
                            "Codex CLI cannot set HTTP headers ({h}); use a bearer-token variable or add it by hand in config.toml"
                        ))
                    }
                }
            }
            if let Some(var) = bearer {
                d.env_passthrough.push(var.clone());
                d.env_headers.push(("Authorization".into(), var));
            }
        }
        "opencode" => {
            d.raw_kind = if src.transport == "stdio" { "local".into() } else { "remote".into() };
            d.transport = if src.transport == "stdio" { "stdio" } else { "http" };
            d.env = src.env.iter().map(|(k, v)| (k.clone(), claude_to_opencode_refs(v))).collect();
            for v in &plain_pass {
                d.env.push(((*v).clone(), format!("{{env:{v}}}")));
            }
            d.headers = src.headers.iter().map(|(k, v)| (k.clone(), claude_to_opencode_refs(v))).collect();
            for (h, var) in &src.env_headers {
                d.headers.push((h.clone(), header_ref(h, var, "opencode")));
            }
        }
        _ => return Err("Unknown tool".into()),
    }
    Ok(d)
}

// ---------- comandos por herramienta (sin ejecutar) ----------

pub(crate) fn claude_json_of(d: &RawDef) -> Value {
    let mut o = serde_json::Map::new();
    o.insert("type".into(), json!(d.transport));
    if d.transport == "stdio" {
        o.insert("command".into(), json!(d.command.clone().unwrap_or_default()));
        o.insert("args".into(), json!(d.args));
        if !d.env.is_empty() {
            o.insert("env".into(), Value::Object(d.env.iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
        }
    } else {
        o.insert("url".into(), json!(d.url.clone().unwrap_or_default()));
        if !d.headers.is_empty() {
            o.insert("headers".into(), Value::Object(d.headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
        }
    }
    Value::Object(o)
}

pub(crate) fn claude_add_args(d: &RawDef) -> Vec<String> {
    claude_add_args_in(d, "user")
}

pub(crate) fn claude_add_args_in(d: &RawDef, scope: &str) -> Vec<String> {
    vec!["mcp".into(), "add-json".into(), d.name.clone(), claude_json_of(d).to_string(), "--scope".into(), scope.into()]
}

pub(crate) fn claude_remove_args(name: &str) -> Vec<String> {
    vec!["mcp".into(), "remove".into(), name.to_string(), "--scope".into(), "user".into()]
}

pub(crate) fn codex_add_args(d: &RawDef) -> Vec<String> {
    let mut a: Vec<String> = vec!["mcp".into(), "add".into(), d.name.clone()];
    if d.transport == "stdio" {
        for (k, v) in &d.env {
            a.push("--env".into());
            a.push(format!("{k}={v}"));
        }
        a.push("--".into());
        a.push(d.command.clone().unwrap_or_default());
        a.extend(d.args.iter().cloned());
    } else {
        a.push("--url".into());
        a.push(d.url.clone().unwrap_or_default());
        if let Some((_, var)) = d.env_headers.first() {
            a.push("--bearer-token-env-var".into());
            a.push(var.clone());
        }
    }
    a
}

pub(crate) fn codex_remove_args(name: &str) -> Vec<String> {
    vec!["mcp".into(), "remove".into(), name.to_string()]
}

pub(crate) fn opencode_value_of(d: &RawDef) -> Value {
    let mut o = serde_json::Map::new();
    if d.transport == "stdio" {
        o.insert("type".into(), json!("local"));
        let mut cmd = vec![d.command.clone().unwrap_or_default()];
        cmd.extend(d.args.iter().cloned());
        o.insert("command".into(), json!(cmd));
        if !d.env.is_empty() {
            o.insert("environment".into(), Value::Object(d.env.iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
        }
    } else {
        o.insert("type".into(), json!("remote"));
        o.insert("url".into(), json!(d.url.clone().unwrap_or_default()));
        if !d.headers.is_empty() {
            o.insert("headers".into(), Value::Object(d.headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
        }
    }
    o.insert("enabled".into(), json!(true));
    Value::Object(o)
}

/// La misma definición con los secretos como `•••` (para enseñar el comando).
pub(crate) fn masked(d: &RawDef) -> RawDef {
    let mut m = d.clone();
    let keep_ref = |v: &str| v.contains("${") || v.contains("{env:");
    m.env = d.env.iter().map(|(k, v)| (k.clone(), if keep_ref(v) { v.clone() } else { MASK.to_string() })).collect();
    m.headers = d
        .headers
        .iter()
        .map(|(k, v)| (k.clone(), if bearer_var(v).is_some() { v.clone() } else { MASK.to_string() }))
        .collect();
    m.url = d.url.as_deref().map(mask_url);
    m.args = mask_args(&d.args);
    m
}

/// Cita un argumento para enseñarlo (no se ejecuta por shell: es solo para leerlo).
pub(crate) fn show_arg(a: &str) -> String {
    if !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=\\@,+%".contains(c) || c == '•') {
        a.to_string()
    } else {
        format!("'{}'", a.replace('\'', "'\\''"))
    }
}

pub(crate) fn show_cli(op: &CliOp) -> String {
    let mut s = String::new();
    if let Some(c) = &op.cwd {
        s.push_str(&format!("cd {} && ", show_arg(c)));
    }
    for (k, v) in &op.env {
        s.push_str(&format!("{k}={} ", show_arg(v)));
    }
    s.push_str(op.program);
    for a in &op.args {
        s.push(' ');
        s.push_str(&show_arg(a));
    }
    s
}

// ---------- cuentas destino ----------

fn opencode_file(dir: &Path) -> PathBuf {
    let jsonc = dir.join("opencode.jsonc");
    if jsonc.is_file() {
        jsonc
    } else {
        dir.join("opencode.json")
    }
}

pub(crate) fn resolve_target(env: &Env, id: &str) -> Result<Target, String> {
    let (provider, dir) = id.split_once(':').ok_or("Unknown account")?;
    match provider {
        "claude" => {
            let (d, f, def) = claude_dirs(env.home)
                .into_iter()
                .find(|(d, _, _)| d.to_string_lossy().eq_ignore_ascii_case(dir))
                .ok_or("Unknown account")?;
            let e = if def { vec![] } else { vec![("CLAUDE_CONFIG_DIR".into(), d.to_string_lossy().into_owned())] };
            Ok(Target { id: id.to_string(), provider: "claude", file: f, env: e, scope: "user", project: None })
        }
        "codex" => {
            let (d, def) = codex_dirs(env.home)
                .into_iter()
                .find(|(d, _)| d.to_string_lossy().eq_ignore_ascii_case(dir))
                .ok_or("Unknown account")?;
            Ok(Target { id: id.to_string(), provider: "codex", file: d.join("config.toml"), env: codex_env(&d, def), scope: "user", project: None })
        }
        "opencode" if dir == "global" => Ok(Target {
            id: id.to_string(),
            provider: "opencode",
            file: opencode_file(&env.opencode_dir),
            env: vec![],
            scope: "global",
            project: None,
        }),
        _ => Err("Unknown account".into()),
    }
}

/// Cambia el ámbito de escritura de una cuenta destino (formulario «Añadir»). Solo Claude tiene «local» y «project».
pub(crate) fn with_scope(mut t: Target, scope: Option<&str>, project: Option<&str>) -> Result<Target, String> {
    let scope = match scope.unwrap_or("user") {
        "user" | "" => return Ok(t),
        "local" => "local",
        "project" => "project",
        _ => return Err("Unknown scope".into()),
    };
    if t.provider != "claude" {
        return Err(format!("Only Claude Code has a {scope} scope; {} only has a global one", if t.provider == "codex" { "Codex" } else { "opencode" }));
    }
    let p = project.map(str::trim).filter(|p| !p.is_empty()).ok_or("Choose the project folder")?;
    if !Path::new(p).is_dir() {
        return Err(format!("The project folder does not exist: {p}"));
    }
    if scope == "project" {
        t.file = Path::new(p).join(".mcp.json");
    }
    t.scope = scope;
    t.project = Some(p.to_string());
    Ok(t)
}

/// `[mcp_servers.<name>]` (o `."name"`) en el config.toml de Codex: basta para saber si existe.
pub(crate) fn codex_toml_has(text: &str, name: &str) -> bool {
    text.lines().any(|l| {
        let Some(rest) = l.trim().strip_prefix("[mcp_servers.") else { return false };
        let table = if let Some(q) = rest.strip_prefix('"') {
            q.split('"').next().unwrap_or("")
        } else {
            rest.split(['.', ']']).next().unwrap_or("").trim()
        };
        table == name
    })
}

/// Lo que hay ahora con ese nombre en la cuenta (ámbito que Orchestra edita). Codex: solo si existe (sin valores).
fn existing(t: &Target, name: &str) -> Result<Option<RawDef>, String> {
    match t.provider {
        "claude" => {
            let text = match std::fs::read_to_string(&t.file) {
                Ok(s) => s,
                Err(_) => return Ok(None),
            };
            if t.scope == "project" {
                let v: Value = serde_json::from_str(&text).map_err(|e| format!("malformed .mcp.json (line {})", e.line()))?;
                return Ok(v["mcpServers"].get(name).map(|d| claude_entry(name, d, "project", t.project.as_deref())));
            }
            let cf = parse_claude_file(&text)?;
            let here = |d: &RawDef| match t.scope {
                "local" => d.scope == "local" && d.project_path.as_deref().map(norm_path) == t.project.as_deref().map(norm_path),
                _ => d.scope == "user",
            };
            Ok(cf.defs.into_iter().find(|d| here(d) && d.name == name))
        }
        "codex" => {
            let text = std::fs::read_to_string(&t.file).unwrap_or_default();
            Ok(codex_toml_has(&text, name).then(|| RawDef { name: name.to_string(), ..Default::default() }))
        }
        _ => {
            let text = match std::fs::read_to_string(&t.file) {
                Ok(s) => s,
                Err(_) => return Ok(None),
            };
            Ok(parse_opencode(&text)?.into_iter().find(|d| d.name == name))
        }
    }
}

fn claude_local_only(t: &Target, name: &str) -> bool {
    !claude_locals(t, name).is_empty()
}

/// Copias con ese nombre en el ámbito local de algún proyecto (`projects.<carpeta>.mcpServers` del `.claude.json`).
fn claude_locals(t: &Target, name: &str) -> Vec<RawDef> {
    std::fs::read_to_string(&t.file)
        .ok()
        .and_then(|s| parse_claude_file(&s).ok())
        .map(|cf| cf.defs.into_iter().filter(|d| d.name == name && d.scope == "local" && d.project_path.is_some()).collect())
        .unwrap_or_default()
}

/// Quitar las copias del ámbito local: `claude mcp remove <name> --scope local`, lanzado en la carpeta de cada proyecto
/// (la CLI de Claude decide el proyecto por la carpeta actual). Mismo fichero que el de usuario: la copia de «Deshacer» vale.
fn local_remove_ops(t: &Target, locals: &[RawDef]) -> (Vec<Op>, Vec<String>) {
    let mut ops = Vec::new();
    let mut lines = Vec::new();
    for d in locals {
        let op = CliOp {
            program: "claude",
            args: vec!["mcp".into(), "remove".into(), d.name.clone(), "--scope".into(), "local".into()],
            env: t.env.clone(),
            cwd: d.project_path.clone(),
        };
        lines.push(show_cli(&op));
        ops.push(Op::Cli(op));
    }
    (ops, lines)
}

// ---------- plan ----------

fn file_label(t: &Target) -> String {
    t.file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn add_ops(t: &Target, d: &RawDef, replace_existing: bool) -> (Vec<Op>, Vec<String>) {
    let mut ops = Vec::new();
    let mut lines = Vec::new();
    let m = masked(d);
    match t.provider {
        "claude" => {
            if replace_existing {
                let op = CliOp { program: "claude", args: claude_remove_args(&d.name), env: t.env.clone(), cwd: t.project.clone() };
                lines.push(show_cli(&op));
                ops.push(Op::Cli(op));
            }
            let op = CliOp { program: "claude", args: claude_add_args_in(d, t.scope), env: t.env.clone(), cwd: t.project.clone() };
            lines.push(show_cli(&CliOp { args: claude_add_args_in(&m, t.scope), ..op.clone() }));
            ops.push(Op::Cli(op));
        }
        "codex" => {
            // `codex mcp add` sustituye si ya existe: no hace falta quitar antes.
            let op = CliOp { program: "codex", args: codex_add_args(d), env: t.env.clone(), cwd: t.project.clone() };
            lines.push(show_cli(&CliOp { args: codex_add_args(&m), ..op.clone() }));
            ops.push(Op::Cli(op));
        }
        _ => {
            let v = opencode_value_of(d);
            lines.push(format!("{}: mcp.{} = {}", file_label(t), d.name, opencode_value_of(&m)));
            ops.push(Op::OcSet { name: d.name.clone(), value: v });
        }
    }
    (ops, lines)
}

fn remove_ops(t: &Target, name: &str) -> (Vec<Op>, Vec<String>) {
    match t.provider {
        "claude" => {
            let op = CliOp { program: "claude", args: claude_remove_args(name), env: t.env.clone(), cwd: t.project.clone() };
            (vec![Op::Cli(op.clone())], vec![show_cli(&op)])
        }
        "codex" => {
            let op = CliOp { program: "codex", args: codex_remove_args(name), env: t.env.clone(), cwd: t.project.clone() };
            (vec![Op::Cli(op.clone())], vec![show_cli(&op)])
        }
        _ => (vec![Op::OcRemove { name: name.to_string() }], vec![format!("{}: remove mcp.{name}", file_label(t))]),
    }
}

fn secrets_of(d: &RawDef) -> Vec<String> {
    let mut v: Vec<String> = d.env.iter().chain(d.headers.iter()).map(|(_, x)| x.clone()).collect();
    if let Some(u) = &d.url {
        if let Some((_, q)) = u.split_once('?') {
            v.extend(q.split('&').filter_map(|p| p.split_once('=').map(|(_, x)| x.to_string())));
        }
    }
    v.retain(|x| x.len() >= 4);
    v
}

fn step(t: &Target, action: &'static str) -> Step {
    Step {
        public: PlanStep {
            account_id: t.id.clone(),
            provider: t.provider,
            action,
            file: t.file.to_string_lossy().into_owned(),
            lines: vec![],
            blocked: None,
            note: None,
        },
        ops: vec![],
        file: t.file.clone(),
        secrets: vec![],
        expect: None,
        target: t.clone(),
        check: vec![],
    }
}

fn plan_add(t: &Target, src: &RawDef, replace: bool, include_local: bool) -> Step {
    let mut s = step(t, "add");
    let d = match translate(src, t.provider) {
        Ok(d) => d,
        Err(e) => {
            s.public.blocked = Some(e);
            return s;
        }
    };
    s.secrets = secrets_of(&d);
    let cur = match existing(t, &d.name) {
        Ok(c) => c,
        Err(e) => {
            s.public.blocked = Some(e);
            return s;
        }
    };
    if let Some(c) = &cur {
        // Codex: no se sabe el valor sin listar; los demás: misma huella = ya está.
        if t.provider != "codex" && fingerprint(c) == fingerprint(&d) {
            // Ya igual en usuario; con `include_local`, aún puede haber copias locales distintas que quitar.
            let other = other_locals(t, &d, include_local);
            if other.is_empty() {
                s.public.action = "skip";
                s.public.note = Some("Already there with the same definition".into());
                return s;
            }
            let (ops, lines) = local_remove_ops(t, &other);
            s.public.action = "remove";
            s.ops = ops;
            s.public.lines = lines;
            s.public.note = Some("Already there with the same definition; removes the local-scope copies that differ".into());
            return s;
        }
        if !replace {
            s.public.blocked = Some("An MCP with this name already exists in this account".into());
            return s;
        }
        s.public.action = "replace";
    }
    let (mut ops, mut lines) = add_ops(t, &d, cur.is_some());
    let other = other_locals(t, &d, include_local);
    if !other.is_empty() {
        let (o, l) = local_remove_ops(t, &other);
        ops.extend(o);
        lines.extend(l);
        s.public.note = Some("Also removes the local-scope copies that differ".into());
    }
    s.ops = ops;
    s.public.lines = lines;
    s.expect = Some(d);
    s
}

/// Copias locales (Claude, al escribir en usuario) con OTRA definición: las que seguirían ganando en su carpeta.
fn other_locals(t: &Target, d: &RawDef, include_local: bool) -> Vec<RawDef> {
    if !include_local || t.provider != "claude" || t.scope != "user" {
        return vec![];
    }
    claude_locals(t, &d.name).into_iter().filter(|l| fingerprint(l) != fingerprint(d)).collect()
}

fn plan_remove(t: &Target, name: &str, include_local: bool) -> Step {
    let mut s = step(t, "remove");
    let locals = if t.provider == "claude" { claude_locals(t, name) } else { vec![] };
    match existing(t, name) {
        Ok(Some(_)) => {
            let (mut ops, mut lines) = remove_ops(t, name);
            // Mismo nombre también en un proyecto (ámbito local): sin `include_local` se quita solo el de usuario.
            if !locals.is_empty() {
                if include_local {
                    let (o, l) = local_remove_ops(t, &locals);
                    ops.extend(o);
                    lines.extend(l);
                    s.public.note = Some("Also removes the copies in the local scope of its projects".into());
                } else {
                    s.public.note = Some("Also in the local scope of a project: that one stays".into());
                }
            }
            s.ops = ops;
            s.public.lines = lines;
        }
        Ok(None) if include_local && !locals.is_empty() => {
            let (ops, lines) = local_remove_ops(t, &locals);
            s.ops = ops;
            s.public.lines = lines;
            s.public.note = Some("Only in the local scope of its projects: removes those".into());
        }
        Ok(None) => {
            s.public.action = "skip";
            s.public.note = Some(if t.provider == "claude" && claude_local_only(t, name) {
                "Only in a project (local scope): Orchestra only edits the user scope".into()
            } else {
                "Not in this account".into()
            });
        }
        Err(e) => s.public.blocked = Some(e),
    }
    s
}

/// Lee la definición real de la cuenta origen (con sus secretos; no sale de Rust).
pub(crate) type SourceReader<'a> = &'a dyn Fn(&SourceRef) -> Result<RawDef, String>;

pub(crate) fn real_source(home: &Path) -> impl Fn(&SourceRef) -> Result<RawDef, String> + '_ {
    move |s: &SourceRef| {
        if s.scope == "claudeai" || s.scope == "plugin" {
            return Err("Managed outside the account config: it cannot be copied".into());
        }
        find_def(home, &s.account_id, &s.scope, &s.name, s.project_path.as_deref()).map(|(d, _)| d)
    }
}

/// Lista de nombres en la ruta `path` de un JSON (vacía si no está).
fn json_list(v: &Value, path: &[String]) -> Vec<String> {
    let mut cur = v;
    for k in path {
        cur = &cur[k.as_str()];
    }
    cur.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

pub(crate) fn read_json_file(f: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(f) {
        Ok(t) if t.trim().is_empty() => Ok(Value::Object(Default::default())),
        Ok(t) => serde_json::from_str(&strip_jsonc(t.trim_start_matches('\u{feff}'))).map_err(|e| format!("malformed {} (line {})", f.display(), e.line())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Default::default())),
        Err(e) => Err(format!("{}: {e}", f.display())),
    }
}

/// Añade o quita `name` de la lista en `path` (sin duplicar); `None` si no cambia nada.
fn list_op(cur: &Value, path: &[&str], name: &str, add: bool) -> Option<(Vec<String>, Value)> {
    let path: Vec<String> = path.iter().map(|x| x.to_string()).collect();
    let mut l = json_list(cur, &path);
    let has = l.iter().any(|x| x == name);
    if has == add {
        return None;
    }
    if add {
        l.push(name.to_string());
    } else {
        l.retain(|x| x != name);
    }
    Some((path, Value::from(l)))
}

/// Pone en un paso los cambios de un JSON (vista previa = cada ruta con su valor nuevo).
fn set_edits(s: &mut Step, file: &Path, edits: Vec<(Vec<String>, Value)>) {
    s.file = file.to_path_buf();
    s.public.file = file.to_string_lossy().into_owned();
    for (path, value) in edits {
        s.public.lines.push(format!("{} = {}", path.iter().map(|k| format!("[{}]", serde_json::to_string(k).unwrap_or_default())).collect::<String>(), value));
        s.check.push((path.clone(), value.clone()));
        s.ops.push(Op::JsonSet { path, value });
    }
}

/// Aprobar en un proyecto: `enabledMcpjsonServers` += nombre, `disabledMcpjsonServers` -= nombre (settings.local.json).
fn approve_edits(project: &str, name: &str, on: bool) -> Result<(PathBuf, Vec<(Vec<String>, Value)>), String> {
    let f = Path::new(project).join(".claude").join("settings.local.json");
    let cur = read_json_file(&f)?;
    let edits = [list_op(&cur, &["enabledMcpjsonServers"], name, on), list_op(&cur, &["disabledMcpjsonServers"], name, !on)].into_iter().flatten().collect();
    Ok((f, edits))
}

/// Pasos de las acciones de estado (Aprobar / Encender / Apagar): cambios de lista en un JSON, con vista previa exacta.
fn plan_state(env: &Env, change: &Change) -> Result<Vec<Step>, String> {
    let (account_id, name) = match change {
        Change::Approve { account_id, name, .. } | Change::SetEnabled { account_id, name, .. } => (account_id, name),
        _ => unreachable!(),
    };
    let t = resolve_target(env, account_id)?;
    let mut s = step(&t, "state");
    match change {
        Change::Approve { project_path, .. } => {
            if t.provider != "claude" {
                return Err("Only Claude Code asks to approve .mcp.json servers".into());
            }
            let (f, edits) = approve_edits(project_path, name, true)?;
            set_edits(&mut s, &f, edits);
            if s.ops.is_empty() {
                s.public.note = Some("already approved".into());
            }
        }
        Change::SetEnabled { scope, project_path, on, .. } => match t.provider {
            "claude" if scope == "project" => {
                let p = project_path.as_deref().ok_or("Missing project folder")?;
                let (f, edits) = approve_edits(p, name, *on)?;
                set_edits(&mut s, &f, edits);
            }
            "claude" => {
                let p = project_path.as_deref().ok_or("Claude turns servers on and off per project folder: choose one")?;
                let cur = read_json_file(&t.file)?;
                // La clave del proyecto tal como la escribe Claude (si ya existe con otras barras o mayúsculas).
                let key = cur["projects"].as_object().and_then(|m| m.keys().find(|k| norm_path(k) == norm_path(p)).cloned()).unwrap_or_else(|| p.replace('\\', "/"));
                let edits = list_op(&cur, &["projects", key.as_str(), "disabledMcpServers"], name, !*on).into_iter().collect();
                let f = t.file.clone();
                set_edits(&mut s, &f, edits);
            }
            "opencode" => {
                let f = t.file.clone();
                let cur = read_json_file(&f)?;
                if !cur["mcp"][name.as_str()].is_object() {
                    return Err(format!("{name} is not in {}", f.display()));
                }
                if cur["mcp"][name.as_str()]["enabled"].as_bool().unwrap_or(true) != *on {
                    set_edits(&mut s, &f, vec![(vec!["mcp".into(), name.clone(), "enabled".into()], Value::Bool(*on))]);
                }
            }
            _ => s.public.blocked = Some(format!("Codex has no command to turn a server on or off: change `enabled` under [mcp_servers.{name}] in {}", t.file.display())),
        },
        _ => unreachable!(),
    }
    if s.ops.is_empty() && s.public.blocked.is_none() && s.public.note.is_none() {
        s.public.note = Some(if matches!(change, Change::SetEnabled { on: false, .. }) { "already off".into() } else { "already on".into() });
    }
    Ok(vec![s])
}

pub(crate) fn plan(env: &Env, change: &Change, source: SourceReader) -> Result<Vec<Step>, String> {
    if matches!(change, Change::Approve { .. } | Change::SetEnabled { .. }) {
        return plan_state(env, change);
    }
    let include_local = matches!(change, Change::Copy { include_local: true, .. } | Change::Remove { include_local: true, .. });
    let (targets, src, replace): (&Vec<String>, Option<RawDef>, bool) = match change {
        Change::Add { def, targets, replace } => (targets, Some(def_from_input(def)?), *replace),
        Change::Copy { from, targets, replace, .. } => {
            let mut d = source(from)?;
            if d.managed_by.is_some() {
                return Err("Managed outside the account config: it cannot be copied".into());
            }
            d.name = from.name.clone();
            (targets, Some(d), *replace)
        }
        Change::Remove { name: _, targets, .. } => (targets, None, false),
        Change::Approve { .. } | Change::SetEnabled { .. } => unreachable!(),
    };
    if targets.is_empty() {
        return Err("Choose at least one account".into());
    }
    let mut out = Vec::new();
    for id in targets {
        let t = match resolve_target(env, id) {
            Ok(t) => t,
            Err(e) => {
                let mut s = step(&Target { id: id.clone(), provider: "claude", file: PathBuf::new(), env: vec![], scope: "user", project: None }, "skip");
                s.public.blocked = Some(e);
                out.push(s);
                continue;
            }
        };
        let t = match change {
            Change::Add { def, .. } => match with_scope(t.clone(), def.scope.as_deref(), def.project_path.as_deref()) {
                Ok(t) => t,
                Err(e) => {
                    let mut s = step(&t, "add");
                    s.public.blocked = Some(e);
                    out.push(s);
                    continue;
                }
            },
            _ => t,
        };
        out.push(match (&src, change) {
            (Some(d), _) => plan_add(&t, d, replace, include_local),
            (None, Change::Remove { name, .. }) => plan_remove(&t, name, include_local),
            _ => unreachable!(),
        });
    }
    Ok(out)
}

// ---------- ejecutar la CLI sin shell ----------

/// `npm` deja shims `.cmd`; si el shim solo llama a un `.exe` (opencode) o a `node script.js`, se lanza eso
/// directamente para no pasar los argumentos (JSON con comillas) por cmd.exe.
pub(crate) fn unwrap_cmd_shim(cmd_path: &Path, text: &str) -> Option<(PathBuf, Vec<String>)> {
    let dir = cmd_path.parent()?;
    let quoted: Vec<&str> = text.split('"').skip(1).step_by(2).collect();
    let expand = |q: &str| -> Option<PathBuf> {
        let rest = q.strip_prefix("%dp0%").or_else(|| q.strip_prefix("%~dp0"))?;
        let rel = rest.trim_start_matches(['\\', '/']);
        Some(dir.join(rel.replace('/', "\\")))
    };
    for q in &quoted {
        let l = q.to_ascii_lowercase();
        if l.ends_with(".exe") && !l.ends_with("node.exe") {
            if let Some(p) = expand(q).filter(|p| p.is_file()) {
                return Some((p, vec![]));
            }
        }
    }
    for q in &quoted {
        let l = q.to_ascii_lowercase();
        if l.ends_with(".js") || l.ends_with(".mjs") || l.ends_with(".cjs") {
            if let Some(js) = expand(q).filter(|p| p.is_file()) {
                let local_node = dir.join("node.exe");
                let node = if local_node.is_file() { local_node } else { resolve_command("node", std::env::var_os("PATH").as_deref(), None) };
                return Some((node, vec![js.to_string_lossy().into_owned()]));
            }
        }
    }
    None
}

fn launcher(program: &str, path: Option<&std::ffi::OsStr>) -> (PathBuf, Vec<String>) {
    let exe = resolve_command(program, path, None);
    let ext = exe.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if ext == "cmd" || ext == "bat" {
        if let Some(r) = std::fs::read_to_string(&exe).ok().and_then(|t| unwrap_cmd_shim(&exe, &t)) {
            return r;
        }
    }
    // .exe directo; si es un .cmd que no se entiende, Rust escapa los argumentos para cmd (o se niega si no puede).
    (exe, vec![])
}

pub(crate) fn run_cli(op: &CliOp) -> Result<(bool, String), String> {
    let path = op.env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| std::ffi::OsString::from(v)).or_else(|| std::env::var_os("PATH"));
    let (exe, pre) = launcher(op.program, path.as_deref());
    let mut cmd = Command::new(&exe);
    cmd.args(&pre).args(&op.args);
    for (k, v) in &op.env {
        cmd.env(k, v);
    }
    if let Some(c) = &op.cwd {
        cmd.current_dir(c);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000 | job::CREATE_SUSPENDED); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start {}: {e}", op.program))?;
    #[cfg(windows)]
    let _job = job::Job::adopt(&child);
    let reader = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let _ = (&mut r).take(64 * 1024).read_to_end(&mut buf);
                let _ = std::io::copy(&mut r, &mut std::io::sink());
            }
            buf
        })
    };
    let out = reader(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err = reader(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let deadline = Instant::now() + CLI_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{}: timed out", op.program));
            }
        }
    };
    let mut text = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&err.join().unwrap_or_default()));
    Ok((status.success(), text))
}

/// Mensaje corto de la salida: sin avisos de Codex sobre alias, sin secretos, una o dos líneas.
fn short_msg(text: &str, secrets: &[String]) -> String {
    let refs: Vec<&str> = secrets.iter().map(String::as_str).collect();
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("WARNING: proceeding, even though we could not create PATH aliases"))
        .collect();
    scrub_msg(&lines.join(" · "), &refs)
}

// ---------- copia de seguridad y deshacer ----------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct Snap {
    pub path: String,
    /// Copia de antes (nombre de fichero en la carpeta de esa ruta); None = el fichero no existía.
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct Entry {
    pub id: u64,
    pub summary: String,
    pub files: Vec<Snap>,
}

/// Carpeta de las copias de una ruta (hash FNV-1a estable de la ruta normalizada).
fn key_dir(root: &Path, file: &Path) -> PathBuf {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in norm_path(&file.to_string_lossy()).bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let base = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    root.join("files").join(format!("{base}-{h:016x}"))
}

fn journal_path(root: &Path) -> PathBuf {
    root.join("journal.json")
}

pub(crate) fn read_journal(root: &Path) -> Vec<Entry> {
    std::fs::read_to_string(journal_path(root)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn write_journal(root: &Path, j: &[Entry]) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let tmp = root.join("journal.json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(j).unwrap_or_default()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, journal_path(root)).map_err(|e| e.to_string())
}

/// Guarda el contenido actual (o su ausencia) de `file` como `<id>.<tag>`; devuelve el nombre.
fn snapshot(root: &Path, file: &Path, id: u64, tag: &str) -> Result<Option<String>, String> {
    let Ok(bytes) = std::fs::read(file) else { return Ok(None) };
    let dir = key_dir(root, file);
    std::fs::create_dir_all(&dir).map_err(|e| format!("backup folder: {e}"))?;
    let name = format!("{id}.{tag}");
    std::fs::write(dir.join(&name), bytes).map_err(|e| format!("backup: {e}"))?;
    Ok(Some(name))
}

/// Deja las últimas `KEEP_SNAPSHOTS` copias de cada fichero y quita del diario lo que ya no se puede deshacer.
fn rotate(root: &Path, journal: &mut Vec<Entry>) {
    let files_dir = root.join("files");
    if let Ok(rd) = std::fs::read_dir(&files_dir) {
        for d in rd.flatten() {
            let mut ids: Vec<u64> = std::fs::read_dir(d.path())
                .map(|r| r.flatten().filter_map(|f| f.file_name().to_string_lossy().split('.').next()?.parse().ok()).collect())
                .unwrap_or_default();
            ids.sort_unstable();
            ids.dedup();
            if ids.len() > KEEP_SNAPSHOTS {
                for old in &ids[..ids.len() - KEEP_SNAPSHOTS] {
                    for tag in ["before", "after"] {
                        let _ = std::fs::remove_file(d.path().join(format!("{old}.{tag}")));
                    }
                }
            }
        }
    }
    journal.retain(|e| {
        e.files.iter().all(|s| {
            let dir = key_dir(root, Path::new(&s.path));
            [&s.before, &s.after].iter().all(|n| n.as_ref().is_none_or(|n| dir.join(n).is_file()))
        })
    });
    if journal.len() > KEEP_SNAPSHOTS {
        let cut = journal.len() - KEEP_SNAPSHOTS;
        journal.drain(..cut);
    }
}

fn new_id(root: &Path) -> u64 {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let last = read_journal(root).last().map(|e| e.id).unwrap_or(0);
    now.max(last + 1)
}

pub(crate) fn undo_info(root: &Path) -> Option<UndoInfo> {
    read_journal(root).pop().map(|e| UndoInfo { id: e.id, summary: e.summary, files: e.files.into_iter().map(|s| s.path).collect() })
}

/// Deshace el último cambio si TODOS sus ficheros siguen como quedaron; si alguno cambió por otra vía, no toca nada.
pub(crate) fn undo_last(root: &Path) -> Result<UndoInfo, String> {
    let mut j = read_journal(root);
    let e = j.last().cloned().ok_or("Nothing to undo")?;
    let mut changed = Vec::new();
    for s in &e.files {
        let dir = key_dir(root, Path::new(&s.path));
        let now = std::fs::read(&s.path).ok();
        let after = match &s.after {
            Some(n) => Some(std::fs::read(dir.join(n)).map_err(|_| "The backup is missing".to_string())?),
            None => None,
        };
        if now != after {
            changed.push(s.path.clone());
        }
    }
    if !changed.is_empty() {
        return Err(format!("Changed since by another program, not restored: {}", changed.join(", ")));
    }
    for s in &e.files {
        let dir = key_dir(root, Path::new(&s.path));
        match &s.before {
            Some(n) => {
                let bytes = std::fs::read(dir.join(n)).map_err(|_| "The backup is missing".to_string())?;
                std::fs::write(&s.path, bytes).map_err(|e| format!("{}: {e}", s.path))?;
            }
            None => {
                let _ = std::fs::remove_file(&s.path);
            }
        }
    }
    j.pop();
    write_journal(root, &j)?;
    Ok(UndoInfo { id: e.id, summary: e.summary, files: e.files.into_iter().map(|s| s.path).collect() })
}

// ---------- aplicar ----------

pub(crate) type Runner<'a> = &'a dyn Fn(&CliOp) -> Result<(bool, String), String>;

fn verify(t: &Target, expect: &Option<RawDef>, name: &str) -> Option<bool> {
    let cur = existing(t, name).ok()?;
    Some(match (expect, cur) {
        (None, c) => c.is_none(),
        (Some(_), None) => false,
        // Codex: la comprobación barata solo dice que existe.
        (Some(_), Some(_)) if t.provider == "codex" => true,
        (Some(d), Some(c)) => fingerprint(d) == fingerprint(&c),
    })
}

fn oc_apply(file: &Path, op: &Op) -> Result<(), String> {
    let text = std::fs::read_to_string(file).unwrap_or_default();
    let new = match op {
        Op::OcSet { name, value } => jsonc::set_mcp(&text, name, value)?,
        Op::OcRemove { name } => jsonc::remove_mcp(&text, name)?,
        Op::JsonSet { path, value } => jsonc::set_path(&text, &path.iter().map(String::as_str).collect::<Vec<_>>(), value)?,
        Op::Cli(_) => unreachable!(),
    };
    // Comprobación antes de escribir: tiene que seguir siendo una config legible.
    if matches!(op, Op::JsonSet { .. }) {
        serde_json::from_str::<Value>(&strip_jsonc(new.trim_start_matches('\u{feff}'))).map_err(|e| format!("the edited file would not parse ({e}); nothing written"))?;
    } else {
        parse_opencode(&new).map_err(|e| format!("the edited file would not parse ({e}); nothing written"))?;
    }
    if let Some(p) = file.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let tmp = file.with_extension("orchestra-tmp");
    std::fs::write(&tmp, new).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

pub(crate) fn apply(env: &Env, change: &Change, source: SourceReader, root: &Path, run: Runner) -> Result<ApplyResult, String> {
    let steps = plan(env, change, source)?;
    let id = new_id(root);
    let summary = match change {
        Change::Add { def, .. } => format!("add {}", def.name.trim()),
        Change::Copy { from, replace: false, .. } => format!("copy {}", from.name),
        Change::Copy { from, .. } => format!("make equal {}", from.name),
        Change::Remove { name, .. } => format!("remove {name}"),
        Change::Approve { name, .. } => format!("approve {name}"),
        Change::SetEnabled { name, on: true, .. } => format!("turn on {name}"),
        Change::SetEnabled { name, .. } => format!("turn off {name}"),
    };
    let mut snaps: Vec<Snap> = Vec::new();
    let mut results = Vec::new();
    for s in &steps {
        let acc = s.public.account_id.clone();
        if let Some(b) = &s.public.blocked {
            results.push(StepResult { account_id: acc, status: "skipped", msg: b.clone(), verified: None });
            continue;
        }
        if s.ops.is_empty() {
            results.push(StepResult { account_id: acc, status: "skipped", msg: s.public.note.clone().unwrap_or_default(), verified: None });
            continue;
        }
        let path = s.file.to_string_lossy().into_owned();
        if !snaps.iter().any(|x| x.path == path) {
            match snapshot(root, &s.file, id, "before") {
                Ok(before) => snaps.push(Snap { path: path.clone(), before, after: None }),
                Err(e) => {
                    results.push(StepResult { account_id: acc, status: "failed", msg: format!("no backup, nothing changed: {e}"), verified: None });
                    continue;
                }
            }
        }
        let mut ok = true;
        let mut msgs = Vec::new();
        for op in &s.ops {
            let r = match op {
                Op::Cli(c) => run(c).map(|(good, text)| (good, short_msg(&text, &s.secrets))),
                other => oc_apply(&s.file, other).map(|_| (true, "written".to_string())),
            };
            match r {
                Ok((true, m)) => msgs.push(m),
                Ok((false, m)) | Err(m) => {
                    ok = false;
                    msgs.push(scrub_msg(&m, &s.secrets.iter().map(String::as_str).collect::<Vec<_>>()));
                    break;
                }
            }
        }
        let name = match change {
            Change::Remove { name, .. } => name.clone(),
            _ => s.expect.as_ref().map(|d| d.name.clone()).unwrap_or_default(),
        };
        let verified = if s.check.is_empty() {
            verify(&s.target, &s.expect, &name)
        } else {
            // Releído: cada ruta tiene lo que se quería escribir.
            read_json_file(&s.file).ok().map(|v| {
                s.check.iter().all(|(p, want)| {
                    let mut cur = &v;
                    for k in p {
                        cur = &cur[k.as_str()];
                    }
                    cur == want
                })
            })
        };
        results.push(StepResult {
            account_id: acc,
            status: if ok && verified != Some(false) { "ok" } else { "failed" },
            msg: msgs.into_iter().filter(|m| !m.is_empty()).collect::<Vec<_>>().join(" · "),
            verified,
        });
    }
    // Contenido de después, para saber al deshacer si alguien lo cambió.
    let mut changed_any = false;
    for sn in &mut snaps {
        sn.after = snapshot(root, Path::new(&sn.path), id, "after")?;
        let dir = key_dir(root, Path::new(&sn.path));
        let read = |n: &Option<String>| n.as_ref().and_then(|n| std::fs::read(dir.join(n)).ok());
        if read(&sn.before) != read(&sn.after) {
            changed_any = true;
        }
    }
    snaps.retain(|sn| {
        let dir = key_dir(root, Path::new(&sn.path));
        let read = |n: &Option<String>| n.as_ref().and_then(|n| std::fs::read(dir.join(n)).ok());
        let differs = read(&sn.before) != read(&sn.after);
        if !differs {
            for n in [&sn.before, &sn.after].into_iter().flatten() {
                let _ = std::fs::remove_file(dir.join(n));
            }
        }
        differs
    });
    let undo_id = if changed_any && !snaps.is_empty() {
        let mut j = read_journal(root);
        j.push(Entry { id, summary, files: snaps });
        rotate(root, &mut j);
        write_journal(root, &j)?;
        Some(id)
    } else {
        None
    };
    Ok(ApplyResult { steps: results, undo_id })
}

// ---------- comandos de Tauri ----------

fn backup_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::store::base_dir(app).map(|d| d.join("mcp-backups"))
}

#[tauri::command]
pub async fn mcpm_plan(change: Change) -> Result<Vec<PlanStep>, String> {
    let home = home().ok_or("No user folder")?;
    tauri::async_runtime::spawn_blocking(move || {
        let env = Env::real(&home);
        let src = real_source(&home);
        plan(&env, &change, &src).map(|v| v.into_iter().map(|s| s.public).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mcpm_apply(app: tauri::AppHandle, change: Change) -> Result<ApplyResult, String> {
    let home = home().ok_or("No user folder")?;
    let root = backup_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let env = Env::real(&home);
        let src = real_source(&home);
        apply(&env, &change, &src, &root, &run_cli)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// «Abrir fichero» del resultado: enseña en el Explorador el fichero de configuración de esa cuenta. Solo ficheros que
/// salen de una cuenta conocida (`resolve_target`), nunca una ruta que mande la interfaz.
#[tauri::command]
pub fn mcpm_reveal(account_id: String) -> Result<(), String> {
    let home = home().ok_or("No user folder")?;
    let t = resolve_target(&Env::real(&home), &account_id)?;
    let target = if t.file.exists() { t.file.clone() } else { t.file.parent().map(Path::to_path_buf).ok_or("No folder")? };
    #[cfg(windows)]
    let r = std::process::Command::new("explorer.exe").arg(format!("/select,{}", target.display())).spawn();
    #[cfg(not(windows))]
    let r = std::process::Command::new("xdg-open").arg(target.parent().unwrap_or(&target)).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mcpm_undo_info(app: tauri::AppHandle) -> Result<Option<UndoInfo>, String> {
    Ok(undo_info(&backup_root(&app)?))
}

#[tauri::command]
pub fn mcpm_undo(app: tauri::AppHandle) -> Result<UndoInfo, String> {
    undo_last(&backup_root(&app)?)
}

// ---------- edición mínima de JSONC (opencode) ----------

pub(crate) mod jsonc {
    //! Cambia o quita un miembro de `mcp` tocando solo ese trozo del texto: comentarios, orden y sangría del resto
    //! quedan igual.
    use serde_json::Value;

    fn skip_ws(b: &[u8], mut i: usize) -> usize {
        while i < b.len() {
            match b[i] {
                b' ' | b'\t' | b'\r' | b'\n' => i += 1,
                b'/' if b.get(i + 1) == Some(&b'/') => {
                    while i < b.len() && b[i] != b'\n' {
                        i += 1;
                    }
                }
                b'/' if b.get(i + 1) == Some(&b'*') => {
                    i += 2;
                    while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                        i += 1;
                    }
                    i = (i + 2).min(b.len());
                }
                _ => break,
            }
        }
        i
    }

    fn str_end(b: &[u8], mut i: usize) -> Result<usize, String> {
        i += 1;
        while i < b.len() {
            match b[i] {
                b'\\' => i += 2,
                b'"' => return Ok(i + 1),
                _ => i += 1,
            }
        }
        Err("unterminated string".into())
    }

    fn value_end(b: &[u8], i: usize) -> Result<usize, String> {
        match b.get(i) {
            Some(b'"') => str_end(b, i),
            Some(b'{') | Some(b'[') => {
                let mut depth = 0usize;
                let mut j = i;
                while j < b.len() {
                    match b[j] {
                        b'"' => {
                            j = str_end(b, j)?;
                            continue;
                        }
                        b'/' if matches!(b.get(j + 1), Some(b'/') | Some(b'*')) => {
                            j = skip_ws(b, j);
                            continue;
                        }
                        b'{' | b'[' => depth += 1,
                        b'}' | b']' => {
                            depth -= 1;
                            if depth == 0 {
                                return Ok(j + 1);
                            }
                        }
                        _ => {}
                    }
                    j += 1;
                }
                Err("unbalanced braces".into())
            }
            Some(_) => {
                let mut j = i;
                while j < b.len() && !matches!(b[j], b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n' | b'/') {
                    j += 1;
                }
                Ok(j)
            }
            None => Err("unexpected end".into()),
        }
    }

    #[derive(Debug)]
    struct Member {
        key: String,
        start: usize,
        val_start: usize,
        val_end: usize,
    }

    /// Miembros del objeto que empieza en `open` y posición de su `}`.
    fn members(t: &str, open: usize) -> Result<(Vec<Member>, usize), String> {
        let b = t.as_bytes();
        let mut v = Vec::new();
        let mut i = open + 1;
        loop {
            i = skip_ws(b, i);
            match b.get(i) {
                Some(b'}') => return Ok((v, i)),
                Some(b',') => i += 1,
                Some(b'"') => {
                    let ke = str_end(b, i)?;
                    let key: String = serde_json::from_str(&t[i..ke]).map_err(|_| "bad key")?;
                    let c = skip_ws(b, ke);
                    if b.get(c) != Some(&b':') {
                        return Err("expected ':'".into());
                    }
                    let vs = skip_ws(b, c + 1);
                    let ve = value_end(b, vs)?;
                    v.push(Member { key, start: i, val_start: vs, val_end: ve });
                    i = ve;
                }
                _ => return Err("malformed object".into()),
            }
        }
    }

    fn line_indent(t: &str, pos: usize) -> String {
        let ls = t[..pos].rfind('\n').map(|x| x + 1).unwrap_or(0);
        t[ls..].chars().take_while(|c| *c == ' ' || *c == '\t').collect()
    }

    fn pretty(v: &Value, indent: &str) -> String {
        serde_json::to_string_pretty(v).unwrap_or_default().replace('\n', &format!("\n{indent}"))
    }

    /// Inserta `"key": value` en el objeto `open..close`.
    fn insert(t: &str, open: usize, close: usize, ms: &[Member], key: &str, v: &Value) -> String {
        let b = t.as_bytes();
        let parent = line_indent(t, open);
        let ind = match ms.first() {
            Some(m) if t[..m.start].rsplit('\n').next().is_some_and(|l| l.trim().is_empty()) => line_indent(t, m.start),
            _ => format!("{parent}  "),
        };
        let member = format!("{}: {}", serde_json::to_string(key).unwrap_or_default(), pretty(v, &ind));
        match ms.last() {
            Some(last) => {
                let j = skip_ws(b, last.val_end);
                if b.get(j) == Some(&b',') {
                    format!("{}\n{ind}{member},{}", &t[..j + 1], &t[j + 1..])
                } else {
                    format!("{},\n{ind}{member}{}", &t[..last.val_end], &t[last.val_end..])
                }
            }
            None if t[open + 1..close].trim().is_empty() => format!("{}\n{ind}{member}\n{parent}{}", &t[..open + 1], &t[close..]),
            None => format!("{}\n{ind}{member}{}", &t[..open + 1], &t[open + 1..]),
        }
    }

    fn root(t: &str) -> Result<(usize, Vec<Member>, usize), String> {
        let b = t.as_bytes();
        let start = if t.starts_with('\u{feff}') { 3 } else { 0 };
        let o = skip_ws(b, start);
        if b.get(o) != Some(&b'{') {
            return Err("the config is not a JSON object".into());
        }
        let (ms, c) = members(t, o)?;
        Ok((o, ms, c))
    }

    /// Objeto donde está (o irá) el servidor: `mcp`, o `mcp.servers` si ya está ahí (formato de `opencode mcp add`).
    fn mcp_obj(t: &str, ms: &[Member], name: &str) -> Result<Option<(usize, Vec<Member>, usize)>, String> {
        let Some(m) = ms.iter().find(|m| m.key == "mcp") else { return Ok(None) };
        if t.as_bytes()[m.val_start] != b'{' {
            return Err("\"mcp\" is not an object".into());
        }
        let (inner, c) = members(t, m.val_start)?;
        if !inner.iter().any(|x| x.key == name) {
            // `servers` es contenedor si no tiene pinta de servidor (sin type/command/url), como en `parse_opencode`.
            if let Some(s) = inner.iter().find(|x| x.key == "servers" && t.as_bytes()[x.val_start] == b'{') {
                let (sm, sc) = members(t, s.val_start)?;
                if !sm.iter().any(|x| matches!(x.key.as_str(), "type" | "command" | "url")) {
                    return Ok(Some((s.val_start, sm, sc)));
                }
            }
        }
        Ok(Some((m.val_start, inner, c)))
    }

    pub fn set_mcp(t: &str, name: &str, v: &Value) -> Result<String, String> {
        if t.trim().is_empty() {
            let doc = serde_json::json!({"$schema": "https://opencode.ai/config.json", "mcp": {name: v}});
            return Ok(serde_json::to_string_pretty(&doc).unwrap_or_default() + "\n");
        }
        let (o, ms, c) = root(t)?;
        match mcp_obj(t, &ms, name)? {
            None => Ok(insert(t, o, c, &ms, "mcp", &serde_json::json!({ name: v }))),
            Some((mo, mm, mc)) => match mm.iter().find(|x| x.key == name) {
                Some(x) => {
                    let ind = line_indent(t, x.start);
                    Ok(format!("{}{}{}", &t[..x.val_start], pretty(v, &ind), &t[x.val_end..]))
                }
                None => Ok(insert(t, mo, mc, &mm, name, v)),
            },
        }
    }

    /// Pone `v` en la ruta de claves `path` (crea los objetos que falten); el resto del texto queda igual.
    pub fn set_path(t: &str, path: &[&str], v: &Value) -> Result<String, String> {
        let nest = |from: usize| path[from..].iter().rev().fold(v.clone(), |acc, k| serde_json::json!({ *k: acc }));
        if t.trim().is_empty() {
            return Ok(serde_json::to_string_pretty(&nest(0)).unwrap_or_default() + "\n");
        }
        let (mut o, mut ms, mut c) = root(t)?;
        for (i, key) in path.iter().enumerate() {
            let Some(m) = ms.iter().find(|m| m.key == *key) else {
                return Ok(insert(t, o, c, &ms, key, &nest(i + 1)));
            };
            if i + 1 == path.len() {
                let ind = line_indent(t, m.start);
                return Ok(format!("{}{}{}", &t[..m.val_start], pretty(v, &ind), &t[m.val_end..]));
            }
            if t.as_bytes()[m.val_start] != b'{' {
                return Err(format!("\"{key}\" is not an object"));
            }
            let vs = m.val_start;
            let (mm, cc) = members(t, vs)?;
            o = vs;
            ms = mm;
            c = cc;
        }
        Err("empty path".into())
    }

    pub fn remove_mcp(t: &str, name: &str) -> Result<String, String> {
        let (_, ms, _) = root(t)?;
        let Some((_, mm, _)) = mcp_obj(t, &ms, name)? else { return Err("not found".into()) };
        let k = mm.iter().position(|x| x.key == name).ok_or("not found")?;
        let m = &mm[k];
        let b = t.as_bytes();
        let j = skip_ws(b, m.val_end);
        let (mut s, mut e) = if b.get(j) == Some(&b',') {
            (m.start, j + 1)
        } else if k > 0 {
            (mm[k - 1].val_end, m.val_end)
        } else {
            (m.start, m.val_end)
        };
        // Si el miembro ocupaba sus propias líneas, quitarlas enteras.
        if s == m.start {
            let ls = t[..s].rfind('\n').map(|x| x + 1).unwrap_or(0);
            if t[ls..s].trim().is_empty() {
                let le = t[e..].find('\n').map(|x| e + x + 1).unwrap_or(t.len());
                if t[e..le].trim().is_empty() {
                    s = ls;
                    e = le;
                }
            }
        }
        Ok(format!("{}{}", &t[..s], &t[e..]))
    }
}
