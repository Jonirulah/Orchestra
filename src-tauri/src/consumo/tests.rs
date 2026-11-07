use super::*;
use serde_json::json;
use std::io::Write;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("consumo").join("fixtures").join(name)
}

const FIXTURES: [&str; 2] = ["agent-lectura.jsonl", "agent-busqueda.jsonl"];

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("orch-consumo-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Petición del asistente con usage.
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

/// Igualdad de JSON con tolerancia en los números (serde_json no recupera un f64 bit a bit).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            (x - y).abs() <= 1e-9 * x.abs().max(y.abs()).max(1.0)
        }
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

fn feed_all(a: &mut Analysis, lines: &[String]) {
    for l in lines {
        assert!(a.feed_line(l));
    }
}

// (a) La suma de usage por petición es la misma que da tokens.rs.
#[test]
fn usage_igual_que_tokens_rs() {
    for f in FIXTURES {
        let p = fixture(f);
        let a = analyze_file(&p).unwrap();
        let s = a.summary(5);
        let t = crate::tokens::session_tokens(&p, false);
        assert!(s.requests >= 3, "{f}: pocas peticiones");
        assert_eq!(
            (s.usage.input, s.usage.output, s.usage.cache_read, s.usage.cache_create, s.usage.thinking),
            (t.input, t.output, t.cache_read, t.cache_create, t.thinking),
            "{f}"
        );
        assert_eq!(a.bad_lines, 0);
    }
}

// (b) Σ t de bloques (base y salidas incluidas) cuadra con el contexto de la última petición.
#[test]
fn bloques_cuadran_con_el_contexto() {
    for f in FIXTURES {
        let a = analyze_file(&fixture(f)).unwrap();
        assert_eq!(a.seg, 0, "{f}: sin compactación");
        let s = a.summary(5);
        let att = a.attributed_tokens(0);
        let last = s.last_context;
        // Exacto contando lo que encogió; y ±5 % sin contarlo.
        assert_eq!(att, last + a.shrink, "{f}");
        let dev = (att as f64 - last as f64).abs() / last as f64;
        assert!(dev <= 0.05, "{f}: desvío {dev:.3}");
        let has = |c: Cat| s.cats.iter().any(|x| x.cat == c && x.t > 0);
        assert!(has(Cat::Base) && has(Cat::Read) && has(Cat::Output), "{f}: {:?}", s.cats);
        assert!(s.top.iter().all(|b| b.cat != Cat::Base));
        let tot_eq: f64 = s.cats.iter().map(|c| c.eq).sum();
        assert!(tot_eq > 0.0);
        eprintln!(
            "{f}: {} pet., base {}, último ctx {last}, encogido {}, top {:?}",
            s.requests,
            s.base,
            a.shrink,
            s.top.first().map(|b| (&b.tool, b.t, b.eq.round()))
        );
    }
    let s = analyze_file(&fixture("agent-busqueda.jsonl")).unwrap().summary(5);
    assert!(s.cats.iter().any(|x| x.cat == Cat::Search && x.t > 0));
}

// Coste de un bloque: t·w_escritura + t·(peticiones posteriores)·w_lectura.
#[test]
fn coste_por_relecturas() {
    let m = "claude-opus-5-5";
    let mut a = Analysis::new(false);
    let mut l = vec![asst("m1", "2026-11-07T10:00:00Z", m, 10, 20_000, 0, 100, read_call("r1", "src/a.rs"))];
    l.push(user_result("2026-11-07T10:00:01Z", "r1", 40_000));
    // Entran 100 de salida + 10 000 del Read.
    l.push(asst("m2", "2026-11-07T10:00:05Z", m, 10, 10_100, 20_000, 50, json!([{"type":"text","text":"ok"}])));
    for i in 3..=6u64 {
        // Sin bloques nuevos: solo la salida anterior.
        l.push(asst(&format!("m{i}"), "2026-11-07T10:00:09Z", m, 10, 50, 30_100 + (i - 3) * 50, 50, json!([])));
    }
    feed_all(&mut a, &l);
    let s = a.summary(5);
    let b = &s.top[0];
    assert_eq!((b.cat, b.tool.as_deref(), b.detail.as_deref(), b.t), (Cat::Read, Some("Read"), Some("src/a.rs"), 10_000));
    assert_eq!(b.rereads, 4);
    let p = price(m, 0);
    // Escritura de m2: 10 de entrada + 10 100 a 1 h.
    let w = (10.0 + 10_100.0 * 2.0) / 10_110.0;
    let expect = 10_000.0 * w + 10_000.0 * 4.0 * (p.read / p.input);
    assert!((b.eq - expect).abs() < 1e-6, "{} vs {expect}", b.eq);
    assert_eq!(s.base, 20_010);
    assert_eq!(a.attributed_tokens(0), s.last_context);
}

// (c) Compactación, caché caducada, cambio de modelo y arranque en frío en un caso construido.
#[test]
fn eventos_compactacion_y_cache() {
    let m = "claude-opus-5-5";
    let mut a = Analysis::new(false);
    let mut l = vec![asst("m1", "2026-11-07T10:00:00Z", m, 5, 30_000, 0, 100, read_call("r1", "x.rs"))];
    l.push(user_result("2026-11-07T10:00:02Z", "r1", 4000));
    l.push(asst("m2", "2026-11-07T10:00:05Z", m, 5, 1100, 30_000, 100, read_call("r2", "y.rs")));
    // Dos horas sin nada: la caché de 1 h ha caducado y se reescribe todo.
    l.push(user_result("2026-11-07T12:00:05Z", "r2", 4000));
    l.push(asst("m3", "2026-11-07T12:00:09Z", m, 5, 32_300, 0, 100, json!([])));
    // Cambio de modelo enseguida: también se reescribe.
    l.push(json!({"type":"user","timestamp":"2026-11-07T12:00:20Z","message":{"role":"user","content":"sigue"}}).to_string());
    l.push(asst("m4", "2026-11-07T12:00:25Z", "claude-sonnet-5-5", 5, 32_500, 0, 100, json!([])));
    // Compactación.
    l.push(
        json!({"type":"system","subtype":"compact_boundary","timestamp":"2026-11-07T12:05:00Z",
        "compactMetadata":{"trigger":"auto","preTokens":32_600,"postTokens":9000}})
        .to_string(),
    );
    l.push(json!({"type":"user","isCompactSummary":true,"timestamp":"2026-11-07T12:05:01Z","message":{"role":"user","content":"z".repeat(20_000)}}).to_string());
    l.push(asst("m5", "2026-11-07T12:05:10Z", "claude-sonnet-5-5", 5, 39_000, 0, 100, json!([])));
    feed_all(&mut a, &l);
    let ev: Vec<(EventKind, u32, Option<BreakCause>)> = a.events.iter().map(|e| (e.kind, e.req, e.cause.clone())).collect();
    assert_eq!(
        ev,
        vec![
            (EventKind::ColdStart, 0, None),
            (EventKind::CacheBroken, 2, Some(BreakCause::Expired)),
            (EventKind::CacheBroken, 3, Some(BreakCause::ModelChanged)),
            (EventKind::Compaction, 4, None),
        ]
    );
    let c = a.events.iter().find(|e| e.kind == EventKind::Compaction).unwrap();
    assert_eq!((c.tokens, c.extra), (32_600, 9000));
    let gap = a.events.iter().find(|e| e.cause == Some(BreakCause::Expired)).unwrap().extra;
    assert_eq!(gap, 7200);
    // Tras compactar: tramo nuevo con la base reescrita y el resumen.
    assert_eq!(a.requests[4].seg, 1);
    let s = a.summary(5);
    assert!(s.cats.iter().any(|x| x.cat == Cat::Compact && x.t > 0));
    assert_eq!(a.attributed_tokens(1), 39_005);
    // Una petición normal (m2) no es caché rota.
    assert!(!a.events.iter().any(|e| e.req == 1));
}

// (d) Procesar en dos trozos (cortando a media línea y guardando el estado) == de una vez.
#[test]
fn incremental_dos_trozos_igual_que_entero() {
    for f in FIXTURES {
        let src = std::fs::read(fixture(f)).unwrap();
        let whole = analyze_file(&fixture(f)).unwrap();
        for cut in [src.len() / 3, src.len() / 2 + 7, src.len() - 5] {
            let d = tmp(&format!("inc{cut}"));
            let p = d.join("agent-s.jsonl");
            std::fs::write(&p, &src[..cut]).unwrap();
            let mut a = Analysis::new(true);
            a.feed_file(&p, None).unwrap();
            // Como en el índice: se guarda y se recupera.
            let mut a: Analysis = serde_json::from_str(&serde_json::to_string(&a).unwrap()).unwrap();
            let mut fh = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
            fh.write_all(&src[cut..]).unwrap();
            drop(fh);
            a.feed_file(&p, None).unwrap();
            assert_eq!(a.offset, src.len() as u64);
            let (x, y) = (serde_json::to_value(a.summary(20)).unwrap(), serde_json::to_value(whole.summary(20)).unwrap());
            assert!(same(&x, &y), "{f} cortado en {cut}:
{x}
{y}");
            let _ = std::fs::remove_dir_all(&d);
        }
    }
}

// (e) Una línea malformada se salta y se cuenta; no cambia nada más.
#[test]
fn linea_malformada_no_rompe() {
    let src = std::fs::read_to_string(fixture("agent-lectura.jsonl")).unwrap();
    let lines: Vec<&str> = src.lines().collect();
    let mid = lines.len() / 2;
    let mut bad = lines[..mid].join("\n");
    bad.push_str("\n{\"type\":\"assistant\",\"message\":{\"usage\":\n\u{0}basura sin json\n");
    bad.push_str(&lines[mid..].join("\n"));
    bad.push('\n');
    let d = tmp("bad");
    let p = d.join("agent-x.jsonl");
    std::fs::write(&p, bad).unwrap();
    let a = analyze_file(&p).unwrap();
    let ok = analyze_file(&fixture("agent-lectura.jsonl")).unwrap();
    assert_eq!(a.bad_lines, 2);
    let mut s = serde_json::to_value(a.summary(20)).unwrap();
    s["badLines"] = json!(0);
    assert!(same(&s, &serde_json::to_value(ok.summary(20)).unwrap()));
    // Bytes que no son UTF-8 tampoco rompen.
    let mut raw = std::fs::read(&p).unwrap();
    raw.extend_from_slice(b"\xff\xfe\n");
    std::fs::write(&p, raw).unwrap();
    assert_eq!(analyze_file(&p).unwrap().bad_lines, 3);
    let _ = std::fs::remove_dir_all(&d);
}

// Escaneo con índice: la segunda vez no lee nada; al crecer, solo lo nuevo; cuentas con `projects` compartido no duplican.
#[test]
fn escaneo_incremental_con_indice() {
    let d = tmp("scan");
    let acc = d.join(".claude");
    let proj = acc.join("projects").join("C--proj");
    let sess = proj.join("11111111-2222-3333-4444-555555555555");
    let subs = sess.join("subagents");
    std::fs::create_dir_all(&subs).unwrap();
    let main = proj.join("11111111-2222-3333-4444-555555555555.jsonl");
    let src = std::fs::read_to_string(fixture("agent-lectura.jsonl")).unwrap();
    // El principal lleva las mismas líneas pero sin sidechain.
    let main_txt = src.replace("\"isSidechain\":true", "\"isSidechain\":false");
    let half = main_txt.len() / 2;
    std::fs::write(&main, &main_txt.as_bytes()[..half]).unwrap();
    std::fs::copy(fixture("agent-busqueda.jsonl"), subs.join("agent-abc.jsonl")).unwrap();
    std::fs::write(subs.join("agent-abc.meta.json"), r#"{"agentType":"Explore","description":"buscar"}"#).unwrap();
    let idx = d.join("data").join("consumo").join("index.json");
    let cancel = AtomicBool::new(false);
    // Dos «cuentas» con la misma carpeta projects.
    let dirs = vec![acc.clone(), acc.clone()];
    let mut n = 0;
    let r1 = scan(&dirs, 7, &idx, &cancel, |_, _| n += 1);
    assert_eq!((r1.files, r1.main_files, r1.sub_files, r1.files_read), (2, 1, 1, 2));
    assert_eq!(n, 2);
    assert!(r1.by_who.iter().any(|w| w.0 == "sub:Explore"));
    let r2 = scan(&dirs, 7, &idx, &cancel, |_, _| {});
    assert_eq!(r2.files_read, 0);
    assert!(same(&serde_json::to_value(&r2.cats).unwrap(), &serde_json::to_value(&r1.cats).unwrap()));
    // Crece el principal: solo se lee lo añadido.
    let mut fh = std::fs::OpenOptions::new().append(true).open(&main).unwrap();
    fh.write_all(&main_txt.as_bytes()[half..]).unwrap();
    drop(fh);
    let r3 = scan(&dirs, 7, &idx, &cancel, |_, _| {});
    assert_eq!(r3.files_read, 1);
    assert!(r3.bytes_read < main_txt.len() as u64);
    let direct = analyze_file(&main).unwrap().summary(5);
    let sub = analyze_file(&subs.join("agent-abc.jsonl")).unwrap().summary(5);
    assert_eq!(r3.requests, direct.requests + sub.requests);
    assert!(direct.requests >= 3);
    let eq3: f64 = r3.cats.iter().map(|c| c.eq).sum();
    let eqd: f64 = direct.cats.iter().chain(sub.cats.iter()).map(|c| c.eq).sum();
    assert!((eq3 - eqd).abs() < 1e-6 * eqd.max(1.0), "{eq3} vs {eqd}");
    // Informe de sesión con sus subagentes.
    let rep = session_report(&main, 10).unwrap();
    assert_eq!(rep.subagents.len(), 1);
    assert_eq!(rep.subagents[0].who.agent_type.as_deref(), Some("Explore"));
    assert_eq!(rep.context_line.len() as u64, direct.requests);
    // El índice no guarda contenido: el relleno de las fixtures («xxxx…» largo) no está.
    let txt = std::fs::read_to_string(&idx).unwrap();
    assert!(!txt.contains(&"x".repeat(81)));
    // Cancelado: no procesa nada.
    cancel.store(true, Ordering::Relaxed);
    assert!(scan(&dirs, 7, &idx, &cancel, |_, _| {}).cancelled);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn precios_por_modelo() {
    let o = price("claude-opus-5-5[1m]", 0);
    assert_eq!((o.input, o.read, o.output), (4.0, 0.20, 20.0));
    assert_eq!((o.write_5m, o.write_1h), (5.0, 8.0));
    assert_eq!(price("claude-fable-5-1", 0).read, 0.25);
    assert_eq!(price("claude-fable-5", 0).read, 1.0);
    assert_eq!(price("claude-sonnet-5-5", 0).input, 2.0);
    assert_eq!(price("claude-haiku-5-5", 50_000).input, 0.10);
    assert_eq!(price("claude-haiku-5-5", 150_000).input, 0.50);
    assert_eq!(price("claude-haiku-4-5-20251001", 0).input, 1.0);
}

/// Medición real: `cargo test --bin orchestra consumo_real_7_dias -- --ignored --nocapture`.
/// Índice en %TEMP% (no toca los datos de Orchestra). Solo lee ~/.claude*.
/// Tabla de pesos fijada contra la skill `claude-api` (shared/prompt-caching.md § Economics y models.md, 2026-11-07):
/// lectura de caché 0,1× la entrada salvo Opus 5.5 (0,05×) y Fable 5.1 (0,025×); escritura 1,25× (5 min) y 2× (1 h);
/// salida 5× la entrada. Si cambia un precio, este test tiene que cambiar a la vez que la tabla.
#[test]
fn tabla_de_pesos_oficial() {
    let tabla: &[(&str, f64, f64)] = &[
        // (modelo, entrada $/M, lectura / entrada)
        ("claude-opus-5-5", 4.0, 0.05),
        ("claude-opus-5", 5.0, 0.1),
        ("claude-opus-4-8", 5.0, 0.1),
        ("claude-opus-4-7", 5.0, 0.1),
        ("claude-opus-4-6", 5.0, 0.1),
        ("claude-sonnet-5-5", 2.0, 0.1),
        ("claude-sonnet-5", 2.0, 0.1),
        ("claude-sonnet-4-6", 3.0, 0.1),
        ("claude-haiku-5-5", 0.10, 0.1),
        ("claude-haiku-4-5", 1.0, 0.1),
        ("claude-fable-5-1", 10.0, 0.025),
        ("claude-fable-5", 10.0, 0.1),
    ];
    for &(m, input, r) in tabla {
        let p = price(m, 0);
        let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
        assert!(close(p.input, input), "{m}: entrada {} ≠ {input}", p.input);
        assert!(close(p.read / p.input, r), "{m}: lectura {}× ≠ {r}×", p.read / p.input);
        assert!(close(p.write_5m / p.input, 1.25) && close(p.write_1h / p.input, 2.0), "{m}: escritura");
        assert!(close(p.output / p.input, 5.0), "{m}: salida {}× ≠ 5×", p.output / p.input);
    }
}

#[test]
#[ignore]
fn consumo_real_7_dias() {
    let dirs: Vec<PathBuf> = crate::accounts::scan().into_iter().map(|p| PathBuf::from(p.dir)).collect();
    let idx = std::env::temp_dir().join("orch-consumo-real").join("index.json");
    let _ = std::fs::remove_file(&idx);
    let cancel = AtomicBool::new(false);
    let r = scan(&dirs, 7, &idx, &cancel, |_, _| {});
    // Vista global de 7 días con el índice caliente: escaneo + JSON que va a la interfaz.
    let t_view = std::time::Instant::now();
    let r2 = scan(&dirs, 7, &idx, &cancel, |_, _| {});
    let json_len = serde_json::to_string(&r2).unwrap().len();
    let view_ms = t_view.elapsed().as_millis();
    eprintln!("VISTA GLOBAL 7 días (índice caliente): {view_ms} ms · JSON {:.1} KB · {} horas · {} proyectos · podadas {}",
        json_len as f64 / 1e3, r2.by_hour.len(), r2.by_project.len(), r2.pruned);
    assert!(view_ms < 2000, "vista global {view_ms} ms ≥ 2 s");
    let tot: f64 = r.cats.iter().map(|c| c.usd).sum();
    let tot_eq: f64 = r.cats.iter().map(|c| c.eq).sum();
    eprintln!(
        "cuentas {} · ficheros {} ({} principales, {} subagentes) · {:.2} GB leídos · {} ms · 2.ª pasada {} ms ({} leídos) · índice {:.1} MB · líneas malas {}",
        dirs.len(), r.files, r.main_files, r.sub_files, r.bytes_read as f64 / 1e9, r.elapsed_ms, r2.elapsed_ms, r2.files_read,
        r.index_bytes as f64 / 1e6, r.bad_lines
    );
    eprintln!(
        "peticiones {} · usage: entrada {} · escritura {} (5m {} / 1h {}) · lectura {} · salida {} (thinking {})",
        r.requests, r.usage.input, r.usage.cache_create, r.usage.cache_5m, r.usage.cache_1h, r.usage.cache_read, r.usage.output, r.usage.thinking
    );
    eprintln!("coste total: {:.1} M eq · {:.0} USD a precio de API · contexto encogido sin compactar {}", tot_eq / 1e6, tot, r.shrink);
    let mut cats = r.cats.clone();
    cats.sort_by(|a, b| b.usd.total_cmp(&a.usd));
    for c in &cats {
        eprintln!(
            "  {:<13} {:>5.1} %  t {:>12}  bloques {:>8}  {:>8.1} M eq",
            format!("{:?}", c.cat), 100.0 * c.usd / tot, c.t, c.count, c.eq / 1e6
        );
    }
    eprintln!("base media: principal {} · subagente {}", r.base_mean_main, r.base_mean_sub);
    eprintln!(
        "eventos: compactaciones {} · caché rota {} (caducada {}, modelo {}, prefijo {}) · arranques en frío {}",
        r.compactions, r.cache_breaks, r.break_causes.0, r.break_causes.1, r.break_causes.2, r.cold_starts
    );
    for w in r.by_who.iter().take(8) {
        eprintln!("  quién {:<22} {:>5.1} %  pet. {}", w.0, 100.0 * w.2 / tot, w.3);
    }
    for m in r.by_model.iter().take(6) {
        eprintln!("  modelo {:<24} {:>5.1} %  pet. {}", m.0, 100.0 * m.2 / tot, m.3);
    }
    for b in r.top.iter().take(5) {
        eprintln!(
            "  top {:?} {} {:?} · {} tok · relecturas {} · {:.2} M eq · {:.2} USD · {}",
            b.cat, b.tool.as_deref().unwrap_or("-"), b.detail.as_deref().unwrap_or(""), b.t, b.rereads, b.eq / 1e6, b.usd,
            b.who.as_deref().unwrap_or("")
        );
    }
}

#[test]
fn poda_del_indice_por_antiguedad_y_borrados() {
    let d = tmp("poda");
    let vivo = d.join("vivo.jsonl");
    let viejo = d.join("viejo.jsonl");
    std::fs::write(&vivo, "").unwrap();
    std::fs::write(&viejo, "").unwrap();
    let now = 1_800_000_000u64;
    let entry = |mtime: u64| IndexEntry { size: 0, mtime, who: Who::default(), analysis: Analysis::new(false) };
    let mut idx = Index { version: INDEX_VERSION, files: HashMap::new() };
    idx.files.insert(vivo.to_string_lossy().into_owned(), entry(now - 3 * 86400));
    idx.files.insert(viejo.to_string_lossy().into_owned(), entry(now - 91 * 86400));
    idx.files.insert(d.join("borrado.jsonl").to_string_lossy().into_owned(), entry(now));
    // Justo en el límite de 90 días se queda.
    let borde = d.join("borde.jsonl");
    std::fs::write(&borde, "").unwrap();
    idx.files.insert(borde.to_string_lossy().into_owned(), entry(now - 90 * 86400));
    assert_eq!(prune_index(&mut idx, now, INDEX_MAX_AGE_DAYS), 2);
    let mut keys: Vec<&String> = idx.files.keys().collect();
    keys.sort();
    assert_eq!(keys, vec![&borde.to_string_lossy().into_owned(), &vivo.to_string_lossy().into_owned()]);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn escaneo_poda_y_reparte_por_hora_y_proyecto() {
    let d = tmp("poda-scan");
    let acc = d.join(".claude");
    let proj = acc.join("projects").join("C--proj");
    std::fs::create_dir_all(&proj).unwrap();
    let main = proj.join("11111111-2222-3333-4444-555555555555.jsonl");
    let src = std::fs::read_to_string(fixture("agent-lectura.jsonl")).unwrap().replace("\"isSidechain\":true", "\"isSidechain\":false");
    std::fs::write(&main, &src).unwrap();
    let idx_path = d.join("index.json");
    let cancel = AtomicBool::new(false);
    // Las fixtures son de noviembre de 2026: con 3650 días entran todas sus peticiones.
    let r = scan(&[acc.clone()], 3650, &idx_path, &cancel, |_, _| {});
    let direct = analyze_file(&main).unwrap();
    let bill: f64 = direct.requests.iter().map(|q| q.bill().1).sum();
    // Las horas salen del mismo coste atribuido que las categorías (un solo total); ≈ factura ±5 %.
    let hours: f64 = r.by_hour.iter().map(|h| h.2).sum();
    assert!(bill > 0.0 && (hours - r.total.1).abs() < 1e-9, "{hours} vs {}", r.total.1);
    assert!((hours - bill).abs() / bill < 0.05, "{hours} vs {bill}");
    assert_eq!(r.by_project.len(), 1);
    assert_eq!(r.by_project[0].0, "C--proj");
    assert_eq!(r.by_project[0].3, direct.requests.len() as u64);
    // Factura ≈ coste atribuido por bloques (mismo dinero, otro reparto).
    let cats: f64 = r.cats.iter().map(|c| c.usd).sum();
    assert!((cats - bill).abs() / bill < 0.05, "bloques {cats} vs factura {bill}");
    // Una entrada vieja de otro fichero en el índice se poda al escanear.
    let mut idx = load_index(&idx_path);
    let otro = d.join("otro.jsonl");
    std::fs::write(&otro, "").unwrap();
    idx.files.insert(otro.to_string_lossy().into_owned(), IndexEntry { size: 0, mtime: 1, who: Who::default(), analysis: Analysis::new(false) });
    save_index(&idx_path, &idx).unwrap();
    let r2 = scan(&[acc.clone()], 3650, &idx_path, &cancel, |_, _| {});
    assert_eq!(r2.pruned, 1);
    assert_eq!(r2.files_read, 0);
    assert_eq!(load_index(&idx_path).files.len(), 1);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn escaneo_a_prioridad_baja_y_la_restaura() {
    let d = tmp("prio");
    let acc = d.join(".claude");
    let proj = acc.join("projects").join("C--p");
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::copy(fixture("agent-lectura.jsonl"), proj.join("11111111-2222-3333-4444-555555555555.jsonl")).unwrap();
    let before = LowPriority::current();
    let mut during = i32::MIN;
    let cancel = AtomicBool::new(false);
    scan(&[acc], 3650, &d.join("index.json"), &cancel, |_, _| during = LowPriority::current());
    if cfg!(windows) {
        assert_eq!(during, -1, "THREAD_PRIORITY_BELOW_NORMAL durante el escaneo");
    }
    assert_eq!(LowPriority::current(), before, "al acabar vuelve a la prioridad de antes");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn proyecto_de_una_ruta() {
    assert_eq!(project_of(Path::new(r"C:\Users\x\.claude\projects\E--app\s.jsonl")), "E--app");
    assert_eq!(project_of(Path::new(r"C:\Users\x\.claude\projects\E--app\s\subagents\agent-a.jsonl")), "E--app");
    assert_eq!(project_of(Path::new(r"C:\otro\s.jsonl")), "");
}

/// Consejos e informe con los datos reales de 7 días. El informe se escribe en %TEMP%\orch-consumo-real\ (nunca en el repo).
/// `cargo test --release --bin orchestra consejos_reales_7_dias -- --ignored --nocapture`
#[test]
#[ignore]
fn consejos_reales_7_dias() {
    let dirs: Vec<PathBuf> = crate::accounts::scan().into_iter().map(|p| PathBuf::from(p.dir)).collect();
    let idx = std::env::temp_dir().join("orch-consumo-real").join("index.json");
    let t0 = std::time::Instant::now();
    let opts = AdviceOpts { lang: "es".into(), ..Default::default() };
    let cancel = AtomicBool::new(false);
    let (rep, mut facts) = scan_full(&dirs, 7, &idx, &cancel, |_, _| {});
    facts.history_bytes = Some(history_bytes(&dirs));
    let advice = opts.run(&facts);
    let ms = t0.elapsed().as_millis();
    let total = facts.total_usd();
    let cats: f64 = rep.cats.iter().map(|c| c.usd).sum();
    assert!((total - cats).abs() / cats < 1e-9, "un solo total: hechos {total} vs categorías {cats}");
    eprintln!("CONSEJOS: {} en {ms} ms · total {:.0} USD · historial {:.1} GB", advice.len(), total, facts.history_bytes.unwrap() as f64 / 1e9);
    for a in advice.iter().take(30) {
        eprintln!("  [{:?}] {:<5} {} · ahorro {:.1} % ({:.1} M eq)", a.severity, format!("{:?}", a.rule), a.title, a.save_pct * 100.0, a.save_eq / 1e6);
    }
    let env = report_env(&dirs);
    let user = std::env::var("USERNAME").unwrap_or_default().to_lowercase();
    for (d, name) in [(informe::Detalle::Summary, "informe_resumen.md"), (informe::Detalle::Full, "informe_completo.md")] {
        let md = informe::markdown(&facts, &rep, &advice, &env, consejos::Lang::Es, d);
        let low = md.to_lowercase();
        assert!(user.len() < 3 || !low.contains(&user), "{name}: sale el nombre de usuario");
        assert!(!low.contains("users\\") && !low.contains("users/"), "{name}: sale una carpeta personal");
        assert!(!md.contains(".jsonl"), "{name}: sale la ruta de un transcript");
        let secciones: Vec<&str> = md.lines().filter(|l| l.starts_with("## ")).collect();
        eprintln!("INFORME {name}: {} bytes ≈ {} tokens · secciones: {}", md.len(), md.len().div_ceil(4), secciones.join(" | "));
        let _ = std::fs::write(idx.with_file_name(name), &md);
    }
}

#[test]
fn solo_se_abren_transcripts_de_las_cuentas() {
    let tmp = std::env::temp_dir().join(format!("orch-consumo-acc-{}", std::process::id()));
    let acc = tmp.join("acc");
    let proj = acc.join("projects").join("C--x");
    std::fs::create_dir_all(&proj).unwrap();
    let ok = proj.join("s.jsonl");
    std::fs::write(&ok, "").unwrap();
    let outside = tmp.join("other.jsonl");
    std::fs::write(&outside, "").unwrap();
    let not_jsonl = proj.join("s.txt");
    std::fs::write(&not_jsonl, "").unwrap();
    let dirs = vec![acc.clone()];
    assert!(is_account_transcript(&ok, &dirs));
    assert!(!is_account_transcript(&outside, &dirs));
    assert!(!is_account_transcript(&not_jsonl, &dirs));
    assert!(!is_account_transcript(&proj.join("..").join("..").join("..").join("other.jsonl"), &dirs));
    assert!(!is_account_transcript(&proj.join("nope.jsonl"), &dirs));
    let _ = std::fs::remove_dir_all(&tmp);
}
