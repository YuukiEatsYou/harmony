import type {
  Category,
  Channel,
  ChannelListResponse,
  ChannelNotificationSettings,
  ChannelUnreadResponse,
  MeResponse,
  Message,
  Poll,
  PollUpdatePayload,
  PruneSummary,
  Reaction,
  ReactionsClearPayload,
  ReactionUpdatePayload,
  PresenceUpdatePayload,
  TypingStartPayload,
  User,
} from '@harmony/shared';
import { applyPollUpdate } from '@harmony/shared';
import { ApiError, api } from './api';
import { emojis } from './emojis.svelte';
import { emojiUsage } from './emoji-usage.svelte';
import { gifs } from './gifs.svelte';
import { mentionsUser, mergeLatest } from './messages';
import { members } from './members.svelte';
import { MemberReloadQueue } from './member-reload';
import { roster } from './roster.svelte';
import { commands } from './commands.svelte';
import { nameColors } from './name-colors.svelte';
import { voice } from './voice.svelte';
import { hostVoice } from './host-voice.svelte';
import { session } from './session.svelte';
import { channelSettings } from './channel-settings.svelte';
import { drafts } from './drafts.svelte';
import { playSound } from './sounds';
import { gateway, type GatewayFrame } from './gateway';
import { appendNewer, windowAround } from './history-window';
import { withChannelReadState } from './unread';
import type { LaunchTarget } from './launch-params';

/** How many messages one history page holds, for both directions. */
const historyPageSize = 50;

/** How long a typing indicator stays up without a refresh from its author. */
const typingTtlMs = 8000;
/** How often expired typing indicators are cleared away. */
const typingSweepMs = 2000;
/** How long a read marker waits when it rides on incoming messages. */
const readDebounceMs = 1000;
/** Page size, and most pages, used to re-check what is loaded after a prune. */
const reconcilePageSize = 100;
const reconcileMaxPages = 10;
/** Most history pages a jump to the first unread message will load. */
const unreadJumpMaxPages = 20;
/** The longest delay `setTimeout` honors; anything longer fires at once. */
const maxTimerMs = 2 ** 31 - 1;
/** How long emoji events wait, so the pruner's one-event-per-emoji burst reloads once. */
const emojiReloadMs = 250;

/** Whether two copies of a user would look any different beside a message. */
function sameFace(a: User, b: User): boolean {
  return (
    a.username === b.username &&
    a.displayName === b.displayName &&
    a.avatarHash === b.avatarHash &&
    a.roleColor === b.roleColor &&
    a.nameColor === b.nameColor &&
    a.badge === b.badge &&
    a.accountType === b.accountType
  );
}

/**
 * Where a page of history is taken from: just before a message, just after one,
 * or centred on one. Every field is the query parameter of the same name, and
 * leaving the cursor out asks for the newest page.
 */
type HistoryCursor = { before: string; beforeId?: string } | { after: string; afterId?: string } | { around: string };

/** Merges a single reaction event into a message's reaction list. */
function applyReactionDelta(
  reactions: Reaction[],
  payload: ReactionUpdatePayload,
  myId: string | undefined,
  mode: 'add' | 'remove',
): Reaction[] {
  const index = reactions.findIndex((reaction) => reaction.emoji === payload.emoji);
  const mine = payload.userId === myId;
  const existing = index === -1 ? undefined : reactions[index];

  if (mode === 'add') {
    if (!existing) {
      if (payload.count <= 0) return reactions;
      return [
        ...reactions,
        { emoji: payload.emoji, emojiId: payload.emojiId, count: payload.count, me: mine },
      ];
    }
    const next = reactions.slice();
    next[index] = { ...existing, count: payload.count, me: mine ? true : existing.me };
    return next;
  }

  if (!existing) return reactions;
  if (payload.count <= 0) return reactions.filter((_, i) => i !== index);
  const next = reactions.slice();
  next[index] = { ...existing, count: payload.count, me: mine ? false : existing.me };
  return next;
}

/** Reactive state for the channel list and the currently open conversation. */
class ChatStore {
  categories = $state<Category[]>([]);
  channels = $state<Channel[]>([]);
  activeChannelId = $state<string | null>(null);
  messages = $state<Message[]>([]);
  loading = $state(false);
  /** Whether older messages exist beyond the oldest one loaded. */
  hasMore = $state(false);
  loadingOlder = $state(false);
  /** Whether the page after an older stretch is on its way, carrying it towards the present. */
  loadingNewer = $state(false);
  /** The message the composer is currently replying to, if any. */
  replyTarget = $state<Message | null>(null);
  /** People typing in the open channel, each with when their notice expires. */
  typingUsers = $state<Array<{ user: User; expiresAt: number }>>([]);
  /** The message a search result landed on, flashed briefly. */
  highlightedId = $state<string | null>(null);
  /**
   * Channels with something this member has not read. It is per member, and the
   * server is what persists it, so it survives a reload and follows them between
   * devices.
   */
  unreadChannelIds = $state<string[]>([]);
  unread = $derived(new Set(this.unreadChannelIds));
  /**
   * How many unread mentions and replies each channel holds for this member,
   * which is the red number beside it. Like `unreadChannelIds` it is per member
   * and kept by the server, and a channel drops off it exactly when it is read.
   */
  mentionCounts = $state<Record<string, number>>({});
  /** The channels with at least one unread mention, for anything that only needs to know whether. */
  mentionChannelIds = $derived(Object.keys(this.mentionCounts));
  mention = $derived(new Set(this.mentionChannelIds));
  /**
   * Where this member had read the open channel up to when they opened it, while
   * it still had something new in it; null when it had nothing. It is a snapshot
   * on purpose: reading the channel moves the real marker at once, but the "new"
   * line and the bar above it stay put until the member leaves, the way
   * Discord's do, and are worked out afresh on the way back in.
   */
  newSince = $state<string | null>(null);
  /**
   * Bumped when a jump wants the message list to scroll to its end. An explicit
   * signal because replacing the list looks like a prepend to the view, which it
   * deliberately refuses to scroll for.
   */
  scrollSignal = $state(0);
  /**
   * Whether the open channel is showing an older stretch of history, after a
   * jump to a search or inbox result or a link to an old message, rather than
   * its newest messages. Live messages are held back while it is, since putting
   * them right after an old page would hide everything in between; the view
   * reads on towards the present a page at a time, and offers the leap there.
   */
  detached = $state(false);
  /**
   * Why the gateway ended this session, when it did so on purpose (a kick, a ban,
   * a password change elsewhere), for the sign-in screen to explain. Whoever
   * shows it clears it.
   */
  signedOutReason = $state<string | null>(null);

  #started = false;
  /** Removes this store's gateway subscription on stop, so a later start does not double it. */
  #gatewayUnsubscribe: (() => void) | null = null;
  /** Whether a READY has already been seen, to tell a first connect from a reconnect. */
  #connected = false;
  #typingTimer: ReturnType<typeof setInterval> | null = null;
  #highlightTimer: ReturnType<typeof setTimeout> | null = null;
  /** Channels whose read marker is waiting to be sent. */
  #readPending = new Set<string>();
  #readTimer: ReturnType<typeof setTimeout> | null = null;
  /** Read markers on their way to the server, by channel, so marking unread can wait them out. */
  #readsInFlight = new Map<string, Promise<void>>();
  /**
   * The open channel the member marked unread from a message, which stays
   * unread while they remain in it. Every path that reads the open channel by
   * itself (a message arriving while the tab is visible, the tab coming back
   * into view, a channel list refresh, catching up after a reconnect, the leap
   * to the present) passes through `#markRead` or `#queueRead`, and both leave
   * it alone. It is let go when the member leaves the channel or opens it
   * afresh, marks it read themselves, or posts in it, which reads it on the
   * server anyway.
   */
  #unreadHold: string | null = null;
  /** Guards the channel-list refresh that a denied channel triggers. */
  #healing = false;
  /**
   * Counts history loads, so only the latest one decides when loading is over.
   * Switching channels quickly would otherwise let a superseded load clear the
   * flag while the current one is still out, flashing "No messages yet". A page
   * loaded onto either end of the list checks it too, so a page fetched for one
   * list is never spliced into the one a jump replaced it with.
   */
  #historyLoad = 0;
  /** Refreshes the session when a timeout runs out, so the composer reopens. */
  #timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * How far this member has read each channel, as the server last said plus
   * whatever has been read here since. Only ever consulted when a channel is
   * opened, to place the "new" line, so it need not be reactive.
   */
  #readMarkers = new Map<string, string>();
  /** The newest message seen live in each channel, so reading one moves its marker that far. */
  #latestSeen = new Map<string, string>();
  /**
   * Mentions counted here as they arrived, by message id, so deleting one can
   * take it back off the count. Ones the server counted are settled by asking
   * it again instead, since it alone knows which messages they were.
   */
  #liveMentions = new Map<string, string>();
  #unreadRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Coalesces a burst of emoji events into one list reload. */
  #emojiReloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** Member and role changes waiting for the one reload that covers them all. */
  #memberReloads = new MemberReloadQueue();
  #memberReloadTimer: ReturnType<typeof setTimeout> | null = null;

  get activeChannel(): Channel | null {
    return this.channels.find((channel) => channel.id === this.activeChannelId) ?? null;
  }

  channelsIn(categoryId: string | null): Channel[] {
    return this.channels.filter((channel) => channel.categoryId === categoryId);
  }

  /**
   * The number on a channel's red pill: its unread mentions, unless the member
   * asked to hear about nothing there. A mute alone does not hide it, as on
   * Discord, since being named is what a mute still lets through.
   */
  mentionsShown(channel: Pick<Channel, 'id' | 'categoryId'>): number {
    const count = this.mentionCounts[channel.id] ?? 0;
    return count > 0 && channelSettings.resolve(channel).level !== 'nothing' ? count : 0;
  }

  /** Whether a channel stands out as unread: something new in it, and not muted. */
  unreadShown(channel: Pick<Channel, 'id' | 'categoryId'>): boolean {
    return this.unread.has(channel.id) && !channelSettings.resolve(channel).muted;
  }

  /** Replaces the poll on a loaded message, with the one the server just answered with. */
  applyPoll(messageId: string, poll: Poll): void {
    this.messages = this.messages.map((message) => (message.id === messageId ? { ...message, poll } : message));
  }

  /**
   * Brings the store up. When the page was opened from a launch link, `target`
   * names the channel, and sometimes the message, to open: the channel is
   * preferred over the configured default and the message is jumped to once the
   * channel's newest page is in.
   */
  async start(target?: LaunchTarget): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#gatewayUnsubscribe = gateway.onEvent((frame) => this.#handleEvent(frame));
    document.addEventListener('visibilitychange', this.#onVisibility);
    this.#scheduleTimeoutLift();
    await this.loadChannels(target?.channelId ?? null);
    // Settings only quiet things down, so a failure leaves everything on the
    // defaults rather than keeping the app from starting.
    await channelSettings.load().catch(() => {});
    await emojis.load();
    await gifs.loadFavorites();
    await members.load();
    await roster.load();
    await commands.load();
    await voice.load().catch(() => {});
    hostVoice.start();
    gateway.connect();
    // A message named by a launch link is looked for once the channel it names
    // is open. The socket is up first, so fetching the page around the message
    // does not keep live messages waiting.
    if (target && target.messageId !== null && target.channelId !== null) {
      await this.revealLinkedMessage(target.channelId, target.messageId);
    }
  }

  stop(): void {
    this.#started = false;
    this.#connected = false;
    this.#gatewayUnsubscribe?.();
    this.#gatewayUnsubscribe = null;
    gateway.close();
    document.removeEventListener('visibilitychange', this.#onVisibility);
    this.categories = [];
    this.channels = [];
    this.messages = [];
    this.activeChannelId = null;
    this.replyTarget = null;
    this.hasMore = false;
    this.loadingOlder = false;
    this.loadingNewer = false;
    this.loading = false;
    this.detached = false;
    this.highlightedId = null;
    this.unreadChannelIds = [];
    this.mentionCounts = {};
    this.newSince = null;
    this.#unreadHold = null;
    this.#readMarkers.clear();
    this.#latestSeen.clear();
    this.#liveMentions.clear();
    if (this.#unreadRefreshTimer) clearTimeout(this.#unreadRefreshTimer);
    this.#unreadRefreshTimer = null;
    if (this.#emojiReloadTimer) clearTimeout(this.#emojiReloadTimer);
    this.#emojiReloadTimer = null;
    if (this.#memberReloadTimer) clearTimeout(this.#memberReloadTimer);
    this.#memberReloadTimer = null;
    this.#memberReloads.clear();
    channelSettings.reset();
    if (this.#highlightTimer) clearTimeout(this.#highlightTimer);
    this.#highlightTimer = null;
    if (this.#timeoutTimer) clearTimeout(this.#timeoutTimer);
    this.#timeoutTimer = null;
    if (this.#readTimer) clearTimeout(this.#readTimer);
    this.#readTimer = null;
    this.#readPending.clear();
    this.#clearTyping();
    roster.reset();
    commands.reset();
    nameColors.reset();
    voice.reset();
    hostVoice.stop();
    // Unsent messages are keyed by member, so they never leak to the next
    // account in this tab, but a logout should not leave them sitting in
    // session storage either.
    drafts.reset();
  }

  /**
   * Brings the client back in step after the app was away, such as a phone that
   * backgrounded it and was reopened. Nothing arrives while the page is hidden, so
   * the socket is re-established without waiting and everything that can have
   * changed meanwhile is refetched.
   *
   * The open channel keeps the pages it has already loaded: only the newest page
   * is folded in, so a reader who had scrolled up is not yanked to the bottom,
   * while someone sitting at the newest message simply sees it follow along.
   */
  async resync(): Promise<void> {
    gateway.ensureConnected();

    // Resuming on a phone often means resuming with no usable network for a
    // moment, so the one refresh that would throw is caught rather than left to
    // surface as an unhandled rejection. The rest keep whatever they already have.
    void this.loadChannels().catch(() => {});
    void channelSettings.load().catch(() => {});
    void roster.load();
    void members.load();
    void commands.load();
    void emojis.load();
    void gifs.loadFavorites();
    void this.#refreshSession();

    // Someone reading an older stretch after a jump stays where they are; the
    // newest page is what "Jump to present" fetches when they want it.
    if (this.detached) return;
    await this.#catchUp();
  }

  /**
   * Fetches the open channel's newest page and folds it into what is loaded,
   * without the loading state, so nobody loses their place. Messages deleted
   * meanwhile go; if more arrived than one page holds, the list starts over at
   * the present rather than hiding the gap.
   */
  async #catchUp(): Promise<void> {
    const channelId = this.activeChannelId;
    if (!channelId) return;

    try {
      const page = await this.#fetchHistory(channelId);
      // A channel switch while this was in flight must not splice a page from
      // the wrong channel into the open one, and a jump elsewhere in history
      // must not be undone by it.
      if (channelId !== this.activeChannelId || this.detached) return;
      const complete = page.length < historyPageSize;
      const merged = mergeLatest(this.messages, page, complete);
      this.messages = merged.messages;
      if (merged.reset) {
        this.hasMore = !complete;
        // The place the reader had is gone, so put them at the newest message,
        // which a replaced list would not do on its own.
        if (!complete) this.scrollSignal += 1;
      }
    } catch {
      // Still offline, or the channel was locked away while we were gone. The
      // channel list refresh is what deals with the second case.
    }
  }

  /**
   * Checks every loaded message against the server again, page by page from the
   * newest one loaded back to the oldest, and drops whatever has gone. Used after
   * a retention prune, which deletes old messages and attachments but does not
   * say which; refetching only the newest page would never reach them.
   */
  async #reconcileLoaded(): Promise<void> {
    const channelId = this.activeChannelId;
    const first = this.messages[0];
    const last = this.messages.at(-1);
    if (!channelId || !first || !last) return;

    try {
      // One millisecond past the newest loaded message, so the walk includes it.
      let cursor: { before: string; beforeId?: string } = {
        before: new Date(Date.parse(last.createdAt) + 1).toISOString(),
      };
      const window: Message[] = [];
      let complete = false;
      for (let pages = 0; pages < reconcileMaxPages; pages++) {
        const page = await this.#fetchHistory(channelId, cursor, reconcilePageSize);
        window.unshift(...page);
        const top = page[0];
        if (!top || page.length < reconcilePageSize) {
          complete = true;
          break;
        }
        if (top.createdAt < first.createdAt) break;
        cursor = { before: top.createdAt, beforeId: top.id };
      }

      if (channelId !== this.activeChannelId) return;
      const merged = mergeLatest(this.messages, window, complete);
      this.messages = merged.messages;
      if (merged.reset) this.hasMore = false;
    } catch {
      // Offline or locked away; the next catch-up will get it right.
    }
  }

  /**
   * Re-dresses loaded messages in their authors' current names, pictures and
   * role colors, from the freshly loaded member directory. Cheaper than
   * refetching history, keeps the reader's place, and reaches the older pages a
   * refetch of the newest one would miss. With `userIds` null everyone is
   * checked, as after a role change that can recolor many people at once.
   */
  #refreshAuthors(userIds: ReadonlySet<string> | null): void {
    const current = (user: User | null): User | null => {
      if (!user || (userIds !== null && !userIds.has(user.id))) return user;
      const fresh = members.byId.get(user.id);
      return fresh && !sameFace(fresh, user) ? fresh : user;
    };

    let changed = false;
    const next = this.messages.map((message) => {
      const author = current(message.author);
      const replyAuthor = message.replyTo ? current(message.replyTo.author) : null;
      if (author === message.author && replyAuthor === (message.replyTo?.author ?? null)) return message;
      changed = true;
      return {
        ...message,
        author,
        replyTo: message.replyTo ? { ...message.replyTo, author: replyAuthor } : null,
      };
    });
    if (changed) this.messages = next;
  }

  async loadChannels(linkedChannelId: string | null = null): Promise<void> {
    const data = await api<ChannelListResponse>('/channels');
    this.categories = data.categories;
    this.channels = data.channels;
    this.#applyReadState(data);

    // Keep the current selection if it still exists. Otherwise open the channel
    // a launch link named, when the instance knows it, ahead of the
    // admin-configured default, falling back to the first channel and finally to
    // nothing when the instance has no channels at all. An unknown or malformed
    // id simply falls through to the default rather than leaving the app blank.
    const stillExists = this.channels.some((channel) => channel.id === this.activeChannelId);
    if (!stillExists) {
      const linked =
        linkedChannelId !== null && this.channels.some((channel) => channel.id === linkedChannelId)
          ? linkedChannelId
          : null;
      const preferred = linked ?? this.channels.find((channel) => channel.id === data.defaultChannelId)?.id;
      await this.selectChannel(preferred ?? this.channels[0]?.id ?? null);
    } else if (this.activeChannelId) {
      // A refresh can arrive with the open channel marked unread, for instance
      // after a role change brought it back into view. It is open, so it is read,
      // unless the member marked it unread themselves.
      this.#markRead(this.activeChannelId, false);
    }
  }

  /** Takes the server's word on what is unread, how many mentions wait where, and how far each channel was read. */
  #applyReadState(data: ChannelListResponse): void {
    this.unreadChannelIds = data.unreadChannelIds;
    this.mentionCounts = data.mentionCounts;
    // Whatever was counted live is in the server's numbers now.
    this.#liveMentions.clear();
    // A read sent a moment ago may not have landed yet, which is why markers
    // only ever move forward here.
    for (const [channelId, readAt] of Object.entries(data.readMarkers)) this.#advanceMarker(channelId, readAt);
  }

  /**
   * Asks the server again what is unread, a moment after something happened
   * that only it can settle, such as a message being deleted in a channel that
   * has mentions waiting. Coalesced, since a purge deletes many at once.
   */
  #refreshUnreadSoon(): void {
    if (this.#unreadRefreshTimer) return;
    this.#unreadRefreshTimer = setTimeout(() => {
      this.#unreadRefreshTimer = null;
      void api<ChannelListResponse>('/channels')
        .then((data) => {
          this.#applyReadState(data);
          // The open channel is being read, whatever the server thought a moment
          // ago, unless the member has marked it unread.
          if (this.activeChannelId && document.visibilityState === 'visible' && !this.detached) {
            this.#markRead(this.activeChannelId, true);
          }
        })
        .catch(() => {});
    }, readDebounceMs);
  }

  /**
   * Marks channels read without opening them, from the sidebar's "Mark as
   * read" on a channel or a whole category.
   */
  markChannelsRead(channelIds: readonly string[]): void {
    // Marking a held channel read is the member reading it after all.
    if (this.#unreadHold !== null && channelIds.includes(this.#unreadHold)) this.#unreadHold = null;
    let marked = false;
    for (const channelId of channelIds) {
      if (!this.unread.has(channelId) && !this.mention.has(channelId)) continue;
      this.#queueRead(channelId);
      marked = true;
    }
    if (this.activeChannelId && channelIds.includes(this.activeChannelId)) this.newSince = null;
    // Mark the whole batch first, then flush once, rather than flushing after each channel.
    if (marked) {
      if (this.#readTimer) {
        clearTimeout(this.#readTimer);
        this.#readTimer = null;
      }
      this.#flushRead();
    }
    // Only the server knows which message a channel nobody opened was read up
    // to, and the next visit's "new" line needs it.
    if (marked) this.#refreshUnreadSoon();
  }

  /**
   * The "Mark as read" on the bar over the open channel: the channel is read
   * already, so this only lets go of the "new" line and the bar that points at it.
   */
  dismissNew(): void {
    this.newSince = null;
    this.#unreadHold = null;
    if (this.activeChannelId) this.#markRead(this.activeChannelId, false);
  }

  /**
   * Marks a channel unread from one of its messages, Discord's Alt+click: the
   * server moves this member's read marker back to just before it, and answers
   * with where the channel then stands, which is taken as is. The channel is
   * unread in the sidebar with its mention count, and when it is the open one the
   * "new" line moves above the message and the channel is held unread for as
   * long as the member stays in it (see `#unreadHold`).
   */
  async markUnreadFrom(message: Message): Promise<void> {
    const channelId = message.channelId;
    // Held from the start, so nothing reads it again while the request is out,
    // and a read still waiting to go is dropped rather than sent after it.
    if (channelId === this.activeChannelId) this.#unreadHold = channelId;
    this.#readPending.delete(channelId);
    let result: ChannelUnreadResponse;
    try {
      // A read already on its way could land after this and undo it.
      await this.#readsInFlight.get(channelId);
      result = await api<ChannelUnreadResponse>(`/channels/${channelId}/unread`, {
        method: 'POST',
        body: JSON.stringify({ messageId: message.id }),
      });
    } catch (cause) {
      if (this.#unreadHold === channelId) this.#unreadHold = null;
      throw cause;
    }

    const next = withChannelReadState(this.unreadChannelIds, this.mentionCounts, result);
    this.unreadChannelIds = next.unreadChannelIds;
    this.mentionCounts = next.mentionCounts;
    // The server's count takes in the mentions counted here as they arrived.
    for (const [messageId, counted] of this.#liveMentions) {
      if (counted === channelId) this.#liveMentions.delete(messageId);
    }
    // Set rather than advanced: the marker has moved back, which is the point.
    this.#readMarkers.set(channelId, result.readAt);
    if (channelId === this.activeChannelId) this.newSince = result.readAt;
  }

  /**
   * Says the open channel has been read: it stops being marked here at once, and
   * the server is told, which is what makes it stay read across a reload.
   *
   * The telling is coalesced when it rides on incoming messages, since a busy
   * channel would otherwise mean a request per message, and the same request twice
   * within a moment is the same request.
   */
  #markRead(channelId: string, soon: boolean): void {
    if (channelId === this.#unreadHold) return;
    this.#queueRead(channelId);

    if (this.#readTimer) {
      clearTimeout(this.#readTimer);
      this.#readTimer = null;
    }
    if (soon) {
      this.#readTimer = setTimeout(() => {
        this.#readTimer = null;
        this.#flushRead();
      }, readDebounceMs);
    } else {
      this.#flushRead();
    }
  }

  /**
   * Marks a channel read here and queues telling the server, without sending.
   * A channel the member has marked unread is left as it is until they let go
   * of it, which whoever reads it on purpose does first.
   */
  #queueRead(channelId: string): void {
    if (channelId === this.#unreadHold) return;
    this.#clearUnread(channelId);
    // The server moves its marker to the newest message; follow it as far as
    // what has been seen here, so the next visit's "new" line starts after it.
    if (channelId === this.activeChannelId) this.#advanceMarker(channelId, this.messages.at(-1)?.createdAt);
    this.#advanceMarker(channelId, this.#latestSeen.get(channelId));
    this.#readPending.add(channelId);
  }

  /** Drops a channel's unread mark and mention count, without telling the server. */
  #clearUnread(channelId: string): void {
    if (this.unread.has(channelId)) {
      this.unreadChannelIds = this.unreadChannelIds.filter((id) => id !== channelId);
    }
    // Reading a channel reads the mentions in it too, so the count goes with it.
    if (channelId in this.mentionCounts) this.#setMentionCount(channelId, 0);
  }

  /** Sets one channel's mention count, dropping the entry once nothing is left. */
  #setMentionCount(channelId: string, count: number): void {
    const next = { ...this.mentionCounts };
    if (count > 0) next[channelId] = count;
    else delete next[channelId];
    this.mentionCounts = next;
  }

  /**
   * Moves this client's idea of a channel's read marker forward, never back. A
   * held channel's marker stays where the member put it, so the "new" line is in
   * the same place when they come back to it.
   */
  #advanceMarker(channelId: string, readAt: string | undefined): void {
    if (channelId === this.#unreadHold) return;
    const known = this.#readMarkers.get(channelId);
    if (readAt && (!known || readAt > known)) this.#readMarkers.set(channelId, readAt);
  }

  #flushRead(): void {
    const ids = [...this.#readPending];
    this.#readPending.clear();
    for (const id of ids) {
      const sent = api(`/channels/${id}/read`, { method: 'POST' }).then(
        () => {},
        () => {
          // Best effort: opening the channel again marks it once more.
        },
      );
      this.#readsInFlight.set(id, sent);
      void sent.then(() => {
        if (this.#readsInFlight.get(id) === sent) this.#readsInFlight.delete(id);
      });
    }
  }

  /**
   * Coming back to a tab with a channel open means its messages have been seen,
   * so it stops being marked. Anything that arrived while the tab was out of
   * sight stayed marked until now.
   */
  #onVisibility = (): void => {
    if (document.visibilityState === 'visible' && this.activeChannelId) {
      this.#markRead(this.activeChannelId, true);
    }
  };

  async selectChannel(channelId: string | null): Promise<void> {
    // Leaving a held channel, or opening it afresh, ends the hold: it stays
    // unread behind the member, and opening it is reading it.
    this.#unreadHold = null;
    this.activeChannelId = channelId;
    this.messages = [];
    this.hasMore = false;
    this.loadingOlder = false;
    this.loadingNewer = false;
    this.detached = false;
    this.replyTarget = null;
    this.highlightedId = null;
    this.newSince = this.#unreadSince(channelId);
    if (channelId) this.#markRead(channelId, false);
    this.#clearTyping();
    if (channelId) await this.loadHistory(channelId);
    // Nothing to load, and any load still out belongs to a channel left behind.
    else this.loading = false;
  }

  /**
   * Where the "new" line should start for a channel about to be opened: its
   * read marker, if it has something unread past it. A channel never read at
   * all has no marker, and drawing the line over its whole history would say
   * nothing, so it gets none.
   */
  #unreadSince(channelId: string | null): string | null {
    if (!channelId || !this.unread.has(channelId)) return null;
    return this.#readMarkers.get(channelId) ?? null;
  }

  /** One page of a channel's history, oldest first: the newest page, or the one the cursor names. */
  async #fetchHistory(channelId: string, cursor?: HistoryCursor, limit: number = historyPageSize): Promise<Message[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    for (const [key, value] of Object.entries(cursor ?? {})) {
      if (value) query.set(key, value);
    }
    const data = await api<{ messages: Message[] }>(`/channels/${channelId}/messages?${query}`);
    return data.messages;
  }

  async loadHistory(channelId: string): Promise<void> {
    const load = ++this.#historyLoad;
    this.loading = true;
    try {
      const messages = await this.#fetchHistory(channelId);
      if (load === this.#historyLoad && channelId === this.activeChannelId) {
        this.messages = messages;
        this.hasMore = messages.length >= historyPageSize;
        this.detached = false;
        // Opening the channel read it, up to what has just been loaded.
        this.#advanceMarker(channelId, messages.at(-1)?.createdAt);
      }
    } catch (cause) {
      // Access to a locked channel can be taken away while it is open. Refresh the
      // list, which drops it and opens one we can still see.
      if (
        cause instanceof ApiError &&
        (cause.status === 403 || cause.status === 404) &&
        channelId === this.activeChannelId &&
        !this.#healing
      ) {
        this.#healing = true;
        try {
          await this.loadChannels();
        } finally {
          this.#healing = false;
        }
      }
    } finally {
      if (load === this.#historyLoad) this.loading = false;
    }
  }

  /**
   * Opens a channel at a particular message, for a search result. The page holds
   * the messages just before it and the message itself is put on the end, so it
   * appears with its context above it rather than alone.
   *
   * The newest page is fetched alongside. When the message is in it, the two
   * join up and the view is simply the present; otherwise the view is detached
   * from the present until the reader asks to go back.
   */
  async jumpToMessage(channelId: string, message: Message): Promise<void> {
    // A jump within the open channel keeps its "new" line where it was, and a
    // hold on it too; a jump elsewhere leaves it behind, unread.
    if (channelId !== this.activeChannelId) {
      this.#unreadHold = null;
      this.newSince = this.#unreadSince(channelId);
    }
    this.activeChannelId = channelId;
    this.messages = [];
    this.hasMore = false;
    this.loadingOlder = false;
    this.loadingNewer = false;
    this.detached = false;
    this.replyTarget = null;
    this.highlightedId = null;
    this.#clearTyping();
    // Jumping into a channel is opening it, so it counts as read: this is what
    // clears a search result's channel and the inbox entry that led here.
    this.#markRead(channelId, false);

    const load = ++this.#historyLoad;
    this.loading = true;
    try {
      const [page, newest] = await Promise.all([
        this.#fetchHistory(channelId, { before: message.createdAt, beforeId: message.id }),
        this.#fetchHistory(channelId),
      ]);
      if (load !== this.#historyLoad || channelId !== this.activeChannelId) return;
      const newestIds = new Set(newest.map((entry) => entry.id));
      if (newestIds.has(message.id)) {
        this.messages = [...page.filter((entry) => !newestIds.has(entry.id)), ...newest];
      } else {
        this.messages = [...page, message];
        this.detached = true;
      }
      this.hasMore = page.length >= historyPageSize;
    } catch {
      // A message that vanished between searching and jumping is not worth an
      // error: the channel still opens, just at its newest page.
      if (load === this.#historyLoad) await this.loadHistory(channelId);
    } finally {
      if (load === this.#historyLoad) this.loading = false;
    }

    this.#highlight(message.id);
    // Bring the jumped-to message into view. When it is the last one loaded the
    // end of the list is exactly that; when newer ones follow it, the message
    // view looks for the highlighted row instead.
    this.scrollSignal += 1;
  }

  /** Leaves an older stretch of history for the channel's newest messages. */
  async jumpToPresent(): Promise<void> {
    const channelId = this.activeChannelId;
    if (!channelId) return;
    this.highlightedId = null;
    await this.loadHistory(channelId);
    if (channelId !== this.activeChannelId) return;
    if (document.visibilityState === 'visible') this.#markRead(channelId, false);
    this.scrollSignal += 1;
  }

  /**
   * Brings a message in the open channel into view and flashes it, however far
   * back in history it sits. One already loaded is simply scrolled to. Otherwise
   * the server is asked for the page centred on it, in one request: when that
   * page meets the present the two are joined and the reader stays in the
   * present, and when it does not it is shown as an older stretch, which
   * scrolling down carries forward a page at a time until it is the present
   * again, exactly like the stretch a search result opens.
   *
   * A message that has been deleted, or is not in this channel at all, leaves
   * the view as it was rather than blanking it.
   */
  async revealMessage(messageId: string): Promise<void> {
    const channelId = this.activeChannelId;
    if (!channelId) return;
    if (this.messages.some((message) => message.id === messageId)) {
      this.#highlight(messageId);
      this.scrollSignal += 1;
      return;
    }

    // A list that reaches the present already says what the present is. One
    // still loading, or showing an older stretch, does not, so the newest page is
    // fetched alongside, as a jump to a search result does.
    const knowsPresent = !this.loading && !this.detached;
    const load = ++this.#historyLoad;
    try {
      const [page, newest] = await Promise.all([
        this.#fetchHistory(channelId, { around: messageId }),
        knowsPresent ? null : this.#fetchHistory(channelId),
      ]);
      if (load !== this.#historyLoad || channelId !== this.activeChannelId) return;
      const present = newest
        ? { messages: newest, hasMore: newest.length >= historyPageSize }
        : { messages: this.messages, hasMore: this.hasMore };
      const view = windowAround(page, messageId, historyPageSize, present);
      if (!view) return;
      this.messages = view.messages;
      this.hasMore = view.hasMore;
      this.detached = view.detached;
      this.#highlight(messageId);
      // The message view finds the flashed row and centres it.
      this.scrollSignal += 1;
    } catch {
      // Deleted, never in this channel, or the request failed. The list on
      // screen stays; one that was still loading opens at the newest page
      // instead, since the load this replaced will not land now.
      if (load === this.#historyLoad && this.messages.length === 0) await this.loadHistory(channelId);
    } finally {
      if (load === this.#historyLoad) this.loading = false;
    }
  }

  /**
   * Takes the reader to a message named by a launch link, as a notification tap
   * or a deep link carries it. Only the channel the link opened is looked in: a
   * link whose channel the instance does not know leaves the default channel
   * open at its newest page, rather than the screen going blank.
   */
  async revealLinkedMessage(channelId: string, messageId: string): Promise<void> {
    if (channelId !== this.activeChannelId) return;
    await this.revealMessage(messageId);
  }

  /** Flashes a message for a few seconds, so a jump is obvious. */
  #highlight(messageId: string): void {
    this.highlightedId = messageId;
    if (this.#highlightTimer) clearTimeout(this.#highlightTimer);
    this.#highlightTimer = setTimeout(() => {
      this.highlightedId = null;
      this.#highlightTimer = null;
    }, 3000);
  }

  /**
   * Fetches the page of messages just before the oldest one loaded and prepends
   * it. The cursor is the oldest message's timestamp together with its id, so a
   * burst of messages sharing a millisecond is never skipped.
   */
  async loadOlder(): Promise<void> {
    const channelId = this.activeChannelId;
    const oldest = this.messages[0];
    if (!channelId || !oldest || this.loadingOlder || !this.hasMore) return;

    const load = this.#historyLoad;
    this.loadingOlder = true;
    try {
      const page = await this.#fetchHistory(channelId, { before: oldest.createdAt, beforeId: oldest.id });
      // A channel switch or a jump while this was in flight must not splice in
      // history from before a list that is no longer there. A reply's quote
      // replaces the list only when its page lands, after this may have set off,
      // so the page also has to still meet the list's first message.
      if (channelId !== this.activeChannelId || load !== this.#historyLoad) return;
      if (this.messages[0]?.id !== oldest.id) return;
      this.messages = [...page, ...this.messages];
      this.hasMore = page.length >= historyPageSize;
    } finally {
      this.loadingOlder = false;
    }
  }

  /**
   * Fetches the page just after the newest message loaded and appends it, while
   * the open channel shows an older stretch, so a reader who jumped back can read
   * on towards the present rather than only leap to it. A short page is the
   * newest one: the stretch has rejoined the present, live messages flow into it
   * again, and a member who read down to it has read the channel, as one who
   * took the leap has.
   */
  async loadNewer(): Promise<void> {
    const channelId = this.activeChannelId;
    const newest = this.messages.at(-1);
    if (!channelId || !newest || this.loadingNewer || !this.detached) return;

    const load = this.#historyLoad;
    this.loadingNewer = true;
    try {
      const page = await this.#fetchHistory(channelId, { after: newest.createdAt, afterId: newest.id });
      if (channelId !== this.activeChannelId || load !== this.#historyLoad || !this.detached) return;
      // As in loadOlder: a list replaced meanwhile no longer ends where this
      // page begins, and joining the two would hide what lies between them.
      if (this.messages.at(-1)?.id !== newest.id) return;
      const next = appendNewer(this.messages, page, historyPageSize);
      this.messages = next.messages;
      this.detached = next.detached;
      if (!next.detached) {
        // Live messages were held back until now, and one may have landed
        // between the page being read and its arriving here; the newest page,
        // folded in, settles that.
        void this.#catchUp();
        if (document.visibilityState === 'visible') this.#markRead(channelId, false);
      }
    } catch {
      // Offline, or the channel was locked away meanwhile. Scrolling down again
      // tries again, and the bar's leap to the present is still there.
    } finally {
      this.loadingNewer = false;
    }
  }

  /**
   * Loads older pages until the first message after the read marker is among
   * them, for the bar that offers to jump there. Bounded, so a channel with a
   * vast backlog stops at a sensible depth rather than pulling in everything.
   */
  async loadToFirstUnread(): Promise<void> {
    const channelId = this.activeChannelId;
    const since = this.newSince;
    if (!channelId || since === null) return;
    for (let pages = 0; pages < unreadJumpMaxPages; pages++) {
      const oldest = this.messages[0];
      if (!this.hasMore || !oldest || oldest.createdAt <= since || this.loadingOlder) return;
      await this.loadOlder();
      if (channelId !== this.activeChannelId) return;
    }
  }

  async sendMessage(content: string, attachmentIds: string[] = [], replyToId: string | null = null): Promise<void> {
    const channelId = this.activeChannelId;
    if (!channelId) return;
    const message = await api<Message>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        replyToId: replyToId ?? undefined,
      }),
    });
    emojiUsage.recordContent(content);
    // Posting read the channel on the server, so a hold on it is over, and the
    // client follows at once rather than waiting for the echo.
    if (this.#unreadHold === channelId) {
      this.#unreadHold = null;
      this.#markRead(channelId, true);
    }
    if (channelId !== this.activeChannelId) return;

    // Sending from an older stretch of history means wanting to see the reply
    // land, so go back to the present, which will include it.
    if (this.detached) {
      await this.jumpToPresent();
      return;
    }
    // The gateway echoes it as MESSAGE_CREATE too, but a socket that died without
    // saying so would never deliver it and the message would seem to vanish. The
    // response is the same message, and the insert ignores whichever comes second.
    this.#insertMessage(message);
  }

  /**
   * Puts a message into the open channel's list in time order, unless it is
   * already there. A history import can deliver older messages, so it is placed
   * by timestamp rather than always appended.
   */
  #insertMessage(message: Message): void {
    if (this.messages.some((existing) => existing.id === message.id)) return;
    // An older stretch of history only takes messages that belong inside it.
    const last = this.messages.at(-1);
    if (this.detached && (!last || message.createdAt > last.createdAt)) return;

    const next = [...this.messages];
    let index = next.length;
    while (index > 0) {
      const previous = next[index - 1];
      if (!previous || previous.createdAt <= message.createdAt) break;
      index--;
    }
    next.splice(index, 0, message);
    this.messages = next;
  }

  /** Adds or removes the current user's reaction; the gateway echoes the result. */
  async toggleReaction(messageId: string, emoji: string, emojiId: string | null): Promise<void> {
    const removing = this.messages.find((m) => m.id === messageId)?.reactions.some((r) => r.emoji === emoji && r.me);
    await api(`/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji, emojiId: emojiId ?? undefined }),
    });
    if (!removing) emojiUsage.record([{ emoji, emojiId }]);
  }

  /** Edits a message's text; the gateway echoes the update. */
  async editMessage(messageId: string, content: string): Promise<void> {
    await api(`/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify({ content }) });
  }

  /** Deletes a message; the gateway echoes the removal. */
  async deleteMessage(messageId: string): Promise<void> {
    await api(`/messages/${messageId}`, { method: 'DELETE' });
  }

  /** Tells the server we are typing in the open channel. Best effort. */
  async sendTyping(): Promise<void> {
    const channelId = this.activeChannelId;
    if (!channelId) return;
    try {
      await api(`/channels/${channelId}/typing`, { method: 'POST' });
    } catch {
      // A typing ping is never important enough to surface an error.
    }
  }

  /** Adds or refreshes one person's typing indicator. */
  #noteTyping(user: User): void {
    const expiresAt = Date.now() + typingTtlMs;
    const others = this.typingUsers.filter((entry) => entry.user.id !== user.id);
    this.typingUsers = [...others, { user, expiresAt }];
    this.#startTypingSweep();
  }

  #clearTyping(): void {
    this.typingUsers = [];
    this.#stopTypingSweep();
  }

  #startTypingSweep(): void {
    if (this.#typingTimer) return;
    this.#typingTimer = setInterval(() => {
      const now = Date.now();
      const live = this.typingUsers.filter((entry) => entry.expiresAt > now);
      if (live.length !== this.typingUsers.length) this.typingUsers = live;
      if (live.length === 0) this.#stopTypingSweep();
    }, typingSweepMs);
  }

  #stopTypingSweep(): void {
    if (!this.#typingTimer) return;
    clearInterval(this.#typingTimer);
    this.#typingTimer = null;
  }

  async #refreshSession(): Promise<void> {
    try {
      const me = await api<MeResponse>('/auth/me');
      session.user = me.user;
      session.permissions = me.permissions;
    } catch (cause) {
      // The session is gone: kicked, banned or expired. A request that never
      // reached the server is a different matter, and must not sign anyone out.
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
        session.user = null;
        session.permissions = '0';
      }
    }
    this.#scheduleTimeoutLift();
  }

  /**
   * A timeout ends on its own, with no event to say so, and whether one applies
   * is read from the session user against the clock. So the session is refreshed
   * just after it runs out: the new user object is what makes the composer look
   * again and reopen.
   */
  #scheduleTimeoutLift(): void {
    if (this.#timeoutTimer) clearTimeout(this.#timeoutTimer);
    this.#timeoutTimer = null;

    const until = session.user?.timedOutUntil;
    if (!until) return;
    const remaining = Date.parse(until) - Date.now();
    if (!(remaining > 0)) return;
    // A moment's grace so the server agrees it is over. A timeout too long for
    // one timer simply refreshes early and schedules the rest.
    this.#timeoutTimer = setTimeout(
      () => {
        this.#timeoutTimer = null;
        void this.#refreshSession();
      },
      Math.min(remaining + 1000, maxTimerMs),
    );
  }

  /**
   * Whether a message is aimed at the signed-in member, by a reply or by name.
   * It is the same question the sound and the channel mark both ask, so the two
   * can never disagree about what counts as a mention.
   */
  #mentionsMe(message: Message): boolean {
    const me = session.user;
    if (!me || message.author?.id === me.id) return false;
    return mentionsUser(message, me.id, (name) => members.byUsername.get(name.toLowerCase()));
  }

  /**
   * Plays the sound a new message deserves, if the member wants one. Nothing is
   * played for their own messages, and nothing ever leaves the page: this is the
   * in-app sound, not a device notification.
   */
  #notify(message: Message): void {
    const me = session.user;
    if (!me || message.author?.id === me.id) return;

    // The member's own say over the channel comes first: a muted channel, or one
    // set to nothing, stays silent whatever arrives in it, and one set to only
    // mentions lets nothing else through.
    const channel = this.channels.find((entry) => entry.id === message.channelId);
    const settings = channel ? channelSettings.resolve(channel) : null;
    if (settings && (settings.muted || settings.level === 'nothing')) return;

    // A mention is aimed at this person wherever they happen to be looking, so
    // it is worth the louder sound even from another channel.
    if (this.#mentionsMe(message)) {
      if (me.notifyMajor) playSound('major');
      return;
    }
    if (settings?.level === 'mentions') return;

    // Anything else only counts in the channel being read. Otherwise a busy
    // instance would chirp once per message in every channel at once.
    if (message.channelId === this.activeChannelId && me.notifyMinor) playSound('minor');
  }

  /**
   * Reloads the member directory and the roster once the member and role events
   * have gone quiet for a moment (see lib/member-reload.ts), and then re-dresses
   * the messages on screen for everyone those events named. The wait starts
   * over with each event, up to a limit, and `delay` is what the queue said is
   * left of it.
   */
  #reloadMembersSoon(delay: number): void {
    if (this.#memberReloadTimer !== null) clearTimeout(this.#memberReloadTimer);
    this.#memberReloadTimer = setTimeout(() => {
      this.#memberReloadTimer = null;
      const reload = this.#memberReloads.take();
      if (!reload) return;
      if (reload.channels) void this.loadChannels();
      void roster.load();
      void members.load().then(() => this.#refreshAuthors(reload.authors));
    }, delay);
  }

  /** Reloads the custom emoji list once, after a short settle. */
  #reloadEmojisSoon(): void {
    if (this.#emojiReloadTimer !== null) clearTimeout(this.#emojiReloadTimer);
    this.#emojiReloadTimer = setTimeout(() => {
      this.#emojiReloadTimer = null;
      void emojis.load();
    }, emojiReloadMs);
  }

  #handleEvent(frame: GatewayFrame): void {
    // Voice is its own concern; hand its frames straight to the voice store.
    if (frame.t === 'VOICE_STATE_UPDATE' || frame.t === 'VOICE_SIGNAL') {
      voice.handleFrame(frame);
      return;
    }
    switch (frame.t) {
      case 'MESSAGE_CREATE': {
        const message = frame.d as Message;
        this.#notify(message);

        const active = message.channelId === this.activeChannelId;
        const mine = message.author !== null && message.author.id === session.user?.id;
        // Posting reads a channel on the server, so a member who marked it unread
        // and then wrote in it, here or on another device, has read it after all.
        if (mine && message.channelId === this.#unreadHold) this.#unreadHold = null;
        this.#latestSeen.set(message.channelId, message.createdAt);
        // An open channel in a tab nobody is looking at has not really been read,
        // so only the visible case counts. Coming back to the tab readies it again.
        // Neither has one showing an older stretch, where the message is held back,
        // nor one the member has marked unread.
        const reading =
          active &&
          document.visibilityState === 'visible' &&
          !this.detached &&
          message.channelId !== this.#unreadHold;
        if (reading) {
          this.#markRead(message.channelId, true);
        } else if (mine) {
          // Sent from another device. Posting reads the channel on the server, so
          // it is not news here either: drop the marks and follow the marker.
          this.#advanceMarker(message.channelId, message.createdAt);
          this.#clearUnread(message.channelId);
        } else {
          // The first message to arrive unseen in the open channel is where the
          // "new" line goes, for when the member comes back to the tab.
          if (active && this.newSince === null) this.newSince = this.#readMarkers.get(message.channelId) ?? null;
          if (!this.unread.has(message.channelId)) {
            this.unreadChannelIds = [...this.unreadChannelIds, message.channelId];
          }
        }

        // A mention aims at this member wherever they are, so it earns the red
        // number even in a channel they are not looking at. Reading it clears the
        // count, so the open-and-visible case is left to #markRead above, and a
        // message this account posted elsewhere has just been cleared too.
        if (!reading && !mine && this.#mentionsMe(message)) {
          this.#setMentionCount(message.channelId, (this.mentionCounts[message.channelId] ?? 0) + 1);
          this.#liveMentions.set(message.id, message.channelId);
        }

        if (!active) break;
        // Whoever sent it has stopped typing it, so their notice goes now rather
        // than lingering for the rest of its few seconds under their message.
        if (message.author && this.typingUsers.some((entry) => entry.user.id === message.author?.id)) {
          this.typingUsers = this.typingUsers.filter((entry) => entry.user.id !== message.author?.id);
        }
        this.#insertMessage(message);
        break;
      }
      case 'MESSAGE_UPDATE': {
        const message = frame.d as Message;
        if (message.channelId === this.activeChannelId) {
          // Reactions are kept in sync by their own events, and an edit carries a
          // viewer-specific `me`, so never let it clobber what we already have.
          // The same goes for `saved`, which a broadcast never knows.
          this.messages = this.messages.map((existing) => {
            if (existing.id === message.id) {
              return {
                ...message,
                reactions: existing.reactions,
                saved: existing.saved,
                // The same for the member's own poll choice, which a broadcast never knows.
                poll: message.poll && existing.poll ? { ...message.poll, myVotes: existing.poll.myVotes } : message.poll,
              };
            }
            // A reply quotes the text it answers, and the server only fills the
            // quote in when history is fetched, so an edit has to reach the
            // replies already on screen here. Replies only ever answer a message
            // in their own channel, so the open channel's list is all there is.
            if (existing.replyTo?.id === message.id) {
              return { ...existing, replyTo: { ...existing.replyTo, content: message.content } };
            }
            return existing;
          });
          if (this.replyTarget?.id === message.id) this.replyTarget = { ...this.replyTarget, content: message.content };
        }
        break;
      }
      case 'POLL_UPDATE': {
        const payload = frame.d as PollUpdatePayload;
        if (payload.channelId !== this.activeChannelId) break;
        this.messages = this.messages.map((message) =>
          message.id === payload.messageId && message.poll
            ? { ...message, poll: applyPollUpdate(message.poll, payload, session.user?.id ?? null) }
            : message,
        );
        break;
      }
      case 'MESSAGE_REACTION_ADD':
      case 'MESSAGE_REACTION_REMOVE': {
        const payload = frame.d as ReactionUpdatePayload;
        if (payload.channelId !== this.activeChannelId) break;
        const mode = frame.t === 'MESSAGE_REACTION_ADD' ? 'add' : 'remove';
        this.messages = this.messages.map((message) =>
          message.id === payload.messageId
            ? { ...message, reactions: applyReactionDelta(message.reactions, payload, session.user?.id, mode) }
            : message,
        );
        break;
      }
      case 'MESSAGE_REACTIONS_CLEAR': {
        const payload = frame.d as ReactionsClearPayload;
        if (payload.channelId !== this.activeChannelId) break;
        this.messages = this.messages.map((message) =>
          message.id === payload.messageId
            ? { ...message, reactions: message.reactions.filter((r) => r.emoji !== payload.emoji) }
            : message,
        );
        break;
      }
      case 'MESSAGE_DELETE': {
        const payload = frame.d as { id: string; channelId: string };
        if (payload.channelId === this.activeChannelId) {
          // Replies to it stay, quoting nothing, the way a fetched page draws them.
          this.messages = this.messages
            .filter((message) => message.id !== payload.id)
            .map((message) =>
              message.replyTo?.id === payload.id
                ? { ...message, replyTo: { ...message.replyTo, content: '', deleted: true } }
                : message,
            );
          // The server refuses a reply to a deleted message, so a reply being
          // written to this one would only fail on send; let it go now instead.
          if (this.replyTarget?.id === payload.id) this.replyTarget = null;
        }
        // A deleted mention no longer counts. One counted here can be taken off
        // directly; for the rest only the server knows whether this was one of
        // them, and whether the channel still has anything unread without it.
        const counted = this.#liveMentions.get(payload.id);
        if (counted !== undefined) {
          this.#liveMentions.delete(payload.id);
          this.#setMentionCount(counted, (this.mentionCounts[counted] ?? 0) - 1);
        } else if (
          this.unread.has(payload.channelId) &&
          (payload.channelId !== this.activeChannelId || payload.channelId === this.#unreadHold)
        ) {
          this.#refreshUnreadSoon();
        }
        break;
      }
      case 'CHANNEL_SETTINGS_UPDATE':
        channelSettings.apply(frame.d as ChannelNotificationSettings);
        break;
      case 'TYPING_START': {
        const payload = frame.d as TypingStartPayload;
        if (payload.channelId !== this.activeChannelId) break;
        // Never echo our own typing, and respect a viewer who turned them off.
        if (payload.user.id === session.user?.id) break;
        if (!session.user?.showTyping) break;
        this.#noteTyping(payload.user);
        break;
      }
      case 'PRESENCE_UPDATE':
        roster.applyPresence(frame.d as PresenceUpdatePayload);
        break;
      case 'READY':
        // A reconnect means the socket was away. Anything the bridge backfilled
        // meanwhile is delivered as fetched history rather than live events, so
        // pull what changed instead of waiting for the next channel switch.
        if (this.#connected) {
          void this.resync();
          break;
        }
        this.#connected = true;
        // Closes the gap between the first roster load and the gateway connecting.
        void roster.load();
        break;
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
      case 'CHANNEL_DELETE':
      case 'CATEGORY_CREATE':
      case 'CATEGORY_UPDATE':
      case 'CATEGORY_DELETE':
        void this.loadChannels();
        break;
      case 'ROLE_CREATE':
      case 'ROLE_UPDATE':
      case 'ROLE_DELETE':
        // Roles decide username colors, member list grouping and which channels
        // are locked, so refresh the channel list and the roster, and recolor the
        // names on screen. Reloading the history would do that too, but would
        // also throw a reader scrolled back through it to the newest messages.
        // Editing roles tends to come in runs, so the refresh waits for a pause.
        this.#reloadMembersSoon(this.#memberReloads.role(Date.now()));
        break;
      case 'COMMANDS_UPDATE':
        // A bot changed the commands it offers, so the completion list is stale.
        void commands.load();
        break;

      case 'MEMBER_UPDATE': {
        const payload = frame.d as { userId: string };
        // The roster and mention list may have changed. They are reloaded once
        // a run of such events has paused, since a role handed to several people
        // or a palette change announces each member separately. Their messages
        // only need their new name, picture or color, not a reload.
        this.#reloadMembersSoon(this.#memberReloads.member(payload.userId, Date.now()));
        // If it was us, the change could be our own timeout or a role that
        // unlocks channels, which should not wait for anyone else's.
        if (payload.userId === session.user?.id) {
          void this.loadChannels();
          void this.#refreshSession();
        }
        break;
      }
      case 'CLOSE': {
        const payload = frame.d as { code: number; reason?: string };
        // 4004 and 4005 mean the session is gone: logged out, kicked, banned, or
        // signed out by a password change. Keep the server's reason so the
        // sign-in screen can say what happened instead of just appearing.
        if (payload.code === 4004 || payload.code === 4005) {
          this.signedOutReason =
            payload.reason ||
            (payload.code === 4005 ? 'You were removed from this server.' : 'Your session has ended.');
          session.user = null;
          session.permissions = '0';
        }
        break;
      }
      case 'EMOJI_CREATE':
      case 'EMOJI_DELETE':
        // The pruner emits one delete per removed emoji, so a large prune would
        // otherwise refetch the whole list for each one.
        this.#reloadEmojisSoon();
        break;
      case 'SERVER_GIFS_UPDATE':
        gifs.serverChanged();
        break;
      case 'RETENTION_APPLIED': {
        // Old messages or attachments may have been pruned from the open channel.
        // Take them out where they sit instead of reloading, which would throw
        // the reader to the newest messages every time the hourly prune runs.
        const summary = frame.d as PruneSummary | undefined;
        if (
          summary &&
          summary.deletedMessages === 0 &&
          summary.deletedAttachments === 0 &&
          summary.deletedStickers === 0
        ) {
          break;
        }
        void this.#reconcileLoaded();
        break;
      }
    }
  }
}

export const chat = new ChatStore();
