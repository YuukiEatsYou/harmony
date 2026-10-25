# Push notifications (design)

> **Status: step 2 shipped — registry, identity and delivery.** The stable
> `instanceId` in `GET /api/v1/meta`, the per-account device registry
> (`PUT` / `DELETE /api/v1/users/@me/push-devices`) and the send are implemented
> and covered by the smoke test. A mention or a reply to a member who is not
> currently connected is `POST`ed, as the `PushPayload` JSON, to every endpoint
> that member registered; an endpoint the provider answers `404`/`410` for is
> pruned. What is still unbuilt is the rest of the provider list (Web Push, FCM,
> APNs) and the admin settings; see [What ships today](#what-ships-today).

This covers **system push**: an OS-level notification raised while the app is not
running (or is suspended). It is separate from the in-app notification *sounds*,
which the web client already plays.

## What ships today

This part of the design has been implemented; the rest of the document is the
proposal it was built from.

- **Instance identity.** A stable `instanceId`, kept for the instance's life, is
  seeded into `server_settings` by migration 41 and surfaced in
  `GET /api/v1/meta`. A client routes a notification or a `harmony://` deep link by
  it and falls back to the origin only when a server sends none.
- **Device registry.** `push_devices` (migration 42) holds one row per install per
  account. `PUT /api/v1/users/@me/push-devices` upserts by endpoint and `DELETE`
  removes one; both are authenticated and idempotent, and the endpoint is stored,
  never logged. See [API.md](API.md#push-devices).
- **Payload.** `PushPayload` in `packages/shared/src/push.ts` fixes the field names
  the client router reads.
- **Delivery.** When a message is created live, `apps/server/src/push/dispatch.ts`
  takes the `mentions` rows for it, drops anyone already connected to the gateway or
  muted in the channel, and `apps/server/src/push/sender.ts` `POST`s the payload
  JSON to each of that member's registered endpoints. It is the plain HTTP contract
  UnifiedPush/ntfy already speak, so no provider account is needed. The sender
  refuses an endpoint whose host does not resolve to a public address (the same
  SSRF guard every other outbound fetch uses, pinned to the address it checked)
  and never follows a redirect. An
  endpoint the provider answers `404`/`410` for is pruned. `GET /api/v1/meta`
  advertises the capability as `push: { supported: true, providers: ["unifiedpush"] }`.

Still unbuilt: the Web Push, FCM and APNs adapters, the per-instance on/off and
snippet-privacy settings, and retry bookkeeping (`last_error_at`). An instance with
no registered devices sends nothing.

## Why this is needed

The WebSocket gateway reaches a client only while it is connected, and it has no
resume: a reconnect gets a fresh `READY` and re-syncs over REST rather than
replaying what it missed (`packages/shared/src/gateway.ts`). So a client that is
closed, or that the OS has suspended, learns about a mention only the next time it
is opened.

- A **desktop** client rarely needs push. If it is running it can hold a gateway
  connection, and Electron can raise a native notification itself.
- A **mobile** client does. A background socket is suspended or killed by Android
  and iOS, so real push is the only reliable delivery while the app is not in the
  foreground.

## Goals and non-goals

**Goals**

- Deliver a notification for a mention or reply to a member who is not currently
  connected, on Android and iOS.
- Respect the same per-channel mute and notification level the inbox and the
  in-app sound already respect.
- Stay opt-in and self-hostable: an instance that configures nothing sends no push,
  and one path (UnifiedPush/ntfy) needs no Apple or Google account.
- Fit a client that is signed into **many** instances at once.

**Non-goals (for now)**

- Delivery receipts, read receipts, or "notification dismissed" state.
- Per-message notification settings beyond the existing channel level.
- Push as an email/SMS fallback, or any non-OS delivery channel.
- Guaranteed delivery or ordering. Push is best-effort, like the sound.

## The client is a shell over many instances

Both clients aim to be one app for every Harmony instance a member uses. The
desktop client already does this: each server is an Electron `<webview>` loaded
from that server's own URL under a persistent session partition, with a server
rail and an add-server flow that validates an address against `GET /api/v1/meta`.

Two things follow for push:

1. **One endpoint per install, registered per instance.** The push endpoint
   belongs to the app install, but each Harmony instance stores its own
   `{user, device}` record. The client registers the same endpoint with every
   instance it is signed into, and removes it when the server is removed or the
   session ends.
2. **A notification must say which instance it came from.** One distributor
   delivers for many servers, so the payload carries a stable instance id the
   client can route on.

## What already exists (reuse it, do not rebuild it)

| Piece | Where | What push can reuse |
| --- | --- | --- |
| Mention/reply recipients | `apps/server/src/db/mentions.ts`, written from `recordMentions` / `recordNameMentions` in `apps/server/src/messages/service.ts` | The exact set of members who should be told about a message. Bots and stand-ins are already excluded. |
| Per-channel mute + level | `apps/server/src/db/channel_settings.ts` | The suppression rule: `muted`, `level` (`default` / `mentions` / `nothing`), channel-or-category. |
| Notification level, resolved with inheritance | `apps/web/src/lib/channel-settings.svelte.ts` (`resolve`) | The client's own semantics, which the server should mirror. |
| Presence | `apps/server/src/realtime/hub.ts` | Whether a member is connected *right now*, to skip pushing to an app that is already open. |
| Auth | Bearer tokens and session cookies (`docs/API.md`) | Native clients can already call the API. |
| Instance metadata | `apps/server/src/routes/meta.ts` (`GET /api/v1/meta`) | Where the client discovers that an instance supports push and how. |

## Server design

### 1. Instance identity

A client that talks to many servers needs to tell them apart by something stable.
The instance name can change, so add a generated, immutable id.

- Store a UUID in `server_settings` (the `instance_id` key, alongside the keys in
  `apps/server/src/settings/service.ts`), seeded once by a migration and minted on
  first read only if it is ever missing.
- Surface it as `instanceId` in `GET /api/v1/meta` and in every push payload.
- It is not a secret; it identifies an instance, not a member.

### 2. Advertising support in `GET /api/v1/meta`

The add-server flow already reads `meta`. Extend it so a client can adapt per
instance, since some self-hosted instances will have push on and others not:

```ts
// Added to InstanceMeta, all optional so old servers and old clients still agree.
interface InstanceMeta {
  // ...existing fields...
  instanceId: string;
  push?: {
    supported: boolean;
    /** Any of these the client may use, best first. */
    providers: Array<'unifiedpush' | 'webpush' | 'fcm' | 'apns'>;
    /** Present only when 'webpush' is offered. */
    vapidPublicKey?: string;
  };
}
```

An absent `push` block means "not configured" — the client simply does not offer
notifications for that server.

**Shipped.** `GET /api/v1/meta` returns `push: { supported: true, providers: ["unifiedpush"] }`.
`supported` is true whenever the instance can deliver to a registered endpoint,
which today is always; the field is there so a build that turns delivery off can
say so without an older client offering a notification that never arrives.

### 3. Device registry

> **Shipped.** The table and the two endpoints below exist today, in the shape the
> mobile shell registers with. The columns the design proposed for later stages
> (`provider`, `keys`, `label`, error bookkeeping) are not there yet; only what the
> shipped contract needs is, and delivery prunes an endpoint the provider reports
> gone rather than recording an error against it.

One row per app install per member. Repeated registration of the same endpoint
updates the row rather than duplicating it.

```sql
-- Migration 42, appended after 41. Never edit a shipped one.
CREATE TABLE push_devices (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL,     -- provider capability URL, e.g. an ntfy URL
  platform   TEXT NOT NULL,     -- what the install runs on, 'android' today
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, endpoint)
);
```

Endpoints (`auth` is enough; a member manages only their own):

| Method | Path | Purpose |
| --- | --- | --- |
| `PUT` | `/api/v1/users/@me/push-devices` | Upsert by `endpoint`: `{ endpoint, platform }`. |
| `DELETE` | `/api/v1/users/@me/push-devices` | Remove one device: `{ endpoint }`. |

Both are idempotent, so the shell can retry a registration or a removal without
checking first. The `endpoint` is a **capability**: whoever holds it can push to
the device. Store it, never log it, and return it only to its owner. A `GET` list,
a per-id `DELETE`, a `DELETE`-all and a per-member cap are proposed below for when
delivery lands; they are not built.

### 4. When to notify

> **Shipped** in `apps/server/src/push/dispatch.ts`.

Mirror the client's `#notify` (`apps/web/src/lib/chat.svelte.ts`), so the sound and
the push cannot disagree:

1. Never for the author's own message; never for a bot/stand-in (already excluded
   from the mention rows).
2. Resolve the member's settings for the channel: the channel's own row, else its
   category's, else defaults.
3. If `muted` or `level === 'nothing'` → **no push** (this suppresses mentions too,
   matching the sound).
4. A resolved `mentions` level pushes only for `kind` `mention` or `reply`.
5. A resolved `all` (the server default) does the same in v1: every recipient is
   already a name mention or a reply, so `all` and `mentions` come to the same set
   here. (Pushing every message in every unmuted channel is a possible later
   option, not a v1 behavior.)
6. Skip if the member currently has a live gateway connection — the hub already
   knows this, and it means a desktop app that is running is not also pushed.
7. Fire on **creation only**, never on edit. An edit re-records name mentions; a
   notification for a message that was already announced would be a duplicate.

Coalesce: at most one notification per member per message, fanned out to that
member's devices. (Sending to every device is fine at these counts; a future
option is to send to the most recently seen device only.)

### 5. Where the fan-out runs

> **Shipped.** The live-only seam is `MessageService.onMessageReceived`, fired from
> `announce()` (a local post) and the non-`silent` branches of `createBridged` /
> `createPollBridged` (a live Discord message). A history import is `silent` and
> stays silent; an edit does not fire it. `index.ts` defers the fan-out past the
> request so a slow provider never delays the post.

The recipients are the `mentions` rows for the message. The trigger must be a
"live message created" signal — not an edit, and **not** a history backfill.

There is a trap here. `MessageService.onMessageCreated`
(`apps/server/src/messages/service.ts`) is documented as *local messages only*, and
`createBridged` deliberately does not announce (to avoid mirroring straight back to
Discord). A mention that arrives **from Discord** into a bridged channel would
therefore be missed if the hook used that listener. Add a live-only seam instead:

- Notify a new set of listeners from both places that already mean "this message
  really arrived": `create()`'s `announce()` and the non-`silent` branch of
  `createBridged()`.
- The `silent` branch (history import) must stay silent — never push.

The fan-out itself must be best-effort and off the request path: it runs after the
message is persisted and broadcast, never blocks or fails the send, and logs
delivery failures the way other background work does.

### 6. The notification payload

Minimal, because it travels through a third party, and bounded, because providers
cap payload size (about 4 KB on FCM, APNs and Web Push alike).

```ts
interface PushPayload {
  instanceId: string;      // route to the right server
  instanceName: string;    // so a shared notification tray is legible
  iconUrl: string | null;  // the instance icon
  channelId: string;
  channelName: string;
  messageId: string;
  kind: 'mention' | 'reply';
  authorName: string;
  /** Short preview, or null when the instance keeps previews out of payloads. */
  snippet: string | null;
}
```

- Never include tokens, session data, or a full message body.
- The `snippet` is a privacy choice: a self-hosted instance may prefer to send ids
  only and let the client fetch the text on open. The shipped default is a short
  snippet (the first 80 characters, whitespace flattened), so a tray can show what
  the notification is about; an admin setting to send ids only is still unbuilt.
- The client deep-links from `instanceId` → `channelId` → `messageId` and fetches
  the rest over the normal API.

### 7. Providers

> **Shipped: UnifiedPush / ntfy.** `apps/server/src/push/sender.ts` `POST`s the
> payload JSON to the registered endpoint over HTTP, which is all UnifiedPush/ntfy
> need. The `PushSender` interface below is the design it was built to; the other
> adapters are unbuilt.

Behind one interface, so the contract never mentions a specific service:

```ts
interface PushNotification {
  title: string;
  body: string;
  data: PushPayload;         // provider-specific encodings derive from this
}

type PushSendResult =
  | { ok: true }
  | { ok: false; retry: boolean; gone?: boolean; error: string };

interface PushSender {
  readonly provider: PushProvider;
  send(device: PushDevice, notification: PushNotification): Promise<PushSendResult>;
}
```

Adapters, in the order they are worth building:

1. **UnifiedPush / ntfy** — the reference adapter, and the best fit for this
   project. The device `endpoint` is an HTTP URL a local distributor (the ntfy app)
   hands the client; the server `POST`s the payload to it. **Shipped.** No Apple or
   Google account, works sideloaded, self-hostable.
2. **Web Push (VAPID)** — for browser/PWA and Electron. Needs a server VAPID
   keypair (admin setting; the public half is in `meta.push.vapidPublicKey`) and the
   client's `keys.p256dh` / `keys.auth`. No third-party account either.
3. **FCM** — Android. Works for a sideloaded APK, but needs a Firebase project
   (a Google account) and `google-services.json` in the client.
4. **APNs** — iOS. Needs a paid Apple Developer account for the push entitlement;
   a free-signed sideload cannot use it.

In the shipped build there is nothing to configure: an instance delivers to any
registered endpoint over HTTP, and sends nothing until a member registers one. The
per-instance on/off and the "one provider at a time" choice are part of the admin
settings that are still unbuilt.

### 8. Housekeeping

- **Prune on provider feedback.** A `410 Gone` / `404` means the endpoint is dead:
  the row is deleted, so it is not retried on every future mention. **Shipped.**
- **Backoff.** A transient failure is logged and dropped; `last_error_at`/`last_error`
  and a later retry are not built yet, because a push is best-effort and the next
  mention is its own retry.
- **Cascade.** Deleting a member removes their devices (`ON DELETE CASCADE`). **Shipped.**
- **Cap and rate limit** registration and sends, and coalesce per message as above.
  Registration is rate limited and one message coalesces to one notification per
  member; a send cap is not built.

## Client contract

- **Obtain one endpoint per install** (via the distributor, or an FCM/APNs token),
  then `PUT` it to each signed-in instance. Re-register if the OS rotates the
  token. `DELETE` it when the server is removed or the session ends.
- **Route by `instanceId`.** Ignore a notification whose instance the app does not
  know. Trust the id, not the display name.
- **Title** should name the instance (`#general · Yuuki Cult` or similar) so a
  single tray makes sense across servers.
- **Desktop (shell):** no server push is required. Consume the gateway you already
  have and raise a native `Notification`, respecting mute/level and the member's
  `notifyMajor`. The shell already aggregates unread-mention badges across
  servers over IPC; notification routing can extend that same channel. Web Push
  (option 2 above) can cover the "app fully closed" case later if wanted.
- **Mobile:** the shell owns the OS subscription, registers it per server, and
  routes an incoming notification into the right server view. It opens the web
  client as `?channel=<id>&message=<id>` (a `harmony://` deep link resolves to
  the same parameters).
- **Web client launch URL.** The web client reads `channel` and `message` on
  load: it opens `channel`, and when `message` names a message still in history
  it scrolls to and flashes it, however far back it sits, then strips both
  parameters so a reload does not replay the link. A message on the newest page
  is simply scrolled to; an older one is fetched with the page around it
  (`GET /channels/:id/messages?around=<id>`, one request), joined to the newest
  messages when the two meet and otherwise shown as an older stretch the reader
  scrolls on from. A channel or message the instance does not know falls back to
  the normal default (the configured default channel, at its newest messages)
  rather than leaving a blank screen. The same link, with the instance's origin
  in front, is what the client copies as a link to a message (`messageLink` in
  `apps/web/src/lib/launch-params.ts`).

## Security and privacy

- Registration requires authentication and is scoped to the caller (`@me`).
- The endpoint is a secret-equivalent capability: store it, never log it, and
  return it only to the member who registered it.
- Payloads traverse a third party. Keep them minimal, make the snippet optional,
  and document this clearly for the instance owner.
- A single endpoint registered with many servers means each of those servers can
  push to it. The client validates `instanceId` and can unregister per server.
- Presence-based skipping means a push is not sent to a member who is already
  connected *to that instance*; it does not leak who is online to any third party.

## Compatibility

The whole feature is additive:

- New tables via an appended migration; no shipped migration edited.
- New endpoints that older clients never call.
- New `meta` fields; clients that do not know them ignore them, and an old server
  simply omits `push`.
- The gateway protocol is unchanged.

An instance with no registered device sends nothing, exactly as today.

## Rollout

1. **Registry and identity — shipped.** Migrations 41–42, `instanceId` in `meta`,
   and the `/users/@me/push-devices` endpoints. No sending yet; covered by the
   smoke test. `meta.push` was left for this step, when there is something to
   advertise.
2. **UnifiedPush/ntfy sender + fan-out — shipped.** The decision logic, the
   live-only seam in `MessageService`, the HTTP sender, `meta.push`, and smoke
   coverage that posts a real mention to a local receiver and prunes a gone one.
3. **Web Push (VAPID)** and the admin settings UI.
4. **FCM / APNs** adapters for those who want them.
5. **Client integration**, mobile first. **Shipped on the mobile side** (YUC-9).

## Open questions

- Default for `level === 'default'`: mentions/replies only, or (later) every
  message in an unmuted channel? Shipped as mentions/replies only.
- Snippet in the payload vs ids only — which should the default be? Shipped as a
  short snippet; the ids-only setting is still open.
- One push per device, or the most recently seen device only?
- Where the member's push master switch lives: implied by having a registered
  device, or its own field alongside `notifyMajor` / `notifyMinor`?
- Do we need to cap pushes per member per minute for a busy channel?
- An endpoint is a member-supplied URL the server will `POST` to, so a hostile
  registration can aim the server at an internal address. **Decided and shipped:**
  the sender resolves the endpoint's host through the same public-address guard
  every other outbound fetch uses (`apps/server/src/embeds/guard.ts`), refuses
  anything private, loopback or link-local before a socket is opened, and
  connects to the address it checked rather than letting the name resolve again
  (closing the DNS-rebinding window). It never follows a redirect (which could
  bounce a public first hop to an internal one).
  A distributor that lives on the instance's own LAN would need the guard relaxed
  explicitly; a default instance refuses it.

## File map

- `apps/server/src/routes/meta.ts` — **shipped:** `instanceId` and `push`.
- `apps/server/src/settings/service.ts` — **shipped:** the instance id.
- `apps/server/src/db/migrations.ts` — **shipped:** the `instance_identity` and
  `push_devices` migrations. Delivery needs no schema change.
- `apps/server/src/db/push_devices.ts` — **shipped:** the registry queries.
- `apps/server/src/db/mentions.ts` — **shipped:** `listMentionsForMessage`, the
  recipients.
- `apps/server/src/routes/push-devices.ts` — **shipped:** the endpoints.
- `apps/server/src/push/service.ts` — **shipped:** the registry service.
- `apps/server/src/push/dispatch.ts` — **shipped:** who to notify and the fan-out.
- `apps/server/src/push/sender.ts` — **shipped:** the provider-agnostic HTTP sender.
- `apps/server/src/messages/service.ts` — **shipped:** the `onMessageReceived` seam.
- `apps/server/src/realtime/hub.ts` — **shipped:** "is this member connected" for
  skipping.
- `packages/shared/src/push.ts` — **shipped:** the payload type and `InstancePushMeta`;
  `api.ts` and `schemas.ts` — **shipped:** the meta field and the request schemas.
- `docs/API.md` — **shipped:** the endpoints, the `meta` field and the send rule.
- `apps/server/scripts/smoke.mjs` — **shipped:** the registry checks and a live
  mention delivered to a local receiver, plus the gone-endpoint prune.
