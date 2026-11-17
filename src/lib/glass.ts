// Transparencia de la ventana (Ajustes → General → Opacidad / Efecto). Módulo puro: se prueba con node --test.
//
// Con opacidad < 100 % la ventana pasa a «cristal» (glass.rs: DWM con alfa por píxel + WebView2 sin fondo) y la
// página pinta su fondo con alfa. Para que la opacidad sea la misma en toda la ventana, cada píxel tiene UN solo
// pintor translúcido (si se apilan dos capas al 60 %, salen al 84 %): con `html.glass` el body no pinta y pintan
// la barra lateral, la barra de pestañas, la de estado, la cabecera y el cuerpo de cada panel (ver app.css).
// El xterm deja su fondo a alfa 0 (lo pinta el cuerpo del panel) y con allowTransparency el texto sale opaco.
// Menús, diálogos, ajustes, fichas y cajones no cambian: siguen opacos.

import type { WindowEffect } from './settings.ts';

/** ¿Hace falta cristal? Solo por debajo del 100 %: a 100 todo queda exactamente como siempre. */
export function isGlass(opacity: number): boolean {
  return Number.isFinite(opacity) && opacity < 100;
}

/** Alfa (0..1) de los fondos para una opacidad en %, recortada a 30..100. */
export function glassAlpha(opacity: number): number {
  if (!Number.isFinite(opacity)) return 1;
  return Math.round(Math.min(100, Math.max(30, opacity))) / 100;
}

/** Lo que se pide a la ventana: sin cristal no hay efecto (con todo opaco no se vería). */
export function windowLook(opacity: number, effect: WindowEffect): { glass: boolean; effect: WindowEffect } {
  const glass = isGlass(opacity);
  return { glass, effect: glass ? effect : 'none' };
}

/**
 * Fondo del xterm con cristal: el mismo color con alfa 0 (lo pinta `.body` del panel, con el alfa de la ventana).
 * Se conserva el color por si xterm lo usa (vídeo inverso: con allowTransparency el texto se pinta opaco).
 */
export function clearBackground(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return 'rgba(0,0,0,0)';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0)`;
}
