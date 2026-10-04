// End-to-end smoke test for the auth, channel and messaging layers.
//
// Boots a throwaway server (temp data dir, invite-gated) and exercises the real
// HTTP + WebSocket surface: registration, invites, permissions, login/logout,
// cookies, bearer tokens, gateway IDENTIFY, channel listing, message history
// and realtime fan-out.
//
// Run with: npm run smoke --workspace @harmony/server
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import sharp from 'sharp';
import { listEmbeddableUrls, unwrapSuppressedLinks, deriveTheme, relativeLuminance, DEFAULT_ACCENT, DEFAULT_BACKGROUND } from '@harmony/shared';
import { isPrivateAddress, parseEmbedMetadata } from '../src/embeds/metadata.ts';
import { isDiscordAttachment, isGifPage, isGiphyPage, tweetStatusId, youtubeVideoId } from '../src/embeds/providers.ts';
import { isKlipyAddress, klipySearchUrl, normalizeKlipySearch } from '../src/gifs/klipy.ts';
import { parseMessageEmbed } from '../src/db/messages.ts';
import { Database } from '../src/db/index.ts';
import { insertGhostUser, insertUser } from '../src/db/users.ts';
import { insertInvite } from '../src/db/invites.ts';
import { insertBan } from '../src/db/bans.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createDiscordOAuthService } from '../src/auth/discord-oauth.ts';
import { insertChannel } from '../src/db/channels.ts';
import { insertMessage } from '../src/db/messages.ts';
import { listLinkedAttachments } from '../src/db/attachments.ts';
import { createAttachmentService } from '../src/attachments/service.ts';
import { createSettingsService } from '../src/settings/service.ts';
import { createUserService } from '../src/users/service.ts';

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

    pictureDb.close();
    rmSync(pictureDir, { recursive: true, force: true });
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
  const discordIdentity = (id, username, displayName = null) => ({ id, username, displayName });
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
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).includes('/oauth2/token')
      ? new Response(JSON.stringify({ access_token: 'token' }))
      : new Response(JSON.stringify({ id: '700000000000000009', username: 'someone' }));
  try {
    const stateOf = (flow) => new URL(flow.url).searchParams.get('state');
    const bound = oauth.authorizeUrl('link', { userId: 'member-2' });
    const completed = await oauth.complete('code', stateOf(bound), bound.binding);
    check(
      'a flow completes in the browser that started it',
      completed.identity.id === '700000000000000009' && completed.userId === 'member-2',
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

  // --- Audit retention and clearing ---
  check('a member cannot clear the log (403)', (await req('/audit', { method: 'DELETE', token: bobToken })).status === 403);
  check('the log can be cleared', (await req('/audit', { method: 'DELETE', token: ownerToken })).status === 204);
  check('the log is empty after clearing', (await req('/audit', { token: ownerToken })).json?.entries?.length === 0);

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
