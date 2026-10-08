import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayEvent,
  Permission,
  hasPermission,
  type VoiceSignalPayload,
  type VoiceState,
  type VoiceStateUpdatePayload,
} from '@harmony/shared';
import { canAccessChannel, channelAccessFor } from '../access/service.ts';
import { resolvePermissions } from '../auth/permissions.ts';
import { findChannel } from '../db/channels.ts';
import { findUserById, presentUser } from '../db/users.ts';
import { HttpError } from '../http/errors.ts';
import type { GatewayHub } from '../realtime/hub.ts';
import type { SettingsService } from '../settings/service.ts';
import { createSfu } from './sfu.ts';

/** One member's voice presence, as it is held in memory. */
interface Membership {
  channelId: string;
  muted: boolean;
  deafened: boolean;
}

export interface VoiceService {
  /** Joins a voice channel, moving the member out of any channel they were in. */
  join(userId: string, channelId: string): Promise<void>;
  /** Leaves whatever voice channel the member is in, if any. */
  leave(userId: string): Promise<void>;
  /** Sets the member's own mute and deafen flags. */
  update(userId: string, patch: { muted?: boolean; deafened?: boolean }): void;
  /** Applies the SDP answer a member's client sent for the current offer. */
  answer(userId: string, sdp: string): Promise<void>;
  /** The members in one channel, for a REST response. */
  room(channelId: string): VoiceState[];
  /** Every non-empty room the member may see, for a freshly loaded client. */
  snapshot(userId: string): Array<{ channelId: string; members: VoiceState[] }>;
  /** The voice channel a member is in, or null. */
  channelOf(userId: string): string | null;
  /** Drops a member who has gone fully offline, i.e. has no other live connection. */
  handleOffline(userId: string): void;
  /** Closes every media connection; on shutdown. */
  close(): void;
}

export interface VoiceDeps {
  sqlite: DatabaseSync;
  hub: GatewayHub;
  settings: SettingsService;
  /** UDP range the media relay binds, and a public IP to advertise behind NAT. */
  portRange?: [number, number];
  publicIp?: string | null;
}

/**
 * Voice presence and its media relay. Presence is who is in which room and how
 * they are set; the media is delegated to the SFU, which forwards encoded audio
 * without decoding it. The two are kept apart: this file owns membership and
 * permissions, `sfu.ts` owns the WebRTC connections, and the room roster is what
 * the SFU trusts.
 *
 * Like presence, membership lives in memory: a restart empties every room and
 * closes every connection, which is correct, since the connections are gone too.
 */
export function createVoiceService(deps: VoiceDeps): VoiceService {
  const { sqlite, hub } = deps;
  /** userId -> membership. A member is in at most one voice channel. */
  const members = new Map<string, Membership>();
  /** channelId -> member ids, for a quick roster and the room-size check. */
  const rooms = new Map<string, Set<string>>();

  // The SFU reaches members only through the gateway: an offer goes to that one
  // member's sessions, and their client answers it over REST.
  const sfu = createSfu(
    {
      sendOffer(userId, channelId, sdp) {
        const payload: VoiceSignalPayload = { channelId, sdp };
        hub.dispatchToUsers(GatewayEvent.VoiceSignal, payload, new Set([userId]));
      },
    },
    { portRange: deps.portRange, publicIp: deps.publicIp },
  );

  function room(channelId: string): VoiceState[] {
    const ids = rooms.get(channelId);
    if (!ids || ids.size === 0) return [];
    const states: VoiceState[] = [];
    for (const userId of ids) {
      const membership = members.get(userId);
      const row = findUserById(sqlite, userId);
      if (!membership || !row) continue;
      states.push({
        channelId,
        user: presentUser(sqlite, row),
        muted: membership.muted,
        deafened: membership.deafened,
      });
    }
    return states;
  }

  /** Announces a channel's roster; only members who can see the channel hear it. */
  function broadcast(channelId: string): void {
    const payload: VoiceStateUpdatePayload = { channelId, members: room(channelId) };
    hub.dispatch(GatewayEvent.VoiceStateUpdate, payload, { channelId });
  }

  function drop(userId: string, membership: Membership): void {
    rooms.get(membership.channelId)?.delete(userId);
    if (rooms.get(membership.channelId)?.size === 0) rooms.delete(membership.channelId);
    members.delete(userId);
  }

  async function leave(userId: string): Promise<void> {
    const membership = members.get(userId);
    if (!membership) return;
    drop(userId, membership);
    await sfu.leave(userId).catch(() => undefined);
    broadcast(membership.channelId);
  }

  return {
    room,
    channelOf: (userId) => members.get(userId)?.channelId ?? null,
    snapshot(userId) {
      const access = channelAccessFor(sqlite, userId);
      const result: Array<{ channelId: string; members: VoiceState[] }> = [];
      for (const channelId of rooms.keys()) {
        if (!canAccessChannel(sqlite, access, channelId)) continue;
        const occupants = room(channelId);
        if (occupants.length > 0) result.push({ channelId, members: occupants });
      }
      return result;
    },
    leave,
    handleOffline: (userId) => {
      void leave(userId);
    },

    async join(userId, channelId) {
      const user = findUserById(sqlite, userId);
      if (!user) throw new HttpError(404, 'user_not_found', 'That member does not exist.');

      const channel = findChannel(sqlite, channelId);
      if (!channel) throw new HttpError(404, 'channel_not_found', 'That channel does not exist.');
      if (channel.type !== 'voice') {
        throw new HttpError(400, 'not_a_voice_channel', 'That channel is not a voice channel.');
      }
      if (!canAccessChannel(sqlite, channelAccessFor(sqlite, userId), channelId)) {
        throw new HttpError(403, 'channel_forbidden', 'You do not have access to that channel.');
      }
      if (!hasPermission(resolvePermissions(sqlite, user), Permission.ConnectVoice)) {
        throw new HttpError(403, 'voice_forbidden', 'You cannot join voice channels.');
      }

      const existing = members.get(userId);
      if (existing?.channelId === channelId) return;

      // The seat is counted against the room being joined, and only taken if one
      // is free; being in another room already does not reserve one here.
      const limit = deps.settings.get().maxVoiceMembers;
      if (limit > 0 && (rooms.get(channelId)?.size ?? 0) >= limit) {
        throw new HttpError(409, 'voice_full', 'That voice channel is full.');
      }

      if (existing) {
        drop(userId, existing);
        await sfu.leave(userId).catch(() => undefined);
        broadcast(existing.channelId);
      }

      const membership: Membership = { channelId, muted: false, deafened: false };
      members.set(userId, membership);
      const occupants = rooms.get(channelId) ?? new Set<string>();
      occupants.add(userId);
      rooms.set(channelId, occupants);
      broadcast(channelId);

      // Presence is live even if the media connection fails to come up; a member
      // would rather be listed and try audio again than be refused outright.
      try {
        await sfu.join(userId, channelId);
      } catch {
        drop(userId, membership);
        broadcast(channelId);
        throw new HttpError(502, 'voice_unavailable', 'Could not start a voice connection.');
      }
    },

    async answer(userId, sdp) {
      await sfu.answer(userId, sdp);
    },

    update(userId, patch) {
      const membership = members.get(userId);
      if (!membership) throw new HttpError(409, 'not_in_voice', 'You are not in a voice channel.');
      if (patch.muted !== undefined) membership.muted = patch.muted;
      if (patch.deafened !== undefined) membership.deafened = patch.deafened;
      broadcast(membership.channelId);
    },

    close() {
      sfu.close();
    },
  };
}
