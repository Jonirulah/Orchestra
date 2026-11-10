import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUPS, GROUP_COLOR, groupFill, groupOf, slices, fmtUsd, fmtPct, fmtGap, shortPath, projectLabel, projectKeyOf, encodeProject,
  dayStart, localDays, hoursOfToday, rankRows, globalModel, sessionModel, niceTicks, linePath, nearestIndex, whoType, CONSUMO_PROVIDERS,
  sumIssues, costFormula, midPath, fmtTok, fmtUnit, fmtDelta, fmtNum, periodSince, PERIODS, roundShares, groupTop, commandKey,
} from './consumo.ts';
import { readFileSync } from 'node:fs';
import { demoScanReport, demoSessionReport } from './consumodemo.ts';
import type { ConsumoCatAgg } from './backend.ts';

const agg = (cat: ConsumoCatAgg['cat'], eq: number, usd = eq / 1e6): ConsumoCatAgg => ({ cat, count: 1, t: eq / 10, eq, usd });

test('14 categorías → 7 grupos; contexto (por tamaño, «otros» al final) y luego generado; % sobre la unidad', () => {
  assert.equal(GROUPS.length, 7);
  assert.equal(groupOf('mcp'), 'other');
  assert.equal(groupOf('subagent'), 'other');
  assert.equal(groupOf('reminder'), 'reminder');
  const s = slices([agg('read', 100), agg('output', 300), agg('mcp', 500), agg('image', 50), agg('bash', 0)], 'eq');
  // Contexto por origen primero («otros» al final del tramo) y lo generado después: dos ejes que no se mezclan.
  assert.deepEqual(s.map((x) => x.group), ['read', 'other', 'output']);
  assert.ok(Math.abs(s.reduce((a, x) => a + x.pct, 0) - 1) < 1e-9);
  // Cada pareja de familia comparte tono y se distingue por la textura; ningún otro par repite color.
  assert.equal(GROUP_COLOR.base, GROUP_COLOR.reminder);
  assert.notEqual(groupFill('base'), groupFill('reminder'));
  assert.equal(new Set(GROUPS.map(groupFill)).size, 7);
});

test('repartos a un decimal por mayor resto: cierran en 100,0 % (pantalla)', () => {
  const tenth = (xs: number[]) => Math.round(xs.reduce((a, x) => a + x, 0) * 1000);
  assert.deepEqual(roundShares([1, 1, 1]), [0.334, 0.333, 0.333]);
  assert.equal(tenth(roundShares([1, 1, 1])), 1000);
  // Muchas partes pequeñas: redondear cada una por su cuenta sumaría 98,4 % (el fallo de la crítica v2).
  const many = [40, 25, 10, 5, 4, 4, 3, 3, 2, 2, 1, 1].map((x) => x + 0.04);
  assert.equal(tenth(roundShares(many)), 1000);
  // Con resto (subtipos sobre el total): filas + resto = 100,0 %.
  const sub = roundShares([2, 1], 7);
  assert.deepEqual(sub, [0.2, 0.1]);
  assert.equal(tenth(roundShares([1, 1], 1)) + Math.round((1 - 0.667) * 1000), 1000);
  assert.deepEqual(roundShares([0, 0]), [0, 0]);
  // En la pantalla: barra y filas de la demo, cada reparto suma 1000 décimas exactas.
  for (const days of [1, 7, 30] as const) {
    const now = Math.floor(Date.now() / 1000);
    const g = globalModel(demoScanReport(days, now), days, now, 'eq');
    for (const [name, rows] of [['slices', g.slices], ['projects', g.projects], ['models', g.models], ['who', g.who]] as const) {
      assert.equal(tenth(rows.map((r) => r.pct)), 1000, `${days} d ${name}: ${rows.map((r) => r.pct).join(' + ')}`);
    }
  }
});

test('bloques más caros agrupados por origen, con % del TOTAL', () => {
  assert.equal(commandKey('cd /e/x && cargo test --bin orchestra'), 'cargo test');
  assert.equal(commandKey('RUST_LOG=1 cargo test consumo'), 'cargo test');
  assert.equal(commandKey('/usr/bin/sed -n 1,20p a.rs'), 'sed');
  const b = (cat: ConsumoCatAgg['cat'], tool: string, detail: string, eq: number) => ({ cat, tool, detail, req: 0, ts: 0, t: eq / 2, eq, usd: eq / 1e6, rereads: 0 });
  const rows = [
    b('bash', 'Bash', 'cd /e/a && cargo test --bin orchestra', 300),
    b('read', 'Read', 'C:\\p\\CLAUDE.md', 250),
    b('bash', 'Bash', 'cargo test consumo -- --nocapture', 200),
    b('read', 'Read', '/e/q/CLAUDE.md', 150),
    b('read', 'Read', '/e/q/main.rs', 100),
  ];
  const g = groupTop(rows, 'eq', 10_000);
  assert.deepEqual(g.map((x) => [x.origin, x.n, x.eq]), [['cargo test', 2, 500], ['CLAUDE.md', 2, 400], ['main.rs', 1, 100]]);
  assert.equal(g[0].pct, 0.05); // del total del periodo, no de la tabla
  assert.deepEqual(g[0].items.map((x) => x.eq), [300, 200]);
});

test('coste por día apilado: Σ grupos = columna, mismo orden que la barra; hoy parcial', () => {
  // Las 23:00 (hora local) de ayer: con la hora real, pasada la medianoche «hoy» aún no tenía datos y la prueba fallaba.
  const ref = new Date();
  ref.setHours(0, 0, 0, 0);
  const now = Math.floor(ref.getTime() / 1000) - 3600;
  for (const days of [1, 7, 30] as const) {
    const g = globalModel(demoScanReport(days, now), days, now, 'eq');
    let any = 0;
    for (const d of g.days) {
      const sg = Object.values(d.g ?? {}).reduce((a, v) => a + (v?.[0] ?? 0), 0);
      assert.ok(Math.abs(sg - d.eq) <= 1e-6 * Math.max(1, d.eq), `${days} d ${d.start}: ${sg} ≠ ${d.eq}`);
      if (sg > 0) any++;
    }
    assert.ok(any > 0, `${days} d sin desglose`);
    // Solo el día (u hora) que contiene «ahora» es parcial.
    assert.equal(g.days.filter((d) => d.partial).length, 1, `${days} d`);
    if (days > 1) assert.ok(g.days[g.days.length - 1].partial);
  }
});

test('formato de USD, % y huecos', () => {
  // USD siempre con 2 decimales y en el formato del idioma.
  assert.equal(fmtUsd(0), '$0.00');
  assert.equal(fmtUsd(0.004), '$0.00');
  assert.equal(fmtUsd(0.88), '$0.88');
  assert.equal(fmtUsd(123.45), '$123.45');
  assert.equal(fmtUsd(7381.2), '$7,381.20');
  assert.equal(fmtUsd(7381.2, 'es'), '7.381,20 $');
  assert.equal(fmtUsd(17381.2, 'es'), '17.381,20 $');
  assert.equal(fmtTok(253_900_000), '253.9M');
  assert.equal(fmtTok(253_900_000, 'es'), '253,9 M');
  assert.equal(fmtTok(289_000, 'es'), '289 k');
  assert.equal(fmtUnit(0.5, 'usd', 'es'), '0,50 $');
  assert.equal(fmtNum(28208, 'es'), '28.208');
  assert.equal(fmtNum(9287, 'es'), '9.287'); // es-ES de serie no agrupa 4 cifras
  assert.equal(fmtNum(8000, 'en'), '8,000');
  assert.equal(fmtDelta(0.234), '+23 %');
  assert.equal(fmtDelta(-0.052, 'es'), '−5,2 %');
  assert.equal(fmtPct(0.256), '25.6 %');
  assert.equal(fmtPct(0.032), '3.2 %');
  assert.equal(fmtPct(0.032, true), '3,2 %');
  assert.equal(fmtPct(0.0004), '<0.1 %');
  assert.equal(fmtGap(7200), '2.0 h');
  assert.equal(fmtGap(7200, 'es'), '2,0 h');
  assert.equal(fmtGap(420), '7 min');
  assert.equal(fmtGap(35), '35 s');
});

test('rutas: proyecto y carpeta personal tapados, en Windows y msys', () => {
  const key = encodeProject('E:\\work\\webapp');
  assert.equal(key, 'E--work-webapp');
  assert.equal(shortPath('E:\\work\\webapp\\src\\lib\\x.ts', key, '<proyecto>'), '<proyecto>\\src\\lib\\x.ts');
  assert.equal(shortPath('cd /e/work/webapp && npm test', key, '<proyecto>'), 'cd <proyecto> && npm test');
  assert.equal(shortPath('E:/work/webapp', key), '<project>');
  // Otra carpeta que solo empieza igual no se toca.
  assert.equal(shortPath('E:\\work\\webapp2\\a', key), 'E:\\work\\webapp2\\a');
  // Carpeta personal, aunque no se sepa cuál es.
  assert.equal(shortPath('C:\\Users\\Ana Pérez\\.claude\\CLAUDE.md'), 'C:\\Users\\Ana Pérez\\.claude\\CLAUDE.md'.replace('C:\\Users\\Ana', '~'));
  assert.equal(shortPath('C:\\Users\\ana\\.claude\\CLAUDE.md'), '~\\.claude\\CLAUDE.md');
  assert.equal(shortPath('cat /c/Users/ana/notes.md'), 'cat ~/notes.md');
  assert.equal(shortPath('ls /home/ana/x'), 'ls ~/x');
  assert.equal(shortPath('C:\\Users\\Ana Pérez\\x', '', '', 'C:\\Users\\Ana Pérez'), '~\\x');
  // Lo que no es ruta, igual.
  assert.equal(shortPath('fn scan'), 'fn scan');
});

test('nombre de proyecto y clave desde la ruta', () => {
  assert.equal(projectKeyOf('C:\\Users\\a\\.claude\\projects\\C--Dev-app\\s\\subagents\\agent-1.jsonl'), 'C--Dev-app');
  assert.equal(projectKeyOf('C:/x/y.jsonl'), '');
  assert.equal(projectLabel('C--Dev-app'), 'C:/Dev-app');
  assert.equal(projectLabel('C--Users-ana-app', 'C:\\Users\\ana'), '~/app');
  assert.equal(projectLabel('C--Users-ana', 'C:\\Users\\ana'), '~');
  assert.equal(projectLabel('C--Users-ana-app'), '~/app');
  assert.equal(projectLabel('C--Users-ana'), '~');
  assert.equal(whoType('main'), null);
  assert.equal(whoType('sub:obrero'), 'obrero');
});

test('días locales: hoy al final, días sin actividad a cero, lo anterior fuera', () => {
  const now = Math.floor(new Date(2026, 10, 7, 15, 30).getTime() / 1000);
  const today = dayStart(now);
  const h = (ts: number) => Math.floor(ts / 3600);
  const byHour: [number, number, number, number][] = [
    [h(today + 3600 * 10), 100, 1, 2],
    [h(today + 3600 * 11), 50, 0.5, 1],
    [h(today - 86400 * 2 + 3600 * 12), 30, 0.3, 1],
    [h(today - 86400 * 9), 999, 9, 9], // fuera de 7 días
  ];
  const d = localDays(byHour, 7, now);
  assert.equal(d.length, 7);
  assert.equal(d[6].start, today);
  assert.equal(d[6].eq, 150);
  assert.equal(d[4].eq, 30);
  assert.equal(d[5].eq, 0);
  assert.equal(d.reduce((a, x) => a + x.eq, 0), 180);
  assert.equal(localDays(byHour, 1, now).length, 1);
  const hrs = hoursOfToday(byHour, now);
  assert.equal(hrs.length, 24);
  assert.equal(hrs[10].eq, 100);
  assert.equal(hrs[11].requests, 1);
});

test('listas: top N y el resto plegado en «otros»', () => {
  const rows: [string, number, number, number][] = [['a', 10, 1, 1], ['b', 40, 4, 1], ['c', 30, 3, 1], ['d', 20, 2, 1], ['e', 0, 0, 0]];
  const r = rankRows(rows, 'eq', 2);
  assert.deepEqual(r.map((x) => x.key), ['b', 'c', '']);
  assert.equal(r[2].eq, 30);
  assert.equal(r[2].other, 2);
  assert.ok(Math.abs(r.reduce((a, x) => a + x.pct, 0) - 1) < 1e-9);
  assert.equal(rankRows(rows, 'eq', 10).length, 4); // sin la fila a cero ni «otros»
});

test('vista global: factura del periodo = suma por horas; principal vs subagentes; proveedor', () => {
  const now = Math.floor(new Date(2026, 10, 7, 18, 0).getTime() / 1000);
  const rep = demoScanReport(7, now);
  const g = globalModel(rep, 7, now, 'eq');
  assert.equal(g.provider, 'claude');
  assert.ok(CONSUMO_PROVIDERS.includes(g.provider));
  assert.equal(g.days.length, 7);
  const sum = rep.byHour.reduce((a, x) => a + x[1], 0);
  assert.ok(Math.abs(g.totalEq - sum) / sum < 1e-9);
  assert.deepEqual(g.who.map((w) => w.key).sort(), ['main', 'sub']);
  assert.ok(g.subTypes.every((s) => !s.key.startsWith('sub:')));
  assert.equal(g.subTypes[0].key, 'obrero');
  for (let i = 1; i < g.top.length; i++) assert.ok(g.top[i - 1].eq >= g.top[i].eq);
  assert.equal(g.events.expired + g.events.modelChanged + g.events.prefixChanged, rep.cacheBreaks);
  // Hoy: 24 columnas por hora, pero el total sigue siendo el del día.
  const t = globalModel(demoScanReport(1, now), 1, now, 'usd');
  assert.equal(t.days.length, 24);
  assert.ok(Math.abs(t.days.reduce((a, d) => a + d.usd, 0) - t.totalUsd) < 1e-9);
});

test('vista por sesión: top (hasta 40, para agrupar) de principal + subagentes, tipos, marcas y base', () => {
  const now = 1_800_000_000;
  const rep = demoSessionReport(now);
  const s = sessionModel(rep, 'usd');
  const all = [rep.main, ...rep.subagents].reduce((a, f) => a + f.summary.top.length, 0);
  assert.equal(s.top.length, Math.min(40, all));
  for (let i = 1; i < s.top.length; i++) assert.ok(s.top[i - 1].usd >= s.top[i].usd);
  assert.ok(s.top.some((b) => b.whoType !== null) && s.top.some((b) => b.whoType === null));
  assert.equal(s.subCount, rep.subagents.length);
  assert.ok(rep.subagents.length >= 2);
  assert.equal(s.compactions, rep.main.summary.events.filter((e) => e.kind === 'compaction').length);
  assert.equal(s.line.length, rep.main.summary.requests);
  assert.ok(Math.abs(s.baseParts.reduce((a, b) => a + b.pct, 0) - 1) < 1e-9);
  assert.ok(Math.abs(s.total - (s.mainCost + s.subTypes.reduce((a, x) => a + x.usd, 0))) / s.total < 1e-9);
  // Las horas se corren a «ahora»: la sesión acaba antes de `now`.
  assert.ok(s.lastTs <= now && s.lastTs > now - 86400, `${s.lastTs} vs ${now}`);
});

test('ejes y línea', () => {
  assert.deepEqual(niceTicks(0), [0]);
  assert.deepEqual(niceTicks(180_000), [0, 50_000, 100_000, 150_000, 200_000]);
  assert.deepEqual(niceTicks(9), [0, 2.5, 5, 7.5, 10]);
  const pts = [{ ts: 0, ctx: 0 }, { ts: 50, ctx: 50 }, { ts: 100, ctx: 100 }];
  assert.equal(linePath(pts, 200, 100, 100), 'M0.0,100.0L100.0,50.0L200.0,0.0');
  assert.equal(linePath([], 200, 100, 100), '');
  assert.equal(nearestIndex(pts, 140, 200), 1);
  assert.equal(nearestIndex(pts, 160, 200), 2);
});

// ── Consejos e informe (C4/C5) ──
import { cleanDismissed, visibleAdvice, reportTokens, REPORT_WARN_TOKENS, MAX_DISMISSED } from './consumo.ts';
import { demoAdvice, demoReport } from './consumodemo.ts';

test('descartes: saneados, sin repetir y con tope', () => {
  assert.deepEqual(cleanDismissed(null), []);
  assert.deepEqual(cleanDismissed(['a', 'a', 3, '', 'x'.repeat(65), 'b']), ['a', 'b']);
  const many = Array.from({ length: MAX_DISMISSED + 20 }, (_, i) => `r:${i}`);
  const c = cleanDismissed(many);
  assert.equal(c.length, MAX_DISMISSED);
  assert.equal(c[c.length - 1], `r:${MAX_DISMISSED + 19}`, 'se quedan los más recientes');
});

test('consejos visibles: «Ya lo sé» quita solo ese caso', () => {
  const list = [{ id: 'a:1' }, { id: 'b:2' }, { id: 'c:3' }];
  assert.deepEqual(visibleAdvice(list, ['b:2']).map((a) => a.id), ['a:1', 'c:3']);
  assert.deepEqual(visibleAdvice(undefined, []), []);
});

test('tamaño del informe en tokens ≈ bytes/4 (UTF-8)', () => {
  assert.equal(reportTokens(''), 0);
  assert.equal(reportTokens('abcd'), 1);
  assert.equal(reportTokens('ñ'.repeat(4)), 2, 'ñ ocupa 2 bytes');
  assert.ok(reportTokens('x'.repeat(4 * REPORT_WARN_TOKENS + 4)) > REPORT_WARN_TOKENS);
});

test('demo: consejos en el idioma, ordenados por ahorro, descartes fuera; informe completo más largo', () => {
  const es = demoAdvice({ lang: 'es', dismissed: [] }, false);
  const en0 = demoAdvice({ lang: 'en', dismissed: [] }, false);
  const en = demoAdvice({ lang: 'en', dismissed: [en0[0].id] }, false);
  assert.ok(es.some((a) => /cachés caducadas/.test(a.title)) && en0.some((a) => /expired caches/.test(a.title)));
  assert.ok(!en.some((a) => a.id === en0[0].id) && en.length === en0.length - 1);
  for (let i = 1; i < es.length; i++) assert.ok(es[i - 1].saveUsd >= es[i].saveUsd);
  assert.ok(demoReport(7, 'full').length > demoReport(7, 'summary').length);
  assert.ok(demoReport(7, 'summary', { lang: 'es', dismissed: [] }).includes('## Periodo y totales'));
});

// ── C6: un solo total; Σ partes = total en todas las vistas, con la fixture que sale de Rust y con la demo ──

const FIX = JSON.parse(readFileSync(new URL('./fixtures/consumo_fixture.json', import.meta.url), 'utf8'));

test('Σ partes = total (±0,5 %) en la vista global y de sesión: fixture de Rust', () => {
  const rep = FIX.scan;
  const now = (rep.byHour[rep.byHour.length - 1][0] + 1) * 3600;
  for (const unit of ['eq', 'usd'] as const) {
    const g = globalModel(rep, 7, now, unit);
    assert.deepEqual(sumIssues(g, unit), [], unit);
    assert.ok(g.total > 0 && g.slices.length > 3 && g.projects.length === 2 && g.subTypes.length === 1);
    const s = sessionModel(FIX.session, unit);
    assert.deepEqual(sumIssues(s, unit), [], `sesión ${unit}`);
    assert.ok(s.subCount === 1 && s.subPct > 0 && s.mainPct > 0);
  }
});

test('Σ partes = total (±0,5 %) en la demo: hoy, 7 y 30 días, y sesión', () => {
  const now = Math.floor(new Date(2026, 10, 7, 18, 0).getTime() / 1000);
  for (const p of PERIODS) {
    const rep = demoScanReport(p, now);
    for (const unit of ['eq', 'usd'] as const) {
      const g = globalModel(rep, p, now, unit);
      assert.deepEqual(sumIssues(g, unit), [], `demo ${p} d ${unit}`);
      // C10: Δ solo con el periodo anterior entero (la demo tiene 8 días: 30 d no lo tiene).
      assert.ok((g.delta !== null) === (rep.prevComplete !== false) && g.eventCost.length >= 2, `${p} d Δ`);
      for (let i = 1; i < g.eventCost.length; i++) assert.ok(g.eventCost[i - 1][unit] >= g.eventCost[i][unit]);
    }
  }
  for (const unit of ['eq', 'usd'] as const) assert.deepEqual(sumIssues(sessionModel(demoSessionReport(now), unit), unit), []);
});

// ── C7: una sola fuente de verdad. Cada consejo cita la cifra de su tarjeta (mismo periodo y ámbito) y no ahorra
// más que su partida; con la demo (que sale de Rust) y con la fixture. Hoy ≠ 7 d ≠ sesión. ──

/** Cifra de la tarjeta que pinta la pantalla global para la clave del consejo: [usd, n]. */
function globalCard(rep: ReturnType<typeof demoScanReport>, card: string, now: number, days: number): [number, number] {
  const g = globalModel(rep, days, now, 'usd');
  if (card.startsWith('event:')) {
    const e = g.eventCost.find((x) => x.kind === card.slice(6));
    return [e?.usd ?? 0, e?.count ?? 0];
  }
  const cat = card.slice(4);
  const sl = g.slices.find((x) => x.group === cat);
  if (sl) return [sl.usd, sl.count];
  const want = cat.split(',');
  const c = rep.cats.filter((x) => want.includes(x.cat));
  return [c.reduce((a, x) => a + x.usd, 0), c.reduce((a, x) => a + x.count, 0)];
}

function adviceVsCards(rep: ReturnType<typeof demoScanReport>, advice: import('./backend.ts').ConsumoAdvice[], now: number, days: number): string[] {
  const bad: string[] = [];
  const g = globalModel(rep, days, now, 'usd');
  for (const a of advice) {
    if (a.saveUsd > (a.cardUsd ?? g.totalUsd) * (1 + 1e-9) + 1e-12) bad.push(`${a.id}: ahorro ${a.saveUsd} > partida ${a.cardUsd}`);
    if (!a.card) continue;
    const [usd, n] = globalCard(rep, a.card, now, days);
    if (Math.abs((a.cardUsd ?? 0) - usd) > 1e-6 * Math.max(1, usd)) bad.push(`${a.id}: consejo ${a.cardUsd} ≠ tarjeta ${usd} (${a.card})`);
    if (a.nums?.n !== undefined && a.nums.n !== n) bad.push(`${a.id}: texto cita ${a.nums.n}, tarjeta ${n}`);
    if (a.rule === 'baseFixed' && (a.nums?.baseMain !== g.baseMain || a.nums?.baseSub !== g.baseSub)) bad.push(`${a.id}: base ${a.nums?.baseMain}/${a.nums?.baseSub} ≠ ${g.baseMain}/${g.baseSub}`);
  }
  return bad;
}

test('consejo = tarjeta en la demo (hoy, 7 d, 30 d y sesión) y ahorro ≤ partida', () => {
  const now = Math.floor(new Date(2026, 10, 7, 18, 0).getTime() / 1000);
  const shares: number[] = [];
  for (const p of PERIODS) {
    const rep = demoScanReport(p, now);
    for (const lang of ['en', 'es']) {
      const adv = demoAdvice({ lang, dismissed: [] }, false, p);
      assert.ok(adv.filter((a) => a.card).length >= 3, `${p} d ${lang}: pocos consejos con tarjeta`);
      assert.deepEqual(adviceVsCards(rep, adv, now, p), [], `${p} d ${lang}`);
    }
    const g = globalModel(rep, p, now, 'usd');
    shares.push((g.slices.find((x) => x.group === 'base')?.usd ?? 0) / g.totalUsd);
  }
  // Sesión: las tarjetas de la sesión (slices en eq) contra cardEq.
  const srep = demoSessionReport(now);
  const s = sessionModel(srep, 'eq');
  const sadv = demoAdvice({ lang: 'en', dismissed: [] }, true);
  assert.ok(sadv.some((a) => a.card));
  for (const a of sadv) {
    assert.ok(a.saveUsd <= (a.cardUsd ?? Infinity) * (1 + 1e-9) + 1e-12, a.id);
    if (!a.card?.startsWith('cat:')) continue;
    const cat = a.card.slice(4);
    const sl = s.slices.find((x) => x.group === cat);
    const v = sl ? sl.eq : [srep.main, ...srep.subagents].flatMap((f) => f.summary.cats).filter((c) => cat.split(",").includes(c.cat)).reduce((x, c) => x + c.eq, 0);
    assert.ok(Math.abs((a.cardEq ?? 0) - v) <= 1e-6 * Math.max(1, v), `sesión ${a.id}: ${a.cardEq} ≠ ${v}`);
  }
  shares.push((s.slices.find((x) => x.group === 'base')?.eq ?? 0) / s.total);
  // Hoy ≠ 7 d ≠ 30 d ≠ sesión en el peso de la base fija (antes la demo daba el mismo % en todas).
  for (let i = 1; i < shares.length; i++) assert.ok(Math.abs(shares[i] - shares[i - 1]) > 0.001, `${shares}`);
});

test('adviceVsCards detecta un consejo con la cifra de otro periodo (fallo de la crítica v2)', () => {
  const now = Math.floor(new Date(2026, 10, 7, 18, 0).getTime() / 1000);
  const rep = demoScanReport(1, now);
  const wrong = demoAdvice({ lang: 'es', dismissed: [] }, false, 30); // consejos de 30 días sobre las tarjetas de hoy
  assert.ok(adviceVsCards(rep, wrong, now, 1).length > 0);
});

test('sumIssues detecta un reparto que no cuadra (denominadores mezclados)', () => {
  const now = Math.floor(new Date(2026, 10, 7, 18, 0).getTime() / 1000);
  const g = globalModel(demoScanReport(7, now, periodSince(7, now)), 7, now, 'eq');
  // % de subagentes sobre su subtotal (el fallo de la crítica): main + tipos ya no suman 100 %.
  const subTotal = g.subTypes.reduce((a, r) => a + r.eq, 0);
  const mixed = { ...g, subTypes: g.subTypes.map((r) => ({ ...r, pct: r.eq / subTotal })) };
  assert.ok(sumIssues(mixed, 'eq').some((x) => x.startsWith('main+subTypes %')));
  // Proyectos de sesiones enteras (otro total): ya no cuadra.
  const whole = { ...g, projects: g.projects.map((r) => ({ ...r, eq: r.eq * 1.04 })) };
  assert.ok(sumIssues(whole, 'eq').some((x) => x.startsWith('projects')));
});

test('fórmula del coste: t × w + t × n × r reproduce el coste de 2 filas de la fixture', () => {
  const rows = FIX.scan.top.filter((b: { n?: number }) => (b.n ?? 0) > 0).slice(0, 2);
  assert.equal(rows.length, 2);
  for (const b of rows) {
    const f = costFormula(b);
    assert.ok(Math.abs(f.total - b.eq) <= 1e-6 * b.eq, `${f.total} vs ${b.eq}`);
    assert.ok(f.write > 0 && f.read > 0 && f.r > 0 && f.r < 1 && f.w >= 1);
  }
});

test('rutas largas cortadas por el medio conservando el fichero', () => {
  assert.equal(midPath('C:\\Dev\\orchestra\\src\\lib\\backend.ts', 22), '…\\src\\lib\\backend.ts');
  assert.equal(midPath('~/proj/a/very/long/folder/name/here/file.rs', 20), '…/name/here/file.rs');
  assert.ok(midPath('cargo test --bin orchestra consumo -- --nocapture 2>&1 | tail -40', 30).endsWith('…'));
  assert.equal(midPath('corto.rs', 30), 'corto.rs');
  for (const s of ['C:\\a\\' + 'x'.repeat(80) + '.ts', 'cmd ' + 'y'.repeat(90)]) assert.ok(midPath(s, 40).length <= 40);
});

// ── C9: ninguna cifra de un consejo contradice la pantalla (demo de Rust y fixture con un transcript real) ──
import { adviceIssues, adviceShare, originGroups, originKeyOf, splitPath, sectionOf } from './consumo.ts';

test('C9 (a)(b)(c): ahorro ≤ origen ≤ total, sin solapes, y el consejo cita su fila (demo hoy/7/30 d, sesión y fixture)', () => {
  const now = Math.floor(new Date(2026, 10, 7, 18, 0).getTime() / 1000);
  let n = 0;
  for (const p of PERIODS) {
    const rep = demoScanReport(p, now);
    for (const lang of ['en', 'es']) {
      const adv = demoAdvice({ lang, dismissed: [] }, false, p);
      assert.deepEqual(adviceIssues(adv, rep.origins, rep.total![1]), [], `${p} d ${lang}`);
      // La fila que pinta la tabla (originGroups) es la misma cifra que cita el consejo.
      const rows = originGroups(rep.origins, rep.top, 'eq', rep.total![0]);
      for (const a of adv.filter((x) => /^(read|bash|image|reminder)\|/.test(x.origin ?? ''))) {
        const r = rows.find((x) => x.key === a.origin);
        assert.ok(r && r.n === a.originN && r.t === a.originT && Math.abs(r.eq - (a.originEq ?? 0)) < 1e-6, `${p} d ${a.id}: fila ${JSON.stringify(r && [r.n, r.t])}`);
      }
      // % del consejo en la unidad de la vista, sobre el total de la vista.
      for (const a of adv) assert.ok(Math.abs(adviceShare(a, 'eq') - a.saveEq / rep.total![0]) < 1e-9 && adviceShare(a, 'usd') <= 1);
      n += adv.length;
    }
  }
  const s = demoSessionReport(now);
  const sAdv = demoAdvice({ lang: 'es', dismissed: [] }, true);
  const sTot = [s.main, ...s.subagents].reduce((a, f) => a + f.summary.cats.reduce((b, c) => b + c.usd, 0), 0);
  assert.deepEqual(adviceIssues(sAdv, s.origins, sTot), [], 'sesión');
  // (e) la sesión cita «de la sesión».
  for (const a of sAdv) assert.ok(a.session && !/del periodo|en el periodo/.test(a.title + a.why), `sesión ${a.id}`);
  // Fixture: escaneo y sesión con el transcript real «agent-lectura» como subagente.
  assert.deepEqual(adviceIssues(FIX.scan.advice, FIX.scan.origins, FIX.scan.total[1]), [], 'fixture');
  const fTot = [FIX.session.main, ...FIX.session.subagents].reduce((a: number, f: any) => a + f.summary.cats.reduce((b: number, c: any) => b + c.usd, 0), 0);
  assert.deepEqual(adviceIssues(FIX.session.advice, FIX.session.origins, fTot), [], 'fixture sesión');
  assert.ok(n >= 40 && FIX.scan.advice.length > 0, `consejos: ${n}`);
});

test('C9 adviceIssues detecta ahorro > origen, solape y cifra distinta de la fila', () => {
  const o = [{ key: 'read|p|C:/a/store.ts', cat: 'read' as const, label: 'C:/a/store.ts', n: 4, t: 100, eq: 10, usd: 1 }];
  const base = { id: 'x', rule: 'bigRead', severity: 'high' as const, title: '', why: '', action: '', evidence: [], saveEq: 5, saveUsd: 0.6, savePct: 0.1, origin: o[0].key, originUsd: 1, originEq: 10, originN: 4, originT: 100, totalUsd: 10, totalEq: 100 };
  assert.deepEqual(adviceIssues([base], o, 10), []);
  assert.match(adviceIssues([{ ...base, saveUsd: 1.5 }], o, 10).join(), /ahorro 1.5 > origen/);
  assert.match(adviceIssues([base, { ...base, id: 'y' }], o, 10).join(), /Σ ahorros de read/);
  assert.match(adviceIssues([{ ...base, originN: 29, nums: { rowN: 29 } }], o, 10).join(), /cita 29×/);
  assert.match(adviceIssues([{ ...base, origin: 'read|q|C:/b/store.ts' }], o, 10).join(), /no tiene fila/);
});

test('C9 (d) el informe repite Contexto / Generado / total de la pantalla y 7 fechas en 7 días', () => {
  const now = Math.floor(new Date(2026, 10, 7, 18, 0).getTime() / 1000);
  const m1 = (x: number, lang: 'en' | 'es') => new Intl.NumberFormat(lang === 'es' ? 'es-ES' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: 'always' } as Intl.NumberFormatOptions).format(x / 1e6) + ' M';
  for (const p of PERIODS) {
    const rep = demoScanReport(p, now);
    const g = globalModel(rep, p, now, 'eq');
    const ctx = g.slices.filter((x) => sectionOf(x.group) === 'context').reduce((a, x) => a + x.eq, 0);
    const gen = g.slices.filter((x) => sectionOf(x.group) === 'generated').reduce((a, x) => a + x.eq, 0);
    for (const lang of ['en', 'es'] as const) {
      const md = demoReport(p, 'full', { lang, dismissed: [] }, now);
      const line = md.split('\n').find((l) => l.includes(lang === 'es' ? 'Contexto que entra' : 'Context that enters')) ?? '';
      assert.ok(line.includes(`${m1(ctx, lang)} eq`) && line.includes(`${m1(gen, lang)} eq`) && line.includes(`${m1(g.totalEq, lang)} eq`), `${p} d ${lang}: «${line}» vs ${m1(ctx, lang)} / ${m1(gen, lang)} / ${m1(g.totalEq, lang)}`);
      if (p > 1) {
        const per = md.split('\n').find((l) => l.startsWith(lang === 'es' ? '- Periodo:' : '- Period:')) ?? '';
        const d = [...per.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)].map((x) => Date.UTC(+x[1], +x[2] - 1, +x[3]));
        assert.equal(d.length, 2, per);
        assert.equal((d[1] - d[0]) / 86400000 + 1, p, `${p} d: ${per}`);
      }
      const unitLine = md.split('\n').find((l) => l.includes('1 eq =')) ?? '';
      for (const fam of ['Opus', 'Sonnet', 'Haiku', 'Fable']) {
        const present = rep.byModel.some(([m]) => m.toLowerCase().includes(fam.toLowerCase()));
        assert.equal(unitLine.includes(fam), present, `${p} d ${lang}: ${fam} en la unidad`);
      }
    }
  }
});

test('C9 orígenes: clave por ruta completa (= Rust) y nombre de fichero que no se parte', () => {
  const b = { cat: 'read' as const, detail: 'C:\\x\\store.svelte.ts', req: 1, ts: 0, t: 1, eq: 1, usd: 1, rereads: 0 };
  assert.notEqual(originKeyOf({ ...b, session: 'C:/u/.claude/projects/C--a/s.jsonl' }), originKeyOf({ ...b, session: 'C:/u/.claude/projects/C--b/s.jsonl' }));
  assert.equal(originKeyOf({ ...b, cat: 'bash', detail: 'cd /e/x && cargo test --bin a' }), 'bash|cargo test');
  const sp = splitPath('~/code/app/src/lib/store.svelte.ts');
  assert.equal(sp.name, 'store.svelte.ts');
  assert.ok(sp.dir.includes('\u200b') && !sp.name.includes('\u200b'));
});

import { adviceText, evidenceLabel } from './consumo.ts';
import { setLocale, getLocale } from './i18n.ts';
import type { ConsumoAdvice as Adv } from './backend.ts';
const ES_WORDS = new Set(['de', 'del', 'la', 'el', 'las', 'los', 'y', 'en', 'una', 'por', 'sin', 'que', 'más', 'sesión', 'lectura', 'lecturas',
  'salida', 'salidas', 'petición', 'peticiones', 'fichero', 'ficheros', 'caché', 'cachés', 'razonamiento', 'entero', 'enteras', 'veces',
  'herramientas', 'prefijo', 'cambiado', 'volcados', 'contexto', 'hilo', 'imágenes', 'subagente', 'subagentes']);
/** Palabras españolas del texto, quitando lo que es dato del usuario (nombres de agentes, ficheros, comandos). */
function spanish(s: string, a: { params?: Record<string, string | number>; lp?: Record<string, string | number> }): string[] {
  let x = s.replace(/«[^»]*»/g, ' ');
  for (const v of Object.values({ ...(a.params ?? {}), ...(a.lp ?? {}) })) if (typeof v === 'string' && !v.startsWith('@')) x = x.split(v).join(' ');
  return x.toLowerCase().split(/[^\p{L}]+/u).filter((w) => ES_WORDS.has(w));
}

test('C10 consejos por i18n: con la interfaz en inglés, ni una palabra española aunque el escaneo fuera en español', () => {
  const now = Math.floor(new Date(2026, 10, 7, 18, 0).getTime() / 1000);
  const all: Adv[] = [...FIX.scan.advice, ...FIX.session.advice, ...demoAdvice({ lang: 'es', dismissed: [] }, true)];
  for (const p of PERIODS) { void demoScanReport(p, now); all.push(...demoAdvice({ lang: 'es', dismissed: [] }, false, p)); }
  const was = getLocale();
  try {
    setLocale('en');
    const ids = new Set<string>();
    for (const a of all) {
      assert.ok(a.textId, `${a.id}: sin textId`);
      ids.add(a.textId!);
      for (const f of ['title', 'why', 'action'] as const) {
        const s = adviceText(a, f);
        assert.notEqual(s, a[f], `${a.id} ${f}: sin traducir (texto del escaneo)`);
        assert.ok(!/[{}]/.test(s), `${a.id} ${f}: parámetro sin rellenar: ${s}`);
        assert.deepEqual(spanish(s, a), [], `${a.id} ${f}: «${s}»`);
      }
      for (const e of a.evidence.filter((e) => e.labelId)) assert.deepEqual(spanish(evidenceLabel(e), e), [], `${a.id} prueba «${evidenceLabel(e)}»`);
    }
    assert.ok(ids.size >= 6, `pocas reglas en los datos: ${[...ids]}`);
    // Y al revés: en español, el texto traducido de un escaneo en inglés no deja claves ni parámetros sin rellenar.
    setLocale('es');
    for (const p of PERIODS) for (const a of demoAdvice({ lang: 'en', dismissed: [] }, false, p)) {
      for (const f of ['title', 'why', 'action'] as const) assert.ok(!/[{}]|consumo\.adv/.test(adviceText(a, f)), `${a.id} ${f} es`);
    }
  } finally { setLocale(was); }
});

import { errorKind } from './consumo.ts';
test('C10 Δ % oculto si el periodo anterior está a medias; base fija de la sesión con lo que no sale en el transcript; errores por clase', () => {
  const now = Math.floor(new Date(2026, 10, 7, 18, 0).getTime() / 1000);
  const rep = demoScanReport(7, now);
  const full = globalModel({ ...rep, prevTotal: [100, 1], prevComplete: true }, 7, now, 'eq');
  assert.ok(full.delta !== null && !full.prevPartial);
  const half = globalModel({ ...rep, prevTotal: [100, 1], prevComplete: false }, 7, now, 'eq');
  assert.equal(half.delta, null, 'Δ con el anterior a medias');
  assert.ok(half.prevPartial);
  // Sesión: las partes de la base suman la base entera (sistema + herramientas + CLAUDE.md raíz incluidos) y 100 %.
  const s = sessionModel(demoSessionReport(now), 'eq');
  assert.ok(s.baseParts.some((p) => p.label === 'system+tools'), JSON.stringify(s.baseParts.map((p) => p.label)));
  assert.ok(Math.abs(s.baseParts.reduce((a, p) => a + p.pct, 0) - 1) < 1e-9);
  assert.equal(s.baseParts.reduce((a, p) => a + p.chars, 0), s.base);
  assert.equal(errorKind('failed to read C:/x: Access is denied. (os error 5)'), 'read');
  assert.equal(errorKind('expected value at line 1 column 1'), 'parse');
  assert.equal(errorKind('boom'), 'other');
});

// ───────────── C11 ─────────────
import { sortAdvice, adviceAssume } from './consumo.ts';
import { tn } from './i18n.ts';

const c11All = (lang: 'es' | 'en'): Adv[] => {
  const now = Math.floor(new Date(2026, 10, 7, 18, 0).getTime() / 1000);
  const all: Adv[] = [...FIX.scan.advice, ...FIX.session.advice, ...demoAdvice({ lang, dismissed: [] }, true)];
  for (const p of PERIODS) { void demoScanReport(p, now); all.push(...demoAdvice({ lang, dismissed: [] }, false, p)); }
  return all;
};

test('C11 orden de los consejos por la unidad de la pantalla (eq y USD) en el demo y la fixture', () => {
  const now = Math.floor(new Date(2026, 10, 7, 18, 0).getTime() / 1000);
  const lists: Adv[][] = [FIX.scan.advice, FIX.session.advice, demoAdvice({ lang: 'es', dismissed: [] }, true)];
  for (const p of PERIODS) { void demoScanReport(p, now); lists.push(demoAdvice({ lang: 'es', dismissed: [] }, false, p)); }
  let flips = 0;
  for (const l of lists) for (const unit of ['eq', 'usd'] as const) {
    const v = (a: Adv) => (unit === 'usd' ? a.saveUsd : a.saveEq);
    const s = sortAdvice(l, unit);
    for (let i = 1; i < s.length; i++) assert.ok(v(s[i - 1]) >= v(s[i]), `${unit}: ${s[i - 1].id} ${v(s[i - 1])} < ${s[i].id} ${v(s[i])}`);
    if (unit === 'eq' && sortAdvice(l, 'usd').map((a) => a.id).join() !== s.map((a) => a.id).join()) flips++;
  }
  // El orden en eq y en USD no es el mismo en los datos (si no, este test no probaría nada).
  assert.ok(flips >= 1, 'eq y USD dan el mismo orden en todos los datos');
});

test('C11 antes → después: después = origen − ahorro, con suposición, y ahorro < origen', () => {
  const all = c11All('es');
  const was = getLocale();
  try {
    for (const loc of ['es', 'en'] as const) {
      setLocale(loc);
      for (const a of all.filter((a) => a.severity !== 'info')) {
        assert.ok(a.saveEq < (a.originEq ?? 0) && a.saveUsd < (a.originUsd ?? 0), `${a.id}: ahorro ≥ origen`);
        assert.ok(Math.abs((a.afterUsd ?? -1) - ((a.originUsd ?? 0) - a.saveUsd)) < 1e-6, `${a.id}: después`);
        const as = adviceAssume(a);
        assert.ok(as && !/[{}]|consumo\./.test(as), `${a.id}: suposición «${as}»`);
      }
    }
  } finally { setLocale(was); }
});

/** Palabras inglesas que no pueden salir en la vista en español. Lista blanca (EN_OK): comandos, opciones y nombres
 *  propios que el español de la app usa tal cual; lo que es dato del usuario (entre «» o parámetro) se quita antes. */
const EN_WORDS = new Set(['main', 'thread', 'the', 'of', 'and', 'output', 'outputs', 'thinking', 'reads', 'file', 'files', 'session',
  'sessions', 'cache', 'caches', 'expired', 'whole', 'repeated', 'times', 'request', 'requests', 'subagent', 'subagents', 'with', 'assuming',
  'saving', 'less', 'over', 'on', 'to', 'for', 'image', 'images', 'fixed', 'per', 'tools', 'changed', 'broken', 'calculated', 'total']);
const EN_OK = new Set(['effort', 'model', 'sonnet', 'haiku', 'opus', 'low', 'medium', 'skill', 'skills', 'brief', 'fork', 'tokens', 'token', 'total']);
function english(s: string, a: { params?: Record<string, string | number>; lp?: Record<string, string | number> }): string[] {
  let x = s.replace(/«[^»]*»/g, ' ');
  for (const v of Object.values({ ...(a.params ?? {}), ...(a.lp ?? {}) })) if (typeof v === 'string' && !v.startsWith('@')) x = x.split(v).join(' ');
  return x.toLowerCase().split(/[^\p{L}]+/u).filter((w) => EN_WORDS.has(w) && !EN_OK.has(w));
}

test('C11 consejos en español: ni «main» ni otras palabras inglesas (título, por qué, qué hacer, suposición, pruebas); plurales', () => {
  const all = c11All('en');
  const was = getLocale();
  try {
    setLocale('es');
    let main = 0;
    for (const a of all) {
      for (const f of ['title', 'why', 'action'] as const) {
        const s = adviceText(a, f);
        assert.deepEqual(english(s, a), [], `${a.id} ${f}: «${s}»`);
        assert.ok(!/(^|[^\d.,])1 (ficheros|lecturas|salidas|subagentes|cachés|veces|sesiones|enteras|repetidas)\b/.test(s), `${a.id} ${f}: plural con 1: «${s}»`);
      }
      assert.deepEqual(english(adviceAssume(a), a), [], `${a.id} suposición «${adviceAssume(a)}»`);
      for (const e of a.evidence.filter((e) => e.labelId)) assert.deepEqual(english(evidenceLabel(e), e), [], `${a.id} prueba «${evidenceLabel(e)}»`);
      if (a.params?.who === 'main') {
        main++;
        // El hilo principal no tiene definición de agente: plantilla propia.
        assert.ok(!/definición/.test(adviceText(a, 'action')), `${a.id}: «definición» en el hilo principal`);
      }
    }
    assert.ok(main >= 1, 'ningún consejo del hilo principal en los datos');
    assert.equal(tn('consumo.adv.pl.gen.n', 1), '1 fichero');
    setLocale('en');
    assert.equal(tn('consumo.adv.pl.gen.n', 1), '1 file');
    assert.equal(tn('consumo.adv.pl.gen.n', 3), '3 files');
  } finally { setLocale(was); }
});

test('C11 rutas: una sola normalización (sin «<proyecto>» ni barras dobles), Windows y POSIX, proyecto = carpeta personal', () => {
  const home = 'C:\\Users\\ana';
  const key = encodeProject(home); // el proyecto ES la carpeta personal
  assert.equal(shortPath('C:\\Users\\ana\\code\\src\\lib\\store.svelte.ts', key, '', home), 'code\\src\\lib\\store.svelte.ts');
  assert.equal(shortPath('C:\\\\Users\\\\ana\\\\code\\\\x.ts', key, '', home), 'code\\x.ts');
  assert.equal(shortPath('C:\\\\Users\\\\bob\\\\x.ts'), '~\\x.ts');
  assert.equal(shortPath('/home/ana//code/x.ts', '-home-ana', '', '/home/ana'), 'code/x.ts');
  assert.equal(shortPath('cd /c/Users/ana && cargo test', key, '', home), 'cd . && cargo test');
  assert.equal(shortPath('curl https://example.com/a'), 'curl https://example.com/a');
  const k2 = encodeProject('E:\\work\\webapp');
  assert.equal(shortPath('E:\\work\\webapp\\src\\lib\\x.ts', k2, ''), 'src\\lib\\x.ts');
  assert.equal(shortPath('/e/work/webapp/src/x.ts', k2, ''), 'src/x.ts');
  for (const p of ['C:\\Users\\ana\\code\\a.ts', 'C:\\\\Users\\\\ana\\\\b.ts', '/c/Users/ana/c.ts']) {
    const o = shortPath(p, key, '', home);
    assert.ok(!o.includes('<') && !o.includes('\\\\') && !/Users/i.test(o), `${p} → ${o}`);
  }
  // Una ruta larga, cortada por la mitad en una línea, conserva el nombre.
  const m = midPath('code\\a\\very\\long\\folder\\name\\that\\goes\\on\\src\\lib\\store.svelte.ts', 40);
  assert.ok(m.length <= 40 && m.endsWith('store.svelte.ts') && m.startsWith('…'), m);
});
