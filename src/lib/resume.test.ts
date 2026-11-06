import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeSpec, isSessionId, restoreSpecFor, resumeCandidate, sessionForSave, stripResume, trackSession,
} from './model.ts';
import type { Account, Pane } from './model.ts';
import { DEFAULTS, SECTION_KEYS, clampSettings, resetSection } from './settings.ts';

const ID1 = '0b1f6c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b';
const ID2 = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const DIR = 'C:\\Users\\me\\.claude';

const acc = (over: Partial<Account> = {}): Account => ({
  id: 'acc1', name: 'Main', dir: DIR, isDefault: true, provider: 'claude', color: '#fff', ...over,
});
const pane = (over: Partial<Pane> = {}): Pane => ({
  id: 't1', col: 0, row: 0, colSpan: 1, rowSpan: 1, parked: false, kind: 'agent', icon: 'bot', title: 'Claude · Main', ref: 'acc1',
  spec: claudeSpec(acc(), { cwd: 'E:\\work' }), lastSession: { id: ID1, dir: DIR }, ...over,
});
const on = { setting: true, account: acc(), exists: true };

// ---------- restoreSpecFor ----------

test('resume: setting on, remembered session, transcript there -> resume(id)', () => {
  assert.deepEqual(restoreSpecFor(pane(), on), { mode: 'resume', id: ID1 });
});

test('fresh when the setting is off', () => {
  assert.deepEqual(restoreSpecFor(pane(), { ...on, setting: false }), { mode: 'fresh' });
});

test('fresh when the pane has no lastSession', () => {
  assert.deepEqual(restoreSpecFor(pane({ lastSession: undefined }), on), { mode: 'fresh' });
});

test('fresh when the stored id is not a UUID (never reaches an argv)', () => {
  for (const bad of ['', 'nope', '--mcp-config', `${ID1} & calc`, `${ID1}'; rm -rf /`, ID1.toUpperCase(), ID1 + 'a', ID1.slice(1), '../../x', ID1.replace('0', 'g')]) {
    assert.deepEqual(restoreSpecFor(pane({ lastSession: { id: bad, dir: DIR } }), on), { mode: 'fresh' }, bad);
  }
  assert.deepEqual(restoreSpecFor(pane({ lastSession: { id: 42 as unknown as string, dir: DIR } }), on), { mode: 'fresh' });
  assert.deepEqual(restoreSpecFor(pane({ lastSession: { id: ID1, dir: undefined as unknown as string } }), on), { mode: 'fresh' });
});

test('fresh when the transcript no longer exists', () => {
  assert.deepEqual(restoreSpecFor(pane(), { ...on, exists: false }), { mode: 'fresh' });
});

test('fresh when the user ended Claude (/exit)', () => {
  assert.deepEqual(restoreSpecFor(pane({ lastSession: { id: ID1, dir: DIR, ended: true } }), on), { mode: 'fresh' });
});

test('fresh for other providers, shells, ssh and missing accounts', () => {
  assert.deepEqual(restoreSpecFor(pane(), { ...on, account: acc({ provider: 'codex' }) }), { mode: 'fresh' });
  assert.deepEqual(restoreSpecFor(pane(), { ...on, account: acc({ provider: 'opencode' }) }), { mode: 'fresh' });
  assert.deepEqual(restoreSpecFor(pane({ kind: 'shell' }), on), { mode: 'fresh' });
  assert.deepEqual(restoreSpecFor(pane({ kind: 'ssh' }), on), { mode: 'fresh' });
  assert.deepEqual(restoreSpecFor(pane(), { ...on, account: undefined }), { mode: 'fresh' });
});

test('fresh when the stored folder is no longer the pane account folder; separators and case do not matter', () => {
  assert.deepEqual(restoreSpecFor(pane({ lastSession: { id: ID1, dir: 'C:\\Users\\me\\.claude-work' } }), on), { mode: 'fresh' });
  assert.deepEqual(restoreSpecFor(pane({ lastSession: { id: ID1, dir: 'c:/users/ME/.claude/' } }), on), { mode: 'resume', id: ID1 });
});

test('two panes in the same folder each resume their OWN session', () => {
  const a = pane({ id: 'a', lastSession: { id: ID1, dir: DIR } });
  const b = pane({ id: 'b', lastSession: { id: ID2, dir: DIR } });
  assert.equal(a.spec.cwd, b.spec.cwd);
  assert.deepEqual(restoreSpecFor(a, on), { mode: 'resume', id: ID1 });
  assert.deepEqual(restoreSpecFor(b, on), { mode: 'resume', id: ID2 });
  const sa = claudeSpec(acc(), { cwd: a.spec.cwd, resumeId: ID1 }).args.at(-1)!;
  const sb = claudeSpec(acc(), { cwd: b.spec.cwd, resumeId: ID2 }).args.at(-1)!;
  assert.ok(sa.includes(`--resume ${ID1}`) && !sa.includes(ID2));
  assert.ok(sb.includes(`--resume ${ID2}`) && !sb.includes(ID1));
});

test('resumeCandidate is the disk-free half of the decision', () => {
  assert.equal(resumeCandidate(pane(), true, acc()), ID1);
  assert.equal(resumeCandidate(pane(), false, acc()), null);
});

// ---------- claudeSpec argv ----------

test('claudeSpec: --resume <id> comes before --settings and the variadic --mcp-config, which stays last', () => {
  const s = claudeSpec(acc(), { cwd: 'E:\\w', resumeId: ID1, settingsPath: 'C:\\o\\set.json', mcpConfig: 'C:\\o\\mcp.json' });
  const cmd = s.args.at(-1)!;
  assert.equal(cmd, `& claude --resume ${ID1} --settings 'C:\\o\\set.json' --mcp-config 'C:\\o\\mcp.json'`);
  assert.ok(cmd.indexOf('--resume') < cmd.indexOf('--mcp-config'));
  assert.ok(cmd.trim().endsWith("--mcp-config 'C:\\o\\mcp.json'"));
  assert.equal(s.cwd, 'E:\\w');
  assert.deepEqual(s.args.slice(0, 3), ['-NoLogo', '-NoExit', '-Command']);
});

test('claudeSpec: an invalid resumeId is ignored (--continue if asked, else fresh); a valid one wins over --continue', () => {
  assert.equal(claudeSpec(acc(), { resumeId: 'x; calc' }).args.at(-1), '& claude');
  assert.equal(claudeSpec(acc(), { resumeId: 'x; calc', resume: true }).args.at(-1), '& claude --continue');
  assert.equal(claudeSpec(acc(), { resume: true }).args.at(-1), '& claude --continue');
  assert.equal(claudeSpec(acc(), { resumeId: ID1, resume: true }).args.at(-1), `& claude --resume ${ID1}`);
  assert.equal(claudeSpec(acc(), {}).args.at(-1), '& claude');
});

test('claudeSpec keeps the account env', () => {
  assert.deepEqual(claudeSpec(acc({ isDefault: false, dir: 'D:\\c2', id: 'a2' }), { resumeId: ID1 }).env, { CLAUDE_CONFIG_DIR: 'D:\\c2', ORCHESTRA_ACCOUNT: 'a2' });
});

test('stripResume turns a resumed command back into a fresh one and leaves the rest alone', () => {
  const r = claudeSpec(acc(), { resumeId: ID1, settingsPath: 'S', mcpConfig: 'M' });
  const f = stripResume(r);
  assert.equal(f.args.at(-1), "& claude --settings 'S' --mcp-config 'M'");
  const plain = claudeSpec(acc(), { resume: true });
  assert.equal(stripResume(plain), plain);
  const sh = { program: 'pwsh.exe', args: ['-NoLogo'] };
  assert.equal(stripResume(sh), sh);
});

// ---------- tracking and persistence ----------

test('trackSession: stores a new id, ignores the same one, ignores invalid ids and a missing dir', () => {
  assert.deepEqual(trackSession(undefined, { sessionId: ID1, configDir: DIR }), { id: ID1, dir: DIR });
  assert.equal(trackSession({ id: ID1, dir: DIR }, { sessionId: ID1, configDir: DIR }), null);
  assert.deepEqual(trackSession({ id: ID1, dir: DIR }, { sessionId: ID2, configDir: DIR }), { id: ID2, dir: DIR });
  assert.deepEqual(trackSession({ id: ID1, dir: DIR }, { sessionId: ID1, configDir: 'D:\\c2' }), { id: ID1, dir: 'D:\\c2' });
  // Same id seen again after /exit: the "ended" flag is cleared.
  assert.deepEqual(trackSession({ id: ID1, dir: DIR, ended: true }, { sessionId: ID1, configDir: DIR }), { id: ID1, dir: DIR });
  assert.equal(trackSession(undefined, { sessionId: 'nope', configDir: DIR }), null);
  assert.equal(trackSession(undefined, { sessionId: ID1 }), null);
  assert.equal(trackSession(undefined, {}), null);
});

test('sessionForSave: a pane shown as exited with code 0 is saved as ended; running or crashed panes keep resuming', () => {
  const ls = { id: ID1, dir: DIR };
  assert.deepEqual(sessionForSave(ls, { state: 'exited', code: 0 }), { ...ls, ended: true });
  assert.deepEqual(sessionForSave(ls, { state: 'running' }), ls);
  assert.deepEqual(sessionForSave(ls, { state: 'exited', code: 1 }), ls);
  assert.deepEqual(sessionForSave(ls, undefined), ls);
  assert.equal(sessionForSave(undefined, { state: 'exited', code: 0 }), undefined);
  // And the saved form really does not resume.
  assert.deepEqual(restoreSpecFor(pane({ lastSession: sessionForSave(ls, { state: 'exited', code: 0 }) }), on), { mode: 'fresh' });
});

test('isSessionId', () => {
  assert.ok(isSessionId(ID1));
  for (const bad of [undefined, null, 1, {}, '', 'a', ID1 + '\n', ` ${ID1}`, ID1.toUpperCase()]) assert.equal(isSessionId(bad), false, String(bad));
});

test('migration: a state saved before lastSession existed loads unchanged and restores fresh', () => {
  const old = JSON.parse(JSON.stringify({ ...pane(), lastSession: undefined })) as Pane;
  assert.equal('lastSession' in old, false);
  assert.equal(old.lastSession, undefined);
  assert.deepEqual(restoreSpecFor(old, on), { mode: 'fresh' });
  assert.equal(stripResume(old.spec), old.spec);
  // A saved lastSession survives the JSON round trip of state.json.
  const back = JSON.parse(JSON.stringify(pane())) as Pane;
  assert.deepEqual(restoreSpecFor(back, on), { mode: 'resume', id: ID1 });
});

// ---------- setting ----------

test('restoreClaudeSessions: default on, bool-only, in the Agents section reset', () => {
  assert.equal(DEFAULTS.restoreClaudeSessions, true);
  assert.equal(clampSettings({}).restoreClaudeSessions, true); // old state files have no such key
  assert.equal(clampSettings({ restoreClaudeSessions: false }).restoreClaudeSessions, false);
  assert.equal(clampSettings({ restoreClaudeSessions: 'no' }).restoreClaudeSessions, true);
  assert.ok((SECTION_KEYS.agents as readonly string[]).includes('restoreClaudeSessions'));
  const r = resetSection({ ...DEFAULTS, restoreClaudeSessions: false }, 'agents');
  assert.equal(r.restoreClaudeSessions, true);
});
