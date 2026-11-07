use super::*;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("orch-mcpw-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

const SECRET: &str = "s3cr3tvalueXYZ";
const HSECRET: &str = "hdrS3cretQQQ";

fn stdio_input(name: &str) -> DefInput {
    DefInput {
        name: name.into(),
        transport: "stdio".into(),
        command: Some("npx".into()),
        args: vec!["-y".into(), "@modelcontextprotocol/server-github".into(), "a b".into()],
        env: vec![Kv { key: "GITHUB_TOKEN".into(), value: SECRET.into() }],
        ..Default::default()
    }
}

fn http_input(name: &str) -> DefInput {
    DefInput {
        name: name.into(),
        transport: "http".into(),
        url: Some("https://mcp.example.com/mcp".into()),
        headers: vec![Kv { key: "X-Api-Key".into(), value: HSECRET.into() }],
        ..Default::default()
    }
}

#[test]
fn builds_commands_per_tool() {
    let d = def_from_input(&stdio_input("github")).unwrap();
    // Claude
    let c = translate(&d, "claude").unwrap();
    let a = claude_add_args(&c);
    assert_eq!(a[..3], ["mcp", "add-json", "github"]);
    assert_eq!(a[4..], ["--scope", "user"]);
    let j: Value = serde_json::from_str(&a[3]).unwrap();
    assert_eq!(j, json!({"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github","a b"],"env":{"GITHUB_TOKEN":SECRET}}));
    assert_eq!(claude_remove_args("github"), ["mcp", "remove", "github", "--scope", "user"]);
    // Codex
    let x = translate(&d, "codex").unwrap();
    assert_eq!(
        codex_add_args(&x),
        ["mcp", "add", "github", "--env", &format!("GITHUB_TOKEN={SECRET}"), "--", "npx", "-y", "@modelcontextprotocol/server-github", "a b"]
    );
    assert_eq!(codex_remove_args("github"), ["mcp", "remove", "github"]);
    // opencode
    let o = translate(&d, "opencode").unwrap();
    assert_eq!(
        opencode_value_of(&o),
        json!({"type":"local","command":["npx","-y","@modelcontextprotocol/server-github","a b"],"environment":{"GITHUB_TOKEN":SECRET},"enabled":true})
    );
    // HTTP con token en variable
    let mut hi = http_input("remote");
    hi.headers.clear();
    hi.bearer_env_var = Some("MY_TOKEN".into());
    let h = def_from_input(&hi).unwrap();
    assert_eq!(codex_add_args(&translate(&h, "codex").unwrap()), ["mcp", "add", "remote", "--url", "https://mcp.example.com/mcp", "--bearer-token-env-var", "MY_TOKEN"]);
    let hc = translate(&h, "claude").unwrap();
    assert_eq!(claude_json_of(&hc), json!({"type":"http","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer ${MY_TOKEN}"}}));
    let ho = translate(&h, "opencode").unwrap();
    assert_eq!(opencode_value_of(&ho)["headers"], json!({"Authorization":"Bearer {env:MY_TOKEN}"}));
    // Claude «Bearer ${X}» → Codex --bearer-token-env-var X
    let mut from_claude = hc.clone();
    from_claude.env_headers.clear();
    from_claude.env_passthrough.clear();
    let back = translate(&from_claude, "codex").unwrap();
    assert_eq!(back.env_headers, vec![("Authorization".to_string(), "MY_TOKEN".to_string())]);
}

#[test]
fn what_cli_cannot_express_is_blocked() {
    let h = def_from_input(&http_input("remote")).unwrap();
    let e = translate(&h, "codex").unwrap_err();
    assert!(e.contains("X-Api-Key"), "{e}");
    assert!(translate(&h, "claude").is_ok());
    assert!(translate(&h, "opencode").is_ok());
    let mut sse = h.clone();
    sse.transport = "sse";
    sse.headers.clear();
    assert!(translate(&sse, "codex").is_err());
    let mut cwd = def_from_input(&stdio_input("x")).unwrap();
    cwd.cwd = Some("C:\\work".into());
    for p in ["claude", "codex", "opencode"] {
        assert!(translate(&cwd, p).is_err(), "{p}");
    }
    // Codex: env_vars de paso no se pueden escribir por CLI.
    let mut pass = def_from_input(&stdio_input("x")).unwrap();
    pass.env_passthrough.push("HOME_TOKEN".into());
    assert!(translate(&pass, "codex").is_err());
    assert_eq!(translate(&pass, "claude").unwrap().env.last().unwrap(), &("HOME_TOKEN".to_string(), "${HOME_TOKEN}".to_string()));
    // Validación del formulario
    for bad in ["", "-x", "a b", "a/b", "ñ"] {
        let mut i = stdio_input(bad);
        i.name = bad.into();
        assert!(def_from_input(&i).is_err(), "{bad:?}");
    }
    let mut i = stdio_input("ok");
    i.command = None;
    assert!(def_from_input(&i).is_err());
    let mut i = http_input("ok");
    i.url = Some("ftp://x".into());
    assert!(def_from_input(&i).is_err());
}

/// HOME falso con una cuenta de Claude, una de Codex y la config de opencode.
fn fake_home(tag: &str) -> PathBuf {
    let h = tmp(tag);
    let cl = h.join(".claude-a");
    std::fs::create_dir_all(&cl).unwrap();
    std::fs::write(
        cl.join(".claude.json"),
        json!({
            "mcpServers": {"github": {"type":"stdio","command":"npx","args":["-y","other"],"env":{"GITHUB_TOKEN": SECRET}}},
            "projects": {"C:/p": {"mcpServers": {"onlylocal": {"command":"x"}}}}
        })
        .to_string(),
    )
    .unwrap();
    let cx = h.join(".codex-b");
    std::fs::create_dir_all(&cx).unwrap();
    std::fs::write(cx.join("config.toml"), "model = \"x\"\n\n[mcp_servers.github]\ncommand = \"npx\"\n\n[mcp_servers.\"dotted.name\"]\nurl = \"u\"\n").unwrap();
    std::fs::create_dir_all(h.join("oc")).unwrap();
    h
}

fn env_of(h: &Path) -> Env<'_> {
    Env { home: h, opencode_dir: h.join("oc") }
}

fn ids(h: &Path) -> Vec<String> {
    vec![
        format!("claude:{}", h.join(".claude-a").display()),
        format!("codex:{}", h.join(".codex-b").display()),
        "opencode:global".into(),
    ]
}

fn no_source(_: &SourceRef) -> Result<RawDef, String> {
    Err("no source".into())
}

#[test]
fn plan_shows_exact_commands_without_secrets() {
    let h = fake_home("plan");
    let env = env_of(&h);
    let change = Change::Add { def: stdio_input("github"), targets: ids(&h), replace: false };
    let steps = plan(&env, &change, &no_source).unwrap();
    // Claude y Codex ya lo tienen (distinto) y no se pidió sustituir → bloqueado; opencode → añadir.
    assert!(steps[0].public.blocked.as_deref().unwrap().contains("already exists"));
    assert!(steps[1].public.blocked.is_some());
    assert_eq!(steps[2].public.action, "add");
    assert!(steps[2].public.lines[0].starts_with("opencode.json: mcp.github = "), "{:?}", steps[2].public.lines);
    let change = Change::Add { def: stdio_input("github"), targets: ids(&h), replace: true };
    let steps = plan(&env, &change, &no_source).unwrap();
    assert_eq!(steps[0].public.action, "replace");
    let cdir = h.join(".claude-a").display().to_string();
    assert_eq!(steps[0].public.lines[0], format!("CLAUDE_CONFIG_DIR={cdir} claude mcp remove github --scope user"));
    assert_eq!(
        steps[0].public.lines[1],
        format!(
            "CLAUDE_CONFIG_DIR={cdir} claude mcp add-json github '{{\"args\":[\"-y\",\"@modelcontextprotocol/server-github\",\"a b\"],\"command\":\"npx\",\"env\":{{\"GITHUB_TOKEN\":\"•••\"}},\"type\":\"stdio\"}}' --scope user"
        )
    );
    assert_eq!(
        steps[1].public.lines,
        [format!(
            "CODEX_HOME={} codex mcp add github --env GITHUB_TOKEN=••• -- npx -y @modelcontextprotocol/server-github 'a b'",
            h.join(".codex-b").display()
        )]
    );
    // Lo que se ejecuta sí lleva el valor real; lo que se enseña, nunca.
    let json = serde_json::to_string(&steps.iter().map(|s| &s.public).collect::<Vec<_>>()).unwrap();
    assert!(!json.contains(SECRET), "secret leaked in the preview: {json}");
    match &steps[1].ops[0] {
        Op::Cli(c) => assert!(c.args.contains(&format!("GITHUB_TOKEN={SECRET}"))),
        _ => panic!(),
    }
    // Misma definición → nada que hacer.
    let mut same = stdio_input("github");
    same.args = vec!["-y".into(), "other".into()];
    let steps = plan(&env, &Change::Add { def: same, targets: ids(&h)[..1].to_vec(), replace: false }, &no_source).unwrap();
    assert_eq!(steps[0].public.action, "skip");
    // Quitar: Claude y Codex lo tienen; opencode no; local de Claude no se toca.
    let steps = plan(&env, &Change::Remove { name: "github".into(), targets: ids(&h), include_local: false }, &no_source).unwrap();
    assert_eq!(steps.iter().map(|s| s.public.action).collect::<Vec<_>>(), ["remove", "remove", "skip"]);
    assert_eq!(steps[1].public.lines, [format!("CODEX_HOME={} codex mcp remove github", h.join(".codex-b").display())]);
    let steps = plan(&env, &Change::Remove { name: "onlylocal".into(), targets: ids(&h)[..1].to_vec(), include_local: false }, &no_source).unwrap();
    assert!(steps[0].public.note.as_deref().unwrap().contains("local"));
    assert!(codex_toml_has("[mcp_servers.\"dotted.name\"]\n", "dotted.name"));
    // Cuenta que no existe → bloqueada, no se inventa.
    let steps = plan(&env, &Change::Remove { name: "x".into(), targets: vec!["claude:C:\\nope".into()], include_local: false }, &no_source).unwrap();
    assert!(steps[0].public.blocked.is_some());
    let _ = std::fs::remove_dir_all(&h);
}

#[test]
fn copy_reads_secrets_from_source_in_rust() {
    let h = fake_home("copy");
    let env = env_of(&h);
    let src = |s: &SourceRef| -> Result<RawDef, String> {
        assert_eq!(s.name, "github");
        let mut d = def_from_input(&stdio_input("github")).unwrap();
        d.scope = "user";
        Ok(d)
    };
    let from = SourceRef { account_id: ids(&h)[0].clone(), scope: "user".into(), name: "github".into(), project_path: None };
    let steps = plan(&env, &Change::Copy { from, targets: vec![ids(&h)[2].clone()], replace: false, include_local: false }, &src).unwrap();
    match &steps[0].ops[0] {
        Op::OcSet { value, .. } => assert_eq!(value["environment"]["GITHUB_TOKEN"], SECRET),
        _ => panic!(),
    }
    assert!(!steps[0].public.lines.join(" ").contains(SECRET));
    let _ = std::fs::remove_dir_all(&h);
}

/// Simula la CLI: `add-json`/`remove` de Claude escriben en el `.claude.json` de CLAUDE_CONFIG_DIR.
fn fake_claude(op: &CliOp) -> Result<(bool, String), String> {
    let dir = op.env.iter().find(|(k, _)| k == "CLAUDE_CONFIG_DIR").map(|(_, v)| PathBuf::from(v)).unwrap();
    let f = dir.join(".claude.json");
    let mut v: Value = std::fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    match op.args[1].as_str() {
        "add-json" => {
            if v["mcpServers"].get(&op.args[2]).is_some() {
                return Ok((false, format!("MCP server {} already exists in user config", op.args[2])));
            }
            v["mcpServers"][&op.args[2]] = serde_json::from_str(&op.args[3]).unwrap();
        }
        "remove" => {
            if v["mcpServers"].as_object_mut().and_then(|m| m.remove(&op.args[2])).is_none() {
                return Ok((false, "not found".into()));
            }
        }
        _ => panic!(),
    }
    std::fs::write(&f, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    Ok((true, format!("ok {SECRET}")))
}

#[test]
fn backup_undo_and_external_change() {
    let h = fake_home("undo");
    let env = env_of(&h);
    let root = h.join("backups");
    let claude_file = h.join(".claude-a").join(".claude.json");
    let oc_file = h.join("oc").join("opencode.json");
    let original = std::fs::read(&claude_file).unwrap();
    assert!(!oc_file.exists());
    let targets = vec![ids(&h)[0].clone(), ids(&h)[2].clone()];
    let r = apply(&env, &Change::Add { def: stdio_input("github"), targets: targets.clone(), replace: true }, &no_source, &root, &fake_claude).unwrap();
    assert_eq!(r.steps.iter().map(|s| s.status).collect::<Vec<_>>(), ["ok", "ok"], "{:?}", r.steps);
    assert_eq!(r.steps.iter().map(|s| s.verified).collect::<Vec<_>>(), [Some(true), Some(true)]);
    assert!(!r.steps[0].msg.contains(SECRET), "CLI output must be scrubbed: {}", r.steps[0].msg);
    assert!(r.undo_id.is_some());
    let after = std::fs::read(&claude_file).unwrap();
    assert_ne!(after, original);
    assert!(oc_file.exists());
    let info = undo_info(&root).unwrap();
    assert_eq!(info.files.len(), 2);
    // Alguien cambia el fichero después: no se pisa nada, ni siquiera el otro fichero.
    std::fs::write(&claude_file, b"{\"changed\":true}").unwrap();
    let e = undo_last(&root).unwrap_err();
    assert!(e.contains(".claude.json"), "{e}");
    assert_eq!(std::fs::read(&claude_file).unwrap(), b"{\"changed\":true}");
    assert!(oc_file.exists());
    // Vuelve a estar como quedó → se deshace: Claude como antes, opencode.json (no existía) borrado.
    std::fs::write(&claude_file, &after).unwrap();
    undo_last(&root).unwrap();
    assert_eq!(std::fs::read(&claude_file).unwrap(), original);
    assert!(!oc_file.exists());
    assert!(undo_info(&root).is_none());
    assert!(undo_last(&root).is_err());
    // Un paso que no cambia nada no deja entrada de deshacer.
    let r = apply(&env, &Change::Remove { name: "nope".into(), targets: targets.clone(), include_local: false }, &no_source, &root, &fake_claude).unwrap();
    assert!(r.undo_id.is_none());
    // Rotación: 12 cambios → como mucho 10 copias por fichero y 10 entradas.
    for i in 0..12 {
        let mut d = stdio_input("rot");
        d.args = vec![format!("v{i}")];
        apply(&env, &Change::Add { def: d, targets: targets.clone(), replace: true }, &no_source, &root, &fake_claude).unwrap();
    }
    assert_eq!(read_journal(&root).len(), 10);
    for d in std::fs::read_dir(root.join("files")).unwrap().flatten() {
        let n = std::fs::read_dir(d.path()).unwrap().count();
        assert!(n <= 2 * KEEP_SNAPSHOTS, "{} has {n} snapshots", d.path().display());
    }
    // Y se puede deshacer el último: «rot» vuelve a v10.
    undo_last(&root).unwrap();
    let v: Value = serde_json::from_slice(&std::fs::read(&claude_file).unwrap()).unwrap();
    assert_eq!(v["mcpServers"]["rot"]["args"], json!(["v10"]));
    let _ = std::fs::remove_dir_all(&h);
}

#[test]
fn failed_cli_reports_and_keeps_going() {
    let h = fake_home("fail");
    let env = env_of(&h);
    let root = h.join("backups");
    let fail = |_: &CliOp| -> Result<(bool, String), String> { Ok((false, format!("boom {SECRET}"))) };
    let r = apply(&env, &Change::Add { def: stdio_input("new1"), targets: ids(&h), replace: false }, &no_source, &root, &fail).unwrap();
    assert_eq!(r.steps.iter().map(|s| s.status).collect::<Vec<_>>(), ["failed", "failed", "ok"]);
    assert!(r.steps[0].msg.contains("boom") && !r.steps[0].msg.contains(SECRET));
    let _ = std::fs::remove_dir_all(&h);
}

const OC: &str = r#"{
  "$schema": "https://opencode.ai/config.json",
  // tema elegido a mano
  "theme": "tokyonight",
  "mcp": {
    /* el de unity */
    "unityMCP": {
      "type": "remote",
      "url": "http://localhost:8080/mcp", // local
      "enabled": true
    },
    "other": { "type": "local", "command": ["x"] },
  },
  "provider": {} // fin
}
"#;

/// Nombres en el orden del fichero no se garantiza (serde_json ordena); se comparan ordenados.
fn names(t: &str) -> Vec<String> {
    let mut v: Vec<String> = parse_opencode(t).unwrap().into_iter().map(|d| d.name).collect();
    v.sort();
    v
}

#[test]
fn jsonc_edit_keeps_comments_and_format() {
    let v = json!({"type":"local","command":["npx","-y","pkg"],"enabled":true});
    // Añadir
    let a = jsonc::set_mcp(OC, "github", &v).unwrap();
    for keep in ["// tema elegido a mano", "/* el de unity */", "// local", "// fin", "\"theme\": \"tokyonight\""] {
        assert!(a.contains(keep), "lost {keep:?}:\n{a}");
    }
    assert_eq!(names(&a), ["github", "other", "unityMCP"]);
    assert!(a.contains("\n    \"github\": {\n      \"command\": ["), "indent:\n{a}");
    assert!(a.find("\"github\"").unwrap() > a.find("\"other\"").unwrap(), "new member goes last");
    assert_eq!(&a[..a.find("\"other\"").unwrap()], &OC[..OC.find("\"other\"").unwrap()], "text before must not change");
    // Sustituir
    let b = jsonc::set_mcp(&a, "unityMCP", &json!({"type":"remote","url":"http://h/mcp"})).unwrap();
    assert!(b.contains("/* el de unity */") && b.contains("// fin"));
    assert_eq!(parse_opencode(&b).unwrap().into_iter().find(|d| d.name == "unityMCP").unwrap().url.as_deref(), Some("http://h/mcp"));
    // Quitar (en medio, al final, el único)
    let c = jsonc::remove_mcp(&a, "other").unwrap();
    assert_eq!(names(&c), ["github", "unityMCP"]);
    assert!(c.contains("// tema elegido a mano") && c.contains("// fin"));
    assert!(!c.contains("\"other\""));
    let d = jsonc::remove_mcp(&c, "github").unwrap();
    assert_eq!(names(&d), ["unityMCP"]);
    let e = jsonc::remove_mcp(&d, "unityMCP").unwrap();
    assert!(names(&e).is_empty());
    assert!(e.contains("// fin") && e.contains("\"theme\""));
    assert!(jsonc::remove_mcp(&e, "unityMCP").is_err());
    // Quitar y volver a poner deja el fichero igual que estaba.
    assert_eq!(jsonc::remove_mcp(&a, "github").unwrap(), OC);
    // Sin clave mcp, objeto vacío, fichero vacío, BOM
    let f = jsonc::set_mcp("{\n  \"theme\": \"x\" // c\n}\n", "g", &v).unwrap();
    assert_eq!(names(&f), ["g"]);
    assert!(f.contains("// c"));
    let g = jsonc::set_mcp("{ \"mcp\": {} }", "g", &v).unwrap();
    assert_eq!(names(&g), ["g"]);
    let h = jsonc::set_mcp("", "g", &v).unwrap();
    assert_eq!(names(&h), ["g"]);
    let i = jsonc::set_mcp("\u{feff}{\"mcp\":{\"a\":{\"type\":\"local\",\"command\":[\"a\"]}}}", "g", &v).unwrap();
    assert_eq!(names(&i), ["a", "g"]);
    // Formato de `opencode mcp add` (2.2.5): mcp.servers.<name>
    let s = "{\n  \"mcp\": {\n    \"servers\": {\n      \"t3\": {\"type\":\"local\",\"command\":[\"z\"]}\n    }\n  }\n}\n";
    assert_eq!(names(s), ["t3"]);
    let s2 = jsonc::set_mcp(s, "t3", &v).unwrap();
    assert_eq!(parse_opencode(&s2).unwrap()[0].args, ["-y", "pkg"]);
    assert_eq!(names(&jsonc::remove_mcp(s, "t3").unwrap()).len(), 0);
    // Si ya usa `mcp.servers`, lo nuevo va también ahí.
    let s3 = jsonc::set_mcp(s, "nuevo", &v).unwrap();
    assert_eq!(names(&s3), ["nuevo", "t3"]);
    assert!(s3.find("\"nuevo\"").unwrap() > s3.find("\"servers\"").unwrap());
    // Cadena con llaves y comentarios dentro no confunde al escáner.
    let tricky = "{\"mcp\":{\"a\":{\"type\":\"local\",\"command\":[\"echo\",\"} // { /*\"]}}}";
    let t2 = jsonc::set_mcp(tricky, "b", &v).unwrap();
    assert_eq!(names(&t2), ["a", "b"]);
    assert_eq!(parse_opencode(&t2).unwrap().into_iter().find(|d| d.name == "a").unwrap().args, ["} // { /*"]);
}

#[test]
fn npm_shim_is_unwrapped() {
    let d = tmp("shim");
    let exe = d.join("node_modules").join("@opencode").join("cli").join("bin");
    std::fs::create_dir_all(&exe).unwrap();
    std::fs::write(exe.join("opencode.exe"), b"").unwrap();
    let shim = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe\"   %*\r\n";
    let (p, pre) = unwrap_cmd_shim(&d.join("opencode.cmd"), shim).unwrap();
    assert_eq!(p, exe.join("opencode.exe"));
    assert!(pre.is_empty());
    std::fs::create_dir_all(d.join("node_modules").join("pkg")).unwrap();
    std::fs::write(d.join("node_modules").join("pkg").join("cli.js"), b"").unwrap();
    std::fs::write(d.join("node.exe"), b"").unwrap();
    let node_shim = "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\node_modules\\pkg\\cli.js\" %*\r\n)";
    let (p, pre) = unwrap_cmd_shim(&d.join("x.cmd"), node_shim).unwrap();
    // node.exe del propio shim (vacío aquí) gana; el script va delante de los argumentos.
    assert!(p.ends_with("node.exe"));
    assert_eq!(pre, [d.join("node_modules").join("pkg").join("cli.js").to_string_lossy().into_owned()]);
    assert!(unwrap_cmd_shim(&d.join("y.cmd"), "@echo hi").is_none());
    let _ = std::fs::remove_dir_all(&d);
}

/// Prueba REAL de extremo a extremo con cuentas de PRUEBA nuevas (nunca las del usuario):
/// `%USERPROFILE%\.claude-orchtest`, `%USERPROFILE%\.codex-orchtest`, opencode en una carpeta temporal. Se borran al final.
/// `cargo test --bin orchestra real_e2e_isolated -- --ignored --nocapture`
#[test]
#[ignore]
fn real_e2e_isolated() {
    let home = PathBuf::from(std::env::var("USERPROFILE").unwrap());
    let cl = home.join(".claude-orchtest");
    let cx = home.join(".codex-orchtest");
    assert!(!cl.exists() && !cx.exists(), "test folders already exist; remove them first");
    std::fs::create_dir_all(&cl).unwrap();
    std::fs::create_dir_all(&cx).unwrap();
    let oc = tmp("e2e-oc");
    let root = tmp("e2e-backups");
    let env = Env { home: &home, opencode_dir: oc.join("opencode") };
    let cleanup = || {
        let _ = std::fs::remove_dir_all(&cl);
        let _ = std::fs::remove_dir_all(&cx);
        let _ = std::fs::remove_dir_all(&oc);
        let _ = std::fs::remove_dir_all(&root);
    };
    let r = std::panic::catch_unwind(|| {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("mcp_manager").join("fake_mcp.ps1");
        let def = DefInput {
            name: "orchtest-fake".into(),
            transport: "stdio".into(),
            command: Some("powershell".into()),
            args: vec!["-NoProfile".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-File".into(), script.to_string_lossy().into_owned()],
            env: vec![Kv { key: "FAKE_MODE".into(), value: "ok".into() }, Kv { key: "FAKE_SECRET".into(), value: SECRET.into() }],
            ..Default::default()
        };
        let targets = vec![format!("claude:{}", cl.display()), format!("codex:{}", cx.display()), "opencode:global".into()];
        let change = Change::Add { def, targets: targets.clone(), replace: false };
        for s in plan(&env, &change, &no_source).unwrap() {
            println!("PLAN {} {}: {}", s.public.account_id, s.public.action, s.public.lines.join(" | "));
        }
        let r = apply(&env, &change, &no_source, &root, &run_cli).unwrap();
        for s in &r.steps {
            println!("APPLY {} {} verified={:?}: {}", s.account_id, s.status, s.verified, s.msg);
        }
        assert!(r.steps.iter().all(|s| s.status == "ok" && s.verified == Some(true)), "{:?}", r.steps);
        let claude_env = vec![("CLAUDE_CONFIG_DIR".to_string(), cl.to_string_lossy().into_owned())];
        let codex_env = vec![("CODEX_HOME".to_string(), cx.to_string_lossy().into_owned())];
        let cli = |p: &'static str, a: &[&str], e: &[(String, String)]| run_cli(&CliOp { program: p, args: a.iter().map(|s| s.to_string()).collect(), env: e.to_vec(), cwd: None }).unwrap();
        let (_, out) = cli("claude", &["mcp", "list"], &claude_env);
        println!("claude mcp list: {}", short_msg(&out, &[SECRET.into()]));
        assert!(out.contains("orchtest-fake"), "{out}");
        let (_, out) = cli("codex", &["mcp", "list", "--json"], &codex_env);
        let list = parse_codex_list(&out).unwrap();
        println!("codex mcp list --json: {:?}", list.iter().map(|d| (&d.name, &d.command)).collect::<Vec<_>>());
        assert!(list.iter().any(|d| d.name == "orchtest-fake" && d.env.iter().any(|(k, v)| k == "FAKE_SECRET" && v == SECRET)));
        // opencode con su config de PRUEBA (XDG_*), nunca la real.
        let oc_env: Vec<(String, String)> = [("XDG_CONFIG_HOME", ""), ("XDG_DATA_HOME", "data"), ("XDG_STATE_HOME", "state")]
            .iter()
            .map(|(k, sub)| (k.to_string(), oc.join(sub).to_string_lossy().trim_end_matches('\\').to_string()))
            .collect();
        // `opencode mcp list` (2.2.5) solo enseña el estado de los servidores ya arrancados; la config cargada la da
        // `debug config` (que normaliza `mcp.<name>` a `mcp.servers.<name>`).
        let (_, out) = cli("opencode", &["debug", "config", "--standalone"], &oc_env);
        let path_json = serde_json::to_string(&env.opencode_dir.join("opencode.json").to_string_lossy()).unwrap();
        let loaded = out.contains("\"orchtest-fake\"") && out.contains(&path_json);
        println!("opencode debug config: test file loaded with orchtest-fake = {loaded}");
        assert!(loaded, "{out}");
        // Sonda con la definición que quedó en cada cuenta.
        let (cdef, cenv) = find_def(&home, &targets[0], "user", "orchtest-fake", None).unwrap();
        println!("probe claude: {:?}", probe_def(&cdef, &cenv, Duration::from_secs(15)));
        // Deshacer: los tres ficheros vuelven a como estaban.
        let u = undo_last(&root).unwrap();
        println!("UNDO {}: {:?}", u.summary, u.files);
        let (_, out) = cli("claude", &["mcp", "list"], &claude_env);
        assert!(!out.contains("orchtest-fake"), "after undo: {out}");
        let (_, out) = cli("codex", &["mcp", "list", "--json"], &codex_env);
        assert!(!parse_codex_list(&out).unwrap().iter().any(|d| d.name == "orchtest-fake"));
        println!("after undo: absent in claude and codex; opencode file exists = {}", env.opencode_dir.join("opencode.json").exists());
        // Otra vez y quitar con la función real.
        apply(&env, &change, &no_source, &root, &run_cli).unwrap();
        let r = apply(&env, &Change::Remove { name: "orchtest-fake".into(), targets: targets.clone(), include_local: false }, &no_source, &root, &run_cli).unwrap();
        for s in &r.steps {
            println!("REMOVE {} {} verified={:?}: {}", s.account_id, s.status, s.verified, s.msg);
        }
        assert!(r.steps.iter().all(|s| s.status == "ok" && s.verified == Some(true)), "{:?}", r.steps);
        let (_, out) = cli("codex", &["mcp", "list", "--json"], &codex_env);
        assert!(!parse_codex_list(&out).unwrap().iter().any(|d| d.name == "orchtest-fake"));
    });
    cleanup();
    assert!(!cl.exists() && !cx.exists(), "cleanup failed");
    println!("test folders removed");
    if let Err(e) = r {
        std::panic::resume_unwind(e);
    }
}

#[test]
fn add_in_local_or_project_scope_is_claude_only_and_runs_in_the_project() {
    let h = fake_home("scope");
    let env = env_of(&h);
    let proj = h.join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let mut d = stdio_input("db");
    d.scope = Some("project".into());
    d.project_path = Some(proj.to_string_lossy().into_owned());
    let steps = plan(&env, &Change::Add { def: d.clone(), targets: ids(&h), replace: false }, &no_source).unwrap();
    // Claude: se lanza desde la carpeta del proyecto y escribe su .mcp.json.
    let s = &steps[0].public;
    assert_eq!(s.blocked, None, "{s:?}");
    assert_eq!(PathBuf::from(&s.file), proj.join(".mcp.json"));
    assert!(s.lines[0].starts_with("cd ") && s.lines[0].ends_with("--scope project"), "{:?}", s.lines);
    match &steps[0].ops[0] {
        Op::Cli(c) => assert_eq!(c.cwd.as_deref(), Some(proj.to_string_lossy().as_ref())),
        _ => panic!(),
    }
    // Codex y opencode: no tienen ese ámbito → bloqueado con el motivo, nada que ejecutar.
    for s in &steps[1..] {
        assert!(s.public.blocked.as_deref().is_some_and(|b| b.contains("only has a global one")), "{:?}", s.public);
        assert!(s.ops.is_empty());
    }
    // Ya está en el .mcp.json con la misma definición → nada que hacer.
    let raw = def_from_input(&d).unwrap();
    std::fs::write(proj.join(".mcp.json"), json!({ "mcpServers": { "db": claude_json_of(&translate(&raw, "claude").unwrap()) } }).to_string()).unwrap();
    let steps = plan(&env, &Change::Add { def: d.clone(), targets: vec![ids(&h)[0].clone()], replace: false }, &no_source).unwrap();
    assert_eq!(steps[0].public.action, "skip", "{:?}", steps[0].public);
    // local: mismo .claude.json, `--scope local`; sin carpeta → bloqueado.
    d.scope = Some("local".into());
    let steps = plan(&env, &Change::Add { def: d.clone(), targets: vec![ids(&h)[0].clone()], replace: false }, &no_source).unwrap();
    assert!(steps[0].public.lines[0].ends_with("--scope local"));
    assert!(steps[0].public.file.ends_with(".claude.json"));
    d.project_path = None;
    let steps = plan(&env, &Change::Add { def: d, targets: vec![ids(&h)[0].clone()], replace: false }, &no_source).unwrap();
    assert!(steps[0].public.blocked.is_some());
    let _ = std::fs::remove_dir_all(&h);
}

/// Crítica v3, grave 5: el mismo MCP en usuario y en el local de un proyecto. «Quitar» toca solo el de usuario (fichero
/// de la cuenta, `--scope user`) y avisa de que el local se queda.
#[test]
fn remove_with_user_and_local_touches_only_user_and_says_so() {
    let h = tmp("rm2scopes");
    let cl = h.join(".claude-a");
    std::fs::create_dir_all(&cl).unwrap();
    let gh = json!({"type":"stdio","command":"npx","args":["-y","gh"]});
    std::fs::write(cl.join(".claude.json"), json!({"mcpServers": {"github": gh}, "projects": {"C:/Dev/game": {"mcpServers": {"github": gh}}}}).to_string()).unwrap();
    std::fs::create_dir_all(h.join("oc")).unwrap();
    let env = env_of(&h);
    let id = format!("claude:{}", cl.display());
    let steps = plan(&env, &Change::Remove { name: "github".into(), targets: vec![id], include_local: false }, &no_source).unwrap();
    assert_eq!(steps[0].public.action, "remove");
    assert_eq!(steps[0].public.file, cl.join(".claude.json").to_string_lossy());
    assert!(steps[0].public.lines[0].ends_with("claude mcp remove github --scope user"), "{:?}", steps[0].public.lines);
    assert!(steps[0].public.note.as_deref().unwrap_or("").contains("local scope"), "{:?}", steps[0].public.note);
    let _ = std::fs::remove_dir_all(&h);
}

/// Grave 4: «Igualar» a una versión que ya está en una cuenta no la toca (sin cambios); la que tiene otra se sustituye.
#[test]
fn equalize_skips_accounts_that_already_have_the_version() {
    let h = fake_home("equal");
    let env = env_of(&h);
    let src = |_: &SourceRef| -> Result<RawDef, String> {
        let mut d = def_from_input(&DefInput { name: "github".into(), transport: "stdio".into(), command: Some("npx".into()), args: vec!["-y".into(), "other".into()], env: vec![Kv { key: "GITHUB_TOKEN".into(), value: SECRET.into() }], ..Default::default() }).unwrap();
        d.scope = "user";
        Ok(d)
    };
    let from = SourceRef { account_id: ids(&h)[0].clone(), scope: "user".into(), name: "github".into(), project_path: None };
    let steps = plan(&env, &Change::Copy { from, targets: vec![ids(&h)[0].clone(), ids(&h)[2].clone()], replace: true, include_local: false }, &src).unwrap();
    assert_eq!(steps.iter().map(|s| s.public.action).collect::<Vec<_>>(), ["skip", "add"]);
    assert!(steps[0].public.note.as_deref().unwrap().contains("same definition"));
    let _ = std::fs::remove_dir_all(&h);
}

/// Crítica v4, grave 4: «Quitar» con la opción de incluir el ámbito local quita también la copia de cada proyecto con
/// `claude mcp remove <name> --scope local` lanzado EN esa carpeta (la CLI decide el proyecto por la carpeta actual).
#[test]
fn remove_including_local_runs_local_remove_in_each_project_folder() {
    let h = tmp("rmlocal");
    let cl = h.join(".claude-a");
    std::fs::create_dir_all(&cl).unwrap();
    let gh = json!({"type":"stdio","command":"npx","args":["-y","gh"]});
    std::fs::write(cl.join(".claude.json"), json!({"mcpServers": {"github": gh}, "projects": {"C:/Dev/game": {"mcpServers": {"github": gh}}, "C:/Dev/web": {"mcpServers": {"other": gh}}}}).to_string()).unwrap();
    std::fs::create_dir_all(h.join("oc")).unwrap();
    let env = env_of(&h);
    let id = format!("claude:{}", cl.display());
    let steps = plan(&env, &Change::Remove { name: "github".into(), targets: vec![id.clone()], include_local: true }, &no_source).unwrap();
    let l = &steps[0].public.lines;
    assert_eq!(l.len(), 2, "{l:?}");
    assert!(l[0].ends_with("claude mcp remove github --scope user"), "{l:?}");
    assert!(l[1].starts_with("cd C:/Dev/game && ") && l[1].ends_with("claude mcp remove github --scope local"), "{l:?}");
    match &steps[0].ops[1] {
        Op::Cli(op) => assert_eq!(op.cwd.as_deref(), Some("C:/Dev/game")),
        o => panic!("{o:?}"),
    }
    // Solo en local: sin la opción se salta; con ella, quita la del proyecto.
    std::fs::write(cl.join(".claude.json"), json!({"projects": {"C:/Dev/game": {"mcpServers": {"github": gh}}}}).to_string()).unwrap();
    let s0 = plan(&env, &Change::Remove { name: "github".into(), targets: vec![id.clone()], include_local: false }, &no_source).unwrap();
    assert_eq!(s0[0].public.action, "skip");
    let s1 = plan(&env, &Change::Remove { name: "github".into(), targets: vec![id], include_local: true }, &no_source).unwrap();
    assert_eq!(s1[0].public.action, "remove");
    assert_eq!(s1[0].public.lines.len(), 1);
    let _ = std::fs::remove_dir_all(&h);
}

/// «Igualar» con la opción de incluir el local: quita las copias locales con OTRA versión (seguirían ganando en su
/// carpeta); las que ya tienen la versión elegida se quedan.
#[test]
fn equalize_including_local_removes_only_differing_local_copies() {
    let h = tmp("eqlocal");
    let cl = h.join(".claude-a");
    std::fs::create_dir_all(&cl).unwrap();
    let a = json!({"type":"stdio","command":"npx","args":["-y","gh"]});
    let b = json!({"type":"stdio","command":"npx","args":["-y","gh@0.5.0"]});
    std::fs::write(cl.join(".claude.json"), json!({"mcpServers": {"github": b}, "projects": {"C:/Dev/old": {"mcpServers": {"github": b}}, "C:/Dev/new": {"mcpServers": {"github": a}}}}).to_string()).unwrap();
    std::fs::create_dir_all(h.join("oc")).unwrap();
    let env = env_of(&h);
    let id = format!("claude:{}", cl.display());
    let src = |_: &SourceRef| -> Result<RawDef, String> {
        let mut d = def_from_input(&DefInput { name: "github".into(), transport: "stdio".into(), command: Some("npx".into()), args: vec!["-y".into(), "gh".into()], ..Default::default() }).unwrap();
        d.scope = "user";
        Ok(d)
    };
    let from = SourceRef { account_id: "claude:elsewhere".into(), scope: "user".into(), name: "github".into(), project_path: None };
    let steps = plan(&env, &Change::Copy { from: from.clone(), targets: vec![id.clone()], replace: true, include_local: true }, &src).unwrap();
    let l = &steps[0].public.lines;
    assert_eq!(steps[0].public.action, "replace");
    assert!(l.iter().any(|x| x.starts_with("cd C:/Dev/old && ") && x.ends_with("--scope local")), "{l:?}");
    assert!(!l.iter().any(|x| x.contains("C:/Dev/new")), "la que ya es A se queda: {l:?}");
    let s0 = plan(&env, &Change::Copy { from, targets: vec![id], replace: true, include_local: false }, &src).unwrap();
    assert!(!s0[0].public.lines.iter().any(|x| x.contains("--scope local")));
    let _ = std::fs::remove_dir_all(&h);
}

// ---------- v7: acciones de estado (Aprobar / Encender / Apagar), en ficheros de prueba ----------

fn no_cli(_: &CliOp) -> Result<(bool, String), String> {
    Err("no CLI in state actions".into())
}

#[test]
fn approve_writes_settings_local_like_claude_code_and_undoes() {
    let h = fake_home("approve");
    let env = env_of(&h);
    let root = h.join("backups");
    let proj = h.join("proj");
    std::fs::create_dir_all(proj.join(".claude")).unwrap();
    std::fs::write(proj.join(".mcp.json"), r#"{"mcpServers":{"postgres":{"command":"pg"}}}"#).unwrap();
    let local = proj.join(".claude").join("settings.local.json");
    // Ya hay algo en settings.local.json (permisos): se conserva tal cual, solo se añade la lista.
    let before = "{\n  \"permissions\": {\n    \"allow\": [\"Bash(ls)\"]\n  }\n}\n";
    std::fs::write(&local, before).unwrap();
    let ch = Change::Approve { account_id: ids(&h)[0].clone(), name: "postgres".into(), project_path: proj.to_string_lossy().into_owned() };
    // Vista previa: el fichero exacto y la lista que queda.
    let p = plan(&env, &ch, &no_source).unwrap();
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].public.file, local.to_string_lossy());
    assert_eq!(p[0].public.lines, vec![r#"["enabledMcpjsonServers"] = ["postgres"]"#.to_string()]);
    let r = apply(&env, &ch, &no_source, &root, &no_cli).unwrap();
    assert_eq!(r.steps[0].status, "ok", "{:?}", r.steps);
    assert_eq!(r.steps[0].verified, Some(true));
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&local).unwrap()).unwrap();
    assert_eq!(v["enabledMcpjsonServers"], json!(["postgres"]));
    assert_eq!(v["permissions"]["allow"], json!(["Bash(ls)"]));
    // El lector de la vista lo da ya por aprobado.
    let cf = crate::mcp_manager::parse_claude_file("{}").unwrap();
    let (defs, _) = crate::mcp_manager::project_defs(&cf, None, &[proj.to_string_lossy().into_owned()]);
    assert_eq!(defs.iter().find(|d| d.name == "postgres").unwrap().enabled, Some(true));
    // Deshacer: el fichero vuelve a estar exactamente como antes.
    assert_eq!(undo_info(&root).unwrap().summary, "approve postgres");
    undo_last(&root).unwrap();
    assert_eq!(std::fs::read_to_string(&local).unwrap(), before);
    // Sin settings.local.json: se crea, y deshacer lo borra.
    std::fs::remove_file(&local).unwrap();
    apply(&env, &ch, &no_source, &root, &no_cli).unwrap();
    assert!(local.exists());
    undo_last(&root).unwrap();
    assert!(!local.exists());
}

#[test]
fn turn_off_and_on_in_claude_json_per_project() {
    let h = fake_home("toggle");
    let env = env_of(&h);
    let root = h.join("backups");
    let file = h.join(".claude-a").join(".claude.json");
    let original = std::fs::read_to_string(&file).unwrap();
    let off = Change::SetEnabled { account_id: ids(&h)[0].clone(), name: "onlylocal".into(), scope: "local".into(), project_path: Some(r"C:\p".into()), on: false };
    let p = plan(&env, &off, &no_source).unwrap();
    assert_eq!(p[0].public.lines, vec![r#"["projects"]["C:/p"]["disabledMcpServers"] = ["onlylocal"]"#.to_string()], "usa la clave del proyecto tal como la escribe Claude");
    let r = apply(&env, &off, &no_source, &root, &no_cli).unwrap();
    assert_eq!((r.steps[0].status, r.steps[0].verified), ("ok", Some(true)), "{:?}", r.steps);
    let cf = crate::mcp_manager::parse_claude_file(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(cf.defs.iter().find(|d| d.name == "onlylocal").unwrap().enabled, Some(false), "el lector lo ve apagado");
    // Encender: sale de la lista; el resto del fichero (el MCP de usuario con su secreto) sigue igual.
    let on = Change::SetEnabled { account_id: ids(&h)[0].clone(), name: "onlylocal".into(), scope: "local".into(), project_path: Some("C:/p".into()), on: true };
    apply(&env, &on, &no_source, &root, &no_cli).unwrap();
    let cf = crate::mcp_manager::parse_claude_file(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(cf.defs.iter().find(|d| d.name == "onlylocal").unwrap().enabled, Some(true));
    assert!(std::fs::read_to_string(&file).unwrap().contains(SECRET));
    // Ya encendido: nada que hacer (nota, sin pasos).
    let p = plan(&env, &on, &no_source).unwrap();
    assert!(p[0].ops.is_empty() && p[0].public.note.as_deref() == Some("already on"));
    // Deshacer dos veces → el fichero original.
    undo_last(&root).unwrap();
    undo_last(&root).unwrap();
    let back: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(back, serde_json::from_str::<Value>(&original).unwrap());
    // Codex: bloqueado con el motivo; opencode: `enabled` del servidor.
    let cx = Change::SetEnabled { account_id: ids(&h)[1].clone(), name: "github".into(), scope: "user".into(), project_path: None, on: false };
    assert!(plan(&env, &cx, &no_source).unwrap()[0].public.blocked.as_deref().unwrap().contains("config.toml"));
    std::fs::write(h.join("oc").join("opencode.json"), "{\n  // comentario\n  \"mcp\": {\n    \"x\": { \"type\": \"local\", \"command\": [\"x\"] }\n  }\n}\n").unwrap();
    let oc = Change::SetEnabled { account_id: "opencode:global".into(), name: "x".into(), scope: "global".into(), project_path: None, on: false };
    let r = apply(&env, &oc, &no_source, &root, &no_cli).unwrap();
    assert_eq!((r.steps[0].status, r.steps[0].verified), ("ok", Some(true)), "{:?}", r.steps);
    let t = std::fs::read_to_string(h.join("oc").join("opencode.json")).unwrap();
    assert!(t.contains("// comentario") && t.contains("\"enabled\": false"), "{t}");
}

#[test]
fn jsonc_set_path_keeps_the_rest() {
    let t = "{\n  \"a\": 1,\n  \"projects\": {\n    \"C:/p\": {\n      \"allowedTools\": []\n    }\n  }\n}\n";
    let out = jsonc::set_path(t, &["projects", "C:/p", "disabledMcpServers"], &json!(["x"])).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["projects"]["C:/p"]["disabledMcpServers"], json!(["x"]));
    assert!(out.starts_with("{\n  \"a\": 1,\n  \"projects\""), "{out}");
    let out2 = jsonc::set_path(&out, &["projects", "C:/q", "disabledMcpServers"], &json!([])).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&out2).unwrap()["projects"]["C:/q"]["disabledMcpServers"], json!([]));
    assert_eq!(jsonc::set_path("", &["k"], &json!(["n"])).unwrap(), "{\n  \"k\": [\n    \"n\"\n  ]\n}\n");
}
