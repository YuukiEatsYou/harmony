<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { chat } from '../lib/chat.svelte';
  import { composerTakesText, focusComposer, isComposerField } from '../lib/composer-field';
  import { globalShortcut, type GlobalShortcut, type KeyScene } from '../lib/global-shortcuts';
  import { lightbox } from '../lib/lightbox.svelte';
  import { modalLayers } from '../lib/modal-layers.svelte';
  import { profileCard } from '../lib/profile-card.svelte';
  import { sidebarOrder, stepChannel } from '../lib/quick-switch';
  import { isTypingTarget, shortcuts } from '../lib/shortcuts.svelte';
  import { ui } from '../lib/ui.svelte';
  import { voice } from '../lib/voice.svelte';
  import QuickSwitcher from './QuickSwitcher.svelte';
  import ShortcutHelp from './ShortcutHelp.svelte';

  const ordered = $derived(sidebarOrder(chat.categories, chat.channels));
  const order = $derived(ordered.map((channel) => channel.id));
  /** Muted channels are skipped by the unread arrows, as on Discord, unless they hold a mention. */
  const unreadStops = $derived(
    new Set(
      ordered
        .filter((channel) => chat.unreadShown(channel) || chat.mentionsShown(channel) > 0)
        .map((channel) => channel.id),
    ),
  );

  /*
   * The menus, pickers and popovers kept in their own component's state rather
   * than a store. Each is a menu or a dialog to assistive technology, or one of
   * the two pickers, so their roles and classes find them all. The profile card
   * is a dialog too but is looked up through its store instead, because unlike
   * the others it opens on hover and takes no typing.
   */
  const popoverSelector = '[role="menu"], [role="dialog"]:not(.profile-card), .emoji-picker, .gif-picker';

  // Every channel opened, by whatever route, is what the switcher offers first.
  $effect(() => {
    const id = chat.activeChannelId;
    if (id) untrack(() => shortcuts.noteVisit(id));
  });

  onMount(() => () => shortcuts.reset());

  async function step(direction: 1 | -1, unreadOnly: boolean): Promise<void> {
    const next = stepChannel(
      order,
      chat.activeChannelId,
      direction,
      unreadOnly ? (id) => unreadStops.has(id) : undefined,
    );
    if (!next) return;
    void chat.selectChannel(next);
    // A long sidebar scrolls, and a channel opened from the keyboard should not
    // end up highlighted somewhere out of sight.
    await tick();
    document.querySelector('.sidebar .channel.active')?.scrollIntoView({ block: 'nearest' });
  }

  /** What the page looks like for one key press, apart from whether it has been used. */
  function sceneFor(event: KeyboardEvent): Omit<KeyScene, 'handled'> {
    const active = chat.activeChannelId;
    return {
      // The admin, profile, search, inbox, pins and setup panels all sit in
      // this overlay; the setup wizard has no store to ask, so the overlay is
      // what is looked for. The lightbox covers the chat the same way, and so
      // do the dialogs that register as modal layers (edit history, "What's
      // new"), whose shortcuts would otherwise act out of sight beneath them.
      panel: document.querySelector('.admin-overlay') !== null || lightbox.url !== null || modalLayers.count > 0,
      dialog: shortcuts.panel !== null,
      // A drawer left open on a narrow screen that has since been widened is
      // not drawn at all, so it only counts while the screen is narrow.
      popover:
        (ui.narrow && (ui.sidebarOpen || ui.rosterOpen)) || document.querySelector(popoverSelector) !== null,
      drawer: ui.narrow && (ui.sidebarOpen || ui.rosterOpen),
      card: profileCard.user !== null,
      typing: isTypingTarget(event.target),
      inComposer: isComposerField(event.target),
      composerReady: composerTakesText(),
      channelOpen: chat.activeChannel !== null,
      hasNew: chat.newSince !== null || (active !== null && (chat.unread.has(active) || chat.mention.has(active))),
      inVoice: voice.channelId !== null,
    };
  }

  /*
   * The page as it was when the key went down, read on the way down before any
   * handler has had the key. The menus, cards and the lightbox that close on
   * Escape listen on the window as well, and whichever of them happened to run
   * before this layer would otherwise already have closed by the time it
   * looked, so the same Escape would close the menu and mark the channel read.
   */
  let captured: { event: KeyboardEvent; scene: Omit<KeyScene, 'handled'> } | null = null;

  function onKeydownCapture(event: KeyboardEvent): void {
    captured = { event, scene: sceneFor(event) };
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const scene = captured?.event === event ? captured.scene : sceneFor(event);
    captured = null;
    const shortcut = globalShortcut(
      {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        altGraph: event.getModifierState('AltGraph'),
      },
      { ...scene, handled: event.defaultPrevented },
    );
    if (!shortcut) return;
    if (shortcut.action === 'close-panel') {
      // Acted on only once every handler has had the key: something over the
      // panel that closes on Escape itself marks it as used, and then only that
      // closes. This layer listens on the window early, so it would otherwise go
      // first.
      // A registered dialog is the top layer when one is open; it closes on
      // Escape itself, and this only reaches it with focus outside it.
      setTimeout(() => {
        if (event.defaultPrevented) return;
        if (modalLayers.count > 0) modalLayers.closeAll();
        else ui.dismissPanel();
      });
      return;
    }
    // Moving focus is all a typed character needs: the key's own default then
    // types it into the message box, which is focused by the time it lands.
    if (shortcut.action !== 'type') event.preventDefault();
    run(shortcut);
  }

  function run(shortcut: GlobalShortcut): void {
    switch (shortcut.action) {
      case 'switcher':
        shortcuts.toggle('switcher');
        break;
      case 'help':
        shortcuts.toggle('help');
        break;
      case 'close-dialog':
        void shortcuts.close();
        break;
      case 'search':
        ui.openSearch();
        break;
      case 'inbox':
        ui.openInbox();
        break;
      case 'pins':
        ui.openPins();
        break;
      case 'members':
        ui.toggleMembers();
        break;
      case 'step':
        void step(shortcut.direction, shortcut.unreadOnly);
        break;
      case 'dismiss-new':
        chat.dismissNew();
        break;
      case 'read-all':
        chat.markChannelsRead(chat.channels.map((channel) => channel.id));
        break;
      // The same toggles as the voice bar's buttons. Deafening leaves the mute
      // setting alone (a deafened member is muted without it changing), so
      // undeafening brings back whatever it was before.
      case 'mute':
        voice.setMuted(!voice.muted);
        break;
      case 'deafen':
        voice.setDeafened(!voice.deafened);
        break;
      case 'type':
        focusComposer();
        break;
    }
  }
</script>

<svelte:window onkeydowncapture={onKeydownCapture} onkeydown={onKeydown} />

{#if shortcuts.panel === 'switcher'}
  <QuickSwitcher />
{:else if shortcuts.panel === 'help'}
  <ShortcutHelp />
{/if}
