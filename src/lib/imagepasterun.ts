// Ejecuta lo que decide imagepaste.ts: habla con Rust (portapapeles, guardado, subida por ssh), escribe en el panel y
// avisa con un toast. Separado del módulo puro para poder probar aquel sin Tauri.
import * as be from './backend.ts';
import { t } from './i18n.ts';
import { CLAUDE_IMAGE_PASTE, planDrop, quoteFor, quotePosix, tooLargeMb, uploadDest } from './imagepaste.ts';
import type { PasteAction, PasteTarget } from './imagepaste.ts';
import type { Host } from './model.ts';

export interface PasteIO {
  /** Bytes crudos al PTY (el atajo de Claude). */
  write(id: string, data: string): void;
  /** Texto pegado por xterm (bracketed paste si el programa lo pidió). */
  paste(id: string, text: string): void;
  toast(msg: string): void;
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function failText(e: unknown, key: 'imagepaste.failed' | 'imagepaste.uploadFailed'): string {
  const m = msgOf(e);
  const mb = tooLargeMb(m);
  return mb !== null ? t('imagepaste.tooLarge', { mb }) : t(key, { error: m });
}

const hostLabel = (h: Host): string => h.name || h.host;

/** Sube un archivo local al host y devuelve la ruta remota ya citada (con aviso de «subiendo…»). */
async function upload(io: PasteIO, h: Host, path: string): Promise<string> {
  io.toast(t('imagepaste.uploading', { host: hostLabel(h) }));
  return quotePosix(await be.sshUploadImage(uploadDest(h), path));
}

export async function runImagePaste(io: PasteIO, id: string, target: PasteTarget, action: PasteAction): Promise<void> {
  if (action === 'text') return;
  if (action === 'ssh-unavailable') { io.toast(t('imagepaste.sshAlias')); return; }
  try {
    if (action === 'claude-key') {
      // Claude lee el portapapeles él mismo: solo se comprueba que hay imagen (si no, Alt+V no haría nada útil).
      const info = await be.clipboardImageInfo();
      if (!info) return;
      io.write(id, CLAUDE_IMAGE_PASTE);
      io.toast(t('imagepaste.pasted', { w: info.width, h: info.height }));
      return;
    }
    const saved = await be.clipboardImageToFile();
    if (!saved) return; // no había imagen (clic derecho con el portapapeles vacío)
    if (action === 'save-path') {
      io.paste(id, quoteFor(target, saved.path));
    } else {
      if (target.kind !== 'ssh' || !target.host) return;
      try { io.paste(id, await upload(io, target.host, saved.path)); } catch (e) { io.toast(failText(e, 'imagepaste.uploadFailed')); return; }
    }
    io.toast(t('imagepaste.pasted', { w: saved.width, h: saved.height }));
  } catch (e) {
    io.toast(failText(e, 'imagepaste.failed'));
  }
}

/** Archivos soltados desde el Explorador: rutas locales tal cual (citadas) o, en SSH, las imágenes subidas. */
export async function runDrop(io: PasteIO, id: string, target: PasteTarget, paths: readonly string[]): Promise<void> {
  const plan = planDrop(target, paths);
  if (plan.do === 'nothing') return;
  if (plan.do === 'unavailable') { io.toast(t('imagepaste.sshAlias')); return; }
  if (plan.do === 'paste') { io.paste(id, plan.text); return; }
  if (target.kind !== 'ssh' || !target.host) return;
  const h = target.host;
  const out: string[] = [];
  for (const p of plan.images) {
    try { out.push(await upload(io, h, p)); } catch (e) { io.toast(failText(e, 'imagepaste.uploadFailed')); break; }
  }
  if (out.length) io.paste(id, out.join(' '));
  if (plan.skipped) io.toast(t('imagepaste.skipped', { n: plan.skipped }));
  else if (out.length === 1) io.toast(t('imagepaste.uploaded', { host: hostLabel(h) }));
  else if (out.length > 1) io.toast(t('imagepaste.uploadedMany', { n: out.length, host: hostLabel(h) }));
}
