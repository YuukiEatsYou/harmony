<script lang="ts">
  import type { MessageBlock } from '../lib/message-text';
  import MessageContent from './MessageContent.svelte';

  /** The draft as it will read once sent, so a `:name:` shows as its emoji. */
  let { blocks }: { blocks: MessageBlock[] } = $props();
</script>

<!--
  Decoration only: the textarea stays the accessible source, so a screen reader
  does not hear the draft twice. The outer box scrolls with the wheel or touch;
  the content inside is inert, so its links and mentions take no focus or click.
-->
<div class="composer-preview" aria-hidden="true" tabindex="-1">
  <div class="content" inert><MessageContent {blocks} /></div>
</div>
