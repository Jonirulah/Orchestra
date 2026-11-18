// Cuándo volver a pedir el renderizador WebGL de un terminal tras perder el contexto (o no poder crearlo).
// Sin esto, un panel que pierde el contexto (GPU cargada, el proceso de GPU de WebView2 que se reinicia...) se queda para
// siempre en el renderizador DOM de xterm, que gasta bastante más CPU en el hilo principal; con varios paneles y horas
// abiertas, la ventana iba cada vez más a tirones. Lógica pura para probarla con `node --test`.

/** Esperas tras cada pérdida seguida: rápido la primera vez y luego cada vez más espaciado; a partir de ahí, la última. */
export const WEBGL_RETRY_MS = [1_000, 5_000, 30_000, 120_000, 300_000] as const;
/** Tiempo con WebGL sin perderlo que hace que la siguiente pérdida cuente como la primera. */
export const WEBGL_STABLE_MS = 10 * 60_000;

export interface WebglRetryState {
  /** Pérdidas seguidas (sin un rato estable entre medias). */
  streak: number;
  /** Momento (ms) de la última vez que se consiguió WebGL; 0 = nunca. */
  okAt: number;
}

export const freshRetry = (): WebglRetryState => ({ streak: 0, okAt: 0 });

/** Se ha conseguido (otra vez) el contexto WebGL. */
export function webglOk(s: WebglRetryState, now: number): WebglRetryState {
  return { streak: s.streak, okAt: now };
}

/** Se ha perdido el contexto (o no se pudo crear): espera hasta el próximo intento y estado nuevo. */
export function webglLost(s: WebglRetryState, now: number): { delayMs: number; state: WebglRetryState } {
  const stable = s.okAt > 0 && now - s.okAt >= WEBGL_STABLE_MS;
  const streak = stable ? 1 : s.streak + 1;
  const delayMs = WEBGL_RETRY_MS[Math.min(streak, WEBGL_RETRY_MS.length) - 1];
  return { delayMs, state: { streak, okAt: s.okAt } };
}
