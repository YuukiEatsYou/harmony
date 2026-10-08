<script lang="ts">
  import { voice } from '../lib/voice.svelte';
  import Icon from './Icon.svelte';

  /**
   * A shared screen floats in its own window, over the chat. It opens bottom-right
   * and small, so it stays out of the conversation until the viewer moves it, and
   * it can be dragged by its header and resized from the corner like any other
   * floating panel. A share is only watched once the viewer opts in, which is also
   * what keeps its video off the wire for everyone else.
   */
  const tiles = $derived(voice.screenTiles);

  /** The window element, for measuring it against the pointer while moving it. */
  let windowEl: HTMLDivElement | null = $state(null);
  /** Explicit left/top/width/height once the viewer has moved or resized it. */
  let box = $state<{ x: number; y: number; w: number; h: number } | null>(null);

  const minWidth = 220;
  const minHeight = 140;

  const boxStyle = $derived(
    box
      ? `left:${box.x}px; top:${box.y}px; right:auto; bottom:auto; width:${box.w}px; height:${box.h}px;`
      : '',
  );

  function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  /** The box to move from: where the window is now, which pins it on first use. */
  function anchor(): { x: number; y: number; w: number; h: number } | null {
    if (box) return box;
    if (!windowEl) return null;
    const rect = windowEl.getBoundingClientRect();
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  }

  /**
   * Moves the whole window with the pointer. The header is the grip; a pointerdown
   * on one of its buttons is left alone so they still click. The moves are clamped
   * so the window cannot be dragged off the screen and stranded.
   */
  function startDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    const base = anchor();
    if (!base) return;
    box = base;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (current: PointerEvent): void => {
      box = {
        ...base,
        x: clamp(base.x + current.clientX - startX, 0, window.innerWidth - base.w),
        y: clamp(base.y + current.clientY - startY, 0, window.innerHeight - base.h),
      };
    };
    const end = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /** Resizes from the bottom-right corner, within sane bounds. */
  function startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    const base = anchor();
    if (!base) return;
    box = base;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (current: PointerEvent): void => {
      box = {
        ...base,
        w: clamp(base.w + current.clientX - startX, minWidth, window.innerWidth - base.x),
        h: clamp(base.h + current.clientY - startY, minHeight, window.innerHeight - base.y),
      };
    };
    const end = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /** Fullscreens the tile the button belongs to, so the share fills the screen. */
  function goFullscreen(event: MouseEvent): void {
    const tile = (event.currentTarget as HTMLElement).closest('.screen-tile');
    const video = tile?.querySelector('video');
    void video?.requestFullscreen?.().catch(() => undefined);
  }
</script>

{#if tiles.length > 0}
  <div class="screen-share" role="region" aria-label="Shared screens" bind:this={windowEl} style={boxStyle}>
    {#each tiles as tile (tile.userId)}
      <div class="screen-tile">
        <div class="screen-tile-head">
          <button
            type="button"
            class="screen-tile-grip"
            title="Drag to move"
            onpointerdown={startDrag}
          >
            <Icon name="screen" size={13} />
            <span class="screen-tile-name">{tile.name}</span>
          </button>
          <span class="screen-tile-actions">
            {#if tile.watching}
              <button
                type="button"
                class="screen-tile-action"
                title="Stop watching"
                aria-label="Stop watching"
                onclick={() => voice.unwatchScreen(tile.userId)}
              >
                <Icon name="close" size={15} />
              </button>
              <button
                type="button"
                class="screen-tile-action"
                title="Fullscreen"
                aria-label="Fullscreen"
                onclick={goFullscreen}
              >
                <Icon name="expand" size={15} />
              </button>
            {/if}
          </span>
        </div>
        {#if tile.watching && tile.stream}
          <video srcObject={tile.stream} autoplay playsinline></video>
        {:else}
          <div class="screen-tile-empty">
            {#if tile.watching}
              <p class="screen-tile-hint">Connecting…</p>
            {:else}
              <button
                type="button"
                class="screen-watch"
                onclick={() => voice.watchScreen(tile.userId)}
              >
                <Icon name="play" size={16} />
                Watch
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
    <button
      type="button"
      class="screen-resize"
      aria-label="Resize shared screen"
      title="Drag to resize"
      onpointerdown={startResize}
    ></button>
  </div>
{/if}
