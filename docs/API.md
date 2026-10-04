# Harmony API

Harmony exposes a JSON HTTP API and a WebSocket gateway so you can build custom clients, bots
and integrations. This document is the reference for both.

The canonical definitions live in [`packages/shared/src`](../packages/shared/src): the TypeScript
types (`types.ts`, `api.ts`), the gateway protocol (`gateway.ts`), request schemas (`schemas.ts`)
and the permission bitfield (`permissions.ts`). If this document and the code ever disagree, the
code wins — please open an issue.

> Status: this covers everything in the 1.0 feature set. Some permission flags are defined but not
> yet enforced; those are marked as reserved below.

## Contents

- [Base URL and versioning](#base-url-and-versioning)
- [Authentication](#authentication)
- [Errors](#errors)
- [Permissions](#permissions)
- [Rate limits](#rate-limits)
- [Object shapes](#object-shapes)
- [REST reference](#rest-reference)
  - [Health and meta](#health-and-meta)
  - [Auth](#auth)
  - [Channels and categories](#channels-and-categories)
  - [Messages](#messages)
  - [Search](#search)
  - [Mentions and replies](#mentions-and-replies)
  - [Reactions](#reactions)
  - [Attachments](#attachments)
  - [Media gallery](#media-gallery)
  - [Gifs and the picker](#gifs-and-the-picker)
  - [Custom emoji](#custom-emoji)
  - [Stickers](#stickers)
  - [Users and avatars](#users-and-avatars)
  - [Roles](#roles)
  - [Members](#members)
  - [Audit log](#audit-log)
  - [Invites](#invites)
  - [Server settings](#server-settings)
  - [Instance icon](#instance-icon)
  - [Retention](#retention)
  - [Discord bridge](#discord-bridge)
  - [Discord sign-in](#discord-sign-in)
- [The gateway (WebSocket)](#the-gateway-websocket)
- [Worked example](#worked-example)
- [Limitations](#limitations)

## Base URL and versioning

All REST routes live under `/api/v1`. Replace `HOST` with your instance's address:

```
https://chat.example.com/api/v1
```

The gateway is a WebSocket at `wss://chat.example.com/gateway` (note: **not** under `/api/v1`).
Use `wss://`/`https://` when the instance is served over TLS, and `ws://`/`http://` otherwise.

One Harmony instance is one server. There is no notion of multiple guilds, so no route carries a
server or guild id.

## Authentication

Harmony uses opaque session tokens. There is no OAuth and no email.

A token is returned by `POST /api/v1/auth/register` and `POST /api/v1/auth/login`. Send it on
every request in one of two ways:

- **Bearer header** — for bots, scripts and native clients:
  ```
  Authorization: Bearer <token>
  ```
- **Session cookie** — set automatically by register/login, for browser clients on the same
  origin. The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when the instance runs over TLS.

The first account ever registered becomes the server owner (`isOwner: true`) and is exempt from the
invite requirement. Every later registration may require a valid invite code, depending on the
instance's `requireInvite` setting (see `GET /api/v1/meta`).

Tokens expire after `HARMONY_SESSION_TTL_DAYS` (default 30 days) or when you logout.

## Errors

Every error response has the same shape:

```json
{ "error": { "code": "forbidden", "message": "You do not have permission to do that." } }
```

`code` is a stable, machine-readable string; `message` is human-readable and may change. Common
status codes and their codes:

| Status | Codes you may see |
| --- | --- |
| 400 | `validation_error`, `invalid_reply`, `invalid_emoji`, `invalid_attachment`, `invalid_upload`, `default_role`, `cannot_moderate_self`, `cannot_moderate_bot` |
| 401 | `unauthorized`, `invalid_credentials` |
| 403 | `forbidden`, `timed_out`, `account_banned`, `target_is_admin`, `invite_required`, `invalid_invite`, `invite_expired`, `invite_exhausted`, `immutable_role`, `permission_escalation` |
| 404 | `not_found`, `channel_not_found`, `message_not_found`, `role_not_found`, `user_not_found`, `emoji_not_found`, `sticker_not_found`, `sticker_missing`, `attachment_not_found`, `avatar_not_found`, `not_banned` |
| 409 | `username_taken`, `emoji_exists`, `discord_channel_taken` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type`, `invalid_image` |
| 429 | `rate_limited` |
| 500 | `internal_error` |

`validation_error` means the body or query string failed schema validation; its `message` names the
offending field. A missing route returns `404` with `{ "error": { "code": "not_found", ... } }`.

## Permissions

Permissions are a bitfield, granted through roles. `Administrator` implies every other flag. The
implicit `@everyone` role grants every member `ViewChannels`, `SendMessages`, `AttachFiles`,
`AddReactions` and `CreateInvites` by default.

| Flag | Bit | Enforced by |
| --- | --- | --- |
| `ViewChannels` | `1 << 0` | Reading channels, messages, roles, emoji and attachments |
| `SendMessages` | `1 << 1` | Posting messages |
| `ManageMessages` | `1 << 2` | Deleting others' messages, clearing reactions |
| `AttachFiles` | `1 << 3` | Uploading attachments |
| `EmbedLinks` | `1 << 4` | *Reserved* — not enforced yet |
| `AddReactions` | `1 << 5` | Adding and removing your own reactions |
| `ManageChannels` | `1 << 6` | Creating, editing, deleting and importing channels and categories |
| `ManageRoles` | `1 << 7` | Managing roles and members' roles |
| `ManageEmojis` | `1 << 8` | Uploading, importing and deleting custom emoji |
| `ManageServer` | `1 << 9` | Server settings, retention, the Discord bridge and the audit log |
| `KickMembers` | `1 << 10` | Ending a member's sessions |
| `BanMembers` | `1 << 11` | Banning and unbanning members |
| `CreateInvites` | `1 << 12` | Minting invite codes |
| `MentionEveryone` | `1 << 13` | *Reserved* — not enforced yet |
| `Administrator` | `1 << 14` | Implies every flag above |
| `ModerateMembers` | `1 << 15` | Putting members in a timeout |
| `ManageMembers` | `1 << 16` | Editing members' usernames, display names, pictures and passwords |

Over the wire, permission bitfields are **decimal strings** (`"1"`, `"2081"`), never JSON numbers,
because JSON cannot carry a 64-bit integer. `GET /api/v1/auth/me` returns your effective
permissions; roles expose theirs via `GET /api/v1/roles`.

Without `Administrator`, you cannot grant a permission you do not hold yourself (an anti-escalation
guard): not by creating or editing a role, not by assigning a role to anyone (yourself included), and
you cannot edit or delete a role that already holds a permission you lack. Each returns
`403 permission_escalation`. Likewise only an administrator can act on an administrator or the owner
— remove their roles, or edit their account — which returns `403 target_is_admin`.

## Rate limits

Only registration and login are rate limited: **10 requests per minute per IP**, after which the
instance replies `429 rate_limited`. The limiter is per-process and in-memory, which is fine for a
single-instance community.

## Object shapes

These appear across the API. Timestamps are ISO 8601 strings; ids are opaque strings.

```ts
type User = {
  id: string;
  username: string;
  displayName: string | null;   // falls back to username in the UI
  avatarHash: string | null;    // see "Users and avatars"
  roleColor: number | null;     // packed RGB integer, from the highest colored role
  isBot: boolean;               // true for Discord stand-in accounts
  isOwner: boolean;
  badge: 'owner' | 'admin' | 'moderator' | null;  // shown beside the name, see "Member badges"
  createdAt: string;
  timedOutUntil: string | null; // end of an active timeout, else null
  showTyping: boolean;          // typing indicators on/off for this user
  notifyMajor: boolean;         // in-app sound for a message that mentions this user
  notifyMinor: boolean;         // in-app sound for other messages
  discordId: string | null;     // the Discord account this user is linked to, or that a stand-in represents
  hasPassword: boolean;         // false for an account created through Discord sign-in until a password is set
};

type Category = {
  id: string;
  name: string;
  position: number;
  requiredRoleId: string | null; // a role required to see it and its channels
};

type Channel = {
  id: string;
  name: string;
  topic: string | null;
  type: 'text';                 // only text channels exist in 1.0
  categoryId: string | null;    // null means "no category"
  position: number;
  createdAt: string;
  discordChannelId: string | null; // set when bridged
  requiredRoleId: string | null;   // its own lock, or null to inherit the category's
  slowmodeSeconds: number;         // per-member seconds between messages; 0 is off
};

type Attachment = {
  id: string;
  messageId: string | null;     // null until attached to a message
  filename: string;
  contentType: string;          // image/*, or video/mp4 for a clip
  size: number;                 // bytes
  width: number | null;         // null for a video, which carries no dimensions
  height: number | null;
  hash: string;                 // content hash; blob is immutable
  createdAt: string;
  sourceUrl: string | null;     // the link this was fetched from, null for an upload
};

type Reaction = {
  emoji: string;                // a unicode character, or ":name:" for a custom emoji
  emojiId: string | null;       // the custom emoji id when emoji is ":name:"
  count: number;
  me: boolean;                  // whether the requesting user reacted
};

type MessageReference = {
  id: string;
  author: User | null;
  content: string;              // "" when the parent was deleted
  deleted: boolean;
};

type Message = {
  id: string;
  channelId: string;
  author: User | null;          // null when the account was deleted
  content: string;
  createdAt: string;
  editedAt: string | null;
  attachments: Attachment[];
  stickers: Sticker[];          // stickers sent with the message; only Discord sends them
  replyTo: MessageReference | null;
  reactions: Reaction[];
  embed: LinkEmbed | null;      // link preview, see "Link previews"
};

type LinkEmbed = {
  url: string;                  // the final URL after redirects
  title: string | null;
  description: string | null;
  siteName: string | null;      // og:site_name, or the host name
  imageUrl: string | null;      // og:image / twitter:image, or the link itself for a direct image
  player: EmbedPlayer | null;   // an inline player a client may offer, or null
};

// Only providers a client knows how to build an embed URL for.
type EmbedPlayer = {
  provider: 'youtube';
  id: string;                   // the video id, never a ready-made embed URL
};

type Role = {
  id: string;
  name: string;
  color: number | null;         // packed RGB, or null for the default color
  position: number;             // display/color ordering only
  permissions: string;          // decimal bitfield string
  hoist: boolean;               // true gives the role its own member list group
  mentionable: boolean;
  isDefault: boolean;           // true only for @everyone
  badge: 'none' | 'moderator';  // shown beside members' names, see "Member badges"
};

// The two colors an admin picks. Everything else is derived, see "Theming".
type ThemeSettings = {
  background: string | null;    // #rrggbb, or null for the built-in default
  accent: string | null;
};

type Emoji = {
  id: string;
  name: string;
  hash: string;
  animated: boolean;
  external: boolean;   // learned from a Discord message; renders, but kept out of the pickers
};

// A sticker learned from a Discord message, served at `/api/v1/stickers/:id`.
// Harmony has no stickers of its own, so these only ever arrive over the bridge.
type Sticker = {
  id: string;
  name: string;
  hash: string;
  animated: boolean;
};

/** A custom emoji that exists in the linked Discord server. */
type DiscordEmojiOption = {
  id: string;
  name: string;
  animated: boolean;
  imported: boolean;   // whether Harmony already has an emoji of this name
};

type DiscordEmojiListResponse = {
  guildName: string | null;   // null when the Discord bridge is not connected
  emojis: DiscordEmojiOption[];
};

/** How a Discord emoji import went. */
type EmojiImportResponse = {
  imported: number;   // emoji copied in
  skipped: number;    // already present in Harmony
  failed: number;     // unreadable: an unusable name, too large, and so on
};

/** A text channel in the linked Discord server. */
type DiscordChannelOption = {
  id: string;
  name: string;
  categoryId: string | null;   // the Discord category it sits in, or null
};

type DiscordCategoryOption = { id: string; name: string };

type DiscordChannelListResponse = {
  guildName: string | null;    // null when the Discord bridge is not connected
  categories: DiscordCategoryOption[];
  channels: DiscordChannelOption[];
};

/** One Discord channel offered to the channel import. */
type DiscordChannelImportOption = {
  id: string;
  name: string;
  bridged: boolean;   // whether a Harmony channel already syncs with it
};

type DiscordChannelImportGroup = {
  categoryName: string | null;   // null for uncategorized channels
  channels: DiscordChannelImportOption[];
};

type DiscordChannelImportPreview = {
  guildName: string | null;
  groups: DiscordChannelImportGroup[];
};

/** How a Discord channel import went. */
type ChannelImportResponse = {
  imported: number;           // channels created and bridged
  skipped: number;            // already bridged
  failed: number;             // names that do not fit Harmony's rules
  categoriesCreated: number;  // new categories made to hold the imports
};

type Invite = {
  code: string;
  createdAt: string;
  expiresAt: string | null;     // null = never expires
  maxUses: number | null;       // null = unlimited
  uses: number;
};

type Ban = {
  user: User;
  bannedBy: User | null;        // null if the moderator's account is gone
  reason: string | null;
  createdAt: string;
};

// One recorded admin or moderation action, see "Audit log".
type AuditKind =
  | 'message_delete' | 'message_edit' | 'media_delete'
  | 'timeout_add' | 'timeout_clear'
  | 'kick' | 'ban' | 'unban'
  | 'role_add' | 'role_remove'
  | 'member_update' | 'password_reset';

type AuditDetail = {
  channelName?: string;   // message and media kinds
  before?: string;        // deleted text, or an edit's old text
  after?: string;         // an edit's new text
  filename?: string;      // media_delete: the file that was removed
  attachments?: Array<{ id: string; filename: string }>;  // images a deleted message carried
  durationMinutes?: number;
  reason?: string | null;
  roleName?: string;
  fields?: string[];       // member_update: the account fields that changed
  actorName?: string;     // snapshots, so an entry stays readable after a rename
  targetName?: string;
};

type AuditEntry = {
  id: string;
  kind: AuditKind;
  actor: User | null;
  target: User | null;
  createdAt: string;
  detail: AuditDetail;
};
```

### Mentions

Mentions are written as `@username` in a message's `content`. Usernames are unique and contain
no spaces, so a mention is unambiguous; the lookbehind in the parser keeps an `@` inside an email
(`a@b.com`) from counting. `@everyone` and `@here` are reserved and never resolve.

The content keeps the **username**, not the display name, so a renaming display name never breaks
a mention. To render one, resolve the token against the `username` field of every entry in
[`GET /api/v1/members/directory`](#get-apiv1membersdirectory--viewchannels). A token that does not
match anyone is plain text. A client may also highlight a message whose mentions include its own
user id.

A **channel reference** is written `#channel-name`. Unlike a username, a channel name may contain a
space and is not unique, so a reference is resolved against the channels the reader can see —
longest name first — rather than matched by shape: `#general` becomes a link to that channel, and a
token matching no channel stays plain text. A reference inside a code span or code block is literal.
A channel reference is a pointer rather than a summons, so it never appears in the
[inbox](#mentions-and-replies) and never plays a notification sound.

When the referenced channel is bridged, [the bridge](#discord-bridge) rewrites `#name` to a real
Discord channel mention `<#id>` on the way out, and a Discord `<#id>` for a bridged channel back to
`#name` on the way in. A reference with no counterpart on the other side is left as plain text.

## REST reference

Unless stated otherwise, request bodies are JSON with `Content-Type: application/json`, and
responses are JSON.

### Health and meta

#### `GET /api/v1/health` — no auth

Liveness probe.

```json
{
  "status": "ok",
  "name": "Harmony",
  "apiVersion": "v1",
  "gatewayVersion": 1,
  "database": "ok",
  "uptimeSeconds": 1234
}
```

#### `GET /api/v1/meta` — no auth

Public instance information a client needs before signing in.

```json
{
  "name": "My Community",
  "apiVersion": "v1",
  "requireInvite": true,
  "theme": { "background": null, "accent": null },
  "iconHash": null,
  "maxImageBytes": 10485760,
  "maxVideoBytes": 20971520,
  "allowedImageTypes": ["image/png", "image/jpeg", "image/gif", "image/webp"],
  "allowedVideoTypes": ["video/mp4"],
  "klipyConfigured": false,
  "discordAuthEnabled": false,
  "limits": {
    "messageLength": 4000,
    "attachmentsPerMessage": 10,
    "channelNameMax": 64,
    "usernameMin": 2,
    "usernameMax": 32,
    "passwordMin": 8
  }
}
```

`discordAuthEnabled` is true only when an administrator has configured Discord sign-in, turned
it on, and the instance has a public base URL — so it is the switch a client uses to decide whether
to offer a "Sign in with Discord" button. It is off on a fresh instance. See
[Discord sign-in](#discord-sign-in).

### Auth

#### `POST /api/v1/auth/register` — no auth, rate limited

```json
{ "username": "alice", "password": "hunter2hunter2", "inviteCode": "abc123" }
```

`username` is 2–32 characters from `A-Z a-z 0-9 . _ -`. `password` is 8–200 characters.
`inviteCode` is required only when the instance requires invites (`403 invite_required`) and is
ignored for the very first account. Returns an `AuthResponse`:

```json
{ "user": { "...": "..." }, "token": "harmony_session_token" }
```

Possibly errors: `409 username_taken`, `403 invite_required` / `invalid_invite` /
`invite_expired` / `invite_exhausted`.

#### `POST /api/v1/auth/login` — no auth, rate limited

```json
{ "username": "alice", "password": "hunter2hunter2" }
```

Returns `AuthResponse`. Errors: `401 invalid_credentials`.

#### `POST /api/v1/auth/logout` — auth

Invalidates the current session and clears the cookie. Returns `{ "ok": true }`.

#### `GET /api/v1/auth/me` — auth

```json
{ "user": { "...": "..." }, "permissions": "2081" }
```

### Discord sign-in

Optional and off by default. When an administrator turns it on, people can sign in with Discord —
which creates their account on first use, with no password — and members can connect their Discord
account from their profile. It uses the same Discord application as the
[bridge](#discord-bridge): register the callback URL shown in **Admin → Bridge** under *OAuth2 →
Redirects* in the Discord developer portal, then save the client id and secret there.

The flow is OAuth2 authorization code with PKCE and a one-time `state`. Both endpoints below end in
a browser navigation, so they redirect back into the app with a short outcome code in the query
string (`?discord=linked`, `?discord_error=taken`, and so on) rather than returning JSON.

#### `GET /api/v1/discord/auth` — `ManageServer`

```json
{ "clientId": "123", "configured": true, "enabled": true, "redirectUri": "https://…/api/v1/auth/discord/callback" }
```

#### `PATCH /api/v1/discord/auth` — `ManageServer`

`{ "clientId"?, "clientSecret"?, "enabled"? }`. Omitted fields are left unchanged; an empty string
clears a saved id or secret. `redirectUri` is null until a public base URL is set on the bridge, and
the flow cannot run without one. The secret is write-only: it is never returned.

#### `GET /api/v1/auth/discord` — no auth

Starts the flow and redirects to Discord. `intent=link` connects a Discord account to the
signed-in member and must be started while signed in; the default is `intent=login`. A login may
carry `invite=<code>`, which is used only if it ends up creating an account and invites are required. Either way the
browser leaves the app, so a failure is a redirect back to `/?discord_error=…`.

#### `GET /api/v1/auth/discord/callback` — no auth

Discord's redirect target. For a `link` intent it verifies the account and connects it — the safe,
ownership-proving path a manually entered id could never be — then redirects to `/?discord=linked`.
For a `login` intent it signs in the member whose account already carries that Discord id
(`/?discord=signed_in`). Otherwise it creates one (`/?discord=signed_up`): a username derived from the
Discord one, the Discord display name, no password (`hasPassword: false`), never the owner. A
bridge stand-in for the same Discord user is folded into the new account, keeping its history. The
same checks as registering apply: where invites are required a missing or unusable code redirects to
`/?discord_error=invite_required|invalid_invite|invite_expired|invite_exhausted`, and a banned
account (or banned stand-in) to `account_banned`.

#### `DELETE /api/v1/users/@me/discord` — auth

Clears the caller's own Discord link and fires `MEMBER_UPDATE`. What a link merged in stays merged —
disconnecting only stops future attribution. Refused with `409 password_required` for an account that
has no password, since Discord is its only way in.

### Channels and categories

#### `GET /api/v1/channels` — `ViewChannels`

```json
{
  "categories": [ /* Category */ ],
  "channels": [ /* Channel */ ],
  "unreadChannelIds": [ "..." ],
  "mentionChannelIds": [ "..." ],
  "defaultChannelId": "..."
}
```

`defaultChannelId` is the channel the server has configured to open on load, or `null` to fall back
to the first channel. It is read fresh on every request, so a client sees an admin's change on the
next load.

`unreadChannelIds` lists the channels holding messages the caller has not read. It is per member —
the same channel is unread for one person and read for another — which is why it sits beside the
channels rather than on them. Read state is kept by the server, so it survives a reload and follows a
member between devices, and it is nobody else's business: it is not a read receipt, and no other
member can tell what you have seen.

`mentionChannelIds` is the same list narrowed to the channels holding an unread mention or reply for
the caller, which is what draws the red mark beside a channel. A channel drops off it exactly when it
is read, so it moves together with `unreadChannelIds`. See
[Mentions and replies](#mentions-and-replies).

#### `POST /api/v1/channels/:id/read` — `ViewChannels`

Records that the caller has read a channel, up to its newest message rather than to the wall clock,
so a message arriving in the same moment still counts as new. Returns `204`. Posting a message marks
its channel read by itself, and a channel with no messages is never unread. `403 channel_forbidden`
for a locked channel, `404` for one that does not exist.

#### `POST /api/v1/channels` — `ManageChannels`

```json
{ "name": "general", "topic": null, "categoryId": null, "discordChannelId": null }
```

`topic`, `categoryId`, `discordChannelId`, `requiredRoleId` and `slowmodeSeconds` are all optional.
Linking a `discordChannelId` requires a configured bridge and a Discord channel not already linked
elsewhere (`409 discord_channel_taken`). `requiredRoleId` must name a real role (`400 invalid_role`)
and locks the channel; see [Channel locking](#channel-locking). `slowmodeSeconds` sets a per-member
cooldown, 0 to 21600; see [Slowmode](#slowmode). Returns the new `Channel` and fires
`CHANNEL_CREATE`.

#### `PATCH /api/v1/channels/:id` — `ManageChannels`

Any of `name`, `topic`, `categoryId`, `position`, `discordChannelId`, `requiredRoleId`,
`slowmodeSeconds`. Returns the updated `Channel` and fires `CHANNEL_UPDATE`. Changing `categoryId`
appends the channel to the end of the target category, unless `position` is given explicitly.
`requiredRoleId: null` drops the channel's own lock, so it falls back to its category's.

#### `POST /api/v1/channels/:id/move` — `ManageChannels`

```json
{ "direction": "up" }
```

`direction` is `up` or `down`. Swaps the channel with its neighbor inside its own category, so it
is a no-op at either end. Returns the moved `Channel` and fires `CHANNEL_UPDATE`.

#### `DELETE /api/v1/channels/:id` — `ManageChannels`

Returns `204`. Fires `CHANNEL_DELETE` with `{ "id": "..." }`. If the deleted channel was the
configured `defaultChannelId`, that preference is cleared.

#### `POST /api/v1/channels/:id/typing` — `SendMessages`

Announces that you are typing in a channel. Returns `204` and fires `TYPING_START`. It is best
effort: the server throttles it per user, a timed-out member is refused, and a member with
`showTyping` off broadcasts nothing. Call it at most every few seconds while typing.

#### `GET /api/v1/channels/discord` — `ManageChannels`

Lists the text channels in the Discord server the bridge is connected to, grouped by their Discord
category, so an admin can see what an import would bring. Returns a `DiscordChannelImportPreview`;
`guildName` is `null` when the bridge is not running.

```json
{
  "guildName": "My Discord Server",
  "groups": [
    { "categoryName": null, "channels": [{ "id": "123", "name": "offtopic", "bridged": false }] },
    { "categoryName": "General", "channels": [{ "id": "456", "name": "general", "bridged": true }] }
  ]
}
```

#### `POST /api/v1/channels/import` — `ManageChannels`

Creates a Harmony channel for every Discord channel the bot can see that is not already bridged,
recreating its Discord category as a Harmony category of the same name, and links each new channel
so messages sync. Discord ids are the join key, so an already-bridged channel is skipped and the
import is safe to run again.

Send `{ "channelIds": ["..."] }` to import only those channels, which is what the admin panel's
picker does; leave it out to import everything not yet bridged. A channel outside the selection is
simply untouched, not counted as skipped. Returns a `ChannelImportResponse`; `503 bridge_offline`
when the bridge is not connected. Each new channel fires `CHANNEL_CREATE`, each new category fires
`CATEGORY_CREATE`, and the new channels' recent history is pulled in afterwards.

#### `POST /api/v1/categories` — `ManageChannels`

```json
{ "name": "Text Channels", "requiredRoleId": null }
```

Returns the new `Category`, fires `CATEGORY_CREATE`. `requiredRoleId` must name a real role
(`400 invalid_role`) and locks the category and every channel inside it.

#### `PATCH /api/v1/categories/:id` — `ManageChannels`

`{ "name"?: string, "position"?: number, "requiredRoleId"?: string | null }`. Returns the
`Category`, fires `CATEGORY_UPDATE`.

#### `POST /api/v1/categories/:id/move` — `ManageChannels`

```json
{ "direction": "up" }
```

`direction` is `up` or `down`. Swaps the category with its neighbor in the sidebar order, so it is
a no-op at either end. Returns the moved `Category` and fires `CATEGORY_UPDATE`.

#### `DELETE /api/v1/categories/:id` — `ManageChannels`

Returns `204`, fires `CATEGORY_DELETE` with `{ "id": "..." }`. A category that still holds
channels cannot be deleted: the request is refused with `409 category_not_empty`. Move or delete its
channels first.

### Channel locking

A channel or category may require a single role. It is deliberately not a permission system: there is
one requirement per resource and no overwrites.

- A member sees a channel when they hold the role it requires.
- A channel with no role of its own inherits its category's, so locking a category covers everything
  inside it. A channel can tighten that further, but never loosen it: a channel whose category is
  hidden is hidden too.
- Anyone with `Administrator` — which includes the instance owner — bypasses every requirement.
- `GET /api/v1/channels` leaves out locked channels and categories a member cannot see, rather than
  listing them and refusing access.
- Reading, posting, editing, deleting, reacting and typing in a locked channel all fail with
  `403 channel_forbidden`.
- Gateway events are filtered per member too, so `MESSAGE_CREATE`, reactions and typing for a locked
  channel are never sent to someone who cannot see it.

One deliberate gap: an attachment's bytes are served by id to anyone with `ViewChannels`, because
attachment ids are unguessable capability URLs. Someone with access to a locked channel can therefore
hand out a working image link; treat that as sharing the file, not as a leak.

### Slowmode

A channel may set `slowmodeSeconds`, a cooldown each member must wait between messages, from 0 (off)
to 21600 (six hours). It is per member and per channel: posting elsewhere, or by someone else, does
not reset your own timer.

- A member who posts while the cooldown is still running gets `429 slowmode`, naming how many seconds
  remain.
- Members with `ManageChannels` or `ManageMessages` skip it, as do `Administrator` holders, so a
  moderator is never held back by a limit meant for everyone else.
- Messages mirrored in from Discord do not count and are not throttled; slowmode is about what people
  type here.

A deleted message still counts, so deleting your own does not clear the wait.

### Messages

#### `GET /api/v1/channels/:id/messages` — `ViewChannels`

Returns up to 100 messages in ascending order (oldest first).

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer 1–100 | 50 | |
| `before` | ISO 8601 string | — | Return messages older than this timestamp |
| `beforeId` | string | — | Id of the message `before` came from |

```json
{ "messages": [ /* Message */ ] }
```

To page backwards, pass the `createdAt` **and** the `id` of the oldest message you already have as
`before` and `beforeId`. The id matters: `createdAt` only has millisecond precision, so a burst of
messages (a bridge history import, for instance) can share a timestamp, and a timestamp-only cursor
would skip the rest of that millisecond.

#### `POST /api/v1/channels/:id/messages` — `SendMessages`

```json
{ "content": "hello", "attachmentIds": ["..."], "replyToId": null }
```

At least one of `content` or `attachmentIds` is required. `attachmentIds` must reference uploads
you own that are not already attached (see [Attachments](#attachments)). `replyToId` must point at
a visible message in the same channel, else `400 invalid_reply`. Returns the new `Message` and
fires `MESSAGE_CREATE`.

If the channel has a [slowmode](#slowmode) and you posted here too recently, this returns
`429 slowmode` instead.

#### `PATCH /api/v1/messages/:id` — auth (author only)

```json
{ "content": "edited text" }
```

Only the author may edit; anyone else, including administrators, gets `403 forbidden`. Returns the
updated `Message` (with `editedAt` set) and fires `MESSAGE_UPDATE`.

#### `DELETE /api/v1/messages/:id` — auth (author or `ManageMessages`)

Returns `204` and fires `MESSAGE_DELETE`. Deletion is a soft delete: replies to the message keep a
stub, and the bridge mirrors the removal to Discord.

#### Link previews

When `embedsEnabled` is on, the server takes the first link a message contains and, if it can reach
it, resolves it. Only the first link is used. What comes back depends on what the link is:

- **A picture** — anything served as one of the instance's accepted image types — is **downloaded
  and kept as an attachment of that message**, and the message carries no `embed` at all. A link to
  somebody else's file cannot be relied on to still be there: those addresses are often signed and
  expire, and a preview that merely points at one goes dead within a day. A copy of our own keeps
  working, appears in the media gallery, answers to retention, and needs no card around it. Which
  attachment came from a link is recorded in its `sourceUrl`.
- **A page** becomes a small `embed`: its title, description, site name, and preview image
  (`og:image` or `twitter:image`) in `imageUrl`. Where a page offers several preview images, the
  animated one is preferred: Giphy and Klipy both list a still WebP first and the GIF second, so
  taking the first is what makes those links preview as frozen pictures.
- **A gif service's page** — Tenor (`tenor.com/view/…`) and Klipy (`klipy.com/gifs/…`) — is read for
  the picture it names in its own preview metadata, and that picture is then fetched and kept exactly
  like a picture link: an attachment, no card, the page's address in `sourceUrl`. Giphy's pages come
  out the same way, except Giphy names the file through a keyless endpoint, so its page is never
  fetched at all.

Only a picture is ever kept, and only its own bytes: a page's `imageUrl` stays a reference that a
client loads through the proxy below. A picture larger than the instance's `maxImageBytes` is left as
an old-style card instead, since keeping it would mean storing something an upload of the same file
would have been refused.

A link the instance has already fetched is not fetched again. A community posts the same handful of
gifs over and over, so the first message to arrive with a given link downloads it and every later one
is given a record of its own pointing at those same bytes. Two messages, one file on disk, no second
request. A link is assumed to keep pointing at what it pointed at the first time.

Links inside code, masked links (`[text](url)`) and angle-bracket links (`<url>`) are never
unfurled. The fetch is guarded: `http` and `https` only, the host must resolve to a public address,
and redirects are limited and re-checked at each hop. Editing a message drops what it previously
resolved — a preview card and any picture it had fetched — and resolves the new text, so removing a
link takes the picture with it. Resolving is skipped when the link has not changed, so an edit
elsewhere in the text does not download the same file twice. A message the Discord bridge imports
resolves the same way it would if it had been typed here. Turn the whole thing off instance-wide
with `embedsEnabled` in the server settings.

Three providers are recognized from the link itself and asked for a small JSON summary instead of a
page, because their pages are heavy, script-driven or both:

- **YouTube** (`watch?v=`, `youtu.be`, `/shorts/`, `/embed/`) resolves through YouTube's oEmbed
  endpoint and carries an `EmbedPlayer`. A client should show the thumbnail with a play control and
  only build the player iframe when it is pressed, so nothing is requested from YouTube otherwise.
- **X/Twitter** status links (`x.com`, `twitter.com`, including `/i/status/`) resolve through X's
  embed endpoint, which gives the author and handle, the text without its trailing media link, and
  the media image. A tweet with no media carries no image rather than its avatar.
- **Giphy** gif pages (`giphy.com/gifs/…`, `giphy.com/embed/…`) resolve through Giphy's keyless
  oEmbed endpoint, which names the file behind the page. That address is then fetched like any other
  link straight at a picture, so the gif is kept as an attachment and the message carries no card.
  The page itself is no help here: it offers a still WebP and the animated GIF as two previews, and
  a page rewritten to a file is exactly what a chat client should show.

Tenor and Klipy have no endpoint of their own, so their pages are read instead: each names the gif in
its preview metadata and that address is fetched the same way. The only difference between them is
access — Tenor serves its pages to anyone, while Klipy hides them behind a Cloudflare challenge and
surrenders them only to a crawler name it recognizes, which is what `previewUserAgent` is for.

**Discord attachments** are a case of their own. Discord signs every attachment address and it
expires, so a link copied out of the client is usually dead by the time it is pasted here. When the
bridge is connected, the server asks Discord's own attachment refresh endpoint — the one its clients
use — for a live address of the same file, which is then fetched and kept like any other picture.
That endpoint signs any attachment address, even one in a channel or a whole server the bot cannot
read, so a pasted Discord gif works wherever it came from. A link that still carries an unexpired
signature is used as it is without asking.

Everything else is scraped for OpenGraph metadata. Only the head is read: social tags always live
there, and on a heavy page they can be hundreds of kilobytes in.

The fetch asks for an image first and a page only as a fallback (`Accept: image/*, text/html;q=0.9`),
because some hosts serve both for the same address and choose by what the client says it wants.
Asking for HTML first is how a media address that answers with a web page — Giphy's do — ends up as a
card pointing at a perfectly good gif instead of the gif itself. A response that really is HTML is
still read as a page exactly as before.

The unfurler names itself `Harmony/1.0 link-preview`. Sites protected by a managed bot challenge —
Cloudflare, and so Klipy, among others — refuse that name and the preview never appears; the server
logs `link preview refused` when that happens. Setting `previewUserAgent` to a name such sites allow
is the only way to preview them.

#### `GET /api/v1/embeds/media` — `ViewChannels`

Serves a preview image for a card, given the embed's `imageUrl` as a `url` query parameter. A client
should load `imageUrl` through this rather than from the third party: the viewer's address stays
private, and an `http`-only image still shows on an `https` page. A picture a message linked to
directly does not go through here: it was kept as an attachment, and is served from `/attachments`
like any other.

The URL is treated as hostile exactly like the metadata fetch — public hosts only, redirects
re-checked — the response must be an `image/*` type of at most 8 MB, and SVG is refused because it
can carry script. Returns `404 media_unavailable` when the image cannot be fetched, so a client
should tolerate a broken image rather than expect one.

### Search

#### `GET /api/v1/search` — `ViewChannels`

```json
{ "messages": [ /* Message */ ] }
```

Searches message text, newest match first. Only the channels the caller can see are searched, so a
locked channel's contents never appear in a result; the only channel that can be searched explicitly
is one they can already read.

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `q` | string 1–200 | — | Case-insensitive substring, not a word. May be left out when a filter is given |
| `limit` | integer 1–50 | 25 | |
| `channelId` | string | — | Narrow to one channel, else `403 channel_forbidden` |
| `authorId` | string | — | Narrow to one author |
| `before` | ISO 8601 string | — | Return matches older than this timestamp |
| `beforeId` | string | — | Id of the match `before` came from |

At least one of `q`, `channelId` or `authorId` is required; a filter on its own is a valid search,
which is how a client lists everything one member said or everything in one channel. Asking for none
of them returns `400 validation_error`.

`%` and `_` in `q` are literal characters, not wildcards. Deleted messages are never returned, and
an edited message is found by its current text only. Paging works exactly like
[message history](#get-apiv1channelsidmessages--viewchannels): the cursor is the oldest match you
already have, its `createdAt` plus its `id`.

Matches are returned as full `Message` objects, ready to render, so a client can show them the same
way it shows a channel.

### Mentions and replies

Every message that names someone with `@username` or replies to them is noted for that member as it
is written, so their inbox can be listed without ever re-reading message text. A message that both
replies to someone and names them is a single entry, a reply winning.

The inbox is private to its owner, in the same spirit as the [read marker](#get-apiv1channels--viewchannels):
nobody else can see what has been collected, and it is not a record of who summoned whom. Nothing is
collected for a member's own message, and nothing is collected for the stand-in accounts kept for
Discord users, since they can never sign in. An edit does not add or remove an entry — a mention
counts at the moment it is sent, exactly as the notification does.

#### `GET /api/v1/mentions` — `ViewChannels`

```json
{
  "mentions": [
    {
      "message": { /* Message */ },
      "kind": "mention",
      "unread": true
    }
  ]
}
```

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer 1–100 | 50 | |
| `before` | ISO 8601 string | — | Return mentions older than this timestamp |
| `beforeId` | string | — | Id of the message `before` came from |

Returns the caller's own mentions and replies, newest first. `kind` is `"mention"` when they were
named and `"reply"` when the message answered theirs. `unread` is `true` while the channel it landed
in has not been read since, so it follows the channel's read cursor rather than a second one of its
own: reading the channel — including jumping to the message from the inbox — clears it.

Only the channels the caller can see are included, so a mention in a channel that has since been
locked away disappears from the list. Deleted messages are never returned. Paging works like
[message search](#get-apiv1search--viewchannels): the cursor is the oldest entry you already have,
its message's `createdAt` plus its `id`.

### Reactions

An emoji is either a unicode character (send it verbatim, e.g. `"👍"`) or a custom emoji shortcode
`":name:"` paired with its `emojiId`.

#### `POST /api/v1/messages/:id/reactions` — `AddReactions`

```json
{ "emoji": "👍" }
{ "emoji": ":YES:", "emojiId": "6b1f..." }
```

Toggles your own reaction: adds it if absent, removes it if present. Returns the updated `Message`
and fires `MESSAGE_REACTION_ADD` or `MESSAGE_REACTION_REMOVE`.

#### `DELETE /api/v1/messages/:id/reactions` — `ManageMessages`

| Query | Type |
| --- | --- |
| `emoji` | required, the unicode character or `:name:` |
| `emojiId` | the custom emoji id, when applicable |

Clears **everyone's** reactions for that emoji. Returns the updated `Message` and fires
`MESSAGE_REACTIONS_CLEAR`.

### Attachments

Uploads are two steps: upload the bytes, then attach the returned id to a message. Images and
MP4 videos are accepted, each with its own size limit.

#### `POST /api/v1/attachments` — `AttachFiles`

`multipart/form-data` with a single `file` field. An image must be one of the instance's
`allowedImageTypes` and within `maxImageBytes`; a video must be one of `allowedVideoTypes` (only
MP4 for now) and within `maxVideoBytes`. A wrong type is a `415`, an oversized file a `413`. An MP4
is sanity-checked by its header rather than decoded, and stores no dimensions. Returns an
`Attachment` whose `messageId` is `null`.

#### `GET /api/v1/attachments/:id` — `ViewChannels`

Serves the bytes with a long-lived immutable cache header, and answers a single `Range` request
with `206`, which is what lets a video player seek. Uploads that are never attached to a message
are eventually removed by [retention](#retention).

#### `DELETE /api/v1/attachments/:id` — `ManageServer`

Deletes a stored attachment; the message stays, minus the file. Storage is content-addressed, so
the bytes are only removed once no attachment, emoji or avatar still points at them. Returns `204`,
or `404 attachment_not_found`.

### Media gallery

The admin gallery lists every stored image and video in one place.

#### `GET /api/v1/media` — `ManageServer`

A page of stored media, **newest first**.

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer 1–100 | 50 | |
| `before` | ISO 8601 string | — | Older than this timestamp |
| `beforeId` | string | — | The attachment id `before` came from |

The cursor works exactly like message history's: send the oldest item's `createdAt` and `id`
together.

```json
{
  "media": [
    {
      "attachment": { "...": "..." },
      "uploader": { "...": "..." },
      "channelId": "...",
      "channelName": "general"
    }
  ]
}
```

`uploader`, `channelId` and `channelName` are `null` for an upload that was never attached to a
message.

### Gifs and the picker

The picker has three tabs. **Favorites** are private to the member who saved them, and a saved gif is
held by **content hash** rather than by an attachment row, which is what lets it outlive the message
it was found in: it is exempt from the image, video and message retention rules and is only ever aged
out by `favoriteRetentionDays`, counted from the last time it was saved or sent. Nothing is ever
downloaded to save one — the bytes are already stored, and a saved gif shares its blob with every
attachment of the same picture.

**This server** lists what the instance already holds, one entry per picture however many times it
was sent, and only from channels the caller may see.

**Klipy** appears only when the instance has a key for it, and is answered entirely by the server so
that key never reaches a browser. A gif saved or picked from there is downloaded and kept first, so
what is stored is ours from then on rather than a link that can expire; only Klipy's own addresses
are ever fetched, so the picker cannot be turned into a way to make the server fetch arbitrary pages.

The picker is deliberately **gif-only**. A screenshot or a photo is stored and shown like anything
else, but it is not something anybody browses a picker for: it is not listed here, it cannot be
saved, and it cannot be picked. `GIF_CONTENT_TYPES` in the shared package is the one place that
decides what counts.

```ts
type GifFavorite = {
  id: string;
  hash: string;             // content hash of the bytes
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  sourceUrl: string | null; // the link it was fetched from, if any
  createdAt: string;
  usedAt: string;           // what favoriteRetentionDays counts from
};
```

#### `GET /api/v1/gifs/local` — `ViewChannels`

Gifs this instance already holds, **newest first**, for the picker's second tab. One entry per
picture: identical bytes are stored once but sent many times, so only the most recent copy of each is
listed.

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `q` | string, ≤100 | — | Matches the file name or the link it came from |
| `limit` | integer 1–100 | 50 | |

```ts
type GifItem = {
  id: string;               // the attachment serving the bytes
  hash: string;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  sourceUrl: string | null;
  createdAt: string;
  favoriteId: string | null; // the caller's saved copy, if they have one
};
```

Returns `{ "gifs": [GifItem] }`. Only channels the caller may see are searched, so a gif in a
[locked channel](#channel-locking) never turns up in somebody else's picker. Load a gif from
`/api/v1/attachments/{id}`.

#### `GET /api/v1/gifs/klipy` — `ViewChannels`

The hosted service's gifs, answered through this server so the key stays here. With no `q` it is the
service's trending list, which is what the tab shows when it opens.

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `q` | string, ≤100 | — | The search term; absent means trending |
| `limit` | integer 1–50 | 30 | |

`url` is the gif that gets kept when the result is saved or picked; `previewUrl` is a smaller one for
the tile, which a client loads through `GET /api/v1/embeds/media` rather than from the service — both
because this instance's own policy only lets a page load its own images, and because going through
here keeps a browsing member's address away from the service. Nothing is stored until it is saved or
picked. Returns `{ "gifs": [{ url, previewUrl, width, height, title }] }`, an empty list when no key
is configured, and `502 gif_service_unavailable` when the service itself cannot be reached.

#### `GET /api/v1/gifs/favorites` — `ViewChannels`

This member's saved gifs, most recently used first. Returns `{ "favorites": [GifFavorite] }`.

#### `POST /api/v1/gifs/favorites` — `ViewChannels`

Body `{ "attachmentId": string }` for a gif this instance already holds, or `{ "url": string }` for a
hosted one, which is fetched and kept on the way in. Returns the `GifFavorite`. Saving the same gif
twice only moves `usedAt` forward. A member may only save a gif they can see: anything from a channel
they cannot view, or an unattached upload of somebody else's, answers `404 gif_not_found` rather than
admitting it exists, anything that is not a gif answers `400 not_a_gif`, and an address outside the
configured service answers `400 invalid_gif_url`.

#### `DELETE /api/v1/gifs/favorites/:id` — `ViewChannels`

Forgets one of the caller's own saved gifs. `204` on success; `404` for anybody else's.

#### `GET /api/v1/gifs/favorites/:id/image` — `ViewChannels`

Serves the saved gif's bytes. Only the owner may fetch it, and it is cached immutably by hash, like
`/attachments/:id`.

#### `POST /api/v1/gifs/pick` — `AttachFiles`

Takes a gif out of the picker and into the message being written. Body is one of
`{ "favoriteId": string }`, `{ "attachmentId": string }` or `{ "url": string }` for a hosted gif; the
answer is an `Attachment` that is **not yet attached to anything**. Send it with the message as usual
— `POST /api/v1/channels/:id/messages` with `attachmentIds: [thatId]` — exactly as an upload would
be.

A gif this instance already holds costs nothing to pick: the attachment is a new row pointing at
bytes that are already there, a few hundred bytes and no bandwidth. A hosted one is fetched and kept
first. Picking a **saved** gif also counts as using it, moving its `usedAt` forward.

### Custom emoji

#### `GET /api/v1/emojis` — `ViewChannels`

```json
{ "emojis": [ /* Emoji */ ] }
```

#### `POST /api/v1/emojis` — `ManageEmojis`

`multipart/form-data` with a `name` field and a `file` field. Names use 2–32 characters from
`A-Z a-z 0-9 _` and are unique (`409 emoji_exists`). Returns the new `Emoji` and fires
`EMOJI_CREATE`. In messages, write a custom emoji as `:name:`.

#### `GET /api/v1/emojis/:id` — `ViewChannels`

Serves the emoji image with an immutable cache header.

#### `DELETE /api/v1/emojis/:id` — `ManageEmojis`

Returns `204` and fires `EMOJI_DELETE` with `{ "id": "..." }`.

#### `GET /api/v1/emojis/discord` — `ManageEmojis`

Lists the custom emoji in the Discord server the bridge is connected to, so an admin can see what
an import would bring. Returns a `DiscordEmojiListResponse`; `guildName` is `null` when the bridge
is not running.

```json
{
  "guildName": "My Discord Server",
  "emojis": [{ "id": "700", "name": "YES", "animated": false, "imported": true }]
}
```

#### `POST /api/v1/emojis/import` — `ManageEmojis`

Downloads every guild emoji Harmony does not already have and stores it, returning an
`EmojiImportResponse`. Names are the join key, so an emoji that already exists is skipped and the
import is safe to run again.

Send `{ "emojiIds": ["..."] }` to import only those emoji, which is what the admin panel's picker
does; leave it out to import every one missing. Each newly created emoji fires `EMOJI_CREATE`.
Returns `503 bridge_offline` when the bridge is not connected.

### Stickers

Harmony has no stickers of its own. A sticker only ever arrives from Discord: when a bridged message
carries one, or someone pastes a Discord sticker link, the bridge learns it by its Discord sticker id
and attaches it to the message, and every later message that sends it shares the same sticker. They
are aged out by `stickerRetentionDays`. A format that cannot be drawn as a picture — a Lottie vector —
is kept as its name in the message's text instead, so nothing is dropped.

#### `GET /api/v1/stickers/:id` — `ViewChannels`

Serves the sticker image with an immutable cache header. `404 sticker_not_found` when there is no
such sticker, `404 sticker_missing` when its image is gone from storage.

### Users and avatars

#### `PATCH /api/v1/users/@me` — auth

```json
{
  "displayName": "Alice the Great",
  "showTyping": true,
  "notifyMajor": true,
  "notifyMinor": false
}
```

Every field is optional, but at least one is required. `displayName` may be up to 32 characters; `null`
or `""` clears it. `showTyping` turns typing indicators off entirely for the user: they neither send
nor see them. `notifyMajor` and `notifyMinor` cover the client's two notification sounds, both on by
default: the first for a message that mentions the user, by reply or by name, and the second for
other messages in the channel being read.

These are **in-app sounds only**. Harmony sends nothing to a device: there is no push, no service
worker involvement and no permission prompt, and a sound can only play while a client of some kind is
open and connected. A client decides for itself what to play, which is why the server stores two
booleans rather than performing any delivery. Returns `MeResponse`.

#### `PATCH /api/v1/users/@me/password` — auth

```json
{ "currentPassword": "old-secret", "newPassword": "new-secret" }
```

Changes your own password. `currentPassword` must match, else `403 wrong_password`; it is omitted
(and ignored) only for an account with no password yet, which this call gives its first. `newPassword` is
subject to the registration policy (at least 8 characters). Every **other** session is ended and its
gateway connection closed (close code `4004`), so an old token stops working at once, while the
device making the change stays signed in. Returns `{ "ok": true }`.

#### `PUT /api/v1/users/@me/avatar` — auth

`multipart/form-data` with a single `file` field (an image). The picture is normalized server-side
to a 256×256 WebP. Returns `MeResponse`.

#### `DELETE /api/v1/users/@me/avatar` — auth

Clears your picture and returns `MeResponse`.

#### `GET /api/v1/users/:id/avatar`

Serves a user's picture as WebP. Normally requires `ViewChannels`, but you may pass a capability
query parameter to fetch it without a session:

```
GET /api/v1/users/<id>/avatar?v=<avatarHash>
```

If `v` matches the user's current `avatarHash` the request is allowed anonymously, otherwise the
normal `ViewChannels` check applies. This exists so Discord's servers can fetch avatars for
mirrored messages; the hash is already public in every avatar URL. Returns `404 avatar_not_found`
when the user has no picture.

### Roles

#### `GET /api/v1/roles` — `ViewChannels`

```json
{ "roles": [ /* Role */ ] }
```

#### `POST /api/v1/roles` — `ManageRoles`

```json
{ "name": "Moderator", "color": 5793266, "permissions": "3", "hoist": false, "mentionable": true }
```

`color` is a packed RGB integer or `null`. `permissions` is a decimal bitfield string. Returns the
new `Role` and fires `ROLE_CREATE`. Granting a permission you lack is rejected with
`403 permission_escalation`.

#### `PATCH /api/v1/roles/:id` — `ManageRoles`

Any of `name`, `color`, `permissions`, `hoist`, `mentionable`, `badge`. The `@everyone` role cannot be
renamed (`403 immutable_role`). Returns the `Role` and fires `ROLE_UPDATE`.

**Member badges.** A `User`'s `badge` is derived, not stored, and only one ever shows, in the order
owner > admin > moderator:

- `owner` — the account registered first (`isOwner`).
- `admin` — the user holds the `Administrator` permission through any role.
- `moderator` — any of the user's roles carries `badge: "moderator"`.

So only the moderator badge is a role's to give; owner and admin follow from the account and the
permissions. Set one with `badge: "moderator"` (or `"none"`) on a role; it is drawn beside the
member's name in messages, the member list and the profile card.

#### `POST /api/v1/roles/:id/move` — `ManageRoles`

```json
{ "direction": "up" }
```

`direction` is `"up"` or `"down"`. Role positions affect only display, including which role's
color is shown for a user (the highest-positioned colored role wins). The `@everyone` role cannot
be reordered. Returns the full `{ "roles": [...] }` list.

#### `DELETE /api/v1/roles/:id` — `ManageRoles`

Returns `204`, fires `ROLE_DELETE` with `{ "id": "..." }`. The `@everyone` role cannot be deleted.

### Members

#### `GET /api/v1/members` — `ManageRoles`

```json
{
  "members": [
    { "user": { "...": "..." }, "roleIds": ["..."], "permissions": "2081" }
  ]
}
```

#### `GET /api/v1/members/directory` — `ViewChannels`

```json
{ "users": [ /* User */ ] }
```

Every member's public profile, with no roles or permissions. This is what clients
use to resolve and autocomplete `@username` mentions (see
[Mentions](#mentions)), so unlike the management view above it is readable by
anyone with `ViewChannels`.

#### `GET /api/v1/members/roster` — `ViewChannels`

```json
{
  "members": [
    { "user": { "...": "..." }, "roleIds": ["..."], "online": true }
  ]
}
```

The member list sidebar. Like the directory it is readable by anyone with
`ViewChannels`, but it adds each member's role ids and a live `online` flag, and
leaves out permissions. Group members by their highest hoisted role to match how
the server orders them; a `Role.hoist` of `true` gives a role its own section,
ordered by `Role.position` from highest to lowest.

Presence is not stored: a member is online while they hold at least one live
gateway connection. Clients keep it current with `PRESENCE_UPDATE` rather than
refetching this endpoint.

A Discord stand-in account never holds a gateway connection, so its `online` comes
from the bridge instead, which borrows it from the linked guild's presences. It is
`false` whenever the bridge is down, and only accounts the bridge has announced are
counted, so an id Discord reports for somebody with no stand-in here changes
nothing.

#### `PUT /api/v1/members/:userId/roles/:roleId` — `ManageRoles`

Assigns a role. Returns `204` and fires `MEMBER_UPDATE` with `{ "userId": "..." }`. The `@everyone`
role is implicit and cannot be assigned (`400 default_role`). A role holding a permission you lack is
`403 permission_escalation` unless you are an administrator.

#### `DELETE /api/v1/members/:userId/roles/:roleId` — `ManageRoles`

Removes a role. Returns `204` and fires `MEMBER_UPDATE`. Removing roles from an administrator or the
owner needs `Administrator` yourself (`403 target_is_admin`).

### Editing accounts

A member holding `ManageMembers` can edit an ordinary account: its username, display name, picture,
password and Discord link. This is the instance's only password-recovery path — there is no email and no reset
token, so a member who has forgotten their password asks an administrator to set a new one. A
password can be **written but never read**: no endpoint returns one, and only the hash is stored.

An administrator or the owner can only be edited by an administrator (`403 target_is_admin`
otherwise); without that, `ManageMembers` would quietly amount to "can become the owner". So an owner
who forgets their password is recovered by another administrator, by Discord sign-in if their account
is linked, or by editing the database — keep a second administrator if that matters to you. Every
change is written to the [audit log](#audit-log). The other exception is a Discord stand-in account, which the bridge
creates and keeps in step: editing one returns `400 externally_managed`. Their roles are still
managed like anyone else's.

#### `PATCH /api/v1/members/:userId` — `ManageMembers`

```json
{ "username": "new-name", "displayName": "New Name", "password": "a-new-secret", "discordId": "1398164034464776202" }
```

Any subset of the fields. `username` must be free (`409 username_taken` unless it is already
this member's). `displayName` may be `null` or `""` to clear it. Setting `password` ends every session
and connection the member has, so they sign back in with the new one. Returns
`{ "user": { /* User */ } }` and fires `MEMBER_UPDATE`; the fields that changed are recorded as a
`member_update` entry, and a password as a `password_reset` entry.

`discordId` links the member to a Discord account, which is how a member and the Discord stand-in
built for them become one identity — see [Linking a Discord account](#linking-a-discord-account).
An empty string or `null` clears the link, and a malformed id (it is 17–20 digits) is
`400 validation_error`. This field is administrator-only for now, so it is deliberately absent from
[`PATCH /api/v1/users/@me`](#patch-apiv1usersme--auth): a member cannot set their own, and the
server strips the field if one is sent.

#### `PUT /api/v1/members/:userId/avatar` — `ManageMembers`

`multipart/form-data` with a single `file` field. Normalized server-side to a 256×256 WebP. Returns
`{ "user": { /* User */ } }`, fires `MEMBER_UPDATE`, and logs a `member_update`.

#### `DELETE /api/v1/members/:userId/avatar` — `ManageMembers`

Clears the member's picture and returns `{ "user": { /* User */ } }`, firing `MEMBER_UPDATE`.

#### `DELETE /api/v1/members/:userId` — `ManageMembers`

Deletes an ordinary member's account. Returns `204` and fires `MEMBER_UPDATE`. Their messages are
kept, but lose their author: the client shows them as *Deleted user*. This is for clearing out
throwaway or test accounts, so it is deliberately narrow — the owner and every administrator are
protected even from each other (`403 target_is_owner` / `403 target_is_admin`), you cannot delete
yourself (`400 cannot_delete_self`), and a Discord stand-in cannot be deleted (`400 cannot_delete_bot`,
since the bridge owns it). The deletion is recorded as a `member_delete` entry.

### Linking a Discord account

A member can be linked to a Discord account, so the person on Discord and the member here are one
identity rather than two. An administrator sets it with `discordId` on
`PATCH /api/v1/members/:userId`, and when [Discord sign-in](#discord-sign-in) is switched on a
member can also connect their own account from their profile — verified by Discord, so it cannot be
claimed by someone who does not own it.

Linking changes what the bridge does for that person:

- Their `@username` in Harmony mirrors to Discord as a real `<@id>` ping. This already happened for
  any account carrying a `discordId`, so the mention half needs no new bridge code.
- New messages and mentions from them on Discord are attributed to the member's own account instead
  of a fresh stand-in, and their Discord presence feeds the member's `online` flag.

When a stand-in account already exists for that Discord id — the common case, since one is created
the first time somebody speaks or is mentioned in a bridged channel — it is **retired into the
member**: everything it authored or carried (messages, pictures, reactions, saved gifs, roles, read
markers, mentions, bans) is reassigned, the rows that would collide with the member's own are
dropped, and the stand-in is deleted. The whole thing is one transaction, so the two are never left
half-merged. The member now shows that Discord history as their own, under their current name and
picture, and is a single entry in every list.

An id another member already holds is refused with `409 discord_id_taken`. Clearing the link
(`discordId: null`, or `DELETE /api/v1/users/@me/discord` for your own) stops future attribution but
does not undo a merge: the history stays with the member. A stand-in account is never the target of
a link, since its profile is the bridge's to manage (`400 externally_managed`).

### Moderation

Timeouts, kicks and bans share one rule set, deliberately without a role hierarchy: **nobody may
moderate themselves, a Discord stand-in account, or anyone holding `Administrator`** (which
includes the instance owner). Those targets return `400 cannot_moderate_self`,
`400 cannot_moderate_bot` and `403 target_is_admin`. The permission check runs first, so a member
without the flag simply gets `403 forbidden`.

#### `PUT /api/v1/members/:userId/timeout` — `ModerateMembers`

```json
{ "durationMinutes": 10 }
```

Puts the member in a timeout of 1 minute up to 28 days. A timed out member keeps read access but
cannot post messages, edit them, react or upload attachments — each of those returns
`403 timed_out`. Returns `204` and fires `MEMBER_UPDATE`.

#### `DELETE /api/v1/members/:userId/timeout` — `ModerateMembers`

Lifts the timeout. Returns `204` and fires `MEMBER_UPDATE`.

#### `POST /api/v1/members/:userId/kick` — `KickMembers`

Ends every session the member has and closes their gateway connections (close code `4005`). They
may sign in again. Returns `204` and fires `MEMBER_UPDATE`.

#### `PUT /api/v1/members/:userId/ban` — `BanMembers`

```json
{ "reason": "spamming" }
```

`reason` is optional (up to 300 characters). Bans the member: their sessions end, their connections
close, and every future login fails with `403 account_banned`. They disappear from the member list
and the directory. Returns `204` and fires `MEMBER_UPDATE`.

#### `DELETE /api/v1/members/:userId/ban` — `BanMembers`

Lifts the ban (`404 not_banned` when there was none). Returns `204` and fires `MEMBER_UPDATE`.

#### `GET /api/v1/bans` — `BanMembers`

```json
{ "bans": [ /* Ban */ ] }
```

### Audit log

The audit log records what was done, by whom and to whom. An entry is logged whenever: a message is
**deleted**, capturing the text and any images it carried; a message is **edited**, with the text
either side of it; an image is **deleted from the media gallery**, naming the file; a member is
**timed out** or the timeout is lifted; a member is **kicked**; a member is **banned** or unbanned;
a member's **roles change**; a member's **account is edited**, naming the fields that changed; and a
member's **password is reset**.

Entries are append-only and are never edited. Names and the channel are captured when the action
happens, so an entry stays readable once a role is renamed, a channel is deleted or an account is
removed. Message text is kept here even though the channel no longer shows it, which is the point of
the feature and also why reading the log is restricted.

Bridged traffic is not logged: a Discord-side edit or deletion arrives through the bridge rather than
from a member, so it leaves the log to the Discord audit trail.

#### `GET /api/v1/audit` — `ManageServer`

```json
{ "entries": [ /* AuditEntry */ ] }
```

Newest first, and read with `ManageServer` rather than any moderation flag, because deleted message
text can be read back from here.

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer 1–100 | 50 | |
| `before` | ISO 8601 string | — | Return entries older than this timestamp |
| `beforeId` | string | — | Id of the entry `before` came from, to break ties |

#### `DELETE /api/v1/audit` — `ManageServer`

Returns `204` and empties the log. The clear itself is deliberately not recorded, so afterwards the
log really is empty. [Audit retention](#retention) ages entries out automatically instead, when it is
configured.

### Invites

#### `GET /api/v1/invites` — `ManageServer`

```json
{ "invites": [ /* Invite */ ] }
```

#### `POST /api/v1/invites` — `CreateInvites`

```json
{ "maxUses": 10, "expiresInHours": 24 }
```

Both fields are optional and independent; omit or pass `null` for unlimited / never-expiring.
Returns the new `Invite`. Note `CreateInvites` is granted to `@everyone` by default, so any member
can mint codes unless an administrator changes that role.

#### `DELETE /api/v1/invites/:code` — `ManageServer`

Returns `204`.

### Server settings

#### `GET /api/v1/settings` — `ManageServer`

```json
{
  "serverName": "My Community",
  "requireInvite": true,
  "defaultChannelId": null,
  "embedsEnabled": true,
  "theme": { "background": "#1e1b2e", "accent": "#eb459e" },
  "maxImageBytes": 10485760,
  "maxVideoBytes": 20971520,
  "previewUserAgent": null,
  "setupCompleted": false
}
```

#### `PATCH /api/v1/settings` — `ManageServer`

`{ "serverName"?: string, "requireInvite"?: boolean, "defaultChannelId"?: string | null,
"embedsEnabled"?: boolean, "maxImageBytes"?: number, "maxVideoBytes"?: number,
"previewUserAgent"?: string | null, "klipyApiKey"?: string | null,
"theme"?: { "background"?: string | null, "accent"?: string | null },
"icon"?: { "padding"?: number | null, "background"?: string | null } }`.
Returns the updated settings. `serverName` and `theme` changing also update `GET /api/v1/meta`.
`defaultChannelId` must reference an existing channel, or `400 invalid_default_channel`; `null`
clears the preference. `embedsEnabled` turns link previews on or off for the whole instance. The two
upload limits are in bytes and may not exceed the server's hard ceiling of 100 MB. `previewUserAgent`
sets the client name used when unfurling a link; an empty string or `null` means Harmony's own.
`klipyApiKey` is the hosted gif service's key; an empty string or `null` clears it and takes the
picker's hosted tab away. The key is **write-only** — it goes in through here and is never sent back
out, the response carrying only `klipyConfigured` — and it is used server-side, never in a browser.
`setupCompleted` records that the owner has been through the first-run setup; setting it `false`
again makes the wizard greet them once more.

`icon.padding` is a percentage of an installed app icon's tile to leave clear around the artwork,
from 0 to 45. `null` works it out from the image: none for a picture with no transparent pixels,
10% for a logo drawn on transparency. `icon.background` is a `#rrggbb` color, or `null` to take it
from the artwork itself. Both only affect the renders described under
[the icon endpoint](#get-apiv1iconssize--no-auth), and both change the URLs in the manifest, so a
changed setting is never served from the long cache.

### Instance icon

The icon shown in a client's browser tab and beside the server name. It is the web client's
built-in default unless an admin uploads one; an upload is cropped to a square and stored as PNG.

#### `GET /api/v1/icon` — no auth

Serves the uploaded icon as `image/png`, with a long cache header because the URL carries the
content hash. Returns `404 icon_not_set` (with error code `icon_not_set`) when the default is in
use, in which case a client should show its own bundled default. Ask for the icon with the current
`iconHash` as `?v=`, so a replaced icon is fetched rather than served from the cache.

#### `PUT /api/v1/icon` — `ManageServer`

`multipart/form-data` with a `file` field. Returns `{ "iconHash": "..." }`; a type outside
`allowedImageTypes` is refused with `415`. `GET /api/v1/meta` then reports the new `iconHash`.

#### `DELETE /api/v1/icon` — `ManageServer`

Returns `{ "iconHash": null }` and puts the built-in default back in use.

#### `GET /api/v1/icons/:size` — no auth

Serves the instance icon — the admin's upload, or the built-in default — resized to a square PNG of
`size`, from 16 to 1024. Add `?maskable=1` for the variant Android crops to its own launcher shape.
Used by the [app manifest](#app-manifest); a caller should append the current `iconHash` as `?v=` so
the long cache is safe. `400 invalid_size` outside the range, `404 icon_unavailable` when no icon
source exists at all.

What `maskable=1` does depends on the artwork. A picture with no transparent pixels is returned edge
to edge, because that is how it was drawn and padding it would shrink it and ring it with a border.
A logo drawn on transparency is the case padding exists for: it is drawn at 80% on a tile, so the
cropping that is coming takes the tile instead of the artwork. That tile is the average of the
drawing's opaque pixels, not the app background, which is usually dark enough to read as a frame.
Sharp's own dominant color cannot be used for it, since a logo drawn on transparency mostly consists
of that transparency, which averages out near black.

Both variants come back opaque. A transparent icon is otherwise left to the platform to back, and
iOS fills those with black: the same frame, arrived at from the other direction.

### App manifest

#### `GET /manifest.webmanifest` — no auth

A web app manifest, built from the instance's settings so an installed app carries the server's own
name, icon and colors. `display` is `standalone`, which is what lets it open on a phone home screen
without browser chrome. It lists the icon sizes a launcher needs (`192x192` and `512x512`, from
[the icon endpoint](#get-apiv1iconssize--no-auth)) plus a maskable one. Serving it over HTTPS is what
makes it installable; see [Deploying Harmony](DEPLOYMENT.md).

### Theming

An instance is themed with just two colors, both `#rrggbb` or `null` for the built-in default:

```ts
type ThemeSettings = { background: string | null; accent: string | null };
```

Everything else the client renders with is derived from those two, so an admin never has to reason
about contrast. In short: the panel surfaces step away from the background, the text is mixed
towards the opposite end so it stays readable on both dark and light backgrounds, the translucent
hover and active overlays flip from white to black with the theme, and the color placed on top of
accent surfaces switches between black and white depending on how bright the accent is.

The tokens a client should set are `--h-bg`, `--h-bg-elevated`, `--h-bg-deep`, `--h-text`,
`--h-text-muted`, `--h-accent`, `--h-on-accent`, `--h-hover` and `--h-active`, each from the matching
field of `deriveTheme`, plus `color-scheme` from its `scheme`. The server itself computes none of
this: it stores the two colors and hands them to clients, which may use the exported `deriveTheme`
from this package or simply read the tokens a Harmony client already publishes.

### Retention

Retention automatically prunes old content and can cap total storage. Any rule set to `null` is
switched off. Image, video, message and audit-log age limits are independent: each is deleted once
it is older than its own limit, and the log can be cleared outright with `DELETE /api/v1/audit`.

[Saved gifs](#gifs-and-the-picker) are deliberately outside all of those. `favoriteRetentionDays` is
the only rule that ages one out, counted from the last time it was saved or sent.

Emoji learned from Discord (marked `external` on the [`Emoji`](#object-shapes) shape) are the same
kind of case: they are aged out only by `externalEmojiRetentionDays`, counted from the last bridged
message or reaction that carried one. The instance's own emoji are never touched by any rule.

[Stickers](#stickers) learned from Discord are aged out by `stickerRetentionDays` the same way,
counted from the last bridged message that carried one.

`storageLimitBytes` caps everything stored on disk, which includes saved gifs, emoji, stickers,
avatars and the instance icon. Once it is exceeded, the pruner removes the oldest attachments until
usage is back under `storageTargetBytes` (or the limit, if no target is set). Attachments are the
only thing it removes for space: it never deletes messages, and it stops as soon as a round of
removals frees nothing, so a cap that the exempt content alone exceeds is left over rather than
chased by deleting more.

```ts
type RetentionSettings = {
  imageRetentionDays: number | null;
  videoRetentionDays: number | null;
  messageRetentionDays: number | null;
  auditRetentionDays: number | null;
  favoriteRetentionDays: number | null;
  externalEmojiRetentionDays: number | null;
  stickerRetentionDays: number | null;
  storageLimitBytes: number | null;
  storageTargetBytes: number | null;
};

type RetentionUsage = { blobBytes: number; attachmentCount: number; messageCount: number };

type PruneSummary = {
  ranAt: string;
  deletedAttachments: number;
  deletedMessages: number;
  deletedAuditEntries: number;
  deletedFavorites: number;
  deletedExternalEmojis: number;
  deletedStickers: number;
  deletedBlobs: number;
  freedBytes: number;
};
```

#### `GET /api/v1/retention` — `ManageServer`

Returns `{ settings, usage, lastRun }`, where `lastRun` is a `PruneSummary` or `null`.

#### `PATCH /api/v1/retention` — `ManageServer`

Any subset of `imageRetentionDays`, `videoRetentionDays`, `messageRetentionDays`,
`auditRetentionDays`, `favoriteRetentionDays`, `externalEmojiRetentionDays`,
`stickerRetentionDays`, `storageLimitBytes`, `storageTargetBytes`; `null` disables a rule. Returns
the same shape as `GET`.

#### `POST /api/v1/retention/run` — `ManageServer`

Runs the pruner immediately and returns `{ summary, usage }`. Fires `RETENTION_APPLIED`.

### Discord bridge

#### `GET /api/v1/bridge` — `ManageServer`

```ts
type BridgeResponse = {
  configured: boolean;      // whether a bot token is saved
  enabled: boolean;
  publicBaseUrl: string | null;
  status: { ready: boolean; botTag: string | null; guildName: string | null; error: string | null };
};
```

The token itself is never returned.

#### `PATCH /api/v1/bridge` — `ManageServer`

```json
{ "token": "MTIz...", "enabled": true, "publicBaseUrl": "https://chat.example.com" }
```

The token and public base URL are optional; an empty-string token clears the saved one, and an
empty public base URL disables outbound avatars. `publicBaseUrl` must be an `http(s)` address (else
`400`). Returns `BridgeResponse`.

#### `GET /api/v1/bridge/channels` — `ManageServer`

```json
{
  "guildName": "My Discord",
  "categories": [ { "id": "cat1", "name": "General" } ],
  "channels": [ { "id": "123", "name": "general", "categoryId": "cat1" } ]
}
```

Discord text channels the bot can see, for linking to a Harmony channel, plus the categories they
sit in. See also [the channel import](#channels-and-categories), which recreates them in Harmony in
one step.

#### `POST /api/v1/bridge/test` — `ManageServer`

```json
{ "channelId": "<harmony channel id>" }
```

Sends a test message to the linked Discord channel so an administrator can verify the setup.
Returns `{ "ok": true }`, or `502 bridge_test_failed` with Discord's own error message.

#### `POST /api/v1/bridge/import` — `ManageServer`

```json
{ "channelId": "<harmony channel id>", "limit": 50 }
```

Pulls the most recent Discord messages into a bridged channel, oldest first, keeping their original
timestamps, authors, attachments, replies and mentions. Linking a channel already triggers this,
and the bridge backfills every bridged channel when it connects, so this endpoint is for pulling
history again on demand. `limit` defaults to 50 (1–100). Messages already imported are recognized
by their Discord id and skipped, so it is safe to call repeatedly. Returns
`{ "imported": 2 }` with how many new messages landed.

Note that imported messages carry their original (possibly old) timestamps, so a retention rule that
deletes old messages will apply to them.

## The gateway (WebSocket)

Connect to `ws(s)://<host>/gateway`. The gateway pushes realtime events; writes still go through
REST.

The protocol mirrors Discord's framing: every message is a JSON object `{ op, t?, d? }`.

### Handshake

1. The server immediately sends **HELLO** (`op: 10`):
   ```json
   { "op": 10, "d": { "heartbeat_interval": 45000, "gateway_version": 1 } }
   ```
2. The client sends **IDENTIFY** (`op: 2`). External clients pass their session token:
   ```json
   { "op": 2, "d": { "token": "harmony_session_token" } }
   ```
   Browser clients on the same origin may send `{ "op": 2, "d": {} }` and rely on the session
   cookie sent with the WebSocket handshake.
3. On success the server sends **READY** (`op: 0`, `t: "READY"`):
   ```json
   { "op": 0, "t": "READY", "d": { "user": { "...": "..." }, "gateway_version": 1 } }
   ```
   On failure it closes the socket with code **4004**.

### Heartbeat

Send `{ "op": 1, "d": null }` every `heartbeat_interval` milliseconds; the server replies with
`{ "op": 11, "d": null }`. Heartbeats are optional but recommended to detect dead connections.

### Dispatch events

Dispatched frames use `op: 0` with a `t` name and `d` payload:

| Event | Payload |
| --- | --- |
| `READY` | `{ user, gateway_version }` |
| `MESSAGE_CREATE` | `Message` |
| `MESSAGE_UPDATE` | `Message` (edits, link previews, and bridged edits) |
| `MESSAGE_DELETE` | `{ id, channelId }` |
| `MESSAGE_REACTION_ADD` | `ReactionUpdatePayload` |
| `MESSAGE_REACTION_REMOVE` | `ReactionUpdatePayload` |
| `MESSAGE_REACTIONS_CLEAR` | `ReactionsClearPayload` |
| `TYPING_START` | `TypingStartPayload` |
| `PRESENCE_UPDATE` | `PresenceUpdatePayload` |
| `CHANNEL_CREATE` / `CHANNEL_UPDATE` | `Channel` |
| `CHANNEL_DELETE` | `{ id }` |
| `CATEGORY_CREATE` / `CATEGORY_UPDATE` | `Category` |
| `CATEGORY_DELETE` | `{ id }` |
| `ROLE_CREATE` | `Role` |
| `ROLE_UPDATE` | `Role`, or `{ id }` after a reorder |
| `ROLE_DELETE` | `{ id }` |
| `MEMBER_UPDATE` | `{ userId }` |
| `EMOJI_CREATE` | `Emoji` |
| `EMOJI_DELETE` | `{ id }` |
| `RETENTION_APPLIED` | `PruneSummary` |

`MEMBER_UPDATE` also fires for timeouts, kicks and bans, so a client should refetch the roster (and
its own profile) whenever it sees one.

`ReactionUpdatePayload` carries the reacting user so each client can decide whether the `me` flag
applies to itself; the server broadcasts one payload to everyone:

```ts
type ReactionUpdatePayload = {
  messageId: string;
  channelId: string;
  emoji: string;
  emojiId: string | null;
  userId: string;   // who reacted or un-reacted
  count: number;    // total for this emoji after the change
};

type ReactionsClearPayload = {
  messageId: string;
  channelId: string;
  emoji: string;
  emojiId: string | null;
};
```

`TYPING_START` is sent when someone announces they are typing, via `POST /channels/:id/typing`. It
is not a promise the message will be sent, and a client should expire a notice after roughly eight
seconds without a refresh:

```ts
type TypingStartPayload = {
  channelId: string;
  user: User;
};
```

The server broadcasts one payload to everyone; a client hides its own typing and the whole feature
when `user.showTyping` is false.

`PRESENCE_UPDATE` is sent when a member's first gateway connection identifies and when their last one
closes. It is derived from live connections and never stored, so a restart begins with everyone
offline:

```ts
type PresenceUpdatePayload = {
  user: User;
  online: boolean;
};
```

Stand-in accounts are the exception, since they never connect here. While the bridge is running, the
same event carries their presence, borrowed from the linked guild: it fires when a Discord account
the bridge has a stand-in for changes status, and when the bridge stops, which reports every stand-in
as offline. A client can treat it exactly like any other presence update.

### Close codes

| Code | Meaning |
| --- | --- |
| `4004` | The session was rejected. Re-authenticate instead of retrying. |
| `4005` | The session was ended by moderation (a kick or ban). |

### Reconnecting

The gateway has no sequence numbers and no resume support. On reconnect, re-identify and refetch
the state you care about (`GET /api/v1/channels`, the open channel's history). Do not reconnect
after a `4004` or `4005` close: re-authenticate first.

Events are broadcast to every authenticated client. There is no per-channel filtering, which is
fine because Harmony's permissions are server-wide rather than per-channel.

## Worked example

Register, post a message, and stream events:

```bash
# 1. Create a session (the first account on a fresh instance becomes the owner).
TOKEN=$(curl -s -X POST https://chat.example.com/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"hunter2hunter2"}' | jq -r .token)

# 2. Find a channel to post in.
CHANNEL=$(curl -s https://chat.example.com/api/v1/channels \
  -H "Authorization: Bearer $TOKEN" | jq -r '.channels[0].id')

# 3. Post a message.
curl -s -X POST "https://chat.example.com/api/v1/channels/$CHANNEL/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello from the API"}'
```

```js
// A minimal bot that logs every new message.
const token = process.env.HARMONY_TOKEN;
const ws = new WebSocket('wss://chat.example.com/gateway');

ws.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  if (frame.op === 10) {
    ws.send(JSON.stringify({ op: 2, d: { token } }));
    return;
  }
  if (frame.op === 0 && frame.t === 'MESSAGE_CREATE') {
    console.log(`${frame.d.author?.username}: ${frame.d.content}`);
  }
};
```

## Limitations

- **No CORS.** The server sends no `Access-Control-Allow-Origin` header, so a browser client must
  be served from the same origin as the API. Bots and native clients are unaffected. Configurable
  CORS could be added later.
- **One server per instance.** There are no guilds, DMs, friend lists, voice or video.
- **Text channels only.** `Channel.type` is always `"text"`.
- **No resume on the gateway.** Reconnect and refetch.
- **Reserved permissions.** `EmbedLinks` and `MentionEveryone` are defined in the bitfield but not
  enforced by any endpoint yet.
- **Bridged content is best-effort.** Discord's webhooks cannot post real replies or reactions, so
  replies are mirrored as quotes and reactions are placed by the bot. See
  [The Discord bridge](TECHNICAL.md#the-discord-bridge) for the full picture.
