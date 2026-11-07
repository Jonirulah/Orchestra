//! Un solo total por periodo: todos los repartos (categoría, quién, modelo, proyecto, hora, consejos) suman lo mismo,
//! y el recorte por horas cuadra con el coste por bloques.
use super::*;
use serde_json::json;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("consumo").join("fixtures").join(name)
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("orch-consumo-per-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[allow(clippy::too_many_arguments)]
fn asst(id: &str, ts: &str, model: &str, inp: u64, cc: u64, cr: u64, out: u64, content: Value) -> String {
    json!({"type":"assistant","timestamp":ts,"message":{"id":id,"model":model,"content":content,
        "usage":{"input_tokens":inp,"cache_creation_input_tokens":cc,"cache_read_input_tokens":cr,"output_tokens":out,
        "cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":cc},
        "output_tokens_details":{"thinking_tokens":out/4}}}})
    .to_string()
}

fn user_result(ts: &str, id: &str, chars: usize) -> String {
    json!({"type":"user","timestamp":ts,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":"y".repeat(chars)}]}}).to_string()
}

fn read_call(id: &str, path: &str) -> Value {
    json!([{"type":"tool_use","id":id,"name":"Read","input":{"file_path":path}}])
}

/// Sesión de 3 horas (10:00 → 12:05 UTC del 7-nov-2026) con relecturas, caché caducada, cambio de modelo y compactación.
fn sesion(day: &str) -> Vec<String> {
    let m = "claude-opus-5-5";
    let t = |hm: &str| format!("2026-11-{day}T{hm}Z");
    let mut l = vec![asst("m1", &t("10:00:00"), m, 5, 30_000, 0, 400, read_call("r1", "x.rs"))];
    l.push(user_result(&t("10:00:02"), "r1", 40_000));
    l.push(asst("m2", &t("10:00:05"), m, 5, 10_500, 30_000, 300, read_call("r2", "y.rs")));
    l.push(user_result(&t("10:20:00"), "r2", 8000));
    l.push(asst("m2b", &t("10:20:05"), m, 5, 2400, 40_500, 300, read_call("r3", "z.rs")));
    l.push(user_result(&t("12:00:05"), "r3", 4000));
    l.push(asst("m3", &t("12:00:09"), m, 5, 44_300, 0, 100, json!([])));
    l.push(json!({"type":"user","timestamp":t("12:00:20"),"message":{"role":"user","content":"sigue"}}).to_string());
    l.push(asst("m4", &t("12:00:25"), "claude-sonnet-5-5", 5, 44_500, 0, 100, json!([])));
    l.push(
        json!({"type":"system","subtype":"compact_boundary","timestamp":t("12:05:00"),
        "compactMetadata":{"trigger":"auto","preTokens":44_600,"postTokens":9000}})
        .to_string(),
    );
    l.push(json!({"type":"user","isCompactSummary":true,"timestamp":t("12:05:01"),"message":{"role":"user","content":"z".repeat(20_000)}}).to_string());
    l.push(asst("m5", &t("12:05:10"), "claude-sonnet-5-5", 5, 39_000, 0, 100, read_call("r4", "w.rs")));
    l.push(user_result(&t("12:05:20"), "r4", 6000));
    l.push(asst("m6", &t("12:05:30"), "claude-sonnet-5-5", 5, 1600, 39_100, 200, json!([])));
    l
}

fn rel(a: f64, b: f64) -> f64 {
    (a - b).abs() / a.abs().max(b.abs()).max(1e-12)
}

fn analizado(lines: &[String]) -> Analysis {
    let mut a = Analysis::new(false);
    for l in lines {
        assert!(a.feed_line(l));
    }
    a
}

/// Las celdas (coste por hora) suman por categoría exactamente lo mismo que el coste por bloques, en la sesión
/// construida y en las fixtures reales; y el coste de bloque recortado a «todo» es el coste del bloque.
#[test]
fn celdas_cuadran_con_los_bloques() {
    let mut casos = vec![analizado(&sesion("07"))];
    for f in ["agent-lectura.jsonl", "agent-busqueda.jsonl"] {
        casos.push(analyze_file(&fixture(f)).unwrap());
    }
    for a in &casos {
        let lento = a.cats_from_blocks();
        let rapido = a.slice(0).cats;
        assert_eq!(lento.len(), rapido.len());
        for (x, y) in lento.iter().zip(&rapido) {
            assert_eq!((x.cat, x.count, x.t), (y.cat, y.count, y.t));
            assert!(rel(x.eq, y.eq) < 1e-9 && rel(x.usd, y.usd) < 1e-9, "{:?}: {} vs {}", x.cat, x.eq, y.eq);
        }
        let ends = a.seg_end();
        for (b, (e, u)) in a.blocks.iter().zip(a.block_costs_in(0)) {
            let (e0, u0) = a.block_cost(b, &ends);
            assert!(rel(e, e0) < 1e-9 && rel(u, u0) < 1e-9);
        }
    }
}

/// Recortar por horas: lo de antes + lo del periodo = todo, en total, por categoría y en cada bloque; y el reparto
/// por horas suma el total.
#[test]
fn recorte_por_horas_es_aditivo() {
    let a = analizado(&sesion("07"));
    let full = a.slice(0);
    let h12 = 1_794_052_800u64; // 2026-11-07T12:00:00Z
    assert_eq!(h12 % 3600, 0);
    let tarde = a.slice(h12);
    assert!(tarde.eq > 0.0 && tarde.eq < full.eq);
    // Lo de las 10-11 h: horas < 12.
    let manana: f64 = full.by_hour.iter().filter(|h| h.0 < h12 / 3600).map(|h| h.1).sum();
    assert!(rel(manana + tarde.eq, full.eq) < 1e-9);
    assert!(rel(full.by_hour.iter().map(|h| h.1).sum::<f64>(), full.eq) < 1e-9);
    assert!(rel(tarde.by_hour.iter().map(|h| h.1).sum::<f64>(), tarde.eq) < 1e-9);
    assert!(rel(tarde.by_model.iter().map(|m| m.1).sum::<f64>(), tarde.eq) < 1e-9);
    assert_eq!(tarde.requests, 4);
    // Cada bloque grande: coste de la tarde ≤ coste entero; el Read de x.rs (entra a las 10) se relee a las 12?
    // No: la caché caducó pero el tramo sigue, así que sí se relee en m3/m4 (antes de compactar).
    let todo = a.block_costs_in(0);
    let parte = a.block_costs_in(h12);
    for ((b, t), p) in a.blocks.iter().zip(&todo).zip(&parte) {
        assert!(p.0 <= t.0 + 1e-9, "{:?}", b);
    }
    let x = a.blocks.iter().position(|b| b.detail.as_deref() == Some("x.rs")).unwrap();
    assert!(parte[x].0 > 0.0 && parte[x].0 < todo[x].0);
    // El de w.rs (entra a las 12:05) cuesta lo mismo en los dos.
    let w = a.blocks.iter().position(|b| b.detail.as_deref() == Some("w.rs")).unwrap();
    assert!(rel(parte[w].0, todo[w].0) < 1e-9);
}

fn cuenta(d: &Path) -> PathBuf {
    let acc = d.join(".claude");
    let proj_a = acc.join("projects").join("C--proj-a");
    let proj_b = acc.join("projects").join("C--proj-b");
    std::fs::create_dir_all(&proj_a).unwrap();
    std::fs::create_dir_all(&proj_b).unwrap();
    let id = "11111111-2222-3333-4444-555555555555";
    std::fs::write(proj_a.join(format!("{id}.jsonl")), sesion("07").join("\n") + "\n").unwrap();
    let sub = proj_a.join(id).join("subagents");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(sub.join("agent-a1.jsonl"), std::fs::read_to_string(fixture("agent-lectura.jsonl")).unwrap()).unwrap();
    std::fs::write(sub.join("agent-a1.meta.json"), r#"{"agentType":"Explore","description":"buscar"}"#).unwrap();
    std::fs::write(proj_b.join("99999999-2222-3333-4444-555555555555.jsonl"), sesion("06").join("\n") + "\n").unwrap();
    acc
}

/// Σ partes = total en todos los repartos del escaneo global, para varios cortes (todo, desde el 7-nov, desde
/// las 12 h del 7-nov) — y los consejos usan ese mismo total.
#[test]
fn periodo_cuadra_en_todos_los_repartos() {
    let d = tmp("cuadra");
    let acc = cuenta(&d);
    let idx = d.join("index.json");
    let cancel = AtomicBool::new(false);
    let mut totales = Vec::new();
    for since in [1u64, 1_794_009_600, 1_794_052_800] {
        let (r, facts) = scan_period(&[acc.clone()], 3650, Some(since), &idx, &cancel, |_, _| {});
        let (te, tu) = r.total;
        assert!(te > 0.0, "since {since}");
        let sums: Vec<(&str, f64, f64)> = vec![
            ("categorías", r.cats.iter().map(|c| c.eq).sum(), r.cats.iter().map(|c| c.usd).sum()),
            ("quién", r.by_who.iter().map(|x| x.1).sum(), r.by_who.iter().map(|x| x.2).sum()),
            ("modelo", r.by_model.iter().map(|x| x.1).sum(), r.by_model.iter().map(|x| x.2).sum()),
            ("proyecto", r.by_project.iter().map(|x| x.1).sum(), r.by_project.iter().map(|x| x.2).sum()),
            ("horas", r.by_hour.iter().map(|x| x.1).sum(), r.by_hour.iter().map(|x| x.2).sum()),
            ("horas por categoría", r.by_hour_cat.iter().map(|x| x.2).sum(), r.by_hour_cat.iter().map(|x| x.3).sum()),
            ("consejos", facts.files.iter().map(|f| f.eq).sum(), facts.total_usd()),
        ];
        for (k, e, u) in sums {
            assert!(rel(e, te) < 0.005 && rel(u, tu) < 0.005, "since {since}: {k} {e} / {u} ≠ total {te} / {tu}");
        }
        // Cada hora apilada por categoría suma lo mismo que la hora (columnas apiladas = columna).
        for &(h, e, _, _) in &r.by_hour {
            let sc: f64 = r.by_hour_cat.iter().filter(|x| x.0 == h).map(|x| x.2).sum();
            assert!(rel(sc, e) < 1e-9, "hora {h}: {sc} ≠ {e}");
        }
        let reqs: u64 = r.by_hour.iter().map(|x| x.3).sum();
        assert_eq!(reqs, r.requests);
        assert_eq!(r.by_who.iter().map(|x| x.3).sum::<u64>(), r.requests);
        // El top y los sucesos no pasan del total.
        assert!(r.top.iter().map(|b| b.eq).sum::<f64>() <= te * 1.000001);
        totales.push((since, te, r.prev_total.0, r.compactions, r.files));
    }
    // Recortar más tarde da menos; y el corte de las 12 h deja fuera la sesión del 6 y la mañana del 7.
    assert!(totales[0].1 > totales[1].1 && totales[1].1 > totales[2].1, "{totales:?}");
    assert_eq!(totales[2].3, 1, "solo la compactación del 7");
    // Periodo anterior (mismas horas, justo antes): desde las 12 h → [00 h, 12 h) del 7 = la mañana del 7.
    let full = analizado(&sesion("07")).slice(0).eq;
    let tarde = analizado(&sesion("07")).slice(1_794_052_800).eq;
    // (el periodo anterior depende de la hora actual: al menos la mañana del 7, como mucho todo lo de antes de las 12 h)
    assert!(totales[2].2 >= (full - tarde) * (1.0 - 1e-6), "prev {} vs {}", totales[2].2, full - tarde);
    assert!(totales[2].2 <= (totales[0].1 - totales[2].1) * (1.0 + 1e-6));
    let _ = std::fs::remove_dir_all(&d);
}

/// Datos REALES (todas las cuentas): Σ partes = total en todas las vistas (hoy, 7 días, sesión). Imprime cifras sin rutas.
/// `cargo test --release --bin orchestra periodo_real_cuadra -- --ignored --nocapture`
#[test]
#[ignore]
fn periodo_real_cuadra() {
    let dirs: Vec<PathBuf> = crate::accounts::scan().into_iter().map(|p| PathBuf::from(p.dir)).collect();
    let idx = std::env::temp_dir().join("orch-consumo-real").join("index.json");
    let _ = std::fs::create_dir_all(idx.parent().unwrap());
    let cancel = AtomicBool::new(false);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let mut biggest: Option<(f64, String)> = None;
    for (name, days, since) in [("hoy (desde 00 h UTC)", 1u64, Some(now - now % 86400)), ("7 días", 7, None), ("30 días", 30, None)] {
        let t0 = std::time::Instant::now();
        let (r, facts) = scan_period(&dirs, days, since, &idx, &cancel, |_, _| {});
        let (te, tu) = r.total;
        let sums: Vec<(&str, f64, f64)> = vec![
            ("categorías", r.cats.iter().map(|c| c.eq).sum(), r.cats.iter().map(|c| c.usd).sum()),
            ("quién", r.by_who.iter().map(|x| x.1).sum(), r.by_who.iter().map(|x| x.2).sum()),
            ("modelo", r.by_model.iter().map(|x| x.1).sum(), r.by_model.iter().map(|x| x.2).sum()),
            ("proyecto", r.by_project.iter().map(|x| x.1).sum(), r.by_project.iter().map(|x| x.2).sum()),
            ("horas", r.by_hour.iter().map(|x| x.1).sum(), r.by_hour.iter().map(|x| x.2).sum()),
            ("consejos", facts.files.iter().map(|f| f.eq).sum(), facts.total_usd()),
        ];
        let worst = sums.iter().map(|(_, e, u)| rel(*e, te).max(rel(*u, tu))).fold(0.0, f64::max);
        let main: f64 = r.by_who.iter().filter(|x| x.0 == "main").map(|x| x.2).sum();
        eprintln!(
            "REAL {name}: total {:.1} M eq · {:.2} USD · anterior {:.2} USD · {} peticiones · {} ficheros · {} ms · peor desvío Σ {:.2e} · principal {:.1} % · sucesos {:?}",
            te / 1e6, tu, r.prev_total.1, r.requests, r.files, t0.elapsed().as_millis(), worst, 100.0 * main / tu,
            r.event_cost.iter().map(|e| format!("{} {}× {:.2} USD", e.0, e.3, e.2)).collect::<Vec<_>>()
        );
        assert!(worst < 0.005, "{name}: {sums:?} vs {te} / {tu}");
        assert_eq!(r.by_hour.iter().map(|x| x.3).sum::<u64>(), r.requests);
        if days == 7 {
            biggest = facts.files.iter().filter(|f| f.agent.is_none()).max_by(|a, b| a.usd.total_cmp(&b.usd)).map(|f| (f.usd, f.session.clone()));
        }
    }
    // Vista de sesión: la sesión principal más cara de los 7 días, con sus subagentes.
    let (_, path) = biggest.expect("sin sesiones");
    let (rep, facts) = session_with_facts(Path::new(&path), 10).unwrap();
    let main = rep.main.summary.cats.iter().map(|c| c.usd).sum::<f64>();
    let subs: f64 = rep.subagents.iter().map(|s| s.summary.cats.iter().map(|c| c.usd).sum::<f64>()).sum();
    let total = main + subs;
    eprintln!(
        "REAL sesión más cara: {:.2} USD · principal {:.1} % · {} subagentes {:.1} % · Σ consejos {:.2} USD",
        total, 100.0 * main / total, rep.subagents.len(), 100.0 * subs / total, facts.total_usd()
    );
    assert!(rel(facts.total_usd(), total) < 0.005);
}

/// A.4: el coste de cada fila del top se reproduce con su fórmula t × w + t × n × r (pesos reales), en 2 filas:
/// z.rs (entra a las 12 h en Opus y se relee 1 vez en Sonnet: r = 0,1) y x.rs recortado a las 12 h (entró antes:
/// w = 0; se relee en m3 Opus 0,05 y m4 Sonnet 0,1 → r = 0,075).
#[test]
fn formula_del_coste_reproduce_las_filas() {
    let a = analizado(&sesion("07"));
    let fila = |since: u64, d: &str| a.top_in(since, 50).into_iter().find(|b| b.detail.as_deref() == Some(d)).unwrap();
    let z = fila(0, "z.rs");
    let t = z.t as f64;
    assert!((z.eq - (t * z.w + t * z.n as f64 * z.r)).abs() < 1e-6 * z.eq, "{z:?}");
    assert_eq!(z.n, 1);
    assert!((z.r - 0.1).abs() < 1e-12, "r {}", z.r);
    assert!((z.w - 2.0).abs() < 0.001, "w {}", z.w);
    let x = fila(1_794_052_800, "x.rs");
    let t = x.t as f64;
    assert!((x.eq - (t * x.w + t * x.n as f64 * x.r)).abs() < 1e-6 * x.eq, "{x:?}");
    assert_eq!((x.w, x.n), (0.0, 2));
    assert!((x.r - 0.075).abs() < 1e-12, "r {}", x.r);
}

/// HERRAMIENTA: escribe `src/lib/fixtures/consumo_fixture.json` (escaneo global de la cuenta construida y la vista de
/// su sesión principal) para que los tests de la interfaz comprueben Σ partes = total con datos que salen de Rust.
/// `cargo test --bin orchestra exporta_fixture_ts -- --ignored`
#[test]
#[ignore]
fn exporta_fixture_ts() {
    let d = tmp("fixture");
    let acc = cuenta(&d);
    let cancel = AtomicBool::new(false);
    let (mut scan, facts) = scan_period(&[acc.clone()], 3650, Some(1), &d.join("index.json"), &cancel, |_, _| {});
    let main = acc.join("projects").join("C--proj-a").join("11111111-2222-3333-4444-555555555555.jsonl");
    let (mut sess, sfacts) = session_with_facts(&main, 10).unwrap();
    // C9: con consejos (de la sesión real «agent-lectura» como subagente) y orígenes, para los invariantes de la UI.
    let run = |l: &str| AdviceOpts { lang: l.into(), ..Default::default() };
    scan.advice = run("es").run(&facts);
    consejos::cover_origins(&mut scan.origins, &facts, &scan.advice);
    sess.advice = run("es").run(&sfacts);
    consejos::cover_origins(&mut sess.origins, &sfacts, &sess.advice);
    scan.advice_total = consejos::total_saving(&facts, &scan.advice);
    sess.advice_total = consejos::total_saving(&sfacts, &sess.advice);
    let json = serde_json::to_string_pretty(&json!({ "scan": scan, "session": sess })).unwrap();
    let json = json.replace(&acc.to_string_lossy().replace('\\', "\\\\"), "C:\\\\Users\\\\demo\\\\.claude");
    assert!(!json.contains("Temp") && !json.contains("orch-consumo"), "ruta sin tapar");
    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("src").join("lib").join("fixtures").join("consumo_fixture.json");
    std::fs::write(&out, json + "\n").unwrap();
    let _ = std::fs::remove_dir_all(&d);
}

/// C10: el Δ % solo vale si el periodo anterior está entero. Con 10 años de periodo no hay datos de antes del
/// anterior → incompleto; con 1 día desde la última hora de datos, sí los hay → completo.
#[test]
fn periodo_anterior_completo() {
    let d = tmp("prevcompleto");
    let acc = cuenta(&d);
    let cancel = AtomicBool::new(false);
    let (largo, _) = scan_period(&[acc.clone()], 3650, None, &d.join("i1.json"), &cancel, |_, _| {});
    assert!(largo.total.0 > 0.0);
    assert!(!largo.prev_complete, "10 años: el anterior no puede estar entero");
    // Un transcript viejo (fuera de la ventana de 2 días que se lista) = hubo uso antes del periodo anterior.
    let old = acc.join("projects").join("C--proj-b").join("99999999-2222-3333-4444-555555555555.jsonl");
    let year = std::time::SystemTime::now() - std::time::Duration::from_secs(365 * 86400);
    std::fs::File::options().write(true).open(&old).unwrap().set_modified(year).unwrap();
    let (corto, _) = scan_period(&[acc.clone()], 1, None, &d.join("i2.json"), &cancel, |_, _| {});
    assert!(corto.prev_complete, "hay datos de antes del día anterior");
    let _ = std::fs::remove_dir_all(&d);
}
