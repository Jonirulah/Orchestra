<script lang="ts" generics="T extends string">
  let { options, value, onchange }: { options: { id: T; label: string }[]; value: T; onchange: (id: T) => void } = $props();
</script>

<div class="s-seg" role="radiogroup">
  {#each options as o (o.id)}
    <button type="button" role="radio" aria-checked={o.id === value} class:on={o.id === value} onclick={() => onchange(o.id)}>{o.label}</button>
  {/each}
</div>
