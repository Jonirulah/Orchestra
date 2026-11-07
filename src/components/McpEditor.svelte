<script lang="ts">
  // Gestor de MCP: añadir (formulario + «Pegar del README»), aplicar a otras cuentas, quitar de cuentas e igualar.
  // Siempre en tres pasos: editar → vista previa (comando exacto por cuenta, secretos como •••) → aplicar y resultado.
  // Nada se ejecuta sin pulsar «Aplicar». Los valores de las cuentas nunca llegan aquí: copiar/igualar manda a Rust
  // solo la referencia de la cuenta origen.
  import { mcpmApply, mcpmPlan, mcpmReveal } from '../lib/backend.ts';
  import type { McpAccount, McpApplyResult, McpChange, McpPlanStep } from '../lib/backend.ts';
  import { canApply, copyChange, emptyForm, formatPlanLine, formFromDraft, formToDef, isReadmePlaceholder, lingering, placeholderFields, previewEntries, relistCheck, resultSummary, rowSource, shownErrors, validateForm } from '../lib/mcpform.ts';
  import type { Linger, PreviewEntry } from '../lib/mcpform.ts';
  import type { McpForm, McpFormError } from '../lib/mcpform.ts';
  import { parsePasted } from '../lib/mcppaste.ts';
  import type { PasteResult } from '../lib/mcppaste.ts';
  import { classifyProbeError } from '../lib/mcpmatrix.ts';
  import { winPath } from '../lib/mcpcols.ts';
  import type { McpRow, McpRowLike, McpVariant, ProbeLike } from '../lib/mcpmatrix.ts';
  import { providerLabel } from '../lib/model.ts';
  import { t, tk, tn } from '../lib/i18n.ts';

  export type EditorMode =
    | { kind: 'add' }
    | { kind: 'copy'; row: McpRowLike; targets: string[]; replace: boolean }
    | { kind: 'remove'; row: McpRowLike; targets: string[] };

  interface Props {
    mode: EditorMode;
    accounts: McpAccount[];
    /** Filas de la tabla (letras de las versiones en la vista previa). */
    rows: McpRow[];
    colName: (a: McpAccount) => string;
    /** Tras aplicar: volver a listar y devolver las cuentas nuevas (para comprobar que aparece). */
    reload: () => Promise<McpAccount[]>;
    /** Carpetas de los paneles abiertos (para los ámbitos local y proyecto). */
    projects: string[];
    /** «Probar ahora» tras aplicar. */
    probeNow: (accountId: string, name: string) => Promise<ProbeLike | null>;
    onclose: () => void;
    /** Cuenta a la que llevar la tabla (la primera que falló al aplicar). */
    onfocus?: (accountId: string) => void;
  }
  let { mode, accounts, rows, colName, reload, projects, probeNow, onclose, onfocus }: Props = $props();

  // svelte-ignore state_referenced_locally
  const initialTargets = mode.kind === 'add' ? [] : mode.targets;
  let form = $state<McpForm>(emptyForm());
  let targets = $state<string[]>([...initialTargets]);
  // svelte-ignore state_referenced_locally
  let replace = $state(mode.kind === 'copy' ? mode.replace : false);
  let paste = $state('');
  let pasted = $state<PasteResult | null>(null);
  let pastedPick = $state(0);
  let showPaste = $state(true);
  let tried = $state(false);
  /** Campos de los que el usuario ya ha salido: sus errores se enseñan (nunca al abrir). */
  let touched = $state<Partial<Record<McpFormError, boolean>>>({});
  const touch = (k: McpFormError) => () => { touched[k] = true; };
  /** Resultado de «Probar ahora» por cuenta. */
  let tested = $state<Record<string, ProbeLike | 'busy' | null>>({});
  let step = $state<'edit' | 'preview' | 'result'>('edit');
  let plan = $state<McpPlanStep[]>([]);
  let busy = $state(false);
  let err = $state<string | null>(null);
  let result = $state<McpApplyResult | null>(null);
  let check = $state<Record<string, boolean>>({});
  /** Quitar / Igualar: incluir también las copias del ámbito local (Claude) que seguirían activas en su carpeta. */
  let includeLocal = $state(false);

  const errors = $derived(mode.kind === 'add' ? validateForm(form, targets) : targets.length ? [] : ['targets' as const]);
  const shown = $derived(shownErrors(errors as McpFormError[], touched, tried));

  const accById = (id: string) => accounts.find((a) => a.id === id);
  const accName = (id: string) => { const a = accById(id); return a ? `${colName(a)} · ${providerLabel(a.provider)}` : id; };

  function change(): McpChange | null {
    if (mode.kind === 'add') return { kind: 'add', def: formToDef(form), targets: [...targets], replace };
    if (mode.kind === 'copy') { const c = copyChange(mode.row, accounts, [...targets], replace); return c && c.kind === 'copy' ? { ...c, includeLocal } : c; }
    return { kind: 'remove', name: mode.row.name, targets: [...targets], includeLocal };
  }

  function analyse() {
    pasted = parsePasted(paste);
    pastedPick = 0;
    if (pasted.drafts.length) form = { ...formFromDraft(pasted.drafts[0]), scope: pasted.scope ?? 'user', project: projects[0] ?? '' };
  }
  function pick(i: number) {
    pastedPick = i;
    if (pasted?.drafts[i]) form = { ...formFromDraft(pasted.drafts[i]), scope: form.scope, project: form.project };
  }
  function warnText(w: PasteResult['warnings'][number]): string {
    return tk(`settings.mcp.edit.warn.${w.kind}`, { detail: w.detail });
  }

  function toggle(id: string) {
    targets = targets.includes(id) ? targets.filter((x) => x !== id) : [...targets, id];
  }
  const addKv = (list: 'env' | 'headers') => { form[list] = [...form[list], { key: '', value: '' }]; };
  const delKv = (list: 'env' | 'headers', i: number) => { form[list] = form[list].filter((_, j) => j !== i); };

  async function preview() {
    tried = true;
    if (errors.length) return;
    const c = change();
    if (!c) { err = t('settings.mcp.edit.noSource'); return; }
    busy = true;
    err = null;
    try {
      plan = await mcpmPlan(c);
      step = 'preview';
    } catch (e) {
      err = String(e);
    } finally {
      busy = false;
    }
  }
  async function apply() {
    const c = change();
    if (!c) return;
    busy = true;
    err = null;
    try {
      result = await mcpmApply(c);
      step = 'result';
      const bad = result.steps.find((r) => r.status === 'failed');
      if (bad) onfocus?.(bad.accountId);
      const fresh = await reload();
      check = relistCheck(c, result.steps, fresh);
    } catch (e) {
      err = String(e);
    } finally {
      busy = false;
    }
  }

  /** Letra de la versión con la que se trabaja (null si la fila no tiene versiones). */
  const letter = $derived(mode.kind === 'add' ? null : ((mode.row as Partial<McpVariant>).letter || null));
  const title = $derived(
    mode.kind === 'add' ? t('settings.mcp.edit.titleAdd')
      : mode.kind === 'remove' ? (letter ? t('mcp.view.ed.titleRemoveV', { name: mode.row.name, l: letter }) : t('settings.mcp.edit.titleRemove', { name: mode.row.name }))
      : mode.replace ? t('mcp.view.ed.titleEqualize', { name: mode.row.name, l: letter ?? 'A' })
      : letter ? t('mcp.view.ed.titleCopyV', { name: mode.row.name, l: letter }) : t('settings.mcp.edit.titleCopy', { name: mode.row.name }),
  );
  /** Vista previa fiel: una entrada por cuenta (también las que no cambian, en Igualar). */
  const entries = $derived.by(() => {
    const c = change();
    return c ? previewEntries(c, plan, accounts, rows, mode.kind === 'add' ? undefined : mode.row) : [];
  });
  const scopeName = (s: string | null) => (s ? tk(`settings.mcp.servers.scope.${s}`) : '');
  /** Lo que seguirá activo tras el cambio (copias local / proyecto) y las del ámbito local que se pueden incluir. */
  const lingers = $derived.by(() => { const c = change(); return c && mode.kind !== 'add' ? lingering(c, accounts, rows, mode.row, includeLocal) : []; });
  const localAvail = $derived.by(() => { const c = change(); return c && mode.kind !== 'add' ? lingering({ ...c, includeLocal: false } as McpChange, accounts, rows, mode.row, false).filter((l) => l.removable) : []; });
  const lingerText = (l: Linger) => { const a = accById(l.accountId); return t(l.letter ? 'mcp.view.lg.staysV' : 'mcp.view.lg.stays', { account: a ? colName(a) : l.accountId, l: l.letter ?? '', path: winPath(l.path), scope: scopeName(l.scope) }); };
  async function toggleLocal() {
    includeLocal = !includeLocal;
    if (step === 'preview') await preview();
  }
  /** Igualar / Aplicar a: de qué cuenta sale el valor de cada secreto (nunca se ve aquí). */
  const secretSrc = $derived.by(() => {
    if (mode.kind !== 'copy') return null;
    const src = rowSource(mode.row, accounts);
    const a = src ? accById(src.accountId) : undefined;
    return src && a ? { account: colName(a), keys: [...src.def.envKeys, ...src.def.headerKeys] } : null;
  });
  /** Vista previa agrupada: el cambio una vez y, debajo, las cuentas (fichero y comando plegado) a las que se aplica. */
  const groups = $derived.by(() => {
    const out: { kind: PreviewEntry['kind']; text: string; json: string | null; entries: PreviewEntry[] }[] = [];
    for (const e of entries) {
      const text = entryText(e);
      let g = out.find((x) => x.kind === e.kind && x.text === text);
      if (!g) out.push((g = { kind: e.kind, text, json: null, entries: [] }));
      g.entries.push(e);
      if (!g.json) g.json = e.lines.map((l) => formatPlanLine(l).json).find(Boolean) ?? null;
    }
    return out;
  });
  /** El aviso «parece un hueco del README» se va en cuanto el campo tiene un valor real. */
  const stillWarn = (w: PasteResult['warnings'][number]) => w.kind !== 'placeholder'
    || form.env.some((e) => e.key.trim() === w.detail && isReadmePlaceholder(e.value))
    || form.headers.some((h) => h.key.trim() === w.detail && isReadmePlaceholder(h.value.replace(/^Bearer\s+/i, '')))
    || (!form.env.some((e) => e.key.trim() === w.detail) && !form.headers.some((h) => h.key.trim() === w.detail) && (ph.args || ph.url));
  const ph = $derived(mode.kind === 'add' ? placeholderFields(form) : { env: [], headers: [], args: false, url: false });
  function entryText(e: PreviewEntry): string {
    switch (e.kind) {
      case 'same': return e.to ? t('mcp.view.pv.sameV', { l: e.to }) : t('mcp.view.pv.same');
      case 'replace': return e.from.length && e.to ? t('mcp.view.pv.replaceV', { from: e.from.join(', '), to: e.to }) : t('mcp.view.pv.replace');
      case 'add': return e.to ? t('mcp.view.pv.addV', { l: e.to, scope: scopeName(e.scope) }) : t('mcp.view.pv.add', { scope: scopeName(e.scope) });
      case 'remove': return e.to ? t('mcp.view.pv.removeV', { l: e.to, scope: scopeName(e.scope) }) : t('mcp.view.pv.remove', { scope: scopeName(e.scope) });
      case 'blocked': return t('mcp.view.pv.blocked', { why: known(e.reason) ?? e.reason ?? '' });
      default: return t('mcp.view.pv.skip', { why: known(e.reason) ?? e.reason ?? '' });
    }
  }
  const failedIds = $derived(result ? result.steps.filter((r) => r.status === 'failed').map((r) => r.accountId) : []);
  /** «Reintentar»: vuelve a aplicar solo en las cuentas que fallaron y junta el resultado. */
  async function retry() {
    const c = change();
    if (!c || !result) return;
    const only = { ...c, targets: failedIds } as McpChange;
    busy = true;
    err = null;
    try {
      const again = await mcpmApply(only);
      const byId = new Map(again.steps.map((r) => [r.accountId, r]));
      result = { steps: result.steps.map((r) => byId.get(r.accountId) ?? r), undoId: again.undoId ?? result.undoId };
      const fresh = await reload();
      check = { ...check, ...relistCheck(only, again.steps, fresh) };
    } catch (e) {
      err = String(e);
    } finally {
      busy = false;
    }
  }
  const fileOf = (id: string) => plan.find((p) => p.accountId === id)?.file ?? '';
  const fieldErr = (k: McpFormError) => shown.includes(k);

  /** Mensajes conocidos de Rust (bloqueos, notas, salida de la CLI) -> frase traducida. El texto crudo va en «Ver detalle». */
  function known(msg: string | null | undefined): string | null {
    const m = msg ?? '';
    if (!m) return null;
    if (/already exists in this account/i.test(m)) return t('settings.mcp.edit.msg.exists');
    const sc = m.match(/Only Claude Code has a (local|project) scope; (Codex|opencode)/);
    if (sc) return t('settings.mcp.edit.msg.scopeOnlyClaude', { scope: tk(`settings.mcp.servers.scopeShort.${sc[1]}`), tool: sc[2] });
    if (/Choose the project folder/i.test(m)) return t('settings.mcp.edit.msg.chooseProject');
    if (/project folder does not exist/i.test(m)) return t('settings.mcp.edit.msg.noProject');
    if (/cannot set HTTP headers/i.test(m)) return t('settings.mcp.edit.msg.codexHeaders');
    if (/working directory \(cwd\)/i.test(m)) return t('settings.mcp.edit.msg.cwd');
    if (/Already there with the same definition/i.test(m)) return t('settings.mcp.edit.msg.same');
    if (/Only in a project \(local scope\)/i.test(m)) return t('settings.mcp.edit.msg.localOnly');
    if (/Not in this account/i.test(m)) return t('settings.mcp.edit.msg.notHere');
    if (/Managed outside/i.test(m)) return t('settings.mcp.edit.msg.managed');
    if (/access is denied|permission denied|os error 5\b/i.test(m)) return t('settings.mcp.edit.msg.denied');
    if (/timed out/i.test(m)) return t('settings.mcp.edit.msg.timeout');
    if (/could not start|not recognized|program not found/i.test(m)) return t('settings.mcp.edit.msg.noCli');
    return null;
  }
  const scopeOf = (id: string) => (mode.kind === 'add' && form.scope !== 'user' ? form.scope : accById(id)?.provider === 'opencode' ? 'global' : 'user');
  /** Frase del resultado de un paso, traducida (la salida cruda de la CLI va en «Ver detalle»). */
  function resultText(r: McpApplyResult['steps'][number]): string {
    const act = plan.find((p) => p.accountId === r.accountId)?.action ?? 'add';
    if (r.status === 'ok') return tk(`settings.mcp.edit.done.${act === 'skip' ? 'add' : act}`, { scope: tk(`settings.mcp.servers.scopeShort.${scopeOf(r.accountId)}`) });
    if (r.status === 'failed') return known(r.msg) ?? t('settings.mcp.edit.msg.failed');
    return known(r.msg) ?? t('settings.mcp.edit.msg.skipped');
  }
  const changeName = () => (mode.kind === 'add' ? form.name.trim() : mode.row.name);
  async function testNow(id: string) {
    tested[id] = 'busy';
    tested[id] = await probeNow(id, changeName()).catch((e) => ({ status: 'error' as const, msg: String(e) }));
  }
  function testText(r: ProbeLike): string {
    if (r.status === 'ok') return t('settings.mcp.servers.st.ok', { n: r.tools });
    if (r.status === 'needsAuth') return t('settings.mcp.servers.st.auth');
    if (r.status === 'timeout') return t('settings.mcp.servers.st.timeout');
    const c = classifyProbeError(r.msg);
    if (c.kind === 'refused' && c.host) return t('settings.mcp.servers.err.refusedAt', { host: c.host });
    return tk(`settings.mcp.servers.err.${c.kind}`, { code: c.code ?? '' });
  }
</script>

<!-- Columna flex: cabecera, cuerpo con scroll y pie (último hijo: nunca tapa campos). -->
{#snippet cmdLine(l: string)}
  {@const f = formatPlanLine(l)}
  <pre class="cmdl">{#each f.head.split(' ') as w, i (i)}{#if i}{' '}{/if}<span class="w">{w}</span>{/each}{#if f.json}<span class="json">{f.json}</span>{/if}{f.tail}</pre>
{/snippet}

<section class="ed" aria-label={title}>
  <header>
    <div class="eh">
      <b>{title}</b>
      <button class="iconbtn" onclick={onclose} aria-label={step === 'result' ? t('settings.mcp.edit.close') : t('settings.mcp.edit.cancel')} title={step === 'result' ? t('settings.mcp.edit.close') : t('settings.mcp.edit.cancel')}>✕</button>
    </div>
    <ol class="steps">
      <li class:on={step === 'edit'}>{t('settings.mcp.edit.stepEdit')}</li>
      <li class:on={step === 'preview'}>{t('settings.mcp.edit.stepPreview')}</li>
      <li class:on={step === 'result'}>{t('settings.mcp.edit.stepResult')}</li>
    </ol>
  </header>

  <div class="ebody">
  {#if step === 'edit'}
    {#if mode.kind !== 'add'}
      {@const d = mode.row.def}
      <p class="src"><code>{d.url ?? [d.command, ...d.args].join(' ')}</code>{#if d.envKeys.length || d.headerKeys.length}<code>{[...d.envKeys, ...d.headerKeys].map((k) => `${k}=•••`).join(' ')}</code>{/if}</p>
    {/if}
    <!-- Cuentas destino lo primero: se ven sin desplazar. -->
    <div class="targets">
      <span class="lbl">{mode.kind === 'remove' ? t('settings.mcp.edit.targetsRemove') : t('settings.mcp.edit.targets')}</span>
      <div class="tl">
        {#each accounts as a (a.id)}
          <label class="tg acc"><input type="checkbox" checked={targets.includes(a.id)} onchange={() => toggle(a.id)} /><span class="tn">{colName(a)}</span><small>{providerLabel(a.provider)}{a.isDefault && a.provider !== 'opencode' ? ` · ${t('settings.mcp.servers.defaultTag')}` : ''}</small></label>
        {/each}
      </div>
      {#if fieldErr('targets')}<small class="bad">{t('settings.mcp.edit.err.targets')}</small>{/if}
      {#if mode.kind === 'add'}
        <!-- Aparte de la rejilla de cuentas: es una opción del cambio, no una cuenta más. -->
        <div class="repl"><label class="tg"><input type="checkbox" bind:checked={replace} /><span>{t('settings.mcp.edit.replace')}</span></label></div>
      {/if}
      {#if mode.kind === 'copy'}<p class="note">{t('settings.mcp.edit.copyNote')}</p>{/if}
    </div>
    {#if mode.kind === 'add'}
      <div class="paste">
        <button class="btn tiny toggle" onclick={() => (showPaste = !showPaste)} aria-expanded={showPaste}>{showPaste ? '▾' : '▸'} {t('settings.mcp.edit.pasteLabel')}</button>
        {#if showPaste}
          <textarea rows="3" spellcheck="false" bind:value={paste} placeholder={t('settings.mcp.edit.pastePlaceholder')}></textarea>
          <div class="row">
            <button class="btn" onclick={analyse} disabled={!paste.trim()}>{t('settings.mcp.edit.pasteAnalyse')}</button>
            <small>{t('settings.mcp.edit.pasteHint')}</small>
          </div>
          {#if pasted}
            {#if pasted.drafts.length}
              <p class="ok">{pasted.drafts.length === 1 ? t('settings.mcp.edit.pasteFoundOne', { source: tk(`settings.mcp.edit.source.${pasted.source}`) }) : t('settings.mcp.edit.pasteFound', { n: pasted.drafts.length, source: tk(`settings.mcp.edit.source.${pasted.source}`) })}</p>
              {#if pasted.drafts.length > 1}
                <div class="chips">
                  {#each pasted.drafts as d, i (i)}
                    <button class="chip" class:on={pastedPick === i} onclick={() => pick(i)}>{d.name || t('settings.mcp.edit.noName')}</button>
                  {/each}
                </div>
              {/if}
            {:else}
              <p class="bad">{t('settings.mcp.edit.pasteNothing')}</p>
            {/if}
            {#if pasted.unknown.length}
              <p class="warn">⚠ {t('settings.mcp.edit.pasteUnknown')} {#each pasted.unknown as u (u)}<code class="kv">{u}</code>{/each}</p>
            {/if}
            {#each pasted.warnings.filter(stillWarn) as w, i (i)}{#if w.kind === 'ignored'}<p class="muted">{warnText(w)}</p>{:else}<p class="warn">⚠ {warnText(w)}</p>{/if}{/each}
          {/if}
        {/if}
      </div>

      <div class="grid">
        <label for="mcp-ed-name">{t('settings.mcp.edit.name')}</label>
        <div><input id="mcp-ed-name" bind:value={form.name} spellcheck="false" class:invalid={fieldErr('name')} onblur={touch('name')} />
          {#if fieldErr('name')}<small class="bad">{t('settings.mcp.edit.err.name')}</small>{/if}</div>

        <span class="lbl">{t('settings.mcp.edit.transport')}</span>
        <div class="seg" role="radiogroup" aria-label={t('settings.mcp.edit.transport')}>
          {#each ['stdio', 'http', 'sse'] as tr (tr)}
            <button role="radio" aria-checked={form.transport === tr} class:on={form.transport === tr} onclick={() => (form.transport = tr as McpForm['transport'])}>{tk(`settings.mcp.edit.tr.${tr}`)}</button>
          {/each}
        </div>

        {#if form.transport === 'stdio'}
          <label for="mcp-ed-cmd">{t('settings.mcp.edit.command')}</label>
          <div><input id="mcp-ed-cmd" bind:value={form.command} spellcheck="false" placeholder="npx" class:invalid={fieldErr('command')} onblur={touch('command')} /> <!-- i18n-ignore -->
            {#if fieldErr('command')}<small class="bad">{t('settings.mcp.edit.err.command')}</small>{/if}</div>
          <label for="mcp-ed-args">{t('settings.mcp.edit.args')}</label>
          <div><textarea id="mcp-ed-args" rows={Math.max(2, form.argsText.split('\n').length)} spellcheck="false" bind:value={form.argsText} class:invalid={ph.args}></textarea>
            {#if ph.args}<small class="bad">{t('mcp.view.ed.placeholder')}</small>{/if}<small>{t('settings.mcp.edit.argsHint')}</small></div>
          <span class="lbl">{t('settings.mcp.edit.env')}</span>
          <div class="kvs">
            {#each form.env as kv, i (i)}
              <div class="kvrow">
                <input bind:value={kv.key} placeholder={t('settings.mcp.edit.varName')} spellcheck="false" class:invalid={fieldErr('envKey') && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(kv.key.trim())} onblur={touch('envKey')} />
                <input type="password" bind:value={kv.value} placeholder={t('settings.mcp.edit.value')} autocomplete="off" class:invalid={ph.env.includes(i)} aria-invalid={ph.env.includes(i)} />
                <button class="btn ghost tiny" onclick={() => delKv('env', i)} aria-label={t('settings.mcp.edit.removeRow')}>✕</button>
              </div>
            {/each}
            {#if ph.env.length}<small class="bad">{t('mcp.view.ed.placeholder')}</small>{/if}
            <button class="btn tiny" onclick={() => addKv('env')}>+ {t('settings.mcp.edit.addVar')}</button>
          </div>
        {:else}
          <label for="mcp-ed-url">{t('settings.mcp.edit.url')}</label>
          <div><input id="mcp-ed-url" bind:value={form.url} spellcheck="false" placeholder="https://…/mcp" class:invalid={fieldErr('url') || ph.url} onblur={touch('url')} />
            {#if ph.url}<small class="bad">{t('mcp.view.ed.placeholder')}</small>{/if}
            {#if fieldErr('url')}<small class="bad">{t('settings.mcp.edit.err.url')}</small>{/if}</div>
          <span class="lbl">{t('settings.mcp.edit.headers')}</span>
          <div class="kvs">
            {#each form.headers as kv, i (i)}
              <div class="kvrow">
                <input bind:value={kv.key} placeholder={t('settings.mcp.edit.headerName')} spellcheck="false" class:invalid={fieldErr('headerKey')} onblur={touch('headerKey')} />
                <input type="password" bind:value={kv.value} placeholder={t('settings.mcp.edit.value')} autocomplete="off" class:invalid={ph.headers.includes(i)} aria-invalid={ph.headers.includes(i)} />
                <button class="btn ghost tiny" onclick={() => delKv('headers', i)} aria-label={t('settings.mcp.edit.removeRow')}>✕</button>
              </div>
            {/each}
            {#if ph.headers.length}<small class="bad">{t('mcp.view.ed.placeholder')}</small>{/if}
            <button class="btn tiny" onclick={() => addKv('headers')}>+ {t('settings.mcp.edit.addHeader')}</button>
          </div>
          <label for="mcp-ed-bearer">{t('settings.mcp.edit.bearer')}</label>
          <div><input id="mcp-ed-bearer" bind:value={form.bearerEnvVar} spellcheck="false" placeholder="MY_TOKEN" class:invalid={fieldErr('bearer')} onblur={touch('bearer')} /> <!-- i18n-ignore --><small>{t('settings.mcp.edit.bearerHint')}</small></div>
        {/if}

        <span class="lbl">{t('settings.mcp.edit.scope')}</span>
        <div>
          <div class="seg" role="radiogroup" aria-label={t('settings.mcp.edit.scope')}>
            {#each ['user', 'local', 'project'] as sc (sc)}
              <button role="radio" aria-checked={form.scope === sc} class:on={form.scope === sc} onclick={() => { form.scope = sc as McpForm['scope']; if (sc !== 'user' && !form.project) form.project = projects[0] ?? ''; }}>{tk(`settings.mcp.servers.scope.${sc}`)}</button>
            {/each}
          </div>
          <small>{tk(`settings.mcp.edit.scopeHint.${form.scope}`)}</small>
        </div>
        {#if form.scope !== 'user'}
          <label for="mcp-ed-proj">{t('settings.mcp.edit.project')}</label>
          <div><input id="mcp-ed-proj" bind:value={form.project} list="mcp-ed-projs" spellcheck="false" placeholder="C:\Dev\app" class:invalid={fieldErr('project')} onblur={touch('project')} /> <!-- i18n-ignore -->
            <datalist id="mcp-ed-projs">{#each projects as p (p)}<option value={p}></option>{/each}</datalist>
            {#if projects.length}<div class="chips" role="radiogroup" aria-label={t('settings.mcp.edit.project')}>{#each projects as p (p)}<button class="chip" role="radio" aria-checked={form.project === p} class:on={form.project === p} onclick={() => (form.project = p)}>{p}</button>{/each}</div>{/if}
            <small>{tk(`mcp.view.ed.projectHint.${form.scope}`, { path: form.project || '…' })}</small>
            {#if fieldErr('project')}<small class="bad">{t('settings.mcp.edit.err.project')}</small>{/if}</div>
        {/if}
      </div>
      <p class="note">{t('settings.mcp.edit.secretsNote')}</p>
    {/if}
  {:else if step === 'preview'}
    <p class="note">{t('settings.mcp.edit.previewIntro')}</p>
    {#if secretSrc && secretSrc.keys.length}
      <ul class="secrets">{#each secretSrc.keys as k (k)}<li><code class="kv">{k}</code> {t('mcp.view.ed.secretFrom', { account: secretSrc.account })}</li>{/each}</ul>
    {/if}
    <ul class="plan">
      {#each groups as g, gi (gi)}
        <li class="k-{g.kind}">
          <div class="ph"><span class="act {g.kind}">{tk(`mcp.view.pv.tag.${g.kind}`)}</span> <b class="what">{g.text}</b></div>
          {#if g.json}<pre class="cmdc">{g.json}</pre>{/if}
          <ul class="accs">
            {#each g.entries as e (e.accountId)}
              <li>
                <div><b>{accName(e.accountId)}</b>{#if e.file && (e.kind === 'remove' || e.kind === 'replace' || e.kind === 'add')}{' '}<span class="muted">· {e.file}</span>{/if}</div>
                {#each e.keeps as k (k.scope + (k.projectPath ?? ''))}
                  {@const lg = lingers.find((l) => l.accountId === e.accountId && l.scope === k.scope && l.path === (k.projectPath ?? ''))}
                  {@const gone = !lg && includeLocal && k.scope === 'local' && localAvail.some((l) => l.accountId === e.accountId && l.path === (k.projectPath ?? ''))}
                  {#if lg}<p class="warn">⚠ {lingerText(lg)}</p>
                  {:else if gone}<p class="muted">{t('mcp.view.lg.removedToo', { path: winPath(k.projectPath ?? '') })}</p>
                  {:else}<p class="muted">{t('mcp.view.pv.keeps', { scope: scopeName(k.scope), path: winPath(k.projectPath ?? '') })}</p>{/if}
                {/each}
                {#if e.lines.length}
                  <details class="cmds"><summary>{tn('mcp.view.pv.showCmd', e.lines.length)}</summary>{#each e.lines as l (l)}{@render cmdLine(l)}{/each}</details>
                {/if}
                {#if e.reason && known(e.reason)}
                  <details class="raw"><summary>{t('settings.mcp.servers.err.showDetail')}</summary><pre>{e.reason}</pre></details>
                {/if}
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {:else if result}
    <ul class="plan">
      {#each result.steps as r (r.accountId)}
        <li class="k-{r.status}">
          <div class="ph"><b>{accName(r.accountId)}</b>
            <!-- Un solo estado principal (hecho / falló; «hecho» que luego no aparece en la lista cuenta como fallo) y,
                 debajo, uno de prueba. -->
            {#if r.status === 'ok' && check[r.accountId] === false}
              <span class="act blocked" title={t('settings.mcp.edit.checkBad')}>{t('settings.mcp.edit.checkBad')}</span>
            {:else}
              <span class="act {r.status === 'ok' ? 'add' : r.status === 'failed' ? 'blocked' : 'skip'}" title={r.status === 'ok' && check[r.accountId] ? t('settings.mcp.edit.checkOk') : undefined}>{tk(`settings.mcp.edit.res.${r.status}`)}</span>
            {/if}
          </div>
          <p class:bad={r.status === 'failed'} class:muted={r.status !== 'failed'}>{resultText(r)}</p>
          {#if r.status === 'failed'}
            <div class="row">
              <button class="btn tiny" disabled={busy} title={t('mcp.view.res.retryTitle')} onclick={() => void retry()}>{busy ? t('settings.mcp.edit.applying') : t('mcp.view.res.retry')}</button>
              {#if fileOf(r.accountId)}<button class="btn tiny" title={t('mcp.view.res.openTitle', { file: fileOf(r.accountId) })} onclick={() => void mcpmReveal(r.accountId)}>{t('mcp.view.res.open')}</button>{/if}
            </div>
          {/if}
          {#if r.status === 'ok' && mode.kind !== 'remove'}
            {@const tr = tested[r.accountId]}
            <div class="row">
              <button class="btn tiny" disabled={tr === 'busy'} onclick={() => void testNow(r.accountId)}>{tr === 'busy' ? t('settings.mcp.servers.probing') : t('settings.mcp.edit.probeNow')}</button>
              {#if tr === 'busy'}<span class="muted"><span class="spinner" aria-hidden="true"></span>{t('mcp.view.res.probing')}</span>
              {:else if tr}<span class={tr.status === 'ok' ? 'ok' : tr.status === 'failed' || tr.status === 'error' ? 'bad' : 'warn'}>{testText(tr)}</span>
              {:else if tr === null}<span class="muted">{t('settings.mcp.edit.probeNotFound')}</span>
              {:else}<span class="muted">{t('mcp.view.res.notProbed')}</span>{/if}
            </div>
          {/if}
          {#if r.msg}<details class="raw"><summary>{t('settings.mcp.servers.err.showDetail')}</summary><pre>{r.msg}</pre></details>{/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if err}<p class="s-msg err" role="alert">{err}</p>{/if}
  </div>

  <footer class="efoot">
    {#if step !== 'edit' && (lingers.length || (step === 'preview' && localAvail.length))}
      <div class="linger" role="status">
        {#if lingers.length}
          <!-- El detalle va en la tarjeta de cada cuenta; aquí solo el resumen (sin repetir la frase). -->
          <p class="warn"><b>{t('mcp.view.lg.partial')}</b> {tn('mcp.view.lg.partialN', new Set(lingers.map((l) => l.accountId)).size)}</p>
        {/if}
        {#if step === 'preview' && localAvail.length}
          <label class="tg"><input type="checkbox" checked={includeLocal} disabled={busy} onchange={() => void toggleLocal()} /><span>{tn('mcp.view.lg.include', localAvail.length)}</span></label>
        {/if}
        {#if lingers.some((l) => !l.removable)}<p class="muted">{t('mcp.view.lg.projectWhy')}</p>{/if}
      </div>
    {/if}
    {#if step === 'edit'}
      <button class="btn" onclick={onclose}>{t('settings.mcp.edit.cancel')}</button>
      <button class="btn primary" onclick={() => void preview()} disabled={busy || errors.includes('placeholder')} title={errors.includes('placeholder') ? t('mcp.view.ed.placeholderBlock') : undefined}>{busy ? t('settings.mcp.edit.planning') : t('settings.mcp.edit.preview')}</button>
    {:else if step === 'preview'}
      <span class="sum">{tn('mcp.view.plan.apply', entries.filter((e) => e.kind === 'add' || e.kind === 'replace' || e.kind === 'remove').length)} · {tn('mcp.view.plan.skip', entries.filter((e) => e.kind === 'same' || e.kind === 'skip').length)} · {tn('mcp.view.plan.blocked', entries.filter((e) => e.kind === 'blocked').length)}</span>
      <button class="btn" onclick={onclose} disabled={busy}>{t('settings.mcp.edit.cancel')}</button>
      <button class="btn" onclick={() => (step = 'edit')} disabled={busy}>{t('settings.mcp.edit.back')}</button>
      <button class="btn primary" onclick={() => void apply()} disabled={busy || !canApply(plan)}>{busy ? t('settings.mcp.edit.applying') : t('settings.mcp.edit.apply')}</button>
    {:else if result}
      {@const rs = resultSummary(result.steps)}
      <span class="sum">{tn('mcp.view.res.ok', rs.ok)} · {tn('mcp.view.res.failed', rs.failed)} · {tn('mcp.view.res.skipped', rs.skipped)}{#if result.undoId}{' · '}{t('settings.mcp.edit.undoHint')}{/if}</span>
      <button class="btn primary" onclick={onclose}>{t('settings.mcp.edit.close')}</button>
    {/if}
  </footer>
</section>

<style>
  .ed { --muted: #8b939e; min-width: 0; height: 100%; display: flex; flex-direction: column; min-height: 0; background: var(--panel); font-size: 13px; }
  header { flex: none; padding: 10px 14px 8px; border-bottom: 1px solid var(--border); display: grid; gap: 4px; }
  .eh { display: flex; align-items: flex-start; gap: 10px; justify-content: space-between; }
  .eh b { font-size: 14px; overflow-wrap: anywhere; }
  .steps { display: flex; gap: 6px; margin: 0; padding: 0; list-style: none; color: var(--muted); font-size: 11.5px; }
  .steps li::after { content: '›'; margin-left: 6px; }
  .steps li:last-child::after { content: ''; }
  .steps li.on { color: var(--text); font-weight: 600; }
  .ebody { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 10px 14px 14px; }
  .efoot { flex: none; display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: wrap; padding: 10px 14px; border-top: 1px solid var(--border); background: var(--panel); }
  .efoot .sum { margin-right: auto; color: var(--muted); font-size: 12px; }
  .linger { flex: 1 1 100%; display: grid; gap: 4px; padding: 6px 8px; border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--warn) 7%, var(--panel)); font-size: 12.5px; }
  .linger p { margin: 0; }
  .secrets { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 2px; color: var(--muted); font-size: 12px; }
  .accs { list-style: none; margin: 6px 0 0; padding: 0 0 0 10px; display: grid; gap: 6px; border-left: 2px solid var(--border); }
  .accs li { min-width: 0; overflow-wrap: anywhere; }
  .cmds summary { cursor: pointer; color: var(--muted); font-size: 12px; width: max-content; }
  .cmdc { padding: 6px 8px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; white-space: pre-wrap; overflow-wrap: break-word; }
  textarea.invalid { border-color: var(--bad); }
  input.invalid, textarea.invalid { box-shadow: 0 0 0 1px var(--bad); }
  .paste { margin: 12px 0 10px; }
  .paste textarea { width: 100%; margin-top: 6px; font: 12px 'Cascadia Mono', Consolas, monospace; }
  .row { display: flex; align-items: center; gap: 10px; margin-top: 6px; flex-wrap: wrap; }
  .row small, .grid small { color: var(--muted); font-size: 12px; display: block; margin-top: 2px; }
  .grid { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 7px 12px; align-items: start; }
  .grid label, .grid .lbl, .targets .lbl { color: var(--muted); padding-top: 4px; font-size: 12.5px; }
  .grid input, .grid textarea { width: 100%; }
  .grid textarea { font: 12px 'Cascadia Mono', Consolas, monospace; field-sizing: content; min-height: 2.6em; resize: vertical; }
  input.invalid { border-color: var(--bad); }
  .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 6px; overflow: hidden; width: max-content; max-width: 100%; flex-wrap: wrap; }
  .seg button { padding: 3px 10px; font-size: 12px; color: var(--muted); white-space: nowrap; }
  .seg button.on { background: var(--raise); color: var(--text); box-shadow: inset 0 0 0 1px var(--muted); }
  .kvs { display: grid; gap: 4px; }
  .kvrow { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 4px; }
  .kvs > .btn { justify-self: start; }
  .chips { display: flex; gap: 4px; flex-wrap: wrap; margin: 4px 0; }
  .chip { padding: 1px 8px; border: 1px solid var(--border-strong); border-radius: 10px; font-size: 11.5px; color: var(--muted); }
  .chip.on { border-color: var(--muted); background: var(--raise); color: var(--text); }
  .targets { display: grid; gap: 6px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
  .tl { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px 14px; }
  .tg.acc { display: grid; grid-template-columns: auto minmax(0, max-content) auto; align-items: baseline; column-gap: 6px; }
  .tg.acc input { align-self: center; }
  .tg.acc .tn { font-weight: 600; white-space: nowrap; overflow-wrap: normal; }
  .tg.acc small { white-space: nowrap; }
  .repl { margin-top: 4px; padding-top: 8px; border-top: 1px solid var(--border); }
  .tg { display: inline-flex; gap: 6px; align-items: flex-start; min-width: 0; }
  .tg span { overflow-wrap: anywhere; }
  .tg small { color: var(--muted); }
  .plan { list-style: none; margin: 8px 0 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .plan li { min-width: 0; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; background: var(--bg); }
  .plan li.k-blocked, .plan li.k-failed { border-color: color-mix(in srgb, var(--bad) 45%, transparent); }
  .plan li.k-same, .plan li.k-skip, .plan li.k-skipped { border-style: dashed; }
  .ph { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .what { color: var(--text); }
  .act { white-space: nowrap; font-size: 11px; padding: 0 6px; border-radius: 9px; border: 1px solid var(--border-strong); color: var(--muted); }
  .act.add, .act.replace { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
  .act.remove, .act.blocked { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, transparent); }
  /* Comandos: siempre con salto de línea, sin scroll horizontal. Cada palabra va entera si cabe (no se parte en los
     guiones); si no cabe en la línea, se parte donde haga falta. El JSON va formateado. */
  pre { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 'Cascadia Mono', Consolas, monospace; color: var(--text); user-select: text; }
  .cmdl { padding: 6px 8px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; }
  .cmdl .w { display: inline-block; max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; vertical-align: top; }
  .cmdl .json { display: block; padding-left: 12px; }
  .raw { margin-top: 4px; }
  .raw summary { cursor: pointer; color: var(--muted); font-size: 12px; width: max-content; }
  .raw pre { color: var(--muted); padding: 6px 8px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; }
  .spinner { display: inline-block; width: 9px; height: 9px; margin-right: 5px; border: 2px solid var(--border-strong); border-top-color: var(--text); border-radius: 50%; animation: edspin 0.8s linear infinite; }
  @keyframes edspin { to { transform: rotate(360deg); } }
  p { margin: 4px 0 0; }
  .src { margin: 0 0 10px; display: grid; gap: 2px; }
  .src code, code.kv { font: 12px 'Cascadia Mono', Consolas, monospace; margin-right: 6px; color: var(--text); overflow-wrap: anywhere; }
  .ok { color: var(--ok); }
  .warn { color: var(--warn); }
  .bad { color: var(--bad); }
  .muted { color: var(--muted); font-size: 12px; }
  .note { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
  .btn.tiny { padding: 1px 6px; font-size: 11px; white-space: nowrap; }
</style>
