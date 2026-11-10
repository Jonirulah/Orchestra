//! Tema elegido en Claude Code sin pasar por /theme: Orchestra pone `"theme": "custom:orchestra-terminal"` en el
//! `settings.json` de cada cuenta (ajuste «Usar el tema del terminal en Claude»).
//!
//! Claude Code 2.1.322 lee el tema con `resolveSetting("theme", "dark")` (los ajustes del usuario: `<CLAUDE_CONFIG_DIR>/
//! settings.json`) y acepta los de serie (`auto`, `dark`, `light`, `*-daltonized`, `*-ansi`) o `custom:<slug>`, que carga de
//! `<CLAUDE_CONFIG_DIR>/themes/<slug>.json`. Lo lee al arrancar la sesión (`useState` inicial): una sesión abierta no cambia
//! de tema hasta que se reinicia; el contenido de los archivos de tema sí lo recarga en caliente.
//!
//! Reglas:
//! - Se edita SOLO el valor de la clave `theme` en el texto (sin reserializar): el resto del JSON queda byte a byte igual, y
//!   se comprueba al parsear antes de escribir. Escritura atómica (temporal + renombrar).
//! - Solo se cambia un tema de serie de Claude o un `custom:orchestra-*`; un tema propio elegido a mano no se toca.
//! - El valor anterior se guarda en `<cuenta>/.orchestra-theme.json` para devolverlo al apagar la opción. Si el usuario cambia
//!   el tema después (con /theme), Orchestra lo respeta: no lo vuelve a poner ni lo restaura.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const BACKUP: &str = ".orchestra-theme.json";
const MAX_SETTINGS: u64 = 4 * 1024 * 1024;

/// Temas de serie de Claude Code 2.1.322 (`M4e` en su binario).
const BUILTIN: [&str; 7] = ["auto", "dark", "light", "light-daltonized", "dark-daltonized", "light-ansi", "dark-ansi"];

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Backup {
    /// Valor que tenía `theme` antes (None = no había clave).
    previous: Option<String>,
    /// Valor que puso Orchestra.
    applied: String,
    /// El usuario cambió el tema a mano después: Orchestra ya no lo toca.
    #[serde(default)]
    released: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceResult {
    pub dir: String,
    pub ok: bool,
    /// `set` (puesto ahora), `kept` (ya estaba), `manual` (tema elegido a mano: no se toca), `restored`, `none`.
    pub action: String,
    pub error: Option<String>,
}

fn overwritable(v: Option<&str>) -> bool {
    match v {
        None => true,
        Some(v) => BUILTIN.contains(&v) || v.starts_with("custom:orchestra-"),
    }
}

fn valid_target(t: &str) -> bool {
    t.strip_prefix("custom:orchestra-")
        .is_some_and(|s| !s.is_empty() && s.len() <= 90 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
}

// ---------- edición del texto JSON ----------

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i
}

/// Fin (exclusivo) de la cadena JSON que empieza en `i` (comilla).
fn skip_string(b: &[u8], mut i: usize) -> Option<usize> {
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// Fin (exclusivo) del valor JSON que empieza en `i`.
fn skip_value(b: &[u8], i: usize) -> Option<usize> {
    match *b.get(i)? {
        b'"' => skip_string(b, i),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut j = i;
            while j < b.len() {
                match b[j] {
                    b'"' => {
                        j = skip_string(b, j)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(j + 1);
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            None
        }
        _ => {
            let mut j = i;
            while j < b.len() && !matches!(b[j], b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r') {
                j += 1;
            }
            (j > i).then_some(j)
        }
    }
}

/// Claves del objeto raíz: (inicio de la clave, inicio del valor, fin del valor, nombre). `brace` = posición de `{`.
struct Member {
    key_start: usize,
    val_start: usize,
    val_end: usize,
    name: String,
}

fn members(text: &str) -> Option<(usize, Vec<Member>)> {
    let b = text.as_bytes();
    let brace = skip_ws(b, 0);
    if b.get(brace) != Some(&b'{') {
        return None;
    }
    let mut out = Vec::new();
    let mut i = skip_ws(b, brace + 1);
    if b.get(i) == Some(&b'}') {
        return Some((brace, out));
    }
    loop {
        if b.get(i) != Some(&b'"') {
            return None;
        }
        let key_end = skip_string(b, i)?;
        let name: String = serde_json::from_str(&text[i..key_end]).ok()?;
        let colon = skip_ws(b, key_end);
        if b.get(colon) != Some(&b':') {
            return None;
        }
        let val_start = skip_ws(b, colon + 1);
        let val_end = skip_value(b, val_start)?;
        out.push(Member { key_start: i, val_start, val_end, name });
        let next = skip_ws(b, val_end);
        match b.get(next) {
            Some(b',') => i = skip_ws(b, next + 1),
            Some(b'}') => return Some((brace, out)),
            _ => return None,
        }
    }
}

/// Texto con `theme` = `value` (Some) o sin la clave (None). Solo cambia ese trozo del texto.
fn edit_theme(text: &str, value: Option<&str>) -> Result<String, String> {
    let bad = || "settings.json no es un objeto JSON válido".to_string();
    let (brace, ms) = members(text).ok_or_else(bad)?;
    let found = ms.iter().rposition(|m| m.name == "theme");
    let lit = value.map(|v| serde_json::to_string(v).unwrap());
    Ok(match (found, lit) {
        (Some(k), Some(lit)) => format!("{}{}{}", &text[..ms[k].val_start], lit, &text[ms[k].val_end..]),
        (None, Some(lit)) => match ms.first() {
            // Delante de la primera clave, con su misma sangría.
            Some(first) => {
                let ws = &text[brace + 1..first.key_start];
                format!("{}\"theme\": {},{}{}", &text[..first.key_start], lit, ws, &text[first.key_start..])
            }
            None => {
                let close = text[brace..].find('}').map(|p| brace + p).ok_or_else(bad)?;
                format!("{}{{\n  \"theme\": {}\n}}{}", &text[..brace], lit, &text[close + 1..])
            }
        },
        (Some(k), None) => {
            let m = &ms[k];
            if k + 1 < ms.len() {
                // Hasta la clave siguiente (se lleva su coma y el salto de línea).
                format!("{}{}", &text[..m.key_start], &text[ms[k + 1].key_start..])
            } else if k > 0 {
                // Última: desde el final del valor anterior (se lleva la coma que la precede).
                format!("{}{}", &text[..ms[k - 1].val_end], &text[m.val_end..])
            } else {
                // Única clave.
                let close = skip_ws(text.as_bytes(), m.val_end);
                format!("{}{}{}", &text[..brace + 1], if text[brace..].contains('\n') { "\n" } else { "" }, &text[close..])
            }
        }
        (None, None) => text.to_string(),
    })
}

fn parse(text: &str) -> Option<serde_json::Map<String, Value>> {
    match serde_json::from_str::<Value>(text).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

/// Edita el texto y comprueba que lo único que cambia al parsearlo es la clave `theme`.
fn checked_edit(text: &str, value: Option<&str>) -> Result<String, String> {
    let before = parse(text).ok_or("settings.json no es un objeto JSON válido")?;
    let out = edit_theme(text, value)?;
    let after = parse(&out).ok_or("la edición de settings.json no es JSON válido")?;
    let mut expect = before;
    match value {
        Some(v) => {
            expect.insert("theme".into(), Value::String(v.into()));
        }
        None => {
            expect.remove("theme");
        }
    }
    if after != expect {
        return Err("la edición de settings.json cambiaría otras claves".into());
    }
    Ok(out)
}

// ---------- archivos ----------

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("settings.json");
    let tmp = path.with_file_name(format!(".{name}.orchestra.tmp"));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Lee settings.json: (texto sin BOM, BOM, valor actual de `theme`). Sin archivo = `{}`.
fn read_settings(path: &Path) -> Result<(String, &'static str, Option<String>), String> {
    let raw = match std::fs::metadata(path) {
        Ok(m) if m.len() > MAX_SETTINGS => return Err("settings.json demasiado grande".into()),
        Ok(_) => std::fs::read_to_string(path).map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "{}\n".to_string(),
        Err(e) => return Err(e.to_string()),
    };
    let (bom, text) = match raw.strip_prefix('\u{feff}') {
        Some(t) => ("\u{feff}", t.to_string()),
        None => ("", raw),
    };
    let map = parse(&text).ok_or("settings.json no es un objeto JSON válido")?;
    let cur = match map.get("theme") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => Some(String::new()), // valor raro: cuenta como elegido a mano
    };
    Ok((text, bom, cur))
}

fn read_backup(dir: &Path) -> Option<Backup> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(BACKUP)).ok()?).ok()
}

fn write_backup(dir: &Path, b: &Backup) -> Result<(), String> {
    write_atomic(&dir.join(BACKUP), &serde_json::to_string_pretty(b).unwrap())
}

/// Pone `target` como tema de la cuenta si toca. Devuelve la acción (`set`, `kept`, `manual`).
pub fn apply(dir: &Path, target: &str) -> Result<&'static str, String> {
    let path = dir.join("settings.json");
    let (text, bom, cur) = read_settings(&path)?;
    match read_backup(dir) {
        Some(b) if b.released => return Ok("manual"),
        Some(mut b) => {
            if cur.as_deref() == Some(b.applied.as_str()) {
                if b.applied == target {
                    return Ok("kept");
                }
                // Otro tema de Orchestra (cambió el destino): se cambia y se conserva el valor anterior original.
                write_atomic(&path, &format!("{bom}{}", checked_edit(&text, Some(target))?))?;
                b.applied = target.into();
                write_backup(dir, &b)?;
                return Ok("set");
            }
            // Lo cambió el usuario después de Orchestra: desde ahora es suyo.
            b.released = true;
            write_backup(dir, &b)?;
            return Ok("manual");
        }
        None => {}
    }
    if cur.as_deref() == Some(target) {
        return Ok("kept");
    }
    if !overwritable(cur.as_deref()) {
        return Ok("manual");
    }
    // Primero la copia del valor anterior: si falla, no se toca settings.json.
    write_backup(dir, &Backup { previous: cur, applied: target.into(), released: false })?;
    if let Err(e) = write_atomic(&path, &format!("{bom}{}", checked_edit(&text, Some(target))?)) {
        let _ = std::fs::remove_file(dir.join(BACKUP));
        return Err(e);
    }
    Ok("set")
}

/// Devuelve el tema anterior si el actual sigue siendo el que puso Orchestra. Devuelve `restored` o `none`.
pub fn restore(dir: &Path) -> Result<&'static str, String> {
    let Some(b) = read_backup(dir) else { return Ok("none") };
    let path = dir.join("settings.json");
    let mut action = "none";
    if !b.released {
        let (text, bom, cur) = read_settings(&path)?;
        if cur.as_deref() == Some(b.applied.as_str()) {
            write_atomic(&path, &format!("{bom}{}", checked_edit(&text, b.previous.as_deref())?))?;
            action = "restored";
        }
    }
    std::fs::remove_file(dir.join(BACKUP)).map_err(|e| e.to_string())?;
    Ok(action)
}

/// `on` = poner `target` en cada cuenta; `!on` = devolver el tema anterior. Solo carpetas de cuentas de Claude.
pub fn set_all(dirs: Vec<String>, on: bool, target: String) -> Result<Vec<ChoiceResult>, String> {
    if on && !valid_target(&target) {
        return Err(format!("tema no válido: {target}"));
    }
    Ok(dirs
        .into_iter()
        .take(50)
        .map(|d| {
            let p = Path::new(&d);
            let r = if !crate::claude_themes::valid_dir(p) {
                Err("no es la carpeta de una cuenta de Claude".to_string())
            } else if on {
                apply(p, &target)
            } else {
                restore(p)
            };
            match r {
                Ok(a) => ChoiceResult { dir: d, ok: true, action: a.into(), error: None },
                Err(e) => ChoiceResult { dir: d, ok: false, action: "none".into(), error: Some(e) },
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "custom:orchestra-terminal";

    fn tmp_account(tag: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!("orch-tc-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let acc = base.join(".claude-prueba");
        std::fs::create_dir_all(&acc).unwrap();
        acc
    }
    fn settings(acc: &Path) -> String {
        std::fs::read_to_string(acc.join("settings.json")).unwrap()
    }
    const USER: &str = "{\n  \"permissions\": {\n    \"allow\": [\"Bash(git:*)\"]\n  },\n  \"model\": \"opus\",\n  \"theme\": \"dark\",\n  \"tui\": \"fullscreen\",\n  \"hooks\": {\"Stop\": [{\"x\": \"a \\\"theme\\\": b\"}]}\n}\n";

    #[test]
    fn edits_only_the_theme_value_and_keeps_everything_else_byte_for_byte() {
        let out = checked_edit(USER, Some(T)).unwrap();
        assert_eq!(out, USER.replace("\"theme\": \"dark\"", "\"theme\": \"custom:orchestra-terminal\""));
        // Sin clave: se añade delante de la primera con la misma sangría.
        let no = "{\n  \"model\": \"opus\"\n}";
        assert_eq!(checked_edit(no, Some(T)).unwrap(), "{\n  \"theme\": \"custom:orchestra-terminal\",\n  \"model\": \"opus\"\n}");
        assert_eq!(checked_edit("{}", Some(T)).unwrap(), "{\n  \"theme\": \"custom:orchestra-terminal\"\n}");
        // Quitar la clave: en medio, al final y sola.
        assert_eq!(checked_edit(USER, None).unwrap(), USER.replace("  \"theme\": \"dark\",\n", ""));
        assert_eq!(checked_edit("{\n  \"a\": 1,\n  \"theme\": \"dark\"\n}", None).unwrap(), "{\n  \"a\": 1\n}");
        assert_eq!(checked_edit("{\n  \"theme\": \"dark\"\n}\n", None).unwrap(), "{\n}\n");
        assert_eq!(checked_edit("{\"theme\":\"dark\"}", None).unwrap(), "{}");
        // Una clave «theme» dentro de otro objeto o de una cadena no cuenta.
        let nested = "{\"hooks\": {\"theme\": \"x\"}, \"s\": \"\\\"theme\\\": 1\"}";
        assert_eq!(checked_edit(nested, Some(T)).unwrap(), format!("{{\"theme\": \"{T}\",\"hooks\": {{\"theme\": \"x\"}}, \"s\": \"\\\"theme\\\": 1\"}}"));
        assert!(checked_edit("[1]", Some(T)).is_err());
        assert!(checked_edit("{\"a\": }", Some(T)).is_err());
    }

    #[test]
    fn sets_the_theme_keeps_other_keys_and_restores_the_previous_value() {
        let acc = tmp_account("set");
        std::fs::write(acc.join("settings.json"), USER).unwrap();
        assert_eq!(apply(&acc, T).unwrap(), "set");
        assert_eq!(settings(&acc), USER.replace("\"dark\"", "\"custom:orchestra-terminal\""));
        assert_eq!(apply(&acc, T).unwrap(), "kept");
        assert_eq!(restore(&acc).unwrap(), "restored");
        assert_eq!(settings(&acc), USER, "vuelve byte a byte");
        assert!(!acc.join(BACKUP).exists());
        assert_eq!(restore(&acc).unwrap(), "none");
        let _ = std::fs::remove_dir_all(acc.parent().unwrap());
    }

    #[test]
    fn missing_key_or_file_is_restored_by_removing_the_key() {
        let acc = tmp_account("miss");
        assert_eq!(apply(&acc, T).unwrap(), "set");
        assert_eq!(parse(&settings(&acc)).unwrap()["theme"], T);
        assert_eq!(restore(&acc).unwrap(), "restored");
        assert!(parse(&settings(&acc)).unwrap().get("theme").is_none());
        std::fs::write(acc.join("settings.json"), "\u{feff}{\n  \"model\": \"opus\"\n}\n").unwrap();
        assert_eq!(apply(&acc, T).unwrap(), "set");
        assert!(settings(&acc).starts_with("\u{feff}{\n  \"theme\""), "conserva el BOM");
        assert_eq!(restore(&acc).unwrap(), "restored");
        assert_eq!(settings(&acc), "\u{feff}{\n  \"model\": \"opus\"\n}\n");
        let _ = std::fs::remove_dir_all(acc.parent().unwrap());
    }

    #[test]
    fn never_overwrites_a_theme_chosen_by_hand() {
        let acc = tmp_account("hand");
        // Tema propio del usuario: no se toca.
        let own = "{\"theme\": \"custom:mi-tema\"}";
        std::fs::write(acc.join("settings.json"), own).unwrap();
        assert_eq!(apply(&acc, T).unwrap(), "manual");
        assert_eq!(settings(&acc), own);
        assert!(!acc.join(BACKUP).exists());
        assert_eq!(restore(&acc).unwrap(), "none");
        // Los de serie y los de Orchestra sí se cambian.
        for v in ["light-daltonized", "dark-ansi", "auto", "custom:orchestra-dracula"] {
            std::fs::write(acc.join("settings.json"), format!("{{\"theme\": \"{v}\"}}")).unwrap();
            assert_eq!(apply(&acc, T).unwrap(), "set", "{v}");
            assert_eq!(restore(&acc).unwrap(), "restored");
            assert_eq!(settings(&acc), format!("{{\"theme\": \"{v}\"}}"));
        }
        // Lo cambia el usuario con /theme después de Orchestra: ni se vuelve a poner ni se «restaura» encima.
        std::fs::write(acc.join("settings.json"), "{\"theme\": \"dark\"}").unwrap();
        assert_eq!(apply(&acc, T).unwrap(), "set");
        std::fs::write(acc.join("settings.json"), "{\"theme\": \"light\"}").unwrap();
        assert_eq!(apply(&acc, T).unwrap(), "manual");
        assert_eq!(apply(&acc, T).unwrap(), "manual", "sigue siendo suyo en los siguientes arranques");
        assert_eq!(settings(&acc), "{\"theme\": \"light\"}");
        assert_eq!(restore(&acc).unwrap(), "none");
        assert_eq!(settings(&acc), "{\"theme\": \"light\"}");
        assert!(!acc.join(BACKUP).exists());
        let _ = std::fs::remove_dir_all(acc.parent().unwrap());
    }

    #[test]
    fn invalid_json_is_never_touched_and_foreign_dirs_or_targets_are_rejected() {
        let acc = tmp_account("bad");
        std::fs::write(acc.join("settings.json"), "{ roto").unwrap();
        assert!(apply(&acc, T).is_err());
        assert_eq!(settings(&acc), "{ roto");
        assert!(!acc.join(BACKUP).exists());
        let dir = acc.to_string_lossy().into_owned();
        assert!(set_all(vec![dir.clone()], true, "custom:mi-tema".into()).is_err());
        assert!(set_all(vec![dir.clone()], true, "dark".into()).is_err());
        let other = acc.parent().unwrap().join("Documentos");
        std::fs::create_dir_all(&other).unwrap();
        let r = set_all(vec![other.to_string_lossy().into_owned()], true, T.into()).unwrap();
        assert!(!r[0].ok);
        assert!(!other.join("settings.json").exists());
        let _ = std::fs::remove_dir_all(acc.parent().unwrap());
    }
}
