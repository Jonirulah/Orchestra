import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_IMAGE_PASTE, decidePaste, isImagePath, msysPath, pasteTarget, planDrop, quoteAgent, quoteCmd, quoteFor,
  quotePosix, quotePwsh, shellFlavor, tooLargeMb, uploadDest, wslPath,
} from './imagepaste.ts';
import type { PasteTarget } from './imagepaste.ts';
import type { Account, Host, Pane } from './model.ts';

const host = (id: string, h: string, extra: Partial<Host> = {}): Host => ({ id, name: h, tags: [], host: h, authMethod: 'agent', agentAccess: 'none', ...extra });
const acc = (id: string, provider: Account['provider']): Account => ({ id, name: id, dir: `C:\\u\\.${provider}-${id}`, isDefault: false, color: '#fff', provider });
const pane = (kind: Pane['kind'], ref: string | undefined, program = 'powershell.exe'): Pick<Pane, 'kind' | 'ref' | 'spec'> => ({ kind, ref, spec: { program, args: [] } });

const CLAUDE: PasteTarget = { kind: 'claude' };
const CODEX: PasteTarget = { kind: 'agent' };
const PWSH: PasteTarget = { kind: 'shell', flavor: 'pwsh' };
const SSH_H: PasteTarget = { kind: 'ssh', host: host('h1', 'srv.example.com') };
const SSH_ALIAS: PasteTarget = { kind: 'ssh' };

// ---------- qué hacer al pegar ----------

test('decidePaste: con texto en el portapapeles todo sigue igual, en cualquier panel', () => {
  for (const t of [CLAUDE, CODEX, PWSH, SSH_H, SSH_ALIAS]) {
    assert.equal(decidePaste(t, { hasText: true, hasImage: true }, true), 'text');
    assert.equal(decidePaste(t, { hasText: true }, true), 'text');
  }
});

test('decidePaste: solo imagen -> atajo en Claude, ruta en Codex/opencode/shell, subida en SSH guardado', () => {
  const img = { hasText: false, hasImage: true };
  assert.equal(decidePaste(CLAUDE, img, true), 'claude-key');
  assert.equal(decidePaste(CODEX, img, true), 'save-path');
  assert.equal(decidePaste(PWSH, img, true), 'save-path');
  assert.equal(decidePaste({ kind: 'shell', flavor: 'wsl' }, img, true), 'save-path');
  assert.equal(decidePaste(SSH_H, img, true), 'ssh-upload');
  assert.equal(decidePaste(SSH_ALIAS, img, true), 'ssh-unavailable');
});

test('decidePaste: ajuste apagado o portapapeles sin imagen -> lo de siempre (nada que hacer con imágenes)', () => {
  assert.equal(decidePaste(CLAUDE, { hasText: false, hasImage: true }, false), 'text');
  assert.equal(decidePaste(SSH_H, { hasText: false, hasImage: true }, false), 'text');
  assert.equal(decidePaste(PWSH, { hasText: false, hasImage: false }, true), 'text');
  // Clic derecho: no se sabe si hay imagen -> se intenta (Rust devuelve null si no hay).
  assert.equal(decidePaste(PWSH, { hasText: false }, true), 'save-path');
});

test('atajo de Claude: ESC v en un solo trozo', () => {
  assert.equal(CLAUDE_IMAGE_PASTE, '\u001bv');
  assert.equal(CLAUDE_IMAGE_PASTE.length, 2);
});

// ---------- citar rutas ----------

test('PowerShell: tal cual si es segura; comillas simples con espacios, duplicando las simples y tipográficas', () => {
  assert.equal(quotePwsh('C:\\Users\\me\\img-1.png'), 'C:\\Users\\me\\img-1.png');
  assert.equal(quotePwsh('C:\\Users\\Ana María\\x.png'), "'C:\\Users\\Ana María\\x.png'");
  assert.equal(quotePwsh("C:\\O'Brien\\x.png"), "'C:\\O''Brien\\x.png'");
  assert.equal(quotePwsh('C:\\O’Brien\\x.png'), "'C:\\O’’Brien\\x.png'");
  assert.equal(quotePwsh('C:\\a$b\\x.png'), "'C:\\a$b\\x.png'", '$ se expandiría sin comillas');
  assert.equal(quotePwsh('C:\\a`b\\x.png'), "'C:\\a`b\\x.png'");
});

test('cmd: comillas dobles con espacios o especiales', () => {
  assert.equal(quoteCmd('C:\\Users\\me\\x.png'), 'C:\\Users\\me\\x.png');
  assert.equal(quoteCmd('C:\\Program Files\\x.png'), '"C:\\Program Files\\x.png"');
  assert.equal(quoteCmd('C:\\a&b\\x.png'), '"C:\\a&b\\x.png"');
  assert.equal(quoteCmd('C:\\100%\\x.png'), '"C:\\100%\\x.png"');
});

test('posix (bash, remoto): comillas simples con \'\\\'\' para la comilla', () => {
  assert.equal(quotePosix('/home/me/.cache/orchestra-paste/img-1.png'), '/home/me/.cache/orchestra-paste/img-1.png');
  assert.equal(quotePosix('/home/a b/x.png'), "'/home/a b/x.png'");
  assert.equal(quotePosix("/home/o'b/x.png"), "'/home/o'\\''b/x.png'");
  assert.equal(quotePosix('/x/$HOME/y.png'), "'/x/$HOME/y.png'");
});

test('rutas de Windows en WSL y Git Bash', () => {
  assert.equal(wslPath('C:\\Users\\me\\x.png'), '/mnt/c/Users/me/x.png');
  assert.equal(wslPath('D:/a/b.png'), '/mnt/d/a/b.png');
  assert.equal(msysPath('C:\\Users\\me\\x.png'), '/c/Users/me/x.png');
  assert.equal(quoteFor({ kind: 'shell', flavor: 'wsl' }, 'C:\\Users\\Ana María\\x.png'), "'/mnt/c/Users/Ana María/x.png'");
  assert.equal(quoteFor({ kind: 'shell', flavor: 'posix' }, 'C:\\Users\\me\\x.png'), '/c/Users/me/x.png');
});

test('agentes: comillas dobles solo con espacios', () => {
  assert.equal(quoteAgent('C:\\Users\\me\\x.png'), 'C:\\Users\\me\\x.png');
  assert.equal(quoteAgent('C:\\Users\\Ana María\\x.png'), '"C:\\Users\\Ana María\\x.png"');
  assert.equal(quoteFor(CLAUDE, 'C:\\a b\\x.png'), '"C:\\a b\\x.png"');
  assert.equal(quoteFor({ kind: 'shell', flavor: 'cmd' }, 'C:\\a b\\x.png'), '"C:\\a b\\x.png"');
});

// ---------- soltar archivos ----------

test('planDrop: local pega todas las rutas citadas; SSH sube solo las imágenes; alias no disponible', () => {
  assert.deepEqual(planDrop(PWSH, ['C:\\a b\\x.png', 'C:\\y.txt']), { do: 'paste', text: "'C:\\a b\\x.png' C:\\y.txt" });
  assert.deepEqual(planDrop(CLAUDE, ['C:\\shot.PNG']), { do: 'paste', text: 'C:\\shot.PNG' });
  assert.deepEqual(planDrop(SSH_H, ['C:\\x.png', 'C:\\y.txt', 'C:\\z.JPG']), { do: 'upload', images: ['C:\\x.png', 'C:\\z.JPG'], skipped: 1 });
  assert.deepEqual(planDrop(SSH_H, ['C:\\y.txt']), { do: 'nothing' });
  assert.deepEqual(planDrop(SSH_ALIAS, ['C:\\x.png']), { do: 'unavailable' });
  assert.deepEqual(planDrop(PWSH, []), { do: 'nothing' });
  assert.ok(isImagePath('a.webp') && isImagePath('a.jpeg') && !isImagePath('a.png.txt'));
});

// ---------- de panel a destino ----------

test('pasteTarget: Claude por la cuenta del panel; Codex/opencode como agente; shell por perfil o programa', () => {
  const accounts = [acc('a1', 'claude'), acc('a2', 'codex'), acc('a3', 'opencode')];
  const hosts = [host('h1', 'srv.example.com')];
  assert.deepEqual(pasteTarget(pane('agent', 'a1'), accounts, hosts), { kind: 'claude' });
  assert.deepEqual(pasteTarget(pane('agent', 'a2'), accounts, hosts), { kind: 'agent' });
  assert.deepEqual(pasteTarget(pane('agent', 'a3'), accounts, hosts), { kind: 'agent' });
  assert.deepEqual(pasteTarget(pane('agent', undefined), accounts, hosts), { kind: 'claude' }, 'sin cuenta = Claude por defecto');
  assert.deepEqual(pasteTarget(pane('ssh', 'h1', 'ssh'), accounts, hosts), { kind: 'ssh', host: hosts[0] });
  assert.deepEqual(pasteTarget(pane('ssh', 'cfg:box', 'ssh'), accounts, hosts), { kind: 'ssh' });
  assert.deepEqual(pasteTarget(pane('shell', 'cmd', 'C:\\Windows\\System32\\cmd.exe'), accounts, hosts), { kind: 'shell', flavor: 'cmd' });
  assert.equal(shellFlavor(pane('shell', 'gitbash', 'C:\\Program Files\\Git\\bin\\bash.exe')), 'posix');
  assert.equal(shellFlavor(pane('shell', 'wsl:Ubuntu', 'wsl.exe')), 'wsl');
  assert.equal(shellFlavor(pane('shell', 'pwsh', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')), 'pwsh');
  assert.equal(shellFlavor(pane('shell', undefined, '/usr/bin/zsh')), 'posix');
});

test('uploadDest: mismos datos que las métricas; solo el nombre del secreto', () => {
  const h = host('h1', 'srv.example.com', { user: 'root', port: 2222, authMethod: 'password', hasPassword: true, proxyJump: ' j@b ' });
  assert.deepEqual(uploadDest(h), { host: 'srv.example.com', port: 2222, user: 'root', identitiesOnly: false, jump: 'j@b', secretKey: 'host:h1:password' });
  const k = host('h2', 'b.example.com', { authMethod: 'key', identityFile: 'C:\\k\\id_ed25519' });
  assert.deepEqual(uploadDest(k), { host: 'b.example.com', port: 22, identity: 'C:\\k\\id_ed25519', identitiesOnly: true });
});

test('tooLargeMb: traduce el error de tamaño de Rust', () => {
  assert.equal(tooLargeMb('too-large:31457280'), 30);
  assert.equal(tooLargeMb('too-large:27000000'), 25.7);
  assert.equal(tooLargeMb('ssh exit 255'), null);
});
