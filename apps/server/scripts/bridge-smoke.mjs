// Bridge orchestration test.
//
// Substitutes a fake Discord transport so the mirroring logic can be verified
// without a bot token or a network connection. Run with:
//   npm run smoke:bridge --workspace @harmony/server
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { Database } from '../src/db/index.ts';
import { insertChannel, listChannels } from '../src/db/channels.ts';
import { listCategories } from '../src/db/categories.ts';
import { findUserById, findUserByDiscordId, insertUser } from '../src/db/users.ts';
import { findBridgeMessageByHarmonyId } from '../src/db/bridge.ts';
import { listLinkedAttachments } from '../src/db/attachments.ts';
import { createEmbedService } from '../src/embeds/service.ts';
import { findEmojiByName, insertEmoji, toEmoji } from '../src/db/emojis.ts';
import { createAttachmentService } from '../src/attachments/service.ts';
import { createEmojiService } from '../src/emojis/service.ts';
import { createEmojiImportService } from '../src/emojis/import.ts';
import { GatewayHub } from '../src/realtime/hub.ts';
import { createSettingsService } from '../src/settings/service.ts';
import { createMessageService } from '../src/messages/service.ts';
import { createAuditService } from '../src/audit/service.ts';
import { createUserService } from '../src/users/service.ts';
import { createBridgeService } from '../src/bridge/service.ts';
import { createChannelImportService } from '../src/channels/import.ts';
import { createPruner } from '../src/retention/pruner.ts';

const logger = { info() {}, debug() {} };

let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

function createFakeTransport() {
  const state = {
    started: false,
    ready: false,
    mirrors: [],
    edits: [],
    deletes: [],
    reactions: [],
    created: [],
    edited: [],
    deleted: [],
    reactionAdded: [],
    reactionRemoved: [],
    reactionCleared: [],
    presence: [],
    guildEmojis: [{ id: '700', name: 'YES', animated: false }],
    // A mutable channel list, so a test can add one to import selectively.
    textChannels: [
      { id: '111', name: 'general', categoryId: 'cat1' },
      { id: '222', name: 'random', categoryId: 'cat1' },
      { id: '333', name: 'offtopic', categoryId: null },
    ],
    recentMessages: [],
    downloadBytes: null,
    downloads: [],
    // Attachment addresses the fake bot can renew, keyed by the original.
    refreshedUrls: new Map([
      ['https://cdn.discordapp.com/attachments/111/900/x.gif', 'https://cdn.discordapp.com/attachments/111/900/x.gif?ex=ff&is=1&hm=abc'],
    ]),
  };
  return {
    state,
    async start() {
      state.started = true;
      state.ready = true;
    },
    async stop() {
      state.ready = false;
    },
    status() {
      return { ready: state.ready, botTag: 'fake#0001', guildName: 'Test Guild', error: null };
    },
    async listTextChannels() {
      return {
        guildName: 'Test Guild',
        categories: [{ id: 'cat1', name: 'General' }],
        channels: state.textChannels,
      };
    },
    onMessage(handler) {
      state.created.push(handler);
    },
    onMessageEdited(handler) {
      state.edited.push(handler);
    },
    onMessageDeleted(handler) {
      state.deleted.push(handler);
    },
    onReactionAdded(handler) {
      state.reactionAdded.push(handler);
    },
    onReactionRemoved(handler) {
      state.reactionRemoved.push(handler);
    },
    onReactionCleared(handler) {
      state.reactionCleared.push(handler);
    },
    onPresence(handler) {
      state.presence.push(handler);
    },
    async guildEmojis() {
      return state.guildEmojis;
    },
    async fetchRecentMessages() {
      return state.recentMessages;
    },
    async addReaction(input) {
      state.reactions.push({ kind: 'add', ...input });
    },
    async removeReaction(input) {
      state.reactions.push({ kind: 'remove', ...input });
    },
    async mirror(input) {
      state.mirrors.push(input);
      return { messageId: `discord-${state.mirrors.length}`, webhook: input.webhook ?? { id: 'wh1', token: 'tok1' } };
    },
    async editMessage(input) {
      state.edits.push(input);
    },
    async deleteMessage(input) {
      state.deletes.push(input);
    },
    async download(url) {
      state.downloads.push(url);
      return state.downloadBytes;
    },
    async refreshAttachmentUrl(url) {
      return state.refreshedUrls.get(url) ?? null;
    },
    emit(message) {
      // Message fields the tests omit default to sensible values.
      for (const handler of state.created) {
        handler({ mentions: [], stickers: [], createdAt: new Date().toISOString(), ...message });
      }
    },
    emitEdit(edit) {
      for (const handler of state.edited) handler(edit);
    },
    emitDelete(deletion) {
      for (const handler of state.deleted) handler(deletion);
    },
    emitReactionAdd(reaction) {
      for (const handler of state.reactionAdded) handler(reaction);
    },
    emitReactionRemove(reaction) {
      for (const handler of state.reactionRemoved) handler(reaction);
    },
    emitReactionClear(reaction) {
      for (const handler of state.reactionCleared) handler(reaction);
    },
    emitPresence(presence) {
      for (const handler of state.presence) handler(presence);
    },
  };
}

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-bridge-'));
const config = {
  dataDir,
  dbFile: join(dataDir, 'harmony.db'),
  uploadDir: join(dataDir, 'uploads'),
};

const db = new Database(config);
const settings = createSettingsService(db.sqlite, { serverName: 'Test', requireInvite: false });
const hub = new GatewayHub();
// Record what the gateway broadcasts, so a history import can be shown never to
// arrive as a live message (which is what used to ring clients' notification
// sounds for old, already-read mentions on every restart).
const broadcasts = [];
const dispatchOriginal = hub.dispatch.bind(hub);
hub.dispatch = (event, payload, visibility) => {
  broadcasts.push({ event, payload });
  dispatchOriginal(event, payload, visibility);
};
const audit = createAuditService(db.sqlite);
const messages = createMessageService(db.sqlite, hub, audit);
const attachments = createAttachmentService(db.sqlite, config, settings);
const users = createUserService(db.sqlite, config);
const transport = createFakeTransport();

const previews = [];
const bridge = createBridgeService({
  sqlite: db.sqlite,
  config,
  settings,
  messages,
  users,
  hub,
  logger,
  transportFactory: () => transport,
  resolvePreview: (messageId, content) => previews.push({ messageId, content }),
});

const png = await sharp({ create: { width: 10, height: 6, channels: 3, background: { r: 10, g: 200, b: 90 } } })
  .png()
  .toBuffer();

/** A minimal well-formed MP4 header: a size word, then the required ftyp box. */
const mp4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from('isomiso2'),
  Buffer.alloc(64),
]);

try {
  // 1. Nothing happens until the bridge is configured and enabled.
  await bridge.applySettings();
  check('bridge is idle before configuration', transport.state.started === false);
  check('status reports unconfigured', bridge.status().configured === false && bridge.status().enabled === false);
  check('status never leaks a token', !('token' in bridge.status()));

  settings.updateBridge({ token: 'fake-token', enabled: true });
  await bridge.applySettings();
  check('transport starts once enabled', transport.state.started === true);
  check('bot identity is exposed', bridge.status().status.botTag === 'fake#0001');
  check('discord channels are listable', (await bridge.listDiscordChannels()).channels.length === 3);
  check('discord categories are listable', (await bridge.listDiscordChannels()).categories.length === 1);
  check(
    'a pasted discord link is renewed through the bridge',
    (await bridge.refreshDiscordAttachment('https://cdn.discordapp.com/attachments/111/900/x.gif'))?.includes('hm=abc') ===
      true,
  );
  check(
    'a link the bridge cannot renew resolves to nothing',
    (await bridge.refreshDiscordAttachment('https://cdn.discordapp.com/attachments/111/901/y.gif')) === null,
  );

  const userId = randomUUID();
  insertUser(db.sqlite, { id: userId, username: 'alice', passwordHash: 'scrypt$x$y$z', isOwner: true });
  const channelId = randomUUID();
  insertChannel(db.sqlite, {
    id: channelId,
    name: 'general',
    topic: null,
    categoryId: null,
    type: 'text',
    position: 0,
    createdAt: new Date().toISOString(),
    discordChannelId: '111',
    requiredRoleId: null,
  });

  const auth = { user: { id: userId }, permissions: 0n, sessionId: 's', token: 't' };

  // 2. Harmony -> Discord, text.
  const sent = messages.create(auth, channelId, 'hello discord', [], null);
  await sleep(50);
  check('harmony message is mirrored', transport.state.mirrors.length === 1);
  check('mirror uses a username override', transport.state.mirrors[0]?.username === 'alice');
  check('mirror carries the content', transport.state.mirrors[0]?.content === 'hello discord');
  check('no avatar is sent without a public base URL', transport.state.mirrors[0]?.avatarUrl === null);
  check(
    'mirrored message is recorded for later sync',
    findBridgeMessageByHarmonyId(db.sqlite, sent.id)?.discord_message_id === 'discord-1',
  );

  // 3. Harmony -> Discord, with an image.
  const upload = await attachments.upload(auth, { filename: 'pic.png', contentType: 'image/png', data: png });
  messages.create(auth, channelId, '', [upload.id], null);
  await sleep(50);
  const withFile = transport.state.mirrors.at(-1);
  check('attachment is mirrored', withFile?.files.length === 1);
  check('mirrored file keeps its name', withFile?.files[0]?.filename === 'pic.png');
  check('a message can be images only', withFile?.content === '');

  // 4. Discord -> Harmony, with an image.
  transport.state.downloadBytes = png;
  const mirrorsBeforeIngest = transport.state.mirrors.length;
  transport.emit({
    id: 'd1',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: 'https://cdn.example/avatar.png',
    replyToDiscordId: null,
    content: 'hi harmony',
    attachments: [{ url: 'https://cdn.example/pic.png', filename: 'pic.png', contentType: 'image/png', size: png.length }],
    fromBot: false,
  });
  await sleep(50);

  const history = messages.history(channelId, { limit: 50 }, userId);
  const ingested = history.messages.find((message) => message.content === 'hi harmony');
  check('discord message lands in harmony', Boolean(ingested));
  check('ingested message is attributed to a ghost user', ingested?.author?.isBot === true);
  check('ghost user carries the discord display name', ingested?.author?.displayName === 'Discord Sam');
  check('discord attachment is mirrored', ingested?.attachments.length === 1);
  check(
    'discord attachment blob is stored',
    existsSync(join(config.uploadDir, ingested.attachments[0].hash.slice(0, 2), ingested.attachments[0].hash)),
  );
  check('ingested messages are not mirrored back', transport.state.mirrors.length === mirrorsBeforeIngest);
  check(
    'a live discord message is broadcast to clients',
    broadcasts.some((entry) => entry.event === 'MESSAGE_CREATE' && entry.payload?.content === 'hi harmony'),
  );
  check(
    'a bridged message resolves a link preview',
    previews.some((entry) => entry.messageId === ingested?.id),
  );
  check('discord avatar is imported for the ghost user', typeof ingested?.author?.avatarHash === 'string');
  check(
    'ghost avatar blob is stored',
    Boolean(
      ingested?.author?.avatarHash &&
        existsSync(join(config.uploadDir, ingested.author.avatarHash.slice(0, 2), ingested.author.avatarHash)),
    ),
  );
  check('discord avatar is fetched by URL', transport.state.downloads.includes('https://cdn.example/avatar.png'));

  // 4a. A suppressed link from Discord is unwrapped so it previews here.
  transport.emit({
    id: 'd1u',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: 'watch <https://www.youtube.com/watch?v=dQw4w9WgXcQ> ok',
    attachments: [],
    fromBot: false,
  });
  await sleep(50);
  const unwrapped = messages.history(channelId, { limit: 50 }, userId).messages.find((message) =>
    message.content.includes('youtube.com/watch'),
  );
  check(
    'a suppressed discord link is unwrapped before it is stored',
    unwrapped?.content === 'watch https://www.youtube.com/watch?v=dQw4w9WgXcQ ok',
  );
  check(
    'the unwrapped link is offered to the unfurler',
    previews.some((entry) => entry.messageId === unwrapped?.id && entry.content === 'watch https://www.youtube.com/watch?v=dQw4w9WgXcQ ok'),
  );

  // 4b. A Discord reply becomes a real Harmony reply.
  transport.emit({
    id: 'd1r',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: 'd1',
    content: 'a reply from discord',
    attachments: [],
    fromBot: false,
  });
  await sleep(50);
  const replyIngested = messages
    .history(channelId, { limit: 50 }, userId)
    .messages.find((message) => message.content === 'a reply from discord');
  check('discord reply references the bridged message', replyIngested?.replyTo?.id === ingested?.id);

  // 4c. A Discord video is imported as-is, so it does not become a link.
  transport.state.downloadBytes = mp4;
  transport.emit({
    id: 'd1v',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: '',
    attachments: [
      { url: 'https://cdn.example/clip.mp4', filename: 'clip.mp4', contentType: 'video/mp4', size: mp4.length },
    ],
    fromBot: false,
  });
  await sleep(50);
  const videoIngested = messages
    .history(channelId, { limit: 50 }, userId)
    .messages.find((message) => message.attachments.some((attachment) => attachment.filename === 'clip.mp4'));
  check('a discord video is imported', videoIngested?.attachments[0]?.contentType === 'video/mp4');
  check('an imported clip keeps no dimensions', videoIngested?.attachments[0]?.width === null);

  // 5. Unsupported attachments are preserved as links rather than dropped.
  transport.emit({
    id: 'd2',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: '',
    attachments: [{ url: 'https://cdn.example/notes.txt', filename: 'notes.txt', contentType: 'text/plain', size: 10 }],
    fromBot: false,
  });
  await sleep(50);
  check(
    'unsupported attachments become links',
    messages.history(channelId, { limit: 50 }, userId).messages.some((m) => m.content.includes('notes.txt')),
  );

  // 6. Edits and deletes, Discord -> Harmony.
  transport.emitEdit({ id: 'd1', channelId: '111', content: 'edited in discord' });
  await sleep(50);
  check(
    'discord edit reaches harmony',
    messages.history(channelId, { limit: 50 }, userId).messages.some((m) => m.content === 'edited in discord'),
  );

  transport.emitDelete({ id: 'd1', channelId: '111' });
  await sleep(50);
  check(
    'discord delete reaches harmony',
    messages.history(channelId, { limit: 50 }, userId).messages.every((m) => m.id !== ingested?.id),
  );

  // 7. Edits and deletes, Harmony -> Discord.
  const edited = messages.edit(auth, sent.id, 'edited in harmony');
  await sleep(50);
  check('harmony edit reaches discord', transport.state.edits.at(-1)?.content === 'edited in harmony');
  check('edit targets the mirrored message', transport.state.edits.at(-1)?.discordMessageId === 'discord-1');
  check('edit uses the cached webhook', transport.state.edits.at(-1)?.webhook?.id === 'wh1');

  messages.remove(auth, edited.id);
  await sleep(50);
  check('harmony delete reaches discord', transport.state.deletes.at(-1)?.discordMessageId === 'discord-1');

  // 7b. Outbound avatars are handed to Discord, but only once we know our own
  // public address, and the hash doubles as the fetch capability.
  await users.setAvatarFromData(userId, png);
  const aliceAvatarHash = findUserById(db.sqlite, userId)?.avatar_hash;
  settings.updateBridge({ publicBaseUrl: 'https://chat.example.com/' });
  messages.create(auth, channelId, 'avatar check', [], null);
  await sleep(50);
  check(
    'outbound avatar URL uses the public base URL and hash capability',
    transport.state.mirrors.at(-1)?.avatarUrl ===
      `https://chat.example.com/api/v1/users/${userId}/avatar?v=${aliceAvatarHash}`,
    String(transport.state.mirrors.at(-1)?.avatarUrl),
  );

  // 7c. A Harmony reply is mirrored out as a quoted line, since Discord
  // webhooks cannot post real replies.
  const original = messages.create(auth, channelId, 'the original', [], null);
  await sleep(50);
  messages.create(auth, channelId, 'replying here', [], original.id);
  await sleep(50);
  const quoted = transport.state.mirrors.at(-1);
  check(
    'outbound reply is mirrored as a quote',
    quoted?.content.startsWith('> **alice**') && quoted.content.includes('replying here'),
    String(quoted?.content),
  );

  // 7d. Reactions mirror out. Custom emoji are matched to the guild's emoji by name.
  const target = messages.create(auth, channelId, 'react to me', [], null);
  await sleep(50);
  messages.toggleReaction(auth, target.id, '👍', null);
  await sleep(50);
  check(
    'a unicode reaction is mirrored out',
    transport.state.reactions.at(-1)?.kind === 'add' &&
      transport.state.reactions.at(-1)?.emoji === encodeURIComponent('👍'),
    String(transport.state.reactions.at(-1)?.emoji),
  );
  check('the bot reacts in the linked discord channel', transport.state.reactions.at(-1)?.channelId === '111');

  insertEmoji(db.sqlite, {
    id: 'emoji-yes',
    name: 'YES',
    hash: 'deadbeef',
    contentType: 'image/png',
    animated: false,
    createdBy: userId,
    createdAt: new Date().toISOString(),
  });
  messages.toggleReaction(auth, target.id, ':YES:', 'emoji-yes');
  await sleep(50);
  check(
    'a custom reaction is translated to a discord emoji',
    transport.state.reactions.at(-1)?.emoji === 'YES:700',
    String(transport.state.reactions.at(-1)?.emoji),
  );

  messages.toggleReaction(auth, target.id, '👍', null);
  await sleep(50);
  check('removing a reaction is mirrored out', transport.state.reactions.at(-1)?.kind === 'remove');

  // A second reactor keeps the bot's single reaction until the last one leaves.
  const bobId = randomUUID();
  insertUser(db.sqlite, { id: bobId, username: 'bob', passwordHash: 'scrypt$x$y$z', isOwner: false });
  const bobAuth = { user: { id: bobId }, permissions: 0n, sessionId: 'sb', token: 'tb' };
  messages.toggleReaction(auth, target.id, '🔥', null);
  await sleep(50);
  messages.toggleReaction(bobAuth, target.id, '🔥', null);
  await sleep(50);
  const beforePartialRemove = transport.state.reactions.length;
  messages.toggleReaction(auth, target.id, '🔥', null);
  await sleep(50);
  check('the bot reaction stays while others remain', transport.state.reactions.length === beforePartialRemove);
  messages.toggleReaction(bobAuth, target.id, '🔥', null);
  await sleep(50);
  check(
    'the bot reaction is removed once the last reactor leaves',
    transport.state.reactions.at(-1)?.kind === 'remove' &&
      transport.state.reactions.at(-1)?.emoji === encodeURIComponent('🔥'),
    String(transport.state.reactions.at(-1)?.emoji),
  );

  // 7i. Importing a channel backfills recent Discord history, idempotently.
  transport.state.recentMessages = [
    {
      id: 'h1',
      channelId: '111',
      authorId: '888',
      authorName: 'Discord History',
      authorAvatarUrl: null,
      replyToDiscordId: null,
      mentions: [],
      createdAt: '2024-01-01T10:00:00.000Z',
      content: 'the first ever message',
      attachments: [],
      stickers: [],
      fromBot: false,
    },
    {
      id: 'h2',
      channelId: '111',
      authorId: '888',
      authorName: 'Discord History',
      authorAvatarUrl: null,
      replyToDiscordId: 'h1',
      mentions: [],
      createdAt: '2024-01-01T10:01:00.000Z',
      content: 'and a reply',
      attachments: [],
      stickers: [],
      fromBot: false,
    },
  ];

  check('an import pulls in discord history', (await bridge.importChannel(channelId)) === 2);
  const importedHistory = messages.history(channelId, { limit: 100 }, userId).messages;
  check(
    'imported messages keep their original timestamp',
    importedHistory.some(
      (message) => message.content === 'the first ever message' && message.createdAt === '2024-01-01T10:00:00.000Z',
    ),
  );
  check(
    'an imported reply links to its parent',
    importedHistory.find((message) => message.content === 'and a reply')?.replyTo?.content === 'the first ever message',
  );
  check('importing again adds nothing', (await bridge.importChannel(channelId)) === 0);
  check(
    'imported history is never broadcast as a live message',
    !broadcasts.some(
      (entry) =>
        entry.event === 'MESSAGE_CREATE' &&
        (entry.payload?.content === 'the first ever message' || entry.payload?.content === 'and a reply'),
    ),
  );

  // 7j. Content removed here stays removed. A hard delete (retention) cascades
  // the bridge mapping away, but the permanent record of the Discord id does not
  // go with it, so the next backfill recognises the message and skips it rather
  // than resurrecting it.
  const pruned = importedHistory.find((message) => message.content === 'the first ever message');
  db.sqlite.prepare('DELETE FROM messages WHERE id = ?').run(pruned.id);
  check(
    'a hard delete drops the bridge mapping',
    findBridgeMessageByHarmonyId(db.sqlite, pruned.id) === null,
  );
  await bridge.importChannel(channelId);
  check(
    'a pruned bridged message is not re-imported',
    !messages
      .history(channelId, { limit: 100 }, userId)
      .messages.some((message) => message.content === 'the first ever message'),
  );

  // 7e. Reactions flow back in, and are attributed to a ghost user.
  const targetDiscordId = findBridgeMessageByHarmonyId(db.sqlite, target.id)?.discord_message_id;
  const reactionsOut = transport.state.reactions.length;
  transport.emitReactionAdd({
    messageId: targetDiscordId,
    channelId: '111',
    userId: '777',
    userName: 'Discord Rhea',
    emoji: '🎉',
    emojiId: null,
  });
  await sleep(50);
  const reacted = messages.history(channelId, { limit: 50 }, userId).messages.find((m) => m.id === target.id);
  check(
    'a discord reaction lands in harmony',
    reacted?.reactions.some((reaction) => reaction.emoji === '🎉' && reaction.count === 1) === true,
  );
  check('inbound reactions are not mirrored back', transport.state.reactions.length === reactionsOut);

  transport.emitReactionAdd({
    messageId: targetDiscordId,
    channelId: '111',
    userId: '777',
    userName: 'Discord Rhea',
    emoji: 'YES',
    emojiId: '700',
  });
  await sleep(50);
  const customReacted = messages.history(channelId, { limit: 50 }, userId).messages.find((m) => m.id === target.id);
  check(
    'a discord custom reaction maps to the harmony emoji',
    customReacted?.reactions.some((reaction) => reaction.emoji === ':YES:' && reaction.emojiId === 'emoji-yes') ===
      true,
  );

  transport.emitReactionRemove({
    messageId: targetDiscordId,
    channelId: '111',
    userId: '777',
    userName: 'Discord Rhea',
    emoji: '🎉',
    emojiId: null,
  });
  await sleep(50);
  const unreacted = messages.history(channelId, { limit: 50 }, userId).messages.find((m) => m.id === target.id);
  check('a removed discord reaction disappears', unreacted?.reactions.some((r) => r.emoji === '🎉') === false);

  // 7f. Custom emoji are translated by name in both directions.
  messages.create(auth, channelId, 'look :YES: and :NOPE:', [], null);
  await sleep(50);
  const emojiMirror = transport.state.mirrors.at(-1);
  check(
    'a known custom emoji is translated for discord',
    emojiMirror?.content.includes('<:YES:700>') === true,
    String(emojiMirror?.content),
  );
  check(
    'an unknown custom emoji is left as text',
    emojiMirror?.content.includes(':NOPE:') === true,
    String(emojiMirror?.content),
  );

  transport.emit({
    id: 'd5',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: 'hi <a:YES:700> and <:LATER:701> there',
    attachments: [],
    fromBot: false,
  });
  await sleep(50);
  check(
    'discord emoji tags become shortcodes',
    messages
      .history(channelId, { limit: 50 }, userId)
      .messages.some((m) => m.content === 'hi :YES: and :LATER: there'),
  );

  // 7f2. An emoji from another server - one this instance does not have - is
  // learned from Discord by its id, so it renders here too. A repeat of the same
  // emoji reuses it instead of fetching again, and it is marked as external so
  // the pickers leave it alone.
  transport.state.downloadBytes = png;
  const downloadsBeforeLearn = transport.state.downloads.length;
  transport.emit({
    id: 'd5b',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: 'party <:party:800> time and <a:blink:801>',
    attachments: [],
    fromBot: false,
  });
  await sleep(100);
  const learnedMessage = messages
    .history(channelId, { limit: 50 }, userId)
    .messages.find((m) => m.content.startsWith('party'));
  check('an emoji from another server becomes a shortcode', learnedMessage?.content === 'party :party: time and :blink:');
  check(
    'the external emoji is fetched from the discord cdn',
    transport.state.downloads.includes('https://cdn.discordapp.com/emojis/800.png') &&
      transport.state.downloads.includes('https://cdn.discordapp.com/emojis/801.gif'),
  );
  const storedParty = findEmojiByName(db.sqlite, 'party');
  check(
    'the external emoji is stored with its discord id',
    storedParty?.discord_id === '800',
  );
  check(
    'an external emoji is flagged, a native one is not',
    storedParty !== null && toEmoji(storedParty).external === true &&
      toEmoji(findEmojiByName(db.sqlite, 'YES')).external === false,
  );

  const downloadsAfterLearn = transport.state.downloads.length;
  transport.emit({
    id: 'd5c',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: 'again <:party:800>',
    attachments: [],
    fromBot: false,
  });
  await sleep(100);
  check(
    'a repeat external emoji is not fetched again',
    transport.state.downloads.length === downloadsAfterLearn &&
      transport.state.downloads.length === downloadsBeforeLearn + 2,
  );

  // A reaction carrying an emoji from another server is learned the same way, so
  // it renders as a picture rather than a bare shortcode.
  transport.emitReactionAdd({
    messageId: targetDiscordId,
    channelId: '111',
    userId: '777',
    userName: 'Discord Rhea',
    emoji: 'cheer',
    emojiId: '900',
  });
  await sleep(100);
  const externalReacted = messages.history(channelId, { limit: 50 }, userId).messages.find((m) => m.id === target.id);
  check(
    'a reaction with an emoji from another server is learned and renders',
    externalReacted?.reactions.some((reaction) => reaction.emoji === ':cheer:' && reaction.emojiId !== null) === true,
  );

  // 7f3. Learned emoji age out under their own retention rule once no bridged
  // message has carried them for a while. The instance's own emoji are exempt.
  const pruner = createPruner({ sqlite: db.sqlite, config, settings, hub, log: () => {} });
  settings.updateRetention({ externalEmojiRetentionDays: 0 });
  const emojiPrune = pruner.runNow();
  check(
    'learned emoji are pruned once unused',
    emojiPrune.deletedExternalEmojis > 0,
    String(emojiPrune.deletedExternalEmojis),
  );
  check('a learned emoji is gone', findEmojiByName(db.sqlite, 'party') === null);
  check('the instance emoji survives the learned-emoji rule', findEmojiByName(db.sqlite, 'YES') !== null);
  settings.updateRetention({ externalEmojiRetentionDays: null });

  // 7f4. A sticker is learned as a shared asset and attached to the message. The
  // same sticker sent again reuses it, a format that cannot be drawn as a picture
  // is kept as its name, and they age out under the sticker rule.
  transport.state.downloadBytes = png;
  const stickersBefore = db.sqlite.prepare('SELECT COUNT(*) AS count FROM stickers').get().count;
  transport.emit({
    id: 'd5d',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: '',
    attachments: [],
    stickers: [{ id: 'st1', name: 'wave', formatType: 1 }],
    fromBot: false,
  });
  await sleep(100);
  const stickerMessage = messages
    .history(channelId, { limit: 50 }, userId)
    .messages.find((m) => m.stickers.length > 0);
  check('a discord sticker is attached to the message', stickerMessage?.stickers[0]?.name === 'wave');
  check(
    'the sticker is fetched from the discord cdn',
    transport.state.downloads.includes('https://cdn.discordapp.com/stickers/st1.png'),
  );

  transport.emit({
    id: 'd5e',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: '',
    attachments: [],
    stickers: [{ id: 'st1', name: 'wave', formatType: 1 }],
    fromBot: false,
  });
  await sleep(100);
  check(
    'a repeated sticker is stored once',
    db.sqlite.prepare('SELECT COUNT(*) AS count FROM stickers').get().count === stickersBefore + 1,
  );

  transport.emit({
    id: 'd5f',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: '',
    attachments: [],
    stickers: [{ id: 'st2', name: 'wumpus', formatType: 3 }],
    fromBot: false,
  });
  await sleep(100);
  check(
    'a sticker that cannot be drawn is kept as its name',
    messages
      .history(channelId, { limit: 50 }, userId)
      .messages.some((m) => m.content === 'wumpus' && m.stickers.length === 0),
  );

  // A pasted "copy link" sticker link becomes the sticker itself, so it renders
  // instead of sitting there as a URL.
  transport.emit({
    id: 'd5g',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content:
      'https://media.discordapp.net/stickers/777.png?size=160&name=SmugTao+%28%40kuruwanchan%29&lossless=true',
    attachments: [],
    fromBot: false,
  });
  await sleep(100);
  const linkedSticker = messages
    .history(channelId, { limit: 50 }, userId)
    .messages.find((m) => m.stickers.some((sticker) => sticker.name.startsWith('SmugTao')));
  check('a pasted sticker link becomes a sticker', linkedSticker !== undefined && linkedSticker.content === '');
  check(
    'the linked sticker is fetched from the discord cdn',
    transport.state.downloads.includes('https://cdn.discordapp.com/stickers/777.png'),
  );

  settings.updateRetention({ stickerRetentionDays: 0 });
  const stickerPrune = pruner.runNow();
  check('learned stickers are pruned once unused', stickerPrune.deletedStickers > 0, String(stickerPrune.deletedStickers));
  settings.updateRetention({ stickerRetentionDays: null });

  // 7g. Discord mentions become Harmony mentions, creating stand-ins as needed.
  transport.emit({
    id: 'd6',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    mentions: [{ id: '555', name: 'Rhea' }],
    content: 'hello <@555> and <@!666>',
    attachments: [],
    fromBot: false,
  });
  await sleep(50);
  const mentionMessage = messages
    .history(channelId, { limit: 50 }, userId)
    .messages.find((m) => m.content.startsWith('hello '));
  check(
    'a discord mention becomes a harmony mention',
    mentionMessage?.content === 'hello @discord_555 and <@!666>',
    String(mentionMessage?.content),
  );
  check(
    'a mentioned discord user becomes a ghost account',
    findUserByDiscordId(db.sqlite, '555')?.display_name === 'Rhea',
  );

  // 7h. A mention of a bridged user pings them on Discord; a native Harmony
  // user is left as plain text.
  messages.create(auth, channelId, 'hi @discord_555 and @alice', [], null);
  await sleep(50);
  const mentionMirror = transport.state.mirrors.at(-1);
  check(
    'a bridged mention becomes a discord ping',
    mentionMirror?.content === 'hi <@555> and @alice',
    String(mentionMirror?.content),
  );
  check(
    'only the bridged user may be notified',
    mentionMirror?.allowedUserMentions?.join(',') === '555',
    String(mentionMirror?.allowedUserMentions),
  );

  // 7i. Channel mentions cross too, but only for a channel that is bridged
  // here; a reference with no counterpart on the other side stays plain text.
  transport.emit({
    id: 'd7',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: 'see <#111> and <#999>',
    attachments: [],
    fromBot: false,
  });
  await sleep(50);
  const channelRef = messages
    .history(channelId, { limit: 50 }, userId)
    .messages.find((message) => message.content.includes('#general'));
  check(
    'a discord channel mention becomes a harmony reference',
    channelRef?.content === 'see #general and <#999>',
    String(channelRef?.content),
  );

  messages.create(auth, channelId, 'move to #general, not #random', [], null);
  await sleep(50);
  const channelMirror = transport.state.mirrors.at(-1);
  check(
    'a harmony channel mention becomes a discord mention',
    channelMirror?.content === 'move to <#111>, not #random',
    String(channelMirror?.content),
  );

  // 8. Bots and webhooks never get ingested.
  const before = messages.history(channelId, { limit: 100 }, userId).messages.length;
  transport.emit({
    id: 'd3',
    channelId: '111',
    authorId: 'wh',
    authorName: 'Harmony',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: 'echo',
    attachments: [],
    fromBot: true,
  });
  await sleep(50);
  check('bot/webhook messages are ignored', messages.history(channelId, { limit: 100 }, userId).messages.length === before);

  // 9. Unmapped Discord channels are ignored.
  transport.emit({
    id: 'd4',
    channelId: '222',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: 'elsewhere',
    attachments: [],
    fromBot: false,
  });
  await sleep(50);
  check('unmapped discord channels are ignored', messages.history(channelId, { limit: 100 }, userId).messages.length === before);

  // 10. The admin test message surfaces problems clearly.
  const unbridgedId = randomUUID();
  insertChannel(db.sqlite, {
    id: unbridgedId,
    name: 'unbridged',
    topic: null,
    categoryId: null,
    type: 'text',
    position: 1,
    createdAt: new Date().toISOString(),
    discordChannelId: null,
    requiredRoleId: null,
  });

  let testError = '';
  try {
    await bridge.testMirror(unbridgedId);
  } catch (error) {
    testError = error instanceof Error ? error.message : String(error);
  }
  check('test message explains an unbridged channel', testError.includes('not linked'), testError);

  const mirrorsBeforeTest = transport.state.mirrors.length;
  await bridge.testMirror(channelId);
  check('test message reaches discord', transport.state.mirrors.length === mirrorsBeforeTest + 1);

  // 11. Discord emoji import. YES already exists from the reaction test above, so
  // it must be skipped; wave is new; X is too short for a Harmony emoji name.
  const emojiService = createEmojiService(db.sqlite, config);
  const emojiImport = createEmojiImportService({ emojis: emojiService, bridge, log: () => {} });
  transport.state.downloadBytes = png;
  transport.state.guildEmojis = [
    { id: '700', name: 'YES', animated: false },
    { id: '730', name: 'wave', animated: false },
    { id: '731', name: 'X', animated: false },
  ];

  const preview = await emojiImport.discordEmojis();
  check(
    'the emoji preview names the guild',
    preview.guildName === 'Test Guild' && preview.emojis.length === 3,
  );
  check(
    'the preview marks an emoji Harmony already has',
    preview.emojis.find((emoji) => emoji.name === 'YES')?.imported === true &&
      preview.emojis.find((emoji) => emoji.name === 'wave')?.imported === false,
  );

  const firstImport = await emojiImport.importMissing(auth);
  check('a new guild emoji is imported', firstImport.imported.length === 1 && firstImport.imported[0].name === 'wave');
  check('an existing emoji is skipped', firstImport.skipped === 1);
  check('an unusable discord name is counted as failed', firstImport.failed === 1);
  check(
    'the emoji bytes come from the discord cdn as png',
    transport.state.downloads.at(-1) === 'https://cdn.discordapp.com/emojis/730.png',
  );
  check('the imported emoji is stored', emojiService.list().some((emoji) => emoji.name === 'wave'));

  const secondImport = await emojiImport.importMissing(auth);
  check(
    'importing again skips everything already present',
    secondImport.imported.length === 0 && secondImport.skipped === 2 && secondImport.failed === 1,
  );

  // A selection imports only what was asked for, and nothing else.
  transport.state.guildEmojis = [...transport.state.guildEmojis, { id: '750', name: 'later', animated: false }];
  const unselected = await emojiImport.importMissing(auth, { emojiIds: ['999'] });
  check('an emoji selection that matches nothing imports nothing', unselected.imported.length === 0);
  const selectedEmoji = await emojiImport.importMissing(auth, { emojiIds: ['750'] });
  check(
    'an emoji selection imports only the chosen emoji',
    selectedEmoji.imported.length === 1 && selectedEmoji.imported[0].name === 'later' && selectedEmoji.skipped === 0,
  );

  const animated = await bridge.downloadGuildEmoji('740', true);
  check(
    'an animated emoji is fetched as a gif',
    animated.contentType === 'image/gif' &&
      transport.state.downloads.at(-1) === 'https://cdn.discordapp.com/emojis/740.gif',
  );

  // 12. Discord channel import. The channel for '111' is already bridged above,
  // so it is skipped; '222' is new and lands in a fresh 'General' category;
  // '333' is new and uncategorized, so it stays at the top level.
  const channelImport = createChannelImportService({ sqlite: db.sqlite, bridge, hub, log: () => {} });
  transport.state.recentMessages = [];

  const channelPreview = await channelImport.discordChannels();
  const previewChannels = channelPreview.groups.flatMap((group) => group.channels);
  check(
    'the channel preview names the guild and groups channels',
    channelPreview.guildName === 'Test Guild' && channelPreview.groups.length === 2,
  );
  check(
    'the channel preview marks an already bridged channel',
    previewChannels.find((channel) => channel.id === '111')?.bridged === true &&
      previewChannels.find((channel) => channel.id === '222')?.bridged === false,
  );
  check(
    'an uncategorized discord channel is grouped on its own',
    channelPreview.groups.find((group) => group.categoryName === null)?.channels.length === 1,
  );

  const channelImportResult = await channelImport.importMissing();
  check('new discord channels are imported', channelImportResult.imported === 2);
  check('an already bridged channel is skipped', channelImportResult.skipped === 1);
  check('the discord category is recreated', channelImportResult.categoriesCreated === 1);
  check(
    'the imported channels are bridged to discord',
    ['222', '333'].every((id) => listChannels(db.sqlite).some((channel) => channel.discord_channel_id === id)),
  );
  check(
    'the imported channel sits in its discord category',
    listCategories(db.sqlite).some((category) => category.name === 'General'),
  );

  const channelImportAgain = await channelImport.importMissing();
  check(
    'importing channels again skips everything',
    channelImportAgain.imported === 0 && channelImportAgain.skipped === 3 && channelImportAgain.categoriesCreated === 0,
  );

  // A selection imports only the named channels, leaving the rest for later.
  transport.state.textChannels = [
    ...transport.state.textChannels,
    { id: '444', name: 'later', categoryId: 'cat1' },
  ];
  const unselectedChannels = await channelImport.importMissing({ channelIds: ['999'] });
  check(
    'a channel selection that matches nothing imports nothing',
    unselectedChannels.imported === 0 && unselectedChannels.skipped === 0,
  );
  const selectedChannels = await channelImport.importMissing({ channelIds: ['444'] });
  check(
    'a channel selection imports only the chosen channel',
    selectedChannels.imported === 1 &&
      listChannels(db.sqlite).some((channel) => channel.discord_channel_id === '444') &&
      !listChannels(db.sqlite).some((channel) => channel.discord_channel_id === '555'),
  );

  // 13. Discord presence fills in the Discord side of the member list.
  const frames = [];
  const watcherId = hub.register(
    (payload) => frames.push(JSON.parse(payload)),
    () => {},
  );
  hub.authenticate(watcherId, {
    user: { id: 'watcher' },
    permissions: 0n,
    sessionId: 'watcher-session',
    token: 'watcher-token',
  });
  // The watcher's own arrival announced itself; only what follows matters here.
  frames.length = 0;

  const standIn = findUserByDiscordId(db.sqlite, '999');
  check('the stand-in account of a bridged author exists', standIn !== null);

  transport.emitPresence({ userId: '999', online: true });
  check('a Discord account is remembered as online', bridge.onlineDiscordIds().has('999'));
  check(
    'its stand-in account is announced as online',
    frames.some(
      (frame) => frame.t === 'PRESENCE_UPDATE' && frame.d?.user?.id === standIn?.id && frame.d?.online === true,
    ),
    JSON.stringify(frames),
  );

  frames.length = 0;
  transport.emitPresence({ userId: '999', online: true });
  check('a repeated presence change announces nothing', frames.length === 0);

  transport.emitPresence({ userId: '4242', online: true });
  check('a Discord account with no stand-in is not announced', frames.length === 0);
  check(
    'but it is remembered, so a stand-in created later starts out online',
    bridge.onlineDiscordIds().has('4242'),
  );

  frames.length = 0;
  transport.emitPresence({ userId: '999', online: false });
  check(
    'going offline is announced as well',
    frames.some((frame) => frame.t === 'PRESENCE_UPDATE' && frame.d?.online === false),
    JSON.stringify(frames),
  );
  check('and is no longer reported as online', !bridge.onlineDiscordIds().has('999'));

  transport.emitPresence({ userId: '999', online: true });

  // 13b. A gif link from Discord arrives once. Discord sends an update each time
  // it finishes unfurling the link, often while we are still downloading the
  // gif, and each of those used to store a copy of its own.
  settings.update({ embedsEnabled: true });
  const embeds = createEmbedService({
    sqlite: db.sqlite,
    settings,
    hub,
    attachments,
    renderMessage: (id) => messages.byId(id),
  });
  const gifUrl = 'https://93.184.216.34/funny.png';
  const gifMessage = messages.createBridged(channelId, userId, gifUrl, [], null, { silent: true });
  const realFetch = globalThis.fetch;
  let gifFetches = 0;
  globalThis.fetch = async () => {
    gifFetches++;
    await sleep(150);
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  };
  try {
    for (let i = 0; i < 3; i++) embeds.resolve(gifMessage.id, gifUrl);
    await sleep(800);
  } finally {
    globalThis.fetch = realFetch;
  }
  check(
    'a link resolved three times at once is kept once',
    listLinkedAttachments(db.sqlite, gifMessage.id).length === 1,
    `${listLinkedAttachments(db.sqlite, gifMessage.id).length} kept`,
  );
  check('and downloaded once', gifFetches === 1, `${gifFetches} fetches`);

  // The unfurl updates carry the same text, so they are not edits.
  check('an update with the same text is not an edit', messages.editBridged(gifMessage.id, gifUrl) === null);
  check('and does not mark the message edited', !messages.byId(gifMessage.id)?.editedAt);

  // The same Discord message delivered twice while the first is still being
  // stored (a live event racing a history import) is only stored once.
  transport.emit({
    id: 'twice',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: 'delivered twice',
    attachments: [{ url: 'https://cdn.example/twice.png', filename: 'twice.png', contentType: 'image/png', size: png.length }],
    fromBot: false,
  });
  transport.emit({
    id: 'twice',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: 'delivered twice',
    attachments: [{ url: 'https://cdn.example/twice.png', filename: 'twice.png', contentType: 'image/png', size: png.length }],
    fromBot: false,
  });
  await sleep(100);
  check(
    'a Discord message delivered twice at once is stored once',
    messages.history(channelId, { limit: 50 }, userId).messages.filter((m) => m.content === 'delivered twice').length === 1,
  );

  // 14. Disabling stops the transport, and takes the presence with it.
  settings.updateBridge({ enabled: false });
  await bridge.applySettings();
  check('transport stops when disabled', transport.state.ready === false);
  check(
    'stopping the bridge reports the stand-ins as offline',
    frames.some((frame) => frame.t === 'PRESENCE_UPDATE' && frame.d?.online === false),
    JSON.stringify(frames),
  );
  check('and forgets who was online', bridge.onlineDiscordIds().size === 0);
} catch (error) {
  failures++;
  console.error('UNEXPECTED ERROR:', error);
} finally {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
