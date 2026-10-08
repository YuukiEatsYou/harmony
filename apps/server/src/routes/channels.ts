import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  GatewayEvent,
  Permission,
  channelImportSchema,
  createCategorySchema,
  createChannelSchema,
  moveSchema,
  updateCategorySchema,
  updateChannelSchema,
  type ChannelListResponse,
  type ChannelImportResponse,
  type DiscordChannelImportPreview,
  type TypingStartPayload,
} from '@harmony/shared';
import { assertNotTimedOut } from '../auth/guards.ts';
import { requirePermission } from '../auth/plugin.ts';
import {
  canAccessChannel,
  channelAccessFor,
  visibleCategories,
  visibleChannels,
} from '../access/service.ts';
import type { BridgeService } from '../bridge/service.ts';
import type { ChannelImportService } from '../channels/import.ts';
import {
  deleteCategory,
  findCategory,
  insertCategory,
  moveCategory,
  nextCategoryPosition,
  toCategory,
  updateCategory,
  type CategoryRow,
} from '../db/categories.ts';
import {
  countChannelsInCategory,
  deleteChannel,
  findChannel,
  findChannelByDiscordId,
  insertChannel,
  moveChannel,
  nextChannelPosition,
  toChannel,
  updateChannel,
  type ChannelRow,
} from '../db/channels.ts';
import { listReadMarkers, listUnreadChannelIds, markChannelRead } from '../db/channel_reads.ts';
import { countUnreadMentions } from '../db/mentions.ts';
import type { Database } from '../db/index.ts';
import { newestMessageAt } from '../db/messages.ts';
import { findRole } from '../db/roles.ts';
import { HttpError } from '../http/errors.ts';
import { createRateLimiter } from '../http/rate-limit.ts';
import { parseBody } from '../http/validation.ts';
import type { ServerLogService } from '../log/service.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import type { SettingsService } from '../settings/service.ts';

export interface ChannelRouteDeps {
  db: Database;
  hub: GatewayHub;
  bridge: BridgeService;
  settings: SettingsService;
  importer: ChannelImportService;
  serverLog: ServerLogService;
}

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRouteDeps): void {
  const { db, hub, settings } = deps;

  // A typing ping is cheap to send but fans out to every client, so blunt spam.
  const typingLimiter = createRateLimiter({ limit: 8, windowMs: 10_000 });

  /**
   * Best effort: pull the Discord channel's recent history once it is linked, so
   * a new bridge does not start out empty. It is idempotent, and a disabled
   * bridge simply fails here and is ignored.
   */
  function backfill(channelId: string): void {
    void deps.bridge.importChannel(channelId).catch(() => undefined);
  }

  function requireChannelRow(id: string): ChannelRow {
    const row = findChannel(db.sqlite, id);
    if (!row) throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');
    return row;
  }

  function requireCategoryRow(id: string): CategoryRow {
    const row = findCategory(db.sqlite, id);
    if (!row) throw new HttpError(404, 'category_not_found', 'That category does not exist.');
    return row;
  }

  /** A channel or category may only demand a role that actually exists. */
  function assertRoleExists(roleId: string): void {
    if (!findRole(db.sqlite, roleId)) {
      throw new HttpError(400, 'invalid_role', 'That role does not exist.');
    }
  }

  /** A Discord channel can only feed one Harmony channel. */
  function assertDiscordChannelFree(discordChannelId: string, exceptChannelId: string | null): void {
    const existing = findChannelByDiscordId(db.sqlite, discordChannelId);
    if (existing && existing.id !== exceptChannelId) {
      throw new HttpError(409, 'discord_channel_taken', 'That Discord channel is already bridged elsewhere.');
    }
  }

  app.get('/api/v1/channels', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    // Locked channels and categories are left out rather than listed and refused.
    const access = channelAccessFor(db.sqlite, auth.user.id);
    const channels = visibleChannels(db.sqlite, access);
    // Only the channels just listed are asked about, so a channel this member
    // cannot see is not even considered, let alone reported as having news.
    const channelIds = channels.map((channel) => channel.id);
    const mentionCounts = countUnreadMentions(db.sqlite, auth.user.id, channelIds);
    const body: ChannelListResponse = {
      categories: visibleCategories(db.sqlite, access).map(toCategory),
      channels: channels.map(toChannel),
      unreadChannelIds: listUnreadChannelIds(db.sqlite, auth.user.id, channelIds),
      // The channels that hold an unread mention or reply, and how many, which
      // is what draws the red number beside a channel.
      mentionChannelIds: Object.keys(mentionCounts),
      mentionCounts,
      readMarkers: listReadMarkers(db.sqlite, auth.user.id, channelIds),
      // Freshly read every time, so a client picks up an admin's change on reload.
      defaultChannelId: settings.get().defaultChannelId,
    };
    return body;
  });

  /**
   * Records that the caller has read a channel up to now, which is what clears
   * the mark beside it in their sidebar. Marking is up to the newest message
   * rather than to the wall clock, so a message that arrives in the same moment
   * is still counted as new.
   */
  app.post('/api/v1/channels/:id/read', async (request, reply) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const { id } = request.params as { id: string };
    requireChannelRow(id);
    if (!canAccessChannel(db.sqlite, channelAccessFor(db.sqlite, auth.user.id), id)) {
      throw new HttpError(403, 'channel_forbidden', 'You do not have access to that channel.');
    }

    markChannelRead(db.sqlite, auth.user.id, id, newestMessageAt(db.sqlite, id) ?? new Date().toISOString());
    return reply.status(204).send();
  });

  /** The linked Discord server's channel list, for the import picker. */
  app.get('/api/v1/channels/discord', async (request) => {
    requirePermission(request, Permission.ManageChannels);
    const body: DiscordChannelImportPreview = await deps.importer.discordChannels();
    return body;
  });

  /**
   * Creates a Harmony channel for every Discord channel not yet bridged, recreating
   * its category too. Safe to run again: already-bridged channels are skipped.
   */
  app.post('/api/v1/channels/import', async (request) => {
    requirePermission(request, Permission.ManageChannels);
    const input = parseBody(channelImportSchema, request.body ?? {});
    const body: ChannelImportResponse = await deps.importer.importMissing(input);
    return body;
  });

  app.post('/api/v1/channels', async (request) => {
    requirePermission(request, Permission.ManageChannels);
    const input = parseBody(createChannelSchema, request.body);
    const categoryId = input.categoryId ?? null;
    if (categoryId) requireCategoryRow(categoryId);

    // A voice channel carries no messages, so a Discord bridge and slowmode, which
    // only apply to text, are ignored rather than stored and never used.
    const type = input.type ?? 'text';
    const discordChannelId = type === 'voice' ? null : (input.discordChannelId ?? null);
    if (discordChannelId) assertDiscordChannelFree(discordChannelId, null);

    const requiredRoleId = input.requiredRoleId ?? null;
    if (requiredRoleId) assertRoleExists(requiredRoleId);

    const id = randomUUID();
    insertChannel(db.sqlite, {
      id,
      name: input.name,
      topic: input.topic ?? null,
      categoryId,
      type,
      position: nextChannelPosition(db.sqlite, categoryId),
      createdAt: new Date().toISOString(),
      discordChannelId,
      requiredRoleId,
      slowmodeSeconds: type === 'voice' ? 0 : (input.slowmodeSeconds ?? 0),
    });

    const channel = toChannel(requireChannelRow(id));
    hub.dispatch(GatewayEvent.ChannelCreate, channel, { channelId: channel.id });
    if (channel.discordChannelId) {
      deps.serverLog.info('bridge_channel_linked', channel.name, {
        channelName: channel.name,
        discordChannelId: channel.discordChannelId,
      });
      backfill(channel.id);
    }
    return channel;
  });

  app.patch('/api/v1/channels/:id', async (request) => {
    requirePermission(request, Permission.ManageChannels);
    const { id } = request.params as { id: string };
    const row = requireChannelRow(id);

    const input = parseBody(updateChannelSchema, request.body);
    // A new role requirement, or a move into a locked category, can hide the
    // channel from members who see it now, so remember who they are.
    const before = hub.audience({ channelId: id });
    if (input.categoryId) requireCategoryRow(input.categoryId);
    if (input.discordChannelId) assertDiscordChannelFree(input.discordChannelId, id);
    if (input.requiredRoleId) assertRoleExists(input.requiredRoleId);

    // Moving a channel to another category appends it to the end of that one,
    // unless a position was given. Otherwise it would keep a position from its
    // old category that can collide with the target's ordering.
    let position = input.position;
    if (input.categoryId !== undefined && input.categoryId !== row.category_id) {
      position = nextChannelPosition(db.sqlite, input.categoryId);
    }

    updateChannel(db.sqlite, id, {
      name: input.name,
      topic: input.topic,
      categoryId: input.categoryId,
      position,
      discordChannelId: input.discordChannelId,
      requiredRoleId: input.requiredRoleId,
      slowmodeSeconds: input.slowmodeSeconds,
    });

    const channel = toChannel(requireChannelRow(id));
    hub.dispatch(GatewayEvent.ChannelUpdate, channel, { channelId: channel.id });
    hub.dispatchLostAccess(GatewayEvent.ChannelDelete, { id }, before, { channelId: id });
    if (input.discordChannelId) {
      deps.serverLog.info('bridge_channel_linked', channel.name, {
        channelName: channel.name,
        discordChannelId: input.discordChannelId,
      });
      backfill(channel.id);
    }
    return channel;
  });

  /** Moves a channel one step up or down inside its own category. */
  app.post('/api/v1/channels/:id/move', async (request) => {
    requirePermission(request, Permission.ManageChannels);
    const { id } = request.params as { id: string };
    requireChannelRow(id);

    const input = parseBody(moveSchema, request.body);
    moveChannel(db.sqlite, id, input.direction);

    const channel = toChannel(requireChannelRow(id));
    hub.dispatch(GatewayEvent.ChannelUpdate, channel, { channelId: channel.id });
    return channel;
  });

  /**
   * Announces that the caller is typing in a channel. Best effort: the client
   * throttles these, and a member who turned typing indicators off is silent.
   */
  app.post('/api/v1/channels/:id/typing', async (request, reply) => {
    const auth = requirePermission(request, Permission.SendMessages);
    const { id } = request.params as { id: string };
    requireChannelRow(id);
    assertNotTimedOut(auth);
    if (!canAccessChannel(db.sqlite, channelAccessFor(db.sqlite, auth.user.id), id)) {
      throw new HttpError(403, 'channel_forbidden', 'You do not have access to that channel.');
    }
    typingLimiter.check(auth.user.id);

    if (auth.user.showTyping) {
      const payload: TypingStartPayload = { channelId: id, user: auth.user };
      hub.dispatch(GatewayEvent.TypingStart, payload, { channelId: id });
    }
    return reply.status(204).send();
  });

  app.delete('/api/v1/channels/:id', async (request, reply) => {
    requirePermission(request, Permission.ManageChannels);
    const { id } = request.params as { id: string };
    requireChannelRow(id);

    // Once the row is gone the access check cannot tell who could see it, so the
    // audience is taken first. Checked afterwards, only administrators heard.
    const audience = hub.audience({ channelId: id });
    deleteChannel(db.sqlite, id);
    // Do not leave the default pointing at a channel that no longer exists.
    if (settings.get().defaultChannelId === id) settings.update({ defaultChannelId: null });
    hub.dispatchToUsers(GatewayEvent.ChannelDelete, { id }, audience);
    return reply.status(204).send();
  });

  app.post('/api/v1/categories', async (request) => {
    requirePermission(request, Permission.ManageChannels);
    const input = parseBody(createCategorySchema, request.body);

    const requiredRoleId = input.requiredRoleId ?? null;
    if (requiredRoleId) assertRoleExists(requiredRoleId);

    const id = randomUUID();
    insertCategory(db.sqlite, {
      id,
      name: input.name,
      position: nextCategoryPosition(db.sqlite),
      requiredRoleId,
    });

    const category = toCategory(requireCategoryRow(id));
    hub.dispatch(GatewayEvent.CategoryCreate, category, { categoryId: category.id });
    return category;
  });

  app.patch('/api/v1/categories/:id', async (request) => {
    requirePermission(request, Permission.ManageChannels);
    const { id } = request.params as { id: string };
    requireCategoryRow(id);

    const input = parseBody(updateCategorySchema, request.body);
    if (input.requiredRoleId) assertRoleExists(input.requiredRoleId);
    const before = hub.audience({ categoryId: id });
    updateCategory(db.sqlite, id, {
      name: input.name,
      position: input.position,
      requiredRoleId: input.requiredRoleId,
    });

    const category = toCategory(requireCategoryRow(id));
    hub.dispatch(GatewayEvent.CategoryUpdate, category, { categoryId: category.id });
    // Members the new lock shuts out are told the category is gone for them,
    // which takes its channels out of their sidebar along with it.
    hub.dispatchLostAccess(GatewayEvent.CategoryDelete, { id }, before, { categoryId: id });
    return category;
  });

  /** Moves a category one step up or down in the sidebar. */
  app.post('/api/v1/categories/:id/move', async (request) => {
    requirePermission(request, Permission.ManageChannels);
    const { id } = request.params as { id: string };
    requireCategoryRow(id);

    const input = parseBody(moveSchema, request.body);
    moveCategory(db.sqlite, id, input.direction);

    const category = toCategory(requireCategoryRow(id));
    hub.dispatch(GatewayEvent.CategoryUpdate, category, { categoryId: category.id });
    return category;
  });

  app.delete('/api/v1/categories/:id', async (request, reply) => {
    requirePermission(request, Permission.ManageChannels);
    const { id } = request.params as { id: string };
    requireCategoryRow(id);

    // Deleting a category would orphan its channels, which then show up in no
    // category at all. Refuse instead, and let the admin move or delete them.
    const orphans = countChannelsInCategory(db.sqlite, id);
    if (orphans > 0) {
      throw new HttpError(409, 'category_not_empty', 'Move or delete the channels in this category first.');
    }

    deleteCategory(db.sqlite, id);
    hub.dispatch(GatewayEvent.CategoryDelete, { id }, { categoryId: id });
    return reply.status(204).send();
  });
}
