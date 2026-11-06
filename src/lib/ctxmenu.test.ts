// Menú contextual: colocación en la ventana, navegación con teclado, elementos con confirmación y qué ofrece cada menú.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIRM_MS, activate, clampPosition, entryCount, firstEnabled, isMenuKey, keepsNativeMenu, moveActive, placeSubmenu, sep, shownLabel, tidy,
} from './ctxmenu.ts';
import type { MenuItem } from './ctxmenu.ts';
import { accountMenu, backgroundMenu, sidebarMenu, COLOR_KEYS } from './ctxitems.ts';
import type { AccountMenuCtx, BgMenuCtx } from './ctxitems.ts';
import { ACCOUNT_COLORS, PRESETS } from './model.ts';
import type { Account } from './model.ts';
import { setLocale } from './i18n.ts';

const it = (id: string, over: Partial<MenuItem> = {}): MenuItem => ({ id, label: id, ...over });
const acc = (over: Partial<Account> = {}): Account => ({ id: 'a1', name: 'Work', dir: 'C:\\Users\\me\\.claude-work', isDefault: false, color: ACCOUNT_COLORS[1], provider: 'claude', ...over });

// ---------- colocación ----------

test('clampPosition: si cabe, se queda donde se pidió', () => {
  assert.deepEqual(clampPosition(100, 120, 200, 150, 1000, 800), { x: 100, y: 120 });
});

test('clampPosition: pegado al borde derecho / inferior se desplaza hacia dentro con margen', () => {
  assert.deepEqual(clampPosition(950, 700, 200, 150, 1000, 800), { x: 1000 - 200 - 4, y: 800 - 150 - 4 });
  assert.deepEqual(clampPosition(999, 799, 200, 150, 1000, 800, 10), { x: 790, y: 640 });
});

test('clampPosition: coordenadas negativas y menú mayor que la ventana: gana arriba-izquierda', () => {
  assert.deepEqual(clampPosition(-50, -9, 200, 150, 1000, 800), { x: 4, y: 4 });
  assert.deepEqual(clampPosition(10, 10, 300, 900, 250, 700), { x: 4, y: 4 });
});

test('clampPosition: el resultado siempre queda dentro de la ventana (barrido)', () => {
  for (let x = -20; x <= 1100; x += 37) for (let y = -20; y <= 900; y += 41) {
    const p = clampPosition(x, y, 220, 310, 1000, 800);
    assert.ok(p.x >= 4 && p.x + 220 <= 996, `x=${x} -> ${p.x}`);
    assert.ok(p.y >= 4 && p.y + 310 <= 796, `y=${y} -> ${p.y}`);
  }
});

test('placeSubmenu: a la derecha de la fila; si no cabe, a la izquierda; siempre dentro', () => {
  const row = { left: 100, right: 300, top: 200, bottom: 224 };
  const a = placeSubmenu(row, 180, 120, 1000, 800);
  assert.equal(a.side, 'right');
  assert.equal(a.x, 296);
  const edge = { left: 700, right: 900, top: 200, bottom: 224 };
  const b = placeSubmenu(edge, 180, 120, 1000, 800);
  assert.equal(b.side, 'left');
  assert.ok(b.x + 180 <= 700 + 4);
  const low = placeSubmenu(row, 180, 300, 1000, 400);
  assert.ok(low.y + 300 <= 396);
  const narrow = placeSubmenu({ left: 10, right: 190, top: 0, bottom: 24 }, 180, 100, 250, 800);
  assert.ok(narrow.x >= 4 && narrow.x + 180 <= 246);
});

// ---------- teclado ----------

const list = [it('a'), sep('s'), it('b', { disabled: true }), it('c'), it('d', { disabled: true })];

test('moveActive: salta separadores y desactivados, y da la vuelta', () => {
  assert.equal(moveActive(list, -1, 'ArrowDown'), 0);
  assert.equal(moveActive(list, 0, 'ArrowDown'), 3);
  assert.equal(moveActive(list, 3, 'ArrowDown'), 0);
  assert.equal(moveActive(list, 0, 'ArrowUp'), 3);
  assert.equal(moveActive(list, -1, 'ArrowUp'), 3);
  assert.equal(moveActive(list, 3, 'ArrowUp'), 0);
});

test('moveActive: Home / End van al primero / último elegible; sin elegibles devuelve -1', () => {
  assert.equal(moveActive(list, 3, 'Home'), 0);
  assert.equal(moveActive(list, 0, 'End'), 3);
  const none = [it('x', { disabled: true }), sep()];
  assert.equal(moveActive(none, -1, 'ArrowDown'), -1);
  assert.equal(moveActive(none, -1, 'Home'), -1);
  assert.equal(moveActive(none, -1, 'End'), -1);
  assert.equal(firstEnabled(list), 0);
  assert.equal(firstEnabled(none), -1);
});

test('moveActive: una tecla que no es de navegación no mueve nada', () => {
  assert.equal(moveActive(list, 3, 'a'), 3);
});

test('isMenuKey: tecla Menú y Shift+F10, pero no F10 solo ni con Ctrl / Alt', () => {
  assert.ok(isMenuKey({ key: 'ContextMenu' }));
  assert.ok(isMenuKey({ key: 'F10', shiftKey: true }));
  assert.ok(!isMenuKey({ key: 'F10' }));
  assert.ok(!isMenuKey({ key: 'F10', shiftKey: true, ctrlKey: true }));
  assert.ok(!isMenuKey({ key: 'Enter' }));
});

// ---------- modelo de elementos ----------

test('activate: un desactivado o un separador no hacen nada y no tocan el armado', () => {
  assert.deepEqual(activate(it('x', { disabled: true }), 'y'), { kind: 'none', armed: 'y' });
  assert.deepEqual(activate(sep(), null), { kind: 'none', armed: null });
});

test('activate: elemento normal se ejecuta y desarma', () => {
  assert.deepEqual(activate(it('x'), 'otro'), { kind: 'run', armed: null });
});

test('activate: con submenú lo abre (no ejecuta)', () => {
  assert.equal(activate(it('x', { children: [it('c')] }), null).kind, 'sub');
});

test('activate: «confirm» necesita dos pulsaciones sobre el mismo elemento', () => {
  const del = it('del', { danger: true, confirm: 'Sure?' });
  const first = activate(del, null);
  assert.deepEqual(first, { kind: 'arm', armed: 'del' });
  assert.deepEqual(activate(del, first.armed), { kind: 'run', armed: null });
  // armado otro distinto: la primera pulsación de este vuelve a ser de armado
  assert.deepEqual(activate(del, 'otro'), { kind: 'arm', armed: 'del' });
  // tras el reinicio (armed = null) hay que volver a empezar
  assert.equal(activate(del, null).kind, 'arm');
  assert.ok(CONFIRM_MS >= 1500 && CONFIRM_MS <= 3000);
});

test('shownLabel: muestra el texto de confirmación solo con el elemento armado', () => {
  const del = it('del', { label: 'Remove', confirm: 'Click again' });
  assert.equal(shownLabel(del, null), 'Remove');
  assert.equal(shownLabel(del, 'del'), 'Click again');
  assert.equal(shownLabel(del, 'otro'), 'Remove');
  assert.equal(shownLabel(it('n', { label: 'N' }), 'n'), 'N');
});

test('tidy: quita separadores iniciales, finales y repetidos', () => {
  const out = tidy([sep('a'), it('x'), sep('b'), sep('c'), it('y'), sep('d')]);
  assert.deepEqual(out.map((i) => i.id), ['x', 'b', 'y']);
  assert.deepEqual(tidy([sep()]), []);
  assert.equal(entryCount([it('x'), sep(), it('y')]), 2);
});

test('keepsNativeMenu: campos de texto, editables y el terminal conservan su menú; el resto no', () => {
  assert.ok(keepsNativeMenu({ tagName: 'INPUT' }));
  assert.ok(keepsNativeMenu({ tagName: 'TEXTAREA' }));
  assert.ok(keepsNativeMenu({ tagName: 'DIV', isContentEditable: true }));
  assert.ok(keepsNativeMenu({ tagName: 'CANVAS', closest: (s) => (s === '.xterm' ? {} : null) }));
  assert.ok(!keepsNativeMenu({ tagName: 'BUTTON', closest: () => null }));
  assert.ok(!keepsNativeMenu(null));
});

// ---------- menú de cuenta ----------

function acctCtx(a: Account, over: Partial<AccountMenuCtx> = {}) {
  const calls: string[] = [];
  const ctx: AccountMenuCtx = {
    account: a, signedIn: true, checking: false,
    openTerminal: () => calls.push('open'), signIn: () => calls.push('signin'), check: () => calls.push('check'),
    rename: () => calls.push('rename'), setColor: (c) => calls.push(`color:${c}`), openFolder: () => calls.push('folder'),
    copyPath: () => calls.push('copy'), remove: () => calls.push('remove'), ...over,
  };
  return { ctx, calls };
}
const ids = (items: MenuItem[]) => items.filter((i) => !i.separator).map((i) => i.id);

test('menú de cuenta Claude: sin «comprobar sesión», con /login y todo lo demás', () => {
  setLocale('en');
  const m = accountMenu(acctCtx(acc()).ctx);
  assert.deepEqual(ids(m), ['open', 'signin', 'rename', 'color', 'folder', 'copy', 'remove']);
  assert.equal(m.find((i) => i.id === 'signin')?.hint, '/login');
});

test('menú de cuenta Codex / opencode: incluye «comprobar sesión»', () => {
  setLocale('en');
  for (const provider of ['codex', 'opencode'] as const) {
    const m = accountMenu(acctCtx(acc({ provider })).ctx);
    assert.deepEqual(ids(m), ['open', 'signin', 'check', 'rename', 'color', 'folder', 'copy', 'remove']);
    assert.equal(m.find((i) => i.id === 'check')?.disabled, false);
    assert.equal(m.find((i) => i.id === 'signin')?.hint, undefined);
  }
});

test('menú de cuenta: el atajo de «Rename» solo sale si quien llama lo indica', () => {
  setLocale('en');
  const plain = accountMenu(acctCtx(acc()).ctx).find((i) => i.id === 'rename');
  assert.equal(plain?.hint, undefined);
  const withHint = accountMenu(acctCtx(acc(), { renameHint: 'F2' }).ctx).find((i) => i.id === 'rename');
  assert.equal(withHint?.hint, 'F2');
});

test('menú de cuenta: la comprobación en marcha desactiva «check»; «sign in» cambia de texto según la sesión', () => {
  setLocale('en');
  const busy = accountMenu(acctCtx(acc({ provider: 'codex' }), { checking: true }).ctx);
  assert.equal(busy.find((i) => i.id === 'check')?.disabled, true);
  const out = accountMenu(acctCtx(acc(), { signedIn: false }).ctx);
  const inn = accountMenu(acctCtx(acc(), { signedIn: true }).ctx);
  assert.notEqual(out.find((i) => i.id === 'signin')?.label, inn.find((i) => i.id === 'signin')?.label);
});

test('menú de cuenta: «quitar» es rojo y pide confirmación; solo se ejecuta tras armar', () => {
  setLocale('en');
  const { ctx, calls } = acctCtx(acc());
  const rm = accountMenu(ctx).find((i) => i.id === 'remove')!;
  assert.ok(rm.danger && rm.confirm);
  let armed: string | null = null;
  const first = activate(rm, armed); armed = first.armed;
  assert.equal(first.kind, 'arm');
  assert.deepEqual(calls, []);
  const second = activate(rm, armed);
  if (second.kind === 'run') rm.run?.();
  assert.deepEqual(calls, ['remove']);
  // el resto de acciones no piden confirmación
  assert.ok(accountMenu(ctx).filter((i) => i.id !== 'remove').every((i) => !i.confirm));
});

test('menú de cuenta: el submenú de color tiene los 8 colores, marca el actual y su run aplica ese color', () => {
  setLocale('en');
  const a = acc({ color: ACCOUNT_COLORS[3] });
  const { ctx, calls } = acctCtx(a);
  const kids = accountMenu(ctx).find((i) => i.id === 'color')!.children!;
  assert.equal(kids.length, ACCOUNT_COLORS.length);
  assert.equal(COLOR_KEYS.length, ACCOUNT_COLORS.length);
  assert.deepEqual(kids.filter((k) => k.checked).map((k) => k.swatch), [ACCOUNT_COLORS[3]]);
  assert.ok(kids.every((k) => k.label && !k.label.startsWith('ctx.')));
  kids[5].run?.();
  assert.deepEqual(calls, [`color:${ACCOUNT_COLORS[5]}`]);
});

test('menú de cuenta en español: sin claves sin traducir', () => {
  setLocale('es');
  try {
    for (const provider of ['claude', 'codex'] as const) {
      const m = accountMenu(acctCtx(acc({ provider })).ctx);
      const all = m.flatMap((i) => [i, ...(i.children ?? [])]);
      assert.ok(all.every((i) => i.separator || !i.label.startsWith('ctx.')), 'clave sin traducir');
    }
  } finally { setLocale('en'); }
});

// ---------- menú del fondo ----------

function bgCtx(over: Partial<BgMenuCtx> = {}) {
  const calls: string[] = [];
  const ctx: BgMenuCtx = {
    accounts: [acc(), acc({ id: 'a2', provider: 'codex', name: 'Dev' })], hasShell: true, hasClaude: true, cols: 2, rows: 2,
    newTerminal: () => calls.push('term'), newSsh: () => calls.push('ssh'), newClaudeAuto: () => calls.push('auto'),
    openAccount: (a) => calls.push(`acc:${a.id}`), setLayout: (c, r) => calls.push(`layout:${c}x${r}`), equalize: () => calls.push('eq'), ...over,
  };
  return { ctx, calls };
}

test('menú del fondo: filas esperadas y como mucho 9 elegibles', () => {
  setLocale('en');
  const m = backgroundMenu(bgCtx().ctx);
  assert.deepEqual(ids(m), ['term', 'ssh', 'claude', 'accounts', 'layout', 'equalize']);
  assert.ok(entryCount(m) <= 9);
});

test('menú del fondo: submenú de cuentas = una entrada por cuenta; diseños = los PRESETS con el actual marcado', () => {
  setLocale('en');
  const { ctx, calls } = bgCtx();
  const m = backgroundMenu(ctx);
  const accs = m.find((i) => i.id === 'accounts')!.children!;
  assert.deepEqual(accs.map((a) => a.id), ['acc:a1', 'acc:a2']);
  accs[1].run?.();
  const lay = m.find((i) => i.id === 'layout')!.children!;
  assert.equal(lay.length, PRESETS.length);
  assert.deepEqual(lay.filter((l) => l.checked).map((l) => l.id), ['layout:2x2']);
  lay.find((l) => l.id === 'layout:3x2')!.run?.();
  assert.deepEqual(calls, ['acc:a2', 'layout:3x2']);
});

test('menú del fondo: sin terminal local / sin cuentas / sin Claude, esas filas quedan desactivadas', () => {
  setLocale('en');
  const m = backgroundMenu(bgCtx({ accounts: [], hasShell: false, hasClaude: false }).ctx);
  for (const id of ['term', 'claude', 'accounts']) assert.equal(m.find((i) => i.id === id)?.disabled, true, id);
  assert.equal(m.find((i) => i.id === 'ssh')?.disabled, undefined);
});

test('menú de la barra lateral: «importar» desactivado si no hay nada que importar', () => {
  setLocale('en');
  const base = { addAccount() {}, newHost() {}, importHosts() {}, settings() {} };
  const none = sidebarMenu({ ...base, importable: 0 });
  assert.equal(none.find((i) => i.id === 'import')?.disabled, true);
  const some = sidebarMenu({ ...base, importable: 3 });
  assert.equal(some.find((i) => i.id === 'import')?.disabled, false);
  assert.ok(some.find((i) => i.id === 'import')!.label.includes('3'));
});
