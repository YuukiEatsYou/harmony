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
  - [Polls](#polls)
  - [Search](#search)
  - [Mentions and replies](#mentions-and-replies)
  - [Pinned messages](#pinned-messages)
  - [Saved messages](#saved-messages)
  - [Scheduled messages](#scheduled-messages)
  - [Events](#events)
  - [Reactions](#reactions)
  - [Attachments](#attachments)
  - [Media gallery](#media-gallery)
  - [Gifs and the picker](#gifs-and-the-picker)
  - [Custom emoji](#custom-emoji)
  - [Stickers](#stickers)
  - [Users and avatars](#users-and-avatars)
  - [Channel notification settings](#channel-notification-settings)
  - [Roles](#roles)
  - [Members](#members)
  - [Audit log](#audit-log)
  - [Backup and export](#backup-and-export)
  - [Server log](#server-log)
  - [Update](#update)
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
| 400 | `validation_error`, `bad_request`, `invalid_reply`, `invalid_emoji`, `invalid_attachment`, `invalid_upload`, `default_role`, `cannot_moderate_self`, `cannot_moderate_bot` |
| 401 | `unauthorized`, `invalid_credentials` |
| 403 | `forbidden`, `timed_out`, `account_banned`, `target_is_admin`, `invite_required`, `invalid_invite`, `invite_expired`, `invite_exhausted`, `immutable_role`, `permission_escalation` |
| 404 | `not_found`, `channel_not_found`, `message_not_found`, `role_not_found`, `user_not_found`, `emoji_not_found`, `sticker_not_found`, `sticker_missing`, `attachment_not_found`, `avatar_not_found`, `not_banned` |
| 409 | `username_taken`, `emoji_exists`, `discord_channel_taken` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type`, `invalid_image` |
| 429 | `rate_limited` |
| 500 | `internal_error` |

`validation_error` means the body or query string failed schema validation; its `message` names the
offending field. `bad_request` means the request was refused before reaching a handler, such as a body
that is not valid JSON or a JSON request with an empty body. A missing route returns `404` with `{ "error": { "code": "not_found", ... } }`.

## Permissions

Permissions are a bitfield, granted through roles. `Administrator` implies every other flag. The
implicit `@everyone` role grants every member `ViewChannels`, `SendMessages`, `AttachFiles`,
`AddReactions` and `CreateInvites` by default.

| Flag | Bit | Enforced by |
| --- | --- | --- |
| `ViewChannels` | `1 << 0` | Reading channels, messages, roles, emoji and attachments |
| `SendMessages` | `1 << 1` | Posting messages |
| `ManageMessages` | `1 << 2` | Deleting others' messages, clearing reactions, pinning and unpinning |
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
| `ManageEvents` | `1 << 17` | Creating, editing and canceling server events (a creator can always change their own) |

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
  pinnedAt: string | null;      // when it was pinned, see "Pinned messages"
  saved: boolean;               // whether the viewer saved it, see "Saved messages"
  poll: Poll | null;            // the poll this message carries, see "Polls"
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
  | 'member_update' | 'password_reset'
  | 'message_pin' | 'message_unpin'
  | 'backup_download' | 'channel_export'
  | 'server_gif_add' | 'server_gif_remove' | 'server_gif_hide' | 'server_gif_unhide'
  | 'gif_archive' | 'gif_free';

type AuditDetail = {
  channelName?: string;   // message and media kinds
  before?: string;        // deleted text, an edit's old text, or the text pinned or unpinned
  after?: string;         // an edit's new text
  filename?: string;      // media_delete: the file that was removed; backup_download / channel_export: the file produced; server_gif_*: the gif's filename
  gifName?: string;       // server_gif_add / server_gif_remove: the curated gif's display name
  attachments?: Array<{ id: string; filename: string }>;  // images a deleted message carried
  durationMinutes?: number;
  reason?: string | null;
  roleName?: string;
  fields?: string[];       // member_update: the account fields that changed
  count?: number;          // gif_archive / gif_free: gifs copied or released
  bytes?: number;          // gif_free: bytes of copies released
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

### Formatting

A message's `content` is stored exactly as typed; formatting is applied by the client when it is
shown. The syntax is Discord's, so text bridged from Discord renders the same here.

| Syntax | Result |
| --- | --- |
| `**bold**`, `*italic*` or `_italic_`, `__underline__`, `~~strike~~`, `\|\|spoiler\|\|` | Inline emphasis, which nests |
| `` `code` `` | Inline code; nothing inside it is formatted |
| ```` ```lang ```` … ```` ``` ```` | A code block, highlighted when `lang` is a known language (js/ts, json, python, bash/shell, css, html/xml, sql, diff, yaml, rust, go, java, c/cpp, csharp, markdown, and their usual aliases) |
| `# `, `## `, `### ` at the start of a line | Headers; the space is required and `####` is plain text |
| `-# ` at the start of a line | Subtext: a small, muted line |
| `- ` or `* ` at the start of a line | A bulleted list item |
| `1. ` at the start of a line | A numbered list item; the list starts at the first item's number |
| `> ` at the start of a line | Quotes that line; consecutive quoted lines form one quote |
| `>>> ` at the start of a line | Quotes everything after it to the end of the message |
| `[label](https://…)` | A masked link, never unfurled |
| `<https://…>` | A link whose preview is suppressed |
| `<t:1700000000>`, `<t:1700000000:R>` | A timestamp shown in the reader's locale and time zone; styles `t` `T` `d` `D` `f` (default) `F` `R` (relative) |
| `\*` (a backslash before any ASCII punctuation) | The character itself, unformatted |

List items nest under the item above when indented at least two spaces further, and an indented line
without a marker continues the item above it. Headers, subtext, lists and code may sit inside a
quote; quotes do not nest. Mentions, channel references, emoji and links work everywhere except
inside code.

Timestamps need not be written by hand. In the web client, `@` followed by a time offers each style
with a preview, and picking one writes the tag; the clock button next to the emoji button does the
same from a date and time field. The expressions read are `now`, `5pm`, `5:30pm`, `17:30`, `noon`,
`midnight`; a day (`today`, `tomorrow`, a weekday such as `monday` or `mon`, `2025-12-24`, or `24/12`
and `24/12/2025` read in the browser locale's day/month order) optionally followed by a time, as in
`tomorrow 18:00` or `monday at 9am`; and `in 2h`, `in 30 minutes`, `in 3 days`. A time without a day
is its next occurrence, a day without a time keeps the current time of day, and everything is read in
the writer's own time zone. When the text after `@` is also the start of a member's name, members are
listed first and the timestamps after them. The tag is all that is stored, so readers see it in their
own zone as above.

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
  "gifStorage": "store",
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
Discord one, the Discord display name, their Discord picture as the avatar (unless it
already has one), no password (`hasPassword: false`), never the owner. A
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
  "mentionCounts": { "<channelId>": 3 },
  "readMarkers": { "<channelId>": "2026-01-01T12:00:00.000Z" },
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

`mentionCounts` says how many unread mentions and replies each of those channels holds, for the red
number beside it; its keys are exactly `mentionChannelIds`. Deleted messages count for neither list,
and neither do the caller's own messages: a channel whose only new message was deleted is read
again.

`readMarkers` gives, for each listed channel the caller has ever read, the timestamp of the newest
message they had seen. A client compares it with message timestamps to draw a "new" line above the
first message after it when the channel is opened. Channels never read are absent.

Mutes and notification levels do not change any of these lists, which describe what is unread, not
what is worth a notification; see [Channel notification settings](#channel-notification-settings).

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
updated `Message` (with `editedAt` set) and fires `MESSAGE_UPDATE`. The [inbox](#mentions-and-replies)
follows the new text: someone named by the edit finds the message there, someone no longer named does
not, and a reply stays a reply. Naming someone by editing does not make the channel unread for them.

#### `GET /api/v1/messages/:id/edits` — auth (author or `ManageMessages`)

The earlier versions of an edited message, newest first:

```json
{ "edits": [ { "id": "...", "content": "text before the edit", "editedAt": "2026-10-04T10:00:00.000Z",
               "editor": { "id": "...", "username": "bob" }, "source": "harmony" } ] }
```

`editedAt` is when the edit replaced that text, `editor` is who made it (`null` once the account is
deleted) and `source` is `harmony` or `discord`. The current text is the message itself and is not
repeated. At most 20 versions are kept per message; the oldest are dropped. Only the author and members
with `ManageMessages` (administrators included) may read it. For anyone else, and for a deleted or
missing message or a channel the caller cannot see, the answer is the same `404 message_not_found`, so
the endpoint cannot be used to probe. An edit arriving from Discord is recorded too; a Discord update
that leaves the text unchanged (a link unfurl) is not an edit and records nothing. There is no gateway
event: clients fetch the list when the user opens it.

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

#### Suppressing previews

Wrapping a link in angle brackets, `<https://example.com>`, as on Discord, asks for no preview: the
text is stored exactly as written, nothing is resolved, and clients draw an ordinary link without the
brackets. The Discord bridge keeps the brackets in both directions, so a link suppressed on one side
is suppressed on the other. Editing re-evaluates: adding the brackets drops the existing preview, and
removing them lets the link resolve again.

#### `DELETE /api/v1/messages/:id/embeds` — auth (author or `ManageMessages`)

Removes every embed of a message for good: the preview card and any picture the server fetched from a
link in the text (an upload is not an embed and stays). The message is flagged, so editing it later
does not bring a preview back. Returns the updated message and fires `MESSAGE_UPDATE`. `403` for
anyone else, `404` for a missing or deleted message or one in a channel the caller cannot see.
There is no inverse; sending the link again resolves it normally. The removal is not mirrored to
Discord, where the unfurl stays.

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

### Polls

A poll is a message. Its `content` is the question, so search, reply quotes and notifications work
without knowing about polls, and the message carries the poll in `Message.poll`. A client should
draw the poll instead of the text. A poll message cannot be edited (`400 poll_not_editable`);
deleting the message deletes the poll and its votes.

```ts
type Poll = {
  messageId: string;
  question: string;
  allowMultiple: boolean;
  closesAt: string | null;     // when it closes by itself, or null for no expiry
  closedAt: string | null;     // when it was closed, by the clock or by hand
  source: 'harmony' | 'discord'; // where it was made, see "Discord polls" below
  options: PollOption[];       // in the order they were asked
  totalVoters: number;         // distinct people; below the sum of counts when allowMultiple
  myVotes: string[];           // option ids the viewer chose (a broadcast carries [])
};

type PollOption = {
  id: string;
  text: string;                // 1-55 characters
  emoji: string | null;        // a unicode emoji, or null
  count: number;
};
```

The limits are Discord's, so any poll can be posted there as a native one: a question of up to 300
characters, 2 to 10 options, a duration of 1 to 768 hours (32 days). Results are live and are never
hidden: everyone who can see the channel sees the counts at any time, and who voted for an option
is available on demand (polls are not anonymous, as on Discord).

#### `POST /api/v1/channels/:id/polls` — `SendMessages`

```json
{
  "question": "Pizza or tacos?",
  "options": [{ "text": "Pizza", "emoji": "🍕" }, { "text": "Tacos" }],
  "allowMultiple": false,
  "durationHours": 24,
  "replyToId": null
}
```

`allowMultiple` defaults to `false` and `durationHours` to `24`; `durationHours: null` is a poll that
never closes. Everything that applies to sending a message applies here (channel access, timeouts,
slowmode). Returns the new `Message` (with `poll`) and fires `MESSAGE_CREATE`.

#### `PUT /api/v1/messages/:id/poll/votes` — `ViewChannels`, rate limited

```json
{ "optionIds": ["…"] }
```

Replaces the caller's whole choice, so changing a vote and withdrawing one (`[]`) are the same
call. A poll that takes one answer refuses more than one (`400 single_choice`); an option from
another poll is `400 invalid_option`; a closed poll, including one whose time ran out a moment ago,
is `409 poll_closed`. Needs access to the channel (`403 channel_forbidden`) and refuses a timed-out
member (`403 timed_out`). Returns the `Poll` as the caller sees it and fires `POLL_UPDATE`.

#### `POST /api/v1/messages/:id/poll/end` — auth (author or `ManageMessages`)

Closes the poll now; the counts stay. `409 poll_closed` when it already is. A poll that was made on
Discord is closed by Discord, not from here (`409 poll_external`). Returns the `Poll` and fires
`POLL_UPDATE`.

#### `GET /api/v1/messages/:id/poll/voters` — `ViewChannels`

| Query | Type |
| --- | --- |
| `optionId` | required |

```json
{ "optionId": "…", "total": 3, "voters": [ { "user": { /* User */ }, "votedAt": "…" } ] }
```

Who chose one option, earliest first, at most 100 (`total` is the full count). Follows channel
locking like history does.

#### Discord polls

On a bridged channel a poll made here is posted to Discord as a native poll, and a native Discord
poll arrives here as a poll message (`source: "discord"`). Discord's API gives a bot no way to cast
a vote, so **votes made in Harmony stay in Harmony**: Discord shows only its own voters, while
Harmony shows both. Votes made on Discord are counted here under the voter's stand-in account, or
under their own account when their Discord id is linked, so one person is one voter however they
vote. See [the technical notes](TECHNICAL.md#polls) for what crosses the bridge and what does not.

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
| `from` | string ≤64, repeatable (up to 10) | — | Author username or display name, case-insensitive. Several values mean any of them; a name nobody has matches nothing |
| `mentions` | string ≤64, repeatable | — | Messages whose text names `@username`, for any of the given members. The `@name` must stand alone, as the mention parser reads it: `@bob` does not find `@bobby` or `x@bob` |
| `in` | string ≤64, repeatable | — | Channel name, case-insensitive, leading `#` ignored. Several mean any of them. A channel that is unknown **or hidden from the caller** returns `404 no_such_channel` |
| `has` | `image` `video` `gif` `file` `link` `embed` `sticker` `pin`, repeatable | — | Every listed trait must hold. `image` includes gifs, `file` is any attachment, `link` is an `http(s)://` address in the text, `embed` a resolved link preview, `pin` a pinned message. Anything else is `400` |
| `sentAfter` | integer, epoch ms | — | Only messages sent at or after this instant |
| `sentBefore` | integer, epoch ms | — | Only messages sent before this instant |

Repeat a parameter to give several values (`?from=ann&from=bob`). Dates are bounds in epoch
milliseconds, so the client works out what "on 2024-05-01" means in the member's own time zone.

At least one of `q`, `channelId`, `authorId` or a filter above is required; a filter on its own is a
valid search, which is how a client lists everything one member said, everything in one channel or
everything pinned. Asking for none of them returns `400 validation_error`. Filters only ever narrow
the channels the caller can already see, so none of them can reveal a hidden channel's messages.

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

### Pinned messages

A member with `ManageMessages` can pin a message to its channel, and anyone who can read the channel
can list its pins. The pin state travels on the message itself as `pinnedAt`, so pinning or
unpinning fires an ordinary `MESSAGE_UPDATE` that a client applies like any other update; there is
no separate pin event. A channel holds at most 50 pins, Discord's own limit. Locked channels follow
[the same rule as history](#channel-locking): a member who cannot see the channel cannot list its
pins either, and a deleted message drops out of the list (and stops counting towards the limit).

On a bridged channel pins sync with Discord both ways (see the bridge section of the technical notes).
Pinning a message that was mirrored to Discord pins its copy there, which needs the bot to hold *Pin
Messages* in the channel; if it does not, the pin still succeeds here and the failure is only written
to the server log. A message pinned or unpinned on Discord arrives as the same `MESSAGE_UPDATE`, with
`pinnedAt` set to the time Discord pinned it. A Discord pin that would exceed this channel's 50 is
skipped. Bridged pins are audited as `message_pin` / `message_unpin` with a null `actor` and
`detail.actorName` of `"Discord"`.

#### `GET /api/v1/channels/:id/pins` — `ViewChannels`

```json
{ "messages": [ /* Message, with pinnedAt set */ ] }
```

Returns every pin in the channel, newest pin first. There is no paging: the list is capped at 50.

#### `PUT /api/v1/channels/:id/pins/:messageId` — `ManageMessages`

Pins the message and returns it with `pinnedAt` set. Pinning a message that is already pinned
changes nothing and keeps its original pin time. A message that is not in that channel is
`404 message_not_found`; a channel already holding 50 pins is `400 too_many_pins`.

#### `DELETE /api/v1/channels/:id/pins/:messageId` — `ManageMessages`

Unpins the message. Returns `204`, also when it was not pinned.

### Saved messages

Any member can save a message they can see, Discord's bookmarks, and optionally ask to be reminded
of it. Saves are private: nobody else can list them or learn of them, and a change is sent only to
the saver's own sessions as `SAVED_MESSAGE_UPDATE`, never to the channel. Whether a message is saved
travels on it as `saved`, for the viewer only, in the same way as a reaction's `me`: history, search,
the inbox and the pin list carry the viewer's value, while a broadcast `MESSAGE_UPDATE` always says
`false`, so a client keeps the value it already holds.

A save is checked against the caller's access whenever the list is read rather than kept in step
with it. A message in a channel they can no longer see (locked, or a role they lost) is left out of
the list but not deleted, and comes back if access does. A deleted message drops out, as it does from
the pins; there is nothing left to jump to.

```ts
type SavedMessage = {
  message: Message;           // with saved: true
  savedAt: string;
  remindAt: string | null;    // when to remind, or null for a plain save
};
```

#### `GET /api/v1/users/@me/saved` — `ViewChannels`

```json
{ "saved": [ /* SavedMessage */ ] }
```

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer 1–100 | 50 | |
| `before` | ISO 8601 string | — | Return saves made before this time |
| `beforeId` | string | — | Id of the message `before` came from |
| `reminders` | `true` | — | Only the saves carrying a reminder, soonest first, unpaged |

Returns the caller's saves, newest save first. The cursor is the oldest entry you already have, its
`savedAt` plus its message's `id`. With `reminders=true` the list is instead every save with a
reminder, due or not, soonest first and capped at `limit`, which is what a client reads to know
when to remind. A reminder that has come due stays until it is cleared or the save is removed; the
server does nothing when one comes due, so reminding is the client's job.

#### `PUT /api/v1/users/@me/saved/:messageId` — `ViewChannels`

```json
{ "remindAt": "2026-10-04T09:00:00.000Z" }
```

Saves the message and returns the `SavedMessage`. The body is optional. Saving a message that is
already saved keeps its original `savedAt`; a `remindAt` replaces its reminder, `null` clears it,
and leaving it out keeps whatever it had. A reminder in the past is `400 invalid_reminder`. A message
that does not exist, was deleted, or is in a channel the caller cannot see is `404
message_not_found`: the route names no channel, so it does not confirm a hidden message exists.
Fires `SAVED_MESSAGE_UPDATE` to the caller's sessions when anything changed.

#### `DELETE /api/v1/users/@me/saved/:messageId` — `ViewChannels`

Removes the save. Returns `204`, also when it was not saved, and works for a message the caller can
no longer see. Fires `SAVED_MESSAGE_UPDATE` with `saved: null` when there was one.

### Scheduled messages

"Send later": a member's private queue of messages that the **server** posts at the chosen time, so
they go out with every tab closed. Nothing about the queue is visible to anyone else, and changes go
only to the owner's own sessions as `SCHEDULED_MESSAGE_UPDATE`.

```ts
type ScheduledMessage = {
  id: string;
  channelId: string;
  content: string;
  attachments: Attachment[];  // uploads waiting to go out with it
  replyToId: string | null;
  sendAt: string;             // ISO timestamp
  createdAt: string;
  status: 'pending' | 'failed';
  error: string | null;       // why a failed one could not be sent
};
```

A member may hold up to 25 (`MAX_SCHEDULED_PER_MEMBER`, failed ones included). `sendAt` must be at
least 30 seconds ahead (`SCHEDULED_MIN_LEAD_MS`; an operator or test can shorten it with
`HARMONY_SCHEDULED_MIN_LEAD_MS`) and at most a year out; otherwise `400 invalid_send_time`.

Delivery goes through the ordinary send path with the author's permissions worked out **at that
moment**: the channel must still be visible, they need Send Messages (and Attach Files for uploads),
and they must not be timed out or banned, or the entry becomes `failed` with the reason in `error`
and nothing is posted. A reply whose parent was deleted fails the same way. Slowmode is not bypassed;
a message held back by it is retried for a few minutes and fails only if the window never opens. A
failed entry is never dropped: it stays in the list until the member sends it by hand, gives it a new
time (which re-queues it) or cancels it. A message that comes due while the server is down is sent at
the next start. The queue row is deleted in the same database transaction that inserts the message,
so a message is never sent twice. Deleting a channel or an account removes its entries.

Uploads named by a scheduled message are claimed by it: they cannot be used in another message and
retention spares them (they would otherwise be pruned as abandoned after 24 hours).

#### `GET /api/v1/users/@me/scheduled` — `ViewChannels`

The caller's own entries, soonest first: `{ "scheduled": [ScheduledMessage] }`.

#### `POST /api/v1/channels/:id/scheduled` — `SendMessages`

Body `{ content, attachmentIds?, replyToId?, sendAt }`, the first three as for `POST
/channels/:id/messages`. Returns `201` with the `ScheduledMessage`. `403 channel_forbidden` for a
channel the caller cannot see, `404 channel_not_found`, `400 too_many_scheduled`, `400
invalid_send_time`, `400 invalid_reply`, `400 invalid_attachment` / `attachment_in_use`.

#### `PATCH /api/v1/users/@me/scheduled/:id` — `ViewChannels`

Body `{ content?, sendAt? }`, at least one. Returns the entry. Giving a `sendAt` puts a `failed`
entry back to `pending` and clears its error; changing only the text leaves its status alone.
Somebody else's entry is `404 scheduled_not_found`.

#### `DELETE /api/v1/users/@me/scheduled/:id` — `ViewChannels`

Cancels it. `204`, also when it is already gone.

#### `POST /api/v1/users/@me/scheduled/:id/send` — `SendMessages`

Sends it now and returns the posted `Message`. The same checks as an ordinary send apply; a refusal
is returned as the error and the entry stays as it was. `404` if it was already sent or cancelled
(concurrent calls deliver it exactly once).

### Events

Server events with an "Interested" RSVP, a simplified take on Discord's scheduled events. An event
has a title, a description, a start (and optionally an end) and a place: either a **channel** of the
server or a short free **text** such as a link or an address. There is no recurrence, and events are
not mirrored to Discord's own scheduled events.

```ts
type ServerEvent = {
  id: string;
  title: string;                       // 1-100 characters
  description: string;                 // up to 1000
  locationKind: 'channel' | 'external';
  channelId: string | null;            // for a channel event
  locationText: string;                // for an external one, up to 100
  startsAt: number;                    // epoch milliseconds
  endsAt: number | null;
  creator: User | null;                // null once that account is gone
  status: 'scheduled' | 'active' | 'ended' | 'canceled';
  createdAt: string;
  updatedAt: string;
  announcedMessageId: string | null;   // the announcement message, if one was posted
  interestedCount: number;
  interested: boolean;                 // the caller's own RSVP
};
```

**Who sees what.** An event in a channel is visible only to members who can open that channel; an
external event is visible to every member. This governs every surface: the list, one event, the RSVP,
the counts, the names and the gateway. An event the caller cannot see is `404 event_not_found`, never
`403`, so ids cannot be probed. A channel's events are deleted with the channel.

**Permissions.** Creating needs `ManageEvents` (bit 17, `1 << 17`). Editing or canceling needs it too,
except that the creator can always edit or cancel their own event. The migration gave `ManageEvents`
to every existing role that already held `ManageServer`; administrators and the owner have it
implicitly. Create, edit and cancel are audit-logged (`event_create`, `event_edit`, `event_cancel`).

**Rules.** At most 50 events can be `scheduled` or `active` at once (`409 too_many_events`). A new
event must start in the future and no more than a year ahead; an end must come after the start and
within 30 days of it (`400 invalid_event_time`). The start of an event that has begun is fixed
(`409 event_started`), though its text and end can still change; an `ended` or `canceled` event can
no longer be edited, joined or canceled (`409 event_closed`).

**Lifecycle.** A sweep (every 15 s; `HARMONY_EVENT_SWEEP_MS`) moves `scheduled` to `active` at the
start time and `active` to `ended` at the end time, or **4 hours after the start** when no end was
given (`HARMONY_EVENT_DEFAULT_DURATION_MS`). After downtime it catches up at the next start. About 15
minutes before the start (`HARMONY_EVENT_REMINDER_LEAD_MS`) it sends `EVENT_REMINDER` to the sessions of
each member who is interested, once per event; a stamp in the database keeps it from repeating across
restarts, and moving the start re-arms it. A member who is offline at that moment is not reminded:
nothing is stored for them.

#### `GET /api/v1/events` — `ViewChannels`

`{ "events": [ServerEvent] }`: every `scheduled` and `active` event the caller can see (soonest
first), plus the events that `ended` or were `canceled` within the last 7 days, at most 20.

#### `GET /api/v1/events/:id` — `ViewChannels`

One `ServerEvent`.

#### `POST /api/v1/events` — `ManageEvents`

Body `{ title, description?, locationKind, channelId?, locationText?, startsAt, endsAt?,
announceChannelId? }`. A channel event needs a `channelId` the caller can see; an external one needs a
`locationText`. With `announceChannelId` the server also posts an ordinary message **as the caller**
in that channel (they need to see it and hold `SendMessages`), containing the title and a
`<t:UNIX:F> (<t:UNIX:R>)` pair so each reader sees their own zone; its id comes back as
`announcedMessageId`. If posting fails the event is still created. Returns the event. Rate limited.

#### `PATCH /api/v1/events/:id` — `ManageEvents` or the creator

Any of `title`, `description`, `locationKind`, `channelId`, `locationText`, `startsAt`, `endsAt`
(`null` clears the end), at least one. Returns the event.

#### `POST /api/v1/events/:id/cancel` — `ManageEvents` or the creator

Marks the event `canceled`. Canceling one already canceled changes nothing. Returns the event.

#### `PUT /api/v1/events/:id/interested` and `DELETE /api/v1/events/:id/interested` — `ViewChannels`

Marks or withdraws the caller's interest. Both are idempotent and return the event with the new
count. Interest can only be added to a `scheduled` or `active` event (`409 event_closed`); it can
always be withdrawn. Both are rate limited.

#### `GET /api/v1/events/:id/interested` — `ViewChannels`

`{ "total": number, "users": [User] }`: the names behind the count (up to 100, earliest first), left
to members who can see the event. Someone who can no longer see a channel event is counted in `total`
but not named.

### Reactions

An emoji is either a unicode character (send it verbatim, e.g. `"👍"`) or a custom emoji shortcode
`":name:"` paired with its `emojiId`.

#### `POST /api/v1/messages/:id/reactions` — `AddReactions`

```json
{ "emoji": "👍" }
{ "emoji": ":YES:", "emojiId": "6b1f..." }
```

Toggles your own reaction: adds it if absent, removes it if present. Returns the updated `Message`
and fires `MESSAGE_REACTION_ADD` or `MESSAGE_REACTION_REMOVE`. A reaction whose custom emoji has
since been deleted can still be removed (and cleared below) by the `emoji` and `emojiId` it carries;
adding one fails with `400 invalid_emoji`.

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

The admin gallery lists every stored image and video in one place. Media is grouped by content
hash, so the same bytes sent many times is a single entry carrying a `copies` count of how often it
was shared; deleting that entry removes every copy and frees the bytes.

#### `GET /api/v1/media` — `ManageServer`

A page of media, **newest first**, one entry per unique piece of content. The entry for a group is
its newest copy, so the `uploader`, channel and date are those of the most recent send.

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
      "channelName": "general",
      "copies": 3
    }
  ]
}
```

`uploader`, `channelId` and `channelName` are `null` for an upload that was never attached to a
message. `copies` is how many stored copies of these exact bytes exist.

#### `DELETE /api/v1/media/:hash` — `ManageServer`

Deletes every stored copy of the content with this hash, then reclaims the blob once nothing else —
no other attachment, emoji, avatar or saved gif — references the same bytes. This is what the
gallery's delete acts on, since removing a single copy would leave the rest, and the bytes, in
place. Returns `204`, or `404 media_not_found`.

### Gifs and the picker

The picker has three tabs. **Favorites** are private to the member who saved them, and a saved gif is
held by **content hash** rather than by an attachment row, which is what lets it outlive the message
it was found in: it is exempt from the image, video and message retention rules and is only ever aged
out by `favoriteRetentionDays`, counted from the last time it was saved or sent. Nothing is ever
downloaded to save one — the bytes are already stored, and a saved gif shares its blob with every
attachment of the same picture.

**This server** lists what the instance already holds, one entry per picture however many times it
was sent, and only from channels the caller may see. The client now shows it as the **Server** tab,
which puts the administrators' curated gifs first (see [Server gifs](#server-gifs)).

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

#### Server gifs

The picker's **Server** tab (it replaces the old `This server` tab) is the community's own shelf:
the administrators' **curated** gifs first, pinned ones on top and the rest in their set order, then
the **auto-collected** gifs (the same list `GET /gifs/local` builds) minus any an administrator
**hid**. Curating needs `ManageEmojis`, the permission that already governs custom emoji; reading
needs only `ViewChannels`. Every change is audit-logged (`server_gif_add`, `server_gif_remove`,
`server_gif_hide`, `server_gif_unhide`) and fires `SERVER_GIFS_UPDATE` so open pickers refresh.

A curated gif is always a **stored copy** held by content hash, so it survives the message it was
found in, a dead link, and every retention rule (image, video, message and the emergency storage
limit): the pruner counts curated rows as references to their bytes. A hidden gif is only a note on a
hash; it keeps nothing alive, and the auto list simply skips it. One row exists per picture (unique
on the hash): hiding a gif that is curated answers `409 server_gif_curated`, and curating a hidden
one promotes the row. At most 500 gifs can be curated (`409 server_gif_limit`).

`GET /gifs/local` is deliberately unchanged and still returns hidden gifs; the Server tab
(`GET /gifs/server`) is what honours the curation.

##### `GET /api/v1/gifs/server` — `ViewChannels`

Query: `q` (optional; matches a curated gif's name, tags and filename, and an auto gif's filename or
source link) and `limit` (default 50, max 100, applied to the auto-collected part: every matching
curated gif is always returned). Returns `{ "gifs": [ServerGifItem] }` where an item is
`{ id, source: "curated" | "auto", hash, name, tags, filename, contentType, width, height, pinned,
favoriteId }`. Load a curated tile from `GET /gifs/server/:id/image` and an auto tile from
`/attachments/:id`. Auto gifs honour channel visibility exactly as `/gifs/local` does, so a gif in a
[locked channel](#channel-locking) never reaches a member who cannot see that channel.

##### `GET /api/v1/gifs/server/manage` — `ManageEmojis`

The admin view: `{ "curated": [ServerGif], "hidden": [ServerGif], "auto": [GifItem] }`. `curated` is in
display order (pinned first, then `position`); `auto` excludes hidden and curated pictures and is
limited to what the caller can see.

##### `POST /api/v1/gifs/server` — `ManageEmojis`

Body: exactly one of `{ "attachmentId" }` (a gif the caller can see, or their own pending upload),
`{ "favoriteId" }` (the caller's own favorite) or `{ "url" }` (a hosted-service address, fetched and
stored through the same SSRF-guarded path as favorites; only the configured service's addresses are
accepted, `400 invalid_gif_url` otherwise), plus optional `name` (up to 60), `tags` (up to 12 words)
and `pinned`. Returns the `ServerGif`. `409 server_gif_exists` when the picture is already curated,
`400 not_a_gif` for anything that is not a gif, `404 gif_not_found` for an attachment the caller
cannot see. A new gif goes to the end of the list. To upload a new gif, `POST /attachments` it first
and pass the returned id.

##### `PATCH /api/v1/gifs/server/:id` — `ManageEmojis`

Body: any of `name`, `tags`, `pinned`, `position`. Returns the `ServerGif`; `404` for an unknown or
hidden row.

##### `POST /api/v1/gifs/server/order` — `ManageEmojis`

Body `{ "ids": [string] }`: the curated ids in their new order. Ids not listed follow in their old
order. `204`.

##### `POST /api/v1/gifs/server/hide` — `ManageEmojis`

Body `{ "attachmentId" }`: removes that picture from the auto-collected list for everyone. Returns the
`hidden` `ServerGif`. The caller must be able to see the attachment (`404` otherwise).

##### `DELETE /api/v1/gifs/server/:id` — `ManageEmojis`

Deletes a curated gif (its bytes go at the next retention sweep unless something else holds them) or
un-hides a hidden one. `204`, or `404`.

##### `POST /api/v1/gifs/server/:id/pick` — `AttachFiles`

Like `POST /gifs/pick` for a curated gif: returns a pending `Attachment` to send with a message.

##### `GET /api/v1/gifs/server/:id/image` — `ViewChannels`

The bytes of a curated or hidden row, cached immutably by hash.

#### `POST /api/v1/gifs/pick` — `AttachFiles`

Takes a gif out of the picker and into the message being written. Body is one of
`{ "favoriteId": string }`, `{ "attachmentId": string }` or `{ "url": string }` for a hosted gif; the
answer is an `Attachment` that is **not yet attached to anything**. Send it with the message as usual
— `POST /api/v1/channels/:id/messages` with `attachmentIds: [thatId]` — exactly as an upload would
be.

A gif this instance already holds costs nothing to pick: the attachment is a new row pointing at
bytes that are already there, a few hundred bytes and no bandwidth. A hosted one is fetched and kept
first. Picking a **saved** gif also counts as using it, moving its `usedAt` forward.

#### Linked gifs

With `gifStorage: "link"` a gif is not copied here. Only gifs on these hosts qualify, matched on the
parsed address (https, default port, no credentials, exact host or a real subdomain): `*.klipy.com`
(media subdomains such as `static.klipy.com`, not the bare site), `media.tenor.com`,
`media1.tenor.com`, `media.giphy.com`, `i.giphy.com` and `media0`–`media4.giphy.com`. The list is
`GIF_LINK_EXACT_HOSTS` / `GIF_LINK_SUFFIX_HOSTS` in `packages/shared/src/gif-hosts.ts`. Everything
else, and every Discord attachment (those addresses are signed and expire), is stored as before.

A message carries a linked gif as ordinary text: its content is the gif's address. When the link
resolver (see [Link previews](#link-previews)) meets such an address in link mode, it checks it and
sets the message's `embed` to `{ url, title: null, description: null, siteName: <host>, imageUrl:
null, player: null, gif: { contentType, width, height } }` with the gif's own address in `url`. The
check: allowlisted host, resolves to a public address, **no redirects followed**, status `200`, a
`Content-Type` of `image/gif`, `image/webp`, `video/mp4` or `video/webm`, and a size within the
instance's image or video limit (by `Content-Length`, or by reading up to the limit when none is
declared). Failing any of that, the gif is stored by the ordinary path instead. A copy this instance
already holds is reused rather than linked past. A client draws `embed.url` directly (`<img>` or a
muted looping `<video>`) while `gifStorage` is `"link"` and the address is on the allowlist, and
from `GET /api/v1/gifs/copy?url=` (below) while it is `"store"` or when the remote fails to load;
`width` and `height` are `null` because gif services do not tell the server.

While the mode is on, the built-in `Content-Security-Policy` opens `img-src` and `media-src` to those
hosts and nothing else; a policy set with `HARMONY_CSP` is sent exactly as written. The page is served
with `Referrer-Policy: no-referrer`. **Viewers' IP addresses are visible to the gif host.**

#### `POST /api/v1/gifs/link` — `AttachFiles`

Body `{ "url": string }`. Checks a hosted gif's address as above and returns
`{ "url": string, "contentType": string }`; the client then sends that address as the message text.
`409 gif_link_disabled` while the mode is `"store"`, `400 invalid_gif_url` for an address off the
allowlist, `415 invalid_gif` when the host did not serve a gif of a sensible size. Nothing is stored.
Saved (favorite) gifs, the This server tab and `POST /api/v1/gifs/pick` are unchanged: they are
stored bytes. Saving a hosted gif to favorites still keeps a copy.

#### `GET /api/v1/gifs/copy?url=` — `ViewChannels`

The copy this server holds of a linked gif, by the address the message links to (percent-encode it,
query string included). Answers with the gif bytes, or `404 gif_not_found`. The address must be on the
gif-host allowlist and already recorded in `gif_sources` (migration 31). While `gifStorage` is
`"store"` a recorded address with no copy yet is fetched once through the SSRF-guarded downloader,
within the upload size limit; after three failed fetches it is marked dead and the route answers 404.
While `"link"` it serves only a copy that already exists and never fetches.

#### `GET /api/v1/gifs/sources` — `ManageServer`

```json
{ "total": 12, "linked": 4, "archived": 7, "dead": 1, "archivedBytes": 1048576 }
```

`linked` counts recorded addresses with no copy that are not dead, `archived` those with a copy,
`dead` those given up on.

#### `POST /api/v1/gifs/sources/archive` — `ManageServer`

Copies up to 20 recorded gifs that have no copy, from allowlisted hosts only, within the upload size
limit. Returns `{ "attempted", "copied", "failed", "markedDead", "more", "stats" }`; call again while
`more` is true. `409 archive_running` if another run is in progress, `429` past 30 calls a minute.
Audit kind `gif_archive` (detail `count`).

#### `POST /api/v1/gifs/sources/free` — `ManageServer`

Releases the copies made for gif sources whose gifs are still linked and that nothing else keeps (no
attachment, favorite or curated server gif). Returns `{ "released", "freedBytes", "stats" }`; the
addresses stay recorded. `409 gif_free_needs_link` while `gifStorage` is `"store"`. Audit kind
`gif_free` (detail `count`, `bytes`).

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
  "notifyMinor": false,
  "bio": "Hi, I build things.",
  "status": "shipping v1.26",
  "accentColor": 16743424,
  "socialLinks": { "github": "octocat", "website": "https://example.com" }
}
```

Every field is optional, but at least one is required. `displayName` may be up to 32 characters; `null`
or `""` clears it. `showTyping` turns typing indicators off entirely for the user: they neither send
nor see them. `notifyMajor` and `notifyMinor` cover the client's two notification sounds, both on by
default: the first for a message that mentions the user, by reply or by name, and the second for
other messages in the channel being read.

The remaining fields are the member's profile customization, shown in the profile viewer. `bio` (up to
256 characters) and `status` (up to 128) are plain text. `accentColor` is a packed RGB integer, or
`null` to fall back to the color averaged from the member's picture. `socialLinks` maps a platform to a
value: for `twitter`, `github`, `twitch`, `youtube` and `steam` the value is a bare handle joined to a
fixed base URL, and for `website` it is a full `http(s)` address. A value that is not valid for its
platform, and any key that is not a known platform, is dropped rather than stored. Read the result back
from `GET /api/v1/users/:id/profile`.

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

#### `PUT /api/v1/users/@me/banner` — auth

`multipart/form-data` with a single `file` field (an image), cropped server-side to a 600×240 WebP.
Banners are kept apart from avatars because they are rarely needed; a request that does not want one
skips it. Returns `MeResponse`.

#### `DELETE /api/v1/users/@me/banner` — auth

Clears your banner and returns `MeResponse`.

#### `GET /api/v1/users/:id/banner`

Serves a user's banner as WebP, with the same `ViewChannels` requirement and `?v=<bannerHash>`
capability rule as the avatar route. Returns `404 banner_not_found` when the user has no banner.

#### `GET /api/v1/users/:id/profile` — `ViewChannels`

```json
{
  "bio": "Hi, I build things.",
  "status": "shipping v1.26",
  "accentColor": 16743424,
  "avatarColor": 16743424,
  "bannerHash": "9f2c…",
  "socialLinks": { "github": "octocat", "website": "https://example.com" }
}
```

The profile fields a member set about themselves. They are fetched on their own rather than carried on
the lean `User` object, which rides along on every message and roster entry and so stays small.
`accentColor` is the member's chosen color, `avatarColor` is the one averaged from their picture (both
packed RGB, either nullable); a client leads with the accent when there is one and the picture's color
otherwise. `bannerHash` is the banner's content hash, served through the route above. `socialLinks`
is only ever the platforms that were stored.

### Channel notification settings

Each member's own mute and notification choices for channels and categories, as on Discord. They are
private: there is no way to read another member's, and changes are announced only to the member's own
sessions. A channel inherits from its category, which a client works out itself (the server stores
each target's settings separately):

- A muted category mutes every channel in it; a channel is muted while either mute is in force.
- A channel's `level` of `default` takes its category's level; a category's (or an uncategorized
  channel's) `default` means the server default, `all`.
- On the web client a muted channel is dimmed, is not shown as unread and plays no sounds, but still
  shows its mention count unless its level is `nothing`. `mentions` plays a sound only for mentions,
  and `nothing` plays none and hides the mention count. Muted channels do not mark the tab title;
  their mentions still do unless the level is `nothing`.

```ts
type ChannelNotificationSettings = {
  targetId: string;                 // a channel or category id
  targetType: 'channel' | 'category';
  muted: boolean;                   // in force right now; an expired mute reads false
  muteEndsAt: string | null;        // when it lifts, or null for "until I turn it back on"
  level: 'default' | 'all' | 'mentions' | 'nothing';
};
```

#### `GET /api/v1/users/@me/channel-settings` — `ViewChannels`

`{ "settings": [ /* ChannelNotificationSettings */ ] }` for every channel and category the caller has
changed anything on and can currently see. Anything absent is on the defaults (not muted, level
`default`). A mute lifts on its own at `muteEndsAt` with nothing to call; clients should schedule
their own timer for it.

#### `PUT /api/v1/users/@me/channel-settings/:targetId` — `ViewChannels`

```json
{ "muted": true, "muteSeconds": 900, "level": "mentions" }
```

Changes the caller's settings for one channel or category, whichever the id names. Fields left out
keep their value, but at least one of `muted` and `level` is required. `muteSeconds` (1 to one year)
goes only with `muted: true`; leaving it out or passing `null` mutes until turned back off. The end is
computed from the server's clock. The client offers Discord's choices: 15 minutes, 1, 3, 8 and 24
hours, or indefinitely. `muted: false` lifts any mute. Settings that end up back on the defaults are
deleted. Returns the new `ChannelNotificationSettings` and sends `CHANNEL_SETTINGS_UPDATE` to the
caller's own sessions only. `400 validation_error` for a bad body; `404 target_not_found` both for an
id that does not exist and for a locked channel or category the caller cannot see. Deleting a channel
or category deletes everyone's settings for it.

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
a member's **roles change**; a member's **account is edited**, naming the fields that changed; a
member's **password is reset**; an **event** is created, edited or canceled; a message is **pinned** or **unpinned**, with its text and its
author as the target; the owner **downloads a backup**; and a channel is **exported**.

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

### Backup and export

#### `GET /api/v1/backup` — owner only

Streams the whole instance as `application/gzip`, with
`Content-Disposition: attachment; filename="harmony-backup-<server>-<YYYY-MM-DD>.tar.gz"`. The
archive is a POSIX (ustar) tar laid out like the data directory: `harmony.db`, a consistent snapshot
taken with SQLite's online backup while the server keeps running, then `uploads/<xx>/<sha-256>` for
every stored blob. It is built as it is sent, so it never sits in memory or on disk whole; the
temporary database snapshot is deleted when the response ends, including when the client disconnects
partway. Restoring is described in [DEPLOYMENT.md](DEPLOYMENT.md#backups).

Restricted to the owner, not just `Administrator`: the archive holds every password and session hash,
the bridge bot token and the Discord sign-in secret. Anyone else gets `403 owner_only`. Only one backup
is prepared at a time; a second request meanwhile gets `409 backup_in_progress`. Each download is
recorded in the audit log as `backup_download`.

#### `GET /api/v1/channels/:id/export` — `ManageServer`

Streams one channel's history as a file download. Deleted messages are left out, as they are from the
channel. A locked channel the caller cannot see is a `404`, the same as a missing one.

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `format` | `json` or `html` | `json` | Anything else is `400 invalid_format` |

The file is named `harmony-<server>-<channel>-<YYYY-MM-DD>.<format>`. `json` is a `ChannelExport`:

```ts
type ChannelExport = {
  format: 1;
  exportedAt: string;
  serverName: string;
  channel: { id: string; name: string; topic: string | null };
  messages: Array<{                     // oldest first
    id: string;
    author: { id: string; username: string; displayName: string | null; isBot: boolean } | null;
    content: string;
    createdAt: string;
    editedAt: string | null;
    replyTo: { id: string; authorName: string | null; deleted: boolean } | null;
    attachments: Array<{
      id: string; filename: string; contentType: string; size: number;
      url: string;                      // absolute, on the address the export was requested at
      sourceUrl: string | null;
    }>;
    stickers: Array<{ id: string; name: string }>;
    reactions: Array<{ emoji: string; emojiId: string | null; count: number }>;
  }>;
};
```

`html` is a standalone page with inline styles and no scripts. Message text is HTML-escaped and shown
as plain text (no Markdown rendering), and the page carries a `Content-Security-Policy` meta tag that
forbids scripts and remote loads when it is opened from disk. Attachments are links back to the server,
which still need a signed-in session to open. Each export is recorded in the audit log as
`channel_export`.

### Server log

The server log records what the **instance** did, and where it failed, as distinct from the
[audit log](#audit-log), which records what people did. It is what lets the owner see an
unhandled request error, a retention run that failed, a backup that could not be prepared, a
bridge that connected or stopped, or a channel that was linked to Discord, without reading the
process log.

Everything written to it is sanitized first: a token, password, bearer value or Discord bot
token in a message or its detail is redacted before the row is stored, and a message is capped
at 500 characters. A repeated warning or error is coalesced onto one row rather than piling up:
`count` is how many times the same event and message were seen, and `firstAt`/`lastAt` bracket
the run. An informational event is never coalesced; each is a distinct thing that happened.

```ts
type ServerLogLevel = 'info' | 'warn' | 'error';

type ServerLogEntry = {
  id: string;
  level: ServerLogLevel;
  event: string;                     // a stable code, e.g. 'instance_started', 'unhandled_error'
  message: string;                   // sanitized, human-readable
  detail: Record<string, unknown>;   // sanitized structured context; never secrets
  count: number;
  firstAt: string;
  lastAt: string;
};
```

#### `GET /api/v1/server-log` — owner only

```json
{ "entries": [ /* ServerLogEntry */ ] }
```

Newest `lastAt` first. Reading it is restricted to the owner, not just `Administrator`: entries
can carry internals — a filesystem path, a failed SQL statement, the address a request was made
to — that a moderated administrator should not necessarily see. Anyone else gets `403 owner_only`.

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer 1–100 | 50 | |
| `before` | ISO 8601 string | — | Return entries last written before this timestamp |
| `beforeId` | string | — | Id of the entry `before` came from, to break ties |
| `level` | `info`, `warn` or `error` | — | Narrow to one severity |

#### `DELETE /api/v1/server-log` — owner only

Returns `204` and empties the log. The clear itself is not recorded, so afterwards the log
really is empty. [Retention](#retention) ages entries out automatically instead, when
`serverLogRetentionDays` is configured.

### Update

The update check compares the version this instance runs with the newest on its update branch, and
the apply button runs an update the operator has configured. The whole feature is the owner's:
every route here answers `403 owner_only` to anyone else, the same reason the
[server log](#server-log) is owner-only.

```ts
type UpdateStatus = {
  running: string;         // the version this instance runs
  latest: string | null;   // the newest on the update branch, or null before a first success
  available: boolean;      // latest is newer than running
  checkedAt: string | null;
  error: string | null;    // the last failure; cleared on success
  autoCheck: boolean;      // the once-a-day check
  enabled: boolean;        // false when the instance has no update source
};

type UpdateSnapshotInfo = {
  filename: string;
  sizeBytes: number;
  createdAt: string;
};

// Every route below returns the whole panel, so the tab never reads two shapes.
type UpdatePanel = UpdateStatus & {
  instanceId: string;               // changes on every restart, so a client can spot one
  command: string | null;          // HARMONY_UPDATE_COMMAND, or null when the button is off
  backupRetention: number;         // how many snapshots stay on disk
  applying: boolean;               // an apply is running now
  log: string;                     // the tail of the running or last apply's output
  failed: boolean;                 // the last apply ended in failure
  snapshots: UpdateSnapshotInfo[]; // newest first
};
```

#### `GET /api/v1/update` — owner only

Returns the cached `UpdatePanel`. It does not call out; use the check below for that.

#### `POST /api/v1/update/check` — owner only, rate limited

Fetches the version file now and returns the `UpdatePanel`. Rate limited to 6 requests a minute per
owner. A failed check keeps the last known answer and records why in `error`, so a blip never reads
as "up to date".

#### `PATCH /api/v1/update` — owner only

`{ "autoCheck"?: boolean, "backupRetention"?: number }`. At least one field is required (`400`
otherwise), and `backupRetention` is `1` to `20`. Returns the `UpdatePanel`.

#### `POST /api/v1/update/apply` — owner only, rate limited

`{ "backup": boolean }`. With `backup: true` the server first writes a database-only snapshot
(awaited, so the refusals below are real statuses), keeping the newest `backupRetention` of them on
disk. It then starts the command from `HARMONY_UPDATE_COMMAND` and returns the `UpdatePanel`; the
command runs in the background. When it exits `0`, the server exits itself so its supervisor starts
the new build, and a poll then sees a new `instanceId` when it is back.

- `400 bad_request` — no `backup` field. The JSON body is required, which also keeps a cross-site
  form from reaching the route.
- `409 update_disabled` — no `HARMONY_UPDATE_COMMAND` is configured.
- `409 update_in_progress` — an apply is already running.
- `409 disk_full` — the snapshot would not fit (only with `backup: true`).

A command that exits non-zero leaves the instance running the old build; the panel reports
`failed: true` and the output in `log`. The log is kept in memory only, so a successful apply's log
is gone once the process restarts.

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
"gifStorage"?: "store" | "link",
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
again makes the wizard greet them once more. `gifStorage` is `"store"` (the default: a gif that is
sent is downloaded and kept here) or `"link"` (a gif on an allowlisted gif host is not downloaded;
the message points at it). It is also in `GET /api/v1/meta`; see
[Linked gifs](#linked-gifs) for what it changes.

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
switched off. Image, video, message, audit-log and server-log age limits are independent: each is
deleted once it is older than its own limit, and the logs can be cleared outright with
`DELETE /api/v1/audit` and `DELETE /api/v1/server-log`.

Messages somebody chose to keep are outside the age rules: a pinned message and a message saved by a
member are never removed by the image, video or message limits, and their attachments are spared by
emergency pruning too. A save or a pin goes away only when the message itself is deleted by its
author or a moderator, which takes it with the message.

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
only thing it removes for space, and it spares the ones on a pinned or saved message: it never
deletes messages, and it stops as soon as a round of removals frees nothing, so a cap that the exempt
content alone exceeds is left over rather than chased by deleting more.

```ts
type RetentionSettings = {
  imageRetentionDays: number | null;
  videoRetentionDays: number | null;
  messageRetentionDays: number | null;
  auditRetentionDays: number | null;
  serverLogRetentionDays: number | null;
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
`auditRetentionDays`, `serverLogRetentionDays`, `favoriteRetentionDays`, `externalEmojiRetentionDays`,
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

A message from a member with a linked Discord account is mirrored under their Discord nickname and
picture, so it reads as theirs to Discord members. The public base URL is only needed for members
with no link, whose Harmony avatar Discord fetches from this instance.

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
   On failure it closes the socket with code **4004**. IDENTIFY must arrive within one
   `heartbeat_interval`, or the socket is closed with **4003**.

### Heartbeat

Send `{ "op": 1, "d": null }` every `heartbeat_interval` milliseconds (45 seconds by default); the
server replies with `{ "op": 11, "d": null }`. Heartbeats are **required**:

- A connection the server hears nothing from for about two intervals (the exact allowance is
  `2 × heartbeat_interval` plus up to five seconds) is presumed dead and closed with `4009`, and its
  member goes offline if it was their last connection. Any frame counts, but only heartbeats are
  sent on an idle socket.
- A connection that has not sent IDENTIFY within one interval of HELLO is closed with `4003`.

Clients should treat a missing ACK the same way from their side: if the previous heartbeat is still
unanswered when the next one is due, the connection has gone quiet without closing (a network
change, a proxy holding a dead line), so close it and reconnect. The web client does exactly this,
and also checks the connection at once when the browser reports it is back online or the tab
returns to the foreground.

Because a healthy socket carries a heartbeat and its ACK every interval, a reverse proxy's idle
timeout only needs to be comfortably longer than `heartbeat_interval`.

### Dispatch events

Dispatched frames use `op: 0` with a `t` name and `d` payload:

| Event | Payload |
| --- | --- |
| `READY` | `{ user, gateway_version }` |
| `MESSAGE_CREATE` | `Message` |
| `MESSAGE_UPDATE` | `Message` (edits, link previews, pins and unpins, and bridged edits) |
| `MESSAGE_DELETE` | `{ id, channelId }` |
| `MESSAGE_REACTION_ADD` | `ReactionUpdatePayload` |
| `MESSAGE_REACTION_REMOVE` | `ReactionUpdatePayload` |
| `MESSAGE_REACTIONS_CLEAR` | `ReactionsClearPayload` |
| `POLL_UPDATE` | `PollUpdatePayload`, to members who can see the channel |
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
| `SERVER_GIFS_UPDATE` | `{}`, to every connected member whenever the server gif list changes; refetch `GET /gifs/server` |
| `RETENTION_APPLIED` | `PruneSummary` |
| `SAVED_MESSAGE_UPDATE` | `{ messageId, channelId, saved: SavedMessage \| null }`, to the saver's own sessions only |
| `SCHEDULED_MESSAGE_UPDATE` | `{ id, scheduled: ScheduledMessage \| null, reason }`, reason one of created, updated, failed, sent, cancelled; to the owner's own sessions only |
| `EVENT_UPDATE` | `{ event: ServerEvent, reason, rsvpUserId, rsvpInterested }`, reason one of created, updated, started, ended, canceled, rsvp; a channel event to members who can see the channel, an external one to everyone. `event.interested` is always false here: for `rsvp`, `rsvpUserId` says whose interest changed and what it became |
| `EVENT_REMINDER` | `{ event: ServerEvent }`, shortly before an event starts, to the sessions of members who are interested in it only |
| `CHANNEL_SETTINGS_UPDATE` | `ChannelNotificationSettings`, sent only to the member it belongs to |

`MEMBER_UPDATE` fires for a member's own profile and avatar changes as well as administrator edits,
role changes, timeouts, kicks and bans, so a client should refetch the roster (and its own profile,
when the `userId` is its own) whenever it sees one.

`CHANNEL_DELETE` and `CATEGORY_DELETE` reach every member who could see the channel or category
before it went. They are also how a member learns they have **lost access**: when an administrator
locks a channel or category behind a role (or moves a channel into a locked category), members who
could see it but no longer can receive a `CHANNEL_DELETE` / `CATEGORY_DELETE` carrying only the id,
while the `CHANNEL_UPDATE` / `CATEGORY_UPDATE` goes only to those who still can. Treat either as
"this is gone for you"; refetching `GET /api/v1/channels` gives the authoritative list.

`POLL_UPDATE` fires when a vote changes or a poll closes, with the new counts rather than a per-viewer
view:

```ts
type PollUpdatePayload = {
  messageId: string;
  channelId: string;
  closedAt: string | null;
  options: { id: string; count: number }[];
  totalVoters: number;
  actorId: string | null;       // who voted; null when the poll closed
  actorVotes: string[] | null;  // that member's choices now; null with actorId
};
```

A client applies the counts, and replaces its own `myVotes` only when `actorId` is its own user. A
`MESSAGE_UPDATE` for a poll message (a pin, say) carries `myVotes: []` and must not clobber it.

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
| `4003` | No IDENTIFY arrived within one heartbeat interval of connecting. Safe to reconnect. |
| `4004` | The session was rejected. Re-authenticate instead of retrying. |
| `4005` | The session was ended by moderation (a kick or ban). |
| `4009` | No heartbeat (or any other frame) arrived for about two heartbeat intervals. Safe to reconnect. |

The close frame's reason is a human-readable sentence (for instance "You were banned from this
server." or "Your password was changed on another device."), suitable for showing on a sign-in
screen after a `4004` or `4005`.

### Reconnecting

The gateway has no sequence numbers and no resume support. On reconnect, re-identify and refetch
the state you care about (`GET /api/v1/channels`, the open channel's history). Do not reconnect
after a `4004` or `4005` close: re-authenticate first.

Events about a locked channel or category, including its messages, typing and reactions, only go to
members who can see it. Everything else is broadcast to every authenticated client.

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
