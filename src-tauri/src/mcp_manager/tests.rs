use super::*;
use std::net::TcpListener;

/// Carpeta temporal propia de cada prueba.
fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("orch-mcpm-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

const SECRETS: &[&str] = &[
    "envsecretvalue123",
    "hdrsecretvalue456",
    "querysecret789",
    "argsecretABC",
    "sk-ant-abcdefghijklmnop",
    "eqflagsecretXYZ",
    "urlpassword42",
];

fn claude_json() -> String {
    json!({
        "oauthAccount": {"emailAddress": "me@example.com"},
        "mcpServers": {
            "files": {
                "type": "stdio", "command": "npx",
                "args": ["-y", "@x/files", "--api-key", "argsecretABC", "--token=eqflagsecretXYZ", "sk-ant-abcdefghijklmnop"],
                "env": {"API_KEY": "envsecretvalue123"}
            },
            "remote": {"type": "http", "url": "https://u:urlpassword42@mcp.example.com/mcp?key=querysecret789&x=1", "headers": {"Authorization": "Bearer hdrsecretvalue456"}},
            "legacy": {"type": "sse", "url": "http://localhost:9/sse"},
            "plain": {"command": "node", "args": ["server.js"]}
        },
        "projects": {
            "C:/work/app": {
                "mcpServers": {"unity": {"type": "stdio", "command": "uvx", "args": ["mcp-unity"], "env": {}}},
                "disabledMcpServers": ["unity"]
            },
            "C:/work/empty": {"mcpServers": {}}
        }
    })
    .to_string()
}

// ---------- Claude ----------

#[test]
fn claude_user_and_local() {
    let (defs, email) = parse_claude_json(&claude_json()).unwrap();
    assert_eq!(email.as_deref(), Some("me@example.com"));
    assert_eq!(defs.len(), 5);
    let f = defs.iter().find(|d| d.name == "files").unwrap();
    assert_eq!((f.transport, f.scope, f.command.as_deref()), ("stdio", "user", Some("npx")));
    let r = defs.iter().find(|d| d.name == "remote").unwrap();
    assert_eq!(r.transport, "http");
    assert_eq!(defs.iter().find(|d| d.name == "legacy").unwrap().transport, "sse");
    // Sin "type": stdio.
    let p = defs.iter().find(|d| d.name == "plain").unwrap();
    assert_eq!((p.transport, p.raw_kind.as_str()), ("stdio", "stdio"));
    let u = defs.iter().find(|d| d.name == "unity").unwrap();
    assert_eq!((u.scope, u.project_path.as_deref(), u.enabled), ("local", Some("C:/work/app"), Some(false)));
}

#[test]
fn claude_empty_and_malformed() {
    assert!(parse_claude_json("{}").unwrap().0.is_empty());
    assert!(parse_claude_json(r#"{"mcpServers": null, "projects": {"a": {}}}"#).unwrap().0.is_empty());
    assert!(parse_claude_json("{\"mcpServers\": {").is_err());
}

#[test]
fn claude_accounts_in_a_home() {
    let home = tmp("home");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::write(home.join(".claude.json"), claude_json()).unwrap();
    std::fs::create_dir_all(home.join(".claude-work")).unwrap();
    std::fs::write(home.join(".claude-work").join(".claude.json"), "{ not json").unwrap();
    std::fs::create_dir_all(home.join(".claude-new")).unwrap(); // sin .claude.json: ni MCP ni error
    let accs = list_in(&home);
    let claude: Vec<_> = accs.iter().filter(|a| a.provider == "claude").collect();
    assert_eq!(claude.len(), 3);
    assert!(claude[0].is_default && claude[0].servers.len() == 5 && claude[0].error.is_none());
    assert_eq!(claude[0].label.as_deref(), Some("me@example.com"));
    let new = claude.iter().find(|a| a.dir.ends_with(".claude-new")).unwrap();
    assert!(new.servers.is_empty() && new.error.is_none());
    let bad = claude.iter().find(|a| a.dir.ends_with(".claude-work")).unwrap();
    assert!(bad.error.as_deref().unwrap().contains("malformed"));
    // Nada secreto en lo que va a la interfaz.
    let out = serde_json::to_string(&accs).unwrap();
    for s in SECRETS {
        assert!(!out.contains(s), "secret {s} leaked: {out}");
    }
    let _ = std::fs::remove_dir_all(&home);
}

// ---------- enmascarado ----------

#[test]
fn masking_never_leaks() {
    let (defs, _) = parse_claude_json(&claude_json()).unwrap();
    let pubs: Vec<McpDef> = defs.iter().map(to_public).collect();
    let out = serde_json::to_string(&pubs).unwrap();
    for s in SECRETS {
        assert!(!out.contains(s), "secret {s} leaked: {out}");
    }
    let f = pubs.iter().find(|d| d.name == "files").unwrap();
    assert_eq!(f.args, vec!["-y", "@x/files", "--api-key", MASK, &format!("--token={MASK}"), MASK]);
    assert_eq!(f.env_keys, vec!["API_KEY"]);
    let r = pubs.iter().find(|d| d.name == "remote").unwrap();
    assert_eq!(r.url.as_deref(), Some(&*format!("https://u:{MASK}@mcp.example.com/mcp?key={MASK}&x={MASK}")));
    assert_eq!(r.header_keys, vec!["Authorization"]);
    // Las rutas y los paquetes normales no se tocan.
    assert_eq!(
        mask_args(&["C:\\Users\\x\\AppData\\Local\\server\\index.js".into(), "@modelcontextprotocol/server-filesystem".into()]),
        vec!["C:\\Users\\x\\AppData\\Local\\server\\index.js", "@modelcontextprotocol/server-filesystem"]
    );
    assert_eq!(mask_url("http://127.0.0.1:8080/mcp"), "http://127.0.0.1:8080/mcp");
}

#[test]
fn scrub_removes_secrets() {
    let m = scrub_msg("\n  Error: bad key envsecretvalue123 token=abc and ghp_abcdefghijklmnop1234\nsecond line", &["envsecretvalue123"]);
    assert!(!m.contains("envsecretvalue123") && !m.contains("ghp_abc") && !m.contains("=abc") && !m.contains("second"), "{m}");
    assert!(scrub_msg(&"x".repeat(500), &[]).chars().count() <= MSG_CAP + 1);
}

// ---------- huella ----------

#[test]
fn fingerprint_same_and_different() {
    let (defs, _) = parse_claude_json(&claude_json()).unwrap();
    let f = defs.iter().find(|d| d.name == "files").unwrap().clone();
    let fp = fingerprint(&f);
    assert_eq!(fp.len(), 16);
    assert_eq!(fp, fingerprint(&f), "estable");
    // Otro nombre, ámbito o enabled: misma definición.
    let mut g = f.clone();
    g.name = "other".into();
    g.scope = "local";
    g.enabled = Some(false);
    assert_eq!(fingerprint(&g), fp);
    // Orden de env distinto: igual.
    let mut a = f.clone();
    a.env = vec![("A".into(), "1".into()), ("B".into(), "2".into())];
    let mut b = f.clone();
    b.env = vec![("B".into(), "2".into()), ("A".into(), "1".into())];
    assert_eq!(fingerprint(&a), fingerprint(&b));
    // Mismo nombre de variable con otro valor: distinta.
    let mut c = f.clone();
    c.env = vec![("API_KEY".into(), "other".into())];
    assert_ne!(fingerprint(&c), fp);
    let mut d = f.clone();
    d.args.push("--verbose".into());
    assert_ne!(fingerprint(&d), fp);
    // opencode guarda comando y argumentos juntos: misma huella que Claude con el comando aparte.
    let oc = parse_opencode(r#"{"mcp":{"files":{"type":"local","command":["npx","-y","@x/files","--api-key","argsecretABC","--token=eqflagsecretXYZ","sk-ant-abcdefghijklmnop"],"environment":{"API_KEY":"envsecretvalue123"}}}}"#).unwrap();
    assert_eq!(fingerprint(&oc[0]), fp);
}

// ---------- opencode ----------

#[test]
fn opencode_jsonc() {
    let text = "\u{feff}{\n  // comentario con \"comillas\"\n  \"$schema\": \"https://opencode.ai/config.json\",\n  /* bloque */\n  \"mcp\": {\n    \"unity\": { \"type\": \"remote\", \"url\": \"http://127.0.0.1:8080/mcp\", \"enabled\": true, },\n    \"fs\": { \"type\": \"local\", \"command\": [\"npx\", \"-y\", \"srv // no es comentario\"], \"environment\": {\"TOKEN\": \"envsecretvalue123\"}, \"enabled\": false, // fin\n    },\n  },\n}\n";
    let defs = parse_opencode(text).unwrap();
    assert_eq!(defs.len(), 2);
    let u = defs.iter().find(|d| d.name == "unity").unwrap();
    assert_eq!((u.transport, u.scope, u.enabled, u.url.as_deref()), ("http", "global", Some(true), Some("http://127.0.0.1:8080/mcp")));
    let f = defs.iter().find(|d| d.name == "fs").unwrap();
    assert_eq!((f.transport, f.command.as_deref(), f.enabled), ("stdio", Some("npx"), Some(false)));
    assert_eq!(f.args, vec!["-y", "srv // no es comentario"]);
    assert!(!serde_json::to_string(&to_public(f)).unwrap().contains("envsecretvalue123"));
    assert!(parse_opencode("{\"mcp\": ").is_err());
    assert!(parse_opencode("{}").unwrap().is_empty());
}

// ---------- Codex ----------

#[test]
fn codex_real_fixture() {
    // Salida real de `codex mcp list --json` (codex 0.167.0) con los valores sustituidos.
    let text = include_str!("codex_list_fixture.json");
    let defs = parse_codex_list(text).unwrap();
    assert_eq!(defs.len(), 5);
    let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(names, vec!["code-review", "codex_app", "cua_repl", "node_repl", "unityMCP"]);
    let cr = &defs[0];
    assert_eq!((cr.transport, cr.enabled, cr.auth_status.as_deref()), ("stdio", Some(false), Some("unsupported")));
    assert!(cr.env.is_empty() && cr.env_passthrough.len() == 21);
    assert!(defs[2].env.len() >= 10);
    let u = &defs[4];
    assert_eq!((u.transport, u.raw_kind.as_str(), u.url.as_deref()), ("http", "streamable_http", Some("http://127.0.0.1:8080/mcp")));
    let out = serde_json::to_string(&defs.iter().map(to_public).collect::<Vec<_>>()).unwrap();
    assert!(!out.contains("SECRET_ENV") && !out.contains("SECRET_HDR"), "{out}");
    // Con texto alrededor (stderr detrás) también se lee.
    assert_eq!(parse_codex_list(&format!("{text}\nWARNING: something\n")).unwrap().len(), 5);
    assert!(parse_codex_list("Error: no config").is_err());
}

#[test]
fn codex_headers_from_env() {
    let text = r#"[{"name":"gh","enabled":true,"transport":{"type":"streamable_http","url":"https://x/mcp","bearer_token_env_var":"GH_TOKEN","http_headers":{"X-Key":"hdrsecretvalue456"},"env_http_headers":{"X-Org":"ORG_VAR"}},"auth_status":"bearer_token"}]"#;
    let d = &parse_codex_list(text).unwrap()[0];
    let p = to_public(d);
    assert_eq!(p.header_keys, vec!["X-Key", "X-Org", "Authorization"]);
    assert_eq!(p.env_passthrough, vec!["ORG_VAR", "GH_TOKEN"]);
    assert!(!serde_json::to_string(&p).unwrap().contains("hdrsecretvalue456"));
}

// ---------- sonda stdio ----------

fn fake_def(mode: &str, pid_file: Option<&Path>) -> RawDef {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("mcp_manager").join("fake_mcp.ps1");
    let mut env = vec![("FAKE_MODE".to_string(), mode.to_string()), ("FAKE_SECRET".to_string(), "envsecretvalue123".to_string())];
    if let Some(p) = pid_file {
        env.push(("FAKE_PID_FILE".into(), p.to_string_lossy().into_owned()));
    }
    RawDef {
        name: "fake".into(),
        transport: "stdio",
        command: Some("powershell".into()),
        args: vec!["-NoProfile".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-File".into(), script.to_string_lossy().into_owned()],
        env,
        scope: "user",
        raw_kind: "stdio".into(),
        ..Default::default()
    }
}

fn alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .creation_flags(0x0800_0000)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
}

fn read_pid(p: &Path) -> u32 {
    std::fs::read_to_string(p).unwrap().trim().parse().unwrap()
}

#[test]
fn probe_stdio_ok_and_tree_killed() {
    let d = tmp("ok");
    let pid_file = d.join("pid.txt");
    let r = probe_def(&fake_def("ok", Some(&pid_file)), &[], Duration::from_secs(20));
    // Coste: JSON compacto de las 3 herramientas, `[{"name":"a"},{"name":"b"},{"name":"c"}]` = 40 bytes → ≈10 tokens.
    assert_eq!(r, ProbeResult::Ok { tools: 3, server_name: Some("fake-mcp".into()), version: Some("1.2.3".into()), tools_bytes: 40, tokens_est: 10 });
    let pid = read_pid(&pid_file);
    std::thread::sleep(Duration::from_millis(300));
    assert!(!alive(pid), "grandchild {pid} survived");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn probe_stdio_timeout_kills_tree() {
    let d = tmp("hang");
    let pid_file = d.join("pid.txt");
    let t0 = Instant::now();
    let r = probe_def(&fake_def("hang", Some(&pid_file)), &[], Duration::from_secs(4));
    assert_eq!(r, ProbeResult::Timeout);
    assert!(t0.elapsed() < Duration::from_secs(7), "{:?}", t0.elapsed());
    let pid = read_pid(&pid_file);
    std::thread::sleep(Duration::from_millis(300));
    assert!(!alive(pid), "grandchild {pid} survived");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn probe_stdio_failed_without_secret() {
    let r = probe_def(&fake_def("fail", None), &[], Duration::from_secs(20));
    let ProbeResult::Failed { msg } = r else { panic!("{r:?}") };
    assert!(msg.contains("fatal: invalid configuration value"), "{msg}");
    assert!(!msg.contains("envsecretvalue123"), "{msg}");
    // Comando que no existe.
    let mut d = fake_def("ok", None);
    d.command = Some("orchestra-no-such-command-xyz".into());
    assert!(matches!(probe_def(&d, &[], Duration::from_secs(5)), ProbeResult::Failed { .. }));
}

// ---------- sonda http ----------

/// Servidor HTTP mínimo: contesta cada POST con `answer(body)` → (status, content-type, cuerpo).
fn fake_http(answer: fn(&Value) -> (u16, &'static str, String)) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}/mcp", l.local_addr().unwrap().port());
    std::thread::spawn(move || {
        for s in l.incoming().take(8) {
            let Ok(mut s) = s else { break };
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                if r.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0u8; len];
            let _ = r.read_exact(&mut body);
            let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let (st, ct, b) = answer(&v);
            let _ = write!(s, "HTTP/1.1 {st} X\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nMcp-Session-Id: s1\r\nConnection: close\r\n\r\n{b}", b.len());
        }
    });
    url
}

fn http_def(url: &str) -> RawDef {
    RawDef {
        name: "h".into(),
        transport: "http",
        url: Some(url.into()),
        headers: vec![("Authorization".into(), "Bearer hdrsecretvalue456".into())],
        scope: "user",
        ..Default::default()
    }
}

#[test]
fn probe_http_ok_sse_and_auth() {
    let url = fake_http(|v| match v["method"].as_str() {
        Some("initialize") => (200, "application/json", json!({"jsonrpc":"2.0","id":v["id"],"result":{"serverInfo":{"name":"h","version":"9"}}}).to_string()),
        Some("tools/list") => (200, "text/event-stream", format!("event: message\ndata: {}\n\n", json!({"jsonrpc":"2.0","id":v["id"],"result":{"tools":[{"name":"x"}]}}))),
        _ => (202, "application/json", String::new()),
    });
    assert_eq!(
        probe_def(&http_def(&url), &[], Duration::from_secs(10)),
        ProbeResult::Ok { tools: 1, server_name: Some("h".into()), version: Some("9".into()), tools_bytes: 14, tokens_est: 4 }
    );
    let url = fake_http(|_| (401, "application/json", "{}".into()));
    assert_eq!(probe_def(&http_def(&url), &[], Duration::from_secs(10)), ProbeResult::NeedsAuth);
    let url = fake_http(|_| (500, "text/plain", "boom".into()));
    assert!(matches!(probe_def(&http_def(&url), &[], Duration::from_secs(10)), ProbeResult::Failed { .. }));
}

// ---------- real ----------

/// Lista las cuentas reales del usuario (solo lectura; no sondea).
/// `cargo test --bin orchestra real_listing -- --ignored --nocapture`
#[test]
#[ignore]
fn real_listing() {
    let home = home().unwrap();
    let all = list_all(&home, &[]);
    let out = serde_json::to_string(&all.iter().map(|(a, _)| a).collect::<Vec<_>>()).unwrap();
    // Texto que ya es público por otro campo (carpeta, comando, argumentos, cwd, nombres de variables…): si un valor
    // de env coincide con él (p. ej. CODEX_HOME = la carpeta de la cuenta) no es una fuga, es una coincidencia.
    let mut public = String::new();
    for (acc, _) in &all {
        public.push_str(&format!("{}\n{}\n{}\n", acc.id, acc.dir, acc.source));
        for d in &acc.servers {
            let fields = [
                d.name.as_str(),
                d.command.as_deref().unwrap_or(""),
                &d.args.join("\n"),
                d.cwd.as_deref().unwrap_or(""),
                d.url.as_deref().unwrap_or(""),
                &d.env_keys.join("\n"),
                &d.env_passthrough.join("\n"),
                &d.project_path.clone().unwrap_or_default(),
            ]
            .join("\n");
            public.push_str(&fields);
            public.push('\n');
        }
    }
    let (mut leaked, mut coincidences) = (0, 0);
    for (acc, raws) in &all {
        let by_scope = |s: &str| acc.servers.iter().filter(|d| d.scope == s).count();
        println!(
            "{} | {} MCP (user {}, local {}, global {}) | error: {}",
            acc.id,
            acc.servers.len(),
            by_scope("user"),
            by_scope("local"),
            by_scope("global"),
            acc.error.as_deref().unwrap_or("-")
        );
        for r in raws {
            for (k, s) in r.env.iter().chain(r.headers.iter()) {
                let enc = serde_json::to_string(s).unwrap();
                if s.len() >= 4 && out.contains(enc.trim_matches('"')) {
                    if public.contains(s.as_str()) {
                        coincidences += 1;
                    } else {
                        leaked += 1;
                        println!("  LEAK in {} key {k} (len {}, value not shown)", r.name, s.len());
                    }
                }
            }
        }
    }
    println!("env values equal to text already public in other fields (paths, versions, names): {coincidences}");
    println!("secret values found in the serialized listing: {leaked}");
    assert_eq!(leaked, 0);
}

/// La forma JSON que espera `src/lib/backend.ts` (McpProbeResult).
#[test]
fn probe_result_json_shape() {
    let ok = ProbeResult::Ok { tools: 2, server_name: Some("s".into()), version: None, tools_bytes: 900, tokens_est: 225 };
    assert_eq!(
        serde_json::to_value(&ok).unwrap(),
        json!({"status": "ok", "tools": 2, "serverName": "s", "version": null, "toolsBytes": 900, "tokensEst": 225})
    );
    assert_eq!(serde_json::to_value(ProbeResult::NeedsAuth).unwrap(), json!({"status": "needsAuth"}));
    assert_eq!(serde_json::to_value(ProbeResult::Failed { msg: "m".into() }).unwrap(), json!({"status": "failed", "msg": "m"}));
    assert_eq!(serde_json::to_value(ProbeResult::Timeout).unwrap(), json!({"status": "timeout"}));
}

// ---------- coste en tokens de las herramientas ----------

/// Las definiciones de TODAS las páginas de `tools/list` cuentan (no solo la última), con su JSON compacto.
#[test]
fn tools_cost_sums_all_pages() {
    let page1 = json!([{"name": "read_file", "description": "Read a file from disk", "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}}}]);
    let page2 = json!([{"name": "write_file", "description": "Write a file", "inputSchema": {"type": "object"}}, {"name": "ls"}]);
    let mut all: Vec<Value> = page1.as_array().unwrap().clone();
    all.extend(page2.as_array().unwrap().iter().cloned());
    let expected = serde_json::to_vec(&Value::Array(all)).unwrap().len();
    let (p1, p2) = (page1.clone(), page2.clone());
    let r = dialog(move |m| {
        Ok(match (m["method"].as_str(), m["params"]["cursor"].as_str()) {
            (Some("initialize"), _) => Some(json!({"id": 1, "result": {"serverInfo": {"name": "fs"}}})),
            (Some("tools/list"), None) => Some(json!({"id": m["id"], "result": {"tools": p1, "nextCursor": "2"}})),
            (Some("tools/list"), Some(_)) => Some(json!({"id": m["id"], "result": {"tools": p2}})),
            _ => None,
        })
    });
    assert_eq!(r, ProbeResult::Ok { tools: 3, server_name: Some("fs".into()), version: None, tools_bytes: expected, tokens_est: expected.div_ceil(4) });
    assert!(expected > 200, "{expected}");
    // Sin herramientas: coste 0.
    let r = dialog(|m| {
        Ok(match m["method"].as_str() {
            Some("initialize") => Some(json!({"id": 1, "result": {}})),
            Some("tools/list") => Some(json!({"id": m["id"], "result": {"tools": []}})),
            _ => None,
        })
    });
    assert_eq!(r, ProbeResult::Ok { tools: 0, server_name: None, version: None, tools_bytes: 0, tokens_est: 0 });
}

// ---------- apagados, .mcp.json de proyecto, plugins y conectores ----------

/// Cuenta de Claude con un MCP de usuario apagado en un proyecto, un `.mcp.json` en dos proyectos abiertos
/// (aprobado / rechazado / sin preguntar), un plugin con MCP y conectores de claude.ai.
#[test]
fn claude_disabled_project_plugins_connectors() {
    let home = tmp("proj");
    let acct = home.join(".claude-work");
    std::fs::create_dir_all(&acct).unwrap();
    let app = home.join("work").join("app");
    let other = home.join("work").join("other");
    std::fs::create_dir_all(&app).unwrap();
    std::fs::create_dir_all(other.join(".claude")).unwrap();
    let app_key = app.to_string_lossy().replace('\\', "/"); // Claude guarda rutas con «/»
    std::fs::write(
        acct.join(".claude.json"),
        json!({
            "mcpServers": {"files": {"command": "npx", "args": ["-y", "@x/files"], "env": {"API_KEY": "envsecretvalue123"}}},
            "projects": {
                app_key.clone(): {
                    "disabledMcpServers": ["files", "claude.ai Miro"],
                    "enabledMcpjsonServers": ["db"],
                    "disabledMcpjsonServers": ["web"]
                }
            },
            "claudeAiMcpEverConnected": ["claude.ai Miro", "claude.ai Trello"]
        })
        .to_string(),
    )
    .unwrap();
    let mcpjson = json!({"mcpServers": {
        "db": {"command": "uvx", "args": ["mcp-db"], "env": {"DB_PASS": "envsecretvalue123"}},
        "web": {"type": "http", "url": "https://mcp.example.com/mcp", "headers": {"Authorization": "Bearer hdrsecretvalue456"}},
        "new": {"command": "node", "args": ["n.js"]}
    }})
    .to_string();
    std::fs::write(app.join(".mcp.json"), &mcpjson).unwrap();
    std::fs::write(other.join(".mcp.json"), &mcpjson).unwrap();
    // En «other» el proyecto aprueba todo desde su settings.local.json.
    std::fs::write(other.join(".claude").join("settings.local.json"), r#"{"enableAllProjectMcpServers": true}"#).unwrap();
    // Plugin con MCP (manifiesto) y plugin sin MCP.
    let pdir = acct.join("plugins").join("cache").join("sentry");
    std::fs::create_dir_all(pdir.join(".claude-plugin")).unwrap();
    std::fs::write(pdir.join(".claude-plugin").join("plugin.json"), r#"{"name":"sentry","mcpServers":{"sentry":{"type":"http","url":"https://mcp.sentry.dev/mcp"}}}"#).unwrap();
    let ldir = acct.join("plugins").join("cache").join("lsp");
    std::fs::create_dir_all(&ldir).unwrap();
    std::fs::write(
        acct.join("plugins").join("installed_plugins.json"),
        json!({"version": 2, "plugins": {
            "sentry@dir": [{"scope": "user", "installPath": pdir.to_string_lossy()}],
            "lsp@dir": [{"scope": "user", "installPath": ldir.to_string_lossy()}]
        }})
        .to_string(),
    )
    .unwrap();
    std::fs::write(acct.join("settings.json"), r#"{"enabledPlugins": {"sentry@dir": true}}"#).unwrap();

    // Con la ruta escrita con «\» (como la da Windows a un panel) y repetida: se reconoce el proyecto y no se duplica.
    let projects = vec![app.to_string_lossy().into_owned(), app.to_string_lossy().into_owned(), other.to_string_lossy().into_owned()];
    let accs = list_with(&home, &projects);
    let a = accs.iter().find(|a| a.dir.ends_with(".claude-work")).unwrap();
    assert!(a.error.is_none(), "{:?}", a.error);
    let get = |name: &str, scope: &str, proj: Option<&Path>| {
        a.servers
            .iter()
            .find(|d| d.name == name && d.scope == scope && proj.is_none_or(|p| d.project_path.as_deref() == Some(&*p.to_string_lossy())))
            .unwrap_or_else(|| panic!("missing {name} {scope}"))
    };
    // disabledMcpServers apaga el MCP de usuario en ese proyecto (y el conector).
    let files = get("files", "user", None);
    assert_eq!(files.disabled_in, vec![app_key.clone()]);
    assert_eq!(get("claude.ai Miro", "claudeai", None).disabled_in, vec![app_key.clone()]);
    assert!(get("claude.ai Trello", "claudeai", None).disabled_in.is_empty());
    assert_eq!(get("claude.ai Trello", "claudeai", None).managed_by.as_deref(), Some("claude.ai"));
    // .mcp.json: aprobado / rechazado / sin preguntar; en «other», todo aprobado por settings.local.json.
    assert_eq!(get("db", "project", Some(&app)).enabled, Some(true));
    assert_eq!(get("web", "project", Some(&app)).enabled, Some(false));
    assert_eq!(get("new", "project", Some(&app)).enabled, None);
    assert_eq!(get("new", "project", Some(&other)).enabled, Some(true));
    assert_eq!(a.servers.iter().filter(|d| d.scope == "project").count(), 6);
    // Misma definición en dos proyectos = misma huella.
    assert_eq!(get("db", "project", Some(&app)).fingerprint, get("db", "project", Some(&other)).fingerprint);
    // Plugin: solo el que trae MCP, encendido según enabledPlugins.
    let plug: Vec<_> = a.servers.iter().filter(|d| d.scope == "plugin").collect();
    assert_eq!(plug.len(), 1);
    assert_eq!(plug[0].managed_by.as_deref(), Some("plugin:sentry@dir"));
    assert_eq!(plug[0].enabled, Some(true));
    // Sin proyectos abiertos, no salen los de ámbito project.
    let accs0 = list_in(&home);
    assert!(accs0.iter().all(|a| a.servers.iter().all(|d| d.scope != "project")));
    // La sonda encuentra el MCP de proyecto (aquí falla al arrancar `node n.js` o no: solo importa que lo encuentre).
    let id = format!("claude:{}", acct.to_string_lossy());
    let (d, env) = find_def(&home, &id, "project", "db", Some(&app.to_string_lossy())).unwrap();
    assert_eq!(d.command.as_deref(), Some("uvx"));
    assert_eq!(env[0].0, "CLAUDE_CONFIG_DIR");
    assert!(find_def(&home, &id, "project", "db", None).is_err());
    // Nada secreto en lo que va a la interfaz.
    let out = serde_json::to_string(&accs).unwrap();
    for s in SECRETS {
        assert!(!out.contains(s), "secret {s} leaked");
    }
    // El refresco por mtime: la firma cambia al tocar el .mcp.json.
    let s1 = stamp_in(&home, &projects);
    assert_eq!(s1, stamp_in(&home, &projects));
    std::thread::sleep(Duration::from_millis(30));
    std::fs::write(app.join(".mcp.json"), r#"{"mcpServers":{}}"#).unwrap();
    assert_ne!(s1, stamp_in(&home, &projects));
    let _ = std::fs::remove_dir_all(&home);
}
