import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLocale } from './i18n.ts';
import { checkable, shouldRefresh, statusLabel, statusTone, toProviderEntry, STATUS_MIN_GAP_MS } from './providers.ts';
import type { ProviderEntry } from './providers.ts';
import type { Account } from './model.ts';

afterEach(() => setLocale('en'));

test('toProviderEntry keeps only the verdict, the method and a small count', () => {
  const secret = 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const e = toProviderEntry({ status: 'signedIn', method: 'apikey', count: 2, key: secret, token: secret, text: `Logged in using ${secret}` }, 123);
  assert.deepEqual(e, { status: 'signedIn', method: 'apikey', count: 2, at: 123 });
  assert.ok(!JSON.stringify(e).includes('sk-'));
  assert.deepEqual(toProviderEntry({ status: 'notSignedIn' }, 5), { status: 'notSignedIn', at: 5 });
  // Valores raros o desconocidos -> unknown / se descartan.
  assert.deepEqual(toProviderEntry({ status: 'maybe', method: secret, count: -1 }, 5), { status: 'unknown', at: 5 });
  assert.deepEqual(toProviderEntry({ status: 'signedIn', count: 1.5 }, 5), { status: 'signedIn', at: 5 });
  assert.deepEqual(toProviderEntry({ status: 'signedIn', count: 5000 }, 5), { status: 'signedIn', at: 5 });
  for (const junk of [null, undefined, 'x', 7, []]) assert.deepEqual(toProviderEntry(junk, 9), { status: 'unknown', at: 9 });
});

test('shouldRefresh debounces per account unless forced', () => {
  const e: ProviderEntry = { status: 'signedIn', at: 1_000_000 };
  assert.equal(shouldRefresh(undefined, 1_000_000), true);
  assert.equal(shouldRefresh(e, 1_000_000 + STATUS_MIN_GAP_MS - 1), false);
  assert.equal(shouldRefresh(e, 1_000_000 + STATUS_MIN_GAP_MS), true);
  assert.equal(shouldRefresh(e, 1_000_001, true), true);
});

test('checkable: only non-Claude accounts are asked about their sign-in', () => {
  const mk = (id: string, provider: Account['provider']): Account => ({ id, name: id, dir: id, isDefault: false, color: '#fff', provider });
  assert.deepEqual(checkable([mk('a', 'claude'), mk('b', 'codex'), mk('c', 'opencode')]).map((a) => a.id), ['b', 'c']);
  const old = { id: 'old', name: 'o', dir: 'x', isDefault: false, color: '#fff' } as unknown as Account;
  assert.deepEqual(checkable([old]), []);
});

test('status labels and tones, in both languages', () => {
  const sign = (extra: object = {}): ProviderEntry => ({ status: 'signedIn', at: 1, ...extra });
  assert.equal(statusLabel(undefined), 'Sign-in status unknown');
  assert.equal(statusLabel(sign({ method: 'chatgpt' })), 'Signed in (ChatGPT)');
  assert.equal(statusLabel(sign({ method: 'apikey' })), 'Signed in (API key)');
  assert.equal(statusLabel(sign({ count: 3 })), 'Signed in · integrations: 3');
  assert.equal(statusLabel(sign()), 'Signed in');
  assert.equal(statusLabel({ status: 'notSignedIn', at: 1 }), 'Not signed in');
  assert.equal(statusLabel(sign(), true), 'Checking…');
  assert.deepEqual([statusTone(sign()), statusTone({ status: 'notSignedIn', at: 1 }), statusTone({ status: 'unknown', at: 1 }), statusTone(undefined)], ['ok', 'warn', 'muted', 'muted']);
  setLocale('es');
  assert.equal(statusLabel(sign({ method: 'chatgpt' })), 'Sesión iniciada (ChatGPT)');
  assert.equal(statusLabel({ status: 'notSignedIn', at: 1 }), 'Sin sesión iniciada');
});

test('the frontend never reads credential files of Codex or opencode', () => {
  for (const f of ['providers.ts', 'store.svelte.ts', 'backend.ts', 'model.ts']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.ok(!/auth\.json|readTextFile|readFile|\bkeyring\b/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), f);
  }
});

test('un panel de «Sign in» vuelve como PowerShell normal y no repite el login', async () => {
  const { restorableSpec, providerSpec } = await import('./model.ts');
  const codex = { id: 'c', name: 'Work', color: '#fff', dir: 'C:/Users/u/.codex-work', provider: 'codex' } as Account;
  const oc = { id: 'o', name: 'Oc', color: '#fff', dir: 'C:/Users/u/.opencode-oc', provider: 'opencode' } as Account;
  for (const a of [codex, oc]) {
    const login = providerSpec(a, { login: true });
    const back = restorableSpec(login);
    assert.deepEqual(back.args, ['-NoLogo'], 'el login no se repite');
    assert.deepEqual(back.env, login.env, 'conserva el entorno de la cuenta');
    assert.equal(back.cwd, login.cwd);
    // El agente normal se restaura tal cual (con su comando).
    const normal = providerSpec(a);
    assert.deepEqual(restorableSpec(normal), normal);
  }
  const ssh = { program: 'ssh', args: ['-p', '22', 'host'] };
  assert.deepEqual(restorableSpec(ssh), ssh);
});
