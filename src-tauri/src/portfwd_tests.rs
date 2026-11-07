// Pruebas del reenvío de puertos. Las de vigilancia usan un «ssh» falso (PowerShell que abre el puerto local del -L);
// la prueba contra un servidor REAL está en `real_server` (ignorada: necesita ORCH_PFWD_TEST=usuario@host:puerto:clave).
use super::*;
use std::io::Write;
use std::net::TcpStream;

fn dest() -> Dest {
    Dest { user: Some("demo".into()), host: "example.org".into(), port: 2222, jump: Some("bastion".into()), ..Default::default() }
}

#[test]
fn args_bind_only_loopback_and_keep_security() {
    let a = tunnel_args(&dest(), 3001, 3000);
    let j = a.join(" ");
    assert!(j.contains("-L 127.0.0.1:3001:localhost:3000"), "{j}");
    assert!(j.contains("-N"));
    assert!(j.contains("ExitOnForwardFailure=yes"));
    assert!(j.contains("StrictHostKeyChecking=yes"));
    assert!(j.contains("ServerAliveInterval="));
    assert!(j.contains("-J bastion"));
    assert!(!j.contains("ClearAllForwardings"), "borraría el -L: {j}");
    assert!(!j.contains("0.0.0.0"));
    // Todo lo nuestro va ANTES de `--` y el destino es lo último.
    let dd = a.iter().position(|x| x == "--").unwrap();
    assert!(a.iter().position(|x| x == "-L").unwrap() < dd);
    assert_eq!(a.last().unwrap(), "demo@example.org");
}

#[test]
fn pick_port_same_or_next() {
    let none = HashSet::new();
    assert_eq!(pick_port(3000, &none, |_| true), Some(3000));
    assert_eq!(pick_port(3000, &none, |p| p != 3000), Some(3001));
    let taken: HashSet<u16> = [3000, 3001].into_iter().collect();
    assert_eq!(pick_port(3000, &taken, |p| p != 3002), Some(3003));
    assert_eq!(pick_port(65535, &none, |_| false), None);
    assert_eq!(pick_port(65535, &none, |_| true), Some(65535));
    assert_eq!(pick_port(0, &none, |_| true), Some(1));
    assert_eq!(pick_port(8000, &none, |_| false), None);
}

#[test]
fn pick_port_real_socket() {
    let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let busy = l.local_addr().unwrap().port();
    assert!(!local_free(busy));
    let got = pick_port(busy, &HashSet::new(), local_free).unwrap();
    assert_ne!(got, busy);
    assert!(got > busy);
}

#[test]
fn bind_failure_detected() {
    assert!(is_bind_failure("bind [127.0.0.1]:3000: Address already in use\r\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 3000\r\nCould not request local forwarding."));
    assert!(!is_bind_failure("ssh: connect to host x port 22: Connection refused"));
}

#[test]
fn backoff_doubles_with_cap() {
    let (f, m) = (Duration::from_secs(1), Duration::from_secs(30));
    let v: Vec<u64> = (1..=8).map(|n| backoff(n, f, m).as_secs()).collect();
    assert_eq!(v, vec![1, 2, 4, 8, 16, 30, 30, 30]);
    assert_eq!(backoff(0, f, m).as_secs(), 1);
    assert_eq!(backoff(1000, f, m).as_secs(), 30);
}

#[test]
fn rejects_bad_requests() {
    let m = Manager::new(Arc::new(SshSpawner), Cfg::default());
    let mut d = dest();
    d.host = "-oProxyCommand=calc".into();
    assert!(m.start(FwdReq { dest: d, remote_port: 3000, local_port: None }).is_err());
    assert!(m.start(FwdReq { dest: dest(), remote_port: 0, local_port: None }).is_err());
    assert!(m.start(FwdReq { dest: dest(), remote_port: 3000, local_port: Some(0) }).is_err());
    assert!(m.list().is_empty());
}

// ---------- vigilancia con un ssh falso ----------

/// «ssh» falso: PowerShell que abre 127.0.0.1:<local del -L> (como haría ssh) o que sale con un error de ssh.
struct Fake {
    mode: &'static str,
}
impl Spawner for Fake {
    fn spawn(&self, args: &[String], _env: &[(String, String)]) -> std::io::Result<Child> {
        let l = &args[args.iter().position(|x| x == "-L").unwrap() + 1];
        let local: u16 = l.split(':').nth(1).unwrap().parse().unwrap();
        let ps = match self.mode {
            "up" => format!("try {{ $l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,{local});$l.Start();Start-Sleep 60 }} catch {{ [Console]::Error.WriteLine(\"fake: $_\"); exit 3 }}"),
            "auth" => "[Console]::Error.WriteLine('demo@example.org: Permission denied (publickey).');exit 255".into(),
            _ => "[Console]::Error.WriteLine('ssh: connect to host example.org port 2222: Connection refused');exit 255".into(),
        };
        let mut c = Command::new("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-Command", &ps]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        c.spawn()
    }
}

fn fast() -> Cfg {
    Cfg { first_delay: Duration::from_millis(300), max_delay: Duration::from_secs(1), up_timeout: Duration::from_secs(15) }
}

fn wait_for(m: &Manager, id: &str, secs: u64, f: impl Fn(&Snap) -> bool) -> Snap {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        let s = m.list().into_iter().find(|s| s.id == id).expect("tunnel");
        if f(&s) {
            return s;
        }
        assert!(Instant::now() < end, "timeout: {s:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn pid_alive(pid: u32) -> bool {
    let out = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

fn kill_pid(pid: u32) {
    let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output();
}

#[test]
fn supervise_up_down_up_and_shutdown() {
    let m = Manager::new(Arc::new(Fake { mode: "up" }), fast());
    // Puerto preferido ocupado por otro programa: el túnel elige el siguiente libre.
    let hold = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let busy = hold.local_addr().unwrap().port();
    let s0 = m.start(FwdReq { dest: dest(), remote_port: 3000, local_port: Some(busy) }).unwrap();
    let up = wait_for(&m, &s0.id, 20, |s| s.state == State::Up);
    assert_ne!(up.local_port, busy);
    let pid = up.pid.unwrap();
    // Pedir el mismo túnel otra vez no crea otro.
    assert_eq!(m.start(FwdReq { dest: dest(), remote_port: 3000, local_port: None }).unwrap().id, s0.id);
    assert_eq!(m.list().len(), 1);
    // Muere el «ssh»: se marca caído y vuelve solo, en el MISMO puerto local (la URL no cambia).
    kill_pid(pid);
    wait_for(&m, &s0.id, 10, |s| s.state != State::Up);
    let back = wait_for(&m, &s0.id, 20, |s| s.state == State::Up && s.pid != Some(pid));
    assert_eq!(back.local_port, up.local_port);
    let pid2 = back.pid.unwrap();
    m.shutdown();
    assert!(m.list().is_empty());
    std::thread::sleep(Duration::from_millis(300));
    assert!(!pid_alive(pid2), "ssh huérfano tras shutdown");
    assert!(local_free(up.local_port));
}

#[test]
fn supervise_network_retries_auth_stops() {
    let m = Manager::new(Arc::new(Fake { mode: "net" }), fast());
    let s = m.start(FwdReq { dest: dest(), remote_port: 4000, local_port: None }).unwrap();
    let d = wait_for(&m, &s.id, 20, |s| s.state == State::Down && s.attempt >= 2);
    assert!(d.error.as_deref().unwrap_or("").contains("Connection refused"), "{d:?}");
    m.stop(&s.id);
    assert!(m.list().is_empty());

    let m = Manager::new(Arc::new(Fake { mode: "auth" }), fast());
    let s = m.start(FwdReq { dest: dest(), remote_port: 4000, local_port: None }).unwrap();
    let e = wait_for(&m, &s.id, 20, |s| s.state == State::Error);
    assert_eq!(e.attempt, 0, "la contraseña mala no se reintenta");
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(m.list()[0].state, State::Error);
}

// ---------- servidor real ----------

fn http_get(port: u16) -> String {
    let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n").unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out
}

/// `ORCH_PFWD_TEST=usuario@host:puerto:ruta_clave`; en el remoto debe correr `python3 -m http.server 8765 --bind 127.0.0.1`.
#[test]
#[ignore]
fn real_server() {
    let spec = std::env::var("ORCH_PFWD_TEST").expect("ORCH_PFWD_TEST");
    let mut it = spec.splitn(4, ':');
    let (uh, port, key) = (it.next().unwrap(), it.next().unwrap(), it.next().unwrap().to_string() + &it.next().map(|r| format!(":{r}")).unwrap_or_default());
    let (user, host) = uh.split_once('@').unwrap();
    let d = Dest { user: Some(user.into()), host: host.into(), port: port.parse().unwrap(), identity: Some(key), identities_only: true, ..Default::default() };
    let m = Manager::new(Arc::new(SshSpawner), Cfg { first_delay: Duration::from_millis(500), ..Cfg::default() });

    let t0 = Instant::now();
    let s = m.start(FwdReq { dest: d.clone(), remote_port: 8765, local_port: None }).unwrap();
    let up = wait_for(&m, &s.id, 30, |s| s.state == State::Up);
    eprintln!("arriba en {:?}: 127.0.0.1:{} -> remoto 8765 (pid {:?})", t0.elapsed(), up.local_port, up.pid);
    let r = http_get(up.local_port);
    eprintln!("GET 1: {}", r.lines().next().unwrap_or(""));
    assert!(r.starts_with("HTTP/1.0 200"), "{r}");

    // Matar el ssh: caído y recuperado.
    let pid = up.pid.unwrap();
    let tk = Instant::now();
    kill_pid(pid);
    let down = wait_for(&m, &s.id, 10, |s| s.state != State::Up);
    eprintln!("tras matar pid {pid}: {:?} en {:?}", down.state, tk.elapsed());
    let back = wait_for(&m, &s.id, 30, |s| s.state == State::Up && s.pid != Some(pid));
    eprintln!("recuperado en {:?} (intento {}, puerto {})", tk.elapsed(), down.attempt, back.local_port);
    assert_eq!(back.local_port, up.local_port);
    assert!(http_get(back.local_port).starts_with("HTTP/1.0 200"));

    // Puerto local ocupado por otro programa: elige el siguiente libre y funciona.
    m.stop(&s.id);
    std::thread::sleep(Duration::from_millis(300));
    assert!(!pid_alive(back.pid.unwrap()), "stop deja el ssh vivo");
    let hold = TcpListener::bind(("127.0.0.1", up.local_port)).unwrap();
    let s2 = m.start(FwdReq { dest: d.clone(), remote_port: 8765, local_port: None }).unwrap();
    let up2 = wait_for(&m, &s2.id, 30, |s| s.state == State::Up);
    eprintln!("con {} ocupado -> local {}", up.local_port, up2.local_port);
    assert_ne!(up2.local_port, up.local_port);
    assert!(http_get(up2.local_port).starts_with("HTTP/1.0 200"));
    drop(hold);

    // Puerto remoto sin nadie: el túnel sube (ssh no lo sabe hasta conectar) pero la petición no llega a nada.
    let s3 = m.start(FwdReq { dest: d.clone(), remote_port: 8799, local_port: None }).unwrap();
    let up3 = wait_for(&m, &s3.id, 30, |s| s.state == State::Up);
    let r3 = http_get(up3.local_port);
    eprintln!("remoto 8799 sin servidor: respuesta de {} bytes", r3.len());
    assert!(r3.is_empty());

    // Salir: ningún ssh queda vivo.
    let pids: Vec<u32> = m.list().iter().filter_map(|s| s.pid).collect();
    m.shutdown();
    std::thread::sleep(Duration::from_millis(500));
    for p in &pids {
        assert!(!pid_alive(*p), "ssh {p} huérfano");
    }
    eprintln!("shutdown: {} ssh cerrados, 0 vivos", pids.len());
}

