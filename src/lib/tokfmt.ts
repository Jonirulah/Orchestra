// Cifras de tokens en corto (1,5M · 289k). Módulo puro.

/** 1_500_000 → "1.5M", 289_000 → "289k", 42 → "42". */
export function tokK(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

/** Resumen para la cabecera de un panel: «289k · ↑4.7M ↓1.5M» (contexto, entrada nueva, salida). Vacío si no hay datos. */
export function tokSummary(ctx: number, freshIn: number, out: number): string {
  const parts: string[] = [];
  if (ctx > 0) parts.push(tokK(ctx));
  if (freshIn > 0 || out > 0) parts.push(`↑${tokK(freshIn)} ↓${tokK(out)}`);
  return parts.join(' · ');
}
