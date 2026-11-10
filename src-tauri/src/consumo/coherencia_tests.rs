//! Una sola fuente de verdad: cada consejo cita la cifra de SU tarjeta (la misma agregación, el mismo periodo y
//! ámbito), su ahorro no pasa del coste de esa partida, y hoy / 7 días / sesión dan cifras distintas.
//! Y el exportador del demo de la interfaz (que sale de este mismo código).
use super::demo_gen::cuenta_demo;
use super::*;
use serde_json::json;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("orch-consumo-coh-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

fn rel(a: f64, b: f64) -> f64 {
    (a - b).abs() / a.abs().max(b.abs()).max(1e-12)
}

/// Cifra de la tarjeta según la pantalla global (ScanReport): (usd, eq, n).
fn card_global(rep: &ScanReport, card: &str) -> (f64, f64, u64) {
    if let Some(cat) = card.strip_prefix("cat:") {
        rep.cats
            .iter()
            .filter(|c| cat.split(',').any(|k| serde_json::to_value(c.cat).unwrap().as_str() == Some(k)))
            .map(|c| (c.usd, c.eq, c.count))
            .fold((0.0, 0.0, 0), |a, x| (a.0 + x.0, a.1 + x.1, a.2 + x.2))
    } else {
        let k = card.strip_prefix("event:").unwrap();
        rep.event_cost.iter().find(|e| e.0 == k).map(|e| (e.2, e.1, e.3)).unwrap_or_default()
    }
}

/// Cifra de la tarjeta según la pantalla de sesión (SessionReport): (eq, n). La sesión pinta eq.
fn card_session(s: &SessionReport, card: &str) -> (f64, u64) {
    let files: Vec<&FileReport> = std::iter::once(&s.main).chain(s.subagents.iter()).collect();
    if let Some(cat) = card.strip_prefix("cat:") {
        files
            .iter()
            .flat_map(|f| f.summary.cats.iter())
            .filter(|c| cat.split(',').any(|k| serde_json::to_value(c.cat).unwrap().as_str() == Some(k)))
            .fold((0.0, 0), |a, c| (a.0 + c.eq, a.1 + c.count))
    } else {
        let k = card.strip_prefix("event:").unwrap();
        files
            .iter()
            .flat_map(|f| f.summary.events.iter())
            .filter(|e| consejos::event_kind(e) == k)
            .fold((0.0, 0), |a, e| (a.0 + e.cost, a.1 + 1))
    }
}

fn opts(lang: &str) -> AdviceOpts {
    AdviceOpts { lang: lang.into(), ..Default::default() }
}

/// Comprueba un juego de consejos contra las tarjetas globales; devuelve cuántos tenían tarjeta.
fn check_global(tag: &str, rep: &ScanReport, advice: &[consejos::Consejo]) -> usize {
    let mut n = 0;
    for a in advice {
        assert!(a.save_usd <= a.card_usd * (1.0 + 1e-9) + 1e-12, "{tag} {}: ahorro {} > partida {}", a.id, a.save_usd, a.card_usd);
        assert!(a.save_usd <= rep.total.1 * (1.0 + 1e-9), "{tag} {}: ahorro > total", a.id);
        let Some(card) = a.card.as_deref() else { continue };
        n += 1;
        let (usd, eq, cnt) = card_global(rep, card);
        assert!(rel(a.card_usd, usd) < 1e-6 && rel(a.card_eq, eq) < 1e-6, "{tag} {}: consejo {} ≠ tarjeta {usd} ({card})", a.id, a.card_usd);
        assert_eq!(a.card_n, cnt, "{tag} {}: veces ({card})", a.id);
        if let Some(&v) = a.nums.get("n") {
            assert_eq!(v as u64, cnt, "{tag} {}: el texto cita {v} veces, la tarjeta {cnt}", a.id);
        }
        if a.rule == consejos::Regla::BaseFixed {
            assert_eq!(a.nums["baseMain"] as u64, rep.base_mean_main, "{tag}: base del principal");
            assert_eq!(a.nums["baseSub"] as u64, rep.base_mean_sub, "{tag}: base de subagente");
        }
    }
    n
}

#[test]
fn consejos_citan_su_tarjeta_hoy_7_dias_y_sesion() {
    let d = tmp("tarjetas");
    // Las 23:00 UTC de ayer: con `now()`, justo después de medianoche «hoy» aún no tenía sesiones y la prueba fallaba
    // según la hora (le pasó a la CI a las 00:00:08).
    let t = now() / 86400 * 86400 - 3600;
    let (acc, best) = cuenta_demo(&d, t, 8, 7);
    let idx = d.join("index.json");
    let cancel = AtomicBool::new(false);
    let mut shares = Vec::new();
    for (tag, since) in [("hoy", t / 86400 * 86400), ("7d", t - 7 * 86400)] {
        let (rep, facts) = scan_period(&[acc.clone()], 7, Some(since), &idx, &cancel, |_, _| {});
        assert!(rep.total.1 > 0.0, "{tag}");
        let advice = opts("es").run(&facts);
        let n = check_global(tag, &rep, &advice);
        assert!(n >= 3, "{tag}: solo {n} consejos con tarjeta: {:?}", advice.iter().map(|a| &a.id).collect::<Vec<_>>());
        let base = card_global(&rep, "cat:base").0 / rep.total.1;
        shares.push((base, advice.iter().find(|a| a.rule == consejos::Regla::CacheExpired).map(|a| a.save_pct)));
    }
    let (sess, facts) = session_with_facts(&best, 10).unwrap();
    let advice = opts("en").run(&facts);
    let mut n = 0;
    let total_eq: f64 = facts.total_eq();
    for a in &advice {
        assert!(a.save_usd <= a.card_usd * (1.0 + 1e-9) + 1e-12, "sesión {}: ahorro > partida", a.id);
        let Some(card) = a.card.as_deref() else { continue };
        n += 1;
        let (eq, cnt) = card_session(&sess, card);
        assert!(rel(a.card_eq, eq) < 1e-6, "sesión {}: consejo {} ≠ tarjeta {eq} ({card})", a.id, a.card_eq);
        assert_eq!(a.card_n, cnt, "sesión {}: veces ({card})", a.id);
    }
    assert!(n >= 2, "sesión: {n} consejos con tarjeta");
    let sess_base = card_session(&sess, "cat:base").0 / total_eq;
    // Hoy ≠ 7 días ≠ sesión (al menos el peso de la base).
    assert!(rel(shares[0].0, shares[1].0) > 0.01 && rel(shares[1].0, sess_base) > 0.01, "{shares:?} / {sess_base}");
    let _ = std::fs::remove_dir_all(&d);
}

/// Datos REALES, 7 días: consejos = tarjetas, top 5 con su ahorro, tamaño del informe y sin rutas personales.
/// `cargo test --release --bin orchestra consejos_tarjetas_reales -- --ignored --nocapture`
#[test]
#[ignore]
fn consejos_tarjetas_reales() {
    let dirs: Vec<PathBuf> = crate::accounts::scan().into_iter().map(|p| PathBuf::from(p.dir)).collect();
    let d = tmp("real");
    let cancel = AtomicBool::new(false);
    let t = now();
    let (rep, mut facts) = scan_period(&dirs, 7, Some(t - 7 * 86400), &d.join("index.json"), &cancel, |_, _| {});
    facts.history_bytes = Some(history_bytes(&dirs));
    let advice = opts("es").run(&facts);
    let n = check_global("real", &rep, &advice);
    println!("REAL 7 d: total {:.1} M eq · {:.2} USD · {} pet. · {} consejos ({n} con tarjeta, todos = tarjeta)", rep.total.0 / 1e6, rep.total.1, rep.requests, advice.len());
    for a in advice.iter().take(5) {
        println!("  {:>5.1} % ahorro · {:>8.2} USD de {:>8.2} ({}) · {}", a.save_pct * 100.0, a.save_usd, a.card_usd, a.card.as_deref().unwrap_or("-"), a.title.chars().take(90).collect::<String>());
    }
    let env = report_env(&dirs);
    for det in [informe::Detalle::Summary, informe::Detalle::Full] {
        let md = informe::markdown(&facts, &rep, &advice, &env, consejos::Lang::Es, det);
        let home = env.home.to_lowercase();
        assert!(!home.is_empty() && !md.to_lowercase().contains(&home), "ruta personal en el informe");
        for u in &env.users {
            assert!(!md.contains(&format!("\\{u}\\")) && !md.contains(&format!("/{u}/")), "usuario en el informe");
        }
        informe::check_tables(&md).unwrap();
        println!("informe {det:?}: {} KB, {} líneas", md.len() / 1024, md.lines().count());
    }
    let _ = std::fs::remove_dir_all(&d);
}

/// HERRAMIENTA: regenera src/lib/fixtures/consumo_demo.json (el modo demo de la interfaz) con el MISMO código que
/// los datos reales. `cargo test --bin orchestra exporta_demo_ts -- --ignored`
#[test]
#[ignore]
fn exporta_demo_ts() {
    let d = tmp("demo");
    // Hora fija redondeada: el demo corre todas las horas a «ahora» al cargarse.
    let t = now() / 3600 * 3600 + 1800;
    let (acc, best) = cuenta_demo(&d, t, 31, 2026);
    let idx = d.join("index.json");
    let cancel = AtomicBool::new(false);
    let env = informe::Entorno { home: "C:\\Users\\demo".into(), users: vec!["demo".into()], accounts: 1, mcp_servers: vec!["orchestra".into(), "sentry".into()] };
    let mut scans = serde_json::Map::new();
    let mut reports = serde_json::Map::new();
    for days in [1u64, 7, 30] {
        let since = if days == 1 { t / 86400 * 86400 } else { t - days * 86400 };
        let (mut rep, mut facts) = scan_period(&[acc.clone()], days, Some(since), &idx, &cancel, |_, _| {});
        rep.history_bytes = 19_700_000_000;
        facts.history_bytes = Some(rep.history_bytes);
        for lang in ["en", "es"] {
            let advice = opts(lang).run(&facts);
            consejos::cover_origins(&mut rep.origins, &facts, &advice);
            for (det, name) in [(informe::Detalle::Summary, "summary"), (informe::Detalle::Full, "full")] {
                let md = informe::markdown(&facts, &rep, &advice, &env, consejos::Lang::parse(lang), det);
                informe::check_tables(&md).unwrap();
                reports.insert(format!("{days}_{name}_{lang}"), json!(md));
            }
        }
        rep.advice_total = consejos::total_saving(&facts, &opts("en").run(&facts));
        let mut v = serde_json::to_value(&rep).unwrap();
        for lang in ["en", "es"] {
            v[format!("advice_{lang}")] = serde_json::to_value(opts(lang).run(&facts)).unwrap();
        }
        if let Some(o) = v.as_object_mut() {
            o.remove("advice");
        }
        scans.insert(days.to_string(), v);
    }
    let (mut sess, facts) = session_with_facts(&best, 10).unwrap();
    for lang in ["en", "es"] {
        consejos::cover_origins(&mut sess.origins, &facts, &opts(lang).run(&facts));
    }
    sess.advice_total = consejos::total_saving(&facts, &opts("en").run(&facts));
    let mut sv = serde_json::to_value(&sess).unwrap();
    for lang in ["en", "es"] {
        sv[format!("advice_{lang}")] = serde_json::to_value(opts(lang).run(&facts)).unwrap();
    }
    if let Some(o) = sv.as_object_mut() {
        o.remove("advice");
    }
    let json = serde_json::to_string(&json!({ "genNow": t, "scans": scans, "session": sv, "reports": reports })).unwrap();
    let json = json.replace(&acc.to_string_lossy().replace('\\', "\\\\"), "C:\\\\Users\\\\demo\\\\.claude");
    assert!(!json.contains("Temp") && !json.contains("orch-consumo"), "ruta sin tapar");
    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("src").join("lib").join("fixtures").join("consumo_demo.json");
    std::fs::write(&out, json + "\n").unwrap();
    println!("demo: {} KB", std::fs::metadata(&out).unwrap().len() / 1024);
    let _ = std::fs::remove_dir_all(&d);
}
