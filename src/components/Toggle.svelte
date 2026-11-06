<script lang="ts">
  let { value, onchange, label = '' }: { value: boolean; onchange: (v: boolean) => void; label?: string } = $props();
</script>

<button type="button" class="s-switch" class:on={value} role="switch" aria-checked={value} aria-label={label} onclick={() => onchange(!value)}>
  <span class="knob"></span>
</button>
