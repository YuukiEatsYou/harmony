<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { chat } from '../lib/chat.svelte';
  import {
    mayCarryOn,
    mouseButtonStep,
    ownedBy,
    planOverlay,
    planVisit,
    popAction,
    readEntry,
    returnAfterClose,
    stepDirection,
    stepsOffMarker,
    writeEntry,
    type ChannelHistoryEntry,
  } from '../lib/channel-history';
  import { withoutLaunchParams } from '../lib/launch-params';
  import { session } from '../lib/session.svelte';
  import { ui } from '../lib/ui.svelte';

  /*
   * Back and forward between the channels opened in this tab. Each channel
   * opened, by whatever route, gets a browser history entry, so the browser's
   * own back and forward walk them; this component writes those entries and
   * follows the browser when it steps onto one. Something opened over the chat
   * gets a marker entry, so back closes it before it changes channel. It draws
   * nothing.
   */

  /**
   * The entry the page is on, as this component last saw it. A step lands on
   * an entry without saying which way it went, so comparing positions is how
   * back is told from forward.
   */
  let here: ChannelHistoryEntry | null = readEntry(window.history.state);

  /**
   * The position a quiet step back off a marker is headed for, while one is on
   * its way. Its landing is this component's own doing, not a press, so it is
   * not followed like one.
   */
  let settling: number | null = null;

  /**
   * Whether an entry can be opened: its channel still exists, and it was written
   * by the account signed in now rather than one that signed out of this tab.
   */
  function usable(entry: ChannelHistoryEntry): boolean {
    return ownedBy(entry, session.user?.id ?? null) && chat.channels.some((channel) => channel.id === entry.channelId);
  }

  /** An entry as this account writes it. */
  function stamped(entry: ChannelHistoryEntry): ChannelHistoryEntry {
    const userId = session.user?.id;
    return userId === undefined ? entry : { ...entry, userId };
  }

  // Watches the open channel and how much is open over the chat. Everything
  // else is read untracked, so a channel list refresh does not count as a visit.
  $effect(() => {
    const channelId = chat.activeChannelId;
    const depth = ui.overlayDepth;
    untrack(() => sync(channelId, depth));
  });

  // Signing out takes the chat away, and whatever was open over it goes too,
  // rather than coming back for whoever signs in next in this tab.
  onMount(() => () => ui.closeOverlaysAbove(0));

  /** Brings history in step with the open channel and with what is open over it. */
  function sync(channelId: string | null, depth: number): void {
    // Until a quiet step has landed the page is still on the entry it is
    // leaving, and anything written now would go on the wrong one. The landing
    // calls this again.
    if (settling !== null) return;

    // A channel first, so a marker for something opened along with it goes
    // after the channel's own entry rather than standing in for it.
    const current = readEntry(window.history.state);
    const visit = planVisit(current, channelId, current !== null && usable(current), here?.index ?? 0);
    if (visit?.op === 'push') push(visit.entry);
    else if (visit) replace(visit.entry);

    const marker = planOverlay(readEntry(window.history.state), channelId, depth, userActivated());
    if (marker) push(marker);

    const now = readEntry(window.history.state);
    if (now && stepsOffMarker(now, channelId, depth)) settle(now.index - 1);
  }

  /**
   * Whether a person has just clicked or pressed a key, which is what Chrome asks
   * of a page before it lets an entry it adds count; see planOverlay. A browser
   * that cannot say is taken at its word that it does not mind.
   */
  function userActivated(): boolean {
    return navigator.userActivation?.isActive ?? true;
  }

  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Steps quietly back off a marker, to the entry at `target`. The landing is
   * reported by popstate like any step, and history is left alone until it is.
   * A browser that never reports it (or refuses the step) must not leave
   * history frozen, so after a moment the wait is given up and the page takes
   * whatever entry it is on as where it is. A return to the entry a press came
   * from (see returnAfterClose) is the same kind of step, taken forward.
   */
  function settle(target: number, step = -1): void {
    settling = target;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (settling === null) return;
      settling = null;
      here = readEntry(window.history.state);
    }, 1000);
    window.history.go(step);
  }

  function push(entry: ChannelHistoryEntry): void {
    entry = stamped(entry);
    here = entry;
    // The address stays as it is, less a launch link's parameters: they
    // belong to the entry the link arrived on, and an entry carrying them
    // would follow the link again on a reload instead of reopening its channel.
    const url = window.location.pathname + withoutLaunchParams(window.location.search) + window.location.hash;
    window.history.pushState(writeEntry(null, entry), '', url);
  }

  function replace(entry: ChannelHistoryEntry): void {
    entry = stamped(entry);
    here = entry;
    window.history.replaceState(writeEntry(window.history.state, entry), '');
  }

  async function onPopState(event: PopStateEvent): Promise<void> {
    const entry = readEntry(event.state);
    if (settling !== null) {
      const quiet = entry !== null && entry.index === settling;
      settling = null;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      if (quiet) {
        here = entry;
        // Whatever changed while the step was on its way is written now, and
        // a marker it landed on that is no longer needed either is stepped off.
        sync(chat.activeChannelId, ui.overlayDepth);
        return;
      }
    }
    if (!entry) return;
    const from = here;
    here = entry;
    const direction = stepDirection(from?.index ?? 0, entry.index);
    const action = popAction(entry, chat.activeChannelId, usable(entry), direction, ui.overlayDepth);

    if (action === 'close') {
      // The channel stays. A press that landed on another channel's entry, as
      // one does over something that opened by itself and so has no marker,
      // steps back onto the entry it came from, before the effect above can
      // write the open channel in again with a push.
      const forward = returnAfterClose(entry, from, chat.activeChannelId);
      if (forward !== null) settle(entry.index + forward, forward);
      ui.closeOverlaysAbove(entry.depth);
      return;
    }

    // Until the channel list is in there is nothing to check the entry against.
    if (chat.channels.length === 0) return;

    if (action === 'stale' && chat.activeChannelId) {
      here = stamped({ ...entry, channelId: chat.activeChannelId });
      window.history.replaceState(writeEntry(event.state, here), '');
    }
    if (action !== 'open') {
      // Going past the last entry this way does nothing, which is the right
      // answer when every entry left that way is gone or already open.
      if (mayCarryOn(direction, entry.index, from, chat.activeChannelId)) window.history.go(direction);
      return;
    }

    // Some panels (pins, the gallery) belong to the channel they were opened
    // from, so a step forward that changes the channel closes whatever is open
    // over the chat, as a jump from inside one does.
    ui.closeOverlaysAbove(0);
    void chat.selectChannel(entry.channelId);
    // As for the channel arrows: a long sidebar scrolls, and the channel just
    // opened should not be highlighted somewhere out of sight.
    await tick();
    document.querySelector('.sidebar .channel.active')?.scrollIntoView({ block: 'nearest' });
  }

  /**
   * The mouse's side buttons. Chrome and the browsers built on it navigate as
   * the default action of this mouseup, and Firefox never shows these buttons to
   * the page at all and navigates by itself; either way the entries above are
   * what it walks. Some engines (Safari, some desktop app shells) hand the page
   * the event and do nothing more, so the step is taken here. The default is
   * prevented first, so a browser that would have navigated as well does not
   * take the step twice. With something open over the chat the step lands on
   * the entry beneath its marker and closes it, as any other back does.
   *
   * Something that opened by itself has no marker (see planOverlay), and on the
   * first channel a step back would then leave the app instead of closing it.
   * The browser's own back button cannot be stopped from doing that, but this
   * one can: when more is open than the entry the page is on accounts for, the
   * back button closes it and takes no step at all.
   */
  function onMouseUp(event: MouseEvent): void {
    const step = mouseButtonStep(event.button);
    if (step === null) return;
    event.preventDefault();
    const depth = here?.depth ?? 0;
    if (step === -1 && ui.overlayDepth > depth) {
      ui.closeOverlaysAbove(depth);
      return;
    }
    window.history.go(step);
  }
</script>

<svelte:window onpopstate={onPopState} onmouseup={onMouseUp} />
