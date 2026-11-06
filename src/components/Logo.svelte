<script lang="ts">
  // Marca de Orchestra: el hexágono ámbar con el cursor del terminal (el mismo dibujo que el icono de la aplicación).
  let { size = 36 }: { size?: number } = $props();
</script>

<svg class="logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
  <polygon points="12,1.5 21.2,6.75 21.2,17.25 12,22.5 2.8,17.25 2.8,6.75" fill="#f5b942" />
  <path d="M9.2 8.6 13 12 9.2 15.4M14 15.4h3" stroke="#14171c" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round" />
</svg>

<style>
  .logo { display: block; flex: none; }
</style>
