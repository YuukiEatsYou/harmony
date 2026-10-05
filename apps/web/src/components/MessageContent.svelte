<script lang="ts">
  import type { User } from '@harmony/shared';
  import { chat } from '../lib/chat.svelte';
  import { isJumbo } from '../lib/jumbo-emoji';
  import { inlineSegmentsOf, type InlineSegment, type ListBlock, type MessageBlock } from '../lib/message-text';
  import { profileCard, hoverCapable } from '../lib/profile-card.svelte';
  import { formatTimestamp, formatTimestampTitle } from '../lib/timestamp';
  import { ui } from '../lib/ui.svelte';
  import CodeBlock from './CodeBlock.svelte';

  /** The parsed text of one message, drawn as Discord would draw it. */
  let { blocks, allowJumbo = true }: { blocks: MessageBlock[]; allowJumbo?: boolean } = $props();

  /** A message of nothing but emoji is drawn large, as on Discord. */
  const jumbo = $derived(allowJumbo && isJumbo(blocks));

  function openCard(user: User, element: HTMLElement): void {
    if (hoverCapable()) profileCard.show(user, element);
  }

  /** Opens the full profile viewer: the click action on a mentioned member. */
  function openViewer(user: User): void {
    profileCard.hide();
    ui.openProfileViewer(user);
  }

  /**
   * "In 3 hours" goes stale while it sits on screen, so a message holding a
   * relative timestamp keeps its own clock. Only those messages tick; the rest
   * never re-render for the time.
   */
  const hasRelative = $derived(
    inlineSegmentsOf(blocks).some((segment) => segment.type === 'timestamp' && segment.style === 'R'),
  );
  let now = $state(Date.now());

  $effect(() => {
    if (!hasRelative) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
</script>

<!--
  The content sits in a pre-wrap container so a paragraph's own line breaks
  show, which also means stray whitespace between tags would show. The markup
  below is kept tight wherever it sits between elements for that reason.
-->
{#snippet inlineSegments(segments: InlineSegment[])}
  {#each segments as segment, index (index)}
    <span
      class="seg"
      class:bold={segment.styles?.bold}
      class:italic={segment.styles?.italic}
      class:underline={segment.styles?.underline}
      class:strike={segment.styles?.strike}
      class:spoiler={segment.styles?.spoiler}
    >
      {#if segment.type === 'emoji'}
        <img
          class="emoji"
          src={`/api/v1/emojis/${segment.emoji.id}`}
          alt={`:${segment.emoji.name}:`}
          title={`:${segment.emoji.name}:`}
        />
      {:else if segment.type === 'mention'}
        <button
          type="button"
          class="mention profile-trigger"
          title={`@${segment.user.username}`}
          onmouseenter={(event) => { if (hoverCapable()) profileCard.scheduleShow(segment.user, event.currentTarget); }}
          onmouseleave={() => profileCard.scheduleHide()}
          onfocus={(event) => openCard(segment.user, event.currentTarget)}
          onblur={() => profileCard.scheduleHide()}
          onclick={() => openViewer(segment.user)}
        >
          @{segment.user.displayName ?? segment.user.username}
        </button>
      {:else if segment.type === 'channel'}
        <button
          type="button"
          class="channel-mention"
          title={`#${segment.channel.name}`}
          onclick={() => chat.selectChannel(segment.channel.id)}
        >
          #{segment.channel.name}
        </button>
      {:else if segment.type === 'link'}
        <a class="link" href={segment.href} target="_blank" rel="noreferrer noopener">{segment.value}</a>
      {:else if segment.type === 'code'}
        <code class="inline-code">{segment.value}</code>
      {:else if segment.type === 'timestamp'}
        <time
          class="md-timestamp"
          datetime={new Date(segment.epochMs).toISOString()}
          title={formatTimestampTitle(segment.epochMs)}
        >{formatTimestamp(segment.epochMs, segment.style, { now })}</time>
      {:else}
        {segment.value}
      {/if}
    </span>
  {/each}
{/snippet}

{#snippet listItems(list: ListBlock)}
  {#each list.items as item, itemIndex (itemIndex)}<li>{@render inlineSegments(item.segments)}{#each item.children as child, childIndex (childIndex)}{@render listBlock(child)}{/each}</li>{/each}
{/snippet}

{#snippet listBlock(list: ListBlock)}
  {#if list.ordered}<ol class="md-list" start={list.start}>{@render listItems(list)}</ol>{:else}<ul class="md-list">{@render listItems(list)}</ul>{/if}
{/snippet}

{#snippet blockList(items: MessageBlock[])}
  {#each items as block, blockIndex (blockIndex)}
    {#if block.type === 'code'}
      <CodeBlock text={block.text} language={block.language} />
    {:else if block.type === 'quote'}
      <blockquote class="quote">{@render blockList(block.blocks)}</blockquote>
    {:else if block.type === 'header'}
      <p
        class="md-header"
        class:md-h1={block.level === 1}
        class:md-h2={block.level === 2}
        class:md-h3={block.level === 3}
      >
        {@render inlineSegments(block.segments)}
      </p>
    {:else if block.type === 'subtext'}
      <p class="md-subtext">{@render inlineSegments(block.segments)}</p>
    {:else if block.type === 'list'}
      {@render listBlock(block)}
    {:else}
      <p class="paragraph">{@render inlineSegments(block.segments)}</p>
    {/if}
  {/each}
{/snippet}

{#if jumbo}<span class="jumbo-emoji">{@render blockList(blocks)}</span>{:else}{@render blockList(blocks)}{/if}
