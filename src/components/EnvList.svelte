<script lang="ts">
  // Lista NOMBRE = valor de variables de entorno propias (Ajustes → Agentes y cada cuenta). Cada fila dice si no se aplica y por qué.
  import { envIssues } from '../lib/agentenv.ts';
  import type { EnvRow } from '../lib/agentenv.ts';
  import { t, tk } from '../lib/i18n.ts';

  let { rows, onchange, label }: { rows: readonly EnvRow[]; onchange: (rows: EnvRow[]) => void; label: string } = $props();

  const issues = $derived(envIssues(rows));
  const copy = () => rows.map((r) => ({ key: r.key, value: r.value }));
  function edit(i: number, field: 'key' | 'value', v: string) {
    const next = copy();
    // Pegar «NOMBRE=valor» en el nombre lo reparte entre las dos casillas.
    const eq = field === 'key' ? v.indexOf('=') : -1;
    next[i] = eq >= 0 ? { key: v.slice(0, eq).trim(), value: v.slice(eq + 1) } : { ...next[i], [field]: v };
    onchange(next);
  }
  function del(i: number) { const next = copy(); next.splice(i, 1); onchange(next); }
  function add() { onchange([...copy(), { key: '', value: '' }]); }
</script>

<div class="envs" role="group" aria-label={label}>
  {#each rows as r, i (i)}
    {@const issue = issues[i]}
    <div class="env-row">
      <input class="k" value={r.key} placeholder={t('settings.agents.env.name')} spellcheck="false" autocomplete="off"
        aria-label={t('settings.agents.env.name')} class:invalid={!!issue} aria-invalid={!!issue}
        oninput={(e) => edit(i, 'key', e.currentTarget.value)} />
      <span class="eq">=</span>
      <input class="v" value={r.value} placeholder={t('settings.agents.env.value')} spellcheck="false" autocomplete="off"
        aria-label={t('settings.agents.env.value')} oninput={(e) => edit(i, 'value', e.currentTarget.value)} />
      <button type="button" class="btn ghost tiny" onclick={() => del(i)} aria-label={t('settings.agents.env.remove')} title={t('settings.agents.env.remove')}>✕</button>
    </div>
    {#if issue}<small class="bad">{tk(`settings.agents.env.issue.${issue}`)}</small>{/if}
  {/each}
  <div><button type="button" class="btn tiny" onclick={add}>+ {t('settings.agents.env.add')}</button></div>
</div>

<style>
  .envs { display: flex; flex-direction: column; gap: 5px; width: 100%; }
  .env-row { display: flex; align-items: center; gap: 6px; }
  .env-row input { font-family: var(--mono, monospace); font-size: 12px; min-width: 0; }
  .env-row .k { flex: 0 1 46%; }
  .env-row .v { flex: 1 1 54%; }
  .env-row input.invalid { border-color: var(--bad); }
  .eq { color: var(--muted); flex: none; }
  .bad { color: var(--bad); font-size: 11.5px; }
  .tiny { padding: 2px 8px; font-size: 11.5px; flex: none; }
</style>
