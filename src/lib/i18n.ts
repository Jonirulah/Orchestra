// Internacionalización. Módulo puro (sin Svelte ni Tauri): se prueba con node --test.
// Inglés = idioma base. Las claves viven en src/lib/locales/<idioma>/<área>.ts (ver docs/i18n.md).
import { en } from './locales/en/index.ts';
import { es } from './locales/es/index.ts';

export type Locale = 'en' | 'es';
/** Valor del ajuste `language`: un idioma concreto o el del sistema. */
export type LanguageSetting = Locale | 'system';
/** Clave de texto comprobada en compilación: sale de las claves del diccionario inglés. */
export type Key = keyof typeof en;

export const LOCALES: readonly Locale[] = ['en', 'es'];
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['en', 'es', 'system'];

const dicts: Record<Locale, Readonly<Record<string, string>>> = { en, es };

let current: Locale = 'en';

export function setLocale(l: Locale): void { current = LOCALES.includes(l) ? l : 'en'; }
export function getLocale(): Locale { return current; }

/** 'system' -> el idioma del navegador si empieza por «es»; si no, inglés. */
export function resolveLanguage(setting: LanguageSetting, navigatorLang?: string): Locale {
  if (setting === 'en' || setting === 'es') return setting;
  const lang = navigatorLang ?? (typeof navigator !== 'undefined' ? navigator.language : '') ?? '';
  return String(lang).toLowerCase().startsWith('es') ? 'es' : 'en';
}

function lookup(l: Locale, key: string): string | undefined {
  const d = dicts[l];
  return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
}

function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
}

/** Texto de una clave en el idioma actual (si falta: inglés; si falta también: la propia clave). */
export function t(key: Key, vars?: Record<string, string | number>): string {
  return tk(key, vars);
}

/** Plural sencillo (EN y ES): `<base>.one` si n = 1, `<base>.other` si no; `{n}` va con el formato del idioma. */
export function tn(base: string, n: number, vars?: Record<string, string | number>): string {
  return tk(`${base}.${n === 1 ? 'one' : 'other'}`, { n: n.toLocaleString(current === 'es' ? 'es-ES' : 'en-US', { useGrouping: 'always' } as unknown as Intl.NumberFormatOptions), ...vars });
}

/** Igual que `t` pero para claves construidas en tiempo de ejecución, p. ej. tk(`agent.status.${s}`). */
export function tk(key: string, vars?: Record<string, string | number>): string {
  return fill(lookup(current, key) || lookup('en', key) || key, vars);
}
