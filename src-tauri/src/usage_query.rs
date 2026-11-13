//! Consulta de uso OPCIONAL (apagada por defecto): pregunta a Anthropic por los límites de 5 h / 7 d
//! de cada cuenta aunque no haya ninguna terminal abierta.
//!
//! SEGURIDAD (leer `docs/SECURITY.md`, sección «Usage query (opt-in)»):
//! - Este es el ÚNICO sitio donde Orchestra lee el token OAuth de Claude: de
//!   `<carpeta de la cuenta>/.credentials.json` solo `claudeAiOauth.accessToken` y
//!   `claudeAiOauth.expiresAt` (el resto, p. ej. el refresh token, ni se materializa).
//! - El token vive en un `Secret` cuyo `Debug`/`Display` imprimen `***`. Nunca se devuelve al
//!   frontend, no se escribe en disco, no entra en mensajes de error y no hay ninguna
//!   macro de impresión ni de registro en este fichero (lo vigila una prueba que lee el propio código fuente).
//! - Orchestra nunca renueva el token por su cuenta ni lee el de refresco: si caduca en menos de 60 s no se envía NADA
//!   (`expired`). Si la renovación está permitida (`Env::renewer`), se le pide a Claude Code que lo renueve él
//!   (`usage_renew`: `claude auth status` con la carpeta de la cuenta) y se vuelve a leer el fichero.
//! - Un único destino fijo, `https://api.anthropic.com/api/oauth/usage`, con validación de
//!   certificado (rustls). Sin redirecciones. Solo se admite otro destino si es loopback
//!   `http://127.0.0.1:<puerto>/…` o `http://localhost:<puerto>/…` (pruebas; variable
//!   `ORCHESTRA_USAGE_URL`, que se rechaza si no es loopback).
//! - Solo lectura: un único GET.
//!
//! La API no está documentada: el lector de la respuesta es tolerante (ver `parse_usage`).

use crate::quota::{Limit, QuotaFile, Window};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// Destino fijo. No hay forma de cambiarlo salvo el desvío loopback de `resolve_url`.
pub const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// Variable para desviar la consulta a un servidor loopback (pruebas). Se rechaza si no es loopback.
pub const URL_ENV: &str = "ORCHESTRA_USAGE_URL";
const BETA_HEADER: &str = "oauth-2025-04-20";
const CREDS_FILE: &str = ".credentials.json";
const MAX_BODY: u64 = 256 * 1024;
const MAX_RAW: usize = 4096;
const MAX_CREDS: u64 = 64 * 1024;
/// Como mucho una petición por cuenta cada 60 s, aunque el frontend pida más.
const MIN_GAP_SEC: f64 = 60.0;
/// Con el botón de refrescar (consulta forzada) el suelo baja a 10 s y se ignora la espera tras errores.
const FORCE_GAP_SEC: f64 = 10.0;
/// Tras una renovación fallida, las consultas automáticas no vuelven a intentarlo en 30 min (el botón sí).
const RENEW_RETRY_SEC: f64 = 30.0 * 60.0;
/// Si el token caduca antes de este margen no se envía nada.
const EXPIRY_MARGIN_SEC: f64 = 60.0;
const MAX_BACKOFF_SEC: f64 = 30.0 * 60.0;
const MAX_ACCOUNTS: usize = 32;

// ---------- secreto ----------

/// El token OAuth. `Debug` y `Display` no lo muestran nunca.
struct Secret(String);

impl Secret {
    fn expose(&self) -> &str {
        &self.0
    }
}
impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("***")
    }
}
impl std::fmt::Display for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("***")
    }
}
impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d).map(Secret)
    }
}

// ---------- resultado ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    Expired,
    Nocreds,
    Unauthorized,
    RateLimited,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageResult {
    pub account_id: String,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<Window>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seven_day: Option<Window>,
    /// Cuándo se intentó (segundos epoch).
    pub fetched_at: f64,
    /// Texto genérico en inglés para el diagnóstico (nunca contiene datos de la respuesta ni el token).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn res(id: &str, status: Status, now: f64, msg: Option<&str>) -> UsageResult {
    UsageResult { account_id: id.to_string(), status, five_hour: None, seven_day: None, fetched_at: now, message: msg.map(str::to_string) }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccountIn {
    pub id: String,
    pub dir: String,
}

// ---------- destino ----------

/// `true` si `url` es `http://127.0.0.1:<puerto>[/…]` o `http://localhost:<puerto>[/…]`. Nada más.
fn is_loopback_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else { return false };
    if url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\') {
        return false;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.contains('@') {
        return false;
    }
    let Some((host, port)) = authority.split_once(':') else { return false };
    (host == "127.0.0.1" || host == "localhost") && !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit())
}

/// Destino efectivo: el fijo, o el desvío SOLO si es loopback. `None`/vacío = el fijo.
pub fn resolve_url(override_url: Option<&str>) -> Result<String, &'static str> {
    match override_url.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(USAGE_URL.to_string()),
        Some(u) if is_loopback_url(u) => Ok(u.to_string()),
        Some(_) => Err("usage URL override must be http://127.0.0.1:<port> or http://localhost:<port>"),
    }
}

// ---------- credenciales ----------

#[derive(Deserialize)]
struct CredsFile {
    #[serde(rename = "claudeAiOauth")]
    oauth: Option<Oauth>,
}
#[derive(Deserialize)]
struct Oauth {
    #[serde(rename = "accessToken")]
    access_token: Option<Secret>,
    #[serde(rename = "expiresAt")]
    expires_at: Option<Value>,
}

/// `fichero` debe vivir DIRECTAMENTE dentro de `dir` (ambos canónicos): así un `.credentials.json`
/// que sea un enlace simbólico a otra carpeta no se sigue.
fn contained(dir: &Path, file: &Path) -> bool {
    file.parent() == Some(dir) && file.file_name().is_some()
}

/// Lee el token de la cuenta. Errores: (estado, texto genérico). No contiene nunca el token.
fn read_token(dir: &str, now: f64) -> Result<Secret, (Status, &'static str)> {
    const NO: (Status, &str) = (Status::Nocreds, "no usable sign-in found in this account folder");
    if dir.is_empty() || dir.len() > 1000 || dir.contains('\0') {
        return Err(NO);
    }
    let p = Path::new(dir);
    // Sin `..` ni rutas relativas: la carpeta viene del frontend y no se interpreta.
    if !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(NO);
    }
    let canon_dir = std::fs::canonicalize(p).map_err(|_| NO)?;
    let canon_file = std::fs::canonicalize(canon_dir.join(CREDS_FILE)).map_err(|_| NO)?;
    if !contained(&canon_dir, &canon_file) {
        return Err(NO);
    }
    let f = std::fs::File::open(&canon_file).map_err(|_| NO)?;
    let meta = f.metadata().map_err(|_| NO)?;
    if !meta.is_file() || meta.len() > MAX_CREDS {
        return Err(NO);
    }
    let mut buf = Vec::new();
    f.take(MAX_CREDS + 1).read_to_end(&mut buf).map_err(|_| NO)?;
    if buf.len() as u64 > MAX_CREDS {
        return Err(NO);
    }
    let creds: CredsFile = serde_json::from_slice(&buf).map_err(|_| NO)?;
    let oauth = creds.oauth.ok_or(NO)?;
    let token = oauth.access_token.ok_or(NO)?;
    // Un token con saltos de línea o enorme no es un token: nunca llega a una cabecera.
    if token.0.is_empty() || token.0.len() > 4096 || token.0.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(NO);
    }
    let exp = oauth.expires_at.as_ref().and_then(number).ok_or(NO)?;
    let exp = if exp > 1e11 { exp / 1000.0 } else { exp };
    if !exp.is_finite() || exp <= 0.0 {
        return Err(NO);
    }
    if now >= exp - EXPIRY_MARGIN_SEC {
        return Err((Status::Expired, "sign-in token expired"));
    }
    Ok(token)
}

// ---------- lectura tolerante de la respuesta ----------

fn number(v: &Value) -> Option<f64> {
    let x = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    x.is_finite().then_some(x)
}

/// Días desde 1970-01-01 de una fecha civil (algoritmo de Howard Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// ISO-8601 («2026-11-06T18:30:00Z», «…00.123456+00:00», «…+0200»; sin zona = UTC) a segundos epoch.
fn parse_iso(s: &str) -> Option<f64> {
    let s = s.trim();
    if !s.is_ascii() || s.len() < 10 {
        return None;
    }
    let b = s.as_bytes();
    let digits = |from: usize, n: usize| -> Option<i64> {
        let part = s.get(from..from + n)?;
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok()).flatten()
    };
    if b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, mo, d) = (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let mut secs = days_from_civil(y, mo, d) as f64 * 86400.0;
    let mut i = 10;
    if i < b.len() {
        if b[i] != b'T' && b[i] != b't' && b[i] != b' ' {
            return None;
        }
        i += 1;
        let (h, mi) = (digits(i, 2)?, digits(i + 3, 2)?);
        if b.get(i + 2) != Some(&b':') || h > 23 || mi > 59 {
            return None;
        }
        secs += (h * 3600 + mi * 60) as f64;
        i += 5;
        if b.get(i) == Some(&b':') {
            let sec = digits(i + 1, 2)?;
            if sec > 60 {
                return None;
            }
            secs += sec as f64;
            i += 3;
            if b.get(i) == Some(&b'.') || b.get(i) == Some(&b',') {
                i += 1;
                let st = i;
                while i < b.len() && b[i].is_ascii_digit() {
                    i += 1;
                }
                if i == st {
                    return None;
                }
                // la fracción se descarta (se trabaja en segundos enteros)
            }
        }
        match b.get(i) {
            None => {}
            Some(b'Z') | Some(b'z') => {
                if i + 1 != b.len() {
                    return None;
                }
            }
            Some(&sign @ (b'+' | b'-')) => {
                let (oh, om) = (digits(i + 1, 2)?, if b.get(i + 3) == Some(&b':') { digits(i + 4, 2)? } else { digits(i + 3, 2)? });
                let used = if b.get(i + 3) == Some(&b':') { 6 } else { 5 };
                if i + used != b.len() || oh > 23 || om > 59 {
                    return None;
                }
                let off = (oh * 3600 + om * 60) as f64;
                secs -= if sign == b'+' { off } else { -off };
            }
            _ => return None,
        }
    }
    Some(secs)
}

/// Instante de reinicio en segundos epoch: ISO-8601, segundos, milisegundos o texto numérico.
fn parse_reset(v: &Value) -> Option<f64> {
    let x = match v {
        Value::Number(_) => number(v)?,
        Value::String(s) => match s.trim().parse::<f64>() {
            Ok(x) if x.is_finite() => x,
            _ => return parse_iso(s),
        },
        _ => return None,
    };
    if x <= 0.0 {
        return None;
    }
    Some((if x > 1e11 { x / 1000.0 } else { x }).floor())
}

const PCT_KEYS: [&str; 5] = ["utilization", "used_percentage", "percent_used", "percentage", "percent"];
const FRACTION_KEYS: [&str; 3] = ["fraction", "used_fraction", "ratio"];
const RESET_KEYS: [&str; 3] = ["resets_at", "reset_at", "resetsAt"];

/// Una ventana. DECISIÓN sobre unidades: `utilization` (y `used_percentage`, `percent_used`,
/// `percentage`) es SIEMPRE un porcentaje 0..100 (0,5 = 0,5 %). Solo los campos de nombre
/// distinto `fraction` / `used_fraction` / `ratio` se toman como fracción 0..1 (x100).
/// Un `resets_at` ausente/nulo con uso 0 significa «ventana sin empezar» (se guarda como ya
/// renovada, `resets_at = now`); con uso > 0 la ventana no se puede mostrar y se descarta.
fn window_from(v: &Value, now: f64) -> Option<Window> {
    let o = v.as_object()?;
    let used = PCT_KEYS
        .iter()
        .find_map(|k| o.get(*k).and_then(number))
        .or_else(|| FRACTION_KEYS.iter().find_map(|k| o.get(*k).and_then(number)).map(|f| f * 100.0))?;
    let used = used.clamp(0.0, 100.0);
    let reset = RESET_KEYS.iter().find_map(|k| o.get(*k)).and_then(parse_reset);
    match reset {
        Some(r) => Some(Window { used, resets_at: r }),
        None if used == 0.0 => Some(Window { used, resets_at: now.floor().max(1.0) }),
        None => None,
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct Parsed {
    pub five_hour: Option<Window>,
    pub seven_day: Option<Window>,
    /// `Some` = la respuesta traía `limits` (aunque no hubiera extras): sustituye a los guardados.
    pub limits: Option<Vec<Limit>>,
}

fn norm(s: &str) -> String {
    s.trim().to_ascii_lowercase().replace(['-', ' '], "_")
}

#[derive(Clone, Copy, PartialEq)]
enum Slot {
    Five,
    Seven,
}

/// ¿Es un límite de la ventana de 5 h o de la semanal «general»? Un límite con `scope` (un modelo) nunca lo es.
/// Respuesta real vista una vez: `{"kind":"weekly_all","group":"weekly",…}` y `{"kind":"weekly_scoped",…,"scope":{…}}`;
/// el nombre del límite de 5 h es desconocido, así que se acepta cualquier `kind`/`group` que contenga five / hour / session.
fn slot_of(kind: &str, group: Option<&str>, scoped: bool) -> Option<Slot> {
    if scoped {
        return None;
    }
    let k = norm(kind);
    match k.as_str() {
        "five_hour" | "5h" | "5_hour" | "fivehour" | "five_hours" => return Some(Slot::Five),
        "seven_day" | "7d" | "7_day" | "sevenday" | "seven_days" | "weekly" | "week" | "weekly_all" => return Some(Slot::Seven),
        _ => {}
    }
    let five = |s: &str| s.contains("five") || s.contains("hour") || s.contains("session") || s.starts_with("5h");
    if five(&k) || group.map(norm).is_some_and(|g| five(&g)) {
        return Some(Slot::Five);
    }
    None
}

/// Nombre legible de un alcance: texto, o `{model:{display_name}}` / `{surface:{…}}` / `{display_name}` / `{name}`.
fn scope_name(v: &Value) -> Option<String> {
    let name = match v {
        Value::String(s) => s.clone(),
        Value::Object(o) => {
            if let Some(n) = ["display_name", "name"].iter().find_map(|k| o.get(*k).and_then(Value::as_str)) {
                n.to_string()
            } else {
                ["model", "surface"].iter().find_map(|k| o.get(*k).and_then(scope_name))?
            }
        }
        _ => return None,
    };
    let c = crate::quota::clean_text(&name);
    (!c.is_empty()).then_some(c)
}

/// Lee la respuesta (API sin documentar). Forma real vista una vez (cuenta Max 20x, 2026-11-06): arriba `five_hour` (nulo si la
/// ventana no está activa), `seven_day` = `{utilization, resets_at, …}` y `limits` = lista de
/// `{kind, group, percent, resets_at, scope, is_active, …}`, más muchas claves que se ignoran. También se prueban otras formas:
/// `limits` como mapa, nombres alternativos y fracciones. `five_hour: null` = ventana ausente (no un 0 %). Lo que no sea la
/// ventana de 5 h ni la semanal general pasa a la lista de límites extra (máx. 8). `None` si no es JSON, no es un objeto o no
/// trae ninguna ventana ni límite.
pub fn parse_usage(body: &[u8], now: f64) -> Option<Parsed> {
    let text = std::str::from_utf8(body).ok()?;
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let top = v.as_object()?;
    let mut p = Parsed {
        five_hour: top.get("five_hour").and_then(|w| window_from(w, now)),
        seven_day: top.get("seven_day").and_then(|w| window_from(w, now)),
        limits: None,
    };
    if let Some(limits) = top.get("limits") {
        let mut extras: Vec<Limit> = Vec::new();
        let mut visit = |key: Option<&str>, item: &Value| {
            let Some(o) = item.as_object() else { return };
            let kind = key.or_else(|| ["kind", "name", "type", "window", "id"].iter().find_map(|k| o.get(*k).and_then(Value::as_str)));
            let Some(kind) = kind else { return };
            let group = o.get("group").and_then(Value::as_str);
            let scope = o.get("scope").filter(|s| !s.is_null());
            let Some(w) = window_from(item, now) else { return };
            match slot_of(kind, group, scope.is_some()) {
                Some(Slot::Five) => p.five_hour = p.five_hour.take().or(Some(w)),
                Some(Slot::Seven) => p.seven_day = p.seven_day.take().or(Some(w)),
                None if extras.len() < crate::quota::MAX_LIMITS => {
                    let clean_kind = crate::quota::clean_text(kind);
                    if clean_kind.is_empty() {
                        return;
                    }
                    extras.push(Limit {
                        kind: clean_kind,
                        percent: w.used,
                        resets_at: w.resets_at,
                        scope: scope.and_then(scope_name),
                        active: ["is_active", "active"].iter().find_map(|k| o.get(*k).and_then(Value::as_bool)).unwrap_or(false),
                    });
                }
                None => {}
            }
        };
        let known = match limits {
            Value::Array(a) => {
                a.iter().for_each(|it| visit(None, it));
                true
            }
            Value::Object(m) => {
                m.iter().for_each(|(k, it)| visit(Some(k.as_str()), it));
                true
            }
            _ => false,
        };
        if known {
            p.limits = Some(extras);
        }
    }
    let has_extras = p.limits.as_ref().is_some_and(|l| !l.is_empty());
    (p.five_hour.is_some() || p.seven_day.is_some() || has_extras).then_some(p)
}

// ---------- red ----------

enum HttpErr {
    /// Destino no permitido: no se envía nada.
    Blocked,
    /// Fallo de red, de TLS o tiempo agotado (sin detalle: ureq no debe volcar nada).
    Net,
}
struct HttpResp {
    status: u16,
    body: Vec<u8>,
    truncated: bool,
}

/// Un GET con el token. Solo a `USAGE_URL` o a un destino loopback; sin redirecciones.
fn http_get(url: &str, token: &Secret, connect: Duration, total: Duration) -> Result<HttpResp, HttpErr> {
    let loopback = is_loopback_url(url);
    if url != USAGE_URL && !loopback {
        return Err(HttpErr::Blocked);
    }
    let mut cfg = ureq::Agent::config_builder()
        .timeout_connect(Some(connect))
        .timeout_global(Some(total))
        .max_redirects(0)
        .max_redirects_will_error(false)
        .http_status_as_error(false);
    if loopback {
        cfg = cfg.proxy(None); // el tráfico local nunca pasa por un proxy
    }
    let agent: ureq::Agent = cfg.build().into();
    let mut resp = agent
        .get(url)
        .header("Authorization", format!("Bearer {}", token.expose()))
        .header("anthropic-beta", BETA_HEADER)
        .header("User-Agent", format!("Orchestra/{}", env!("CARGO_PKG_VERSION")))
        .header("Accept", "application/json")
        .call()
        .map_err(|_| HttpErr::Net)?;
    let status = resp.status().as_u16();
    let mut body = Vec::new();
    resp.body_mut().as_reader().take(MAX_BODY + 1).read_to_end(&mut body).map_err(|_| HttpErr::Net)?;
    let truncated = body.len() as u64 > MAX_BODY;
    body.truncate(MAX_BODY as usize);
    Ok(HttpResp { status, body, truncated })
}

// ---------- estado por cuenta ----------

#[derive(Default)]
struct AcctState {
    last_request: f64,
    skip_until: f64,
    fails: u32,
    last: Option<UsageResult>,
    /// Hasta cuándo no se reintenta sola una renovación que falló.
    renew_retry_at: f64,
}

/// Estado en memoria de las consultas (suelo de 60 s y espera tras 429 / 5xx).
#[derive(Default)]
pub struct Tracker(Mutex<HashMap<String, AcctState>>);

static TRACKER: LazyLock<Tracker> = LazyLock::new(Tracker::default);

pub struct Env<'a> {
    pub base: &'a Path,
    pub url: &'a str,
    pub connect: Duration,
    pub total: Duration,
    /// Pausa entre cuentas (solo si la anterior hizo una petición).
    pub spacing: Duration,
    /// Consulta pedida a mano (botón de refrescar): suelo de 10 s y sin espera tras errores.
    pub force: bool,
    /// Si el token caducó, cómo pedir a Claude Code que lo renueve (recibe la carpeta de la cuenta; `true` = terminó bien).
    /// `None` = no se renueva.
    pub renewer: Option<&'a dyn Fn(&str) -> bool>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Corta en un límite de carácter UTF-8.
fn clip(s: &str, max: usize) -> &str {
    let mut n = max.min(s.len());
    while !s.is_char_boundary(n) {
        n -= 1;
    }
    &s[..n]
}

/// Respuesta cruda saneada (solo el cuerpo, ≤ 4 KB, sin el token aunque el servidor lo repitiera).
fn sanitized_raw(body: &[u8], token: &Secret) -> String {
    let text = String::from_utf8_lossy(body);
    let text = text.replace(token.expose(), "***");
    clip(&text, MAX_RAW).to_string()
}

fn merge_and_save(base: &Path, id: &str, p: &Parsed, now: f64) -> Result<(), String> {
    let qdir = base.join("quota");
    std::fs::create_dir_all(&qdir).map_err(|e| e.to_string())?;
    let path = qdir.join(format!("{id}.json"));
    let mut q: QuotaFile = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if p.five_hour.is_some() {
        q.five_hour = p.five_hour.clone();
    }
    if p.seven_day.is_some() {
        q.seven_day = p.seven_day.clone();
    }
    // `limits`: si la respuesta los trae, sustituyen a los guardados; si no, se conservan.
    if let Some(l) = &p.limits {
        q.limits = if l.is_empty() { None } else { Some(l.clone()) };
    }
    q.at = Some(now);
    let json = serde_json::to_string(&q).map_err(|e| e.to_string())?;
    crate::quota::write_if_changed(&path, &json).map(|_| ())
}

fn save_raw(base: &Path, id: &str, text: &str) {
    let qdir = base.join("quota");
    if std::fs::create_dir_all(&qdir).is_ok() {
        let _ = crate::quota::write_if_changed(&qdir.join(format!("{id}.query-raw.txt")), text);
    }
}

/// Consulta UNA cuenta. Devuelve el resultado y si se hizo una petición de red.
pub fn fetch_one(env: &Env, tracker: &Tracker, acct: &AccountIn, interval_min: u32, now: f64) -> (UsageResult, bool) {
    let id = acct.id.as_str();
    if !valid_id(id) {
        return (res("", Status::Error, now, Some("invalid account id")), false);
    }
    // 1. Suelo de 60 s (10 s si es a mano) y espera: se devuelve lo último que se supo, sin tocar la red.
    {
        let map = tracker.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(st) = map.get(id) {
            let gap = if env.force { FORCE_GAP_SEC } else { MIN_GAP_SEC };
            if st.last_request > 0.0 && (now - st.last_request < gap || (!env.force && now < st.skip_until)) {
                if let Some(last) = &st.last {
                    return (last.clone(), false);
                }
            }
        }
    }
    // 2. Credenciales: si no sirven, no se envía nada. Caducadas: se pide a Claude Code que las renueve (si se permite).
    let token = match read_token(&acct.dir, now) {
        Ok(t) => t,
        Err((Status::Expired, msg)) => match renew(env, tracker, acct, now) {
            Ok(t) => t,
            Err(renew_msg) => return (res(id, Status::Expired, now, Some(renew_msg.unwrap_or(msg))), false),
        },
        Err((status, msg)) => return (res(id, status, now, Some(msg)), false),
    };
    // 3. Una única petición.
    {
        let mut map = tracker.0.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(id.to_string()).or_default().last_request = now;
    }
    let outcome = http_get(env.url, &token, env.connect, env.total);
    let mut backoff = false;
    let mut result = match outcome {
        Err(HttpErr::Blocked) => res(id, Status::Error, now, Some("request destination not allowed")),
        Err(HttpErr::Net) => {
            backoff = true;
            res(id, Status::Error, now, Some("network error or timeout"))
        }
        Ok(r) => {
            if !r.body.is_empty() {
                save_raw(env.base, id, &sanitized_raw(&r.body, &token));
            }
            match r.status {
                200..=299 if r.truncated => res(id, Status::Error, now, Some("response too large")),
                200..=299 => match parse_usage(&r.body, now) {
                    Some(p) => match merge_and_save(env.base, id, &p, now) {
                        Ok(()) => UsageResult { five_hour: p.five_hour, seven_day: p.seven_day, ..res(id, Status::Ok, now, None) },
                        Err(_) => res(id, Status::Error, now, Some("could not save the result")),
                    },
                    None => res(id, Status::Error, now, Some("unrecognized response")),
                },
                401 | 403 => res(id, Status::Unauthorized, now, Some("Anthropic rejected the token")),
                429 => {
                    backoff = true;
                    res(id, Status::RateLimited, now, Some("rate limited"))
                }
                500..=599 => {
                    backoff = true;
                    res(id, Status::Error, now, Some("server error"))
                }
                300..=399 => res(id, Status::Error, now, Some("redirect not followed")),
                _ => res(id, Status::Error, now, Some("unexpected HTTP status")),
            }
        }
    };
    result.account_id = id.to_string();
    {
        let mut map = tracker.0.lock().unwrap_or_else(|e| e.into_inner());
        let st = map.entry(id.to_string()).or_default();
        if backoff {
            st.fails = st.fails.saturating_add(1);
            let base = 2.0 * f64::from(interval_min.clamp(2, 30)) * 60.0;
            let wait = (base * 2f64.powi(st.fails.saturating_sub(1).min(8) as i32)).min(MAX_BACKOFF_SEC);
            st.skip_until = now + wait;
        } else {
            st.fails = 0;
            st.skip_until = 0.0;
        }
        st.last = Some(result.clone());
    }
    (result, true)
}

/// Token caducado: pide a Claude Code que lo renueve y vuelve a leerlo. `Err(None)` = no se intentó (sin `renewer`);
/// `Err(Some(texto))` = se intentó ahora (o hace menos de 30 min, en una consulta automática) y sigue caducado.
fn renew(env: &Env, tracker: &Tracker, acct: &AccountIn, now: f64) -> Result<Secret, Option<&'static str>> {
    const FAILED: &str = "Claude Code could not renew the sign-in; open Claude in that account";
    let Some(renewer) = env.renewer else { return Err(None) };
    let id = acct.id.as_str();
    {
        let map = tracker.0.lock().unwrap_or_else(|e| e.into_inner());
        if !env.force && map.get(id).is_some_and(|st| now < st.renew_retry_at) {
            return Err(Some(FAILED));
        }
    }
    let token = if renewer(&acct.dir) { read_token(&acct.dir, now).ok() } else { None };
    let mut map = tracker.0.lock().unwrap_or_else(|e| e.into_inner());
    let st = map.entry(id.to_string()).or_default();
    st.renew_retry_at = if token.is_some() { 0.0 } else { now + RENEW_RETRY_SEC };
    token.ok_or(Some(FAILED))
}

/// Consulta varias cuentas, una tras otra.
pub fn fetch_all(env: &Env, tracker: &Tracker, accounts: &[AccountIn], interval_min: u32, now: impl Fn() -> f64) -> Vec<UsageResult> {
    let mut out = Vec::new();
    let mut prev_requested = false;
    for a in accounts.iter().take(MAX_ACCOUNTS) {
        if prev_requested && !env.spacing.is_zero() {
            std::thread::sleep(env.spacing);
        }
        let (r, requested) = fetch_one(env, tracker, a, interval_min, now());
        prev_requested = requested;
        out.push(r);
    }
    out
}

fn unix_now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0).floor()
}

/// Pregunta a Anthropic por el uso de cada cuenta y lo guarda en `quota/<cuenta>.json`.
/// Solo se llama desde la interfaz cuando el usuario lo ha activado (o pulsa «Probar ahora» / refrescar).
/// `force` = pedido a mano (suelo de 10 s, sin espera tras errores); `renew` = si el token caducó, pedir a Claude Code que lo renueve.
#[tauri::command]
pub async fn usage_fetch(
    app: tauri::AppHandle,
    accounts: Vec<AccountIn>,
    interval_min: Option<u32>,
    force: Option<bool>,
    renew: Option<bool>,
) -> Result<Vec<UsageResult>, String> {
    let base: PathBuf = crate::store::base_dir(&app)?;
    let url = resolve_url(std::env::var(URL_ENV).ok().as_deref()).map_err(str::to_string)?;
    let interval = interval_min.unwrap_or(5).clamp(2, 30);
    let (force, renew) = (force.unwrap_or(false), renew.unwrap_or(false));
    tauri::async_runtime::spawn_blocking(move || {
        let renewer: &dyn Fn(&str) -> bool = &crate::usage_renew::renew_with_claude;
        let env = Env {
            base: &base,
            url: &url,
            connect: Duration::from_secs(5),
            total: Duration::from_secs(10),
            spacing: Duration::from_millis(400),
            force,
            renewer: renew.then_some(renewer),
        };
        fetch_all(&env, &TRACKER, &accounts, interval, unix_now)
    })
    .await
    .map_err(|_| "usage query task failed".to_string())
}

#[cfg(test)]
mod tests;
