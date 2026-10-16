<script lang="ts">
  let { label, sub, value }: { label: string; sub: string; value: number } = $props();
</script>

<div data-testid="stat" class="rounded-[14px] border border-line bg-gradient-to-br from-panel to-[#111820] p-[18px]">
  <span class="text-sm text-muted-ink">{label}</span>
  <strong class="my-2 block text-4xl leading-none">{value}</strong>
  <span class="text-sm text-muted-ink">{sub}</span>
</div>
