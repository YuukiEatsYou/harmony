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
import {
  deleteUser,
  findUserById,
  findUserByDiscordId,
  insertUser,
  mergeUsers,
  setUserDiscordId,
} from '../src/db/users.ts';
import { listMessageEdits, recordMessageEdit } from '../src/db/message_edits.ts';
import { findBridgeMessageByDiscordId, findBridgeMessageByHarmonyId, hasSeenBridgeMessage } from '../src/db/bridge.ts';
import { listLinkedAttachments } from '../src/db/attachments.ts';
import { createEmbedService } from '../src/embeds/service.ts';
import { deleteEmoji, findEmojiByName, insertEmoji, toEmoji } from '../src/db/emojis.ts';
import { Permission, listEmbeddableUrls } from '@harmony/shared';
import { createAttachmentService } from '../src/attachments/service.ts';
import { createEmojiService } from '../src/emojis/service.ts';
import { createEmojiImportService } from '../src/emojis/import.ts';
import { GatewayHub } from '../src/realtime/hub.ts';
import { createSettingsService } from '../src/settings/service.ts';
import { createMessageService } from '../src/messages/service.ts';
import { createAuditService } from '../src/audit/service.ts';
import { createPinService } from '../src/pins/service.ts';
import { createUserService } from '../src/users/service.ts';
import { createBridgeService } from '../src/bridge/service.ts';
import { createPollService } from '../src/polls/service.ts';
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
    // Deletions made through the bot, for messages the webhook did not post.
    botDeletes: [],
    failBotDelete: false,
    reactions: [],
    created: [],
    edited: [],
    deleted: [],
    reactionAdded: [],
    reactionRemoved: [],
    reactionCleared: [],
    reactionsRemovedAll: [],
    presence: [],
    // What the fake Discord has pinned per channel, newest first, and what was asked of it.
    pinned: new Map(),
    pinCalls: [],
    pinReads: 0,
    failPin: false,
    pinsUpdated: [],
    reconnected: [],
    pollVoteAdded: [],
    pollVoteRemoved: [],
    pollEnded: [],
    pollMirrors: [],
    pollEnds: [],
    // Who Discord reports for an answer, keyed "<discord message id>:<answer id>".
    pollVoters: {},
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
    // Linked-member identities the fake Discord resolves, keyed by discord id.
    mirrorIdentities: new Map(),
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
    onReactionsRemovedAll(handler) {
      state.reactionsRemovedAll.push(handler);
    },
    onPresence(handler) {
      state.presence.push(handler);
    },
    onPinsUpdated(handler) {
      state.pinsUpdated.push(handler);
    },
    onReconnected(handler) {
      state.reconnected.push(handler);
    },
    async fetchPinned(channelId) {
      state.pinReads++;
      return [...(state.pinned.get(channelId) ?? [])];
    },
    async pinMessage(input) {
      if (state.failPin) throw new Error('Missing Permissions');
      const list = state.pinned.get(input.channelId) ?? [];
      if (list.length >= 50) throw new Error('Maximum number of pins reached (30003)');
      state.pinCalls.push({ kind: 'pin', ...input });
      state.pinned.set(input.channelId, [{ messageId: input.discordMessageId, pinnedAt: new Date().toISOString() }, ...list]);
    },
    async unpinMessage(input) {
      if (state.failPin) throw new Error('Missing Permissions');
      state.pinCalls.push({ kind: 'unpin', ...input });
      state.pinned.set(
        input.channelId,
        (state.pinned.get(input.channelId) ?? []).filter((pin) => pin.messageId !== input.discordMessageId),
      );
    },
    onPollVoteAdded(handler) {
      state.pollVoteAdded.push(handler);
    },
    onPollVoteRemoved(handler) {
      state.pollVoteRemoved.push(handler);
    },
    onPollEnded(handler) {
      state.pollEnded.push(handler);
    },
    async mirrorPoll(input) {
      state.pollMirrors.push(input);
      // Discord numbers the answers from 1, in the order given.
      return { messageId: `discord-poll-${state.pollMirrors.length}`, answerIds: input.answers.map((_, i) => i + 1) };
    },
    async endPoll(input) {
      state.pollEnds.push(input);
    },
    async fetchPollVoters(input) {
      return state.pollVoters[`${input.discordMessageId}:${input.answerId}`] ?? [];
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
    async mirrorIdentity(discordId) {
      return state.mirrorIdentities.get(discordId) ?? null;
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
    async deleteMessageAsBot(input) {
      if (state.failBotDelete) throw new Error('Missing Permissions');
      state.botDeletes.push(input);
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
      for (const handler of state.edited) handler({ mentions: [], fromBot: false, ...edit });
    },
    emitDelete(deletion) {
      for (const handler of state.deleted) handler(deletion);
    },
    emitReactionAdd(reaction) {
      for (const handler of state.reactionAdded) handler({ animated: false, ...reaction });
    },
    emitReactionRemove(reaction) {
      for (const handler of state.reactionRemoved) handler({ animated: false, ...reaction });
    },
    emitReactionClear(reaction) {
      for (const handler of state.reactionCleared) handler({ animated: false, ...reaction });
    },
    emitReactionsRemovedAll(removed) {
      for (const handler of state.reactionsRemovedAll) handler(removed);
    },
    emitPollVote(vote, add = true) {
      for (const handler of add ? state.pollVoteAdded : state.pollVoteRemoved) handler(vote);
    },
    emitPollEnd(ended) {
      for (const handler of state.pollEnded) handler(ended);
    },
    emitPresence(presence) {
      for (const handler of state.presence) handler(presence);
    },
    emitPinsUpdated(channelId) {
      for (const handler of state.pinsUpdated) handler(channelId);
    },
    emitReconnected() {
      for (const handler of state.reconnected) handler();
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
const polls = createPollService(db.sqlite, hub, messages);
const transport = createFakeTransport();
const pins = createPinService(db.sqlite, hub, audit, messages);
const serverWarnings = [];

const previews = [];
const bridge = createBridgeService({
  sqlite: db.sqlite,
  config,
  settings,
  messages,
  polls,
  users,
  hub,
  pins,
  logger,
  serverLog: { info() {}, warn: (event) => serverWarnings.push(event) },
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
  check('ingested message is attributed to a ghost user', ingested?.author?.accountType === 'ghost');
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

  // 4a. A suppressed link from Discord keeps its angle brackets, so it stays
  // suppressed here too: the client draws it as a plain link and the resolver
  // finds nothing to unfurl.
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
    'a suppressed discord link keeps its brackets when stored',
    unwrapped?.content === 'watch <https://www.youtube.com/watch?v=dQw4w9WgXcQ> ok',
    String(unwrapped?.content),
  );
  check(
    'and the unfurler is given the bracketed text, which it skips',
    previews.some((entry) => entry.messageId === unwrapped?.id && entry.content === 'watch <https://www.youtube.com/watch?v=dQw4w9WgXcQ> ok') &&
      listEmbeddableUrls('watch <https://www.youtube.com/watch?v=dQw4w9WgXcQ> ok').length === 0,
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

  // Edit history: a Discord edit keeps the previous text, an unchanged one keeps nothing.
  const d1Edits = listMessageEdits(db.sqlite, ingested.id);
  check(
    'a discord edit records the previous text',
    d1Edits.length === 1 && d1Edits[0].source === 'discord' && d1Edits[0].content !== 'edited in discord',
    JSON.stringify(d1Edits),
  );
  transport.emitEdit({ id: 'd1', channelId: '111', content: 'edited in discord' });
  await sleep(50);
  check('a discord edit with unchanged text records nothing', listMessageEdits(db.sqlite, ingested.id).length === 1);
  {
    const ghostId = randomUUID();
    insertUser(db.sqlite, { id: ghostId, username: 'ghost-editor', passwordHash: 'scrypt$x$y$z', isOwner: false });
    const keeperId = randomUUID();
    insertUser(db.sqlite, { id: keeperId, username: 'keeper', passwordHash: 'scrypt$x$y$z', isOwner: false });
    const when = new Date().toISOString();
    recordMessageEdit(db.sqlite, { messageId: ingested.id, editorId: ghostId, content: 'x', editedAt: when, source: 'harmony' });
    mergeUsers(db.sqlite, ghostId, keeperId);
    check(
      'a merge hands the edits to the surviving account',
      listMessageEdits(db.sqlite, ingested.id).some((e) => e.content === 'x' && e.editor_id === keeperId),
    );
    deleteUser(db.sqlite, keeperId);
    check(
      'deleting an account leaves its edits with no editor',
      listMessageEdits(db.sqlite, ingested.id).some((e) => e.content === 'x' && e.editor_id === null),
    );
  }

  transport.emitDelete({ id: 'd1', channelId: '111' });
  await sleep(50);
  check(
    'discord delete reaches harmony',
    messages.history(channelId, { limit: 50 }, userId).messages.every((m) => m.id !== ingested?.id),
  );
  check('a soft-deleted message keeps its edit rows', listMessageEdits(db.sqlite, ingested.id).length === 2);
  db.sqlite.prepare('DELETE FROM messages WHERE id = ?').run(ingested.id);
  check('a hard delete takes the edit rows with it', listMessageEdits(db.sqlite, ingested.id).length === 0);

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

  // 7b2. A member with a linked Discord account is mirrored under the identity
  // Discord knows them by, so the name and face match what the guild sees.
  const carolId = randomUUID();
  insertUser(db.sqlite, { id: carolId, username: 'carol', passwordHash: 'scrypt$x$y$z', isOwner: false });
  users.linkDiscord(carolId, '9001');
  transport.state.mirrorIdentities.set('9001', {
    name: 'Carol (Discord)',
    avatarUrl: 'https://cdn.discordapp.com/avatars/9001/hash.png',
  });
  const carolAuth = { user: { id: carolId }, permissions: 0n, sessionId: 'sc', token: 'tc' };
  messages.create(carolAuth, channelId, 'linked identity', [], null);
  await sleep(50);
  check(
    'a linked member mirrors under their discord name',
    transport.state.mirrors.at(-1)?.username === 'Carol (Discord)',
    String(transport.state.mirrors.at(-1)?.username),
  );
  check(
    'a linked member mirrors with their discord avatar',
    transport.state.mirrors.at(-1)?.avatarUrl === 'https://cdn.discordapp.com/avatars/9001/hash.png',
    String(transport.state.mirrors.at(-1)?.avatarUrl),
  );
  // A linked member with no Discord picture keeps their Harmony one, rather than
  // the webhook's own default picture.
  await users.setAvatarFromData(carolId, png);
  const carolAvatarHash = findUserById(db.sqlite, carolId)?.avatar_hash;
  transport.state.mirrorIdentities.set('9001', { name: 'Carol (Discord)', avatarUrl: null });
  messages.create(carolAuth, channelId, 'no discord picture', [], null);
  await sleep(50);
  check(
    'a linked member with no discord picture keeps their harmony avatar',
    transport.state.mirrors.at(-1)?.avatarUrl ===
      `https://chat.example.com/api/v1/users/${carolId}/avatar?v=${carolAvatarHash}`,
    String(transport.state.mirrors.at(-1)?.avatarUrl),
  );

  // 7b3. A linked member's picture follows Discord: pulled when it changes,
  // skipped when it has not, cleared when Discord drops it, and left alone when
  // the member has turned syncing off.
  const daveId = randomUUID();
  insertUser(db.sqlite, { id: daveId, username: 'dave', passwordHash: 'scrypt$x$y$z', isOwner: false });
  users.linkDiscord(daveId, '9100');
  transport.state.downloadBytes = png;
  const daveOne = 'https://cdn.discordapp.com/avatars/9100/11111111111111111111111111111111.png';
  transport.state.mirrorIdentities.set('9100', { name: 'Dave', avatarUrl: daveOne });
  await bridge.syncDiscordAvatarFor(daveId);
  check(
    'a linked member picture is pulled from discord',
    typeof findUserById(db.sqlite, daveId)?.avatar_hash === 'string',
  );

  const beforeUnchanged = transport.state.downloads.length;
  await bridge.syncDiscordAvatarFor(daveId);
  check('an unchanged discord picture is not fetched again', transport.state.downloads.length === beforeUnchanged);

  transport.state.mirrorIdentities.set('9100', {
    name: 'Dave',
    avatarUrl: 'https://cdn.discordapp.com/avatars/9100/22222222222222222222222222222222.png',
  });
  await bridge.syncDiscordAvatarFor(daveId);
  check('a changed discord picture is fetched', transport.state.downloads.length === beforeUnchanged + 1);

  transport.state.mirrorIdentities.set('9100', { name: 'Dave', avatarUrl: null });
  await bridge.syncDiscordAvatarFor(daveId);
  check('a picture discord no longer has is cleared', findUserById(db.sqlite, daveId)?.avatar_hash === null);

  users.updateProfile(daveId, { syncDiscordAvatar: false });
  transport.state.mirrorIdentities.set('9100', { name: 'Dave', avatarUrl: daveOne });
  const beforeOff = transport.state.downloads.length;
  await bridge.syncDiscordAvatarFor(daveId);
  check(
    'a member with syncing off is left alone',
    findUserById(db.sqlite, daveId)?.avatar_hash === null && transport.state.downloads.length === beforeOff,
  );

  // The sweep catches a member who has never been checked, which is the only way
  // a quiet member's change is ever noticed.
  const erinId = randomUUID();
  insertUser(db.sqlite, { id: erinId, username: 'erin', passwordHash: 'scrypt$x$y$z', isOwner: false });
  users.linkDiscord(erinId, '9200');
  transport.state.mirrorIdentities.set('9200', {
    name: 'Erin',
    avatarUrl: 'https://cdn.discordapp.com/avatars/9200/33333333333333333333333333333333.png',
  });
  await bridge.syncDueDiscordAvatars();
  check(
    'the sweep pulls a picture for a member who has never been checked',
    typeof findUserById(db.sqlite, erinId)?.avatar_hash === 'string',
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
  const emojiDeletesBefore = broadcasts.filter((entry) => entry.event === 'EMOJI_DELETE').length;
  const emojiPrune = pruner.runNow();
  check(
    'learned emoji are pruned once unused',
    emojiPrune.deletedExternalEmojis > 0,
    String(emojiPrune.deletedExternalEmojis),
  );
  check('a learned emoji is gone', findEmojiByName(db.sqlite, 'party') === null);
  check(
    'pruning a learned emoji is announced to clients',
    broadcasts.filter((entry) => entry.event === 'EMOJI_DELETE').length > emojiDeletesBefore,
  );
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

  // 13c. Keeping the two sides in step. Messages below come from the same
  // Discord author unless a test says otherwise.
  const fromDiscord = (fields) => ({
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    attachments: [],
    fromBot: false,
    ...fields,
  });
  const recent = () => messages.history(channelId, { limit: 100 }, userId).messages;
  const modAuth = { user: { id: userId }, permissions: Permission.ManageMessages, sessionId: 'sm', token: 'tm' };

  // Our own edit of a mirrored message comes back from Discord as an update, in
  // Discord's form. It must not be applied over what was written here.
  const ownWords = messages.create(auth, channelId, 'my own words, @bob', [], original.id);
  await sleep(50);
  const ownDiscordId = findBridgeMessageByHarmonyId(db.sqlite, ownWords.id)?.discord_message_id;
  transport.emitEdit({
    id: ownDiscordId,
    channelId: '111',
    content: '> **alice**: the original\nmy own words, @bob',
    fromBot: true,
  });
  await sleep(50);
  check(
    'our own edit echoed back by discord is ignored',
    messages.byId(ownWords.id)?.content === 'my own words, @bob' && !messages.byId(ownWords.id)?.editedAt,
    String(messages.byId(ownWords.id)?.content),
  );

  // A Discord edit that adds a mention reads the same as a message sent with one.
  transport.emit(fromDiscord({ id: 'e1', content: 'before the edit' }));
  await sleep(50);
  transport.emitEdit({ id: 'e1', channelId: '111', content: 'after <@555>', mentions: [{ id: '555', name: 'Rhea' }] });
  await sleep(50);
  check(
    'a discord edit rewrites its mentions',
    recent().some((m) => m.content === 'after @discord_555'),
  );

  // Suppressed links round-trip: an edit that wraps a link keeps the brackets and
  // one that unwraps it lets it unfurl again; a Harmony message with one is sent
  // to Discord as written, so Discord hides the preview as well.
  transport.emit(fromDiscord({ id: 'e2', content: 'see https://example.com/a' }));
  await sleep(50);
  transport.emitEdit({ id: 'e2', channelId: '111', content: 'see <https://example.com/a>' });
  await sleep(50);
  const wrappedEdit = recent().find((m) => m.content === 'see <https://example.com/a>');
  check('a discord edit that suppresses a link keeps its brackets', Boolean(wrappedEdit));
  check(
    'and is offered to the unfurler as suppressed',
    previews.filter((entry) => entry.messageId === wrappedEdit?.id).at(-1)?.content === 'see <https://example.com/a>',
  );
  transport.emitEdit({ id: 'e2', channelId: '111', content: 'see https://example.com/a' });
  await sleep(50);
  check(
    'an edit that unwraps it is offered as a plain link again',
    previews.filter((entry) => entry.messageId === wrappedEdit?.id).at(-1)?.content === 'see https://example.com/a',
  );
  messages.create(auth, channelId, 'quiet <https://example.com/q> link', [], null);
  await sleep(50);
  check(
    'a suppressed link is sent to discord with its brackets',
    transport.state.mirrors.at(-1)?.content === 'quiet <https://example.com/q> link',
    String(transport.state.mirrors.at(-1)?.content),
  );

  // A Discord-authored message deleted here is deleted through the bot, since
  // the webhook can only delete its own; the mapping goes either way.
  transport.emit(fromDiscord({ id: 'p1', content: 'deleted here by a moderator' }));
  await sleep(50);
  const doomed = recent().find((m) => m.content === 'deleted here by a moderator');
  const webhookDeletesBefore = transport.state.deletes.length;
  messages.remove(modAuth, doomed.id);
  await sleep(50);
  check(
    'a discord message deleted here is deleted by the bot',
    transport.state.botDeletes.at(-1)?.discordMessageId === 'p1' && transport.state.botDeletes.at(-1)?.channelId === '111',
    JSON.stringify(transport.state.botDeletes),
  );
  check('the webhook is not asked to delete it', transport.state.deletes.length === webhookDeletesBefore);
  check('and its mapping is dropped', findBridgeMessageByHarmonyId(db.sqlite, doomed.id) === null);

  transport.emit(fromDiscord({ id: 'p2', content: 'the bot may not delete this' }));
  await sleep(50);
  const undeletable = recent().find((m) => m.content === 'the bot may not delete this');
  transport.state.failBotDelete = true;
  messages.remove(modAuth, undeletable.id);
  await sleep(50);
  transport.state.failBotDelete = false;
  check(
    'the mapping is dropped even when discord refuses the delete',
    findBridgeMessageByHarmonyId(db.sqlite, undeletable.id) === null,
  );

  // A Discord reply to a message deleted here still arrives, as a plain message.
  // The deletion is applied the way one made while the bridge was down would be,
  // leaving the mapping to the deleted parent in place.
  transport.emit(fromDiscord({ id: 'p3', content: 'about to be deleted' }));
  await sleep(50);
  const deletedParent = recent().find((m) => m.content === 'about to be deleted');
  messages.deleteBridged(deletedParent.id);
  transport.state.downloadBytes = png;
  transport.emit(
    fromDiscord({
      id: 'p4',
      replyToDiscordId: 'p3',
      content: 'answering a deleted message',
      attachments: [{ url: 'https://cdn.example/answer.png', filename: 'answer.png', contentType: 'image/png', size: png.length }],
    }),
  );
  await sleep(100);
  const orphanReply = recent().find((m) => m.content === 'answering a deleted message');
  check('a discord reply to a message deleted here still arrives', orphanReply !== undefined);
  check('as a plain message with its attachment', orphanReply?.replyTo === null && orphanReply?.attachments.length === 1);
  check('and is recorded as seen', hasSeenBridgeMessage(db.sqlite, 'p4'));

  // A message longer than Discord allows goes out in several parts, the first
  // carrying the files and standing for the message in later edits.
  const longText = `${'word '.repeat(700)}end`;
  const mirrorsBeforeLong = transport.state.mirrors.length;
  const longMessage = messages.create(auth, channelId, longText, [], null);
  await sleep(50);
  const longParts = transport.state.mirrors.slice(mirrorsBeforeLong);
  check(
    'a long message is split for discord',
    longParts.length === 2 && longParts.every((part) => part.content.length <= 2000),
    longParts.map((part) => part.content.length).join(','),
  );
  check(
    'nothing is lost in the split',
    longParts.map((part) => part.content).join(' ') === longText,
  );
  check(
    'the first part stands for the message',
    findBridgeMessageByHarmonyId(db.sqlite, longMessage.id)?.discord_message_id === `discord-${mirrorsBeforeLong + 1}`,
  );
  check('the following parts are remembered as ours', hasSeenBridgeMessage(db.sqlite, `discord-${mirrorsBeforeLong + 2}`));
  messages.edit(auth, longMessage.id, `${longText} edited`);
  await sleep(50);
  check(
    'an edit too long for one discord message is shortened visibly',
    transport.state.edits.at(-1)?.content.length <= 2000 &&
      transport.state.edits.at(-1)?.content.endsWith('*(continued in Harmony)*'),
  );

  // Every reaction cleared at once on Discord clears them here too.
  check('the target message has reactions to clear', (messages.byId(target.id)?.reactions.length ?? 0) > 0);
  const reactionsOutBeforeClear = transport.state.reactions.length;
  transport.emitReactionsRemovedAll({ messageId: targetDiscordId, channelId: '111' });
  await sleep(50);
  check('removing every reaction on discord clears them here', messages.byId(target.id)?.reactions.length === 0);
  check(
    'and clients are told',
    broadcasts.some((entry) => entry.event === 'MESSAGE_REACTIONS_CLEAR' && entry.payload?.messageId === target.id),
  );
  check('and nothing is mirrored back', transport.state.reactions.length === reactionsOutBeforeClear);

  // A forward carries the forwarded message's text and files, marked as a forward.
  transport.state.downloadBytes = png;
  transport.emit(
    fromDiscord({
      id: 'fw1',
      forwarded: true,
      content: 'words from elsewhere',
      attachments: [{ url: 'https://cdn.example/fw.png', filename: 'fw.png', contentType: 'image/png', size: png.length }],
    }),
  );
  await sleep(100);
  const forwarded = recent().find((m) => m.content.endsWith('words from elsewhere'));
  check(
    'a forwarded discord message arrives, marked as a forward',
    forwarded?.content === '*Forwarded*\nwords from elsewhere' && forwarded.attachments.length === 1,
    String(forwarded?.content),
  );

  // Several deletions in a row, as a bulk delete hands them on, all land.
  transport.emit(fromDiscord({ id: 'b1', content: 'purged one' }));
  transport.emit(fromDiscord({ id: 'b2', content: 'purged two' }));
  await sleep(50);
  transport.emitDelete({ id: 'b1', channelId: '111' });
  transport.emitDelete({ id: 'b2', channelId: '111' });
  await sleep(50);
  check(
    'a run of discord deletions removes every message',
    !recent().some((m) => m.content === 'purged one' || m.content === 'purged two'),
  );

  // An emoji learned from a message is announced, so connected clients render it.
  transport.emit(fromDiscord({ id: 'em1', content: 'look <:fresh:802>' }));
  await sleep(100);
  check(
    'a learned emoji is announced to clients',
    broadcasts.some((entry) => entry.event === 'EMOJI_CREATE' && entry.payload?.name === 'fresh' && entry.payload?.external === true),
  );

  // An animated emoji first seen in a reaction is learned as a gif.
  transport.emitReactionAdd({
    messageId: targetDiscordId,
    channelId: '111',
    userId: '777',
    userName: 'Discord Rhea',
    emoji: 'spin',
    emojiId: '803',
    animated: true,
  });
  await sleep(100);
  check(
    'an animated reaction emoji is fetched as a gif',
    transport.state.downloads.includes('https://cdn.discordapp.com/emojis/803.gif'),
  );

  // The bot's reaction stands in for Harmony's reactors only. A Discord user
  // reacting the same way must not keep it there once the last of them leaves.
  const shared = messages.create(auth, channelId, 'react together', [], null);
  await sleep(50);
  const sharedDiscordId = findBridgeMessageByHarmonyId(db.sqlite, shared.id)?.discord_message_id;
  messages.toggleReaction(auth, shared.id, '🌟', null);
  await sleep(50);
  transport.emitReactionAdd({
    messageId: sharedDiscordId,
    channelId: '111',
    userId: '777',
    userName: 'Discord Rhea',
    emoji: '🌟',
    emojiId: null,
  });
  await sleep(50);
  messages.toggleReaction(auth, shared.id, '🌟', null);
  await sleep(50);
  check(
    'the bot reaction goes once no harmony member is left reacting',
    transport.state.reactions.at(-1)?.kind === 'remove' &&
      transport.state.reactions.at(-1)?.discordMessageId === sharedDiscordId &&
      transport.state.reactions.at(-1)?.emoji === encodeURIComponent('🌟'),
    JSON.stringify(transport.state.reactions.at(-1)),
  );

  // A reaction whose custom emoji has since been deleted can still be taken
  // away, but not added again.
  insertEmoji(db.sqlite, {
    id: 'emoji-temp',
    name: 'temp',
    hash: 'deadbeef',
    contentType: 'image/png',
    animated: false,
    createdBy: userId,
    createdAt: new Date().toISOString(),
  });
  messages.toggleReaction(auth, shared.id, ':temp:', 'emoji-temp');
  messages.toggleReaction(bobAuth, shared.id, ':temp:', 'emoji-temp');
  deleteEmoji(db.sqlite, 'emoji-temp');
  let removeError = null;
  try {
    messages.toggleReaction(auth, shared.id, ':temp:', 'emoji-temp');
  } catch (error) {
    removeError = error;
  }
  check('a reaction of a deleted emoji can be removed', removeError === null, String(removeError?.message));
  check(
    'and only that one reaction is gone',
    messages.byId(shared.id)?.reactions.find((reaction) => reaction.emoji === ':temp:')?.count === 1,
  );
  let addError = null;
  try {
    messages.toggleReaction(auth, shared.id, ':temp:', 'emoji-temp');
  } catch (error) {
    addError = error;
  }
  check('but a deleted emoji cannot be added', addError?.code === 'invalid_emoji', String(addError?.code));
  let clearError = null;
  try {
    messages.clearReactions(modAuth, shared.id, ':temp:', 'emoji-temp');
  } catch (error) {
    clearError = error;
  }
  check(
    'a moderator can clear a deleted emoji',
    clearError === null && !messages.byId(shared.id)?.reactions.some((reaction) => reaction.emoji === ':temp:'),
    String(clearError?.message),
  );

  // A stand-in's name follows the one its Discord author goes by, and clients
  // hear about it. A reaction, which only knows the account's global name, does
  // not change it.
  const samId = findUserByDiscordId(db.sqlite, '999')?.id;
  transport.emit(fromDiscord({ id: 'n1', authorName: 'Samuel', content: 'new name, who dis' }));
  await sleep(50);
  check('a stand-in takes on a new discord name', findUserByDiscordId(db.sqlite, '999')?.display_name === 'Samuel');
  check(
    'and clients are told',
    broadcasts.some((entry) => entry.event === 'MEMBER_UPDATE' && entry.payload?.userId === samId),
  );
  transport.emitReactionAdd({
    messageId: sharedDiscordId,
    channelId: '111',
    userId: '777',
    userName: 'rhea_global',
    emoji: '👋',
    emojiId: null,
  });
  await sleep(50);
  check('a reaction does not rename a stand-in', findUserByDiscordId(db.sqlite, '777')?.display_name === 'Discord Rhea');

  // An edit brings the inbox in line: a name added to a message is found there,
  // a name taken out is not, and a reply stays a reply throughout.
  const inbox = () => messages.mentions(bobAuth, { limit: 50 }).mentions;
  const plain = messages.create(auth, channelId, 'nobody named yet', [], null);
  messages.edit(auth, plain.id, 'now naming @bob');
  check('naming someone in an edit reaches their inbox', inbox().some((entry) => entry.message.id === plain.id && entry.kind === 'mention'));
  messages.edit(auth, plain.id, 'nobody named again');
  check('taking the name out removes it', !inbox().some((entry) => entry.message.id === plain.id));

  const bobSays = messages.create(bobAuth, channelId, 'bob says something', [], null);
  const answer = messages.create(auth, channelId, 'an answer', [], bobSays.id);
  messages.edit(auth, answer.id, 'an answer for @bob');
  messages.edit(auth, answer.id, 'an answer, edited');
  check(
    'a reply stays in the inbox through edits',
    inbox().some((entry) => entry.message.id === answer.id && entry.kind === 'reply'),
  );

  const bridgedMention = messages.createBridged(channelId, samId, 'from discord', [], null);
  messages.editBridged(bridgedMention.id, 'from discord, for @bob');
  check('a bridged edit that names someone reaches their inbox', inbox().some((entry) => entry.message.id === bridgedMention.id));

  // 13d. Pins, both ways. The fake models Discord's own pin list, and a pin
  // change on either side is followed by the update event Discord would send.
  const pinCallCount = () => transport.state.pinCalls.length;
  const settle = () => sleep(80);
  const pinRows = () =>
    db.sqlite
      .prepare("SELECT kind, actor_id, detail FROM audit_log WHERE kind IN ('message_pin', 'message_unpin') ORDER BY rowid")
      .all();
  const pinned = (id) => Boolean(messages.byId(id)?.pinnedAt);
  const discordIdOf = (harmonyId) => findBridgeMessageByHarmonyId(db.sqlite, harmonyId)?.discord_message_id;
  const harmonyIdOf = (discordId) => findBridgeMessageByDiscordId(db.sqlite, discordId)?.harmony_message_id;

  const pinMine = messages.create(auth, channelId, 'pin this one', [], null);
  await sleep(50);
  const pinMineDiscord = discordIdOf(pinMine.id);

  // Harmony -> Discord, before the channel's pins were ever read.
  const callsBefore = pinCallCount();
  pins.pin(modAuth, channelId, pinMine.id);
  await settle();
  check(
    'pinning a mirrored message in Harmony pins it on Discord',
    transport.state.pinCalls.slice(callsBefore).some(
      (call) => call.kind === 'pin' && call.channelId === '111' && call.discordMessageId === pinMineDiscord,
    ),
  );
  check('and Harmony keeps its pin', pinned(pinMine.id));
  pins.unpin(modAuth, channelId, pinMine.id);
  await settle();
  check(
    'unpinning it in Harmony unpins it on Discord',
    transport.state.pinCalls.at(-1)?.kind === 'unpin' &&
      transport.state.pinCalls.at(-1)?.discordMessageId === pinMineDiscord &&
      !(transport.state.pinned.get('111') ?? []).some((pin) => pin.messageId === pinMineDiscord),
  );

  // The first update for a channel reads its pins; nothing is pinned yet.
  transport.emitPinsUpdated('111');
  await settle();
  check('the first pin read changes nothing in Harmony', !pinned(pinMine.id));

  // Discord -> Harmony.
  transport.emit(fromDiscord({ id: 'pn1', content: 'pin me from discord' }));
  transport.emit(fromDiscord({ id: 'pn2', content: 'and me too' }));
  await settle();
  const pn1 = harmonyIdOf('pn1');
  const pn2 = harmonyIdOf('pn2');
  const callsAfterIngest = pinCallCount();
  const auditBefore = pinRows().length;
  transport.state.pinned.set('111', [{ messageId: 'pn1', pinnedAt: '2026-01-02T03:04:05.000Z' }]);
  transport.emitPinsUpdated('111');
  await settle();
  check('a message pinned on Discord is pinned in Harmony', pinned(pn1));
  check('it keeps the time Discord pinned it', messages.byId(pn1)?.pinnedAt === '2026-01-02T03:04:05.000Z');
  check('and a message that was not pinned stays unpinned', !pinned(pn2));
  check('a pin that began on Discord is never sent back', pinCallCount() === callsAfterIngest);
  const newRows = pinRows().slice(auditBefore);
  check(
    'it is audited with no actor, as Discord',
    newRows.length === 1 && newRows[0].kind === 'message_pin' && newRows[0].actor_id === null &&
      JSON.parse(newRows[0].detail).actorName === 'Discord',
    JSON.stringify(newRows),
  );

  // Two pins at once, and a repeated event, are applied exactly once.
  transport.state.pinned.set('111', [
    { messageId: 'pn2', pinnedAt: '2026-01-03T00:00:00.000Z' },
    { messageId: 'pn1', pinnedAt: '2026-01-02T03:04:05.000Z' },
  ]);
  transport.emitPinsUpdated('111');
  transport.emitPinsUpdated('111');
  transport.emitPinsUpdated('111');
  await settle();
  check('a second pin on Discord reaches Harmony', pinned(pn2));
  check('a burst of updates is not applied repeatedly', pinRows().length === auditBefore + 2, String(pinRows().length));
  check('and still nothing is sent back', pinCallCount() === callsAfterIngest);

  // Unpinned on Discord.
  transport.state.pinned.set('111', [{ messageId: 'pn2', pinnedAt: '2026-01-03T00:00:00.000Z' }]);
  transport.emitPinsUpdated('111');
  await settle();
  check('a message unpinned on Discord is unpinned in Harmony', !pinned(pn1) && pinned(pn2));
  check('which is audited too', pinRows().at(-1)?.kind === 'message_unpin' && pinRows().at(-1)?.actor_id === null);
  check('and not echoed', pinCallCount() === callsAfterIngest);

  // Echo: our own pin comes back as an update and must change nothing.
  pins.pin(modAuth, channelId, pinMine.id);
  await settle();
  const readsBefore = transport.state.pinReads;
  const rowsBeforeEcho = pinRows().length;
  const callsBeforeEcho = pinCallCount();
  transport.emitPinsUpdated('111');
  await settle();
  check('the update our own pin causes is read', transport.state.pinReads > readsBefore);
  check('but changes nothing in Harmony', pinned(pinMine.id) && pinned(pn2) && pinRows().length === rowsBeforeEcho);
  check('and sends nothing more to Discord', pinCallCount() === callsBeforeEcho);
  pins.unpin(modAuth, channelId, pinMine.id);
  await settle();
  transport.emitPinsUpdated('111');
  await settle();
  check('the same holds for our own unpin', !pinned(pinMine.id) && pinned(pn2));

  // A pin made without Discord's permission: Harmony keeps it, once-logged.
  const noRights1 = messages.create(auth, channelId, 'pin without rights', [], null);
  const noRights2 = messages.create(auth, channelId, 'and another', [], null);
  await sleep(50);
  const warningsBefore = serverWarnings.filter((event) => event === 'bridge_pin_failed').length;
  transport.state.failPin = true;
  pins.pin(modAuth, channelId, noRights1.id);
  await settle();
  pins.pin(modAuth, channelId, noRights2.id);
  await settle();
  transport.state.failPin = false;
  check('a pin Discord refuses stays pinned in Harmony', pinned(noRights1.id) && pinned(noRights2.id));
  check(
    'and the failure is reported once, not per pin',
    serverWarnings.filter((event) => event === 'bridge_pin_failed').length === warningsBefore + 1,
  );
  transport.emitPinsUpdated('111');
  await settle();
  check('a later update does not undo a pin Discord never had', pinned(noRights1.id) && pinned(noRights2.id));
  pins.unpin(modAuth, channelId, noRights1.id);
  pins.unpin(modAuth, channelId, noRights2.id);
  await settle();

  // A success clears the once-only flag, so a later failure is reported again.
  const recovers = messages.create(auth, channelId, 'recovers', [], null);
  await sleep(50);
  pins.pin(modAuth, channelId, recovers.id);
  await settle();
  transport.state.failPin = true;
  pins.unpin(modAuth, channelId, recovers.id);
  await settle();
  transport.state.failPin = false;
  check(
    'a failure after a success is reported again',
    serverWarnings.filter((event) => event === 'bridge_pin_failed').length === warningsBefore + 2,
  );
  // The unpin failed, so Discord still holds it; Harmony stays unpinned.
  transport.emitPinsUpdated('111');
  await settle();
  check('Harmony stays unpinned after a failed unpin', !pinned(recovers.id));
  transport.state.pinned.set('111', (transport.state.pinned.get('111') ?? []).filter((pin) => pin.messageId !== discordIdOf(recovers.id)));
  transport.emitPinsUpdated('111');
  await settle();

  // Discord's own "pinned a message" notice is not a message.
  const beforeNotices = recent().length;
  transport.emit(fromDiscord({ id: 'sys1', content: '', system: true }));
  transport.emit(fromDiscord({ id: 'sys2', content: 'Sam pinned a message to this channel.', system: true }));
  await settle();
  check('the pinned-a-message notice is not mirrored', recent().length === beforeNotices);

  // Harmony is full: a Discord pin that does not fit is left alone, then taken once there is room.
  transport.emitPinsUpdated('222');
  await settle();
  const capIds = [];
  for (let i = 1; i <= 51; i++) {
    transport.emit(fromDiscord({ id: `cap${i}`, channelId: '222', content: `cap message ${i}` }));
  }
  await sleep(300);
  for (let i = 1; i <= 51; i++) capIds.push(harmonyIdOf(`cap${i}`));
  check('the capped channel received its messages', capIds.every(Boolean));
  for (let i = 0; i < 50; i++) pins.pinBridged(capIds[i]);
  check('Harmony holds 50 pins', capIds.slice(0, 50).every(pinned));
  transport.state.pinned.set('222', [{ messageId: 'cap51', pinnedAt: new Date().toISOString() }]);
  transport.emitPinsUpdated('222');
  await settle();
  check('a pin that does not fit in a full Harmony channel is skipped', !pinned(capIds[50]));
  check('without disturbing the pins already there', capIds.slice(0, 50).every(pinned));
  pins.unpinBridged(capIds[0]);
  transport.emitPinsUpdated('222');
  await settle();
  check('it is taken on the next update once there is room', pinned(capIds[50]));

  // Reconnecting reads every bridged channel again and adds what either side is missing.
  const harmonyOnly = messages.create(auth, channelId, 'pinned only in Harmony', [], null);
  await sleep(50);
  pins.pinBridged(harmonyOnly.id);
  transport.emit(fromDiscord({ id: 'bf1', content: 'pinned on Discord while away' }));
  await settle();
  transport.state.pinned.set('111', [{ messageId: 'bf1', pinnedAt: '2026-02-01T00:00:00.000Z' }]);
  transport.emitReconnected();
  await sleep(250);
  check('a reconnect picks up a pin made on Discord meanwhile', pinned(harmonyIdOf('bf1')));
  check(
    'and sends over a Harmony pin Discord is missing',
    (transport.state.pinned.get('111') ?? []).some((pin) => pin.messageId === discordIdOf(harmonyOnly.id)),
  );
  check('without removing anything from Harmony', pinned(harmonyOnly.id) && pinned(pn2));

  // 13d. Polls. A poll made here is posted to Discord as a native poll; one made
  // there arrives as a poll message. Discord's bots cannot vote, so votes cross
  // in one direction only (Discord into Harmony), and closing crosses both ways.
  const pollsOf = (messageId) => messages.byId(messageId)?.poll;
  const pollEvents = () => broadcasts.filter((entry) => entry.event === 'POLL_UPDATE');

  const made = polls.create(auth, channelId, {
    question: 'Best snack?',
    options: [{ text: 'Chips', emoji: '🥔' }, { text: 'Fruit' }, { text: 'Cake' }],
    allowMultiple: false,
    durationHours: 2,
  });
  await sleep(50);
  const pollMirror = transport.state.pollMirrors.at(-1);
  check(
    'a poll made in Harmony is posted to Discord as a native poll',
    pollMirror?.question === 'Best snack?' &&
      pollMirror.answers.map((a) => a.text).join() === 'Chips,Fruit,Cake' &&
      pollMirror.answers[0].emoji === '🥔' &&
      pollMirror.answers[1].emoji === null &&
      pollMirror.allowMultiple === false &&
      pollMirror.durationHours === 2 &&
      pollMirror.discordChannelId === '111',
    JSON.stringify(pollMirror),
  );
  check('the post says whose question it is, and pings nobody', pollMirror?.content === 'alice asked in Harmony:');
  check(
    'it is not also sent as a text message',
    !transport.state.mirrors.some((m) => m.content === 'Best snack?'),
  );
  const pollDiscordId = findBridgeMessageByHarmonyId(db.sqlite, made.id)?.discord_message_id;
  check('the Discord copy is recorded as this message\'s mirror', pollDiscordId === 'discord-poll-1');
  check('and is never mistaken for something said on Discord', hasSeenBridgeMessage(db.sqlite, pollDiscordId));
  const optionIds = made.poll.options.map((o) => o.id);

  // A Harmony vote is local: Discord's API gives a bot no way to cast one.
  const mirrorsBefore = transport.state.pollMirrors.length;
  polls.vote(bobAuth, made.id, { optionIds: [optionIds[2]] });
  await sleep(50);
  check(
    'a vote made in Harmony sends nothing to Discord',
    transport.state.pollMirrors.length === mirrorsBefore && transport.state.pollEnds.length === 0,
  );
  check('and counts here', pollsOf(made.id)?.options[2].count === 1);

  // Discord voters are counted under stand-in accounts, live.
  const discordVote = (answerId, extra = {}) => ({
    messageId: pollDiscordId,
    channelId: '111',
    answerId,
    userId: '5001',
    userName: 'Discord Dee',
    ...extra,
  });
  transport.emitPollVote(discordVote(1));
  await sleep(50);
  const afterDiscordVote = pollsOf(made.id);
  const deeId = findUserByDiscordId(db.sqlite, '5001')?.id;
  check(
    'a vote on Discord is counted here under a stand-in account',
    afterDiscordVote?.options[0].count === 1 && afterDiscordVote.totalVoters === 2 && findUserById(db.sqlite, deeId)?.account_type === 'ghost',
    JSON.stringify(afterDiscordVote),
  );
  check(
    'and clients are told with the voter attached',
    pollEvents().at(-1)?.payload?.actorId === deeId && pollEvents().at(-1)?.payload?.totalVoters === 2,
  );
  transport.emitPollVote(discordVote(2));
  await sleep(50);
  check(
    'changing a vote on Discord moves it (single answer)',
    pollsOf(made.id)?.options.map((o) => o.count).join() === '0,1,1',
  );
  transport.emitPollVote(discordVote(2), false);
  await sleep(50);
  check('taking a vote back on Discord removes it', pollsOf(made.id)?.options.map((o) => o.count).join() === '0,0,1');
  check(
    'votes from Discord are never sent back to Discord',
    transport.state.pollMirrors.length === mirrorsBefore && transport.state.pollEnds.length === 0,
  );
  const voterNames = polls.voters(auth, made.id, optionIds[2]).voters.map((v) => v.user.username);
  check('the voter list shows the Harmony voter by name', voterNames.join() === 'bob', voterNames.join());

  // A person linked to a Discord account is one voter however they vote.
  setUserDiscordId(db.sqlite, bobId, '4242');
  const bobDiscord = (answerId) => discordVote(answerId, { userId: '4242', userName: 'Bobby on Discord' });
  transport.emitPollVote(bobDiscord(3));
  await sleep(50);
  check(
    'a linked member voting on Discord for what they chose here is not counted twice',
    pollsOf(made.id)?.options[2].count === 1 && pollsOf(made.id)?.totalVoters === 1,
    JSON.stringify(pollsOf(made.id)),
  );
  check(
    'and no stand-in is invented for them',
    findUserByDiscordId(db.sqlite, '4242')?.id === bobId,
  );
  transport.emitPollVote(bobDiscord(1));
  await sleep(50);
  check(
    'a different choice from the same person on the other side replaces the first',
    pollsOf(made.id)?.options.map((o) => o.count).join() === '1,0,0' && pollsOf(made.id)?.totalVoters === 1,
    JSON.stringify(pollsOf(made.id)),
  );
  transport.emitPollVote(bobDiscord(1), false);
  await sleep(50);
  check('and withdrawing on Discord withdraws the member\'s vote', pollsOf(made.id)?.totalVoters === 0);

  // A vote for an answer nobody knows, or a message that was never bridged.
  transport.emitPollVote(discordVote(9));
  transport.emitPollVote(discordVote(1, { messageId: 'never-bridged' }));
  await sleep(50);
  check('votes for an unknown answer or message are ignored', pollsOf(made.id)?.totalVoters === 0);

  // Ending a poll here ends it on Discord, once.
  polls.end(auth, made.id);
  await sleep(50);
  check(
    'ending a poll here ends the Discord poll',
    transport.state.pollEnds.length === 1 &&
      transport.state.pollEnds[0].channelId === '111' &&
      transport.state.pollEnds[0].discordMessageId === pollDiscordId,
  );
  transport.emitPollEnd({ messageId: pollDiscordId, channelId: '111' });
  await sleep(50);
  check('Discord reporting it closed does not end it again', transport.state.pollEnds.length === 1);
  transport.emitPollVote(discordVote(1));
  await sleep(50);
  check('a vote arriving after the poll closed is ignored', pollsOf(made.id)?.totalVoters === 0);

  // Discord closing a poll made here (its own clock) does not decide it here.
  const endless = polls.create(auth, channelId, {
    question: 'No end?',
    options: [{ text: 'a' }, { text: 'b' }],
    allowMultiple: true,
    durationHours: null,
  });
  await sleep(50);
  check('a poll with no expiry gets Discord\'s longest duration', transport.state.pollMirrors.at(-1)?.durationHours === 768);
  check('and keeps its multiple answers', transport.state.pollMirrors.at(-1)?.allowMultiple === true);
  const endlessDiscordId = findBridgeMessageByHarmonyId(db.sqlite, endless.id)?.discord_message_id;
  transport.emitPollEnd({ messageId: endlessDiscordId, channelId: '111' });
  await sleep(50);
  check('Discord\'s clock does not close a poll made here', pollsOf(endless.id)?.closedAt === null);

  // Deleting the message removes the Discord poll through the bot.
  const deletesBefore = transport.state.deletes.length + transport.state.botDeletes.length;
  messages.remove(auth, endless.id);
  await sleep(50);
  check(
    'deleting a poll here deletes the Discord message',
    transport.state.deletes.length + transport.state.botDeletes.length === deletesBefore + 1,
  );

  // A poll made on Discord arrives as a poll message, voters and all.
  transport.state.pollVoters['dp1:1'] = [{ id: '5001', name: 'Discord Dee' }, { id: '5002', name: 'Discord Eli' }];
  transport.state.pollVoters['dp1:2'] = [{ id: '4242', name: 'Bobby on Discord' }];
  const mirrorsAtDiscordPoll = transport.state.mirrors.length;
  const pollEventsBeforeImport = pollEvents().length;
  transport.emit(
    fromDiscord({
      id: 'dp1',
      content: '',
      authorId: '5003',
      authorName: 'Discord Fay',
      poll: {
        question: 'Movie night?',
        answers: [
          { id: 1, text: 'Friday', emoji: '🎬' },
          { id: 2, text: 'Saturday', emoji: null },
        ],
        allowMultiple: true,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        finalized: false,
      },
    }),
  );
  await sleep(100);
  const arrived = recent().find((m) => m.poll?.question === 'Movie night?');
  check(
    'importing a Discord poll sends one update for all its voters, not one each',
    pollEvents().length - pollEventsBeforeImport === 1,
    `got ${pollEvents().length - pollEventsBeforeImport}`,
  );
  check(
    'a poll made on Discord arrives as a poll message with its options',
    arrived?.content === 'Movie night?' &&
      arrived.poll.options.map((o) => o.text).join() === 'Friday,Saturday' &&
      arrived.poll.options[0].emoji === '🎬' &&
      arrived.poll.allowMultiple === true &&
      arrived.poll.source === 'discord' &&
      arrived.author?.accountType === 'ghost',
    JSON.stringify(arrived),
  );
  check(
    'its existing votes are read from Discord and counted, a linked member as themselves',
    arrived?.poll.options.map((o) => o.count).join() === '2,1' && arrived.poll.totalVoters === 3,
    JSON.stringify(arrived?.poll),
  );
  check('it is not mirrored back to Discord', transport.state.mirrors.length === mirrorsAtDiscordPoll && transport.state.pollMirrors.length === 2);
  check(
    'it is announced to clients like any new message',
    broadcasts.some((entry) => entry.event === 'MESSAGE_CREATE' && entry.payload?.id === arrived?.id && entry.payload?.poll),
  );
  transport.emitPollVote({ messageId: 'dp1', channelId: '111', answerId: 2, userId: '5001', userName: 'Discord Dee' });
  await sleep(50);
  check(
    'later votes on it arrive live; a multiple-answer poll keeps both of Dee\'s',
    pollsOf(arrived.id)?.options.map((o) => o.count).join() === '2,2' && pollsOf(arrived.id)?.totalVoters === 3,
    JSON.stringify(pollsOf(arrived.id)),
  );
  // A vote made in Harmony counts here but Discord never hears of it.
  polls.vote(auth, arrived.id, { optionIds: [arrived.poll.options[1].id] });
  check('members here can vote on it too', pollsOf(arrived.id)?.totalVoters === 4);
  let externalError = null;
  try {
    polls.end(modAuth, arrived.id);
  } catch (error) {
    externalError = error;
  }
  check('but ending it is Discord\'s to do', externalError?.code === 'poll_external', String(externalError?.code));
  check('and a bridged edit cannot rewrite its question', messages.editBridged(arrived.id, 'something else') === null);
  transport.emitPollEnd({ messageId: 'dp1', channelId: '111' });
  await sleep(50);
  check('Discord closing it closes it here', typeof pollsOf(arrived.id)?.closedAt === 'string');
  check(
    'the close is announced',
    pollEvents().some((entry) => entry.payload?.messageId === arrived.id && entry.payload?.closedAt),
  );
  check('and the close is not sent back to Discord', transport.state.pollEnds.length === 1);
  transport.emitPollEnd({ messageId: 'dp1', channelId: '111' });
  await sleep(20);
  check('a repeated close report is harmless', typeof pollsOf(arrived.id)?.closedAt === 'string');

  // A poll Discord already finalized arrives closed, with who voted, and a
  // history import of it stays silent.
  transport.state.pollVoters['dp2:1'] = [{ id: '5002', name: 'Discord Eli' }];
  const broadcastsBeforeImport = broadcasts.length;
  transport.state.recentMessages = [
    fromDiscord({
      id: 'dp2',
      content: '',
      authorId: '5003',
      authorName: 'Discord Fay',
      createdAt: '2025-01-01T00:00:00.000Z',
      poll: {
        question: 'Old poll',
        answers: [{ id: 1, text: 'Yes', emoji: null }, { id: 2, text: 'No', emoji: null }],
        allowMultiple: false,
        expiresAt: '2025-01-02T00:00:00.000Z',
        finalized: true,
      },
    }),
  ];
  await bridge.importChannel(channelId);
  const imported = recent().find((m) => m.poll?.question === 'Old poll');
  check(
    'an imported finished poll keeps its voters and is closed',
    imported?.poll.closedAt !== null && imported?.poll.options[0].count === 1 && imported.poll.totalVoters === 1,
    JSON.stringify(imported?.poll),
  );
  check(
    'importing it is not a live message',
    !broadcasts.slice(broadcastsBeforeImport).some((entry) => entry.event === 'MESSAGE_CREATE' && entry.payload?.id === imported?.id),
  );
  transport.state.recentMessages = [];
  await bridge.importChannel(channelId);
  check('importing again does not duplicate it', recent().filter((m) => m.poll?.question === 'Old poll').length === 1);

  // A Discord message that is only a poll with no usable answers is dropped.
  transport.emit(fromDiscord({ id: 'dp3', content: '', poll: { question: 'x', answers: [{ id: 1, text: 'only', emoji: null }], allowMultiple: false, expiresAt: null, finalized: false } }));
  await sleep(50);
  check('a poll with fewer than two answers is not imported', !recent().some((m) => m.poll?.question === 'x'));

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
