import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageReferenceType,
  Partials,
  type Message as DiscordMessage,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialPollAnswer,
  type Poll,
  type PollAnswer,
  type Presence,
  type TextChannel,
} from 'discord.js';
import type { BridgeStatus, DiscordCategoryOption, DiscordChannelOption } from '@harmony/shared';
import {
  DISCORD_MAX_CONTENT,
  type BotDeleteInput,
  type BridgeLogger,
  type DiscordEmoji,
  type DiscordIncomingDelete,
  type DiscordIncomingEdit,
  type DiscordIncomingMessage,
  type DiscordIncomingPoll,
  type DiscordIncomingPollEnd,
  type DiscordIncomingPollVote,
  type DiscordIncomingPresence,
  type DiscordIncomingReaction,
  type DiscordIncomingReactionsRemoved,
  type DiscordMention,
  type DiscordPin,
  type DiscordTransport,
  type EditInput,
  type DeleteInput,
  type MirrorInput,
  type MirrorPollInput,
  type MirrorPollResult,
  type MirrorResult,
  type ReactionInput,
  type WebhookRef,
} from './transport.ts';

const MAX_DISCORD_USERNAME = 80;

/** What Discord's attachment refresh endpoint answers with. */
interface RefreshUrlsResponse {
  refreshed_urls?: Array<{ original?: unknown; refreshed?: unknown }>;
}

export function createDiscordTransport(token: string, logger: BridgeLogger): DiscordTransport {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      // Privileged. Without it Discord sends no presences and the member list has
      // no way to tell who is around on the Discord side of a bridge.
      GatewayIntentBits.GuildPresences,
      // Not privileged. Without it Discord never says who voted on a poll, so
      // votes made on the Discord side could not be counted here.
      GatewayIntentBits.GuildMessagePolls,
    ],
    // Partials let us see edits, deletes and reactions of messages sent before startup.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  const createdHandlers: Array<(message: DiscordIncomingMessage) => void> = [];
  const editedHandlers: Array<(message: DiscordIncomingEdit) => void> = [];
  const deletedHandlers: Array<(message: DiscordIncomingDelete) => void> = [];
  const reactionAddedHandlers: Array<(reaction: DiscordIncomingReaction) => void> = [];
  const reactionRemovedHandlers: Array<(reaction: DiscordIncomingReaction) => void> = [];
  const reactionClearedHandlers: Array<(reaction: DiscordIncomingReaction) => void> = [];
  const reactionsRemovedAllHandlers: Array<(removed: DiscordIncomingReactionsRemoved) => void> = [];
  const presenceHandlers: Array<(presence: DiscordIncomingPresence) => void> = [];
  const pinsUpdatedHandlers: Array<(channelId: string) => void> = [];
  const reconnectedHandlers: Array<() => void> = [];
  let readyOnce = false;
  const pollVoteAddedHandlers: Array<(vote: DiscordIncomingPollVote) => void> = [];
  const pollVoteRemovedHandlers: Array<(vote: DiscordIncomingPollVote) => void> = [];
  const pollEndedHandlers: Array<(ended: DiscordIncomingPollEnd) => void> = [];
  let status: BridgeStatus = { ready: false, botTag: null, guildName: null, error: null };

  function reportPresence(presence: Presence): void {
    const incoming: DiscordIncomingPresence = {
      userId: presence.userId,
      online: presence.status !== 'offline',
    };
    for (const handler of presenceHandlers) handler(incoming);
  }

  client.once(Events.ClientReady, (ready) => {
    status = {
      ready: true,
      botTag: ready.user.tag,
      guildName: ready.guilds.cache.first()?.name ?? null,
      error: null,
    };
    logger.info('discord bridge connected', { botTag: status.botTag, guildName: status.guildName });

    // Discord sends the guild's current presences with the guild we receive on
    // connecting, so the member list starts out populated instead of waiting for
    // everybody to change status. Only members who are not offline are included.
    for (const guild of ready.guilds.cache.values()) {
      for (const presence of guild.presences.cache.values()) reportPresence(presence);
    }
  });

  /** The users a message mentions, by the name they go by in the guild. */
  function mentionsOf(message: Pick<DiscordMessage, 'mentions'>): DiscordMention[] {
    return [...message.mentions.users.values()].map((user) => ({
      id: user.id,
      name: message.mentions.members?.get(user.id)?.displayName ?? user.globalName ?? user.username,
    }));
  }

  /** Maps a discord.js message onto the shape the bridge works with. */
  function toIncomingMessage(message: DiscordMessage): DiscordIncomingMessage {
    // A forward has no content of its own: what was forwarded travels as a
    // snapshot, and that is what the bridge should carry across. Its reference
    // points at the original message, which must not turn it into a reply.
    const forward =
      message.reference?.type === MessageReferenceType.Forward ? (message.messageSnapshots.first() ?? null) : null;
    const body = forward ?? message;
    return {
      id: message.id,
      channelId: message.channelId,
      authorId: message.author.id,
      authorName: message.member?.displayName ?? message.author.displayName,
      // Null when the author has no custom picture, so we never import the
      // generic default avatars.
      authorAvatarUrl:
        message.member?.avatarURL({ size: 128 }) ?? message.author.avatarURL({ size: 128 }),
      replyToDiscordId: forward ? null : (message.reference?.messageId ?? null),
      mentions: mentionsOf(body),
      stickers: [...body.stickers.values()].map((sticker) => ({
        id: sticker.id,
        name: sticker.name,
        formatType: sticker.format,
      })),
      createdAt: message.createdAt.toISOString(),
      content: body.content,
      attachments: [...body.attachments.values()].map((attachment) => ({
        url: attachment.url,
        filename: attachment.name,
        contentType: attachment.contentType ?? 'application/octet-stream',
        size: attachment.size,
      })),
      // Webhook messages are ours; never echo them back.
      fromBot: isFromBot(message),
      forwarded: forward !== null,
      // The "pinned a message" notice and the like: Discord's own, not a person's.
      system: message.system,
      poll: message.poll ? toIncomingPoll(message.poll) : null,
    };
  }

  /** Maps a discord.js poll onto the shape the bridge works with. */
  function toIncomingPoll(poll: Poll): DiscordIncomingPoll {
    return {
      question: poll.question.text ?? '',
      answers: [...poll.answers.values()].map((answer) => ({
        id: answer.id,
        text: answer.text ?? '',
        // A unicode emoji has a name and no id; a custom one is not carried over.
        emoji: answer.emoji && !answer.emoji.id ? (answer.emoji.name ?? null) : null,
      })),
      allowMultiple: poll.allowMultiselect,
      expiresAt: poll.expiresAt?.toISOString() ?? null,
      finalized: poll.resultsFinalized,
    };
  }

  /**
   * Poll votes are handled one at a time, in the order Discord sent them. Each
   * needs the voter's name looked up first, and a vote followed at once by its
   * withdrawal must not be applied the other way round.
   */
  let pollQueue: Promise<void> = Promise.resolve();

  function reportPollVote(
    answer: PollAnswer | PartialPollAnswer,
    userId: string,
    handlers: Array<(vote: DiscordIncomingPollVote) => void>,
  ): void {
    pollQueue = pollQueue.then(async () => {
      try {
        const user = await client.users.fetch(userId).catch(() => null);
        // A bot cannot vote, so this is a webhook or an app; never a person.
        if (user?.bot) return;
        const vote: DiscordIncomingPollVote = {
          messageId: answer.poll.messageId,
          channelId: answer.poll.channelId,
          answerId: answer.id,
          userId,
          userName: user ? (user.globalName ?? user.username) : 'Discord user',
        };
        for (const handler of handlers) handler(vote);
      } catch {
        // The vote could not be read; the next sync of the poll will catch up.
      }
    });
  }

  /** Bots and webhooks, our own mirrors among them, are never bridged in. */
  function isFromBot(message: DiscordMessage): boolean {
    return message.author.bot || message.webhookId !== null;
  }

  /** Maps a discord.js reaction onto the shape the bridge works with. */
  function toIncomingReaction(
    full: MessageReaction | PartialMessageReaction,
    user: { id: string; globalName?: string | null; username?: string | null } | null,
  ): DiscordIncomingReaction {
    return {
      messageId: full.message.id,
      channelId: full.message.channelId ?? '',
      userId: user?.id ?? '',
      userName: user ? (user.globalName ?? user.username ?? 'Discord user') : '',
      emoji: full.emoji.name ?? '',
      emojiId: full.emoji.id ?? null,
      animated: full.emoji.animated ?? false,
    };
  }

  client.on(Events.MessageCreate, (message) => {
    const incoming = toIncomingMessage(message);
    for (const handler of createdHandlers) handler(incoming);
  });

  client.on(Events.MessagePollVoteAdd, (answer, userId) => reportPollVote(answer, userId, pollVoteAddedHandlers));
  client.on(Events.MessagePollVoteRemove, (answer, userId) => reportPollVote(answer, userId, pollVoteRemovedHandlers));

  client.on(Events.MessageUpdate, (previous, next) => {
    // A poll closing is an update to its message with the text unchanged, so it
    // is looked for before the unchanged-text rule below drops the event.
    if (next.poll?.resultsFinalized && !previous.poll?.resultsFinalized) {
      const ended: DiscordIncomingPollEnd = { messageId: next.id, channelId: next.channelId };
      for (const handler of pollEndedHandlers) handler(ended);
    }
    // Discord also sends an update when it finishes unfurling a link, often more
    // than once for a gif. The text is unchanged, so it is not an edit, and
    // passing it on would mark the message edited and resolve its link again.
    if (!previous.partial && !next.partial && previous.content === next.content) return;
    void (async () => {
      try {
        const message = (next.partial ? await next.fetch() : next) as DiscordMessage;
        const edit: DiscordIncomingEdit = {
          id: message.id,
          channelId: message.channelId,
          content: message.content,
          mentions: mentionsOf(message),
          // Our own webhook edits come back as updates. Carrying the authorship
          // lets the bridge drop them, as it does bot messages.
          fromBot: isFromBot(message),
        };
        for (const handler of editedHandlers) handler(edit);
      } catch {
        // The message was deleted before we could read the edit.
      }
    })();
  });

  client.on(Events.MessageDelete, (message) => {
    const deletion = { id: message.id, channelId: message.channelId ?? '' };
    for (const handler of deletedHandlers) handler(deletion);
  });

  // A moderator's purge arrives as one bulk event rather than a delete per
  // message; each is passed on exactly like a single deletion.
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    for (const message of messages.values()) {
      const deletion: DiscordIncomingDelete = { id: message.id, channelId: message.channelId ?? channel.id };
      for (const handler of deletedHandlers) handler(deletion);
    }
  });

  // Reactions from bots or webhooks (including our own mirrored ones) are ignored,
  // exactly like bot messages, so nothing ping-pongs across the bridge.
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void (async () => {
      if (user.bot) return;
      try {
        const full = reaction.partial ? await reaction.fetch() : reaction;
        const incoming = toIncomingReaction(full, user);
        for (const handler of reactionAddedHandlers) handler(incoming);
      } catch {
        // The message was gone before we could read the reaction.
      }
    })();
  });

  client.on(Events.MessageReactionRemove, (reaction, user) => {
    void (async () => {
      if (user.bot) return;
      try {
        const full = reaction.partial ? await reaction.fetch() : reaction;
        const incoming = toIncomingReaction(full, user);
        for (const handler of reactionRemovedHandlers) handler(incoming);
      } catch {
        // The message was gone before we could read the reaction.
      }
    })();
  });

  // Every reaction of a single emoji was removed at once.
  client.on(Events.MessageReactionRemoveEmoji, (reaction) => {
    void (async () => {
      try {
        const full = reaction.partial ? await reaction.fetch() : reaction;
        const incoming = toIncomingReaction(full, null);
        for (const handler of reactionClearedHandlers) handler(incoming);
      } catch {
        // The message was gone before we could read the reaction.
      }
    })();
  });

  // Every reaction on a message was removed at once, usually by a moderator.
  client.on(Events.MessageReactionRemoveAll, (message) => {
    const removed: DiscordIncomingReactionsRemoved = { messageId: message.id, channelId: message.channelId };
    for (const handler of reactionsRemovedAllHandlers) handler(removed);
  });

  // Discord reports only that a channel's pins changed, not which message.
  client.on(Events.ChannelPinsUpdate, (channel) => {
    for (const handler of pinsUpdatedHandlers) handler(channel.id);
  });

  // A shard becoming ready again means a fresh session, so events in the gap are
  // gone for good; a resume replays them and needs nothing. The first ready is
  // the initial connection, which the bridge already handles by itself.
  client.on(Events.ShardReady, () => {
    if (!readyOnce) {
      readyOnce = true;
      return;
    }
    for (const handler of reconnectedHandlers) handler();
  });

  // Somebody came online, went idle or signed off.
  client.on(Events.PresenceUpdate, (_previous, presence) => {
    if (!presence) return;
    reportPresence(presence);
  });

  function firstGuild() {
    return client.guilds.cache.first() ?? null;
  }

  /**
   * Returns a usable webhook, reusing the cached one when it still exists and
   * creating a replacement otherwise. Message overrides (username) only work on
   * webhooks, so one has to exist for the channel.
   */
  async function ensureWebhook(channel: TextChannel, cached: WebhookRef | null): Promise<WebhookRef> {
    if (cached?.id && cached.token) {
      try {
        await client.fetchWebhook(cached.id, cached.token);
        return cached;
      } catch {
        logger.debug('cached discord webhook is gone, creating a new one', { channelId: channel.id });
      }
    }

    try {
      const created = await channel.createWebhook({ name: 'Harmony' });
      if (!created.token) throw new Error('Discord did not return a webhook token');
      return { id: created.id, token: created.token };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not create a webhook in #${channel.name}. The bot needs the "Manage Webhooks" permission there. (${detail})`,
      );
    }
  }

  return {
    async start() {
      try {
        await client.login(token);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status = { ready: false, botTag: null, guildName: null, error: message };
        logger.info('discord login failed', message);
      }
    },

    async stop() {
      try {
        await client.destroy();
      } catch {
        // Already torn down.
      }
      status = { ready: false, botTag: null, guildName: null, error: null };
    },

    status: () => status,

    async listTextChannels() {
      const guild = firstGuild();
      if (!guild) return { guildName: null, categories: [], channels: [] };

      const fetched = await guild.channels.fetch();
      const categories: Array<DiscordCategoryOption & { position: number }> = [];
      const channels: Array<DiscordChannelOption & { position: number }> = [];
      for (const channel of fetched.values()) {
        if (!channel) continue;
        if (channel.type === ChannelType.GuildCategory) {
          categories.push({ id: channel.id, name: channel.name, position: channel.rawPosition });
        } else if (channel.type === ChannelType.GuildText) {
          channels.push({
            id: channel.id,
            name: channel.name,
            categoryId: channel.parentId ?? null,
            position: channel.rawPosition,
          });
        }
      }
      // Keep Discord's own order, so an import reproduces the sidebar as it was.
      categories.sort((a, b) => a.position - b.position);
      channels.sort((a, b) => a.position - b.position);
      return {
        guildName: guild.name,
        categories: categories.map(({ position: _position, ...option }) => option),
        channels: channels.map(({ position: _position, ...option }) => option),
      };
    },

    onMessage(handler) {
      createdHandlers.push(handler);
    },

    onMessageEdited(handler) {
      editedHandlers.push(handler);
    },

    onMessageDeleted(handler) {
      deletedHandlers.push(handler);
    },

    onReactionAdded(handler) {
      reactionAddedHandlers.push(handler);
    },

    onReactionRemoved(handler) {
      reactionRemovedHandlers.push(handler);
    },

    onReactionCleared(handler) {
      reactionClearedHandlers.push(handler);
    },

    onReactionsRemovedAll(handler) {
      reactionsRemovedAllHandlers.push(handler);
    },

    onPresence(handler) {
      presenceHandlers.push(handler);
    },

    onPinsUpdated(handler) {
      pinsUpdatedHandlers.push(handler);
    },

    onReconnected(handler) {
      reconnectedHandlers.push(handler);
    },

    onPollVoteAdded(handler) {
      pollVoteAddedHandlers.push(handler);
    },

    onPollVoteRemoved(handler) {
      pollVoteRemovedHandlers.push(handler);
    },

    onPollEnded(handler) {
      pollEndedHandlers.push(handler);
    },

    async mirrorPoll(input: MirrorPollInput): Promise<MirrorPollResult> {
      const channel = await client.channels.fetch(input.discordChannelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) {
        throw new Error(`Discord channel ${input.discordChannelId} is not a text channel the bot can see.`);
      }
      // A webhook cannot post a poll, so the bot does. Nobody is pinged by the text.
      const sent = await (channel as TextChannel).send({
        content: input.content.slice(0, DISCORD_MAX_CONTENT),
        allowedMentions: { parse: [] },
        poll: {
          question: { text: input.question },
          answers: input.answers.map((answer) => ({
            text: answer.text,
            ...(answer.emoji ? { emoji: answer.emoji } : {}),
          })),
          allowMultiselect: input.allowMultiple,
          duration: input.durationHours,
        },
      });
      // Discord numbers the answers itself, in the order given.
      const answerIds = sent.poll
        ? [...sent.poll.answers.values()].map((answer) => answer.id)
        : input.answers.map((_, index) => index + 1);
      return { messageId: sent.id, answerIds };
    },

    async endPoll(input: BotDeleteInput) {
      // Only the poll's author can end it, which is the bot for one we posted.
      await client.rest.post(`/channels/${input.channelId}/polls/${input.discordMessageId}/expire`);
    },

    async fetchPollVoters(input) {
      const response = (await client.rest.get(
        `/channels/${input.channelId}/polls/${input.discordMessageId}/answers/${input.answerId}`,
        { query: new URLSearchParams({ limit: '100' }) },
      )) as { users?: Array<{ id: string; username: string; global_name?: string | null; bot?: boolean }> };
      return (response.users ?? [])
        .filter((user) => !user.bot)
        .map((user) => ({ id: user.id, name: user.global_name ?? user.username }));
    },

    async guildEmojis(): Promise<DiscordEmoji[]> {
      const guild = firstGuild();
      if (!guild) return [];

      const fetched = await guild.emojis.fetch();
      const emojis: DiscordEmoji[] = [];
      for (const emoji of fetched.values()) {
        if (!emoji.name) continue;
        emojis.push({ id: emoji.id, name: emoji.name, animated: emoji.animated ?? false });
      }
      return emojis;
    },

    async mirror(input: MirrorInput): Promise<MirrorResult> {
      logger.debug('mirroring to discord', {
        channelId: input.discordChannelId,
        files: input.files.length,
      });

      const channel = await client.channels.fetch(input.discordChannelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) {
        throw new Error(`Discord channel ${input.discordChannelId} is not a text channel the bot can see.`);
      }
      const textChannel = channel as TextChannel;

      const webhook = await ensureWebhook(textChannel, input.webhook);
      const files = input.files.map((file) => ({
        name: file.filename,
        data: file.data,
        contentType: file.contentType,
      }));

      try {
        // Posting straight to the webhook endpoint is what discord.js's own
        // Webhook#send does, and is the only way to override the name. When
        // files are present the REST layer builds the multipart payload.
        const sent = (await client.rest.post(`/webhooks/${webhook.id}/${webhook.token}`, {
          auth: false,
          query: new URLSearchParams({ wait: 'true' }),
          ...(files.length > 0 ? { files } : {}),
          body: {
            content: input.content.slice(0, DISCORD_MAX_CONTENT),
            username: input.username.slice(0, MAX_DISCORD_USERNAME),
            ...(input.avatarUrl ? { avatar_url: input.avatarUrl } : {}),
            // Only ping the users we deliberately mirrored as mentions. `parse`
            // is mutually exclusive with an explicit `users` list, so listing
            // them also keeps roles and @everyone from ever firing.
            allowed_mentions:
              input.allowedUserMentions.length > 0
                ? { users: input.allowedUserMentions }
                : { parse: [] },
          },
        })) as { id: string };

        logger.debug('mirrored a message to discord', {
          channelId: input.discordChannelId,
          messageId: sent.id,
        });
        return { messageId: sent.id, webhook };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: number | string }).code;
        throw new Error(`Discord rejected the webhook message (${code ?? 'error'}): ${detail}`);
      }
    },

    async editMessage(input: EditInput) {
      await client.rest.patch(`/webhooks/${input.webhook.id}/${input.webhook.token}/messages/${input.discordMessageId}`, {
        auth: false,
        body: {
          content: input.content.slice(0, DISCORD_MAX_CONTENT),
          allowed_mentions:
            input.allowedUserMentions.length > 0
              ? { users: input.allowedUserMentions }
              : { parse: [] },
        },
      });
    },

    async deleteMessage(input: DeleteInput) {
      await client.rest.delete(
        `/webhooks/${input.webhook.id}/${input.webhook.token}/messages/${input.discordMessageId}`,
        { auth: false },
      );
    },

    async deleteMessageAsBot(input: BotDeleteInput) {
      // Needs the bot's "Manage Messages" permission in the channel.
      await client.rest.delete(`/channels/${input.channelId}/messages/${input.discordMessageId}`);
    },

    async addReaction(input: ReactionInput) {
      // Reactions cannot go through a webhook: Discord has no such route, so the
      // bot reacts instead. The emoji must be URL-encoded by the caller.
      await client.rest.put(
        `/channels/${input.channelId}/messages/${input.discordMessageId}/reactions/${input.emoji}/@me`,
      );
    },

    async removeReaction(input: ReactionInput) {
      await client.rest.delete(
        `/channels/${input.channelId}/messages/${input.discordMessageId}/reactions/${input.emoji}/@me`,
      );
    },

    async fetchPinned(channelId): Promise<DiscordPin[]> {
      // Discord caps a channel at 50 pins and a page holds 50, so one request is all.
      const response = (await client.rest.get(`/channels/${channelId}/messages/pins`, {
        query: new URLSearchParams({ limit: '50' }),
      })) as { items?: Array<{ pinned_at?: unknown; message?: { id?: unknown } }> };
      const pins: DiscordPin[] = [];
      for (const item of response.items ?? []) {
        if (typeof item.message?.id !== 'string') continue;
        pins.push({
          messageId: item.message.id,
          pinnedAt: typeof item.pinned_at === 'string' ? item.pinned_at : null,
        });
      }
      return pins;
    },

    async pinMessage(input) {
      // Needs the bot's "Pin Messages" permission in the channel.
      await client.rest.put(`/channels/${input.channelId}/messages/pins/${input.discordMessageId}`);
    },

    async unpinMessage(input) {
      await client.rest.delete(`/channels/${input.channelId}/messages/pins/${input.discordMessageId}`);
    },

    async download(url: string) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Discord returned ${response.status} for an attachment`);
      return Buffer.from(await response.arrayBuffer());
    },

    async refreshAttachmentUrl(url: string) {
      // Discord signs every attachment address and the signature expires, which is
      // why a link copied out of the client is usually dead on arrival. This is the
      // endpoint its own clients use to renew one, and it signs any attachment
      // address, including one in a channel or guild the bot cannot otherwise read.
      const response = (await client.rest
        .post('/attachments/refresh-urls', { body: { attachment_urls: [url] } })
        .catch((error: unknown) => {
          logger.debug('discord attachment refresh failed', { url, error: String(error) });
          return null;
        })) as RefreshUrlsResponse | null;

      const refreshed = response?.refreshed_urls?.[0]?.refreshed;
      return typeof refreshed === 'string' ? refreshed : null;
    },

    async fetchRecentMessages(channelId, limit) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) return [];

      const fetched = await channel.messages.fetch({ limit: Math.min(Math.max(limit, 1), 100) });
      // Discord returns newest first; importing oldest first keeps a reply after
      // the message it answers.
      return [...fetched.values()].map(toIncomingMessage).reverse();
    },
  };
}
