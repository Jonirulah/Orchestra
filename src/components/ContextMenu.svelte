<script lang="ts">
  // Menú contextual único de la app (montado una vez en App.svelte). Quien lo quiere abrir llama a ctxmenu.openFromEvent(...).
  import { tick, untrack } from 'svelte';
  import { ctxmenu } from '../lib/ctxmenu.svelte.ts';
  import { CONFIRM_MS, activate, clampPosition, firstEnabled, isEnabled, moveActive, placeSubmenu } from '../lib/ctxmenu.ts';
  import type { MenuItem } from '../lib/ctxmenu.ts';
  import { t } from '../lib/i18n.ts';
  import Icon from './Icon.svelte';

  const m = $derived(ctxmenu.current);

  let rootEl = $state<HTMLDivElement>();
  let subEl = $state<HTMLDivElement>();
  let pos = $state<{ x: number; y: number } | null>(null);
  let subPos = $state<{ x: number; y: number } | null>(null);
  let active = $state(-1);
  let subIdx = $state<number | null>(null);
  let subActive = $state(-1);
  let armed = $state<string | null>(null);
  let armTimer: number | undefined;
  let subTimer: number | undefined;

  const subItems = $derived(m && subIdx !== null ? (m.items[subIdx]?.children ?? []) : []);

  const q = (el: HTMLElement | undefined, i: number) => el?.querySelector<HTMLElement>(`[data-i="${i}"]`) ?? null;
  const focusItem = (el: HTMLElement | undefined, i: number) => q(el, i)?.focus({ preventScroll: true });
  const gutter = (items: MenuItem[]) => items.some((i) => i.swatch || i.checked !== undefined);

  // Cada apertura nueva (seq) reinicia el estado y coloca el menú dentro de la ventana.
  // Se mide primero en (0,0) y oculto: un elemento fixed pegado al borde se encogería y daría un ancho falso.
  $effect(() => {
    const cur = m;
    if (!cur) return;
    untrack(() => {
      pos = null; subPos = null; subIdx = null; subActive = -1; armed = null;
      active = cur.keyboard ? firstEnabled(cur.items) : -1;
    });
    void tick().then(async () => {
      if (!rootEl || ctxmenu.current !== cur) return;
      const r = rootEl.getBoundingClientRect();
      pos = clampPosition(cur.x, cur.y, r.width, r.height, window.innerWidth, window.innerHeight);
      await tick(); // el foco no entra en un elemento con visibility:hidden: hay que esperar a que se pinte visible
      if (ctxmenu.current !== cur) return;
      if (cur.keyboard && active >= 0) focusItem(rootEl, active); else rootEl.focus({ preventScroll: true });
    });
  });

  function close(restoreFocus: boolean) {
    const back = m?.returnTo;
    clearTimeout(armTimer);
    clearTimeout(subTimer);
    ctxmenu.close();
    if (restoreFocus && back && document.contains(back)) back.focus({ preventScroll: true });
  }

  const inside = (t: EventTarget | null) => !!t && t instanceof Node && (!!rootEl?.contains(t) || !!subEl?.contains(t));

  // Cierres: clic fuera, otro clic derecho, scroll / rueda, perder el foco la ventana, cambiar de tamaño.
  $effect(() => {
    if (!m) return;
    const o = { capture: true } as const;
    const onDown = (e: Event) => { if (!inside(e.target)) close(false); };
    const onCtx = (e: Event) => { if (inside(e.target)) e.preventDefault(); else ctxmenu.close(); };
    // El terminal hace scroll solo al llegar salida: eso no cierra el menú (la rueda sí).
    const onScroll = (e: Event) => {
      const el = e.target as Element | null;
      if (inside(el) || el?.closest?.('.xterm')) return;
      close(false);
    };
    const onWheel = (e: Event) => { if (!inside(e.target)) close(false); };
    const onGone = () => close(false);
    window.addEventListener('pointerdown', onDown, o);
    window.addEventListener('contextmenu', onCtx, o);
    window.addEventListener('scroll', onScroll, o);
    window.addEventListener('wheel', onWheel, { capture: true, passive: true });
    window.addEventListener('blur', onGone);
    window.addEventListener('resize', onGone);
    window.addEventListener('keydown', onKey, o);
    return () => {
      window.removeEventListener('pointerdown', onDown, o);
      window.removeEventListener('contextmenu', onCtx, o);
      window.removeEventListener('scroll', onScroll, o);
      window.removeEventListener('wheel', onWheel, o);
      window.removeEventListener('blur', onGone);
      window.removeEventListener('resize', onGone);
      window.removeEventListener('keydown', onKey, o);
    };
  });

  function openSub(i: number, byKey: boolean) {
    if (!m) return;
    const it = m.items[i];
    if (!it?.children?.length || !isEnabled(it)) return;
    clearTimeout(subTimer);
    if (subIdx === i && subPos) { if (byKey) { subActive = firstEnabled(subItems); focusItem(subEl, subActive); } return; }
    subIdx = i; subPos = null; subActive = byKey ? firstEnabled(it.children) : -1;
    void tick().then(async () => {
      const row = q(rootEl, i);
      if (!row || !subEl || subIdx !== i) return;
      const r = row.getBoundingClientRect();
      const s = subEl.getBoundingClientRect();
      const p = placeSubmenu(r, s.width, s.height, window.innerWidth, window.innerHeight);
      subPos = { x: p.x, y: p.y };
      if (byKey) { await tick(); focusItem(subEl, subActive); }
    });
  }
  function closeSub(refocus: boolean) {
    const i = subIdx;
    clearTimeout(subTimer);
    subIdx = null; subPos = null; subActive = -1;
    if (refocus && i !== null) { active = i; focusItem(rootEl, i); }
  }

  function choose(it: MenuItem, i: number, lvl: 0 | 1) {
    const a = activate(it, armed);
    armed = a.armed;
    if (a.kind === 'arm') {
      clearTimeout(armTimer);
      armTimer = window.setTimeout(() => (armed = null), CONFIRM_MS);
    } else if (a.kind === 'sub') {
      if (lvl === 0) openSub(i, false);
    } else if (a.kind === 'run') {
      close(true);
      it.run?.();
    }
  }

  function onKey(e: KeyboardEvent) {
    if (!m) return;
    const inSub = subIdx !== null;
    const items = inSub ? subItems : m.items;
    const cur = inSub ? subActive : active;
    const set = (i: number) => {
      if (inSub) subActive = i; else active = i;
      focusItem(inSub ? subEl : rootEl, i);
    };
    const swallow = () => { e.preventDefault(); e.stopPropagation(); };
    switch (e.key) {
      case 'Escape': swallow(); if (inSub) closeSub(true); else close(true); return;
      case 'ArrowDown': case 'ArrowUp': case 'Home': case 'End': {
        swallow();
        const n = moveActive(items, cur, e.key);
        if (n >= 0) set(n);
        return;
      }
      case 'ArrowRight': swallow(); if (!inSub && cur >= 0) openSub(cur, true); return;
      case 'ArrowLeft': swallow(); if (inSub) closeSub(true); return;
      case 'Enter': case ' ': {
        swallow();
        const it = items[cur];
        if (it) {
          if (it.children?.length && !inSub) openSub(cur, true);
          else choose(it, cur, inSub ? 1 : 0);
        }
        return;
      }
      case 'Tab': close(true); swallow(); return;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          // Escribir la inicial salta al siguiente elemento que empiece por ella.
          swallow();
          const ch = e.key.toLowerCase();
          const n = items.length;
          for (let k = 1; k <= n; k++) {
            const j = ((cur < 0 ? -1 : cur) + k + n) % n;
            if (isEnabled(items[j]) && items[j].label.toLowerCase().startsWith(ch)) { set(j); break; }
          }
        } else if (!['Shift', 'Control', 'Alt', 'Meta', 'ContextMenu'].includes(e.key)) {
          close(false); // un atajo cualquiera: se cierra el menú y la tecla sigue su camino
        }
    }
  }

  function hover(e: PointerEvent, i: number, lvl: 0 | 1) {
    const el = e.currentTarget as HTMLElement;
    if (lvl === 1) { subActive = i; clearTimeout(subTimer); el.focus({ preventScroll: true }); return; }
    active = i; subActive = -1;
    el.focus({ preventScroll: true });
    const it = m?.items[i];
    if (it?.children?.length && isEnabled(it)) openSub(i, false);
    else if (subIdx !== null) {
      // Un pequeño retardo: así se puede cruzar en diagonal de la fila al submenú sin que se cierre.
      clearTimeout(subTimer);
      subTimer = window.setTimeout(() => closeSub(false), 220);
    }
  }
</script>

{#snippet rows(items: MenuItem[], lvl: 0 | 1, cur: number)}
  {@const gut = gutter(items)}
  {#each items as it, i (it.id)}
    {#if it.separator}
      <div class="sep" role="separator"></div>
    {:else}
      {@const isArmed = !!it.confirm && armed === it.id}
      <button type="button" class="mi" class:on={cur === i || (lvl === 0 && subIdx === i)} class:danger={it.danger} class:armed={isArmed}
        role={it.checked !== undefined ? 'menuitemradio' : 'menuitem'} aria-checked={it.checked}
        aria-disabled={it.disabled ? 'true' : undefined} aria-haspopup={it.children?.length ? 'menu' : undefined}
        aria-expanded={it.children?.length ? subIdx === i : undefined}
        data-i={i} tabindex="-1"
        onpointerenter={(e) => hover(e, i, lvl)} onclick={() => choose(it, i, lvl)}>
        {#if gut}
          <span class="gut">
            {#if it.swatch}<span class="sw" style:background={it.swatch}></span>{:else if it.checked}<Icon name="check" size={12} />{/if}
          </span>
        {/if}
        <span class="lbl">
          <span class="l" class:hide={isArmed}>{it.label}</span>
          {#if it.confirm}<span class="l" class:hide={!isArmed} aria-hidden={!isArmed}>{it.confirm}</span>{/if}
        </span>
        {#if it.hint}<span class="hint">{it.hint}</span>{/if}
        {#if it.checked && it.swatch}<span class="tick"><Icon name="check" size={12} /></span>{/if}
        {#if it.children?.length}<span class="chev"><Icon name="right" size={11} /></span>{/if}
      </button>
    {/if}
  {/each}
{/snippet}

{#if m}
  {#key m.seq}
    <div class="cm" role="menu" aria-label={t('ctx.menuAria')} tabindex="-1" bind:this={rootEl}
      style:left="{pos?.x ?? 0}px" style:top="{pos?.y ?? 0}px" style:visibility={pos ? 'visible' : 'hidden'}
      oncontextmenu={(e) => e.preventDefault()}>
      {@render rows(m.items, 0, active)}
    </div>
    {#if subIdx !== null && subItems.length}
      <div class="cm sub" role="menu" aria-label={m.items[subIdx]?.label} tabindex="-1" bind:this={subEl}
        style:left="{subPos?.x ?? 0}px" style:top="{subPos?.y ?? 0}px" style:visibility={subPos ? 'visible' : 'hidden'}
        onpointerenter={() => clearTimeout(subTimer)} oncontextmenu={(e) => e.preventDefault()}>
        {@render rows(subItems, 1, subActive)}
      </div>
    {/if}
  {/key}
{/if}

<style>
  .cm { position: fixed; z-index: 1000; min-width: 210px; max-width: min(340px, calc(100vw - 8px)); max-height: calc(100vh - 8px); overflow-y: auto; overscroll-behavior: contain;
    background: var(--panel); border: 1px solid var(--border-strong); border-radius: 9px; padding: 5px; box-shadow: 0 16px 50px rgba(0, 0, 0, 0.55);
    cursor: default; user-select: none; outline: none; font-size: 12.5px; animation: cm-in 90ms ease-out; }
  .cm.sub { min-width: 170px; z-index: 1001; }
  @keyframes cm-in { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .cm { animation: none; } }

  .mi { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border-radius: 6px; text-align: left; color: var(--text); outline: none; }
  .mi.on { background: var(--raise); }
  .mi[aria-disabled='true'] { color: var(--faint); cursor: default; }
  .mi[aria-disabled='true'].on { background: transparent; }
  .gut { width: 14px; flex: none; display: grid; place-items: center; color: var(--accent); }
  .sw { width: 9px; height: 9px; border-radius: 50%; }
  .lbl { display: grid; flex: 1; min-width: 0; }
  .l { grid-area: 1 / 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .l.hide { visibility: hidden; }
  .hint { color: var(--muted); font-size: 11px; flex: none; margin-left: 12px; }
  .tick { color: var(--accent); display: grid; flex: none; }
  .chev { color: var(--muted); display: grid; flex: none; margin-right: -2px; }
  .mi.danger { color: var(--bad); }
  .mi.danger.on { background: rgba(239, 107, 115, 0.14); }
  .mi.armed { background: rgba(239, 107, 115, 0.22); color: #ffc2c6; }
  .sep { height: 1px; background: var(--border); margin: 4px 3px; }
</style>
