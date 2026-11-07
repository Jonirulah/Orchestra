// Sonidos de aviso, sintetizados con Web Audio (sin archivos: la app pesa lo mismo).
// La parte pura (ids, saneado, anti-spam) se prueba con node --test; playSound() solo hace algo en el navegador
// y nunca lanza: si el audio falla, la app sigue.

export type SoundId = 'none' | 'chime' | 'bell' | 'pop' | 'ping';
/** Orden en que se enseñan en Ajustes. */
export const SOUND_IDS: readonly SoundId[] = ['none', 'chime', 'bell', 'pop', 'ping'];

/** Mínimo entre dos sonidos (ms): si varios agentes cambian a la vez, suena uno. */
export const SOUND_GAP_MS = 1500;

export function cleanSoundId(v: unknown, d: SoundId): SoundId {
  return SOUND_IDS.includes(v as SoundId) ? (v as SoundId) : d;
}

/** Anti-spam puro: ¿puede sonar ahora, dado cuándo sonó el último? */
export function canPlay(now: number, last: number | null, gap = SOUND_GAP_MS): boolean {
  return last === null || now - last >= gap || now < last;
}

type Note = { f: number; at: number; dur: number; type: OscillatorType; gain: number; attack?: number; slideTo?: number };

/** Notas de cada sonido (frecuencia Hz, inicio y duración en s). Todos acaban antes de 0,8 s. */
export const RECIPES: Record<Exclude<SoundId, 'none'>, Note[]> = {
  // Dos notas ascendentes (Mi5 → La5).
  chime: [
    { f: 659.25, at: 0, dur: 0.32, type: 'sine', gain: 0.5 },
    { f: 880, at: 0.14, dur: 0.45, type: 'sine', gain: 0.5 },
  ],
  // Campanita: fundamental + parciales inarmónicos con decaimiento largo.
  bell: [
    { f: 1046.5, at: 0, dur: 0.75, type: 'sine', gain: 0.45 },
    { f: 2637, at: 0, dur: 0.4, type: 'sine', gain: 0.12 },
    { f: 3961, at: 0, dur: 0.22, type: 'sine', gain: 0.05 },
  ],
  // Burbuja: barrido rápido hacia arriba, muy corto.
  pop: [{ f: 320, at: 0, dur: 0.12, type: 'sine', gain: 0.6, attack: 0.004, slideTo: 900 }],
  // Sonar: nota alta suave con cola.
  ping: [
    { f: 1568, at: 0, dur: 0.6, type: 'sine', gain: 0.35, attack: 0.01 },
    { f: 1572, at: 0, dur: 0.6, type: 'triangle', gain: 0.08, attack: 0.01 },
  ],
};

let ctx: AudioContext | null = null;
let lastAt: number | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const C = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      if (!C) return null;
      ctx = new C();
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  } catch { return null; }
}

/**
 * Toca un sonido. volume 0..1. Con `force` se salta el anti-spam (botón ▶ de Ajustes).
 * Devuelve si llegó a sonar. Nunca lanza.
 */
export function playSound(id: SoundId, volume: number, force = false): boolean {
  try {
    if (id === 'none' || !(id in RECIPES)) return false;
    const vol = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0));
    if (vol <= 0) return false;
    const now = Date.now();
    if (!force && !canPlay(now, lastAt)) return false;
    const ac = audio();
    if (!ac) return false;
    lastAt = now;
    const t0 = ac.currentTime + 0.01;
    const master = ac.createGain();
    master.gain.value = vol * vol; // curva perceptiva: el deslizador se siente lineal
    master.connect(ac.destination);
    let end = t0;
    for (const n of RECIPES[id]) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = n.type;
      const s = t0 + n.at;
      const e = s + n.dur;
      o.frequency.setValueAtTime(n.f, s);
      if (n.slideTo) o.frequency.exponentialRampToValueAtTime(n.slideTo, e);
      // Entrada y salida en rampa: sin chasquidos.
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(n.gain, s + (n.attack ?? 0.008));
      g.gain.exponentialRampToValueAtTime(0.0001, e);
      g.gain.linearRampToValueAtTime(0, e + 0.01);
      o.connect(g).connect(master);
      o.start(s);
      o.stop(e + 0.02);
      end = Math.max(end, e + 0.02);
    }
    setTimeout(() => { try { master.disconnect(); } catch { /* ya desconectado */ } }, (end - ac.currentTime + 0.1) * 1000);
    return true;
  } catch { return false; }
}

/** Alias corto. */
export const play = playSound;
