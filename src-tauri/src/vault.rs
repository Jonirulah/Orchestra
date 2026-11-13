//! Bóveda de secretos (Administrador de credenciales de Windows) y gestor de claves SSH.
//!
//! Reglas de seguridad:
//! - Ningún comando devuelve un secreto a la interfaz: solo escribir, preguntar si existe y borrar.
//! - El secreto solo sale de la bóveda por `run_askpass` (stdout hacia el `ssh` que lo pidió).
//! - Las variables de entorno llevan el NOMBRE de la clave, nunca el valor.
//! - Nada de esto escribe secretos en logs ni en mensajes de error.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

pub const SERVICE: &str = "dev.orchestra.app";
/// Variable con el nombre de la clave de la bóveda que debe devolver el askpass.
pub const ENV_KEY: &str = "ORCHESTRA_ASKPASS_KEY";
/// Marca que identifica a nuestro exe actuando como askpass (ssh lo invoca solo con el prompt).
pub const ENV_MODE: &str = "ORCHESTRA_ASKPASS_MODE";

const MAX_SECRET_CHARS: usize = 1000; // el blob de una credencial de Windows admite 2560 bytes (UTF-16)

// ---------- bóveda ----------

fn valid_key(key: &str) -> Result<(), String> {
    let ok = !key.is_empty()
        && key.len() <= 160
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '_' | '-' | '@'));
    if ok {
        Ok(())
    } else {
        Err("Invalid secret name".into())
    }
}

fn entry(key: &str) -> Result<keyring::Entry, String> {
    valid_key(key)?;
    keyring::Entry::new(SERVICE, key).map_err(|e| format!("Credential store unavailable: {e}"))
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("The secret is empty".into());
    }
    if value.chars().count() > MAX_SECRET_CHARS {
        return Err("The secret is too long".into());
    }
    entry(key)?
        .set_password(value)
        .map_err(|e| format!("Could not save to Windows Credential Manager: {e}"))
}

/// Solo para el askpass y para pruebas: la interfaz no tiene comando que llame a esto.
pub(crate) fn get(key: &str) -> Option<String> {
    entry(key).ok()?.get_password().ok()
}

pub fn exists(key: &str) -> bool {
    get(key).is_some()
}

pub fn delete(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not delete from Windows Credential Manager: {e}")),
    }
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    set(&key, &value)
}

#[tauri::command]
pub fn secret_exists(key: String) -> bool {
    valid_key(&key).is_ok() && exists(&key)
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    delete(&key)
}

/// Copia un secreto de una clave a otra sin pasar por la interfaz.
#[tauri::command]
pub fn secret_copy(from: String, to: String) -> Result<(), String> {
    valid_key(&to)?;
    let v = get(&from).ok_or("There is no saved secret to copy")?;
    set(&to, &v)
}

// ---------- askpass ----------

/// ¿Debe el askpass contestar a este prompt con el secreto de `key`? Solo contesta a lo que
/// corresponde al tipo de secreto: nunca a «yes/no» de huella ni a códigos de 2 factores.
pub fn prompt_matches(prompt: &str, key: &str) -> bool {
    let p = prompt.to_ascii_lowercase();
    if p.contains("yes/no") || p.contains("fingerprint") || p.contains("[y/n]") {
        return false;
    }
    if key.ends_with(":password") {
        p.is_empty() || p.contains("password")
    } else if key.ends_with(":passphrase") {
        p.is_empty() || p.contains("passphrase")
    } else {
        false
    }
}

/// ¿Esta invocación es de ssh usando nuestro exe como SSH_ASKPASS?
pub fn is_askpass_invocation(args: &[String]) -> bool {
    args.get(1).map(String::as_str) == Some("--askpass")
        || (args.len() == 2 && std::env::var_os(ENV_MODE).is_some_and(|v| v == "1"))
}

/// Cuerpo del askpass: imprime el secreto por stdout y devuelve el código de salida.
/// Sin ventana, sin registros. Código 1 si no hay clave, no hay secreto o el prompt no encaja.
pub fn run_askpass(args: &[String]) -> i32 {
    use std::io::Write;
    let prompt = if args.get(1).map(String::as_str) == Some("--askpass") {
        args.get(2)
    } else {
        args.get(1)
    }
    .map(String::as_str)
    .unwrap_or("");
    let Ok(key) = std::env::var(ENV_KEY) else {
        return 1;
    };
    if !prompt_matches(prompt, &key) {
        return 1;
    }
    let Some(secret) = get(&key) else {
        return 1;
    };
    let mut out = std::io::stdout().lock();
    if out.write_all(secret.as_bytes()).and_then(|_| out.write_all(b"\n")).and_then(|_| out.flush()).is_err() {
        return 1;
    }
    0
}

/// Variables de entorno para que un `ssh`/`ssh-keygen` hijo use este exe como askpass.
pub fn askpass_env(key: &str) -> Vec<(String, String)> {
    let exe = std::env::current_exe().unwrap_or_default();
    askpass_env_with(&exe, key)
}

/// Igual, con el exe explícito (las pruebas unitarias no corren dentro del exe real).
pub fn askpass_env_with(exe: &Path, key: &str) -> Vec<(String, String)> {
    let exe = exe.to_string_lossy().into_owned();
    vec![
        ("SSH_ASKPASS".into(), exe),
        ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
        (ENV_MODE.into(), "1".into()),
        (ENV_KEY.into(), key.into()),
    ]
}

// ---------- gestor de claves SSH ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    /// Nombre base del archivo (sin `.pub`).
    pub name: String,
    pub pub_path: String,
    pub private_path: Option<String>,
    pub has_private: bool,
    pub key_type: String,
    pub bits: Option<u32>,
    pub fingerprint: String,
    pub comment: String,
    /// Clave PÚBLICA (se puede copiar y mostrar sin riesgo).
    pub public_key: String,
    /// ¿Hay una passphrase guardada en la bóveda para esta clave?
    pub has_saved_passphrase: bool,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(Into::into)
}

pub(crate) fn ssh_dir() -> Result<PathBuf, String> {
    home().map(|h| h.join(".ssh")).ok_or_else(|| "Cannot locate the user folder".to_string())
}

/// Nombre de archivo de clave: letras, números, `.`, `_` y `-`; sin rutas.
pub fn valid_key_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && !name.ends_with(".pub")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(())
    } else {
        Err("Key name: only letters, numbers, . _ - (max 64), not starting with a dot".into())
    }
}

#[cfg(windows)]
fn quiet(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000) // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn quiet(cmd: &mut Command) -> &mut Command {
    cmd
}

pub(crate) fn friendly_type(t: &str) -> String {
    match t {
        "ssh-ed25519" => "ED25519".into(),
        "ssh-rsa" => "RSA".into(),
        "ssh-dss" => "DSA".into(),
        s if s.starts_with("ecdsa-sha2-") => "ECDSA".into(),
        s if s.starts_with("sk-ssh-ed25519") => "ED25519-SK".into(),
        s if s.starts_with("sk-ecdsa") => "ECDSA-SK".into(),
        s => s.to_string(),
    }
}

/// Salida de `ssh-keygen -lf`: «256 SHA256:abc... comentario (ED25519)».
fn parse_lf(line: &str) -> (Option<u32>, String) {
    let mut it = line.split_whitespace();
    let bits = it.next().and_then(|b| b.parse().ok());
    let fp = it.next().unwrap_or("").to_string();
    (bits, fp)
}

fn describe(pub_path: &Path, dir: &Path) -> Option<SshKeyInfo> {
    let file = pub_path.file_name()?.to_str()?;
    let name = file.strip_suffix(".pub")?.to_string();
    let text = std::fs::read_to_string(pub_path).ok()?;
    let line = text.lines().find(|l| !l.trim().is_empty())?.trim().to_string();
    let mut f = line.splitn(3, char::is_whitespace);
    let ktype = f.next().unwrap_or("").to_string();
    let _blob = f.next()?;
    let comment = f.next().unwrap_or("").trim().to_string();
    let priv_path = dir.join(&name);
    let has_private = priv_path.is_file();
    let mut c = Command::new("ssh-keygen");
    c.arg("-l").arg("-f").arg(pub_path);
    quiet(&mut c);
    let (bits, fingerprint) = match c.output() {
        Ok(o) if o.status.success() => parse_lf(String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("")),
        _ => (None, String::new()),
    };
    let has_saved_passphrase = valid_key_name(&name).is_ok() && exists(&format!("key:{name}:passphrase"));
    Some(SshKeyInfo {
        name,
        pub_path: pub_path.to_string_lossy().into_owned(),
        private_path: has_private.then(|| priv_path.to_string_lossy().into_owned()),
        has_private,
        key_type: friendly_type(&ktype),
        bits,
        fingerprint,
        comment,
        public_key: line,
        has_saved_passphrase,
    })
}

/// Lista las claves `*.pub` de una carpeta (nunca lee los archivos privados, solo comprueba que existen).
pub fn list_in(dir: &Path) -> Vec<SshKeyInfo> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut v: Vec<SshKeyInfo> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "pub") && p.is_file())
        .filter_map(|p| describe(&p, dir))
        .collect();
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    v
}

/// Genera una clave ed25519 en `dir`. No sobrescribe nada. La passphrase NO va por la línea
/// de comandos: se guarda en una entrada temporal de la bóveda y `ssh-keygen` la pide por
/// SSH_ASKPASS (este mismo exe), así que no aparece en la lista de procesos.
pub fn generate_in(dir: &Path, name: &str, comment: &str, passphrase: Option<&str>) -> Result<SshKeyInfo, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    generate_with(&exe, dir, name, comment, passphrase)
}

pub fn generate_with(
    askpass_exe: &Path,
    dir: &Path,
    name: &str,
    comment: &str,
    passphrase: Option<&str>,
) -> Result<SshKeyInfo, String> {
    valid_key_name(name)?;
    if comment.len() > 120 || comment.chars().any(|c| c.is_control()) {
        return Err("Comment: max 120 characters, no control characters".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create the key folder: {e}"))?;
    let priv_path = dir.join(name);
    let pub_path = dir.join(format!("{name}.pub"));
    if priv_path.exists() || pub_path.exists() {
        return Err(format!("A key named «{name}» already exists; pick another name"));
    }
    let pass = passphrase.filter(|p| !p.is_empty());
    let mut cmd = Command::new("ssh-keygen");
    cmd.args(["-q", "-t", "ed25519", "-C", comment, "-f"]).arg(&priv_path);
    let tmp_key = pass.map(|_| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("tmp:keygen-{}-{nanos}:passphrase", std::process::id())
    });
    match (&tmp_key, pass) {
        (Some(k), Some(p)) => {
            set(k, p)?;
            for (a, b) in askpass_env_with(askpass_exe, k) {
                cmd.env(a, b);
            }
            // El askpass de ssh-keygen se usa porque no hay terminal: stdin nulo.
            cmd.stdin(std::process::Stdio::null());
        }
        _ => {
            cmd.args(["-N", ""]);
        }
    }
    quiet(&mut cmd);
    let out = cmd.output();
    if let Some(k) = &tmp_key {
        let _ = delete(k);
    }
    let out = out.map_err(|e| format!("Could not run ssh-keygen: {e}"))?;
    if !out.status.success() || !pub_path.is_file() {
        let _ = std::fs::remove_file(&priv_path);
        let _ = std::fs::remove_file(&pub_path);
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ssh-keygen failed: {}", err.lines().next().unwrap_or("unknown error")));
    }
    describe(&pub_path, dir).ok_or_else(|| "The key was created but could not be read".to_string())
}

#[tauri::command]
pub async fn ssh_keys_list() -> Result<Vec<SshKeyInfo>, String> {
    let dir = ssh_dir()?;
    tauri::async_runtime::spawn_blocking(move || list_in(&dir))
        .await
        .map_err(|e| e.to_string())
}

/// `save_passphrase`: guarda la passphrase en la bóveda como `key:<nombre>:passphrase`.
#[tauri::command]
pub async fn ssh_keygen(
    name: String,
    comment: String,
    passphrase: Option<String>,
    save_passphrase: bool,
) -> Result<SshKeyInfo, String> {
    let dir = ssh_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        let info = generate_in(&dir, &name, &comment, passphrase.as_deref())?;
        if save_passphrase {
            if let Some(p) = passphrase.as_deref().filter(|p| !p.is_empty()) {
                set(&format!("key:{name}:passphrase"), p)?;
            }
        }
        describe(Path::new(&info.pub_path), &dir).ok_or_else(|| "Could not read the new key".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Abre el Explorador con la clave seleccionada (sin shell).
#[tauri::command]
pub fn ssh_key_reveal(name: String) -> Result<(), String> {
    valid_key_name(&name)?;
    let dir = ssh_dir()?;
    let pub_path = dir.join(format!("{name}.pub"));
    let target = if pub_path.is_file() { pub_path } else { dir.join(&name) };
    if !target.exists() {
        return Err("That key file does not exist".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // El nombre ya está validado (sin comillas ni separadores); la ruta es de ~/.ssh.
        let arg = format!("/select,\"{}\"", target.to_string_lossy());
        Command::new("explorer.exe").raw_arg(arg).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        Command::new("xdg-open").arg(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Borra la passphrase guardada de una clave del gestor.
#[tauri::command]
pub fn ssh_key_forget_passphrase(name: String) -> Result<(), String> {
    valid_key_name(&name)?;
    delete(&format!("key:{name}:passphrase"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> String {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        format!("test:vault-{tag}-{}-{n}:password", std::process::id())
    }

    #[test]
    fn ida_y_vuelta_en_el_administrador_de_credenciales() {
        let k = scratch("rt");
        assert!(!exists(&k));
        set(&k, "p@ss wörd ñ 123").unwrap();
        assert!(exists(&k));
        assert_eq!(get(&k).as_deref(), Some("p@ss wörd ñ 123"));
        set(&k, "otra").unwrap(); // sobrescribir
        assert_eq!(get(&k).as_deref(), Some("otra"));
        delete(&k).unwrap();
        assert!(!exists(&k));
        delete(&k).unwrap(); // borrar dos veces no falla
    }

    #[test]
    fn rechaza_nombres_y_valores_malos() {
        assert!(set("", "x").is_err());
        assert!(set("a b", "x").is_err());
        assert!(set("../x", "x").is_err());
        assert!(set("test:vacio", "").is_err());
        assert!(set("test:largo", &"x".repeat(MAX_SECRET_CHARS + 1)).is_err());
        assert!(!secret_exists("con espacio".into()));
    }

    #[test]
    fn copiar_secreto() {
        let a = scratch("ca");
        let b = scratch("cb");
        set(&a, "valor").unwrap();
        secret_copy(a.clone(), b.clone()).unwrap();
        assert_eq!(get(&b).as_deref(), Some("valor"));
        delete(&a).unwrap();
        delete(&b).unwrap();
        assert!(secret_copy(a, b).is_err());
    }

    #[test]
    fn el_askpass_solo_contesta_a_lo_suyo() {
        let pw = "host:h1:password";
        let pp = "host:h1:passphrase";
        assert!(prompt_matches("user@10.0.0.1's password: ", pw));
        assert!(prompt_matches("Password:", pw));
        assert!(!prompt_matches("Enter passphrase for key 'x': ", pw));
        assert!(prompt_matches("Enter passphrase for key 'x': ", pp));
        assert!(prompt_matches("Enter same passphrase again: ", pp));
        assert!(!prompt_matches("user@h's password: ", pp));
        // Preguntas de huella y 2FA nunca reciben el secreto.
        assert!(!prompt_matches("Are you sure you want to continue connecting (yes/no/[fingerprint])? ", pw));
        assert!(!prompt_matches("Verification code: ", pw));
        assert!(!prompt_matches("password", "key:x:otra"));
    }

    #[test]
    fn detecta_la_invocacion_askpass() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_askpass_invocation(&a(&["orchestra", "--askpass"])));
        assert!(is_askpass_invocation(&a(&["orchestra", "--askpass", "pw: "])));
        assert!(!is_askpass_invocation(&a(&["orchestra"])));
    }

    #[test]
    fn nombres_de_clave() {
        for ok in ["id_ed25519", "work-2025", "a.b_c"] {
            assert!(valid_key_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", ".x", "a/b", "a\\b", "a b", "x.pub", "..", "a:b", &"x".repeat(65)] {
            assert!(valid_key_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn parsea_ssh_keygen_lf() {
        let (b, f) = parse_lf("256 SHA256:AbC/123+x me@pc (ED25519)");
        assert_eq!(b, Some(256));
        assert_eq!(f, "SHA256:AbC/123+x");
        assert_eq!(friendly_type("ssh-rsa"), "RSA");
        assert_eq!(friendly_type("ecdsa-sha2-nistp256"), "ECDSA");
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("orch-keys-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// El exe real (el de pruebas no sabe hacer de askpass). `cargo test` lo compila por los tests/.
    fn bin() -> PathBuf {
        // Se busca hacia arriba desde el exe de pruebas: hasta Rust 1.99 vivía en target/debug/deps; desde la 1.100, más abajo
        // (target/debug/build/orchestra/<hash>/…). El exe real sigue en target/debug.
        let me = std::env::current_exe().unwrap();
        let p = me.ancestors().skip(1).map(|d| d.join("orchestra.exe")).find(|p| p.is_file());
        p.unwrap_or_else(|| panic!("falta orchestra.exe encima de {me:?}: ejecuta `cargo test` completo (compila el exe real)"))
    }

    #[test]
    fn genera_y_lista_claves_en_carpeta_temporal() {
        let d = tmp_dir("gen");
        // Sin passphrase.
        let k = generate_with(&bin(), &d, "prueba_a", "orchestra-test", None).unwrap();
        assert_eq!(k.name, "prueba_a");
        assert_eq!(k.key_type, "ED25519");
        assert_eq!(k.bits, Some(256));
        assert!(k.fingerprint.starts_with("SHA256:"), "{}", k.fingerprint);
        assert_eq!(k.comment, "orchestra-test");
        assert!(k.has_private);
        assert!(k.public_key.starts_with("ssh-ed25519 "));
        // No sobrescribe.
        let e = generate_with(&bin(), &d, "prueba_a", "x", None).unwrap_err();
        assert!(e.contains("already exists"), "{e}");
        // Nombres peligrosos.
        assert!(generate_with(&bin(), &d, "../fuera", "x", None).is_err());
        assert!(!d.parent().unwrap().join("fuera").exists());
        // Con passphrase: la clave privada queda cifrada (sin la passphrase no se puede leer).
        let k2 = generate_with(&bin(), &d, "prueba_b", "con-pass", Some("s3cr3t-pass")).unwrap();
        assert_eq!(k2.comment, "con-pass");
        let priv_b = d.join("prueba_b");
        let bad = Command::new("ssh-keygen").args(["-y", "-P", "mala", "-f"]).arg(&priv_b).output().unwrap();
        assert!(!bad.status.success(), "la clave no está cifrada");
        let good = Command::new("ssh-keygen").args(["-y", "-P", "s3cr3t-pass", "-f"]).arg(&priv_b).output().unwrap();
        assert!(good.status.success(), "no abre con la passphrase correcta: {}", String::from_utf8_lossy(&good.stderr));
        // Listado: ordenado y con los dos pares; un .pub sin privada se marca.
        std::fs::remove_file(d.join("prueba_a")).unwrap();
        let l = list_in(&d);
        assert_eq!(l.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["prueba_a", "prueba_b"]);
        assert!(!l[0].has_private && l[0].private_path.is_none());
        assert!(l[1].has_private);
        // Un .pub corrupto se ignora.
        std::fs::write(d.join("roto.pub"), "basura").unwrap();
        assert_eq!(list_in(&d).len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// «Install on server»: ejecuta el panel que genera sshInstallKeySpec (JSON en
    /// ORCHESTRA_E2E_INSTALL = ruta al archivo; contraseña en ORCHESTRA_E2E_PW) con askpass.
    /// La comprobación del authorized_keys remoto la hace quien lanza la prueba.
    #[test]
    #[ignore]
    fn ssh_e2e_instalar_clave() {
        use crate::pty::{spawn, Sink, SpawnSpec};
        use std::collections::HashMap;
        use std::sync::{mpsc, Arc};
        use std::time::Duration;
        struct Collect(parking_lot::Mutex<Vec<u8>>);
        impl Sink for Collect {
            fn data(&self, b: Vec<u8>) {
                self.0.lock().extend(b);
            }
        }
        let spec: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(std::env::var("ORCHESTRA_E2E_INSTALL").unwrap()).unwrap()).unwrap();
        let pw = std::env::var("ORCHESTRA_E2E_PW").unwrap();
        let key = spec["env"]["ORCHESTRA_ASKPASS_KEY"].as_str().unwrap().to_string();
        set(&key, &pw).unwrap();
        let mut env: HashMap<String, String> = askpass_env_with(&bin(), &key).into_iter().collect();
        env.insert("ORCHESTRA_ASKPASS_KEY".into(), key.clone());
        let args: Vec<String> = spec["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .filter(|a| a != "-NoExit")
            .collect();
        let (tx, rx) = mpsc::channel();
        let s = spawn(
            SpawnSpec { id: "e2e-inst".into(), program: "powershell.exe".into(), args, cwd: None, env, cols: 120, rows: 30 },
            Box::new(move |_id, code| {
                let _ = tx.send(code);
            }),
        )
        .unwrap();
        let sink = Arc::new(Collect(parking_lot::Mutex::new(vec![])));
        s.attach(sink.clone());
        let t0 = std::time::Instant::now();
        let mut answered = 0;
        let code = loop {
            let seen = String::from_utf8_lossy(&sink.0.lock()).matches("[6n").count();
            while answered < seen {
                let _ = s.write(b"\x1b[1;1R");
                answered += 1;
            }
            if t0.elapsed() > Duration::from_secs(40) {
                s.kill();
                let _ = delete(&key);
                panic!("no terminó: {:?}", String::from_utf8_lossy(&sink.0.lock()));
            }
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(c) => break c,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(e) => panic!("{e}"),
            }
        };
        std::thread::sleep(Duration::from_millis(300));
        let _ = delete(&key);
        let out = String::from_utf8_lossy(&sink.0.lock()).into_owned();
        println!("--- salida ---\n{out}");
        assert_eq!(code, 0);
        assert!(out.contains("Key installed."), "{out}");
        assert!(!out.contains(&pw));
    }

    /// Cierto de punta a punta: login SSH por contraseña a un sshd local, dentro de un ConPTY real
    /// y con el exe de Orchestra como SSH_ASKPASS (copiado a una ruta CON ESPACIOS).
    /// `cargo test -- --ignored ssh_e2e` con ORCHESTRA_E2E_SSH=puerto:usuario:contraseña
    /// (y opcionalmente ORCHESTRA_E2E_SSHBIN=ruta de un ssh concreto).
    #[test]
    #[ignore]
    fn ssh_e2e_login_por_contrasena_con_askpass() {
        use crate::pty::{spawn, Sink, SpawnSpec};
        use std::collections::HashMap;
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        struct Collect(parking_lot::Mutex<Vec<u8>>);
        impl Sink for Collect {
            fn data(&self, b: Vec<u8>) {
                self.0.lock().extend(b);
            }
        }
        let cfg = std::env::var("ORCHESTRA_E2E_SSH").expect("falta ORCHESTRA_E2E_SSH=puerto:usuario:contraseña");
        let mut it = cfg.splitn(3, ':');
        let (port, user, good_pw) = (it.next().unwrap(), it.next().unwrap(), it.next().unwrap());
        let ssh = std::env::var("ORCHESTRA_E2E_SSHBIN").unwrap_or_else(|_| "ssh".into());

        // Exe real en una carpeta con espacios.
        let dir = tmp_dir("e2e").join("carpeta con espacios");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("orchestra.exe");
        std::fs::copy(bin(), &exe).unwrap();
        // (ssh parte `-o Clave=valor` por espacios: known_hosts va en una ruta sin ellos.)
        let known = dir.parent().unwrap().join("known_hosts");

        let run = |pw: &str, tag: &str| -> (i32, String) {
            // Con ORCHESTRA_E2E_KEY=ruta de una clave privada con passphrase: login por clave y la
            // «contraseña» es la passphrase (el askpass contesta al prompt «Enter passphrase for key»).
            let keyfile = std::env::var("ORCHESTRA_E2E_KEY").ok();
            let kind = if keyfile.is_some() { "passphrase" } else { "password" };
            let key = format!("test:e2e-{tag}-{}:{kind}", std::process::id());
            set(&key, pw).unwrap();
            let env: HashMap<String, String> = askpass_env_with(&exe, &key).into_iter().collect();
            // Las mismas opciones que genera sshArgs() para un host con contraseña guardada.
            let dbg = std::env::var("ORCHESTRA_E2E_DEBUG").map(|_| "-vv").unwrap_or("-oLogLevel=INFO");
            let id_args: Vec<&str> = match &keyfile {
                Some(f) => vec!["-i", f.as_str(), "-o", "IdentitiesOnly=yes", "-o", "PreferredAuthentications=publickey"],
                None => vec![],
            };
            let args: Vec<String> = id_args
                .into_iter()
                .chain([
                dbg, "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4", "-p", port,
                "-o", "NumberOfPasswordPrompts=1", "-o", "StrictHostKeyChecking=accept-new",
                "-o", &format!("UserKnownHostsFile={}", known.display()),
                "-t", &format!("{user}@127.0.0.1"), "echo LOGIN_OK_$(id -un)",
            ])
            .into_iter()
            .map(|s| s.to_string())
            .collect();
            let (tx, rx) = mpsc::channel();
            let s = spawn(
                SpawnSpec { id: format!("e2e-{tag}"), program: ssh.clone(), args, cwd: None, env, cols: 100, rows: 30 },
                Box::new(move |_id, code| {
                    let _ = tx.send(code);
                }),
            )
            .unwrap();
            let sink = Arc::new(Collect(parking_lot::Mutex::new(vec![])));
            s.attach(sink.clone());
            let t0 = std::time::Instant::now();
            let mut answered = 0;
            let code = loop {
                // ConPTY pregunta la posición del cursor: se contesta como lo haría xterm.
                let seen = String::from_utf8_lossy(&sink.0.lock()).matches("[6n").count();
                while answered < seen {
                    let _ = s.write(b"\x1b[1;1R");
                    answered += 1;
                }
                if t0.elapsed() > Duration::from_secs(40) {
                    s.kill();
                    let out = String::from_utf8_lossy(&sink.0.lock()).into_owned();
                    panic!("ssh no terminó en 40 s; salida: {out:?}");
                }
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(c) => break c,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(e) => panic!("{e}"),
                }
            };
            std::thread::sleep(Duration::from_millis(300));
            let _ = delete(&key);
            let out = String::from_utf8_lossy(&sink.0.lock()).into_owned();
            (code, out)
        };

        let (code, out) = run(good_pw, "ok");
        println!("--- salida con la contraseña buena ---\n{out}");
        assert_eq!(code, 0, "ssh no terminó bien");
        assert!(out.contains("LOGIN_OK_") && out.contains(user), "no hubo login: {out}");
        assert!(!out.contains(good_pw), "la contraseña salió en pantalla");
        assert!(!out.to_lowercase().contains("password:"), "ssh pidió la contraseña por la terminal");

        let (code, out) = run("no-es-esta-1", "bad");
        println!("--- salida con la contraseña mala ---\n{out}");
        assert_ne!(code, 0);
        assert!(out.contains("Permission denied"), "{out}");
        assert!(!out.contains("LOGIN_OK_"));
        assert_eq!(out.matches("Permission denied").count(), 1, "más de un intento: {out}");
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }
}
