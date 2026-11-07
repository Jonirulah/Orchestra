//! Ejecución de un comando remoto para la herramienta MCP `run_command` (ver mcp.rs).
//!
//! Un proceso `ssh` por llamada, sin terminal, sin shell local (argumentos en array), con la misma política que las
//! métricas del servidor (`remote_metrics::base_args`): `StrictHostKeyChecking=yes` siempre, secreto solo por askpass de
//! la bóveda (el entorno lleva el NOMBRE de la entrada, nunca el secreto). La salida se corta a un tope por flujo y el
//! proceso se mata al vencer el plazo.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::mcp::{CommandRunner, RunOutput, RunRequest};
use crate::remote_metrics::{base_args, build_env};

/// Tope de bytes que se conservan por flujo (stdout y stderr).
pub const MAX_STREAM: usize = 64 * 1024;

/// Lee un flujo entero pero solo conserva los primeros `cap` bytes (el resto se descarta para no bloquear al hijo).
fn drain(mut r: impl Read + Send + 'static, cap: usize) -> std::thread::JoinHandle<(Vec<u8>, bool)> {
    std::thread::spawn(move || {
        let mut keep: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut buf = [0u8; 8192];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = cap.saturating_sub(keep.len());
                    if room >= n {
                        keep.extend_from_slice(&buf[..n]);
                    } else {
                        keep.extend_from_slice(&buf[..room]);
                        truncated = true;
                    }
                }
            }
        }
        (keep, truncated)
    })
}

/// Lanza `cmd` (ya construido), espera hasta `timeout` y devuelve lo recogido. Al vencer, mata el proceso.
pub fn run_process(cmd: Command, timeout: Duration, cap: usize) -> RunOutput {
    run_process_stdin(cmd, Stdio::null(), timeout, cap)
}

/// Igual que `run_process`, pero con la entrada estándar que se le dé (p. ej. un archivo que se sube por ssh).
pub fn run_process_stdin(mut cmd: Command, stdin: Stdio, timeout: Duration, cap: usize) -> RunOutput {
    cmd.stdin(stdin).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return RunOutput { spawn_error: Some(format!("could not run ssh: {e}")), ..Default::default() };
        }
    };
    let out = child.stdout.take().map(|s| drain(s, cap));
    let err = child.stderr.take().map(|s| drain(s, cap));
    let end = Instant::now() + timeout;
    let mut timed_out = false;
    let mut code: Option<i32> = None;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                code = st.code();
                break;
            }
            Ok(None) => {}
            Err(_) => break,
        }
        if Instant::now() >= end {
            timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    let (so, t1) = out.map(|h| h.join().unwrap_or_default()).unwrap_or_default();
    let (se, t2) = err.map(|h| h.join().unwrap_or_default()).unwrap_or_default();
    RunOutput {
        stdout: so,
        stderr: se,
        exit_code: code,
        truncated: t1 || t2,
        timed_out,
        spawn_error: None,
    }
}

/// Lanzador real: `ssh` con los argumentos validados y el comando del agente como UN solo argumento.
pub struct SshRunner;

impl SshRunner {
    pub fn command_for(req: &RunRequest) -> Command {
        let mut a = base_args(&req.dest);
        a.push(req.cmd.clone());
        let mut c = Command::new("ssh");
        c.args(a);
        for (k, v) in build_env(&req.dest) {
            c.env(k, v);
        }
        c
    }
}

impl CommandRunner for SshRunner {
    fn run(&self, req: &RunRequest) -> RunOutput {
        run_process(SshRunner::command_for(req), req.timeout, MAX_STREAM)
    }
}

pub fn ssh_runner() -> Arc<dyn CommandRunner> {
    Arc::new(SshRunner)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> Command {
        if cfg!(windows) {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoProfile", "-NonInteractive", "-Command", script]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", script]);
            c
        }
    }

    #[test]
    fn captures_stdout_stderr_and_exit_code() {
        let o = run_process(
            sh(if cfg!(windows) { "[Console]::Out.Write('out'); [Console]::Error.Write('err'); exit 3" } else { "printf out; printf err >&2; exit 3" }),
            Duration::from_secs(30),
            1024,
        );
        assert_eq!(String::from_utf8_lossy(&o.stdout), "out");
        assert_eq!(String::from_utf8_lossy(&o.stderr), "err");
        assert_eq!(o.exit_code, Some(3));
        assert!(!o.truncated && !o.timed_out && o.spawn_error.is_none());
    }

    #[test]
    fn timeout_kills_the_process() {
        let t = Instant::now();
        let o = run_process(sh(if cfg!(windows) { "Start-Sleep -Seconds 60" } else { "sleep 60" }), Duration::from_millis(800), 1024);
        assert!(o.timed_out, "debe marcar el vencimiento");
        assert!(o.exit_code.is_none());
        assert!(t.elapsed() < Duration::from_secs(20), "no esperó al proceso: {:?}", t.elapsed());
    }

    #[test]
    fn output_is_truncated_per_stream_without_blocking() {
        let o = run_process(
            sh(if cfg!(windows) { "[Console]::Out.Write('x' * 200000)" } else { "head -c 200000 /dev/zero | tr '\\0' x" }),
            Duration::from_secs(30),
            1000,
        );
        assert_eq!(o.stdout.len(), 1000);
        assert!(o.truncated);
        assert_eq!(o.exit_code, Some(0));
    }

    #[test]
    fn missing_binary_is_a_spawn_error() {
        let o = run_process(Command::new("orchestra-no-such-binary-xyz"), Duration::from_secs(5), 100);
        assert!(o.spawn_error.is_some());
    }

    #[test]
    fn ssh_command_uses_strict_hostkey_one_remote_arg_and_no_secrets_in_args() {
        use crate::remote_metrics::Dest;
        let req = RunRequest {
            dest: Dest { user: Some("deploy".into()), host: "h.example.com".into(), port: 2222, secret_key: Some("host:h1:password".into()), ..Default::default() },
            cmd: "echo 'a b'; ls -l".into(),
            timeout: Duration::from_secs(5),
        };
        let c = SshRunner::command_for(&req);
        let args: Vec<String> = c.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.contains(&"StrictHostKeyChecking=yes".to_string()));
        assert_eq!(args.last().unwrap(), "echo 'a b'; ls -l", "el comando va como un único argumento final");
        let dash = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[dash + 1], "deploy@h.example.com");
        assert_eq!(args.len(), dash + 3);
        assert!(!args.iter().any(|a| a == "sh" || a == "-s"));
        // El entorno solo lleva el NOMBRE de la entrada de la bóveda.
        let envs: Vec<(String, String)> = c.get_envs().filter_map(|(k, v)| v.map(|v| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))).collect();
        assert!(envs.iter().any(|(k, v)| k == "ORCHESTRA_ASKPASS_KEY" && v == "host:h1:password"));
    }
}
