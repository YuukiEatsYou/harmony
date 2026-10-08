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
   * Attaches pointer handlers for one gesture, reporting every move as a delta in
   * pixels from where it started, and stops when the pointer lifts or is cancelled.
   */
  function track(handle: HTMLElement, start: { x: number; y: number }, onMove: (dx: number, dy: number) => void): void {
    const move = (current: PointerEvent): void => onMove(current.clientX - start.x, current.clientY - start.y);
    const end = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /** The corner a resize started from, named by the edges that move. */
  type Corner = 'br' | 'bl' | 'tl';

  /**
   * Moves the whole window with the pointer. The header is the grip. The moves are
   * clamped so the window cannot be dragged off the screen and stranded.
   */
  function startDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    const base = anchor();
    if (!base) return;
    box = base;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    track(handle, { x: event.clientX, y: event.clientY }, (dx, dy) => {
      box = {
        ...base,
        x: clamp(base.x + dx, 0, window.innerWidth - base.w),
        y: clamp(base.y + dy, 0, window.innerHeight - base.h),
      };
    });
  }

  /**
   * Resizes from one corner, keeping the opposite corner pinned so the window grows
   * toward the pointer. The size is clamped to a floor and to the viewport, so the
   * pinned corner never leaves the screen.
   */
  function startResize(event: PointerEvent, corner: Corner): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    const base = anchor();
    if (!base) return;
    box = base;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const right = base.x + base.w;
    const bottom = base.y + base.h;
    track(handle, { x: event.clientX, y: event.clientY }, (dx, dy) => {
      if (corner === 'br') {
        box = {
          ...base,
          w: clamp(base.w + dx, minWidth, window.innerWidth - base.x),
          h: clamp(base.h + dy, minHeight, window.innerHeight - base.y),
        };
        return;
      }
      // A left corner pins the right edge, so dragging left grows the window over
      // the space to its left; a top corner does the same with the bottom edge.
      const w = clamp(base.w - dx, minWidth, right);
      const h =
        corner === 'bl'
          ? clamp(base.h + dy, minHeight, window.innerHeight - base.y)
          : clamp(base.h - dy, minHeight, bottom);
      box = { ...base, x: right - w, w, y: corner === 'bl' ? base.y : bottom - h, h };
    });
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
      class="screen-resize tl"
      aria-label="Resize from top left"
      title="Drag to resize"
      onpointerdown={(event) => startResize(event, 'tl')}
    ></button>
    <button
      type="button"
      class="screen-resize bl"
      aria-label="Resize from bottom left"
      title="Drag to resize"
      onpointerdown={(event) => startResize(event, 'bl')}
    ></button>
    <button
      type="button"
      class="screen-resize br"
      aria-label="Resize from bottom right"
      title="Drag to resize"
      onpointerdown={(event) => startResize(event, 'br')}
    ></button>
  </div>
{/if}
