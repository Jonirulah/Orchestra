// Puente con Rust del reenvío de puertos (portfwd.rs) y, sin Tauri (demo en el navegador), túneles FALSOS que conectan
// en ~0,7 s. En la demo el 5173 local está «ocupado» para ver cómo se elige el siguiente libre.
import { invoke } from '@tauri-apps/api/core';
import { inTauri } from './backend.ts';
import type { FwdDest, TunnelSnap } from './portdetect.ts';
import { destKey, tunnelId } from './portdetect.ts';

export interface FwdStartReq extends FwdDest { remotePort: number; localPort?: number }

const demo = new Map<string, TunnelSnap>();
const DEMO_BUSY = new Set([5173]);

function demoStart(r: FwdStartReq): TunnelSnap {
  const id = tunnelId(r, r.remotePort);
  const cur = demo.get(id);
  if (cur) return { ...cur };
  const taken = new Set([...demo.values()].map((t) => t.localPort));
  let local = r.localPort ?? r.remotePort;
  while (DEMO_BUSY.has(local) || taken.has(local)) local++;
  const s: TunnelSnap = { id, destKey: destKey(r), remotePort: r.remotePort, localPort: local, state: 'connecting', error: null, attempt: 0, retryIn: null, pid: null };
  demo.set(id, s);
  setTimeout(() => { const t = demo.get(id); if (t) t.state = 'up'; }, 700);
  return { ...s };
}

export async function pfwdStart(req: FwdStartReq): Promise<TunnelSnap> {
  if (inTauri) return invoke<TunnelSnap>('pfwd_start', { req });
  return demoStart(req);
}

export function pfwdStop(id: string): void {
  if (inTauri) void invoke('pfwd_stop', { id });
  else demo.delete(id);
}

export async function pfwdList(): Promise<TunnelSnap[]> {
  if (inTauri) return invoke<TunnelSnap[]>('pfwd_list');
  return [...demo.values()].map((t) => ({ ...t })).sort((a, b) => a.id.localeCompare(b.id));
}
