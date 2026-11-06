use super::*;
use std::time::Instant;

/// Carpeta temporal propia de cada prueba (se borra al final con `cleanup`).
fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("orch-prov-unit-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn cleanup(d: &Path) {
    let _ = std::fs::remove_dir_all(d);
}

// ---------- parsers ----------

#[test]
fn codex_status_parsing() {
    let s = parse_codex_status(true, "Logged in using ChatGPT\n");
    assert_eq!((s.status, s.method), ("signedIn", Some("chatgpt")));
    let s = parse_codex_status(true, "Logged in using an API key - sk-***abcde");
    assert_eq!((s.status, s.method), ("signedIn", Some("apikey")));
    let s = parse_codex_status(true, "Logged in somehow");
    assert_eq!((s.status, s.method), ("signedIn", Some("other")));
    assert_eq!(parse_codex_status(false, "Not logged in\n").status, "notSignedIn");
    // Un error de configuración no es «sin sesión»: es «no sé».
    assert_eq!(parse_codex_status(false, "Error loading configuration: ...").status, "unknown");
    // Exit 0 con texto desconocido tampoco se da por válido.
    assert_eq!(parse_codex_status(true, "something else").status, "unknown");
    assert_eq!(parse_codex_status(true, "").status, "unknown");
}

#[test]
fn opencode_list_parsing() {
    let s = parse_opencode_list(true, "[]\n");
    assert_eq!((s.status, s.count), ("notSignedIn", Some(0)));
    let s = parse_opencode_list(true, "\n[{\"id\":\"a\"},{\"id\":\"b\"}]\n");
    assert_eq!((s.status, s.count), ("signedIn", Some(2)));
    assert_eq!(parse_opencode_list(true, "No authenticated integrations\n").status, "notSignedIn");
    assert_eq!(parse_opencode_list(false, "[{\"id\":1}]").status, "unknown", "exit != 0 = unknown");
    assert_eq!(parse_opencode_list(true, "{\"a\":1}").status, "unknown", "no es una lista");
    assert_eq!(parse_opencode_list(true, "garbage").status, "unknown");
}

#[test]
fn the_verdict_never_carries_text() {
    // Aunque la salida traiga algo que parezca una clave, el veredicto serializado solo tiene estos campos.
    let secret = "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let s = parse_codex_status(true, &format!("Logged in using an API key - {secret}"));
    let j = serde_json::to_string(&s).unwrap();
    assert!(!j.contains("sk-"), "{j}");
    assert_eq!(j, "{\"status\":\"signedIn\",\"method\":\"apikey\"}");
    let s = parse_opencode_list(true, &format!("[{{\"key\":\"{secret}\"}}]"));
    let j = serde_json::to_string(&s).unwrap();
    assert!(!j.contains("sk-"), "{j}");
    assert_eq!(j, "{\"status\":\"signedIn\",\"count\":1}");
}

// ---------- carpetas ----------

#[test]
fn account_dir_validation() {
    let home = tmp("home-v");
    let ok = |prov: &str, name: &str| valid_account_dir(prov, home.join(name).to_str().unwrap(), &home);
    assert!(ok("codex", ".codex-work").is_ok());
    assert!(ok("opencode", ".opencode-work.2_b").is_ok());
    // Prefijo equivocado, el de siempre, vacío, o de otro proveedor.
    assert!(ok("codex", ".codex").is_err());
    assert!(ok("codex", ".codex-").is_err());
    assert!(ok("codex", ".opencode-work").is_err());
    assert!(ok("opencode", ".codex-work").is_err());
    assert!(ok("codex", ".claude-work").is_err());
    assert!(ok("codex", ".codex-a b").is_err());
    assert!(ok("codex", ".codex-a&b").is_err());
    assert!(ok("claude", ".claude-x").is_err(), "proveedor no soportado aquí");
    // Fuera de la carpeta de usuario, relativa, con `..`.
    let other = tmp("other-v");
    assert!(valid_account_dir("codex", other.join(".codex-x").to_str().unwrap(), &home).is_err());
    assert!(valid_account_dir("codex", ".codex-x", &home).is_err());
    let tricky = format!("{}\\sub\\..\\.codex-x", home.display());
    assert!(valid_account_dir("codex", &tricky, &home).is_err());
    let nested = home.join("sub").join(".codex-x");
    assert!(valid_account_dir("codex", nested.to_str().unwrap(), &home).is_err());
    cleanup(&home);
    cleanup(&other);
}

#[test]
fn codex_prepare_writes_config_only_into_a_new_or_empty_folder() {
    let home = tmp("home-c");
    let new = home.join(".codex-new");
    let r = prepare_in("codex", new.to_str().unwrap(), &home).unwrap();
    assert_eq!(r, ProviderPrepared { created: true, wrote_config: true });
    assert_eq!(std::fs::read_to_string(new.join("config.toml")).unwrap(), "cli_auth_credentials_store = \"file\"\n");

    // Vacía y ya existente: también se escribe.
    let empty = home.join(".codex-empty");
    std::fs::create_dir_all(&empty).unwrap();
    let r = prepare_in("codex", empty.to_str().unwrap(), &home).unwrap();
    assert_eq!(r, ProviderPrepared { created: false, wrote_config: true });

    // Con contenido: no se toca NADA (ni se crea config.toml).
    let used = home.join(".codex-used");
    std::fs::create_dir_all(&used).unwrap();
    std::fs::write(used.join("history.jsonl"), "x").unwrap();
    let r = prepare_in("codex", used.to_str().unwrap(), &home).unwrap();
    assert_eq!(r, ProviderPrepared { created: false, wrote_config: false });
    assert!(!used.join("config.toml").exists());

    // Con config.toml propio: se respeta.
    let own = home.join(".codex-own");
    std::fs::create_dir_all(&own).unwrap();
    std::fs::write(own.join("config.toml"), "model = \"x\"\n").unwrap();
    prepare_in("codex", own.to_str().unwrap(), &home).unwrap();
    assert_eq!(std::fs::read_to_string(own.join("config.toml")).unwrap(), "model = \"x\"\n");

    // Rechaza carpetas que no son de cuenta y no crea nada fuera.
    assert!(prepare_in("codex", home.join(".codex").to_str().unwrap(), &home).is_err());
    assert!(!home.join(".codex").exists());
    cleanup(&home);
}

#[test]
fn opencode_prepare_makes_data_and_state() {
    let home = tmp("home-o");
    let d = home.join(".opencode-work");
    let r = prepare_in("opencode", d.to_str().unwrap(), &home).unwrap();
    assert_eq!(r, ProviderPrepared { created: true, wrote_config: false });
    assert!(d.join("data").is_dir() && d.join("state").is_dir());
    assert!(!d.join("config.toml").exists());
    cleanup(&home);
}

// ---------- detección ----------

#[test]
fn detection_uses_only_existence() {
    let home = tmp("home-d");
    let bin = tmp("bin-d");
    let path = std::env::join_paths([bin.as_path()]).unwrap();
    let d = detect_in(Some(&home), Some(&path));
    assert!(!d.codex_installed && !d.opencode_installed && d.codex_dir.is_none() && d.opencode_dir.is_none());
    std::fs::write(bin.join("codex.exe"), "").unwrap();
    std::fs::write(bin.join("opencode.cmd"), "").unwrap();
    std::fs::create_dir_all(home.join(".codex")).unwrap();
    std::fs::create_dir_all(home.join(".local").join("share").join("opencode")).unwrap();
    let d = detect_in(Some(&home), Some(&path));
    assert!(d.codex_installed && d.opencode_installed);
    assert!(d.codex_dir.is_some() && d.opencode_dir.is_some());
    assert!(!detect_in(Some(&home), None).codex_installed);
    cleanup(&home);
    cleanup(&bin);
}

// ---------- entorno por proveedor y ejecución ----------

#[test]
fn status_command_env_per_provider() {
    let home = tmp("home-e");
    let c = home.join(".codex-a");
    let (p, a, env) = status_command("codex", c.to_str().unwrap(), false, &home).unwrap();
    assert_eq!((p, a), ("codex", vec!["login", "status"]));
    assert_eq!(env, vec![("CODEX_HOME".to_string(), c.to_string_lossy().into_owned())]);
    // La Default no lleva variable ni valida la ruta.
    let (_, _, env) = status_command("codex", "", true, &home).unwrap();
    assert!(env.is_empty());

    let o = home.join(".opencode-a");
    let (p, a, env) = status_command("opencode", o.to_str().unwrap(), false, &home).unwrap();
    assert_eq!(p, "opencode");
    assert!(a.contains(&"--standalone") && a.contains(&"json"), "{a:?}");
    let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, ["XDG_DATA_HOME", "XDG_STATE_HOME"]);
    assert!(env[0].1.ends_with("data") && env[1].1.ends_with("state"));
    let (_, a, env) = status_command("opencode", "", true, &home).unwrap();
    assert!(env.is_empty() && !a.contains(&"--standalone"), "la Default usa el servicio de siempre");
    assert!(status_command("opencode", "C:\\Windows", false, &home).is_err());
    cleanup(&home);
}

#[test]
fn run_capture_passes_env_and_enforces_the_timeout() {
    let (ok, text) = run_capture("echo", &["%ORCH_PROV_T%"], &[("ORCH_PROV_T".into(), "hello-env".into())], Duration::from_secs(10)).unwrap();
    assert!(ok && text.contains("hello-env"), "{text:?}");

    let t0 = Instant::now();
    let r = run_capture("ping", &["-n", "20", "127.0.0.1"], &[], Duration::from_millis(400));
    assert!(r.is_none(), "debe vencer el tiempo");
    assert!(t0.elapsed() < Duration::from_secs(5), "tardó {:?}", t0.elapsed());
}

#[test]
fn run_capture_caps_the_output() {
    let d = tmp("cap");
    let f = d.join("big.txt");
    std::fs::write(&f, "a".repeat(300 * 1024)).unwrap();
    let (_, text) = run_capture("type", &[f.to_str().unwrap()], &[], Duration::from_secs(10)).unwrap();
    assert!(text.len() <= (OUTPUT_CAP as usize) + 8, "len {}", text.len()); // stderr vacío
    assert!(text.len() > 1000);
    cleanup(&d);
}

/// Un `codex.cmd` y un `opencode.cmd` falsos en el PATH del hijo, para recorrer `check_status` entero:
/// solo dicen «con sesión» si ven el entorno que esa cuenta debe llevar.
#[test]
fn check_status_end_to_end_with_fake_binaries() {
    let home = tmp("home-f");
    let bin = tmp("bin-f");
    std::fs::write(
        bin.join("codex.cmd"),
        "@echo off\r\nif \"%CODEX_HOME%\"==\"%ORCH_EXPECT_HOME%\" goto yes\r\necho Not logged in\r\nexit /b 1\r\n:yes\r\necho Logged in using ChatGPT\r\nexit /b 0\r\n",
    )
    .unwrap();
    std::fs::write(
        bin.join("opencode.cmd"),
        "@echo off\r\necho %* | findstr /C:\"--standalone\" >nul\r\nif errorlevel 1 goto plain\r\necho [{\"id\":\"a\"}]\r\nexit /b 0\r\n:plain\r\necho []\r\nexit /b 0\r\n",
    )
    .unwrap();

    let acc = home.join(".codex-w");
    let (prog, args, mut env) = status_command("codex", acc.to_str().unwrap(), false, &home).unwrap();
    let path = format!("{};{}", bin.display(), std::env::var("PATH").unwrap_or_default());
    env.push(("PATH".into(), path.clone()));
    env.push(("ORCH_EXPECT_HOME".into(), acc.to_string_lossy().into_owned()));
    let (ok, text) = run_capture(prog, &args, &env, Duration::from_secs(10)).unwrap();
    assert_eq!(parse_codex_status(ok, &text).status, "signedIn", "{text:?}");
    // Otra carpeta = otra sesión: el mismo binario falso contesta «no».
    env.retain(|(k, _)| k != "CODEX_HOME");
    env.push(("CODEX_HOME".into(), home.join(".codex-other").to_string_lossy().into_owned()));
    let (ok, text) = run_capture(prog, &args, &env, Duration::from_secs(10)).unwrap();
    assert_eq!(parse_codex_status(ok, &text).status, "notSignedIn", "{text:?}");

    let oc = home.join(".opencode-w");
    let (prog, args, mut env) = status_command("opencode", oc.to_str().unwrap(), false, &home).unwrap();
    env.push(("PATH".into(), path.clone()));
    let (ok, text) = run_capture(prog, &args, &env, Duration::from_secs(10)).unwrap();
    let s = parse_opencode_list(ok, &text);
    assert_eq!((s.status, s.count), ("signedIn", Some(1)), "{text:?}");
    // Sin --standalone (cuenta Default) el falso contesta lista vacía: demuestra que el flag viaja.
    let (prog, args, mut env) = status_command("opencode", "", true, &home).unwrap();
    env.push(("PATH".into(), path));
    let (ok, text) = run_capture(prog, &args, &env, Duration::from_secs(10)).unwrap();
    assert_eq!(parse_opencode_list(ok, &text).status, "notSignedIn", "{text:?}");
    cleanup(&home);
    cleanup(&bin);
}

// ---------- el módulo no lee secretos ----------

#[test]
fn the_module_never_touches_credential_files() {
    // Todo el fichero salvo la declaración `mod tests;` (las pruebas viven en otro fichero).
    let src = include_str!("../providers.rs");
    let prod = src.replace("#[cfg(test)]
mod tests;", "").replace("#[cfg(test)]
mod tests;", "");
    assert!(prod.len() > 5000, "the scan must cover the whole production code");
    for bad in ["auth.json", "read_to_string", "File::open", "println!", "eprintln!", "dbg!", "keyring"] {
        assert!(!prod.contains(bad), "providers.rs no debe contener `{bad}`");
    }
    // Nada de escribir en carpetas reales de los proveedores: las únicas rutas escritas salen de `valid_account_dir`.
    for bad in ["\".config\"", "\".claude\"", "\".local\"/", "XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR"] {
        assert!(!prod.contains(bad), "providers.rs no debe tocar `{bad}`");
    }
}
