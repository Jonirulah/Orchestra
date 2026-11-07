// Resultados de «Probar» guardados fuera de la vista MCP (v7): sobreviven a cerrar y volver a abrir la vista mientras
// Orchestra siga abierto, y se tiran en cuanto cambia la definición (huella) de ese MCP en esa cuenta.
import type { McpAccount } from './backend.ts';
import type { ProbeLike } from './mcpmatrix.ts';
import { probeKey } from './mcpmatrix.ts';

export interface ProbeMemo { r: ProbeLike; at: number; fp: string }

/** Resultados que siguen valiendo para las cuentas leídas ahora (misma clave y misma huella). */
export function recallProbes(memo: Readonly<Record<string, ProbeMemo>>, accounts: readonly McpAccount[]): { results: Record<string, ProbeLike>; at: Record<string, number> } {
  const results: Record<string, ProbeLike> = {};
  const at: Record<string, number> = {};
  for (const a of accounts) for (const d of a.servers) {
    const k = probeKey(a.id, d);
    const m = memo[k];
    if (m && m.fp === d.fingerprint) { results[k] = m.r; at[k] = m.at; }
  }
  return { results, at };
}

/** «hace X»: segundos → «ahora», minutos, horas o días (redondeo hacia abajo). */
export function agoParts(ms: number): { unit: 'now' | 'min' | 'h' | 'd'; n: number } {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return { unit: 'now', n: 0 };
  if (s < 3600) return { unit: 'min', n: Math.floor(s / 60) };
  if (s < 86400) return { unit: 'h', n: Math.floor(s / 3600) };
  return { unit: 'd', n: Math.floor(s / 86400) };
}
