import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_VIDEO_BYTES,
  DEFAULT_MAX_VOICE_MEMBERS,
  GatewayEvent,
  HARMONY_VERSION_SOURCE_URL,
  MAX_UPLOAD_CEILING_BYTES,
  type UpdateAvailablePayload,
} from '@harmony/shared';
import { loadConfig } from './config.ts';
import { Database } from './db/index.ts';
import { countUsers } from './db/users.ts';
import { canSeeResource, channelAccessFor } from './access/service.ts';
import { createAuthService } from './auth/service.ts';
import { createDiscordOAuthService } from './auth/discord-oauth.ts';
import { registerAuth } from './auth/plugin.ts';
import { createAuditService } from './audit/service.ts';
import { createServerLogService } from './log/service.ts';
import { createBotService } from './bots/service.ts';
import { createCommandService } from './commands/service.ts';
import { createSettingsService } from './settings/service.ts';
import { createIconService } from './settings/icon.ts';
import { createAttachmentService } from './attachments/service.ts';
import { createEmojiService } from './emojis/service.ts';
import { createEmojiImportService } from './emojis/import.ts';
import { createStickerService } from './stickers/service.ts';
import { createUserService } from './users/service.ts';
import { createMessageService } from './messages/service.ts';
import { createPinService } from './pins/service.ts';
import { createSavedMessageService } from './saved/service.ts';
import { createScheduledMessageService } from './scheduled/service.ts';
import { createPollService } from './polls/service.ts';
import { createEventService } from './events/service.ts';
import { createVoiceService } from './voice/service.ts';
import { GatewayHub } from './realtime/hub.ts';
import { createPruner } from './retention/pruner.ts';
import { createUpdateService } from './update/service.ts';
import { createUpdateApplier } from './update/apply.ts';
import { createBridgeService } from './bridge/service.ts';
import { createDiscordTransport } from './bridge/discordjs.ts';
import { createChannelImportService } from './channels/import.ts';
import { createEmbedService } from './embeds/service.ts';
import { createModerationService } from './moderation/service.ts';
import { createMediaService } from './media/service.ts';
import { createGifService } from './gifs/service.ts';
import { createServerGifService } from './gifs/server-gifs.ts';
import { createGifSourceService } from './gifs/sources.ts';
import { registerErrorHandler } from './http/errors.ts';
import { registerSecurityHeaders, warnAboutExposure } from './http/security.ts';
import { registerWebClient, webClientIndex } from './http/webclient.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerMetaRoutes } from './routes/meta.ts';
import { registerManifestRoutes } from './routes/manifest.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerDiscordRoutes } from './routes/discord.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerIconRoutes } from './routes/icon.ts';
import { registerRoleRoutes } from './routes/roles.ts';
import { registerNameColorRoutes } from './routes/name-colors.ts';
import { registerMemberRoutes } from './routes/members.ts';
import { registerInviteRoutes } from './routes/invites.ts';
import { registerChannelRoutes } from './routes/channels.ts';
import { registerMessageRoutes } from './routes/messages.ts';
import { registerSearchRoutes } from './routes/search.ts';
import { registerMentionRoutes } from './routes/mentions.ts';
import { registerPinRoutes } from './routes/pins.ts';
import { registerSavedRoutes } from './routes/saved.ts';
import { registerScheduledRoutes } from './routes/scheduled.ts';
import { registerPollRoutes } from './routes/polls.ts';
import { registerEventRoutes } from './routes/events.ts';
import { registerAttachmentRoutes } from './routes/attachments.ts';
import { registerEmbedRoutes } from './routes/embeds.ts';
import { registerEmojiRoutes } from './routes/emojis.ts';
import { registerStickerRoutes } from './routes/stickers.ts';
import { registerMediaRoutes } from './routes/media.ts';
import { registerGifRoutes } from './routes/gifs.ts';
import { registerServerGifRoutes } from './routes/server-gifs.ts';
import { registerUserRoutes } from './routes/users.ts';
import { registerBotRoutes } from './routes/bots.ts';
import { registerCommandRoutes } from './routes/commands.ts';
import { registerChannelSettingsRoutes } from './routes/channel-settings.ts';
import { registerVoiceRoutes } from './routes/voice.ts';
import { registerRetentionRoutes } from './routes/retention.ts';
import { registerBridgeRoutes } from './routes/bridge.ts';
import { registerAuditRoutes } from './routes/audit.ts';
import { registerServerLogRoutes } from './routes/server-log.ts';
import { registerUpdateRoutes } from './routes/update.ts';
import { registerBackupRoutes } from './routes/backup.ts';
import { registerGateway } from './gateway/index.ts';

const config = loadConfig();
// A per-process id. The update panel returns it so a client can tell that a restart
// happened (and the new build is serving) rather than infer it from timing.
const instanceId = randomUUID();
const db = new Database(config);
const serverLog = createServerLogService(db.sqlite);
const hub = new GatewayHub();
// Locked channels stay out of the gateway traffic of members who cannot see them.
hub.setVisibilityResolver((userId, visibility) =>
  canSeeResource(db.sqlite, channelAccessFor(db.sqlite, userId), visibility),
);
const settingsService = createSettingsService(db.sqlite, {
  serverName: config.serverName,
  requireInvite: config.requireInvite,
  defaultChannelId: null,
  embedsEnabled: true,
  theme: { background: null, accent: null },
  // Null in both means "work it out from the uploaded image".
  icon: { padding: null, background: null },
  maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
  maxVideoBytes: DEFAULT_MAX_VIDEO_BYTES,
  previewUserAgent: null,
  setupCompleted: false,
  maxVoiceMembers: DEFAULT_MAX_VOICE_MEMBERS,
});
const authService = createAuthService(db.sqlite, config, settingsService);
const discordOAuth = createDiscordOAuthService(settingsService);
const auditService = createAuditService(db.sqlite);
const attachmentService = createAttachmentService(db.sqlite, config, settingsService);
const emojiService = createEmojiService(db.sqlite, config);
const stickerService = createStickerService(db.sqlite, config);
const iconService = createIconService(config, settingsService);
const userService = createUserService(db.sqlite, config);
const botService = createBotService(db.sqlite);
const commandService = createCommandService(db.sqlite, hub);
const voiceService = createVoiceService({
  sqlite: db.sqlite,
  hub,
  settings: settingsService,
  portRange: config.voicePortRange,
  publicIp: config.voicePublicIp,
});
const messageService = createMessageService(db.sqlite, hub, auditService);
const pinService = createPinService(db.sqlite, hub, auditService, messageService);
const savedService = createSavedMessageService(db.sqlite, hub, messageService);
const scheduledService = createScheduledMessageService({
  sqlite: db.sqlite,
  hub,
  messages: messageService,
  tickMs: config.scheduledTickMs,
  minLeadMs: config.scheduledMinLeadMs,
  serverLog,
});
const pollService = createPollService(db.sqlite, hub, messageService, {
  // A test hook: the smoke test shortens the wait for the expiry sweep.
  sweepMs: Number(process.env.HARMONY_POLL_SWEEP_MS) || undefined,
});
const eventService = createEventService(db.sqlite, hub, messageService, auditService, {
  // Test hooks: the smoke test shortens the sweep, the reminder lead and the default length.
  sweepMs: Number(process.env.HARMONY_EVENT_SWEEP_MS) || undefined,
  reminderLeadMs: process.env.HARMONY_EVENT_REMINDER_LEAD_MS
    ? Number(process.env.HARMONY_EVENT_REMINDER_LEAD_MS)
    : undefined,
  defaultDurationMs: Number(process.env.HARMONY_EVENT_DEFAULT_DURATION_MS) || undefined,
});
const moderationService = createModerationService({ sqlite: db.sqlite, hub, audit: auditService });
const mediaService = createMediaService(db.sqlite, config);
const gifSources = createGifSourceService(db.sqlite, config, { attachments: attachmentService });
const gifService = createGifService(db.sqlite, config, {
  attachments: attachmentService,
  settings: settingsService,
  sources: gifSources,
});
const serverGifService = createServerGifService(db.sqlite, {
  attachments: attachmentService,
  gifs: gifService,
  audit: auditService,
  hub,
});

const app = Fastify({ logger: { level: config.logLevel }, trustProxy: config.trustProxy });

const pruner = createPruner({
  sqlite: db.sqlite,
  config,
  settings: settingsService,
  hub,
  log: (message, detail) => app.log.info(detail ?? {}, message),
  serverLog,
});

// Checks the version this instance runs against the newest on its update branch.
// Off unless the owner turns the daily check on; a found release is broadcast so
// any connected owner client can say so.
const updateService = createUpdateService({
  settings: settingsService,
  // A fork edits HARMONY_VERSION_SOURCE_URL in the shared constants to point at
  // its own file; an empty value switches the check off entirely.
  sourceUrl: HARMONY_VERSION_SOURCE_URL.length > 0 ? HARMONY_VERSION_SOURCE_URL : null,
  notify: (status) => {
    if (status.latest === null) return;
    const payload: UpdateAvailablePayload = { running: status.running, latest: status.latest };
    hub.dispatch(GatewayEvent.UpdateAvailable, payload);
  },
  log: (message, detail) => app.log.info(detail ?? {}, message),
});

// The manual "Update now" path. It does nothing unless HARMONY_UPDATE_COMMAND is set;
// a successful apply exits cleanly and lets the supervisor (systemd, pm2, Docker)
// start the new build, since this process has no privilege to restart itself.
const updateApplier = createUpdateApplier({
  sqlite: db.sqlite,
  config,
  settings: settingsService,
  serverLog,
  onSuccess: () => void shutdown('update'),
});

// Set once the bridge exists, so a pasted Discord attachment link can be renewed
// through Discord. Null until then, and while the bridge is offline.
let refreshDiscordAttachment: ((url: string) => Promise<string | null>) | null = null;

// Unfurls one link per message into a small preview. It listens for local
// messages only and pushes updates straight to the gateway, so the bridge never
// mistakes a preview for a user edit.
const embedService = createEmbedService({
  sqlite: db.sqlite,
  settings: settingsService,
  hub,
  attachments: attachmentService,
  sources: gifSources,
  renderMessage: (messageId) => messageService.byId(messageId),
  refreshDiscordAttachment: (url) => refreshDiscordAttachment?.(url) ?? Promise.resolve(null),
  log: (message, detail) => app.log.debug(detail ?? {}, message),
});
messageService.onMessageCreated((message) => embedService.resolve(message.id, message.content));
messageService.onMessageEdited((message) => embedService.resolve(message.id, message.content));

const bridgeLogger = {
  info: (message: string, detail?: unknown) => app.log.info(detail ?? {}, message),
  debug: (message: string, detail?: unknown) => app.log.debug(detail ?? {}, message),
};

const bridge = createBridgeService({
  sqlite: db.sqlite,
  config,
  settings: settingsService,
  messages: messageService,
  polls: pollService,
  users: userService,
  hub,
  pins: pinService,
  logger: bridgeLogger,
  transportFactory: (token, logger) => createDiscordTransport(token, logger),
  serverLog,
  // A link posted on Discord should preview here too. Previews are pushed
  // straight to the gateway, so this never mirrors itself back out.
  resolvePreview: (messageId, content) => embedService.resolve(messageId, content),
});

// Hand the embed service the bridge it can renew Discord attachment links through.
refreshDiscordAttachment = (url) => bridge.refreshDiscordAttachment(url);

// Copies the linked guild's custom emoji in on demand from the emoji panel.
const emojiImport = createEmojiImportService({
  emojis: emojiService,
  bridge,
  log: (message, detail) => app.log.info(detail ?? {}, message),
});

// Recreates the linked guild's channels, bridging each one, from the channels panel.
const channelImport = createChannelImportService({
  sqlite: db.sqlite,
  bridge,
  hub,
  log: (message, detail) => app.log.info(detail ?? {}, message),
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_CEILING_BYTES, files: 1 } });
// A client only ever sends a heartbeat or an identify, so there is no reason to
// accept a large frame: cap it rather than let a socket buffer megabytes.
await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

// Serve the built client from this process when there is one, so a production
// instance is a single origin. In development there is no build and the Vite
// dev server fronts the app instead.
const servingClient = await registerWebClient(app, { dir: config.webDir });

// Warn about settings that turn a working instance into an unsafe one.
warnAboutExposure(app.log, {
  host: config.host,
  cookieSecure: config.cookieSecure,
  requireInvite: config.requireInvite,
  userCount: countUsers(db.sqlite),
});

registerErrorHandler(app, { spaIndex: webClientIndex(config.webDir), serverLog });
registerSecurityHeaders(app, { csp: config.csp, linkedGifs: () => settingsService.getGifStorage() === 'link' });
registerAuth(app, { cookieName: config.cookieName, resolveToken: authService.resolveToken });

registerHealthRoutes(app, db);
registerMetaRoutes(app, { config, settings: settingsService });
registerManifestRoutes(app, { settings: settingsService, icon: iconService });
registerAuthRoutes(app, { service: authService, config });
registerDiscordRoutes(app, {
  db,
  config,
  settings: settingsService,
  oauth: discordOAuth,
  auth: authService,
  users: userService,
  hub,
  bridge,
});
registerSettingsRoutes(app, { settings: settingsService, db });
registerIconRoutes(app, { icon: iconService });
registerRetentionRoutes(app, { settings: settingsService, pruner });
registerAuditRoutes(app, { audit: auditService });
registerServerLogRoutes(app, { serverLog });
registerUpdateRoutes(app, {
  settings: settingsService,
  update: updateService,
  applier: updateApplier,
  updateCommand: config.updateCommand,
  instanceId,
});
registerBackupRoutes(app, { db, config, settings: settingsService, audit: auditService, serverLog });
registerBridgeRoutes(app, { settings: settingsService, bridge });
registerRoleRoutes(app, { db, hub });
registerNameColorRoutes(app, { db, hub });
registerMemberRoutes(app, {
  db,
  hub,
  moderation: moderationService,
  audit: auditService,
  users: userService,
  bridge,
});
registerInviteRoutes(app, db);
registerChannelRoutes(app, { db, hub, bridge, settings: settingsService, importer: channelImport, serverLog });
registerMessageRoutes(app, { service: messageService });
registerSearchRoutes(app, { service: messageService });
registerMentionRoutes(app, { service: messageService });
registerPinRoutes(app, { service: pinService });
registerSavedRoutes(app, { service: savedService });
registerScheduledRoutes(app, { service: scheduledService });
registerPollRoutes(app, { service: pollService });
registerEventRoutes(app, { service: eventService });
registerAttachmentRoutes(app, { service: attachmentService, settings: settingsService });
registerEmbedRoutes(app, { settings: settingsService, service: embedService });
registerMediaRoutes(app, { service: mediaService, audit: auditService });
registerGifRoutes(app, { service: gifService, sources: gifSources, settings: settingsService, audit: auditService });
registerServerGifRoutes(app, { service: serverGifService });
registerEmojiRoutes(app, { service: emojiService, importer: emojiImport, hub });
registerStickerRoutes(app, { service: stickerService });
registerUserRoutes(app, { db, users: userService, hub, bridge });
registerBotRoutes(app, { bots: botService, commands: commandService, users: userService, hub });
registerCommandRoutes(app, { commands: commandService, hub });
registerChannelSettingsRoutes(app, { db, hub });
registerVoiceRoutes(app, { voice: voiceService });
registerGateway(app, {
  heartbeatIntervalMs: config.gatewayHeartbeatMs,
  cookieName: config.cookieName,
  resolveToken: authService.resolveToken,
  hub,
  // A member who goes fully offline leaves whatever voice channel they were in.
  onUserOffline: (userId) => voiceService.handleOffline(userId),
});

app.addHook('onClose', async () => {
  pruner.stop();
  updateService.stop();
  scheduledService.stop();
  pollService.stop();
  eventService.stop();
  voiceService.close();
  await bridge.shutdown();
  db.close();
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info(`Harmony is listening on ${address}`);
  serverLog.info('instance_started', 'Instance started');
  if (servingClient) {
    app.log.info(`Serving the web client from ${config.webDir}`);
  } else {
    app.log.info('No web client build found; serve apps/web/dist separately, or run npm run build:web');
  }
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

// Pruning runs once at startup, then on the configured interval.
pruner.start();
pollService.start();
eventService.start();

// Schedules the daily update check when the owner has switched it on.
updateService.start();

// Deliver anything that came due while the server was down, then keep watching the clock.
scheduledService.start();

// Connect the Discord bot if the bridge was left enabled.
await bridge.applySettings();

// The Discord picture sync: an immediate catch-up, then an hourly look that only
// touches members whose last check is over a day old. Kept off the bridge's own
// connect path so a reconnect does not re-run the sweep; the per-member stamp is
// what actually holds it to once a day.
const runAvatarSync = (): void => {
  void bridge.syncDueDiscordAvatars().catch((error) => app.log.error(error));
};
const avatarSyncTimer = setInterval(runAvatarSync, 60 * 60 * 1000);
avatarSyncTimer.unref();
runAvatarSync();
