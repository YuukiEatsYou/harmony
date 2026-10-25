<script lang="ts">
  import { isApple, modKey as mod, shortcuts, trapFocus } from '../lib/shortcuts.svelte';

  // Named the way the keys are printed on the keyboard in front of the reader.
  const alt = isApple ? '⌥' : 'Alt';
  // The browser's own back and forward keys, which walk the channels opened.
  const historyKeys = isApple
    ? [
        ['⌘', '['],
        ['⌘', ']'],
      ]
    : [
        ['Alt', '←'],
        ['Alt', '→'],
      ];
  const formatKeys = [
    [mod, 'B'],
    [mod, 'I'],
    [mod, 'U'],
  ];

  /*
   * The whole map: the app-wide keys of KeyboardShortcuts.svelte, and the ones
   * the message box, the edit box and the messages handle themselves, grouped
   * by where they work. The app-wide groups come first and the message ones
   * after, so on a wide screen the two columns fall roughly along that line.
   * docs/TECHNICAL.md has the rules behind the app-wide keys; keep the two in
   * step when a key is added.
   */
  const groups: Array<{ title: string; rows: Array<{ keys: string[][]; label: string }> }> = [
    {
      title: 'Anywhere, even while typing',
      rows: [
        { keys: [[mod, 'K']], label: 'Open the quick switcher' },
        { keys: [[mod, 'F']], label: 'Search messages' },
        { keys: [[mod, 'P']], label: 'Pinned messages in this channel' },
        { keys: historyKeys, label: 'Back or forward through the channels you opened' },
        { keys: [['Mouse back'], ['Mouse forward']], label: 'The same, with the side buttons of a mouse' },
      ],
    },
    {
      title: 'Navigation',
      rows: [
        { keys: [[mod, 'I']], label: 'Mentions and replies' },
        { keys: [[mod, 'U']], label: 'Show or hide the member list' },
        { keys: [[alt, '↑'], [alt, '↓']], label: 'Previous or next channel' },
        { keys: [[alt, 'Shift', '↑'], [alt, 'Shift', '↓']], label: 'Previous or next unread channel' },
        { keys: [['Esc']], label: 'Close the open panel, or the drawer on a phone' },
        { keys: [['Esc']], label: 'Mark this channel read' },
        { keys: [['Shift', 'Esc']], label: 'Mark every channel read' },
        { keys: [['Any letter']], label: 'Start writing a message' },
        { keys: [[mod, '/']], label: 'Show these shortcuts' },
      ],
    },
    {
      title: 'Voice, while connected',
      rows: [
        { keys: [[mod, 'Shift', 'M']], label: 'Mute or unmute' },
        { keys: [[mod, 'Shift', 'D']], label: 'Deafen or undeafen' },
      ],
    },
    {
      title: 'In the quick switcher',
      rows: [
        { keys: [['↑'], ['↓']], label: 'Move through the results' },
        { keys: [['Enter']], label: 'Open the highlighted result' },
        { keys: [['Esc']], label: 'Close' },
        { keys: [['#'], ['@']], label: 'Typed first, look only for channels or only for members' },
      ],
    },
    {
      title: 'In the message box',
      rows: [
        { keys: [['Enter']], label: 'Send' },
        { keys: [['Shift', 'Enter']], label: 'New line' },
        { keys: [[mod, 'Shift', 'Enter']], label: 'Schedule the message' },
        { keys: formatKeys, label: 'Bold, italic or underline' },
        { keys: [[mod, 'E']], label: 'Emoji picker' },
        { keys: [[mod, 'G']], label: 'GIF picker' },
        { keys: [[mod, 'Shift', 'U']], label: 'Attach a file' },
        { keys: [['↑']], label: 'Edit your last message, from an empty box' },
        { keys: [['Tab']], label: 'Take the highlighted suggestion' },
        { keys: [['Esc']], label: 'Close a picker or suggestions, or cancel a reply; then mark the channel read' },
      ],
    },
    {
      title: 'Editing a message',
      rows: [
        { keys: [['Enter']], label: 'Save' },
        { keys: [['Shift', 'Enter']], label: 'New line' },
        { keys: [['Esc']], label: 'Cancel' },
        { keys: formatKeys, label: 'Bold, italic or underline' },
      ],
    },
    {
      title: 'With the mouse',
      rows: [
        { keys: [['Shift', 'Click']], label: 'On Delete: delete without asking first' },
        { keys: [[alt, 'Click']], label: 'On a message: mark the channel unread from there' },
        { keys: [['Click']], label: 'On a reply’s quote: jump to the message it answers' },
      ],
    },
  ];
</script>

<div class="sh-layer">
  <button
    class="sh-backdrop"
    type="button"
    tabindex="-1"
    aria-label="Close keyboard shortcuts"
    onclick={() => shortcuts.close()}
  ></button>

  <div class="sh-dialog" role="dialog" aria-modal="true" aria-labelledby="sh-title" use:trapFocus>
    <div class="sh-head">
      <h2 id="sh-title">Keyboard shortcuts</h2>
      <button type="button" data-autofocus onclick={() => shortcuts.close()}>Close</button>
    </div>

    <p class="sh-note">
      The first group and voice work while you are typing in a box. The rest wait until you are out of it,
      since there keys like {mod}+I and {mod}+U mean italic and underline.
    </p>

    <div class="sh-groups">
      {#each groups as group (group.title)}
        <section class="sh-group">
          <h3>{group.title}</h3>
          <dl>
            {#each group.rows as row (row.label)}
              <div class="sh-row">
                <dt>
                  {#each row.keys as combo, index (index)}
                    {#if index > 0}<span class="sh-or">/</span>{/if}
                    {#each combo as key, keyIndex (keyIndex)}<kbd>{key}</kbd>{/each}
                  {/each}
                </dt>
                <dd>{row.label}</dd>
              </div>
            {/each}
          </dl>
        </section>
      {/each}
    </div>
  </div>
</div>

<style>
  .sh-layer {
    position: fixed;
    inset: 0;
    z-index: 120;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }

  .sh-backdrop {
    position: absolute;
    inset: 0;
    border: none;
    background: rgb(0 0 0 / 70%);
    cursor: default;
  }

  /* A button, so the shared hover and active styles are pinned off it, as on every backdrop. */
  .sh-backdrop:hover:not(:disabled),
  .sh-backdrop:active:not(:disabled) {
    background: rgb(0 0 0 / 70%);
    box-shadow: none;
    transform: none;
  }

  .sh-dialog {
    position: relative;
    width: min(820px, 100%);
    max-height: 90vh;
    overflow-y: auto;
    padding: 1.1rem 1.2rem;
    border: 1px solid var(--h-glass-border);
    border-radius: var(--h-radius-lg);
    background: var(--h-bg-elevated);
    box-shadow: var(--h-shadow-xl);
  }

  .sh-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  h2 {
    margin: 0;
    font-size: 1.1rem;
  }

  /* Two columns where there is room for them, one on a phone; a group never splits. */
  .sh-groups {
    columns: 2 300px;
    column-gap: 2rem;
  }

  .sh-group {
    break-inside: avoid;
    padding-top: 1rem;
  }

  h3 {
    margin: 0 0 0.4rem;
    color: var(--h-text-faint);
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .sh-note {
    margin: 0.4rem 0 0;
    color: var(--h-text-muted);
    font-size: 0.85rem;
  }

  dl {
    margin: 0;
  }

  .sh-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--h-border);
  }

  dt {
    flex: none;
    order: 2;
  }

  dd {
    margin: 0;
    color: var(--h-text-muted);
    font-size: 0.9rem;
  }

  .sh-or {
    margin: 0 0.25rem;
    color: var(--h-text-faint);
  }

  kbd {
    display: inline-block;
    min-width: 1.5em;
    margin: 0 0.1em;
    padding: 0.05em 0.35em;
    border: 1px solid var(--h-border-strong);
    border-radius: var(--h-radius-xs);
    background: var(--h-bg-raised);
    color: var(--h-text);
    font-family: var(--h-font);
    font-size: 0.8rem;
    text-align: center;
  }
</style>
