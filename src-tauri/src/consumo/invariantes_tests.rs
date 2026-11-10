//! C9: ninguna cifra de un consejo puede contradecir la pantalla. Invariantes sobre la cuenta sintética del demo
//! (hoy, 7 días, sesión) y sobre las fixtures REALES (transcripts de verdad):
//! (a) ahorro ≤ coste del origen citado ≤ total;
//! (b) Σ ahorros de los consejos con el mismo origen (o la misma tarjeta) ≤ ese coste; Σ de todos ≤ total;
//! (c) lo que el consejo cita de una fila de «Bloques más caros» (veces, tokens, coste) = esa fila;
//! (d) el informe repite Contexto / Generado / total de la pantalla en eq, el mismo número de fechas que la gráfica
//!     y solo nombra modelos del periodo;
//! (e) en la vista de sesión los textos dicen «de la sesión».
use super::demo_gen::cuenta_demo;
use super::*;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("orch-consumo-inv-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

/// Las 23:00 UTC de ayer, para las cuentas de prueba: con la hora real, justo después de medianoche «hoy» aún no tenía
/// sesiones y estas pruebas fallaban según la hora (le pasó a la CI a las 00:00:08).
fn test_clock() -> u64 {
    now() / 86400 * 86400 - 3600
}

const TOL: f64 = 1e-9;

fn le(a: f64, b: f64) -> bool {
    a <= b * (1.0 + TOL) + 1e-9
}

fn opts(lang: &str) -> AdviceOpts {
    AdviceOpts { lang: lang.into(), ..Default::default() }
}

/// (a), (b) y (c). `shown` = orígenes que enseña la pantalla («Bloques más caros»).
pub fn check_advice(tag: &str, facts: &consejos::Facts, shown: &[consejos::Origen], advice: &[consejos::Consejo]) -> Result<(), String> {
    let (tu, te) = (facts.total_usd(), facts.total_eq());
    let all = consejos::origins(facts);
    let mut by_origin: HashMap<&str, (f64, f64, f64, f64)> = HashMap::new();
    let mut by_card: HashMap<&str, (f64, f64, f64, f64)> = HashMap::new();
    let (mut su, mut se) = (0.0, 0.0);
    for a in advice {
        let id = &a.id;
        // (a)
        if !le(a.save_usd, a.origin_usd) || !le(a.save_eq, a.origin_eq) {
            return Err(format!("{tag} (a) {id}: ahorro {:.4} USD / {:.0} eq > origen «{}» {:.4} / {:.0}", a.save_usd, a.save_eq, a.origin, a.origin_usd, a.origin_eq));
        }
        if !le(a.origin_usd, tu) || !le(a.origin_eq, te) {
            return Err(format!("{tag} (a) {id}: origen {:.4} > total {tu:.4}", a.origin_usd));
        }
        if (a.total_usd - tu).abs() > 1e-6 * tu.max(1.0) {
            return Err(format!("{tag} (a) {id}: total citado {} ≠ total {tu}", a.total_usd));
        }
        let o = by_origin.entry(a.origin.as_str()).or_insert((0.0, 0.0, a.origin_usd, a.origin_eq));
        o.0 += a.save_usd;
        o.1 += a.save_eq;
        if let Some(c) = a.card.as_deref() {
            let x = by_card.entry(c).or_insert((0.0, 0.0, a.card_usd, a.card_eq));
            x.0 += a.save_usd;
            x.1 += a.save_eq;
        }
        su += a.save_usd;
        se += a.save_eq;
        // (c) orígenes de bloques: la fila de la pantalla existe y es la misma cifra.
        if ["read|", "bash|", "image|", "reminder|"].iter().any(|p| a.origin.starts_with(p)) {
            let Some(row) = shown.iter().find(|o| o.key == a.origin) else {
                return Err(format!("{tag} (c) {id}: el origen «{}» no tiene fila en «Bloques más caros»", a.origin));
            };
            let full = all.iter().find(|o| o.key == a.origin).ok_or(format!("{tag} (c) {id}: origen desconocido"))?;
            if row != full {
                return Err(format!("{tag} (c) {id}: la fila {row:?} ≠ la agregación {full:?}"));
            }
            if a.origin_n != row.n || a.origin_t != row.t || (a.origin_usd - row.usd).abs() > 1e-9 || (a.origin_eq - row.eq).abs() > 1e-6 {
                return Err(format!("{tag} (c) {id}: consejo cita {}×/{} tok/{:.4} USD, la fila {}×/{} tok/{:.4}", a.origin_n, a.origin_t, a.origin_usd, row.n, row.t, row.usd));
            }
            if let Some(&n) = a.nums.get("rowN") {
                if n as u64 != row.n || !has_num(&a.title, &row.n.to_string()) {
                    return Err(format!("{tag} (c) {id}: el texto cita {n} veces, la fila {} («{}»)", row.n, a.title));
                }
            }
            if let Some(&t) = a.nums.get("rowT") {
                let ft = consejos::fmt_tok(row.t as f64);
                if t as u64 != row.t || !(a.title.contains(&ft) || a.title.contains(&ft.replace('.', ","))) {
                    return Err(format!("{tag} (c) {id}: el texto cita {t} tokens, la fila {} («{}»)", row.t, a.title));
                }
            }
        }
    }
    // (b)
    for (k, (u, e, ou, oe)) in &by_origin {
        if !le(*u, *ou) || !le(*e, *oe) {
            return Err(format!("{tag} (b): Σ ahorros del origen «{k}» {u:.4} USD > su coste {ou:.4}"));
        }
    }
    for (k, (u, e, cu, ce)) in &by_card {
        if !le(*u, *cu) || !le(*e, *ce) {
            return Err(format!("{tag} (b): Σ ahorros de la tarjeta «{k}» {u:.4} USD > la tarjeta {cu:.4}"));
        }
    }
    if !le(su, tu) || !le(se, te) {
        return Err(format!("{tag} (b): Σ de todos los ahorros {su:.4} > total {tu:.4}"));
    }
    // (g) C10: cada consejo lleva su clave de i18n (la interfaz lo traduce en su idioma, no en el del escaneo).
    if let Some(a) = advice.iter().find(|a| a.text_id.is_empty()) {
        return Err(format!("{tag} (g) {}: sin text_id: «{}»", a.id, a.title));
    }
    // C11 (i): antes → después. Ahorro ESTRICTAMENTE menor que el origen, después = origen − ahorro, con suposición.
    // (j): ahorro/origen ≤ 0,9 salvo las reglas de `may_exceed_90` (quitarlo casi todo es real; justificado allí).
    for a in advice.iter().filter(|a| a.rule != consejos::Regla::Disk) {
        if a.save_usd >= a.origin_usd || a.save_eq >= a.origin_eq {
            return Err(format!("{tag} (i) {}: ahorro {:.4} ≥ origen {:.4} («{}»)", a.id, a.save_usd, a.origin_usd, a.origin));
        }
        if (a.after_usd - (a.origin_usd - a.save_usd)).abs() > 1e-9 || (a.after_eq - (a.origin_eq - a.save_eq)).abs() > 1e-3 {
            return Err(format!("{tag} (i) {}: después {:.4} ≠ origen − ahorro {:.4}", a.id, a.after_usd, a.origin_usd - a.save_usd));
        }
        if a.assume.is_empty() {
            return Err(format!("{tag} (i) {}: sin suposición del «después»", a.id));
        }
        let r = a.save_eq / a.origin_eq.max(1e-9);
        if r > 0.9 && !consejos::may_exceed_90(a.rule) {
            return Err(format!("{tag} (j) {}: ahorra el {:.0} % de su origen «{}»", a.id, r * 100.0, a.origin));
        }
    }
    // (k): ahorro total sin doble conteo ≤ total del periodo y ≤ Σ ahorros (y ≥ el mayor de ellos).
    let (xu, xe) = consejos::total_saving(facts, advice);
    let mx = advice.iter().map(|a| a.save_eq).fold(0.0, f64::max);
    if !le(xu, tu) || !le(xe, te) || !le(xu, su) || !le(xe, se) || (xe + 1e-6 * te.max(1.0) < mx * 0.999) {
        return Err(format!("{tag} (k): ahorro total {xu:.4} USD / {xe:.0} eq; Σ {su:.4} / {se:.0}; total {tu:.4} / {te:.0}; mayor {mx:.0}"));
    }
    Ok(())
}

/// ¿`s` contiene el número `n` entero (no como parte de otro)?
fn has_num(s: &str, n: &str) -> bool {
    s.match_indices(n).any(|(i, _)| {
        let b = s[..i].chars().next_back().is_none_or(|c| !c.is_ascii_digit() && c != '.' && c != ',');
        let a = s[i + n.len()..].chars().next().is_none_or(|c| !c.is_ascii_digit());
        b && a
    })
}

/// Número como lo escribe el informe en «X M eq» (una cifra decimal, separador del idioma).
fn m1(x: f64, l: consejos::Lang) -> String {
    let s = format!("{:.1}", (x / 1e6).max(0.0));
    if l == consejos::Lang::Es {
        let (i, d) = s.split_once('.').unwrap();
        let mut g = String::new();
        for (k, ch) in i.chars().enumerate() {
            if k > 0 && (i.len() - k) % 3 == 0 {
                g.push('.');
            }
            g.push(ch);
        }
        format!("{g},{d} M")
    } else {
        let (i, d) = s.split_once('.').unwrap();
        let mut g = String::new();
        for (k, ch) in i.chars().enumerate() {
            if k > 0 && (i.len() - k) % 3 == 0 {
                g.push(',');
            }
            g.push(ch);
        }
        format!("{g}.{d} M")
    }
}

/// (d) informe contra la pantalla.
pub fn check_report(tag: &str, md: &str, rep: &ScanReport, l: consejos::Lang) -> Result<(), String> {
    let gen = |c: Cat| matches!(c, Cat::Output | Cat::Thinking);
    let ctx: f64 = rep.cats.iter().filter(|c| !gen(c.cat)).map(|c| c.eq).sum();
    let g: f64 = rep.cats.iter().filter(|c| gen(c.cat)).map(|c| c.eq).sum();
    let (lc, lg) = match l {
        consejos::Lang::Es => ("Contexto que entra", "Generado por el modelo"),
        consejos::Lang::En => ("Context that enters", "Generated by the model"),
    };
    let line = md.lines().find(|x| x.contains(lc)).ok_or(format!("{tag} (d): sin línea «{lc}»"))?;
    for (name, v) in [(lc, ctx), (lg, g)] {
        let want = format!("{name}: {} eq", m1(v, l));
        if !line.contains(&want) {
            return Err(format!("{tag} (d): falta «{want}» en «{line}»"));
        }
    }
    if !line.contains(&format!("{} eq", m1(rep.total.0, l))) {
        return Err(format!("{tag} (d): el total {} no sale en «{line}»", m1(rep.total.0, l)));
    }
    if !line.contains(&format!(": {} eq", m1(rep.total.0, l))) {
        return Err(format!("{tag} (d): total de la línea ≠ total de la pantalla ({})", m1(rep.total.0, l)));
    }
    // Pesos de la unidad: solo modelos del periodo, y todos ellos.
    let unit = md.lines().find(|x| x.contains("1 eq =")).ok_or(format!("{tag} (d): sin línea de unidad"))?;
    for fam in ["Opus", "Sonnet", "Haiku", "Fable"] {
        let present = rep.by_model.iter().any(|(m, ..)| m.to_lowercase().contains(&fam.to_lowercase()));
        if unit.contains(fam) != present {
            return Err(format!("{tag} (d): «{fam}» {} en la unidad y {} en «Por modelo»", if unit.contains(fam) { "sale" } else { "no sale" }, if present { "sí está" } else { "no está" }));
        }
    }
    // Periodo: tantas fechas como días de la gráfica.
    if rep.days > 1 {
        let per = md.lines().find(|x| x.starts_with(l.pick("- Period:", "- Periodo:"))).ok_or(format!("{tag} (d): sin periodo"))?;
        let dates: Vec<&str> = per.split(|c: char| !(c.is_ascii_digit() || c == '-')).filter(|w| w.len() == 10 && w.matches('-').count() == 2).collect();
        if dates.len() != 2 {
            return Err(format!("{tag} (d): periodo sin dos fechas: «{per}»"));
        }
        let day = |s: &str| {
            let p: Vec<i64> = s.split('-').map(|x| x.parse().unwrap()).collect();
            // días desde 1970 (Howard Hinnant, inverso)
            let (y, m, d) = (if p[1] <= 2 { p[0] - 1 } else { p[0] }, p[1], p[2]);
            let era = y.div_euclid(400);
            let yoe = y - era * 400;
            let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
            era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468
        };
        let n = day(dates[1]) - day(dates[0]) + 1;
        if n != rep.days as i64 {
            return Err(format!("{tag} (d): el informe cubre {n} fechas ({} a {}), la gráfica {}", dates[0], dates[1], rep.days));
        }
    }
    // (h) C10: los consejos que citan una tarjeta la nombran, no enseñan su clave («event:expired», «cat:base»).
    if let Some(x) = md.lines().find(|x| x.contains("«event:") || x.contains("«cat:")) {
        return Err(format!("{tag} (h): clave cruda de tarjeta en el informe: «{x}»"));
    }
    // (l) C11: cada consejo con «de X → ~Y» y su suposición; en ES ni «thinking» ni «permissionMode» ni «main»; sin
    // «: -» de un dato que falta; números de tokens como la pantalla («16,6 M», no «16.6M»).
    let advice_lines: Vec<&str> = md.lines().filter(|x| x.starts_with(|c: char| c.is_ascii_digit()) && x.contains("**") && !x.contains("informativ")).collect();
    if let Some(x) = advice_lines.iter().find(|x| !x.contains(" → ~") || !(x.contains("suponiendo") || x.contains("assuming"))) {
        return Err(format!("{tag} (l): consejo sin «antes → después» o sin suposición: «{x}»"));
    }
    if l == consejos::Lang::Es {
        for w in ["thinking", "permissionmode", "«main»", "(main)"] {
            if let Some(x) = md.lines().find(|x| x.to_lowercase().contains(w)) {
                return Err(format!("{tag} (l): «{w}» en el informe en español: «{x}»"));
            }
        }
    }
    if let Some(x) = md.lines().find(|x| x.trim_end().ends_with(": -")) {
        return Err(format!("{tag} (l): dato vacío «{x}»"));
    }
    let re_mixed = md.lines().filter(|_| l == consejos::Lang::Es).find(|x| {
        let b = x.as_bytes();
        (1..b.len()).any(|i| (b[i] == b'M' || b[i] == b'k') && b[i - 1].is_ascii_digit() && b.get(i + 1).is_none_or(|c| !c.is_ascii_alphabetic()))
    });
    if let Some(x) = re_mixed {
        return Err(format!("{tag} (l): número a la inglesa en ES («16.6M», la pantalla dice «16,6 M»): «{x}»"));
    }
    informe::check_tables(md).map_err(|e| format!("{tag} (d) tablas: {e}"))
}

/// (e) sesión.
pub fn check_session(tag: &str, advice: &[consejos::Consejo]) -> Result<(), String> {
    for a in advice {
        let txt = format!("{} {} {}", a.title, a.why, a.action);
        if !a.session || txt.contains("del periodo") || txt.contains("of the period") || txt.contains("en el periodo") || txt.contains("in the period") {
            return Err(format!("{tag} (e) {}: la sesión cita el periodo: «{txt}»", a.id));
        }
    }
    Ok(())
}

/// Corre (a)-(e) sobre una cuenta: hoy y 7 días (global) y la sesión `best`.
fn run_account(tag: &str, acc: &Path, best: &Path, t: u64, d: &Path) -> Result<usize, String> {
    let idx = d.join("index.json");
    let cancel = AtomicBool::new(false);
    let env = informe::Entorno { home: "C:\\Users\\demo".into(), users: vec!["demo".into()], accounts: 1, mcp_servers: vec![] };
    let mut n = 0;
    for (p, days, since) in [("hoy", 1u64, t / 86400 * 86400), ("7d", 7, (t / 86400 - 6) * 86400)] {
        let (mut rep, facts) = scan_period(&[acc.to_path_buf()], days, Some(since), &idx, &cancel, |_, _| {});
        for lang in ["es", "en"] {
            let advice = opts(lang).run(&facts);
            consejos::cover_origins(&mut rep.origins, &facts, &advice);
            check_advice(&format!("{tag} {p} {lang}"), &facts, &rep.origins, &advice)?;
            if lang == "es" {
                println!("{tag} {p}: {}", advice.iter().map(|a| format!("{:?} {:.2}/{:.2}", a.rule, a.save_usd, a.origin_usd)).collect::<Vec<_>>().join(" · "));
            }
            let l = consejos::Lang::parse(lang);
            for det in [informe::Detalle::Summary, informe::Detalle::Full] {
                let md = informe::markdown(&facts, &rep, &advice, &env, l, det);
                check_report(&format!("{tag} {p} {lang} {det:?}"), &md, &rep, l)?;
            }
            n += advice.len();
        }
    }
    let (mut sess, facts) = session_with_facts(best, 10).map_err(|e| e.to_string())?;
    for lang in ["es", "en"] {
        let advice = opts(lang).run(&facts);
        consejos::cover_origins(&mut sess.origins, &facts, &advice);
        check_advice(&format!("{tag} sesión {lang}"), &facts, &sess.origins, &advice)?;
        check_session(&format!("{tag} sesión {lang}"), &advice)?;
        n += advice.len();
    }
    Ok(n)
}

#[test]
fn invariantes_demo() {
    let d = tmp("demo");
    let t = test_clock();
    let (acc, best) = cuenta_demo(&d, t, 8, 7);
    let n = run_account("demo", &acc, &best, t, &d).unwrap();
    assert!(n >= 20, "pocos consejos: {n}");
    let _ = std::fs::remove_dir_all(&d);
}

/// Fixtures REALES (dos transcripts de verdad, con sus horas de verdad): se ponen como sesiones de hoy cambiando
/// solo la fecha de cada línea para que caigan en hoy y en 7 días.
#[test]
fn invariantes_fixture_real() {
    let d = tmp("real");
    let t = test_clock();
    let acc = d.join(".claude");
    let pdir = acc.join("projects").join("C--real-proyecto");
    let id = "11111111-2222-3333-4444-555555555555";
    let sub = pdir.join(id).join("subagents");
    std::fs::create_dir_all(&sub).unwrap();
    // Hilo principal mínimo; los dos transcripts reales son sus subagentes (son de subagente: isSidechain).
    let best = pdir.join(format!("{id}.jsonl"));
    let ts = secs_iso(t as i64 - 4 * 3600);
    std::fs::write(&best, format!("{{\"type\":\"user\",\"timestamp\":\"{ts}\",\"message\":{{\"role\":\"user\",\"content\":\"hola\"}}}}
")).unwrap();
    for (i, name) in ["agent-lectura.jsonl", "agent-busqueda.jsonl"].iter().enumerate() {
        let src = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/consumo/fixtures").join(name)).unwrap();
        // Corre las horas a hoy (mismo desfase para todas las líneas: intervalos y pausas reales).
        let first = src.lines().find_map(|l| serde_json::from_str::<serde_json::Value>(l).ok().and_then(|v| v["timestamp"].as_str().map(String::from)));
        let shift = first.map(|f| (t - 3600 * (i as u64 + 1)) as i64 - iso_secs(&f)).unwrap_or(0);
        let out: String = src
            .lines()
            .map(|l| match serde_json::from_str::<serde_json::Value>(l) {
                Ok(mut v) if v["timestamp"].is_string() => {
                    let s = iso_secs(v["timestamp"].as_str().unwrap()) + shift;
                    v["timestamp"] = serde_json::json!(secs_iso(s));
                    v.to_string() + "\n"
                }
                _ => l.to_string() + "\n",
            })
            .collect();
        std::fs::write(sub.join(format!("agent-a{i}.jsonl")), out).unwrap();
        std::fs::write(sub.join(format!("agent-a{i}.meta.json")), if i == 0 { r#"{"agentType":"peon"}"# } else { r#"{"agentType":"Explore"}"# }).unwrap();
    }
    let n = run_account("real", &acc, &best, t, &d).unwrap();
    assert!(n >= 4, "pocos consejos en la fixture real: {n}");
    let _ = std::fs::remove_dir_all(&d);
}

fn iso_secs(s: &str) -> i64 {
    let y: i64 = s[0..4].parse().unwrap();
    let m: i64 = s[5..7].parse().unwrap();
    let d: i64 = s[8..10].parse().unwrap();
    let (hh, mm, ss): (i64, i64, i64) = (s[11..13].parse().unwrap(), s[14..16].parse().unwrap(), s[17..19].parse().unwrap());
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    days * 86400 + hh * 3600 + mm * 60 + ss
}

fn secs_iso(s: i64) -> String {
    let day = informe::day_of(s as u64);
    let r = s.rem_euclid(86400);
    format!("{day}T{:02}:{:02}:{:02}.000Z", r / 3600, r % 3600 / 60, r % 60)
}

/// Datos REALES de la cuenta, 7 días: (a)-(d) y top 5 con «sobre X de Y». Sin rutas personales.
/// `cargo test --release --bin orchestra invariantes_reales -- --ignored --nocapture`
#[test]
#[ignore]
fn invariantes_reales() {
    let dirs: Vec<PathBuf> = crate::accounts::scan().into_iter().map(|p| PathBuf::from(p.dir)).collect();
    let d = tmp("cuenta");
    let cancel = AtomicBool::new(false);
    let t = now();
    // Como la interfaz: 7 días = desde la medianoche local de hace 6 días (aquí UTC+1 en invierno).
    let since = (t / 86400 - 6) * 86400 - 3600;
    let (mut rep, mut facts) = scan_period(&dirs, 7, Some(since), &d.join("index.json"), &cancel, |_, _| {});
    facts.history_bytes = Some(history_bytes(&dirs));
    let advice = opts("es").run(&facts);
    consejos::cover_origins(&mut rep.origins, &facts, &advice);
    check_advice("real", &facts, &rep.origins, &advice).unwrap();
    let env = report_env(&dirs);
    println!("REAL 7 d: total {:.1} M eq · {:.2} USD · {} pet. · {} consejos", rep.total.0 / 1e6, rep.total.1, rep.requests, advice.len());
    let (xu, xe) = consejos::total_saving(&facts, &advice);
    let (su, se) = advice.iter().fold((0.0, 0.0), |a, x| (a.0 + x.save_usd, a.1 + x.save_eq));
    println!("  ahorro total sin doble conteo {:.1} M eq ({:.2} USD, {:.1} %) · Σ consejos {:.1} M eq ({:.2} USD)", xe / 1e6, xu, xe / rep.total.0 * 100.0, se / 1e6, su);
    let mut by_eq: Vec<&consejos::Consejo> = advice.iter().collect();
    by_eq.sort_by(|a, b| b.save_eq.total_cmp(&a.save_eq));
    for a in by_eq.into_iter().take(5) {
        println!(
            "  de {:.1} M → ~{:.1} M (≈ {:.1} M eq · {:.1} %) [{} {:?}] de «{}» de {:.1} M eq · {}",
            a.origin_eq / 1e6,
            a.after_eq / 1e6,
            a.save_eq / 1e6,
            a.save_eq / rep.total.0 * 100.0,
            a.assume,
            a.assume_p,
            informe::anon(&a.origin_label, "", &env, 60),
            rep.total.0 / 1e6,
            informe::anon(&a.title, "", &env, 100)
        );
    }
    for det in [informe::Detalle::Summary, informe::Detalle::Full] {
        let md = informe::markdown(&facts, &rep, &advice, &env, consejos::Lang::Es, det);
        check_report(&format!("real {det:?}"), &md, &rep, consejos::Lang::Es).unwrap();
        let home = env.home.to_lowercase();
        assert!(!home.is_empty() && !md.to_lowercase().contains(&home), "ruta personal en el informe");
        for u in &env.users {
            assert!(!md.contains(&format!("\\{u}\\")) && !md.contains(&format!("/{u}/")), "usuario en el informe");
        }
        println!("informe {det:?}: {} KB, {} líneas", md.len() / 1024, md.lines().count());
        if det == informe::Detalle::Full {
            for l in md.lines().filter(|l| l.contains("Contexto que entra") || l.contains("Periodo:") || l.contains("1 eq =")) {
                println!("  {}", l.chars().take(400).collect::<String>());
            }
        }
    }
    let _ = std::fs::remove_dir_all(&d);
}
