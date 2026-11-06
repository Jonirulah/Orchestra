//! Cuotas de uso (ventanas de 5 h y 7 d) de las suscripciones de Claude Code.
//!
//! Claude Code pasa a su statusline un JSON por stdin con `rate_limits.five_hour` y
//! `rate_limits.seven_day` (`used_percentage`, `resets_at` en segundos epoch). Orchestra
//! lanza sus Claude con `--settings <orchestra-settings.json>`, cuyo `statusLine` apunta a
//! un script envoltorio (`orchestra-statusline.ps1`). Ese script guarda la cuota en
//! `<datos>\quota\<cuenta>.json` y luego ejecuta el statusline original del usuario con el
//! mismo stdin. Aquí solo se escriben esos dos ficheros y se LEE la carpeta `quota`.
//! No se toca nada de `~/.claude*`.

use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// Envoltorio del statusline (PowerShell 5.1, solo ASCII). Se vigila en una prueba.
const WRAPPER: &str = include_str!("orchestra-statusline.ps1");
const WRAPPER_NAME: &str = "orchestra-statusline.ps1";
const SETTINGS_NAME: &str = "orchestra-settings.json";

/// Una ventana de cuota: `used` en 0..100, `resets_at` en segundos epoch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub used: f64,
    pub resets_at: f64,
}

/// Un límite extra (p. ej. el semanal de un modelo) que solo conoce la consulta a Anthropic:
/// `percent` en 0..100, `resets_at` en segundos epoch, `scope` = nombre del modelo, `active` = el que está corriendo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub kind: String,
    pub percent: f64,
    pub resets_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default)]
    pub active: bool,
}

/// Máximo de límites extra que se guardan por cuenta y largo máximo de sus textos.
pub const MAX_LIMITS: usize = 8;
pub const MAX_LIMIT_TEXT: usize = 40;

/// Quita caracteres de control y corta a `MAX_LIMIT_TEXT` caracteres.
pub fn clean_text(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(MAX_LIMIT_TEXT).collect::<String>().trim().to_string()
}

/// Normaliza un límite: porcentaje a 0..100, instante a segundos, textos limpios. `None` si no sirve.
fn clean_limit(l: Limit) -> Option<Limit> {
    let w = clean(l.percent, l.resets_at)?;
    let kind = clean_text(&l.kind);
    if kind.is_empty() {
        return None;
    }
    let scope = l.scope.map(|s| clean_text(&s)).filter(|s| !s.is_empty());
    Some(Limit { kind, percent: w.used, resets_at: w.resets_at, scope, active: l.active })
}

/// Contenido de `quota/<cuenta>.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<Window>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seven_day: Option<Window>,
    /// Cuándo se guardó (segundos epoch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<f64>,
    /// Límites extra (solo los escribe la consulta a Anthropic; el envoltorio de statusline los conserva).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<Vec<Limit>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountQuota {
    pub account_id: String,
    #[serde(flatten)]
    pub quota: QuotaFile,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub settings_path: String,
}

#[cfg(test)]
fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// Normaliza una ventana: porcentaje a 0..100, instante a segundos (si llega en ms se divide).
fn clean(used: f64, resets: f64) -> Option<Window> {
    if !used.is_finite() || !resets.is_finite() || resets <= 0.0 {
        return None;
    }
    let r = if resets > 1e11 { resets / 1000.0 } else { resets };
    Some(Window { used: used.clamp(0.0, 100.0), resets_at: r.floor() })
}

#[cfg(test)]
fn window_from_payload(v: Option<&Value>) -> Option<Window> {
    let v = v?;
    clean(number(v.get("used_percentage")?)?, number(v.get("resets_at")?)?)
}

/// (Solo pruebas: la lógica viva está en el .ps1; aquí queda como especificación ejecutable.)
/// Lee el JSON que Claude Code pasa al statusline. `None` si no es JSON o no trae ninguna
/// ventana de `rate_limits` (cuentas sin suscripción, o antes de la primera respuesta).
#[cfg(test)]
pub fn parse_payload(text: &str, now: f64) -> Option<QuotaFile> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let rl = v.get("rate_limits")?;
    let q = QuotaFile {
        five_hour: window_from_payload(rl.get("five_hour")),
        seven_day: window_from_payload(rl.get("seven_day")),
        at: Some(now),
        limits: None,
    };
    if q.five_hour.is_none() && q.seven_day.is_none() {
        None
    } else {
        Some(q)
    }
}

/// Lee todos los `*.json` de la carpeta de cuotas. Ignora los corruptos, los temporales y los vacíos.
pub fn read_dir(dir: &Path) -> Vec<AccountQuota> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<AccountQuota> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                return None;
            }
            let id = p.file_stem()?.to_str()?.to_string();
            let mut q: QuotaFile = serde_json::from_str(&std::fs::read_to_string(&p).ok()?).ok()?;
            q.five_hour = q.five_hour.and_then(|w| clean(w.used, w.resets_at));
            q.seven_day = q.seven_day.and_then(|w| clean(w.used, w.resets_at));
            let limits: Vec<Limit> = q.limits.take().unwrap_or_default().into_iter().filter_map(clean_limit).take(MAX_LIMITS).collect();
            q.limits = if limits.is_empty() { None } else { Some(limits) };
            if q.five_hour.is_none() && q.seven_day.is_none() && q.limits.is_none() {
                return None;
            }
            Some(AccountQuota { account_id: id, quota: q })
        })
        .collect();
    out.sort_by(|a, b| a.account_id.cmp(&b.account_id));
    out
}

/// Escribe `content` solo si cambió (atómico). Devuelve `true` si escribió.
pub(crate) fn write_if_changed(path: &Path, content: &str) -> Result<bool, String> {
    if std::fs::read_to_string(path).map(|s| s == content).unwrap_or(false) {
        return Ok(false);
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Contenido de `orchestra-settings.json`: solo `statusLine`. Rutas con `/` (también las
/// entiende el shell de Claude Code) y entre comillas por si hay espacios.
pub fn settings_json(wrapper: &Path) -> String {
    let w = wrapper.to_string_lossy().replace('\\', "/");
    let cmd = format!("powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{w}\"");
    let v = serde_json::json!({ "statusLine": { "type": "command", "command": cmd } });
    serde_json::to_string_pretty(&v).unwrap_or_default() + "\n"
}

/// Deja el envoltorio y los ajustes en `bin_dir` (idempotente). Devuelve la ruta de los ajustes.
pub fn prepare_in(bin_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| e.to_string())?;
    let wrapper = bin_dir.join(WRAPPER_NAME);
    let settings = bin_dir.join(SETTINGS_NAME);
    write_if_changed(&wrapper, WRAPPER)?;
    write_if_changed(&settings, &settings_json(&wrapper))?;
    Ok(settings)
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::store::base_dir(app)
}

/// Prepara el envoltorio y devuelve la ruta del `--settings` que hay que pasar a `claude`.
#[tauri::command]
pub fn quota_prepare(app: AppHandle) -> Result<Prepared, String> {
    let p = prepare_in(&data_dir(&app)?.join("bin"))?;
    Ok(Prepared { settings_path: p.to_string_lossy().into_owned() })
}

/// Última cuota conocida de cada cuenta.
#[tauri::command]
pub fn quota_read(app: AppHandle) -> Vec<AccountQuota> {
    match data_dir(&app) {
        Ok(d) => read_dir(&d.join("quota")),
        Err(_) => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"{"session_id":"s","model":{"display_name":"Opus"},
        "rate_limits":{"five_hour":{"used_percentage":62.4,"resets_at":1893456000},
                       "seven_day":{"used_percentage":31,"resets_at":1893888000}}}"#;

    fn tmpdir(tag: &str) -> PathBuf {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("orchestra-quota-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn parses_both_windows() {
        let q = parse_payload(FULL, 100.0).unwrap();
        assert_eq!(q.five_hour, Some(Window { used: 62.4, resets_at: 1893456000.0 }));
        assert_eq!(q.seven_day, Some(Window { used: 31.0, resets_at: 1893888000.0 }));
        assert_eq!(q.at, Some(100.0));
    }

    #[test]
    fn parses_only_five_hour() {
        let q = parse_payload(r#"{"rate_limits":{"five_hour":{"used_percentage":96,"resets_at":1893456000}}}"#, 1.0).unwrap();
        assert!(q.five_hour.is_some());
        assert!(q.seven_day.is_none());
    }

    #[test]
    fn no_rate_limits_or_garbage_gives_none() {
        assert!(parse_payload(r#"{"session_id":"s","model":{}}"#, 1.0).is_none());
        assert!(parse_payload(r#"{"rate_limits":{}}"#, 1.0).is_none());
        assert!(parse_payload(r#"{"rate_limits":null}"#, 1.0).is_none());
        assert!(parse_payload(r#"{"rate_limits":{"five_hour":{"used_percentage":"x","resets_at":5}}}"#, 1.0).is_none());
        for g in ["", "   ", "not json {", "[1,2]", "42", "null", "{\"rate_limits\":"] {
            assert!(parse_payload(g, 1.0).is_none(), "{g:?}");
        }
    }

    #[test]
    fn tolerates_floats_strings_ms_bom_and_clamps() {
        let q = parse_payload(
            "\u{feff}{\"rate_limits\":{\"five_hour\":{\"used_percentage\":\"12.5\",\"resets_at\":1893456000123},\"seven_day\":{\"used_percentage\":250,\"resets_at\":1893888000.9}}}",
            1.0,
        )
        .unwrap();
        assert_eq!(q.five_hour, Some(Window { used: 12.5, resets_at: 1893456000.0 }));
        assert_eq!(q.seven_day, Some(Window { used: 100.0, resets_at: 1893888000.0 }));
        let neg = parse_payload(r#"{"rate_limits":{"five_hour":{"used_percentage":-5,"resets_at":1893456000}}}"#, 1.0).unwrap();
        assert_eq!(neg.five_hour.unwrap().used, 0.0);
        // un instante imposible invalida la ventana
        assert!(parse_payload(r#"{"rate_limits":{"five_hour":{"used_percentage":5,"resets_at":0}}}"#, 1.0).is_none());
    }

    #[test]
    fn read_dir_ignores_corrupt_temp_and_empty() {
        let d = tmpdir("read");
        std::fs::write(d.join("good.json"), r#"{"fiveHour":{"used":10,"resetsAt":1893456000},"at":5}"#).unwrap();
        std::fs::write(d.join("both.json"), r#"{"fiveHour":{"used":96,"resetsAt":1893456000},"sevenDay":{"used":78,"resetsAt":1893888000},"at":6}"#).unwrap();
        std::fs::write(d.join("bad.json"), "{ nope").unwrap();
        std::fs::write(d.join("empty.json"), r#"{"at":3}"#).unwrap();
        std::fs::write(d.join("good.json.123.tmp"), r#"{"fiveHour":{"used":1,"resetsAt":1893456000}}"#).unwrap();
        std::fs::write(d.join("good.raw.txt"), "{}").unwrap();
        let v = read_dir(&d);
        let ids: Vec<&str> = v.iter().map(|a| a.account_id.as_str()).collect();
        assert_eq!(ids, ["both", "good"]);
        assert_eq!(v[0].quota.seven_day.as_ref().unwrap().used, 78.0);
        assert!(v[1].quota.seven_day.is_none());
        assert!(read_dir(&d.join("missing")).is_empty());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn serializes_camel_case_without_nulls() {
        let a = AccountQuota {
            account_id: "acc-1".into(),
            quota: QuotaFile { five_hour: Some(Window { used: 1.0, resets_at: 2.0 }), seven_day: None, at: Some(3.0), limits: None },
        };
        let s = serde_json::to_string(&a).unwrap();
        assert_eq!(s, r#"{"accountId":"acc-1","fiveHour":{"used":1.0,"resetsAt":2.0},"at":3.0}"#);
    }

    #[test]
    fn prepare_is_idempotent_and_settings_point_to_wrapper() {
        let d = tmpdir("prep").join("bin");
        let s = prepare_in(&d).unwrap();
        assert_eq!(s, d.join(SETTINGS_NAME));
        let w = d.join(WRAPPER_NAME);
        assert_eq!(std::fs::read_to_string(&w).unwrap(), WRAPPER);
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&s).unwrap()).unwrap();
        assert_eq!(v["statusLine"]["type"], "command");
        let cmd = v["statusLine"]["command"].as_str().unwrap();
        assert!(cmd.starts_with("powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""));
        assert!(cmd.ends_with("orchestra-statusline.ps1\""));
        assert!(!cmd.contains('\\'));
        // segunda llamada: no reescribe nada
        assert!(!write_if_changed(&w, WRAPPER).unwrap());
        assert!(!write_if_changed(&s, &settings_json(&w)).unwrap());
        let mtime = std::fs::metadata(&w).unwrap().modified().unwrap();
        prepare_in(&d).unwrap();
        assert_eq!(std::fs::metadata(&w).unwrap().modified().unwrap(), mtime);
        // si cambia el contenido, sí
        std::fs::write(&w, "old").unwrap();
        prepare_in(&d).unwrap();
        assert_eq!(std::fs::read_to_string(&w).unwrap(), WRAPPER);
        std::fs::remove_dir_all(d.parent().unwrap()).ok();
    }

    #[test]
    fn wrapper_is_ascii_only() {
        // PowerShell 5.1 lee los .ps1 sin BOM como ANSI: cualquier byte no ASCII se corrompería.
        assert!(WRAPPER.is_ascii());
        assert!(WRAPPER.contains("rate_limits"));
    }

    /// Ejecuta el envoltorio REAL (PowerShell) con `payload` en stdin, en carpetas temporales (sin tocar nada de ~/.claude*).
    #[cfg(windows)]
    fn run_wrapper(root: &Path, account: &str, payload: &str) {
        use std::io::Write as _;
        use std::process::{Command, Stdio};
        let bin = root.join("bin");
        prepare_in(&bin).unwrap();
        let cfg = root.join("cfg"); // vacía: sin statusline original que ejecutar
        std::fs::create_dir_all(&cfg).unwrap();
        let mut child = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(bin.join(WRAPPER_NAME))
            .env("ORCHESTRA_ACCOUNT", account)
            .env("CLAUDE_CONFIG_DIR", &cfg)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
    }

    #[cfg(windows)]
    #[test]
    fn wrapper_keeps_the_limits_the_usage_query_wrote() {
        let root = tmpdir("wrap-limits");
        let quota = root.join("quota");
        std::fs::create_dir_all(&quota).unwrap();
        let old = r#"{"fiveHour":{"used":10,"resetsAt":1893456000},"limits":[{"kind":"weekly_scoped","percent":40,"resetsAt":1893888000,"scope":"Fáble","active":true},{"kind":"other","percent":5.5,"resetsAt":1893888001,"active":false}],"at":5}"#;
        std::fs::write(quota.join("wl.json"), old).unwrap();
        run_wrapper(&root, "wl", FULL);
        let q = read_dir(&quota);
        assert_eq!(q.len(), 1);
        let q = &q[0].quota;
        // la ventana la actualiza el envoltorio...
        assert_eq!(q.five_hour, Some(Window { used: 62.4, resets_at: 1893456000.0 }));
        assert_eq!(q.seven_day, Some(Window { used: 31.0, resets_at: 1893888000.0 }));
        assert!(q.at.unwrap() > 1.0e9);
        // ...y los límites extra siguen igual
        let l = q.limits.as_ref().expect("limits conservados");
        assert_eq!(l.len(), 2);
        assert_eq!((l[0].kind.as_str(), l[0].percent, l[0].scope.as_deref(), l[0].active), ("weekly_scoped", 40.0, Some("Fáble"), true));
        assert_eq!((l[1].kind.as_str(), l[1].percent, l[1].scope.as_deref(), l[1].active), ("other", 5.5, None, false));
        // una cuenta sin límites previos no los inventa
        run_wrapper(&root, "wn", FULL);
        let text = std::fs::read_to_string(quota.join("wn.json")).unwrap();
        assert!(!text.contains("limits"), "{text}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_dir_cleans_and_caps_limits() {
        let d = tmpdir("limits");
        let items: Vec<String> = (0..12).map(|i| format!(r#"{{"kind":"k{i}","percent":{},"resetsAt":1893888000,"active":true}}"#, 10 * i)).collect();
        std::fs::write(
            d.join("a.json"),
            format!(
                r#"{{"sevenDay":{{"used":1,"resetsAt":1893888000}},"limits":[{{"kind":"bad\u0007kind","percent":250,"resetsAt":1893888000000,"scope":"{}"}},{{"kind":"","percent":1,"resetsAt":1893888000}},{{"kind":"nodate","percent":1,"resetsAt":0}},{}]}}"#,
                "S".repeat(90),
                items.join(",")
            ),
        )
        .unwrap();
        std::fs::write(d.join("only-limits.json"), r#"{"limits":[{"kind":"x","percent":3,"resetsAt":1893888000,"active":true}]}"#).unwrap();
        std::fs::write(d.join("junk.json"), r#"{"limits":[{"kind":"x","percent":3,"resetsAt":0}]}"#).unwrap();
        let v = read_dir(&d);
        assert_eq!(v.iter().map(|a| a.account_id.as_str()).collect::<Vec<_>>(), ["a", "only-limits"]);
        let l = v[0].quota.limits.as_ref().unwrap();
        assert_eq!(l.len(), MAX_LIMITS);
        assert_eq!(l[0].kind, "badkind");
        assert_eq!(l[0].percent, 100.0);
        assert_eq!(l[0].resets_at, 1893888000.0); // llegó en ms
        assert_eq!(l[0].scope.as_ref().unwrap().chars().count(), MAX_LIMIT_TEXT);
        assert_eq!(l[1].kind, "k0");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn limits_serialize_camel_case_and_old_files_still_load() {
        let l = Limit { kind: "weekly_scoped".into(), percent: 40.0, resets_at: 5.0, scope: Some("Fable".into()), active: true };
        let q = QuotaFile { five_hour: None, seven_day: None, at: Some(1.0), limits: Some(vec![l]) };
        assert_eq!(serde_json::to_string(&q).unwrap(), r#"{"at":1.0,"limits":[{"kind":"weekly_scoped","percent":40.0,"resetsAt":5.0,"scope":"Fable","active":true}]}"#);
        // un fichero antiguo (sin `limits`) sigue leyéndose igual
        let old: QuotaFile = serde_json::from_str(r#"{"fiveHour":{"used":1,"resetsAt":2},"at":3}"#).unwrap();
        assert_eq!(old.limits, None);
    }
}
