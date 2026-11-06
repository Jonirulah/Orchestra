// Shared, reactive git state per pane. Written by GitChip (one per visible local pane), read by the sidebar.
import * as be from './backend.ts';
import { sameGit } from './gitinfo.ts';
import type { GitInfo } from './gitinfo.ts';

export const gitState = $state<{ byPane: Record<string, GitInfo | null> }>({ byPane: {} });

/** Asks the backend (cached there for 1.5 s) and stores the answer only when it changed. Returns whether git answered. */
export async function refreshGit(paneId: string, cwd: string): Promise<GitInfo | null> {
  const info = await be.gitInfo(cwd);
  if (!sameGit(gitState.byPane[paneId], info)) gitState.byPane[paneId] = info;
  return info;
}

export function forgetGit(paneId: string): void {
  delete gitState.byPane[paneId];
}
