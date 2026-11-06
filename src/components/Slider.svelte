<script lang="ts">
  let { value, min, max, step = 1, unit = '', digits = 0, onchange }:
    { value: number; min: number; max: number; step?: number; unit?: string; digits?: number; onchange: (v: number) => void } = $props();
</script>

<div class="s-slider" style:--pct="{max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0}%">
  <input type="range" {min} {max} {step} {value} oninput={(e) => onchange(Number(e.currentTarget.value))} />
  <span class="read">{value.toFixed(digits)}{unit}</span>
</div>
