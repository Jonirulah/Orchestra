//! Verificación de la huella de un servidor SSH antes de conectar (hosts con secreto guardado).
//!
//! El askpass no puede contestar al «yes/no» de ssh, así que, con la política «confirm», Orchestra
//! comprueba la huella ANTES de abrir el panel: `ssh-keygen -F` (¿ya es de confianza?), si no,
//! `ssh-keyscan` + `ssh-keygen -lf -` (huellas SHA256) y, solo si el usuario acepta, se AÑADE la
//! línea a `~/.ssh/known_hosts`. Después el panel se lanza con `StrictHostKeyChecking=yes`.
//!
//! Reglas: nada pasa por un shell (siempre `Command` con lista de argumentos); known_hosts solo se
//! amplía (append), nunca se reescribe; aquí solo hay datos públicos (claves públicas y huellas).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Tipos que se piden al servidor (los mismos que ssh sabe verificar hoy).
const KEY_TYPES: &str = "ed25519,ecdsa,rsa";

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProbeStatus {
    /// La clave del host ya está en known_hosts: se conecta sin preguntar.
    Known,
    /// Desconocido y escaneado: hay que enseñar las huellas.
    Unknown,
    /// Desconocido y se llega por salto (ProxyJump/ProxyCommand): no se puede escanear.
    Jump,
    /// El host usa HostKeyAlias: no sabemos con qué nombre lo anotaría ssh.
    Alias,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScannedKey {
    /// «ED25519», «RSA»…
    pub key_type: String,
    /// «ssh-ed25519»…
    pub algo: String,
    /// «SHA256:…»
    pub fingerprint: String,
    /// «ssh-ed25519 AAAA…» (sin nombre de host): es lo que vuelve en `hostkey_trust`.
    pub line: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyProbe {
    pub status: ProbeStatus,
    /// Nombre real al que se conecta (tras `ssh -G`), en minúsculas y sin punto final.
    pub host: String,
    pub port: u16,
    /// Nombre tal como lo escribe known_hosts (`host` o `[host]:puerto`).
    pub pattern: String,
    pub keys: Vec<ScannedKey>,
}

// ---------- nombres ----------

/// Nombre de host seguro para pasarlo como argumento: sin corchetes, minúsculas, sin punto final
/// y sin nada que ssh pudiera tomar por una opción.
pub fn normalize_host(raw: &str) -> Result<String, String> {
    let mut h = raw.trim().to_string();
    if h.starts_with('[') && h.ends_with(']') && h.len() >= 2 {
        h = h[1..h.len() - 1].to_string();
    }
    while h.ends_with('.') {
        h.pop();
    }
    let h = h.to_ascii_lowercase();
    let ok = !h.is_empty()
        && h.len() <= 253
        && !h.starts_with('-')
        && h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'));
    if ok {
        Ok(h)
    } else {
        Err("That host name cannot be checked (unexpected characters)".into())
    }
}

/// Nombre en known_hosts: `host` para el puerto 22 y `[host]:puerto` para el resto
/// (IPv6 sin corchetes en el 22: `::1`; con puerto: `[::1]:2222`).
pub fn known_hosts_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

// ---------- análisis de salidas ----------

fn is_b64(s: &str) -> bool {
    !s.is_empty() && s.len() <= 8192 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

fn is_key_algo(s: &str) -> bool {
    s.starts_with("ssh-") || s.starts_with("ecdsa-sha2-")
}

/// Salida de `ssh-keyscan`: `host tipo base64` por línea; `#…` y líneas vacías se ignoran.
/// Devuelve (algoritmo, base64) sin repetir algoritmo.
pub fn parse_keyscan(out: &str) -> Vec<(String, String)> {
    let mut keys: Vec<(String, String)> = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 3 || !is_key_algo(f[1]) || !is_b64(f[2]) {
            continue;
        }
        if keys.iter().any(|(a, _)| a == f[1]) {
            continue;
        }
        keys.push((f[1].to_string(), f[2].to_string()));
    }
    keys
}

/// «256 SHA256:abc comentario (ED25519)» -> «SHA256:abc».
pub fn parse_fingerprint(line: &str) -> Option<String> {
    let fp = line.split_whitespace().nth(1)?;
    (fp.starts_with("SHA256:") && fp.len() > 10 && fp[7..].bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))).then(|| fp.to_string())
}

/// Líneas `clave valor` de `ssh -G`.
fn ssh_g_value<'a>(out: &'a str, key: &str) -> Option<&'a str> {
    out.lines().find_map(|l| {
        let (k, v) = l.split_once(' ')?;
        (k == key).then_some(v.trim())
    })
}

/// Valida lo que vuelve de la interfaz: «tipo base64» sin saltos de línea ni nombre de host.
fn valid_pub_line(line: &str) -> Result<(String, String), String> {
    let f: Vec<&str> = line.split_whitespace().collect();
    if f.len() != 2 || line.contains(['\n', '\r']) || !is_key_algo(f[0]) || !is_b64(f[1]) {
        return Err("Invalid host key data".into());
    }
    Ok((f[0].to_string(), f[1].to_string()))
}

/// Texto para añadir a known_hosts: una línea `patrón tipo base64\n` por clave.
/// Se niega si no hay ninguna clave o alguna es inválida.
pub fn format_known_hosts(pattern: &str, lines: &[String]) -> Result<String, String> {
    if lines.is_empty() {
        return Err("No host key to trust".into());
    }
    if pattern.is_empty() || pattern.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, ',' | '|' | '*' | '?' | '!')) {
        return Err("Invalid host name".into());
    }
    let mut out = String::new();
    for l in lines {
        let (a, b) = valid_pub_line(l)?;
        out.push_str(&format!("{pattern} {a} {b}\n"));
    }
    Ok(out)
}

// ---------- procesos ----------

#[cfg(windows)]
fn quiet(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000) // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn quiet(cmd: &mut Command) -> &mut Command {
    cmd
}

struct Ran {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

/// Ejecuta con stdin opcional y un límite de tiempo duro (mata el proceso si se pasa).
fn run(mut cmd: Command, stdin: Option<&str>, secs: u64) -> Result<Ran, String> {
    quiet(&mut cmd);
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let name = cmd.get_program().to_string_lossy().into_owned();
    let mut child = cmd.spawn().map_err(|e| format!("Could not run {name}: {e}. Is the OpenSSH client installed?"))?;
    if let (Some(text), Some(mut si)) = (stdin, child.stdin.take()) {
        let _ = si.write_all(text.as_bytes());
    }
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let t_out = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = so.read_to_end(&mut b);
        b
    });
    let t_err = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = se.read_to_end(&mut b);
        b
    });
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut timed_out = false;
    let code = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code(),
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let stdout = String::from_utf8_lossy(&t_out.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&t_err.join().unwrap_or_default()).into_owned();
    Ok(Ran { code, stdout, stderr, timed_out })
}

/// ¿Está ya la clave de ese host en known_hosts? (`ssh-keygen -F` entiende los archivos hasheados.)
pub fn is_known(host: &str, port: u16, known_hosts: Option<&Path>) -> Result<bool, String> {
    let mut c = Command::new("ssh-keygen");
    c.arg("-F").arg(known_hosts_pattern(host, port));
    if let Some(f) = known_hosts {
        c.arg("-f").arg(f);
    }
    let r = run(c, None, 10)?;
    if r.timed_out {
        return Err("ssh-keygen did not answer".into());
    }
    Ok(r.code == Some(0))
}

/// Huella SHA256 de una clave pública (`ssh-keygen -lf -`, la clave entra por stdin).
pub fn fingerprint_of(algo: &str, b64: &str) -> Result<String, String> {
    let mut c = Command::new("ssh-keygen");
    c.args(["-l", "-f", "-"]);
    let r = run(c, Some(&format!("{algo} {b64}\n")), 10)?;
    if r.code != Some(0) {
        return Err(format!("ssh-keygen could not read the key: {}", r.stderr.lines().next().unwrap_or("unknown error")));
    }
    r.stdout.lines().find_map(parse_fingerprint).ok_or_else(|| "Unexpected ssh-keygen output".to_string())
}

/// ¿Vale la pena reintentar con el propio `ssh`? Sí cuando `ssh-keyscan` llegó a ver el banner del
/// servidor (hay red) pero no sacó ninguna clave: pasa con el ssh-keyscan de Windows 9.5, que se
/// ofrece KEX `sntrup761x25519` y luego no sabe usarlo («choose_kex: unsupported KEX method»).
pub fn keyscan_needs_ssh_fallback(stdout: &str, stderr: &str) -> bool {
    parse_keyscan(stdout).is_empty()
        && stdout.lines().chain(stderr.lines()).any(|l| l.starts_with("# ") && l.contains(" SSH-"))
}

/// `ssh-keyscan` con tope de 5 s por conexión (y 15 s en total). Si llega al servidor pero no
/// consigue claves, se reintenta con el propio ssh (ver `scan_via_ssh`).
pub fn scan(host: &str, port: u16) -> Result<Vec<(String, String)>, String> {
    let mut c = Command::new("ssh-keyscan");
    c.args(["-T", "5", "-p", &port.to_string(), "-t", KEY_TYPES, "--", host]);
    let r = run(c, None, 15)?;
    let keys = parse_keyscan(&r.stdout);
    if !keys.is_empty() {
        return Ok(keys);
    }
    if keyscan_needs_ssh_fallback(&r.stdout, &r.stderr) {
        let keys = scan_via_ssh(host, port)?;
        if !keys.is_empty() {
            return Ok(keys);
        }
    }
    let why = if r.timed_out { "timed out" } else { "no answer" };
    Err(format!(
        "Could not read the host key of {host}:{port} ({why}). Check the address and port, and that the server is reachable."
    ))
}

/// Saca las claves del servidor con el propio `ssh`: se conecta SIN autenticarse (ni claves, ni
/// contraseña), con un known_hosts y una configuración TEMPORALES, y lee lo que ssh aprendió.
/// ssh aprende la clave del host durante el intercambio de claves, antes de autenticar, así que
/// no se envía ningún secreto. Una llamada por familia de clave (ssh solo negocia una).
pub fn scan_via_ssh(host: &str, port: u16) -> Result<Vec<(String, String)>, String> {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("orch-scan-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create a temporary folder: {e}"))?;
    let out = scan_via_ssh_in(&dir, host, port);
    let _ = std::fs::remove_dir_all(&dir);
    out
}

fn scan_via_ssh_in(dir: &Path, host: &str, port: u16) -> Result<Vec<(String, String)>, String> {
    // Rutas RELATIVAS (cwd = carpeta temporal): `-o Clave=valor` se parte por espacios y la carpeta
    // temporal del usuario puede tenerlos.
    std::fs::write(dir.join("cfg"), "").map_err(|e| e.to_string())?;
    let mut keys: Vec<(String, String)> = Vec::new();
    for (i, algos) in ["ssh-ed25519", "ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521", "rsa-sha2-512,rsa-sha2-256,ssh-rsa"].into_iter().enumerate() {
        // Un known_hosts nuevo por familia: con una clave ya aprendida, ssh rechazaría las de otro tipo como «cambiadas».
        let kh = format!("kh{i}");
        let mut c = Command::new("ssh");
        c.current_dir(dir)
            .args(["-F", "cfg", "-o", &format!("UserKnownHostsFile={kh}"), "-o", "GlobalKnownHostsFile=kh_global"])
            .args(["-o", "StrictHostKeyChecking=accept-new", "-o", "HashKnownHosts=no", "-o", "CheckHostIP=no"])
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "LogLevel=ERROR"])
            .args(["-o", "PubkeyAuthentication=no", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no"])
            .args(["-o", "GSSAPIAuthentication=no", "-o", "NumberOfPasswordPrompts=0", "-o", "IdentitiesOnly=yes"])
            .args(["-o", &format!("HostKeyAlgorithms={algos}"), "-p", &port.to_string(), "-l", "orchestra-hostkey-check", "--", host, "exit"]);
        let r = run(c, None, 15)?;
        if let Ok(text) = std::fs::read_to_string(dir.join(&kh)) {
            for (a, b) in parse_keyscan(&text) {
                if !keys.iter().any(|(x, _)| *x == a) {
                    keys.push((a, b));
                }
            }
        }
        // Sin red / sin servidor: no tiene sentido probar las otras familias.
        if !r.stderr.contains("no matching host key type") && keys.is_empty() {
            break;
        }
    }
    Ok(keys)
}

/// Lo que ssh usaría de verdad (`ssh -G`): nombre real, puerto, saltos y alias de clave.
struct Resolved {
    host: String,
    port: u16,
    jump: bool,
    alias: bool,
}

fn resolve(host: &str, port: Option<u16>, user: Option<&str>, proxy_jump: Option<&str>) -> Result<Resolved, String> {
    let given = normalize_host(host)?;
    let given_port = port.filter(|p| *p != 0).unwrap_or(22);
    let mut jump = proxy_jump.map(|j| !j.trim().is_empty()).unwrap_or(false);
    let mut r = Resolved { host: given.clone(), port: given_port, jump, alias: false };
    let mut c = Command::new("ssh");
    c.arg("-G");
    if let Some(p) = port.filter(|p| *p != 0) {
        c.arg("-p").arg(p.to_string());
    }
    if let Some(u) = user.map(str::trim).filter(|u| !u.is_empty() && !u.starts_with('-') && !u.contains(char::is_whitespace)) {
        c.arg("-l").arg(u);
    }
    c.arg("--").arg(&given);
    // Si `ssh -G` falla (ssh raro, configuración rota) se sigue con lo que escribió el usuario.
    if let Ok(out) = run(c, None, 10) {
        if out.code == Some(0) {
            if let Some(h) = ssh_g_value(&out.stdout, "hostname").and_then(|h| normalize_host(h).ok()) {
                r.host = h;
            }
            if let Some(p) = ssh_g_value(&out.stdout, "port").and_then(|p| p.parse::<u16>().ok()) {
                r.port = p;
            }
            let none = |v: Option<&str>| v.map(|v| !v.is_empty() && !v.eq_ignore_ascii_case("none")).unwrap_or(false);
            jump = jump || none(ssh_g_value(&out.stdout, "proxyjump")) || none(ssh_g_value(&out.stdout, "proxycommand"));
            r.alias = none(ssh_g_value(&out.stdout, "hostkeyalias"));
        }
    }
    r.jump = jump;
    Ok(r)
}

/// Comprobación completa. `known_hosts`: archivo alternativo (solo para pruebas).
pub fn probe(host: &str, port: Option<u16>, user: Option<&str>, proxy_jump: Option<&str>, known_hosts: Option<&Path>) -> Result<HostKeyProbe, String> {
    let r = resolve(host, port, user, proxy_jump)?;
    let pattern = known_hosts_pattern(&r.host, r.port);
    let mk = |status, keys| HostKeyProbe { status, host: r.host.clone(), port: r.port, pattern: pattern.clone(), keys };
    if r.alias {
        return Ok(mk(ProbeStatus::Alias, vec![]));
    }
    if is_known(&r.host, r.port, known_hosts)? {
        return Ok(mk(ProbeStatus::Known, vec![]));
    }
    if r.jump {
        return Ok(mk(ProbeStatus::Jump, vec![]));
    }
    let mut keys = Vec::new();
    for (algo, b64) in scan(&r.host, r.port)? {
        let fingerprint = fingerprint_of(&algo, &b64)?;
        keys.push(ScannedKey { key_type: crate::vault::friendly_type(&algo), line: format!("{algo} {b64}"), algo, fingerprint });
    }
    Ok(mk(ProbeStatus::Unknown, keys))
}

// ---------- confiar ----------

fn default_known_hosts() -> Result<PathBuf, String> {
    Ok(crate::vault::ssh_dir()?.join("known_hosts"))
}

/// Añade las claves a known_hosts (crea la carpeta si falta). Nunca reescribe lo que ya hay;
/// si ya constaba (otro panel se adelantó) no duplica.
pub fn trust(host: &str, port: u16, lines: &[String], known_hosts: Option<&Path>) -> Result<(), String> {
    let host = normalize_host(host)?;
    let text = format_known_hosts(&known_hosts_pattern(&host, port), lines)?;
    let path = match known_hosts {
        Some(p) => p.to_path_buf(),
        None => default_known_hosts()?,
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    if path.exists() && is_known(&host, port, Some(&path)).unwrap_or(false) {
        return Ok(());
    }
    // Si el archivo no acaba en salto de línea, el primero va delante para no pegarse a la última entrada.
    let lead = match std::fs::read(&path) {
        Ok(b) if !b.is_empty() && *b.last().unwrap() != b'\n' => "\n",
        _ => "",
    };
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Cannot write {}: {e}. Check that the .ssh folder is writable.", path.display()))?;
    f.write_all(format!("{lead}{text}").as_bytes())
        .and_then(|_| f.flush())
        .map_err(|e| format!("Cannot write {}: {e}", path.display()))
}

// ---------- comandos ----------

#[tauri::command]
pub async fn hostkey_probe(host: String, port: Option<u16>, user: Option<String>, proxy_jump: Option<String>) -> Result<HostKeyProbe, String> {
    tauri::async_runtime::spawn_blocking(move || probe(&host, port, user.as_deref(), proxy_jump.as_deref(), None))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn hostkey_trust(host: String, port: u16, lines: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || trust(&host, port, &lines, None))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED: &str = "AAAAC3NzaC1lZDI1NTE5AAAAICJy3qGYqCp4bYB37rkEwXEAUblilFvFT/OoUF69RCDZ";

    #[test]
    fn parsea_la_salida_de_keyscan() {
        let out = format!(
            "# 10.0.0.5:22 SSH-2.0-OpenSSH_9.6\n\n10.0.0.5 ssh-ed25519 {ED}\n# otra\n10.0.0.5 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY=\n10.0.0.5 ssh-rsa AAAAB3NzaC1yc2E=\n10.0.0.5 ssh-rsa AAAAB3NzaC1yc2EOTRA\n"
        );
        let k = parse_keyscan(&out);
        let algos: Vec<&str> = k.iter().map(|(a, _)| a.as_str()).collect();
        assert_eq!(algos, ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"], "sin repetir tipo, en orden");
        assert_eq!(k[0].1, ED);
        assert_eq!(k[2].1, "AAAAB3NzaC1yc2E=", "se queda con la primera de cada tipo");
    }

    #[test]
    fn keyscan_ignora_basura() {
        assert!(parse_keyscan("").is_empty());
        assert!(parse_keyscan("# solo comentarios\n   \n#x").is_empty());
        assert!(parse_keyscan("host ssh-ed25519\nhost foo AAAA\nhost ssh-ed25519 no*es*base64").is_empty());
        // Línea con host IPv6 y con corchetes.
        let k = parse_keyscan(&format!("[::1]:2222 ssh-ed25519 {ED}\r\n"));
        assert_eq!(k.len(), 1);
    }

    #[test]
    fn linea_de_huella() {
        assert_eq!(
            parse_fingerprint("256 SHA256:QdmizYy61MB96NGyVJthrCS+ez63ogtKD+yCvF/Dbl8 jon@pc (ED25519)").as_deref(),
            Some("SHA256:QdmizYy61MB96NGyVJthrCS+ez63ogtKD+yCvF/Dbl8")
        );
        assert_eq!(parse_fingerprint("256 MD5:aa:bb x (ED25519)"), None);
        assert_eq!(parse_fingerprint(""), None);
        assert_eq!(parse_fingerprint("(stdin) is not a public key file."), None);
    }

    #[test]
    fn nombres_de_host() {
        assert_eq!(normalize_host("  Example.COM. ").unwrap(), "example.com");
        assert_eq!(normalize_host("[::1]").unwrap(), "::1");
        assert_eq!(normalize_host("2001:DB8::1").unwrap(), "2001:db8::1");
        for bad in ["", "-oProxyCommand=x", "a b", "a;b", "a/b", "$(x)", "..."] {
            assert!(normalize_host(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn nombre_en_known_hosts_segun_puerto() {
        assert_eq!(known_hosts_pattern("srv.example.com", 22), "srv.example.com");
        assert_eq!(known_hosts_pattern("srv.example.com", 2222), "[srv.example.com]:2222");
        assert_eq!(known_hosts_pattern("::1", 22), "::1");
        assert_eq!(known_hosts_pattern("::1", 2222), "[::1]:2222");
        assert_eq!(known_hosts_pattern("127.0.0.1", 2222), "[127.0.0.1]:2222");
    }

    #[test]
    fn formatea_lineas_y_se_niega_si_no_hay_nada() {
        let l = vec![format!("ssh-ed25519 {ED}"), "ssh-rsa AAAAB3NzaC1yc2E=".to_string()];
        assert_eq!(
            format_known_hosts("[h]:2222", &l).unwrap(),
            format!("[h]:2222 ssh-ed25519 {ED}\n[h]:2222 ssh-rsa AAAAB3NzaC1yc2E=\n")
        );
        assert!(format_known_hosts("h", &[]).is_err(), "entrada vacía: no se escribe nada");
        assert!(format_known_hosts("", &l).is_err());
        assert!(format_known_hosts("h h2", &l).is_err(), "nombre con espacio");
        assert!(format_known_hosts("*", &l).is_err(), "comodín: confiaría en todos los hosts");
        // Una línea con salto de línea o con otro host dentro no entra.
        assert!(format_known_hosts("h", &[format!("ssh-ed25519 {ED}\nevil ssh-ed25519 {ED}")]).is_err());
        assert!(format_known_hosts("h", &[format!("evil ssh-ed25519 {ED}")]).is_err());
        assert!(format_known_hosts("h", &["ssh-ed25519".to_string()]).is_err());
    }

    fn tmp(tag: &str) -> PathBuf {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("orch-hk-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn trust_crea_la_carpeta_y_solo_anade() {
        let d = tmp("trust");
        let kh = d.join("nueva").join(".ssh").join("known_hosts");
        let l = vec![format!("ssh-ed25519 {ED}")];
        trust("Example.com.", 22, &l, Some(&kh)).unwrap();
        assert_eq!(std::fs::read_to_string(&kh).unwrap(), format!("example.com ssh-ed25519 {ED}\n"));
        // Otro host, otro puerto: se añade; lo anterior queda intacto.
        trust("10.0.0.5", 2222, &l, Some(&kh)).unwrap();
        assert_eq!(
            std::fs::read_to_string(&kh).unwrap(),
            format!("example.com ssh-ed25519 {ED}\n[10.0.0.5]:2222 ssh-ed25519 {ED}\n")
        );
        // Ya conocido: no duplica.
        trust("10.0.0.5", 2222, &l, Some(&kh)).unwrap();
        assert_eq!(std::fs::read_to_string(&kh).unwrap().lines().count(), 2);
        // Entrada vacía: se niega y no toca el archivo.
        let before = std::fs::read(&kh).unwrap();
        assert!(trust("10.0.0.9", 22, &[], Some(&kh)).is_err());
        assert_eq!(std::fs::read(&kh).unwrap(), before);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn trust_no_pega_la_linea_a_una_entrada_sin_salto_final() {
        let d = tmp("nl");
        let kh = d.join("known_hosts");
        std::fs::write(&kh, format!("viejo ssh-ed25519 {ED}")).unwrap(); // sin \n final
        trust("nuevo.example", 22, &[format!("ssh-ed25519 {ED}")], Some(&kh)).unwrap();
        let t = std::fs::read_to_string(&kh).unwrap();
        assert_eq!(t, format!("viejo ssh-ed25519 {ED}\nnuevo.example ssh-ed25519 {ED}\n"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn trust_con_carpeta_imposible_da_error_claro() {
        let d = tmp("ro");
        // «Carpeta» que en realidad es un archivo: ni crear la carpeta ni escribir son posibles.
        let blocker = d.join("ssh");
        std::fs::write(&blocker, "x").unwrap();
        let kh = blocker.join("known_hosts");
        let e = trust("h.example", 22, &[format!("ssh-ed25519 {ED}")], Some(&kh)).unwrap_err();
        assert!(e.contains("Cannot"), "{e}");
        assert!(!e.contains(ED), "el error no vuelca datos de la clave");
        // Archivo de solo lectura: error de escritura (en Windows y Unix).
        let kh2 = d.join("known_hosts");
        std::fs::write(&kh2, "").unwrap();
        let mut perm = std::fs::metadata(&kh2).unwrap().permissions();
        perm.set_readonly(true);
        std::fs::set_permissions(&kh2, perm.clone()).unwrap();
        let e = trust("h.example", 22, &[format!("ssh-ed25519 {ED}")], Some(&kh2)).unwrap_err();
        assert!(e.contains("Cannot write"), "{e}");
        #[allow(clippy::permissions_set_readonly_false)]
        {
            perm.set_readonly(false);
            let _ = std::fs::set_permissions(&kh2, perm);
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn huella_de_una_clave_real_con_ssh_keygen() {
        // Clave generada aquí mismo; la huella tiene que coincidir con `ssh-keygen -lf archivo.pub`.
        let d = tmp("fp");
        let k = d.join("k");
        let o = Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "t", "-f"]).arg(&k).output().unwrap();
        assert!(o.status.success());
        let pubtxt = std::fs::read_to_string(d.join("k.pub")).unwrap();
        let f: Vec<&str> = pubtxt.split_whitespace().collect();
        let ours = fingerprint_of(f[0], f[1]).unwrap();
        let o = Command::new("ssh-keygen").arg("-lf").arg(d.join("k.pub")).output().unwrap();
        let theirs = parse_fingerprint(&String::from_utf8_lossy(&o.stdout)).unwrap();
        assert_eq!(ours, theirs);
        assert!(ours.starts_with("SHA256:"));
        // Basura -> error, no huella inventada.
        assert!(fingerprint_of("ssh-ed25519", "AAAAnope").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn is_known_distingue_puertos_y_mayusculas() {
        let d = tmp("known");
        let k = d.join("k");
        let o = Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "t", "-f"]).arg(&k).output().unwrap();
        assert!(o.status.success());
        let pubtxt = std::fs::read_to_string(d.join("k.pub")).unwrap();
        let f: Vec<&str> = pubtxt.split_whitespace().collect();
        let line = vec![format!("{} {}", f[0], f[1])];
        let kh = d.join("known_hosts");
        // Sin archivo todavía: desconocido, sin error.
        assert!(!is_known("srv.example.com", 22, Some(&kh)).unwrap());
        trust("srv.example.com", 2222, &line, Some(&kh)).unwrap();
        trust("::1", 22, &line, Some(&kh)).unwrap();
        trust("2001:db8::7", 2200, &line, Some(&kh)).unwrap();
        assert!(is_known("srv.example.com", 2222, Some(&kh)).unwrap());
        assert!(!is_known("srv.example.com", 22, Some(&kh)).unwrap(), "la entrada es de otro puerto");
        assert!(!is_known("srv.example.com", 2223, Some(&kh)).unwrap());
        assert!(is_known("::1", 22, Some(&kh)).unwrap());
        assert!(!is_known("::1", 2222, Some(&kh)).unwrap());
        assert!(is_known("2001:db8::7", 2200, Some(&kh)).unwrap());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn probe_con_salto_no_escanea_y_con_conocido_no_pregunta() {
        let d = tmp("probe");
        let kh = d.join("known_hosts");
        // Desconocido + ProxyJump: aviso «jump», sin tocar la red ni el archivo.
        let p = probe("Intranet.Example.", Some(22), None, Some("user@bastion"), Some(&kh)).unwrap();
        assert_eq!(p.status, ProbeStatus::Jump);
        assert!(p.keys.is_empty());
        assert_eq!(p.host, "intranet.example");
        assert!(!kh.exists());
        // Conocido + ProxyJump: se puede conectar (la clave ya está).
        std::fs::write(&kh, format!("intranet.example ssh-ed25519 {ED}\n")).unwrap();
        let p = probe("Intranet.Example.", Some(22), None, Some("user@bastion"), Some(&kh)).unwrap();
        assert_eq!(p.status, ProbeStatus::Known);
        // Nombre con pinta de opción: se rechaza antes de ejecutar nada.
        assert!(probe("-oProxyCommand=calc", None, None, None, Some(&kh)).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn el_reintento_con_ssh_solo_si_hubo_banner_y_ninguna_clave() {
        // Windows OpenSSH 9.5: banner visible y luego «choose_kex: unsupported KEX method».
        let err = "# 10.0.0.5:22 SSH-2.0-OpenSSH_10.2p1\nchoose_kex: unsupported KEX method sntrup761x25519-sha512@openssh.com\n";
        assert!(keyscan_needs_ssh_fallback("", err));
        assert!(keyscan_needs_ssh_fallback("# 10.0.0.5:22 SSH-2.0-OpenSSH_9.6\n", ""));
        // Sin banner (no hay red, rechazada, DNS): no se reintenta.
        assert!(!keyscan_needs_ssh_fallback("", "getaddrinfo 10.0.0.5: Name or service not known\n"));
        assert!(!keyscan_needs_ssh_fallback("", ""));
        // Con claves ya no hace falta.
        assert!(!keyscan_needs_ssh_fallback(&format!("# x SSH-2.0\n10.0.0.5 ssh-ed25519 {ED}\n"), ""));
    }

    #[test]
    fn el_reintento_con_ssh_a_un_puerto_cerrado_no_inventa_claves() {
        let keys = scan_via_ssh("127.0.0.1", 1).unwrap();
        assert!(keys.is_empty(), "{keys:?}");
    }

    #[test]
    fn keyscan_a_un_puerto_cerrado_da_error_claro() {
        // Puerto 1 de loopback: conexión rechazada al instante, sin red.
        let e = scan("127.0.0.1", 1).unwrap_err();
        assert!(e.contains("Could not read the host key of 127.0.0.1:1"), "{e}");
    }
}

/// Pruebas de punta a punta contra un sshd real (temporal, en WSL). Todas `#[ignore]`.
/// Entorno: `ORCHESTRA_E2E_HK=puerto:usuario:contraseña` y `ORCHESTRA_E2E_HK_DIR=carpeta` con
/// `pubs/*.pub` (las claves públicas ACTUALES del servidor). known_hosts SIEMPRE temporal
/// (`UserKnownHostsFile=`): jamás se toca el ~/.ssh real. Orden: a, c1, (cambiar la clave del
/// servidor), b, c2:
///   `cargo test --bin orchestra hostkey::e2e -- --ignored --test-threads=1 <nombre>`
#[cfg(test)]
mod e2e {
    use super::*;
    use crate::pty::{spawn, Sink, SpawnSpec};
    use crate::vault::{askpass_env_with, delete, set};
    use std::collections::{BTreeSet, HashMap};
    use std::sync::{mpsc, Arc};

    struct Collect(parking_lot::Mutex<Vec<u8>>);
    impl Sink for Collect {
        fn data(&self, b: Vec<u8>) {
            self.0.lock().extend(b);
        }
    }

    fn cfg() -> (u16, String, String, PathBuf) {
        let c = std::env::var("ORCHESTRA_E2E_HK").expect("falta ORCHESTRA_E2E_HK=puerto:usuario:contraseña");
        let mut it = c.splitn(3, ':');
        let port = it.next().unwrap().parse().unwrap();
        let (user, pw) = (it.next().unwrap().to_string(), it.next().unwrap().to_string());
        let dir = PathBuf::from(std::env::var("ORCHESTRA_E2E_HK_DIR").expect("falta ORCHESTRA_E2E_HK_DIR"));
        (port, user, pw, dir)
    }

    /// El exe real (el de pruebas no sabe hacer de askpass).
    fn bin() -> PathBuf {
        let p = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().join("orchestra.exe");
        assert!(p.is_file(), "falta {p:?}: ejecuta `cargo test` completo (compila el exe real)");
        p
    }

    /// Lo que genera `sshArgs()` para un host con contraseña guardada, con `StrictHostKeyChecking=<strict>`,
    /// dentro de un ConPTY real y con el exe de Orchestra como SSH_ASKPASS. Devuelve (código, salida).
    fn run_ssh(strict: &str, known: &Path, tag: &str) -> (i32, String) {
        let (port, user, pw, _) = cfg();
        let key = format!("test:e2e-hk-{tag}-{}:password", std::process::id());
        set(&key, &pw).unwrap();
        let env: HashMap<String, String> = askpass_env_with(&bin(), &key).into_iter().collect();
        let args: Vec<String> = [
            "-oLogLevel=INFO", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4", "-p", &port.to_string(),
            "-o", "NumberOfPasswordPrompts=1", "-o", &format!("StrictHostKeyChecking={strict}"),
            "-o", &format!("UserKnownHostsFile={}", known.display()),
            "-t", &format!("{user}@127.0.0.1"), "echo LOGIN_OK_$(id -un)",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let (tx, rx) = mpsc::channel();
        let s = spawn(
            SpawnSpec { id: format!("e2e-hk-{tag}"), program: "ssh".into(), args, cwd: None, env, cols: 120, rows: 30 },
            Box::new(move |_id, code| {
                let _ = tx.send(code);
            }),
        )
        .unwrap();
        let sink = Arc::new(Collect(parking_lot::Mutex::new(vec![])));
        s.attach(sink.clone());
        let t0 = Instant::now();
        let mut answered = 0;
        let code = loop {
            let seen = String::from_utf8_lossy(&sink.0.lock()).matches("[6n").count();
            while answered < seen {
                let _ = s.write(b"\x1b[1;1R"); // ConPTY pregunta la posición del cursor
                answered += 1;
            }
            if t0.elapsed() > Duration::from_secs(40) {
                s.kill();
                let _ = delete(&key);
                panic!("ssh no terminó en 40 s; salida: {:?}", String::from_utf8_lossy(&sink.0.lock()));
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
        assert!(!out.contains(&pw), "la contraseña salió en pantalla");
        (code, out)
    }

    /// Huellas SHA256 de las claves públicas del servidor (`ssh-keygen -lf` sobre sus .pub).
    fn server_fingerprints(dir: &Path) -> BTreeSet<String> {
        let mut set = BTreeSet::new();
        for e in std::fs::read_dir(dir.join("pubs")).unwrap() {
            let p = e.unwrap().path();
            if p.extension().map(|x| x == "pub").unwrap_or(false) {
                let o = Command::new("ssh-keygen").arg("-lf").arg(&p).output().unwrap();
                set.insert(parse_fingerprint(&String::from_utf8_lossy(&o.stdout)).expect("huella del .pub"));
            }
        }
        assert!(set.len() >= 2, "la carpeta pubs debe tener varias claves del servidor");
        set
    }

    fn fresh(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        let _ = std::fs::remove_file(&p);
        p
    }

    /// (a) confirm + host desconocido: las huellas de keyscan son las del servidor; sin confiar, ssh con
    /// `yes` se niega y no escribe nada; tras «Trust and connect» entra con la contraseña del askpass.
    #[test]
    #[ignore]
    fn e2e_a_confirm_desconocido_huellas_coinciden_y_tras_confiar_conecta() {
        let (port, user, _pw, dir) = cfg();
        let known = fresh(&dir, "known_a");
        let p = probe("127.0.0.1", Some(port), Some(&user), None, Some(&known)).unwrap();
        assert_eq!(p.status, ProbeStatus::Unknown);
        assert_eq!(p.pattern, format!("[127.0.0.1]:{port}"));
        let got: BTreeSet<String> = p.keys.iter().map(|k| k.fingerprint.clone()).collect();
        let want = server_fingerprints(&dir);
        println!("keyscan: {got:?}\nservidor: {want:?}");
        assert_eq!(got, want, "las huellas escaneadas no son las del servidor");
        assert!(p.keys.len() >= 2, "varias claves del servidor");
        assert!(!known.exists(), "probe no escribe known_hosts");

        // Fallar cerrado: sin confiar, `yes` rechaza y no aprende nada.
        let (code, out) = run_ssh("yes", &known, "a-sin-confiar");
        println!("--- sin confiar ---\n{out}");
        assert_ne!(code, 0);
        assert!(out.contains("Host key verification failed"), "{out}");
        assert!(!out.contains("LOGIN_OK_"));
        assert!(!known.exists(), "ssh con yes no debe escribir known_hosts");

        // Confiar y conectar.
        let lines: Vec<String> = p.keys.iter().map(|k| k.line.clone()).collect();
        trust(&p.host, p.port, &lines, Some(&known)).unwrap();
        assert!(is_known("127.0.0.1", port, Some(&known)).unwrap());
        assert_eq!(probe("127.0.0.1", Some(port), Some(&user), None, Some(&known)).unwrap().status, ProbeStatus::Known);
        let (code, out) = run_ssh("yes", &known, "a-confiado");
        println!("--- tras confiar ---\n{out}");
        assert_eq!(code, 0, "{out}");
        assert!(out.contains("LOGIN_OK_") && out.contains(&user), "{out}");
        assert!(!out.to_lowercase().contains("password:"), "ssh pidió la contraseña en la terminal");
        assert!(!out.contains("yes/no"), "ssh preguntó por la huella en la terminal");
    }

    /// (b) tras cambiar la clave del servidor, `yes` se niega (clave cambiada), sin auto-aceptar;
    /// known_hosts queda intacto. El probe dice «known» (ssh-keygen -F la encuentra): se conecta con
    /// `yes` y es ssh quien avisa del cambio.
    #[test]
    #[ignore]
    fn e2e_b_clave_cambiada_se_rechaza() {
        let (port, user, _pw, dir) = cfg();
        let known = dir.join("known_a");
        let before = std::fs::read(&known).expect("ejecuta antes el test (a)");
        assert_eq!(probe("127.0.0.1", Some(port), Some(&user), None, Some(&known)).unwrap().status, ProbeStatus::Known);
        let (code, out) = run_ssh("yes", &known, "b");
        println!("--- clave cambiada (yes) ---\n{out}");
        assert_ne!(code, 0);
        assert!(out.contains("REMOTE HOST IDENTIFICATION HAS CHANGED"), "{out}");
        assert!(!out.contains("LOGIN_OK_"));
        assert_eq!(std::fs::read(&known).unwrap(), before, "known_hosts no se reescribe");
    }

    /// (c1) accept-new: la primera vez entra sin preguntar y aprende la clave.
    #[test]
    #[ignore]
    fn e2e_c1_accept_new_primera_conexion() {
        let (port, _user, _pw, dir) = cfg();
        let known = fresh(&dir, "known_c");
        let (code, out) = run_ssh("accept-new", &known, "c1");
        println!("--- accept-new, primera vez ---\n{out}");
        assert_eq!(code, 0, "{out}");
        assert!(out.contains("LOGIN_OK_"), "{out}");
        assert!(is_known("127.0.0.1", port, Some(&known)).unwrap(), "debe haber aprendido la clave");
    }

    /// (c2) accept-new con la clave ya cambiada: ssh la rechaza igualmente.
    #[test]
    #[ignore]
    fn e2e_c2_accept_new_clave_cambiada_se_rechaza() {
        let (_port, _user, _pw, dir) = cfg();
        let known = dir.join("known_c");
        let before = std::fs::read(&known).expect("ejecuta antes el test (c1)");
        let (code, out) = run_ssh("accept-new", &known, "c2");
        println!("--- accept-new, clave cambiada ---\n{out}");
        assert_ne!(code, 0);
        assert!(out.contains("REMOTE HOST IDENTIFICATION HAS CHANGED"), "{out}");
        assert!(!out.contains("LOGIN_OK_"));
        assert_eq!(std::fs::read(&known).unwrap(), before);
    }
}
