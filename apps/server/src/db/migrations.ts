import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { EVERYONE_PERMISSIONS, isGifLinkUrl, permissionsToString } from '@harmony/shared';
import { normalizeGifSourceUrl } from '../gifs/source-url.ts';

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

/**
 * Ordered, append-only list of schema migrations. Each entry runs once and is
 * recorded in `schema_migrations`. Never edit a shipped migration; add a new
 * one instead so existing installations migrate cleanly.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up(db) {
      db.exec(`
        CREATE TABLE users (
          id            TEXT PRIMARY KEY,
          username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
          display_name  TEXT,
          password_hash TEXT NOT NULL,
          avatar_hash   TEXT,
          is_bot        INTEGER NOT NULL DEFAULT 0,
          is_owner      INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL
        );

        CREATE TABLE sessions (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash   TEXT NOT NULL UNIQUE,
          user_agent   TEXT,
          created_at   TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          expires_at   TEXT
        );
        CREATE INDEX idx_sessions_user ON sessions(user_id);

        CREATE TABLE roles (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          color       INTEGER,
          position    INTEGER NOT NULL DEFAULT 0,
          permissions TEXT NOT NULL DEFAULT '0',
          hoist       INTEGER NOT NULL DEFAULT 0,
          mentionable INTEGER NOT NULL DEFAULT 0,
          is_default  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL
        );

        CREATE TABLE member_roles (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
          PRIMARY KEY (user_id, role_id)
        );

        CREATE TABLE categories (
          id       TEXT PRIMARY KEY,
          name     TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE channels (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          topic       TEXT,
          type        TEXT NOT NULL DEFAULT 'text',
          category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
          position    INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL
        );

        CREATE TABLE messages (
          id         TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          author_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
          content    TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          edited_at  TEXT,
          deleted_at TEXT
        );
        CREATE INDEX idx_messages_channel_created ON messages(channel_id, created_at);

        CREATE TABLE attachments (
          id           TEXT PRIMARY KEY,
          message_id   TEXT REFERENCES messages(id) ON DELETE CASCADE,
          uploader_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
          filename     TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size         INTEGER NOT NULL,
          width        INTEGER,
          height       INTEGER,
          hash         TEXT NOT NULL,
          created_at   TEXT NOT NULL
        );
        CREATE INDEX idx_attachments_message ON attachments(message_id);
        CREATE INDEX idx_attachments_hash ON attachments(hash);

        CREATE TABLE emojis (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL UNIQUE,
          hash       TEXT NOT NULL,
          animated   INTEGER NOT NULL DEFAULT 0,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE invites (
          code       TEXT PRIMARY KEY,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          max_uses   INTEGER,
          uses       INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE server_settings (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      // Every instance starts with the implicit @everyone role.
      db.prepare(
        `INSERT INTO roles (id, name, position, permissions, is_default, created_at)
         VALUES ('everyone', '@everyone', 0, ?, 1, ?)`,
      ).run(permissionsToString(EVERYONE_PERMISSIONS), new Date().toISOString());
    },
  },
  {
    version: 2,
    name: 'default_category_and_channel',
    up(db) {
      // Seed Discord's familiar starting point, but only on a fresh instance.
      const existing = db.prepare('SELECT COUNT(*) AS count FROM channels').get() as { count: number };
      if (existing.count > 0) return;

      const categoryId = randomUUID();
      db.prepare('INSERT INTO categories (id, name, position) VALUES (?, ?, 0)').run(
        categoryId,
        'Text Channels',
      );
      db.prepare(
        `INSERT INTO channels (id, name, type, category_id, position, created_at)
         VALUES (?, 'general', 'text', ?, 0, ?)`,
      ).run(randomUUID(), categoryId, new Date().toISOString());
    },
  },
  {
    version: 3,
    name: 'emoji_content_type',
    up(db) {
      // Needed to serve emoji images with the right Content-Type.
      db.exec(`ALTER TABLE emojis ADD COLUMN content_type TEXT NOT NULL DEFAULT 'image/png'`);
    },
  },
  {
    version: 4,
    name: 'discord_bridge',
    up(db) {
      db.exec(`
        ALTER TABLE channels ADD COLUMN discord_channel_id TEXT;
        ALTER TABLE channels ADD COLUMN discord_webhook_id TEXT;
        ALTER TABLE channels ADD COLUMN discord_webhook_token TEXT;
        ALTER TABLE users ADD COLUMN discord_id TEXT;

        CREATE UNIQUE INDEX idx_channels_discord
          ON channels(discord_channel_id) WHERE discord_channel_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_users_discord
          ON users(discord_id) WHERE discord_id IS NOT NULL;

        CREATE TABLE bridge_messages (
          harmony_message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          discord_message_id TEXT NOT NULL,
          created_at         TEXT NOT NULL
        );
        CREATE INDEX idx_bridge_messages_discord ON bridge_messages(discord_message_id);
      `);
    },
  },
  {
    version: 5,
    name: 'message_replies',
    up(db) {
      // A reply points at its parent; if the parent is ever hard-deleted
      // (retention), the reply simply becomes a normal message.
      db.exec(`ALTER TABLE messages ADD COLUMN reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL`);
    },
  },
  {
    version: 6,
    name: 'message_reactions',
    up(db) {
      db.exec(`
        CREATE TABLE reactions (
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          /* A unicode character, or ':name:' for a custom emoji. */
          emoji      TEXT NOT NULL,
          /* The custom emoji id, for custom emoji only. */
          emoji_id   TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (message_id, user_id, emoji)
        );
        CREATE INDEX idx_reactions_message ON reactions(message_id);
      `);
    },
  },
  {
    version: 7,
    name: 'moderation',
    up(db) {
      db.exec(`
        /* An active timeout, or NULL when the user is not timed out. */
        ALTER TABLE users ADD COLUMN timed_out_until TEXT;

        CREATE TABLE bans (
          user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          banned_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
          reason     TEXT,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 8,
    name: 'user_typing_preference',
    up(db) {
      /* 1 means typing indicators are on, which is the default for everyone. */
      db.exec(`ALTER TABLE users ADD COLUMN show_typing INTEGER NOT NULL DEFAULT 1`);
    },
  },
  {
    version: 9,
    name: 'message_embeds',
    up(db) {
      /* The unfurled link preview as JSON, or NULL when there is none. */
      db.exec(`ALTER TABLE messages ADD COLUMN embed TEXT`);
    },
  },
  {
    version: 10,
    name: 'channel_roles',
    up(db) {
      db.exec(`
        /* A role required to see a channel; NULL means open to everyone. */
        ALTER TABLE channels ADD COLUMN required_role_id TEXT REFERENCES roles(id) ON DELETE SET NULL;
        /* A required role on a category covers every channel inside it. */
        ALTER TABLE categories ADD COLUMN required_role_id TEXT REFERENCES roles(id) ON DELETE SET NULL;
      `);
    },
  },
  {
    version: 11,
    name: 'audit_log',
    up(db) {
      db.exec(`
        CREATE TABLE audit_log (
          id         TEXT PRIMARY KEY,
          kind       TEXT NOT NULL,
          /* Who acted, and who it happened to. Set NULL when that account goes. */
          actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
          target_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
          channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
          /* Kind-specific fields as JSON, e.g. the text before an edit. */
          detail     TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
      `);
    },
  },
  {
    version: 12,
    name: 'channel_slowmode',
    up(db) {
      /* Seconds a member must wait between messages; 0 means slowmode is off. */
      db.exec(`ALTER TABLE channels ADD COLUMN slowmode_seconds INTEGER NOT NULL DEFAULT 0`);
    },
  },
  {
    version: 13,
    name: 'user_notification_sounds',
    up(db) {
      /*
       * The two in-app notification sounds. Both default to on, and neither is
       * about device notifications: nothing is ever pushed off the page.
       */
      db.exec(`
        ALTER TABLE users ADD COLUMN notify_major INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE users ADD COLUMN notify_minor INTEGER NOT NULL DEFAULT 1;
      `);
    },
  },
  {
    version: 14,
    name: 'attachment_source_url',
    up(db) {
      /*
       * The link an attachment was copied from, when it was fetched rather than
       * uploaded. NULL for anything someone actually attached themselves, which
       * is how the two are told apart: a linked image is kept in step with the
       * message's text, while an upload belongs to the message and stays.
       */
      db.exec(`ALTER TABLE attachments ADD COLUMN source_url TEXT`);
    },
  },
  {
    version: 15,
    name: 'gif_favorites',
    up(db) {
      /*
       * A gif somebody kept, held by content hash rather than by any message.
       * That is the whole point: a favorite has to outlive the message it was
       * found in, so it cannot be a reference to an attachment row, which is
       * deleted along with its message. `used_at` is what the retention rule for
       * favorites counts from, and it moves when the gif is favorited or sent.
       */
      db.exec(`
        CREATE TABLE gif_favorites (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          hash         TEXT NOT NULL,
          filename     TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size         INTEGER NOT NULL,
          width        INTEGER,
          height       INTEGER,
          source_url   TEXT,
          created_at   TEXT NOT NULL,
          used_at      TEXT NOT NULL,
          UNIQUE(user_id, hash)
        );
        CREATE INDEX idx_gif_favorites_user ON gif_favorites(user_id, used_at DESC);
        CREATE INDEX idx_gif_favorites_hash ON gif_favorites(hash);
      `);
    },
  },
  {
    version: 16,
    name: 'channel_reads',
    up(db) {
      /*
       * How far each member has read each channel, which is what makes a channel
       * with something new in it stand out in the sidebar. It is deliberately a
       * timestamp rather than a message id: ids here are random rather than
       * ordered, and history imported from Discord arrives with its original
       * timestamps, so an old import reads as already seen instead of lighting a
       * channel up with months of backfill. Only the member it belongs to ever
       * sees it; it is not a read receipt and nobody else can tell.
       */
      db.exec(`
        CREATE TABLE channel_reads (
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          read_at    TEXT NOT NULL,
          PRIMARY KEY (user_id, channel_id)
        );
      `);
    },
  },
  {
    version: 17,
    name: 'mentions',
    up(db) {
      /*
       * Every message that named or replied to a member, recorded as the message
       * is written so the inbox can be listed and its badge drawn without ever
       * scanning message text. Rows follow their message: a hard delete
       * (retention) takes them along, while a soft delete leaves them for the
       * message's own deleted filter to hide.
       *
       * Like the read marker, this is one member's own list and nobody else's
       * business: it is not a public record of who was summoned by whom.
       */
      db.exec(`
        CREATE TABLE mentions (
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          /* Denormalized so a per-channel lookup needs no join onto the message. */
          channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          /* 'mention' when named, 'reply' when the message answered theirs. */
          kind       TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (message_id, user_id)
        );
        CREATE INDEX idx_mentions_user_created ON mentions(user_id, created_at DESC);
        CREATE INDEX idx_mentions_user_channel ON mentions(user_id, channel_id);
      `);
    },
  },
  {
    version: 18,
    name: 'bridge_seen',
    up(db) {
      /*
       * Every Discord message id the bridge has ever accounted for, whether it
       * was imported from Discord or sent there by us on a member's behalf. It
       * exists because bridge_messages cannot answer "have I seen this before?"
       * on its own: that mapping is deleted when a message is deleted, and is
       * cascaded away when retention hard-deletes one, so a backfill would keep
       * re-importing content that had deliberately been removed. This record is
       * never deleted with a message, so a re-fetched Discord id is recognised
       * and skipped however the Harmony message it once mapped to went away.
       *
       * Rows are a snowflake id and a timestamp - a few dozen bytes - so keeping
       * them for the life of the instance is cheap, and it is what makes pruning
       * and deletion stick. Existing mappings are seeded so an upgrade keeps the
       * dedup it already had.
       */
      db.exec(`
        CREATE TABLE bridge_seen (
          discord_message_id TEXT PRIMARY KEY,
          first_seen_at      TEXT NOT NULL
        );
      `);
      db.exec(`
        INSERT OR IGNORE INTO bridge_seen (discord_message_id, first_seen_at)
        SELECT discord_message_id, created_at FROM bridge_messages
      `);
    },
  },
  {
    version: 19,
    name: 'external_emojis',
    up(db) {
      /*
       * A custom emoji learned from a Discord message: one from another server,
       * or any emoji this guild does not have here. It is kept as an ordinary
       * emoji row so it renders and reacts through the same code everywhere,
       * marked by the Discord id it came from. Those rows are held out of the
       * pickers: they exist to display what crossed the bridge, not to be picked
       * by hand. The partial unique index keeps one row per Discord emoji without
       * disturbing the emoji added here, which have no Discord id.
       */
      db.exec(`ALTER TABLE emojis ADD COLUMN discord_id TEXT`);
      db.exec(`CREATE UNIQUE INDEX idx_emojis_discord ON emojis(discord_id) WHERE discord_id IS NOT NULL`);
    },
  },
  {
    version: 20,
    name: 'emoji_used_at',
    up(db) {
      /*
       * When an emoji learned from Discord was last seen in a bridged message,
       * which is what the learned-emoji retention rule counts from. It is only
       * meaningful for those rows: the instance's own emoji are never aged out,
       * so they keep a null here. Existing learned emoji start from when they
       * were stored, which is the best guess available.
       */
      db.exec(`ALTER TABLE emojis ADD COLUMN used_at TEXT`);
      db.exec(`UPDATE emojis SET used_at = created_at WHERE discord_id IS NOT NULL`);
    },
  },
  {
    version: 21,
    name: 'stickers',
    up(db) {
      /*
       * Stickers learned from Discord. Harmony has no stickers of its own, so
       * this only ever holds ones a bridged message carried: a shared asset,
       * keyed by the Discord sticker id, that many messages can point at. The
       * bytes live in the blob store like an emoji's, and `used_at` is what the
       * sticker retention rule counts from. `message_stickers` is the link, the
       * same shape as attachments: a hard delete takes it, so a pruned sticker
       * or message simply drops off.
       */
      db.exec(`
        CREATE TABLE stickers (
          id                 TEXT PRIMARY KEY,
          discord_sticker_id TEXT NOT NULL UNIQUE,
          name               TEXT NOT NULL,
          hash               TEXT NOT NULL,
          content_type       TEXT NOT NULL,
          animated           INTEGER NOT NULL DEFAULT 0,
          created_at         TEXT NOT NULL,
          used_at            TEXT NOT NULL
        );

        CREATE TABLE message_stickers (
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          sticker_id TEXT NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
          position   INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (message_id, sticker_id)
        );
        CREATE INDEX idx_message_stickers_message ON message_stickers(message_id);
      `);
    },
  },
  {
    version: 22,
    name: 'role_badge',
    up(db) {
      /*
       * The badge a role confers on its members, drawn beside their name. Only
       * `moderator` is a role's to give: the owner badge comes from the account
       * flag and the admin one from the Administrator permission, so a role
       * saying so would be redundant. Most roles carry none.
       */
      db.exec(`ALTER TABLE roles ADD COLUMN badge TEXT NOT NULL DEFAULT 'none'`);
    },
  },
  {
    version: 23,
    name: 'message_pins',
    up(db) {
      /*
       * Pinned messages. A message is pinned at most once, to the channel it
       * already belongs to, so the pin is two columns on the message rather than
       * a table of its own: every query that reads a message (history, search,
       * the inbox) carries the pin state for free, and a retention delete takes
       * the pin with the row. A soft-deleted message keeps its columns but is
       * filtered out of the pin list, as it is everywhere else. Whoever pinned it
       * is kept for the record and cleared if their account goes. The partial
       * index serves the per-channel pin list and its count, and stays as small
       * as the pins themselves.
       */
      db.exec(`ALTER TABLE messages ADD COLUMN pinned_at TEXT`);
      db.exec(`ALTER TABLE messages ADD COLUMN pinned_by TEXT REFERENCES users(id) ON DELETE SET NULL`);
      db.exec(`CREATE INDEX idx_messages_pinned ON messages(channel_id, pinned_at) WHERE pinned_at IS NOT NULL`);
    },
  },
  {
    version: 24,
    name: 'channel_settings',
    up(db) {
      /*
       * Each member's mute and notification choices for a channel or a category.
       * A row names exactly one of the two, each through its own foreign key, so
       * deleting the channel or category takes the row with it rather than
       * leaving a setting for something that is gone. Only rows that differ from
       * the defaults are kept: undoing everything deletes the row.
       *
       * `muted` and `mute_ends_at` together describe a mute: an end in the past
       * simply means it has lifted, which is read off the clock rather than
       * swept, so nothing has to run for a mute to end on time. A null end with
       * `muted` set lasts until the member turns it off.
       *
       * Like the read marker this is one member's business and nobody else's.
       */
      db.exec(`
        CREATE TABLE channel_settings (
          user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          channel_id   TEXT REFERENCES channels(id) ON DELETE CASCADE,
          category_id  TEXT REFERENCES categories(id) ON DELETE CASCADE,
          muted        INTEGER NOT NULL DEFAULT 0,
          mute_ends_at TEXT,
          level        TEXT NOT NULL DEFAULT 'default',
          updated_at   TEXT NOT NULL,
          CHECK ((channel_id IS NULL) <> (category_id IS NULL))
        );
        CREATE UNIQUE INDEX idx_channel_settings_channel
          ON channel_settings(user_id, channel_id) WHERE channel_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_channel_settings_category
          ON channel_settings(user_id, category_id) WHERE category_id IS NOT NULL;
      `);
    },
  },
  {
    version: 25,
    name: 'saved_messages',
    up(db) {
      /*
       * Messages a member saved for later, Discord's bookmarks. Unlike a pin this
       * is one person's own list, so it is a table keyed by member and message
       * rather than a column on the message. Either going takes the save with it:
       * a retention delete or a deleted account leaves nothing dangling. A soft
       * delete keeps the row, and the list filters it out like every other read,
       * so a message nobody can see any more simply stops showing.
       *
       * `remind_at` turns a save into a reminder; most saves have none. The
       * partial index serves the "what is due next" question without growing
       * with the plain saves.
       */
      db.exec(`
        CREATE TABLE saved_messages (
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          saved_at   TEXT NOT NULL,
          remind_at  TEXT,
          PRIMARY KEY (user_id, message_id)
        );
        CREATE INDEX idx_saved_messages_user_saved ON saved_messages(user_id, saved_at DESC);
        CREATE INDEX idx_saved_messages_message ON saved_messages(message_id);
        CREATE INDEX idx_saved_messages_remind ON saved_messages(user_id, remind_at) WHERE remind_at IS NOT NULL;
      `);
    },
  },
  {
    version: 26,
    name: 'server_log',
    up(db) {
      /*
       * The instance's own log: what the server did, and where it failed. It is
       * distinct from the audit log, which records what *people* did. A repeated
       * error is coalesced onto one row rather than written per occurrence:
       * count and first_at/last_at bracket the run, so a crash loop cannot fill
       * the table. The indexes serve the newest-first listing and the level
       * filter the owner may narrow it to.
       */
      db.exec(`
        CREATE TABLE server_log (
          id       TEXT PRIMARY KEY,
          level    TEXT NOT NULL,
          event    TEXT NOT NULL,
          message  TEXT NOT NULL,
          detail   TEXT,
          count    INTEGER NOT NULL DEFAULT 1,
          first_at TEXT NOT NULL,
          last_at  TEXT NOT NULL
        );
        CREATE INDEX idx_server_log_last_at ON server_log(last_at DESC);
        CREATE INDEX idx_server_log_level ON server_log(level);
      `);
    },
  },
  {
    version: 27,
    name: 'scheduled_messages',
    up(db) {
      /*
       * Messages a member scheduled to be sent later, which the server delivers
       * itself so they go out with every tab closed. One member's private list,
       * like saved_messages: either the member or the channel going takes their
       * rows with it.
       *
       * `send_at` is epoch milliseconds, since the scheduler compares it against
       * the clock. `status` is pending or failed (due but undeliverable, with
       * the reason in `error`). A row is deleted in the same transaction
       * that inserts the real message, so a delivery either happened completely
       * or not at all and a message cannot go out twice. `reply_to_id` is not a
       * foreign key on purpose: a parent that was deleted meanwhile must fail
       * the send with a reason rather than silently erase the schedule.
       *
       * The attachments sit in their own table, without a foreign key to the
       * attachment: retention reads it to spare an upload that is waiting for its
       * message, and one that went missing anyway is reported when the send fails.
       */
      db.exec(`
        CREATE TABLE scheduled_messages (
          id          TEXT PRIMARY KEY,
          user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          content     TEXT NOT NULL,
          reply_to_id TEXT,
          send_at     INTEGER NOT NULL,
          created_at  INTEGER NOT NULL,
          status      TEXT NOT NULL DEFAULT 'pending',
          error       TEXT
        );
        CREATE INDEX idx_scheduled_messages_due ON scheduled_messages(status, send_at);
        CREATE INDEX idx_scheduled_messages_user ON scheduled_messages(user_id, send_at);
        CREATE INDEX idx_scheduled_messages_channel ON scheduled_messages(channel_id);

        CREATE TABLE scheduled_message_attachments (
          scheduled_id  TEXT NOT NULL REFERENCES scheduled_messages(id) ON DELETE CASCADE,
          attachment_id TEXT NOT NULL,
          position      INTEGER NOT NULL,
          PRIMARY KEY (scheduled_id, attachment_id)
        );
        CREATE INDEX idx_scheduled_attachments_attachment ON scheduled_message_attachments(attachment_id);
      `);
    },
  },
  {
    version: 28,
    name: 'polls',
    up(db) {
      /*
       * Polls hang off a message, one at most, and go with it: a retention delete
       * of the message takes the poll, its options and every vote through the
       * foreign keys (a soft delete keeps them, and reads filter the message out
       * like any other). `source` records where the poll was made, because a poll
       * that came from Discord is closed by Discord, not from here.
       *
       * A vote is one row per member per option. `poll_id` is repeated on the vote
       * so "has this member voted in this poll" and the distinct-voter count need
       * no join. A stand-in account for a Discord voter is an ordinary user row,
       * so a linked member's Discord vote and their own are one person's, and the
       * primary key keeps them from being counted twice.
       *
       * `discord_answer_id` pairs an option with the answer it became on Discord
       * (their ids are small integers, unique within one poll); null when the poll
       * was never bridged. The partial index serves the expiry sweep and stays as
       * small as the set of polls still open.
       */
      db.exec(`
        CREATE TABLE polls (
          id             TEXT PRIMARY KEY,
          message_id     TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
          question       TEXT NOT NULL,
          allow_multiple INTEGER NOT NULL DEFAULT 0,
          closes_at      TEXT,
          closed_at      TEXT,
          source         TEXT NOT NULL DEFAULT 'harmony',
          created_at     TEXT NOT NULL
        );
        CREATE INDEX idx_polls_open_expiry ON polls(closes_at)
          WHERE closed_at IS NULL AND closes_at IS NOT NULL;

        CREATE TABLE poll_options (
          id                TEXT PRIMARY KEY,
          poll_id           TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
          position          INTEGER NOT NULL,
          text              TEXT NOT NULL,
          emoji             TEXT,
          discord_answer_id INTEGER,
          UNIQUE (poll_id, position)
        );

        CREATE TABLE poll_votes (
          poll_id   TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
          option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
          user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          voted_at  TEXT NOT NULL,
          PRIMARY KEY (option_id, user_id)
        );
        CREATE INDEX idx_poll_votes_poll_user ON poll_votes(poll_id, user_id);
      `);
    },
  },
  {
    version: 30,
    name: 'message_embeds_hidden',
    up(db) {
      /*
       * Set when a message's author (or a moderator) removed its embeds. The
       * link resolver skips a hidden message for good, edits included, so the
       * preview or fetched picture does not come back with the next edit.
       */
      db.exec(`ALTER TABLE messages ADD COLUMN embeds_hidden INTEGER NOT NULL DEFAULT 0`);
    },
  },
  {
    version: 31,
    name: 'gif_sources',
    up(db) {
      /*
       * Pairs a remote gif address with the copy this server holds of it, so that
       * switching the gif storage mode between "store" and "link" never fetches a
       * gif twice or loses one. `url` is the normalized address (see
       * gifs/source-url.ts). `hash` points at the content-addressed blob and is
       * null while there is no copy: a gif only linked so far, or one whose copy
       * was released. It is deliberately not a foreign key, since blobs are files
       * and not rows; whoever deletes a blob clears the pairing instead.
       * `fail_count` and `status` give up on an address after repeated failed
       * fetches ('dead'), and `last_checked_at` spaces the retries.
       *
       * `held` says who keeps the blob alive. 0: the pairing merely mirrors bytes
       * an attachment or a favorite holds, so the blob follows their retention
       * and the pairing is cleared once it is gone. 1: the copy was made for the
       * pairing itself (an archive run, an on-demand copy), so the retention
       * sweep treats the blob as referenced until the copy is released.
       */
      db.exec(`
        CREATE TABLE gif_sources (
          url             TEXT PRIMARY KEY,
          hash            TEXT,
          content_type    TEXT,
          size            INTEGER,
          width           INTEGER,
          height          INTEGER,
          first_seen_at   TEXT NOT NULL,
          last_seen_at    TEXT NOT NULL,
          copied_at       TEXT,
          held            INTEGER NOT NULL DEFAULT 0,
          last_checked_at TEXT,
          fail_count      INTEGER NOT NULL DEFAULT 0,
          status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'dead'))
        );
        CREATE INDEX idx_gif_sources_hash ON gif_sources(hash) WHERE hash IS NOT NULL;
      `);

      /*
       * One-time, idempotent backfill from what already pairs an address with
       * bytes: gifs fetched from a link (attachments.source_url) and gifs kept
       * from the hosted service (gif_favorites.source_url). Done in pages so a
       * large history never sits in memory at once; INSERT OR IGNORE keeps the
       * first pairing per address.
       */
      const insert = db.prepare(
        `INSERT OR IGNORE INTO gif_sources
           (url, hash, content_type, size, width, height, first_seen_at, last_seen_at, copied_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')`,
      );
      interface Pair {
        rowid: number;
        source_url: string;
        hash: string;
        content_type: string;
        size: number;
        width: number | null;
        height: number | null;
        created_at: string;
      }
      for (const table of ['attachments', 'gif_favorites'] as const) {
        let after = 0;
        for (;;) {
          const rows = db
            .prepare(
              `SELECT rowid, source_url, hash, content_type, size, width, height, created_at FROM ${table}
               WHERE source_url IS NOT NULL AND content_type = 'image/gif' AND rowid > ?
               ORDER BY rowid LIMIT 500`,
            )
            .all(after) as unknown as Pair[];
          if (rows.length === 0) break;
          for (const row of rows) {
            const url = normalizeGifSourceUrl(row.source_url);
            if (url === null || !isGifLinkUrl(url)) continue;
            insert.run(
              url,
              row.hash,
              row.content_type,
              row.size,
              row.width,
              row.height,
              row.created_at,
              row.created_at,
              row.created_at,
            );
          }
          after = rows[rows.length - 1]?.rowid ?? after + 1;
        }
      }
    },
  },
  {
    version: 32,
    name: 'server_gifs',
    up(db) {
      /*
       * The administrators' say over the picker's Server tab, one row per picture
       * (unique on the content hash, so the same bytes are never listed twice).
       *
       * kind 'curated' is a gif an administrator chose to keep for everyone. It is
       * held by hash, like a favorite, so it outlives the message it was found in;
       * the bytes are always a copy stored here, never a link, so it survives link
       * rot. The blob is protected from retention by listReferencedHashes, which
       * counts curated rows (and only those). position orders the curated list and
       * pinned lifts a gif above the rest.
       *
       * kind 'hidden' is an administrator removing a gif from the auto-collected
       * list (recent gif attachments). It carries the same descriptive columns so
       * the admin can see and restore it, but it makes no claim on the bytes: if
       * the last message holding them is pruned, the blob goes and the row is just
       * a stale note.
       */
      db.exec(`
        CREATE TABLE server_gifs (
          id           TEXT PRIMARY KEY,
          kind         TEXT NOT NULL CHECK (kind IN ('curated', 'hidden')),
          hash         TEXT NOT NULL UNIQUE,
          filename     TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size         INTEGER NOT NULL,
          width        INTEGER,
          height       INTEGER,
          name         TEXT NOT NULL DEFAULT '',
          tags         TEXT NOT NULL DEFAULT '',
          position     INTEGER NOT NULL DEFAULT 0,
          pinned       INTEGER NOT NULL DEFAULT 0,
          added_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at   TEXT NOT NULL
        );
        CREATE INDEX idx_server_gifs_kind ON server_gifs(kind, pinned DESC, position, created_at);
      `);
    },
  },
  {
    version: 33,
    name: 'server_events',
    up(db) {
      /*
       * Server events with an "Interested" RSVP. Times are epoch milliseconds, which
       * is what the clients format and what the sweep compares.
       *
       * A channel event is deleted with its channel (CASCADE) rather than
       * orphaned: an orphan would have no channel left to decide who may see it,
       * and one that was private would turn public. The creator is kept as null
       * once their account goes, so the event outlives them.
       *
       * `reminded_at` is stamped when the pre-start reminder has gone out, so it
       * fires once even across a restart; moving the start time clears it. The
       * partial index serves the sweep and stays as small as the set of events
       * still open.
       */
      db.exec(`
        CREATE TABLE events (
          id                   TEXT PRIMARY KEY,
          title                TEXT NOT NULL,
          description          TEXT NOT NULL DEFAULT '',
          location_kind        TEXT NOT NULL CHECK (location_kind IN ('channel', 'external')),
          channel_id           TEXT REFERENCES channels(id) ON DELETE CASCADE,
          location_text        TEXT NOT NULL DEFAULT '',
          starts_at            INTEGER NOT NULL,
          ends_at              INTEGER,
          creator_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
          status               TEXT NOT NULL DEFAULT 'scheduled'
                                 CHECK (status IN ('scheduled', 'active', 'ended', 'canceled')),
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL,
          announced_message_id TEXT,
          reminded_at          INTEGER
        );
        CREATE INDEX idx_events_open ON events(starts_at) WHERE status IN ('scheduled', 'active');
        CREATE INDEX idx_events_channel ON events(channel_id);

        CREATE TABLE event_rsvps (
          event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY (event_id, user_id)
        );
        CREATE INDEX idx_event_rsvps_user ON event_rsvps(user_id);
      `);

      /*
       * ManageEvents is bit 17 (131072). Roles that could already run the server
       * (ManageServer, bit 9 = 512) keep that reach by getting the new bit;
       * administrators have every bit implicitly and the owner holds them all.
       */
      db.exec(`
        UPDATE roles
           SET permissions = CAST((CAST(permissions AS INTEGER) | 131072) AS TEXT)
         WHERE (CAST(permissions AS INTEGER) & 512) != 0
           AND (CAST(permissions AS INTEGER) & 131072) = 0
      `);
    },
  },
  {
    version: 34,
    name: 'message_edits',
    up(db) {
      /*
       * The text a message had before each edit. editor_id is who made the edit
       * (null once that account is deleted); source says whether the edit came
       * from Harmony or from Discord. Rows go with their message via the cascade.
       */
      db.exec(`
        CREATE TABLE message_edits (
          id         TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          editor_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
          content    TEXT NOT NULL,
          edited_at  TEXT NOT NULL,
          source     TEXT NOT NULL DEFAULT 'harmony'
        );
        CREATE INDEX idx_message_edits_message ON message_edits(message_id, edited_at);
      `);
    },
  },
  {
    version: 35,
    name: 'profile_customization',
    up(db) {
      /*
       * What a member sets about themselves: bio and status text, a chosen accent
       * color (null falls back to avatar_color), the color averaged from their
       * picture (kept so a profile renders without re-measuring the image every
       * time), a banner image hash, and social links as a JSON object keyed by
       * platform. The avatar and banner hashes are content-addressed blobs.
       */
      db.exec(`
        ALTER TABLE users ADD COLUMN bio TEXT;
        ALTER TABLE users ADD COLUMN status TEXT;
        ALTER TABLE users ADD COLUMN accent_color INTEGER;
        ALTER TABLE users ADD COLUMN avatar_color INTEGER;
        ALTER TABLE users ADD COLUMN banner_hash TEXT;
        ALTER TABLE users ADD COLUMN social_links TEXT;
      `);
    },
  },
];
