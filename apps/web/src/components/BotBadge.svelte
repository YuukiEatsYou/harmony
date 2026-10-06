<script lang="ts">
  import Icon from './Icon.svelte';

  /** A small robot shown beside a bot account's name, the way a role badge is shown. */
  let { size = 14 }: { size?: number } = $props();
</script>

<span class="member-badge badge-bot" title="Bot"><Icon name="bot" size={size} /></span>
