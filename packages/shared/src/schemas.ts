import { z } from 'zod';
import { LIMITS, MAX_ICON_PADDING, MAX_UPDATE_BACKUP_RETENTION, MAX_UPLOAD_CEILING_BYTES } from './constants.ts';
import { TIMEOUT_MAX_MINUTES } from './moderation.ts';
import { MAX_SLOWMODE_SECONDS } from './slowmode.ts';
import { MAX_MUTE_SECONDS, NOTIFICATION_LEVELS } from './channel-settings.ts';
import { GIF_STORAGE_MODES, type GifStorageMode } from './gif-hosts.ts';
import { BIO_MAX, SOCIAL_VALUE_MAX, STATUS_MAX } from './profile.ts';
import { HEX_COLOR_PATTERN } from './theme.ts';

export const usernameSchema = z
  .string()
  .min(LIMITS.username.min)
  .max(LIMITS.username.max)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Only letters, numbers, dot, dash and underscore are allowed');

export const passwordSchema = z.string().min(LIMITS.password.min).max(LIMITS.password.max);

export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  /** Only required when the instance has `HARMONY_REQUIRE_INVITE=true`. */
  inviteCode: z.string().min(1).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  username: usernameSchema,
  // Login only checks that a password was supplied; registration enforces the policy.
  password: z.string().min(1).max(LIMITS.password.max),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Seconds a member must wait between messages in a channel; 0 means off. */
const slowmodeSeconds = z.number().int().min(0).max(MAX_SLOWMODE_SECONDS).optional();

export const createChannelSchema = z.object({
  name: z.string().min(LIMITS.channelName.min).max(LIMITS.channelName.max),
  topic: z.string().max(1024).nullable().optional(),
  categoryId: z.string().nullable().optional(),
  discordChannelId: z.string().nullable().optional(),
  /** A role required to see the channel, or null for open access. */
  requiredRoleId: z.string().nullable().optional(),
  slowmodeSeconds,
});
export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export const createMessageSchema = z
  .object({
    content: z.string().max(LIMITS.messageLength).default(''),
    attachmentIds: z.array(z.string()).max(LIMITS.attachmentsPerMessage).optional(),
    /** Id of the message being replied to, if any. */
    replyToId: z.string().nullable().optional(),
  })
  .refine((value) => value.content.trim().length > 0 || (value.attachmentIds?.length ?? 0) > 0, {
    message: 'A message needs text or at least one attachment.',
    path: ['content'],
  });
export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export const createInviteSchema = z.object({
  /** `null`/absent means unlimited uses. */
  maxUses: z.number().int().positive().nullable().optional(),
  /** `null`/absent means the code never expires. */
  expiresInHours: z.number().positive().nullable().optional(),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export const createCategorySchema = z.object({
  name: z.string().min(1).max(LIMITS.channelName.max),
  /** A role required to see the category and its channels, or null for open. */
  requiredRoleId: z.string().nullable().optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(LIMITS.channelName.max).optional(),
  position: z.number().int().optional(),
  /** A role required to see the category and its channels, or null for open. */
  requiredRoleId: z.string().nullable().optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const updateChannelSchema = z.object({
  name: z.string().min(LIMITS.channelName.min).max(LIMITS.channelName.max).optional(),
  topic: z.string().max(1024).nullable().optional(),
  categoryId: z.string().nullable().optional(),
  position: z.number().int().optional(),
  discordChannelId: z.string().nullable().optional(),
  /** A role required to see the channel, or null to inherit or open it up. */
  requiredRoleId: z.string().nullable().optional(),
  slowmodeSeconds,
});
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;

export const editMessageSchema = z.object({
  content: z.string().min(1).max(LIMITS.messageLength),
});
export type EditMessageInput = z.infer<typeof editMessageSchema>;

/**
 * A reaction target. `emoji` is a unicode character, or `:name:` paired with
 * `emojiId` for a custom emoji.
 */
export const reactionSchema = z.object({
  emoji: z.string().trim().min(1).max(64),
  emojiId: z.string().nullable().optional(),
});
export type ReactionInput = z.infer<typeof reactionSchema>;

/** Same fields, but for a query string (used by the clear-all endpoint). */
export const reactionQuerySchema = z.object({
  emoji: z.string().trim().min(1).max(64),
  emojiId: z.string().optional(),
});
export type ReactionQuery = z.infer<typeof reactionQuerySchema>;

/**
 * Cursor pagination, shared by message history and the media gallery: a page
 * size, plus the timestamp and id of the oldest item already held. The id matters
 * because a timestamp alone can tie.
 */
const cursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Return items created strictly before this ISO timestamp. */
  before: z.string().optional(),
  /** Id of the item `before` came from, to break ties within a millisecond. */
  beforeId: z.string().optional(),
});

export const messageHistoryQuerySchema = cursorQuerySchema;
export type MessageHistoryQuery = z.infer<typeof messageHistoryQuerySchema>;

/** The audit log pages the same way, newest first. */
export const auditQuerySchema = cursorQuerySchema;
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** A member's own inbox pages the same way, newest first. */
export const mentionQuerySchema = cursorQuerySchema;
export type MentionQuery = z.infer<typeof mentionQuerySchema>;

export const mediaQuerySchema = cursorQuerySchema;
export type MediaQuery = z.infer<typeof mediaQuerySchema>;

/**
 * A member's saved messages page the same way, newest save first: `before` is a
 * save time and `beforeId` the message it saved. `reminders` asks instead for
 * the saves carrying a reminder, soonest first, which is what a client needs to
 * know when to remind; that list is not paged.
 */
export const savedQuerySchema = cursorQuerySchema.extend({
  reminders: z.enum(['true', 'false']).optional(),
});
export type SavedQuery = z.infer<typeof savedQuerySchema>;

/**
 * The server log pages the same way, newest last. `before`/`beforeId` are the
 * `lastAt` and id of the oldest entry already held. `level` narrows to one
 * severity.
 */
export const serverLogQuerySchema = cursorQuerySchema.extend({
  level: z.enum(['info', 'warn', 'error']).optional(),
});
export type ServerLogQuery = z.infer<typeof serverLogQuerySchema>;

/**
 * Saving a message. The body is optional: without `remindAt` a save keeps any
 * reminder it already had, and an explicit null clears it.
 */
export const saveMessageSchema = z
  .object({
    remindAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .optional();
export type SaveMessageInput = z.infer<typeof saveMessageSchema>;

/** The picker's local tab: a search term and a page size. */
export const gifQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type GifQuery = z.infer<typeof gifQuerySchema>;

/** Permission bitfields cross the wire as decimal strings. */
const permissionString = z.string().regex(/^\d+$/, 'Must be a decimal permission bitfield');

export const createRoleSchema = z.object({
  name: z.string().min(1).max(LIMITS.channelName.max),
  color: z.number().int().min(0).max(0xffffff).nullable().optional(),
  permissions: permissionString.optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
  badge: z.enum(['none', 'moderator']).optional(),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: z.string().min(1).max(LIMITS.channelName.max).optional(),
  color: z.number().int().min(0).max(0xffffff).nullable().optional(),
  permissions: permissionString.optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
  badge: z.enum(['none', 'moderator']).optional(),
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

/** A per-type upload limit in bytes: at least 1 KiB, at most the hard ceiling. */
const uploadSize = z.number().int().min(1024).max(MAX_UPLOAD_CEILING_BYTES).optional();

export const updateSettingsSchema = z.object({
  serverName: z.string().min(1).max(64).optional(),
  requireInvite: z.boolean().optional(),
  /** The channel opened by default on load. Null clears the preference. */
  defaultChannelId: z.string().nullable().optional(),
  /** Whether the server unfurls link previews by fetching the linked pages. */
  embedsEnabled: z.boolean().optional(),
  /** Instance colors. Every other color in the palette is derived from these. */
  theme: z
    .object({
      background: z.string().regex(HEX_COLOR_PATTERN, 'Must be a #rrggbb color').nullable(),
      accent: z.string().regex(HEX_COLOR_PATTERN, 'Must be a #rrggbb color').nullable(),
    })
    .partial()
    .optional(),
  /** How the installed app icon is drawn; see `IconSettings`. */
  icon: z
    .object({
      /** Null works the padding out from the image itself. */
      padding: z.number().int().min(0).max(MAX_ICON_PADDING).nullable(),
      /** Null takes the color from the artwork itself. */
      background: z.string().regex(HEX_COLOR_PATTERN, 'Must be a #rrggbb color').nullable(),
    })
    .partial()
    .optional(),
  /** Upload size limits, in bytes; the ceiling is what the server can buffer. */
  maxImageBytes: uploadSize,
  maxVideoBytes: uploadSize,
  /** An empty string clears it, falling back to Harmony's own user agent. */
  previewUserAgent: z.string().trim().max(200).nullable().optional(),
  /** Set true once the owner has finished or skipped the first-run wizard. */
  setupCompleted: z.boolean().optional(),
  /** An empty string clears it, and the picker loses its hosted tab. */
  klipyApiKey: z.string().trim().max(200).nullable().optional(),
  /** "store" keeps a copy of each gif here; "link" points at allowlisted gif hosts. */
  gifStorage: z.enum(GIF_STORAGE_MODES as [GifStorageMode, ...GifStorageMode[]]).optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

/**
 * The owner's switches on the Update tab. Both fields are optional so one can be
 * changed on its own, but a patch that carries neither is refused.
 */
export const updatePatchSchema = z
  .object({
    /** The once-a-day automatic check. */
    autoCheck: z.boolean().optional(),
    /** How many pre-update snapshots to keep on disk. */
    backupRetention: z.number().int().min(1).max(MAX_UPDATE_BACKUP_RETENTION).optional(),
  })
  .refine((value) => value.autoCheck !== undefined || value.backupRetention !== undefined, {
    message: 'No update setting given',
  });
export type UpdatePatchInput = z.infer<typeof updatePatchSchema>;

/**
 * The apply request. `backup` says whether to take a database snapshot first;
 * the body is required, which also keeps a cross-site form from reaching it.
 */
export const updateApplySchema = z.object({
  backup: z.boolean(),
});
export type UpdateApplyInput = z.infer<typeof updateApplySchema>;

/** A permission bitfield as a decimal string, the wire form the API uses. */
const permissionBitfieldSchema = z.string().regex(/^\d+$/, 'A decimal permission bitfield');

/** Creating a bot. The owner chooses the name and what the token may do. */
export const createBotSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().max(LIMITS.displayName.max).nullable().optional(),
  permissions: permissionBitfieldSchema,
});
export type CreateBotInput = z.infer<typeof createBotSchema>;

/** Editing a bot. Every field is optional, but a patch carrying none is refused. */
export const updateBotSchema = z
  .object({
    username: usernameSchema.optional(),
    displayName: z.string().trim().max(LIMITS.displayName.max).nullable().optional(),
    permissions: permissionBitfieldSchema.optional(),
  })
  .refine((value) => value.username !== undefined || 'displayName' in value || value.permissions !== undefined, {
    message: 'No bot setting given',
  });
export type UpdateBotInput = z.infer<typeof updateBotSchema>;

/** A one-step reorder, shared by roles, channels and categories. */
export const moveSchema = z.object({
  direction: z.enum(['up', 'down']),
});
export type MoveInput = z.infer<typeof moveSchema>;

/** Emoji shortcodes are written as `:name:` and use Discord's name rules. */
export const emojiNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_]{2,32}$/, 'Emoji names use 2-32 letters, numbers or underscores');

export const createEmojiSchema = z.object({
  name: emojiNameSchema,
});
export type CreateEmojiInput = z.infer<typeof createEmojiSchema>;

/** `null` disables the rule; omitted fields are left unchanged. */
const retentionNumber = z.number().int().min(0).nullable().optional();

export const updateRetentionSchema = z.object({
  imageRetentionDays: retentionNumber,
  videoRetentionDays: retentionNumber,
  messageRetentionDays: retentionNumber,
  auditRetentionDays: retentionNumber,
  serverLogRetentionDays: retentionNumber,
  favoriteRetentionDays: retentionNumber,
  externalEmojiRetentionDays: retentionNumber,
  stickerRetentionDays: retentionNumber,
  storageLimitBytes: retentionNumber,
  storageTargetBytes: retentionNumber,
});
export type UpdateRetentionInput = z.infer<typeof updateRetentionSchema>;

/** Keeps an already-stored gif, so it survives the message it was found in. */
export const addGifFavoriteSchema = z.union([
  z.object({ attachmentId: z.string().min(1) }),
  /** A hosted service's gif, which is fetched and kept at that moment. */
  z.object({ url: z.string().min(1).max(2048) }),
]);
export type AddGifFavoriteInput = z.infer<typeof addGifFavoriteSchema>;

/**
 * Takes a gif out of the picker and into the message being written. The server
 * copies it into an unattached attachment owned by the caller, which the message
 * then claims exactly as it would an upload.
 */
export const pickGifSchema = z.union([
  z.object({ attachmentId: z.string().min(1) }),
  z.object({ favoriteId: z.string().min(1) }),
  /** A hosted service's gif, fetched and kept on the way in. */
  z.object({ url: z.string().min(1).max(2048) }),
]);
export type PickGifInput = z.infer<typeof pickGifSchema>;

/** A gif address to be checked and linked rather than stored. */
export const linkGifSchema = z.object({ url: z.string().min(1).max(2048) });
export type LinkGifInput = z.infer<typeof linkGifSchema>;

/** Gif tags: a handful of short words. */
const serverGifTags = z.array(z.string().trim().min(1).max(30)).max(12);

/** Curates a gif for the whole server: from an attachment, a member's favorite, or a hosted address (exactly one). */
export const addServerGifSchema = z
  .object({
    attachmentId: z.string().min(1).optional(),
    favoriteId: z.string().min(1).optional(),
    url: z.string().min(1).max(2048).optional(),
    name: z.string().trim().max(60).optional(),
    tags: serverGifTags.optional(),
    pinned: z.boolean().optional(),
  })
  .refine(
    (value) => [value.attachmentId, value.favoriteId, value.url].filter((entry) => entry !== undefined).length === 1,
    'Name exactly one of attachmentId, favoriteId and url.',
  );
export type AddServerGifInput = z.infer<typeof addServerGifSchema>;

export const updateServerGifSchema = z
  .object({
    name: z.string().trim().max(60).optional(),
    tags: serverGifTags.optional(),
    pinned: z.boolean().optional(),
    position: z.number().int().min(0).max(100000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');
export type UpdateServerGifInput = z.infer<typeof updateServerGifSchema>;

/** The curated gifs in the order they should now appear. */
export const orderServerGifsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });
export type OrderServerGifsInput = z.infer<typeof orderServerGifsSchema>;

/** Hides an auto-collected gif, named by the attachment it was found as. */
export const hideServerGifSchema = z.object({ attachmentId: z.string().min(1) });
export type HideServerGifInput = z.infer<typeof hideServerGifSchema>;

/** The picker's hosted tab: a search term and a page size. */
export const gifSearchQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export type GifSearchQuery = z.infer<typeof gifSearchQuerySchema>;

export const updateBridgeSchema = z
  .object({
    /** Omit to leave unchanged; an empty string clears the saved token. */
    token: z.string().trim().max(500).optional(),
    enabled: z.boolean().optional(),
    /** Public base URL used to hand avatar URLs to Discord; null disables them. */
    publicBaseUrl: z.string().trim().max(500).nullable().optional(),
  })
  // A malformed address would make Discord reject webhook posts outright, so it
  // is caught here rather than silently breaking every mirrored message.
  .refine(
    (value) =>
      value.publicBaseUrl == null || value.publicBaseUrl === '' || /^https?:\/\/\S+$/.test(value.publicBaseUrl),
    {
      message: 'Use a full http(s) address, like https://chat.example.com',
      path: ['publicBaseUrl'],
    },
  );
export type UpdateBridgeInput = z.infer<typeof updateBridgeSchema>;

export const bridgeTestSchema = z.object({
  channelId: z.string().min(1),
});
export type BridgeTestInput = z.infer<typeof bridgeTestSchema>;

/**
 * The optional Discord sign-in integration. Omitting a field leaves it unchanged;
 * an empty string clears a saved id or secret.
 */
export const updateDiscordAuthSchema = z
  .object({
    clientId: z.string().trim().max(64).optional(),
    clientSecret: z.string().trim().max(200).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (value) => value.clientId !== undefined || value.clientSecret !== undefined || value.enabled !== undefined,
    { message: 'Nothing to update.' },
  );
export type UpdateDiscordAuthInput = z.infer<typeof updateDiscordAuthSchema>;

/** Pull recent Discord history into a bridged channel. */
export const bridgeImportSchema = z.object({
  channelId: z.string().min(1),
  /** How many recent Discord messages to pull, 1-100. */
  limit: z.number().int().min(1).max(100).optional(),
});
export type BridgeImportInput = z.infer<typeof bridgeImportSchema>;

/**
 * Which Discord channels to import. Leaving `channelIds` out means "everything not
 * bridged yet", so the original all-at-once behavior is unchanged.
 */
export const channelImportSchema = z.object({
  channelIds: z.array(z.string().min(1)).max(1000).optional(),
});
export type ChannelImportInput = z.infer<typeof channelImportSchema>;

/** Which Discord emoji to import. `emojiIds` left out means every one missing. */
export const emojiImportSchema = z.object({
  emojiIds: z.array(z.string().min(1)).max(1000).optional(),
});
export type EmojiImportInput = z.infer<typeof emojiImportSchema>;

export const updateProfileSchema = z
  .object({
    /** `null` (or an empty string) clears it and falls back to the username. */
    displayName: z.string().trim().max(LIMITS.displayName.max).nullable().optional(),
    /** When false the user neither sends nor sees typing indicators. */
    showTyping: z.boolean().optional(),
    /** Whether a message that mentions the user plays the louder sound. */
    notifyMajor: z.boolean().optional(),
    /** Whether any other message plays the quieter sound. */
    notifyMinor: z.boolean().optional(),
    /** A short "about me", plain text. */
    bio: z.string().trim().max(BIO_MAX).optional(),
    /** A one-line custom status, plain text. */
    status: z.string().trim().max(STATUS_MAX).optional(),
    /** A chosen profile accent, or null to fall back to the picture's own color. */
    accentColor: z.number().int().min(0).max(0xffffff).nullable().optional(),
    /** Social links, validated against the known platforms in the service. */
    socialLinks: z.record(z.string(), z.string().trim().max(SOCIAL_VALUE_MAX)).optional(),
  })
  .refine(
    (value) =>
      value.displayName !== undefined ||
      value.showTyping !== undefined ||
      value.notifyMajor !== undefined ||
      value.notifyMinor !== undefined ||
      value.bio !== undefined ||
      value.status !== undefined ||
      value.accentColor !== undefined ||
      value.socialLinks !== undefined,
    { message: 'Nothing to update.' },
  );
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** A signed-in member changing their own password. */
export const changePasswordSchema = z.object({
  /** Omitted when the account has no password yet (it signed up with Discord). */
  currentPassword: z.string().min(1).max(LIMITS.password.max).optional(),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * An administrator editing another account. Everything is optional so a caller
 * can change one field, but at least one must be present.
 */
export const adminUpdateUserSchema = z
  .object({
    username: usernameSchema.optional(),
    /** `null` (or an empty string) clears it and falls back to the username. */
    displayName: z.string().trim().max(LIMITS.displayName.max).nullable().optional(),
    /** Only ever set by someone else; a password is never returned by the API. */
    password: passwordSchema.optional(),
    /**
     * The Discord account to link this member to. An empty string or `null`
     * clears the link. Only an administrator sets this for now; the id is what
     * the bridge uses to route that person's Discord messages and pings to them.
     */
    discordId: z
      .string()
      .trim()
      .max(32)
      .refine((value) => value === '' || /^\d{17,20}$/.test(value), 'A Discord id is 17 to 20 digits')
      .nullable()
      .optional(),
  })
  .refine(
    (value) =>
      value.username !== undefined ||
      value.displayName !== undefined ||
      value.password !== undefined ||
      value.discordId !== undefined,
    { message: 'Nothing to update.' },
  );
export type AdminUpdateUserInput = z.infer<typeof adminUpdateUserSchema>;

/** What `has:` can ask a message to carry. `pin` means the message is pinned. */
export const SEARCH_HAS_VALUES = ['image', 'video', 'gif', 'file', 'link', 'embed', 'sticker', 'pin'] as const;
export type SearchHas = (typeof SEARCH_HAS_VALUES)[number];

/**
 * A repeated query parameter as a list: one value arrives as a bare string, two
 * or more as an array, and both mean the same thing here.
 */
function queryList<T extends z.ZodTypeAny>(item: T, max: number) {
  return z.preprocess((value) => (typeof value === 'string' ? [value] : value), z.array(item).max(max));
}

/**
 * A message search. The named filters mirror Discord's: `from`, `mentions`,
 * `in`, `has` and the `sentAfter`/`sentBefore` bounds in epoch milliseconds,
 * which the client works out from the member's own calendar day. Names are
 * resolved by the server, case-insensitively. `q` is matched as a case-insensitive substring of the text,
 * so `100%` finds that literally rather than as a wildcard. It may be left out
 * when a filter narrows the search instead, e.g. everything one member said.
 */
export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
    /** Return matches older than this timestamp, for paging. */
    before: z.string().optional(),
    /** Id of the match `before` came from, to break ties within a millisecond. */
    beforeId: z.string().optional(),
    /** Narrow to one channel. Only channels the caller can see are accepted. */
    channelId: z.string().optional(),
    /** Narrow to one author. */
    authorId: z.string().optional(),
    /** Author usernames or display names; a message by any of them matches. */
    from: queryList(z.string().trim().min(1).max(64), 10).optional(),
    /** Usernames named in the text; a message naming any of them matches. */
    mentions: queryList(z.string().trim().min(1).max(64), 10).optional(),
    /** Channel names; a message in any of them matches. */
    in: queryList(z.string().trim().min(1).max(LIMITS.channelName.max), 10).optional(),
    /** Every listed trait must hold. */
    has: queryList(z.enum(SEARCH_HAS_VALUES), SEARCH_HAS_VALUES.length).optional(),
    /** Only messages sent at or after this time (epoch milliseconds). */
    sentAfter: z.coerce.number().int().min(0).max(8.64e15).optional(),
    /** Only messages sent before this time (epoch milliseconds). */
    sentBefore: z.coerce.number().int().min(0).max(8.64e15).optional(),
  })
  .refine(
    (value) =>
      value.q !== undefined ||
      value.channelId !== undefined ||
      value.authorId !== undefined ||
      (value.from?.length ?? 0) > 0 ||
      (value.mentions?.length ?? 0) > 0 ||
      (value.in?.length ?? 0) > 0 ||
      (value.has?.length ?? 0) > 0 ||
      value.sentAfter !== undefined ||
      value.sentBefore !== undefined,
    {
      message: 'A search needs a term or at least one filter.',
      path: ['q'],
    },
  );
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** How long a moderation timeout lasts. */
export const timeoutSchema = z.object({
  durationMinutes: z.number().int().min(1).max(TIMEOUT_MAX_MINUTES),
});
export type TimeoutInput = z.infer<typeof timeoutSchema>;

/** The reason shown alongside a ban is optional. */
export const banSchema = z.object({
  reason: z.string().trim().max(300).nullable().optional(),
});
export type BanInput = z.infer<typeof banSchema>;

/**
 * One member's mute and notification settings for a channel or category.
 * Omitting a field leaves it as it was, so the mute menu and the notification
 * menu can each change their own half. `muteSeconds` only means something when
 * muting: a length to mute for, or null (or omitted) for "until I turn it back on".
 */
export const updateChannelSettingsSchema = z
  .object({
    muted: z.boolean().optional(),
    muteSeconds: z.number().int().min(1).max(MAX_MUTE_SECONDS).nullable().optional(),
    level: z.enum(NOTIFICATION_LEVELS).optional(),
  })
  .refine((value) => value.muted !== undefined || value.level !== undefined, { message: 'Nothing to update.' })
  .refine((value) => value.muteSeconds == null || value.muted === true, {
    message: 'A mute length only goes with muted: true.',
    path: ['muteSeconds'],
  });
export type UpdateChannelSettingsInput = z.infer<typeof updateChannelSettingsSchema>;
