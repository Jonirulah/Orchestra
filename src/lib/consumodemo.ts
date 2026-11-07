// Datos del modo demo (navegador sin Tauri) de las pantallas de Consumo. NO se inventan aquí: los genera el MISMO
// código Rust que analiza los datos reales (consumo/demo_gen.rs + scan_period + consejos + informe) a partir de
// transcripts sintéticos, y se guardan en fixtures/consumo_demo.json (`cargo test --bin orchestra exporta_demo_ts
// -- --ignored`). Así tarjetas, consejos e informe del demo cuadran entre sí como en la app real. Este módulo solo
// elige el periodo, corre las horas a «ahora» y quita los consejos descartados.

import type { ConsumoAdvice, ConsumoAdviceOpts, ConsumoEvent, ConsumoFileReport, ConsumoScanReport, ConsumoSessionReport, ConsumoTopBlock } from './backend.ts';
import demo from './fixtures/consumo_demo.json' with { type: 'json' };

type Lang = 'en' | 'es';
type DemoScan = ConsumoScanReport & { advice_en: ConsumoAdvice[]; advice_es: ConsumoAdvice[] };
type DemoSession = ConsumoSessionReport & { advice_en: ConsumoAdvice[]; advice_es: ConsumoAdvice[] };
interface DemoData { genNow: number; scans: Record<string, DemoScan>; session: DemoSession; reports: Record<string, string> }
const DATA = demo as unknown as DemoData;

/** Desplazamiento en horas enteras entre la generación y `now` (las horas UTC se conservan). */
function shiftOf(now: number): number {
  return (Math.floor(now / 3600) - Math.floor(DATA.genNow / 3600)) * 3600;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function shiftTop(top: ConsumoTopBlock[], d: number): ConsumoTopBlock[] {
  return top.map((b) => ({ ...b, ts: b.ts + d }));
}

function periodKey(days: number): string {
  return days <= 1 ? '1' : days <= 7 ? '7' : '30';
}

function langOf(opts?: ConsumoAdviceOpts): Lang {
  return opts?.lang === 'es' ? 'es' : 'en';
}

/** Escaneo global del demo: el periodo de 1 (hoy), 7 o 30 días más cercano a `days`. */
export function demoScanReport(days: number, now: number): ConsumoScanReport {
  const src = DATA.scans[periodKey(days)];
  const d = shiftOf(now);
  const { advice_en: _en, advice_es: _es, ...rep } = clone(src);
  return {
    ...rep,
    since: (rep.since ?? 0) + d,
    top: shiftTop(rep.top, d),
    byHour: rep.byHour.map(([h, e, u, n]) => [h + d / 3600, e, u, n] as [number, number, number, number]),
    byHourCat: (rep.byHourCat ?? []).map(([h, c, e, u]) => [h + d / 3600, c, e, u] as [number, typeof c, number, number]),
  };
}

function shiftFile(f: ConsumoFileReport, d: number): ConsumoFileReport {
  const s = f.summary;
  return {
    ...f,
    summary: { ...s, firstTs: s.firstTs + d, lastTs: s.lastTs + d, top: shiftTop(s.top, d), events: s.events.map((e: ConsumoEvent) => ({ ...e, ts: e.ts + d })) },
  };
}

/** Sesión del demo (la más rica de hoy en la cuenta sintética). */
export function demoSessionReport(now: number): ConsumoSessionReport {
  const d = shiftOf(now);
  const { advice_en: _en, advice_es: _es, ...s } = clone(DATA.session);
  return {
    ...s,
    main: shiftFile(s.main, d),
    subagents: s.subagents.map((f) => shiftFile(f, d)),
    contextLine: s.contextLine.map(([ts, c, seg]) => [ts + d, c, seg] as [number, number, number]),
  };
}

/** Consejos del demo (los que calculó Rust para ese periodo o para la sesión), sin los descartados. */
export function demoAdvice(opts: ConsumoAdviceOpts | undefined, session: boolean, days = 7): ConsumoAdvice[] {
  const gone = new Set(opts?.dismissed ?? []);
  const src = session ? DATA.session : DATA.scans[periodKey(days)];
  const list = langOf(opts) === 'es' ? src.advice_es : src.advice_en;
  return clone(list).filter((a) => !gone.has(a.id));
}

/** Informe del demo (generado por consumo/informe.rs); las fechas se corren a hoy. */
export function demoReport(days: number, detail: 'summary' | 'full', opts?: ConsumoAdviceOpts, now = Math.floor(Date.now() / 1000)): string {
  const md = DATA.reports[`${periodKey(days)}_${detail}_${langOf(opts)}`] ?? '';
  const dd = Math.round(shiftOf(now) / 86400);
  if (dd === 0) return md;
  return md.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_m, y: string, mo: string, da: string) => {
    const t = Date.UTC(Number(y), Number(mo) - 1, Number(da)) + dd * 86_400_000;
    return new Date(t).toISOString().slice(0, 10);
  });
}
