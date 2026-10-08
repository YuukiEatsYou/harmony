// End-to-end smoke test for the auth, channel and messaging layers.
//
// Boots a throwaway server (temp data dir, invite-gated) and exercises the real
// HTTP + WebSocket surface: registration, invites, permissions, login/logout,
// cookies, bearer tokens, gateway IDENTIFY, channel listing, message history
// and realtime fan-out.
//
// Run with: npm run smoke --workspace @harmony/server
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import sharp from 'sharp';
import { Permission, HARMONY_VERSION, listEmbeddableUrls, unwrapSuppressedLinks, deriveTheme, relativeLuminance, DEFAULT_ACCENT, DEFAULT_BACKGROUND } from '@harmony/shared';
import { isPrivateAddress, parseEmbedMetadata } from '../src/embeds/metadata.ts';
import { isDiscordAttachment, isGifPage, isGiphyPage, tweetStatusId, youtubeVideoId } from '../src/embeds/providers.ts';
import { isKlipyAddress, klipySearchUrl, normalizeKlipySearch } from '../src/gifs/klipy.ts';
import { createServerGifService } from '../src/gifs/server-gifs.ts';
import { parseMessageEmbed } from '../src/db/messages.ts';
import { Database } from '../src/db/index.ts';
import { insertGhostUser, insertUser, mergeUsers } from '../src/db/users.ts';
import { insertInvite } from '../src/db/invites.ts';
import { insertBan } from '../src/db/bans.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createDiscordOAuthService } from '../src/auth/discord-oauth.ts';
import { insertChannel } from '../src/db/channels.ts';
import { insertMessage } from '../src/db/messages.ts';
import { listLinkedAttachments } from '../src/db/attachments.ts';
import { createEmbedService } from '../src/embeds/service.ts';
import { createGifService } from '../src/gifs/service.ts';
import { createGifSourceService } from '../src/gifs/sources.ts';
import { normalizeGifSourceUrl } from '../src/gifs/source-url.ts';
import { fetchPublicImage } from '../src/embeds/media.ts';
import { createPruner } from '../src/retention/pruner.ts';
import { createBlobStore } from '../src/storage/blobs.ts';
import { migrations } from '../src/db/migrations.ts';
import { upsertGifFavorite } from '../src/db/gif_favorites.ts';
import { verifyLinkedGif } from '../src/embeds/linked-gif.ts';
import { createAttachmentService } from '../src/attachments/service.ts';
import { createSettingsService } from '../src/settings/service.ts';
import { createUpdateService } from '../src/update/service.ts';
import { createUpdateApplier, listUpdateSnapshots, pruneUpdateSnapshots } from '../src/update/apply.ts';
import { createUserService } from '../src/users/service.ts';
import { sanitizeDetail, sanitizeLogText } from '../src/log/sanitize.ts';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8791;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/api/v1`;
const HEARTBEAT_MS = 1000;
const dataDir = mkdtempSync(join(tmpdir(), 'harmony-smoke-'));

// A stand-in for the built client, so the static serving and SPA fallback can be
// exercised without depending on whether anyone ran `npm run build:web` first.
const webDir = mkdtempSync(join(tmpdir(), 'harmony-web-'));
writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Harmony test shell</title><div id="app"></div>');
// A stand-in default icon, so the on-demand icon rendering has a source even
// without a real client build. Deliberately a picture rather than a flat color:
// it is fully opaque, and it reaches every edge, which is what the checks further
// down use to tell a full bleed from a padded tile.
const standInBlue = [20, 120, 200];
writeFileSync(
  join(webDir, 'icon.png'),
  await sharp({ create: { width: 96, height: 96, channels: 3, background: { r: 20, g: 120, b: 200 } } })
    .composite([
      {
        input: await sharp({ create: { width: 96, height: 48, channels: 3, background: { r: 240, g: 200, b: 40 } } })
          .png()
          .toBuffer(),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer(),
);

const server = spawn('node', ['src/index.ts'], {
  cwd: serverDir,
  env: {
    ...process.env,
    HARMONY_PORT: String(PORT),
    HARMONY_DATA_DIR: dataDir,
    HARMONY_WEB_DIR: webDir,
    HARMONY_REQUIRE_INVITE: 'true',
    HARMONY_LOG_LEVEL: 'error',
    // Short enough that a socket going silent is closed within a few seconds,
    // long enough that the heartbeating helper below never misses one.
    HARMONY_GATEWAY_HEARTBEAT_MS: String(HEARTBEAT_MS),
    // Scheduled messages: check the clock often and accept a short lead, so a
    // send can be watched in seconds.
    HARMONY_SCHEDULED_TICK_MS: '250',
    HARMONY_SCHEDULED_MIN_LEAD_MS: '1500',
    // Lets the poll sweep notice an expired poll within a moment.
    HARMONY_POLL_SWEEP_MS: '300',
    // Server events: sweep often, remind 4s before the start, and end an event with no end time after 2s.
    HARMONY_EVENT_SWEEP_MS: '250',
    HARMONY_EVENT_REMINDER_LEAD_MS: '4000',
    HARMONY_EVENT_DEFAULT_DURATION_MS: '2000',
    // The apply button is on, with a command that runs briefly then fails. A command
    // that exited 0 would restart this server; this one lets the route, the snapshot
    // and the failure handling be exercised without tearing the smoke down.
    HARMONY_UPDATE_COMMAND: 'sleep 2; false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (data) => process.stderr.write(`[server] ${data}`));

let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

/** A minimal well-formed MP4 header: a size word, then the required ftyp box. */
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from('isomiso2'),
  Buffer.alloc(64),
]);

async function req(path, { method = 'GET', body, cookie, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const setCookie = res.headers.getSetCookie?.()[0] ?? null;

  return {
    status: res.status,
    json: text ? JSON.parse(text) : null,
    cookie: setCookie ? setCookie.split(';')[0] : null,
  };
}

/**
 * Opens a gateway connection, identifies, and returns the events it receives.
 * It heartbeats on the server's schedule like a real client, since the server
 * closes a connection that goes quiet.
 */
function openGateway(auth = {}) {
  return new Promise((resolveGateway, reject) => {
    const options = auth.cookie ? { headers: { cookie: auth.cookie } } : {};
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`, options);
    const events = [];
    const timer = setTimeout(() => reject(new Error('gateway ready timeout')), 5000);
    let heartbeat = null;
    ws.on('close', () => clearInterval(heartbeat));

    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.op === 10) {
        ws.send(JSON.stringify({ op: 2, d: auth.token ? { token: auth.token } : {} }));
        heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: null }));
        }, frame.d.heartbeat_interval);
        return;
      }
      if (frame.op === 11) return;
      if (frame.t === 'READY') {
        clearTimeout(timer);
        resolveGateway({ ws, events, ready: frame.d });
        return;
      }
      if (frame.t) events.push(frame);
    });
    ws.on('error', reject);
  });
}

function gatewayIdentify(token) {
  return new Promise((resolveIdentify, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`);
    const result = { ready: null, closeCode: null };
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('gateway timeout'));
    }, 5000);

    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.op === 10) ws.send(JSON.stringify({ op: 2, d: { token } }));
      if (frame.t === 'READY') {
        result.ready = frame.d;
        ws.close();
      }
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      result.closeCode = code;
      resolveIdentify(result);
    });
    ws.on('error', reject);
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('server did not start in time');
}

try {
  await waitForServer();

  // --- The built client, served from this process ---
  const shell = await fetch(`${ORIGIN}/`);
  const shellBody = await shell.text();
  check(
    'the app shell is served at the root',
    shell.status === 200 && shellBody.includes('Harmony test shell'),
    `${shell.status} ${shellBody.slice(0, 120)}`,
  );
  const deepLink = await fetch(`${ORIGIN}/channels/123`);
  check(
    'a client-side route falls back to the app shell',
    deepLink.status === 200 && (await deepLink.text()).includes('Harmony test shell'),
  );
  check('a missing asset is a real 404', (await fetch(`${ORIGIN}/assets/missing.js`)).status === 404);
  const missingApi = await fetch(`${ORIGIN}/api/v1/not-a-route`);
  check(
    'an unknown API route is still a JSON 404',
    missingApi.status === 404 && (missingApi.headers.get('content-type') ?? '').includes('application/json'),
  );

  // --- Hardening headers ---
  const hardened = (await fetch(`${BASE}/health`)).headers;
  check('responses are nosniff', hardened.get('x-content-type-options') === 'nosniff');
  check('responses refuse framing', hardened.get('x-frame-options') === 'DENY');
  check('responses hide the referrer', hardened.get('referrer-policy') === 'no-referrer');
  check(
    'a content security policy is sent',
    (hardened.get('content-security-policy') ?? '').includes("default-src 'self'"),
  );
  check('HSTS is withheld over plain HTTP', hardened.get('strict-transport-security') === null);

  // --- Auth ---
  const owner = await req('/auth/register', {
    method: 'POST',
    body: { username: 'alice', password: 'correct horse' },
  });
  check('first user registers', owner.status === 200, `status ${owner.status}`);
  check('first user is owner', owner.json?.user?.isOwner === true);
  check('register sets a session cookie', owner.cookie?.startsWith('harmony_session=') === true);

  const ownerToken = owner.json?.token;
  const me = await req('/auth/me', { cookie: owner.cookie });
  check('cookie authenticates /auth/me', me.status === 200 && me.json?.user?.username === 'alice');
  check('bearer token authenticates /auth/me', (await req('/auth/me', { token: ownerToken })).status === 200);
  check('a real member carries no Discord id', me.json?.user?.discordId === null);
  check('owner has Administrator', (BigInt(me.json?.permissions ?? '0') & (1n << 14n)) !== 0n);

  const dup = await req('/auth/register', { method: 'POST', body: { username: 'alice', password: 'another one' } });
  check('duplicate username rejected (409)', dup.status === 409, `status ${dup.status}`);

  const invite = await req('/invites', { method: 'POST', token: ownerToken, body: {} });
  check('owner creates an invite', invite.status === 200 && typeof invite.json?.code === 'string');

  const noInvite = await req('/auth/register', { method: 'POST', body: { username: 'bob', password: 'hunter2hunter2' } });
  check('registration without invite rejected (403)', noInvite.status === 403, `status ${noInvite.status}`);

  const badInvite = await req('/auth/register', {
    method: 'POST',
    body: { username: 'bob', password: 'hunter2hunter2', inviteCode: 'nope' },
  });
  check('registration with invalid invite rejected (403)', badInvite.status === 403, `status ${badInvite.status}`);

  const bob = await req('/auth/register', {
    method: 'POST',
    body: { username: 'bob', password: 'hunter2hunter2', inviteCode: invite.json?.code },
  });
  check('registration with valid invite succeeds', bob.status === 200, `status ${bob.status}`);
  check('second user is not owner', bob.json?.user?.isOwner === false);

  const bobToken = bob.json?.token;
  const bobMe = await req('/auth/me', { token: bobToken });
  check('member lacks Administrator', (BigInt(bobMe.json?.permissions ?? '0') & (1n << 14n)) === 0n);
  check('member cannot list invites (403)', (await req('/invites', { token: bobToken })).status === 403);

  const wrongPassword = await req('/auth/login', { method: 'POST', body: { username: 'alice', password: 'wrong' } });
  check('wrong password rejected (401)', wrongPassword.status === 401, `status ${wrongPassword.status}`);

  const login = await req('/auth/login', { method: 'POST', body: { username: 'alice', password: 'correct horse' } });
  check('correct password logs in', login.status === 200 && typeof login.json?.token === 'string');

  const gatewayOk = await gatewayIdentify(login.json?.token);
  check('gateway IDENTIFY with valid token yields READY', gatewayOk.ready?.user?.username === 'alice');

  const gatewayBad = await gatewayIdentify('not-a-real-token');
  check('gateway IDENTIFY with bad token closes 4004', gatewayBad.closeCode === 4004, `code ${gatewayBad.closeCode}`);

  // --- Channels, categories and messages ---
  const channelList = await req('/channels', { token: ownerToken });
  const general = channelList.json?.channels?.find((channel) => channel.name === 'general');
  check('channel list loads', channelList.status === 200, `status ${channelList.status}`);
  check(
    'seeded category "Text Channels" exists',
    channelList.json?.categories?.some((category) => category.name === 'Text Channels') === true,
  );
  check('seeded channel "general" exists', Boolean(general));

  if (general) {
    const emptyHistory = await req(`/channels/${general.id}/messages`, { token: ownerToken });
    check('message history starts empty', emptyHistory.json?.messages?.length === 0);

    const cookieGateway = await openGateway({ cookie: owner.cookie });
    check('gateway identifies via session cookie', cookieGateway.ready?.user?.username === 'alice');
    cookieGateway.ws.close();

    const posted = await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'hello world' },
    });
    check('message is created', posted.status === 200 && posted.json?.content === 'hello world');
    const messageId = posted.json?.id;

    const history = await req(`/channels/${general.id}/messages`, { token: ownerToken });
    check('message appears in history', history.json?.messages?.some((m) => m.id === messageId) === true);

    const fanout = await openGateway({ token: ownerToken });
    await req(`/channels/${general.id}/messages`, { method: 'POST', token: ownerToken, body: { content: 'broadcast me' } });
    await sleep(250);
    check(
      'gateway broadcasts MESSAGE_CREATE',
      fanout.events.some((event) => event.t === 'MESSAGE_CREATE' && event.d?.content === 'broadcast me'),
    );
    fanout.ws.close();

    // --- Unread channels ---
    // Read state is per member, and the server is what keeps it so it survives a
    // reload and follows somebody between devices.
    const unreadFor = async (token) => (await req('/channels', { token })).json?.unreadChannelIds ?? [];
    check(
      'a channel with messages is unread for somebody who never read it',
      (await unreadFor(bobToken)).includes(general.id),
    );
    check(
      'but not for whoever posted in it',
      (await unreadFor(ownerToken)).includes(general.id) === false,
    );
    check(
      'marking a channel read is accepted',
      (await req(`/channels/${general.id}/read`, { method: 'POST', token: bobToken })).status === 204,
    );
    check('and then it is read for that member', (await unreadFor(bobToken)).includes(general.id) === false);

    // A channel nobody has said anything in has nothing to be unread about.
    const quiet = await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'quiet' } });
    check(
      'a channel with no messages is not unread',
      (await unreadFor(bobToken)).includes(quiet.json.id) === false,
    );
    await req(`/channels/${quiet.json.id}`, { method: 'DELETE', token: ownerToken });

    await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'something new' },
    });
    check('a new message makes it unread again', (await unreadFor(bobToken)).includes(general.id));
    await req(`/channels/${general.id}/read`, { method: 'POST', token: bobToken });
    check('reading again clears it', (await unreadFor(bobToken)).includes(general.id) === false);
    check(
      'a read marker cannot be sent for a channel that does not exist (404)',
      (await req('/channels/does-not-exist/read', { method: 'POST', token: bobToken })).status === 404,
    );

    // --- Replies ---
    const parent = await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'parent message' },
    });
    const reply = await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'a reply', replyToId: parent.json?.id },
    });
    check('a reply records its parent', reply.json?.replyTo?.id === parent.json?.id);
    check('the reply preview carries the parent text', reply.json?.replyTo?.content === 'parent message');
    check(
      'replying to a missing message is rejected (400)',
      (
        await req(`/channels/${general.id}/messages`, {
          method: 'POST',
          token: ownerToken,
          body: { content: 'x', replyToId: 'does-not-exist' },
        })
      ).status === 400,
    );

    // --- Reactions ---
    const reactTarget = await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'react target' },
    });
    const reacted = await req(`/messages/${reactTarget.json?.id}/reactions`, {
      method: 'POST',
      token: ownerToken,
      body: { emoji: '👍' },
    });
    check(
      'a reaction is added',
      reacted.json?.reactions?.some((r) => r.emoji === '👍' && r.count === 1 && r.me === true) === true,
    );
    const unreacted = await req(`/messages/${reactTarget.json?.id}/reactions`, {
      method: 'POST',
      token: ownerToken,
      body: { emoji: '👍' },
    });
    check('reacting again toggles the reaction off', unreacted.json?.reactions?.length === 0);

    await req(`/messages/${reactTarget.json?.id}/reactions`, {
      method: 'POST',
      token: bobToken,
      body: { emoji: '🎉' },
    });
    const seenByOwner = await req(`/channels/${general.id}/messages`, { token: ownerToken });
    const seenMessage = seenByOwner.json?.messages?.find((m) => m.id === reactTarget.json?.id);
    check(
      "another user's reaction is visible but not 'me'",
      seenMessage?.reactions?.some((r) => r.emoji === '🎉' && r.me === false) === true,
    );
    check(
      'member cannot clear reactions (403)',
      (await req(`/messages/${reactTarget.json?.id}/reactions?emoji=${encodeURIComponent('🎉')}`, {
        method: 'DELETE',
        token: bobToken,
      })).status === 403,
    );
    check(
      'owner can clear reactions',
      (await req(`/messages/${reactTarget.json?.id}/reactions?emoji=${encodeURIComponent('🎉')}`, {
        method: 'DELETE',
        token: ownerToken,
      })).json?.reactions?.length === 0,
    );

    // --- Pagination ---
    await req(`/channels/${general.id}/messages`, { method: 'POST', token: ownerToken, body: { content: 'page one' } });
    await req(`/channels/${general.id}/messages`, { method: 'POST', token: ownerToken, body: { content: 'page two' } });
    await req(`/channels/${general.id}/messages`, { method: 'POST', token: ownerToken, body: { content: 'page three' } });

    const newestPage = await req(`/channels/${general.id}/messages?limit=2`, { token: ownerToken });
    const boundary = newestPage.json?.messages?.[0];
    check(
      'history pages from the newest message',
      newestPage.json?.messages?.length === 2 && newestPage.json?.messages?.at(-1)?.content === 'page three',
    );
    const olderPage = await req(
      `/channels/${general.id}/messages?limit=2&before=${encodeURIComponent(boundary?.createdAt)}&beforeId=${boundary?.id}`,
      { token: ownerToken },
    );
    check(
      'the cursor returns the messages before it',
      olderPage.json?.messages?.some((message) => message.content === 'page one') === true,
    );
    check(
      'the cursor does not repeat its own message',
      olderPage.json?.messages?.every((message) => message.id !== boundary?.id) === true,
    );

    // Admins may delete another user's message, but like Discord, never edit it.
    const bobMessage = await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: bobToken,
      body: { content: 'bob says hi' },
    });
    check(
      "even an admin cannot edit another user's message (403)",
      (await req(`/messages/${bobMessage.json?.id}`, {
        method: 'PATCH',
        token: ownerToken,
        body: { content: 'rewritten' },
      })).status === 403,
    );
    check(
      "an admin can delete another user's message",
      (await req(`/messages/${bobMessage.json?.id}`, { method: 'DELETE', token: ownerToken })).status === 204,
    );

    const edited = await req(`/messages/${messageId}`, {
      method: 'PATCH',
      token: ownerToken,
      body: { content: 'edited' },
    });
    check('author can edit their message', edited.json?.content === 'edited' && edited.json?.editedAt != null);
    check(
      "member cannot edit another user's message (403)",
      (await req(`/messages/${messageId}`, { method: 'PATCH', token: bobToken, body: { content: 'nope' } })).status === 403,
    );
    check(
      'member cannot create channels (403)',
      (await req('/channels', { method: 'POST', token: bobToken, body: { name: 'secret' } })).status === 403,
    );

    check('author can delete their message', (await req(`/messages/${messageId}`, { method: 'DELETE', token: ownerToken })).status === 204);
    const afterDelete = await req(`/channels/${general.id}/messages`, { token: ownerToken });
    check('deleted message is gone from history', afterDelete.json?.messages?.some((m) => m.id === messageId) === false);

    // --- Images ---
    const png = await sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 30, g: 120, b: 200 } } })
      .png()
      .toBuffer();

    const uploadForm = new FormData();
    uploadForm.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
    const uploadRes = await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: uploadForm,
    });
    const uploaded = await uploadRes.json();
    check('image uploads', uploadRes.status === 200 && uploaded?.contentType === 'image/png', `status ${uploadRes.status}`);
    check('image dimensions are recorded', uploaded?.width === 12 && uploaded?.height === 8);
    const attachmentId = uploaded?.id;

    const withImage = await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'look at this', attachmentIds: [attachmentId] },
    });
    check('message carries its attachment', withImage.json?.attachments?.length === 1);

    const reuse = await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { attachmentIds: [attachmentId] },
    });
    check('an attachment cannot be reused (400)', reuse.status === 400, `status ${reuse.status}`);

    const served = await fetch(`${BASE}/attachments/${attachmentId}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const servedBytes = Buffer.from(await served.arrayBuffer());
    check(
      'uploaded image is served back byte-for-byte',
      served.status === 200 && served.headers.get('content-type') === 'image/png' && servedBytes.equals(png),
      `status ${served.status}`,
    );
    check('attachments require auth (401)', (await fetch(`${BASE}/attachments/${attachmentId}`)).status === 401);

    const badType = new FormData();
    badType.append('file', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'notes.txt');
    const badRes = await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: badType,
    });
    check('non-image upload rejected (415)', badRes.status === 415, `status ${badRes.status}`);

    const fakeImage = new FormData();
    fakeImage.append('file', new Blob([Buffer.from('definitely not a png')], { type: 'image/png' }), 'fake.png');
    const fakeRes = await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: fakeImage,
    });
    check('unreadable image rejected (415)', fakeRes.status === 415, `status ${fakeRes.status}`);

    // --- Videos ---
    const videoForm = new FormData();
    videoForm.append('file', new Blob([MP4], { type: 'video/mp4' }), 'clip.mp4');
    const videoRes = await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: videoForm,
    });
    const clip = await videoRes.json();
    check(
      'an mp4 uploads',
      videoRes.status === 200 && clip?.contentType === 'video/mp4',
      `status ${videoRes.status}`,
    );
    check('a clip records no dimensions', clip?.width === null && clip?.height === null);

    const ranged = await fetch(`${BASE}/attachments/${clip.id}`, {
      headers: { authorization: `Bearer ${ownerToken}`, range: 'bytes=0-3' },
    });
    const rangedBytes = Buffer.from(await ranged.arrayBuffer());
    check(
      'a range request returns just that slice',
      ranged.status === 206 &&
        ranged.headers.get('content-range') === `bytes 0-3/${MP4.length}` &&
        rangedBytes.equals(MP4.subarray(0, 4)),
      `status ${ranged.status} ${ranged.headers.get('content-range')}`,
    );
    check('clips advertise range support', ranged.headers.get('accept-ranges') === 'bytes');

    const fakeVideo = new FormData();
    fakeVideo.append('file', new Blob([Buffer.from('definitely not an mp4')], { type: 'video/mp4' }), 'fake.mp4');
    const fakeVideoRes = await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: fakeVideo,
    });
    check('unreadable video rejected (415)', fakeVideoRes.status === 415, `status ${fakeVideoRes.status}`);

    await req('/settings', { method: 'PATCH', token: ownerToken, body: { maxVideoBytes: 1024 } });
    const bigClip = new FormData();
    bigClip.append('file', new Blob([Buffer.concat([MP4, Buffer.alloc(4096)])], { type: 'video/mp4' }), 'big.mp4');
    const bigClipRes = await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: bigClip,
    });
    check('an oversized clip is rejected (413)', bigClipRes.status === 413, `status ${bigClipRes.status}`);
    await req('/settings', { method: 'PATCH', token: ownerToken, body: { maxVideoBytes: 20 * 1024 * 1024 } });
  }

  // --- Admin: settings, roles, members, invites ---
  const metaRes = await req('/meta');
  check('public meta is available', metaRes.status === 200 && typeof metaRes.json?.name === 'string');
  check('meta reports requireInvite', metaRes.json?.requireInvite === true);
  check('meta reports the upload limits', metaRes.json?.maxImageBytes > 0 && metaRes.json?.maxVideoBytes > 0);
  check('meta lists mp4 as a video type', metaRes.json?.allowedVideoTypes?.includes('video/mp4') === true);

  const settings = await req('/settings', { token: ownerToken });
  check('owner reads settings', settings.status === 200 && settings.json?.serverName === 'Harmony');
  check('settings start with no default channel', settings.json?.defaultChannelId === null);
  check('link previews default to on', settings.json?.embedsEnabled === true);
  check('settings report the upload limits', settings.json?.maxImageBytes > 0 && settings.json?.maxVideoBytes > 0);
  check('a fresh instance has not been through setup', settings.json?.setupCompleted === false);
  check(
    'setup can be marked complete',
    (
      await req('/settings', { method: 'PATCH', token: ownerToken, body: { setupCompleted: true } })
    ).json?.setupCompleted === true,
  );

  const resized = await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { maxImageBytes: 3 * 1024 * 1024, maxVideoBytes: 25 * 1024 * 1024 },
  });
  check(
    'the upload limits can be changed',
    resized.json?.maxImageBytes === 3 * 1024 * 1024 && resized.json?.maxVideoBytes === 25 * 1024 * 1024,
  );
  check('meta follows the upload limits', (await req('/meta')).json?.maxVideoBytes === 25 * 1024 * 1024);
  await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { maxImageBytes: 10 * 1024 * 1024, maxVideoBytes: 20 * 1024 * 1024 },
  });

  check('the preview user agent starts unset', settings.json?.previewUserAgent === null);
  const uaSaved = await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { previewUserAgent: 'Harmony-test/1.0' },
  });
  check('the preview user agent can be set', uaSaved.json?.previewUserAgent === 'Harmony-test/1.0');
  check(
    'an empty preview user agent clears it',
    (await req('/settings', { method: 'PATCH', token: ownerToken, body: { previewUserAgent: '' } })).json
      ?.previewUserAgent === null,
  );

  const embedsOff = await req('/settings', { method: 'PATCH', token: ownerToken, body: { embedsEnabled: false } });
  check('link previews can be turned off', embedsOff.json?.embedsEnabled === false);
  await req('/settings', { method: 'PATCH', token: ownerToken, body: { embedsEnabled: true } });

  check('the instance starts on the built-in colors', settings.json?.theme?.background === null && settings.json?.theme?.accent === null);
  const themed = await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { theme: { background: '#101018', accent: '#ff8800' } },
  });
  check(
    'owner sets the instance colors',
    themed.json?.theme?.background === '#101018' && themed.json?.theme?.accent === '#ff8800',
  );
  check('public meta carries the colors', (await req('/meta')).json?.theme?.accent === '#ff8800');

  const badTheme = await req('/settings', { method: 'PATCH', token: ownerToken, body: { theme: { background: 'red' } } });
  check('a color that is not #rrggbb is rejected (400)', badTheme.status === 400, `status ${badTheme.status}`);
  await req('/settings', { method: 'PATCH', token: ownerToken, body: { theme: { background: null, accent: null } } });

  // The default channel lives in settings and is echoed with the channel list so
  // clients can open it on load.
  const setDefault = await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { defaultChannelId: general.id },
  });
  check('owner sets the default channel', setDefault.json?.defaultChannelId === general.id);
  check(
    'channel list reports the default channel',
    (await req('/channels', { token: ownerToken })).json?.defaultChannelId === general.id,
  );

  const badDefault = await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { defaultChannelId: 'no-such-channel' },
  });
  check('a default channel must exist (400)', badDefault.status === 400, `status ${badDefault.status}`);

  // Deleting the default channel clears the preference instead of leaving it dangling.
  const tempChannel = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'temp-default' },
  });
  await req('/settings', { method: 'PATCH', token: ownerToken, body: { defaultChannelId: tempChannel.json.id } });
  await req(`/channels/${tempChannel.json.id}`, { method: 'DELETE', token: ownerToken });
  check(
    'deleting the default channel clears the preference',
    (await req('/settings', { token: ownerToken })).json?.defaultChannelId === null,
  );

  // A category that still holds channels cannot be deleted, so nothing is orphaned.
  const busyCategory = await req('/categories', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'busy-category' },
  });
  const busyChannel = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'busy-channel', categoryId: busyCategory.json.id },
  });
  const refusedCategory = await req(`/categories/${busyCategory.json.id}`, {
    method: 'DELETE',
    token: ownerToken,
  });
  check(
    'a non-empty category cannot be deleted (409)',
    refusedCategory.status === 409 && refusedCategory.json?.error?.code === 'category_not_empty',
    `status ${refusedCategory.status}`,
  );

  // Emptying it out allows the delete.
  await req(`/channels/${busyChannel.json.id}`, { method: 'DELETE', token: ownerToken });
  const emptiedCategory = await req(`/categories/${busyCategory.json.id}`, {
    method: 'DELETE',
    token: ownerToken,
  });
  check('an empty category can be deleted', emptiedCategory.status === 204, `status ${emptiedCategory.status}`);

  // --- Reordering and recategorizing channels ---
  async function channelNamesIn(categoryId) {
    const res = await req('/channels', { token: ownerToken });
    return res.json.channels.filter((channel) => channel.categoryId === categoryId).map((channel) => channel.name);
  }

  const textCategory = (await req('/channels', { token: ownerToken })).json.categories.find(
    (category) => category.name === 'Text Channels',
  );
  const alpha = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'alpha', categoryId: textCategory.id },
  });
  const bravo = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'bravo', categoryId: textCategory.id },
  });

  const appended = await channelNamesIn(textCategory.id);
  check(
    'new channels append to the end of their category',
    appended.at(-2) === 'alpha' && appended.at(-1) === 'bravo',
    appended.join(', '),
  );

  await req(`/channels/${bravo.json.id}/move`, { method: 'POST', token: ownerToken, body: { direction: 'up' } });
  check(
    'moving a channel up swaps it with its neighbor',
    JSON.stringify((await channelNamesIn(textCategory.id)).slice(-2)) === JSON.stringify(['bravo', 'alpha']),
  );

  // The channel at the top of the category cannot move any higher.
  const topChannel = (await req('/channels', { token: ownerToken })).json.channels.filter(
    (channel) => channel.categoryId === textCategory.id,
  )[0];
  const noopBefore = await channelNamesIn(textCategory.id);
  await req(`/channels/${topChannel.id}/move`, { method: 'POST', token: ownerToken, body: { direction: 'up' } });
  check(
    'moving the first channel up does nothing',
    JSON.stringify(await channelNamesIn(textCategory.id)) === JSON.stringify(noopBefore),
  );

  // Recategorizing moves the channel, and it lands at the end of its new home.
  const miscCategory = await req('/categories', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Misc' },
  });
  await req(`/channels/${alpha.json.id}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { categoryId: miscCategory.json.id },
  });
  check(
    'recategorizing moves the channel into the target category',
    JSON.stringify(await channelNamesIn(miscCategory.json.id)) === JSON.stringify(['alpha']),
  );
  check(
    'recategorizing removes the channel from its old category',
    !(await channelNamesIn(textCategory.id)).includes('alpha'),
  );

  // Category reordering swaps with the neighbor, and is a no-op at the top.
  const catsBefore = (await req('/channels', { token: ownerToken })).json.categories.map((topic) => topic.name);
  await req(`/categories/${miscCategory.json.id}/move`, { method: 'POST', token: ownerToken, body: { direction: 'up' } });
  const catsAfter = (await req('/channels', { token: ownerToken })).json.categories.map((topic) => topic.name);
  check(
    'moving a category up reorders the sidebar',
    catsAfter.indexOf('Misc') === catsBefore.indexOf('Misc') - 1,
    catsAfter.join(', '),
  );

  const topCategory = (await req('/channels', { token: ownerToken })).json.categories[0];
  await req(`/categories/${topCategory.id}/move`, { method: 'POST', token: ownerToken, body: { direction: 'up' } });
  check(
    'moving the first category up does nothing',
    (await req('/channels', { token: ownerToken })).json.categories[0]?.id === topCategory.id,
  );

  // Clean up so later tests see the original channel tree.
  await req(`/channels/${alpha.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/channels/${bravo.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/categories/${miscCategory.json.id}`, { method: 'DELETE', token: ownerToken });

  // --- Voice channels ---
  // Audio never comes near the server: it is relayed by the SFU over UDP. These
  // cover only the room presence: joining, the roster broadcast, muting, the size
  // limit and leaving.
  const bobPerms = await req('/auth/me', { token: bobToken });
  check(
    'members may join voice by default',
    (BigInt(bobPerms.json?.permissions ?? '0') & (1n << 18n)) !== 0n,
  );

  const voiceChannel = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Lounge', type: 'voice' },
  });
  const voiceId = voiceChannel.json?.id;
  check(
    'a voice channel is created',
    voiceChannel.status === 200 && voiceChannel.json?.type === 'voice',
    `status ${voiceChannel.status}`,
  );
  check(
    'the channel list marks it as voice',
    (await req('/channels', { token: ownerToken })).json?.channels?.find((c) => c.id === voiceId)?.type === 'voice',
  );

  const voiceWatcher = await openGateway({ token: bobToken });
  const joined = await req(`/channels/${voiceId}/voice`, { method: 'POST', token: ownerToken });
  await sleep(250);
  check(
    'joining returns the room with the member in it',
    joined.status === 200 &&
      joined.json?.members?.length === 1 &&
      joined.json?.members?.[0]?.user?.id === owner.json?.user?.id,
    JSON.stringify(joined.json),
  );
  check(
    'a voice join is broadcast to the channel',
    voiceWatcher.events.some(
      (frame) => frame.t === 'VOICE_STATE_UPDATE' && frame.d?.channelId === voiceId && frame.d?.members?.length === 1,
    ),
  );
  check(
    'a freshly loaded client can fetch who is in voice',
    (await req('/voice', { token: bobToken })).json?.channels?.some(
      (entry) => entry.channelId === voiceId && entry.members?.length === 1,
    ) === true,
  );

  const muted = await req(`/channels/${voiceId}/voice`, {
    method: 'PATCH',
    token: ownerToken,
    body: { muted: true },
  });
  check('a member can mute themselves', muted.json?.members?.[0]?.muted === true);

  // The room limit is on by default at 10; set it to 1 so a second member is refused.
  await req('/settings', { method: 'PATCH', token: ownerToken, body: { maxVoiceMembers: 1 } });
  check(
    'a full voice channel refuses another member (409)',
    (await req(`/channels/${voiceId}/voice`, { method: 'POST', token: bobToken })).status === 409,
  );
  await req('/settings', { method: 'PATCH', token: ownerToken, body: { maxVoiceMembers: 10 } });

  check(
    'joining a text channel as voice is refused (400)',
    (await req(`/channels/${general.id}/voice`, { method: 'POST', token: ownerToken })).status === 400,
  );

  const left = await req(`/channels/${voiceId}/voice`, { method: 'DELETE', token: ownerToken });
  await sleep(250);
  check('a member can leave', left.status === 204, `status ${left.status}`);
  check(
    'the emptied room is broadcast',
    voiceWatcher.events.some(
      (frame) => frame.t === 'VOICE_STATE_UPDATE' && frame.d?.channelId === voiceId && frame.d?.members?.length === 0,
    ),
  );
  voiceWatcher.ws.close();

  // --- Typing indicators ---
  check('typing indicators default to on', owner.json?.user?.showTyping === true);
  const typingPing = await req(`/channels/${general.id}/typing`, { method: 'POST', token: ownerToken });
  check('the typing endpoint accepts a ping', typingPing.status === 204, `status ${typingPing.status}`);

  const typingWatcher = await openGateway({ token: bobToken });
  await req(`/channels/${general.id}/typing`, { method: 'POST', token: ownerToken });
  await sleep(250);
  const typingEvent = typingWatcher.events.find((frame) => frame.t === 'TYPING_START');
  check(
    'typing is broadcast with the user and channel',
    typingEvent?.d?.channelId === general.id && typingEvent?.d?.user?.id === owner.json?.user?.id,
  );

  const typingOff = await req('/users/@me', { method: 'PATCH', token: ownerToken, body: { showTyping: false } });
  check('typing can be turned off', typingOff.json?.user?.showTyping === false);

  typingWatcher.events.length = 0;
  await req(`/channels/${general.id}/typing`, { method: 'POST', token: ownerToken });
  await sleep(250);
  check(
    'a user with typing off broadcasts nothing',
    typingWatcher.events.every((frame) => frame.t !== 'TYPING_START'),
  );

  const typingBackOn = await req('/users/@me', { method: 'PATCH', token: ownerToken, body: { showTyping: true } });
  check('typing can be turned back on', typingBackOn.json?.user?.showTyping === true);
  typingWatcher.ws.close();

  // --- Notification sounds ---
  check(
    'notification sounds default to on',
    owner.json?.user?.notifyMajor === true && owner.json?.user?.notifyMinor === true,
  );

  const soundsOff = await req('/users/@me', {
    method: 'PATCH',
    token: ownerToken,
    body: { notifyMajor: false, notifyMinor: false },
  });
  check(
    'both notification sounds can be turned off',
    soundsOff.json?.user?.notifyMajor === false && soundsOff.json?.user?.notifyMinor === false,
  );
  check(
    'the choice is stored rather than just echoed back',
    (await req('/auth/me', { token: ownerToken })).json?.user?.notifyMinor === false,
  );

  const majorBackOn = await req('/users/@me', { method: 'PATCH', token: ownerToken, body: { notifyMajor: true } });
  check(
    'one sound can be turned back on without disturbing the other',
    majorBackOn.json?.user?.notifyMajor === true && majorBackOn.json?.user?.notifyMinor === false,
  );

  // Leave the account as it was found, for the checks that follow.
  await req('/users/@me', {
    method: 'PATCH',
    token: ownerToken,
    body: { notifyMajor: true, notifyMinor: true },
  });

  // --- Link previews ---
  check('embeddable urls are found', listEmbeddableUrls('see https://example.com/a').includes('https://example.com/a'));
  check('masked links are not unfurled', listEmbeddableUrls('[x](https://example.com/a)').length === 0);
  check('angle links are not unfurled', listEmbeddableUrls('<https://example.com/a>').length === 0);
  check('urls inside code are not unfurled', listEmbeddableUrls('`https://example.com/a`').length === 0);
  check(
    'trailing punctuation is trimmed from a link',
    listEmbeddableUrls('see https://example.com/a.').includes('https://example.com/a'),
  );
  check(
    'a suppressed link is unwrapped so it can unfurl',
    unwrapSuppressedLinks('look <https://example.com/a> now') === 'look https://example.com/a now',
  );
  check(
    'unwrapping leaves bare links alone',
    unwrapSuppressedLinks('look https://example.com/a now') === 'look https://example.com/a now',
  );
  check(
    'unwrapping skips code spans',
    unwrapSuppressedLinks('`<https://example.com/a>`') === '`<https://example.com/a>`',
  );
  check(
    'a masked link is not unwrapped',
    unwrapSuppressedLinks('[x](https://example.com/a)') === '[x](https://example.com/a)',
  );

  check('loopback is refused', isPrivateAddress('127.0.0.1') === true && isPrivateAddress('::1') === true);
  check(
    'private ranges are refused',
    isPrivateAddress('10.1.2.3') &&
      isPrivateAddress('192.168.1.1') &&
      isPrivateAddress('172.16.5.5') &&
      isPrivateAddress('169.254.1.1') &&
      isPrivateAddress('fd00::1'),
  );
  check('public addresses are allowed', isPrivateAddress('1.1.1.1') === false && isPrivateAddress('8.8.8.8') === false);

  const metadata = parseEmbedMetadata(
    '<html><head><title>Fallback</title>' +
      '<meta property="og:title" content="OG &amp; Title">' +
      '<meta name="description" content="A description"></head></html>',
    'https://example.com/post',
  );
  check('the open graph title wins over the title tag', metadata.title === 'OG & Title');
  check('the description is read', metadata.description === 'A description');
  check('the site name falls back to the host', metadata.siteName === 'example.com');
  check('a page without a preview image has none', metadata.imageUrl === null);

  const gifPage = parseEmbedMetadata(
    '<meta property="og:image" content="/img/cat.gif"><meta property="og:title" content="A gif">',
    'https://example.com/post',
  );
  check('an og:image is resolved against the page', gifPage.imageUrl === 'https://example.com/img/cat.gif');

  // Giphy and Klipy both list a still WebP first and the animated GIF second, so
  // taking the first one is exactly why those links preview as frozen pictures.
  const twoImages = parseEmbedMetadata(
    '<meta property="og:image" content="https://cdn.test/aa/1.webp">' +
      '<meta property="og:image:type" content="image/webp">' +
      '<meta property="og:image:width" content="480">' +
      '<meta property="og:image" content="https://cdn.test/aa/1.gif">' +
      '<meta property="og:image:type" content="image/gif">',
    'https://example.com/post',
  );
  check(
    'the animated image wins when a page offers both',
    twoImages.imageUrl === 'https://cdn.test/aa/1.gif',
    String(twoImages.imageUrl),
  );

  const gifLast = parseEmbedMetadata(
    '<meta property="og:image" content="https://cdn.test/aa/still.png">' +
      '<meta property="og:image" content="https://cdn.test/aa/loop.gif?cid=abc123">',
    'https://example.com/post',
  );
  check(
    'a gif is recognized from its address even with a query on the end',
    gifLast.imageUrl === 'https://cdn.test/aa/loop.gif?cid=abc123',
    String(gifLast.imageUrl),
  );

  const stillOnly = parseEmbedMetadata(
    '<meta property="og:image" content="https://cdn.test/aa/one.png">' +
      '<meta property="og:image" content="https://cdn.test/aa/two.jpg">',
    'https://example.com/post',
  );
  check('with no animated image the first is still used', stillOnly.imageUrl === 'https://cdn.test/aa/one.png');
  check(
    "a still that merely says gif is not taken as one",
    parseEmbedMetadata(
      '<meta property="og:image" content="https://cdn.test/aa/a.png">' +
        '<meta property="og:image:type" content="image/png">',
      'https://example.com/',
    ).imageUrl === 'https://cdn.test/aa/a.png',
  );
  check(
    'a twitter image is still a fallback',
    parseEmbedMetadata('<meta name="twitter:image" content="https://cdn.test/t.png">', 'https://example.com/')
      .imageUrl === 'https://cdn.test/t.png',
  );
  check(
    'a data: image is refused',
    parseEmbedMetadata('<meta property="og:image" content="data:image/gif;base64,R0lGOD">', 'https://example.com/')
      .imageUrl === null,
  );

  // Inline players are recognized from the link, never from og:video.
  check('a watch link yields its video id', youtubeVideoId(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ')) === 'dQw4w9WgXcQ');
  check('a short link yields its video id', youtubeVideoId(new URL('https://youtu.be/dQw4w9WgXcQ')) === 'dQw4w9WgXcQ');
  check('a shorts link yields its video id', youtubeVideoId(new URL('https://www.youtube.com/shorts/dQw4w9WgXcQ')) === 'dQw4w9WgXcQ');
  check('a channel link is not a video', youtubeVideoId(new URL('https://www.youtube.com/@someone')) === null);
  check(
    'a lookalike host is not youtube',
    youtubeVideoId(new URL('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ')) === null,
  );

  check('a status link yields its tweet id', tweetStatusId(new URL('https://x.com/jack/status/20')) === '20');
  check('an i/status link yields its tweet id', tweetStatusId(new URL('https://x.com/i/status/20')) === '20');
  check('a profile link is not a tweet', tweetStatusId(new URL('https://x.com/jack')) === null);
  check('a lookalike host is not x', tweetStatusId(new URL('https://x.com.evil.test/jack/status/20')) === null);

  // A Giphy page is rewritten to the file behind it through their keyless
  // endpoint, so only their page shapes are recognized. Their media addresses
  // are already a link straight at a picture and are left alone.
  check('a gifs page is recognized', isGiphyPage(new URL('https://giphy.com/gifs/cat-JIX9t2j0ZTN9S')));
  check('a www gifs page is recognized', isGiphyPage(new URL('https://www.giphy.com/gifs/cat-JIX9t2j0ZTN9S')));
  check('an embed page is recognized', isGiphyPage(new URL('https://giphy.com/embed/JIX9t2j0ZTN9S')));
  check('a plain media address is not a page', isGiphyPage(new URL('https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif')) === false);
  check('a channel page is not a gif', isGiphyPage(new URL('https://giphy.com/channel/kdy')) === false);
  check('a lookalike host is not giphy', isGiphyPage(new URL('https://giphy.com.evil.test/gifs/cat-JIX9t2j0ZTN9S')) === false);

  // A Tenor or Klipy page is read for the picture it names in its own metadata,
  // which is then kept like a file link. Their media hosts are not pages.
  check('a tenor view page is recognized', isGifPage(new URL('https://tenor.com/view/x-gif-123')));
  check('a www tenor view page is recognized', isGifPage(new URL('https://www.tenor.com/view/x-gif-123')));
  check('a tenor search page is not a gif page', isGifPage(new URL('https://tenor.com/search/happy')) === false);
  check('a tenor media address is not a page', isGifPage(new URL('https://media1.tenor.com/m/abc/x.gif')) === false);
  check('a klipy gifs page is recognized', isGifPage(new URL('https://klipy.com/gifs/name-id')));
  check('a klipy media address is not a page', isGifPage(new URL('https://static2.klipy.com/ii/x/00/6e/y.gif')) === false);
  check('a lookalike host is not a gif page', isGifPage(new URL('https://tenor.com.evil.test/view/x-gif-123')) === false);

  // A pasted Discord CDN attachment is signed and expires, so it is renewed through
  // Discord's refresh endpoint before it is fetched.
  check(
    'a discord attachment link is recognized',
    isDiscordAttachment(
      new URL('https://cdn.discordapp.com/attachments/1400576064547196989/1527627040914804798/x.gif?ex=1&is=2&hm=3'),
    ),
  );
  check(
    'the discord proxy host is recognized too',
    isDiscordAttachment(new URL('https://media.discordapp.net/attachments/1400576064547196989/1527627040914804798/x.gif')),
  );
  check('a discord emoji link is not an attachment', isDiscordAttachment(new URL('https://cdn.discordapp.com/emojis/123456789012345678.gif')) === false);
  check('a plain discord cdn link is not an attachment', isDiscordAttachment(new URL('https://cdn.discordapp.com/icons/123456789012345678/abc.png')) === false);
  check(
    'a lookalike host is not discord',
    isDiscordAttachment(new URL('https://cdn.discordapp.com.evil.test/attachments/1400576064547196989/1527627040914798/x.gif')) === false,
  );

  // The hosted gif service: its envelope is walked rather than assumed, and only
  // its own addresses are ever fetched.
  const klipyPayload = {
    result: true,
    data: {
      current_page: 1,
      has_next: false,
      data: [
        {
          id: 'a',
          title: 'A cat',
          file: {
            hd: { gif: { url: 'https://static.klipy.com/x/hd.gif', width: 480, height: 270 } },
            sm: { gif: { url: 'https://static.klipy.com/x/sm.gif', width: 220, height: 124 } },
          },
        },
        { id: 'b', title: 'No gif at all', file: { hd: { webp: { url: 'https://static.klipy.com/x/hd.webp' } } } },
      ],
    },
  };
  const klipyResults = normalizeKlipySearch(klipyPayload);
  check(
    'a hosted result is read out of its envelope',
    klipyResults.length === 1 && klipyResults[0]?.url === 'https://static.klipy.com/x/hd.gif',
    JSON.stringify(klipyResults),
  );
  check('a hosted result carries its size', klipyResults[0]?.width === 480 && klipyResults[0]?.height === 270);
  check(
    'and a smaller address for the grid',
    klipyResults[0]?.previewUrl === 'https://static.klipy.com/x/sm.gif',
    String(klipyResults[0]?.previewUrl),
  );
  check('a result with no gif is left out', normalizeKlipySearch(klipyPayload).length === 1);
  check('an unreadable payload yields nothing', normalizeKlipySearch({ nonsense: true }).length === 0);

  check('a hosted media address is recognized', isKlipyAddress(new URL('https://static.klipy.com/ii/x/y.gif')));
  check('a lookalike host is not the service', isKlipyAddress(new URL('https://klipy.com.evil.test/y.gif')) === false);
  check('and neither is an unrelated host', isKlipyAddress(new URL('https://example.com/y.gif')) === false);
  check(
    'no search term asks for trending',
    klipySearchUrl('KEY', { limit: 30 }).includes('/gifs/trending') &&
      klipySearchUrl('KEY', { limit: 30 }).includes('per_page=30'),
  );
  check(
    'a search term is passed through',
    klipySearchUrl('KEY', { q: 'cat', limit: 10 }).includes('/gifs/search') &&
      klipySearchUrl('KEY', { q: 'cat', limit: 10 }).includes('q=cat'),
  );

  const storedPlayer = parseMessageEmbed(
    JSON.stringify({ url: 'https://youtu.be/dQw4w9WgXcQ', player: { provider: 'youtube', id: 'dQw4w9WgXcQ' } }),
  );
  check('a stored player survives a round trip', storedPlayer?.player?.id === 'dQw4w9WgXcQ');
  check(
    'an unknown player provider is dropped',
    parseMessageEmbed(JSON.stringify({ url: 'https://x.test', player: { provider: 'evil', id: 'x' } }))?.player === null,
  );

  check('the preview media endpoint needs a url (400)', (await req('/embeds/media', { token: ownerToken })).status === 400);
  check(
    'the preview media endpoint refuses a private address (404)',
    (await req(`/embeds/media?url=${encodeURIComponent('http://127.0.0.1:9/x.png')}`, { token: ownerToken })).status === 404,
  );

  // A message linking to a private address must never be fetched.
  const privateLink = await req(`/channels/${general.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'http://127.0.0.1:9/secret' },
  });
  await sleep(300);
  const privateHistory = await req(`/channels/${general.id}/messages?limit=1`, { token: ownerToken });
  check(
    'a private address is never unfurled',
    privateHistory.json?.messages?.[0]?.id === privateLink.json?.id && privateHistory.json?.messages?.[0]?.embed === null,
  );

  // --- Removing embeds over HTTP: who may, and that nothing else changes ---
  const quietLink = await req(`/channels/${general.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'plain <https://example.com/quiet> link' },
  });
  await sleep(200);
  check(
    'an angle-bracket link is stored as written and gets no embed',
    quietLink.json?.content === 'plain <https://example.com/quiet> link' &&
      (await req(`/channels/${general.id}/messages?limit=1`, { token: ownerToken })).json?.messages?.[0]?.embed === null,
  );
  check(
    'another member cannot remove embeds from it (403)',
    (await req(`/messages/${quietLink.json?.id}/embeds`, { method: 'DELETE', token: bobToken })).status === 403,
  );
  check(
    'a message that does not exist is 404',
    (await req('/messages/nope/embeds', { method: 'DELETE', token: ownerToken })).status === 404,
  );
  const removed = await req(`/messages/${quietLink.json?.id}/embeds`, { method: 'DELETE', token: ownerToken });
  check(
    'the author can; the message comes back with no embed and the same text',
    removed.status === 200 && removed.json?.embed === null && removed.json?.content === 'plain <https://example.com/quiet> link',
  );
  const editedQuiet = await req(`/messages/${quietLink.json?.id}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { content: 'edited <https://example.com/quiet> link' },
  });
  check('and the message can still be edited', editedQuiet.status === 200 && editedQuiet.json?.embed === null);

  // --- Pictures fetched out of a message's own text ---
  // Driven in process with a throwaway database, because the whole point of this
  // path is a fetch, and a fetch to somewhere the guard allows is a fetch to the
  // internet. What is checked here is the half that comes after one.
  {
    const pictureDir = mkdtempSync(join(tmpdir(), 'harmony-linked-'));
    const pictureDb = new Database({ dataDir: pictureDir, dbFile: join(pictureDir, 'linked.db'), uploadDir: join(pictureDir, 'uploads') });
    const pictureSettings = createSettingsService(pictureDb.sqlite, { serverName: 'Test', requireInvite: false });
    const pictures = createAttachmentService(pictureDb.sqlite, { uploadDir: join(pictureDir, 'uploads') }, pictureSettings);

    insertUser(pictureDb.sqlite, { id: 'u1', username: 'owner', passwordHash: 'x', isOwner: true });
    insertChannel(pictureDb.sqlite, {
      id: 'c1',
      name: 'general',
      topic: null,
      categoryId: null,
      type: 'text',
      position: 0,
      createdAt: new Date().toISOString(),
      discordChannelId: null,
    });
    insertMessage(pictureDb.sqlite, {
      id: 'm1',
      channelId: 'c1',
      authorId: 'u1',
      content: 'https://example.com/cat.gif',
      createdAt: new Date().toISOString(),
    });

    const gifBytes = await sharp({ create: { width: 40, height: 24, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } })
      .png()
      .toBuffer();
    const stored = await pictures.storeLinkedImage({
      messageId: 'm1',
      uploaderId: 'u1',
      sourceUrl: 'https://example.com/cat.gif',
      filename: 'cat.gif',
      contentType: 'image/png',
      data: gifBytes,
    });
    check(
      'a picture fetched from a link is kept on the message',
      stored?.messageId === 'm1' && stored?.sourceUrl === 'https://example.com/cat.gif' && stored?.width === 40,
      JSON.stringify(stored),
    );
    check(
      'so a message can find what it fetched',
      listLinkedAttachments(pictureDb.sqlite, 'm1').some((row) => row.source_url === 'https://example.com/cat.gif'),
    );
    check(
      'the same bytes are stored once, however many links point at them',
      (await pictures.storeLinkedImage({
        messageId: 'm1',
        uploaderId: 'u1',
        sourceUrl: 'https://example.com/other.gif',
        filename: 'other.png',
        contentType: 'image/png',
        data: gifBytes,
      }))?.hash === stored?.hash,
    );
    check(
      'a non-image is refused',
      (await pictures.storeLinkedImage({
        messageId: 'm1',
        uploaderId: 'u1',
        sourceUrl: 'https://example.com/x.svg',
        filename: 'x.svg',
        contentType: 'image/svg+xml',
        data: Buffer.from('<svg/>'),
      })) === null,
    );
    check(
      'an upload is not mistaken for something fetched',
      listLinkedAttachments(pictureDb.sqlite, 'm1').every((row) => row.source_url !== null),
    );

    // The same gif comes round again far more often than a community finds a new
    // one, so a second message should get the one already here rather than
    // fetching it all over again.
    const reusable = pictures.reusableForUrl('https://example.com/cat.gif');
    check('a picture already held can be found for its link', reusable?.hash === stored?.hash);
    check(
      'a link nothing was ever fetched from has nothing to reuse',
      pictures.reusableForUrl('https://example.com/never-seen.gif') === null,
    );

    insertMessage(pictureDb.sqlite, {
      id: 'm2',
      channelId: 'c1',
      authorId: 'u1',
      content: 'https://example.com/cat.gif again',
      createdAt: new Date().toISOString(),
    });
    const copied = reusable
      ? pictures.copyLinkedImage({
          messageId: 'm2',
          uploaderId: 'u1',
          sourceUrl: 'https://example.com/cat.gif',
          from: reusable,
        })
      : null;
    check(
      'a second message gets its own record, sharing the same bytes',
      copied?.hash === stored?.hash && copied?.id !== stored?.id && copied?.messageId === 'm2',
      JSON.stringify(copied),
    );
    check(
      'and the second message can find it too',
      listLinkedAttachments(pictureDb.sqlite, 'm2').length === 1,
    );

    // --- Removing a message's embeds by hand ---
    // Off by default in this throwaway instance; the checks below need the
    // resolver switched on or they would pass for the wrong reason.
    pictureSettings.update({ embedsEnabled: true });
    const sent = [];
    const embedsHere = createEmbedService({
      sqlite: pictureDb.sqlite,
      settings: pictureSettings,
      hub: { dispatch: (event, payload) => sent.push({ event, payload }) },
      attachments: pictures,
      renderMessage: (id) => ({ id, channelId: 'c1', author: { id: 'u1' }, attachments: [] }),
    });
    const owner = { user: { id: 'u1' }, permissions: 0n };
    const stranger = { user: { id: 'u2' }, permissions: 0n };
    insertUser(pictureDb.sqlite, { id: 'u2', username: 'other', passwordHash: 'x', isOwner: false });

    let strangerRefused = false;
    try {
      await embedsHere.suppress(stranger, 'm1');
    } catch (cause) {
      strangerRefused = cause?.statusCode === 403;
    }
    check('someone else cannot remove a message\'s embeds', strangerRefused && listLinkedAttachments(pictureDb.sqlite, 'm1').length > 0);
    check(
      'a moderator with Manage Messages can',
      (await embedsHere.suppress({ user: { id: 'u2' }, permissions: Permission.ManageMessages }, 'm2'))?.id === 'm2' &&
        listLinkedAttachments(pictureDb.sqlite, 'm2').length === 0,
    );
    await embedsHere.suppress(owner, 'm1');
    check(
      'the author removes the pictures fetched from their links',
      listLinkedAttachments(pictureDb.sqlite, 'm1').length === 0,
    );
    check(
      'and clients are told',
      sent.filter((entry) => entry.event === 'MESSAGE_UPDATE').length === 2,
    );
    check(
      'the message is flagged so it stays that way',
      pictureDb.sqlite.prepare('SELECT embeds_hidden FROM messages WHERE id = ?').get('m1')?.embeds_hidden === 1,
    );
    embedsHere.resolve('m1', 'https://example.com/cat.gif');
    await sleep(100);
    check(
      'a later resolution (an edit) does not bring them back',
      listLinkedAttachments(pictureDb.sqlite, 'm1').length === 0,
    );

    // --- Linking a gif instead of storing it (gif storage mode "link") ---
    const verifyCalls = [];
    const linkingEmbeds = createEmbedService({
      sqlite: pictureDb.sqlite,
      settings: pictureSettings,
      hub: { dispatch: (event, payload) => sent.push({ event, payload }) },
      attachments: pictures,
      renderMessage: (id) => ({ id, channelId: 'c1', author: { id: 'u1' }, attachments: [] }),
      verifyLinkedGif: async (url, limits) => {
        verifyCalls.push({ url, limits });
        return { contentType: 'image/gif', width: null, height: null };
      },
    });
    const embedOf = (id) => parseMessageEmbed(pictureDb.sqlite.prepare('SELECT embed FROM messages WHERE id = ?').get(id)?.embed ?? null);
    const addMessage = (id, content) =>
      insertMessage(pictureDb.sqlite, { id, channelId: 'c1', authorId: 'u1', content, createdAt: new Date().toISOString() });

    pictureSettings.update({ gifStorage: 'link' });
    check('the setting is stored', pictureSettings.get().gifStorage === 'link' && pictureSettings.getGifStorage() === 'link');

    const GIPHY = 'https://media.giphy.com/media/abc123/giphy.gif';
    addMessage('g1', GIPHY);
    linkingEmbeds.resolve('g1', GIPHY);
    await sleep(150);
    const linkedEmbed = embedOf('g1');
    check(
      'link mode: an allowlisted gif becomes a linked embed carrying its remote address',
      linkedEmbed?.url === GIPHY && linkedEmbed?.gif?.contentType === 'image/gif',
      JSON.stringify(linkedEmbed),
    );
    check('and nothing was downloaded or stored for it', listLinkedAttachments(pictureDb.sqlite, 'g1').length === 0);
    check(
      'the check got the instance upload limits',
      verifyCalls.length === 1 && verifyCalls[0].limits.maxImageBytes === pictureSettings.get().maxImageBytes,
    );
    check(
      'clients are told',
      sent.some((entry) => entry.payload?.id === 'g1'),
    );
    linkingEmbeds.resolve('g1', GIPHY);
    await sleep(100);
    check('the same address is not checked again', verifyCalls.length === 1);

    addMessage('g2', 'http://127.0.0.1:9/z.gif');
    linkingEmbeds.resolve('g2', 'http://127.0.0.1:9/z.gif');
    await sleep(150);
    check(
      'link mode: any other address is not linked, nor even checked',
      verifyCalls.length === 1 && embedOf('g2') === null,
    );

    // A copy this instance already holds is reused rather than linked past.
    const HELD = 'https://media.tenor.com/held/cat.gif';
    addMessage('g3', HELD);
    await pictures.storeLinkedImage({
      messageId: 'g3',
      uploaderId: 'u1',
      sourceUrl: HELD,
      filename: 'cat.png',
      contentType: 'image/png',
      data: gifBytes,
    });
    addMessage('g4', HELD);
    linkingEmbeds.resolve('g4', HELD);
    await sleep(150);
    check(
      'link mode: a gif already stored here is reused, not linked',
      listLinkedAttachments(pictureDb.sqlite, 'g4').length === 1 && embedOf('g4') === null && verifyCalls.length === 1,
    );

    // A linked embed only survives parsing for an allowlisted address and type.
    check(
      'a stored gif record on a foreign address is ignored',
      parseMessageEmbed(JSON.stringify({ url: 'https://example.com/a.gif', gif: { contentType: 'image/gif' } }))?.gif === undefined,
    );
    check(
      'and so is one with a type that is not gif-like',
      parseMessageEmbed(JSON.stringify({ url: GIPHY, gif: { contentType: 'text/html' } }))?.gif === undefined &&
        parseMessageEmbed(JSON.stringify({ url: GIPHY, gif: { contentType: 'image/svg+xml' } }))?.gif === undefined,
    );
    check(
      'an allowlisted one is kept, with sizes sanitized',
      JSON.stringify(parseMessageEmbed(JSON.stringify({ url: GIPHY, gif: { contentType: 'video/mp4', width: 'x', height: 90 } }))?.gif) ===
        JSON.stringify({ contentType: 'video/mp4', width: null, height: 90 }),
    );

    // The check itself, against a stand-in for the network.
    const limits = { maxImageBytes: 1000, maxVideoBytes: 5000, userAgent: 'test' };
    const fakeIO = (respond, { publicHost = true } = {}) => {
      const calls = [];
      return {
        calls,
        io: {
          isPublicHost: async () => publicHost,
          fetch: async (target, init) => {
            calls.push({ target: String(target), init });
            return respond(String(target));
          },
        },
      };
    };
    const serve = (type, { length, body = 'GIF89a', status = 200, location } = {}) => () =>
      new Response(body, {
        status,
        headers: {
          ...(type ? { 'content-type': type } : {}),
          ...(length !== undefined ? { 'content-length': String(length) } : {}),
          ...(location ? { location } : {}),
        },
      });

    const good = fakeIO(serve('image/gif', { length: 500 }));
    check(
      'verify: an allowlisted https gif passes',
      (await verifyLinkedGif(GIPHY, limits, good.io))?.contentType === 'image/gif' && good.calls.length === 1,
    );
    check('verify: redirects are never followed', good.calls[0]?.init?.redirect === 'manual');
    for (const [name, url] of [
      ['a foreign host', 'https://example.com/a.gif'],
      ['plain http', 'http://media.giphy.com/a.gif'],
      ['a lookalike suffix', 'https://media.giphy.com.evil.test/a.gif'],
      ['a lookalike prefix', 'https://notmedia.giphy.com/a.gif'],
      ['credentials', 'https://u:p@media.giphy.com/a.gif'],
      ['a port', 'https://media.giphy.com:444/a.gif'],
      ['a bare klipy page host', 'https://klipy.com/a.gif'],
      ['a discord attachment', 'https://cdn.discordapp.com/attachments/1/2/a.gif'],
    ]) {
      const probe = fakeIO(serve('image/gif', { length: 10 }));
      check(`verify: ${name} is refused before any request`, (await verifyLinkedGif(url, limits, probe.io)) === null && probe.calls.length === 0);
    }
    check(
      'verify: a klipy media subdomain is allowed',
      (await verifyLinkedGif('https://static.klipy.com/ii/x/y.gif', limits, fakeIO(serve('image/gif', { length: 10 })).io)) !== null,
    );
    check(
      'verify: a host resolving to a private address is refused',
      (await verifyLinkedGif(GIPHY, limits, fakeIO(serve('image/gif', { length: 10 }), { publicHost: false }).io)) === null,
    );
    check(
      'verify: a redirect is refused, even to another allowlisted host',
      (await verifyLinkedGif(GIPHY, limits, fakeIO(serve('', { status: 302, location: 'https://media.tenor.com/a.gif' })).io)) === null,
    );
    check('verify: an error status is refused', (await verifyLinkedGif(GIPHY, limits, fakeIO(serve('image/gif', { status: 404 })).io)) === null);
    for (const type of ['text/html', 'image/svg+xml', 'image/png', 'application/octet-stream', '']) {
      check(
        `verify: a "${type}" response is refused`,
        (await verifyLinkedGif(GIPHY, limits, fakeIO(serve(type, { length: 10 })).io)) === null,
      );
    }
    check('verify: an animated webp passes', (await verifyLinkedGif(GIPHY, limits, fakeIO(serve('image/webp', { length: 10 })).io))?.contentType === 'image/webp');
    check('verify: an mp4 passes', (await verifyLinkedGif(GIPHY, limits, fakeIO(serve('video/mp4', { length: 10 })).io))?.contentType === 'video/mp4');
    check(
      'verify: a declared size over the image limit is refused',
      (await verifyLinkedGif(GIPHY, limits, fakeIO(serve('image/gif', { length: 1001 })).io)) === null,
    );
    check(
      'verify: a clip gets the video limit instead',
      (await verifyLinkedGif(GIPHY, limits, fakeIO(serve('video/mp4', { length: 4000 })).io)) !== null &&
        (await verifyLinkedGif(GIPHY, limits, fakeIO(serve('video/mp4', { length: 5001 })).io)) === null,
    );
    check(
      'verify: with no declared size the body is read up to the limit',
      (await verifyLinkedGif(GIPHY, limits, fakeIO(serve('image/gif', { body: 'x'.repeat(900) })).io)) !== null &&
        (await verifyLinkedGif(GIPHY, limits, fakeIO(serve('image/gif', { body: 'x'.repeat(1200) })).io)) === null,
    );
    check(
      'verify: a failing network is a refusal, not an error',
      (await verifyLinkedGif(GIPHY, limits, { isPublicHost: async () => true, fetch: async () => { throw new Error('down'); } })) === null,
    );

    pictureDb.close();
    rmSync(pictureDir, { recursive: true, force: true });
  }

  // --- Gif sources: a remote gif address paired with the copy held here ---
  // In process, with a fake network, for the same reason as the section above.
  {
    const dir = mkdtempSync(join(tmpdir(), 'harmony-gifsrc-'));
    const config = { uploadDir: join(dir, 'uploads') };
    const db = new Database({ dataDir: dir, dbFile: join(dir, 'gifsrc.db'), uploadDir: config.uploadDir });
    const sql = db.sqlite;
    const settings = createSettingsService(sql, { serverName: 'Test', requireInvite: false });
    settings.update({ embedsEnabled: true });
    const attachments = createAttachmentService(sql, config, settings);
    const blobStore = createBlobStore(config);
    insertUser(sql, { id: 'u1', username: 'owner', passwordHash: 'x', isOwner: true });
    insertChannel(sql, {
      id: 'c1', name: 'general', topic: null, categoryId: null, type: 'text', position: 0,
      createdAt: new Date().toISOString(), discordChannelId: null,
    });
    const addMessage = (id, content) =>
      insertMessage(sql, { id, channelId: 'c1', authorId: 'u1', content, createdAt: new Date().toISOString() });
    const makeGif = (red) =>
      sharp({ create: { width: 8, height: 8, channels: 3, background: { r: red, g: 40, b: 90 } } }).gif().toBuffer();
    const gifA = await makeGif(200);
    const gifH = await Promise.all([1, 2, 3, 4, 5].map((n) => makeGif(20 + n * 40)));
    const gifC = await makeGif(120);
    const gifD = await makeGif(250);
    // Noise does not compress, so this one is safely over the smallest size limit a server accepts (1 KiB).
    const gifBig = await sharp(randomBytes(150 * 150 * 3), { raw: { width: 150, height: 150, channels: 3 } }).gif().toBuffer();
    const sha = (data) => createHash('sha256').update(data).digest('hex');

    // The fake network: whatever is in `world` is served, everything else fails.
    const world = new Map();
    const fetched = [];
    const fetchImage = async (url) => {
      fetched.push(url);
      return world.get(url) ?? null;
    };
    const fetchedCount = (url) => fetched.filter((entry) => entry === url).length;
    const sources = createGifSourceService(sql, config, { attachments, fetchImage });
    const rowCount = () => sql.prepare('SELECT COUNT(*) AS n FROM gif_sources').get().n;
    const rowOf = (url) => sql.prepare('SELECT * FROM gif_sources WHERE url = ?').get(url);
    const blobCount = () => blobStore.listHashes().length;
    const auth = { user: { id: 'u1' }, permissions: 0n };
    const alive = async () => ({ contentType: 'image/gif', width: null, height: null });
    const gifs = createGifService(sql, config, { attachments, settings, sources, fetchImage, verifyLinkedGif: alive });
    const hubStub = { dispatch: () => {} };
    const mkEmbeds = (verify) =>
      createEmbedService({
        sqlite: sql, settings, hub: hubStub, attachments, sources,
        renderMessage: (id) => ({ id, channelId: 'c1', author: { id: 'u1' }, attachments: [] }),
        verifyLinkedGif: verify,
      });
    const embeds = mkEmbeds(alive);
    const embedOf = (id) => parseMessageEmbed(sql.prepare('SELECT embed FROM messages WHERE id = ?').get(id)?.embed ?? null);

    const G1 = 'https://media.giphy.com/media/aaa/giphy.gif';
    const G2 = 'https://media.giphy.com/media/bbb/giphy.gif';
    world.set(G1, { contentType: 'image/gif', data: gifA });

    // The normalization rule.
    check('gif url: case, default port and fragment collapse to one form',
      normalizeGifSourceUrl('HTTPS://Media.Giphy.COM:443/media/aaa/giphy.gif#top') === G1);
    check('gif url: the query string is kept as given',
      normalizeGifSourceUrl('https://media.tenor.com/x/a.gif?size=big&v=2') === 'https://media.tenor.com/x/a.gif?size=big&v=2' &&
        normalizeGifSourceUrl('https://media.tenor.com/x/a.gif?v=1') !== normalizeGifSourceUrl('https://media.tenor.com/x/a.gif?v=2'));
    check('gif url: http, credentials and junk are not recorded',
      normalizeGifSourceUrl('http://media.giphy.com/a.gif') === null &&
        normalizeGifSourceUrl('https://u:p@media.giphy.com/a.gif') === null &&
        normalizeGifSourceUrl('not a url') === null &&
        normalizeGifSourceUrl(`https://media.giphy.com/${'a'.repeat(2100)}.gif`) === null);

    // Link mode only records the pairing.
    settings.update({ gifStorage: 'link' });
    await gifs.link(auth, G1);
    await gifs.link(auth, 'https://MEDIA.giphy.com/media/aaa/giphy.gif#again');
    check('the same address twice, spelled two ways, is one row', rowCount() === 1);
    check('link mode records the address without a copy and fetches nothing',
      rowOf(G1)?.hash === null && fetched.length === 0 && blobCount() === 0);
    check('only gif hosts are recorded; a private or foreign address is not',
      sources.record('https://127.0.0.1/x.gif') === null && sources.record('https://example.com/x.gif') === null &&
        sources.record('http://media.giphy.com/x.gif') === null && rowCount() === 1);

    addMessage('gm1', G1);
    embeds.resolve('gm1', G1);
    await sleep(150);
    check('a linked message carries the gif embed and still has one row', embedOf('gm1')?.gif?.contentType === 'image/gif' && rowCount() === 1);
    check('stats: one linked, none archived, none dead',
      JSON.stringify(sources.stats()) === JSON.stringify({ total: 1, linked: 1, archived: 0, dead: 0, archivedBytes: 0 }));

    // Store mode copies on demand, once, however many ask at once.
    settings.update({ gifStorage: 'store' });
    const asks = await Promise.all([1, 2, 3, 4, 5].map(() => sources.ensureCopy(G1)));
    check('on demand: five concurrent asks make one fetch and one blob',
      fetchedCount(G1) === 1 && blobCount() === 1 && asks.every((entry) => entry?.hash === sha(gifA)));
    check('the copy is held by the pairing itself', rowOf(G1)?.held === 1 && rowOf(G1)?.size === gifA.length);
    await sources.ensureCopy(G1);
    check('and never fetched again', fetchedCount(G1) === 1);
    check('the linked message is untouched by the copy', embedOf('gm1')?.gif != null);

    // Switching modes back and forth loses nothing.
    settings.update({ gifStorage: 'link' });
    check('store to link: the copy is kept and still found', sources.copyFor(G1)?.hash === sha(gifA) && blobCount() === 1 && rowCount() === 1);
    await gifs.link(auth, G1);
    check('linking the same gif again neither refetches nor drops the copy', fetchedCount(G1) === 1 && rowOf(G1)?.hash === sha(gifA));
    settings.update({ gifStorage: 'store' });
    check('link to store: served from the same copy, no second fetch, no second blob',
      (await sources.ensureCopy(G1))?.hash === sha(gifA) && fetchedCount(G1) === 1 && blobCount() === 1);

    // A dead source is marked dead and the message keeps its link.
    settings.update({ gifStorage: 'link' });
    await gifs.link(auth, G2);
    addMessage('gm2', G2);
    embeds.resolve('gm2', G2);
    await sleep(150);
    settings.update({ gifStorage: 'store' });
    const age = (url) => sql.prepare("UPDATE gif_sources SET last_checked_at = '2000-01-01T00:00:00.000Z' WHERE url = ?").run(url);
    check('a failed fetch yields no copy', (await sources.ensureCopy(G2)) === null && rowOf(G2)?.fail_count === 1);
    await sources.ensureCopy(G2);
    check('a retry straight away is not made', fetchedCount(G2) === 1);
    age(G2);
    await sources.ensureCopy(G2);
    age(G2);
    await sources.ensureCopy(G2);
    check('three failures in a row mark it dead', rowOf(G2)?.status === 'dead' && fetchedCount(G2) === 3);
    age(G2);
    await sources.ensureCopy(G2);
    check('a dead source is not fetched any more', fetchedCount(G2) === 3);
    check('the message keeps showing its link', embedOf('gm2')?.gif != null && embedOf('gm2')?.url === G2);
    check('stats count it as dead and not linked', sources.stats().dead === 1 && sources.stats().linked === 0);
    settings.update({ gifStorage: 'link' });
    await gifs.link(auth, G2);
    check('seen alive again, it is revived', rowOf(G2)?.status === 'ok' && rowOf(G2)?.fail_count === 0);

    // The archive job is bounded, and only ever fetches what it is allowed to.
    const H = [1, 2, 3, 4, 5].map((n) => `https://media.giphy.com/media/h${n}/giphy.gif`);
    for (const [n, url] of H.entries()) {
      world.set(url, { contentType: 'image/gif', data: gifH[n] });
      sources.record(url, 'image/gif');
    }
    world.set(G2, { contentType: 'image/gif', data: gifC });
    // 5 + G2 (revived) are waiting; the batch is bounded to what the caller asks.
    const first = await sources.archive(2);
    check('archive: a batch is bounded and reports progress',
      first.attempted === 2 && first.copied === 2 && first.more === true && first.stats.archived >= 3, JSON.stringify(first));
    const second = await sources.archive(3);
    const third = await sources.archive(10);
    check('archive: repeated calls finish the job', second.attempted === 3 && third.more === false && sources.stats().linked === 0, JSON.stringify([second, third]));
    check('archive: one blob per distinct picture', blobCount() === 7);
    check('archive: nothing is left to do afterwards', (await sources.archive(10)).attempted === 0);
    sql.prepare('INSERT INTO gif_sources (url, first_seen_at, last_seen_at) VALUES (?, ?, ?)')
      .run('https://intranet.example/p.gif', new Date().toISOString(), new Date().toISOString());
    const guarded = await sources.archive(10);
    check('archive: an address off the allowlist is never fetched, and is given up on',
      guarded.attempted === 1 && guarded.copied === 0 && guarded.markedDead === 1 && guarded.more === false &&
        !fetched.includes('https://intranet.example/p.gif') && (await sources.ensureCopy('https://intranet.example/p.gif')) === null);
    check('archive: the real downloader refuses private addresses',
      (await fetchPublicImage('http://127.0.0.1:9/a.gif', 'smoke')) === null &&
        (await fetchPublicImage('https://localhost/a.gif', 'smoke')) === null);
    const H6 = 'https://media.giphy.com/media/h6/giphy.gif';
    sources.record(H6, 'image/gif');
    world.set(H6, { contentType: 'image/gif', data: gifBig });
    const normalLimit = settings.get().maxImageBytes;
    settings.update({ maxImageBytes: 1024 });
    const tooBig = await sources.archive(5);
    settings.update({ maxImageBytes: normalLimit });
    check('archive: the upload size limit is respected', tooBig.copied === 0 && tooBig.failed === 1 && rowOf(H6)?.hash === null);
    const H7 = 'https://media.giphy.com/media/h7/giphy.gif';
    sources.record(H7, 'image/gif');
    world.set(H7, { contentType: 'image/png', data: gifA });
    // H6 failed the size limit above; make it eligible again so the run is
    // deterministic. Otherwise whether it is retried depends on the archive
    // calls landing in different milliseconds, which they need not.
    age(H6);
    const notGif = await sources.archive(5);
    check('archive: something that is not a gif is not kept', notGif.copied === 1 && rowOf(H7)?.hash === null);

    // Using a copy for a new message costs no fetch.
    settings.update({ gifStorage: 'store' });
    const before = fetched.length;
    addMessage('gm3', H[0]);
    embeds.resolve('gm3', H[0]);
    await sleep(150);
    const gm3 = listLinkedAttachments(sql, 'gm3');
    check('store mode: a message with an archived address gets the copy, with no fetch',
      gm3.length === 1 && gm3[0].hash === sha(gifH[0]) && gm3[0].source_url === H[0] && fetched.length === before && embedOf('gm3') === null);
    settings.update({ gifStorage: 'link' });
    addMessage('gm4', H[1]);
    mkEmbeds(async () => null).resolve('gm4', H[1]);
    await sleep(150);
    check('link mode with a dead remote: the message falls back to the copy held here',
      listLinkedAttachments(sql, 'gm4').length === 1 && fetched.length === before && embedOf('gm4') === null);
    addMessage('gm5', H[2]);
    embeds.resolve('gm5', H[2]);
    await sleep(150);
    check('link mode with a live remote: still linked, copy kept, nothing deleted',
      embedOf('gm5')?.gif != null && sources.copyFor(H[2]) !== null && listLinkedAttachments(sql, 'gm5').length === 0);

    // Picking a hosted gif twice is one fetch and one blob.
    const K = 'https://static.klipy.com/ii/k1/k.gif';
    world.set(K, { contentType: 'image/gif', data: gifD });
    const blobsBefore = blobCount();
    settings.update({ gifStorage: 'store' });
    const pickA = await gifs.pick(auth, { url: K });
    const pickB = await gifs.pick(auth, { url: K });
    await gifs.addFavorite(auth, { url: K });
    check('pick: the same hosted gif twice is one fetch, and the second pick shares the bytes',
      fetchedCount(K) === 1 && pickA.hash === pickB.hash && pickA.id !== pickB.id);
    check('pick: it is one row and one new blob, for the gif itself', rowOf(K)?.hash === pickA.hash && blobCount() === blobsBefore + 1);

    // Freeing copies keeps whatever else holds them.
    settings.update({ gifStorage: 'link' });
    upsertGifFavorite(sql, {
      userId: 'u1', hash: rowOf(H[3]).hash, filename: 'a.gif', contentType: 'image/gif',
      size: rowOf(H[3]).size, width: 8, height: 8, sourceUrl: null,
    });
    const held = sql.prepare('SELECT COUNT(*) AS n FROM gif_sources WHERE held = 1 AND hash IS NOT NULL').get().n;
    const freeStats = sources.free();
    check('free: releases copies nothing else keeps and reports it', freeStats.released > 0 && freeStats.released < held, JSON.stringify([freeStats, held]));
    check('free: a favorited gif keeps its copy', rowOf(H[3])?.hash === sha(gifH[3]) && existsSync(blobStore.pathFor(sha(gifH[3]))));
    check('free: a gif on a message attachment keeps its copy',
      rowOf(H[0])?.hash === sha(gifH[0]) && existsSync(blobStore.pathFor(sha(gifH[0]))));
    check('free: the addresses stay recorded', rowOf(H[4]) !== undefined && rowOf(H[4])?.hash === null);
    check('free: the freed bytes are gone from disk', existsSync(blobStore.pathFor(sha(gifA))) === false && freeStats.freedBytes > 0);
    check('free: a released gif is fetched again on demand', (await sources.ensureCopy(G1))?.hash === sha(gifA) && fetchedCount(G1) === 2);

    // Retention: the pruner and the pairing agree about what is still here.
    const pruner = createPruner({ sqlite: sql, config, settings, hub: hubStub, log: () => {} });
    pruner.runNow();
    check('prune: a copy made for a gif source is not swept', existsSync(blobStore.pathFor(sha(gifA))) && rowOf(G1)?.hash === sha(gifA));
    sql.prepare('DELETE FROM gif_favorites WHERE hash = ?').run(pickA.hash);
    sql.prepare('DELETE FROM attachments WHERE hash = ?').run(pickA.hash);
    pruner.runNow();
    check('prune: a blob only mirrored by a pairing goes with its holder, and the pairing is cleared',
      !existsSync(blobStore.pathFor(pickA.hash)) && rowOf(K)?.hash === null);
    check('prune: that gif is fetched again on demand rather than missing', (await sources.ensureCopy(K))?.hash === sha(gifD) && fetchedCount(K) === 2);
    blobStore.delete(sha(gifA));
    pruner.runNow();
    check('prune: a copy whose file vanished is forgotten, not served as missing', rowOf(G1)?.hash === null);
    check('prune: and is fetched again', (await sources.ensureCopy(G1))?.hash === sha(gifA) && existsSync(blobStore.pathFor(sha(gifA))));

    // Emergency pruning gives up copies before it touches attachments.
    const attachmentsBefore = sql.prepare('SELECT COUNT(*) AS n FROM attachments').get().n;
    const messagesBefore = sql.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    const total = blobStore.totalBytes();
    const heldBeforeEmergency = sql.prepare('SELECT COUNT(*) AS n FROM gif_sources WHERE held = 1 AND hash IS NOT NULL').get().n;
    settings.updateRetention({ storageLimitBytes: total - 1, storageTargetBytes: total - gifA.length });
    pruner.runNow();
    settings.updateRetention({ storageLimitBytes: null, storageTargetBytes: null });
    check('emergency prune: gif copies are released first, and that is enough',
      sql.prepare('SELECT COUNT(*) AS n FROM gif_sources WHERE held = 1 AND hash IS NOT NULL').get().n < heldBeforeEmergency &&
        blobStore.totalBytes() <= total - gifA.length &&
        sql.prepare('SELECT COUNT(*) AS n FROM attachments').get().n === attachmentsBefore);
    check('emergency prune: no message is deleted', sql.prepare('SELECT COUNT(*) AS n FROM messages').get().n === messagesBefore);

    // The one-off backfill from what already pairs an address with bytes.
    const old = new DatabaseSync(':memory:');
    const cols = 'hash TEXT, content_type TEXT, size INTEGER, width INTEGER, height INTEGER, source_url TEXT, created_at TEXT';
    old.exec(`CREATE TABLE attachments (id TEXT, ${cols}); CREATE TABLE gif_favorites (id TEXT, ${cols});`);
    const put = old.prepare('INSERT INTO attachments (id, hash, content_type, size, width, height, source_url, created_at) VALUES (?, ?, ?, 10, 2, 2, ?, ?)');
    put.run('a1', 'h1', 'image/gif', 'HTTPS://Media.Giphy.com/x.gif#frag', '2024-01-01T00:00:00.000Z');
    put.run('a2', 'h2', 'image/gif', 'https://media.giphy.com/x.gif', '2024-02-01T00:00:00.000Z');
    put.run('a3', 'h3', 'image/png', 'https://media.giphy.com/png.png', '2024-01-01T00:00:00.000Z');
    put.run('a4', 'h4', 'image/gif', 'https://example.com/other.gif', '2024-01-01T00:00:00.000Z');
    put.run('a5', 'h5', 'image/gif', null, '2024-01-01T00:00:00.000Z');
    old.prepare('INSERT INTO gif_favorites (id, hash, content_type, size, width, height, source_url, created_at) VALUES (?, ?, ?, 10, 2, 2, ?, ?)')
      .run('f1', 'h6', 'image/gif', 'https://static.klipy.com/ii/z.gif', '2024-03-01T00:00:00.000Z');
    migrations.find((migration) => migration.version === 31).up(old);
    const filled = old.prepare('SELECT url, hash, held FROM gif_sources ORDER BY url').all();
    check('backfill: pairs gif addresses with their bytes, normalized, one row each, not held',
      filled.length === 2 && filled[0].url === 'https://media.giphy.com/x.gif' && filled[0].hash === 'h1' &&
        filled[1].url === 'https://static.klipy.com/ii/z.gif' && filled.every((row) => row.held === 0),
      JSON.stringify(filled));
    old.close();

    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // --- Presence ---
  await sleep(200);
  const rosterRes = await req('/members/roster', { token: ownerToken });
  check(
    'the roster lists members with roles and presence',
    Array.isArray(rosterRes.json?.members) &&
      rosterRes.json.members.every(
        (entry) => typeof entry.online === 'boolean' && Array.isArray(entry.roleIds) && Boolean(entry.user?.id),
      ),
  );
  check('everyone starts offline', rosterRes.json?.members?.every((entry) => entry.online === false));

  const presenceWatcher = await openGateway({ token: ownerToken });
  const bobGateway = await openGateway({ token: bobToken });
  await sleep(300);
  check(
    'a member coming online is announced',
    presenceWatcher.events.some(
      (frame) => frame.t === 'PRESENCE_UPDATE' && frame.d?.user?.id === bob.json?.user?.id && frame.d?.online === true,
    ),
  );
  check(
    'the roster reports them online',
    (await req('/members/roster', { token: ownerToken })).json?.members?.find(
      (entry) => entry.user.id === bob.json?.user?.id,
    )?.online === true,
  );

  bobGateway.ws.close();
  await sleep(400);
  check(
    'a member going offline is announced',
    presenceWatcher.events.some(
      (frame) => frame.t === 'PRESENCE_UPDATE' && frame.d?.user?.id === bob.json?.user?.id && frame.d?.online === false,
    ),
  );
  presenceWatcher.ws.close();

  // --- Theme derivation ---
  const defaults = deriveTheme(null);
  check(
    'an untouched instance derives the built-in palette',
    defaults.scheme === 'dark' && defaults.bg === DEFAULT_BACKGROUND && defaults.accent === DEFAULT_ACCENT,
  );
  check('dark backgrounds get light text', relativeLuminance(defaults.text) > 0.5);

  const light = deriveTheme({ background: '#f5f5f5', accent: '#1a73e8' });
  check('light backgrounds are detected', light.scheme === 'light');
  check('light backgrounds get dark text', relativeLuminance(light.text) < 0.2);
  check('light themes flip the overlay to black', light.hover.startsWith('rgb(0 0 0'));
  check('dark themes keep a white overlay', defaults.hover.startsWith('rgb(255 255 255'));
  check('panels stay distinct from the background', light.bgElevated !== light.bg && light.bgDeep !== light.bg);

  check('an unparseable color falls back to the default', deriveTheme({ background: 'nonsense' }).bg === DEFAULT_BACKGROUND);
  check('a bright accent takes dark text', deriveTheme({ accent: '#ffd700' }).onAccent === '#000000');
  check('a dark accent takes light text', deriveTheme({ accent: '#1a3ea8' }).onAccent === '#ffffff');
  check('a near black background still separates its panels', deriveTheme({ background: '#050505' }).bgElevated !== '#050505');

  // --- Channel locking ---
  const staffRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Staff' } });
  const staffChannel = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'staff-only', requiredRoleId: staffRole.json.id },
  });
  check('a channel can require a role', staffChannel.json?.requiredRoleId === staffRole.json.id);

  const badRole = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'bad-lock', requiredRoleId: 'no-such-role' },
  });
  check('a channel lock must name a real role (400)', badRole.status === 400, `status ${badRole.status}`);

  const seesStaffChannel = async (token) =>
    (await req('/channels', { token })).json?.channels?.some((channel) => channel.id === staffChannel.json.id);
  check('a locked channel is hidden from a member without the role', (await seesStaffChannel(bobToken)) === false);
  check('a locked channel is listed for an administrator', (await seesStaffChannel(ownerToken)) === true);
  check(
    'reading a locked channel is refused (403)',
    (await req(`/channels/${staffChannel.json.id}/messages`, { token: bobToken })).status === 403,
  );
  check(
    'marking a locked channel read is refused (403)',
    (await req(`/channels/${staffChannel.json.id}/read`, { method: 'POST', token: bobToken })).status === 403,
  );
  check(
    'posting to a locked channel is refused (403)',
    (
      await req(`/channels/${staffChannel.json.id}/messages`, {
        method: 'POST',
        token: bobToken,
        body: { content: 'let me in' },
      })
    ).status === 403,
  );

  // Locked traffic must not reach a member who cannot see the channel.
  const lockWatcher = await openGateway({ token: bobToken });
  await req(`/channels/${staffChannel.json.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'a secret' },
  });
  await sleep(250);
  check(
    'a locked channel broadcasts nothing to a member without the role',
    lockWatcher.events.every((frame) => frame.t !== 'MESSAGE_CREATE' || frame.d?.channelId !== staffChannel.json.id),
  );

  // Granting the role opens it up live.
  await req(`/members/${bob.json.user.id}/roles/${staffRole.json.id}`, { method: 'PUT', token: ownerToken });
  await sleep(200);
  check('granting the role reveals the channel', (await seesStaffChannel(bobToken)) === true);
  await req(`/channels/${staffChannel.json.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'welcome' },
  });
  await sleep(250);
  check(
    'the unlocked channel now reaches the member',
    lockWatcher.events.some(
      (frame) => frame.t === 'MESSAGE_CREATE' && frame.d?.channelId === staffChannel.json.id,
    ),
  );
  lockWatcher.ws.close();

  // A locked category covers every channel inside it.
  const staffCategory = await req('/categories', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Staff area', requiredRoleId: staffRole.json.id },
  });
  await req(`/members/${bob.json.user.id}/roles/${staffRole.json.id}`, { method: 'DELETE', token: ownerToken });
  await sleep(200);
  const insideCategory = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'staff-room', categoryId: staffCategory.json.id },
  });
  const bobList = await req('/channels', { token: bobToken });
  check(
    'a locked category hides its channels and itself',
    bobList.json?.channels?.every((channel) => channel.categoryId !== staffCategory.json.id) &&
      bobList.json?.categories?.every((category) => category.id !== staffCategory.json.id),
  );
  check(
    'the locked category is still visible to an administrator',
    (await req('/channels', { token: ownerToken })).json?.channels?.some(
      (channel) => channel.id === insideCategory.json.id,
    ) === true,
  );

  await req(`/channels/${insideCategory.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/categories/${staffCategory.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/channels/${staffChannel.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/roles/${staffRole.json.id}`, { method: 'DELETE', token: ownerToken });

  // Deleting a channel reaches everyone who could see it, not just the
  // administrators: checked after the row is gone, the access check used to say
  // nobody else could.
  const goneWatcher = await openGateway({ token: bobToken });
  const doomedChannel = await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'doomed' } });
  await sleep(150);
  await req(`/channels/${doomedChannel.json.id}`, { method: 'DELETE', token: ownerToken });
  await sleep(250);
  check(
    'a member hears that a channel was deleted',
    goneWatcher.events.some((frame) => frame.t === 'CHANNEL_DELETE' && frame.d?.id === doomedChannel.json.id),
  );

  // Locking a channel away from someone tells them it is gone for them, and
  // nothing more; the update itself only goes to those who can still see it.
  const vaultRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Vault' } });
  const lockable = await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'lockable' } });
  await sleep(150);
  goneWatcher.events.length = 0;
  await req(`/channels/${lockable.json.id}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { requiredRoleId: vaultRole.json.id },
  });
  await sleep(250);
  check(
    'a member who loses a channel to a lock is told it is gone',
    goneWatcher.events.some((frame) => frame.t === 'CHANNEL_DELETE' && frame.d?.id === lockable.json.id),
  );
  check(
    'the locked channel update itself does not reach them',
    goneWatcher.events.every((frame) => frame.t !== 'CHANNEL_UPDATE'),
  );

  const lockableCategory = await req('/categories', { method: 'POST', token: ownerToken, body: { name: 'Lockable' } });
  await sleep(150);
  goneWatcher.events.length = 0;
  await req(`/categories/${lockableCategory.json.id}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { requiredRoleId: vaultRole.json.id },
  });
  await sleep(250);
  check(
    'a member who loses a category to a lock is told it is gone',
    goneWatcher.events.some(
      (frame) => frame.t === 'CATEGORY_DELETE' && frame.d?.id === lockableCategory.json.id,
    ) && goneWatcher.events.every((frame) => frame.t !== 'CATEGORY_UPDATE'),
  );
  await req(`/channels/${lockable.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/categories/${lockableCategory.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/roles/${vaultRole.json.id}`, { method: 'DELETE', token: ownerToken });

  // Editing your own profile is announced like an administrator's edit, so other
  // people's member lists and messages pick up the new name.
  const profileWatcher = await openGateway({ token: ownerToken });
  await req('/users/@me', { method: 'PATCH', token: bobToken, body: { displayName: 'Bobby' } });
  await sleep(250);
  check(
    'editing your own profile dispatches MEMBER_UPDATE',
    profileWatcher.events.some((frame) => frame.t === 'MEMBER_UPDATE' && frame.d?.userId === bob.json.user.id),
  );
  await req('/users/@me', { method: 'PATCH', token: bobToken, body: { displayName: null } });
  profileWatcher.ws.close();

  // The server closes connections that stop heartbeating, and ones that never
  // identify, so a vanished client does not stay online forever. The helper
  // above heartbeats, so its socket outlives both deadlines.
  const silentClose = new Promise((resolveClose) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`);
    const openedAt = Date.now();
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.op === 10) ws.send(JSON.stringify({ op: 2, d: { token: bobToken } }));
    });
    ws.on('close', (code) => resolveClose({ code, after: Date.now() - openedAt }));
  });
  const unidentifiedClose = new Promise((resolveClose) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`);
    ws.on('close', (code) => resolveClose(code));
  });
  const silent = await Promise.race([silentClose, sleep(HEARTBEAT_MS * 6).then(() => null)]);
  check(
    'a socket that stops heartbeating is closed (4009)',
    silent?.code === 4009 && silent.after >= HEARTBEAT_MS * 2,
    JSON.stringify(silent),
  );
  check(
    'a socket that never identifies is closed (4003)',
    (await Promise.race([unidentifiedClose, sleep(HEARTBEAT_MS * 3).then(() => null)])) === 4003,
  );
  check('a heartbeating socket stays open', goneWatcher.ws.readyState === WebSocket.OPEN);
  goneWatcher.ws.close();

  // Fastify's own refusals are the client's fault and say so.
  const badJson = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"username": ',
  });
  const badJsonBody = await badJson.json();
  check(
    'invalid JSON is a 400, not a 500',
    badJson.status === 400 && badJsonBody?.error?.code === 'bad_request',
    `status ${badJson.status}`,
  );
  const emptyJson = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '',
  });
  check('an empty JSON body is a 400, not a 500', emptyJson.status === 400, `status ${emptyJson.status}`);
  const hugeJson = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'x'.repeat(2 * 1024 * 1024) }),
  });
  const hugeJsonBody = await hugeJson.json();
  check(
    'an oversized body is a 413, not a 500',
    hugeJson.status === 413 && hugeJsonBody?.error?.code === 'payload_too_large',
    `status ${hugeJson.status}`,
  );
  const wrongType = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-something' },
    body: 'hello',
  });
  check('an unsupported content type is a 415, not a 500', wrongType.status === 415, `status ${wrongType.status}`);

  const patched = await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { serverName: 'Test Server' },
  });
  check('owner updates settings', patched.json?.serverName === 'Test Server');
  check('meta reflects the new name', (await req('/meta')).json?.name === 'Test Server');
  check('member cannot read settings (403)', (await req('/settings', { token: bobToken })).status === 403);

  // Toggling requireInvite in settings takes effect immediately.
  await req('/settings', { method: 'PATCH', token: ownerToken, body: { requireInvite: false } });
  const openReg = await req('/auth/register', {
    method: 'POST',
    body: { username: 'carol', password: 'carol-password' },
  });
  check('registration opens when requireInvite is false', openReg.status === 200, `status ${openReg.status}`);
  await req('/settings', { method: 'PATCH', token: ownerToken, body: { requireInvite: true } });

  // Edit history: the previous text is kept per edit; only the author and
  // Manage Messages read it, and everyone else gets the same 404 as for a missing id.
  {
    const carolToken = openReg.json?.token;
    const carolId = openReg.json?.user?.id;
    const histChannel = (await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'edit-history' } })).json;
    const histMsg = (
      await req(`/channels/${histChannel.id}/messages`, { method: 'POST', token: bobToken, body: { content: 'v0' } })
    ).json;
    const edits = (id, token) => req(`/messages/${id}/edits`, { token });
    check('an unedited message has an empty history', (await edits(histMsg.id, bobToken)).json?.edits?.length === 0);
    await req(`/messages/${histMsg.id}`, { method: 'PATCH', token: bobToken, body: { content: 'v1' } });
    await req(`/messages/${histMsg.id}`, { method: 'PATCH', token: bobToken, body: { content: 'v2' } });
    const hist = await edits(histMsg.id, bobToken);
    check(
      'the author reads previous versions, newest first',
      hist.status === 200 &&
        hist.json?.edits?.map((e) => e.content).join(',') === 'v1,v0' &&
        hist.json.edits[0].editor?.username === 'bob' &&
        hist.json.edits[0].source === 'harmony',
      JSON.stringify(hist.json),
    );
    check(
      'the current text is not part of the history',
      !hist.json?.edits?.some((e) => e.content === 'v2'),
    );
    const missing = await edits('no-such-message', carolToken);
    const other = await edits(histMsg.id, carolToken);
    check(
      'another member gets the same 404 as for a missing message',
      other.status === 404 && missing.status === 404 && JSON.stringify(other.json) === JSON.stringify(missing.json),
      `${other.status} ${JSON.stringify(other.json)} vs ${JSON.stringify(missing.json)}`,
    );
    check('an unauthenticated request is refused', (await req(`/messages/${histMsg.id}/edits`)).status === 401);

    const modRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'HistoryMod' } });
    await req(`/roles/${modRole.json.id}`, {
      method: 'PATCH',
      token: ownerToken,
      body: { permissions: String(1n << 2n) },
    });
    await req(`/members/${carolId}/roles/${modRole.json.id}`, { method: 'PUT', token: ownerToken });
    check('a Manage Messages member reads the history', (await edits(histMsg.id, carolToken)).json?.edits?.length === 2);
    check('an administrator reads the history', (await edits(histMsg.id, ownerToken)).json?.edits?.length === 2);

    for (let i = 3; i <= 30; i += 1) {
      await req(`/messages/${histMsg.id}`, { method: 'PATCH', token: bobToken, body: { content: `v${i}` } });
    }
    const capped = (await edits(histMsg.id, bobToken)).json?.edits ?? [];
    check('history keeps at most 20 versions', capped.length === 20, `${capped.length}`);
    check('the oldest versions are dropped first', capped[0].content === 'v29' && capped.at(-1).content === 'v10');

    // A channel locked behind a role hides the history from a Manage Messages member too.
    const lockRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'HistoryLock' } });
    const lockChannel = (
      await req('/channels', {
        method: 'POST',
        token: ownerToken,
        body: { name: 'edit-history-locked', requiredRoleId: lockRole.json.id },
      })
    ).json;
    const lockMsg = (
      await req(`/channels/${lockChannel.id}/messages`, { method: 'POST', token: ownerToken, body: { content: 'a' } })
    ).json;
    await req(`/messages/${lockMsg.id}`, { method: 'PATCH', token: ownerToken, body: { content: 'b' } });
    check('a locked channel hides the history (404)', (await edits(lockMsg.id, carolToken)).status === 404);
    check('and the owner still reads it', (await edits(lockMsg.id, ownerToken)).json?.edits?.length === 1);

    // A deleted message exposes nothing.
    await req(`/messages/${histMsg.id}`, { method: 'DELETE', token: bobToken });
    check('a deleted message has no readable history (404)', (await edits(histMsg.id, bobToken)).status === 404);

    await req(`/roles/${modRole.json.id}`, { method: 'DELETE', token: ownerToken });
    await req(`/roles/${lockRole.json.id}`, { method: 'DELETE', token: ownerToken });
    await req(`/channels/${histChannel.id}`, { method: 'DELETE', token: ownerToken });
    await req(`/channels/${lockChannel.id}`, { method: 'DELETE', token: ownerToken });
  }

  const rolesRes = await req('/roles', { token: ownerToken });
  const everyoneRole = rolesRes.json?.roles?.find((role) => role.isDefault);
  check('roles list includes @everyone', Boolean(everyoneRole));

  const newRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Moderator' } });
  check('owner creates a role', newRole.status === 200 && newRole.json?.name === 'Moderator');
  const roleId = newRole.json?.id;

  const manageMessages = String(1n << 2n);
  const granted = await req(`/roles/${roleId}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { permissions: manageMessages },
  });
  check('role permissions update', granted.json?.permissions === manageMessages);

  check(
    '@everyone cannot be renamed (403)',
    (await req(`/roles/${everyoneRole.id}`, { method: 'PATCH', token: ownerToken, body: { name: 'nope' } })).status === 403,
  );
  check(
    '@everyone cannot be deleted (403)',
    (await req(`/roles/${everyoneRole.id}`, { method: 'DELETE', token: ownerToken })).status === 403,
  );
  check(
    'member cannot create roles (403)',
    (await req('/roles', { method: 'POST', token: bobToken, body: { name: 'hax' } })).status === 403,
  );

  const membersRes = await req('/members', { token: ownerToken });
  check('owner lists members', membersRes.status === 200 && membersRes.json?.members?.length >= 3);
  check('member cannot list members (403)', (await req('/members', { token: bobToken })).status === 403);

  // The public directory is readable by every member, because mentions need it.
  const directory = await req('/members/directory', { token: bobToken });
  check(
    'any member reads the user directory',
    directory.status === 200 && directory.json?.users?.length >= 3,
  );
  check(
    'the directory carries no roles or permissions',
    directory.json?.users?.every((user) => !('permissions' in user) && !('roleIds' in user)) === true,
  );
  check('the user directory requires auth (401)', (await req('/members/directory')).status === 401);

  const bobId = bob.json?.user?.id;
  check(
    'owner assigns a role',
    (await req(`/members/${bobId}/roles/${roleId}`, { method: 'PUT', token: ownerToken })).status === 204,
  );
  const bobAfter = await req('/auth/me', { token: bobToken });
  check('assigned role grants permissions', (BigInt(bobAfter.json?.permissions ?? '0') & (1n << 2n)) !== 0n);

  check(
    'owner removes a role',
    (await req(`/members/${bobId}/roles/${roleId}`, { method: 'DELETE', token: ownerToken })).status === 204,
  );
  const bobCleared = await req('/auth/me', { token: bobToken });
  check('removing a role takes permissions away', (BigInt(bobCleared.json?.permissions ?? '0') & (1n << 2n)) === 0n);

  // A single moderation permission is enough to read the member list, since the
  // moderation controls live on that same screen. KickMembers is bit 10.
  const kickRole = await req('/roles', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Kicker', permissions: String(1n << 10n) },
  });
  check('a kick-only moderator cannot list members yet (403)', (await req('/members', { token: bobToken })).status === 403);
  await req(`/members/${bobId}/roles/${kickRole.json?.id}`, { method: 'PUT', token: ownerToken });
  check('a kick-only moderator can list members', (await req('/members', { token: bobToken })).status === 200);
  await req(`/members/${bobId}/roles/${kickRole.json?.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/roles/${kickRole.json?.id}`, { method: 'DELETE', token: ownerToken });

  // Badges: owner from the account flag, admin from the Administrator permission,
  // moderator from a role marked as one, in that order of precedence.
  const ownerMe = await req('/auth/me', { token: ownerToken });
  check('the owner carries the owner badge', ownerMe.json?.user?.badge === 'owner');
  check('a plain member carries no badge', bobCleared.json?.user?.badge === null);

  await req(`/roles/${roleId}`, { method: 'PATCH', token: ownerToken, body: { badge: 'moderator' } });
  await req(`/members/${bobId}/roles/${roleId}`, { method: 'PUT', token: ownerToken });
  const bobMod = await req('/auth/me', { token: bobToken });
  check('a role marked moderator gives the moderator badge', bobMod.json?.user?.badge === 'moderator');

  const adminRole = await req('/roles', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Temp admin', permissions: String(1n << 14n) },
  });
  await req(`/members/${bobId}/roles/${adminRole.json.id}`, { method: 'PUT', token: ownerToken });
  const bobAdmin = await req('/auth/me', { token: bobToken });
  check('Administrator outranks the moderator badge', bobAdmin.json?.user?.badge === 'admin');
  await req(`/members/${bobId}/roles/${adminRole.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/members/${bobId}/roles/${roleId}`, { method: 'DELETE', token: ownerToken });
  await req(`/roles/${adminRole.json.id}`, { method: 'DELETE', token: ownerToken });

  // A delegated role or member manager cannot climb past what they hold, nor
  // reach an administrator. ManageRoles is bit 7, ManageMembers bit 16.
  const managerRole = await req('/roles', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Manager', permissions: String((1n << 7n) | (1n << 16n)) },
  });
  const guardAdminRole = await req('/roles', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Guarded admin', permissions: String(1n << 14n) },
  });
  const plainRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Plain' } });
  await req(`/members/${bobId}/roles/${managerRole.json.id}`, { method: 'PUT', token: ownerToken });
  check(
    'a role manager cannot give themselves Administrator (403)',
    (await req(`/members/${bobId}/roles/${guardAdminRole.json.id}`, { method: 'PUT', token: bobToken })).status === 403,
  );
  check(
    'nor a role with any permission they lack (403)',
    (await req(`/members/${bobId}/roles/${roleId}`, { method: 'PUT', token: bobToken })).status === 403,
  );
  check(
    'but can hand out a role within their own permissions',
    (await req(`/members/${bobId}/roles/${plainRole.json.id}`, { method: 'PUT', token: bobToken })).status === 204,
  );
  check(
    'a role manager cannot strip an admin role (403)',
    (await req(`/roles/${guardAdminRole.json.id}`, { method: 'PATCH', token: bobToken, body: { permissions: '0' } }))
      .status === 403,
  );
  check(
    'or rename it (403)',
    (await req(`/roles/${guardAdminRole.json.id}`, { method: 'PATCH', token: bobToken, body: { name: 'mine' } }))
      .status === 403,
  );
  check(
    'or delete it (403)',
    (await req(`/roles/${guardAdminRole.json.id}`, { method: 'DELETE', token: bobToken })).status === 403,
  );
  const guardOwnerId = (await req('/auth/me', { token: ownerToken })).json?.user?.id;
  check(
    'a role manager cannot take roles from an administrator (403)',
    (await req(`/members/${guardOwnerId}/roles/${guardAdminRole.json.id}`, { method: 'DELETE', token: bobToken }))
      .status === 403,
  );
  check(
    "a member manager cannot reset the owner's password (403)",
    (await req(`/members/${guardOwnerId}`, { method: 'PATCH', token: bobToken, body: { password: 'taken-over-now' } }))
      .status === 403,
  );
  check(
    "or relink the owner's Discord account (403)",
    (await req(`/members/${guardOwnerId}`, { method: 'PATCH', token: bobToken, body: { discordId: '123456789012345678' } }))
      .status === 403,
  );
  check(
    'a member manager can still edit an ordinary member',
    (await req(`/members/${bobId}`, { method: 'PATCH', token: bobToken, body: { displayName: 'Bob' } })).status === 200,
  );
  await req(`/members/${bobId}`, { method: 'PATCH', token: ownerToken, body: { displayName: '' } });
  await req(`/members/${bobId}/roles/${plainRole.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/members/${bobId}/roles/${managerRole.json.id}`, { method: 'DELETE', token: ownerToken });
  for (const role of [managerRole, guardAdminRole, plainRole]) {
    await req(`/roles/${role.json.id}`, { method: 'DELETE', token: ownerToken });
  }

  check(
    'the default role cannot be assigned (400)',
    (await req(`/members/${bobId}/roles/${everyoneRole.id}`, { method: 'PUT', token: ownerToken })).status === 400,
  );

  const revokeTarget = await req('/invites', { method: 'POST', token: ownerToken, body: {} });
  check(
    'owner revokes an invite',
    (await req(`/invites/${revokeTarget.json?.code}`, { method: 'DELETE', token: ownerToken })).status === 204,
  );

  check(
    'owner deletes a role',
    (await req(`/roles/${roleId}`, { method: 'DELETE', token: ownerToken })).status === 204,
  );

  // --- Username colors and role ordering ---
  const red = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Red', color: 0xff0000 } });
  const blue = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Blue', color: 0x0000ff } });
  check('roles accept colors', red.json?.color === 0xff0000 && blue.json?.color === 0x0000ff);

  await req(`/members/${bobId}/roles/${red.json?.id}`, { method: 'PUT', token: ownerToken });
  await req(`/members/${bobId}/roles/${blue.json?.id}`, { method: 'PUT', token: ownerToken });

  const bobColored = await req('/auth/me', { token: bobToken });
  check(
    'the highest-positioned role decides the color',
    bobColored.json?.user?.roleColor === 0x0000ff,
    `got ${bobColored.json?.user?.roleColor}`,
  );

  const reordered = await req(`/roles/${red.json?.id}/move`, {
    method: 'POST',
    token: ownerToken,
    body: { direction: 'up' },
  });
  check('moving a role reorders it', reordered.json?.roles?.[0]?.id === red.json?.id);

  const bobAfterMove = await req('/auth/me', { token: bobToken });
  check(
    'the color follows the new order',
    bobAfterMove.json?.user?.roleColor === 0xff0000,
    `got ${bobAfterMove.json?.user?.roleColor}`,
  );

  check(
    '@everyone cannot be reordered (403)',
    (
      await req(`/roles/${everyoneRole.id}/move`, { method: 'POST', token: ownerToken, body: { direction: 'up' } })
    ).status === 403,
  );

  const colorChannel = (await req('/channels', { token: bobToken })).json?.channels?.find(
    (channel) => channel.name === 'general',
  );
  const colorMessage = await req(`/channels/${colorChannel.id}/messages`, {
    method: 'POST',
    token: bobToken,
    body: { content: 'color check' },
  });
  check(
    'message authors carry their role color',
    colorMessage.json?.author?.roleColor === 0xff0000,
    `got ${colorMessage.json?.author?.roleColor}`,
  );

  // --- Custom emoji ---
  const emojiPng = await sharp({
    create: { width: 24, height: 24, channels: 4, background: { r: 255, g: 200, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();

  const emojiForm = new FormData();
  emojiForm.append('name', 'party');
  emojiForm.append('file', new Blob([emojiPng], { type: 'image/png' }), 'party.png');
  const emojiUpload = await fetch(`${BASE}/emojis`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerToken}` },
    body: emojiForm,
  });
  const emoji = await emojiUpload.json();
  check('emoji uploads', emojiUpload.status === 200 && emoji?.name === 'party', `status ${emojiUpload.status}`);
  check('static emoji is not marked animated', emoji?.animated === false);

  const duplicateEmoji = new FormData();
  duplicateEmoji.append('name', 'party');
  duplicateEmoji.append('file', new Blob([emojiPng], { type: 'image/png' }), 'party.png');
  check(
    'duplicate emoji name rejected (409)',
    (
      await fetch(`${BASE}/emojis`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerToken}` },
        body: duplicateEmoji,
      })
    ).status === 409,
  );

  const shortName = new FormData();
  shortName.append('name', 'x');
  shortName.append('file', new Blob([emojiPng], { type: 'image/png' }), 'x.png');
  check(
    'invalid emoji name rejected (400)',
    (
      await fetch(`${BASE}/emojis`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerToken}` },
        body: shortName,
      })
    ).status === 400,
  );

  const notAnEmoji = new FormData();
  notAnEmoji.append('name', 'nope');
  notAnEmoji.append('file', new Blob([Buffer.from('plain text')], { type: 'text/plain' }), 'n.txt');
  check(
    'non-image emoji rejected (415)',
    (
      await fetch(`${BASE}/emojis`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerToken}` },
        body: notAnEmoji,
      })
    ).status === 415,
  );

  const emojiList = await req('/emojis', { token: bobToken });
  check(
    'members can list emoji',
    emojiList.status === 200 && emojiList.json?.emojis?.some((entry) => entry.name === 'party') === true,
  );

  const servedEmoji = await fetch(`${BASE}/emojis/${emoji.id}`, {
    headers: { authorization: `Bearer ${bobToken}` },
  });
  const servedEmojiBytes = Buffer.from(await servedEmoji.arrayBuffer());
  check(
    'emoji image is served back',
    servedEmoji.status === 200 &&
      servedEmoji.headers.get('content-type') === 'image/png' &&
      servedEmojiBytes.equals(emojiPng),
  );
  check('emoji images require auth (401)', (await fetch(`${BASE}/emojis/${emoji.id}`)).status === 401);

  const bobEmoji = new FormData();
  bobEmoji.append('name', 'bobemoji');
  bobEmoji.append('file', new Blob([emojiPng], { type: 'image/png' }), 'b.png');
  check(
    'member cannot upload emoji (403)',
    (
      await fetch(`${BASE}/emojis`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bobToken}` },
        body: bobEmoji,
      })
    ).status === 403,
  );
  check(
    'member cannot delete emoji (403)',
    (await req(`/emojis/${emoji.id}`, { method: 'DELETE', token: bobToken })).status === 403,
  );
  check(
    'owner deletes emoji',
    (await req(`/emojis/${emoji.id}`, { method: 'DELETE', token: ownerToken })).status === 204,
  );
  check(
    'deleted emoji is gone',
    (await req('/emojis', { token: ownerToken })).json?.emojis?.every((entry) => entry.name !== 'party') === true,
  );

  // --- Discord emoji import, with no bridge configured ---
  const discordEmoji = await req('/emojis/discord', { token: ownerToken });
  check(
    'the discord emoji preview reports no guild without a bridge',
    discordEmoji.status === 200 && discordEmoji.json?.guildName === null && discordEmoji.json?.emojis?.length === 0,
  );
  check('member cannot preview discord emoji (403)', (await req('/emojis/discord', { token: bobToken })).status === 403);
  check(
    'importing with no bridge connected reports 503',
    (await req('/emojis/import', { method: 'POST', token: ownerToken })).status === 503,
  );
  check(
    'member cannot import discord emoji (403)',
    (await req('/emojis/import', { method: 'POST', token: bobToken })).status === 403,
  );

  // --- Discord channel import, with no bridge configured ---
  const discordChannelPreview = await req('/channels/discord', { token: ownerToken });
  check(
    'the discord channel preview reports no guild without a bridge',
    discordChannelPreview.status === 200 &&
      discordChannelPreview.json?.guildName === null &&
      discordChannelPreview.json?.groups?.length === 0,
  );
  check(
    'member cannot preview discord channels (403)',
    (await req('/channels/discord', { token: bobToken })).status === 403,
  );
  check(
    'importing channels with no bridge connected reports 503',
    (await req('/channels/import', { method: 'POST', token: ownerToken })).status === 503,
  );
  check(
    'member cannot import discord channels (403)',
    (await req('/channels/import', { method: 'POST', token: bobToken })).status === 403,
  );

  // --- Retention and pruning ---
  const retention = await req('/retention', { token: ownerToken });
  check(
    'owner reads retention settings',
    retention.status === 200 &&
      retention.json?.settings?.imageRetentionDays === null &&
      retention.json?.settings?.auditRetentionDays === null,
  );
  check('retention reports usage', typeof retention.json?.usage?.blobBytes === 'number');
  check('member cannot read retention (403)', (await req('/retention', { token: bobToken })).status === 403);

  // The emoji was deleted earlier, so its blob is now orphaned on disk.
  const emojiBlobPath = join(dataDir, 'uploads', emoji.hash.slice(0, 2), emoji.hash);
  check('deleted emoji leaves an orphaned blob on disk', existsSync(emojiBlobPath));

  // Emergency pruning: a 1-byte limit forces everything out.
  const pruneUpload = new FormData();
  pruneUpload.append('file', new Blob([emojiPng], { type: 'image/png' }), 'prune.png');
  const pruneAttachment = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: pruneUpload,
    })
  ).json();
  await req(`/channels/${colorChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'will be pruned', attachmentIds: [pruneAttachment.id] },
  });
  const pruneBlobPath = join(dataDir, 'uploads', pruneAttachment.hash.slice(0, 2), pruneAttachment.hash);
  check('attachment blob exists before pruning', existsSync(pruneBlobPath));

  await req('/retention', {
    method: 'PATCH',
    token: ownerToken,
    body: { storageLimitBytes: 1, storageTargetBytes: 0 },
  });
  const emergency = await req('/retention/run', { method: 'POST', token: ownerToken });
  check(
    'emergency pruning deletes attachments',
    emergency.json?.summary?.deletedAttachments > 0,
    JSON.stringify(emergency.json?.summary),
  );
  check(
    'emergency pruning empties stored media',
    emergency.json?.usage?.blobBytes === 0,
    `bytes ${emergency.json?.usage?.blobBytes}`,
  );
  check('pruned attachment blob is removed', !existsSync(pruneBlobPath));
  check('orphaned emoji blob is swept', !existsSync(emojiBlobPath));

  await req('/retention', {
    method: 'PATCH',
    token: ownerToken,
    body: { storageLimitBytes: null, storageTargetBytes: null },
  });

  // Emergency pruning when the cap is out of reach: an emoji alone is over the
  // target, and pruning may never remove one. It should evict the attachment and
  // then stop, rather than delete messages that hold no bytes of their own.
  const keptEmojiForm = new FormData();
  keptEmojiForm.append('name', 'keeper');
  keptEmojiForm.append(
    'file',
    new Blob(
      [
        await sharp({
          create: { width: 24, height: 24, channels: 4, background: { r: 0, g: 120, b: 255, alpha: 1 } },
        })
          .png()
          .toBuffer(),
      ],
      { type: 'image/png' },
    ),
    'keeper.png',
  );
  const keptEmoji = await (
    await fetch(`${BASE}/emojis`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: keptEmojiForm,
    })
  ).json();
  const capUpload = new FormData();
  capUpload.append('file', new Blob([emojiPng], { type: 'image/png' }), 'cap.png');
  const capAttachment = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: capUpload,
    })
  ).json();
  const capMessage = await req(`/channels/${colorChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'outlives the storage cap', attachmentIds: [capAttachment.id] },
  });
  const messagesBeforeCap = (await req('/retention', { token: ownerToken })).json?.usage?.messageCount;

  await req('/retention', {
    method: 'PATCH',
    token: ownerToken,
    body: { storageLimitBytes: 1, storageTargetBytes: 0 },
  });
  const unreachable = await req('/retention/run', { method: 'POST', token: ownerToken });
  check(
    'unreachable storage cap still evicts attachments',
    unreachable.status === 200 && unreachable.json?.summary?.deletedAttachments > 0,
    JSON.stringify(unreachable.json?.summary),
  );
  check(
    'unreachable storage cap deletes no messages',
    unreachable.json?.summary?.deletedMessages === 0 && unreachable.json?.usage?.messageCount === messagesBeforeCap,
    JSON.stringify({ summary: unreachable.json?.summary, before: messagesBeforeCap, usage: unreachable.json?.usage }),
  );
  const capHistory = await req(`/channels/${colorChannel.id}/messages`, { token: ownerToken });
  check(
    'the message survives with only its attachment pruned',
    capHistory.json?.messages?.some(
      (message) => message.id === capMessage.json?.id && message.attachments?.length === 0,
    ) === true,
  );
  check(
    'the emoji holding the bytes is left alone',
    existsSync(join(dataDir, 'uploads', keptEmoji.hash.slice(0, 2), keptEmoji.hash)) &&
      unreachable.json?.usage?.blobBytes > 0,
  );

  await req('/retention', {
    method: 'PATCH',
    token: ownerToken,
    body: { storageLimitBytes: null, storageTargetBytes: null },
  });
  await req(`/emojis/${keptEmoji.id}`, { method: 'DELETE', token: ownerToken });

  // Age-based image retention.
  const ageUpload = new FormData();
  ageUpload.append('file', new Blob([emojiPng], { type: 'image/png' }), 'age.png');
  const ageAttachment = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: ageUpload,
    })
  ).json();
  await req(`/channels/${colorChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'aged image', attachmentIds: [ageAttachment.id] },
  });

  await req('/retention', { method: 'PATCH', token: ownerToken, body: { imageRetentionDays: 0 } });
  const aged = await req('/retention/run', { method: 'POST', token: ownerToken });
  check('image retention deletes old attachments', aged.json?.summary?.deletedAttachments > 0);
  check(
    'expired attachment is no longer served (404)',
    (
      await fetch(`${BASE}/attachments/${ageAttachment.id}`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).status === 404,
  );

  // Clip retention runs on its own schedule, independent of images.
  const clipUpload = new FormData();
  clipUpload.append('file', new Blob([MP4], { type: 'video/mp4' }), 'aged.mp4');
  const agedClip = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: clipUpload,
    })
  ).json();
  await req(`/channels/${colorChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'aged clip', attachmentIds: [agedClip.id] },
  });
  await req('/retention', { method: 'PATCH', token: ownerToken, body: { videoRetentionDays: 0 } });
  const clipPruned = await req('/retention/run', { method: 'POST', token: ownerToken });
  check('video retention deletes clips', clipPruned.json?.summary?.deletedAttachments > 0);
  check(
    'expired clip is no longer served (404)',
    (
      await fetch(`${BASE}/attachments/${agedClip.id}`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).status === 404,
  );

  // Age-based message retention.
  await req(`/channels/${colorChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'aged text' },
  });
  await req('/retention', { method: 'PATCH', token: ownerToken, body: { messageRetentionDays: 0 } });
  const msgPruned = await req('/retention/run', { method: 'POST', token: ownerToken });
  check('message retention deletes old messages', msgPruned.json?.summary?.deletedMessages > 0);
  check(
    'channel is empty after message retention',
    (await req(`/channels/${colorChannel.id}/messages`, { token: ownerToken })).json?.messages?.length === 0,
  );

  // Pinned and saved messages are outside the age rules on purpose: both are
  // somebody saying keep this, so retention must leave the message, and the
  // pictures and clips on it, alone, and emergency pruning must spare them too.
  const retentionPlainMsg = (
    await req(`/channels/${colorChannel.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'prune this text' },
    })
  ).json;
  const retentionPinnedMsg = (
    await req(`/channels/${colorChannel.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'keep this pinned' },
    })
  ).json;
  const retentionKeepUpload = new FormData();
  retentionKeepUpload.append('file', new Blob([emojiPng], { type: 'image/png' }), 'kept.png');
  const retentionKeepAttachment = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: retentionKeepUpload,
    })
  ).json();
  const retentionSavedMsg = (
    await req(`/channels/${colorChannel.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'keep this saved', attachmentIds: [retentionKeepAttachment.id] },
    })
  ).json;
  await req(`/channels/${colorChannel.id}/pins/${retentionPinnedMsg.id}`, { method: 'PUT', token: ownerToken });
  await req(`/users/@me/saved/${retentionSavedMsg.id}`, { method: 'PUT', token: ownerToken });

  await req('/retention', { method: 'PATCH', token: ownerToken, body: { messageRetentionDays: 0 } });
  const keptRun = await req('/retention/run', { method: 'POST', token: ownerToken });
  const afterKept = (await req(`/channels/${colorChannel.id}/messages`, { token: ownerToken })).json?.messages ?? [];
  const keptIds = new Set(afterKept.map((message) => message.id));
  check(
    'message retention still deletes an ordinary message',
    !keptIds.has(retentionPlainMsg.id),
    JSON.stringify(keptRun.json?.summary),
  );
  check('message retention spares a pinned message', keptIds.has(retentionPinnedMsg.id));
  check('message retention spares a saved message', keptIds.has(retentionSavedMsg.id));

  // The picture on the saved message outlives both the image rule and emergency
  // pruning, the way a saved gif does.
  await req('/retention', { method: 'PATCH', token: ownerToken, body: { imageRetentionDays: 0 } });
  await req('/retention/run', { method: 'POST', token: ownerToken });
  check(
    'an attachment on a saved message survives the image rule',
    (
      await fetch(`${BASE}/attachments/${retentionKeepAttachment.id}`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).status === 200,
  );
  await req('/retention', { method: 'PATCH', token: ownerToken, body: { storageLimitBytes: 1, storageTargetBytes: 0 } });
  await req('/retention/run', { method: 'POST', token: ownerToken });
  check(
    'emergency pruning spares an attachment on a saved message',
    (
      await fetch(`${BASE}/attachments/${retentionKeepAttachment.id}`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).status === 200,
  );

  // Put the scratch channel back the way the next block expects it: drop the pin
  // and the save, then let retention take the now-unprotected leftovers.
  await req(`/channels/${colorChannel.id}/pins/${retentionPinnedMsg.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/users/@me/saved/${retentionSavedMsg.id}`, { method: 'DELETE', token: ownerToken });
  await req('/retention', {
    method: 'PATCH',
    token: ownerToken,
    body: { imageRetentionDays: 0, messageRetentionDays: 0, storageLimitBytes: null, storageTargetBytes: null },
  });
  await req('/retention/run', { method: 'POST', token: ownerToken });

  // --- Saved gifs ---
  // Reset the age rules so this block is about the rule for favorites, not the
  // image and message ones that ran above.
  await req('/retention', {
    method: 'PATCH',
    token: ownerToken,
    body: { imageRetentionDays: null, messageRetentionDays: null },
  });

  // A gif, as far as the picker is concerned: only the type matters, and this is
  // the only thing that decides whether a picture is offered.
  const keeperPng = await sharp({
    create: { width: 17, height: 11, channels: 4, background: { r: 9, g: 200, b: 90, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const keeperForm = new FormData();
  keeperForm.append('file', new Blob([keeperPng], { type: 'image/gif' }), 'keeper.gif');
  const keeperAttachment = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: keeperForm,
    })
  ).json();
  const keeperBlobPath = join(dataDir, 'uploads', keeperAttachment.hash.slice(0, 2), keeperAttachment.hash);
  const keeperMessage = await req(`/channels/${colorChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'a keeper', attachmentIds: [keeperAttachment.id] },
  });

  const favorited = await req('/gifs/favorites', {
    method: 'POST',
    token: ownerToken,
    body: { attachmentId: keeperAttachment.id },
  });
  check(
    'a gif can be saved',
    favorited.status === 200 && favorited.json?.hash === keeperAttachment.hash,
    `status ${favorited.status}`,
  );
  const favoritedAgain = await req('/gifs/favorites', {
    method: 'POST',
    token: ownerToken,
    body: { attachmentId: keeperAttachment.id },
  });
  check('saving the same gif twice keeps one row', favoritedAgain.json?.id === favorited.json?.id);
  check(
    'the saved gif is listed',
    (await req('/gifs/favorites', { token: ownerToken })).json?.favorites?.length === 1,
  );
  check(
    'a member sees only their own saved gifs',
    (await req('/gifs/favorites', { token: bobToken })).json?.favorites?.length === 0,
  );
  check(
    'the saved gif is served',
    (await fetch(`${BASE}/gifs/favorites/${favorited.json.id}/image`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    })).status === 200,
  );
  check(
    'somebody else cannot fetch a saved gif (404)',
    (await fetch(`${BASE}/gifs/favorites/${favorited.json.id}/image`, {
      headers: { authorization: `Bearer ${bobToken}` },
    })).status === 404,
  );
  check(
    'somebody else cannot pick a saved gif (404)',
    (await req('/gifs/pick', { method: 'POST', token: bobToken, body: { favoriteId: favorited.json.id } })).status === 404,
  );

  // The local tab lists what the instance already holds, one per picture.
  const localList = await req('/gifs/local', { token: ownerToken });
  const localKeeper = localList.json?.gifs?.find((gif) => gif.hash === keeperAttachment.hash);
  check('the local list offers gifs the instance holds', localKeeper !== undefined);
  check('and marks the ones this member saved', localKeeper?.favoriteId === favorited.json.id);
  check(
    'the local list can be searched by name',
    (await req('/gifs/local?q=keeper', { token: ownerToken })).json?.gifs?.some(
      (gif) => gif.hash === keeperAttachment.hash,
    ) === true,
  );

  // A gif in a channel a member cannot see must not reach their picker either.
  const gifRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Gif Keepers' } });
  const hiddenGifChannel = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'hidden-gifs', requiredRoleId: gifRole.json.id },
  });
  const hiddenPng = await sharp({
    create: { width: 19, height: 13, channels: 4, background: { r: 210, g: 20, b: 130, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const hiddenForm = new FormData();
  hiddenForm.append('file', new Blob([hiddenPng], { type: 'image/gif' }), 'hidden.gif');
  const hiddenAttachment = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: hiddenForm,
    })
  ).json();
  await req(`/channels/${hiddenGifChannel.json.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'a gif behind a role', attachmentIds: [hiddenAttachment.id] },
  });
  check(
    'a gif in a locked channel is not in a member picker',
    (await req('/gifs/local', { token: bobToken })).json?.gifs?.every(
      (gif) => gif.hash !== hiddenAttachment.hash,
    ) === true,
  );
  check(
    'an administrator sees it',
    (await req('/gifs/local', { token: ownerToken })).json?.gifs?.some(
      (gif) => gif.hash === hiddenAttachment.hash,
    ) === true,
  );
  check(
    'a locked gif cannot be saved by somebody who cannot see it (404)',
    (
      await req('/gifs/favorites', {
        method: 'POST',
        token: bobToken,
        body: { attachmentId: hiddenAttachment.id },
      })
    ).status === 404,
  );

  // The same again for an age-gated section locked at the category, which is how
  // a server with channels minors must not see tends to be arranged.
  const gifCategory = await req('/categories', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Grown-up gifs', requiredRoleId: gifRole.json.id },
  });
  const behindCategory = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'behind-the-category', categoryId: gifCategory.json.id },
  });
  const adultPng = await sharp({
    create: { width: 31, height: 17, channels: 4, background: { r: 120, g: 10, b: 60, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const adultForm = new FormData();
  adultForm.append('file', new Blob([adultPng], { type: 'image/gif' }), 'grown-up.gif');
  const adultAttachment = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: adultForm,
    })
  ).json();
  await req(`/channels/${behindCategory.json.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'behind a category', attachmentIds: [adultAttachment.id] },
  });
  check(
    'a gif in a category-locked channel is not in a member picker',
    (await req('/gifs/local', { token: bobToken })).json?.gifs?.every(
      (gif) => gif.hash !== adultAttachment.hash,
    ) === true,
  );
  check(
    'and an administrator sees it',
    (await req('/gifs/local', { token: ownerToken })).json?.gifs?.some(
      (gif) => gif.hash === adultAttachment.hash,
    ) === true,
  );

  // The picker is gif-only: a screenshot or a photo is not something anybody
  // browses a picker for, so it is neither offered nor savable.
  const plainPng = await sharp({
    create: { width: 23, height: 29, channels: 4, background: { r: 240, g: 240, b: 240, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const plainForm = new FormData();
  plainForm.append('file', new Blob([plainPng], { type: 'image/png' }), 'plain.png');
  const plainAttachment = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: plainForm,
    })
  ).json();
  await req(`/channels/${colorChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'just a picture', attachmentIds: [plainAttachment.id] },
  });
  check(
    'a plain picture is not offered by the gif picker',
    (await req('/gifs/local', { token: ownerToken })).json?.gifs?.every(
      (gif) => gif.hash !== plainAttachment.hash,
    ) === true,
  );
  check(
    'and a plain picture cannot be saved as one (400)',
    (
      await req('/gifs/favorites', {
        method: 'POST',
        token: ownerToken,
        body: { attachmentId: plainAttachment.id },
      })
    ).status === 400,
  );

  // Picking only makes an attachment; the message it goes into is sent normally.
  const picked = await req('/gifs/pick', {
    method: 'POST',
    token: ownerToken,
    body: { favoriteId: favorited.json.id },
  });
  check(
    'a saved gif can be picked into a message',
    picked.status === 200 && picked.json?.hash === keeperAttachment.hash,
    `status ${picked.status}`,
  );
  check(
    'the picked gif can be sent',
    (await req(`/channels/${colorChannel.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: '', attachmentIds: [picked.json.id] },
    })).status === 200,
  );

  // The message it was found in goes away; the saved gif must not.
  await req(`/messages/${keeperMessage.json.id}`, { method: 'DELETE', token: ownerToken });
  check(
    'a saved gif outlives the message it was found in',
    (await req('/gifs/favorites', { token: ownerToken })).json?.favorites?.length === 1,
  );
  check('and its bytes are still on disk', existsSync(keeperBlobPath));

  // Even wiping every image attachment leaves a saved gif alone.
  await req('/retention', { method: 'PATCH', token: ownerToken, body: { imageRetentionDays: 0 } });
  await req('/retention/run', { method: 'POST', token: ownerToken });
  check('a saved gif survives the image rule', existsSync(keeperBlobPath));

  // It has a rule of its own, and only that rule ever ages it out.
  await req('/retention', {
    method: 'PATCH',
    token: ownerToken,
    body: { imageRetentionDays: null, favoriteRetentionDays: 0 },
  });
  const favoritesPruned = await req('/retention/run', { method: 'POST', token: ownerToken });
  check(
    'the saved-gif rule retires an unused gif',
    favoritesPruned.json?.summary?.deletedFavorites >= 1,
    JSON.stringify(favoritesPruned.json?.summary),
  );
  check('and its bytes are swept', !existsSync(keeperBlobPath));
  check(
    'the list is empty again',
    (await req('/gifs/favorites', { token: ownerToken })).json?.favorites?.length === 0,
  );
  await req('/retention', { method: 'PATCH', token: ownerToken, body: { favoriteRetentionDays: null } });

  // --- Server gifs: the administrators' curated list on the picker's Server tab ---
  {
    const bobMe = await req('/auth/me', { token: bobToken });
    const bobUserId = bobMe.json.user.id;
    const solid = (r, g, b, w, h) =>
      sharp({ create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toBuffer();
    // As elsewhere in this file, a "gif" is a picture whose declared type is gif.
    const uploadGif = async (token, bytes, filename) => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'image/gif' }), filename);
      return (
        await fetch(`${BASE}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form })
      ).json();
    };
    const blobOf = (hash) => join(dataDir, 'uploads', hash.slice(0, 2), hash);
    const serverList = async (token, q = '') =>
      (await req(`/gifs/server${q ? `?q=${encodeURIComponent(q)}` : ''}`, { token })).json?.gifs ?? [];

    // Three gifs posted to a channel everybody sees, so they appear in the auto list.
    const autoA = await uploadGif(ownerToken, await solid(11, 22, 33, 14, 9), 'auto-alpha.gif');
    const autoB = await uploadGif(ownerToken, await solid(44, 55, 66, 15, 9), 'auto-bravo.gif');
    const autoC = await uploadGif(ownerToken, await solid(77, 88, 99, 16, 9), 'auto-charlie.gif');
    const sgMessage = await req(`/channels/${colorChannel.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'server gif candidates', attachmentIds: [autoA.id, autoB.id, autoC.id] },
    });
    check('server gifs: the candidate gifs were posted', sgMessage.status === 200, `status ${sgMessage.status}`);

    // Permissions: reading is for anyone with the picker, changing is ManageEmojis.
    check('server gifs: a member reads the Server tab', (await req('/gifs/server', { token: bobToken })).status === 200);
    check('server gifs: the Server tab needs a session (401)', (await req('/gifs/server')).status === 401);
    check(
      'server gifs: a member cannot curate (403)',
      (await req('/gifs/server', { method: 'POST', token: bobToken, body: { attachmentId: autoA.id } })).status === 403,
    );
    check('server gifs: a member cannot open the admin view (403)', (await req('/gifs/server/manage', { token: bobToken })).status === 403);
    check(
      'server gifs: a member cannot hide an auto gif (403)',
      (await req('/gifs/server/hide', { method: 'POST', token: bobToken, body: { attachmentId: autoA.id } })).status === 403,
    );

    // Before any curation the tab is the auto list.
    const before = await serverList(bobToken);
    check(
      'server gifs: with nothing curated the tab is the auto-collected list',
      before.length >= 3 && before.every((gif) => gif.source === 'auto') && before.some((gif) => gif.hash === autoA.hash),
    );

    // Curate bravo and alpha (in that order), pin charlie.
    const addB = await req('/gifs/server', {
      method: 'POST',
      token: ownerToken,
      body: { attachmentId: autoB.id, name: 'Bravo Wave', tags: ['Hello', 'wave', 'hello'] },
    });
    check(
      'server gifs: an administrator curates a gif from an attachment',
      addB.status === 200 && addB.json?.kind === 'curated' && addB.json?.hash === autoB.hash && addB.json?.name === 'Bravo Wave',
      JSON.stringify(addB.json),
    );
    check('server gifs: tags are lower-cased and de-duplicated', JSON.stringify(addB.json?.tags) === JSON.stringify(['hello', 'wave']));
    const addA = await req('/gifs/server', { method: 'POST', token: ownerToken, body: { attachmentId: autoA.id } });
    check('server gifs: a missing name falls back to the filename', addA.json?.name === 'auto-alpha');
    check(
      'server gifs: the same picture cannot be curated twice (409)',
      (await req('/gifs/server', { method: 'POST', token: ownerToken, body: { attachmentId: autoB.id } })).status === 409,
    );
    check(
      'server gifs: naming two references is refused (400)',
      (await req('/gifs/server', { method: 'POST', token: ownerToken, body: { attachmentId: autoC.id, url: 'https://static.klipy.com/x.gif' } })).status === 400,
    );
    const plainForm = new FormData();
    plainForm.append('file', new Blob([await solid(5, 6, 7, 12, 12)], { type: 'image/png' }), 'still.png');
    const stillAttachment = await (
      await fetch(`${BASE}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${ownerToken}` }, body: plainForm })
    ).json();
    check(
      'server gifs: a plain picture cannot be curated (400)',
      (await req('/gifs/server', { method: 'POST', token: ownerToken, body: { attachmentId: stillAttachment.id } })).status === 400,
    );
    check(
      'server gifs: an unknown attachment is a 404',
      (await req('/gifs/server', { method: 'POST', token: ownerToken, body: { attachmentId: 'nope' } })).status === 404,
    );

    // Ordering: curated first (position order), pinned above the rest, auto afterwards.
    let tab = await serverList(bobToken);
    const sources = tab.map((gif) => gif.source);
    check(
      'server gifs: curated gifs come first, then the auto ones',
      sources.indexOf('auto') === 2 && sources.slice(0, 2).every((source) => source === 'curated'),
      sources.join(','),
    );
    check('server gifs: curated gifs keep the order they were added in', tab[0]?.hash === autoB.hash && tab[1]?.hash === autoA.hash);
    check(
      'server gifs: a curated gif is not repeated in the auto part',
      tab.filter((gif) => gif.hash === autoB.hash).length === 1,
    );

    const pinA = await req(`/gifs/server/${addA.json.id}`, { method: 'PATCH', token: ownerToken, body: { pinned: true } });
    check('server gifs: a gif can be pinned', pinA.status === 200 && pinA.json?.pinned === true);
    tab = await serverList(bobToken);
    check('server gifs: a pinned gif jumps ahead of the others', tab[0]?.hash === autoA.hash && tab[0]?.pinned === true);

    const reordered = await req('/gifs/server/order', { method: 'POST', token: ownerToken, body: { ids: [addB.json.id, addA.json.id] } });
    check('server gifs: the order can be set (204)', reordered.status === 204);
    tab = await serverList(bobToken);
    check('server gifs: pinned still outranks position after a reorder', tab[0]?.hash === autoA.hash);
    await req(`/gifs/server/${addA.json.id}`, { method: 'PATCH', token: ownerToken, body: { pinned: false } });
    tab = await serverList(bobToken);
    check('server gifs: unpinned, the explicit order stands', tab[0]?.hash === autoB.hash && tab[1]?.hash === autoA.hash);
    check(
      'server gifs: a rename and new tags are saved',
      (await req(`/gifs/server/${addA.json.id}`, { method: 'PATCH', token: ownerToken, body: { name: 'Alpha Cat', tags: ['feline'] } })).json?.name === 'Alpha Cat',
    );
    check(
      'server gifs: an empty change is refused (400)',
      (await req(`/gifs/server/${addA.json.id}`, { method: 'PATCH', token: ownerToken, body: {} })).status === 400,
    );
    check(
      'server gifs: a member cannot edit one (403)',
      (await req(`/gifs/server/${addA.json.id}`, { method: 'PATCH', token: bobToken, body: { name: 'x' } })).status === 403,
    );

    // Search matches the name, the tags and the filename.
    check('server gifs: search finds a gif by its name', (await serverList(bobToken, 'alpha cat')).some((gif) => gif.hash === autoA.hash));
    check('server gifs: search finds a gif by its tag', (await serverList(bobToken, 'feline'))[0]?.hash === autoA.hash);
    check('server gifs: search finds a gif by its filename', (await serverList(bobToken, 'bravo')).some((gif) => gif.hash === autoB.hash));
    check(
      'server gifs: a search with no match is empty',
      (await serverList(bobToken, 'zzzz-nothing')).length === 0,
    );

    // Hiding: gone from the auto list for everybody, restorable.
    check(
      'server gifs: an administrator hides an auto gif',
      (await req('/gifs/server/hide', { method: 'POST', token: ownerToken, body: { attachmentId: autoC.id } })).json?.kind === 'hidden',
    );
    check('server gifs: a hidden gif is gone from a member\'s tab', (await serverList(bobToken)).every((gif) => gif.hash !== autoC.hash));
    check('server gifs: and from the administrator\'s own tab', (await serverList(ownerToken)).every((gif) => gif.hash !== autoC.hash));
    const manage = await req('/gifs/server/manage', { token: ownerToken });
    const hiddenRow = manage.json?.hidden?.find((gif) => gif.hash === autoC.hash);
    check('server gifs: the admin view lists the hidden gif', hiddenRow !== undefined);
    check(
      'server gifs: and the curated ones in order, with no auto duplicates',
      manage.json?.curated?.length === 2 && manage.json?.auto?.every((gif) => gif.hash !== autoC.hash && gif.hash !== autoA.hash),
    );
    check(
      'server gifs: hiding a curated gif is refused (409)',
      (await req('/gifs/server/hide', { method: 'POST', token: ownerToken, body: { attachmentId: autoA.id } })).status === 409,
    );
    check(
      'server gifs: a hidden gif cannot be sent from the Server tab (404)',
      (await req(`/gifs/server/${hiddenRow.id}/pick`, { method: 'POST', token: ownerToken })).status === 404,
    );
    check(
      'server gifs: a hidden gif is still in the raw local list (unchanged endpoint)',
      (await req('/gifs/local', { token: ownerToken })).json?.gifs?.some((gif) => gif.hash === autoC.hash) === true,
    );

    // A gif in a locked channel stays invisible to non-members in every list, hidden or not.
    const lockRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Server Gif Lock' } });
    const lockedGifChannel = await req('/channels', {
      method: 'POST',
      token: ownerToken,
      body: { name: 'server-gif-lock', requiredRoleId: lockRole.json.id },
    });
    const lockedGif = await uploadGif(ownerToken, await solid(201, 202, 203, 18, 9), 'locked-away.gif');
    await req(`/channels/${lockedGifChannel.json.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'secret gif', attachmentIds: [lockedGif.id] },
    });
    check('server gifs: a locked channel\'s gif is not on a member\'s tab', (await serverList(bobToken)).every((gif) => gif.hash !== lockedGif.hash));
    check('server gifs: an administrator sees it', (await serverList(ownerToken)).some((gif) => gif.hash === lockedGif.hash));
    // Curating it is the administrator's deliberate act, which is what publishes it.
    // Hiding or curating by a member who cannot see the attachment is refused outright.
    const reader = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Gif Curators', permissions: String(1n << 8n) } });
    await req(`/members/${bobUserId}/roles/${reader.json.id}`, { method: 'PUT', token: ownerToken });
    check(
      'server gifs: a curator cannot hide a gif they cannot see (404)',
      (await req('/gifs/server/hide', { method: 'POST', token: bobToken, body: { attachmentId: lockedGif.id } })).status === 404,
    );
    check(
      'server gifs: a curator cannot curate a gif they cannot see (404)',
      (await req('/gifs/server', { method: 'POST', token: bobToken, body: { attachmentId: lockedGif.id } })).status === 404,
    );
    check(
      'server gifs: a curator (ManageEmojis) can open the admin view',
      (await req('/gifs/server/manage', { token: bobToken })).json?.auto?.every((gif) => gif.hash !== lockedGif.hash) === true,
    );
    await req(`/members/${bobUserId}/roles/${reader.json.id}`, { method: 'DELETE', token: ownerToken });
    check('server gifs: losing the role loses the access (403)', (await req('/gifs/server/manage', { token: bobToken })).status === 403);

    // The image route and picking.
    const imageOf = (id, token) => fetch(`${BASE}/gifs/server/${id}/image`, { headers: { authorization: `Bearer ${token}` } });
    const curatedImage = await imageOf(addB.json.id, bobToken);
    check(
      'server gifs: a curated gif is served to any member',
      curatedImage.status === 200 && curatedImage.headers.get('content-type') === 'image/gif',
    );
    const picked = await req(`/gifs/server/${addB.json.id}/pick`, { method: 'POST', token: bobToken });
    check('server gifs: a member can pick one into a message', picked.status === 200 && picked.json?.hash === autoB.hash, `status ${picked.status}`);
    check(
      'server gifs: and send it',
      (await req(`/channels/${colorChannel.id}/messages`, { method: 'POST', token: bobToken, body: { content: '', attachmentIds: [picked.json.id] } })).status === 200,
    );

    // The gateway tells open pickers to refresh.
    const sgSocket = await openGateway({ token: bobToken });
    const sgBefore = sgSocket.events.length;
    const addCForEvent = await req('/gifs/server', { method: 'POST', token: ownerToken, body: { attachmentId: autoC.id, name: 'Charlie' } });
    await sleep(300);
    check(
      'server gifs: a change reaches connected members as SERVER_GIFS_UPDATE',
      sgSocket.events.slice(sgBefore).some((frame) => frame.t === 'SERVER_GIFS_UPDATE'),
    );
    check('server gifs: curating a hidden gif promotes it', addCForEvent.json?.id === hiddenRow.id && addCForEvent.json?.kind === 'curated');
    sgSocket.ws.close();

    // Retention: a curated gif's blob outlives its message, the image rule, and the emergency limit.
    await req(`/messages/${sgMessage.json.id}`, { method: 'DELETE', token: ownerToken });
    await req('/retention', { method: 'PATCH', token: ownerToken, body: { imageRetentionDays: 0 } });
    await req('/retention/run', { method: 'POST', token: ownerToken });
    check('server gifs: a curated gif survives the image rule', existsSync(blobOf(autoB.hash)) && existsSync(blobOf(autoA.hash)));
    await req('/retention', { method: 'PATCH', token: ownerToken, body: { imageRetentionDays: null, storageLimitBytes: 1, storageTargetBytes: 0 } });
    await req('/retention/run', { method: 'POST', token: ownerToken });
    check('server gifs: and the emergency storage limit', existsSync(blobOf(autoB.hash)) && existsSync(blobOf(autoA.hash)));
    await req('/retention', { method: 'PATCH', token: ownerToken, body: { storageLimitBytes: null, storageTargetBytes: null } });
    check(
      'server gifs: a curated gif is still served after retention',
      (await imageOf(addA.json.id, bobToken)).status === 200 && (await serverList(bobToken)).some((gif) => gif.hash === autoA.hash),
    );

    // A hidden-only gif holds nothing: once its message is gone its bytes go.
    const hideOnly = await uploadGif(ownerToken, await solid(130, 131, 132, 13, 9), 'hide-only.gif');
    const hideOnlyMessage = await req(`/channels/${colorChannel.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'to be hidden', attachmentIds: [hideOnly.id] },
    });
    await req('/gifs/server/hide', { method: 'POST', token: ownerToken, body: { attachmentId: hideOnly.id } });
    await req(`/messages/${hideOnlyMessage.json.id}`, { method: 'DELETE', token: ownerToken });
    await req('/retention', { method: 'PATCH', token: ownerToken, body: { imageRetentionDays: 0 } });
    await req('/retention/run', { method: 'POST', token: ownerToken });
    await req('/retention', { method: 'PATCH', token: ownerToken, body: { imageRetentionDays: null } });
    check('server gifs: hiding does not keep a gif\'s bytes alive', !existsSync(blobOf(hideOnly.hash)));
    check('server gifs: while the curated ones are still on disk', existsSync(blobOf(autoB.hash)));

    // Removing: the row goes, then the next sweep takes the bytes (nothing else holds them).
    check('server gifs: a member cannot remove one (403)', (await req(`/gifs/server/${addB.json.id}`, { method: 'DELETE', token: bobToken })).status === 403);
    check('server gifs: an administrator removes one (204)', (await req(`/gifs/server/${addB.json.id}`, { method: 'DELETE', token: ownerToken })).status === 204);
    check('server gifs: removing an unknown one is a 404', (await req(`/gifs/server/${addB.json.id}`, { method: 'DELETE', token: ownerToken })).status === 404);
    check('server gifs: a removed gif is no longer served (404)', (await imageOf(addB.json.id, bobToken)).status === 404);
    check('server gifs: and is off the tab', (await serverList(bobToken)).every((gif) => gif.hash !== autoB.hash));
    await req('/retention/run', { method: 'POST', token: ownerToken });
    check('server gifs: its bytes are swept once nothing holds them', !existsSync(blobOf(autoB.hash)));
    check('server gifs: the other curated gifs keep theirs', existsSync(blobOf(autoA.hash)));

    // Restoring a hidden gif that still has a message: it returns to the auto list.
    const restoreGif = await uploadGif(ownerToken, await solid(150, 151, 152, 13, 11), 'restore-me.gif');
    await req(`/channels/${colorChannel.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'restore me', attachmentIds: [restoreGif.id] },
    });
    const hiddenRestore = await req('/gifs/server/hide', { method: 'POST', token: ownerToken, body: { attachmentId: restoreGif.id } });
    check('server gifs: the gif is hidden', (await serverList(bobToken)).every((gif) => gif.hash !== restoreGif.hash));
    check('server gifs: un-hiding is a delete of the hidden row (204)', (await req(`/gifs/server/${hiddenRestore.json.id}`, { method: 'DELETE', token: ownerToken })).status === 204);
    check('server gifs: and it is back in the auto list', (await serverList(bobToken)).some((gif) => gif.hash === restoreGif.hash && gif.source === 'auto'));

    // The audit log records adds, removals, hides and restores.
    const auditKinds = (await req('/audit?limit=100', { token: ownerToken })).json?.entries?.map((entry) => entry.kind) ?? [];
    for (const kind of ['server_gif_add', 'server_gif_remove', 'server_gif_hide', 'server_gif_unhide']) {
      check(`server gifs: the audit log records ${kind}`, auditKinds.includes(kind));
    }
    const removeEntry = (await req('/audit?limit=100', { token: ownerToken })).json?.entries?.find((entry) => entry.kind === 'server_gif_remove');
    check('server gifs: a removal names the gif', removeEntry?.detail?.gifName === 'Bravo Wave' && removeEntry?.actor !== null);

    // Adding from a member's favorite.
    const favSource = await uploadGif(ownerToken, await solid(170, 171, 172, 10, 10), 'from-fav.gif');
    await req(`/channels/${colorChannel.id}/messages`, { method: 'POST', token: ownerToken, body: { content: 'fav', attachmentIds: [favSource.id] } });
    const fav = await req('/gifs/favorites', { method: 'POST', token: ownerToken, body: { attachmentId: favSource.id } });
    const fromFav = await req('/gifs/server', { method: 'POST', token: ownerToken, body: { favoriteId: fav.json.id } });
    check('server gifs: a favorite can be curated', fromFav.status === 200 && fromFav.json?.hash === favSource.hash);
    check(
      'server gifs: only your own favorite (404)',
      (await req('/gifs/server', { method: 'POST', token: ownerToken, body: { favoriteId: 'not-mine' } })).status === 404,
    );
    // The real service refuses a non-Klipy address before any fetch is made.
    check(
      'server gifs: an address outside the hosted service is refused (400)',
      (await req('/gifs/server', { method: 'POST', token: ownerToken, body: { url: 'http://127.0.0.1:1/x.gif' } })).status === 400,
    );
    check(
      'server gifs: a lookalike host is refused (400)',
      (await req('/gifs/server', { method: 'POST', token: ownerToken, body: { url: 'https://klipy.com.evil.test/x.gif' } })).status === 400,
    );
  }

  // The same service in process, with a fake network, for the hosted-address path.
  {
    const sgDir = mkdtempSync(join(tmpdir(), 'harmony-servergifs-'));
    const sgDb = new Database({ dataDir: sgDir, dbFile: join(sgDir, 'sg.db'), uploadDir: join(sgDir, 'uploads') });
    const sgSettings = createSettingsService(sgDb.sqlite, { serverName: 'Test', requireInvite: false });
    const sgAttachments = createAttachmentService(sgDb.sqlite, { uploadDir: join(sgDir, 'uploads') }, sgSettings);
    insertUser(sgDb.sqlite, { id: 'u1', username: 'owner', passwordHash: 'x', isOwner: true });

    const sgAudit = [];
    const sgEvents = [];
    const fetched = [];
    const gifBytes = await sharp({ create: { width: 21, height: 13, channels: 4, background: { r: 3, g: 99, b: 200, alpha: 1 } } })
      .png()
      .toBuffer();
    let response = { data: gifBytes, contentType: 'image/gif' };
    const service = createServerGifService(sgDb.sqlite, {
      attachments: sgAttachments,
      gifs: { listLocal: () => [] },
      audit: { serverGif: (kind, actorId, filename, gifName) => sgAudit.push({ kind, actorId, filename, gifName }) },
      hub: { dispatch: (event) => sgEvents.push(event) },
      fetchImage: async (url) => {
        fetched.push(url);
        return response;
      },
    });
    const auth = { user: { id: 'u1' }, permissions: 0n, sessionId: 's', token: 't' };
    const rejection = async (input) => {
      try {
        await service.add(auth, input);
        return 0;
      } catch (error) {
        return error.statusCode ?? -1;
      }
    };

    check('server gifs (fake network): an address outside the service is refused before any fetch', (await rejection({ url: 'https://example.com/a.gif' })) === 400 && fetched.length === 0);
    check('server gifs (fake network): a look-alike host is refused before any fetch', (await rejection({ url: 'https://klipy.com.evil.test/a.gif' })) === 400 && fetched.length === 0);
    check('server gifs (fake network): an unusable address is refused', (await rejection({ url: 'not a url' })) === 400);

    response = null;
    check('server gifs (fake network): a failed fetch is a 415', (await rejection({ url: 'https://static.klipy.com/ii/a/b/cat.gif' })) === 415);
    response = { data: gifBytes, contentType: 'image/png' };
    check('server gifs (fake network): a non-gif answer is a 415', (await rejection({ url: 'https://static.klipy.com/ii/a/b/cat.gif' })) === 415);
    response = { data: Buffer.from('not an image at all'), contentType: 'image/gif' };
    check('server gifs (fake network): bytes that are not an image are refused', (await rejection({ url: 'https://static.klipy.com/ii/a/b/cat.gif' })) === 413);

    response = { data: gifBytes, contentType: 'image/gif' };
    const added = await service.add(auth, { url: 'https://static.klipy.com/ii/a/b/cat%20dance.gif', tags: ['Dance'] });
    check(
      'server gifs (fake network): a hosted gif is fetched and stored as curated',
      added.kind === 'curated' && added.filename === 'cat dance.gif' && added.width === 21 && added.height === 13 && fetched.length >= 1,
      JSON.stringify(added),
    );
    check(
      'server gifs (fake network): the copy is on disk, so link rot cannot touch it',
      existsSync(join(sgDir, 'uploads', added.hash.slice(0, 2), added.hash)),
    );
    check('server gifs (fake network): it was audited and announced', sgAudit.some((entry) => entry.kind === 'server_gif_add' && entry.filename === 'cat dance.gif') && sgEvents.includes('SERVER_GIFS_UPDATE'));
    check('server gifs (fake network): fetching the same gif again is a conflict', (await rejection({ url: 'https://static.klipy.com/ii/a/b/cat%20dance.gif' })) === 409);
    check('server gifs (fake network): the listing shows it with its tags', service.list(auth, { limit: 10 }).some((gif) => gif.hash === added.hash && gif.tags.includes('dance')));

    // The reference counting: the bytes belong to the curated row alone.
    const { listReferencedHashes } = await import('../src/db/attachments.ts');
    check('server gifs (fake network): a curated hash counts as referenced', listReferencedHashes(sgDb.sqlite).has(added.hash));
    service.remove(auth, added.id);
    check('server gifs (fake network): a removed one no longer does', !listReferencedHashes(sgDb.sqlite).has(added.hash));

    sgDb.close();
    rmSync(sgDir, { recursive: true, force: true });
  }

  // --- Hosted gif service ---
  check('the hosted tab is off by default', (await req('/meta')).json?.klipyConfigured === false);
  check(
    'and its search has nothing to offer',
    (await req('/gifs/klipy', { token: ownerToken })).json?.gifs?.length === 0,
  );
  const withKey = await req('/settings', { method: 'PATCH', token: ownerToken, body: { klipyApiKey: 'test-key' } });
  check('setting a key turns the hosted tab on', withKey.json?.klipyConfigured === true);
  check('and the key itself is never sent back', withKey.json?.klipyApiKey === undefined);
  check('the public meta agrees', (await req('/meta')).json?.klipyConfigured === true);
  check(
    'a member cannot set a key (403)',
    (await req('/settings', { method: 'PATCH', token: bobToken, body: { klipyApiKey: 'nope' } })).status === 403,
  );
  const withoutKey = await req('/settings', { method: 'PATCH', token: ownerToken, body: { klipyApiKey: '' } });
  check('clearing the key takes the tab away', withoutKey.json?.klipyConfigured === false);

  // --- Gif storage: store a copy (default) or link to allowlisted gif hosts ---
  const cspOf = async () => (await fetch(`${BASE}/health`)).headers.get('content-security-policy') ?? '';
  const directive = (csp, name) => csp.split('; ').find((entry) => entry.startsWith(`${name} `)) ?? '';
  check('gifs are stored by default', (await req('/meta')).json?.gifStorage === 'store');
  const storeCsp = await cspOf();
  check(
    'so the policy lets the page load only its own images and media',
    !directive(storeCsp, 'img-src').includes('tenor') && !directive(storeCsp, 'media-src').includes('giphy'),
    storeCsp,
  );
  check(
    'linking is refused while the instance stores (409)',
    (await req('/gifs/link', { method: 'POST', token: ownerToken, body: { url: 'https://media.tenor.com/x/y.gif' } })).status === 409,
  );
  check(
    'an unknown storage mode is refused (400)',
    (await req('/settings', { method: 'PATCH', token: ownerToken, body: { gifStorage: 'hotlink' } })).status === 400,
  );
  check(
    'a member cannot change it (403)',
    (await req('/settings', { method: 'PATCH', token: bobToken, body: { gifStorage: 'link' } })).status === 403,
  );

  const linkOn = await req('/settings', { method: 'PATCH', token: ownerToken, body: { gifStorage: 'link' } });
  check('an admin can switch to linking', linkOn.json?.gifStorage === 'link' && (await req('/meta')).json?.gifStorage === 'link');
  const linkCsp = await cspOf();
  for (const source of ['https://media.tenor.com', 'https://media1.tenor.com', 'https://media.giphy.com', 'https://*.klipy.com']) {
    check(
      `linking opens images and media to ${source}`,
      directive(linkCsp, 'img-src').includes(source) && directive(linkCsp, 'media-src').includes(source),
      linkCsp,
    );
  }
  check(
    'and nothing else in the policy changes',
    linkCsp.replace(/(img|media)-src [^;]*/g, '') === storeCsp.replace(/(img|media)-src [^;]*/g, '') &&
      directive(linkCsp, 'script-src') === "script-src 'self'" &&
      directive(linkCsp, 'connect-src') === "connect-src 'self'" &&
      !linkCsp.includes('*.giphy.com'),
  );
  for (const bad of [
    'https://example.com/cat.gif',
    'http://media.tenor.com/x/y.gif',
    'https://media.tenor.com.evil.test/x.gif',
    'https://evilklipy.com/x.gif',
    'https://klipy.com/gifs/page',
    'https://user:pw@media.tenor.com/x.gif',
    'https://media.tenor.com:8443/x.gif',
    'https://cdn.discordapp.com/attachments/1/2/x.gif',
    'not a url',
  ]) {
    const refused = await req('/gifs/link', { method: 'POST', token: ownerToken, body: { url: bad } });
    check(`a non-allowlisted address is refused (${bad})`, refused.status === 400, `status ${refused.status}`);
  }
  // An allowlisted host that cannot be verified (no gif there, or no network in
  // the sandbox) is refused too, never recorded blindly.
  check(
    'an allowlisted address that is not a reachable gif is refused (415)',
    (await req('/gifs/link', { method: 'POST', token: ownerToken, body: { url: 'https://media.tenor.com/nonexistent/none.gif' } })).status === 415,
  );

  await req('/settings', { method: 'PATCH', token: ownerToken, body: { gifStorage: 'store' } });
  check('switching back closes the policy again', !directive(await cspOf(), 'img-src').includes('tenor'));

  // Only the service's own addresses are ever fetched, so the picker cannot be
  // turned into a way to make the server fetch arbitrary pages.
  check(
    'a gif address outside the service is refused (400)',
    (
      await req('/gifs/pick', {
        method: 'POST',
        token: ownerToken,
        body: { url: 'https://example.com/not-ours.gif' },
      })
    ).status === 400,
  );
  check(
    'and so is saving one (400)',
    (
      await req('/gifs/favorites', {
        method: 'POST',
        token: ownerToken,
        body: { url: 'https://example.com/not-ours.gif' },
      })
    ).status === 400,
  );

  // --- Profile: display name and picture ---
  const renamed = await req('/users/@me', {
    method: 'PATCH',
    token: ownerToken,
    body: { displayName: 'Alice the Great' },
  });
  check('display name is saved', renamed.status === 200 && renamed.json?.user?.displayName === 'Alice the Great');
  check(
    'display name is returned by /auth/me',
    (await req('/auth/me', { token: ownerToken })).json?.user?.displayName === 'Alice the Great',
  );

  const named = await req(`/channels/${colorChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'named hello' },
  });
  check('messages carry the display name', named.json?.author?.displayName === 'Alice the Great');

  const avatarPng = await sharp({ create: { width: 64, height: 40, channels: 3, background: { r: 200, g: 40, b: 90 } } })
    .png()
    .toBuffer();
  const avatarForm = new FormData();
  avatarForm.append('file', new Blob([avatarPng], { type: 'image/png' }), 'me.png');
  const avatarRes = await fetch(`${BASE}/users/@me/avatar`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${ownerToken}` },
    body: avatarForm,
  });
  const avatarUser = await avatarRes.json();
  const avatarHash = avatarUser?.user?.avatarHash;
  check(
    'avatar uploads',
    avatarRes.status === 200 && typeof avatarHash === 'string',
    `status ${avatarRes.status}`,
  );

  const avatarServed = await fetch(`${BASE}/users/${avatarUser.user.id}/avatar`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  const avatarBytes = Buffer.from(await avatarServed.arrayBuffer());
  check(
    'avatar is served as webp',
    avatarServed.status === 200 && avatarServed.headers.get('content-type') === 'image/webp' && avatarBytes.length > 0,
  );
  check(
    'avatars require auth (401)',
    (await fetch(`${BASE}/users/${avatarUser.user.id}/avatar`)).status === 401,
  );
  check(
    'avatar is fetchable without a session when the hash is presented',
    (await fetch(`${BASE}/users/${avatarUser.user.id}/avatar?v=${avatarHash}`)).status === 200,
  );
  check(
    'a wrong hash does not bypass auth (401)',
    (await fetch(`${BASE}/users/${avatarUser.user.id}/avatar?v=not-the-hash`)).status === 401,
  );

  const notAnAvatar = new FormData();
  notAnAvatar.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'n.txt');
  check(
    'non-image avatar rejected (415)',
    (
      await fetch(`${BASE}/users/@me/avatar`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${ownerToken}` },
        body: notAnAvatar,
      })
    ).status === 415,
  );

  // An avatar is a referenced blob, so pruning must not sweep it away.
  const avatarBlobPath = join(dataDir, 'uploads', avatarHash.slice(0, 2), avatarHash);
  check('avatar blob exists before pruning', existsSync(avatarBlobPath));
  await req('/retention/run', { method: 'POST', token: ownerToken });
  check('avatar blob survives pruning', existsSync(avatarBlobPath));
  check(
    'avatar is still served after pruning',
    (
      await fetch(`${BASE}/users/${avatarUser.user.id}/avatar`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).status === 200,
  );

  check(
    'avatar can be removed',
    (await req('/users/@me/avatar', { method: 'DELETE', token: ownerToken })).json?.user?.avatarHash === null,
  );
  check(
    'removed avatar 404s',
    (
      await fetch(`${BASE}/users/${avatarUser.user.id}/avatar`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).status === 404,
  );

  // --- Discord picture sync ---
  // No Discord is configured in the smoke, so the bridge is down. The toggle and
  // the guards still have to hold; the actual fetching is covered by the bridge
  // smoke, where a fake Discord stands in.
  const syncMe = await req('/auth/me', { token: ownerToken });
  check('discord picture sync is on by default', syncMe.json?.user?.syncDiscordAvatar === true);

  const syncOff = await req('/users/@me', {
    method: 'PATCH',
    token: ownerToken,
    body: { syncDiscordAvatar: false },
  });
  check('discord picture sync can be turned off', syncOff.json?.user?.syncDiscordAvatar === false);
  const syncOn = await req('/users/@me', {
    method: 'PATCH',
    token: ownerToken,
    body: { syncDiscordAvatar: true },
  });
  check('discord picture sync can be turned back on', syncOn.json?.user?.syncDiscordAvatar === true);

  check(
    'syncing with no discord link is refused (400)',
    (await req('/users/@me/discord/sync', { method: 'POST', token: ownerToken })).status === 400,
  );

  // While a picture follows Discord it is not the member's to set here, so a
  // direct change is refused rather than quietly overwritten by the next message.
  check(
    'an administrator links a discord account',
    (
      await req(`/members/${avatarUser.user.id}`, {
        method: 'PATCH',
        token: ownerToken,
        body: { discordId: '123456789012345678' },
      })
    ).status === 200,
  );
  check(
    'a picture change is refused while syncing (409)',
    (
      await fetch(`${BASE}/users/@me/avatar`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${ownerToken}` },
        body: avatarForm,
      })
    ).status === 409,
  );
  check(
    'syncing with the bridge down is unavailable (503)',
    (await req('/users/@me/discord/sync', { method: 'POST', token: ownerToken })).status === 503,
  );

  // Turning syncing off hands the picture back, so a change goes through again.
  await req('/users/@me', { method: 'PATCH', token: ownerToken, body: { syncDiscordAvatar: false } });
  check(
    'with syncing off a picture change is allowed',
    (
      await fetch(`${BASE}/users/@me/avatar`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${ownerToken}` },
        body: avatarForm,
      })
    ).status === 200,
  );

  // Leave the account as it was found for the checks that follow.
  await req(`/members/${avatarUser.user.id}`, { method: 'PATCH', token: ownerToken, body: { discordId: null } });
  await req('/users/@me', { method: 'PATCH', token: ownerToken, body: { syncDiscordAvatar: true } });
  await req('/users/@me/avatar', { method: 'DELETE', token: ownerToken });

  // --- Profile customization ---
  const profileUserId = avatarUser.user.id;
  const freshProfile = await req(`/users/${profileUserId}/profile`, { token: ownerToken });
  check(
    'a fresh profile is empty',
    freshProfile.status === 200 &&
      freshProfile.json?.bio === '' &&
      freshProfile.json?.status === '' &&
      freshProfile.json?.accentColor === null &&
      freshProfile.json?.bannerHash === null &&
      JSON.stringify(freshProfile.json?.socialLinks) === '{}',
    JSON.stringify(freshProfile.json),
  );

  const savedProfile = await req('/users/@me', {
    method: 'PATCH',
    token: ownerToken,
    body: {
      bio: '  hello there  ',
      status: 'building',
      accentColor: 0xff8800,
      socialLinks: { github: 'octocat', website: 'https://example.com/me', twitter: 'javascript:alert(1)' },
    },
  });
  check('the owner saves a profile', savedProfile.status === 200);
  const readProfile = await req(`/users/${profileUserId}/profile`, { token: ownerToken });
  check(
    'the profile reads back trimmed, with only valid links kept',
    readProfile.json?.bio === 'hello there' &&
      readProfile.json?.status === 'building' &&
      readProfile.json?.accentColor === 0xff8800 &&
      readProfile.json?.socialLinks?.github === 'octocat' &&
      readProfile.json?.socialLinks?.website === 'https://example.com/me' &&
      readProfile.json?.socialLinks?.twitter === undefined,
    JSON.stringify(readProfile.json),
  );

  const bannerPng = await sharp({
    create: { width: 900, height: 300, channels: 3, background: { r: 10, g: 20, b: 200 } },
  })
    .png()
    .toBuffer();
  const bannerForm = new FormData();
  bannerForm.append('file', new Blob([bannerPng], { type: 'image/png' }), 'banner.png');
  const bannerRes = await fetch(`${BASE}/users/@me/banner`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${ownerToken}` },
    body: bannerForm,
  });
  const bannerHash = (await req(`/users/${profileUserId}/profile`, { token: ownerToken })).json?.bannerHash;
  check('a banner uploads', bannerRes.status === 200 && typeof bannerHash === 'string', `status ${bannerRes.status}`);

  const bannerServed = await fetch(`${BASE}/users/${profileUserId}/banner`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  check(
    'the banner is served as webp, and fetchable by hash without a session',
    bannerServed.status === 200 &&
      bannerServed.headers.get('content-type') === 'image/webp' &&
      (await fetch(`${BASE}/users/${profileUserId}/banner?v=${bannerHash}`)).status === 200,
  );

  // A banner is a referenced blob too, so pruning must not sweep it away.
  const bannerBlobPath = join(dataDir, 'uploads', bannerHash.slice(0, 2), bannerHash);
  check('banner blob exists before pruning', existsSync(bannerBlobPath));
  await req('/retention/run', { method: 'POST', token: ownerToken });
  check('banner blob survives pruning', existsSync(bannerBlobPath));

  check(
    'the banner can be removed',
    (await req('/users/@me/banner', { method: 'DELETE', token: ownerToken })).status === 200 &&
      (await req(`/users/${profileUserId}/profile`, { token: ownerToken })).json?.bannerHash === null,
  );

  // --- Username colors ---
  // The palette an administrator offers, and the member's pick from it.
  const paletteEmpty = await req('/name-colors', { token: ownerToken });
  check(
    'the name-color palette starts empty',
    paletteEmpty.status === 200 && paletteEmpty.json?.nameColors?.length === 0,
  );
  check(
    'a member cannot add a name color (403)',
    (await req('/name-colors', { method: 'POST', token: bobToken, body: { color: 0x57b0e0 } })).status === 403,
  );

  const createdColor = await req('/name-colors', {
    method: 'POST',
    token: ownerToken,
    body: { color: 0x57b0e0, label: 'Sky' },
  });
  const colorId = createdColor.json?.id;
  check(
    'an administrator adds a name color',
    createdColor.status === 200 &&
      typeof colorId === 'string' &&
      createdColor.json?.color === 0x57b0e0 &&
      createdColor.json?.label === 'Sky',
    JSON.stringify(createdColor.json),
  );
  check(
    'the palette lists it',
    (await req('/name-colors', { token: bobToken })).json?.nameColors?.some((entry) => entry.id === colorId) === true,
  );

  // The color is resolved from the picked entry and rides on the lean User.
  const pickedColor = await req('/users/@me', { method: 'PATCH', token: ownerToken, body: { nameColorId: colorId } });
  check(
    'a member picks a name color, and no role color competes with it',
    pickedColor.json?.user?.nameColor === 0x57b0e0 && pickedColor.json?.user?.roleColor === null,
    JSON.stringify(pickedColor.json?.user),
  );
  check(
    'the profile records the pick',
    (await req(`/users/${profileUserId}/profile`, { token: ownerToken })).json?.nameColorId === colorId,
  );
  check(
    'an unknown name color is refused (400)',
    (await req('/users/@me', { method: 'PATCH', token: ownerToken, body: { nameColorId: 'nope' } })).status === 400,
  );

  // A colored role outranks the pick. The server sends both; the client prefers
  // the role color, which is what the glow marks out.
  const colorRole = await req('/roles', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Sky role', color: 0xff8800 },
  });
  await req(`/members/${profileUserId}/roles/${colorRole.json.id}`, { method: 'PUT', token: ownerToken });
  const withRole = await req('/auth/me', { token: ownerToken });
  check(
    'a role color is sent alongside the chosen one, so the client can prefer it',
    withRole.json?.user?.roleColor === 0xff8800 && withRole.json?.user?.nameColor === 0x57b0e0,
    JSON.stringify(withRole.json?.user),
  );
  await req(`/members/${profileUserId}/roles/${colorRole.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/roles/${colorRole.json.id}`, { method: 'DELETE', token: ownerToken });

  // Removing an entry drops everyone who picked it back to no color, which is
  // what deleting a color role would do.
  check(
    'the name color can be removed',
    (await req(`/name-colors/${colorId}`, { method: 'DELETE', token: ownerToken })).status === 204,
  );
  check(
    'removing a color clears the members who chose it',
    (await req('/auth/me', { token: ownerToken })).json?.user?.nameColor === null,
  );
  check(
    'the profile clears the pick too',
    (await req(`/users/${profileUserId}/profile`, { token: ownerToken })).json?.nameColorId === null,
  );

  // --- Instance icon ---
  const iconPng = await sharp({
    create: { width: 40, height: 40, channels: 4, background: { r: 88, g: 101, b: 242, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const bobIcon = new FormData();
  bobIcon.append('file', new Blob([iconPng], { type: 'image/png' }), 'icon.png');
  check(
    'member cannot upload a server icon (403)',
    (
      await fetch(`${BASE}/icon`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${bobToken}` },
        body: bobIcon,
      })
    ).status === 403,
  );

  check('no icon is set by default (404)', (await req('/icon')).status === 404);
  check('meta reports no icon hash by default', (await req('/meta')).json?.iconHash === null);

  const ownerIcon = new FormData();
  ownerIcon.append('file', new Blob([iconPng], { type: 'image/png' }), 'icon.png');
  const iconRes = await fetch(`${BASE}/icon`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${ownerToken}` },
    body: ownerIcon,
  });
  const iconBody = await iconRes.json();
  check(
    'owner uploads a server icon',
    iconRes.status === 200 && typeof iconBody.iconHash === 'string',
    JSON.stringify(iconBody),
  );

  const servedIcon = await fetch(`${BASE}/icon?v=${iconBody.iconHash}`);
  const iconBytes = Buffer.from(await servedIcon.arrayBuffer());
  check(
    'the icon is served as png without a session',
    servedIcon.status === 200 && servedIcon.headers.get('content-type') === 'image/png' && iconBytes.length > 0,
  );
  check('meta now reports the icon hash', (await req('/meta')).json?.iconHash === iconBody.iconHash);

  const notAnIcon = new FormData();
  notAnIcon.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'n.txt');
  check(
    'a non-image icon is rejected (415)',
    (
      await fetch(`${BASE}/icon`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${ownerToken}` },
        body: notAnIcon,
      })
    ).status === 415,
  );

  // The icon is a blob like any other, so the pruner must know it is referenced.
  await req('/retention/run', { method: 'POST', token: ownerToken });
  check('the icon survives pruning', (await fetch(`${BASE}/icon?v=${iconBody.iconHash}`)).status === 200);

  check('owner resets the icon', (await req('/icon', { method: 'DELETE', token: ownerToken })).json?.iconHash === null);
  check('the icon is gone after a reset (404)', (await req('/icon')).status === 404);
  check('meta forgets the icon hash after a reset', (await req('/meta')).json?.iconHash === null);

  // Bridge settings: outbound avatars need a real public address, but a blank
  // value (turning them off) must stay allowed.
  check(
    'bridge rejects a malformed public base URL (400)',
    (await req('/bridge', { method: 'PATCH', token: ownerToken, body: { publicBaseUrl: 'not a url' } })).status === 400,
  );
  check(
    'bridge accepts a valid public base URL',
    (await req('/bridge', { method: 'PATCH', token: ownerToken, body: { publicBaseUrl: 'https://chat.example.com/' } })).json
      ?.publicBaseUrl === 'https://chat.example.com/',
  );
  check(
    'bridge can clear the public base URL',
    (await req('/bridge', { method: 'PATCH', token: ownerToken, body: { publicBaseUrl: '' } })).json?.publicBaseUrl === null,
  );

  check(
    'display name can be cleared',
    (await req('/users/@me', { method: 'PATCH', token: ownerToken, body: { displayName: null } })).json?.user
      ?.displayName === null,
  );

  // --- Moderation: timeouts, kicks and bans ---
  const modInvite = await req('/invites', { method: 'POST', token: ownerToken, body: {} });
  const modTarget = await req('/auth/register', {
    method: 'POST',
    body: { username: 'modtarget', password: 'hunter2hunter2', inviteCode: modInvite.json?.code },
  });
  const modToken = modTarget.json?.token;
  const modId = modTarget.json?.user?.id;
  const ownerId = owner.json?.user?.id;

  // Nobody may moderate an administrator (including the owner), themselves, or
  // exercise a permission they do not hold.
  const tempAdminRole = await req('/roles', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Temp Admin', permissions: '16384' },
  });
  await req(`/members/${bobId}/roles/${tempAdminRole.json?.id}`, { method: 'PUT', token: ownerToken });
  check(
    'an administrator cannot be timed out (403)',
    (await req(`/members/${bobId}/timeout`, {
      method: 'PUT',
      token: ownerToken,
      body: { durationMinutes: 5 },
    })).status === 403,
  );
  check(
    'an administrator cannot be kicked (403)',
    (await req(`/members/${bobId}/kick`, { method: 'POST', token: ownerToken })).status === 403,
  );
  await req(`/members/${bobId}/roles/${tempAdminRole.json?.id}`, { method: 'DELETE', token: ownerToken });

  check(
    'you cannot kick yourself (400)',
    (await req(`/members/${ownerId}/kick`, { method: 'POST', token: ownerToken })).status === 400,
  );
  check(
    'a member without permission cannot kick (403)',
    (await req(`/members/${modId}/kick`, { method: 'POST', token: modToken })).status === 403,
  );

  // A timeout stops posting but not reading.
  check(
    'an administrator can time out a member',
    (await req(`/members/${modId}/timeout`, {
      method: 'PUT',
      token: ownerToken,
      body: { durationMinutes: 5 },
    })).status === 204,
  );
  check(
    'a timed-out member cannot post (403)',
    (await req(`/channels/${colorChannel.id}/messages`, {
      method: 'POST',
      token: modToken,
      body: { content: 'nope' },
    })).status === 403,
  );
  check(
    'a timed-out member can still read',
    (await req(`/channels/${colorChannel.id}/messages`, { token: modToken })).status === 200,
  );
  check(
    'a timeout can be lifted',
    (await req(`/members/${modId}/timeout`, { method: 'DELETE', token: ownerToken })).status === 204,
  );
  check(
    'posting works again after a timeout',
    (await req(`/channels/${colorChannel.id}/messages`, {
      method: 'POST',
      token: modToken,
      body: { content: 'back' },
    })).status === 200,
  );

  // A kick ends their session; they may sign back in.
  check(
    'an administrator can kick a member',
    (await req(`/members/${modId}/kick`, { method: 'POST', token: ownerToken })).status === 204,
  );
  check('a kicked member is logged out (401)', (await req('/auth/me', { token: modToken })).status === 401);

  // A ban blocks login until it is lifted.
  check(
    'an administrator can ban a member',
    (await req(`/members/${modId}/ban`, {
      method: 'PUT',
      token: ownerToken,
      body: { reason: 'testing' },
    })).status === 204,
  );
  check(
    'a banned member cannot sign in (403)',
    (await req('/auth/login', { method: 'POST', body: { username: 'modtarget', password: 'hunter2hunter2' } })).status ===
      403,
  );
  check(
    'banned members leave the directory',
    (await req('/members/directory', { token: ownerToken })).json?.users?.some((user) => user.id === modId) === false,
  );
  const banList = await req('/bans', { token: ownerToken });
  check(
    'bans are listed with their reason',
    banList.json?.bans?.some((ban) => ban.user.id === modId && ban.reason === 'testing') === true,
  );
  check(
    'an administrator can unban',
    (await req(`/members/${modId}/ban`, { method: 'DELETE', token: ownerToken })).status === 204,
  );
  check(
    'an unbanned member can sign in again',
    (await req('/auth/login', { method: 'POST', body: { username: 'modtarget', password: 'hunter2hunter2' } })).status ===
      200,
  );
  check(
    'the directory includes them again',
    (await req('/members/directory', { token: ownerToken })).json?.users?.some((user) => user.id === modId) === true,
  );

  // --- Changing your own password ---
  const editInvite = await req('/invites', { method: 'POST', token: ownerToken, body: {} });
  const editTarget = await req('/auth/register', {
    method: 'POST',
    body: { username: 'editme', password: 'editmepass1', inviteCode: editInvite.json?.code },
  });
  const editId = editTarget.json?.user?.id;
  const ownToken = editTarget.json?.token;

  const secondSession = await req('/auth/login', {
    method: 'POST',
    body: { username: 'editme', password: 'editmepass1' },
  });
  const otherToken = secondSession.json?.token;

  check(
    'changing a password needs the current one (403)',
    (await req('/users/@me/password', {
      method: 'PATCH',
      token: ownToken,
      body: { currentPassword: 'wrong-password', newPassword: 'brandnewpass1' },
    })).status === 403,
  );
  check(
    'a rejected change leaves the old password working',
    (await req('/auth/login', { method: 'POST', body: { username: 'editme', password: 'editmepass1' } })).status === 200,
  );
  check(
    'a member can change their own password',
    (await req('/users/@me/password', {
      method: 'PATCH',
      token: ownToken,
      body: { currentPassword: 'editmepass1', newPassword: 'brandnewpass1' },
    })).status === 200,
  );
  check(
    'the old password stops working',
    (await req('/auth/login', { method: 'POST', body: { username: 'editme', password: 'editmepass1' } })).status === 401,
  );
  check(
    'the new password works',
    (await req('/auth/login', { method: 'POST', body: { username: 'editme', password: 'brandnewpass1' } })).status === 200,
  );
  check('the session that changed the password survives', (await req('/auth/me', { token: ownToken })).status === 200);
  check("a member's other sessions are signed out", (await req('/auth/me', { token: otherToken })).status === 401);

  // --- An administrator editing an account ---
  // This is the instance's only password-recovery path: nobody can read a
  // password, but an administrator can set a new one.
  check(
    'editing an account needs ManageMembers (403)',
    (await req(`/members/${editId}`, { method: 'PATCH', token: bobToken, body: { displayName: 'Nope' } })).status === 403,
  );

  const editedAccount = await req(`/members/${editId}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { username: 'renameduser', displayName: 'Renamed User' },
  });
  check(
    'an administrator can change a username and display name',
    editedAccount.status === 200 &&
      editedAccount.json?.user?.username === 'renameduser' &&
      editedAccount.json?.user?.displayName === 'Renamed User',
  );
  check(
    'the API never returns a password field',
    editedAccount.json?.user !== undefined && !('password' in editedAccount.json.user),
  );
  check(
    'a username already in use is refused (409)',
    (await req(`/members/${editId}`, { method: 'PATCH', token: ownerToken, body: { username: 'alice' } })).status === 409,
  );

  // Linking a member to a Discord account is the administrator's to set for now;
  // signing in with Discord and letting members do it themselves comes later.
  const linkedAccount = await req(`/members/${editId}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { discordId: '123456789012345678' },
  });
  check(
    'an administrator can link a member to a Discord id',
    linkedAccount.status === 200 && linkedAccount.json?.user?.discordId === '123456789012345678',
  );
  check(
    'a malformed Discord id is refused (400)',
    (await req(`/members/${editId}`, { method: 'PATCH', token: ownerToken, body: { discordId: 'not-a-number' } })).status ===
      400,
  );
  const selfLink = await req('/users/@me', {
    method: 'PATCH',
    token: ownToken,
    body: { discordId: '999999999999999999' },
  });
  check(
    'a member cannot set their own Discord id',
    selfLink.status === 400 &&
      (await req('/auth/me', { token: ownToken })).json?.user?.discordId === '123456789012345678',
  );
  check(
    'an administrator can clear a Discord link',
    (await req(`/members/${editId}`, { method: 'PATCH', token: ownerToken, body: { discordId: null } })).json?.user
      ?.discordId === null,
  );

  const beforeReset = await req('/auth/login', {
    method: 'POST',
    body: { username: 'renameduser', password: 'brandnewpass1' },
  });
  const beforeResetToken = beforeReset.json?.token;
  check(
    'an administrator can reset a password',
    (await req(`/members/${editId}`, {
      method: 'PATCH',
      token: ownerToken,
      body: { password: 'adminreset123' },
    })).status === 200,
  );
  check(
    'the reset password works',
    (await req('/auth/login', { method: 'POST', body: { username: 'renameduser', password: 'adminreset123' } })).status ===
      200,
  );
  check('a reset signs existing sessions out', (await req('/auth/me', { token: beforeResetToken })).status === 401);

  const ownerAvatar = new FormData();
  ownerAvatar.append('file', new Blob([emojiPng], { type: 'image/png' }), 'member.png');
  const bobAvatar = new FormData();
  bobAvatar.append('file', new Blob([emojiPng], { type: 'image/png' }), 'member.png');

  check(
    'an administrator can set a member picture',
    (
      await fetch(`${BASE}/members/${editId}/avatar`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${ownerToken}` },
        body: ownerAvatar,
      })
    ).status === 200,
  );
  check(
    'setting a member picture needs ManageMembers (403)',
    (
      await fetch(`${BASE}/members/${editId}/avatar`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${bobToken}` },
        body: bobAvatar,
      })
    ).status === 403,
  );
  check(
    'an administrator can clear a member picture',
    (await req(`/members/${editId}/avatar`, { method: 'DELETE', token: ownerToken })).status === 200,
  );

  // --- Deleting an account ---
  // The owner and administrators are protected, so this only ever removes a
  // plain member. Their messages stay behind, with no author left to show.
  const deleteInvite = await req('/invites', { method: 'POST', token: ownerToken, body: {} });
  const doomed = await req('/auth/register', {
    method: 'POST',
    body: { username: 'deleteme', password: 'deletemepass1', inviteCode: deleteInvite.json?.code },
  });
  const doomedId = doomed.json?.user?.id;
  const doomedToken = doomed.json?.token;
  const doomedMessage = await req(`/channels/${colorChannel.id}/messages`, {
    method: 'POST',
    token: doomedToken,
    body: { content: 'I was here' },
  });
  const doomedMessageId = doomedMessage.json?.id;

  const deleteAdmin = await req('/roles', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Delete guard', permissions: String(1n << 14n) },
  });
  await req(`/members/${bobId}/roles/${deleteAdmin.json?.id}`, { method: 'PUT', token: ownerToken });

  check(
    'deleting an account needs ManageMembers (403)',
    (await req(`/members/${bobId}`, { method: 'DELETE', token: doomedToken })).status === 403,
  );
  check(
    'the owner cannot be deleted (403)',
    (await req(`/members/${ownerId}`, { method: 'DELETE', token: bobToken })).status === 403,
  );
  check(
    'you cannot delete your own account (400)',
    (await req(`/members/${bobId}`, { method: 'DELETE', token: bobToken })).status === 400,
  );
  check(
    'an administrator cannot be deleted (403)',
    (await req(`/members/${bobId}`, { method: 'DELETE', token: ownerToken })).status === 403,
  );
  await req(`/members/${bobId}/roles/${deleteAdmin.json?.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/roles/${deleteAdmin.json?.id}`, { method: 'DELETE', token: ownerToken });

  check(
    'an administrator can delete an ordinary member',
    (await req(`/members/${doomedId}`, { method: 'DELETE', token: ownerToken })).status === 204,
  );
  check(
    'the deleted member leaves the member list',
    (await req('/members', { token: ownerToken })).json?.members?.some((member) => member.user.id === doomedId) === false,
  );
  check(
    'their messages stay behind with no author',
    (await req(`/channels/${colorChannel.id}/messages`, { token: ownerToken })).json?.messages?.some(
      (message) => message.id === doomedMessageId && message.author === null,
    ) === true,
  );

  // A Discord stand-in account belongs to the bridge: its profile is not the
  // admin panel's to edit, though its roles still are.
  const ghostDir = mkdtempSync(join(tmpdir(), 'harmony-ghost-'));
  const ghostStore = new Database({
    dataDir: ghostDir,
    dbFile: join(ghostDir, 'harmony.db'),
    uploadDir: join(ghostDir, 'uploads'),
  });
  insertGhostUser(ghostStore.sqlite, {
    id: 'ghost-account',
    username: 'discordfan',
    displayName: 'Discord Fan',
    discordId: '999999',
    createdAt: new Date().toISOString(),
  });
  const ghostUsers = createUserService(ghostStore.sqlite, {
    dataDir: ghostDir,
    uploadDir: join(ghostDir, 'uploads'),
  });
  let ghostEditError = null;
  try {
    await ghostUsers.adminUpdate('ghost-account', { displayName: 'Renamed' });
  } catch (error) {
    ghostEditError = error;
  }
  check(
    'editing a discord stand-in account is refused',
    ghostEditError?.statusCode === 400,
    String(ghostEditError),
  );

  // Linking a member to a Discord account retires the stand-in built for that
  // Discord user: its history is reassigned and the stand-in is gone, so the
  // person is one identity. Exercised on its own database, where no bridge is
  // needed and a collision can be arranged on purpose.
  insertUser(ghostStore.sqlite, { id: 'member-1', username: 'memberone', passwordHash: 'x', isOwner: false });
  insertUser(ghostStore.sqlite, { id: 'member-2', username: 'membertwo', passwordHash: 'x', isOwner: false });
  ghostStore.sqlite
    .prepare("INSERT INTO channels (id, name, type, position, created_at) VALUES ('chan-1', 'general', 'text', 0, ?)")
    .run(new Date().toISOString());
  insertMessage(ghostStore.sqlite, {
    id: 'msg-1',
    channelId: 'chan-1',
    authorId: 'ghost-account',
    content: 'bridged hello',
    createdAt: new Date().toISOString(),
  });
  // A role both accounts hold, and a reaction left a second time, so the merge
  // meets genuine key collisions rather than only empty tables.
  ghostStore.sqlite
    .prepare("INSERT INTO roles (id, name, position, permissions, created_at) VALUES ('role-1', 'Fan', 0, '0', ?)")
    .run(new Date().toISOString());
  ghostStore.sqlite.prepare("INSERT INTO member_roles (user_id, role_id) VALUES ('ghost-account', 'role-1')").run();
  ghostStore.sqlite.prepare("INSERT INTO member_roles (user_id, role_id) VALUES ('member-1', 'role-1')").run();
  ghostStore.sqlite
    .prepare("INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES ('msg-1', 'ghost-account', '👍', ?)")
    .run(new Date().toISOString());
  ghostStore.sqlite
    .prepare("INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES ('msg-1', 'member-1', '👍', ?)")
    .run(new Date().toISOString());

  let mergeError = null;
  try {
    ghostUsers.linkDiscord('member-1', '999999');
  } catch (error) {
    mergeError = error;
  }
  const linkedMember = ghostStore.sqlite.prepare("SELECT * FROM users WHERE id = 'member-1'").get();
  const ghostRow = ghostStore.sqlite.prepare("SELECT id FROM users WHERE id = 'ghost-account'").get() ?? null;
  const movedMessage = ghostStore.sqlite.prepare("SELECT author_id FROM messages WHERE id = 'msg-1'").get();
  const movedReaction = ghostStore.sqlite.prepare("SELECT user_id FROM reactions WHERE message_id = 'msg-1'").get();
  const roleRows = ghostStore.sqlite
    .prepare("SELECT COUNT(*) AS n FROM member_roles WHERE user_id = 'member-1' AND role_id = 'role-1'")
    .get();
  check('linking a Discord account retires the stand-in', mergeError === null && ghostRow === null, String(mergeError));
  check('the member takes the Discord id', linkedMember?.discord_id === '999999');
  check('the stand-in history becomes the member own', movedMessage?.author_id === 'member-1');
  check('a reaction moves with it', movedReaction?.user_id === 'member-1');
  check('a role both held is not duplicated', roleRows?.n === 1);

  // An id another member already holds is refused, and clearing works.
  ghostUsers.linkDiscord('member-2', '888888');
  let takenError = null;
  try {
    ghostUsers.linkDiscord('member-1', '888888');
  } catch (error) {
    takenError = error;
  }
  check('linking an id another member holds is refused (409)', takenError?.statusCode === 409, String(takenError));
  ghostUsers.linkDiscord('member-1', null);
  check(
    'clearing a Discord link works',
    ghostStore.sqlite.prepare("SELECT discord_id FROM users WHERE id = 'member-1'").get()?.discord_id === null,
  );

  // Signing in with Discord creates the account the first time. Run against the
  // same throwaway database, with the invite requirement switched by hand.
  let requireInvite = false;
  const discordAuth = createAuthService(
    ghostStore.sqlite,
    { sessionTtlDays: 1 },
    { get: () => ({ requireInvite }) },
  );
  const discordIdentity = (id, username, displayName = null) => ({ id, username, displayName, avatarUrl: null });
  const nowIso = new Date().toISOString();

  const fresh = discordAuth.signInWithDiscord(discordIdentity('700000000000000001', 'New Person!', 'New P'), null, null);
  const freshRow = ghostStore.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(fresh.auth.user.id);
  check('a first Discord sign-in creates an account', fresh.created === true && !!fresh.auth.token);
  check('the new account has no password', fresh.auth.user.hasPassword === false && freshRow.password_hash === '!no-password');
  check('its username is made valid from the Discord name', freshRow.username === 'NewPerson');
  check('it carries the Discord id and name', freshRow.discord_id === '700000000000000001' && freshRow.display_name === 'New P');
  check('a Discord sign-up is never the owner', freshRow.is_owner === 0);

  const again = discordAuth.signInWithDiscord(discordIdentity('700000000000000001', 'whatever'), null, null);
  check('signing in again finds the same account', again.created === false && again.auth.user.id === fresh.auth.user.id);

  let passwordlessLogin = null;
  try {
    await discordAuth.login({ username: 'NewPerson', password: '!no-password' }, null);
  } catch (error) {
    passwordlessLogin = error;
  }
  check('a passwordless account cannot be logged into with a password (401)', passwordlessLogin?.statusCode === 401);

  // A name that is already taken gets a suffix rather than an error.
  const clash = discordAuth.signInWithDiscord(discordIdentity('700000000000000002', 'NewPerson'), null, null);
  check('a taken username is suffixed', clash.auth.user.username === 'NewPerson2');

  // A stand-in for the same Discord user is folded into the new account.
  insertGhostUser(ghostStore.sqlite, {
    id: 'ghost-three',
    username: 'discord_700000000000000003',
    displayName: 'Bridge Name',
    discordId: '700000000000000003',
    createdAt: nowIso,
  });
  insertMessage(ghostStore.sqlite, {
    id: 'msg-ghost-three',
    channelId: 'chan-1',
    authorId: 'ghost-three',
    content: 'said on discord',
    createdAt: nowIso,
  });
  const adopted = discordAuth.signInWithDiscord(discordIdentity('700000000000000003', 'adoptee'), null, null);
  check(
    'a stand-in is adopted by the new account',
    adopted.created === true &&
      ghostStore.sqlite.prepare("SELECT id FROM users WHERE id = 'ghost-three'").get() === undefined &&
      ghostStore.sqlite.prepare("SELECT author_id FROM messages WHERE id = 'msg-ghost-three'").get()?.author_id ===
        adopted.auth.user.id,
  );
  check('and keeps the name the bridge gave it', adopted.auth.user.displayName === 'Bridge Name');

  // A ban on the stand-in follows the person.
  insertGhostUser(ghostStore.sqlite, {
    id: 'ghost-banned',
    username: 'discord_700000000000000004',
    displayName: 'Banned',
    discordId: '700000000000000004',
    createdAt: nowIso,
  });
  insertBan(ghostStore.sqlite, { userId: 'ghost-banned', bannedBy: 'member-2', reason: null, createdAt: nowIso });
  let bannedSignIn = null;
  try {
    discordAuth.signInWithDiscord(discordIdentity('700000000000000004', 'banned'), null, null);
  } catch (error) {
    bannedSignIn = error;
  }
  check('a banned stand-in cannot sign up (403)', bannedSignIn?.code === 'account_banned');

  // Invites gate new accounts only.
  requireInvite = true;
  const inviteError = (id, code) => {
    try {
      discordAuth.signInWithDiscord(discordIdentity(id, 'invitee'), code, null);
    } catch (error) {
      return error.code;
    }
    return null;
  };
  check('a new Discord account needs an invite when required', inviteError('700000000000000005', null) === 'invite_required');
  check('a wrong invite is refused', inviteError('700000000000000005', 'nope') === 'invalid_invite');
  insertInvite(ghostStore.sqlite, { code: 'once', createdBy: 'member-2', createdAt: nowIso, expiresAt: null, maxUses: 1 });
  check('a valid invite is accepted', inviteError('700000000000000005', 'once') === null);
  check(
    'and is consumed',
    ghostStore.sqlite.prepare("SELECT uses FROM invites WHERE code = 'once'").get()?.uses === 1,
  );
  check('an used-up invite is refused', inviteError('700000000000000006', 'once') === 'invite_exhausted');
  check(
    'an existing member signs in without an invite',
    discordAuth.signInWithDiscord(discordIdentity('700000000000000001', 'x'), null, null).created === false,
  );
  requireInvite = false;

  // Discord is the only way in, so it cannot be cut off until a password exists.
  let lockout = null;
  try {
    ghostUsers.linkDiscord(fresh.auth.user.id, null);
  } catch (error) {
    lockout = error;
  }
  check('a passwordless account cannot disconnect Discord (409)', lockout?.statusCode === 409);
  await ghostUsers.changePassword(fresh.auth.user.id, undefined, 'a-first-password');
  check(
    'it can set its first password without a current one',
    (await discordAuth.login({ username: 'NewPerson', password: 'a-first-password' }, null)).user.hasPassword === true,
  );
  let wrongCurrent = null;
  try {
    await ghostUsers.changePassword(fresh.auth.user.id, undefined, 'another-password');
  } catch (error) {
    wrongCurrent = error;
  }
  check('once set, changing it needs the current one (403)', wrongCurrent?.statusCode === 403);
  ghostUsers.linkDiscord(fresh.auth.user.id, null);
  check('and then Discord can be disconnected', ghostStore.sqlite.prepare('SELECT discord_id FROM users WHERE id = ?').get(fresh.auth.user.id)?.discord_id === null);

  // The OAuth round trip only completes in the browser that started it. Discord
  // is stubbed, so the binding is the only thing that can make this fail.
  const oauth = createDiscordOAuthService({
    getDiscordAuth: () => ({ enabled: true, clientId: '1', clientSecret: 's' }),
    discordRedirectUri: () => 'https://harmony.test/api/v1/auth/discord/callback',
    get: () => ({ previewUserAgent: null }),
  });
  const realFetch = globalThis.fetch;
  const stubFetch = (user) => async (url) =>
    String(url).includes('/oauth2/token')
      ? new Response(JSON.stringify({ access_token: 'token' }))
      : new Response(JSON.stringify(user));
  globalThis.fetch = stubFetch({ id: '700000000000000009', username: 'someone' });
  try {
    const stateOf = (flow) => new URL(flow.url).searchParams.get('state');
    const bound = oauth.authorizeUrl('link', { userId: 'member-2' });
    const completed = await oauth.complete('code', stateOf(bound), bound.binding);
    check(
      'a flow completes in the browser that started it',
      completed.identity.id === '700000000000000009' && completed.userId === 'member-2',
    );
    check('a Discord account with no picture carries no avatar URL', completed.identity.avatarUrl === null);

    // A Discord picture turns into the CDN address a new account imports as its avatar.
    globalThis.fetch = stubFetch({ id: '700000000000000009', username: 'someone', avatar: 'abc123' });
    const pictured = oauth.authorizeUrl('link');
    const withPicture = await oauth.complete('code', stateOf(pictured), pictured.binding);
    check(
      'a Discord picture becomes a CDN avatar URL',
      withPicture.identity.avatarUrl ===
        'https://cdn.discordapp.com/avatars/700000000000000009/abc123.png?size=256',
      String(withPicture.identity.avatarUrl),
    );
    check(
      'the avatar fetcher refuses a non-public address',
      (await oauth.downloadAvatar('http://127.0.0.1:9/a.png')) === null,
    );

    const refusal = async (flow, binding) => {
      try {
        await oauth.complete('code', stateOf(flow), binding);
      } catch (error) {
        return error.code;
      }
      return null;
    };
    check('a flow without its binding is refused', (await refusal(oauth.authorizeUrl('link'), null)) === 'discord_state');
    const other = oauth.authorizeUrl('link');
    check(
      "a flow with another flow's binding is refused",
      (await refusal(other, oauth.authorizeUrl('link').binding)) === 'discord_state',
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  ghostStore.close();
  rmSync(ghostDir, { recursive: true, force: true });

  // --- Slowmode ---
  const slowChannel = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'quiet-room', slowmodeSeconds: 60 },
  });
  check('a channel can be given a slowmode', slowChannel.json?.slowmodeSeconds === 60);
  check(
    'an out-of-range slowmode is refused (400)',
    (
      await req(`/channels/${slowChannel.json.id}`, {
        method: 'PATCH',
        token: ownerToken,
        body: { slowmodeSeconds: 999_999 },
      })
    ).status === 400,
  );

  check(
    'a member can post once in a slow channel',
    (
      await req(`/channels/${slowChannel.json.id}/messages`, {
        method: 'POST',
        token: bobToken,
        body: { content: 'first' },
      })
    ).status === 200,
  );
  const slowBlocked = await req(`/channels/${slowChannel.json.id}/messages`, {
    method: 'POST',
    token: bobToken,
    body: { content: 'second' },
  });
  check(
    'slowmode refuses the next message (429)',
    slowBlocked.status === 429 && slowBlocked.json?.error?.code === 'slowmode',
    `status ${slowBlocked.status}`,
  );

  // Managing messages skips the cooldown, so a moderator is never held back.
  const ownerFirst = await req(`/channels/${slowChannel.json.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'mod one' },
  });
  const ownerSecond = await req(`/channels/${slowChannel.json.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'mod two' },
  });
  check('managing messages skips slowmode', ownerFirst.status === 200 && ownerSecond.status === 200);

  await req(`/channels/${slowChannel.json.id}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { slowmodeSeconds: 0 },
  });
  check(
    'turning slowmode off lifts the cooldown',
    (
      await req(`/channels/${slowChannel.json.id}/messages`, {
        method: 'POST',
        token: bobToken,
        body: { content: 'third' },
      })
    ).status === 200,
  );

  // --- Search ---
  const searchChannel = await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'searchroom' } });
  const searchChannelId = searchChannel.json.id;
  const postInSearch = (token, content) =>
    req(`/channels/${searchChannelId}/messages`, { method: 'POST', token, body: { content } });
  const search = (query, token = ownerToken) => req(`/search?${new URLSearchParams(query)}`, { token });

  await postInSearch(ownerToken, 'qqq alpha findme');
  const editedForSearch = await postInSearch(ownerToken, 'qqq oldword here');
  await req(`/messages/${editedForSearch.json.id}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { content: 'qqq newword here' },
  });
  const deletedForSearch = await postInSearch(ownerToken, 'qqq deletedword here');
  await req(`/messages/${deletedForSearch.json.id}`, { method: 'DELETE', token: ownerToken });
  await postInSearch(bobToken, 'qqq bobword here');
  await postInSearch(ownerToken, 'qqq a_b underscore');
  await postInSearch(ownerToken, 'qqq axb underscore');
  await postInSearch(ownerToken, 'qqq page one');
  await postInSearch(ownerToken, 'qqq page two');
  await postInSearch(ownerToken, 'qqq page three');

  const found = await search({ q: 'findme' });
  check(
    'search finds a message by a word',
    found.json?.messages?.length === 1 && found.json.messages[0].content === 'qqq alpha findme',
  );
  check('search ignores case', (await search({ q: 'FINDME' })).json?.messages?.length === 1);
  check('search leaves out deleted messages', (await search({ q: 'deletedword' })).json?.messages?.length === 0);
  check('an edited message is found by its new text', (await search({ q: 'newword' })).json?.messages?.length === 1);
  check(
    'an edited message is no longer found by its old text',
    (await search({ q: 'oldword' })).json?.messages?.length === 0,
  );
  check(
    'like wildcards in a search are taken literally',
    (await search({ q: 'qqq a_b' })).json?.messages?.length === 1,
  );
  check('a search without a term is refused (400)', (await req('/search', { token: ownerToken })).status === 400);

  // A filter on its own is enough: everything one member said, or everything in
  // one channel, without any search term.
  const byAuthorOnly = await search({ authorId: bobId });
  check(
    'a search can be a filter with no term',
    byAuthorOnly.json?.messages?.length > 0 &&
      byAuthorOnly.json.messages.every((message) => message.author.id === bobId),
  );
  const byChannelOnly = await search({ channelId: searchChannelId, limit: '50' });
  check(
    'a search can be a channel with no term',
    byChannelOnly.json?.messages?.length > 0 &&
      byChannelOnly.json.messages.every((message) => message.channelId === searchChannelId),
  );

  const byBob = await search({ q: 'bobword', authorId: bobId });
  check(
    'search can be narrowed to one author',
    byBob.json?.messages?.length === 1 && byBob.json.messages[0].author.id === bobId,
  );
  check(
    'a search narrowed to one author leaves the others out',
    (await search({ q: 'bobword', authorId: owner.json?.user?.id })).json?.messages?.length === 0,
  );
  check(
    'search can be narrowed to one channel',
    (await search({ q: 'findme', channelId: searchChannelId })).json?.messages?.length === 1 &&
      (await search({ q: 'findme', channelId: general.id })).json?.messages?.length === 0,
  );

  const firstPage = await search({ q: 'qqq page', limit: '2' });
  check(
    'search returns the newest matches first',
    firstPage.json?.messages?.length === 2 && firstPage.json.messages[0].content === 'qqq page three',
  );
  const oldestMatch = firstPage.json.messages[1];
  const secondPage = await search({
    q: 'qqq page',
    limit: '2',
    before: oldestMatch.createdAt,
    beforeId: oldestMatch.id,
  });
  check(
    'search pages through older matches with the cursor',
    secondPage.json?.messages?.length === 1 && secondPage.json.messages[0].content === 'qqq page one',
  );

  // A locked channel's text must not leak through a search.
  const secretRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Secret' } });
  const secretChannel = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'secretroom', requiredRoleId: secretRole.json.id },
  });
  await req(`/channels/${secretChannel.json.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'qqq zzz hidden' },
  });
  check(
    'search skips channels the member cannot see',
    (await search({ q: 'zzz hidden' }, bobToken)).json?.messages?.length === 0,
  );
  check(
    'an administrator searches locked channels too',
    (await search({ q: 'zzz hidden' })).json?.messages?.length === 1,
  );
  check(
    'searching a locked channel directly is refused (403)',
    (await search({ q: 'zzz hidden', channelId: secretChannel.json.id }, bobToken)).status === 403,
  );
  await req(`/channels/${secretChannel.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/roles/${secretRole.json.id}`, { method: 'DELETE', token: ownerToken });

  // --- Search filters: from, mentions, in, has, date bounds ---
  const ownerName = owner.json.user.username;
  const bobName = bob.json.user.username;
  const flt = (query, token = ownerToken) => search({ q: 'fltx', limit: '50', ...query }, token);
  const fltPairs = (pairs, token = ownerToken) => req(`/search?${new URLSearchParams(pairs)}`, { token });
  const fltImage = await sharp({ create: { width: 6, height: 6, channels: 3, background: { r: 9, g: 99, b: 199 } } })
    .png()
    .toBuffer();
  const fltUpload = async (token, type, name, bytes) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), name);
    const res = await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    return (await res.json()).id;
  };
  const fltPostWith = async (content, attachmentId) =>
    req(`/channels/${searchChannelId}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content, attachmentIds: [attachmentId] },
    });
  const fltBefore = Date.now();
  await postInSearch(ownerToken, 'fltx plain words');
  await postInSearch(bobToken, `fltx link https://example.invalid/page and hello @${ownerName}`);
  await fltPostWith('fltx picture', await fltUpload(ownerToken, 'image/png', 'p.png', fltImage));
  await fltPostWith(
    'fltx gif',
    await fltUpload(ownerToken, 'image/gif', 'g.gif', await sharp(fltImage).gif().toBuffer()),
  );
  const fltPinned = await postInSearch(ownerToken, 'fltx pinned one');
  await req(`/channels/${searchChannelId}/pins/${fltPinned.json.id}`, { method: 'PUT', token: ownerToken });
  const fltAfter = Date.now() + 1;

  const texts = (res) => (res.json?.messages ?? []).map((message) => message.content);
  check('from: finds one author by username', texts(await flt({ from: bobName })).length === 1);
  check('from: ignores case', texts(await flt({ from: bobName.toUpperCase() })).length === 1);
  const fromMany = await fltPairs([['q', 'fltx'], ['from', bobName], ['from', ownerName], ['limit', '50']]);
  check('several from: values mean either author', texts(fromMany).length === 5, `got ${texts(fromMany).length}`);
  check('from: a name nobody has finds nothing', texts(await flt({ from: 'nobody-here' })).length === 0);
  check('mentions: finds messages naming a member', texts(await flt({ mentions: ownerName })).length === 1);
  check('mentions: leaves out messages naming nobody', texts(await flt({ mentions: bobName })).length === 0);
  await postInSearch(bobToken, `fltz @${ownerName}by and x@${ownerName}`);
  check(
    'mentions: a longer name or an email address is not a mention',
    texts(await search({ q: 'fltz', limit: '50', mentions: ownerName }, ownerToken)).length === 0,
  );
  check('in: narrows to a channel by name, ignoring case', texts(await flt({ in: 'SearchRoom' })).length === 5);
  check('in: another channel finds nothing here', texts(await flt({ in: 'general' })).length === 0);
  const inUnknown = await flt({ in: 'no-such-room' });
  check(
    'in: an unknown channel is 404 no_such_channel',
    inUnknown.status === 404 && inUnknown.json?.error?.code === 'no_such_channel',
    JSON.stringify(inUnknown.json),
  );
  check('has:image finds pictures and gifs', texts(await flt({ has: 'image' })).length === 2);
  check('has:gif finds only gifs', texts(await flt({ has: 'gif' })).join() === 'fltx gif');
  check('has:file finds any attachment (uploads are images or videos)', texts(await flt({ has: 'file' })).length === 2);
  check('has:video finds none here', texts(await flt({ has: 'video' })).length === 0);
  check('has:link finds links', texts(await flt({ has: 'link' })).length === 1);
  check('has:pin finds pinned messages', texts(await flt({ has: 'pin' })).join() === 'fltx pinned one');
  check('has:sticker finds none here', texts(await flt({ has: 'sticker' })).length === 0);
  check('has:embed finds none here', texts(await flt({ has: 'embed' })).length === 0);
  const hasBoth = await fltPairs([['q', 'fltx'], ['has', 'image'], ['has', 'gif']]);
  check('several has: values must all hold', texts(hasBoth).join() === 'fltx gif');
  check('a bad has: value is refused (400)', (await flt({ has: 'banana' })).status === 400);
  const onlyFilter = await fltPairs([['has', 'pin'], ['in', 'searchroom']]);
  check('filters alone are a search', texts(onlyFilter).join() === 'fltx pinned one');
  const dated = await fltPairs([
    ['q', 'fltx'],
    ['sentAfter', String(fltBefore - 1)],
    ['sentBefore', String(fltAfter)],
    ['limit', '50'],
  ]);
  check('date bounds include messages in range', texts(dated).length === 5);
  check('sentBefore excludes later messages', texts(await flt({ sentBefore: String(fltBefore - 1) })).length === 0);
  check('sentAfter excludes earlier messages', texts(await flt({ sentAfter: String(fltAfter + 100000) })).length === 0);
  const newestFirst = texts(await fltPairs([['from', ownerName], ['sentAfter', String(fltBefore - 1)]]));
  check('a bound with no text lists newest first', newestFirst[0] === 'fltx pinned one', newestFirst.join('|'));

  // Filters must never reveal a channel the member cannot see.
  const hideRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'FilterSecret' } });
  const hideRoom = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'hiddenroom', requiredRoleId: hideRole.json.id },
  });
  const hiddenPost = await req(`/channels/${hideRoom.json.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: {
      content: `fltx secret @${bobName}`,
      attachmentIds: [await fltUpload(ownerToken, 'image/png', 's.png', fltImage)],
    },
  });
  await req(`/channels/${hideRoom.json.id}/pins/${hiddenPost.json.id}`, { method: 'PUT', token: ownerToken });
  check('an administrator can filter by a locked channel', texts(await flt({ in: 'hiddenroom' })).length === 1);
  const inHidden = await flt({ in: 'hiddenroom' }, bobToken);
  const inGhost = await flt({ in: 'ghostroom' }, bobToken);
  check(
    'in: a hidden channel answers like a missing one',
    inHidden.status === 404 &&
      inGhost.status === 404 &&
      inHidden.json?.error?.code === inGhost.json?.error?.code,
    `${inHidden.status} ${inGhost.status}`,
  );
  const leaks = (res) => texts(res).some((text) => text.includes('secret'));
  check('from: does not leak hidden-channel messages', !leaks(await flt({ from: ownerName }, bobToken)));
  check('mentions: does not leak hidden-channel messages', !leaks(await flt({ mentions: bobName }, bobToken)));
  check('has:image does not leak hidden-channel messages', !leaks(await flt({ has: 'image' }, bobToken)));
  check('has:pin does not leak hidden-channel messages', !leaks(await flt({ has: 'pin' }, bobToken)));
  check('dates alone do not leak hidden-channel messages', !leaks(await fltPairs([['sentAfter', String(fltBefore - 1)]], bobToken)));
  check(
    'in: a hidden channel among visible ones is still refused',
    (await fltPairs([['in', 'searchroom'], ['in', 'hiddenroom']], bobToken)).status === 404,
  );
  await req(`/channels/${hideRoom.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/roles/${hideRole.json.id}`, { method: 'DELETE', token: ownerToken });

  // --- Mentions and the inbox ---
  const mentionChannel = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'mentionroom' },
  });
  const mentionChannelId = mentionChannel.json.id;
  const replyChannel = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'replyroom' },
  });
  const replyChannelId = replyChannel.json.id;
  const postIn = (channelId, token, body) =>
    req(`/channels/${channelId}/messages`, { method: 'POST', token, body });
  const inboxFor = (token, query = {}) => req(`/mentions?${new URLSearchParams(query)}`, { token });
  const channelsFor = (token) => req('/channels', { token });

  // Two messages naming bob, and one from bob that owner replies to. Bob never
  // posts in mentionroom, so his read marker there stays behind the mentions.
  await postIn(mentionChannelId, ownerToken, { content: 'hey @bob look at this' });
  await postIn(mentionChannelId, ownerToken, { content: 'also @bob check the docs' });
  const bobRoot = await postIn(replyChannelId, bobToken, { content: 'any news?' });
  await postIn(replyChannelId, ownerToken, { content: 'later', replyToId: bobRoot.json.id });
  // Neither a self-mention nor an unknown name is a mention of anyone.
  await postIn(mentionChannelId, ownerToken, { content: 'note @owner to self' });
  await postIn(mentionChannelId, ownerToken, { content: 'hello @nobodyhere' });

  const bobInbox = (await inboxFor(bobToken)).json.mentions;
  const bobMentions = bobInbox.filter((entry) => entry.message.channelId === mentionChannelId);
  const bobReplies = bobInbox.filter((entry) => entry.message.channelId === replyChannelId);
  check(
    'name mentions reach the inbox, newest first',
    bobMentions.length === 2 &&
      bobMentions[0].message.content === 'also @bob check the docs' &&
      bobMentions[1].message.content === 'hey @bob look at this' &&
      bobMentions.every((entry) => entry.kind === 'mention'),
  );
  check(
    'a reply reaches the inbox of the one replied to',
    bobReplies.length === 1 && bobReplies[0].kind === 'reply' && bobReplies[0].message.content === 'later',
  );
  check('an inbox entry in an unread channel starts unread', bobInbox.every((entry) => entry.unread === true));
  check(
    'mentioning yourself is not a mention',
    !(await inboxFor(ownerToken)).json.mentions.some((entry) => entry.message.content.includes('@owner')),
  );
  check(
    'an unknown name is not a mention',
    !bobInbox.some((entry) => entry.message.content.includes('@nobodyhere')),
  );
  const bobChannelList = (await channelsFor(bobToken)).json.mentionChannelIds;
  check(
    'a channel holding an unread mention is marked',
    bobChannelList.includes(mentionChannelId) && bobChannelList.includes(replyChannelId),
  );

  const mentionPageOne = (await inboxFor(bobToken, { limit: '2' })).json.mentions;
  const mentionPageTwo = (
    await inboxFor(bobToken, {
      limit: '2',
      before: mentionPageOne.at(-1).message.createdAt,
      beforeId: mentionPageOne.at(-1).message.id,
    })
  ).json.mentions;
  check(
    'the inbox pages backwards with the cursor',
    mentionPageOne.length === 2 &&
      mentionPageTwo.length === 1 &&
      !mentionPageOne.some((page) => mentionPageTwo.some((older) => older.message.id === page.message.id)),
  );

  await req(`/channels/${mentionChannelId}/read`, { method: 'POST', token: bobToken });
  await req(`/channels/${replyChannelId}/read`, { method: 'POST', token: bobToken });
  const bobChannelsAfterRead = (await channelsFor(bobToken)).json.mentionChannelIds;
  check(
    'reading the channel clears its mention mark',
    !bobChannelsAfterRead.includes(mentionChannelId) && !bobChannelsAfterRead.includes(replyChannelId),
  );
  check(
    'reading the channel marks its mentions read',
    (await inboxFor(bobToken)).json.mentions.every((entry) => entry.unread === false),
  );

  // A deleted message leaves the inbox, though its row is only soft-deleted.
  await postIn(mentionChannelId, ownerToken, { content: '@bob this will go' });
  const vanishing = (await inboxFor(bobToken)).json.mentions.find((entry) =>
    entry.message.content.includes('this will go'),
  );
  await req(`/messages/${vanishing.message.id}`, { method: 'DELETE', token: ownerToken });
  check(
    'a deleted mention leaves the inbox',
    !(await inboxFor(bobToken)).json.mentions.some((entry) => entry.message.content.includes('this will go')),
  );

  // A locked channel's mention must not show up for someone who cannot see it.
  const inboxLockRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Inbox' } });
  const inboxLocked = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'inboxsecret', requiredRoleId: inboxLockRole.json.id },
  });
  await postIn(inboxLocked.json.id, ownerToken, { content: 'psst @bob hidden away' });
  check(
    'a mention in a channel the member cannot see stays out of the inbox',
    !(await inboxFor(bobToken)).json.mentions.some((entry) => entry.message.content.includes('hidden away')),
  );
  await req(`/channels/${inboxLocked.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/roles/${inboxLockRole.json.id}`, { method: 'DELETE', token: ownerToken });

  // A member linked to a Discord account is still a member. Only stand-in
  // accounts are skipped, so a link must not stop mentions reaching them.
  await req(`/members/${bobId}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { discordId: '111222333444555666' },
  });
  await postIn(mentionChannelId, ownerToken, { content: 'psst @bob linked ping' });
  check(
    'a mention reaches a member who is linked to Discord',
    (await inboxFor(bobToken)).json.mentions.some((entry) => entry.message.content.includes('linked ping')),
  );
  await req(`/members/${bobId}`, { method: 'PATCH', token: ownerToken, body: { discordId: null } });

  // --- Mention counts and unread state ---
  // The channel list counts unread mentions per channel rather than flagging
  // them, says how far each channel was read, and ignores deleted messages.
  {
    const countsRoom = (await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'countsroom' } }))
      .json.id;
    const listFor = async (token) => (await channelsFor(token)).json;
    await postIn(countsRoom, ownerToken, { content: '@bob one' });
    await postIn(countsRoom, ownerToken, { content: '@bob two' });
    const third = await postIn(countsRoom, ownerToken, { content: '@bob three' });
    await postIn(countsRoom, ownerToken, { content: 'nobody named here' });

    let list = await listFor(bobToken);
    check('every unread mention in a channel is counted', list.mentionCounts?.[countsRoom] === 3);
    check('the counted channels are the mention list', list.mentionChannelIds.includes(countsRoom));
    check('a channel never read has no read marker', list.readMarkers?.[countsRoom] === undefined);
    check('the poster has no mentions counted there', (await listFor(ownerToken)).mentionCounts[countsRoom] === undefined);

    await req(`/messages/${third.json.id}`, { method: 'DELETE', token: ownerToken });
    list = await listFor(bobToken);
    check('a deleted mention stops counting', list.mentionCounts[countsRoom] === 2);

    await req(`/channels/${countsRoom}/read`, { method: 'POST', token: bobToken });
    list = await listFor(bobToken);
    check(
      'reading the channel clears its count',
      list.mentionCounts[countsRoom] === undefined && !list.mentionChannelIds.includes(countsRoom),
    );
    check(
      'and moves its read marker to the newest message',
      typeof list.readMarkers[countsRoom] === 'string' && !list.unreadChannelIds.includes(countsRoom),
    );

    // A deleted message is not news: once the only new message goes, so does the mark.
    const fleeting = await postIn(countsRoom, ownerToken, { content: 'here and gone' });
    check('a new message makes the channel unread', (await listFor(bobToken)).unreadChannelIds.includes(countsRoom));
    await req(`/messages/${fleeting.json.id}`, { method: 'DELETE', token: ownerToken });
    check(
      'deleting it leaves the channel read again',
      !(await listFor(bobToken)).unreadChannelIds.includes(countsRoom),
    );

    // A mention in a channel locked away from bob is never counted for him.
    const countsRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Counts' } });
    const countsLocked = await req('/channels', {
      method: 'POST',
      token: ownerToken,
      body: { name: 'countslocked', requiredRoleId: countsRole.json.id },
    });
    await postIn(countsLocked.json.id, ownerToken, { content: '@bob behind a lock' });
    list = await listFor(bobToken);
    check(
      'a locked channel leaks no mention count, unread mark or read marker',
      list.mentionCounts[countsLocked.json.id] === undefined &&
        !list.unreadChannelIds.includes(countsLocked.json.id) &&
        list.readMarkers[countsLocked.json.id] === undefined,
    );
    await req(`/channels/${countsLocked.json.id}`, { method: 'DELETE', token: ownerToken });
    await req(`/roles/${countsRole.json.id}`, { method: 'DELETE', token: ownerToken });
    await req(`/channels/${countsRoom}`, { method: 'DELETE', token: ownerToken });
  }

  // --- Mute and notification settings ---
  {
    const settingsOf = async (token) => (await req('/users/@me/channel-settings', { token })).json?.settings ?? [];
    const put = (targetId, body, token = bobToken) =>
      req(`/users/@me/channel-settings/${targetId}`, { method: 'PUT', token, body });
    const quietCategory = (
      await req('/categories', { method: 'POST', token: ownerToken, body: { name: 'Quiet corner' } })
    ).json;
    const quietRoom = (
      await req('/channels', {
        method: 'POST',
        token: ownerToken,
        body: { name: 'quietroom', categoryId: quietCategory.id },
      })
    ).json;

    check('nobody starts with any settings', (await settingsOf(bobToken)).length === 0);
    check(
      'reading settings needs a session (401)',
      (await req('/users/@me/channel-settings')).status === 401,
    );

    const bobWatcher = await openGateway({ token: bobToken });
    const ownerWatcher = await openGateway({ token: ownerToken });
    const before = Date.now();
    const muted = await put(quietRoom.id, { muted: true, muteSeconds: 900 });
    const endsIn = Date.parse(muted.json?.muteEndsAt ?? '') - before;
    check(
      'muting a channel for 15 minutes is accepted',
      muted.status === 200 &&
        muted.json.targetType === 'channel' &&
        muted.json.muted === true &&
        endsIn > 899_000 &&
        endsIn < 905_000 &&
        muted.json.level === 'default',
      JSON.stringify(muted.json),
    );
    await sleep(250);
    check(
      'the change reaches the member\'s own sessions',
      bobWatcher.events.some((event) => event.t === 'CHANNEL_SETTINGS_UPDATE' && event.d?.targetId === quietRoom.id),
    );
    check(
      'and nobody else\'s',
      !ownerWatcher.events.some((event) => event.t === 'CHANNEL_SETTINGS_UPDATE'),
    );
    bobWatcher.ws.close();
    ownerWatcher.ws.close();

    const leveled = await put(quietRoom.id, { level: 'mentions' });
    check(
      'changing the level leaves the mute alone',
      leveled.json?.level === 'mentions' && leveled.json.muted === true && leveled.json.muteEndsAt === muted.json.muteEndsAt,
    );

    const categoryMuted = await put(quietCategory.id, { muted: true });
    check(
      'a category can be muted until turned back on',
      categoryMuted.status === 200 &&
        categoryMuted.json.targetType === 'category' &&
        categoryMuted.json.muted === true &&
        categoryMuted.json.muteEndsAt === null,
    );
    await put(quietCategory.id, { level: 'nothing' });
    let mine = await settingsOf(bobToken);
    const ofRoom = mine.find((entry) => entry.targetId === quietRoom.id);
    const ofCategory = mine.find((entry) => entry.targetId === quietCategory.id);
    check(
      'channel and category settings are kept apart, the channel only inheriting on the client',
      mine.length === 2 && ofRoom?.level === 'mentions' && ofCategory?.level === 'nothing' && ofCategory?.muted === true,
    );
    // Positive control: the owner holds a setting of their own, so "only visible
    // to their owner" is checked against a non-empty list rather than passing on
    // an empty one.
    const ownerRoom = (
      await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'owner-settings' } })
    ).json;
    await put(ownerRoom.id, { muted: true }, ownerToken);
    const ownerSettings = await settingsOf(ownerToken);
    check(
      'settings are only visible to their owner',
      ownerSettings.length === 1 &&
        ownerSettings[0].targetId === ownerRoom.id &&
        !ownerSettings.some((entry) => entry.targetId === quietRoom.id || entry.targetId === quietCategory.id),
      JSON.stringify(ownerSettings),
    );
    await req(`/channels/${ownerRoom.id}`, { method: 'DELETE', token: ownerToken });

    await put(quietCategory.id, { muted: false });
    mine = await settingsOf(bobToken);
    check(
      'unmuting the category keeps its level and the channel\'s own settings',
      mine.find((entry) => entry.targetId === quietCategory.id)?.level === 'nothing' &&
        mine.find((entry) => entry.targetId === quietRoom.id)?.muted === true,
    );

    const unmuted = await put(quietRoom.id, { muted: false });
    check(
      'unmuting a channel keeps its level',
      unmuted.json?.muted === false && unmuted.json.muteEndsAt === null && unmuted.json.level === 'mentions',
    );
    await put(quietRoom.id, { level: 'default' });
    check(
      'settings back on the defaults are forgotten',
      !(await settingsOf(bobToken)).some((entry) => entry.targetId === quietRoom.id),
    );

    // A short mute lifts on its own, read off the clock rather than swept.
    await put(quietRoom.id, { muted: true, muteSeconds: 1 });
    await sleep(1300);
    const expired = (await settingsOf(bobToken)).find((entry) => entry.targetId === quietRoom.id);
    check(
      'an expired mute reads as no mute',
      expired !== undefined && expired.muted === false && expired.muteEndsAt === null,
    );
    check(
      'and stays lifted when something else changes',
      (await put(quietRoom.id, { level: 'all' })).json?.muted === false,
    );

    for (const [body, why] of [
      [{}, 'an empty change'],
      [{ muted: true, muteSeconds: 0 }, 'a zero-length mute'],
      [{ muted: true, muteSeconds: 1.5 }, 'a fractional mute'],
      [{ muted: true, muteSeconds: 400 * 24 * 60 * 60 }, 'a mute longer than a year'],
      [{ muteSeconds: 60 }, 'a length without muting'],
      [{ muted: false, muteSeconds: 60 }, 'a length while unmuting'],
      [{ level: 'loud' }, 'an unknown level'],
      [{ muted: 'yes' }, 'a muted flag that is not a boolean'],
    ]) {
      check(`${why} is refused (400)`, (await put(quietRoom.id, body)).status === 400);
    }
    check('an unknown target is refused (404)', (await put('no-such-channel', { muted: true })).status === 404);

    // A locked channel answers exactly like a missing one, so it cannot be probed.
    const settingsRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Settings' } });
    const settingsLocked = await req('/channels', {
      method: 'POST',
      token: ownerToken,
      body: { name: 'settingslocked', requiredRoleId: settingsRole.json.id },
    });
    check(
      'a channel the member cannot see is refused like a missing one (404)',
      (await put(settingsLocked.json.id, { muted: true })).status === 404,
    );
    check(
      'while someone who can see it may mute it',
      (await put(settingsLocked.json.id, { muted: true }, ownerToken)).status === 200,
    );

    // Two first saves of the same target at once must upsert rather than have
    // one collide on the partial unique index and 500. Both are accepted and one
    // row is kept, holding whichever write won.
    const upsertRoom = (
      await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'settings-race' } })
    ).json;
    const raceWrites = await Promise.all([
      put(upsertRoom.id, { level: 'mentions' }),
      put(upsertRoom.id, { level: 'nothing' }),
    ]);
    check(
      'two first saves of the same target do not collide',
      raceWrites.every((result) => result.status === 200),
      JSON.stringify(raceWrites.map((result) => result.status)),
    );
    const raced = (await settingsOf(bobToken)).filter((entry) => entry.targetId === upsertRoom.id);
    check(
      'and exactly one row is kept, holding one of the written values',
      raced.length === 1 && (raced[0].level === 'mentions' || raced[0].level === 'nothing'),
      JSON.stringify(raced),
    );
    await req(`/channels/${upsertRoom.id}`, { method: 'DELETE', token: ownerToken });

    await req(`/channels/${settingsLocked.json.id}`, { method: 'DELETE', token: ownerToken });
    check(
      'deleting a channel takes its settings with it',
      !(await settingsOf(ownerToken)).some((entry) => entry.targetId === settingsLocked.json.id),
    );
    await req(`/roles/${settingsRole.json.id}`, { method: 'DELETE', token: ownerToken });
    await req(`/channels/${quietRoom.id}`, { method: 'DELETE', token: ownerToken });
    await req(`/categories/${quietCategory.id}`, { method: 'DELETE', token: ownerToken });
    check(
      'and deleting a category takes its own',
      !(await settingsOf(bobToken)).some((entry) => entry.targetId === quietCategory.id),
    );
  }

  // --- Audit log ---
  check('the audit log needs ManageServer (403)', (await req('/audit', { token: bobToken })).status === 403);

  // Produce one of each kind here, so the assertions below cannot depend on how
  // much earlier activity has pushed older entries off the first page. The
  // target is modtarget rather than bob, because kicking ends their sessions
  // and the checks that follow still use bob's token.
  const auditRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Audited' } });
  await req(`/members/${modId}/roles/${auditRole.json.id}`, { method: 'PUT', token: ownerToken });
  await req(`/members/${modId}/roles/${auditRole.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/members/${modId}/timeout`, { method: 'PUT', token: ownerToken, body: { durationMinutes: 5 } });
  await req(`/members/${modId}/timeout`, { method: 'DELETE', token: ownerToken });
  await req(`/members/${modId}/kick`, { method: 'POST', token: ownerToken });
  await req(`/members/${modId}/ban`, { method: 'PUT', token: ownerToken, body: { reason: 'audit check' } });
  await req(`/members/${modId}/ban`, { method: 'DELETE', token: ownerToken });

  const auditedMessage = await req(`/channels/${colorChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'original text' },
  });
  await req(`/messages/${auditedMessage.json.id}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { content: 'changed text' },
  });
  await req(`/messages/${auditedMessage.json.id}`, { method: 'DELETE', token: ownerToken });

  // A deletion that carried an image keeps a link to the file, since only the
  // message row is soft-deleted and the bytes are still on disk.
  const auditUpload = new FormData();
  auditUpload.append('file', new Blob([emojiPng], { type: 'image/png' }), 'audited.png');
  const auditAttachment = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: auditUpload,
    })
  ).json();
  const imageMessage = await req(`/channels/${colorChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'has an image', attachmentIds: [auditAttachment.id] },
  });
  await req(`/messages/${imageMessage.json.id}`, { method: 'DELETE', token: ownerToken });

  const audit = (await req('/audit?limit=100', { token: ownerToken })).json;
  const auditKinds = new Set((audit?.entries ?? []).map((entry) => entry.kind));
  check(
    'every audited kind is recorded',
    [
      'message_edit',
      'message_delete',
      'timeout_add',
      'timeout_clear',
      'kick',
      'ban',
      'unban',
      'role_add',
      'role_remove',
      'member_update',
      'password_reset',
    ].every((kind) => auditKinds.has(kind)),
    [...auditKinds].join(', '),
  );

  const editedEntry = (audit?.entries ?? []).find(
    (entry) => entry.kind === 'message_edit' && entry.detail.before === 'original text',
  );
  check(
    'an edit keeps the text either side',
    editedEntry?.detail?.after === 'changed text' && editedEntry?.detail?.channelName === colorChannel.name,
  );

  const removedEntry = (audit?.entries ?? []).find(
    (entry) => entry.kind === 'message_delete' && entry.detail.before === 'changed text',
  );
  check('a deletion keeps the text that was removed', Boolean(removedEntry));

  const imageEntry = (audit?.entries ?? []).find(
    (entry) => entry.kind === 'message_delete' && entry.detail.before === 'has an image',
  );
  check(
    'a deletion keeps a link to the images it carried',
    imageEntry?.detail.attachments?.[0]?.filename === 'audited.png',
    JSON.stringify(imageEntry?.detail),
  );
  check(
    'the deleted image is still served so the log can show it',
    (
      await fetch(`${BASE}/attachments/${auditAttachment.id}`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).status === 200,
  );

  const banEntry = (audit?.entries ?? []).find(
    (entry) => entry.kind === 'ban' && entry.detail.reason === 'audit check',
  );
  check(
    'an entry names the actor and the target',
    banEntry?.actor?.username === 'alice' && banEntry?.target?.username === 'modtarget',
  );

  const roleEntry = (audit?.entries ?? []).find(
    (entry) => entry.kind === 'role_add' && entry.detail.roleName === 'Audited',
  );
  check('a role change records the role name', Boolean(roleEntry));

  const profileEntry = (audit?.entries ?? []).find(
    (entry) => entry.kind === 'member_update' && entry.detail.fields?.includes('username'),
  );
  check(
    'editing an account records the fields that changed',
    profileEntry?.actor?.username === 'alice' && profileEntry?.target?.username === 'renameduser',
  );

  const resetEntry = (audit?.entries ?? []).find((entry) => entry.kind === 'password_reset');
  check(
    'a password reset is logged against the target',
    resetEntry?.actor?.username === 'alice' && resetEntry?.target?.username === 'renameduser',
  );

  const newest = audit?.entries?.[0];
  const olderPage = newest
    ? await req(
        `/audit?limit=1&before=${encodeURIComponent(newest.createdAt)}&beforeId=${newest.id}`,
        { token: ownerToken },
      )
    : { status: 0, json: null };
  check(
    'the audit log pages backwards',
    olderPage.status === 200 && olderPage.json?.entries?.length === 1 && olderPage.json.entries[0].id !== newest?.id,
  );

  await req(`/roles/${auditRole.json.id}`, { method: 'DELETE', token: ownerToken });

  // --- Pinned messages ---
  const pinChannel = (await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'pinboard' } })).json;
  const postInPins = (content) =>
    req(`/channels/${pinChannel.id}/messages`, { method: 'POST', token: ownerToken, body: { content } });
  const pinsIn = (channelId, token = ownerToken) => req(`/channels/${channelId}/pins`, { token });
  const pinFirst = (await postInPins('pin me first')).json;
  const pinSecond = (await postInPins('pin me second')).json;

  check('a new message is not pinned', pinFirst.pinnedAt === null);
  check('an empty channel has no pins', (await pinsIn(pinChannel.id)).json?.messages?.length === 0);

  const pinWatcher = await openGateway({ token: bobToken });
  const pinned = await req(`/channels/${pinChannel.id}/pins/${pinFirst.id}`, { method: 'PUT', token: ownerToken });
  check(
    'a message can be pinned',
    pinned.status === 200 && typeof pinned.json?.pinnedAt === 'string',
    `status ${pinned.status}`,
  );
  await sleep(250);
  const pinUpdate = pinWatcher.events.find((frame) => frame.t === 'MESSAGE_UPDATE' && frame.d?.id === pinFirst.id);
  check('pinning broadcasts MESSAGE_UPDATE carrying the pin time', pinUpdate?.d?.pinnedAt === pinned.json?.pinnedAt);

  const repinned = await req(`/channels/${pinChannel.id}/pins/${pinFirst.id}`, { method: 'PUT', token: ownerToken });
  check('pinning again keeps the original pin time', repinned.json?.pinnedAt === pinned.json?.pinnedAt);

  // Pin times are ISO strings to the millisecond; make sure the second is later.
  await sleep(5);
  await req(`/channels/${pinChannel.id}/pins/${pinSecond.id}`, { method: 'PUT', token: ownerToken });
  const pinList = await pinsIn(pinChannel.id, bobToken);
  check(
    'any member who can see the channel lists its pins, newest pin first',
    pinList.status === 200 &&
      pinList.json?.messages?.map((message) => message.id).join() === [pinSecond.id, pinFirst.id].join(),
    JSON.stringify(pinList.json?.messages?.map((message) => message.content)),
  );
  check(
    'history carries the pin state',
    (await req(`/channels/${pinChannel.id}/messages`, { token: bobToken })).json?.messages?.find(
      (message) => message.id === pinFirst.id,
    )?.pinnedAt === pinned.json?.pinnedAt,
  );

  check(
    'a plain member cannot pin (403)',
    (await req(`/channels/${pinChannel.id}/pins/${pinSecond.id}`, { method: 'PUT', token: bobToken })).status === 403,
  );
  check(
    'a plain member cannot unpin (403)',
    (await req(`/channels/${pinChannel.id}/pins/${pinFirst.id}`, { method: 'DELETE', token: bobToken })).status ===
      403,
  );
  check(
    'a message cannot be pinned through another channel (404)',
    (await req(`/channels/${colorChannel.id}/pins/${pinFirst.id}`, { method: 'PUT', token: ownerToken })).status ===
      404,
  );

  pinWatcher.events.length = 0;
  const unpinned = await req(`/channels/${pinChannel.id}/pins/${pinFirst.id}`, { method: 'DELETE', token: ownerToken });
  await sleep(250);
  check('a message can be unpinned', unpinned.status === 204, `status ${unpinned.status}`);
  check(
    'unpinning broadcasts MESSAGE_UPDATE with no pin time',
    pinWatcher.events.some(
      (frame) => frame.t === 'MESSAGE_UPDATE' && frame.d?.id === pinFirst.id && frame.d?.pinnedAt === null,
    ),
  );
  check(
    'an unpinned message leaves the list',
    (await pinsIn(pinChannel.id)).json?.messages?.every((message) => message.id !== pinFirst.id),
  );
  check(
    'unpinning one that is not pinned is harmless',
    (await req(`/channels/${pinChannel.id}/pins/${pinFirst.id}`, { method: 'DELETE', token: ownerToken })).status ===
      204,
  );
  pinWatcher.ws.close();

  // Pinning is a moderation act, so it lands in the log, with the text it pinned.
  // Checked now, before the cap test below floods the first page with pins.
  const pinAudit = (await req('/audit', { token: ownerToken })).json?.entries ?? [];
  check(
    'pins and unpins are recorded in the audit log',
    pinAudit.some((entry) => entry.kind === 'message_pin' && entry.detail?.channelName === 'pinboard') &&
      pinAudit.some((entry) => entry.kind === 'message_unpin' && entry.detail?.before === 'pin me first'),
  );

  // A deleted message drops out of the pins, and stops counting towards the cap.
  await req(`/messages/${pinSecond.id}`, { method: 'DELETE', token: ownerToken });
  check('a deleted message drops out of the pins', (await pinsIn(pinChannel.id)).json?.messages?.length === 0);

  // Discord's cap of 50 per channel, with a clear error past it.
  const pinCap = (await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'pin-cap' } })).json;
  const capIds = [];
  for (let index = 0; index < 51; index++) {
    const posted = await req(`/channels/${pinCap.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: `cap ${index}` },
    });
    capIds.push(posted.json.id);
  }
  let capPinned = 0;
  for (const id of capIds.slice(0, 50)) {
    const result = await req(`/channels/${pinCap.id}/pins/${id}`, { method: 'PUT', token: ownerToken });
    if (result.status === 200) capPinned++;
  }
  check('a channel holds 50 pins', capPinned === 50 && (await pinsIn(pinCap.id)).json?.messages?.length === 50);
  const overCap = await req(`/channels/${pinCap.id}/pins/${capIds[50]}`, { method: 'PUT', token: ownerToken });
  check(
    'a 51st pin is refused with a clear error (400)',
    overCap.status === 400 &&
      overCap.json?.error?.code === 'too_many_pins' &&
      /50/.test(overCap.json?.error?.message ?? ''),
    JSON.stringify(overCap.json),
  );
  await req(`/messages/${capIds[0]}`, { method: 'DELETE', token: ownerToken });
  check(
    'a deleted pin frees its place under the cap',
    (await req(`/channels/${pinCap.id}/pins/${capIds[50]}`, { method: 'PUT', token: ownerToken })).status === 200,
  );

  // Two pins racing for the last slot: the cap is enforced by the write itself,
  // so exactly one can land and the channel can never tip over 50. The outcome
  // is deterministic (one winner regardless of order), not a flaky race.
  const pinRace = (await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'pin-race' } })).json;
  const raceIds = [];
  for (let index = 0; index < 51; index++) {
    const posted = await req(`/channels/${pinRace.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: `race ${index}` },
    });
    raceIds.push(posted.json.id);
  }
  for (const id of raceIds.slice(0, 49)) {
    await req(`/channels/${pinRace.id}/pins/${id}`, { method: 'PUT', token: ownerToken });
  }
  const race = await Promise.all([
    req(`/channels/${pinRace.id}/pins/${raceIds[49]}`, { method: 'PUT', token: ownerToken }),
    req(`/channels/${pinRace.id}/pins/${raceIds[50]}`, { method: 'PUT', token: ownerToken }),
  ]);
  check(
    'two pins racing for the last slot cannot both land',
    race.map((result) => result.status).sort().join() === '200,400' &&
      (await pinsIn(pinRace.id)).json?.messages?.length === 50 &&
      race
        .filter((result) => result.status === 400)
        .every((result) => result.json?.error?.code === 'too_many_pins'),
    JSON.stringify(race.map((result) => ({ status: result.status, code: result.json?.error?.code }))),
  );

  // A locked channel's pins are as hidden as its history.
  const pinLockRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Pin keepers' } });
  const lockedPins = (
    await req('/channels', {
      method: 'POST',
      token: ownerToken,
      body: { name: 'locked-pins', requiredRoleId: pinLockRole.json.id },
    })
  ).json;
  const lockedPost = (
    await req(`/channels/${lockedPins.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'secret pin' },
    })
  ).json;
  const lockedWatcher = await openGateway({ token: bobToken });
  // Positive control: a pin in a channel this member can see does reach him, so
  // the check below is not passing merely because his gateway is silent.
  const publicPinRoom = (
    await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'public-pins' } })
  ).json;
  const publicPost = (
    await req(`/channels/${publicPinRoom.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'public pin' },
    })
  ).json;
  await req(`/channels/${publicPinRoom.id}/pins/${publicPost.id}`, { method: 'PUT', token: ownerToken });
  await sleep(250);
  check(
    'a pin in a channel the member can see is broadcast',
    lockedWatcher.events.some(
      (frame) => frame.t === 'MESSAGE_UPDATE' && frame.d?.channelId === publicPinRoom.id && frame.d?.pinnedAt,
    ),
  );
  await req(`/channels/${lockedPins.id}/pins/${lockedPost.id}`, { method: 'PUT', token: ownerToken });
  await sleep(250);
  check(
    'a locked channel lists its pins for an administrator',
    (await pinsIn(lockedPins.id)).json?.messages?.length === 1,
  );
  check(
    'a locked channel refuses its pins to a member without the role (403)',
    (await pinsIn(lockedPins.id, bobToken)).status === 403,
  );
  check(
    'a pin in a locked channel is not broadcast to a member without the role',
    !lockedWatcher.events.some((frame) => frame.d?.channelId === lockedPins.id),
  );
  await req(`/channels/${publicPinRoom.id}`, { method: 'DELETE', token: ownerToken });
  lockedWatcher.ws.close();

  // --- Saved messages ---
  const savedChannel = (await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'bookmarks' } }))
    .json;
  const postInSaved = async (content, channelId = savedChannel.id) =>
    (await req(`/channels/${channelId}/messages`, { method: 'POST', token: ownerToken, body: { content } })).json;
  const savedOf = (token, query = '') => req(`/users/@me/saved${query}`, { token });
  const saveAs = (token, messageId, body) => req(`/users/@me/saved/${messageId}`, { method: 'PUT', token, body });
  const savedIds = (response) => (response.json?.saved ?? []).map((entry) => entry.message.id).join();
  const keepFirst = await postInSaved('keep me');
  const keepSecond = await postInSaved('keep me too');

  check('a new message is not saved', keepFirst.saved === false);
  check('nothing is saved at first', (await savedOf(bobToken)).json?.saved?.length === 0);

  // Bob's second session, to see a save follow him, and Alice's, to see it does not reach her.
  const bobElsewhere = await openGateway({ token: bobToken });
  const aliceWatching = await openGateway({ token: ownerToken });
  const savedOne = await saveAs(bobToken, keepFirst.id);
  check(
    'any member who can see a message can save it',
    savedOne.status === 200 &&
      savedOne.json?.message?.id === keepFirst.id &&
      savedOne.json.message.saved === true &&
      savedOne.json.remindAt === null,
    `status ${savedOne.status}`,
  );
  await sleep(250);
  check(
    "a save reaches the saver's other sessions",
    bobElsewhere.events.some(
      (frame) =>
        frame.t === 'SAVED_MESSAGE_UPDATE' &&
        frame.d?.messageId === keepFirst.id &&
        frame.d?.saved?.savedAt === savedOne.json?.savedAt,
    ),
  );
  check(
    'a save is sent to nobody else, not even as a message update',
    aliceWatching.events.every(
      (frame) => frame.t !== 'SAVED_MESSAGE_UPDATE' && !(frame.t === 'MESSAGE_UPDATE' && frame.d?.id === keepFirst.id),
    ),
  );

  bobElsewhere.events.length = 0;
  const savedAgain = await saveAs(bobToken, keepFirst.id);
  await sleep(250);
  check(
    'saving again keeps the original save time',
    savedAgain.status === 200 && savedAgain.json?.savedAt === savedOne.json?.savedAt,
  );
  check(
    'saving again changes nothing, so nothing is sent',
    bobElsewhere.events.every((frame) => frame.t !== 'SAVED_MESSAGE_UPDATE'),
  );

  // Save times are ISO strings to the millisecond; make sure the second is later.
  await sleep(5);
  await saveAs(bobToken, keepSecond.id);
  check(
    'the saved list is newest save first',
    savedIds(await savedOf(bobToken)) === [keepSecond.id, keepFirst.id].join(),
  );
  check(
    'history marks a message saved for whoever saved it',
    (await req(`/channels/${savedChannel.id}/messages`, { token: bobToken })).json?.messages?.find(
      (message) => message.id === keepFirst.id,
    )?.saved === true,
  );
  check(
    'and for nobody else',
    (await req(`/channels/${savedChannel.id}/messages`, { token: ownerToken })).json?.messages?.find(
      (message) => message.id === keepFirst.id,
    )?.saved === false,
  );
  check("another member's saved list does not show them", (await savedOf(ownerToken)).json?.saved?.length === 0);

  const savedTop = (await savedOf(bobToken, '?limit=1')).json?.saved ?? [];
  const savedNext = savedTop[0]
    ? (
        await savedOf(
          bobToken,
          `?limit=1&before=${encodeURIComponent(savedTop[0].savedAt)}&beforeId=${savedTop[0].message.id}`,
        )
      ).json?.saved ?? []
    : [];
  check(
    'the saved list pages backwards',
    savedTop.length === 1 &&
      savedTop[0].message.id === keepSecond.id &&
      savedNext.length === 1 &&
      savedNext[0].message.id === keepFirst.id,
    JSON.stringify([savedTop.map((entry) => entry.message.content), savedNext.map((entry) => entry.message.content)]),
  );

  // Reminders ride on the save.
  const remindAt = new Date(Date.now() + 3_600_000).toISOString();
  const reminded = await saveAs(bobToken, keepFirst.id, { remindAt });
  check(
    'a save can carry a reminder, without moving in the list',
    reminded.status === 200 && reminded.json?.remindAt === remindAt && reminded.json?.savedAt === savedOne.json?.savedAt,
    JSON.stringify(reminded.json),
  );
  check('the reminders list holds it', savedIds(await savedOf(bobToken, '?reminders=true')) === keepFirst.id);
  check(
    'saving again without a reminder keeps the one it had',
    (await saveAs(bobToken, keepFirst.id)).json?.remindAt === remindAt,
  );
  check(
    'a reminder in the past is refused (400)',
    (await saveAs(bobToken, keepFirst.id, { remindAt: '2000-01-01T00:00:00.000Z' })).status === 400,
  );
  check(
    'a reminder that is not a time is refused (400)',
    (await saveAs(bobToken, keepFirst.id, { remindAt: 'tomorrow' })).status === 400,
  );
  const unreminded = await saveAs(bobToken, keepFirst.id, { remindAt: null });
  check(
    'a reminder can be cleared, leaving the message saved',
    unreminded.json?.remindAt === null && (await savedOf(bobToken, '?reminders=true')).json?.saved?.length === 0,
  );

  check(
    'a message that does not exist cannot be saved (404)',
    (await saveAs(bobToken, 'no-such-message')).status === 404,
  );

  bobElsewhere.events.length = 0;
  const unsaved = await req(`/users/@me/saved/${keepSecond.id}`, { method: 'DELETE', token: bobToken });
  await sleep(250);
  check('a save can be removed', unsaved.status === 204, `status ${unsaved.status}`);
  check(
    'removing it reaches the other sessions too',
    bobElsewhere.events.some(
      (frame) => frame.t === 'SAVED_MESSAGE_UPDATE' && frame.d?.messageId === keepSecond.id && frame.d?.saved === null,
    ),
  );
  check(
    "a removal names the message's channel so it can be routed",
    bobElsewhere.events.some(
      (frame) =>
        frame.t === 'SAVED_MESSAGE_UPDATE' &&
        frame.d?.messageId === keepSecond.id &&
        frame.d?.channelId === savedChannel.id,
    ),
  );
  check('a removed save leaves the list', savedIds(await savedOf(bobToken)) === keepFirst.id);
  check(
    'removing one that is not saved is harmless',
    (await req(`/users/@me/saved/${keepSecond.id}`, { method: 'DELETE', token: bobToken })).status === 204,
  );

  // Like a pin, a deleted message drops out: there is nothing left to jump to.
  await req(`/messages/${keepFirst.id}`, { method: 'DELETE', token: ownerToken });
  check('a deleted message drops out of the saved list', (await savedOf(bobToken)).json?.saved?.length === 0);
  check('a deleted message cannot be saved (404)', (await saveAs(bobToken, keepFirst.id)).status === 404);

  // A save in a channel the member loses is hidden, not deleted, and returns with access.
  const savedLockRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Bookmark keepers' } });
  const savedLocked = (
    await req('/channels', {
      method: 'POST',
      token: ownerToken,
      body: { name: 'locked-bookmarks', requiredRoleId: savedLockRole.json.id },
    })
  ).json;
  const lockedKeep = await postInSaved('keep this quiet', savedLocked.id);
  check(
    'a message in a locked channel cannot be saved without the role (404)',
    (await saveAs(bobToken, lockedKeep.id)).status === 404,
  );
  await req(`/members/${bob.json.user.id}/roles/${savedLockRole.json.id}`, { method: 'PUT', token: ownerToken });
  check('with the role it can be saved', (await saveAs(bobToken, lockedKeep.id)).status === 200);
  check('and it is listed', savedIds(await savedOf(bobToken)) === lockedKeep.id);
  await req(`/members/${bob.json.user.id}/roles/${savedLockRole.json.id}`, { method: 'DELETE', token: ownerToken });
  check('losing the role hides the save', (await savedOf(bobToken)).json?.saved?.length === 0);
  await req(`/members/${bob.json.user.id}/roles/${savedLockRole.json.id}`, { method: 'PUT', token: ownerToken });
  check('regaining it brings the save back', savedIds(await savedOf(bobToken)) === lockedKeep.id);
  await req(`/members/${bob.json.user.id}/roles/${savedLockRole.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/users/@me/saved/${lockedKeep.id}`, { method: 'DELETE', token: bobToken });
  await req(`/roles/${savedLockRole.json.id}`, { method: 'DELETE', token: ownerToken });
  bobElsewhere.ws.close();
  aliceWatching.ws.close();

  // Merging accounts carries the saves across, keeping one where both saved the
  // same message. Run on a throwaway database, as the Discord link merge is.
  const mergeDir = mkdtempSync(join(tmpdir(), 'harmony-saved-merge-'));
  const mergeStore = new Database({
    dataDir: mergeDir,
    dbFile: join(mergeDir, 'harmony.db'),
    uploadDir: join(mergeDir, 'uploads'),
  });
  insertUser(mergeStore.sqlite, { id: 'keeper', username: 'keeper', passwordHash: 'x', isOwner: false });
  insertUser(mergeStore.sqlite, { id: 'leaver', username: 'leaver', passwordHash: 'x', isOwner: false });
  mergeStore.sqlite
    .prepare("INSERT INTO channels (id, name, type, position, created_at) VALUES ('merge-chan', 'general', 'text', 0, ?)")
    .run(new Date().toISOString());
  for (const id of ['merge-a', 'merge-b']) {
    insertMessage(mergeStore.sqlite, {
      id,
      channelId: 'merge-chan',
      authorId: 'keeper',
      content: id,
      createdAt: new Date().toISOString(),
    });
  }
  const saveRow = mergeStore.sqlite.prepare(
    'INSERT INTO saved_messages (user_id, message_id, saved_at, remind_at) VALUES (?, ?, ?, NULL)',
  );
  saveRow.run('keeper', 'merge-a', '2026-01-01T00:00:00.000Z');
  saveRow.run('leaver', 'merge-a', '2026-02-01T00:00:00.000Z');
  saveRow.run('leaver', 'merge-b', '2026-03-01T00:00:00.000Z');
  let savedMergeError = null;
  try {
    mergeUsers(mergeStore.sqlite, 'leaver', 'keeper');
  } catch (error) {
    savedMergeError = error;
  }
  const mergedSaves = mergeStore.sqlite
    .prepare('SELECT user_id, message_id, saved_at FROM saved_messages ORDER BY message_id')
    .all();
  check(
    'merging accounts moves the saves, keeping one per message',
    savedMergeError === null &&
      mergedSaves.length === 2 &&
      mergedSaves.every((row) => row.user_id === 'keeper') &&
      mergedSaves[0].saved_at === '2026-01-01T00:00:00.000Z',
    String(savedMergeError ?? JSON.stringify(mergedSaves)),
  );
  mergeStore.close();

  // --- Scheduled messages ---
  {
  // The server runs with a short tick and a 1.5 s minimum lead (see the spawn
  // environment above), so delivery can be watched without waiting minutes.
  const schedChannel = (await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'send-later' } })).json;
  const inMs = (ms) => new Date(Date.now() + ms).toISOString();
  const schedule = (token, body, channelId = schedChannel.id) =>
    req(`/channels/${channelId}/scheduled`, { method: 'POST', token, body });
  const scheduledOf = (token) => req('/users/@me/scheduled', { token });
  const scheduledEntry = async (token, id) => (await scheduledOf(token)).json?.scheduled?.find((item) => item.id === id);
  const historyOf = async (channelId = schedChannel.id) =>
    (await req(`/channels/${channelId}/messages`, { token: ownerToken })).json?.messages ?? [];
  const uploadFor = async (token, name) => {
    const form = new FormData();
    form.append('file', new Blob([emojiPng], { type: 'image/png' }), name);
    return (await fetch(`${BASE}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form })).json();
  };
  const waitFor = async (predicate, ms = 8000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await predicate()) return true;
      await sleep(100);
    }
    return false;
  };
  const heardAbout = (watcher, id, reason) =>
    watcher.events.some((frame) => frame.t === 'SCHEDULED_MESSAGE_UPDATE' && frame.d?.id === id && frame.d?.reason === reason);

  const schedWatcher = await openGateway({ token: bobToken });
  const schedOther = await openGateway({ token: ownerToken });

  check('nothing is scheduled at first', (await scheduledOf(bobToken)).json?.scheduled?.length === 0);
  check('the scheduled list needs a session (401)', (await fetch(`${BASE}/users/@me/scheduled`)).status === 401);
  check(
    'a time too close to now is refused (400)',
    (await schedule(bobToken, { content: 'too soon', sendAt: inMs(300) })).status === 400,
  );
  check(
    'a time in the past is refused (400)',
    (await schedule(bobToken, { content: 'past', sendAt: inMs(-60_000) })).status === 400,
  );
  check(
    'a time more than a year out is refused (400)',
    (await schedule(bobToken, { content: 'far', sendAt: inMs(400 * 86_400_000) })).status === 400,
  );
  check(
    'a nonsense time is refused (400)',
    (await schedule(bobToken, { content: 'huh', sendAt: 'tomorrow-ish' })).status === 400,
  );
  check(
    'an empty message is refused (400)',
    (await schedule(bobToken, { content: '   ', sendAt: inMs(60_000) })).status === 400,
  );
  check(
    'a missing channel is refused (404)',
    (await schedule(bobToken, { content: 'x', sendAt: inMs(60_000) }, 'no-such-channel')).status === 404,
  );
  check(
    'scheduling needs a session (401)',
    (
      await fetch(`${BASE}/channels/${schedChannel.id}/scheduled`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'x', sendAt: inMs(60_000) }),
      })
    ).status === 401,
  );

  // A long-dated one, to edit, cancel and keep private.
  const farOne = await schedule(bobToken, { content: 'next week', sendAt: inMs(7 * 86_400_000) });
  check(
    'a message can be scheduled',
    farOne.status === 201 && farOne.json?.status === 'pending' && farOne.json?.content === 'next week',
    `status ${farOne.status}`,
  );
  check('and is listed for its author', (await scheduledOf(bobToken)).json?.scheduled?.[0]?.id === farOne.json?.id);
  check(
    'the author is told on their sessions',
    await waitFor(() => heardAbout(schedWatcher, farOne.json?.id, 'created')),
  );
  check('nobody else is told', !schedOther.events.some((frame) => frame.t === 'SCHEDULED_MESSAGE_UPDATE'));
  check('another member does not see it', (await scheduledOf(ownerToken)).json?.scheduled?.length === 0);
  check(
    'another member cannot edit it (404)',
    (await req(`/users/@me/scheduled/${farOne.json.id}`, { method: 'PATCH', token: ownerToken, body: { content: 'mine now' } }))
      .status === 404,
  );
  check(
    'another member cannot send it (404)',
    (await req(`/users/@me/scheduled/${farOne.json.id}/send`, { method: 'POST', token: ownerToken })).status === 404,
  );
  await req(`/users/@me/scheduled/${farOne.json.id}`, { method: 'DELETE', token: ownerToken });
  check('another member cannot cancel it either', (await scheduledOf(bobToken)).json?.scheduled?.length === 1);
  check(
    'it does not appear in the channel before its time',
    !(await historyOf()).some((message) => message.content === 'next week'),
  );

  const edited = await req(`/users/@me/scheduled/${farOne.json.id}`, {
    method: 'PATCH',
    token: bobToken,
    body: { content: 'next week, edited', sendAt: inMs(8 * 86_400_000) },
  });
  check(
    'text and time can be edited',
    edited.status === 200 &&
      edited.json?.content === 'next week, edited' &&
      Date.parse(edited.json.sendAt) > Date.now() + 7.5 * 86_400_000,
  );
  check(
    'an edit to a time too soon is refused (400)',
    (await req(`/users/@me/scheduled/${farOne.json.id}`, { method: 'PATCH', token: bobToken, body: { sendAt: inMs(100) } }))
      .status === 400,
  );
  check(
    'an empty edit is refused (400)',
    (await req(`/users/@me/scheduled/${farOne.json.id}`, { method: 'PATCH', token: bobToken, body: {} })).status === 400,
  );
  check(
    'emptying the text is refused (400)',
    (await req(`/users/@me/scheduled/${farOne.json.id}`, { method: 'PATCH', token: bobToken, body: { content: ' ' } }))
      .status === 400,
  );
  check(
    'a message can be cancelled',
    (await req(`/users/@me/scheduled/${farOne.json.id}`, { method: 'DELETE', token: bobToken })).status === 204 &&
      (await scheduledOf(bobToken)).json?.scheduled?.length === 0,
  );
  check(
    'cancelling twice is harmless',
    (await req(`/users/@me/scheduled/${farOne.json.id}`, { method: 'DELETE', token: bobToken })).status === 204,
  );

  // The cap.
  const capIds = [];
  for (let n = 0; n < 25; n++) {
    const made = await schedule(bobToken, { content: `cap ${n}`, sendAt: inMs(86_400_000 + n * 1000) });
    if (made.status === 201) capIds.push(made.json.id);
  }
  check('up to 25 can be held at once', capIds.length === 25);
  check(
    'a 26th is refused (400)',
    (await schedule(bobToken, { content: 'one too many', sendAt: inMs(86_400_000) })).status === 400,
  );
  check(
    'the cap is per member',
    (await schedule(ownerToken, { content: 'owner is fine', sendAt: inMs(86_400_000) })).status === 201,
  );
  for (const id of capIds) await req(`/users/@me/scheduled/${id}`, { method: 'DELETE', token: bobToken });
  for (const entry of (await scheduledOf(ownerToken)).json?.scheduled ?? []) {
    await req(`/users/@me/scheduled/${entry.id}`, { method: 'DELETE', token: ownerToken });
  }

  // Delivery: the server sends it with nobody asking.
  const dueSoon = await schedule(bobToken, { content: 'sent by the clock', sendAt: inMs(2200) });
  check('a near-future message is accepted', dueSoon.status === 201);
  check(
    'it is delivered by the server when its time comes',
    await waitFor(async () => (await historyOf()).some((message) => message.content === 'sent by the clock')),
  );
  await sleep(600);
  const delivered = (await historyOf()).filter((message) => message.content === 'sent by the clock');
  check(
    'exactly once, as its author',
    delivered.length === 1 && delivered[0].author?.id === bobId,
    `${delivered.length} copies`,
  );
  check('and it leaves the scheduled list', (await scheduledOf(bobToken)).json?.scheduled?.length === 0);
  check(
    'the author hears that it was sent',
    await waitFor(() => heardAbout(schedWatcher, dueSoon.json?.id, 'sent')),
  );

  // Send now, raced against itself and the timer: still once.
  const rushed = await schedule(bobToken, { content: 'sent early', sendAt: inMs(86_400_000) });
  const raced = await Promise.all(
    Array.from({ length: 6 }, () =>
      req(`/users/@me/scheduled/${rushed.json.id}/send`, { method: 'POST', token: bobToken }),
    ),
  );
  check(
    'send now delivers it',
    raced.some((response) => response.status === 200 && response.json?.content === 'sent early'),
  );
  check(
    'racing send-now requests deliver it exactly once',
    raced.filter((response) => response.status === 200).length === 1 &&
      (await historyOf()).filter((message) => message.content === 'sent early').length === 1,
  );
  check('the losers are told it is gone (404)', raced.filter((response) => response.status === 404).length === 5);

  // A reply keeps its parent; one whose parent is gone fails with a reason.
  const parent = (
    await req(`/channels/${schedChannel.id}/messages`, { method: 'POST', token: ownerToken, body: { content: 'question' } })
  ).json;
  const replying = await schedule(bobToken, { content: 'answer', replyToId: parent.id, sendAt: inMs(2200) });
  check('a reply can be scheduled', replying.status === 201 && replying.json?.replyToId === parent.id);
  check(
    'a reply to a message in another channel is refused (400)',
    (await schedule(bobToken, { content: 'x', replyToId: parent.id, sendAt: inMs(60_000) }, savedChannel.id)).status === 400,
  );
  check(
    'it is delivered as a reply',
    await waitFor(async () =>
      (await historyOf()).some((message) => message.content === 'answer' && message.replyTo?.id === parent.id),
    ),
  );
  const orphaned = await schedule(bobToken, { content: 'to nobody', replyToId: parent.id, sendAt: inMs(3000) });
  await req(`/messages/${parent.id}`, { method: 'DELETE', token: ownerToken });
  check(
    'a reply whose parent was deleted fails, with the reason',
    await waitFor(async () => {
      const entry = await scheduledEntry(bobToken, orphaned.json?.id);
      return entry?.status === 'failed' && /repl/i.test(entry.error ?? '');
    }),
  );
  check(
    'the author is told it failed',
    schedWatcher.events.some(
      (frame) =>
        frame.t === 'SCHEDULED_MESSAGE_UPDATE' &&
        frame.d?.id === orphaned.json?.id &&
        frame.d?.reason === 'failed' &&
        frame.d?.scheduled?.status === 'failed',
    ),
  );
  await sleep(700);
  check(
    'nothing was posted, and the clock does not retry a failed one',
    !(await historyOf()).some((message) => message.content === 'to nobody'),
  );
  check(
    'editing only the text leaves it failed',
    (
      await req(`/users/@me/scheduled/${orphaned.json.id}`, {
        method: 'PATCH',
        token: bobToken,
        body: { content: 'to nobody (fixed)' },
      })
    ).json?.status === 'failed',
  );
  check(
    'a failed one can be cancelled',
    (await req(`/users/@me/scheduled/${orphaned.json.id}`, { method: 'DELETE', token: bobToken })).status === 204,
  );

  // Permissions are checked again at send time.
  const lockRole = (await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'send-later-lock' } })).json;
  const lockedRoom = (
    await req('/channels', {
      method: 'POST',
      token: ownerToken,
      body: { name: 'send-later-locked', requiredRoleId: lockRole.id },
    })
  ).json;
  await req(`/members/${bobId}/roles/${lockRole.id}`, { method: 'PUT', token: ownerToken });
  const lockedSched = await schedule(bobToken, { content: 'while I could', sendAt: inMs(2500) }, lockedRoom.id);
  check('a member with the role can schedule into a locked channel', lockedSched.status === 201);
  await req(`/members/${bobId}/roles/${lockRole.id}`, { method: 'DELETE', token: ownerToken });
  check(
    'but losing access before it is due makes it fail',
    await waitFor(async () => (await scheduledEntry(bobToken, lockedSched.json?.id))?.status === 'failed'),
  );
  check(
    'and nothing was posted to the locked channel',
    !(await historyOf(lockedRoom.id)).some((message) => message.content === 'while I could'),
  );
  check(
    'a member without access cannot schedule there (403)',
    (await schedule(bobToken, { content: 'nope', sendAt: inMs(60_000) }, lockedRoom.id)).status === 403,
  );
  await req(`/users/@me/scheduled/${lockedSched.json.id}`, { method: 'DELETE', token: bobToken });

  const timedSched = await schedule(bobToken, { content: 'while free', sendAt: inMs(2500) });
  await req(`/members/${bobId}/timeout`, { method: 'PUT', token: ownerToken, body: { durationMinutes: 5 } });
  check(
    'a member who is timed out when it is due gets a failed entry',
    await waitFor(async () => {
      const entry = await scheduledEntry(bobToken, timedSched.json?.id);
      return entry?.status === 'failed' && /timed out/i.test(entry.error ?? '');
    }),
  );
  await req(`/members/${bobId}/timeout`, { method: 'DELETE', token: ownerToken });
  check(
    'sending it by hand once the timeout is over works',
    (await req(`/users/@me/scheduled/${timedSched.json.id}/send`, { method: 'POST', token: bobToken })).status === 200 &&
      (await historyOf()).some((message) => message.content === 'while free'),
  );

  const everyone = (await req('/roles', { token: ownerToken })).json?.roles?.find((role) => role.isDefault);
  const noSendSched = await schedule(bobToken, { content: 'without permission', sendAt: inMs(2500) });
  const sendBit = 1n << 1n;
  await req(`/roles/${everyone.id}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { permissions: String(BigInt(everyone.permissions) & ~sendBit) },
  });
  check(
    'losing Send Messages before it is due makes it fail',
    await waitFor(async () => (await scheduledEntry(bobToken, noSendSched.json?.id))?.status === 'failed'),
  );
  check(
    'scheduling needs Send Messages (403)',
    (await schedule(bobToken, { content: 'x', sendAt: inMs(60_000) })).status === 403,
  );
  await req(`/roles/${everyone.id}`, { method: 'PATCH', token: ownerToken, body: { permissions: everyone.permissions } });
  check(
    'nothing was posted without the permission',
    !(await historyOf()).some((message) => message.content === 'without permission'),
  );
  // A new time is the retry.
  const retried = await req(`/users/@me/scheduled/${noSendSched.json.id}`, {
    method: 'PATCH',
    token: bobToken,
    body: { sendAt: inMs(2200) },
  });
  check('a new time puts a failed one back in the queue', retried.json?.status === 'pending' && retried.json?.error === null);
  check(
    'and it then goes out',
    await waitFor(async () => (await historyOf()).some((message) => message.content === 'without permission')),
  );

  // Slowmode is not bypassed: the message waits for the window instead.
  const slowRoom = (
    await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'send-later-slow', slowmodeSeconds: 4 } })
  ).json;
  await req(`/channels/${slowRoom.id}/messages`, { method: 'POST', token: bobToken, body: { content: 'just posted' } });
  const slowQueued = await schedule(bobToken, { content: 'after the wait', sendAt: inMs(1600) }, slowRoom.id);
  await sleep(2200);
  check(
    'slowmode holds a scheduled message back instead of failing it',
    (await scheduledEntry(bobToken, slowQueued.json?.id))?.status === 'pending' &&
      !(await historyOf(slowRoom.id)).some((message) => message.content === 'after the wait'),
  );
  check(
    'and it is sent once the window has passed',
    await waitFor(async () => (await historyOf(slowRoom.id)).some((message) => message.content === 'after the wait')),
  );

  // Attachments stay claimed for the schedule and survive retention.
  const heldUpload = await uploadFor(bobToken, 'later.png');
  const withFile = await schedule(bobToken, {
    content: 'with a picture',
    attachmentIds: [heldUpload.id],
    sendAt: inMs(6000),
  });
  check(
    'a scheduled message can carry an upload',
    withFile.status === 201 && withFile.json?.attachments?.[0]?.id === heldUpload.id,
  );
  check(
    'the same upload cannot be scheduled twice (400)',
    (await schedule(bobToken, { content: 'again', attachmentIds: [heldUpload.id], sendAt: inMs(60_000) })).status === 400,
  );
  check(
    'nor used in an ordinary message meanwhile (400)',
    (
      await req(`/channels/${schedChannel.id}/messages`, {
        method: 'POST',
        token: bobToken,
        body: { content: 'sneaky', attachmentIds: [heldUpload.id] },
      })
    ).status === 400,
  );
  const foreignUpload = await uploadFor(ownerToken, 'theirs.png');
  check(
    "someone else's upload cannot be scheduled (403)",
    (await schedule(bobToken, { content: 'x', attachmentIds: [foreignUpload.id], sendAt: inMs(60_000) })).status === 403,
  );
  await req('/retention', { method: 'PATCH', token: ownerToken, body: { imageRetentionDays: 0 } });
  await req('/retention/run', { method: 'POST', token: ownerToken });
  await req('/retention', { method: 'PATCH', token: ownerToken, body: { imageRetentionDays: null } });
  check(
    'retention spares an upload waiting for its scheduled message',
    (await fetch(`${BASE}/attachments/${heldUpload.id}`, { headers: { authorization: `Bearer ${bobToken}` } })).status === 200,
  );
  check(
    'and the message goes out with it',
    await waitFor(async () =>
      (await historyOf()).some(
        (message) => message.content === 'with a picture' && message.attachments?.[0]?.id === heldUpload.id,
      ),
    ),
  );

  // A channel going away takes its scheduled messages with it.
  const doomed = (await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'send-later-doomed' } })).json;
  const doomedSched = await schedule(bobToken, { content: 'never', sendAt: inMs(86_400_000) }, doomed.id);
  await req(`/channels/${doomed.id}`, { method: 'DELETE', token: ownerToken });
  check(
    'deleting a channel drops its scheduled messages',
    doomedSched.status === 201 &&
      !(await scheduledOf(bobToken)).json?.scheduled?.some((item) => item.id === doomedSched.json.id),
  );

  schedWatcher.ws.close();
  schedOther.ws.close();
  await req(`/roles/${lockRole.id}`, { method: 'DELETE', token: ownerToken });

  // Merging accounts moves the scheduled messages across.
  const schedMergeDir = mkdtempSync(join(tmpdir(), 'harmony-scheduled-merge-'));
  const schedMergeStore = new Database({
    dataDir: schedMergeDir,
    dbFile: join(schedMergeDir, 'harmony.db'),
    uploadDir: join(schedMergeDir, 'uploads'),
  });
  insertUser(schedMergeStore.sqlite, { id: 'keeper', username: 'keeper', passwordHash: 'x', isOwner: false });
  insertUser(schedMergeStore.sqlite, { id: 'leaver', username: 'leaver', passwordHash: 'x', isOwner: false });
  schedMergeStore.sqlite
    .prepare("INSERT INTO channels (id, name, type, position, created_at) VALUES ('sm-chan', 'general', 'text', 0, ?)")
    .run(new Date().toISOString());
  schedMergeStore.sqlite
    .prepare(
      "INSERT INTO scheduled_messages (id, user_id, channel_id, content, send_at, created_at) VALUES ('sm-1', 'leaver', 'sm-chan', 'carried', 1, 1)",
    )
    .run();
  mergeUsers(schedMergeStore.sqlite, 'leaver', 'keeper');
  check(
    'merging accounts carries scheduled messages to the survivor',
    schedMergeStore.sqlite.prepare("SELECT user_id FROM scheduled_messages WHERE id = 'sm-1'").get()?.user_id === 'keeper',
  );
  schedMergeStore.sqlite.prepare("DELETE FROM users WHERE id = 'keeper'").run();
  check(
    'a deleted account takes its scheduled messages along',
    schedMergeStore.sqlite.prepare('SELECT COUNT(*) AS n FROM scheduled_messages').get()?.n === 0,
  );
  schedMergeStore.close();
  rmSync(schedMergeDir, { recursive: true, force: true });
  }

  // --- Polls ---
  const pollRoom = (await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'polls-room' } })).json;
  const pollBody = (overrides = {}) => ({
    question: 'Pizza or tacos?',
    options: [{ text: 'Pizza', emoji: '🍕' }, { text: 'Tacos' }, { text: 'Neither' }],
    allowMultiple: false,
    durationHours: 24,
    ...overrides,
  });
  const makePoll = (overrides = {}, token = ownerToken, channelId = pollRoom.id) =>
    req(`/channels/${channelId}/polls`, { method: 'POST', token, body: pollBody(overrides) });
  const voteOn = (messageId, optionIds, token = bobToken) =>
    req(`/messages/${messageId}/poll/votes`, { method: 'PUT', token, body: { optionIds } });
  const pollOf = async (messageId, token = bobToken, channelId = pollRoom.id) =>
    (await req(`/channels/${channelId}/messages?limit=100`, { token })).json?.messages?.find((m) => m.id === messageId)?.poll;

  const pollWatcher = await openGateway({ token: bobToken });
  const created = await makePoll();
  const pollMessage = created.json;
  check(
    'a poll is created as a message whose text is the question',
    created.status === 200 &&
      pollMessage?.content === 'Pizza or tacos?' &&
      pollMessage?.poll?.options?.length === 3 &&
      pollMessage.poll.options[0].emoji === '🍕' &&
      pollMessage.poll.options[1].emoji === null &&
      pollMessage.poll.options.every((o) => o.count === 0) &&
      pollMessage.poll.totalVoters === 0 &&
      pollMessage.poll.allowMultiple === false &&
      pollMessage.poll.closedAt === null &&
      typeof pollMessage.poll.closesAt === 'string' &&
      pollMessage.poll.source === 'harmony' &&
      pollMessage.poll.myVotes.length === 0,
    JSON.stringify(created.json),
  );
  const [pizza, tacos, neither] = pollMessage.poll.options;
  await sleep(200);
  check(
    'a new poll reaches the gateway as an ordinary message',
    pollWatcher.events.some((f) => f.t === 'MESSAGE_CREATE' && f.d?.id === pollMessage.id && f.d?.poll?.options?.length === 3),
  );
  check(
    'a poll appears in channel history with the viewer\'s own votes',
    (await pollOf(pollMessage.id))?.options?.length === 3,
  );

  // Validation.
  const invalid = async (overrides) => (await makePoll(overrides)).status;
  check('a poll needs a question (400)', (await invalid({ question: '   ' })) === 400);
  check('a poll needs two options (400)', (await invalid({ options: [{ text: 'Only one' }] })) === 400);
  check(
    'a poll takes at most ten options (400)',
    (await invalid({ options: Array.from({ length: 11 }, (_, i) => ({ text: `o${i}` })) })) === 400,
  );
  check('an option cannot be blank (400)', (await invalid({ options: [{ text: 'a' }, { text: '  ' }] })) === 400);
  check('an option is limited to 55 characters (400)', (await invalid({ options: [{ text: 'a' }, { text: 'x'.repeat(56) }] })) === 400);
  check('a question is limited to 300 characters (400)', (await invalid({ question: 'q'.repeat(301) })) === 400);
  check('an option emoji must be an emoji (400)', (await invalid({ options: [{ text: 'a', emoji: 'abc' }, { text: 'b' }] })) === 400);
  check('a poll lasts at least an hour (400)', (await invalid({ durationHours: 0 })) === 400);
  check('a poll lasts at most 32 days (400)', (await invalid({ durationHours: 769 })) === 400);
  check('a duration must be a whole number of hours (400)', (await invalid({ durationHours: 1.5 })) === 400);
  check('a poll can have no expiry', (await makePoll({ durationHours: null })).json?.poll?.closesAt === null);

  // Voting.
  const first = await voteOn(pollMessage.id, [pizza.id]);
  check(
    'a member can vote and gets the poll back with their choice',
    first.status === 200 && first.json?.myVotes?.join() === pizza.id && first.json?.options?.[0]?.count === 1 && first.json?.totalVoters === 1,
    JSON.stringify(first.json),
  );
  await sleep(200);
  const update = pollWatcher.events.filter((f) => f.t === 'POLL_UPDATE' && f.d?.messageId === pollMessage.id).at(-1);
  check(
    'a vote is broadcast as counts plus who voted, not a per-viewer view',
    update?.d?.channelId === pollRoom.id &&
      update.d.actorId === bobId &&
      update.d.actorVotes?.join() === pizza.id &&
      update.d.totalVoters === 1 &&
      update.d.options.find((o) => o.id === pizza.id)?.count === 1 &&
      !('myVotes' in update.d),
    JSON.stringify(update),
  );
  check(
    'the owner sees the live counts without having voted',
    (await pollOf(pollMessage.id, ownerToken))?.options?.[0]?.count === 1 &&
      (await pollOf(pollMessage.id, ownerToken))?.myVotes?.length === 0,
  );
  const changed = await voteOn(pollMessage.id, [tacos.id]);
  check(
    'changing a vote moves it rather than adding a second',
    changed.json?.myVotes?.join() === tacos.id &&
      changed.json?.options?.map((o) => o.count).join() === '0,1,0' &&
      changed.json?.totalVoters === 1,
    JSON.stringify(changed.json),
  );
  check(
    'voting the same option again changes nothing',
    (await voteOn(pollMessage.id, [tacos.id])).json?.options?.map((o) => o.count).join() === '0,1,0',
  );
  check(
    'a single-answer poll refuses two choices (400)',
    (await voteOn(pollMessage.id, [pizza.id, tacos.id])).status === 400,
  );
  check(
    'an option from another poll is refused (400)',
    (await voteOn(pollMessage.id, [(await makePoll()).json.poll.options[0].id])).status === 400,
  );
  check('an unknown option is refused (400)', (await voteOn(pollMessage.id, ['nope'])).status === 400);
  await voteOn(pollMessage.id, [neither.id], ownerToken);
  check(
    'two voters are counted separately',
    (await pollOf(pollMessage.id, ownerToken))?.totalVoters === 2 &&
      (await pollOf(pollMessage.id, ownerToken))?.options?.map((o) => o.count).join() === '0,1,1',
  );
  const withdrawn = await voteOn(pollMessage.id, []);
  check(
    'an empty choice withdraws the vote',
    withdrawn.json?.myVotes?.length === 0 && withdrawn.json?.totalVoters === 1,
    JSON.stringify(withdrawn.json),
  );

  // Who voted.
  const votersOf = (messageId, optionId, token = bobToken) =>
    req(`/messages/${messageId}/poll/voters?optionId=${optionId}`, { token });
  const voterList = await votersOf(pollMessage.id, neither.id);
  check(
    'the voter list names who chose an option (polls are not anonymous)',
    voterList.status === 200 &&
      voterList.json?.total === 1 &&
      voterList.json?.voters?.length === 1 &&
      voterList.json.voters[0].user.id === ownerId,
    JSON.stringify(voterList.json),
  );
  check('the voter list refuses an unknown option (404)', (await votersOf(pollMessage.id, 'nope')).status === 404);
  check('the voter list needs a sign-in (401)', (await req(`/messages/${pollMessage.id}/poll/voters?optionId=${neither.id}`)).status === 401);

  // Multiple answers.
  const multi = (await makePoll({ question: 'Toppings?', allowMultiple: true })).json;
  const [m1, m2, m3] = multi.poll.options;
  const multiVote = await voteOn(multi.id, [m1.id, m3.id]);
  check(
    'a multiple-answer poll takes several choices',
    multiVote.json?.myVotes?.length === 2 && multiVote.json?.totalVoters === 1 && multiVote.json?.options?.map((o) => o.count).join() === '1,0,1',
    JSON.stringify(multiVote.json),
  );
  await voteOn(multi.id, [m2.id], ownerToken);
  const multiAfter = await pollOf(multi.id, ownerToken);
  check(
    'with several answers the voter total is below the sum of the counts',
    multiAfter?.totalVoters === 2 && multiAfter.options.reduce((sum, o) => sum + o.count, 0) === 3,
  );
  check(
    'a repeated option in one vote counts once',
    (await voteOn(multi.id, [m1.id, m1.id])).json?.options?.map((o) => o.count).join() === '1,1,0',
  );

  // Ending early.
  const endable = (await makePoll({ question: 'End me?' })).json;
  await voteOn(endable.id, [endable.poll.options[0].id]);
  check('a member cannot end another member\'s poll (403)', (await req(`/messages/${endable.id}/poll/end`, { method: 'POST', token: bobToken })).status === 403);
  const ended = await req(`/messages/${endable.id}/poll/end`, { method: 'POST', token: ownerToken });
  check(
    'the author can end a poll, and the final counts stay',
    ended.status === 200 && typeof ended.json?.closedAt === 'string' && ended.json?.options?.[0]?.count === 1,
    JSON.stringify(ended.json),
  );
  await sleep(200);
  check(
    'ending a poll is broadcast',
    pollWatcher.events.some((f) => f.t === 'POLL_UPDATE' && f.d?.messageId === endable.id && f.d?.closedAt && f.d?.actorId === null),
  );
  check('a closed poll refuses votes (409)', (await voteOn(endable.id, [endable.poll.options[1].id])).status === 409);
  check('a closed poll refuses withdrawals (409)', (await voteOn(endable.id, [])).status === 409);
  check('a poll cannot be ended twice (409)', (await req(`/messages/${endable.id}/poll/end`, { method: 'POST', token: ownerToken })).status === 409);
  check('a closed poll still lists its voters', (await votersOf(endable.id, endable.poll.options[0].id)).json?.voters?.length === 1);
  check('a closed poll reads as closed in history', typeof (await pollOf(endable.id))?.closedAt === 'string');

  // A moderator with Manage Messages may end someone else's poll.
  const modPoll = (await makePoll({ question: 'Moderated?' }, bobToken)).json;
  check('a member can start a poll', modPoll?.poll?.options?.length === 3 && modPoll.author.id === bobId);
  check('the owner (Manage Messages) can end a member\'s poll', (await req(`/messages/${modPoll.id}/poll/end`, { method: 'POST', token: ownerToken })).status === 200);

  // Expiry: the clock closes a poll by itself. Rewind one through the database.
  const pollDb = new DatabaseSync(join(dataDir, 'harmony.db'));
  const expiring = (await makePoll({ question: 'Hurry?', durationHours: 1 })).json;
  await voteOn(expiring.id, [expiring.poll.options[0].id]);
  pollDb.prepare('UPDATE polls SET closes_at = ? WHERE message_id = ?').run(new Date(Date.now() - 1000).toISOString(), expiring.id);
  pollWatcher.events.length = 0;
  let swept = false;
  for (let attempt = 0; attempt < 30 && !swept; attempt++) {
    await sleep(200);
    swept = pollWatcher.events.some((f) => f.t === 'POLL_UPDATE' && f.d?.messageId === expiring.id && f.d?.closedAt);
  }
  check('the timer closes an expired poll and broadcasts it', swept);
  check('an expired poll keeps its votes', (await pollOf(expiring.id))?.options?.[0]?.count === 1);
  const lazy = (await makePoll({ question: 'Late?', durationHours: 1 })).json;
  pollDb.prepare('UPDATE polls SET closes_at = ? WHERE message_id = ?').run(new Date(Date.now() - 1000).toISOString(), lazy.id);
  check(
    'a vote cast after the time is up is refused even before the timer ran (409)',
    (await voteOn(lazy.id, [lazy.poll.options[0].id])).status === 409,
  );

  // Editing and deleting.
  check('a poll cannot be edited (400)', (await req(`/messages/${pollMessage.id}`, { method: 'PATCH', token: ownerToken, body: { content: 'changed' } })).status === 400);
  const searched = await req(`/search?q=${encodeURIComponent('Pizza or tacos')}`, { token: bobToken });
  check(
    'a poll is found by searching its question, poll attached',
    searched.json?.messages?.some((m) => m.id === pollMessage.id && m.poll?.options?.length === 3),
  );
  const replied = await req(`/channels/${pollRoom.id}/messages`, {
    method: 'POST',
    token: bobToken,
    body: { content: 'good question', replyToId: pollMessage.id },
  });
  check('a reply quotes the question', replied.json?.replyTo?.content === 'Pizza or tacos?');

  // Permissions.
  const carol = await req('/auth/register', { method: 'POST', body: { username: 'pollwatcher', password: 'pollwatcher-pass', inviteCode: (await req('/invites', { method: 'POST', token: ownerToken, body: {} })).json?.code } });
  const carolToken = carol.json?.token;
  const carolId = carol.json?.user?.id;
  check('a fresh member can vote', carolToken && (await voteOn(multi.id, [m1.id], carolToken)).status === 200);
  check('creating a poll needs a sign-in (401)', (await req(`/channels/${pollRoom.id}/polls`, { method: 'POST', body: pollBody() })).status === 401);
  check('creating a poll in a missing channel is refused (404)', (await makePoll({}, ownerToken, 'no-such-channel')).status === 404);
  check('voting on a message that is not a poll is refused (404)', (await voteOn(replied.json.id, ['x'])).status === 404);
  check('ending a message that is not a poll is refused (404)', (await req(`/messages/${replied.json.id}/poll/end`, { method: 'POST', token: ownerToken })).status === 404);

  // A timed-out member can read a poll but not vote on it.
  const timeoutPoll = (await makePoll({ question: 'Timeout?' })).json;
  await req(`/members/${carolId}/timeout`, { method: 'PUT', token: ownerToken, body: { durationMinutes: 5 } });
  check('a timed-out member cannot vote (403)', (await voteOn(timeoutPoll.id, [timeoutPoll.poll.options[0].id], carolToken)).status === 403);
  check('a timed-out member can still read the poll', (await pollOf(timeoutPoll.id, carolToken))?.options?.length === 3);
  await req(`/members/${carolId}/timeout`, { method: 'DELETE', token: ownerToken });
  check('and votes again once the timeout lifts', (await voteOn(timeoutPoll.id, [timeoutPoll.poll.options[0].id], carolToken)).status === 200);

  // Rate limit: a script flipping its vote is stopped.
  const spam = [];
  for (let i = 0; i < 36; i++) spam.push((await voteOn(timeoutPoll.id, [timeoutPoll.poll.options[i % 2].id], carolToken)).status);
  check('vote flooding is rate limited (429)', spam.includes(429), spam.join());

  // Hidden channels: a locked channel's polls are invisible, unvotable and silent.
  const pollRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Poll insiders' } });
  const hiddenRoom = (
    await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'hidden-polls', requiredRoleId: pollRole.json.id } })
  ).json;
  const hiddenPoll = (await makePoll({ question: 'Secret ballot?' }, ownerToken, hiddenRoom.id)).json;
  await voteOn(hiddenPoll.id, [hiddenPoll.poll.options[0].id], ownerToken);
  await sleep(250);
  check(
    'a poll in a locked channel is not broadcast to a member without the role',
    !pollWatcher.events.some((f) => f.d?.channelId === hiddenRoom.id || f.d?.id === hiddenPoll.id),
  );
  check('voting in a locked channel is refused (403)', (await voteOn(hiddenPoll.id, [hiddenPoll.poll.options[0].id])).status === 403);
  check('a locked channel\'s voters are refused (403)', (await votersOf(hiddenPoll.id, hiddenPoll.poll.options[0].id)).status === 403);
  check('ending in a locked channel is refused (403)', (await req(`/messages/${hiddenPoll.id}/poll/end`, { method: 'POST', token: bobToken })).status === 403);
  check('a locked channel refuses its poll history (403)', (await req(`/channels/${hiddenRoom.id}/messages`, { token: bobToken })).status === 403);
  check('creating a poll in a locked channel is refused (403)', (await makePoll({}, bobToken, hiddenRoom.id)).status === 403);
  const hiddenSearch = await req(`/search?q=${encodeURIComponent('Secret ballot')}`, { token: bobToken });
  check('a locked channel\'s poll is not searchable', (hiddenSearch.json?.messages ?? []).length === 0);
  await req(`/members/${bobId}/roles/${pollRole.json.id}`, { method: 'PUT', token: ownerToken });
  check('with the role the same poll is votable', (await voteOn(hiddenPoll.id, [hiddenPoll.poll.options[1].id])).status === 200);
  await req(`/members/${bobId}/roles/${pollRole.json.id}`, { method: 'DELETE', token: ownerToken });

  // Deleting the message removes the poll, and its voters.
  check('a poll message can be deleted', (await req(`/messages/${pollMessage.id}`, { method: 'DELETE', token: ownerToken })).status === 204);
  check('a deleted poll cannot be voted on (404)', (await voteOn(pollMessage.id, [pizza.id])).status === 404);
  check('a deleted poll lists no voters (404)', (await votersOf(pollMessage.id, pizza.id)).status === 404);
  check('a deleted poll drops out of history', (await pollOf(pollMessage.id)) === undefined);
  // Hard deletion (retention, or the channel going) cascades to every child row.
  const childRows = (table) => pollDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const pollRowsBefore = childRows('polls');
  const votesBefore = childRows('poll_votes');
  await req(`/channels/${pollRoom.id}`, { method: 'DELETE', token: ownerToken });
  check(
    'deleting the channel cascades to its polls, options and votes',
    childRows('polls') < pollRowsBefore &&
      childRows('poll_votes') < votesBefore &&
      pollDb.prepare("SELECT COUNT(*) AS n FROM poll_options WHERE poll_id NOT IN (SELECT id FROM polls)").get().n === 0 &&
      pollDb.prepare("SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id NOT IN (SELECT id FROM polls)").get().n === 0,
  );
  pollDb.close();
  pollWatcher.ws.close();

  // Merging accounts (the Discord link) keeps one vote per person per poll.
  const pollMergeDir = mkdtempSync(join(tmpdir(), 'harmony-poll-merge-'));
  const pollMergeStore = new Database({
    dataDir: pollMergeDir,
    dbFile: join(pollMergeDir, 'harmony.db'),
    uploadDir: join(pollMergeDir, 'uploads'),
  });
  const ms = pollMergeStore.sqlite;
  insertUser(ms, { id: 'p-keeper', username: 'pkeeper', passwordHash: 'x', isOwner: false });
  insertUser(ms, { id: 'p-leaver', username: 'pleaver', passwordHash: 'x', isOwner: false });
  ms.prepare("INSERT INTO channels (id, name, type, position, created_at) VALUES ('p-chan', 'general', 'text', 0, ?)").run(new Date().toISOString());
  for (const id of ['p-single', 'p-multi']) {
    insertMessage(ms, { id, channelId: 'p-chan', authorId: 'p-keeper', content: id, createdAt: new Date().toISOString() });
    ms.prepare("INSERT INTO polls (id, message_id, question, allow_multiple, created_at) VALUES (?, ?, 'q', ?, ?)").run(`${id}-poll`, id, id === 'p-multi' ? 1 : 0, new Date().toISOString());
    for (const o of ['a', 'b', 'c']) ms.prepare('INSERT INTO poll_options (id, poll_id, position, text) VALUES (?, ?, ?, ?)').run(`${id}-${o}`, `${id}-poll`, o.charCodeAt(0), o);
  }
  const castVote = (user, poll, option) =>
    ms.prepare('INSERT INTO poll_votes (poll_id, option_id, user_id, voted_at) VALUES (?, ?, ?, ?)').run(`${poll}-poll`, `${poll}-${option}`, user, new Date().toISOString());
  castVote('p-keeper', 'p-single', 'a'); // survivor chose a
  castVote('p-leaver', 'p-single', 'b'); // outgoing chose b: the survivor's choice stands
  castVote('p-keeper', 'p-multi', 'a');
  castVote('p-leaver', 'p-multi', 'a'); // the same option twice collapses
  castVote('p-leaver', 'p-multi', 'c'); // a different one moves across
  let pollMergeError = null;
  try {
    mergeUsers(ms, 'p-leaver', 'p-keeper');
  } catch (error) {
    pollMergeError = error;
  }
  const mergedVotes = ms.prepare('SELECT poll_id, option_id, user_id FROM poll_votes ORDER BY option_id').all();
  check(
    'merging accounts keeps one vote per person: the survivor wins a single-answer poll, a multi poll unions',
    pollMergeError === null &&
      mergedVotes.every((row) => row.user_id === 'p-keeper') &&
      mergedVotes.map((row) => row.option_id).join() === 'p-multi-a,p-multi-c,p-single-a',
    String(pollMergeError ?? JSON.stringify(mergedVotes)),
  );
  pollMergeStore.close();

  // --- Server events ---
  // The member registered for the poll checks above stands in for a second ordinary member.
  const evCarolToken = carolToken;
  const evCarolId = carolId;
  const evRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Event runners' } });
  const manageEvents = String(1n << 17n);
  await req(`/roles/${evRole.json.id}`, { method: 'PATCH', token: ownerToken, body: { permissions: manageEvents } });
  const evVisibleRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Event insiders' } });
  const evSecret = (
    await req('/channels', {
      method: 'POST',
      token: ownerToken,
      body: { name: 'event-secret', requiredRoleId: evVisibleRole.json.id },
    })
  ).json;
  const evOpen = (await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'event-open' } })).json;
  const inMs = (ms) => Date.now() + ms;
  const evBody = (overrides = {}) => ({
    title: 'Game night',
    description: 'Bring snacks',
    locationKind: 'external',
    locationText: 'The park',
    startsAt: inMs(3_600_000),
    endsAt: null,
    ...overrides,
  });
  const makeEvent = (overrides = {}, token = ownerToken) =>
    req('/events', { method: 'POST', token, body: evBody(overrides) });
  const evStatus = async (overrides, token = ownerToken) => (await makeEvent(overrides, token)).status;
  const evDb = new DatabaseSync(join(dataDir, 'harmony.db'));

  check(
    'the ManageEvents bit is bit 17',
    Permission.ManageEvents === 1n << 17n && manageEvents === '131072',
  );
  check(
    'the migration hands ManageEvents to roles that hold ManageServer and leaves others alone',
    (() => {
      const probe = new DatabaseSync(':memory:');
      probe.exec('CREATE TABLE roles (permissions TEXT NOT NULL)');
      probe.prepare('INSERT INTO roles VALUES (?), (?), (?)').run('512', '1', '131584');
      probe.exec(
        `UPDATE roles SET permissions = CAST((CAST(permissions AS INTEGER) | 131072) AS TEXT)
          WHERE (CAST(permissions AS INTEGER) & 512) != 0 AND (CAST(permissions AS INTEGER) & 131072) = 0`,
      );
      const rows = probe.prepare('SELECT permissions FROM roles').all().map((r) => r.permissions);
      return rows.join() === '131584,1,131584';
    })(),
  );

  // Who may create.
  check('an ordinary member cannot create an event (403)', (await evStatus({}, bobToken)) === 403);
  await req(`/members/${evCarolId}/roles/${evRole.json.id}`, { method: 'PUT', token: ownerToken });
  check('a member with Manage Events can create one', (await evStatus({ title: 'Carol event' }, evCarolToken)) === 200);

  // Validation.
  check('an event needs a title (400)', (await evStatus({ title: '   ' })) === 400);
  check('a title over 100 characters is refused (400)', (await evStatus({ title: 'x'.repeat(101) })) === 400);
  check('a description over 1000 characters is refused (400)', (await evStatus({ description: 'x'.repeat(1001) })) === 400);
  check('a location over 100 characters is refused (400)', (await evStatus({ locationText: 'x'.repeat(101) })) === 400);
  check('an external event needs a place (400)', (await evStatus({ locationText: '' })) === 400);
  check('a channel event needs a channel (400)', (await evStatus({ locationKind: 'channel', channelId: null })) === 400);
  check('an unknown channel is refused (404)', (await evStatus({ locationKind: 'channel', channelId: 'nope' })) === 404);
  check('an event cannot start in the past (400)', (await evStatus({ startsAt: inMs(-60_000) })) === 400);
  check('an event cannot start more than a year ahead (400)', (await evStatus({ startsAt: inMs(366 * 86_400_000) })) === 400);
  check('an event must end after it starts (400)', (await evStatus({ endsAt: inMs(3_000_000) })) === 400);
  check(
    'an event cannot run for more than 30 days (400)',
    (await evStatus({ endsAt: inMs(3_600_000 + 31 * 86_400_000) })) === 400,
  );
  check('a non-numeric start is refused (400)', (await evStatus({ startsAt: 'soon' })) === 400);

  // The timed event: watchers first, so no broadcast is missed.
  const evBob = await openGateway({ token: bobToken });
  const evCarolGw = await openGateway({ token: evCarolToken });
  const evOwnerGw = await openGateway({ token: ownerToken });
  const remindersOf = (gw, id) => gw.events.filter((f) => f.t === 'EVENT_REMINDER' && f.d?.event?.id === id);
  const updatesOf = (gw, id, reason) =>
    gw.events.filter((f) => f.t === 'EVENT_UPDATE' && f.d?.event?.id === id && (!reason || f.d.reason === reason));

  const timedStart = inMs(9_000);
  const timed = await makeEvent({ title: 'Timed one', startsAt: timedStart, announceChannelId: evOpen.id });
  const timedEvent = timed.json;
  check(
    'creating an event returns it with its fields, scheduled, nobody interested',
    timed.status === 200 &&
      timedEvent.title === 'Timed one' &&
      timedEvent.status === 'scheduled' &&
      timedEvent.startsAt === timedStart &&
      timedEvent.endsAt === null &&
      timedEvent.locationKind === 'external' &&
      timedEvent.locationText === 'The park' &&
      timedEvent.channelId === null &&
      timedEvent.creator?.username === 'alice' &&
      timedEvent.interestedCount === 0 &&
      timedEvent.interested === false,
    JSON.stringify(timed.json),
  );
  await sleep(200);
  check(
    'a new external event reaches every connected member',
    updatesOf(evBob, timedEvent.id, 'created').length === 1 && updatesOf(evCarolGw, timedEvent.id, 'created').length === 1,
  );
  const evAnnouncement = (await req(`/channels/${evOpen.id}/messages?limit=10`, { token: bobToken })).json?.messages?.find(
    (m) => m.id === timedEvent.announcedMessageId,
  );
  const unixStart = Math.floor(timedStart / 1000);
  check(
    'the announcement is an ordinary message by the creator with a timestamp pair',
    Boolean(evAnnouncement) &&
      evAnnouncement.author?.username === 'alice' &&
      evAnnouncement.content.includes('Timed one') &&
      evAnnouncement.content.includes(`<t:${unixStart}:F>`) &&
      evAnnouncement.content.includes(`<t:${unixStart}:R>`),
    JSON.stringify(evAnnouncement),
  );
  check(
    'announcing in a channel the creator cannot see is refused (403)',
    (await evStatus({ announceChannelId: evSecret.id }, evCarolToken)) === 403,
  );
  check(
    'announcing in an unknown channel is refused (404)',
    (await evStatus({ announceChannelId: 'nope' })) === 404,
  );

  // RSVP: idempotent, counted, live.
  const rsvp = (id, token, method = 'PUT') => req(`/events/${id}/interested`, { method, token });
  const firstRsvp = await rsvp(timedEvent.id, bobToken);
  const againRsvp = await rsvp(timedEvent.id, bobToken);
  check(
    'marking interest counts once however often it is repeated',
    firstRsvp.status === 200 &&
      firstRsvp.json.interested === true &&
      firstRsvp.json.interestedCount === 1 &&
      againRsvp.json.interestedCount === 1,
  );
  await sleep(200);
  const rsvpUpdates = updatesOf(evCarolGw, timedEvent.id, 'rsvp');
  check(
    'an RSVP is broadcast once, naming whose interest changed and without baking in a viewer',
    rsvpUpdates.length === 1 &&
      rsvpUpdates[0].d.rsvpUserId === bobId &&
      rsvpUpdates[0].d.rsvpInterested === true &&
      rsvpUpdates[0].d.event.interested === false &&
      rsvpUpdates[0].d.event.interestedCount === 1,
  );
  const evCarolView = (await req(`/events/${timedEvent.id}`, { token: evCarolToken })).json;
  const evBobView = (await req(`/events/${timedEvent.id}`, { token: bobToken })).json;
  check(
    'the viewer\'s own interest is reported per viewer',
    evCarolView.interested === false && evBobView.interested === true && evCarolView.interestedCount === 1,
  );
  const whoList = await req(`/events/${timedEvent.id}/interested`, { token: evCarolToken });
  check(
    'the interested list names who is interested',
    whoList.status === 200 && whoList.json.total === 1 && whoList.json.users.map((u) => u.id).join() === bobId,
  );
  check('a missing event is 404', (await req('/events/none', { token: bobToken })).status === 404);
  check('events need a session (401)', (await req('/events')).status === 401);

  // Cap on open events: fill up through the database, then try one more.
  const openNow = evDb.prepare("SELECT COUNT(*) AS n FROM events WHERE status IN ('scheduled','active')").get().n;
  for (let i = openNow; i < 50; i++) {
    evDb
      .prepare(
        `INSERT INTO events (id, title, location_kind, location_text, starts_at, status, created_at, updated_at)
         VALUES (?, 'filler', 'external', 'x', ?, 'scheduled', ?, ?)`,
      )
      .run(`filler-${i}`, inMs(86_400_000), new Date().toISOString(), new Date().toISOString());
  }
  check('at most 50 events can be open at once (409)', (await evStatus({})) === 409);
  evDb.prepare("DELETE FROM events WHERE id LIKE 'filler-%'").run();

  // Visibility by channel.
  const secretEvent = (
    await makeEvent({ title: 'Secret meet', locationKind: 'channel', channelId: evSecret.id, startsAt: inMs(7_200_000) })
  ).json;
  const openEvent = (
    await makeEvent({ title: 'Open meet', locationKind: 'channel', channelId: evOpen.id, startsAt: inMs(7_200_000) })
  ).json;
  check('a channel event records its channel', secretEvent.locationKind === 'channel' && secretEvent.channelId === evSecret.id);
  check(
    'a member cannot place an event in a channel they cannot see (403)',
    (await evStatus({ locationKind: 'channel', channelId: evSecret.id }, evCarolToken)) === 403,
  );
  await sleep(200);
  check(
    'a locked channel\'s event never reaches members who cannot see the channel',
    updatesOf(evBob, secretEvent.id).length === 0 &&
      updatesOf(evCarolGw, secretEvent.id).length === 0 &&
      updatesOf(evOwnerGw, secretEvent.id, 'created').length === 1 &&
      updatesOf(evBob, openEvent.id, 'created').length === 1,
  );
  const listFor = async (token) => (await req('/events', { token })).json?.events ?? [];
  const evBobList = await listFor(bobToken);
  check(
    'the list leaves out events in channels the member cannot see',
    !evBobList.some((e) => e.id === secretEvent.id) &&
      evBobList.some((e) => e.id === openEvent.id) &&
      evBobList.some((e) => e.id === timedEvent.id),
  );
  check(
    'an invisible event is not found for detail, RSVP or the interested list (404)',
    (await req(`/events/${secretEvent.id}`, { token: bobToken })).status === 404 &&
      (await rsvp(secretEvent.id, bobToken)).status === 404 &&
      (await rsvp(secretEvent.id, bobToken, 'DELETE')).status === 404 &&
      (await req(`/events/${secretEvent.id}/interested`, { token: bobToken })).status === 404,
  );
  check(
    'an invisible event cannot be edited or canceled by guessing its id',
    (await req(`/events/${secretEvent.id}`, { method: 'PATCH', token: evCarolToken, body: { title: 'x' } })).status === 404 &&
      (await req(`/events/${secretEvent.id}/cancel`, { method: 'POST', token: evCarolToken })).status === 404,
  );
  await req(`/members/${bobId}/roles/${evVisibleRole.json.id}`, { method: 'PUT', token: ownerToken });
  const bobNowSees = await rsvp(secretEvent.id, bobToken);
  check(
    'a member given the role sees and can RSVP to the event',
    bobNowSees.status === 200 &&
      bobNowSees.json.interestedCount === 1 &&
      (await listFor(bobToken)).some((e) => e.id === secretEvent.id),
  );
  const secretInterest = (await req(`/events/${secretEvent.id}/interested`, { token: bobToken })).json;
  check('the interested list of a channel event names those who can see it', secretInterest.users.map((u) => u.id).join() === bobId);
  await req(`/members/${bobId}/roles/${evVisibleRole.json.id}`, { method: 'DELETE', token: ownerToken });
  const secretInterestAfter = (await req(`/events/${secretEvent.id}/interested`, { token: ownerToken })).json;
  check(
    'a member who lost access is no longer named, though their interest is kept',
    secretInterestAfter.total === 1 && secretInterestAfter.users.length === 0,
  );

  // Editing.
  check(
    'an ordinary member cannot edit someone else\'s event (403)',
    (await req(`/events/${openEvent.id}`, { method: 'PATCH', token: bobToken, body: { title: 'Hijack' } })).status === 403,
  );
  check(
    'an ordinary member cannot cancel someone else\'s event (403)',
    (await req(`/events/${openEvent.id}/cancel`, { method: 'POST', token: bobToken })).status === 403,
  );
  check('an empty edit is refused (400)', (await req(`/events/${openEvent.id}`, { method: 'PATCH', token: ownerToken, body: {} })).status === 400);
  const evEdited = await req(`/events/${openEvent.id}`, {
    method: 'PATCH',
    token: evCarolToken,
    body: { title: 'Open meet (moved)', description: 'New text', startsAt: inMs(7_300_000) },
  });
  check(
    'a member with Manage Events can edit any event',
    evEdited.status === 200 && evEdited.json.title === 'Open meet (moved)' && evEdited.json.description === 'New text',
  );
  const carolOwn = (await makeEvent({ title: 'Carol own' }, evCarolToken)).json;
  check(
    'the creator can edit their own event',
    (await req(`/events/${carolOwn.id}`, { method: 'PATCH', token: evCarolToken, body: { title: 'Carol own 2' } })).json?.title === 'Carol own 2',
  );
  // The creator keeps the right after the role is taken away.
  await req(`/members/${evCarolId}/roles/${evRole.json.id}`, { method: 'DELETE', token: ownerToken });
  check(
    'a creator without Manage Events can still edit and cancel their own event',
    (await req(`/events/${carolOwn.id}`, { method: 'PATCH', token: evCarolToken, body: { description: 'still mine' } })).status === 200 &&
      (await req(`/events/${carolOwn.id}/cancel`, { method: 'POST', token: evCarolToken })).json?.status === 'canceled',
  );
  check('but cannot create another (403)', (await evStatus({}, evCarolToken)) === 403);
  check(
    'moving an event to a past start is refused (400)',
    (await req(`/events/${openEvent.id}`, { method: 'PATCH', token: ownerToken, body: { startsAt: inMs(-5000) } })).status === 400,
  );
  check(
    'moving the end before the start is refused (400)',
    (await req(`/events/${openEvent.id}`, { method: 'PATCH', token: ownerToken, body: { endsAt: inMs(1000) } })).status === 400,
  );
  const toExternal = await req(`/events/${openEvent.id}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { locationKind: 'external', locationText: 'Online' },
  });
  check(
    'an event can change from a channel to a place',
    toExternal.status === 200 && toExternal.json.channelId === null && toExternal.json.locationText === 'Online',
  );
  check(
    'switching to a place without saying where is refused (400)',
    (await req(`/events/${secretEvent.id}`, { method: 'PATCH', token: ownerToken, body: { locationKind: 'external' } })).status === 400,
  );

  // Reminder, start and end by the clock.
  check(
    'nobody has been reminded before the lead window opens',
    Date.now() > timedStart - 4000 || remindersOf(evBob, timedEvent.id).length === 0,
  );
  await sleep(Math.max(0, timedStart - 4000 - Date.now()) + 900);
  check(
    'the reminder goes to the interested member only',
    remindersOf(evBob, timedEvent.id).length === 1 &&
      remindersOf(evCarolGw, timedEvent.id).length === 0 &&
      remindersOf(evOwnerGw, timedEvent.id).length === 0,
    `${remindersOf(evBob, timedEvent.id).length} / ${remindersOf(evCarolGw, timedEvent.id).length} / ${remindersOf(evOwnerGw, timedEvent.id).length}`,
  );
  check(
    'the reminder carries the event and is evStamped in the database',
    remindersOf(evBob, timedEvent.id)[0]?.d?.event?.title === 'Timed one' &&
      evDb.prepare('SELECT reminded_at FROM events WHERE id = ?').get(timedEvent.id).reminded_at !== null,
  );
  await sleep(900);
  check('the reminder is not sent again on later sweeps', remindersOf(evBob, timedEvent.id).length === 1);
  check(
    'the event is still scheduled before its start',
    (await req(`/events/${timedEvent.id}`, { token: bobToken })).json?.status === 'scheduled' && Date.now() < timedStart,
  );
  await sleep(Math.max(0, timedStart - Date.now()) + 900);
  const startedView = (await req(`/events/${timedEvent.id}`, { token: bobToken })).json;
  check(
    'the event becomes active at its start and everyone is told',
    startedView.status === 'active' && updatesOf(evCarolGw, timedEvent.id, 'started').length === 1,
    startedView.status,
  );
  check(
    'a started event keeps its text editable but its start fixed',
    (await req(`/events/${timedEvent.id}`, { method: 'PATCH', token: ownerToken, body: { description: 'Now on' } })).json?.description === 'Now on' &&
      (await req(`/events/${timedEvent.id}`, { method: 'PATCH', token: ownerToken, body: { startsAt: inMs(60_000) } })).status === 409,
  );
  check('an RSVP is still welcome while it runs', (await rsvp(timedEvent.id, evCarolToken)).json?.interestedCount === 2);
  // No end time: ended after the default length (2s in this run).
  await sleep(2_600);
  const endedView = (await req(`/events/${timedEvent.id}`, { token: bobToken })).json;
  check(
    'with no end time the event ends after the default duration',
    endedView.status === 'ended' && updatesOf(evBob, timedEvent.id, 'ended').length === 1,
    endedView.status,
  );
  check(
    'a finished event can no longer be changed, joined or canceled (409)',
    (await req(`/events/${timedEvent.id}`, { method: 'PATCH', token: ownerToken, body: { title: 'late' } })).status === 409 &&
      (await rsvp(timedEvent.id, ownerToken)).status === 409 &&
      (await req(`/events/${timedEvent.id}/cancel`, { method: 'POST', token: ownerToken })).status === 409,
  );
  check(
    'but interest can still be withdrawn from it',
    (await rsvp(timedEvent.id, bobToken, 'DELETE')).json?.interestedCount === 1,
  );
  check(
    'a finished event is listed in the past section',
    (await listFor(bobToken)).some((e) => e.id === timedEvent.id && e.status === 'ended'),
  );

  // An explicit end time ends it on time.
  const evEnding = (await makeEvent({ title: 'Short one', startsAt: inMs(1_200), endsAt: inMs(3_200) })).json;
  await sleep(1_800);
  check(
    'an event with an end time is active between start and end',
    (await req(`/events/${evEnding.id}`, { token: bobToken })).json?.status === 'active',
  );
  await sleep(1_800);
  check('and ended after its end time', (await req(`/events/${evEnding.id}`, { token: bobToken })).json?.status === 'ended');

  // A start moved later re-arms the reminder.
  const evStamped = (await makeEvent({ title: 'Stamped', startsAt: inMs(5_500) })).json;
  await rsvp(evStamped.id, bobToken);
  await sleep(1_800);
  check('a reminder fires once the start is inside the lead', remindersOf(evBob, evStamped.id).length === 1);
  await req(`/events/${evStamped.id}`, { method: 'PATCH', token: ownerToken, body: { startsAt: inMs(60_000) } });
  check(
    'moving the start re-arms the reminder',
    evDb.prepare('SELECT reminded_at FROM events WHERE id = ?').get(evStamped.id).reminded_at === null,
  );

  // Cancel.
  const evCanceled = await req(`/events/${evStamped.id}/cancel`, { method: 'POST', token: ownerToken });
  check('canceling marks the event canceled', evCanceled.status === 200 && evCanceled.json.status === 'canceled');
  await sleep(200);
  check(
    'a cancellation is broadcast and repeating it is harmless',
    updatesOf(evBob, evStamped.id, 'canceled').length === 1 &&
      (await req(`/events/${evStamped.id}/cancel`, { method: 'POST', token: ownerToken })).status === 200 &&
      (await sleep(150), updatesOf(evBob, evStamped.id, 'canceled').length === 1),
  );
  check('interest in a canceled event is refused (409)', (await rsvp(evStamped.id, evCarolToken)).status === 409);
  check(
    'a canceled event is listed with the past ones',
    (await listFor(bobToken)).some((e) => e.id === evStamped.id && e.status === 'canceled'),
  );

  // Audit.
  const evAudit = (await req('/audit?limit=100', { token: ownerToken })).json?.entries ?? [];
  const evKinds = new Set(evAudit.filter((e) => e.detail?.eventTitle).map((e) => e.kind));
  check(
    'creating, editing and canceling events are audit-logged',
    evKinds.has('event_create') && evKinds.has('event_edit') && evKinds.has('event_cancel'),
    [...evKinds].join(),
  );
  check(
    'an audit entry names the actor and the event',
    evAudit.some((e) => e.kind === 'event_create' && e.detail.eventTitle === 'Timed one' && e.actor?.username === 'alice'),
  );

  // A channel's events go with the channel.
  const goneChannel = (await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'event-gone' } })).json;
  const goneEvent = (await makeEvent({ title: 'Goes away', locationKind: 'channel', channelId: goneChannel.id })).json;
  await rsvp(goneEvent.id, bobToken);
  await req(`/channels/${goneChannel.id}`, { method: 'DELETE', token: ownerToken });
  check(
    'deleting a channel deletes its events and their interest',
    (await req(`/events/${goneEvent.id}`, { token: ownerToken })).status === 404 &&
      evDb.prepare('SELECT COUNT(*) AS n FROM event_rsvps WHERE event_id = ?').get(goneEvent.id).n === 0,
  );

  evDb.close();
  evBob.ws.close();
  evCarolGw.ws.close();
  evOwnerGw.ws.close();

  // Merging accounts: one interest per person, events re-owned.
  const evMergeDir = mkdtempSync(join(tmpdir(), 'harmony-event-merge-'));
  const evMergeStore = new Database({
    dataDir: evMergeDir,
    dbFile: join(evMergeDir, 'harmony.db'),
    uploadDir: join(evMergeDir, 'uploads'),
  });
  const evm = evMergeStore.sqlite;
  insertUser(evm, { id: 'e-keeper', username: 'ekeeper', passwordHash: 'x', isOwner: false });
  insertUser(evm, { id: 'e-leaver', username: 'eleaver', passwordHash: 'x', isOwner: false });
  const evStamp = new Date().toISOString();
  for (const id of ['e-both', 'e-only-leaver', 'e-only-keeper']) {
    evm.prepare(
      `INSERT INTO events (id, title, location_kind, location_text, starts_at, creator_id, created_at, updated_at)
       VALUES (?, ?, 'external', 'x', ?, ?, ?, ?)`,
    ).run(id, id, Date.now() + 100_000, id === 'e-only-keeper' ? 'e-keeper' : 'e-leaver', evStamp, evStamp);
  }
  const rsvpRow = (event, user) =>
    evm.prepare('INSERT INTO event_rsvps (event_id, user_id, created_at) VALUES (?, ?, ?)').run(event, user, evStamp);
  rsvpRow('e-both', 'e-keeper');
  rsvpRow('e-both', 'e-leaver');
  rsvpRow('e-only-leaver', 'e-leaver');
  let evMergeError = null;
  try {
    mergeUsers(evm, 'e-leaver', 'e-keeper');
  } catch (error) {
    evMergeError = error;
  }
  const mergedRsvps = evm.prepare('SELECT event_id, user_id FROM event_rsvps ORDER BY event_id').all();
  check(
    'merging accounts keeps one interest per person and moves the rest across',
    evMergeError === null &&
      mergedRsvps.map((r) => `${r.event_id}:${r.user_id}`).join() === 'e-both:e-keeper,e-only-leaver:e-keeper',
    String(evMergeError ?? JSON.stringify(mergedRsvps)),
  );
  check(
    'merging accounts re-owns the events the outgoing account created',
    evm.prepare("SELECT COUNT(*) AS n FROM events WHERE creator_id = 'e-keeper'").get().n === 3,
  );
  evMergeStore.close();

  // --- Admin media gallery ---
  const galleryPng = await sharp({
    create: { width: 20, height: 14, channels: 3, background: { r: 12, g: 34, b: 56 } },
  })
    .png()
    .toBuffer();
  const galleryForm = new FormData();
  galleryForm.append('file', new Blob([galleryPng], { type: 'image/png' }), 'gallery.png');
  const galleryUpload = await fetch(`${BASE}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerToken}` },
    body: galleryForm,
  });
  const galleryAttachment = await galleryUpload.json();

  const gallery = await req('/media', { token: ownerToken });
  const galleryItem = gallery.json?.media?.find((item) => item.attachment.id === galleryAttachment.id);
  check(
    'the media gallery lists stored images',
    gallery.status === 200 && galleryItem !== undefined,
  );
  check('a media item resolves its uploader', galleryItem?.uploader?.username === 'alice');
  check('a member cannot read the media gallery (403)', (await req('/media', { token: bobToken })).status === 403);
  check(
    'a member cannot delete media (403)',
    (await req(`/attachments/${galleryAttachment.id}`, { method: 'DELETE', token: bobToken })).status === 403,
  );
  check(
    'an administrator can delete media',
    (await req(`/attachments/${galleryAttachment.id}`, { method: 'DELETE', token: ownerToken })).status === 204,
  );
  check(
    'deleted media leaves the gallery',
    (await req('/media', { token: ownerToken })).json?.media?.some(
      (item) => item.attachment.id === galleryAttachment.id,
    ) === false,
  );
  check(
    'deleting a missing attachment 404s',
    (await req(`/attachments/${galleryAttachment.id}`, { method: 'DELETE', token: ownerToken })).status === 404,
  );

  // Deleting from the gallery is a loggable admin action, unlike the soft delete
  // of a message which only hides it.
  const afterGallery = (await req('/audit?limit=100', { token: ownerToken })).json;
  const mediaEntry = (afterGallery?.entries ?? []).find((entry) => entry.kind === 'media_delete');
  check(
    'deleting media from the gallery is logged with the file name',
    mediaEntry?.detail.filename === 'gallery.png',
    JSON.stringify(mediaEntry?.detail),
  );

  // Identical bytes sent twice is one gallery entry with a reuse count, and the
  // hash delete removes every copy so the bytes actually free.
  const repeatedPng = await sharp({
    create: { width: 9, height: 9, channels: 3, background: { r: 200, g: 30, b: 90 } },
  })
    .png()
    .toBuffer();
  async function uploadBytes(bytes, name) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/png' }), name);
    return (
      await fetch(`${BASE}/attachments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerToken}` },
        body: form,
      })
    ).json();
  }
  const repeatedA = await uploadBytes(repeatedPng, 'repeat.png');
  const repeatedB = await uploadBytes(repeatedPng, 'repeat-again.png');
  for (const [content, attachmentId] of [
    ['shared twice', repeatedA.id],
    ['and again', repeatedB.id],
  ]) {
    await req(`/channels/${colorChannel.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content, attachmentIds: [attachmentId] },
    });
  }
  check('identical uploads share one content hash', repeatedA.hash === repeatedB.hash);
  const groupedItems = ((await req('/media', { token: ownerToken })).json?.media ?? []).filter(
    (item) => item.attachment.hash === repeatedA.hash,
  );
  check(
    'the media gallery groups identical media into one entry',
    groupedItems.length === 1 && groupedItems[0].copies === 2,
    JSON.stringify(groupedItems.map((item) => item.copies)),
  );
  check(
    'a member cannot delete grouped media (403)',
    (await req(`/media/${repeatedA.hash}`, { method: 'DELETE', token: bobToken })).status === 403,
  );
  check(
    'deleting grouped media removes every copy',
    (await req(`/media/${repeatedA.hash}`, { method: 'DELETE', token: ownerToken })).status === 204,
  );
  check(
    'the deleted group leaves the gallery',
    ((await req('/media', { token: ownerToken })).json?.media ?? []).some(
      (item) => item.attachment.hash === repeatedA.hash,
    ) === false,
  );
  check(
    'deleting a missing group 404s',
    (await req(`/media/${repeatedA.hash}`, { method: 'DELETE', token: ownerToken })).status === 404,
  );

  // --- Backups and channel exports ---
  const backupPng = await sharp({
    create: { width: 9, height: 7, channels: 3, background: { r: 200, g: 10, b: 90 } },
  })
    .png()
    .toBuffer();
  const backupForm = new FormData();
  backupForm.append('file', new Blob([backupPng], { type: 'image/png' }), 'backup.png');
  const backupUpload = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: backupForm,
    })
  ).json();

  const exportChannel = (
    await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'export-test', topic: 'For the export' } })
  ).json;
  const exportFirst = (
    await req(`/channels/${exportChannel.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'backup marker message', attachmentIds: [backupUpload.id] },
    })
  ).json;
  await req(`/messages/${exportFirst.id}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { content: 'backup marker message, edited' },
  });
  await req(`/messages/${exportFirst.id}/reactions`, { method: 'POST', token: ownerToken, body: { emoji: '👍' } });
  const exportReply = (
    await req(`/channels/${exportChannel.id}/messages`, {
      method: 'POST',
      token: bobToken,
      body: { content: '<script>alert("x")</script> & "quotes"', replyToId: exportFirst.id },
    })
  ).json;
  const exportGone = (
    await req(`/channels/${exportChannel.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'deleted before the export' },
    })
  ).json;
  await req(`/messages/${exportGone.id}`, { method: 'DELETE', token: ownerToken });

  /** Just enough of a tar reader to check the archive: names, types and bytes. */
  function readTar(buffer) {
    const entries = new Map();
    let checksumsOk = true;
    let offset = 0;
    while (offset + 512 <= buffer.length) {
      const head = buffer.subarray(offset, offset + 512);
      if (head.every((byte) => byte === 0)) break;
      const field = (start, length) => head.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/, '');
      let sum = 0;
      for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 0x20 : head[index];
      if (parseInt(field(148, 8).trim(), 8) !== sum) checksumsOk = false;
      const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
      const size = parseInt(field(124, 12).trim() || '0', 8);
      offset += 512;
      entries.set(name, { type: String.fromCharCode(head[156]), data: buffer.subarray(offset, offset + size) });
      offset += Math.ceil(size / 512) * 512;
    }
    return { entries, checksumsOk };
  }

  const backupRole = await req('/roles', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Backup Admin', permissions: String(1n << 14n) },
  });
  check('a plain member cannot download a backup (403)', (await req('/backup', { token: bobToken })).status === 403);
  check(
    'a plain member cannot export a channel (403)',
    (await req(`/channels/${exportChannel.id}/export`, { token: bobToken })).status === 403,
  );
  await req(`/members/${bobId}/roles/${backupRole.json.id}`, { method: 'PUT', token: ownerToken });
  check(
    'an administrator who is not the owner cannot download a backup (403)',
    (await req('/backup', { token: bobToken })).status === 403,
  );
  check(
    'an administrator can export a channel',
    (await fetch(`${BASE}/channels/${exportChannel.id}/export`, { headers: { authorization: `Bearer ${bobToken}` } }))
      .status === 200,
  );
  await req(`/roles/${backupRole.json.id}`, { method: 'DELETE', token: ownerToken });

  // Manage Server alone is enough to export, but not a channel locked away from them.
  const exportManagerRole = await req('/roles', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Exporter', permissions: String(1n << 9n) },
  });
  const exportLockRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Vault', permissions: '0' } });
  const lockedExport = (
    await req('/channels', {
      method: 'POST',
      token: ownerToken,
      body: { name: 'vault', requiredRoleId: exportLockRole.json.id },
    })
  ).json;
  await req(`/members/${bobId}/roles/${exportManagerRole.json.id}`, { method: 'PUT', token: ownerToken });
  check(
    'Manage Server can export a channel it can see',
    (await fetch(`${BASE}/channels/${exportChannel.id}/export`, { headers: { authorization: `Bearer ${bobToken}` } }))
      .status === 200,
  );
  check(
    'a locked channel the exporter cannot see answers 404',
    (await req(`/channels/${lockedExport.id}/export`, { token: bobToken })).status === 404,
  );
  await req(`/channels/${lockedExport.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/roles/${exportManagerRole.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/roles/${exportLockRole.json.id}`, { method: 'DELETE', token: ownerToken });

  check(
    'exporting a missing channel 404s',
    (await req('/channels/no-such-channel/export', { token: ownerToken })).status === 404,
  );
  check(
    'an unknown export format is refused (400)',
    (await req(`/channels/${exportChannel.id}/export?format=pdf`, { token: ownerToken })).status === 400,
  );

  // Plant an orphan snapshot so the cleanup checks below are not vacuous: a
  // backup sweeps stale snapshots as it starts, and its own snapshot must be gone
  // when it ends. If either failed, this seeded file would still be here.
  const orphanSnapshot = join(dataDir, '.backup-orphan.db');
  writeFileSync(orphanSnapshot, 'orphan');
  check('the seeded orphan snapshot exists before the backup', existsSync(orphanSnapshot));

  const backupRes = await fetch(`${BASE}/backup`, { headers: { authorization: `Bearer ${ownerToken}` } });
  const backupName = /filename="([^"]+)"/.exec(backupRes.headers.get('content-disposition') ?? '')?.[1] ?? '';
  check('the owner can download a backup', backupRes.status === 200, `status ${backupRes.status}`);
  check(
    'the backup is named after the server and the date',
    /^harmony-backup-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(backupName),
    backupName,
  );
  const backupBytes = Buffer.from(await backupRes.arrayBuffer());
  let backupTar = { entries: new Map(), checksumsOk: false };
  try {
    backupTar = readTar(gunzipSync(backupBytes));
  } catch (error) {
    check('the backup is a gzip', false, String(error));
  }
  const dbEntry = backupTar.entries.get('harmony.db');
  check('the backup tar headers are well formed', backupTar.checksumsOk && backupTar.entries.size > 0);
  check('the backup holds the database', dbEntry?.type === '0' && dbEntry.data.length > 0);
  if (dbEntry) {
    const restoredPath = join(dataDir, 'restored-check.db');
    writeFileSync(restoredPath, dbEntry.data);
    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    check(
      'the database in the backup holds a known message',
      restored.prepare('SELECT content FROM messages WHERE id = ?').get(exportFirst.id)?.content ===
        'backup marker message, edited',
    );
    check(
      'the database in the backup holds the owner account',
      restored.prepare("SELECT is_owner FROM users WHERE username = 'alice'").get()?.is_owner === 1,
    );
    restored.close();
    rmSync(restoredPath, { force: true });
  }
  const blobEntry = backupTar.entries.get(`uploads/${backupUpload.hash.slice(0, 2)}/${backupUpload.hash}`);
  check(
    'the backup holds an uploaded file, byte for byte',
    blobEntry !== undefined && createHash('sha256').update(blobEntry.data).digest('hex') === backupUpload.hash,
  );
  check(
    'the temporary snapshot is gone once the backup is sent',
    readdirSync(dataDir).every((name) => !name.startsWith('.backup-')),
    readdirSync(dataDir).join(', '),
  );
  check('the seeded orphan snapshot was swept', !existsSync(orphanSnapshot));

  // Walking away halfway still cleans up, and does not wedge the next backup.
  const abandoned = new AbortController();
  const abandonedRes = await fetch(`${BASE}/backup`, {
    headers: { authorization: `Bearer ${ownerToken}` },
    signal: abandoned.signal,
  });
  abandoned.abort();
  await abandonedRes.body?.cancel().catch(() => {});
  await sleep(300);
  check(
    'an abandoned backup leaves no snapshot behind',
    readdirSync(dataDir).every((name) => !name.startsWith('.backup-')),
    readdirSync(dataDir).join(', '),
  );
  const nextBackup = await fetch(`${BASE}/backup`, { headers: { authorization: `Bearer ${ownerToken}` } });
  await nextBackup.arrayBuffer();
  check('a backup can be taken again after an abandoned one', nextBackup.status === 200, `status ${nextBackup.status}`);

  const jsonExportRes = await fetch(`${BASE}/channels/${exportChannel.id}/export?format=json`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  const jsonDisposition = jsonExportRes.headers.get('content-disposition') ?? '';
  const jsonExport = await jsonExportRes.json();
  check(
    'a JSON export downloads as a file',
    jsonDisposition.startsWith('attachment;') && jsonDisposition.includes('-export-test-') && jsonDisposition.endsWith('.json"'),
    jsonDisposition,
  );
  const [exportedFirst, exportedReply] = jsonExport.messages ?? [];
  check(
    'a JSON export holds the channel and its live messages, oldest first',
    jsonExport.channel?.name === 'export-test' &&
      jsonExport.messages?.length === 2 &&
      exportedFirst?.id === exportFirst.id &&
      exportedReply?.id === exportReply.id,
    JSON.stringify(jsonExport.messages?.map((message) => message.content)),
  );
  check(
    'a JSON export carries authors, edits, files and reactions',
    exportedFirst?.author?.username === 'alice' &&
      exportedFirst.editedAt !== null &&
      exportedFirst.attachments?.[0]?.filename === 'backup.png' &&
      exportedFirst.attachments[0].url.endsWith(`/api/v1/attachments/${backupUpload.id}`) &&
      exportedFirst.reactions?.[0]?.emoji === '👍' &&
      exportedFirst.reactions[0].count === 1,
    JSON.stringify(exportedFirst),
  );
  check(
    'a JSON export carries replies',
    exportedReply?.replyTo?.id === exportFirst.id && exportedReply.replyTo.authorName !== null,
    JSON.stringify(exportedReply?.replyTo),
  );

  const htmlExportRes = await fetch(`${BASE}/channels/${exportChannel.id}/export?format=html`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  const htmlExport = await htmlExportRes.text();
  check(
    'an HTML export is a standalone page',
    (htmlExportRes.headers.get('content-type') ?? '').startsWith('text/html') &&
      htmlExport.startsWith('<!doctype html>') &&
      htmlExport.includes('backup marker message, edited'),
  );
  check(
    'an HTML export escapes markup in messages',
    !htmlExport.includes('<script') && htmlExport.includes('&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;'),
  );
  check('an HTML export leaves deleted messages out', !htmlExport.includes('deleted before the export'));

  const backupAudit = (await req('/audit?limit=100', { token: ownerToken })).json?.entries ?? [];
  check(
    'downloading a backup is logged',
    backupAudit.some((entry) => entry.kind === 'backup_download' && entry.detail.filename === backupName),
  );
  check(
    'exporting a channel is logged with the channel',
    backupAudit.some((entry) => entry.kind === 'channel_export' && entry.detail.channelName === 'export-test'),
  );
  await req(`/channels/${exportChannel.id}`, { method: 'DELETE', token: ownerToken });

  // --- Audit retention and clearing ---
  check('a member cannot clear the log (403)', (await req('/audit', { method: 'DELETE', token: bobToken })).status === 403);
  // The Clear button is shown to anyone with Manage Server, not only the owner, so
  // a non-owner administrator clearing must be allowed.
  const auditorRole = await req('/roles', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Auditor', permissions: String(1n << 9n) },
  });
  await req(`/members/${bobId}/roles/${auditorRole.json.id}`, { method: 'PUT', token: ownerToken });
  check(
    'a Manage Server administrator can clear the log',
    (await req('/audit', { method: 'DELETE', token: bobToken })).status === 204,
  );
  await req(`/roles/${auditorRole.json.id}`, { method: 'DELETE', token: ownerToken });
  check('the log can be cleared', (await req('/audit', { method: 'DELETE', token: ownerToken })).status === 204);
  check('the log is empty after clearing', (await req('/audit', { token: ownerToken })).json?.entries?.length === 0);

  // --- Gif sources over HTTP: permissions, the guard on the copy route, the audit trail ---
  {
    const gifDb = new DatabaseSync(join(dataDir, 'harmony.db'));
    const GONE = 'https://media.giphy.com/media/harmony-smoke-nonexistent/giphy.gif';
    check('gif sources: stats need Manage Server (403)', (await req('/gifs/sources', { token: bobToken })).status === 403);
    check('gif sources: and a session (401)', (await req('/gifs/sources')).status === 401);
    const stats = await req('/gifs/sources', { token: ownerToken });
    check('gif sources: the owner reads the counts',
      stats.status === 200 && ['total', 'linked', 'archived', 'dead', 'archivedBytes'].every((key) => typeof stats.json?.[key] === 'number'));
    check('gif sources: archiving needs Manage Server', (await req('/gifs/sources/archive', { method: 'POST', token: bobToken })).status === 403);
    check('gif sources: freeing needs Manage Server', (await req('/gifs/sources/free', { method: 'POST', token: bobToken })).status === 403);
    check('gif sources: an empty archive run does nothing and is not logged',
      (await req('/gifs/sources/archive', { method: 'POST', token: ownerToken })).json?.attempted === 0 &&
        (await req('/audit?limit=100', { token: ownerToken })).json?.entries?.length === 0);

    check('gif copy: needs a session (401)', (await req(`/gifs/copy?url=${encodeURIComponent(GONE)}`)).status === 401);
    check('gif copy: an address never recorded is 404 and is not fetched',
      (await req(`/gifs/copy?url=${encodeURIComponent(GONE)}`, { token: ownerToken })).status === 404);
    check('gif copy: a private address is 404',
      (await req(`/gifs/copy?url=${encodeURIComponent('https://127.0.0.1/a.gif')}`, { token: ownerToken })).status === 404 &&
        (await req(`/gifs/copy?url=${encodeURIComponent('http://localhost:9/a.gif')}`, { token: ownerToken })).status === 404);
    check('gif sources: freeing is refused while the server stores gifs',
      (await req('/gifs/sources/free', { method: 'POST', token: ownerToken })).status === 409);

    // A recorded address whose fetch fails (guarded and, here, unreachable or absent).
    const nowIso = new Date().toISOString();
    gifDb.prepare('INSERT INTO gif_sources (url, content_type, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)').run(GONE, 'image/gif', nowIso, nowIso);
    const ran = await req('/gifs/sources/archive', { method: 'POST', token: ownerToken });
    check('gif sources: an archive run reports its batch and the failure',
      ran.status === 200 && ran.json?.attempted === 1 && ran.json?.copied === 0 && ran.json?.failed === 1 && ran.json?.more === false,
      JSON.stringify(ran.json));
    check('gif sources: the failure is counted against the address', gifDb.prepare('SELECT fail_count FROM gif_sources WHERE url = ?').get(GONE)?.fail_count === 1);

    const flip = await req('/settings', { method: 'PATCH', token: ownerToken, body: { gifStorage: 'link' } });
    const freed = await req('/gifs/sources/free', { method: 'POST', token: ownerToken });
    check('gif sources: freeing works while linking', flip.status === 200 && freed.status === 200 && freed.json?.released === 0);
    const gifAudit = (await req('/audit?limit=100', { token: ownerToken })).json?.entries ?? [];
    check('gif sources: archive and free are audit-logged',
      gifAudit.some((entry) => entry.kind === 'gif_archive' && entry.detail.count === 0) &&
        gifAudit.some((entry) => entry.kind === 'gif_free' && entry.detail.count === 0));
    await req('/settings', { method: 'PATCH', token: ownerToken, body: { gifStorage: 'store' } });
    gifDb.close();
    await req('/audit', { method: 'DELETE', token: ownerToken });
  }

  const auditDays = await req('/retention', {
    method: 'PATCH',
    token: ownerToken,
    body: { auditRetentionDays: 30 },
  });
  check(
    'audit retention is saved',
    auditDays.json?.settings?.auditRetentionDays === 30,
    JSON.stringify(auditDays.json?.settings),
  );

  // Make a fresh entry, then let retention age it out.
  const toPruneFromLog = await req(`/channels/${colorChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'prune me from the log' },
  });
  await req(`/messages/${toPruneFromLog.json.id}`, { method: 'DELETE', token: ownerToken });
  check(
    'a fresh entry is in the log',
    (await req('/audit', { token: ownerToken })).json?.entries?.length > 0,
  );

  await req('/retention', { method: 'PATCH', token: ownerToken, body: { auditRetentionDays: 0 } });
  const auditPruned = await req('/retention/run', { method: 'POST', token: ownerToken });
  check(
    'audit retention deletes old log entries',
    auditPruned.json?.summary?.deletedAuditEntries > 0,
    JSON.stringify(auditPruned.json?.summary),
  );
  check(
    'the log is empty after audit retention',
    (await req('/audit', { token: ownerToken })).json?.entries?.length === 0,
  );

  // --- Server log ---
  // The sanitizer is a pure function, so its rules can be exercised directly.
  check(
    'the server-log sanitizer redacts a token value',
    !sanitizeLogText('token: abc123def456').includes('abc123def456') &&
      sanitizeLogText('token: abc123def456').includes('[redacted]'),
  );
  check(
    'the server-log sanitizer redacts a password',
    !sanitizeLogText('password=hunter2').includes('hunter2') &&
      sanitizeLogText('password=hunter2').includes('[redacted]'),
  );
  check(
    'the server-log sanitizer redacts a bearer value',
    !sanitizeLogText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc').includes('eyJhbGciOiJIUzI1NiJ9.abc'),
  );
  check(
    'the server-log sanitizer redacts a Discord bot token',
    !sanitizeLogText('MTAwMDAwMDAwMDAwMDAwMDAwMDA.Abcde.abcdefghijklmnopqrstuvwx').includes('Abcde'),
  );
  check('the server-log sanitizer caps a long message', sanitizeLogText('x'.repeat(800)).length <= 500);
  const nestedRedaction = sanitizeDetail({ inner: { note: 'token: supersecret' }, list: ['api_key=xyz'] });
  check(
    'the server-log sanitizer redacts secrets nested in detail',
    nestedRedaction.inner.note === 'token: [redacted]' && nestedRedaction.list[0] === 'api_key=[redacted]',
    JSON.stringify(nestedRedaction),
  );
  check(
    'the server-log sanitizer keeps ordinary detail',
    sanitizeDetail({ channelName: 'general' }).channelName === 'general',
  );
  const keyedSecrets = sanitizeDetail({ token: 'abc123', password: 'hunter2', botToken: 'x', ok: 'kept' });
  check(
    'the server-log sanitizer redacts a secret held as a detail value',
    keyedSecrets.token === '[redacted]' &&
      keyedSecrets.password === '[redacted]' &&
      keyedSecrets.botToken === '[redacted]' &&
      keyedSecrets.ok === 'kept',
    JSON.stringify(keyedSecrets),
  );

  check('a member cannot read the server log (403)', (await req('/server-log', { token: bobToken })).status === 403);
  check(
    'a member cannot clear the server log (403)',
    (await req('/server-log', { method: 'DELETE', token: bobToken })).status === 403,
  );

  const serverLog = await req('/server-log?limit=100', { token: ownerToken });
  check(
    'the owner reads the server log and it holds the instance start',
    serverLog.status === 200 &&
      serverLog.json?.entries?.some((entry) => entry.event === 'instance_started'),
    JSON.stringify(serverLog.json?.entries?.map((entry) => entry.event)),
  );

  // Taking a backup records itself in the server log, as it does in the audit log.
  await (await fetch(`${BASE}/backup`, { headers: { authorization: `Bearer ${ownerToken}` } })).arrayBuffer();
  check(
    'a backup is recorded in the server log',
    (await req('/server-log?limit=100', { token: ownerToken })).json?.entries?.some(
      (entry) => entry.event === 'backup_created',
    ),
  );

  check(
    'the owner can clear the server log',
    (await req('/server-log', { method: 'DELETE', token: ownerToken })).status === 204,
  );
  check(
    'the server log is empty after clearing',
    (await req('/server-log', { token: ownerToken })).json?.entries?.length === 0,
  );

  const logDays = await req('/retention', {
    method: 'PATCH',
    token: ownerToken,
    body: { serverLogRetentionDays: 30 },
  });
  check(
    'server-log retention is saved',
    logDays.json?.settings?.serverLogRetentionDays === 30,
    JSON.stringify(logDays.json?.settings),
  );

  // Make a fresh entry, then let retention age it out.
  await (await fetch(`${BASE}/backup`, { headers: { authorization: `Bearer ${ownerToken}` } })).arrayBuffer();
  check(
    'a fresh entry is in the server log',
    (await req('/server-log', { token: ownerToken })).json?.entries?.length > 0,
  );

  await req('/retention', { method: 'PATCH', token: ownerToken, body: { serverLogRetentionDays: 0 } });
  await req('/retention/run', { method: 'POST', token: ownerToken });
  check(
    'server-log retention prunes old entries',
    (await req('/server-log?limit=100', { token: ownerToken })).json?.entries?.some(
      (entry) => entry.event === 'backup_created',
    ) !== true,
  );
  await req('/retention', { method: 'PATCH', token: ownerToken, body: { serverLogRetentionDays: null } });

  // --- Installable web app ---
  const manifestRes = await fetch(`${ORIGIN}/manifest.webmanifest`);
  const manifest = await manifestRes.json();
  check(
    'the app manifest is served as a manifest',
    manifestRes.status === 200 && (manifestRes.headers.get('content-type') ?? '').includes('manifest'),
  );
  check(
    'the manifest opens without browser chrome',
    manifest.display === 'standalone' && manifest.start_url === '/',
  );
  check('the manifest carries the instance name', manifest.name === 'Test Server', manifest.name);
  check(
    'the manifest lists the icon sizes a launcher needs',
    ['192x192', '512x512'].every((size) =>
      (manifest.icons ?? []).some((icon) => icon.sizes === size && icon.purpose === 'any'),
    ),
  );
  check(
    'the manifest offers a maskable icon',
    (manifest.icons ?? []).some((icon) => icon.purpose === 'maskable'),
  );

  const icon192 = await fetch(`${ORIGIN}/api/v1/icons/192`);
  const icon192Bytes = Buffer.from(await icon192.arrayBuffer());
  check(
    'an icon is rendered at the requested size',
    icon192.status === 200 &&
      (icon192.headers.get('content-type') ?? '') === 'image/png' &&
      (await sharp(icon192Bytes).metadata()).width === 192,
  );
  const maskableIcon = await fetch(`${ORIGIN}/api/v1/icons/512?maskable=1`);
  const maskableBytes = Buffer.from(await maskableIcon.arrayBuffer());
  const maskableMeta = await sharp(maskableBytes).metadata();
  check(
    'a maskable icon is rendered at its size',
    maskableIcon.status === 200 && maskableMeta.width === 512 && maskableMeta.height === 512,
  );
  // Opaque, because a transparent icon is left for the platform to back, and
  // Android and iOS both fill those in as a dark frame around the logo.
  check(
    'a rendered icon is opaque rather than left transparent',
    (await sharp(icon192Bytes).stats()).isOpaque === true &&
      (await sharp(maskableBytes).stats()).isOpaque === true,
  );

  /** One row of an icon's pixels, with the channel count it was written with. */
  async function iconRow(bytes, y) {
    const image = sharp(bytes);
    const { channels } = await image.metadata();
    const raw = await image.extract({ left: 0, top: y, width: 512, height: 1 }).raw().toBuffer();
    return { raw, channels: channels ?? 4 };
  }

  /** Where the first pixel of exactly this color sits along a scanned row. */
  function firstOf(scanned, rgb) {
    for (let x = 0; x < 512; x++) {
      const i = x * scanned.channels;
      if (scanned.raw[i] === rgb[0] && scanned.raw[i + 1] === rgb[1] && scanned.raw[i + 2] === rgb[2]) return x;
    }
    return -1;
  }

  // The stand-in icon is a picture that fills its own frame, so it must be drawn
  // edge to edge. Padding it would shrink it and ring it with a border nobody
  // asked for, which is exactly what a full-bleed image should never get.
  check(
    'a picture that fills its frame is drawn edge to edge, with no tile around it',
    firstOf(await iconRow(maskableBytes, 400), standInBlue) === 0,
    `the picture starts at x ${firstOf(await iconRow(maskableBytes, 400), standInBlue)}`,
  );

  // A logo drawn on transparency is what the padding is for. It stays inset on a
  // tile of its own color, so the launcher's crop takes the tile and not the art.
  const transparentLogo = await sharp({
    create: { width: 96, height: 96, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: await sharp({ create: { width: 24, height: 48, channels: 4, background: { r: 242, g: 63, b: 67, alpha: 1 } } })
          .png()
          .toBuffer(),
        left: 24,
        top: 24,
      },
      {
        input: await sharp({ create: { width: 24, height: 48, channels: 4, background: { r: 35, g: 165, b: 90, alpha: 1 } } })
          .png()
          .toBuffer(),
        left: 48,
        top: 24,
      },
    ])
    .png()
    .toBuffer();

  const logoUpload = new FormData();
  logoUpload.append('file', new Blob([transparentLogo], { type: 'image/png' }), 'logo.png');
  const logoRes = await fetch(`${BASE}/icon`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${ownerToken}` },
    body: logoUpload,
  });
  check('a logo drawn on transparency can be uploaded', logoRes.status === 200, `status ${logoRes.status}`);

  const logoMaskableBytes = Buffer.from(
    await (await fetch(`${ORIGIN}/api/v1/icons/512?maskable=1`)).arrayBuffer(),
  );
  const logoPlainBytes = Buffer.from(await (await fetch(`${ORIGIN}/api/v1/icons/512`)).arrayBuffer());
  const logoRed = [242, 63, 67];
  const paddedRed = firstOf(await iconRow(logoMaskableBytes, 256), logoRed);
  const plainRed = firstOf(await iconRow(logoPlainBytes, 256), logoRed);
  check(
    'a logo on transparency is inset, leaving the cropping to the tile',
    paddedRed > plainRed && plainRed > 0,
    `the logo starts at x ${paddedRed} padded and x ${plainRed} at full width`,
  );

  // The half-red, half-green logo averages to 139,114,79, which is what the tile
  // under it should be. The app background would be 49,51,56.
  const tile = (await iconRow(logoMaskableBytes, 256)).raw;
  check(
    "and that tile is the artwork's own color, not the app background",
    Math.abs((tile[0] ?? 0) - 139) < 12 && Math.abs((tile[1] ?? 0) - 114) < 12 && Math.abs((tile[2] ?? 0) - 79) < 12,
    `the tile pixel was ${tile[0]},${tile[1]},${tile[2]}`,
  );

  // Working the padding out from the image is the default, but it is a guess, and
  // the instance can overrule it either way.
  const iconDefaults = (await req('/settings', { token: ownerToken })).json;
  check(
    'the icon padding and background are worked out from the image by default',
    iconDefaults?.icon?.padding === null && iconDefaults?.icon?.background === null,
  );
  check(
    'an out of range icon padding is refused (400)',
    (
      await req('/settings', {
        method: 'PATCH',
        token: ownerToken,
        body: { icon: { padding: 90 } },
      })
    ).status === 400,
  );

  const manifestBefore = await (await fetch(`${ORIGIN}/manifest.webmanifest`)).json();
  const chosenIcon = await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { icon: { padding: 0, background: '#ffffff' } },
  });
  check(
    'the icon padding and background can be set',
    chosenIcon.json?.icon?.padding === 0 && chosenIcon.json?.icon?.background === '#ffffff',
  );

  const unpaddedBytes = Buffer.from(await (await fetch(`${ORIGIN}/api/v1/icons/512?maskable=1`)).arrayBuffer());
  const unpaddedRow = await iconRow(unpaddedBytes, 256);
  check(
    'padding 0 draws the logo across the whole tile',
    firstOf(unpaddedRow, logoRed) < paddedRed,
    `the logo starts at x ${firstOf(unpaddedRow, logoRed)}, against x ${paddedRed} by default`,
  );
  check(
    'and the chosen background shows around it, not the app background',
    unpaddedRow.raw[0] === 255 && unpaddedRow.raw[1] === 255 && unpaddedRow.raw[2] === 255,
    `the corner was ${unpaddedRow.raw[0]},${unpaddedRow.raw[1]},${unpaddedRow.raw[2]}`,
  );

  // The rendered icons are served with a long cache, so a changed setting has to
  // be a changed URL or an installed app would keep the old one forever.
  const manifestAfter = await (await fetch(`${ORIGIN}/manifest.webmanifest`)).json();
  const maskableSrc = (manifest) => (manifest.icons ?? []).find((icon) => icon.purpose === 'maskable')?.src ?? '';
  check(
    'a changed icon setting is a new icon URL, so the cache cannot serve the old one',
    maskableSrc(manifestAfter).length > 0 && maskableSrc(manifestAfter) !== maskableSrc(manifestBefore),
    `${maskableSrc(manifestBefore)} then ${maskableSrc(manifestAfter)}`,
  );

  await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { icon: { padding: null, background: null } },
  });
  await req('/icon', { method: 'DELETE', token: ownerToken });

  check('an unreasonable icon size is refused (400)', (await fetch(`${ORIGIN}/api/v1/icons/99999`)).status === 400);

  // --- Discord sign-in (optional, and off by default) ---
  check(
    'Discord sign-in settings need ManageServer (403)',
    (await req('/discord/auth', { token: bobToken })).status === 403,
  );
  const discordDefaults = await req('/discord/auth', { token: ownerToken });
  check(
    'Discord sign-in is off and unconfigured by default',
    discordDefaults.json?.configured === false && discordDefaults.json?.enabled === false,
  );
  check(
    'Discord sign-in is not offered in the instance meta by default',
    (await req('/meta')).json?.discordAuthEnabled === false,
  );

  // Discord has to be able to call us back, so a public base URL comes first.
  await req('/bridge', { method: 'PATCH', token: ownerToken, body: { publicBaseUrl: 'https://harmony.test' } });
  const discordConfigured = await req('/discord/auth', {
    method: 'PATCH',
    token: ownerToken,
    body: { clientId: '123456789012345678', clientSecret: 'secret-value', enabled: true },
  });
  check(
    'a configured Discord sign-in exposes its callback URL',
    discordConfigured.json?.configured === true &&
      discordConfigured.json?.redirectUri === 'https://harmony.test/api/v1/auth/discord/callback',
  );
  check('the client secret is never returned', !('clientSecret' in (discordConfigured.json ?? {})));
  check(
    'Discord sign-in is offered in the meta once enabled',
    (await req('/meta')).json?.discordAuthEnabled === true,
  );

  // Starting the flow hands the browser to Discord, with PKCE and a state.
  const discordStart = await fetch(`${BASE}/auth/discord`, { redirect: 'manual' });
  const discordStartTo = discordStart.headers.get('location') ?? '';
  check(
    'starting Discord sign-in redirects to Discord with PKCE',
    discordStart.status >= 300 &&
      discordStart.status < 400 &&
      discordStartTo.startsWith('https://discord.com/oauth2/authorize') &&
      discordStartTo.includes('client_id=123456789012345678') &&
      discordStartTo.includes('code_challenge_method=S256'),
    `${discordStart.status} ${discordStartTo}`,
  );

  // The flow is bound to the browser that started it, so a callback URL handed
  // to someone else is worthless.
  const flowCookie = discordStart.headers.getSetCookie?.().find((value) => value.startsWith('harmony_session_discord=')) ?? '';
  check(
    'starting Discord sign-in sets an HttpOnly browser binding',
    flowCookie.includes('HttpOnly') && flowCookie.includes('Path=/api/v1/auth/discord'),
    flowCookie,
  );
  const startState = new URL(discordStartTo).searchParams.get('state');
  const unbound = await fetch(`${BASE}/auth/discord/callback?code=stolen&state=${startState}`, { redirect: 'manual' });
  check(
    'a callback without the binding is refused',
    (unbound.headers.get('location') ?? '').includes('discord_error=failed'),
  );
  const secondStart = await fetch(`${BASE}/auth/discord`, { redirect: 'manual' });
  const secondState = new URL(secondStart.headers.get('location') ?? '').searchParams.get('state');
  const wrongBinding = await fetch(`${BASE}/auth/discord/callback?code=stolen&state=${secondState}`, {
    redirect: 'manual',
    headers: { cookie: 'harmony_session_discord=someone-elses' },
  });
  check(
    'a callback with another browser binding is refused',
    (wrongBinding.headers.get('location') ?? '').includes('discord_error=failed'),
  );

  // Linking an account must start from a signed-in member.
  const anonLink = await fetch(`${BASE}/auth/discord?intent=link`, { redirect: 'manual' });
  check(
    'linking Discord without a session sends the browser back to sign in',
    (anonLink.headers.get('location') ?? '').includes('discord_error=not_signed_in'),
  );

  // Turning it off takes the whole flow away again.
  await req('/discord/auth', { method: 'PATCH', token: ownerToken, body: { enabled: false } });
  const discordDisabled = await fetch(`${BASE}/auth/discord`, { redirect: 'manual' });
  check(
    'a disabled Discord sign-in sends the browser back with an error',
    (discordDisabled.headers.get('location') ?? '').includes('discord_error=disabled') &&
      (await req('/meta')).json?.discordAuthEnabled === false,
  );

  // A member can clear their own link from their profile.
  await req(`/members/${bobId}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { discordId: '666666666666666666' },
  });
  check(
    'a member can clear their own Discord link',
    (await req('/users/@me/discord', { method: 'DELETE', token: bobToken })).status === 204 &&
      (await req('/auth/me', { token: bobToken })).json?.user?.discordId === null,
  );

  // --- Update check ---
  // Driven in process with a throwaway database and a fake fetch: the real check
  // calls out to the internet, and what matters here is the parsing, the
  // comparison and that a failure never reads as "up to date".
  {
    const updateDir = mkdtempSync(join(tmpdir(), 'harmony-update-'));
    const updateDb = new Database({ dataDir: updateDir, dbFile: join(updateDir, 'update.db'), uploadDir: join(updateDir, 'uploads') });
    const updateSettings = createSettingsService(updateDb.sqlite, { serverName: 'Test', requireInvite: false });

    const versionFile = (version) => `export const HARMONY_VERSION = '${version}';\n`;
    const respond = (body, ok = true, status = 200) => Promise.resolve({ ok, status, text: async () => body });
    const notices = [];
    // Relative to the running version, so bumping Harmony does not break this.
    const newer = '99.0.0';
    const newest = '99.0.1';
    let answer = respond(versionFile(newer));
    const checker = createUpdateService({
      settings: updateSettings,
      sourceUrl: 'https://example.test/constants.ts',
      fetchImpl: () => answer,
      now: () => new Date('2025-01-01T00:00:00.000Z'),
      notify: (status) => notices.push(status.latest),
    });

    const first = await checker.check();
    check(
      'update: a newer version on the source is offered',
      first.enabled && first.latest === newer && first.available && first.checkedAt === '2025-01-01T00:00:00.000Z',
      JSON.stringify(first),
    );
    check('update: the newer release is announced once', notices.join() === newer);

    await checker.check();
    check('update: the same release is not announced twice', notices.length === 1);

    answer = respond(versionFile(HARMONY_VERSION));
    const upToDate = await checker.check();
    check(
      'update: the running version reads as up to date',
      !upToDate.available && upToDate.latest === HARMONY_VERSION && upToDate.error === null,
    );

    answer = respond(versionFile(newest));
    await checker.check();
    check('update: a second new release is announced', notices.join() === `${newer},${newest}`);

    // A failed check keeps the last known answer and records why.
    answer = respond('nope', false, 500);
    const failed = await checker.check();
    check(
      'update: a failed check keeps the last answer and records the error',
      failed.latest === newest && failed.available && failed.error === 'the source answered 500',
      JSON.stringify(failed),
    );

    answer = respond('nothing here');
    check('update: a source with no version is a failure', (await checker.check()).error === 'the source carried no version');

    // With no source configured, checks are off and nothing is fetched.
    let fetched = false;
    const off = createUpdateService({
      settings: updateSettings,
      sourceUrl: null,
      fetchImpl: () => {
        fetched = true;
        return respond(versionFile('9.9.9'));
      },
    });
    const disabled = await off.check();
    check('update: no configured source means the check is off', disabled.enabled === false && !fetched);

    // The toggle defaults off and round-trips through the settings service.
    check('update: the daily check is off by default', updateSettings.getUpdateCheck() === false);
    updateSettings.setUpdateCheck(true);
    check(
      'update: the daily check can be switched on',
      updateSettings.getUpdateCheck() === true && off.status().autoCheck === true,
    );

    updateDb.close();
    rmSync(updateDir, { recursive: true, force: true });
  }

  // The routes: the owner reads and toggles the status, nobody else reaches it.
  // The manual check is not pressed here, because on the booted instance it would
  // go out to the real update source.
  const updateStatus = await req('/update', { token: ownerToken });
  check(
    'the owner reads the update status',
    updateStatus.status === 200 &&
      updateStatus.json?.running === HARMONY_VERSION &&
      updateStatus.json?.autoCheck === false &&
      typeof updateStatus.json?.instanceId === 'string' &&
      updateStatus.json?.command === 'sleep 2; false' &&
      updateStatus.json?.backupRetention === 3 &&
      updateStatus.json?.applying === false &&
      Array.isArray(updateStatus.json?.snapshots),
    JSON.stringify(updateStatus.json),
  );
  check('a non-owner cannot read the update status (403)', (await req('/update', { token: bobToken })).status === 403);
  const toggled = await req('/update', { method: 'PATCH', token: ownerToken, body: { autoCheck: true } });
  check('the owner can switch the daily check on', toggled.status === 200 && toggled.json?.autoCheck === true);
  const untoggled = await req('/update', { method: 'PATCH', token: ownerToken, body: { autoCheck: false } });
  check('and off again', untoggled.status === 200 && untoggled.json?.autoCheck === false);

  // The snapshot retention field, and that a patch with nothing in it is refused.
  const retentionPatch = await req('/update', { method: 'PATCH', token: ownerToken, body: { backupRetention: 2 } });
  check(
    'the owner can change the snapshot retention',
    retentionPatch.status === 200 && retentionPatch.json?.backupRetention === 2,
  );
  check('an empty update patch is refused (400)', (await req('/update', { method: 'PATCH', token: ownerToken, body: {} })).status === 400);
  check(
    'an out-of-range retention is refused (400)',
    (await req('/update', { method: 'PATCH', token: ownerToken, body: { backupRetention: 0 } })).status === 400,
  );

  // The apply button: a non-owner cannot press it, and the backup flag is required.
  check(
    'a non-owner cannot apply an update (403)',
    (await req('/update/apply', { method: 'POST', token: bobToken, body: { backup: false } })).status === 403,
  );
  check(
    'an apply without the backup flag is refused (400)',
    (await req('/update/apply', { method: 'POST', token: ownerToken, body: {} })).status === 400,
  );

  // Back up and apply: the snapshot lands on disk, the command runs, and because the
  // smoke command exits non-zero the instance stays up and reports the failure.
  const applied = await req('/update/apply', { method: 'POST', token: ownerToken, body: { backup: true } });
  check('the owner can start a backed-up apply', applied.status === 200 && applied.json?.applying === true);
  check(
    'a second apply while one runs is refused (409)',
    (await req('/update/apply', { method: 'POST', token: ownerToken, body: { backup: false } })).status === 409,
  );
  let finished = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    finished = (await req('/update', { token: ownerToken })).json;
    if (finished?.applying === false) break;
    await sleep(250);
  }
  check(
    'the failed apply is reported, with its log',
    finished?.applying === false && finished?.failed === true && finished?.log?.includes('exited') === true,
    JSON.stringify({ applying: finished?.applying, failed: finished?.failed }),
  );
  check('the backup was kept', (finished?.snapshots ?? []).length >= 1 && finished.snapshots[0]?.sizeBytes > 0);

  // In-process: an apply with no command is refused, and old snapshots are pruned.
  {
    const applyDir = mkdtempSync(join(tmpdir(), 'harmony-apply-'));
    const applyDb = new Database({ dataDir: applyDir, dbFile: join(applyDir, 'apply.db'), uploadDir: join(applyDir, 'uploads') });
    const applySettings = createSettingsService(applyDb.sqlite, { serverName: 'Test', requireInvite: false });
    const applyLog = { info() {}, warn() {}, error() {} };
    const disabled = createUpdateApplier({
      sqlite: applyDb.sqlite,
      config: { dataDir: applyDir, dbFile: join(applyDir, 'apply.db'), updateCommand: null },
      settings: applySettings,
      serverLog: applyLog,
      onSuccess: () => {},
    });
    let refused = null;
    try {
      await disabled.apply({ backup: false });
    } catch (error) {
      refused = error;
    }
    check('an apply with no command is refused', refused?.statusCode === 409 && refused?.code === 'update_disabled');

    const snapshotsDir = join(applyDir, 'update-backups');
    mkdirSync(snapshotsDir, { recursive: true });
    ['a.db', 'b.db', 'c.db', 'd.db'].forEach((name, index) => {
      const path = join(snapshotsDir, name);
      writeFileSync(path, `snapshot ${name}`);
      // Distinct times, so newest-first order does not depend on the filesystem clock.
      const when = new Date(2026, 0, 1 + index);
      utimesSync(path, when, when);
    });
    const removed = pruneUpdateSnapshots(snapshotsDir, 2);
    const left = listUpdateSnapshots(snapshotsDir).map((snapshot) => snapshot.filename);
    check(
      'pruning keeps only the newest snapshots',
      removed === 2 && left.join(',') === 'd.db,c.db',
      `removed ${removed}, left ${left.join(',')}`,
    );

    applyDb.close();
    rmSync(applyDir, { recursive: true, force: true });
  }

  // Bots: owner-only accounts that act through a long-lived token and carry their
  // own permission bitfield rather than roles.
  const botList = await req('/bots', { token: ownerToken });
  check('the owner lists bots', botList.status === 200 && Array.isArray(botList.json?.bots));
  check('a non-owner cannot list bots (403)', (await req('/bots', { token: bobToken })).status === 403);

  const botChannel = (await req('/channels', { method: 'POST', token: ownerToken, body: { name: 'bot-room' } })).json;
  const madeBot = await req('/bots', {
    method: 'POST',
    token: ownerToken,
    body: { username: 'smokebot', displayName: 'Smoke Bot', permissions: String(Permission.ViewChannels) },
  });
  check(
    'the owner creates a bot and is shown its token once',
    madeBot.status === 200 &&
      typeof madeBot.json?.token === 'string' &&
      madeBot.json?.bot?.user?.accountType === 'bot',
    JSON.stringify(madeBot.json),
  );
  const botId = madeBot.json?.bot?.user?.id;
  let botToken = madeBot.json?.token;
  check('a bot carries no owner/admin badge', madeBot.json?.bot?.user?.badge === null);
  check(
    'the new bot is listed',
    (await req('/bots', { token: ownerToken })).json?.bots?.some((bot) => bot.user.id === botId) === true,
  );

  // The token authenticates as the bot, limited to the permissions it was given.
  check('the bot token reaches the API', (await req('/channels', { token: botToken })).status === 200);
  check(
    'the bot is held to its permissions (403 without SendMessages)',
    (await req(`/channels/${botChannel.id}/messages`, { method: 'POST', token: botToken, body: { content: 'hi' } }))
      .status === 403,
  );
  check('a bot is never the owner, so it cannot manage bots (403)', (await req('/bots', { token: botToken })).status === 403);

  // Editing the permission bitfield takes effect for the token already issued.
  const wanted = String(Permission.ViewChannels | Permission.SendMessages);
  const patchedBot = await req(`/bots/${botId}`, { method: 'PATCH', token: ownerToken, body: { permissions: wanted } });
  check('the owner edits a bot permissions', patchedBot.status === 200 && patchedBot.json?.permissions === wanted);
  check(
    'the edited permission lets the bot post',
    (await req(`/channels/${botChannel.id}/messages`, { method: 'POST', token: botToken, body: { content: 'from the bot' } }))
      .status === 200,
  );

  // Regenerating replaces the token; the old one dies at once.
  const regenerated = await req(`/bots/${botId}/token`, { method: 'POST', token: ownerToken });
  check(
    'regenerating returns a fresh token',
    regenerated.status === 200 && typeof regenerated.json?.token === 'string' && regenerated.json.token !== botToken,
  );
  const beforeRegenerate = botToken;
  botToken = regenerated.json.token;
  check('the replaced bot token stops working (401)', (await req('/channels', { token: beforeRegenerate })).status === 401);

  // Deleting the bot revokes its token.
  check('the owner deletes the bot (204)', (await req(`/bots/${botId}`, { method: 'DELETE', token: ownerToken })).status === 204);
  check('a deleted bot token is refused (401)', (await req('/channels', { token: botToken })).status === 401);
  check(
    'the bot is gone from the list',
    (await req('/bots', { token: ownerToken })).json?.bots?.some((bot) => bot.user.id === botId) !== true,
  );

  // Slash commands a bot registers, and the registry a member completes from.
  const cmdBot = await req('/bots', {
    method: 'POST',
    token: ownerToken,
    body: {
      username: 'cmd-bot',
      permissions: String(Permission.ViewChannels | Permission.SendMessages | Permission.ModerateMembers),
    },
  });
  const cmdBotToken = cmdBot.json?.token;

  const registered = await req('/bots/@me/commands', {
    method: 'PUT',
    token: cmdBotToken,
    body: {
      commands: [
        { name: 'timeout', description: 'Times a member out', requiredPermissions: String(Permission.ModerateMembers) },
        { name: 'ping', description: 'Replies with pong', requiredPermissions: String(Permission.ViewChannels) },
      ],
    },
  });
  check(
    'a bot registers slash commands',
    registered.status === 200 && registered.json?.commands?.length === 2,
    JSON.stringify(registered.json),
  );
  check(
    'a bot cannot take a built-in command name (400)',
    (
      await req('/bots/@me/commands', {
        method: 'PUT',
        token: cmdBotToken,
        body: { commands: [{ name: 'me', description: 'no', requiredPermissions: '0' }] },
      })
    ).status === 400,
  );
  check(
    'a repeated command name is refused (400)',
    (
      await req('/bots/@me/commands', {
        method: 'PUT',
        token: cmdBotToken,
        body: {
          commands: [
            { name: 'dup', description: 'a', requiredPermissions: '0' },
            { name: 'dup', description: 'b', requiredPermissions: '0' },
          ],
        },
      })
    ).status === 400,
  );
  check(
    'a person cannot register commands for a bot (403)',
    (
      await req('/bots/@me/commands', {
        method: 'PUT',
        token: ownerToken,
        body: { commands: [] },
      })
    ).status === 403,
  );

  // The owner holds every permission, so both show; a plain member does not hold
  // ModerateMembers, so /timeout is filtered out of their list entirely.
  const ownerCommands = await req('/commands', { token: ownerToken });
  check(
    'the owner sees both bot commands',
    ownerCommands.status === 200 &&
      ownerCommands.json?.commands?.map((command) => command.name).sort().join() === 'ping,timeout',
    JSON.stringify(ownerCommands.json),
  );
  check(
    'a command carries the bot it belongs to',
    ownerCommands.json?.commands?.every((command) => command.bot?.username === 'cmd-bot') === true,
  );
  const bobCommands = await req('/commands', { token: bobToken });
  check(
    'a member without the permission does not see the command',
    bobCommands.json?.commands?.some((command) => command.name === 'timeout') !== true &&
      bobCommands.json?.commands?.some((command) => command.name === 'ping') === true,
  );

  const timeoutCommand = ownerCommands.json?.commands?.find((command) => command.name === 'timeout');
  check(
    'invoking a command whose bot is offline is refused (409)',
    (
      await req(`/channels/${botChannel.id}/commands`, {
        method: 'POST',
        token: ownerToken,
        body: { commandId: timeoutCommand.id, args: '@someone 1h' },
      })
    ).status === 409,
  );
  check(
    'invoking a command without the permission is forbidden (403)',
    (
      await req(`/channels/${botChannel.id}/commands`, {
        method: 'POST',
        token: bobToken,
        body: { commandId: timeoutCommand.id },
      })
    ).status === 403,
  );

  check('logout succeeds', (await req('/auth/logout', { method: 'POST', cookie: login.cookie })).status === 200);
  check('session is dead after logout (401)', (await req('/auth/me', { cookie: login.cookie })).status === 401);
} catch (error) {
  failures++;
  console.error('UNEXPECTED ERROR:', error);
} finally {
  server.kill('SIGTERM');
  rmSync(webDir, { recursive: true, force: true });
  await sleep(200);
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
