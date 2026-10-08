import type { FastifyInstance } from 'fastify';
import { ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES, API_VERSION, LIMITS, type InstanceMeta } from '@harmony/shared';
import type { Config } from '../config.ts';
import type { SettingsService } from '../settings/service.ts';

/** Public, unauthenticated information a client needs before signing in. */
export function registerMetaRoutes(app: FastifyInstance, deps: { config: Config; settings: SettingsService }): void {
  app.get('/api/v1/meta', async () => {
    const settings = deps.settings.get();
    const discord = deps.settings.getDiscordAuth();
    const body: InstanceMeta = {
      name: settings.serverName,
      apiVersion: API_VERSION,
      requireInvite: settings.requireInvite,
      theme: settings.theme,
      iconHash: deps.settings.getIconHash(),
      maxImageBytes: settings.maxImageBytes,
      maxVideoBytes: settings.maxVideoBytes,
      allowedImageTypes: ALLOWED_IMAGE_TYPES,
      allowedVideoTypes: ALLOWED_VIDEO_TYPES,
      klipyConfigured: settings.klipyConfigured,
      gifStorage: settings.gifStorage,
      // Offered only when it is configured, switched on, and reachable from the
      // internet, since Discord has to be able to call us back.
      discordAuthEnabled:
        discord.enabled && discord.clientId !== null && discord.clientSecret !== null &&
        deps.settings.discordRedirectUri() !== null,
      limits: {
        messageLength: LIMITS.messageLength,
        attachmentsPerMessage: LIMITS.attachmentsPerMessage,
        channelNameMax: LIMITS.channelName.max,
        usernameMin: LIMITS.username.min,
        usernameMax: LIMITS.username.max,
        passwordMin: LIMITS.password.min,
      },
      screenShare: { height: settings.screenShareHeight, frameRate: settings.screenShareFrameRate },
    };
    return body;
  });
}
