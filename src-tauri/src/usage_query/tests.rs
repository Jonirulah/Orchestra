//! Pruebas de la consulta de uso. REGLAS: ninguna toca credenciales reales (todo son ficheros
//! `.credentials.json` falsos en carpetas temporales) y ninguna sale a Internet: el destino
//! de cada prueba es un servidor falso en 127.0.0.1. `USAGE_URL` solo se compara, nunca se usa.

use super::*;
use std::io::Write;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const NOW: f64 = 1_800_000_000.0;
const TOKEN: &str = "sk-ant-oat01-CANARY-TOKEN-0123456789";
const REFRESH: &str = "sk-ant-ort01-CANARY-REFRESH-9876543210";
const FIVE: &str = r#"{"five_hour":{"utilization":62.4,"resets_at":"2027-01-15T10:00:00+00:00"},"seven_day":{"utilization":31,"resets_at":"2027-01-19T10:00:00Z"}}"#;

// ---------- ayudas ----------

fn tmpdir(tag: &str) -> PathBuf {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let d = std::env::temp_dir().join(format!("orchestra-uq-{tag}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn creds_json(token: &str, expires_ms: f64) -> String {
    format!(r#"{{"claudeAiOauth":{{"accessToken":"{token}","refreshToken":"{REFRESH}","expiresAt":{expires_ms:.0},"scopes":["user:inference"]}}}}"#)
}

/// (carpeta de datos, carpeta de la cuenta) con credenciales FALSAS que caducan en `ttl` s.
fn fixture(tag: &str, ttl: f64) -> (PathBuf, PathBuf) {
    let root = tmpdir(tag);
    let base = root.join("data");
    let acct = root.join("acct");
    std::fs::create_dir_all(&base).unwrap();
    std::fs::create_dir_all(&acct).unwrap();
    std::fs::write(acct.join(CREDS_FILE), creds_json(TOKEN, (NOW + ttl) * 1000.0)).unwrap();
    (base, acct)
}

fn acct_in(id: &str, dir: &Path) -> AccountIn {
    AccountIn { id: id.into(), dir: dir.to_string_lossy().into_owned() }
}

fn env<'a>(base: &'a Path, url: &'a str) -> Env<'a> {
    Env { base, url, connect: Duration::from_secs(2), total: Duration::from_secs(3), spacing: Duration::ZERO, force: false, renewer: None }
}

/// Lee todos los ficheros bajo `dir` (texto) para buscar el token.
fn all_text(dir: &Path) -> String {
    let mut out = String::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                out += &all_text(&p);
            } else if p.file_name().is_some_and(|n| n != CREDS_FILE) {
                out += &String::from_utf8_lossy(&std::fs::read(&p).unwrap_or_default());
            }
        }
    }
    out
}

/// El token (ni el de refresco) no aparece en el resultado (Debug y JSON) ni en los ficheros escritos.
fn assert_clean(r: &UsageResult, base: &Path) {
    let dbg = format!("{r:?}");
    let js = serde_json::to_string(r).unwrap();
    let files = all_text(base);
    for (what, text) in [("Debug", &dbg), ("JSON", &js), ("files", &files)] {
        assert!(!text.contains("CANARY"), "token canary leaked in {what}: {text}");
    }
}

fn go(url: &str, base: &Path, acct: &AccountIn, tracker: &Tracker, now: f64) -> UsageResult {
    let (r, _) = fetch_one(&env(base, url), tracker, acct, 5, now);
    assert_clean(&r, base);
    r
}

// ---------- servidor falso (loopback) ----------

#[derive(Clone)]
struct Reply {
    status: u16,
    headers: String,
    body: Vec<u8>,
    delay: Duration,
}
fn reply(status: u16, body: &str) -> Reply {
    Reply { status, headers: String::new(), body: body.as_bytes().to_vec(), delay: Duration::ZERO }
}

struct Fake {
    port: u16,
    hits: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
}
impl Fake {
    /// Responde con `replies[i]` a la petición i (la última se repite).
    fn start(replies: Vec<Reply>) -> Fake {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.set_nonblocking(true).unwrap();
        let port = l.local_addr().unwrap().port();
        let hits: Arc<Mutex<Vec<String>>> = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let (h2, s2) = (hits.clone(), stop.clone());
        std::thread::spawn(move || {
            while !s2.load(Ordering::Relaxed) {
                let Ok((mut sock, _)) = l.accept() else {
                    std::thread::sleep(Duration::from_millis(3));
                    continue;
                };
                sock.set_nonblocking(false).ok();
                sock.set_read_timeout(Some(Duration::from_secs(2))).ok();
                let mut head = Vec::new();
                let mut b = [0u8; 1024];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut b) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => head.extend_from_slice(&b[..n]),
                    }
                }
                let idx = {
                    let mut h = h2.lock().unwrap();
                    h.push(String::from_utf8_lossy(&head).into_owned());
                    h.len() - 1
                };
                let rp = replies[idx.min(replies.len() - 1)].clone();
                std::thread::spawn(move || {
                    std::thread::sleep(rp.delay);
                    let head = format!("HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n", rp.status, rp.body.len(), rp.headers);
                    let _ = sock.write_all(head.as_bytes());
                    let _ = sock.write_all(&rp.body);
                });
            }
        });
        Fake { port, hits, stop }
    }
    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/api/oauth/usage", self.port)
    }
    fn count(&self) -> usize {
        self.hits.lock().unwrap().len()
    }
}
impl Drop for Fake {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

// ---------- destino ----------

#[test]
fn default_url_is_the_hardcoded_https_endpoint() {
    assert_eq!(resolve_url(None).unwrap(), "https://api.anthropic.com/api/oauth/usage");
    assert_eq!(resolve_url(Some("")).unwrap(), USAGE_URL);
    assert_eq!(resolve_url(Some("   ")).unwrap(), USAGE_URL);
}

#[test]
fn loopback_override_accepted_everything_else_rejected() {
    for ok in ["http://127.0.0.1:8080/x", "http://localhost:1/api/oauth/usage", "http://127.0.0.1:65000", "http://localhost:80?a=b"] {
        assert_eq!(resolve_url(Some(ok)).unwrap(), ok, "{ok}");
    }
    for bad in [
        "https://example.com/usage",
        "https://127.0.0.1:8080/x", // https a loopback: no se admite (solo http plano local)
        "http://example.com:80/x",
        "http://127.0.0.1/x", // sin puerto
        "http://127.0.0.1.evil.com:80/x",
        "http://127.0.0.1:80@evil.com/x",
        "http://evil.com:80@127.0.0.1:80/",
        "http://localhost.evil.com:80/",
        "http://127.0.0.1:80\\@evil.com/",
        "http://127.0.0.1:abc/",
        "http://127.0.0.1: 80/",
        "http://[::1]:80/",
        "http://0.0.0.0:80/",
        "http://192.168.1.2:80/",
        "ftp://127.0.0.1:80/",
        "127.0.0.1:80",
        "http://127.0.0.1:80/\nHost: evil",
    ] {
        assert!(resolve_url(Some(bad)).is_err(), "{bad:?} debería rechazarse");
    }
}

#[test]
fn non_loopback_destination_sends_nothing() {
    // Aunque alguien construya un Env con un destino ajeno, http_get se niega (y no hay red de por medio).
    let (base, acct) = fixture("blocked", 3600.0);
    let spy = Fake::start(vec![reply(200, FIVE)]);
    let tr = Tracker::default();
    let r = go("http://example.invalid:80/api/oauth/usage", &base, &acct_in("a1", &acct), &tr, NOW);
    assert_eq!(r.status, Status::Error);
    assert_eq!(r.message.as_deref(), Some("request destination not allowed"));
    assert_eq!(spy.count(), 0);
}

// ---------- lector de la respuesta ----------

fn p(body: &str) -> Option<Parsed> {
    parse_usage(body.as_bytes(), NOW)
}
fn w(used: f64, resets_at: f64) -> Option<Window> {
    Some(Window { used, resets_at })
}
#[test]
fn iso_parser_matches_known_epochs() {
    assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0.0));
    assert_eq!(parse_iso("2000-03-01T00:00:00Z"), Some(951_868_800.0));
    assert_eq!(parse_iso("2024-02-29T12:30:45Z"), Some(1_709_209_845.0)); // bisiesto
    assert_eq!(parse_iso("2026-11-06T18:30:00.123456+00:00"), Some(1_793_989_800.0));
    assert_eq!(parse_iso("2026-11-06T20:30:00+02:00"), Some(1_793_989_800.0));
    assert_eq!(parse_iso("2026-11-06T20:30:00+0200"), Some(1_793_989_800.0));
    assert_eq!(parse_iso("2026-11-06T14:00:00-04:30"), Some(1_793_989_800.0));
    assert_eq!(parse_iso("2026-11-06 18:30:00"), Some(1_793_989_800.0)); // sin zona = UTC
    assert_eq!(parse_iso("2026-11-06"), Some(1_793_923_200.0));
    for bad in ["", "garbage", "2026-13-01T00:00:00Z", "2026-11-06T25:00:00Z", "2026-11-06T10:00:00Zjunk", "2026-11-06T10:00:00+25:00", "2026/11/06", "20261106T100000Z", "2026-11-06T10"] {
        assert_eq!(parse_iso(bad), None, "{bad:?}");
    }
}

#[test]
fn flat_shape_with_iso_strings() {
    let r = p(FIVE).unwrap();
    let f = r.five_hour.unwrap();
    let s = r.seven_day.unwrap();
    assert_eq!(f.used, 62.4);
    assert_eq!(f.resets_at, parse_iso("2027-01-15T10:00:00+00:00").unwrap());
    assert_eq!(s.used, 31.0);
    assert_eq!(s.resets_at, parse_iso("2027-01-19T10:00:00Z").unwrap());
}

#[test]
fn epoch_seconds_millis_and_numeric_strings() {
    let r = p(r#"{"five_hour":{"utilization":"12.5","resets_at":1800003600},"seven_day":{"utilization":3,"resets_at":"1800086400123"}}"#).unwrap();
    assert_eq!(r.five_hour, w(12.5, 1_800_003_600.0));
    assert_eq!(r.seven_day, w(3.0, 1_800_086_400.0)); // ms en texto
    let ms = p(r#"{"five_hour":{"utilization":1,"resets_at":1800003600999}}"#).unwrap();
    assert_eq!(ms.five_hour, w(1.0, 1_800_003_600.0));
}

#[test]
fn utilization_is_a_percentage_fraction_fields_are_scaled() {
    // `utilization` 0..100 siempre: 0,5 es 0,5 %, no 50 %.
    assert_eq!(p(r#"{"five_hour":{"utilization":0.5,"resets_at":1800003600}}"#).unwrap().five_hour, w(0.5, 1_800_003_600.0));
    assert_eq!(p(r#"{"five_hour":{"utilization":1,"resets_at":1800003600}}"#).unwrap().five_hour, w(1.0, 1_800_003_600.0));
    // Un campo con otro nombre sí es fracción.
    assert_eq!(p(r#"{"five_hour":{"fraction":0.5,"resets_at":1800003600}}"#).unwrap().five_hour, w(50.0, 1_800_003_600.0));
    assert_eq!(p(r#"{"five_hour":{"ratio":"0.25","resets_at":1800003600}}"#).unwrap().five_hour, w(25.0, 1_800_003_600.0));
    // Recorte.
    assert_eq!(p(r#"{"five_hour":{"utilization":250,"resets_at":1800003600}}"#).unwrap().five_hour.unwrap().used, 100.0);
    assert_eq!(p(r#"{"five_hour":{"utilization":-4,"resets_at":1800003600}}"#).unwrap().five_hour.unwrap().used, 0.0);
    assert_eq!(p(r#"{"five_hour":{"used_percentage":40,"resets_at":1800003600}}"#).unwrap().five_hour.unwrap().used, 40.0);
}

#[test]
fn null_windows_are_absent_and_unknown_keys_ignored() {
    let r = p(r#"{"five_hour":null,"seven_day":{"utilization":10,"resets_at":1800003600},"seven_day_opus":{"utilization":99,"resets_at":1800003600},"seven_day_sonnet":null,"extra_usage":{"is_enabled":false}}"#).unwrap();
    assert!(r.five_hour.is_none());
    assert_eq!(r.seven_day, w(10.0, 1_800_003_600.0));
    // seven_day_opus no se confunde con seven_day
    assert!(p(r#"{"seven_day_opus":{"utilization":99,"resets_at":1800003600}}"#).is_none());
    assert!(p(r#"{"five_hour":null,"seven_day":null}"#).is_none());
}

#[test]
fn missing_reset_zero_use_is_unstarted_window_nonzero_is_dropped() {
    let r = p(r#"{"five_hour":{"utilization":0.0,"resets_at":null},"seven_day":{"utilization":20,"resets_at":null}}"#).unwrap();
    assert_eq!(r.five_hour, w(0.0, NOW)); // ya «renovada»: la interfaz la pinta al 0 %
    assert!(r.seven_day.is_none());
}

#[test]
fn limits_array_shapes() {
    // lista con `name`
    let a = p(r#"{"limits":[{"name":"five_hour","utilization":55,"resets_at":1800003600},{"name":"seven_day","utilization":12,"resets_at":"2027-01-15T10:00:00Z"},{"name":"seven_day_opus","utilization":99,"resets_at":1800003600}]}"#).unwrap();
    assert_eq!(a.five_hour, w(55.0, 1_800_003_600.0));
    assert_eq!(a.seven_day.unwrap().used, 12.0);
    // lista con `type`, nombres alternativos y fracción
    let b = p(r#"{"limits":[{"type":"5h","fraction":0.4,"resets_at":1800003600},{"type":"Seven-Day","used_percentage":"7","reset_at":1800086400}]}"#).unwrap();
    assert_eq!(b.five_hour, w(40.0, 1_800_003_600.0));
    assert_eq!(b.seven_day, w(7.0, 1_800_086_400.0));
    // mapa
    let c = p(r#"{"limits":{"five_hour":{"utilization":5,"resets_at":1800003600},"weekly":{"utilization":6,"resets_at":1800086400}}}"#).unwrap();
    assert_eq!(c.five_hour, w(5.0, 1_800_003_600.0));
    assert_eq!(c.seven_day, w(6.0, 1_800_086_400.0));
    // el nivel superior manda sobre `limits`
    let d = p(r#"{"five_hour":{"utilization":1,"resets_at":1800003600},"limits":[{"name":"five_hour","utilization":99,"resets_at":1800003600},{"name":"seven_day","utilization":2,"resets_at":1800086400}]}"#).unwrap();
    assert_eq!(d.five_hour.unwrap().used, 1.0);
    assert_eq!(d.seven_day.unwrap().used, 2.0);
    // elementos raros no rompen nada
    assert!(p(r#"{"limits":[1,null,"x",{"name":5},{"name":"five_hour"}]}"#).is_none());
    assert!(p(r#"{"limits":"nope"}"#).is_none());
}

#[test]
fn garbage_is_none() {
    for g in ["", "   ", "<html><body>502 Bad Gateway</body></html>", "not json {", "[1,2]", "42", "null", "\"x\"", "{}", "{\"five_hour\":", "{\"five_hour\":{\"utilization\":\"x\",\"resets_at\":5}}"] {
        assert!(p(g).is_none(), "{g:?}");
    }
    assert!(parse_usage(&[0xff, 0xfe, 0x00, 0x01], NOW).is_none());
    assert!(parse_usage("\u{feff}{\"five_hour\":{\"utilization\":5,\"resets_at\":1800003600}}".as_bytes(), NOW).is_some());
}

// ---------- credenciales ----------

fn token_of(dir: &Path, now: f64) -> Result<String, Status> {
    read_token(&dir.to_string_lossy(), now).map(|s| s.expose().to_string()).map_err(|e| e.0)
}

#[test]
fn valid_credentials_give_the_token_and_it_never_prints() {
    let (_, acct) = fixture("cred-ok", 3600.0);
    let s = read_token(&acct.to_string_lossy(), NOW).unwrap();
    assert_eq!(s.expose(), TOKEN);
    assert_eq!(format!("{s:?}"), "***");
    assert_eq!(format!("{s}"), "***");
    assert_eq!(format!("{:?}", Some(&s)), "Some(***)");
}

#[test]
fn expired_and_within_margin_are_expired_not_sent() {
    let (_, a) = fixture("cred-exp", -10.0);
    assert_eq!(token_of(&a, NOW), Err(Status::Expired));
    let (_, a) = fixture("cred-60", 59.0);
    assert_eq!(token_of(&a, NOW), Err(Status::Expired));
    let (_, a) = fixture("cred-60b", 60.0);
    assert_eq!(token_of(&a, NOW), Err(Status::Expired));
    let (_, a) = fixture("cred-61", 61.0);
    assert!(token_of(&a, NOW).is_ok());
    // expiresAt en segundos (no en ms) también se entiende
    let (_, a) = fixture("cred-secs", 3600.0);
    std::fs::write(a.join(CREDS_FILE), creds_json(TOKEN, NOW + 30.0)).unwrap();
    assert_eq!(token_of(&a, NOW), Err(Status::Expired));
    std::fs::write(a.join(CREDS_FILE), creds_json(TOKEN, NOW + 600.0)).unwrap();
    assert!(token_of(&a, NOW).is_ok());
}

#[test]
fn missing_malformed_or_incomplete_credentials_are_nocreds() {
    let (_, a) = fixture("cred-bad", 3600.0);
    let f = a.join(CREDS_FILE);
    for (name, content) in [
        ("malformed", "{ not json".to_string()),
        ("empty", String::new()),
        ("array", "[1]".into()),
        ("no oauth", r#"{"other":1}"#.into()),
        ("no token", r#"{"claudeAiOauth":{"expiresAt":1900000000000}}"#.into()),
        ("no expiry", r#"{"claudeAiOauth":{"accessToken":"abc"}}"#.into()),
        ("empty token", r#"{"claudeAiOauth":{"accessToken":"","expiresAt":1900000000000}}"#.into()),
        ("token with newline", r#"{"claudeAiOauth":{"accessToken":"ab\ncd","expiresAt":1900000000000}}"#.into()),
        ("token with space", r#"{"claudeAiOauth":{"accessToken":"ab cd","expiresAt":1900000000000}}"#.into()),
        ("token not string", r#"{"claudeAiOauth":{"accessToken":5,"expiresAt":1900000000000}}"#.into()),
        ("expiry not number", r#"{"claudeAiOauth":{"accessToken":"abc","expiresAt":"soon"}}"#.into()),
        ("expiry zero", r#"{"claudeAiOauth":{"accessToken":"abc","expiresAt":0}}"#.into()),
    ] {
        std::fs::write(&f, content).unwrap();
        assert_eq!(token_of(&a, NOW), Err(Status::Nocreds), "{name}");
    }
    std::fs::remove_file(&f).unwrap();
    assert_eq!(token_of(&a, NOW), Err(Status::Nocreds), "missing file");
    assert_eq!(token_of(&a.join("no-such-dir"), NOW), Err(Status::Nocreds));
    // `.credentials.json` como carpeta
    std::fs::create_dir(&f).unwrap();
    assert_eq!(token_of(&a, NOW), Err(Status::Nocreds), "creds is a dir");
}

#[test]
fn huge_credentials_file_is_refused() {
    let (_, a) = fixture("cred-huge", 3600.0);
    let pad = "x".repeat(200_000);
    std::fs::write(a.join(CREDS_FILE), format!(r#"{{"pad":"{pad}","claudeAiOauth":{{"accessToken":"{TOKEN}","expiresAt":1900000000000}}}}"#)).unwrap();
    assert_eq!(token_of(&a, NOW), Err(Status::Nocreds));
}

#[test]
fn path_traversal_and_odd_dirs_are_refused() {
    let (_, a) = fixture("cred-trav", 3600.0);
    let root = a.parent().unwrap();
    // `..` que SÍ resolvería a la carpeta buena: solo la regla léxica lo frena.
    std::fs::create_dir_all(root.join("zzz")).unwrap();
    let sneaky = root.join("zzz").join("..").join("acct");
    assert!(std::fs::canonicalize(&sneaky).is_ok());
    assert_eq!(token_of(&sneaky, NOW), Err(Status::Nocreds), "con ..");
    let s2 = format!("{}/..", a.to_string_lossy());
    assert_eq!(read_token(&s2, NOW).map(|_| ()).map_err(|e| e.0), Err(Status::Nocreds));
    for bad in ["", "relative/dir", ".", "..", "\0", &"a".repeat(2000)] {
        assert_eq!(read_token(bad, NOW).map(|_| ()).map_err(|e| e.0), Err(Status::Nocreds), "{bad:?}");
    }
}

#[test]
fn containment_requires_the_file_directly_inside_the_dir() {
    let a = tmpdir("contain-a");
    let b = tmpdir("contain-b");
    std::fs::write(a.join(CREDS_FILE), "{}").unwrap();
    std::fs::write(b.join(CREDS_FILE), "{}").unwrap();
    let (ca, cb) = (std::fs::canonicalize(&a).unwrap(), std::fs::canonicalize(&b).unwrap());
    assert!(contained(&ca, &std::fs::canonicalize(a.join(CREDS_FILE)).unwrap()));
    assert!(!contained(&ca, &std::fs::canonicalize(b.join(CREDS_FILE)).unwrap()));
    assert!(!contained(&ca, &cb));
    std::fs::create_dir(a.join("sub")).unwrap();
    std::fs::write(a.join("sub").join(CREDS_FILE), "{}").unwrap();
    assert!(!contained(&ca, &std::fs::canonicalize(a.join("sub").join(CREDS_FILE)).unwrap()));
}

#[test]
fn credentials_symlink_pointing_outside_is_refused() {
    let (_, a) = fixture("cred-link", 3600.0);
    let outside = tmpdir("cred-link-out");
    std::fs::write(outside.join("elsewhere.json"), creds_json(TOKEN, (NOW + 3600.0) * 1000.0)).unwrap();
    let link = a.join(CREDS_FILE);
    std::fs::remove_file(&link).unwrap();
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(outside.join("elsewhere.json"), &link);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(outside.join("elsewhere.json"), &link);
    match made {
        Ok(()) => assert_eq!(token_of(&a, NOW), Err(Status::Nocreds), "el enlace a otra carpeta no se sigue"),
        // Sin privilegio para enlaces (Windows sin modo desarrollador): la lógica queda cubierta por `containment_requires...`.
        Err(e) => eprintln!("NOTA: no se pudo crear el enlace simbólico ({e}); prueba cubierta solo por la de contención"),
    }
}

// ---------- extremo a extremo con el servidor falso ----------

#[test]
fn ok_flat_shape_sends_exact_request_and_writes_quota() {
    let (base, acct) = fixture("e2e-ok", 3600.0);
    let srv = Fake::start(vec![reply(200, FIVE)]);
    let tr = Tracker::default();
    let r = go(&srv.url(), &base, &acct_in("acc-1", &acct), &tr, NOW);
    assert_eq!(r.status, Status::Ok, "{r:?}");
    assert_eq!(r.account_id, "acc-1");
    assert_eq!(r.fetched_at, NOW);
    assert_eq!(r.five_hour.as_ref().unwrap().used, 62.4);
    assert_eq!(r.seven_day.as_ref().unwrap().used, 31.0);
    assert_eq!(srv.count(), 1);
    let head = srv.hits.lock().unwrap()[0].clone();
    let lines: Vec<&str> = head.split("\r\n").collect();
    assert_eq!(lines[0], "GET /api/oauth/usage HTTP/1.1");
    let hdr = |name: &str| lines.iter().find_map(|l| l.to_ascii_lowercase().strip_prefix(&format!("{name}: ")).map(|_| l.split_once(": ").unwrap().1.to_string()));
    assert_eq!(hdr("authorization").as_deref(), Some(format!("Bearer {TOKEN}").as_str()));
    assert_eq!(hdr("anthropic-beta").as_deref(), Some("oauth-2025-04-20"));
    assert_eq!(hdr("user-agent").as_deref(), Some(format!("Orchestra/{}", env!("CARGO_PKG_VERSION")).as_str()));
    assert_eq!(hdr("accept").as_deref(), Some("application/json"));
    assert!(!head.contains(REFRESH), "el token de refresco no sale jamás");
    // Lo mismo que lee la interfaz con quota_read.
    let q = crate::quota::read_dir(&base.join("quota"));
    assert_eq!(q.len(), 1);
    assert_eq!(q[0].account_id, "acc-1");
    assert_eq!(q[0].quota.five_hour.as_ref().unwrap().used, 62.4);
    assert_eq!(q[0].quota.seven_day.as_ref().unwrap().used, 31.0);
    assert_eq!(q[0].quota.at, Some(NOW));
    // volcado crudo: solo el cuerpo
    let raw = std::fs::read_to_string(base.join("quota").join("acc-1.query-raw.txt")).unwrap();
    assert_eq!(raw, FIVE);
}

#[test]
fn merge_keeps_the_other_window_from_the_statusline() {
    let (base, acct) = fixture("e2e-merge", 3600.0);
    std::fs::create_dir_all(base.join("quota")).unwrap();
    std::fs::write(base.join("quota").join("m1.json"), r#"{"fiveHour":{"used":90,"resetsAt":1800000500},"sevenDay":{"used":40,"resetsAt":1800086400},"at":5}"#).unwrap();
    let srv = Fake::start(vec![reply(200, r#"{"five_hour":{"utilization":11,"resets_at":1800003600},"seven_day":null}"#)]);
    let r = go(&srv.url(), &base, &acct_in("m1", &acct), &Tracker::default(), NOW);
    assert_eq!(r.status, Status::Ok);
    assert!(r.seven_day.is_none());
    let q = crate::quota::read_dir(&base.join("quota"));
    assert_eq!(q[0].quota.five_hour, w(11.0, 1_800_003_600.0));
    assert_eq!(q[0].quota.seven_day, w(40.0, 1_800_086_400.0), "la ventana de 7 d que no llegó se conserva");
    assert_eq!(q[0].quota.at, Some(NOW));
    // sin restos temporales
    let names: Vec<String> = std::fs::read_dir(base.join("quota")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert!(names.iter().all(|n| n.ends_with(".json") || n.ends_with(".query-raw.txt")), "{names:?}");
}

#[test]
fn limits_array_response_end_to_end() {
    let (base, acct) = fixture("e2e-limits", 3600.0);
    let srv = Fake::start(vec![reply(200, r#"{"limits":[{"name":"five_hour","utilization":70,"resets_at":1800003600},{"name":"seven_day","utilization":20,"resets_at":1800086400}],"extra_usage":null}"#)]);
    let r = go(&srv.url(), &base, &acct_in("l1", &acct), &Tracker::default(), NOW);
    assert_eq!(r.status, Status::Ok);
    assert_eq!(r.five_hour, w(70.0, 1_800_003_600.0));
}

#[test]
fn expired_token_sends_zero_requests() {
    let srv = Fake::start(vec![reply(200, FIVE)]);
    for (tag, ttl) in [("zero-exp", -3600.0), ("zero-30", 30.0), ("zero-60", 60.0)] {
        let (base, acct) = fixture(tag, ttl);
        let r = go(&srv.url(), &base, &acct_in("z1", &acct), &Tracker::default(), NOW);
        assert_eq!(r.status, Status::Expired, "{tag}");
        assert!(r.five_hour.is_none());
        assert!(!base.join("quota").exists(), "no se escribe nada");
    }
    assert_eq!(srv.count(), 0, "caducado o a menos de 60 s: no llega NI UNA petición");
    // Justo por encima del margen sí se envía.
    let (base, acct) = fixture("zero-61", 61.0);
    assert_eq!(go(&srv.url(), &base, &acct_in("z1", &acct), &Tracker::default(), NOW).status, Status::Ok);
    assert_eq!(srv.count(), 1);
}

#[test]
fn no_creds_sends_zero_requests() {
    let srv = Fake::start(vec![reply(200, FIVE)]);
    let (base, acct) = fixture("zero-nocreds", 3600.0);
    std::fs::remove_file(acct.join(CREDS_FILE)).unwrap();
    assert_eq!(go(&srv.url(), &base, &acct_in("n1", &acct), &Tracker::default(), NOW).status, Status::Nocreds);
    assert_eq!(srv.count(), 0);
}

#[test]
fn traversal_dir_sends_zero_requests() {
    let srv = Fake::start(vec![reply(200, FIVE)]);
    let (base, acct) = fixture("zero-trav", 3600.0);
    let root = acct.parent().unwrap();
    std::fs::create_dir_all(root.join("zzz")).unwrap();
    let sneaky = root.join("zzz").join("..").join("acct");
    let r = go(&srv.url(), &base, &acct_in("t1", &sneaky), &Tracker::default(), NOW);
    assert_eq!(r.status, Status::Nocreds);
    assert_eq!(srv.count(), 0, "una carpeta con `..` no llega a abrirse");
}

#[test]
fn http_errors_map_to_statuses() {
    for (code, want) in [(401, Status::Unauthorized), (403, Status::Unauthorized), (429, Status::RateLimited), (500, Status::Error), (503, Status::Error), (404, Status::Error), (418, Status::Error)] {
        let (base, acct) = fixture(&format!("e2e-{code}"), 3600.0);
        let srv = Fake::start(vec![reply(code, r#"{"error":"x"}"#)]);
        let r = go(&srv.url(), &base, &acct_in("h1", &acct), &Tracker::default(), NOW);
        assert_eq!(r.status, want, "HTTP {code}");
        assert!(r.five_hour.is_none());
        assert!(!base.join("quota").join("h1.json").exists(), "un error no escribe cuota");
    }
}

#[test]
fn error_body_that_echoes_the_token_is_redacted_in_the_raw_dump() {
    let (base, acct) = fixture("e2e-echo", 3600.0);
    let srv = Fake::start(vec![reply(401, &format!(r#"{{"error":"invalid bearer {TOKEN} !"}}"#))]);
    let r = go(&srv.url(), &base, &acct_in("e1", &acct), &Tracker::default(), NOW);
    assert_eq!(r.status, Status::Unauthorized);
    let raw = std::fs::read_to_string(base.join("quota").join("e1.query-raw.txt")).unwrap();
    assert!(raw.contains("***") && !raw.contains("CANARY"), "{raw}");
}

#[test]
fn garbage_bodies_are_generic_errors() {
    for (i, body) in ["<html><h1>Bad gateway</h1></html>", "", "null", "[]", "{\"hello\":1}", "\u{1}\u{2}binary"].into_iter().enumerate() {
        let (base, acct) = fixture(&format!("e2e-garb{i}"), 3600.0);
        let srv = Fake::start(vec![reply(200, body)]);
        let r = go(&srv.url(), &base, &acct_in("g1", &acct), &Tracker::default(), NOW);
        assert_eq!(r.status, Status::Error, "{body:?}");
        assert_eq!(r.message.as_deref(), Some("unrecognized response"));
        assert!(!r.message.as_deref().unwrap().contains(body) || body.is_empty());
    }
}

#[test]
fn huge_body_is_capped_and_not_parsed() {
    let (base, acct) = fixture("e2e-huge", 3600.0);
    // JSON válido de ~300 KB cuyo contenido útil está al final: con tope, el cuerpo queda cortado.
    let body = format!(r#"{{"pad":"{}","five_hour":{{"utilization":5,"resets_at":1800003600}}}}"#, "x".repeat(300_000));
    let srv = Fake::start(vec![reply(200, &body)]);
    let r = go(&srv.url(), &base, &acct_in("big", &acct), &Tracker::default(), NOW);
    assert_eq!(r.status, Status::Error);
    assert_eq!(r.message.as_deref(), Some("response too large"));
    let raw = std::fs::read(base.join("quota").join("big.query-raw.txt")).unwrap();
    assert!(raw.len() <= MAX_RAW, "volcado de {} bytes", raw.len());
    assert!(!base.join("quota").join("big.json").exists());
}

#[test]
fn slow_response_times_out() {
    let (base, acct) = fixture("e2e-slow", 3600.0);
    let mut slow = reply(200, FIVE);
    slow.delay = Duration::from_secs(3);
    let srv = Fake::start(vec![slow]);
    let url = srv.url();
    let e = Env { connect: Duration::from_millis(500), total: Duration::from_millis(400), ..env(&base, &url) };
    let t0 = std::time::Instant::now();
    let tr = Tracker::default();
    let (r, requested) = fetch_one(&e, &tr, &acct_in("s1", &acct), 5, NOW);
    assert!(t0.elapsed() < Duration::from_millis(2500), "tardó {:?}", t0.elapsed());
    assert!(requested);
    assert_eq!(r.status, Status::Error);
    assert_eq!(r.message.as_deref(), Some("network error or timeout"));
    assert_clean(&r, &base);
    // y cuenta como fallo: espera antes de reintentar
    assert!(tr.0.lock().unwrap().get("s1").unwrap().skip_until > NOW);
}

#[test]
fn connection_refused_is_a_generic_error() {
    let (base, acct) = fixture("e2e-refused", 3600.0);
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port(); // se cierra al salir de la línea
    let r = go(&format!("http://127.0.0.1:{port}/x"), &base, &acct_in("c1", &acct), &Tracker::default(), NOW);
    assert_eq!(r.status, Status::Error);
}

#[test]
fn redirects_are_never_followed() {
    let (base, acct) = fixture("e2e-redir", 3600.0);
    let target = Fake::start(vec![reply(200, FIVE)]);
    let mut redirect = reply(302, "");
    redirect.headers = format!("Location: http://127.0.0.1:{}/stolen\r\n", target.port);
    let srv = Fake::start(vec![redirect.clone()]);
    let r = go(&srv.url(), &base, &acct_in("r1", &acct), &Tracker::default(), NOW);
    assert_eq!(r.status, Status::Error);
    assert_eq!(r.message.as_deref(), Some("redirect not followed"));
    assert_eq!(srv.count(), 1);
    assert_eq!(target.count(), 0, "el token no se reenvía a la URL de la redirección");
    for code in [301, 303, 307, 308] {
        let mut rd = redirect.clone();
        rd.status = code;
        let s2 = Fake::start(vec![rd]);
        let (b2, a2) = fixture(&format!("e2e-redir{code}"), 3600.0);
        assert_eq!(go(&s2.url(), &b2, &acct_in("r1", &a2), &Tracker::default(), NOW).status, Status::Error);
    }
    assert_eq!(target.count(), 0);
}

#[test]
fn per_account_floor_of_60_seconds() {
    let (base, acct) = fixture("floor", 7200.0);
    let srv = Fake::start(vec![reply(200, FIVE)]);
    let tr = Tracker::default();
    let a = acct_in("f1", &acct);
    let r1 = go(&srv.url(), &base, &a, &tr, NOW);
    assert_eq!(srv.count(), 1);
    let r2 = go(&srv.url(), &base, &a, &tr, NOW + 1.0);
    let r3 = go(&srv.url(), &base, &a, &tr, NOW + 59.0);
    assert_eq!(srv.count(), 1, "dentro de 60 s no hay segunda petición");
    assert_eq!(r1, r2);
    assert_eq!(r1, r3);
    // otra cuenta no queda bloqueada por la primera
    let (b2, a2) = fixture("floor2", 7200.0);
    assert_eq!(go(&srv.url(), &b2, &acct_in("f2", &a2), &tr, NOW + 2.0).status, Status::Ok);
    assert_eq!(srv.count(), 2);
    let r4 = go(&srv.url(), &base, &a, &tr, NOW + 61.0);
    assert_eq!(srv.count(), 3);
    assert_eq!(r4.fetched_at, NOW + 61.0);
}

#[test]
fn rate_limit_backs_off_for_twice_the_interval_then_recovers() {
    let (base, acct) = fixture("backoff", 36000.0);
    let srv = Fake::start(vec![reply(429, "{}"), reply(200, FIVE)]);
    let tr = Tracker::default();
    let a = acct_in("b1", &acct);
    let r = go(&srv.url(), &base, &a, &tr, NOW);
    assert_eq!(r.status, Status::RateLimited);
    assert_eq!(srv.count(), 1);
    // intervalo 5 min -> espera 10 min (600 s)
    let r = go(&srv.url(), &base, &a, &tr, NOW + 120.0);
    assert_eq!(r.status, Status::RateLimited, "se devuelve el último estado");
    assert_eq!(srv.count(), 1);
    go(&srv.url(), &base, &a, &tr, NOW + 599.0);
    assert_eq!(srv.count(), 1);
    let r = go(&srv.url(), &base, &a, &tr, NOW + 601.0);
    assert_eq!(r.status, Status::Ok);
    assert_eq!(srv.count(), 2);
    // tras el éxito se olvida la espera
    let st = tr.0.lock().unwrap();
    assert_eq!(st["b1"].fails, 0);
    assert_eq!(st["b1"].skip_until, 0.0);
}

#[test]
fn server_errors_back_off_with_a_30_minute_cap() {
    let (base, acct) = fixture("backoff500", 360000.0);
    let srv = Fake::start(vec![reply(500, "oops")]);
    let tr = Tracker::default();
    let a = acct_in("b5", &acct);
    let mut now = NOW;
    let mut waits = vec![];
    for _ in 0..7 {
        let r = go(&srv.url(), &base, &a, &tr, now);
        assert_eq!(r.status, Status::Error);
        let skip = tr.0.lock().unwrap()["b5"].skip_until;
        waits.push(skip - now);
        now = skip + 1.0;
    }
    assert_eq!(waits[0], 600.0);
    assert_eq!(waits[1], 1200.0);
    assert_eq!(waits[2], 1800.0);
    assert!(waits.iter().all(|w| *w <= 1800.0), "{waits:?}");
    assert_eq!(srv.count(), 7);
    // intervalo mínimo (2 min) -> primera espera 4 min
    let tr2 = Tracker::default();
    let (b2, a2) = fixture("backoff500b", 360000.0);
    let (_, req) = fetch_one(&env(&b2, &srv.url()), &tr2, &acct_in("b6", &a2), 2, NOW);
    assert!(req);
    assert_eq!(tr2.0.lock().unwrap()["b6"].skip_until - NOW, 240.0);
}

#[test]
fn unauthorized_does_not_trigger_backoff_but_respects_the_floor() {
    let (base, acct) = fixture("e2e-401floor", 7200.0);
    let srv = Fake::start(vec![reply(401, "{}")]);
    let tr = Tracker::default();
    let a = acct_in("u1", &acct);
    go(&srv.url(), &base, &a, &tr, NOW);
    go(&srv.url(), &base, &a, &tr, NOW + 30.0);
    assert_eq!(srv.count(), 1);
    go(&srv.url(), &base, &a, &tr, NOW + 61.0);
    assert_eq!(srv.count(), 2);
}

#[test]
fn invalid_account_ids_never_touch_the_disk_or_the_network() {
    let (base, acct) = fixture("ids", 3600.0);
    let srv = Fake::start(vec![reply(200, FIVE)]);
    for id in ["", "../evil", "a/b", "a\\b", "a.b", "x y", &"z".repeat(101)] {
        let r = go(&srv.url(), &base, &acct_in(id, &acct), &Tracker::default(), NOW);
        assert_eq!(r.status, Status::Error, "{id:?}");
    }
    assert_eq!(srv.count(), 0);
    assert!(!base.join("quota").exists());
}

#[test]
fn fetch_all_goes_one_by_one_and_caps_the_list() {
    let (base, a1) = fixture("all1", 3600.0);
    let (_, a2) = fixture("all2", -5.0);
    let srv = Fake::start(vec![reply(200, FIVE)]);
    let accts = vec![acct_in("x1", &a1), acct_in("x2", &a2), acct_in("x3", &a1)];
    let url = srv.url();
    let e = Env { spacing: Duration::from_millis(5), ..env(&base, &url) };
    let out = fetch_all(&e, &Tracker::default(), &accts, 5, || NOW);
    let st: Vec<Status> = out.iter().map(|r| r.status).collect();
    assert_eq!(st, [Status::Ok, Status::Expired, Status::Ok]);
    assert_eq!(srv.count(), 2);
    let many: Vec<AccountIn> = (0..100).map(|i| acct_in(&format!("m{i}"), &a2)).collect();
    assert_eq!(fetch_all(&e, &Tracker::default(), &many, 5, || NOW).len(), MAX_ACCOUNTS);
}

#[test]
fn result_serializes_camel_case_without_nulls() {
    let r = UsageResult { account_id: "a".into(), status: Status::RateLimited, five_hour: w(1.0, 2.0), seven_day: None, fetched_at: 3.0, message: None };
    assert_eq!(serde_json::to_string(&r).unwrap(), r#"{"accountId":"a","status":"rate_limited","fiveHour":{"used":1.0,"resetsAt":2.0},"fetchedAt":3.0}"#);
    for (s, n) in [(Status::Ok, "ok"), (Status::Expired, "expired"), (Status::Nocreds, "nocreds"), (Status::Unauthorized, "unauthorized"), (Status::Error, "error")] {
        assert_eq!(serde_json::to_string(&s).unwrap(), format!("\"{n}\""));
    }
}

// ---------- vigilancia del código fuente ----------

#[test]
fn source_has_no_printing_logging_or_refresh_code() {
    let src = include_str!("../usage_query.rs");
    for bad in ["println!", "eprintln!", "print!(", "eprint!(", "dbg!", "log::", "tracing::", "panic!", "unreachable!", "todo!", "unimplemented!"] {
        assert!(!src.contains(bad), "usage_query.rs no debe contener {bad}");
    }
    for bad in ["refreshToken", "refresh_token", "grant_type", "/oauth/token"] {
        assert!(!src.contains(bad), "Orchestra nunca renueva tokens: {bad}");
    }
    // El token solo se interpola en la cabecera Authorization.
    let uses: Vec<&str> = src.lines().filter(|l| l.contains("expose()")).collect();
    assert_eq!(uses.len(), 2, "{uses:?}"); // la cabecera Authorization y la redacción del volcado
    assert!(uses.iter().any(|l| l.contains("Bearer")));
    // Solo se llama a la red en un sitio.
    assert_eq!(src.matches(".call()").count(), 1);
    assert_eq!(src.matches("https://").count(), src.lines().filter(|l| l.contains("https://")).count());
}

// ---------- forma REAL de la respuesta (vista una vez por el orquestador, cuenta Max 20x, 2026-11-06; valores sin datos personales) ----------

const REAL: &str = r#"{
  "five_hour": null,
  "seven_day": {"utilization": 29.0, "resets_at": "2026-11-13T13:00:00.230794+00:00", "limit_dollars": null, "used_dollars": null, "remaining_dollars": null, "locked_reason": null},
  "seven_day_opus": null, "seven_day_sonnet": null, "seven_day_oauth_apps": null, "seven_day_cowork": null, "seven_day_omelette": null,
  "extra_usage": {"is_enabled": false, "used_credits": null, "currency": null, "disabled_reason": "out_of_credits"},
  "spend": {"anything": [1, 2, 3]},
  "seven_day_breakdown": {"by_model": {"x": 1}},
  "iguana_necktie": null, "tangelo": {"odd": true}, "zxq_vorpal": 17,
  "limits": [
    {"kind": "weekly_all", "group": "weekly", "percent": 29, "severity": "normal", "resets_at": "2026-11-13T13:00:00.230794+00:00", "scope": null, "is_active": false},
    {"kind": "weekly_scoped", "group": "weekly", "percent": 40, "severity": "normal", "resets_at": "2026-11-13T13:00:00.230962+00:00", "scope": {"model": {"id": null, "display_name": "Fable"}, "surface": null}, "is_active": true}
  ]
}"#;

const RESET_REAL: f64 = 1_794_574_800.0; // 2026-11-13T13:00:00Z

fn lim(kind: &str, percent: f64, scope: Option<&str>, active: bool) -> Limit {
    Limit { kind: kind.into(), percent, resets_at: RESET_REAL, scope: scope.map(str::to_string), active }
}

#[test]
fn real_shape_five_hour_null_is_absent_not_zero_and_scoped_limit_is_extra() {
    assert_eq!(parse_iso("2026-11-13T13:00:00Z"), Some(RESET_REAL));
    let r = p(REAL).unwrap();
    assert!(r.five_hour.is_none(), "five_hour null = ventana ausente, no un 0 %");
    assert_eq!(r.seven_day, w(29.0, RESET_REAL));
    // weekly_all es la ventana semanal general (ya viene arriba); weekly_scoped es un extra con el nombre del modelo
    assert_eq!(r.limits, Some(vec![lim("weekly_scoped", 40.0, Some("Fable"), true)]));
}

#[test]
fn real_shape_variant_with_a_five_hour_object() {
    let body = REAL.replace(r#""five_hour": null,"#, r#""five_hour": {"utilization": 62, "resets_at": "2026-11-06T22:30:00.5+00:00"},"#);
    let r = p(&body).unwrap();
    assert_eq!(r.five_hour, w(62.0, parse_iso("2026-11-06T22:30:00Z").unwrap()));
    assert_eq!(r.seven_day, w(29.0, RESET_REAL));
    assert_eq!(r.limits.unwrap().len(), 1);
}

#[test]
fn five_hour_can_come_from_limits_under_unknown_kind_names() {
    for kind in ["five_hour", "session", "session_5h", "five_hour_all", "hourly_session"] {
        let body = format!(r#"{{"five_hour":null,"seven_day":null,"limits":[{{"kind":"{kind}","group":"x","percent":55,"resets_at":1800003600,"scope":null,"is_active":true}}]}}"#);
        let r = p(&body).unwrap();
        assert_eq!(r.five_hour, w(55.0, 1_800_003_600.0), "{kind}");
        assert_eq!(r.limits, Some(vec![]), "{kind}: no es un extra");
    }
    // por `group`
    let r = p(r#"{"limits":[{"kind":"mystery","group":"five_hour","percent":9,"resets_at":1800003600,"scope":null}]}"#).unwrap();
    assert_eq!(r.five_hour, w(9.0, 1_800_003_600.0));
    // con alcance de modelo nunca es la ventana general
    let r = p(r#"{"limits":[{"kind":"session","percent":9,"resets_at":1800003600,"scope":{"model":{"display_name":"Fable"}},"is_active":true}]}"#).unwrap();
    assert!(r.five_hour.is_none());
    assert_eq!(r.limits.unwrap()[0].scope.as_deref(), Some("Fable"));
}

#[test]
fn extras_are_capped_sanitized_and_inactive_by_default() {
    let items: Vec<String> = (0..12)
        .map(|i| format!(r#"{{"kind":"extra_{i}","percent":{},"resets_at":1800003600,"scope":"M{i}"}}"#, i * 5))
        .collect();
    let r = p(&format!(r#"{{"limits":[{}]}}"#, items.join(","))).unwrap();
    let l = r.limits.unwrap();
    assert_eq!(l.len(), 8, "máximo 8");
    assert!(l.iter().all(|x| !x.active), "sin is_active no se asume activo");
    // textos: sin caracteres de control y a 40 caracteres como mucho
    let long = "X".repeat(100);
    let r = p(&format!(r#"{{"limits":[{{"kind":"{long}","percent":1,"resets_at":1800003600,"scope":{{"surface":{{"name":"Bad\u0007Name\n{long}"}}}},"is_active":true}}]}}"#)).unwrap();
    let e = &r.limits.unwrap()[0];
    assert_eq!(e.kind.chars().count(), 40);
    let s = e.scope.as_deref().unwrap();
    assert!(s.chars().count() <= 40 && !s.chars().any(|c| c.is_control()), "{s:?}");
    assert!(s.starts_with("BadName"));
    // límites con porcentaje o fecha imposibles se descartan
    let r = p(r#"{"five_hour":{"utilization":1,"resets_at":1800003600},"limits":[{"kind":"a","percent":"x","resets_at":1800003600},{"kind":"b","percent":50}]}"#).unwrap();
    assert_eq!(r.limits, Some(vec![]));
    // mapa en vez de lista
    let r = p(r#"{"limits":{"weekly_scoped":{"percent":33,"resets_at":1800003600,"scope":{"model":{"display_name":"Fable"}},"is_active":true}}}"#).unwrap();
    assert_eq!(r.limits.unwrap()[0].percent, 33.0);
}

#[test]
fn real_shape_end_to_end_writes_limits_and_no_empty_five_hour() {
    let (base, acct) = fixture("e2e-real", 3600.0);
    let srv = Fake::start(vec![reply(200, REAL)]);
    let r = go(&srv.url(), &base, &acct_in("real1", &acct), &Tracker::default(), NOW);
    assert_eq!(r.status, Status::Ok, "{r:?}");
    assert!(r.five_hour.is_none());
    assert_eq!(r.seven_day, w(29.0, RESET_REAL));
    let text = std::fs::read_to_string(base.join("quota").join("real1.json")).unwrap();
    assert!(!text.contains("fiveHour"), "{text}");
    assert!(text.contains(r#""limits":[{"kind":"weekly_scoped","percent":40.0,"resetsAt":1794574800.0,"scope":"Fable","active":true}]"#), "{text}");
    let q = crate::quota::read_dir(&base.join("quota"));
    assert_eq!(q[0].quota.limits, Some(vec![lim("weekly_scoped", 40.0, Some("Fable"), true)]));
    assert_eq!(q[0].quota.five_hour, None);
    let raw = std::fs::read_to_string(base.join("quota").join("real1.query-raw.txt")).unwrap();
    assert!(raw.starts_with("{\n  \"five_hour\": null"));
}

#[test]
fn query_keeps_existing_limits_when_the_answer_has_none_and_replaces_them_when_it_has() {
    let (base, acct) = fixture("e2e-limits-merge", 360000.0);
    std::fs::create_dir_all(base.join("quota")).unwrap();
    let old = r#"{"fiveHour":{"used":90,"resetsAt":1800000500},"limits":[{"kind":"weekly_scoped","percent":77,"resetsAt":1794574800,"scope":"Old","active":true}],"at":5}"#;
    std::fs::write(base.join("quota").join("k1.json"), old).unwrap();
    let srv = Fake::start(vec![
        reply(200, r#"{"seven_day":{"utilization":4,"resets_at":1800086400}}"#), // sin `limits`: se conservan
        reply(200, REAL),                                                          // con `limits`: sustituyen
        reply(200, r#"{"seven_day":{"utilization":4,"resets_at":1800086400},"limits":[]}"#), // vacíos: se borran
    ]);
    let tr = Tracker::default();
    let a = acct_in("k1", &acct);
    go(&srv.url(), &base, &a, &tr, NOW);
    let q = crate::quota::read_dir(&base.join("quota"));
    assert_eq!(q[0].quota.limits.as_ref().unwrap()[0].scope.as_deref(), Some("Old"));
    assert_eq!(q[0].quota.five_hour, w(90.0, 1_800_000_500.0), "la ventana de 5 h del envoltorio también se conserva");
    go(&srv.url(), &base, &a, &tr, NOW + 61.0);
    let q = crate::quota::read_dir(&base.join("quota"));
    assert_eq!(q[0].quota.limits, Some(vec![lim("weekly_scoped", 40.0, Some("Fable"), true)]));
    go(&srv.url(), &base, &a, &tr, NOW + 122.0);
    let q = crate::quota::read_dir(&base.join("quota"));
    assert_eq!(q[0].quota.limits, None);
}

// ---------- renovar con Claude Code y consulta forzada (botón de refrescar) ----------

/// Renovador falso: cuenta las llamadas y, si `ok`, reescribe las credenciales FALSAS con 8 h de vida (como haría Claude Code).
fn fake_renewer(calls: &std::cell::Cell<u32>, ok: bool) -> impl Fn(&str) -> bool + '_ {
    move |dir: &str| {
        calls.set(calls.get() + 1);
        if ok {
            std::fs::write(Path::new(dir).join(CREDS_FILE), creds_json(TOKEN, (NOW + 8.0 * 3600.0) * 1000.0)).unwrap();
        }
        ok
    }
}

#[test]
fn expired_token_is_renewed_by_claude_code_and_then_queried() {
    let (base, acct) = fixture("renew-ok", -3600.0);
    let srv = Fake::start(vec![reply(200, FIVE)]);
    let calls = std::cell::Cell::new(0);
    let r = fake_renewer(&calls, true);
    let url = srv.url();
    let e = Env { renewer: Some(&r), ..env(&base, &url) };
    let (res, requested) = fetch_one(&e, &Tracker::default(), &acct_in("rn1", &acct), 5, NOW);
    assert_clean(&res, &base);
    assert_eq!(calls.get(), 1);
    assert!(requested);
    assert_eq!(res.status, Status::Ok);
    assert_eq!(srv.count(), 1);
}

#[test]
fn a_valid_token_never_calls_the_renewer() {
    let (base, acct) = fixture("renew-valid", 7200.0);
    let srv = Fake::start(vec![reply(200, FIVE)]);
    let calls = std::cell::Cell::new(0);
    let r = fake_renewer(&calls, true);
    let url = srv.url();
    let e = Env { renewer: Some(&r), ..env(&base, &url) };
    assert_eq!(fetch_one(&e, &Tracker::default(), &acct_in("rn2", &acct), 5, NOW).0.status, Status::Ok);
    assert_eq!(calls.get(), 0);
}

#[test]
fn no_creds_or_bad_dirs_never_call_the_renewer() {
    let srv = Fake::start(vec![reply(200, FIVE)]);
    let calls = std::cell::Cell::new(0);
    let r = fake_renewer(&calls, true);
    let (base, acct) = fixture("renew-nocreds", 3600.0);
    std::fs::remove_file(acct.join(CREDS_FILE)).unwrap();
    let url = srv.url();
    let e = Env { renewer: Some(&r), ..env(&base, &url) };
    assert_eq!(fetch_one(&e, &Tracker::default(), &acct_in("rn3", &acct), 5, NOW).0.status, Status::Nocreds);
    let bad = AccountIn { id: "rn4".into(), dir: acct.join("..").join("acct").to_string_lossy().into_owned() };
    assert_eq!(fetch_one(&e, &Tracker::default(), &bad, 5, NOW).0.status, Status::Nocreds);
    assert_eq!(calls.get(), 0);
    assert_eq!(srv.count(), 0);
}

#[test]
fn failed_renewal_sends_nothing_and_automatic_queries_wait_30_minutes() {
    let (base, acct) = fixture("renew-fail", -3600.0);
    let srv = Fake::start(vec![reply(200, FIVE)]);
    let calls = std::cell::Cell::new(0);
    let r = fake_renewer(&calls, false);
    let tr = Tracker::default();
    let a = acct_in("rn5", &acct);
    let url = srv.url();
    let auto = Env { renewer: Some(&r), ..env(&base, &url) };
    let (res, requested) = fetch_one(&auto, &tr, &a, 5, NOW);
    assert_eq!(res.status, Status::Expired);
    assert!(res.message.as_deref().unwrap().contains("could not renew"));
    assert!(!requested);
    assert_eq!(calls.get(), 1);
    // automática dentro de 30 min: no se vuelve a lanzar Claude
    assert_eq!(fetch_one(&auto, &tr, &a, 5, NOW + 300.0).0.status, Status::Expired);
    assert_eq!(calls.get(), 1);
    // a mano (botón): sí
    let manual = Env { force: true, ..auto };
    assert_eq!(fetch_one(&manual, &tr, &a, 5, NOW + 301.0).0.status, Status::Expired);
    assert_eq!(calls.get(), 2);
    // pasados 30 min desde el último fallo, la automática vuelve a probar
    let auto = Env { force: false, ..manual };
    fetch_one(&auto, &tr, &a, 5, NOW + 301.0 + 1801.0);
    assert_eq!(calls.get(), 3);
    assert_eq!(srv.count(), 0, "con el token caducado no sale ninguna petición");
}

#[test]
fn without_renewer_an_expired_token_keeps_the_plain_message() {
    let (base, acct) = fixture("renew-none", -3600.0);
    let srv = Fake::start(vec![reply(200, FIVE)]);
    let r = go(&srv.url(), &base, &acct_in("rn6", &acct), &Tracker::default(), NOW);
    assert_eq!(r.status, Status::Expired);
    assert_eq!(r.message.as_deref(), Some("sign-in token expired"));
}

#[test]
fn forced_query_has_a_10_second_floor_and_ignores_the_error_backoff() {
    let (base, acct) = fixture("force", 360000.0);
    let srv = Fake::start(vec![reply(429, "{}"), reply(200, FIVE)]);
    let tr = Tracker::default();
    let a = acct_in("fo1", &acct);
    assert_eq!(go(&srv.url(), &base, &a, &tr, NOW).status, Status::RateLimited);
    let url = srv.url();
    let forced = Env { force: true, ..env(&base, &url) };
    // dentro de 10 s, ni a mano
    assert_eq!(fetch_one(&forced, &tr, &a, 5, NOW + 5.0).0.status, Status::RateLimited);
    assert_eq!(srv.count(), 1);
    // a los 11 s, a mano sí aunque la espera tras el 429 siga en marcha
    let (r, requested) = fetch_one(&forced, &tr, &a, 5, NOW + 11.0);
    assert!(requested);
    assert_eq!(r.status, Status::Ok);
    assert_eq!(srv.count(), 2);
    // la automática sigue con su suelo de 60 s
    go(&srv.url(), &base, &a, &tr, NOW + 30.0);
    assert_eq!(srv.count(), 2);
}
