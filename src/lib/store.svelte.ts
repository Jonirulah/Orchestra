import * as be from './backend.ts';
import * as T from './terminals.ts';
import { decidePaste, pasteTarget } from './imagepaste.ts';
import { runDrop, runImagePaste } from './imagepasterun.ts';
import type { PasteIO } from './imagepasterun.ts';
import { compactKey, decideCompact, pushLog } from './autocompact.ts';
import type { CompactLogEntry } from './autocompact.ts';
import {
  ACCOUNT_COLORS, accountDir, accountTitle, claudeSpec, codexSpec, emptyHost, equalTracks, movePaneToCell, neighbor,
  newWorkspace, parseQuickConnect, placePane, reflow, removePane, resizeTracks, slug, sshAliasArgs,
  sshArgs, sshTarget, swapPanes, uid, restorableSpec,
  exportHosts, hostFromSshConfig, hostSecretKey, newConfigEntries, normalizeHost, sshInstallKeySpec, sshSpec,
  hostKeyAction, normalizeAccounts, providerOf, providerSpec,
  isSessionId, resumeCandidate, restoreSpecFor, sessionForSave, stripResume, trackSession,
} from './model.ts';
import type { Account, Dir, Host, Pane, Provider, Workspace } from './model.ts';
import { displayName, hostKeyBlockedMsg } from './model.ts';
import { fmtDuration, nextAlert, pickAccount } from './policy.ts';
import type { AccountPolicy, AlertState, Quota } from './policy.ts';
import { buildMcpSnapshot } from './mcpsync.ts';
import { checkable, shouldRefresh, toProviderEntry } from './providers.ts';
import type { ProviderEntry } from './providers.ts';
import { clampIntervalMin, queryTargets, toEntry } from './usageQuery.ts';
import type { QueryEntry, UsageResult } from './usageQuery.ts';
import { DEFAULTS, TERMINAL_KEYS, clampSettings, fontStack, hexAlpha, resetSection } from './settings.ts';
import type { SectionId, Settings } from './settings.ts';
import { cleanOverride } from './statusbar.ts';
import { playSound } from './sounds.ts';
import type { ItemId } from './statusbar.ts';
import { DEFAULT_THEME, MAX_CUSTOM_THEMES, hasTheme, resolveTheme } from './themes.ts';
import type { ThemeDef } from './themes.ts';
import { sanitizeCustomThemes, sanitizeName, withUniqueIds } from './themeimport.ts';
import { resolveLanguage, setLocale, t } from './i18n.ts';
import { SshConn } from './sshconn.ts';
import type { ConnState } from './sshconn.ts';
import { dotOf, separatorText, sshLook, veiled, worstDot } from './sshdrop.ts';
import type { SshLook } from './sshdrop.ts';
import { alertPlan, nextWaiting, paneOrder, trackWaiting } from './attention.ts';
import type { BackupState } from './backup.ts';
import * as SW from './savedws.ts';
import type { SavedWorkspace } from './savedws.ts';
import * as HV from './hostview.ts';

export type { Settings };

export interface LiveInfo {
  state: 'starting' | 'running' | 'exited';
  code?: number;
  title?: string;
  bell?: number;
  /** El proceso ya ha escrito algo (hasta entonces un panel SSH enseña «conectando…»). */
  output?: boolean;
  /** Cuándo se lanzó el proceso (ms), para el «sigue intentándolo…» del panel SSH. */
  startedAt?: number;
  /** Cuándo llegó la primera salida del proceso (ms): marca el comienzo de una sesión SSH «establecida» (reconexión automática). */
  firstOutputAt?: number;
  /** Carpeta actual que ha avisado la shell del panel (OSC 9;9 / OSC 7); alimenta la etiqueta de la rama git. */
  cwd?: string;
}

/** Diálogo de confirmación de huella SSH (ConfirmHostKey.svelte). */
export interface HostKeyPrompt {
  host: Host;
  /** 'checking' = consultando; 'confirm' = huellas a la vista; el resto = solo un mensaje y no se conecta. */
  phase: 'checking' | 'confirm' | 'error' | 'jump' | 'alias';
  probe?: be.HostKeyProbe;
  message?: string;
  /** Escribiendo en known_hosts. */
  busy?: boolean;
}

export type OpenReq =
  | { kind: 'shell'; id: string }
  | { kind: 'host'; id: string }
  | { kind: 'sshconfig'; alias: string }
  | { kind: 'claude'; accountId: string; resume?: boolean; cwd?: string }
  | { kind: 'codex' }
  /** Cuenta de Codex u opencode (o cualquiera): `login` = su inicio de sesión en vez del agente. */
  | { kind: 'account'; accountId: string; login?: boolean; cwd?: string }
  | { kind: 'quick'; text: string }
  | { kind: 'sshinstall'; hostId: string; pubPath: string };

class AppState {
  ready = $state(false);
  shells = $state<be.ShellProfile[]>([]);
  sshConfig = $state<be.SshConfigHost[]>([]);
  profiles = $state<be.ClaudeProfile[]>([]);
  hosts = $state<Host[]>([]);
  /** Todas las cuentas, de cualquier proveedor. Lo exclusivo de Claude (cuota, política, perfiles) usa `claudeAccounts`. */
  accounts = $state<Account[]>([]);
  /** Qué hay instalado de Codex / opencode (null = aún sin consultar). */
  providers = $state<be.ProviderDetect | null>(null);
  /** Sesión de cada cuenta de Codex / opencode, por id (solo veredicto; se refresca al abrir Ajustes → Cuentas o a demanda). */
  providerStatus = $state<Record<string, ProviderEntry>>({});
  /** Cuentas con una comprobación de sesión en curso. */
  statusChecking = $state<Record<string, boolean>>({});
  workspaces = $state<Workspace[]>([]);
  /** Espacios guardados con nombre (savedws.ts): se abren como pestañas nuevas. */
  savedWorkspaces = $state<SavedWorkspace[]>([]);
  activeId = $state('');
  settings = $state<Settings>({ ...DEFAULTS });
  live = $state<Record<string, LiveInfo>>({});
  /** Insignia de latencia y reconexión de los paneles SSH (la lógica está en sshconn.ts). */
  sshState = $state<ConnState>({ latency: {}, reconnecting: {}, flash: {}, down: {}, gaveUp: {} });
  readonly conn = new SshConn({
    // Demo del navegador con ?drop=N: la sesión «cuenta» como establecida antes de caerse y se rinde pronto (solo demo).
    settings: () => (be.demoDrop() ? { ...this.settings, ...be.demoDropSettings(this.settings) } : this.settings),
    hosts: () => this.hosts,
    sshConfig: () => this.sshConfig,
    pane: (id) => {
      const p = this.paneById(id);
      return p ? { pane: p, visible: !p.parked && this.active.panes.includes(p) } : undefined;
    },
    visiblePanes: () => this.active.panes.filter((p) => !p.parked),
    live: (id) => this.live[id],
    restart: (id, attempt) => this.restartNow(id, attempt ? t('attention.ssh.retryBanner', { n: attempt }) : undefined),
    reconnected: (id, at, downMs) => T.noteAbove(id, separatorText(at, downMs)),
    toast: (m) => this.toast(m),
    tailText: (id) => T.tailText(id),
    ping: (targets, timeoutSec) => be.netPing(targets, timeoutSec),
    pageVisible: () => typeof document === 'undefined' || !document.hidden,
    now: () => Date.now(),
    gaveUpText: (name, n) => t('store.toast.reconnectGaveUp', { name, n }),
  }, this.sshState);
  agents = $state<be.AgentInfo[]>([]);
  /** Visor de solo lectura de un subagente (panel del agente + id del subagente); null = cerrado. */
  subagentView = $state<{ paneId: string; subId: string } | null>(null);
  /** Cuota por cuenta (límites de 5 h / 7 d que guarda el envoltorio de statusline; vacía = sin datos). */
  quota = $state<Record<string, Quota>>({});
  /** Resultado de la última consulta de uso a Anthropic por cuenta (vacío = apagada o aún sin consultar). */
  usageStatus = $state<Record<string, QueryEntry>>({});
  /** «Ahora» en segundos, refrescado cada 30 s para que las cuentas atrás avancen sin volver a leer nada. */
  nowSec = $state(Math.floor(Date.now() / 1000));
  /** Ruta del `--settings` de Orchestra para los Claude nuevos (vacía = no capturar). */
  private usageSettings = $state('');
  /** Estado del servidor MCP local (null = aún sin consultar). */
  mcp = $state<be.McpInfo | null>(null);
  /** Comandos que un agente quiere ejecutar en hosts `ask`, a la espera de tu respuesta (el primero se muestra). */
  mcpApprovals = $state<be.McpApprovalReq[]>([]);
  private mcpTimer: number | undefined;
  private mcpLast = '';
  private quotaTimer: number | undefined;
  private quotaTicks = 0;
  private usageTimer: number | undefined;
  private usageBusy = false;
  private quotaAlerts = new Map<string, AlertState>();
  filter = $state('');
  paletteOpen = $state(false);
  hostDialog = $state<Host | null>(null);
  /** Huella SSH pendiente de confirmar (null = ninguna). */
  hostKeyPrompt = $state<HostKeyPrompt | null>(null);
  private hostKeyToken = 0;
  private hostKeyResolve: ((ok: boolean) => void) | null = null;
  accountDialog = $state(false);
  settingsOpen = $state(false);
  /** Sección abierta en Ajustes; vive aquí para sobrevivir al remontado que provoca cambiar de idioma. */
  settingsTab = $state<string>('general');
  /** Carpetas de cuenta que el usuario quitó de la lista: no se vuelven a añadir al escanear. */
  ignoredDirs = $state<string[]>([]);
  /** Temas de color importados por el usuario. Van aparte de `settings` para que «copiar ajustes» no los arrastre. */
  customThemes = $state<ThemeDef[]>([]);
  toastMsg = $state('');
  /** Auto-compact: últimos 20 compactados (solo en memoria). */
  compactLog = $state<CompactLogEntry[]>([]);
  private compactDone = new Set<string>();
  home = '';
  private saveTimer: number | undefined;
  private scanTimer: number | undefined;
  private toastTimer: number | undefined;

  get active(): Workspace {
    return this.workspaces.find((w) => w.id === this.activeId) ?? this.workspaces[0];
  }

  // ---------- arranque / persistencia ----------

  async init(): Promise<void> {
    const [shells, cfg, profiles, raw, home] = await Promise.all([
      be.detectShells(), be.sshConfigHosts(), be.claudeProfiles(), be.loadState(), be.homeDir(),
    ]);
    this.shells = shells;
    this.sshConfig = cfg;
    this.profiles = profiles;
    this.home = home;
    try {
      const st = raw ? JSON.parse(raw) : null;
      if (st?.workspaces?.length) {
        this.workspaces = st.workspaces;
        this.activeId = st.activeId ?? st.workspaces[0].id;
        this.hosts = Array.isArray(st.hosts) ? st.hosts.map(normalizeHost) : [];
        this.accounts = normalizeAccounts(st.accounts);
        this.settings = clampSettings(st.settings);
        this.ignoredDirs = Array.isArray(st.ignoredDirs) ? st.ignoredDirs.filter((d: unknown) => typeof d === 'string') : [];
        this.customThemes = sanitizeCustomThemes(st.customThemes);
      }
      this.savedWorkspaces = SW.normalizeSaved(st?.savedWorkspaces); // estados de antes: sin la clave = lista vacía
    } catch { /* estado corrupto: se arranca limpio */ }
    // Un tema propio que ya no se puede cargar: se vuelve al de serie sin avisar.
    if (!hasTheme(this.settings.theme, this.customThemes)) this.settings = { ...this.settings, theme: DEFAULT_THEME };
    this.applyLanguage(); // antes del primer render: sin parpadeo en inglés
    // Migración: los nombres por defecto en español guardados pasan a inglés.
    for (const a of this.accounts) if (a.isDefault && a.name === 'Principal') a.name = 'Main';
    for (const w of this.workspaces) if (w.name === 'Principal') w.name = 'Main';
    // Lista propia de la barra de estado por pestaña: se limpia como la global (desconocidos y repetidos fuera); sin lista = la global.
    for (const w of this.workspaces) { const own = cleanOverride(w.statusBarItems); if (own) w.statusBarItems = own; else delete w.statusBarItems; }
    // Los paneles SSH de un host de la bóveda se relanzan con el método de acceso actual del host.
    for (const w of this.workspaces) for (const p of w.panes) this.refreshSshSpec(p);
    this.syncAccounts();
    for (const d of be.demoProviderAccounts()) { // solo demo del navegador
      if (!this.accounts.some((a) => a.dir === d.dir)) this.accounts.push({ id: uid('acc'), name: d.name, dir: d.dir, isDefault: false, provider: d.provider, color: d.color });
    }
    await this.prepareUsage();
    await this.applyMcp();
    void be.onMcpApproval(
      (r) => { if (!this.mcpApprovals.some((x) => x.id === r.id)) this.mcpApprovals = [...this.mcpApprovals, r]; },
      (id) => { this.mcpApprovals = this.mcpApprovals.filter((x) => x.id !== id); },
    );
    await this.resumeSavedSessions();
    if (!this.workspaces.length) {
      const ws = newWorkspace('Main', 2, 2);
      this.workspaces = [ws];
      this.activeId = ws.id;
      const sh = shells[0];
      if (sh) this.placeNew(ws, this.shellPane(sh));
    }
    // Los procesos de una sesión anterior ya no existen: los paneles se relanzan al montarse.
    T.initTerminals(
      {
        onTitle: (id, t) => this.setLive(id, { title: t }),
        onState: (id, state, code) => {
          const was = this.live[id]?.state;
          this.setLive(id, { state, code });
          if (state === 'exited' && was !== 'exited') void this.conn.onExit(id, code); // SSH: ¿reconectar? (la salida llega a veces dos veces)
        },
        onBell: (id) => this.setLive(id, { bell: Date.now() }),
        onOutput: (id, seen) => {
          this.setLive(id, seen ? { output: true, firstOutputAt: Date.now() } : { output: false, state: 'starting', code: undefined, startedAt: Date.now(), firstOutputAt: undefined });
          if (seen) this.conn.outputSeen(id);
        },
        onShortcut: (ev) => this.handleShortcut(ev),
        onImagePaste: (id, clip) => this.imagePaste(id, clip),
        onDropUnavailable: () => this.toast(t('imagepaste.noDrop')),
        onCopy: (_id, r) => this.toast(!r.ok ? t('terminals.copy.failed', { error: r.error })
          : r.via === 'osc52' ? t('terminals.copy.doneApp', { n: r.chars })
          : r.chars === 1 ? t('terminals.copy.doneOne') : t('terminals.copy.done', { n: r.chars })),
        onShiftHint: () => this.toast(t('terminals.copy.shiftHint')),
        onCwd: (id, cwd) => { if (this.live[id]?.cwd !== cwd) this.setLive(id, { cwd }); },
        trackFolder: () => this.settings.gitTrackFolder,
      },
      this.termOptions(),
    );
    this.applyAppearance();
    void be.onFileDrop((id, paths) => this.fileDrop(id, paths));
    be.setCloseToTray(this.settings.closeToTray);
    window.addEventListener('beforeunload', () => { this.conn.shutdown(); this.persistNow(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void this.conn.tick(); });
    this.conn.arm();
    void this.detectProviders();
    void this.pollAgents();
    this.armScan();
    this.armQuota();
    this.armUsageQuery();
    this.syncMcp();
    this.ready = true;
  }

  // ---------- retomar las conversaciones de Claude al reabrir ----------

  /**
   * Los procesos de la sesión anterior ya no existen: cada panel de Claude se relanza al montarse. Con `restoreClaudeSessions`
   * encendido, el que recuerde su sesión (`lastSession`) se relanza con `claude --resume <id>` (su propia conversación, aunque
   * haya otro panel en la misma carpeta) siempre que la transcripción siga en disco; si no, Claude nuevo.
   */
  private async resumeSavedSessions(): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const w of this.workspaces) {
      for (const p of w.panes) {
        const acc = p.kind === 'agent' ? this.accountById(p.ref) : undefined;
        if (!acc || providerOf(acc) !== 'claude') continue;
        const setting = this.settings.restoreClaudeSessions;
        jobs.push((async () => {
          const id = resumeCandidate(p, setting, acc);
          let exists = false;
          if (id) { try { exists = await be.claudeSessionExists(acc.dir, id); } catch { /* sin comprobar = no se retoma */ } }
          const plan = restoreSpecFor(p, { setting, account: acc, exists });
          p.spec = plan.mode === 'resume'
            ? claudeSpec(acc, { cwd: p.spec.cwd, resumeId: plan.id, settingsPath: this.usageSettings || undefined, mcpConfig: this.mcpConfigPath })
            : stripResume(p.spec);
        })());
      }
    }
    await Promise.all(jobs);
  }

  /** Ids de panel en los que el último escaneo vio un Claude: si luego desaparece con el panel vivo, el usuario salió (/exit). */
  private claudeSeen = new Set<string>();

  /** Recuerda la sesión de cada panel de Claude y marca como cerrada la de los que el usuario terminó. */
  private trackSessions(found: be.AgentInfo[], runningIds: string[]): void {
    let changed = false;
    const alive = new Set<string>();
    for (const a of found) {
      if (a.agent !== 'claude') continue;
      alive.add(a.paneId);
      const pane = this.paneById(a.paneId);
      if (!pane) continue;
      this.claudeSeen.add(a.paneId);
      const next = trackSession(pane.lastSession, a);
      if (next) { pane.lastSession = next; changed = true; }
    }
    for (const id of [...this.claudeSeen]) {
      if (alive.has(id)) continue;
      this.claudeSeen.delete(id);
      if (!runningIds.includes(id)) continue; // el panel se está reiniciando o ya murió: no es una salida del usuario
      const pane = this.paneById(id);
      if (!pane?.lastSession || pane.lastSession.ended) continue;
      pane.lastSession = { ...pane.lastSession, ended: true };
      pane.spec = stripResume(pane.spec); // «Reiniciar» tras salir empieza una conversación nueva
      changed = true;
    }
    if (changed) this.persist();
  }

  // ---------- límites de uso (cuotas) ----------

  /** Deja listo el envoltorio de statusline y recuerda la ruta de `--settings` (vacía si está apagado o falla). */
  private async prepareUsage(): Promise<void> {
    this.usageSettings = this.settings.captureUsage ? (await be.quotaPrepare()) ?? '' : '';
  }

  /** Lee las cuotas guardadas cada 5 s y avanza el reloj de las cuentas atrás cada 30 s. */
  armQuota(): void {
    window.clearInterval(this.quotaTimer);
    void this.pollQuota();
    this.quotaTimer = window.setInterval(() => {
      if (++this.quotaTicks % 6 === 0) this.nowSec = Math.floor(Date.now() / 1000);
      void this.pollQuota();
    }, 5000);
  }

  async pollQuota(): Promise<void> {
    try {
      const list = await be.quotaRead(this.claudeAccounts.map((a) => ({ id: a.id, dir: a.dir })));
      const next: Record<string, Quota> = {};
      for (const e of list) {
        if (this.accountById(e.accountId)) next[e.accountId] = { fiveHour: e.fiveHour, sevenDay: e.sevenDay, at: e.at, limits: e.limits };
      }
      if (JSON.stringify(next) !== JSON.stringify($state.snapshot(this.quota))) this.quota = next;
      this.checkQuotaAlerts();
    } catch { /* sin datos: las barras no se muestran */ }
  }

  /** Aviso (una vez) cuando una cuenta cruza el 80 % y el 95 % de su ventana de 5 h. */
  private checkQuotaAlerts(): void {
    if (!this.settings.notifyQuota) return;
    const now = Math.floor(Date.now() / 1000);
    for (const acc of this.claudeAccounts) {
      const w = this.quota[acc.id]?.fiveHour;
      if (!w) continue;
      const r = nextAlert(this.quotaAlerts.get(acc.id), w, now);
      this.quotaAlerts.set(acc.id, r.state);
      if (r.fire) this.toast(t('store.toast.quotaUsed', { name: displayName(acc.name), pct: r.fire, time: fmtDuration(w.resetsAt - now) }));
    }
  }

  // ---------- consulta de uso a Anthropic (opcional; ver docs/SECURITY.md) ----------

  /** Cuentas con sesión iniciada: solo ellas se consultan. */
  private usageTargets(only?: string): { id: string; dir: string }[] {
    return queryTargets(this.claudeAccounts.filter((a) => !only || a.id === only), (a) => !!this.profileOf(a)?.loggedIn);
  }

  /** Enciende o apaga el sondeo según `usageQuery` / `usageQueryMin`: una consulta al encender y luego cada N minutos. */
  armUsageQuery(): void {
    window.clearInterval(this.usageTimer);
    this.usageTimer = undefined;
    if (!this.settings.usageQuery) {
      this.usageStatus = {};
      return;
    }
    void this.runUsageQuery();
    this.usageTimer = window.setInterval(() => void this.runUsageQuery(), clampIntervalMin(this.settings.usageQueryMin) * 60_000);
  }

  /** Una pasada de consulta (todas las cuentas, o solo `only`). Devuelve los resultados; nunca lanza. */
  async runUsageQuery(only?: string): Promise<UsageResult[]> {
    if (!this.settings.usageQuery || (!only && this.usageBusy)) return [];
    const targets = this.usageTargets(only);
    if (!targets.length) return [];
    if (!only) this.usageBusy = true;
    try {
      const list = await be.usageFetch(targets, clampIntervalMin(this.settings.usageQueryMin));
      const now = Math.floor(Date.now() / 1000);
      const next = { ...$state.snapshot(this.usageStatus) };
      for (const r of list) if (this.accountById(r.accountId)) next[r.accountId] = toEntry(r, now);
      this.usageStatus = next;
      await this.pollQuota(); // los porcentajes nuevos ya están en quota/<cuenta>.json
      return list;
    } catch {
      return [];
    } finally {
      if (!only) this.usageBusy = false;
    }
  }

  /** «Probar ahora» de una cuenta (solo con la consulta encendida). */
  testUsage(accountId: string): Promise<UsageResult[]> {
    return this.runUsageQuery(accountId);
  }

  persist(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.persistNow(), 400);
    this.syncMcp();
  }

  persistNow(): void {
    const data = $state.snapshot({
      version: 1, workspaces: this.workspaces, activeId: this.activeId,
      hosts: this.hosts, accounts: this.accounts, settings: this.settings, ignoredDirs: this.ignoredDirs,
      customThemes: this.customThemes, savedWorkspaces: this.savedWorkspaces,
    });
    // Un panel de «Sign in» no debe repetir el login al restaurarse.
    data.workspaces = data.workspaces.map((w) => ({ ...w, panes: w.panes.map((p) => ({ ...p, spec: restorableSpec(p.spec), ...(p.lastSession ? { lastSession: sessionForSave(p.lastSession, this.live[p.id]) } : {}) })) }));
    void be.saveState(JSON.stringify(data));
  }

  toast(msg: string): void {
    this.toastMsg = msg;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastMsg = ''), 3500);
  }

  setLive(id: string, patch: Partial<LiveInfo>): void {
    const cur: LiveInfo = this.live[id] ?? { state: 'starting' };
    this.live[id] = { ...cur, ...patch };
    if (patch.state) this.syncMcp();
  }

  // ---------- agentes en ejecución ----------

  agentOf(paneId: string): be.AgentInfo | undefined {
    return this.agents.find((a) => a.paneId === paneId);
  }

  private prevStatus = new Map<string, string>();
  /** Desde cuándo espera cada agente (id de panel → ms), para el bloque «Necesitan atención». */
  waitSince = $state<Record<string, number>>({});

  private polling = false;

  /** (Re)arma el temporizador del escaneo con el intervalo de los ajustes. */
  armScan(): void {
    window.clearInterval(this.scanTimer);
    this.scanTimer = window.setInterval(() => void this.pollAgents(), this.settings.scanIntervalSec * 1000);
  }

  async pollAgents(): Promise<void> {
    if (this.polling) return; // un escaneo lento no debe apilarse con el siguiente
    this.polling = true;
    try { await this.pollOnce(); } finally { this.polling = false; }
  }

  private async pollOnce(): Promise<void> {
    const ids = this.workspaces.flatMap((w) => w.panes.map((p) => p.id)).filter((id) => this.live[id]?.state === 'running');
    if (!ids.length) { this.agents = []; this.subagentView = null; this.waitSince = {}; return; }
    try {
      const found = await be.agentScan(ids, this.claudeAccounts.map((a) => a.dir));
      let needsYou = false, finished = false;
      let firstWaiting: be.AgentInfo | undefined;
      for (const a of found) {
        const was = this.prevStatus.get(a.paneId);
        const pane = this.paneById(a.paneId);
        const name = pane?.title ?? t('store.agentFallback');
        if (was && was !== a.status) {
          if (a.status === 'waiting') { needsYou = true; firstWaiting ??= a; if (this.settings.notifyPermission) this.toast(t('store.toast.needsPermission', { name })); }
          else if (was === 'busy' && a.status === 'idle') { finished = true; if (this.settings.notifyDone) this.toast(t('store.toast.finished', { name })); }
        }
        this.prevStatus.set(a.paneId, a.status);
      }
      // Un solo sonido por escaneo (pedir permiso gana a terminar); el anti-spam de sounds.ts limita a uno cada 1,5 s.
      const snd = needsYou ? this.settings.soundAttention : finished ? this.settings.soundDone : 'none';
      if (snd !== 'none') playSound(snd, this.settings.soundVolume / 100);
      if (firstWaiting) this.alertOutside(firstWaiting);
      this.agents = found;
      this.waitSince = trackWaiting(this.waitSince, found.filter((a) => a.status === 'waiting').map((a) => a.paneId), Date.now()).since;
      // El visor de un subagente se cierra si su agente ya no existe.
      if (this.subagentView && !found.some((a) => a.paneId === this.subagentView!.paneId)) this.subagentView = null;
      this.trackSessions(found, ids);
      await this.autoCompactCheck(found);
    } catch { /* el escáner falla en silencio: no debe tumbar la interfaz */ }
  }

  /** Escribe `/compact` en los agentes Claude ociosos con la caché aún caliente mientras el usuario está ausente. */
  private async autoCompactCheck(found: be.AgentInfo[]): Promise<void> {
    const s = this.settings;
    if (!s.autoCompact) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const input = (a: be.AgentInfo, userIdleSec: number | null) => ({
      enabled: s.autoCompact, agent: a, nowSec, userIdleSec, ctxK: s.autoCompactCtxK,
      afterMin: s.autoCompactAfterMin, userIdleMin: s.autoCompactUserIdleMin, done: this.compactDone,
    });
    const cands = found.filter((a) => decideCompact(input(a, null)).reason === 'needs-idle-check');
    if (!cands.length) return;
    const idle = await be.systemIdleSeconds(); // una sola consulta por escaneo
    for (const a of cands) {
      if (!decideCompact(input(a, idle)).compact) continue;
      this.compactDone.add(compactKey(a));
      be.ptyWrite(a.paneId, '/compact\r');
      const title = this.paneById(a.paneId)?.title ?? a.title ?? t('store.agentFallback');
      this.compactLog = pushLog(this.compactLog, { at: Date.now(), title, ctxTokens: a.ctxTokens });
      this.toast(t('store.toast.compacted', { title }));
    }
  }

  /** Un agente acaba de pasar a esperar: si la ventana no está delante, parpadea en la barra de tareas y (si el ajuste
   *  de avisos de permiso está encendido) notificación de Windows. Nunca lanza. */
  private alertOutside(a: be.AgentInfo): void {
    const focused = typeof document === 'undefined' || document.hasFocus();
    const plan = alertPlan(focused, this.settings.notifyPermission);
    if (plan.flash) void be.requestAttention();
    if (plan.notify) {
      const name = this.paneById(a.paneId)?.title ?? t('store.agentFallback');
      const what = (a.waitingFor ?? '').trim();
      void be.notify(t('attention.notify.title', { name }), what ? t('attention.notify.body', { what }) : t('attention.notify.bodyGeneric'));
    }
  }

  /** Aspecto de la caída SSH de un panel (sshdrop.ts). */
  sshLookOf(p: Pane): SshLook {
    const st = this.sshState;
    return sshLook({ kind: p.kind, state: this.live[p.id]?.state, reconnecting: st.reconnecting[p.id], down: st.down[p.id], gaveUp: st.gaveUp[p.id] });
  }
  sshDotOf(p: Pane): 'amber' | 'red' | null { return dotOf(this.sshLookOf(p), !!this.sshState.down[p.id]); }
  sshVeiled(p: Pane): boolean { return veiled(this.sshLookOf(p), !!this.sshState.down[p.id]); }

  /** Punto de caída de un host en la barra lateral: lo peor de sus paneles SSH abiertos (ref = id del host o «cfg:alias»). */
  hostDot(ref: string): 'amber' | 'red' | null {
    return worstDot(this.workspaces.flatMap((w) => w.panes.filter((p) => p.kind === 'ssh' && p.ref === ref).map((p) => this.sshDotOf(p))));
  }

  /** Paneles con un agente esperando respuesta. */
  get waitingIds(): Set<string> {
    return new Set(this.agents.filter((a) => a.status === 'waiting').map((a) => a.paneId));
  }

  /** Ctrl+Shift+A: al siguiente agente que espera (rotando, cambiando de pestaña y sacándolo de segundo plano). */
  jumpToWaiting(): void {
    const id = nextWaiting(paneOrder(this.workspaces), this.waitingIds, this.active?.focusId);
    if (!id) { this.toast(t('attention.none')); return; }
    this.focusPane(id);
  }

  /** Salida del pegado de imágenes: atajo crudo al PTY, texto por xterm y avisos. */
  private pasteIO: PasteIO = {
    write: (id, data) => be.ptyWrite(id, data),
    paste: (id, text) => { T.paste(id, text); T.focus(id); },
    toast: (m) => this.toast(m),
  };

  /** Pegado sin texto en un panel: si toca imagen (ver imagepaste.ts) la gestiona y devuelve true; si no, xterm sigue. */
  imagePaste(id: string, clip: { hasText: boolean; hasImage?: boolean }): boolean {
    const p = this.paneById(id);
    if (!p) return false;
    const target = pasteTarget(p, this.accounts, this.hosts);
    const act = decidePaste(target, clip, this.settings.pasteImages);
    if (act === 'text') return false;
    void runImagePaste(this.pasteIO, id, target, act);
    return true;
  }

  /** Archivos soltados en un panel desde el Explorador (evento de Rust con las rutas reales). */
  private fileDrop(id: string, paths: string[]): void {
    const p = this.paneById(id);
    if (!p) return;
    void runDrop(this.pasteIO, id, pasteTarget(p, this.accounts, this.hosts), paths);
  }

  paneById(id: string): Pane | undefined {
    for (const w of this.workspaces) { const p = w.panes.find((x) => x.id === id); if (p) return p; }
    return undefined;
  }

  /** Lleva el foco a un panel aunque esté en otro espacio de trabajo o en segundo plano. */
  focusPane(id: string): void {
    const ws = this.workspaces.find((w) => w.panes.some((p) => p.id === id));
    if (!ws) return;
    if (this.activeId !== ws.id) this.switchWorkspace(ws.id);
    const p = ws.panes.find((x) => x.id === id)!;
    if (p.parked) this.unpark(id);
    if (ws.maximizedId && ws.maximizedId !== id) ws.maximizedId = undefined;
    ws.focusId = id;
    window.setTimeout(() => T.focus(id), 80);
  }

  // ---------- cuentas de Claude ----------

  /** Asegura una cuenta por cada carpeta ~/.claude* detectada (sin duplicar las ya guardadas). */
  private syncAccounts(): void {
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    for (const pr of this.profiles) {
      if (this.claudeAccounts.some((a) => norm(a.dir) === norm(pr.dir))) continue;
      if (this.ignoredDirs.some((d) => norm(d) === norm(pr.dir))) continue;
      const base = pr.dir.replace(/\\/g, '/').split('/').pop() ?? 'claude';
      const name = pr.isDefault ? 'Main' : base.replace(/^\.claude-?/, '') || base;
      this.accounts.push({
        id: uid('acc'), name, dir: pr.dir, isDefault: pr.isDefault, provider: 'claude',
        color: ACCOUNT_COLORS[this.accounts.length % ACCOUNT_COLORS.length],
      });
    }
  }

  /** Cuentas de Claude: las únicas con perfil, cuota, consulta de uso y política automática. */
  get claudeAccounts(): Account[] { return this.accounts.filter((a) => providerOf(a) === 'claude'); }

  profileOf(acc: Account): be.ClaudeProfile | undefined {
    if (providerOf(acc) !== 'claude') return undefined;
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    return this.profiles.find((p) => norm(p.dir) === norm(acc.dir));
  }

  accountById(id?: string): Account | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  /** ¿Hay un terminal de Claude vivo de esta cuenta? (para decir «envía un mensaje para ver el uso») */
  hasLiveClaude(accountId: string): boolean {
    return this.workspaces.some((w) => w.panes.some((p) => p.kind === 'agent' && p.ref === accountId && this.live[p.id]?.state === 'running'));
  }

  /** ¿Se están capturando los límites de uso en los Claude nuevos? */
  get capturingUsage(): boolean { return !!this.usageSettings; }

  // ---------- MCP: servidor local para que los agentes vean hosts y terminales ----------

  /** Archivo `--mcp-config` para los Claude nuevos (undefined = MCP apagado o sin servidor). */
  get mcpConfigPath(): string | undefined {
    return this.settings.mcpEnabled && this.mcp?.running && this.mcp.configPath ? this.mcp.configPath : undefined;
  }

  /** Respuesta a una petición de aprobación de `run_command`. Cerrar el diálogo sin contestar no existe: solo Denegar o Ejecutar. */
  answerMcpApproval(id: string, approve: boolean): void {
    this.mcpApprovals = this.mcpApprovals.filter((x) => x.id !== id);
    void be.mcpApprovalAnswer(id, approve).catch(() => { /* ya había caducado */ });
  }

  /** Arranca o para el servidor según los ajustes y manda la instantánea. */
  async applyMcp(): Promise<void> {
    try {
      this.mcp = await be.mcpConfigure(this.settings.mcpEnabled, this.settings.mcpExposeLocal);
    } catch (e) {
      this.mcp = { enabled: this.settings.mcpEnabled, running: false, port: null, url: null, error: String(e), configPath: '' };
    }
    this.mcpLast = '';
    this.syncMcp();
  }

  /** Empuja hosts y paneles (sin secretos, ver mcpsync.ts) al backend, con un retardo de 300 ms. */
  syncMcp(): void {
    window.clearTimeout(this.mcpTimer);
    this.mcpTimer = window.setTimeout(() => {
      const snap = buildMcpSnapshot({
        hosts: $state.snapshot(this.hosts) as Host[],
        workspaces: $state.snapshot(this.workspaces) as Workspace[],
        live: $state.snapshot(this.live),
        providers: Object.fromEntries(this.accounts.map((a) => [a.id, providerOf(a)])),
      });
      const json = JSON.stringify(snap);
      if (json === this.mcpLast) return;
      this.mcpLast = json;
      void be.mcpSync(snap).catch(() => { this.mcpLast = ''; });
    }, 300);
  }

  /** Crea una cuenta nueva: prepara su carpeta (historial compartido) y abre `claude` para el login. */
  async addAccount(name: string): Promise<void> {
    const dir = `${this.home.replace(/\\/g, '/')}/.claude-${slug(name)}`;
    await be.prepareClaudeDir(dir.replace(/\//g, '\\'));
    const acc: Account = {
      id: uid('acc'), name: name.trim(), dir: dir.replace(/\//g, '\\'), isDefault: false, provider: 'claude',
      color: ACCOUNT_COLORS[this.accounts.length % ACCOUNT_COLORS.length],
    };
    this.accounts.push(acc);
    this.ignoredDirs = this.ignoredDirs.filter((d) => d.replace(/\\/g, '/').toLowerCase() !== acc.dir.replace(/\\/g, '/').toLowerCase());
    this.persist();
    this.toast(t('store.toast.accountCreated', { name: acc.name }));
    this.open({ kind: 'claude', accountId: acc.id });
  }

  // ---------- cuentas de Codex y opencode ----------

  /** Mira qué hay instalado (solo existencia de programa y carpetas; no se lee nada dentro). */
  async detectProviders(): Promise<void> {
    try { this.providers = await be.providerDetect(); } catch { this.providers = null; }
  }

  /** ¿Ya existe la cuenta «de siempre» (sin variable de entorno) de ese proveedor? */
  hasDefaultAccount(provider: Provider): boolean {
    return this.accounts.some((a) => providerOf(a) === provider && a.isDefault);
  }

  /**
   * Crea una cuenta de Codex u opencode. `useDefault` = la carpeta de siempre del usuario (~/.codex, datos de opencode)
   * sin tocarla; si no, una carpeta nueva `~.codex-<nombre>` / `~.opencode-<nombre>` (Codex: con `cli_auth_credentials_store = "file"`
   * en SU config.toml). No abre nada: el diálogo ofrece «Iniciar sesión» después.
   */
  async addProviderAccount(provider: 'codex' | 'opencode', name: string, opts: { useDefault?: boolean } = {}): Promise<Account> {
    const useDefault = !!opts.useDefault && !this.hasDefaultAccount(provider);
    let dir: string;
    if (useDefault) {
      dir = (provider === 'codex' ? this.providers?.codexDir : this.providers?.opencodeDir)
        ?? (provider === 'codex' ? this.home + '\\.codex' : this.home + '\\.local\\share\\opencode');
    } else {
      dir = accountDir(provider, this.home, name);
      await be.providerPrepare(provider, dir);
    }
    const acc: Account = {
      id: uid('acc'), name: name.trim(), dir, isDefault: useDefault, provider,
      color: ACCOUNT_COLORS[this.accounts.length % ACCOUNT_COLORS.length],
    };
    this.accounts.push(acc);
    this.persist();
    this.toast(t('store.toast.providerAccountCreated', { name: accountTitle(acc) }));
    void this.refreshProviderStatus({ id: acc.id, force: true });
    return acc;
  }

  /** Abre un terminal con el inicio de sesión del proveedor (codex login / opencode auth login) y el entorno de esa cuenta. */
  signIn(accountId: string, target?: { col: number; row: number }): void {
    this.open({ kind: 'account', accountId, login: true }, target);
  }

  /**
   * Pregunta al proveedor si hay sesión (codex login status / opencode auth list, con el entorno de la cuenta).
   * Solo guarda el veredicto. Sin `force` respeta un mínimo de 30 s por cuenta. En paralelo no se lanzan más de uno a la vez.
   */
  async refreshProviderStatus(opts: { id?: string; force?: boolean } = {}): Promise<void> {
    const now = Date.now();
    const todo = checkable(this.accounts).filter((a) =>
      (!opts.id || a.id === opts.id) && !this.statusChecking[a.id] && shouldRefresh(this.providerStatus[a.id], now, !!opts.force));
    for (const a of todo) {
      this.statusChecking[a.id] = true;
      try {
        const raw = await be.providerStatus(providerOf(a) as 'codex' | 'opencode', a.dir, a.isDefault);
        if (this.accountById(a.id)) this.providerStatus[a.id] = toProviderEntry(raw, Date.now());
      } catch {
        if (this.accountById(a.id)) this.providerStatus[a.id] = toProviderEntry(null, Date.now());
      } finally {
        delete this.statusChecking[a.id];
      }
    }
  }

  /** Abre Claude con la cuenta que dicte la política elegida. */
  openAuto(target?: { col: number; row: number }): void {
    const cands = this.claudeAccounts.map((acc) => ({ acc, loggedIn: !!this.profileOf(acc)?.loggedIn, quota: this.quota[acc.id] }));
    const pick = pickAccount(this.settings.accountPolicy, cands, this.settings.lastAccountId, Date.now() / 1000);
    if (!pick) { this.toast(t('store.toast.noAccountLoggedIn')); return; }
    this.settings.lastAccountId = pick.acc.id;
    this.toast(t('store.toast.accountPicked', { name: displayName(pick.acc.name), reason: pick.reason }));
    this.open({ kind: 'claude', accountId: pick.acc.id }, target);
  }

  /** Lista de la barra de estado de la pestaña activa: una lista propia, o `undefined` para volver a la global. */
  setTabStatusItems(list: ItemId[] | undefined): void {
    const w = this.active;
    if (!w) return;
    if (list) w.statusBarItems = cleanOverride(list); else delete w.statusBarItems;
    this.persist();
  }

  setPolicy(p: AccountPolicy): void { this.settings.accountPolicy = p; this.persist(); }

  renameAccount(id: string, name: string): void {
    const a = this.accountById(id);
    if (a && name.trim()) { a.name = name.trim(); this.persist(); }
  }

  /** Quita la cuenta de la lista de Orchestra. No toca la carpeta; no se vuelve a añadir sola al escanear. */
  removeAccount(id: string): void {
    const acc = this.accountById(id);
    if (!acc) return;
    this.accounts = this.accounts.filter((a) => a.id !== id);
    delete this.providerStatus[id];
    // «Ignoradas» es del escaneo de ~/.claude*: Codex y opencode no se añaden solas.
    if (providerOf(acc) === 'claude' && !this.ignoredDirs.includes(acc.dir)) this.ignoredDirs.push(acc.dir);
    if (this.settings.lastAccountId === id) this.settings.lastAccountId = undefined;
    this.persist();
    this.toast(t('store.toast.accountRemoved', { name: displayName(acc.name) }));
  }

  /** Vuelve a leer las carpetas ~/.claude* y añade las cuentas que falten. */
  async rescanAccounts(): Promise<void> {
    try { this.profiles = await be.claudeProfiles(); } catch (e) { this.toast(t('store.toast.scanFailed', { error: String(e) })); return; }
    const before = this.accounts.length;
    this.syncAccounts();
    this.persist();
    const n = this.accounts.length - before;
    this.toast(n === 0 ? t('store.toast.nothingNew')
      : n === 1 ? t('store.toast.foundAccountsOne', { n }) : t('store.toast.foundAccountsMany', { n }));
  }

  /** Deja de ignorar las carpetas quitadas y las vuelve a escanear. */
  async restoreIgnored(): Promise<void> {
    this.ignoredDirs = [];
    await this.rescanAccounts();
  }

  /** Cambia la suscripción de un panel de Claude: relanza `claude --continue` con la otra cuenta. */
  async switchAccount(paneId: string, accountId: string): Promise<void> {
    const acc = this.accountById(accountId);
    const pane = this.active.panes.find((p) => p.id === paneId);
    if (!acc || !pane || pane.kind !== 'agent' || providerOf(acc) !== 'claude') return;
    // Con la sesión conocida y su transcripción en la carpeta de la cuenta nueva, se retoma ESA (no «la última de la carpeta»).
    const sid = pane.lastSession && !pane.lastSession.ended && isSessionId(pane.lastSession.id) ? pane.lastSession.id : undefined;
    let resumeId: string | undefined;
    if (sid) { try { if (await be.claudeSessionExists(acc.dir, sid)) resumeId = sid; } catch { /* --continue */ } }
    pane.spec = claudeSpec(acc, { cwd: pane.spec.cwd, resume: true, resumeId, settingsPath: this.usageSettings || undefined, mcpConfig: this.mcpConfigPath });
    pane.ref = acc.id;
    pane.title = `Claude · ${acc.name}`;
    this.persist();
    await T.restart($state.snapshot(pane) as Pane);
    this.toast(t('store.toast.paneSwitched', { name: displayName(acc.name) }));
  }

  // ---------- abrir terminales ----------

  private shellPane(sh: be.ShellProfile): Pane {
    return this.basePane('shell', 'terminal', sh.name, sh.id, { program: sh.program, args: sh.args, cwd: this.home || undefined });
  }

  private basePane(kind: Pane['kind'], icon: string, title: string, ref: string | undefined, spec: Pane['spec']): Pane {
    return { id: uid('t'), col: 0, row: 0, colSpan: 1, rowSpan: 1, parked: false, kind, icon, title, ref, spec };
  }

  private build(req: OpenReq): Pane | null {
    switch (req.kind) {
      case 'shell': {
        const sh = this.shells.find((s) => s.id === req.id);
        return sh ? this.shellPane(sh) : null;
      }
      case 'host': {
        const h = this.hosts.find((x) => x.id === req.id);
        return h ? this.basePane('ssh', 'server', h.name || h.host, h.id, sshSpec(h, this.settings.sshHostKeyPolicy)) : null;
      }
      case 'sshinstall': {
        const h = this.hosts.find((x) => x.id === req.hostId);
        return h ? this.basePane('ssh', 'server', t('store.pane.installKey', { name: h.name || h.host }), undefined, sshInstallKeySpec(h, req.pubPath, this.settings.sshHostKeyPolicy)) : null;
      }
      case 'sshconfig':
        return this.basePane('ssh', 'server', req.alias, `cfg:${req.alias}`, { program: 'ssh', args: sshAliasArgs(req.alias) });
      case 'claude': {
        const acc = this.accountById(req.accountId);
        if (!acc) return null;
        return this.basePane('agent', 'bot', `Claude · ${acc.name}`, acc.id,
          claudeSpec(acc, { cwd: req.cwd ?? (this.settings.agentCwd || this.home || undefined), resume: req.resume, settingsPath: this.usageSettings || undefined, mcpConfig: this.mcpConfigPath }));
      }
      case 'codex':
        return this.basePane('agent', 'bot', 'Codex', 'codex', codexSpec({ cwd: this.home || undefined }));
      case 'account': {
        const acc = this.accountById(req.accountId);
        if (!acc) return null;
        if (providerOf(acc) === 'claude') return this.build({ kind: 'claude', accountId: acc.id, cwd: req.cwd });
        const title = req.login ? t('store.pane.signIn', { name: accountTitle(acc) }) : accountTitle(acc);
        return this.basePane('agent', 'bot', title, acc.id,
          providerSpec(acc, { cwd: req.cwd ?? (this.settings.agentCwd || this.home || undefined), login: req.login }));
      }
      case 'quick': {
        const q = parseQuickConnect(req.text);
        if (!q?.host) return null;
        const h = { ...emptyHost(), ...q, host: q.host } as Host;
        return this.basePane('ssh', 'server', sshTarget(h), undefined, { program: 'ssh', args: sshArgs(h) });
      }
    }
  }

  private placeNew(ws: Workspace, pane: Pane, target?: { col: number; row: number }): void {
    const displaced = placePane(ws, pane, target);
    if (displaced) this.toast(t('store.toast.movedToBackground', { title: displaced.title }));
  }

  open(req: OpenReq, target?: { col: number; row: number }): void {
    // Host con contraseña/passphrase guardada y política «confirm»: primero se comprueba la huella.
    const h = req.kind === 'host' ? this.hosts.find((x) => x.id === req.id)
      : req.kind === 'sshinstall' ? this.hosts.find((x) => x.id === req.hostId) : undefined;
    if (h && hostKeyAction(h, this.settings.sshHostKeyPolicy) !== 'spawn') {
      void this.hostKeyGate(h).then((ok) => { if (ok) this.openNow(req, target); });
      return;
    }
    this.openNow(req, target);
  }

  private openNow(req: OpenReq, target?: { col: number; row: number }): void {
    const pane = this.build(req);
    if (!pane) { this.toast(t('store.toast.openFailed')); return; }
    this.placeNew(this.active, pane, target);
    this.persist();
  }

  // ---------- huella del servidor (hosts con secreto guardado) ----------

  /** Mismo paso de huella que al abrir un panel (lo usa el explorador SFTP). true = se puede conectar. */
  async ensureHostKey(h: Host): Promise<boolean> {
    if (hostKeyAction(h, this.settings.sshHostKeyPolicy) === 'spawn') return true;
    return this.hostKeyGate(h);
  }

  /** true = se puede conectar. false = cancelado, bloqueado o con error (el diálogo explica por qué). */
  private async hostKeyGate(h: Host): Promise<boolean> {
    this.cancelHostKey();
    const token = ++this.hostKeyToken;
    this.hostKeyPrompt = { host: h, phase: 'checking' };
    let probe: be.HostKeyProbe;
    try {
      probe = await be.hostKeyProbe(h.host, h.port, h.user, h.proxyJump);
    } catch (e) {
      if (token === this.hostKeyToken) this.hostKeyPrompt = { host: h, phase: 'error', message: String(e).replace(/^Error: /, '') };
      return false;
    }
    if (token !== this.hostKeyToken) return false; // el usuario canceló mientras tanto
    const act = hostKeyAction(h, this.settings.sshHostKeyPolicy, probe.status);
    if (act === 'spawn') { this.hostKeyPrompt = null; return true; }
    if (act === 'blocked-jump') { this.hostKeyPrompt = { host: h, phase: 'jump', message: hostKeyBlockedMsg('jump') }; return false; }
    if (act === 'blocked-alias') { this.hostKeyPrompt = { host: h, phase: 'alias', message: hostKeyBlockedMsg('alias') }; return false; }
    return new Promise<boolean>((resolve) => {
      this.hostKeyResolve = resolve;
      this.hostKeyPrompt = { host: h, phase: 'confirm', probe };
    });
  }

  /** «Trust and connect»: añade las claves a known_hosts y deja abrir el panel. */
  async acceptHostKey(): Promise<void> {
    const p = this.hostKeyPrompt;
    if (!p || p.phase !== 'confirm' || !p.probe || p.busy) return;
    p.busy = true;
    p.message = undefined;
    try {
      await be.hostKeyTrust(p.probe.host, p.probe.port, p.probe.keys.map((k) => k.line));
    } catch (e) {
      p.busy = false;
      p.message = String(e).replace(/^Error: /, '');
      return;
    }
    const done = this.hostKeyResolve;
    this.hostKeyResolve = null;
    this.hostKeyPrompt = null;
    done?.(true);
  }

  /** Cancelar / cerrar el diálogo: no se abre panel y no cambia nada. */
  cancelHostKey(): void {
    this.hostKeyToken++;
    const done = this.hostKeyResolve;
    this.hostKeyResolve = null;
    this.hostKeyPrompt = null;
    done?.(false);
  }

  // ---------- paneles ----------

  focus(id: string): void {
    this.active.focusId = id;
    T.focus(id);
  }

  closePane(id: string): void {
    this.conn.closed(id);
    T.dispose(id);
    removePane(this.active, id);
    delete this.live[id];
    this.persist();
  }

  /** Reinicio pedido por el usuario (botón Restart): olvida la cuenta atrás y el «Cancel» de la reconexión automática. */
  restartPane(id: string): void {
    this.conn.userRestarted(id);
    this.restartNow(id);
  }

  /** El camino de «Restart» (huella del host, bóveda, refreshSshSpec); la reconexión automática entra por aquí. */
  private restartNow(id: string, banner?: string): void {
    const p = this.paneById(id);
    if (!p) return;
    const h = p.kind === 'ssh' && p.ref && !p.ref.startsWith('cfg:') ? this.hosts.find((x) => x.id === p.ref) : undefined;
    const go = () => {
      this.refreshSshSpec(p);
      void T.restart($state.snapshot(p) as Pane, banner);
    };
    if (h && hostKeyAction(h, this.settings.sshHostKeyPolicy) !== 'spawn') {
      void this.hostKeyGate(h).then((ok) => { if (ok) go(); });
      return;
    }
    go();
  }

  /** Un panel abierto desde un host de la bóveda toma el método de acceso vigente del host. */
  private refreshSshSpec(p: Pane): void {
    if (p.kind !== 'ssh' || !p.ref || p.ref.startsWith('cfg:')) return;
    const h = this.hosts.find((x) => x.id === p.ref);
    if (h) p.spec = sshSpec(h, this.settings.sshHostKeyPolicy);
  }

  toggleMaximize(id: string): void {
    const ws = this.active;
    ws.maximizedId = ws.maximizedId === id ? undefined : id;
    ws.focusId = id;
    this.persist();
  }

  swap(a: string, b: string): void { swapPanes(this.active, a, b); this.persist(); }
  moveTo(id: string, col: number, row: number): void { movePaneToCell(this.active, id, col, row); this.persist(); }

  unpark(id: string): void {
    const ws = this.active;
    const p = ws.panes.find((x) => x.id === id);
    if (!p) return;
    const focus = ws.panes.find((x) => x.id === ws.focusId && !x.parked);
    const free = this.freeFor(ws);
    if (free) { p.col = free.col; p.row = free.row; p.parked = false; ws.focusId = id; }
    else if (focus) { swapPanes(ws, id, focus.id); ws.focusId = id; }
    this.persist();
  }

  private freeFor(ws: Workspace): { col: number; row: number } | null {
    const taken = new Set(ws.panes.filter((p) => !p.parked).map((p) => `${p.col},${p.row}`));
    for (let r = 0; r < ws.rows.length; r++)
      for (let c = 0; c < ws.cols.length; c++) if (!taken.has(`${c},${r}`)) return { col: c, row: r };
    return null;
  }

  moveFocus(dir: Dir): void {
    const ws = this.active;
    if (!ws.focusId) return;
    const n = neighbor(ws, ws.focusId, dir);
    if (n) this.focus(n);
  }

  // ---------- cuadrícula ----------

  setLayout(cols: number, rows: number): void {
    reflow(this.active, Math.max(1, Math.min(8, cols)), Math.max(1, Math.min(8, rows)));
    this.persist();
  }
  equalize(): void {
    const ws = this.active;
    ws.cols = equalTracks(ws.cols.length);
    ws.rows = equalTracks(ws.rows.length);
    this.persist();
  }
  resizeTrack(axis: 'col' | 'row', i: number, delta: number, minFrac: number): void {
    const ws = this.active;
    if (axis === 'col') ws.cols = resizeTracks(ws.cols, i, delta, minFrac);
    else ws.rows = resizeTracks(ws.rows, i, delta, minFrac);
    this.persist();
  }

  // ---------- espacios de trabajo ----------

  addWorkspace(): void {
    const ws = newWorkspace(`Workspace ${this.workspaces.length + 1}`, 2, 2);
    this.workspaces.push(ws);
    this.activeId = ws.id;
    this.persist();
  }
  switchWorkspace(id: string): void { this.activeId = id; this.persist(); }
  cycleWorkspace(step: number): void {
    const i = this.workspaces.findIndex((w) => w.id === this.activeId);
    const n = this.workspaces.length;
    this.switchWorkspace(this.workspaces[(i + step + n) % n].id);
  }
  renameWorkspace(id: string, name: string): void {
    const ws = this.workspaces.find((w) => w.id === id);
    const n = SW.cleanName(name);
    if (ws && n) { ws.name = n; this.persist(); } // vacío = se queda el nombre de antes
  }
  /** Cierra todas las pestañas menos `id` (y la deja activa). */
  closeOtherWorkspaces(id: string): void {
    if (!this.workspaces.some((w) => w.id === id)) return;
    this.activeId = id;
    for (const w of [...this.workspaces]) if (w.id !== id) this.closeWorkspace(w.id);
  }

  // ---------- espacios guardados (lógica pura en savedws.ts) ----------

  /** Carpeta actual de cada panel según su terminal, para guardar dónde está y no dónde arrancó. */
  private liveCwds(ws: Workspace): Record<string, string | undefined> {
    return Object.fromEntries(ws.panes.map((p) => [p.id, this.live[p.id]?.cwd]));
  }
  private snapshotOf(wsId: string, name: string): SavedWorkspace | null {
    const ws = this.workspaces.find((w) => w.id === wsId);
    return ws ? SW.toSaved($state.snapshot(ws) as Workspace, { name, liveCwd: this.liveCwds(ws) }) : null;
  }

  /** Guarda la pestaña `wsId` como `name`. Con el nombre ya cogido devuelve `conflict` (la interfaz pregunta y vuelve con `overwrite`). */
  saveWorkspace(wsId: string, name: string, overwrite = false): SW.SaveResult {
    const snap = this.snapshotOf(wsId, name);
    if (!snap) return { ok: false, reason: 'empty' };
    const r = SW.upsertSaved($state.snapshot(this.savedWorkspaces) as SavedWorkspace[], snap, overwrite);
    if (r.ok) {
      this.savedWorkspaces = r.list;
      this.persist();
      this.toast(t('topbar.saved.toastSaved', { name: r.saved.name }));
    } else if (r.reason === 'full') this.toast(t('topbar.saved.toastFull', { n: SW.SAVED_LIMITS.count }));
    return r;
  }
  /** Sobrescribe el guardado `savedId` con la pestaña `wsId` (conserva su nombre). */
  overwriteSavedWorkspace(savedId: string, wsId: string): void {
    const cur = this.savedWorkspaces.find((s) => s.id === savedId);
    const snap = this.snapshotOf(wsId, cur?.name ?? '');
    if (!cur || !snap) return;
    this.savedWorkspaces = SW.overwriteSaved($state.snapshot(this.savedWorkspaces) as SavedWorkspace[], savedId, snap);
    this.persist();
    this.toast(t('topbar.saved.toastSaved', { name: cur.name }));
  }
  renameSavedWorkspace(savedId: string, name: string): SW.RenameResult {
    const r = SW.renameSaved($state.snapshot(this.savedWorkspaces) as SavedWorkspace[], savedId, name);
    if (r.ok) { this.savedWorkspaces = r.list; this.persist(); }
    return r;
  }
  deleteSavedWorkspace(savedId: string): void {
    const cur = this.savedWorkspaces.find((s) => s.id === savedId);
    if (!cur) return;
    this.savedWorkspaces = SW.deleteSaved($state.snapshot(this.savedWorkspaces) as SavedWorkspace[], savedId);
    this.persist();
    this.toast(t('topbar.saved.toastDeleted', { name: cur.name }));
  }

  /**
   * Prepara los paneles de una pestaña que sale de un guardado o de «Duplicar»: los de un host toman su acceso vigente y los de
   * una cuenta se rehacen desde la cuenta (rutas de --settings y --mcp-config de esta sesión). Claude arranca SIEMPRE una
   * conversación nueva: la de origen puede seguir abierta en otra pestaña y dos paneles en la misma sesión se pisan.
   */
  private freshPanes(ws: Workspace): void {
    for (const p of ws.panes) {
      this.refreshSshSpec(p);
      if (p.kind !== 'agent') continue;
      const acc = this.accountById(p.ref);
      if (!acc) { p.spec = SW.freshAgentSpec(p.spec); continue; }
      p.spec = providerOf(acc) === 'claude'
        ? claudeSpec(acc, { cwd: p.spec.cwd, settingsPath: this.usageSettings || undefined, mcpConfig: this.mcpConfigPath })
        : providerSpec(acc, { cwd: p.spec.cwd });
    }
  }
  /** Abre un guardado en una pestaña nueva (ids nuevos; el guardado no cambia). */
  openSavedWorkspace(savedId: string): void {
    const sw = this.savedWorkspaces.find((s) => s.id === savedId);
    if (!sw) return;
    const ws = SW.fromSaved($state.snapshot(sw) as SavedWorkspace);
    this.freshPanes(ws);
    this.workspaces.push(ws);
    this.activeId = ws.id;
    this.persist();
  }
  /** Copia de una pestaña abierta, al lado de la original. */
  duplicateWorkspace(wsId: string): void {
    const i = this.workspaces.findIndex((w) => w.id === wsId);
    if (i < 0) return;
    const ws = this.workspaces[i];
    const name = SW.uniqueName(t('topbar.copyName', { name: displayName(ws.name) }), this.workspaces.map((w) => displayName(w.name)));
    const copy = SW.duplicateWorkspace($state.snapshot(ws) as Workspace, name, this.liveCwds(ws));
    this.freshPanes(copy);
    this.workspaces.splice(i + 1, 0, copy);
    this.activeId = copy.id;
    this.persist();
  }
  closeWorkspace(id: string): void {
    if (this.workspaces.length <= 1) return;
    const ws = this.workspaces.find((w) => w.id === id);
    ws?.panes.forEach((p) => { this.conn.closed(p.id); T.dispose(p.id); delete this.live[p.id]; });
    this.workspaces = this.workspaces.filter((w) => w.id !== id);
    if (this.activeId === id) this.activeId = this.workspaces[0].id;
    this.persist();
  }

  // ---------- hosts ----------

  saveHost(h: Host): void {
    const i = this.hosts.findIndex((x) => x.id === h.id);
    if (i >= 0) this.hosts[i] = h; else this.hosts.push(h);
    this.persist();
  }
  deleteHost(id: string): void {
    this.hosts = this.hosts.filter((h) => h.id !== id);
    // Sus secretos se borran del Administrador de credenciales (mejor esfuerzo).
    for (const kind of ['password', 'passphrase'] as const) void be.secretDelete(hostSecretKey(id, kind)).catch(() => {});
    this.persist();
  }

  // ---------- hosts: carpetas y orden (lógica pura en hostview.ts) ----------

  private hostsPlain(): Host[] { return $state.snapshot(this.hosts) as Host[]; }
  /** Antes de reordenar a mano: con orden A-Z se guarda ese A-Z como manual y se pasa a Manual (nada salta de sitio) y se avisa. */
  private manualBase(): { hosts: Host[]; folders: string[] } {
    const hosts = this.hostsPlain();
    const folders = [...this.settings.hostFolders];
    if (this.settings.hostsSort === 'manual') return { hosts, folders };
    const f = HV.freezeOrder(hosts, folders, this.settings.hostsSort);
    this.patchSettings({ hostsSort: 'manual', hostFolders: f.folders });
    this.toast(t('store.toast.hostsSortManual'));
    return f;
  }
  /** Guarda los hosts reordenados. Las carpetas que había se quedan en la lista aunque se vacíen (no desaparecen al sacar su
   *  último host; se borran con «Borrar carpeta»). */
  private setHostsOrder(before: { hosts: Host[]; folders: string[] }, next: Host[]): void {
    this.hosts = next;
    this.setting('hostFolders', HV.folderOrder(next, HV.folderOrder(before.hosts, before.folders)));
    this.persist();
  }
  /** Arrastrar y soltar: el host va a `folder` antes de `beforeId` (null = al final de la carpeta). */
  moveHostTo(id: string, folder: string, beforeId: string | null): void {
    const b = this.manualBase();
    this.setHostsOrder(b, HV.moveHost(b.hosts, id, folder, beforeId));
  }
  /** Alt+↑/↓ o «Subir» / «Bajar». */
  stepHost(id: string, dir: -1 | 1): void {
    const b = this.manualBase();
    this.setHostsOrder(b, HV.stepHost(b.hosts, b.folders, id, dir));
  }
  moveHostFolder(name: string, before: string | null): void {
    const b = this.manualBase();
    this.setting('hostFolders', HV.moveFolder(b.hosts, b.folders, name, before));
  }
  stepHostFolder(name: string, dir: -1 | 1): void {
    const b = this.manualBase();
    this.setting('hostFolders', HV.stepFolder(b.hosts, b.folders, name, dir));
  }
  /** Crea una carpeta vacía al final con un nombre libre y lo devuelve (la barra lo pone a renombrar). */
  newHostFolder(): string {
    const hosts = this.hostsPlain();
    const name = HV.freeFolderName(hosts, this.settings.hostFolders, t('sidebar.ssh.folder.newName'));
    this.patchSettings({ hostFolders: HV.addFolder(hosts, this.settings.hostFolders, name), hostFoldersCollapsed: this.settings.hostFoldersCollapsed.filter((g) => g !== name) });
    return name;
  }
  renameHostFolder(from: string, to: string): void {
    const r = HV.renameFolder(this.hostsPlain(), this.settings.hostFolders, this.settings.hostFoldersCollapsed, from, to);
    this.hosts = r.hosts;
    this.patchSettings({ hostFolders: r.folders, hostFoldersCollapsed: r.collapsed });
    this.persist();
  }
  /** Borra la carpeta; sus hosts pasan a «sin carpeta» (nunca se borran). */
  deleteHostFolder(name: string): void {
    const r = HV.deleteFolder(this.hostsPlain(), this.settings.hostFolders, this.settings.hostFoldersCollapsed, name);
    this.hosts = r.hosts;
    this.patchSettings({ hostFolders: r.folders, hostFoldersCollapsed: r.collapsed });
    this.persist();
  }
  toggleHostFolder(name: string): void { this.setting('hostFoldersCollapsed', HV.toggleCollapsed(this.settings.hostFoldersCollapsed, name)); }

  /** Convierte en hosts de la bóveda las entradas de ~/.ssh/config que aún no lo son. */
  importSshConfig(): number {
    const fresh = newConfigEntries(this.sshConfig, this.hosts);
    for (const c of fresh) this.hosts.push(hostFromSshConfig(c));
    if (fresh.length) this.persist();
    const n = fresh.length;
    this.toast(n === 0 ? t('store.toast.nothingToImport')
      : n === 1 ? t('store.toast.hostsImportedOne', { n }) : t('store.toast.hostsImportedMany', { n }));
    return fresh.length;
  }

  /** Copia los hosts como JSON (sin secretos ni ids) al portapapeles. */
  async exportHosts(): Promise<void> {
    try {
      await be.copyText(exportHosts($state.snapshot(this.hosts) as Host[]));
      const n = this.hosts.length;
      this.toast(n === 1 ? t('store.toast.hostsCopiedOne', { n }) : t('store.toast.hostsCopiedMany', { n }));
    } catch (e) {
      this.toast(t('store.toast.copyFailed', { error: String(e) }));
    }
  }
  newHost(): void { this.hostDialog = emptyHost(); }

  // ---------- ajustes y atajos ----------

  /** Opciones de xterm a partir de los ajustes. */
  termOptions(): T.TermOptions {
    const s = this.settings;
    return {
      fontFamily: fontStack(s.fontFamily), fontSize: s.fontSize, lineHeight: s.lineHeight,
      cursorStyle: s.cursorStyle, cursorBlink: s.cursorBlink, scrollback: s.scrollback,
      theme: resolveTheme(s.theme, this.customThemes), copyOnSelect: s.copyOnSelect, rightClick: s.rightClick, bell: s.bell,
    };
  }

  /** Color de acento y fondo del terminal como variables CSS (en vivo). */
  applyAppearance(): void {
    const st = document.documentElement.style;
    st.setProperty('--accent', this.settings.accent);
    st.setProperty('--accent-soft', hexAlpha(this.settings.accent, 0.14));
    st.setProperty('--term-bg', resolveTheme(this.settings.theme, this.customThemes).background);
  }

  /** Idioma de la interfaz: fija el diccionario, `<html lang>` y los textos de la bandeja. App.svelte remonta todo al cambiar `settings.language`. */
  applyLanguage(): void {
    const loc = resolveLanguage(this.settings.language, navigator.language);
    setLocale(loc);
    document.documentElement.lang = loc;
    be.setTrayLabels(t('tray.show'), t('tray.quit'));
  }

  /** Aplica en vivo lo que dependa de las claves cambiadas. */
  private applyEffects(keys: readonly (keyof Settings)[]): void {
    if (keys.some((k) => TERMINAL_KEYS.includes(k))) T.applyOptions(this.termOptions());
    if (keys.includes('accent') || keys.includes('theme')) this.applyAppearance();
    if (keys.includes('language')) this.applyLanguage();
    if (keys.includes('closeToTray')) be.setCloseToTray(this.settings.closeToTray);
    if (keys.includes('scanIntervalSec')) this.armScan();
    if (keys.includes('captureUsage')) void this.prepareUsage();
    if (keys.includes('usageQuery') || keys.includes('usageQueryMin')) this.armUsageQuery();
    if (keys.includes('latencyBadge') || keys.includes('latencyIntervalSec')) this.conn.arm();
    if (keys.includes('mcpEnabled') || keys.includes('mcpExposeLocal')) void this.applyMcp();
  }

  /** Cambia varios ajustes a la vez (validados), los aplica en vivo y los guarda. */
  patchSettings(patch: Partial<Settings>): void {
    const next = clampSettings({ ...$state.snapshot(this.settings), ...patch });
    const changed = (Object.keys(DEFAULTS) as (keyof Settings)[]).filter((k) => next[k] !== this.settings[k]);
    if (!changed.length) return;
    this.settings = next;
    this.applyEffects(changed);
    this.persist();
  }

  setting<K extends keyof Settings>(key: K, value: Settings[K]): void { this.patchSettings({ [key]: value } as Partial<Settings>); }

  resetSettingsSection(section: SectionId): void { this.replaceSettings(resetSection($state.snapshot(this.settings) as Settings, section)); }

  /** Sustituye todos los ajustes (importar, restablecer) y aplica lo que haya cambiado. */
  replaceSettings(next: Settings): void {
    const valid = clampSettings(next);
    const changed = (Object.keys(DEFAULTS) as (keyof Settings)[]).filter((k) => valid[k] !== this.settings[k]);
    this.settings = valid;
    this.applyEffects(changed);
    this.persist();
  }

  resetAllSettings(): void { this.replaceSettings({ ...DEFAULTS }); }

  // ---------- temas de color propios ----------

  /** Guarda temas ya validados (ids únicos, tope MAX_CUSTOM_THEMES). Si entra uno solo, queda elegido. */
  addCustomThemes(defs: readonly ThemeDef[]): { added: number; skipped: number } {
    const room = Math.max(0, MAX_CUSTOM_THEMES - this.customThemes.length);
    const fresh = withUniqueIds(defs.slice(0, room), $state.snapshot(this.customThemes) as ThemeDef[]);
    if (fresh.length) {
      this.customThemes = [...this.customThemes, ...fresh];
      this.persist();
      if (fresh.length === 1) this.setting('theme', fresh[0].id);
    }
    return { added: fresh.length, skipped: defs.length - fresh.length };
  }

  renameCustomTheme(id: string, name: string): boolean {
    const clean = sanitizeName(name, '');
    if (!clean || !this.customThemes.some((d) => d.id === id)) return false;
    this.customThemes = this.customThemes.map((d) => (d.id === id ? { ...d, name: clean } : d));
    this.persist();
    return true;
  }

  /** Borra un tema propio; si estaba en uso, las terminales vuelven a Orchestra Dark. */
  deleteCustomTheme(id: string): void {
    this.customThemes = this.customThemes.filter((d) => d.id !== id);
    if (this.settings.theme === id) this.setting('theme', DEFAULT_THEME);
    this.persist();
  }

  setFontSize(n: number): void { this.setting('fontSize', n); }
  toggleSidebar(): void { this.settings.sidebarOpen = !this.settings.sidebarOpen; this.persist(); }

  handleShortcut(ev: KeyboardEvent): boolean {
    const ws = this.active;
    const id = ws?.focusId;
    const ctrl = ev.ctrlKey && !ev.metaKey;
    if (ctrl && !ev.shiftKey && ev.code === 'Comma') { this.settingsOpen = !this.settingsOpen; return true; }
    if (ctrl && ev.shiftKey && ev.code === 'KeyP') { this.paletteOpen = true; return true; }
    if (ctrl && ev.shiftKey && ev.code === 'KeyB') { this.toggleSidebar(); return true; }
    if (ctrl && ev.shiftKey && ev.code === 'KeyA') { this.jumpToWaiting(); return true; }
    if (ctrl && ev.shiftKey && ev.code === 'Enter' && id) { this.toggleMaximize(id); return true; }
    if (ctrl && ev.shiftKey && ev.code === 'KeyW' && id) { this.closePane(id); return true; }
    if (ctrl && ev.shiftKey && ev.code === 'KeyT') {
      const sh = this.shells[0];
      if (sh) this.open({ kind: 'shell', id: sh.id });
      return true;
    }
    if (ctrl && ev.shiftKey && ev.code === 'KeyF' && id) { window.dispatchEvent(new CustomEvent('orchestra-search', { detail: id })); return true; }
    if (ctrl && !ev.shiftKey && (ev.code === 'PageDown' || ev.code === 'PageUp')) { this.cycleWorkspace(ev.code === 'PageDown' ? 1 : -1); return true; }
    if (ev.altKey && !ctrl && !ev.shiftKey) {
      const d: Record<string, Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      if (d[ev.code]) { this.moveFocus(d[ev.code]); return true; }
      const m = /^Digit([1-9])$/.exec(ev.code);
      if (m) {
        const vis = ws.panes.filter((p) => !p.parked).sort((a, b) => a.row - b.row || a.col - b.col);
        const p = vis[Number(m[1]) - 1];
        if (p) this.focus(p.id);
        return true;
      }
    }
    if (ctrl && !ev.shiftKey && (ev.key === '+' || ev.key === '=')) { this.setFontSize(this.settings.fontSize + 1); return true; }
    if (ctrl && !ev.shiftKey && ev.key === '-') { this.setFontSize(this.settings.fontSize - 1); return true; }
    if (ctrl && !ev.shiftKey && ev.key === '0') { this.setFontSize(DEFAULTS.fontSize); return true; }
    return false;
  }

  // ---------- copia de seguridad completa (la composición es pura: ver backup.ts) ----------

  /** Copia plana de lo que entra en una copia de seguridad. */
  backupState(): BackupState {
    return $state.snapshot({
      settings: this.settings, hosts: this.hosts, accounts: this.accounts, customThemes: this.customThemes,
      workspaces: this.workspaces, activeId: this.activeId, ignoredDirs: this.ignoredDirs, savedWorkspaces: this.savedWorkspaces,
    }) as BackupState;
  }

  /**
   * Escribe el resultado de `mergeBackup` / `replaceFromBackup`. `closePanes` = ids de paneles actuales que se cierran antes
   * (sus procesos se matan; los nuevos se lanzan solos al montarse, sin recargar la ventana: recargarla dejaría los PTY viejos vivos y huérfanos).
   */
  applyBackupState(next: BackupState, closePanes: readonly string[] = []): void {
    for (const id of closePanes) { this.conn.closed(id); T.dispose(id); delete this.live[id]; }
    this.customThemes = next.customThemes;
    this.hosts = next.hosts;
    this.accounts = next.accounts;
    this.ignoredDirs = next.ignoredDirs;
    this.workspaces = next.workspaces;
    if (next.savedWorkspaces) this.savedWorkspaces = SW.normalizeSaved(next.savedWorkspaces);
    this.activeId = next.workspaces.some((w) => w.id === next.activeId) ? next.activeId : next.workspaces[0].id;
    for (const w of this.workspaces) for (const p of w.panes) this.refreshSshSpec(p); // como al arrancar: los paneles de un host toman su método de acceso
    this.replaceSettings(next.settings);
    this.syncAccounts();
    this.persistNow();
    void this.prepareUsage();
    void this.applyMcp();
  }
}

export const app = new AppState();
