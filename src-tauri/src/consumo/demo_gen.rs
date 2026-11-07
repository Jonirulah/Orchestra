//! Transcripts sintéticos para el modo demo y para las pruebas de coherencia: sesiones con subagentes, lecturas,
//! Bash, skills, imágenes, pausas que caducan la caché y compactaciones, repartidas en los últimos `days` días.
//! El demo de la interfaz (src/lib/fixtures/consumo_demo.json) sale de aquí pasando por el MISMO código que los
//! datos reales (scan_period, session_with_facts, advise, informe::markdown).
use super::*;
use serde_json::json;

pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407))
    }
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
    }
    pub fn int(&mut self, a: u64, b: u64) -> u64 {
        a + ((b - a + 1) as f64 * self.next()) as u64
    }
    pub fn pick<'a, T>(&mut self, xs: &'a [(T, f64)]) -> &'a T {
        let mut x = self.next() * xs.iter().map(|p| p.1).sum::<f64>();
        for (v, w) in xs {
            if x < *w {
                return v;
            }
            x -= w;
        }
        &xs[xs.len() - 1].0
    }
}

pub fn iso(ts: u64) -> String {
    let s = ts % 86400;
    format!("{}T{:02}:{:02}:{:02}Z", informe::day_of(ts), s / 3600, (s / 60) % 60, s % 60)
}

/// Simulador de un fichero: lleva el contexto y escribe líneas con usage coherente (1 token ≈ 4 caracteres).
pub struct Sim {
    pub lines: Vec<String>,
    pub ts: u64,
    model: String,
    ctx: u64,
    pending: u64,
    last_req: u64,
    n: u32,
    hidden: u64,
}

impl Sim {
    /// `hidden`: tokens de sistema + herramientas que el transcript no muestra.
    pub fn new(ts: u64, model: &str, hidden: u64) -> Sim {
        Sim { lines: Vec::new(), ts, model: model.into(), ctx: 0, pending: 0, last_req: 0, n: 0, hidden }
    }
    fn usage(&mut self, out: u64) -> Value {
        let new = self.pending + if self.n == 0 { self.hidden } else { 0 };
        let expired = self.n > 0 && self.ts.saturating_sub(self.last_req) > 3600;
        let (cc, cr) = if self.n == 0 || expired { (self.ctx + new, 0) } else { (new, self.ctx) };
        self.ctx += new;
        self.pending = out;
        self.last_req = self.ts;
        self.n += 1;
        let think = out / 3;
        json!({"input_tokens":3,"cache_creation_input_tokens":cc,"cache_read_input_tokens":cr,"output_tokens":out,
            "cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":cc},
            "output_tokens_details":{"thinking_tokens":think}})
    }
    fn asst(&mut self, content: Value, out: u64) {
        let u = self.usage(out);
        let id = format!("msg_{}_{}", self.ts, self.n);
        self.lines.push(json!({"type":"assistant","timestamp":iso(self.ts),"message":{"id":id,"model":self.model,"content":content,"usage":u}}).to_string());
    }
    pub fn user(&mut self, chars: usize) {
        self.lines.push(json!({"type":"user","timestamp":iso(self.ts),"message":{"role":"user","content":"u".repeat(chars)}}).to_string());
        self.pending += chars as u64 / 4;
        self.ts += 20;
    }
    pub fn attach(&mut self, kind: &str, chars: usize) {
        // Como Claude Code: una skill cargada llega como `invoked_skills` con su nombre.
        let att = if kind == "skill" { json!({"type":"invoked_skills","skills":[{"name":"guia-de-estilo"}]}) } else { json!({"type":kind}) };
        self.lines.push(json!({"type":"attachment","timestamp":iso(self.ts),"attachment":att,"rendered":[{"content":"a".repeat(chars)}]}).to_string());
        self.pending += chars as u64 / 4;
    }
    /// Llamada a una herramienta y su resultado (`imgs` imágenes además del texto).
    pub fn call(&mut self, name: &str, input: Value, chars: usize, imgs: usize, out: u64, dt: u64) {
        let id = format!("tu{}", self.lines.len());
        self.asst(json!([{"type":"tool_use","id":id,"name":name,"input":input}]), out);
        self.ts += 2;
        let mut content = vec![json!({"type":"text","text":"y".repeat(chars)})];
        for _ in 0..imgs {
            content.push(json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}));
        }
        self.lines.push(json!({"type":"user","timestamp":iso(self.ts),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":content}]}}).to_string());
        self.pending += chars as u64 / 4 + imgs as u64 * 1600;
        self.ts += dt;
    }
    pub fn say(&mut self, out: u64) {
        self.asst(json!([{"type":"text","text":"ok"}]), out);
        self.ts += 30;
    }
    pub fn compact(&mut self) {
        let post = 9000;
        self.lines.push(json!({"type":"system","subtype":"compact_boundary","timestamp":iso(self.ts),"compactMetadata":{"trigger":"auto","preTokens":self.ctx,"postTokens":post}}).to_string());
        self.lines.push(json!({"type":"user","isCompactSummary":true,"timestamp":iso(self.ts + 1),"message":{"role":"user","content":"z".repeat(20_000)}}).to_string());
        self.ctx = self.hidden;
        self.pending = 5000;
        self.ts += 60;
    }
    pub fn context(&self) -> u64 {
        self.ctx
    }
}

const FILES: &[(&str, f64)] = &[
    ("src/lib/store.svelte.ts", 3.0),
    ("src-tauri/src/consumo.rs", 2.0),
    ("src/components/TerminalPane.svelte", 1.5),
    ("CLAUDE.md", 1.0),
    ("docs/dev-notes/_estado.md", 1.0),
    ("src/lib/backend.ts", 1.0),
    ("package.json", 0.5),
];
const BASH: &[(&str, f64)] = &[
    ("cargo test --bin app 2>&1", 3.0),
    ("npm run build", 1.5),
    ("npm test", 1.5),
    ("git diff", 1.0),
    ("cat src/lib/store.svelte.ts", 1.0),
    ("cargo test --bin app -- consumo | tail -5", 1.0),
    ("git log --oneline -5", 0.5),
];
const PROJECTS: &[(&str, f64)] = &[("C--Users-demo-code-app", 4.0), ("C--Users-demo-code-site", 1.5), ("C--Users-demo", 1.0), ("C--Users-demo-code-notes", 0.6)];
const SUBS: &[(&str, &str, f64)] = &[
    ("obrero", "claude-opus-5-5", 3.0),
    ("Explore", "claude-sonnet-5-5", 2.0),
    ("verificador", "claude-opus-5-5", 1.0),
    ("critico", "claude-opus-5-5", 1.0),
    ("peon", "claude-haiku-5-5", 1.5),
];

/// Pasos de trabajo de un fichero (hilo principal o subagente).
fn work(s: &mut Sim, r: &mut Rng, steps: u64, out_base: u64, main: bool, project_dir: &str) {
    for i in 0..steps {
        let x = r.next();
        let out = out_base + r.int(0, out_base);
        if x < 0.32 {
            let f = *r.pick(FILES);
            let chars = if f.ends_with("store.svelte.ts") || f.ends_with("consumo.rs") { r.int(60_000, 140_000) } else { r.int(2_000, 30_000) } as usize;
            s.call("Read", json!({"file_path": format!("{project_dir}\\{}", f.replace('/', "\\"))}), chars, 0, out, r.int(5, 40));
        } else if x < 0.55 {
            let c = *r.pick(BASH);
            let chars = if c.contains("tail") || c.contains("git log") { r.int(200, 800) } else { r.int(6_000, 70_000) } as usize;
            s.call("Bash", json!({"command": c}), chars, 0, out, r.int(20, 120));
        } else if x < 0.66 {
            s.call("Grep", json!({"pattern":"fn scan","path":"src"}), r.int(300, 3000) as usize, 0, out, r.int(3, 15));
        } else if x < 0.72 {
            s.call("Edit", json!({"file_path": format!("{project_dir}\\src\\lib\\store.svelte.ts")}), 200, 0, out * 2, r.int(5, 20));
        } else if x < 0.75 && main {
            s.attach("skill", r.int(30_000, 60_000) as usize);
            s.say(out);
        } else if x < 0.78 && main {
            s.call("Read", json!({"file_path": format!("{project_dir}\\docs\\shot-{i}.png")}), 100, r.int(1, 3) as usize, out, r.int(5, 20));
        } else if x < 0.83 && main {
            s.user(r.int(200, 1200) as usize);
            s.say(out);
        } else if x < 0.86 && main {
            // Pausa larga: la caché de 1 h caduca.
            s.ts += r.int(65, 160) * 60;
            s.user(300);
            s.say(out);
        } else {
            s.say(out * 3);
        }
        if s.context() > 220_000 {
            s.compact();
        }
    }
}

/// Escribe la cuenta sintética bajo `dir` (`<dir>/.claude/projects/...`). Sesiones entre `now - days` y `now`.
/// Devuelve (carpeta de la cuenta, ruta de la sesión más rica del último día).
pub fn cuenta_demo(dir: &Path, now: u64, days: u64, seed: u64) -> (PathBuf, PathBuf) {
    let acc = dir.join(".claude");
    let mut r = Rng::new(seed);
    let mut best: (usize, PathBuf) = (0, PathBuf::new());
    let mut k = 0u64;
    for d in (0..days).rev() {
        let day0 = (now / 86400 - d) * 86400;
        let n = if d == 0 { 3 } else { r.int(2, 4) };
        for j in 0..n {
            k += 1;
            let proj = *r.pick(PROJECTS);
            let pdir = acc.join("projects").join(proj);
            std::fs::create_dir_all(&pdir).unwrap();
            let id = format!("{:08x}-1111-4222-8333-{:012x}", seed as u32, k);
            // Hoy: sesiones que acaban antes de ahora.
            let start = if d == 0 { now.saturating_sub((3 - j) * 3 * 3600 + 3600) } else { day0 + 7 * 3600 + j * 4 * 3600 + r.int(0, 3600) };
            let project_dir = format!("C:\\Users\\demo\\code\\{}", proj.trim_start_matches("C--Users-demo-").replace("C--Users-demo", ""));
            let mut s = Sim::new(start, "claude-opus-5-5", 18_000);
            s.attach("nested_memory", r.int(30_000, 60_000) as usize);
            s.attach("skill_listing", r.int(20_000, 36_000) as usize);
            s.attach("deferred_tools_delta", 6_000);
            s.user(1500);
            let steps = r.int(18, 45);
            work(&mut s, &mut r, steps / 2, 300, true, &project_dir);
            let nsub = r.int(1, 4) as usize;
            let mut subs = Vec::new();
            for a in 0..nsub {
                let (ty, model, _) = SUBS[{
                    let w: Vec<(usize, f64)> = SUBS.iter().enumerate().map(|(i, s)| (i, s.2)).collect();
                    *r.pick(&w)
                }];
                let mut sa = Sim::new(s.ts + 30, model, 12_000);
                sa.attach("nested_memory", r.int(16_000, 40_000) as usize);
                sa.user(r.int(2_000, 6_000) as usize);
                let (st, ob) = match ty {
                    "obrero" => (r.int(30, 70), 900),
                    "verificador" => (r.int(20, 40), 600),
                    "critico" => (r.int(6, 14), 1400),
                    "Explore" => (r.int(15, 35), 250),
                    _ => (r.int(10, 30), 150),
                };
                work(&mut sa, &mut r, st, ob, false, &project_dir);
                sa.say(ob * 4);
                s.ts = sa.ts + 20;
                let res = r.int(3_000, 9_000) as usize;
                s.call("Agent", json!({"subagent_type": ty, "description": format!("{ty} {a}")}), res, 0, 400, 30);
                subs.push((format!("agent-a{a}{k:x}"), ty, sa.lines));
            }
            work(&mut s, &mut r, steps - steps / 2, 300, true, &project_dir);
            s.say(800);
            let path = pdir.join(format!("{id}.jsonl"));
            std::fs::write(&path, s.lines.join("\n") + "\n").unwrap();
            let sdir = pdir.join(&id).join("subagents");
            std::fs::create_dir_all(&sdir).unwrap();
            for (name, ty, lines) in &subs {
                std::fs::write(sdir.join(format!("{name}.jsonl")), lines.join("\n") + "\n").unwrap();
                std::fs::write(sdir.join(format!("{name}.meta.json")), json!({"agentType": ty, "description": format!("{ty}: tarea")}).to_string()).unwrap();
            }
            if d == 0 && subs.len() >= best.0 {
                best = (subs.len(), path.clone());
            }
        }
    }
    (acc, best.1)
}
