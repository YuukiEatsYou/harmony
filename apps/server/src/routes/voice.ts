import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  Permission,
  voiceAnswerSchema,
  voiceStatePatchSchema,
  type IceServerConfig,
  type VoiceIceResponse,
  type VoiceRoomResponse,
  type VoiceRoomsResponse,
} from '@harmony/shared';
import { requireAuth, requirePermission } from '../auth/plugin.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody } from '../http/validation.ts';
import type { ServerSettings, SettingsService } from '../settings/service.ts';
import type { VoiceService } from '../voice/service.ts';

/** How long minted TURN credentials last, and what clients are told to cache. */
const ICE_TTL_SECONDS = 3600;

export interface VoiceRouteDeps {
  voice: VoiceService;
  settings: SettingsService;
}

/**
 * The ICE configuration for one client. STUN is plain. TURN gets credentials in
 * coturn's REST scheme — the username carries an expiry and the member, and the
 * credential is that username hashed under the shared secret — so a credential
 * that leaks stops working when it expires. With nothing configured the list is
 * empty and the route still answers `200`, so a client never has to branch on an
 * error. That TURN is not in `/meta` is the point: `/meta` is unauthenticated and
 * relay bandwidth must not be an open door.
 */
function iceResponse(settings: ServerSettings, turnSecret: string | null, userId: string): VoiceIceResponse {
  const iceServers: IceServerConfig[] = [];
  for (const url of settings.stunUrls) iceServers.push({ urls: [url] });
  if (turnSecret && settings.turnUrls.length > 0) {
    const expiry = Math.floor(Date.now() / 1000) + ICE_TTL_SECONDS;
    const username = `${expiry}:${userId}`;
    const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
    for (const url of settings.turnUrls) iceServers.push({ urls: [url], username, credential });
  }
  return { iceServers, ttlSeconds: ICE_TTL_SECONDS };
}

/**
 * Joining, leaving and muting in a voice channel. Audio never passes through
 * here — or any Harmony route: these carry presence only, and the media is
 * relayed by the SFU over UDP. Joining is a POST to the channel's voice room;
 * leaving and muting are scoped to the channel the member is actually in.
 */
export function registerVoiceRoutes(app: FastifyInstance, deps: VoiceRouteDeps): void {
  const { voice, settings } = deps;

  function room(channelId: string): VoiceRoomResponse {
    return { channelId, members: voice.room(channelId) };
  }

  /**
   * Which voice channels have members right now. A client fetches this once on
   * load, since the per-channel events only arrive as changes are made.
   */
  app.get('/api/v1/voice', async (request) => {
    const auth = requirePermission(request, Permission.ViewChannels);
    const body: VoiceRoomsResponse = { channels: voice.snapshot(auth.user.id) };
    return body;
  });

  /**
   * The ICE servers this client should use. TURN credentials are minted here, per
   * request, and never leave the server any other way.
   */
  app.get('/api/v1/voice/ice', async (request) => {
    const auth = requirePermission(request, Permission.ConnectVoice);
    return iceResponse(settings.get(), settings.getTurnSecret(), auth.user.id);
  });

  app.post('/api/v1/channels/:channelId/voice', async (request) => {
    const auth = requirePermission(request, Permission.ConnectVoice);
    const { channelId } = request.params as { channelId: string };
    await voice.join(auth.user.id, channelId);
    return room(channelId);
  });

  /**
   * The client's answer to the offer it was sent over the gateway. Only the
   * server ever offers, so this is the whole client-to-server media path.
   */
  app.post('/api/v1/channels/:channelId/voice/answer', async (request, reply) => {
    const auth = requireAuth(request);
    const { channelId } = request.params as { channelId: string };
    if (voice.channelOf(auth.user.id) !== channelId) {
      throw new HttpError(409, 'not_in_voice', 'You are not in that voice channel.');
    }
    const input = parseBody(voiceAnswerSchema, request.body);
    await voice.answer(auth.user.id, input.sdp);
    return reply.status(204).send();
  });

  /**
   * Restarts the caller's ICE and re-offers, for a client that changed networks
   * and cannot offer itself (the server is the only offerer). The fresh offer
   * arrives as `VOICE_SIGNAL` and is answered through the route above, exactly
   * like any other. `409 not_in_voice` when the caller is not in that channel,
   * which includes having already been reaped, so a client falls back to rejoining.
   */
  app.post('/api/v1/channels/:channelId/voice/renegotiate', async (request, reply) => {
    const auth = requireAuth(request);
    const { channelId } = request.params as { channelId: string };
    if (voice.channelOf(auth.user.id) !== channelId) {
      throw new HttpError(409, 'not_in_voice', 'You are not in that voice channel.');
    }
    voice.renegotiate(auth.user.id);
    return reply.status(204).send();
  });

  app.patch('/api/v1/channels/:channelId/voice', async (request) => {
    const auth = requireAuth(request);
    const { channelId } = request.params as { channelId: string };
    if (voice.channelOf(auth.user.id) !== channelId) {
      throw new HttpError(409, 'not_in_voice', 'You are not in that voice channel.');
    }
    const input = parseBody(voiceStatePatchSchema, request.body);
    voice.update(auth.user.id, input);
    return room(channelId);
  });

  app.delete('/api/v1/channels/:channelId/voice', async (request, reply) => {
    const auth = requireAuth(request);
    const { channelId } = request.params as { channelId: string };
    if (voice.channelOf(auth.user.id) !== channelId) {
      throw new HttpError(409, 'not_in_voice', 'You are not in that voice channel.');
    }
    await voice.leave(auth.user.id);
    return reply.status(204).send();
  });
}
