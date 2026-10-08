<script lang="ts">
  import type { IconName } from '../lib/icons';

  /**
   * A small set of monochrome line icons, drawn inline so each takes the color
   * of whatever it sits in, needs no icon font or sprite, and stays crisp at any
   * size. They are decorative by design: every place one is used already carries
   * an `aria-label` or a `title`, so the icon itself is hidden from assistive
   * technology rather than doubling up the label.
   */
  let { name, size = 20 }: { name: IconName; size?: number } = $props();
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#if name === 'menu'}
    <path d="M4 7h16" />
    <path d="M4 12h16" />
    <path d="M4 17h16" />
  {:else if name === 'search'}
    <circle cx="11" cy="11" r="7" />
    <path d="M16.2 16.2 21 21" />
  {:else if name === 'inbox'}
    <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <path d="M4 13h4l2 3h4l2-3h4" />
  {:else if name === 'pin'}
    <path d="M9 3h6" />
    <path d="M10 3v6.5L6.5 13v2h11v-2L14 9.5V3" />
    <path d="M12 15v6" />
  {:else if name === 'bookmark'}
    <path d="M6.5 4.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5V21L12 17l-5.5 4z" />
  {:else if name === 'users'}
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.5a3 3 0 0 1 0 5.8" />
    <path d="M17 14.2A5.5 5.5 0 0 1 20.5 19" />
  {:else if name === 'lock'}
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  {:else if name === 'link'}
    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
  {:else if name === 'check'}
    <path d="M5 12.5 9.5 17 19 7.5" />
  {:else if name === 'smile'}
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
    <path d="M9.5 9.75h.01" />
    <path d="M14.5 9.75h.01" />
  {:else if name === 'calendar'}
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 10h17" />
    <path d="M8 3v4" />
    <path d="M16 3v4" />
  {:else if name === 'clock'}
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  {:else if name === 'paperclip'}
    <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7" />
  {:else if name === 'gif'}
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="M3 16l4.5-4 4 3.5 3-2.5L21 17" />
    <circle cx="8.5" cy="9" r="1.3" />
  {:else if name === 'plus'}
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  {:else if name === 'send'}
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4z" />
  {:else if name === 'close'}
    <path d="M6 6 18 18" />
    <path d="M18 6 6 18" />
  {:else if name === 'heart-filled'}
    <path
      d="M12 20.7C7.2 17 3.6 13.9 3.6 10.2 3.6 7.4 5.8 5.2 8.5 5.2c1.6 0 3 .7 3.5 1.9.6-1.2 2-1.9 3.5-1.9 2.7 0 4.9 2.2 4.9 5 0 3.7-3.6 6.8-8.4 10.5z"
      fill="currentColor"
      stroke="none"
    />
  {:else if name === 'heart'}
    <path
      d="M12 20.7C7.2 17 3.6 13.9 3.6 10.2 3.6 7.4 5.8 5.2 8.5 5.2c1.6 0 3 .7 3.5 1.9.6-1.2 2-1.9 3.5-1.9 2.7 0 4.9 2.2 4.9 5 0 3.7-3.6 6.8-8.4 10.5z"
    />
  {:else if name === 'crown'}
    <path d="M3 7.5 6.5 11 12 4.5 17.5 11 21 7.5 19.4 18.5H4.6z" />
    <path d="M4.6 18.5h14.8" />
  {:else if name === 'sword'}
    <path d="M14.5 17.5 3 6V3h3l11.5 11.5" />
    <path d="m13 19 6-6" />
    <path d="m16 16 4 4" />
    <path d="m19 21 2-2" />
  {:else if name === 'shield'}
    <path d="M12 21.5c4.4-2.1 7-5.4 7-9.5V5.4L12 2.8 5 5.4V12c0 4.1 2.6 7.4 7 9.5z" />
  {:else if name === 'chevron-down'}
    <path d="m6 9 6 6 6-6" />
  {:else if name === 'more'}
    <path d="M5.5 12h.01" stroke-width="3" />
    <path d="M12 12h.01" stroke-width="3" />
    <path d="M18.5 12h.01" stroke-width="3" />
  {:else if name === 'poll'}
    <path d="M5 20V11" />
    <path d="M12 20V4" />
    <path d="M19 20v-6" />
  {:else if name === 'bot'}
    <rect x="4.5" y="8" width="15" height="11" rx="3" />
    <path d="M12 8V4.8" />
    <circle cx="12" cy="3.6" r="1.2" />
    <path d="M9.2 13h.01" stroke-width="2.4" />
    <path d="M14.8 13h.01" stroke-width="2.4" />
    <path d="M9.5 16.2h5" />
  {:else if name === 'volume'}
    <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" />
    <path d="M15.5 9.7a3.5 3.5 0 0 1 0 4.6" />
    <path d="M18 7.2a7 7 0 0 1 0 9.6" />
  {:else if name === 'mic'}
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
  {:else if name === 'mic-off'}
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
    <path d="M3.5 3.5 20.5 20.5" />
  {:else if name === 'headphones'}
    <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
    <rect x="3" y="13" width="4.5" height="7" rx="2" />
    <rect x="16.5" y="13" width="4.5" height="7" rx="2" />
  {:else if name === 'phone-off'}
    <path d="M6.5 4h3.2l1.5 4-2 1.4a12 12 0 0 0 5.4 5.4l1.4-2 4 1.5v3.2a2 2 0 0 1-2.2 2A16.2 16.2 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z" />
    <path d="M3.5 3.5 20.5 20.5" />
  {/if}
</svg>
