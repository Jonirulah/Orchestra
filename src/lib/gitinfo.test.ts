import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCwd, parseOsc9, parseOsc7, withCwdTracking, PS_WRAPPER, truncateBranch, gitLevel, chipText, cwdForPane, sameGit, isLocalUsable,
  type GitInfo,
} from './gitinfo.ts';

const base: GitInfo = {
  repoRoot: 'C:\\r', branch: 'main', detached: false, hasUpstream: true, ahead: 0, behind: 0,
  dirtyCount: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, worktree: false, inProgress: null,
};

test('OSC 9;9: Windows drive paths, spaces, forward slashes, quotes', () => {
  assert.equal(parseOsc9('9;C:\\Users\\me\\proj'), 'C:\\Users\\me\\proj');
  assert.equal(parseOsc9('9;c:/Users/me/My Project/'), 'C:\\Users\\me\\My Project');
  assert.equal(parseOsc9('9;"D:\\a b\\c"'), 'D:\\a b\\c');
  assert.equal(parseOsc9('9;C:\\'), 'C:\\');
  assert.equal(parseOsc9('9;C:\\\\a\\\\b'), 'C:\\a\\b');
});

test('OSC 9;9: bad input is rejected', () => {
  assert.equal(parseOsc9('9;'), null);
  assert.equal(parseOsc9('4;C:\\x'), null);
  assert.equal(parseOsc9('9;relative\\dir'), null);
  assert.equal(parseOsc9('9;\\\\server\\share\\x'), null);
  assert.equal(parseOsc9('9;-C'), null);
  assert.equal(parseOsc9('9;C:\\a\\..\\b'), null);
  assert.equal(parseOsc9('9;C:\\a\x1bb'), null);
  assert.equal(parseOsc9('9;C:\\' + 'a'.repeat(1100)), null);
});

test('OSC 7: percent-decoding, drive paths, hosts', () => {
  assert.equal(parseOsc7('file:///C:/Users/me/My%20Project'), 'C:\\Users\\me\\My Project');
  assert.equal(parseOsc7('file://localhost/c:/x/%C3%B1and%C3%BA'), 'C:\\x\\ñandú');
  assert.equal(parseOsc7('file://PC01/home/me/a%20b'), '/home/me/a b');
  assert.equal(parseOsc7('file:///home/me/%E2%9C%93'), '/home/me/✓');
  assert.equal(parseOsc7('file:///'), '/');
});

test('OSC 7: bad input is rejected', () => {
  assert.equal(parseOsc7('http://x/y'), null);
  assert.equal(parseOsc7('file:///home/%E0%A4%A'), null); // broken percent escape
  assert.equal(parseOsc7('file:///home/%2e%2e/etc'), null); // decoded ".." segment
  assert.equal(parseOsc7('file:///home/a%00b'), null); // NUL
  assert.equal(parseOsc7('file://bad host/x'), null);
  assert.equal(parseOsc7('file:///' + 'a'.repeat(2000)), null);
  assert.equal(parseOsc7(''), null);
});

test('isLocalUsable: WSL paths are not usable by the Windows git', () => {
  assert.equal(isLocalUsable('C:\\x'), true);
  assert.equal(isLocalUsable('/home/me'), false);
  assert.equal(isLocalUsable('/home/me', false), true);
});

test('withCwdTracking only touches plain PowerShell shell panes', () => {
  const ps = { program: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'] };
  const out = withCwdTracking(ps, true, 'shell');
  assert.deepEqual(out.args, ['-NoLogo', '-NoExit', '-Command', PS_WRAPPER]);
  assert.notEqual(out, ps);
  assert.deepEqual(ps.args, ['-NoLogo']); // the stored spec is not mutated
  assert.equal(withCwdTracking({ program: 'pwsh.exe', args: [] }, true).args[3], PS_WRAPPER);
  // off, other programs, custom args, agent/ssh panes: untouched (same object)
  assert.equal(withCwdTracking(ps, false), ps);
  const cmd = { program: 'cmd.exe', args: [] };
  assert.equal(withCwdTracking(cmd, true), cmd);
  const codex = { program: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', '& codex'] };
  assert.equal(withCwdTracking(codex, true, 'agent'), codex);
  assert.equal(withCwdTracking(codex, true), codex);
  assert.equal(withCwdTracking(ps, true, 'ssh'), ps);
  const prof = { program: 'powershell.exe', args: ['-NoProfile'] };
  assert.equal(withCwdTracking(prof, true), prof);
});

test('PS wrapper keeps the user prompt and is a single safe line', () => {
  assert.ok(!PS_WRAPPER.includes('\n'));
  assert.ok(PS_WRAPPER.includes('$function:prompt'));
  assert.ok(PS_WRAPPER.includes(']9;9;'));
  assert.ok(!PS_WRAPPER.includes('"')); // survives the Windows command-line quoting of -Command
});

test('truncateBranch', () => {
  assert.equal(truncateBranch('main'), 'main');
  assert.equal(truncateBranch('a'.repeat(22)), 'a'.repeat(22));
  assert.equal(truncateBranch('feature/' + 'x'.repeat(30)), 'feature/' + 'x'.repeat(13) + '…');
  assert.equal(Array.from(truncateBranch('é'.repeat(40))).length, 22);
});

test('gitLevel: clean / dirty / bad', () => {
  assert.equal(gitLevel(base), 'clean');
  assert.equal(gitLevel({ ...base, ahead: 3 }), 'clean');
  assert.equal(gitLevel({ ...base, dirtyCount: 1 }), 'dirty');
  assert.equal(gitLevel({ ...base, untracked: 2 }), 'dirty');
  assert.equal(gitLevel({ ...base, conflicts: 1, dirtyCount: 1 }), 'bad');
  assert.equal(gitLevel({ ...base, inProgress: 'rebase' }), 'bad');
});

test('chipText', () => {
  assert.deepEqual(chipText(base), { name: 'main', changes: '', ahead: '', behind: '' });
  const g = { ...base, dirtyCount: 2, untracked: 1, ahead: 4, behind: 1 };
  assert.deepEqual(chipText(g), { name: 'main', changes: '±3', ahead: '↑4', behind: '↓1' });
  assert.equal(chipText(g, false).changes, '');
  assert.equal(chipText({ ...base, branch: null }).name, '?');
});

test('cwdForPane: shell report > agent folder > start folder; junk and WSL paths are skipped', () => {
  assert.equal(cwdForPane('C:\\a', 'C:\\g', 'C:\\b'), 'C:\\a');
  assert.equal(cwdForPane(undefined, 'C:/g', 'C:\\b'), 'C:\\g');
  assert.equal(cwdForPane(undefined, undefined, 'C:\\b'), 'C:\\b');
  assert.equal(cwdForPane('nonsense', undefined, 'C:\\b'), 'C:\\b');
  assert.equal(cwdForPane('/home/me', undefined, 'C:\\b'), 'C:\\b');
  assert.equal(cwdForPane(undefined, undefined, undefined), undefined);
  assert.equal(cwdForPane(undefined, undefined, 'rel'), undefined);
});

test('normalizeCwd / sameGit', () => {
  assert.equal(normalizeCwd('/home/me/'), '/home/me');
  assert.equal(normalizeCwd('d:\\x\\'), 'D:\\x');
  assert.ok(sameGit(base, { ...base }));
  assert.ok(!sameGit(base, { ...base, ahead: 1 }));
  assert.ok(sameGit(null, null));
  assert.ok(!sameGit(base, null));
});

test('git settings: defaults, clamping, section reset', async () => {
  const { DEFAULTS, LIMITS, clampSettings, SECTION_KEYS } = await import('./settings.ts');
  assert.equal(DEFAULTS.gitChip, true);
  assert.equal(DEFAULTS.gitCounts, true);
  assert.equal(DEFAULTS.gitTrackFolder, true);
  assert.equal(DEFAULTS.gitIntervalSec, 5);
  assert.deepEqual([...LIMITS.gitIntervalSec], [2, 30]);
  assert.equal(clampSettings({ gitIntervalSec: 1 }).gitIntervalSec, 2);
  assert.equal(clampSettings({ gitIntervalSec: 999 }).gitIntervalSec, 30);
  assert.equal(clampSettings({ gitIntervalSec: 'x' }).gitIntervalSec, 5);
  assert.equal(clampSettings({ gitChip: 'yes' }).gitChip, true);
  assert.equal(clampSettings({ gitChip: false }).gitChip, false);
  assert.equal(clampSettings({ gitTrackFolder: false }).gitTrackFolder, false);
  for (const k of ['gitChip', 'gitCounts', 'gitIntervalSec', 'gitTrackFolder']) assert.ok((SECTION_KEYS.terminal as readonly string[]).includes(k), k);
});
