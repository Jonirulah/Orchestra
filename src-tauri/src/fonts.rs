//! Fuentes instaladas (DirectWrite), para la lista de fuentes del terminal en Ajustes.
//!
//! El WebView2 solo ve las fuentes que había cuando arrancó su proceso: una fuente instalada con Orchestra abierto no se
//! puede usar hasta cerrarlo del todo (Salir en la bandeja) y abrirlo otra vez. Por eso se apuntan los nombres al arrancar
//! y las que aparezcan después se marcan como `new_since_start`.

use std::collections::HashSet;
use std::sync::OnceLock;

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub name: String,
    /// Instalada después de arrancar Orchestra: el WebView aún no la ve.
    pub new_since_start: bool,
}

static AT_START: OnceLock<HashSet<String>> = OnceLock::new();

/// Al arrancar, en un hilo aparte: los nombres que ve ahora el sistema son los que verá el WebView.
pub fn snapshot_at_start() {
    std::thread::spawn(|| {
        let names = families(false).into_iter().map(|n| n.to_lowercase()).collect();
        let _ = AT_START.set(names);
    });
}

/// Todas las familias instaladas ahora mismo, por orden alfabético y sin repetir. Si es monoespaciada lo mide la página
/// (`IsMonospacedFont` de DirectWrite falla: dice que no a Asterisk Mono y que sí a JetBrainsMono Nerd Font Propo).
pub fn list() -> Vec<FontFamily> {
    mark(families(true), AT_START.get())
}

fn mark(found: Vec<String>, at_start: Option<&HashSet<String>>) -> Vec<FontFamily> {
    let mut out: Vec<FontFamily> = found
        .into_iter()
        .filter(|n| !n.is_empty() && !n.starts_with('@')) // las «@Fuente» son las de texto vertical
        .map(|name| {
            let new_since_start = at_start.is_some_and(|s| !s.contains(&name.to_lowercase()));
            FontFamily { name, new_since_start }
        })
        .collect();
    out.sort_by_key(|f| f.name.to_lowercase());
    out.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
    out
}

#[cfg(windows)]
fn families(check_updates: bool) -> Vec<String> {
    use windows::Win32::Graphics::DirectWrite::*;
    let mut out = Vec::new();
    unsafe {
        let Ok(factory) = DWriteCreateFactory::<IDWriteFactory>(DWRITE_FACTORY_TYPE_SHARED) else { return out };
        let mut coll: Option<IDWriteFontCollection> = None;
        // check_updates: sin esto, el sistema devuelve la lista que tenía en caché este proceso (la del arranque).
        if factory.GetSystemFontCollection(&mut coll, check_updates).is_err() {
            return out;
        }
        let Some(coll) = coll else { return out };
        for i in 0..coll.GetFontFamilyCount() {
            let Ok(fam) = coll.GetFontFamily(i) else { continue };
            let Some(name) = fam.GetFamilyNames().ok().and_then(|n| english_name(&n)) else { continue };
            out.push(name);
        }
    }
    out
}

/// El nombre en inglés (es el que entiende CSS) o, si no hay, el primero.
#[cfg(windows)]
unsafe fn english_name(names: &windows::Win32::Graphics::DirectWrite::IDWriteLocalizedStrings) -> Option<String> {
    unsafe {
        if names.GetCount() == 0 {
            return None;
        }
        let mut idx = 0u32;
        let mut exists = windows_core::BOOL(0);
        let _ = names.FindLocaleName(windows::core::w!("en-us"), &mut idx, &mut exists);
        if !exists.as_bool() {
            idx = 0;
        }
        let len = names.GetStringLength(idx).ok()? as usize;
        let mut buf = vec![0u16; len + 1];
        names.GetString(idx, &mut buf).ok()?;
        Some(String::from_utf16_lossy(&buf[..len]))
    }
}

#[cfg(not(windows))]
fn families(_check_updates: bool) -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_fonts_installed_after_start_sorts_and_dedups() {
        let start: HashSet<String> = ["consolas", "cascadia code"].iter().map(|s| s.to_string()).collect();
        let got = mark(
            ["Consolas", "Asterisk Mono", "@MS Gothic", "cascadia code", "Cascadia Code", ""].iter().map(|s| s.to_string()).collect(),
            Some(&start),
        );
        let names: Vec<_> = got.iter().map(|f| (f.name.as_str(), f.new_since_start)).collect();
        assert_eq!(names, vec![("Asterisk Mono", true), ("cascadia code", false), ("Consolas", false)]);
    }

    #[test]
    fn without_snapshot_nothing_is_new() {
        let got = mark(vec!["Hack".into()], None);
        assert!(!got[0].new_since_start);
    }

    /// Para mirar a mano qué ve DirectWrite: `cargo test --bin orchestra print_installed_fonts -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn print_installed_fonts() {
        for f in list() {
            println!("{}{}", f.name, if f.new_since_start { "  [nueva]" } else { "" });
        }
    }

    /// En Windows siempre están Consolas y Arial.
    #[cfg(windows)]
    #[test]
    fn real_system_fonts() {
        let all = list();
        for n in ["Consolas", "Arial"] {
            assert!(all.iter().any(|f| f.name.eq_ignore_ascii_case(n)), "falta {n}");
        }
    }
}
