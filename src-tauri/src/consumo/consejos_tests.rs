use super::*;
use crate::consumo::{BreakCause, Cat, CatAgg, Event, EventKind};

fn cat(c: Cat, count: u64, usd: f64) -> CatAgg {
    CatAgg { cat: c, count, t: 0, eq: usd * 1e5, usd }
}

fn file(name: &str, agent: Option<&str>, usd: f64) -> FileFacts {
    FileFacts {
        session: format!("C:/x/projects/p/{name}.jsonl"),
        project: "p".into(),
        agent: agent.map(String::from),
        model: "claude-opus-5-5".into(),
        requests: 10,
        eq: usd * 1e5,
        usd,
        // Partidas holgadas: el ahorro de un consejo se recorta al coste de su partida (consejos.rs, card_value).
        cats: vec![cat(Cat::Output, 10, usd * 0.05), cat(Cat::Bash, 10, usd), cat(Cat::Read, 10, usd), cat(Cat::Image, 10, usd), cat(Cat::Reminder, 10, usd)],
        ..Default::default()
    }
}

fn blk(c: Cat, tool: &str, detail: &str, chars: u64, t: u64, usd: f64) -> FactBlock {
    FactBlock { cat: c, tool: Some(tool.into()), detail: Some(detail.into()), req: 1, chars, t, eq: usd * 1e5, usd, rereads: 9 }
}

fn run(files: Vec<FileFacts>) -> Vec<Consejo> {
    advise(&Facts { files, history_bytes: None, session: false }, &Umbrales::default(), Lang::En, &HashSet::new())
}

fn rules(v: &[Consejo]) -> Vec<Regla> {
    v.iter().map(|c| c.rule).collect()
}

#[test]
fn clave_de_comando() {
    assert_eq!(command_key("cd /e/x && cargo test --bin orchestra"), "cargo test");
    assert_eq!(command_key("FOO=1 npm run check"), "npm run");
    assert_eq!(command_key("tools/tests/runbench.sh --headless x"), "runbench.sh");
    assert_eq!(command_key("cd C:\\a; git log --oneline"), "git log");
    assert_eq!(command_key("python /tmp/x.py"), "python");
}

#[test]
fn regla_bash_dispara_agrupa_y_no_con_filtro() {
    let mut f = file("a", None, 100.0);
    f.blocks = vec![
        blk(Cat::Bash, "Bash", "cd /e/x && cargo test a", 40_000, 10_000, 2.0),
        blk(Cat::Bash, "Bash", "cargo test b", 40_000, 10_000, 2.0),
        blk(Cat::Bash, "Bash", "npm test", 20_000, 5_000, 1.0),
    ];
    let v = run(vec![f]);
    let b: Vec<&Consejo> = v.iter().filter(|c| c.rule == Regla::BashOutput).collect();
    assert_eq!(b.len(), 2, "{v:?}");
    assert!(b[0].title.contains("cargo test") && b[0].title.contains(" 2 "), "{}", b[0].title);
    // C11, a mano: 2 salidas de 10 k (2 USD cada una) recortadas a 3 k → 2 × 2 × (1 − 3000/10000) = 2,8; quedan 1,2.
    assert!((b[0].save_usd - 2.8).abs() < 1e-9, "{}", b[0].save_usd);
    assert!((b[0].after_usd - 1.2).abs() < 1e-9, "{}", b[0].after_usd);
    assert_eq!(b[0].assume, "bash");
    assert_eq!(b[0].assume_p["keepTok"], 3000);
    assert!((b[0].save_pct - 0.028).abs() < 1e-9);
    assert_eq!(b[0].evidence.len(), 2);
    // No dispara: filtrada o pequeña.
    let mut g = file("b", None, 100.0);
    g.blocks = vec![blk(Cat::Bash, "Bash", "cargo test 2>&1 | tail -20", 40_000, 10_000, 2.0), blk(Cat::Bash, "Bash", "ls", 4000, 1000, 1.0)];
    assert!(run(vec![g]).iter().all(|c| c.rule != Regla::BashOutput));
}

#[test]
fn regla_read_grande_y_relecturas() {
    let mut f = file("a", None, 100.0);
    f.blocks = vec![blk(Cat::Read, "Read", "/e/x/big.rs", 60_000, 15_000, 3.0)];
    for _ in 0..3 {
        f.blocks.push(blk(Cat::Read, "Read", "/e/x/small.rs", 8_000, 2_000, 0.5));
    }
    let v = run(vec![f]);
    assert!(rules(&v).contains(&Regla::BigRead), "{v:?}");
    let r = v.iter().find(|c| c.rule == Regla::Reread).expect("reread");
    assert!(r.title.contains("small.rs") && r.title.contains('3'));
    assert!((r.save_usd - 1.0).abs() < 1e-9); // 3 × 0,5 − la más barata
    // No dispara: fichero pequeño, leído 2 veces.
    let mut g = file("b", None, 100.0);
    g.blocks = vec![blk(Cat::Read, "Read", "/e/x/a.rs", 20_000, 5_000, 1.0), blk(Cat::Read, "Read", "/e/x/a.rs", 20_000, 5_000, 1.0)];
    let v = run(vec![g]);
    assert!(!rules(&v).contains(&Regla::BigRead) && !rules(&v).contains(&Regla::Reread), "{v:?}");
}

#[test]
fn regla_imagenes_solo_en_el_principal() {
    let img = |n| (0..n).map(|_| blk(Cat::Image, "Read", "shot.png", 6400, 1600, 0.2)).collect::<Vec<_>>();
    let mut main = file("m", None, 50.0);
    main.blocks = img(7);
    assert!(rules(&run(vec![main])).contains(&Regla::Images));
    let mut few = file("m2", None, 50.0);
    few.blocks = img(5);
    let mut sub = file("s", Some("critico"), 50.0);
    sub.blocks = img(12);
    assert!(!rules(&run(vec![few, sub])).contains(&Regla::Images));
}

#[test]
fn regla_reanudar_y_fork() {
    let mut s = file("s", Some("obrero"), 50.0);
    s.reqs = (0..10).map(|i| (if i < 5 { 100_000 } else { 350_000 }, 1e5, 1.0)).collect();
    s.user_turns = vec![0, 6];
    let v = run(vec![s.clone()]);
    let r = v.iter().find(|c| c.rule == Regla::Resume).expect("resume");
    assert!(r.save_usd > 3.0 && r.save_usd < 4.0, "{}", r.save_usd); // 4 peticiones × (1 − 40k/350k)
    // Mensaje que llega con poco contexto: no.
    s.user_turns = vec![0, 3];
    assert!(!rules(&run(vec![s])).contains(&Regla::Resume));
    // Fork con base heredada de 200k: sí; 30k: no.
    let mut f = file("f", Some("fork"), 50.0);
    f.base = 200_000;
    f.cats.push(cat(Cat::Base, 1, 10.0));
    assert!(rules(&run(vec![f.clone()])).contains(&Regla::Fork));
    f.base = 30_000;
    assert!(!rules(&run(vec![f])).contains(&Regla::Fork));
}

#[test]
fn regla_mecanico_en_modelo_caro() {
    let mut s = file("s", Some("obrero"), 40.0);
    s.cats.push(cat(Cat::Bash, 30, 1.0));
    s.output = 1000; // 100 por petición
    let v = run(vec![s.clone()]);
    let m = v.iter().find(|c| c.rule == Regla::MechModel).expect("mech");
    assert!(m.save_usd > 0.0 && m.save_usd < 40.0);
    let mut sonnet = s.clone();
    sonnet.model = "claude-sonnet-5-5".into();
    let mut writer = s.clone();
    writer.output = 50_000;
    let mut main = s;
    main.agent = None;
    assert!(!rules(&run(vec![sonnet, writer, main])).contains(&Regla::MechModel));
}

#[test]
fn regla_base_fija_y_skills_enteras() {
    let mut f = file("a", None, 100.0);
    f.base = 54_000;
    f.base_parts = vec![("nested_memory".into(), 22_000), ("skill_listing".into(), 17_000), ("user".into(), 500)];
    f.cats.push(cat(Cat::Base, 1, 30.0));
    let v = run(vec![f.clone()]);
    let b = v.iter().find(|c| c.rule == Regla::BaseFixed).expect("base");
    assert!(b.why.contains("nested_memory") && b.why.contains("skill_listing"), "{}", b.why);
    // C11, a mano: cada parte queda en un índice de 2 k → 30 × (22k − 2k + 17k − 2k)/54k = 30 × 35/54.
    assert!((b.save_usd - 30.0 * 35.0 / 54.0).abs() < 0.01, "{}", b.save_usd);
    assert!((b.after_usd - (b.origin_usd - b.save_usd)).abs() < 1e-9 && b.assume == "base");
    let parts = base_breakdown(&Facts { files: vec![f.clone()], history_bytes: None, session: false });
    assert!(parts.iter().any(|p| p.0 == "system+tools" && p.1 == 54_000 - 39_500));
    assert!((parts.iter().map(|p| p.3).sum::<f64>() - 30.0).abs() < 1e-9, "Σ partes = coste de la base");
    // Base barata (2 % del total): no.
    let mut g = f;
    g.cats.retain(|c| c.cat != Cat::Base);
    g.cats.push(cat(Cat::Base, 1, 2.0));
    assert!(!rules(&run(vec![g])).contains(&Regla::BaseFixed));
    // Skill de 51k inyectada entera: sí; recordatorio de 5k: no.
    let mut s = file("s", Some("obrero"), 100.0);
    s.blocks = vec![blk(Cat::Reminder, "skill", "claude-api", 200_000, 51_000, 0.9), blk(Cat::Reminder, "todo", "x", 20_000, 5_000, 0.3)];
    let v = run(vec![s]);
    let sk: Vec<_> = v.iter().filter(|c| c.rule == Regla::SkillWhole).collect();
    assert_eq!(sk.len(), 1);
    assert!(sk[0].title.contains("skill"));
}

#[test]
fn regla_caches() {
    let ev = |cause, cost| (Event { kind: EventKind::CacheBroken, req: 3, ts: 0, tokens: 90_000, cause: Some(cause), extra: 7200, cost }, cost / 1e5);
    let mut f = file("a", None, 100.0);
    f.events = vec![ev(BreakCause::Expired, 2e5), ev(BreakCause::Expired, 1e5), ev(BreakCause::PrefixChanged, 5e4), ev(BreakCause::ModelChanged, 9e5)];
    let v = run(vec![f]);
    let e = v.iter().find(|c| c.rule == Regla::CacheExpired).expect("expired");
    // Ahorro realista: sobrecoste menos compactar antes (sin compactaciones: resumen = 35 % del contexto).
    let want = (expired_saving(90_000, 2e5, 0.05, 0.35) + expired_saving(90_000, 1e5, 0.05, 0.35)) / 1e5;
    assert!(e.title.starts_with("2 ") && (e.save_usd - want).abs() < 1e-9 && e.save_usd < 3.0, "{} vs {want}", e.save_usd);
    assert!((e.card_usd - 3.0).abs() < 1e-9, "la tarjeta sigue siendo la partida entera");
    assert!(e.why.contains("35 %"), "{}", e.why);
    assert_eq!(e.evidence[0].label, "120 min");
    assert!(v.iter().any(|c| c.rule == Regla::CachePrefix && c.title.starts_with("1 ")));
    let mut g = file("b", None, 100.0);
    g.events = vec![(Event { kind: EventKind::Compaction, req: 3, ts: 0, tokens: 9, cause: None, extra: 1, cost: 0.0 }, 0.0)];
    assert!(run(vec![g]).iter().all(|c| !matches!(c.rule, Regla::CacheExpired | Regla::CachePrefix)));
}

/// Caso a mano (Opus 5.5: lectura 0,05× la entrada; escritura 1 h 2×). Contexto U = 100 000 reescrito en frío:
/// sobrecoste = U·(2 − 0,05) = 195 000. Alternativa: leer el contexto en caliente (U·0,05 = 5 000) + escribir un
/// resumen del 35 % (0,35·U·2 = 70 000) = 75 000. Ahorro = 195 000 − 75 000 = 120 000 (no 195 000).
#[test]
fn ahorro_cache_caducada_realista_caso_a_mano() {
    assert!((expired_saving(100_000, 195_000.0, 0.05, 0.35) - 120_000.0).abs() < 1e-6, "{}", expired_saving(100_000, 195_000.0, 0.05, 0.35));
    // Con un resumen medido del 10 %: 195 000 − (5 000 + 20 000) = 170 000.
    assert!((expired_saving(100_000, 195_000.0, 0.05, 0.10) - 170_000.0).abs() < 1e-6);
    // Si compactar sale más caro que reescribir, no hay ahorro (nunca negativo).
    assert_eq!(expired_saving(100_000, 10_000.0, 0.05, 0.9), 0.0);
    // Fracción medida en las compactaciones del periodo (antes 200k → después 30k y 100k → 15k: 45/300 = 0,15).
    let comp = |pre, post| (Event { kind: EventKind::Compaction, req: 1, ts: 0, tokens: pre, cause: None, extra: post, cost: 0.0 }, 0.0);
    let mut f = file("a", None, 100.0);
    f.events = vec![comp(200_000, 30_000), comp(100_000, 15_000)];
    let facts = Facts { files: vec![f.clone()], history_bytes: None, session: false };
    let (r, n) = post_compact_ratio(&facts);
    assert!((r - 0.15).abs() < 1e-9 && n == 2, "{r} {n}");
    assert_eq!(post_compact_ratio(&Facts { files: vec![file("b", None, 1.0)], history_bytes: None, session: false }), (0.35, 0));
    // En el consejo: 1 caducada de U = 100 000, sobrecoste 195 000 eq = 1,95 USD; ahorro con 0,15 = 195 000 − (5 000 + 30 000).
    f.events.push((Event { kind: EventKind::CacheBroken, req: 3, ts: 0, tokens: 100_000, cause: Some(BreakCause::Expired), extra: 7200, cost: 195_000.0 }, 1.95));
    let v = run(vec![f]);
    let e = v.iter().find(|c| c.rule == Regla::CacheExpired).expect("expired");
    assert!((e.save_eq - 160_000.0).abs() < 1e-6 && (e.save_usd - 1.6).abs() < 1e-9, "{} {}", e.save_eq, e.save_usd);
    assert!((e.card_usd - 1.95).abs() < 1e-9);
    assert!(e.why.contains("15 %") && e.why.contains("2 compactions"), "{}", e.why);
}

#[test]
fn regla_sesion_larga() {
    let mut f = file("a", None, 100.0);
    f.max_context = 600_000;
    f.reqs = vec![(300_000, 1e5, 1.0), (600_000, 2e5, 2.0)];
    let v = run(vec![f]);
    let l = v.iter().find(|c| c.rule == Regla::LongSession).expect("long");
    assert!((l.save_usd - 2.0 * 150.0 / 600.0).abs() < 1e-9);
    let mut g = file("b", None, 100.0);
    g.max_context = 200_000;
    g.requests = 100;
    assert!(!rules(&run(vec![g])).contains(&Regla::LongSession));
}

#[test]
fn regla_salida_y_razonamiento() {
    // peon (mecánico) en Opus: razonamiento 8 USD, salida 4 USD (con sus relecturas) de 100.
    let mut f = file("a", Some("peon"), 100.0);
    f.thinking = 100_000;
    f.output = 110_000;
    f.cats[0] = cat(Cat::Output, 10, 4.0);
    f.cats.push(cat(Cat::Thinking, 10, 8.0));
    f.gen_out = (3e5, 3.0);
    f.gen_think = (6e5, 6.0);
    let v = run(vec![f.clone()]);
    let t = v.iter().find(|c| c.rule == Regla::Output).expect("output");
    // C11, a mano: mecánico en Opus 5.5 → precio de salida de Sonnet 5.5 (10/20 = 0,5), razonamiento −30 % y
    // salida −20 %: después = 8 × 0,7 × 0,5 + 4 × 0,8 × 0,5 = 2,8 + 1,6 = 4,4 → ahorro 12 − 4,4 = 7,6.
    assert!((t.save_usd - 7.6).abs() < 1e-9, "{}", t.save_usd);
    assert!((t.after_usd - 4.4).abs() < 1e-9 && t.assume == "genCheap" && t.assume_p["model"] == "Sonnet 5.5", "{} {:?}", t.after_usd, t.assume_p);
    assert!((t.origin_usd - 12.0).abs() < 1e-9 && t.origin.starts_with("gen|peon|"));
    assert!((t.nums["genShare"] - 0.75).abs() < 1e-9);
    assert!(t.action.contains("effort: low") && t.action.contains("model: sonnet"), "{}", t.action);
    // Menos del 3 % del total: no sale.
    f.cats[0] = cat(Cat::Output, 10, 1.0);
    f.cats[5] = cat(Cat::Thinking, 10, 1.0);
    assert!(!rules(&run(vec![f])).contains(&Regla::Output));
}

#[test]
fn regla_disco() {
    let f = vec![file("a", None, 1.0)];
    let big = advise(&Facts { files: f.clone(), history_bytes: Some(39_000_000_000), session: false }, &Umbrales::default(), Lang::Es, &HashSet::new());
    let d = big.iter().find(|c| c.rule == Regla::Disk).expect("disk");
    assert!(d.title.contains("39,0 GB") && d.action.contains("cleanupPeriodDays"));
    assert_eq!(d.severity, Gravedad::Info);
    let small = advise(&Facts { files: f, history_bytes: Some(2_000_000_000), session: false }, &Umbrales::default(), Lang::Es, &HashSet::new());
    assert!(small.iter().all(|c| c.rule != Regla::Disk));
}

#[test]
fn orden_por_ahorro_descartes_y_umbral_ajustable() {
    let mut f = file("a", None, 100.0);
    f.blocks = vec![blk(Cat::Bash, "Bash", "cargo test", 40_000, 10_000, 1.0), blk(Cat::Read, "Read", "/x/big.rs", 60_000, 15_000, 9.0)];
    f.events = vec![(Event { kind: EventKind::CacheBroken, req: 3, ts: 0, tokens: 1, cause: Some(BreakCause::Expired), extra: 0, cost: 1.0 }, 5.0)];
    let v = run(vec![f.clone()]);
    assert!(v.len() >= 3);
    assert!(v.windows(2).all(|w| w[0].save_usd >= w[1].save_usd), "{:?}", v.iter().map(|c| c.save_usd).collect::<Vec<_>>());
    assert_eq!(v[0].rule, Regla::BigRead);
    // Los ids son estables y «Ya lo sé» quita ese caso.
    let again = run(vec![f.clone()]);
    assert_eq!(v.iter().map(|c| &c.id).collect::<Vec<_>>(), again.iter().map(|c| &c.id).collect::<Vec<_>>());
    let gone: HashSet<String> = [v[0].id.clone()].into();
    let w = advise(&Facts { files: vec![f.clone()], history_bytes: None, session: false }, &Umbrales::default(), Lang::En, &gone);
    assert_eq!(w.len(), v.len() - 1);
    assert!(w.iter().all(|c| c.id != v[0].id));
    // Umbral de Bash a 20k tokens: la salida de 10k deja de contar.
    let u = Umbrales { bash_tokens: 20_000, ..Default::default() };
    let x = advise(&Facts { files: vec![f], history_bytes: None, session: false }, &u, Lang::En, &HashSet::new());
    assert!(x.iter().all(|c| c.rule != Regla::BashOutput));
    // Umbrales parciales desde la interfaz.
    let p: Umbrales = serde_json::from_str(r#"{"bashTokens": 999}"#).unwrap();
    assert_eq!((p.bash_tokens, p.read_bytes), (999, 30_000));
}

#[test]
fn hechos_de_un_fichero_real_cuadran_con_el_resumen() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/consumo/fixtures");
    for name in ["agent-lectura.jsonl", "agent-busqueda.jsonl"] {
        let p = dir.join(name);
        let a = crate::consumo::analyze_file(&p).unwrap();
        let s = a.summary(0);
        let f = a.facts("k", "p", &crate::consumo::Who { agent_type: Some("Explore".into()), description: None });
        let total: f64 = s.cats.iter().map(|c| c.usd).sum();
        assert!((f.usd - total).abs() < 1e-12);
        let billed: f64 = f.reqs.iter().map(|r| r.2).sum();
        assert!((billed - total).abs() / total < 0.05, "{name}: factura {billed} vs bloques {total}");
        assert_eq!(f.requests as usize, f.reqs.len());
        assert!(!f.user_turns.is_empty(), "{name}: el encargo cuenta como primer turno");
    }
}

/// % a un decimal que cierran en 100,0 (mayor resto), también con restos empatados y partes diminutas.
#[test]
fn porcentajes_cierran_en_cien() {
    for xs in [vec![1.0, 1.0, 1.0], vec![0.333, 0.333, 0.334], vec![98.4, 0.8, 0.8, 0.0], vec![5.0, 0.0001, 0.0002, 7.0, 13.0], vec![1.0; 7]] {
        let r = round_shares(&xs);
        let sum: f64 = r.iter().sum();
        assert!((sum - 1.0).abs() < 1e-9, "{xs:?} → {r:?} suma {sum}");
        for (x, p) in xs.iter().zip(&r) {
            let exact = x / xs.iter().sum::<f64>();
            assert!((p - exact).abs() <= 0.001 + 1e-12, "{xs:?}: {p} lejos de {exact}");
            assert!((p * 1000.0 - (p * 1000.0).round()).abs() < 1e-9, "no es una décima: {p}");
        }
    }
    assert_eq!(round_shares(&[0.0, 0.0]), vec![0.0, 0.0]);
    assert_eq!(fmt_pct(0.1234), "12.3 %");
}

/// C9: dos `store.svelte.ts` de proyectos distintos son dos orígenes (antes se juntaban por nombre de fichero).
#[test]
fn origen_por_ruta_completa() {
    let mut a = file("a", None, 100.0);
    a.project = "C--app-uno".into();
    a.blocks = vec![blk(Cat::Read, "Read", "C:/uno/src/store.svelte.ts", 40_000, 10_000, 3.0)];
    let mut b = file("b", None, 100.0);
    b.project = "C--app-dos".into();
    b.blocks = vec![blk(Cat::Read, "Read", "D:/dos/lib/store.svelte.ts", 40_000, 10_000, 2.0); 2];
    let facts = Facts { files: vec![a, b], history_bytes: None, session: false };
    let o: Vec<_> = origins(&facts).into_iter().filter(|o| o.cat == Cat::Read).collect();
    assert_eq!(o.len(), 2, "{o:?}");
    assert_eq!((o[0].n, o[0].usd, o[0].label.as_str()), (2, 4.0, "D:/dos/lib/store.svelte.ts"));
    assert_eq!((o[1].n, o[1].usd), (1, 3.0));
    // Bash: comando normalizado.
    let mut c = file("c", None, 100.0);
    c.blocks = vec![blk(Cat::Bash, "Bash", "cd /e/x && cargo test --bin a", 9000, 3000, 1.0), blk(Cat::Bash, "Bash", "RUST_LOG=1 cargo test b", 9000, 3000, 1.0)];
    let o = origins(&Facts { files: vec![c], history_bytes: None, session: false });
    assert_eq!((o[0].key.as_str(), o[0].n), ("bash|cargo test", 2));
}

/// C11: el ahorro total sin doble conteo, a mano. Fichero de 100 USD: Bash 30, Salida 70. Consejo A quita 10 USD de
/// bloques de Bash; consejo B reduce TODO el fichero a la mitad (p. ej. modelo más barato). Aplicando los dos: Bash
/// queda 30 × (1 − 10/30) × 0,5 = 10 (ahorra 20), Salida 70 × 0,5 = 35 (ahorra 35) → 55, no 10 + 50 = 60.
#[test]
fn ahorro_total_sin_doble_conteo() {
    let mut f = file("a", None, 100.0);
    f.cats = vec![cat(Cat::Bash, 1, 30.0), cat(Cat::Output, 1, 70.0)];
    f.eq = 100.0;
    for c in f.cats.iter_mut() {
        c.eq = c.usd;
    }
    let mut b = f.clone();
    b.blocks = vec![blk(Cat::Bash, "Bash", "cargo test", 40_000, 10_000, 2.0)];
    let base = run(vec![b]).into_iter().find(|c| c.rule == Regla::BashOutput).expect("bash");
    let mut a = base.clone();
    a.save_usd = 10.0;
    a.save_eq = 10.0;
    a.cells = vec![Cell { file: 0, part: "bash".into(), usd: 10.0, eq: 10.0, frac: false }];
    let mut m = base;
    m.save_usd = 50.0;
    m.save_eq = 50.0;
    m.cells = vec![Cell { file: 0, part: "*".into(), usd: 50.0, eq: 50.0, frac: true }];
    let facts = Facts { files: vec![f], history_bytes: None, session: false };
    let (u, e) = total_saving(&facts, &[a.clone(), m.clone()]);
    assert!((u - 55.0).abs() < 1e-9 && (e - 55.0).abs() < 1e-9, "{u} {e}");
    // Dos consejos de bloques DISTINTOS de la misma partida se suman (no se solapan).
    let mut a2 = a.clone();
    a2.cells[0].usd = 5.0;
    a2.cells[0].eq = 5.0;
    assert!((total_saving(&facts, &[a, a2]).0 - 15.0).abs() < 1e-9);
    // Uno solo: su ahorro.
    assert!((total_saving(&facts, &[m]).0 - 50.0).abs() < 1e-9);
}
