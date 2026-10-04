import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_VIDEO_BYTES,
  MAX_UPLOAD_CEILING_BYTES,
} from '@harmony/shared';
import { loadConfig } from './config.ts';
import { Database } from './db/index.ts';
import { countUsers } from './db/users.ts';
import { canSeeResource, channelAccessFor } from './access/service.ts';
import { createAuthService } from './auth/service.ts';
import { createDiscordOAuthService } from './auth/discord-oauth.ts';
import { registerAuth } from './auth/plugin.ts';
import { createAuditService } from './audit/service.ts';
import { createSettingsService } from './settings/service.ts';
import { createIconService } from './settings/icon.ts';
import { createAttachmentService } from './attachments/service.ts';
import { createEmojiService } from './emojis/service.ts';
import { createEmojiImportService } from './emojis/import.ts';
import { createStickerService } from './stickers/service.ts';
import { createUserService } from './users/service.ts';
import { createMessageService } from './messages/service.ts';
import { GatewayHub } from './realtime/hub.ts';
import { createPruner } from './retention/pruner.ts';
import { createBridgeService } from './bridge/service.ts';
import { createDiscordTransport } from './bridge/discordjs.ts';
import { createChannelImportService } from './channels/import.ts';
import { createEmbedService } from './embeds/service.ts';
import { createModerationService } from './moderation/service.ts';
import { createMediaService } from './media/service.ts';
import { createGifService } from './gifs/service.ts';
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
import { registerMemberRoutes } from './routes/members.ts';
import { registerInviteRoutes } from './routes/invites.ts';
import { registerChannelRoutes } from './routes/channels.ts';
import { registerMessageRoutes } from './routes/messages.ts';
import { registerSearchRoutes } from './routes/search.ts';
import { registerMentionRoutes } from './routes/mentions.ts';
import { registerAttachmentRoutes } from './routes/attachments.ts';
import { registerEmbedRoutes } from './routes/embeds.ts';
import { registerEmojiRoutes } from './routes/emojis.ts';
import { registerStickerRoutes } from './routes/stickers.ts';
import { registerMediaRoutes } from './routes/media.ts';
import { registerGifRoutes } from './routes/gifs.ts';
import { registerUserRoutes } from './routes/users.ts';
import { registerRetentionRoutes } from './routes/retention.ts';
import { registerBridgeRoutes } from './routes/bridge.ts';
import { registerAuditRoutes } from './routes/audit.ts';
import { registerGateway } from './gateway/index.ts';

const config = loadConfig();
const db = new Database(config);
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
});
const authService = createAuthService(db.sqlite, config, settingsService);
const discordOAuth = createDiscordOAuthService(settingsService);
const auditService = createAuditService(db.sqlite);
const attachmentService = createAttachmentService(db.sqlite, config, settingsService);
const emojiService = createEmojiService(db.sqlite, config);
const stickerService = createStickerService(db.sqlite, config);
const iconService = createIconService(config, settingsService);
const userService = createUserService(db.sqlite, config);
const messageService = createMessageService(db.sqlite, hub, auditService);
const moderationService = createModerationService({ sqlite: db.sqlite, hub, audit: auditService });
const mediaService = createMediaService(db.sqlite, config);
const gifService = createGifService(db.sqlite, config, {
  attachments: attachmentService,
  settings: settingsService,
});

const app = Fastify({ logger: { level: config.logLevel }, trustProxy: config.trustProxy });

const pruner = createPruner({
  sqlite: db.sqlite,
  config,
  settings: settingsService,
  hub,
  log: (message, detail) => app.log.info(detail ?? {}, message),
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
  users: userService,
  hub,
  logger: bridgeLogger,
  transportFactory: (token, logger) => createDiscordTransport(token, logger),
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

registerErrorHandler(app, { spaIndex: webClientIndex(config.webDir) });
registerSecurityHeaders(app, { csp: config.csp });
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
});
registerSettingsRoutes(app, { settings: settingsService, db });
registerIconRoutes(app, { icon: iconService });
registerRetentionRoutes(app, { settings: settingsService, pruner });
registerAuditRoutes(app, { audit: auditService });
registerBridgeRoutes(app, { settings: settingsService, bridge });
registerRoleRoutes(app, { db, hub });
registerMemberRoutes(app, {
  db,
  hub,
  moderation: moderationService,
  audit: auditService,
  users: userService,
  bridge,
});
registerInviteRoutes(app, db);
registerChannelRoutes(app, { db, hub, bridge, settings: settingsService, importer: channelImport });
registerMessageRoutes(app, { service: messageService });
registerSearchRoutes(app, { service: messageService });
registerMentionRoutes(app, { service: messageService });
registerAttachmentRoutes(app, { service: attachmentService, settings: settingsService });
registerEmbedRoutes(app, { settings: settingsService });
registerMediaRoutes(app, { service: mediaService, audit: auditService });
registerGifRoutes(app, { service: gifService });
registerEmojiRoutes(app, { service: emojiService, importer: emojiImport, hub });
registerStickerRoutes(app, { service: stickerService });
registerUserRoutes(app, { db, users: userService, hub });
registerGateway(app, {
  heartbeatIntervalMs: config.gatewayHeartbeatMs,
  cookieName: config.cookieName,
  resolveToken: authService.resolveToken,
  hub,
});

app.addHook('onClose', async () => {
  pruner.stop();
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

// Connect the Discord bot if the bridge was left enabled.
await bridge.applySettings();
