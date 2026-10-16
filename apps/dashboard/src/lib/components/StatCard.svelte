<script lang="ts">
  let { label, sub, value }: { label: string; sub: string; value: number } = $props();
</script>

<div data-testid="stat" class="stat">
  <span class="stat-label">{label}</span>
  <strong class="stat-value">{value}</strong>
  <span class="stat-sub">{sub}</span>
</div>
