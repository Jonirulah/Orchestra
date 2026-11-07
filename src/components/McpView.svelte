<script lang="ts">
  // Vista MCP (capa a pantalla completa sobre los paneles, como Consumo): qué MCP tiene configurados cada cuenta (Claude,
  // Codex, opencode), «Probar», y añadir / aplicar a / quitar / igualar con vista previa (McpEditor) y «Deshacer».
  // Maquetación: barra + tabla (cabecera y totales FUERA del área con scroll; un solo scroll vertical, sin scroll
  // horizontal: las columnas se reparten el ancho) + panel lateral a toda la altura (detalle o editor; pie siempre visible).
  // Los resultados de las sondas viven en memoria; nunca se guarda nada. Un solo estado por aparición (`defStatus`).
  import { onDestroy, onMount } from 'svelte';
  import { app } from '../lib/store.svelte.ts';
  import { mcpmList, mcpmProbe, mcpmStamp, mcpmUndo, mcpmUndoInfo } from '../lib/backend.ts';
  import type { McpAccount, McpDef, McpUndoInfo } from '../lib/backend.ts';
  import { copyTargets, equalizeTargets, removeTargets, rowSource } from '../lib/mcpform.ts';
  import McpEditor from './McpEditor.svelte';
  import McpStateAction from './McpStateAction.svelte';
  import type { StateAction } from './McpStateAction.svelte';
  import type { EditorMode } from './McpEditor.svelte';
  import { columnIdentity, sidebarColumns, sidebarEntries } from '../lib/mcpcols.ts';
  import type { McpColumn } from '../lib/mcpcols.ts';
  import { buildMcpRows, canProbe, cellVersionLabel, columnMinWidth, tableLayout, windowFor, cellView, classifyProbeError, compactTokens, defStatus, diffDefs, diffPieces, wordPieces, probeKey, rowTokens, shouldProbe, thirdPartyPackage, totalBreakdown, variantOf, columnTotal } from '../lib/mcpmatrix.ts';
  import type { CellParts, Density, DiffPiece, McpRow, McpVariant, ProbeLike, StatusView } from '../lib/mcpmatrix.ts';
  import { displayName, providerLabel } from '../lib/model.ts';
  import { getLocale, t, tk, tn } from '../lib/i18n.ts';
  import Icon from './Icon.svelte';
  import { winPath } from '../lib/mcpcols.ts';
  import { agoParts, recallProbes } from '../lib/mcpprobememo.ts';

  /** Lo que leyó el backend; las columnas salen de la barra lateral (`cols`). */
  let raw = $state<McpAccount[]>([]);
  let loading = $state(false);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let results = $state<Record<string, ProbeLike | undefined>>({});
  /** Cuándo se probó cada cosa (para «probado hace X»). */
  let probedAt = $state<Record<string, number>>({});
  let nowTick = $state(Date.now());
  $effect(() => { const iv = setInterval(() => (nowTick = Date.now()), 30_000); return () => clearInterval(iv); });
  const ago = (at: number) => { const p = agoParts(nowTick - at); return tk(`mcp.view.ago.${p.unit}`, { n: p.n }); };
  /** Última prueba de toda la tabla (cabecera: «probado hace X»). */
  const lastProbe = $derived(Math.max(0, ...Object.values(probedAt)));
  let probing = $state<Record<string, boolean>>({});
  let selected = $state<string | null>(null);
  /** Tooltip propio (los `title` nativos tardan y no se ven con teclado). */
  let tip = $state<{ text: string; x: number; y: number; up: boolean } | null>(null);
  let editor = $state<EditorMode | null>(null);
  /** Acción sobre un estado malo (Aprobar / Encender / Apagar / Iniciar sesión), en el panel lateral. */
  let action = $state<StateAction | null>(null);
  let undoInfo = $state<McpUndoInfo | null>(null);
  let undoAsk = $state(false);
  let undoMsg = $state<{ ok: boolean; text: string } | null>(null);
  let legendOpen = $state(false);
  let moreOpen = $state(false);
  /** «Probar todos» / «Probar» de una cuenta: lo que espera turno (las sondas van de 3 en 3) sale como «en cola». */
  let queued = $state<Record<string, boolean>>({});

  // Carpetas de los paneles locales abiertos: su `.mcp.json` (ámbito project) entra en la tabla.
  const projects = $derived.by(() => {
    const out = new Set<string>();
    for (const w of app.workspaces) for (const p of w.panes) {
      if (p.kind === 'ssh') continue;
      const cwd = app.live[p.id]?.cwd ?? p.spec?.cwd;
      if (cwd) out.add(cwd);
    }
    return [...out].sort();
  });
  // Columnas = filas de cuenta de la barra lateral, mismo orden, siempre; sin datos → columna atenuada con el motivo.
  const cols = $derived<McpColumn[]>(sidebarColumns(raw,
    sidebarEntries(app.accounts, { sort: app.settings.accountsSort, group: app.settings.accountsGroup }, { quota: app.quota, now: app.nowSec }),
    (a) => app.profileOf(a)?.loggedIn ?? false)); // igual que la barra: sin perfil = «sin sesión iniciada»
  /** Las columnas con datos: las únicas que entran en copiar / quitar / igualar y en el formulario. */
  const accounts = $derived(cols.filter((c) => !c.unreadable));
  const rows = $derived(buildMcpRows(accounts));
  const sel = $derived(rows.find((r) => r.key === selected) ?? null);
  const anyBusy = $derived(Object.values(probing).some(Boolean));
  const probingCount = $derived(Object.values(probing).filter(Boolean).length);
  const panelOpen = $derived(!!editor || !!sel || !!action);
  /** La acción que arregla un estado malo de una definición (null si no tiene). Encender: Claude por carpeta de proyecto y
   *  opencode; Codex no tiene comando (la vista previa lo dice). */
  function fixOf(a: McpAccount, d: McpDef): StateAction['kind'] | null {
    const st = defStatus(d, results[probeKey(a.id, d)]).status;
    if (st === 'pending') return 'approve';
    if (st === 'auth') return 'login';
    if (st === 'off' && !d.managedBy) return 'on';
    return null;
  }
  function openAction(a: McpAccount, d: McpDef, kind: StateAction['kind']) {
    editor = null;
    selected = null;
    action = { kind, account: a, def: d };
    afterLayout(() => scrollToCol(a.id));
  }
  function mcpLogin(a: McpAccount, d: McpDef) {
    const acc = ident(a).accounts[0] ?? null;
    app.open({ kind: 'mcplogin', provider: a.provider, accountId: acc?.id ?? null, name: d.name, cwd: d.projectPath ?? undefined, hint: t('mcp.view.act.loginClaude', { name: d.name }) });
  }
  const lang = getLocale();
  const tok = (n: number) => compactTokens(n, lang);

  let stamp = '';
  let timer: number | undefined;
  async function load() {
    loading = true;
    loadError = null;
    try {
      const p = projects;
      const [list, st] = await Promise.all([mcpmList(p), mcpmStamp(p)]);
      raw = list;
      stamp = st;
      // Lo probado antes (también en otra apertura de la vista) vuelve si la definición no ha cambiado.
      const mem = recallProbes(app.mcpProbeMemo, list);
      for (const [k, r] of Object.entries(mem.results)) if (!results[k] && !probing[k]) { results[k] = r; probedAt[k] = mem.at[k]; }
      loaded = true;
      undoInfo = await mcpmUndoInfo().catch(() => null);
    } catch (e) {
      loadError = String(e);
    } finally {
      loading = false;
    }
  }
  async function reload(): Promise<McpAccount[]> {
    await load();
    return accounts;
  }
  function openEditor(m: EditorMode) {
    editor = m;
    action = null;
    undoMsg = null;
    hideTip();
  }
  function toggleRow(key: string, colId?: string) {
    if (editor) return;
    action = null;
    selected = selected === key ? null : key;
    hideTip();
    if (!selected) return;
    // Al abrir el detalle, la columna de la celda (o la primera que tiene el MCP) queda a la vista.
    const r = rows.find((x) => x.key === key);
    const id = colId ?? accounts.find((a) => r?.cells[a.id])?.id;
    if (id) afterLayout(() => scrollToCol(id));
  }
  async function undo() {
    if (!undoAsk) { undoAsk = true; return; }
    undoAsk = false;
    try {
      const u = await mcpmUndo();
      undoMsg = { ok: true, text: t('settings.mcp.edit.undone', { summary: undoText(u.summary) }) };
    } catch (e) {
      undoMsg = { ok: false, text: String(e) };
    }
    await load();
  }
  /** El resumen del registro de Deshacer viene del backend como «add brave-search»: se traduce. */
  function undoText(summary: string): string {
    const m = /^(add|copy|make equal|remove) (.+)$/.exec(summary);
    if (!m) return summary;
    const k = ({ add: 'add', copy: 'copy', 'make equal': 'equal', remove: 'remove' } as const)[m[1] as 'add' | 'copy' | 'make equal' | 'remove'];
    return tk(`mcp.view.undoKind.${k}`, { name: m[2] });
  }
  /** Sondeo ligero (mtime + tamaño de los ficheros leídos) mientras la vista está abierta. */
  async function poll() {
    if (loading || document.visibilityState !== 'visible') return;
    try {
      const st = await mcpmStamp(projects);
      if (stamp && st !== stamp) await load();
    } catch { /* el siguiente intento */ }
  }
  onMount(() => {
    void load();
    timer = window.setInterval(() => void poll(), 4000);
  });
  onDestroy(() => clearInterval(timer));

  function onWindowKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !app.mcpOpen) return;
    if ((e.target as HTMLElement)?.closest?.('.xterm')) return;
    if (app.settingsOpen || app.hostDialog || app.accountDialog || app.paletteOpen || app.hostKeyPrompt) return;
    e.preventDefault();
    if (legendOpen) legendOpen = false;
    else if (editor) editor = null;
    else if (selected) selected = null;
    else app.mcpOpen = false;
  }

  /** Columna = cuenta de la barra lateral: mismo nombre visible (traducido) y mismo punto de color (mcpcols.ts). */
  const ident = (a: McpAccount) => columnIdentity(a, app.accounts, { defaultAccount: t('settings.mcp.servers.defaultAccount'), opencodeGlobal: t('settings.mcp.servers.opencodeGlobal') });
  const colName = (a: McpAccount) => ident(a).name;
  const accSub = (a: McpAccount) => a.label ?? winPath(a.dir).replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~');
  function headTip(a: McpAccount): string {
    const id = ident(a);
    const l = [`${id.name} · ${id.tool}${a.isDefault && a.provider !== 'opencode' ? ` · ${t('settings.mcp.servers.defaultTag')}` : ''}`, accSub(a), t('settings.mcp.servers.fromFile', { file: a.source })];
    if (a.provider === 'opencode' && id.accounts.length) l.push(t('mcp.view.opencodeShared', { list: id.accounts.map((x) => displayName(x.name)).join(', ') }));
    if (!a.servers.length) l.push(t('mcp.view.noMcp'));
    if (a.error) l.push(`⚠ ${a.error}`);
    return l.join('\n');
  }

  async function probeOne(a: McpAccount, d: McpDef) {
    const k = probeKey(a.id, d);
    if (probing[k] || !canProbe(d)) return;
    probing[k] = true;
    queued[k] = false;
    try {
      results[k] = await mcpmProbe(a.id, d.scope, d.name, d.projectPath);
    } catch (e) {
      results[k] = { status: 'error', msg: String(e) };
    } finally {
      probing[k] = false;
    }
    probedAt[k] = Date.now();
    app.mcpProbeMemo[k] = { r: results[k]!, at: probedAt[k], fp: d.fingerprint };
  }
  async function probeCell(a: McpAccount, defs: McpDef[]) {
    await Promise.all(defs.filter(shouldProbe).map((d) => probeOne(a, d)));
  }
  /** «Probar» de una cuenta: de 3 en 3. Lo apagado y lo sin aprobar no se prueba: no entra en las sesiones. */
  async function probeColumn(a: McpAccount) {
    const queue = a.servers.filter(shouldProbe);
    for (const d of queue) queued[probeKey(a.id, d)] = true;
    const worker = async () => { for (let d = queue.shift(); d; d = queue.shift()) await probeOne(a, d); };
    await Promise.all([worker(), worker(), worker()]);
  }
  const columnBusy = (a: McpAccount) => a.servers.some((d) => probing[probeKey(a.id, d)]);
  async function probeAll() {
    await Promise.all(accounts.map((a) => probeColumn(a)));
  }
  async function probeNow(accountId: string, name: string): Promise<ProbeLike | null> {
    const a = accounts.find((x) => x.id === accountId);
    const d = a?.servers.find((x) => x.name === name && shouldProbe(x));
    if (!a || !d) return null;
    await probeOne(a, d);
    return results[probeKey(a.id, d)] ?? null;
  }

  function showTip(e: Event, text: string) {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const up = r.top > 220;
    tip = { text, x: Math.max(8, Math.min(r.left, window.innerWidth - 470)), y: up ? r.top - 6 : r.bottom + 6, up };
  }
  const hideTip = () => (tip = null);

  function errText(msg: string): string {
    const c = classifyProbeError(msg);
    if (c.kind === 'refused' && c.host) return t('settings.mcp.servers.err.refusedAt', { host: c.host });
    if (c.kind === 'exit' || c.kind === 'http') return tk(`settings.mcp.servers.err.${c.kind}`, { code: c.code ?? '' });
    return tk(`settings.mcp.servers.err.${c.kind}`);
  }
  function stateLong(v: StatusView): string {
    switch (v.status) {
      case 'ok': return t('settings.mcp.servers.st.ok', { n: v.tools ?? 0 });
      case 'failed': return `${t('settings.mcp.servers.st.failed')}: ${errText(v.msg ?? '')}`;
      default: return tk(`settings.mcp.servers.st.${v.status}`);
    }
  }
  /** Estado de una celda en dos piezas: icono (siempre) y texto (cae si no cabe). */
  function stParts(v: { status: StatusView['status'] | 'queued'; tools?: number }): { icon: string; text: string } {
    if (v.status === 'ok') return { icon: '✓', text: String(v.tools ?? 0) };
    const s = tk(`settings.mcp.servers.cell.${v.status}`);
    const i = s.indexOf(' ');
    return i < 0 ? { icon: s, text: '' } : { icon: s.slice(0, i), text: s.slice(i + 1) };
  }
  const toneOf = (s: string) => ({ ok: 'ok', failed: 'bad', auth: 'warn', timeout: 'warn' } as Record<string, string>)[s] ?? 'dim';
  /** Ámbitos de la leyenda: «global» (Codex / opencode) se llama y se pinta igual que «usuario» (una sola palabra). */
  const LEGEND_SCOPES = ['user', 'local', 'project', 'plugin', 'claudeai'] as const;
  const SCOPE_ICON: Record<McpDef['scope'], string> = { user: 'user', local: 'folder', project: 'box', global: 'user', plugin: 'puzzle', claudeai: 'cloud' };
  const tone = (v: StatusView) => toneOf(v.status);
  const abbr = (s: McpDef['scope']) => tk(`mcp.view.scopeAbbr.${s}`);
  function where(d: McpDef): string {
    const s = tk(`settings.mcp.servers.scope.${d.scope}`);
    return d.projectPath ? t('settings.mcp.servers.scopeAt', { scope: s, path: winPath(d.projectPath) }) : s;
  }
  function cellTitle(r: McpRow, a: McpAccount, defs: McpDef[]): string {
    const lines = [`${r.name} · ${colName(a)}`];
    for (const d of defs) {
      const v = r.variants.length > 1 ? variantOf(r, d) : undefined;
      lines.push([v ? t('settings.mcp.servers.vHead', { l: v.letter }) : '', where(d), stateLong(defStatus(d, results[probeKey(a.id, d)]))].filter(Boolean).join(' · '));
    }
    for (const d of defs) if (d.authStatus && d.authStatus !== 'unsupported') lines.push(`${t('settings.mcp.servers.dAuth')}: ${authLabel(d.authStatus)}`);
    if (defs.length > 1) lines.push(t('mcp.view.tot.multi', { name: r.name, n: defs.length }));
    const off = defs.flatMap((d) => d.disabledIn);
    if (off.length) lines.push(t('settings.mcp.servers.disabledIn', { paths: off.map(winPath).join(', ') }));
    return lines.join('\n');
  }
  /** Tooltip del total: qué suma, qué queda fuera y por qué; dos ámbitos en la misma cuenta. */
  function totalTip(a: McpAccount): string {
    const b = totalBreakdown(rows, a.id, results);
    const c = columnTotal(rows, a.id, results);
    const l: string[] = [colName(a)];
    l.push(b.counted.length ? t('mcp.view.tot.counted', { sum: tok(c.tokens), list: b.counted.map((x) => `${x.name} ${tok(x.tokens)}`).join(', ') }) : t('mcp.view.tot.none'));
    const why = ['untested', 'failed', 'auth', 'timeout', 'claudeai', 'off', 'pending'] as const;
    for (const w of why) {
      const names = b.out.filter((o) => o.why === w).map((o) => o.name);
      if (names.length) l.push(tk(`mcp.view.tot.out.${w}`, { list: names.join(', ') }));
    }
    for (const m of b.multi) l.push(t('mcp.view.tot.multi', { name: m.name, n: m.n }));
    if (c.partial) l.push(t('mcp.view.tot.partialWhy'));
    l.push(t('settings.mcp.servers.costTitle'));
    return l.join('\n');
  }
  const managedLabel = (d: McpDef) =>
    d.managedBy === 'claude.ai' ? t('settings.mcp.servers.managedClaudeAi') : t('settings.mcp.servers.managedPlugin', { plugin: (d.managedBy ?? '').replace(/^plugin:/, '') });
  const accountsOf = (v: McpVariant) => accounts.filter((a) => v.cells[a.id]);

  /** Estado de la sesión (OAuth) que da la herramienta, traducido si se conoce. */
  function authLabel(s: string | null): string {
    if (!s) return '';
    const k = ({ signedIn: 'signedIn', o_auth: 'signedIn', oauth: 'signedIn', not_logged_in: 'signedOut', notLoggedIn: 'signedOut', unsupported: 'unsupported', bearer_token: 'bearer' } as Record<string, string>)[s];
    return k ? tk(`mcp.view.auth.${k}`) : s;
  }
  /** Campos de una definición para el detalle (valor de texto; los secretos como •••). */
  function fieldsOf(d: McpDef): { label: string; value: string }[] {
    const f: [string, string][] = [
      [t('settings.mcp.servers.dTransport'), d.scope === 'claudeai' ? '' : d.transport + (d.rawKind && d.rawKind !== d.transport ? ` (${d.rawKind})` : '')],
      [t('settings.mcp.servers.dCommand'), d.command ? [d.command, ...d.args].join(' ') : ''],
      [t('settings.mcp.servers.dUrl'), d.url ?? ''],
      [t('settings.mcp.servers.dCwd'), d.cwd ?? ''],
      [t('settings.mcp.servers.dEnv'), d.envKeys.map((k) => `${k}=•••`).join(' ')],
      [t('settings.mcp.servers.dHeaders'), d.headerKeys.map((k) => `${k}: •••`).join(' ')],
      [t('settings.mcp.servers.dPassthrough'), d.envPassthrough.join(' ')],
      [t('settings.mcp.servers.dAuth'), authLabel(d.authStatus)],
      [t('settings.mcp.servers.dManaged'), d.managedBy ? managedLabel(d) : ''],
    ];
    return f.filter(([, v]) => v).map(([label, value]) => ({ label, value }));
  }
  /** Con qué versión se compara cada una para resaltar: la A con la B; las demás con la A. */
  const refOf = (r: McpRow, v: McpVariant) => (v === r.variants[0] ? r.variants[1] : r.variants[0]);
  function valueIn(d: McpDef, label: string): string {
    return fieldsOf(d).find((f) => f.label === label)?.value ?? '';
  }
  const onlyHidden = (r: McpRow) => r.variants.length > 1 && diffDefs(r.variants[0].def, r.variants[1].def).length === 1 && diffDefs(r.variants[0].def, r.variants[1].def)[0] === 'values';
  // ---- Anchos (v7): UNA densidad por tabla (mcpmatrix.tableLayout): normal (icono + palabra del ámbito) si caben todas
  // las columnas, compacta (solo icono del ámbito) si no, y si tampoco, las columnas que caben ENTERAS con flechas a
  // los lados. Sin scroll horizontal: nada se ve a medias ni pasa por debajo de la columna de nombres.
  let cv: HTMLCanvasElement | undefined;
  /** Ancho en px de un texto con la letra de la vista (12 px; `weight` 600 para lo resaltado), con un margen del 4 %. */
  function measure(s: string, px = 12, weight = 400): number {
    if (typeof document === 'undefined') return s.length * 7;
    cv ??= document.createElement('canvas');
    const ctx = cv.getContext('2d');
    if (!ctx) return s.length * 7;
    ctx.font = `${weight} ${px}px ${getComputedStyle(document.body).fontFamily}`;
    return Math.ceil(ctx.measureText(s).width * 1.04) + 1;
  }
  const m12 = (s: string) => measure(s, 12, 600);
  /** Estado de una celda (texto largo y corto, con icono) — lo mismo que se pinta. */
  function cellParts(r: McpRow, a: McpAccount, defs: McpDef[]): CellParts {
    const v = cellView(defs, a.id, results)!;
    const busy = defs.some((d) => probing[probeKey(a.id, d)]);
    const inQueue = !busy && defs.some((d) => queued[probeKey(a.id, d)]);
    const p = busy ? { icon: '', text: t('mcp.view.cell.probing') } : stParts(inQueue ? { status: 'queued' } : v);
    return { version: cellVersionLabel(r, defs), scope: defs.length > 1 ? tn('mcp.view.nScopes', defs.length) : abbr(defs[0].scope), status: p.text, statusIcon: !busy };
  }
  /** Ancho útil de la tabla (ResizeObserver). */
  let gridW = $state(0);
  /** Mínimo de cada columna en cada densidad: celda más ancha, cabecera (nombre, herramienta o motivo) y total. */
  const colMins = $derived.by(() => {
    const out: Record<Density, number[]> = { normal: [], compact: [] };
    for (const a of cols) {
      const id = ident(a);
      const cells = rows.flatMap((r) => (r.cells[a.id] ? [cellParts(r, a, r.cells[a.id])] : []));
      const c = columnTotal(rows, a.id, results);
      const foot = c.probed ? measure(`≈ ${tok(c.tokens)}`, 12, 600) + (c.partial ? measure(t('settings.mcp.servers.totalPartial'), 11.5) + 18 : 0) : measure(t('settings.mcp.servers.totalNoNumber'));
      const head = 9 + 6 + measure(id.name, 13, 600) + (a.error ? 16 : 0);
      // Subtítulo (herramienta, «sin MCP» o el motivo): siempre visible, la columna lo deja caber.
      const sub = a.unreadable ? measure(unreadableText(a), 11.5) : 21 + measure(a.servers.length ? id.tool : t('mcp.view.noMcp'), 11.5);
      const other = Math.max(head + 16, sub + 16, foot + 16, a.servers.length || a.unreadable ? 96 : 72);
      out.normal.push(columnMinWidth(cells, 'normal', m12, other));
      out.compact.push(columnMinWidth(cells, 'compact', m12, other));
    }
    return out;
  });
  /** Columna de nombres: el nombre más largo con su chip de versiones, o la línea de transporte y coste. */
  /** «Probar todos» no cambia de ancho al pasar a «Probando N…» (los botones de al lado no se mueven). */
  const probeBtnW = $derived(Math.max(measure(t('settings.mcp.servers.probeAll'), 13), measure(t('mcp.view.probingN', { n: 99 }), 13)) + 13 + 6 + 26);
  const nameMin = $derived(Math.min(320, Math.max(150, measure(t('settings.mcp.servers.colServer'), 11.5, 600) + 30,
    measure(t('settings.mcp.servers.totalLabel').toUpperCase(), 11.5, 600) * 1.08 + 20, ...rows.map((r) => Math.max(
    measure(r.name, 13, 600) + (r.variants.length > 1 ? measure(tn('mcp.view.versions', r.variants.length), 11) + 20 : 0),
    measure(`${r.managed ? 'plugin' : r.def.transport} · ${t('settings.mcp.servers.costRow', { n: tok(rowTokens(r, results) ?? 0) })}`, 11.5)) + 18))));
  // Columnas sin MCP (o sin datos) más estrechas; si ninguna tiene MCP, todas iguales (con fr < 1 en total la rejilla
  // no llenaría el ancho).
  const GUT = 28;
  let colStart = $state(0);
  const layout = $derived(tableLayout(gridW || 1e5, nameMin, colMins.normal, colMins.compact, colStart, GUT));
  const density = $derived(layout.density);
  /** Columnas que se ven (enteras). */
  const vcols = $derived(cols.slice(layout.start, layout.end));
  const moreL = $derived(layout.start > 0);
  const moreR = $derived(layout.end < cols.length);
  const gridCols = $derived.by(() => {
    const any = vcols.some((a) => a.servers.length);
    const W = colMins[density];
    const mid = vcols.map((a, i) => `minmax(${W[layout.start + i] ?? 96}px, ${a.servers.length || !any ? 1 : 0.4}fr)`).join(' ') || '1fr';
    return `${nameMin}px ${moreL ? `${GUT}px ` : ''}${mid}${moreR ? ` ${GUT}px` : ''}`;
  });
  /** Motivo de una columna sin datos («sin sesión: /login», «no se pudo leer»). */
  const unreadableText = (a: McpColumn) => (a.unreadable ? tk(`mcp.view.unreadable.${a.unreadable}`) : '');

  let grid = $state<HTMLDivElement | undefined>();
  let tblEl = $state<HTMLDivElement | undefined>();
  let tblH = $state(0);
  /** Pone a la vista (entera) la columna `id`. */
  function scrollToCol(id: string) {
    const idx = cols.findIndex((c) => c.id === id);
    if (idx < 0) return;
    colStart = windowFor(idx, layout, gridW || 1e5, nameMin, colMins.normal, colMins.compact, GUT);
  }
  /** Tras el próximo pintado (el panel lateral cambia el ancho de la tabla). */
  const afterLayout = (f: () => void) => requestAnimationFrame(() => requestAnimationFrame(f));
  /** Flechas: una columna a cada pulsación (la ventana siempre enseña columnas enteras). */
  const scrollBy = (dir: 1 | -1) => (colStart = dir > 0 ? Math.min(cols.length - 1, layout.start + 1) : Math.max(0, layout.start - 1));
  $effect(() => {
    if (!grid) return;
    const ro = new ResizeObserver(() => (gridW = grid!.clientWidth));
    ro.observe(grid);
    return () => ro.disconnect();
  });
  $effect(() => {
    if (!tblEl) return;
    const ro = new ResizeObserver(() => (tblH = tblEl!.clientHeight));
    ro.observe(tblEl);
    return () => ro.disconnect();
  });
  /** Alto de fila: 44 px, y hasta 56 si sobra alto (la tabla ocupa la altura en vez de dejar un hueco debajo). */
  const rowH = $derived(rows.length ? Math.max(44, Math.min(56, Math.floor((tblH - 20 - 48 - 38 - 34) / rows.length))) : 44);
  // Columna de la cuenta bajo el ratón en la barra lateral: resaltada y a la vista.
  const hoverCol = $derived.by(() => {
    const h = app.mcpHover;
    if (!h) return null;
    if (h === 'codex-launcher') return cols.find((c) => c.provider === 'codex' && c.isDefault && !ident(c).accounts.length)?.id ?? null;
    return cols.find((c) => ident(c).accounts.some((x) => x.id === h))?.id ?? null;
  });
  $effect(() => { const id = hoverCol; if (id) afterLayout(() => scrollToCol(id)); });
  // Panel abierto y la tabla ya no cabe en densidad normal: se pliega la barra lateral de la app (no se guarda en los
  // ajustes) y se vuelve a abrir al cerrar el panel o la vista.
  let foldChecked = false;
  $effect(() => {
    if (!panelOpen) { foldChecked = false; app.mcpFold = false; return; }
    if (foldChecked || !app.settings.sidebarOpen) return;
    foldChecked = true;
    afterLayout(() => { if (panelOpen && layout.density !== 'normal') app.mcpFold = true; });
  });
  $effect(() => () => (app.mcpFold = false));
</script>

<svelte:window onkeydown={onWindowKey} onpointerdown={(e) => { if (legendOpen && !(e.target as HTMLElement)?.closest?.('.legend, .lgbtn')) legendOpen = false; }} />

{#snippet toolIcon(p: McpAccount['provider'])}
  <span class="tool t-{p}" aria-hidden="true">{p === 'claude' ? '✳' : p === 'codex' ? '>_' : 'oc'}</span>
{/snippet}

{#snippet cmdWords(pieces: DiffPiece[])}
  <code class="cmd">{#each wordPieces(pieces) as w, i (i)}{#if i}{' '}{/if}<span class="w">{#each w as p, k (k)}{#if p.changed}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}</span>{/each}</code>
{/snippet}

{#snippet whereList(v: McpVariant)}
  <ul class="wh">
    {#each accountsOf(v) as a (a.id)}
      {#each v.cells[a.id] as x (probeKey(a.id, x))}
        {@const st = defStatus(x, results[probeKey(a.id, x)])}
        {@const fk = fixOf(a, x)}
        <li>
          <span>{@render toolIcon(a.provider)} <b>{colName(a)}</b> · {where(x)} · <span class={tone(st)}>{stateLong(st)}</span>{#if fk}{' '}<button class="btn tiny fixb" onclick={() => openAction(a, x, fk)}>{tk(`mcp.view.act.btn.${fk}`)}</button>{/if}</span>
          {#if st.status === 'failed' && st.msg}
            <details class="raw"><summary>{t('settings.mcp.servers.err.showDetail')}</summary><pre>{st.msg}</pre></details>
          {/if}
          {#if x.disabledIn.length}<span class="off">{t('settings.mcp.servers.disabledIn', { paths: x.disabledIn.map(winPath).join(', ') })}</span>{/if}
        </li>
      {/each}
    {/each}
  </ul>
{/snippet}

<section class="mv" aria-label={t('mcp.view.title')}>
  <header>
    <div class="ttl">
      <Icon name="layers" size={16} />
      <h2>{t('mcp.view.title')}</h2>
      <span class="subt">{t('mcp.view.subtitle')}</span>
    </div>
    <div class="ctl">
      {#if lastProbe && !anyBusy}<span class="ago" title={new Date(lastProbe).toLocaleString()}>{ago(lastProbe)}</span>{/if}
      <button class="btn primary" onclick={() => openEditor({ kind: 'add' })} disabled={!loaded || !!editor || !accounts.length}
        title={loaded && !accounts.length ? t('mcp.view.addNoAccounts') : editor ? t('mcp.view.addBusy') : undefined}>+ {t('settings.mcp.edit.addButton')}</button>
      <button class="btn" onclick={() => void probeAll()} disabled={!loaded || anyBusy || !accounts.some((a) => a.servers.some(shouldProbe))} style:min-width="{probeBtnW}px"
        title={loaded && !accounts.some((a) => a.servers.some(shouldProbe)) ? t('mcp.view.probeNone') : t('settings.mcp.servers.probeAllTitle')}>
        <span class:spin={anyBusy}><Icon name="refresh" size={13} /></span>{anyBusy ? t('mcp.view.probingN', { n: probingCount }) : t('settings.mcp.servers.probeAll')}
      </button>
      <span class="sec" class:open={moreOpen}>
        <button class="btn" onclick={() => void undo()} disabled={!undoInfo} title={undoInfo ? t('settings.mcp.edit.undoTitle', { summary: undoText(undoInfo.summary), files: undoInfo.files.join(', ') }) : t('settings.mcp.edit.undoNone')}>
          {undoAsk ? t('settings.mcp.edit.undoConfirm', { summary: undoText(undoInfo?.summary ?? '') }) : t('settings.mcp.edit.undo')}
        </button>
        <button class="btn" onclick={() => { moreOpen = false; void load(); }} disabled={loading} title={t('settings.mcp.servers.refreshAria')}>
          {loading ? t('settings.mcp.servers.reading') : t('settings.mcp.servers.refresh')}
        </button>
        <button class="btn ghost lgbtn" aria-expanded={legendOpen} onclick={() => { moreOpen = false; legendOpen = !legendOpen; }}>{t('settings.mcp.servers.legend.title')}</button>
      </span>
      <button class="iconbtn more" aria-label={t('mcp.view.more')} title={t('mcp.view.more')} aria-expanded={moreOpen} onclick={() => (moreOpen = !moreOpen)}><Icon name="more" size={14} /></button>
      <button class="iconbtn" title={t('mcp.view.close')} aria-label={t('mcp.view.close')} onclick={() => (app.mcpOpen = false)}><Icon name="x" size={14} /></button>
    </div>
  </header>
  {#if legendOpen}
    <!-- Leyenda: popover en 3 bloques (Estado / Ámbito / Versiones) con una celda de ejemplo; cada cosa una vez. -->
    <div class="legend" role="dialog" aria-label={t('settings.mcp.servers.legend.title')}>
      <div class="lgx">
        <span class="lgh">{t('mcp.view.legend.example')}</span>
        <span class="c lgcell"><span class="vl v0">A</span><span class="sc"><span class="si"><Icon name="layers" size={12} /></span><span class="sw">{tn('mcp.view.nScopes', 2)}</span></span><span class="st ok"><span class="sg">✓</span><span class="stt">26</span></span></span>
        <span class="lgnote">{t('mcp.view.legend.exampleText')}</span>
      </div>
      <div class="lgb">
        <span class="lgh">{t('settings.mcp.servers.legend.state')}</span>
        {#each ['ok', 'untested', 'failed', 'auth', 'timeout', 'off', 'pending', 'managed', 'queued'] as s (s)}
          {@const p = stParts({ status: s as StatusView['status'], tools: 14 })}
          <span class="lgi"><b class="sg {toneOf(s)}">{p.icon}</b><span>{s === 'ok' ? t('settings.mcp.servers.legend.ok') : p.text}</span></span>
        {/each}
      </div>
      <div class="lgb">
        <span class="lgh">{t('settings.mcp.servers.legend.scope')}</span>
        {#each LEGEND_SCOPES as s (s)}
          <span class="lgi"><Icon name={SCOPE_ICON[s]} size={12} /><b>{abbr(s)}</b><span class="lgs">{tk(`mcp.view.legend.scope.${s}`)}</span></span>
        {/each}
        <span class="lgi"><Icon name="layers" size={12} /><b>{tn('mcp.view.nScopes', 2)}</b><span class="lgs">{t('mcp.view.legend.scope.multi')}</span></span>
      </div>
      <div class="lgb">
        <span class="lgh">{t('mcp.view.legend.versions')}</span>
        <span class="lgi"><span class="vl v0">A</span><span class="vl v1">B</span><span>{t('settings.mcp.servers.legend.variants')}</span></span>
        <span class="lgi"><span class="vl vmix">A/B</span><span>{t('mcp.view.legend.mixed')}</span></span>
        <span class="lgi"><Icon name="refresh" size={12} /><span>{t('mcp.view.legend.probe')}</span></span>
      </div>
    </div>
  {/if}
  {#if loadError}<p class="s-msg err" role="alert">{loadError}</p>{/if}
  {#if undoMsg}<p class="s-msg {undoMsg.ok ? 'ok' : 'err'}" role="status">{undoMsg.text}</p>{/if}

  <div class="main" class:open={panelOpen}>
    <div class="tbl" bind:this={tblEl}>
      {#if loaded && !cols.length}
        <div class="empty-box" role="status">
          <b>{t('settings.mcp.servers.noAccounts')}</b>
          <span>{t('settings.mcp.servers.noAccountsHint')}</span>
        </div>
      {:else if loaded}
        <!-- Un solo scroll (los dos ejes): cabecera y totales fijos arriba/abajo, columna de nombres fija a la izquierda.
             Una columna por cuenta de la barra lateral (mismo orden), también sin MCP o sin datos. -->
        <div class="gwrap">
        <div class="grid" role="table" bind:this={grid} style:grid-template-columns={gridCols} style:--rh="{rowH}px" class:compact={density === 'compact'} style:grid-template-rows={`auto repeat(${rows.length || 1}, auto) auto`} onscroll={hideTip}>
          <div class="mx head" role="row">
            <span class="td nm hd" role="columnheader">{t('settings.mcp.servers.colServer')}</span>
            {#if moreL}<span class="td gut l"><button class="xhint l" aria-label={t('mcp.view.scrollLeft')} title={t('mcp.view.scrollLeft')} onclick={() => scrollBy(-1)}><Icon name="left" size={16} /></button></span>{/if}
            {#each vcols as a (a.id)}
              {@const id = ident(a)}
              <span class="td acc" class:slim={!a.servers.length} class:unr={!!a.unreadable} class:hl={hoverCol === a.id} data-col={a.id} role="columnheader" style:--cc={id.color ?? 'var(--faint)'}>
                <span class="ah" role="group" tabindex="-1" aria-label={headTip(a)} onmouseenter={(e) => showTip(e, headTip(a))} onmouseleave={hideTip}>
                  <span class="an"><span class="dot" style:background={id.color ?? 'var(--faint)'}></span><span class="anm">{id.name}</span>{#if a.error}<span class="warn" aria-label={t('settings.mcp.servers.accountError')}>⚠</span>{/if}</span>
                  <span class="as">{#if a.unreadable}<span>{unreadableText(a)}</span>{#if a.unreadable === 'unreadable'}<button class="retry" onclick={() => void load()} title={t('mcp.view.retryTitle')}>{t('mcp.view.retry')}</button>{/if}{:else if a.servers.length}{@render toolIcon(a.provider)}<span>{id.tool}</span>{:else}{@render toolIcon(a.provider)}<span>{t('mcp.view.noMcp')}</span>{/if}</span>
                </span>
                {#if a.servers.some(shouldProbe)}
                  <button class="ico hov" class:busy={columnBusy(a)} disabled={columnBusy(a)} onclick={() => void probeColumn(a)}
                    aria-label={t('settings.mcp.servers.probeColumnAria', { account: id.name })}
                    title={a.provider === 'codex' ? t('settings.mcp.servers.probeColumnCodexTitle') : t('settings.mcp.servers.probeColumnTitle')}>
                    <span class:spin={columnBusy(a)}><Icon name="refresh" size={13} /></span>
                  </button>
                {/if}
              </span>
            {/each}
            {#if moreR}<span class="td gut r"><button class="xhint r" aria-label={t('mcp.view.scrollRight')} title={t('mcp.view.scrollRight')} onclick={() => scrollBy(1)}><Icon name="right" size={16} /></button></span>{/if}
          </div>
          {#if !rows.length}
            <div class="mx" role="row">
              <span class="td emptyrow" role="cell">
                {#if !accounts.length}
                  <b>{t('mcp.view.noneReadable')}</b>
                  <span>{t('mcp.view.noneReadableHint')}</span>
                {:else}
                  <b>{t('settings.mcp.servers.noServers')}</b>
                  <span>{t('settings.mcp.servers.noServersHint')}</span>
                  <button class="btn primary" onclick={() => openEditor({ kind: 'add' })} disabled={!!editor}>+ {t('settings.mcp.edit.addButton')}</button>
                {/if}
              </span>
            </div>
          {/if}
          {#each rows as r (r.key)}
            {@const cost = rowTokens(r, results)}
            {@const v0 = r.variants[0]}
            {@const addTo = !r.managed && rowSource(v0, accounts) ? copyTargets(v0, rows, accounts) : []}
            <div class="mx row" class:sel={selected === r.key} class:managed={r.managed} role="row">
              <span class="td nm" role="rowheader">
                <button class="rowbtn" onclick={() => toggleRow(r.key)} aria-expanded={selected === r.key} disabled={!!editor}>
                  <span class="n">{r.name}</span>
                  {#if r.variants.length > 1}<span class="badge">{tn('mcp.view.versions', r.variants.length)}</span>{/if}
                </button>
                <span class="meta">{#if r.managed}{r.def.managedBy === 'claude.ai' ? 'claude.ai' : 'plugin'}{:else}{r.def.transport}{/if}{#if cost !== null}{' · '}<span class="cost">{t('settings.mcp.servers.costRow', { n: tok(cost) })}</span>{/if}</span>
              </span>
              {#if moreL}<span class="td gut l" aria-hidden="true"></span>{/if}
              {#each vcols as a (a.id)}
                {@const defs = a.unreadable ? undefined : r.cells[a.id]}
                {@const v = cellView(defs, a.id, results)}
                {@const busy = !!defs?.some((d) => probing[probeKey(a.id, d)])}
                {@const inQueue = !busy && !!defs?.some((d) => queued[probeKey(a.id, d)])}
                <span class="td cell" class:slim={!a.servers.length} class:unr={!!a.unreadable} class:hl={hoverCol === a.id} role="cell">
                  {#if defs && v}
                    {@const parts = cellParts(r, a, defs)}
                    <span class="c" class:multi={defs.length > 1} role="button" tabindex="0" aria-label={cellTitle(r, a, defs)} onclick={() => toggleRow(r.key, a.id)} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleRow(r.key, a.id); } }}
                      onmouseenter={(e) => showTip(e, cellTitle(r, a, defs))} onmouseleave={hideTip} onfocusin={(e) => showTip(e, cellTitle(r, a, defs))} onfocusout={hideTip}>
                      {#if parts.version}<span class="vl {parts.version.includes('/') ? 'vmix' : 'v' + (r.variants.findIndex((x) => x.letter === parts.version) % 4)}">{parts.version}</span>{/if}
                      <span class="sc" class:ext={defs.length === 1 && !!defs[0].managedBy}>
                        <span class="si"><Icon name={defs.length > 1 ? 'layers' : SCOPE_ICON[defs[0].scope]} size={12} /></span>{#if density === 'normal'}<span class="sw">{parts.scope}</span>{/if}
                      </span>
                      <span class="st {busy || inQueue ? 'dim' : tone(v)} s-{busy ? 'probing' : inQueue ? 'queued' : v.status}" aria-label={busy || inQueue ? parts.status : stateLong(v)}>
                        {#if busy}<span class="spinner" aria-hidden="true"></span>{:else}<span class="sg" aria-hidden="true">{stParts(inQueue ? { status: 'queued' } : v).icon}</span>{/if}<span class="stt">{parts.status}</span>
                      </span>
                    </span>
                    {@const fx = defs.map((d) => ({ d, k: fixOf(a, d) })).find((x) => x.k)}
                    {#if fx && fx.k && !busy}
                      {@const label = tk(`mcp.view.act.btn.${fx.k}`)}
                      <button class="ico hov fix" onclick={() => openAction(a, fx.d, fx.k!)} aria-label={t('mcp.view.act.cellAria', { action: label, name: r.name, account: colName(a) })}
                        onmouseenter={(e) => showTip(e, t('mcp.view.act.cellAria', { action: label, name: r.name, account: colName(a) }))} onmouseleave={hideTip}><Icon name={fx.k === 'login' ? 'key' : fx.k === 'approve' ? 'check' : 'plug'} size={12} /></button>
                    {:else if defs.some(shouldProbe) && !busy}
                      <button class="ico hov" onclick={() => void probeCell(a, defs)} aria-label={t('settings.mcp.servers.probeCellAria', { name: r.name, account: colName(a) })}><Icon name="refresh" size={12} /></button>
                    {/if}
                  {:else if a.unreadable}
                    <span class="c none" aria-label={unreadableText(a)}></span>
                  {:else}
                    <span class="c none">
                      <span class="dash" aria-label={t('settings.mcp.servers.cellNone')}>—</span>
                    </span>
                    {#if addTo.includes(a.id)}
                      <button class="ico hov" disabled={!!editor} onclick={() => openEditor({ kind: 'copy', row: v0, targets: [a.id], replace: false })}
                        aria-label={t('settings.mcp.servers.addHereAria', { name: r.name, account: colName(a) })}
                        onmouseenter={(e) => showTip(e, t('settings.mcp.servers.addHereAria', { name: r.name, account: colName(a) }))} onmouseleave={hideTip}><Icon name="plus" size={12} /></button>
                    {/if}
                  {/if}
                </span>
              {/each}
              {#if moreR}<span class="td gut r" aria-hidden="true"></span>{/if}
            </div>
          {/each}
          <!-- Totales justo debajo de la última fila (fijos abajo solo si la tabla es más alta que la vista). -->
          <div class="mx foot" role="row">
            <span class="td nm hd" role="rowheader">{t('settings.mcp.servers.totalLabel')}</span>
            {#if moreL}<span class="td gut l" aria-hidden="true"></span>{/if}
            {#each vcols as a (a.id)}
              {@const c = columnTotal(rows, a.id, results)}
              <span class="td cell" class:slim={!a.servers.length} class:unr={!!a.unreadable} class:hl={hoverCol === a.id} role="cell">
                <span class="c" role="group" tabindex="-1" onmouseenter={(e) => showTip(e, a.unreadable ? unreadableText(a) : totalTip(a))} onmouseleave={hideTip}>
                  {#if a.unreadable}
                    <span class="dash">{t('mcp.view.noData')}</span>
                  {:else if c.probed}
                    <span class="sum">≈ {tok(c.tokens)}</span>{#if c.partial}<span class="part">{t('settings.mcp.servers.totalPartial')}</span>{/if}
                  {:else if c.pending && !c.failed}
                    <span class="dash">{t('settings.mcp.servers.totalUntested')}</span>
                  {:else if c.failed || c.unmeasurable}
                    <span class="dash">{t('settings.mcp.servers.totalNoNumber')}</span>
                  {:else if !a.servers.length}
                    <span class="dash">{t('mcp.view.noMcp')}</span>
                  {:else}
                    <span class="dash">—</span>
                  {/if}
                </span>
              </span>
            {/each}
            {#if moreR}<span class="td gut r" aria-hidden="true"></span>{/if}
          </div>
        </div>
        </div>
        <p class="note">{t('settings.mcp.servers.footNote')}</p>
      {:else}
        <p class="empty"><span class="spinner" aria-hidden="true"></span>{t('settings.mcp.servers.reading')}</p>
      {/if}
    </div>
    {#if panelOpen}<button class="scrim" tabindex="-1" aria-label={t('mcp.view.panelClose')} onclick={() => { if (!editor) selected = null; }}></button>{/if}

    {#if action}
      <aside class="side wide" aria-label={t('mcp.view.panel')}>
        {#key action}
          <McpStateAction {action} {colName} toolName={ident(action.account).tool} {reload} onlogin={() => action && mcpLogin(action.account, action.def)} onclose={() => (action = null)} />
        {/key}
      </aside>
    {:else if editor}
      <aside class="side wide" aria-label={t('mcp.view.panel')}>
        {#key editor}
          <McpEditor mode={editor} {accounts} {rows} {colName} {reload} {projects} {probeNow} onclose={() => (editor = null)} onfocus={(id) => afterLayout(() => scrollToCol(id))} />
        {/key}
      </aside>
    {:else if sel}
      {@const multi = sel.variants.length > 1}
      <aside class="side" aria-label={t('mcp.view.panel')}>
        <header class="sh">
          <b class="sn">{sel.name}</b>
          {#if multi}<span class="badge">{tn('mcp.view.versions', sel.variants.length)}</span>{/if}
          <span class="grow"></span>
          <button class="iconbtn" aria-label={t('mcp.view.panelClose')} title={t('mcp.view.panelClose')} onclick={() => (selected = null)}><Icon name="x" size={14} /></button>
        </header>
        <div class="sbody">
          {#if multi}
            <p class="vintro">{onlyHidden(sel) ? t('mcp.view.versionsHidden') : t('mcp.view.versionsIntro')}</p>
            {#each sel.variants as v, vi (v.key)}
              {@const ref = refOf(sel, v)}
              {@const ct = copyTargets(v, rows, accounts)}
              {@const rt = removeTargets(v, accounts)}
              <div class="vcard">
                <div class="vh"><span class="vl v{vi % 4}">{v.letter}</span> <b>{t('settings.mcp.servers.vHead', { l: v.letter })}</b> <small>{accountsOf(v).map(colName).join(', ')}</small></div>
                <dl>
                  {#each fieldsOf(v.def) as f (f.label)}
                    {@const other = valueIn(ref.def, f.label)}
                    <dt class:diff={other !== f.value}>{f.label}</dt>
                    <dd>{@render cmdWords(diffPieces(f.value, other))}</dd>
                  {/each}
                  {#if onlyHidden(sel)}<dt class="diff">{t('settings.mcp.servers.dValues')}</dt><dd><mark>•••</mark></dd>{/if}
                  <dt>{t('settings.mcp.servers.dWhere')}</dt>
                  <dd>{@render whereList(v)}</dd>
                </dl>
                {#if !sel.managed && rowSource(v, accounts)}
                  <div class="rowacts">
                    <button class="btn tiny" disabled={!ct.length} title={ct.length ? undefined : t('mcp.view.copyNone')} onclick={() => openEditor({ kind: 'copy', row: v, targets: ct, replace: false })}>{t('mcp.view.copyVersion', { l: v.letter })}</button>
                    <button class="btn tiny" disabled={!rt.length} title={rt.length ? undefined : t('mcp.view.removeNone')} onclick={() => openEditor({ kind: 'remove', row: v, targets: rt })}>{t('mcp.view.removeVersion', { l: v.letter })}</button>
                  </div>
                {/if}
              </div>
            {/each}
          {:else}
            {@const sv = sel.variants[0]}
            {@const pkg = thirdPartyPackage(sv.def)}
            <dl>
              {#each fieldsOf(sv.def) as f (f.label)}
                <dt>{f.label}</dt><dd>{@render cmdWords([{ text: f.value, changed: false }])}</dd>
              {/each}
              <dt>{t('settings.mcp.servers.dWhere')}</dt>
              <dd>{@render whereList(sv)}</dd>
            </dl>
            {#if pkg}<p class="third" role="note">⚠ {t('settings.mcp.servers.thirdParty', { pkg })}</p>{/if}
            {#if sv.def.scope === 'claudeai'}<p class="note">{t('settings.mcp.servers.claudeAiNote')}</p>{/if}
          {/if}
        </div>
        {#if !sel.managed}
          <footer class="sfoot">
            {#if multi}
              {#each sel.variants as v (v.key)}
                {@const et = equalizeTargets(v, rows, accounts)}
                {#if rowSource(v, accounts)}
                  <button class="btn" disabled={!et.length} title={et.length ? t('mcp.view.equalizeToTitle', { l: v.letter, n: et.length }) : t('mcp.view.equalizeNone', { l: v.letter })} onclick={() => openEditor({ kind: 'copy', row: v, targets: et, replace: true })}>{t('mcp.view.equalizeTo', { l: v.letter })}</button>
                {/if}
              {/each}
            {:else if rowSource(sel.variants[0], accounts)}
              {@const sv = sel.variants[0]}
              {@const ct = copyTargets(sv, rows, accounts)}
              {@const rt = removeTargets(sv, accounts)}
              <button class="btn" disabled={!ct.length} title={ct.length ? undefined : t('mcp.view.copyNone')} onclick={() => openEditor({ kind: 'copy', row: sv, targets: ct, replace: false })}>{t('settings.mcp.edit.copyButton')}</button>
              <button class="btn" disabled={!rt.length} title={rt.length ? undefined : t('mcp.view.removeNone')} onclick={() => openEditor({ kind: 'remove', row: sv, targets: rt })}>{t('settings.mcp.edit.removeButton')}</button>
            {/if}
          </footer>
        {/if}
      </aside>
    {/if}
  </div>
</section>
{#if tip}<div class="tip" class:up={tip.up} role="tooltip" style="left: {tip.x}px; top: {tip.y}px">{tip.text}</div>{/if}

<style>
  .mv { --muted: #8b939e; position: absolute; inset: 0; z-index: 20; background: var(--bg); display: flex; flex-direction: column; min-height: 0; font-size: 13px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); flex-wrap: nowrap; }
  .ttl { display: flex; align-items: baseline; gap: 10px; color: var(--info); min-width: 0; overflow: hidden; }
  h2 { margin: 0; font-size: 15px; color: var(--text); font-weight: 600; }
  .subt { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ctl { display: flex; align-items: center; gap: 8px; flex: none; position: relative; }
  .sec { display: contents; }
  .more { display: none; }
  /* Estrecho: el subtítulo se va y las acciones secundarias pasan al menú «…» (todo en una línea, × incluida). */
  @media (max-width: 1700px) { .subt { display: none; } }
  @media (max-width: 1100px) {
    .more { display: inline-flex; }
    .sec { display: none; }
    .sec.open { display: grid; gap: 6px; position: absolute; top: calc(100% + 6px); right: 30px; z-index: 30; padding: 8px; background: var(--raise); border: 1px solid var(--border-strong); border-radius: 8px; box-shadow: 0 8px 22px rgba(0, 0, 0, 0.45); }
  }
  .ctl .btn { white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
  .legend { position: absolute; top: 52px; right: 16px; z-index: 30; display: grid; grid-template-columns: repeat(3, auto); gap: 10px 22px; padding: 12px 14px; max-width: calc(100% - 32px); background: var(--raise); border: 1px solid var(--border-strong); border-radius: 8px; box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5); color: var(--text); font-size: 12px; }
  .lgx { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .lgcell { padding: 3px 8px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg); }
  .lgnote, .lgs { color: var(--muted); }
  .lgb { display: grid; gap: 5px; align-content: start; }
  .lgi { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .legend .lgh { color: var(--muted); font-weight: 600; font-size: 11.5px; letter-spacing: 0.06em; text-transform: uppercase; }
  @media (max-width: 1100px) { .legend { grid-template-columns: repeat(2, auto); } }
  .s-msg { margin: 8px 16px 0; }
  .ok { color: var(--ok); }
  .bad { color: var(--bad); }
  .warn { color: var(--warn); }
  .dim { color: var(--muted); }

  /* Tabla + panel lateral a toda la altura. En ventanas estrechas el panel va encima de la tabla. */
  .main { flex: 1; min-height: 0; display: flex; position: relative; }
  .tbl { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; padding: 10px 16px 10px; container-type: inline-size; }
  .side { flex: none; width: clamp(400px, 32vw, 620px); border-left: 1px solid var(--border-strong); background: var(--panel); display: flex; flex-direction: column; min-height: 0; }
  .side.wide { width: clamp(460px, 40vw, 760px); }
  .scrim { display: none; }
  /* Ventana estrecha: el panel es una hoja superpuesta (con velo sobre la tabla), no una columna que la estruja. */
  @media (max-width: 1099px) {
    .side { position: absolute; top: 0; right: 0; bottom: 0; z-index: 5; box-shadow: -10px 0 24px rgba(0, 0, 0, 0.45); width: min(520px, calc(100% - 48px)); }
    .side.wide { width: min(620px, calc(100% - 48px)); }
    .scrim { display: block; position: absolute; inset: 0; z-index: 4; border: 0; padding: 0; border-radius: 0; background: rgba(0, 0, 0, 0.5); cursor: default; }
  }

  /* Tabla: UNA caja con scroll en los dos ejes. Las filas son `display: contents` (sus celdas son de la rejilla): la
     cabecera y los totales se quedan fijos arriba y abajo y la columna de nombres a la izquierda (position: sticky).
     Altura de fila fija y todo en una línea: si no cabe, primero cae la palabra del ámbito (queda su icono) y luego el
     texto del estado (queda su icono; el texto entero va en el aria-label y en el tooltip). */
  .gwrap { flex: 1 1 auto; min-height: 0; position: relative; display: flex; align-items: flex-start; }
  /* La tabla mide lo que sus filas (los totales van justo debajo de la última); con más filas que alto, scroll vertical
     con cabecera y totales fijos. Nunca scroll horizontal: las columnas que no caben se ocultan enteras. */
  .grid { flex: 1; min-width: 0; min-height: 0; max-height: 100%; overflow: hidden auto; display: grid; align-content: start; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); }
  /* Hueco de la flecha a cada lado con columnas ocultas: rayado tenue (hay más) y la flecha en la cabecera. */
  .td.gut { padding: 0; background: repeating-linear-gradient(90deg, var(--bg) 0 4px, color-mix(in srgb, var(--border) 45%, var(--bg)) 4px 5px); }
  .head > .td.gut { background: var(--panel); justify-content: center; }
  .foot > .td.gut { background: var(--panel); }
  .xhint { display: flex; align-items: center; justify-content: center; width: 24px; height: 32px; padding: 0; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--raise); color: var(--text); }
  .xhint:hover, .xhint:focus-visible { color: var(--accent); border-color: var(--accent); }
  .xhint:hover { color: var(--accent); }
    .td.emptyrow { grid-column: 1 / -1; height: auto; padding: 40px 16px; flex-direction: column; justify-content: center; gap: 8px; text-align: center; color: var(--muted); position: static; }
  .emptyrow b { color: var(--text); font-weight: 600; font-size: 14px; }
  /* Columna sin datos (sin sesión / no se pudo leer): rayada y con el motivo en la cabecera. */
  .td.unr { background: repeating-linear-gradient(135deg, var(--bg) 0 7px, color-mix(in srgb, var(--border) 55%, var(--bg)) 7px 8px); }
  .head > .td.unr { background: var(--panel); }
  .acc.unr .anm { color: var(--muted); }
  /* Columna de la cuenta bajo el ratón en la barra lateral. */
  .td.hl { background: color-mix(in srgb, var(--info) 9%, var(--bg)); }
  .head > .td.hl, .foot > .td.hl { background: color-mix(in srgb, var(--info) 8%, var(--panel)); }
  .acc.hl { box-shadow: inset 0 -3px 0 var(--cc); }
  .mx { display: contents; }
  .td { box-sizing: border-box; min-width: 0; height: var(--rh, 44px); padding: 0 8px; display: flex; align-items: center; border-bottom: 1px solid var(--border); background: var(--bg); position: relative; }
  /* Lo fijo es opaco y con sombra: al desplazar no se transparenta nada por debajo. */
  .head > .td { position: sticky; top: 0; z-index: 2; height: 48px; background: var(--panel); border-bottom-color: var(--border-strong); box-shadow: 0 3px 6px -2px rgba(0, 0, 0, 0.55); }
  .foot > .td { position: sticky; bottom: 0; z-index: 2; height: 38px; background: var(--panel); border-top: 1px solid var(--border-strong); border-bottom: 0; box-shadow: 0 -3px 6px -2px rgba(0, 0, 0, 0.55); }
  .td.nm { position: sticky; left: 0; z-index: 1; border-right: 1px solid var(--border); }
  .head > .td.nm, .foot > .td.nm { z-index: 3; }
  .row:hover > .td { background: color-mix(in srgb, var(--raise) 45%, var(--bg)); }
  .row.sel > .td { background: color-mix(in srgb, var(--info) 10%, var(--bg)); }
  .row.sel > .td.nm { box-shadow: inset 2px 0 0 var(--info); }
  .row.managed .n { color: var(--muted); }
  .hd { color: var(--muted); font-size: 11.5px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; }
  .acc { gap: 4px; container-type: inline-size; }
  .ah { display: grid; gap: 1px; min-width: 0; flex: 1; cursor: default; }
  .an { display: flex; align-items: center; gap: 6px; min-width: 0; font-weight: 600; white-space: nowrap; line-height: 18px; }
  .anm { overflow: hidden; text-overflow: ellipsis; }
  .as { display: flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11.5px; white-space: nowrap; line-height: 16px; min-width: 0; }
  .dot { flex: none; width: 9px; height: 9px; border-radius: 50%; }
  .tool { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 4px; font: 700 9.5px/1 'Cascadia Mono', Consolas, monospace; }
  .t-claude { background: color-mix(in srgb, #d97757 22%, transparent); color: #e8906f; font-size: 11px; }
  .t-codex { background: color-mix(in srgb, var(--text) 14%, transparent); color: var(--text); }
  .t-opencode { background: color-mix(in srgb, var(--info) 20%, transparent); color: var(--info); }
  .nm { flex-direction: column; align-items: stretch; justify-content: center; gap: 1px; }
  .rowbtn { display: flex; align-items: center; gap: 6px; color: var(--text); text-align: left; padding: 0; min-width: 0; white-space: nowrap; }
  .rowbtn:hover:not(:disabled) .n { text-decoration: underline; }
  .rowbtn:disabled { cursor: default; }
  .rowbtn .n { font-weight: 600; overflow: hidden; text-overflow: ellipsis; line-height: 18px; }
  .meta { color: var(--muted); font-size: 11.5px; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cost { white-space: nowrap; }
  .badge { flex: none; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 9px; background: var(--raise); color: var(--muted); border: 1px solid var(--border-strong); white-space: nowrap; }
  .cell { container-type: inline-size; }
  .c { display: inline-flex; align-items: center; gap: 6px; flex-wrap: nowrap; white-space: nowrap; min-width: 0; border-radius: 5px; outline-offset: 2px; }
  .c:focus-visible { outline: 2px solid var(--accent); }
  .sc { display: inline-flex; gap: 3px; align-items: center; color: var(--muted); font-size: 12px; line-height: 18px; }
  .sc.ext { font-style: italic; }
  .si { display: inline-flex; color: var(--muted); }
  .st { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; line-height: 18px; color: var(--muted); }
  .sg { font-weight: 700; min-width: 10px; text-align: center; }
  .st.ok { color: var(--ok); font-weight: 600; }
  .st.warn { color: var(--warn); font-weight: 600; }
  .st.bad { color: var(--bad); font-weight: 600; }
  /* Una sola línea siempre; qué cae si falta sitio lo decide cellFit (mcpmatrix): la palabra del ámbito y después el
     estado se abrevia. El estado nunca se queda solo en icono. */
  .vl { display: inline-block; font: 700 11px/16px 'Cascadia Mono', Consolas, monospace; min-width: 16px; text-align: center; border-radius: 4px; color: #10131a; }
  .vl.v0 { background: #6cb2ff; }
  .vl.v1 { background: #e08fd0; }
  .vl.v2 { background: #8fcf7a; }
  .vl.v3 { background: #f5b942; }
  .vl.vmix { background-color: #a6a0e8; background-image: linear-gradient(90deg, #6cb2ff 50%, #e08fd0 50%); padding: 0 3px; }
  .dash { color: var(--muted); }
  .ico { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border-radius: 5px; color: var(--muted); border: 1px solid transparent; flex: none; }
  .ico:hover:not(:disabled), .ico:focus-visible { color: var(--text); background: var(--raise); border-color: var(--border-strong); }
  .ico:disabled { opacity: 0.45; }
  .ico.fix { color: var(--warn); }
  .ago { color: var(--muted); font-size: 12px; white-space: nowrap; margin-right: 4px; }
  .retry { margin-left: 6px; padding: 0 6px; font-size: 11.5px; line-height: 16px; border-radius: 4px; border: 1px solid var(--border-strong); background: var(--raise); color: var(--text); }
  .fixb { margin-left: 6px; }
  /* Botón de la celda: encima del borde derecho (no ocupa sitio), visible con el ratón o el foco. */
  .ico.hov { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); opacity: 0; background: var(--panel); border-color: var(--border-strong); }
  .cell:hover .ico.hov, .ico.hov:focus-visible, .cell:focus-within .ico.hov, .acc:hover .ico.hov, .ico.hov.busy { opacity: 1; }
  .foot .sum { color: var(--text); font-weight: 600; }
  .foot .part { margin-left: 4px; font-size: 11.5px; color: var(--muted); border: 1px dashed var(--border-strong); border-radius: 9px; padding: 0 6px; cursor: help; }
  .note { color: var(--muted); font-size: 12px; margin: 8px 0 0; flex: none; }
  .empty { color: var(--muted); padding: 14px 8px; display: flex; align-items: center; gap: 8px; }
  .empty-box { flex: 1; display: grid; place-content: center; justify-items: center; text-align: center; gap: 8px; padding: 40px 16px; color: var(--muted); border: 1px dashed var(--border-strong); border-radius: var(--radius); }
  .empty-box b { color: var(--text); font-weight: 600; font-size: 14px; }

  /* Panel lateral: cabecera, cuerpo con scroll y pie (último hijo, nunca encima de nada). */
  .sh { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .sh .grow { flex: 1; }
  .sn { font-size: 14px; }
  .sbody { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px; display: grid; gap: 12px; align-content: start; }
  .sfoot { flex: none; display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; padding: 10px 14px; border-top: 1px solid var(--border); background: var(--panel); }
  .vintro { margin: 0; color: var(--muted); font-size: 12px; }
  .vcard { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; background: var(--bg); display: grid; gap: 8px; }
  .vh { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .vh small { color: var(--muted); font-size: 11.5px; }
  /* Etiqueta encima del valor: el comando tiene todo el ancho y no se parte dentro de una palabra. */
  dl { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; margin: 0; }
  dd + dt { margin-top: 6px; }
  dt { color: var(--muted); font-size: 12px; }
  dt.diff { color: var(--text); font-weight: 600; }
  dd { margin: 0; min-width: 0; }
  code.cmd { display: block; font: 12px/1.45 'Cascadia Mono', Consolas, monospace; color: var(--text); white-space: pre-wrap; overflow-wrap: break-word; user-select: text; }
  code.cmd .w { display: inline-block; max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; vertical-align: top; }
  mark { background: color-mix(in srgb, var(--warn) 30%, transparent); color: var(--text); border-radius: 3px; padding: 0 1px; box-shadow: inset 0 -1px 0 var(--warn); }
  .wh { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .wh li { display: grid; gap: 2px; overflow-wrap: anywhere; }
  .off { color: var(--muted); font-size: 12px; padding-left: 12px; }
  .raw summary { cursor: pointer; color: var(--muted); font-size: 12px; width: max-content; }
  .raw pre { margin: 4px 0 0; padding: 6px 8px; border-radius: 6px; background: var(--panel); border: 1px solid var(--border); white-space: pre-wrap; overflow-wrap: anywhere; font: 12px 'Cascadia Mono', Consolas, monospace; color: var(--muted); user-select: text; }
  .rowacts { display: flex; gap: 6px; flex-wrap: wrap; }
  .third { margin: 0; color: var(--warn); font-size: 12.5px; }
  .spinner { display: inline-block; width: 9px; height: 9px; margin-right: 5px; border: 2px solid var(--border-strong); border-top-color: var(--text); border-radius: 50%; animation: mxspin 0.8s linear infinite; }
  .spin { display: inline-flex; animation: mxspin 0.8s linear infinite; }
  @keyframes mxspin { to { transform: rotate(360deg); } }
  .tip { position: fixed; z-index: 1000; max-width: 460px; padding: 6px 9px; border-radius: 6px; background: var(--raise); border: 1px solid var(--border-strong); color: var(--text); font-size: 12px; line-height: 1.4; white-space: pre-line; overflow-wrap: break-word; pointer-events: none; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45); }
  .tip.up { transform: translateY(-100%); }
</style>
