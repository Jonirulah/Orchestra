import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseName, crumbs, errorKey, filterEntries, fmtDate, fmtPerm, fmtSize, joinPath, localBase, parentPath, pct, Queue, resolveClash,
  sftpDest, shellQuote, sortEntries, uniqueName, validName, MAX_RUNNING,
} from './sftp.ts';
import type { Entry } from './sftp.ts';
import type { Host } from './model.ts';

const e = (name: string, o: Partial<Entry> = {}): Entry => ({ name, size: 0, mtime: 0, perm: 0o100644, isDir: false, isLink: false, ...o });

test('rutas: unir, subir nivel, nombre y migas', () => {
  assert.equal(joinPath('/', 'a'), '/a');
  assert.equal(joinPath('/home/u', 'a b'), '/home/u/a b');
  assert.equal(joinPath('/home/u/', 'x'), '/home/u/x');
  assert.equal(parentPath('/home/u'), '/home');
  assert.equal(parentPath('/home'), '/');
  assert.equal(parentPath('/'), '/');
  assert.equal(parentPath('/a/b/'), '/a');
  assert.equal(parentPath('/C:/Users'), '/C:');
  assert.equal(baseName('/a/b c'), 'b c');
  assert.equal(baseName('/'), '/');
  assert.deepEqual(crumbs('/home/u/año'), [
    { label: '/', path: '/' }, { label: 'home', path: '/home' }, { label: 'u', path: '/home/u' }, { label: 'año', path: '/home/u/año' },
  ]);
  assert.deepEqual(crumbs('/'), [{ label: '/', path: '/' }]);
  assert.equal(localBase('C:\\Users\\me\\Fotos\\'), 'Fotos');
  assert.equal(localBase('C:\\a\\b.txt'), 'b.txt');
});

test('shellQuote: espacios, comillas y rutas seguras', () => {
  assert.equal(shellQuote('/srv/app/x.log'), '/srv/app/x.log');
  assert.equal(shellQuote('/home/u/a b'), `'/home/u/a b'`);
  assert.equal(shellQuote(`/tmp/it's`), `'/tmp/it'\\''s'`);
  assert.equal(shellQuote('/tmp/$(rm -rf ~)'), `'/tmp/$(rm -rf ~)'`);
  assert.equal(shellQuote('-rf'), `'-rf'`);
  assert.equal(shellQuote('/home/ñandú'), `'/home/ñandú'`);
  assert.equal(shellQuote(''), `''`);
});

test('nombres: válidos y únicos', () => {
  assert.ok(validName('año «1».txt'));
  for (const bad of ['', '.', '..', 'a/b', 'a\0b', 'x'.repeat(256)]) assert.ok(!validName(bad), bad);
  assert.equal(uniqueName('a.txt', new Set(['a.txt', 'a (1).txt'])), 'a (2).txt');
  assert.equal(uniqueName('a.txt', new Set()), 'a.txt');
  assert.equal(uniqueName('.bashrc', new Set(['.bashrc'])), '.bashrc (1)');
  assert.equal(uniqueName('Makefile', new Set(['Makefile'])), 'Makefile (1)');
});

test('choque al subir: sobrescribir, saltar, renombrar', () => {
  const taken = new Set(['r.txt']);
  assert.deepEqual(resolveClash('n.txt', false, null, taken), { name: 'n.txt', overwrite: false });
  assert.deepEqual(resolveClash('r.txt', true, 'overwrite', taken), { name: 'r.txt', overwrite: true });
  assert.deepEqual(resolveClash('r.txt', true, 'rename', taken), { name: 'r (1).txt', overwrite: false });
  assert.equal(resolveClash('r.txt', true, 'skip', taken), null);
  assert.equal(resolveClash('r.txt', true, null, taken), null);
});

test('orden: carpetas primero, natural, por tamaño y fecha; filtro y ocultos', () => {
  const l = [e('b10.txt', { size: 5, mtime: 3 }), e('b2.txt', { size: 50, mtime: 1 }), e('Zeta', { isDir: true }), e('.env', { size: 1, mtime: 9 }), e('alfa', { isDir: true, isLink: true })];
  assert.deepEqual(sortEntries(l).map((x) => x.name), ['alfa', 'Zeta', '.env', 'b2.txt', 'b10.txt']);
  assert.deepEqual(sortEntries(l, 'size', true).map((x) => x.name), ['Zeta', 'alfa', 'b2.txt', 'b10.txt', '.env']);
  assert.deepEqual(sortEntries(l, 'mtime').filter((x) => !x.isDir).map((x) => x.name), ['b2.txt', 'b10.txt', '.env']);
  assert.deepEqual(filterEntries(l, '', false).map((x) => x.name), ['b10.txt', 'b2.txt', 'Zeta', 'alfa']);
  assert.deepEqual(filterEntries(l, 'B1', true).map((x) => x.name), ['b10.txt']);
  assert.deepEqual(filterEntries(l, 'env', true).map((x) => x.name), ['.env']);
});

test('formatos: tamaño, permisos y fecha', () => {
  assert.equal(fmtSize(0), '0 B');
  assert.equal(fmtSize(1023), '1023 B');
  assert.equal(fmtSize(1536), '1.5 KB');
  assert.equal(fmtSize(50 * 1024 * 1024), '50 MB');
  assert.equal(fmtSize(123.4 * 1024 ** 3), '123 GB');
  assert.equal(fmtPerm(0o040755), 'drwxr-xr-x');
  assert.equal(fmtPerm(0o100644), '-rw-r--r--');
  assert.equal(fmtPerm(0o120777), 'lrwxrwxrwx');
  assert.equal(fmtPerm(0o104755), '-rwsr-xr-x');
  assert.equal(fmtPerm(0o041777), 'drwxrwxrwt');
  assert.match(fmtDate(1_700_000_000), /^2023-11-1[45] \d\d:\d\d$/);
  assert.equal(fmtDate(0), '');
});

test('errores de Rust → claves', () => {
  assert.deepEqual(errorKey('E_NOFILE: /x'), { key: 'files.err.nofile', detail: '/x' });
  assert.equal(errorKey('Error: E_HOSTKEY: host key not trusted yet').key, 'files.err.hostkey');
  assert.equal(errorKey('E_CANCEL').key, 'files.err.cancel');
  assert.deepEqual(errorKey('SFTP is not enabled on this server'), { key: 'files.err.other', detail: 'SFTP is not enabled on this server' });
});

test('destino desde un host guardado: solo el NOMBRE del secreto', () => {
  const h = { id: 'h1', name: 'web', host: 'web.example', user: 'u', port: 2222, authMethod: 'password', hasPassword: true, proxyJump: ' j@b ', tags: [] } as unknown as Host;
  const d = sftpDest(h);
  assert.equal(d.host, 'web.example');
  assert.equal(d.port, 2222);
  assert.equal(d.jump, 'j@b');
  assert.ok(d.secretKey?.startsWith('host:'));
  assert.equal(d.identitiesOnly, false);
  assert.equal(sftpDest({ ...h, port: undefined, authMethod: 'agent', proxyJump: '' } as unknown as Host).port, 22);
});

test('cola: límite de paralelas, progreso, velocidad, cancelar, reintentar y fin', () => {
  const q = new Queue();
  const mk = (n: string) => q.add({ id: `id-${n}`, dir: 'up', hostId: 'h', hostName: 'web', name: n, local: `C:\\${n}`, remoteDir: '/srv' }, 0);
  for (const n of ['a', 'b', 'c', 'd']) mk(n);
  const s1 = q.startable(0);
  assert.equal(s1.length, MAX_RUNNING);
  assert.equal(q.get('id-d')!.state, 'queued');
  q.progress({ id: 'id-a', done: 0, total: 1000, state: 'run' }, 0);
  q.progress({ id: 'id-a', done: 500, total: 1000, state: 'run' }, 1000);
  assert.equal(q.get('id-a')!.speed, 500);
  assert.equal(pct(q.get('id-a')!), 50);
  assert.deepEqual(q.summary(), { active: 4, done: 500, total: 1000, pct: 50 });
  // Cancelar una en marcha avisa a Rust; una en cola no.
  assert.equal(q.cancel('id-b'), true);
  assert.equal(q.cancel('id-d'), false);
  assert.equal(q.get('id-d')!.state, 'cancelled');
  // Avisos tardíos de una cancelada no la resucitan.
  q.progress({ id: 'id-b', done: 10, total: 100, state: 'run' }, 1100);
  assert.equal(q.get('id-b')!.state, 'cancelled');
  // Fin y error.
  q.progress({ id: 'id-a', done: 1000, total: 1000, state: 'done', path: null }, 2000);
  assert.equal(q.get('id-a')!.state, 'done');
  assert.equal(pct(q.get('id-a')!), 100);
  q.progress({ id: 'id-c', done: 3, total: 9, state: 'error', error: 'E_DENIED: /srv/c' }, 2000);
  assert.equal(q.get('id-c')!.error, 'E_DENIED: /srv/c');
  // Un aviso tardío tras acabar no cambia nada.
  q.progress({ id: 'id-a', done: 5, total: 1000, state: 'run' }, 2100);
  assert.equal(q.get('id-a')!.state, 'done');
  // Reintentar: id nuevo, vuelve a la cola y arranca.
  const r = q.retry('id-c', 3000)!;
  assert.notEqual(r.id, 'id-c');
  assert.equal(r.state, 'queued');
  assert.equal(q.retry('id-a'), undefined);
  assert.deepEqual(q.startable(3000).map((x) => x.name), ['c']);
  q.clearFinished();
  assert.deepEqual(q.items.map((x) => x.name), ['c']);
});
