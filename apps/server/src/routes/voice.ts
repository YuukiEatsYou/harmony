import type { FastifyInstance } from 'fastify';
import {
  Permission,
  voiceAnswerSchema,
  voiceStatePatchSchema,
  type VoiceRoomResponse,
  type VoiceRoomsResponse,
} from '@harmony/shared';
import { requireAuth, requirePermission } from '../auth/plugin.ts';
import { HttpError } from '../http/errors.ts';
import { parseBody } from '../http/validation.ts';
import type { VoiceService } from '../voice/service.ts';

export interface VoiceRouteDeps {
  voice: VoiceService;
}

/**
 * Joining, leaving and muting in a voice channel. Audio never passes through
 * here — or any Harmony route: these carry presence only, and the media is
 * relayed by the SFU over UDP. Joining is a POST to the channel's voice room;
 * leaving and muting are scoped to the channel the member is actually in.
 */
export function registerVoiceRoutes(app: FastifyInstance, deps: VoiceRouteDeps): void {
  const { voice } = deps;

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
