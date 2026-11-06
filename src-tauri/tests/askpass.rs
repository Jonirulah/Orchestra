//! Prueba real del askpass: el exe de Orchestra, lanzado como lo lanza `ssh`
//! (un solo argumento = el prompt, variables ORCHESTRA_ASKPASS_*), devuelve el secreto
//! guardado en el Administrador de credenciales de Windows y nada más.

use std::path::PathBuf;
use std::process::{Command, Stdio};

const SERVICE: &str = "dev.orchestra.app";

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_orchestra")
}

fn scratch_key(tag: &str, kind: &str) -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    format!("test:askpass-{tag}-{}-{n}:{kind}", std::process::id())
}

/// Entrada de prueba que se borra al salir (también si el test falla).
struct Scratch(String);
impl Scratch {
    fn new(key: String, secret: &str) -> Self {
        keyring::Entry::new(SERVICE, &key).unwrap().set_password(secret).unwrap();
        Scratch(key)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = keyring::Entry::new(SERVICE, &self.0).and_then(|e| e.delete_credential());
    }
}

fn run_askpass(prompt: &str, key: &str) -> (i32, String) {
    // Un hijo SIN consola propia ni ventana: stdout por tubería, como cuando lo lanza ssh.
    let out = Command::new(bin())
        .arg(prompt)
        .env("ORCHESTRA_ASKPASS_MODE", "1")
        .env("ORCHESTRA_ASKPASS_KEY", key)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(out.stderr.is_empty(), "el askpass no debe escribir en stderr: {:?}", String::from_utf8_lossy(&out.stderr));
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned())
}

#[test]
fn el_exe_imprime_el_secreto_por_stdout() {
    let secret = "S3cr3t con espacios & ñ \"comillas\" 123";
    let s = Scratch::new(scratch_key("pw", "password"), secret);
    let (code, stdout) = run_askpass("user@127.0.0.1's password: ", &s.0);
    assert_eq!(code, 0);
    assert_eq!(stdout.trim_end_matches(['\r', '\n']), secret);
    assert!(stdout.ends_with('\n'));
}

#[test]
fn passphrase_solo_para_prompts_de_passphrase() {
    let s = Scratch::new(scratch_key("pp", "passphrase"), "frase-secreta");
    let (code, stdout) = run_askpass("Enter passphrase for key 'C:\\k\\id_ed25519': ", &s.0);
    assert_eq!((code, stdout.trim()), (0, "frase-secreta"));
    // NEGATIVO: un prompt de contraseña no recibe la passphrase.
    let (code, stdout) = run_askpass("user@host's password: ", &s.0);
    assert_eq!(code, 1);
    assert!(stdout.is_empty(), "no debe imprimir nada: {stdout:?}");
}

#[test]
fn negativos_no_filtran_nada() {
    let s = Scratch::new(scratch_key("neg", "password"), "no-lo-sueltes");
    for prompt in [
        "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
        "Verification code: ",
        "Enter passphrase for key 'x': ",
    ] {
        let (code, stdout) = run_askpass(prompt, &s.0);
        assert_eq!(code, 1, "{prompt}");
        assert!(stdout.is_empty(), "{prompt}: {stdout:?}");
    }
    // Clave inexistente.
    let (code, stdout) = run_askpass("password: ", &scratch_key("nada", "password"));
    assert_eq!((code, stdout.as_str()), (1, ""));
    // Sin ORCHESTRA_ASKPASS_KEY.
    let out = Command::new(bin())
        .arg("password: ")
        .env("ORCHESTRA_ASKPASS_MODE", "1")
        .env_remove("ORCHESTRA_ASKPASS_KEY")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
}

#[test]
fn tambien_con_el_argumento_explicito() {
    let s = Scratch::new(scratch_key("flag", "password"), "con-flag");
    let out = Command::new(bin())
        .args(["--askpass", "Password: "])
        .env("ORCHESTRA_ASKPASS_KEY", &s.0)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "con-flag");
}

/// El exe de producción es del subsistema GUI (`windows_subsystem = "windows"`): este test
/// compila un programa mínimo con ESE subsistema y la misma forma de escribir (stdout bloqueado,
/// write_all + flush) y comprueba que la tubería del padre recibe los bytes.
#[test]
fn un_exe_de_subsistema_gui_escribe_por_la_tuberia_heredada() {
    let dir: PathBuf = std::env::temp_dir().join(format!("orch-gui-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("gui.rs");
    std::fs::write(
        &src,
        r#"#![windows_subsystem = "windows"]
use std::io::Write;
fn main() {
    let mut o = std::io::stdout().lock();
    let _ = o.write_all(b"secreto-gui\n");
    let _ = o.flush();
}
"#,
    )
    .unwrap();
    let exe = dir.join("gui.exe");
    let rc = Command::new("rustc")
        .args(["--edition", "2021", "-O", "-o"])
        .arg(&exe)
        .arg(&src)
        .output()
        .unwrap();
    assert!(rc.status.success(), "rustc: {}", String::from_utf8_lossy(&rc.stderr));
    // Comprobación de que de verdad es GUI: cabecera PE, Subsystem = 2 (WINDOWS_GUI).
    let bytes = std::fs::read(&exe).unwrap();
    let pe = u32::from_le_bytes(bytes[0x3c..0x40].try_into().unwrap()) as usize;
    let subsystem = u16::from_le_bytes(bytes[pe + 24 + 68..pe + 24 + 70].try_into().unwrap());
    assert_eq!(subsystem, 2, "el exe de prueba no es del subsistema GUI");
    let out = Command::new(&exe).stdin(Stdio::null()).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "secreto-gui\n");
    let _ = std::fs::remove_dir_all(&dir);
}
