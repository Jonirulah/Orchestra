// Pegar y soltar imágenes en los terminales. Módulo puro (sin Svelte ni Tauri): se prueba con node --test.
//
// Ctrl+V (o el pegado del clic derecho) con una IMAGEN y sin texto en el portapapeles:
//  - Panel de Claude Code: se le manda su propio atajo de «pegar imagen» (Alt+V en Windows = ESC v). Claude lee el
//    portapapeles él mismo y sale «[Image #1]», igual que en su terminal nativo.
//  - Codex, opencode y shells locales: Rust guarda la imagen en PNG en la caché y se pega su RUTA, citada para esa shell.
//  - SSH (host guardado): Rust guarda el PNG, lo sube a ~/.cache/orchestra-paste/ del remoto y se pega la ruta remota.
//    Los alias de ~/.ssh/config no tienen datos de conexión propios: aviso de que no está disponible.
// Con texto en el portapapeles todo sigue igual (lo pega xterm, con bracketed paste).
import { activeSecretKey, providerOf } from './model.ts';
import type { Account, Host, Pane } from './model.ts';

/** Atajo de Claude Code para pegar una imagen: en Windows/WSL es Alt+V (su binario: `m ? "alt+v" : "ctrl+v"`), que un
 *  terminal envía como ESC seguido de «v». Se manda en UNA escritura para que Ink lo lea como meta+v y no como Escape. */
export const CLAUDE_IMAGE_PASTE = '\x1bv';

export type ShellFlavor = 'pwsh' | 'cmd' | 'posix' | 'wsl';

export type PasteTarget =
  | { kind: 'claude' }
  /** Codex u opencode: su TUI reconoce la ruta pegada de una imagen y la adjunta. */
  | { kind: 'agent' }
  | { kind: 'shell'; flavor: ShellFlavor }
  /** `host` = host guardado (se puede subir); sin él (alias de ~/.ssh/config) no hay subida. */
  | { kind: 'ssh'; host?: Host };

export type PasteAction =
  /** Lo de siempre: que xterm pegue el texto. */
  | 'text'
  /** Comprobar que hay imagen y mandar el atajo de Claude. */
  | 'claude-key'
  /** Guardar PNG y pegar su ruta local. */
  | 'save-path'
  /** Guardar PNG, subirlo y pegar la ruta remota. */
  | 'ssh-upload'
  | 'ssh-unavailable';

/** `hasImage` sin definir = no se sabe (clic derecho: solo se lee el texto); Rust lo confirma y, si no hay, no pasa nada. */
export interface ClipState { hasText: boolean; hasImage?: boolean }

export function decidePaste(target: PasteTarget, clip: ClipState, enabled: boolean): PasteAction {
  if (clip.hasText || !enabled || clip.hasImage === false) return 'text';
  switch (target.kind) {
    case 'claude': return 'claude-key';
    case 'agent':
    case 'shell': return 'save-path';
    case 'ssh': return target.host ? 'ssh-upload' : 'ssh-unavailable';
  }
}

/** Qué hacer con archivos soltados desde el Explorador (no depende del ajuste: soltar ya es explícito). */
export type DropPlan =
  | { do: 'paste'; text: string }
  | { do: 'upload'; images: string[]; skipped: number }
  | { do: 'unavailable' }
  | { do: 'nothing' };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
export const isImagePath = (p: string): boolean => IMAGE_EXT.test(p);

export function planDrop(target: PasteTarget, paths: readonly string[]): DropPlan {
  const ps = paths.filter((p) => p.length > 0);
  if (!ps.length) return { do: 'nothing' };
  if (target.kind === 'ssh') {
    if (!target.host) return { do: 'unavailable' };
    const images = ps.filter(isImagePath);
    return images.length ? { do: 'upload', images, skipped: ps.length - images.length } : { do: 'nothing' };
  }
  return { do: 'paste', text: ps.map((p) => quoteFor(target, p)).join(' ') };
}

// ---------- citar rutas ----------

/** PowerShell: tal cual si es «segura»; si no, comillas simples (duplicando también las tipográficas ‘ ’ ‚ ‛). */
export function quotePwsh(p: string): string {
  if (/^[A-Za-z0-9_\\/.:~+-]+$/.test(p)) return p;
  return `'${p.replace(/['‘’‚‛]/g, (c) => c + c)}'`;
}

/** cmd.exe: comillas dobles si hay espacios o caracteres especiales (en una ruta de Windows no puede haber «"»). */
export function quoteCmd(p: string): string {
  return /[\s&()[\]{}^=;!'+,`~%]/.test(p) ? `"${p}"` : p;
}

/** sh/bash/zsh: tal cual si es segura; si no, comillas simples con ' -> '\''. */
export function quotePosix(p: string): string {
  if (/^[A-Za-z0-9_/.:@%+=,-]+$/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** TUI de un agente (Claude, Codex, opencode): comillas dobles solo si hay espacios (todas las quitan al reconocer la ruta). */
export function quoteAgent(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

/** C:\Users\x -> /mnt/c/Users/x (WSL). Una ruta que no es de unidad se deja con barras normales. */
export function wslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  const rest = (m ? m[2] : p).replace(/\\/g, '/');
  return m ? `/mnt/${m[1].toLowerCase()}/${rest}` : rest;
}

/** C:\Users\x -> /c/Users/x (Git Bash / MSYS). */
export function msysPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  const rest = (m ? m[2] : p).replace(/\\/g, '/');
  return m ? `/${m[1].toLowerCase()}/${rest}` : rest;
}

/** Ruta LOCAL de Windows lista para pegar en ese panel. */
export function quoteFor(target: PasteTarget, p: string): string {
  switch (target.kind) {
    case 'claude':
    case 'agent': return quoteAgent(p);
    case 'ssh': return quotePosix(p);
    case 'shell':
      switch (target.flavor) {
        case 'pwsh': return quotePwsh(p);
        case 'cmd': return quoteCmd(p);
        case 'posix': return quotePosix(msysPath(p));
        case 'wsl': return quotePosix(wslPath(p));
      }
  }
}

// ---------- de un panel a su destino ----------

const base = (prog: string): string => (prog.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');

/** Shell de un panel local por su perfil (`ref`) o, si no, por el programa. */
export function shellFlavor(p: Pick<Pane, 'ref' | 'spec'>): ShellFlavor {
  const ref = p.ref ?? '';
  if (ref === 'cmd') return 'cmd';
  if (ref === 'gitbash') return 'posix';
  if (ref.startsWith('wsl:')) return 'wsl';
  const b = base(p.spec.program);
  if (b === 'cmd') return 'cmd';
  if (b === 'wsl') return 'wsl';
  if (b === 'bash' || b === 'sh' || b === 'zsh' || b === 'fish') return 'posix';
  return 'pwsh';
}

export function pasteTarget(p: Pick<Pane, 'kind' | 'ref' | 'spec'>, accounts: readonly Account[], hosts: readonly Host[]): PasteTarget {
  if (p.kind === 'agent') {
    const acc = accounts.find((a) => a.id === p.ref);
    return providerOf(acc) === 'claude' ? { kind: 'claude' } : { kind: 'agent' };
  }
  if (p.kind === 'ssh') {
    const host = p.ref && !p.ref.startsWith('cfg:') ? hosts.find((h) => h.id === p.ref) : undefined;
    return host ? { kind: 'ssh', host } : { kind: 'ssh' };
  }
  return { kind: 'shell', flavor: shellFlavor(p) };
}

/** Destino que espera `ssh_upload_image` (mismo `Dest` de Rust que las métricas del servidor): solo el NOMBRE del secreto. */
export interface UploadDest {
  user?: string; host: string; port: number; identity?: string; identitiesOnly: boolean; jump?: string; secretKey?: string;
}

export function uploadDest(h: Host): UploadDest {
  const jump = h.proxyJump?.trim();
  const sk = activeSecretKey(h);
  return {
    host: h.host, port: h.port ?? 22,
    ...(h.user ? { user: h.user } : {}),
    ...(h.identityFile ? { identity: h.identityFile } : {}),
    identitiesOnly: h.authMethod === 'key' && !!h.identityFile,
    ...(jump ? { jump } : {}),
    ...(sk ? { secretKey: sk } : {}),
  };
}

/** Error de Rust «too-large:<bytes>» -> MB (una cifra decimal), o null si es otro error. */
export function tooLargeMb(err: string): number | null {
  const m = /too-large:(\d+)/.exec(err);
  return m ? Math.round(Number(m[1]) / 104857.6) / 10 : null;
}
