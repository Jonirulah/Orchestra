//! Temas de Claude Code generados por Orchestra (src/lib/claudetheme.ts): se escriben en
//! `<CLAUDE_CONFIG_DIR>/themes/orchestra-*.json` y en Claude se eligen con /theme. Solo se tocan archivos con ese prefijo:
//! los temas propios del usuario no se pisan ni se borran.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Clone, Debug)]
pub struct ThemeFile {
    pub slug: String,
    pub json: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirResult {
    pub dir: String,
    pub ok: bool,
    pub written: usize,
    pub removed: usize,
    pub error: Option<String>,
}

const PREFIX: &str = "orchestra-";
/** Claude salta los temas de más de 256 KB; los nuestros ocupan ~3 KB. */
const MAX_JSON: usize = 200 * 1024;
const MAX_FILES: usize = 200;
const MAX_DIRS: usize = 50;

fn valid_slug(s: &str) -> bool {
    s.len() > PREFIX.len()
        && s.len() <= 100
        && s.starts_with(PREFIX)
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Solo carpetas de cuentas de Claude (`.claude` o `.claude-*`), que ya existan.
pub fn valid_dir(dir: &Path) -> bool {
    dir.is_absolute()
        && dir.is_dir()
        && dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| n == ".claude" || n.starts_with(".claude-"))
}

/// Escribe los temas en `<dir>/themes` (solo los que cambian) y quita los `orchestra-*.json` que ya no se generan
/// (un tema propio borrado). Devuelve (escritos, borrados).
pub fn write_dir(dir: &Path, files: &[ThemeFile]) -> Result<(usize, usize), String> {
    if !valid_dir(dir) {
        return Err("no es la carpeta de una cuenta de Claude".into());
    }
    let themes = dir.join("themes");
    std::fs::create_dir_all(&themes).map_err(|e| e.to_string())?;
    let mut written = 0;
    for f in files {
        let path = themes.join(format!("{}.json", f.slug));
        if std::fs::read_to_string(&path).ok().as_deref() == Some(f.json.as_str()) {
            continue;
        }
        let tmp = themes.join(format!(".{}.json.tmp", f.slug));
        std::fs::write(&tmp, &f.json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        written += 1;
    }
    let keep: HashSet<String> = files.iter().map(|f| format!("{}.json", f.slug)).collect();
    let mut removed = 0;
    for e in std::fs::read_dir(&themes).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(PREFIX) && name.ends_with(".json") && !keep.contains(&name) && e.path().is_file() && std::fs::remove_file(e.path()).is_ok() {
            removed += 1;
        }
    }
    Ok((written, removed))
}

pub fn write_all(dirs: Vec<String>, files: Vec<ThemeFile>) -> Result<Vec<DirResult>, String> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err("lista de temas vacía o demasiado larga".into());
    }
    for f in &files {
        if !valid_slug(&f.slug) || f.json.len() > MAX_JSON || serde_json::from_str::<serde_json::Value>(&f.json).is_err() {
            return Err(format!("tema no válido: {}", f.slug));
        }
    }
    Ok(dirs
        .into_iter()
        .take(MAX_DIRS)
        .map(|d| match write_dir(Path::new(&d), &files) {
            Ok((written, removed)) => DirResult { dir: d, ok: true, written, removed, error: None },
            Err(e) => DirResult { dir: d, ok: false, written: 0, removed: 0, error: Some(e) },
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_account(tag: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!("orch-ct-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let acc = base.join(".claude-prueba");
        std::fs::create_dir_all(&acc).unwrap();
        acc
    }
    fn f(slug: &str) -> ThemeFile {
        ThemeFile { slug: slug.into(), json: format!("{{\"name\":\"{slug}\",\"base\":\"dark\",\"overrides\":{{}}}}") }
    }

    #[test]
    fn writes_only_what_changed_and_removes_stale_orchestra_files_only() {
        let acc = tmp_account("w");
        let themes = acc.join("themes");
        std::fs::create_dir_all(&themes).unwrap();
        std::fs::write(themes.join("mio.json"), "{}").unwrap();
        std::fs::write(themes.join("orchestra-custom-viejo.json"), "{}").unwrap();
        assert_eq!(write_dir(&acc, &[f("orchestra-dracula"), f("orchestra-terminal")]).unwrap(), (2, 1));
        assert_eq!(write_dir(&acc, &[f("orchestra-dracula"), f("orchestra-terminal")]).unwrap(), (0, 0));
        assert!(themes.join("mio.json").exists(), "el tema propio del usuario no se toca");
        assert!(!themes.join("orchestra-custom-viejo.json").exists());
        let mut changed = f("orchestra-terminal");
        changed.json = "{\"name\":\"otro\"}".into();
        assert_eq!(write_dir(&acc, &[f("orchestra-dracula"), changed]).unwrap(), (1, 0));
        let _ = std::fs::remove_dir_all(acc.parent().unwrap());
    }

    #[test]
    fn rejects_bad_slugs_bad_json_and_foreign_dirs() {
        let acc = tmp_account("r");
        let dir = acc.to_string_lossy().into_owned();
        assert!(write_all(vec![dir.clone()], vec![f("../evil")]).is_err());
        assert!(write_all(vec![dir.clone()], vec![f("orchestra-../x")]).is_err());
        assert!(write_all(vec![dir.clone()], vec![f("mio")]).is_err());
        assert!(write_all(vec![dir.clone()], vec![ThemeFile { slug: "orchestra-x".into(), json: "no json".into() }]).is_err());
        assert!(write_all(vec![dir.clone()], vec![]).is_err());
        let other = acc.parent().unwrap().join("Documentos");
        std::fs::create_dir_all(&other).unwrap();
        let r = write_all(vec![other.to_string_lossy().into_owned(), dir], vec![f("orchestra-x")]).unwrap();
        assert!(!r[0].ok && r[1].ok);
        assert!(!other.join("themes").exists());
        let _ = std::fs::remove_dir_all(acc.parent().unwrap());
    }
}
