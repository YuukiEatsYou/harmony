# Harmony, technically

The internals, the development setup and the full reference for the Discord
bridge. For running a real instance, see [DEPLOYMENT.md](DEPLOYMENT.md); for the
API, see [API.md](API.md); for the planned system push notifications, see
[PUSH.md](PUSH.md). The friendly overview lives in the
[README](../README.md).

## How it is built

- **TypeScript** across the server, the web client and a shared package.
- **Fastify** for the HTTP API, plus a **WebSocket gateway** for realtime, on plain
  Node — no build step for the server, which runs its `.ts` files directly.
- **SQLite** through Node's built-in `node:sqlite`: one file, no database server to
  run and no database driver to install. Schema changes are hand-written,
  append-only migrations.
- **Svelte 5 + Vite** for the web client, a single-page app.

A production instance is a single process: the server serves the built client, the
API and the gateway on one origin, so there is nothing else to run and no CORS to
configure.

## Requirements

- **Node.js 24 or newer.** The project relies on Node stripping TypeScript types
  itself and on the built-in SQLite module.

## Repository layout

```
apps/
  server/   Fastify API, WebSocket gateway and SQLite storage
  web/      Svelte 5 single-page client
packages/
  shared/   Types, permission bitfield, gateway protocol and zod schemas
docs/
  API.md          HTTP and gateway reference for custom clients and bots
  DEPLOYMENT.md   Running a real instance: TLS, settings, backups
  PUSH.md         Design for OS push notifications (proposed, not built)
  TECHNICAL.md    This file
```

## Running it

### Development

```sh
npm install
npm run dev
```

- Web client: <http://127.0.0.1:5173>
- API and gateway: <http://127.0.0.1:8787>

Both bind to loopback only, so the instance is not reachable from other devices by
default. To open it to your local network — a phone on the same Wi-Fi, say — run
`npm run dev:lan` instead. It starts the same pair but lets the web client listen
on every interface and prints a `Network:` URL to open on the other device. The
API and gateway stay on loopback and are reached through the web client's proxy, so
no other port needs opening.

Configuration is read from environment variables; copy `.env.example` to `.env` to
override the defaults. Environment values only supply the **initial** defaults —
settings an admin can change at runtime (server name, theme, upload limits,
retention, the bridge) live in the database and are edited in the admin panel.

### Tests

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-check every workspace (`tsc` for the server and shared package, `svelte-check` for the web client) |
| `npm run smoke` | Boot a throwaway server and exercise the API end to end |
| `npm run smoke:bridge` | Exercise the Discord bridge against a fake transport |
| `npm run smoke:text` | Check the client's pure logic: the markdown and link parser, catching up after being away, and what the emoji picker offers |

### Production

```sh
npm ci
npm run build:web
npm start
```

`npm start` is `node apps/server/src/index.ts`, which serves the built client from
`apps/web/dist` when it is there (override with `HARMONY_WEB_DIR`). Without a
build it serves the API only and says so on startup.

Other scripts: `npm run dev:server` and `npm run dev:web` run one side on its own,
and `npm run dev:web:lan` is the LAN variant of the client.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the environment-variable table, TLS, a
reverse proxy, backups and a systemd unit.

## Data and storage

Everything that matters lives in `data/` (override with `HARMONY_DATA_DIR`): the
SQLite database `harmony.db` and the uploaded blobs in `uploads/`.

Uploaded files are **content-addressed**: named by the SHA-256 of their bytes and
sharded into subdirectories by the first byte, so identical files are stored once
however many times they are posted. The database rows reference blobs by hash, and
retention pruning removes any blob nothing references any more. Backing up the
database and the `uploads/` folder together is therefore enough.

## Theming

An instance picks two colors — a background and an accent — and the client derives
everything else from them in `packages/shared/src/theme.ts`. The derivation works
in plain RGB and keeps light and dark backgrounds readable on their own: the text
grays, the surface ladder, the borders and the translucent washes and glows built
from the accent all come out of that one function, so an admin never has to reason
about contrast and no component has to carry a fallback color.

The **surface ladder** is the spine of the look. On a dark background surfaces get
lighter as they rise — a panel above the base, a raised chip above the panel — while
recessed wells (inputs, code blocks, rows) step the other way. On a light background
the whole ladder runs the other way, and a near-black background, which has no room
to darken, climbs instead. The client writes every color token onto `:root` as a
`--h-*` custom property when the theme loads, and the stylesheet refers to nothing
but those tokens; the values hardcoded in `app.css` are only the first-paint
fallbacks for the built-in palette, before the theme is applied.

The one thing deliberately **not** derived is the status colors (ok, warning,
error): they are semantic, and a green or a red should not shift because an admin
picked a different accent. Shape, shadow, motion and type are fixed too.

## Search

Message search is a case-insensitive substring match (`LIKE`) over the text, rather than a full-text
index. That is a deliberate trade for a server this size: the query reads the real table, so it can
never disagree with what is actually stored — no index to keep in step with edits, soft deletes or
retention pruning — at the cost of a scan that is imperceptible at the message counts one community
produces. The channels a searcher may see are resolved first and passed into the query, so a locked
channel cannot leak through a result.

### Filters

Discord-style filters narrow the same scan: `from`, `mentions`, `in`, `has`, and a sent-after /
sent-before time range. They are plain `AND` conditions in `searchMessages` (`db/messages.ts`) with
every value bound as a parameter; the `has` traits map to fixed SQL strings, never to caller input.
Names are resolved in `MessageService.search`, and the order matters for safety: `in` is matched only
against the channels the caller can already see, so a hidden channel and a channel that does not exist
both answer `404 no_such_channel`, and every other filter is applied inside that visible set. `from`
and `mentions` resolve names to accounts case-insensitively (username or display name); a name that
matches nobody simply matches no messages. `mentions` is a substring match on the literal `@username`
text rather than the `mentions` table, because that table skips self-mentions, bots and Discord
stand-ins. Dates are sent as epoch milliseconds: the client turns a local calendar day into bounds so
the server never needs to know the member's time zone.

On the client, `lib/search-query.ts` is the pure half: it tokenizes the box (quotes keep a name with a
space whole), turns finished `key:value` tokens into chips, builds the request, and ranks the
suggestions for the token under the caret. `SearchPanel.svelte` only wires it to the DOM.

If a very large instance ever needed ranking or word matching, SQLite's FTS5 is available in the
bundled build and would slot in behind the same endpoint.

## The Discord bridge

The bridge mirrors messages both ways. On the Discord side you need to:

1. Create an application and a bot at <https://discord.com/developers/applications>.
2. Enable the **Message Content** and **Presence** intents on the Bot page. Both
   are privileged: the toggles work right away for a bot in fewer than 100
   servers, and need Discord's approval beyond that. Message Content is what makes
   message text readable. Presence is what tells Harmony who on the Discord side is
   online, for the member list of a bridged channel. The poll intent the bridge also
   asks for is not privileged and needs no toggle.
3. Invite the bot with at least **View Channels**, **Send Messages**, **Read
   Message History**, **Add Reactions** and **Manage Webhooks**. Add **Manage
   Messages** too if a message written on Discord should also disappear there when
   it is deleted in Harmony; a webhook can only delete its own messages, so the bot
   does that itself. Add **Pin Messages** if pins should sync from Harmony to
   Discord (pins made on Discord reach Harmony without it).

Intents are read when the bot connects, so restart Harmony after changing them. If
an intent is requested that has not been enabled, Discord refuses the connection
outright (close code 4014) rather than degrading, and the bridge reports the failure
in **Admin → Bridge**.

Then paste the token into **Admin → Bridge**, enable it, and pick a Discord channel
when creating or editing a Harmony channel. Only bridged channels sync. The setup
wizard walks through the same steps on a new instance.

Harmony users are mirrored to Discord as webhook messages, so they carry the
author's display name; Discord always marks webhook messages with an "APP" tag.
Discord users appear in Harmony as stand-in accounts created automatically the
first time they post.

A stand-in account has no way to sign in, so its presence is never Harmony's own.
It is borrowed from Discord instead: the bridge keeps the guild's presences in
memory and marks a stand-in online or offline as its owner's status changes, with
the status sent on connect filling in everyone before anybody moves. None of it is
stored, so stopping the bridge or restarting Harmony simply drops the stand-ins back
to offline. Only accounts that already have a stand-in are announced — presence
covers every member of the Discord server, and creating an account for each of them
would bury the real members. An account created later still starts out online if its
owner was already around.

Text, images, videos, avatars, replies, reactions, edits and deletes are all
mirrored in both directions. Images and clips are transferred between the two
systems, and anything that cannot be mirrored (an unsupported file type, or one
above the instance's upload limit) is preserved as a link instead of being dropped.
A forwarded Discord message arrives with the forwarded text and files, under a
*Forwarded* line. A moderator's bulk delete on Discord deletes every message here,
and clearing all reactions from a message there clears them here. Our own webhook
messages, and Discord's echo of our own edits to them, are never bridged back in.

Discord allows 2000 characters in a message and Harmony 4000, so a longer Harmony
message is split into several Discord messages, breaking at a line or a space where
it can. Files ride on the first part, and the first part is the one mapped to the
Harmony message: edits, deletes and reactions reach it alone. An edit that no longer
fits in it is shortened with a *(continued in Harmony)* note, and the later parts of
a split message keep their original text and are not deleted with it. Messages that
long are rare, and tracking every part would need its own table; this keeps the
mapping one to one.

Custom emoji are matched by name: a Harmony `:YES:` is sent to Discord as its
`<:YES:id>` tag, and a Discord `<:YES:id>` tag is turned back into `:YES:` on the
way in, rendering the Harmony emoji of the same name. Reactions work both ways too.
Mentions sync as well: a Discord `<@id>` becomes a Harmony `@username` (creating a
stand-in account if needed), and mentioning a bridged user in Harmony pings them on
Discord — only bridged users can ever be pinged, so no stray notification escapes.
Channel references cross too: a `#name` becomes a real Discord channel mention
`<#id>` when that channel is bridged here, and a Discord `<#id>` for a bridged
channel becomes `#name` on the way in. A reference with no counterpart on the other
side is left as plain text, the same as an unknown user mention.
Linking a channel, or starting the bridge, backfills the Discord channel's recent
history (bounded, idempotent, oldest first); there is also an **Admin → Bridge**
button to pull it again on demand. Imported history is stored quietly: it is never
broadcast to connected clients as a live `MESSAGE_CREATE`, so a backfill can never
ring a notification sound for a message that was already read. The message itself
is still there, arriving the ordinary way through history fetches and unread marks.
Backfill is kept idempotent by a permanent record of every Discord id the bridge
has accounted for, held apart from the mapping that mirrors edits and deletes.
That record is not removed when a message is deleted or hard-deleted by retention,
so a later backfill recognises the message and skips it instead of resurrecting
content that was removed on purpose.

Two limitations come from mirroring through a single app account: Discord webhooks
cannot post real replies, so a Harmony reply is mirrored as a quoted line, and
Discord has no webhook reaction route at all, so the bot places reactions itself —
they appear as the bot, and one reaction stands in for however many Harmony users
reacted. It is removed once the last Harmony member takes theirs back; Discord
users' own reactions, which Harmony also shows, do not keep it there.

Display names and profile pictures are mirrored to Discord automatically (they
become the webhook username and avatar). A Discord user's name and picture are
imported into Harmony the first time they post, and a stand-in's name follows later
changes as they post again. Since Discord fetches avatars
directly from this instance, outbound avatars need a **Public base URL** set in
**Admin → Bridge** — the address people use to reach the instance from the
internet. A `localhost` address will not work. Leave it blank to send names only.

### Linking a Discord account

A stand-in account exists only so Discord's side of a bridge can be shown and
pinged. When the real person has an account here, an administrator can link the
two by giving the member a **Discord ID** on their account (**Admin → Members →
Edit**). The moment that id is on the member's own row, the mention machinery
already does the right thing: `@username` mirrors out as a real `<@id>` ping,
and an inbound `<@id>` no longer creates a stand-in but resolves to the member.
Only the id on the row matters; no separate link table is needed.

The stand-in that usually already exists for that Discord id is then retired
into the member rather than left beside it. That is the point: without it,
history would show one person twice, an old stand-in name beside the member's
own. `mergeUsers` reassigns everything the stand-in authored or carried —
messages, pictures, reactions, saved gifs, roles, read markers, mentions, bans —
drops the rows that would collide with the member's own, and deletes the
stand-in, all in one transaction. The composite-keyed tables are where the care
is: a reaction both accounts left on the same message, or a role both hold, would
otherwise trip a primary key, so the duplicate is dropped before the rest move.

Assignment is administrator-only unless Discord sign-in is turned on, and that
is deliberate. Typing a Discord id is not proof of owning it, so self-service on
its own would let anyone claim someone else's Discord history. Discord sign-in
closes that gap: it is the same authorization-code flow used to log in, and it
proves the id before `linkDiscord` is called, so a member who connects from their
profile is genuinely the owner. An id another member already holds is refused, and
clearing the link stops future attribution without undoing a merge.

Discord sign-in is optional and off by default; a bridge and a sign-in are
independent, and neither is required to run Harmony. It uses the same Discord
application as the bot, needs a public base URL to derive its callback, and stores
its client secret write-only like the bot token. The flow carries a one-time
`state` and a PKCE verifier held in memory for the few minutes it takes, so a
forged callback cannot land and a leaked code cannot be exchanged without the
verifier. Signing in only finds an account that already carries the Discord id; an
id that only has a stand-in is refused, since a stand-in has no real owner and must
never be signed into.

## Emoji

The picker offers two tabs. **Server** holds the instance's own uploaded emoji and
is the default, since those are the ones a member came here for. **Unicode** holds
the full set, grouped the way Unicode groups it. Search filters whichever tab is
open, matching names case-insensitively; while a search is running the group
headings and the row of common shortcuts step aside, because a handful of results
split across nine headings reads worse than one plain list.

The unicode set comes from the `unicode-emoji-json` package (MIT): the RGI subset,
the emoji likely to render everywhere, with skin tone variants collapsed onto the
emoji they belong to rather than listed as separate entries. It is roughly 277 kB
of JSON, fetched through a dynamic import only when a picker is first opened — so
it is code-split into its own chunk, about 30 kB over the wire, and a session that
never reacts to anything never pays for it. The package ships no types for the
grouped file, so the shape the picker relies on is asserted by the text smoke test
against the package itself, which is what would catch an upgrade changing it into
an empty list with no error anywhere.

**Frequently used.** The client remembers the emoji a member sends in messages,
adds as reactions (adding, not removing) and so on, in `localStorage` under
`harmony:emoji-usage:<user id>`, per device and never sent to the server. Storage
access is guarded and an in-memory copy backs it, so it still works for a session
with storage blocked. `lib/emoji-usage.ts` holds the pure part: up to 36 entries,
each a use count that halves every 14 days (so recency and frequency both count),
custom emoji keyed by id so a rename merges and a deleted one is dropped when
resolved against the live list. The picker shows a **Frequent** tab first when
there is any history, a bare `:` in the composer offers the top few, and a typed
`:query` keeps its order except that used matches float up (stable, so custom
stays ahead of unicode on equal scores).

**Jumbo emoji.** A message that is a single paragraph of nothing but emoji
(custom ones that resolve and/or unicode, whitespace between, at most 27) and has
no attachments is drawn large, as on Discord. `lib/jumbo-emoji.ts` decides, using
`Intl.Segmenter` graphemes so skin tones, ZWJ sequences, flags and keycaps count as
one emoji while bare digits, `#` and `*` do not. Quotes, lists, headers, code and
unknown `:names:` make a message ordinary.

An emoji from another Discord server is the one kind the picker does not offer.
When a bridged message or reaction names an emoji this instance does not have,
the bridge fetches it from Discord's own emoji CDN by its id — the id in the
`<:name:id>` tag is all that is needed — and keeps it as an emoji row of its own,
marked by that Discord id. From then on it renders everywhere an emoji does, in
messages and reactions alike, and a second sighting is reused rather than fetched
again. Those rows are held out of the pickers and the admin list: they are here to
show what crossed the bridge, not to be chosen by hand. A name already in use is
reused, the same rule the guild import follows, so a tag naming an emoji imported
from the guild points at one picture rather than two. Each learned emoji records
when it was last carried by a bridged message or reaction, and the
`externalEmojiRetentionDays` rule ages one out once that goes stale — the only
rule that touches them. The instance's own emoji are kept whatever it says.

## Stickers

Harmony has no stickers of its own, on purpose: Discord webhooks cannot send them,
so there is nothing to mirror out, and a native picker would be half a feature. But
people send them constantly, so a bridged message that carries one is made to show
it. A sticker is not an emoji — it is large, message-level, and cannot be reacted
with — nor quite an attachment, since the same sticker recurs across messages. It
is its own small thing: a shared asset keyed by the Discord sticker id, with the
bytes in the blob store and a `message_stickers` link to each message that sent it,
the same shape as attachments. Serving is by id, and `stickerRetentionDays` ages
one out once no bridged message has carried it, exactly like learned emoji.

Discord serves PNG and APNG stickers as `.png` and GIF ones as `.gif`; both are
stored as pictures. Lottie stickers are vector graphics with no bitmap form, so
they cannot be an `<img>` and are kept as the sticker's name in the message text
instead — the same choice unmirrorable attachments make when they become links.
A Discord sticker link pasted into a message — the `media.discordapp.net/stickers/…`
form the client's copy-link gives — is learned the same way and draws as the
sticker, so it does not sit there as a URL.

## Unread channels

A channel with something new in it is drawn brighter in the sidebar, with a mark down its left edge.
The state behind that is one row per member and channel, holding the time of the newest message they
have seen, and a channel is unread when it holds anything newer.

A **timestamp** rather than a message id, from two constraints. Message ids are random here rather
than ordered, so "newer than this id" means nothing; and history imported from Discord arrives
carrying its original timestamps, so a channel linked today pulls in months of old messages at once.
Against a timestamp, that backfill reads as already seen instead of lighting the whole sidebar up.
The cost is that a message which is genuinely new but was sent long ago — one bridged in late, after
the bridge was down — reads as seen too, which is the lesser of the two annoyances.

Read state is the server's, not the browser's, so it survives a reload and follows a member between
devices. It is also strictly per member: it is not a read receipt, nothing about it is ever shown to
anybody else, and marking a channel read is refused for a channel the member cannot see.

The client keeps the server up to date in three places. Opening a channel marks it at once. A message
arriving in the open channel marks it shortly after, coalesced, because a busy channel would
otherwise mean a request per message. And a tab coming back into view marks the open channel again:
messages that arrived while nobody was looking stayed marked, which is what makes the mark mean
something. Posting marks a channel read on the server side, since whatever else was waiting there has
plainly been seen by whoever just wrote in it.

## Mentions and the inbox

A message that names someone with `@username` or replies to them is recorded for that member in a
`mentions` table as the message is written, one row per message and recipient. The inbox can then be
listed and the red mark beside a channel drawn without ever scanning message text, and a row follows
its message: retention's hard delete takes it along, while a soft delete leaves it for the message's
own deleted filter to hide. A message that both replies to someone and names them is a single entry,
a reply winning; an edit changes nothing, since a mention counts at the moment it is sent, exactly as
the notification does.

Like the read marker, an inbox is one member's own list — it is not a public record of who was
summoned by whom — and it is filtered to the channels the member can see, so a mention in a channel
that has since been locked away disappears from it. Nothing is collected for a member's own message,
and nothing is collected for the Discord stand-in accounts, since they can never sign in.

There is deliberately **no second read cursor**. A mention is unread while the channel it landed in
is unread, so reading the channel — including jumping to the message from the inbox — clears the red
mark and the entry's unread state together. That is why `mentionCounts` in the channel list is just
a count of the mentions newer than each channel's read marker, and `mentionChannelIds` its keys.

The client draws a "new" line and a "new messages since" bar from the same marker, which the channel
list also returns as `readMarkers`. Opening a channel moves the marker at once, so the client takes a
snapshot of it on the way in and keeps the line where it was until the member leaves. Read state is
not broadcast, so reading a channel on one device clears it on another only at that device's next
channel-list refresh (a reconnect or coming back to the tab).

Mutes and notification levels (`channel_settings`, one row per member and channel or category, only
for non-default choices) are deliberately separate from read state: they decide what the client
dims, counts in the tab title and plays a sound for, never what is unread. A channel inherits from
its category on the client, through `resolveChannelSettings` in `packages/shared`, and an expired mute
is read off the clock rather than swept away.

Which messages count as a mention is decided by the same parser that renders them, and the inbox uses
one definition of "aimed at me" throughout: the same check drives the louder notification sound, the
red channel mark, and what the server records, so they cannot disagree. A `#channel` reference is
deliberately not one of these: it is a pointer rather than a summons, so it never reaches an inbox,
and the row the inbox is built from is only ever written for a person.

## Pins

A message is pinned by stamping two columns on its own row, `pinned_at` and `pinned_by`, rather
than through a table of pins. A message can only be pinned once, and only to the channel it is
already in, so a separate table would add a join to every read for nothing: as it is, history,
search and the inbox all carry `Message.pinnedAt` without knowing pins exist. The per-channel list is
a partial index over the pinned rows. Deletion needs no extra handling either — a soft-deleted
message is filtered out of the list and the count like everywhere else. A pin also outlives the age
rules: a pinned message, and a saved one, are what retention deliberately never deletes, because
both are somebody choosing to keep the message. A hand delete still takes the pin with the row.

Pinning needs `ManageMessages`, the same flag that clears other people's reactions, and a channel
holds at most 50 pins, Discord's limit, so a bridged channel's pins can always fit on both sides.
Reading pins follows channel locking exactly as history does. A change is broadcast as a plain
`MESSAGE_UPDATE`, which every client already applies; the pins panel listens for the same event (and
`MESSAGE_DELETE`) to stay current while it is open. Pins and unpins are written to the audit log.

The logic lives in `pins/service.ts`, deliberately shaped like the message service because the
bridge syncs pins with Discord. A local pin or unpin notifies `onPinned` / `onUnpinned`, which the
bridge subscribes to and repeats on Discord; a pin observed on Discord is applied through
`pinBridged` / `unpinBridged`, which skip permission checks and notify no listener, so a pin can
never echo back and forth. Its update is broadcast straight from the pin service, not through the
message service's edit path, so a pin is never mistaken for an edit and mirrored as one. A bridged
pin is audited too, with no actor; the log shows it as made by *Discord*.

### Pin sync with Discord

Only messages the bridge has mapped can be pinned across: Harmony messages it mirrored, and Discord
messages it imported. A pin on anything else is ignored on the Discord side and kept in Harmony.

**Harmony to Discord.** Pinning or unpinning a mapped message calls the bot's pin route on its
Discord copy. This needs the **Pin Messages** permission (Discord's `PinMessages`, split out of
Manage Messages) for the bot in that channel. If Discord refuses, the pin stays in Harmony, nothing
is surfaced to the member, and the failure is written once per channel to the server log as
`bridge_pin_failed`; the next success re-arms the warning. A Discord channel that already holds 50
pins is reported the same way.

**Discord to Harmony.** Discord's `channelPinsUpdate` carries only a timestamp, never which message
changed, and the "pinned a message to this channel" notice is a separate system message. So the bridge
ignores the notice (`DiscordIncomingMessage.system`, set from discord.js's `message.system`; it is
never a person's words) and instead reads the channel's pin list (`GET /channels/:id/messages/pins`)
whenever the event fires. It keeps, in memory, the set of Discord pin ids it has accounted for per
channel, and applies only the difference since the last read: new ids are pinned in Harmony with
`pinBridged` (keeping Discord's pin time), ids that disappeared are unpinned with `unpinBridged`.
Acting on the difference, not on the whole list, is what stops a pin Discord refused from being undone,
or an unpin Discord refused from being re-applied, by some unrelated change later. Reads of one
channel are queued one at a time together with the pin calls we make, and a burst of events folds into
a single read, so the rate limit is not stressed and a read never races our own pin.

**Loops.** `pinBridged` / `unpinBridged` never notify, so a Discord pin cannot go back out. Our own
pin comes back as a `channelPinsUpdate`; the read finds the id already in the record and changes
nothing.

**Cap.** Harmony and Discord both allow 50. A Discord pin that Harmony has no room for is left unpinned
and kept out of the record, so it is tried again on a later pin update once a slot is free.

**Backfill.** When the bridge connects, and again after Discord forces a fresh session (events in the
gap are lost), every bridged channel is read once with no record yet. That first read only adds, in both
directions, up to Discord's 50: Discord pins that Harmony lacks are pinned here, and Harmony pins that
Discord lacks are sent over, oldest first. Without a stored record there is no telling a pin made while
the bridge was away from one that was removed, so an unpin made on one side while the bridge was
offline is undone by the other side's pin. It costs one request per bridged channel plus at most 50
pin calls.

## Polls

A poll is a message whose text is the question, plus three tables (`polls`, `poll_options`,
`poll_votes`, migration 28) that cascade from the message. Making the question the message text
means search, reply quotes, the inbox and notifications need no poll awareness, and a poll message
refuses edits because the options are fixed once people vote. A soft delete keeps the rows and every
read filters the message out like any other; a retention delete takes the poll with it through the
foreign keys.

A vote is one row per person per option, with `poll_id` repeated on it so "has this person voted"
and the distinct-voter count need no join. Casting a vote replaces the caller's whole choice in a
transaction. `mergeUsers` keeps one vote per person when two accounts merge: the survivor's choice
stands in a single-answer poll and the sets are united in a multiple-answer one.

Results are live. A vote or a close broadcasts `POLL_UPDATE` through the hub with the channel's
visibility rules, so a locked channel's polls never reach a member without the role. The payload
carries counts and the actor, not a per-viewer view, in the same way reaction events carry the user:
each client keeps its own `myVotes`. A timer (`polls/service.ts`, every 15 seconds; the smoke test
shortens it with `HARMONY_POLL_SWEEP_MS`) closes polls whose time is up, and a vote that lands after
the time but before the sweep closes the poll itself and is refused. Voting is rate limited per
member.

### Polls across the bridge

What the Discord API allows decides what crosses:

- **Harmony to Discord, the poll itself.** A poll made here is posted to the bridged channel as a
  native Discord poll with the same options, emoji, multiple-answer setting and duration. A webhook
  cannot carry a poll, so the *bot* posts it, with a line above saying whose question it is. A poll
  with no expiry is posted with Discord's longest duration (32 days).
- **Discord to Harmony, the poll itself.** A native poll arrives as a poll message (`source` is
  `discord`) with its options. Only unicode emoji on options are carried; a custom emoji is dropped.
  Text posted with the poll is not carried.
- **Discord to Harmony, votes.** Votes arrive live through the `GuildMessagePolls` intent (not
  privileged, so there is nothing to enable) and are counted under the voter's stand-in account, or
  under the member whose Discord id is linked. When a poll is first read, its existing voters are
  fetched too, up to the 100 per answer that Discord's endpoint returns, so a poll with more voters on
  Discord than that is undercounted here.
- **Harmony to Discord, votes: not possible.** Discord gives a bot no way to vote, so a vote made
  in Harmony never reaches Discord. Discord's own tally shows only Discord voters, while Harmony shows
  the union. This is a limit of the platform, not of the bridge.
- **Closing, both ways.** Ending a Harmony poll by hand ends the Discord poll through the bot (it
  is the poll's author there). Discord closing a poll that was made there closes it here. A poll
  made here is governed by Harmony's clock: Discord's own timer on it, which differs for a poll with
  no expiry, is ignored. A poll made on Discord cannot be ended from Harmony.
- **Deleting** a poll message here deletes the Discord message, as for any other message.

A person is never counted twice. A Discord account linked to a member resolves to that member, so
their Discord vote and their Harmony vote are the same row, and in a single-answer poll the latest
choice from either side replaces the earlier one. There is no loop to guard against beyond the usual
rule: bridged votes and closes go through `voteBridged` / `closeBridged`, which skip permission
checks and notify no listener, and only a local early end notifies the bridge. The poll's Discord
message is also recorded in the permanent seen-set, like any other mirrored message. Reading a
Discord poll for the first time records every existing voter quietly and then sends one
`POLL_UPDATE` (`announceBridged`), so a large poll does not flood the gateway with one frame per vote.

## Saved messages

A save is one member's bookmark, so it lives in a table keyed by member and message rather than on
the message, and a row may carry a `remind_at` to turn it into a reminder. The list is filtered by
what the member may still see, so a message they can no longer reach drops out without the row being
removed. Unsaving deletes the row.

Saved messages share the pin's exemption from age-based retention: a message somebody kept is not
something a retention sweep should take away. The exemption is a single SQL fragment,
`EXEMPT_MESSAGE_IDS_SQL` in `db/messages.ts`, that both the message deletes and the attachment rules
in `db/attachments.ts` apply, so a pinned or saved message and its pictures and clips survive image,
video and message retention and are spared by emergency pruning too. They go only when the message
itself is deleted by its author or a moderator, which cascades the save away.

## Scheduled messages

A scheduled message is one member's queued post, in `scheduled_messages` (with its uploads in
`scheduled_message_attachments`). `scheduled/service.ts` owns a timer: one `setInterval` tick (10 s,
`HARMONY_SCHEDULED_TICK_MS`) that also runs once at startup to catch up on anything that came due while
the server was down. Delivery calls the same `MessageService.create` as a hand-sent message, with an
auth context rebuilt from the author's current roles, so channel visibility, Send Messages, timeouts,
bans and slowmode are all checked at send time. The claim is atomic: the queue row is deleted inside
the transaction that inserts the message (the node:sqlite calls are synchronous, so nothing interleaves),
and a failure rolls both back, which is why a message is never sent twice and a crash loses nothing.
A permanent failure leaves the row as `failed` with a reason and notifies the owner's sessions; slowmode
is treated as a wait and retried for five minutes. Uploads linked from the queue are excluded from the
"abandoned upload" and age rules in `db/attachments.ts`, and `MessageService` refuses to attach them to
any other message. `mergeUsers` re-owns the rows; deleting a channel or user cascades them away.

On the client, `lib/scheduled.svelte.ts` only mirrors the queue (it loads the list and follows
`SCHEDULED_MESSAGE_UPDATE`); nothing is timed in the browser, so a message goes out whether or not a tab
is open. The pure parts (reading the typed time with the same parser the composer's `@` timestamps use,
checking it, describing it in the member's own zone) are in `lib/schedule-time.ts` and covered by the
text smoke test. The composer opens `SchedulePicker` from the chevron by Send, the + menu or
Ctrl+Shift+Enter, and `ScheduledPanel` (header clock button, with a count badge) lists, edits, sends
and deletes entries, failed ones included.

## Notification sounds

Two sounds ship with the client, in `apps/web/public/sounds`: a louder one for a
message that mentions the member, by reply or by name, and a quieter one for the
rest. Each member can silence either from **Notifications** in their profile.
Both are on by default.

There is no push and no device notification anywhere in the project. Nothing leaves
the page: no service worker involvement, no permission prompt, no server doing any
delivery. That keeps the feature small and keeps a self-hosted instance from
needing certificate or vendor setup to nudge anybody, at the cost of only working
while a client is open. The server therefore stores two booleans and nothing else —
what the sound actually is, and when it plays, is the client's business.

Which messages count as a mention is decided by the same parser that renders them,
so a name inside a backtick block is a quotation rather than a summons.

## Slash helpers

Typing `/` as the first character of the message box opens the same suggestion popup that `:`, `@` and
`#` use, listing `/shrug`, `/tableflip`, `/unflip`, `/lenny`, `/me <text>` and `/spoiler <text>`. They
are client-side text transforms in `apps/web/src/lib/slash-commands.ts`, applied when the message is
sent; the server never sees the command, only the finished text. (The shrug is sent as escaped
Markdown, `¯\\\_(ツ)\_/¯`, exactly as Discord's own client does, because its backslash and underscores
would otherwise be eaten and the face italicized.) The first four append an emoticon to
whatever follows the command word, `/me` sends the text in italics (one emphasis run per line, since
italics do not cross a line break) and `/spoiler` wraps it in `||`. A command only counts when the first
word is exactly a known lowercase name followed by whitespace or the end of the text, so `/foo`,
`/usr/bin` and `/shrugged` go out untouched, and a leading `\/` sends a literal slash. `/me` and
`/spoiler` with nothing after them are left as typed.

## Links and media

A message's first link is resolved, and a small card is stored on the message. A link that points
straight at a picture is different: the bytes are fetched once and kept as an attachment of that
message, with the link it came from in the attachment's `source_url` column.

That column is what makes the rest work. It marks the attachment as having come from the text rather
than from the sender, which is how an edit knows to take the picture away again when the link goes,
how the bridge knows not to hand Discord a file for a link Discord can unfurl itself, and how a
resolution is skipped when the link has not actually changed. Anything with a null `source_url` was
uploaded by a person and belongs to the message; anything else is a copy of somebody else's file and
follows the text.

A message whose whole text is that link shows the picture and nothing else, the way Discord does: the
address is behind the picture for anyone who wants it, and printing it above would only be noise. A
message with anything else in it keeps its text, link and all. The picture itself links back to where
it came from, so the original is one right-click away.

The page half of this has one wrinkle worth knowing. A page may offer several preview images and they
are not equal — Giphy and Klipy both list a still WebP first and the animated GIF second — so the
animated one is preferred, recognized either from the `og:image:type` that follows it or from the
address itself. A reader that takes the first one gets a frozen picture, which is most of why a gif
link used to preview badly.

Giphy is handled a step earlier still. Its pages are not scraped at all: `giphy.com/gifs/…` and
`giphy.com/embed/…` are handed to Giphy's keyless oEmbed endpoint, which answers with the address of
the file itself. That address is then fetched by the ordinary guarded path, so a gif page behaves
exactly like a link straight at a gif and is kept as an attachment with no card. No account and no
key is involved, which is the rule this project holds to for every provider it recognizes.

Tenor and Klipy have no such endpoint, so their pages are read instead: both name the gif in their own
preview metadata, and that address is fetched by the same guarded path and kept the same way. The two
differ only in access — Tenor serves its pages to anyone, while Klipy puts them behind a Cloudflare
challenge and hands them over to a recognized crawler name alone. That is precisely what the opt-in
`previewUserAgent` setting is for, and why Klipy page links preview only once it is set.

A link in angle brackets (`<https://example.com>`) is suppressed, as on Discord. The shared
`listEmbeddableUrls` skips it, so the resolver finds nothing, and the client's parser draws it as a
plain link without the brackets. The bridge used to strip the brackets from incoming Discord text so
the link would unfurl here; it now keeps them, which is also what makes a suppressed link round-trip
(Harmony sends the text to Discord as written, and Discord's own edits come back the same way). The
manual counterpart, Remove embeds, sets `messages.embeds_hidden` (migration 30), which the resolver
checks before doing anything, so the flag outlives edits. It drops the card and any fetched picture,
and is not mirrored to Discord.

A Discord attachment link needs a different trick again, because the address itself is the problem:
Discord signs it and the signature expires, so a link copied out of the client usually arrives already
dead. Discord has an endpoint of its own for exactly this — the one its clients call to renew an
address — and when the bridge is connected the server asks it for a live address, which the ordinary
guarded path then fetches and keeps. It signs any attachment address, including one in a channel or a
server the bot has no access to, so nothing about where the file lives matters. Nothing is stored
when the bridge is off, which is why the feature costs an instance with no Discord presence nothing.

One detail is behind a surprising amount of the earlier unreliability: the fetch says it wants an
image first and only falls back to a page (`Accept: image/*, text/html;q=0.9`), rather than the other
way round. Giphy serves its media host by content negotiation on a single address — ask for `image/*`
and it returns the gif, ask for HTML and it returns a web page — so a client that asks for HTML first
is told about the gif it wanted and then wraps it in a card instead of showing it. Asking for the
picture first costs nothing when the answer really is a page, since that is still read exactly as
before.

It also makes the second and later postings of the same link free. Blobs are content-addressed, so
the bytes were only ever stored once; the row is what is per-message, and a row is a few hundred
bytes. What the column adds is the ability to notice before fetching that this instance already holds
the file, so a gif posted every morning is downloaded on the first morning and copied from the shelf
on every morning after. The trade is that a link is assumed to keep pointing at what it pointed at
the first time, which is how Discord, Slack and every other client treats them too.

The two also differ in what happens when they cannot be had. An image too large for the instance's
owner-configured upload limit is left as a card pointing at it through the proxy, rather than being
stored; a page's preview image is always only a reference. Nothing is kept that an upload of the same
file would have been refused.

## Saved gifs

A saved gif is held by content hash, in its own table, rather than by an attachment row. That is the
whole point: an attachment belongs to its message and is deleted along with it, and a saved gif has to
outlive the message it was found in. Keeping the hash instead means the bytes are shared with every
other copy of the same gif on the instance — saving one costs a row and nothing else.

It is also what keeps the bytes alive. The sweep deletes a blob only once nothing references it, and
that list of references now includes saved gifs alongside attachments, emoji, avatars and the
instance icon. So the image and message rules can take the attachment and the message away and the
blob stays, because a saved gif is still pointing at it.

That leaves the question of what eventually clears a saved gif up, and the answer is deliberately
one rule and no other: `favoriteRetentionDays`, counted from `used_at`, which moves whenever the gif
is saved or sent. `null` keeps them forever, which is the default — an instance that never turns the
rule on never loses one. Everything else the owner might set, including emergency pruning, leaves
them alone.

Picking a gif out of the picker is not a copy and not a fetch. It writes one attachment row pointing
at bytes that are already stored, owned by the person picking, and the message then claims it exactly
as it would an upload. That keeps a picked gif the same kind of thing as everything else in a message
— retention, the media gallery and the bridge already understand it — and makes picking instant.

The picker's other tab, This server, is a listing rather than a store: it reads recent gif
attachments, keeps one per content hash, and drops any channel the caller cannot see, through the
same role-aware helper the sidebar uses. The read is deliberately bounded to a few times the page
size, because the same handful of gifs get sent again and again and the rows far outnumber the
pictures — a bounded scan still fills a page with distinct gifs. What counts as a gif lives in one
place, the shared package's GIF_CONTENT_TYPES, and decides the listing, the hearts and what may be
saved alike; a screenshot is stored and shown like anything else but never turns up in a picker.

The hosted tab is the one part of the picker that talks to somebody else, and it only appears when
the instance has a key for it. Its search is asked for by the server and never by the browser,
because the key is part of the request path and would otherwise be readable by anyone who opens
their network tab. Nothing is stored until a gif is saved or picked, at which point the address is
fetched through the same guarded path a link preview uses and kept like anything else — so a hosted
gif becomes ours rather than a link that can expire under it. Only the service's own addresses are
accepted, which keeps the picker from becoming a way to make the server fetch arbitrary pages.

The grid loads its tiles through that same path rather than from the service directly. The instance's
policy only lets the page load its own images, so a tile pointing straight at a third party is simply
refused by the browser — which is how a picker can work perfectly in development, where the client is
served by Vite with no such policy, and show nothing at all in production. Fetching through the server
is what the policy allows, and it has the happy side effect that browsing the picker does not hand
Klipy every member's address. One consequence is worth knowing: the tile and the copy that is kept are
not the same file, because a grid of full-size gifs would be megabytes through the instance's own
connection for every search.

## Gif storage: store or link

By default every gif is brought home: a picked Klipy result or a pasted gif address is downloaded and
kept as a content-addressed blob. That is the right default for a community instance: members' IP
addresses never reach a third party, a gif survives its source disappearing, and retention, the media
gallery and the bridge all keep working on files that are really here. The cost is disk and the
download.

The admin setting `gifStorage` (Settings, Gifs) lets an owner trade that away: in `link` mode a gif on
an allowlisted gif host is not downloaded; the message just points at it. The trade-offs, which the
admin help text also states:

- **Privacy.** Every viewer's browser contacts the gif host, which sees their IP address and, for the
  duration of the request, that they opened Harmony. `Referrer-Policy: no-referrer` stops it learning
  the channel. Store mode leaks nothing.
- **Durability.** A linked gif disappears when the host removes it or changes its address. Tenor's API
  is shutting down on 30 June 2026 although `media.tenor.com` keeps serving existing addresses; Klipy
  is the hosted service the picker uses. Store mode is immune.
- **Cost.** Link mode saves disk and one download per new gif.
- **Safety.** Hotlinking is the risky half, so it is narrow. The allowlist is in
  `packages/shared/src/gif-hosts.ts`, matched on the parsed URL (https, default port, no credentials,
  exact host or real subdomain), and is used in four places that must agree: the server's check, the
  parse of stored embeds (a hand-edited row cannot name another host), the client before it draws
  anything, and the Content-Security-Policy. Nothing outside the list is ever linked, and a Discord
  CDN link is never on it: those addresses are signed with `ex`/`is`/`hm` parameters and expire in
  about a day, so the bridge keeps downloading and storing them.

How it works without a new table: a linked gif is an ordinary embed. The message text is the gif's
address, and when the embed resolver sees an allowlisted address in link mode it calls
`verifyLinkedGif` (`embeds/linked-gif.ts`) and, if that passes, stores `LinkEmbed.gif`
(`{ contentType, width, height }`) on the message's `embed` column with the gif's address as the embed
`url`. The check goes through the same public-address guard as every outbound fetch, follows no
redirects at all (so the file cannot live anywhere the allowlist did not see), requires a gif-like
content type (GIF, animated WebP, MP4, WebM) and applies the instance's own image or video size limit.
A host that fails any of it simply falls back to the stored path. The size comes from the host's
`Content-Length` and the file is not downloaded, so a host that lies about it is trusted for the
size only; it still cannot serve anything the allowlist does not name. Order of preference when a
message arrives: a copy already stored here (free, and private), then a link, then a download.

The picker keeps its tile previews going through the server's media proxy, so browsing the picker
reveals nothing either way; only a gif that is actually sent is hotlinked. In link mode picking a
Klipy result calls `POST /api/v1/gifs/link`, which runs the same check and hands back the address,
and the composer inserts it as text. Favorites, the This server tab and `gifs/pick` are untouched:
they are stored bytes, and saving a hosted gif to favorites still keeps a copy.

The Content-Security-Policy is built per response (`http/security.ts`): only the built-in policy is
widened, only `img-src` and `media-src`, only while the mode is on. It is read per page load, so a
client with the app already open needs a reload after the setting changes. A custom `HARMONY_CSP` is
never modified. Switching back to `store` leaves existing linked embeds in the database; clients stop
drawing them (and the browser would refuse them anyway) and the address shows as plain text.

The bridge needs nothing: a message is text plus the embed, and a linked gif's text is just the
address, so Discord unfurls it itself. Incoming Discord links to an allowlisted host are linked the
same way in link mode.

## Server log

The server log (`server_log`, written through `log/service.ts`) is the instance's own record of
what it did and where it failed, kept apart from the audit log, which records what people did. It
surfaces an unhandled request error, a retention run that failed, a backup that could not be
prepared, a bridge connect or stop, a failed sync to Discord and a channel link, so the owner can
see them in the admin panel without reading the process log.

Reading it is **owner-only**, not `ManageServer`: an entry can carry a filesystem path, a failed
SQL statement or the address a request was made to, which a moderated administrator should not
necessarily see.

Everything is sanitized before it is stored. `log/sanitize.ts` redacts the value after a secret
key (`bearer`, `token`, `password`, `secret`, `authorization`, `api_key` and the like, in
`key: value` or `key=value` form) and the three-segment Discord bot-token shape, caps a message at
500 characters and a sanitized detail at about 2 KB, and recurses into nested detail with a depth
cap. A repeated warning or error is coalesced onto one row within five minutes, tracked by `count`
and bracketed by `first_at`/`last_at`; informational events are never coalesced. The
`serverLogRetentionDays` rule ages entries out through the same pruner as the audit log, and the
owner can clear the log outright.

## Versioning

The release number lives in one place, `HARMONY_VERSION` in
`packages/shared/src/constants.ts`, and is what the About panel shows when a member
clicks the server name. It is deliberately not read from a `package.json`: nothing
in this repository is published to a registry, so a second number that has to be
kept in step would only be a way for the two to disagree.

Patch versions are for fixes, minor versions for features. The major number is the
owner's to raise, because it is the one that signals a break to people running an
instance.

The number is compiled into the web bundle, so an installed app that has not
reloaded since an update reports the version it was built with. The service worker
caches nothing, so one reload corrects it.

## License

Harmony is free software, licensed under the
[GNU Affero General Public License v3.0 or later](../LICENSE).
