import type { DatabaseSync } from 'node:sqlite';
import {
  GatewayEvent,
  Permission,
  hasPermission,
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

/** One member's voice presence, as it is held in memory. */
interface Membership {
  channelId: string;
  muted: boolean;
  deafened: boolean;
}

export interface VoiceService {
  /** Joins a voice channel, moving the member out of any channel they were in. */
  join(userId: string, channelId: string): void;
  /** Leaves whatever voice channel the member is in, if any. */
  leave(userId: string): void;
  /** Sets the member's own mute and deafen flags. */
  update(userId: string, patch: { muted?: boolean; deafened?: boolean }): void;
  /** The members in one channel, for a REST response. */
  room(channelId: string): VoiceState[];
  /** The voice channel a member is in, or null. */
  channelOf(userId: string): string | null;
  /** Drops a member who has gone fully offline, i.e. has no other live connection. */
  handleOffline(userId: string): void;
}

export interface VoiceDeps {
  sqlite: DatabaseSync;
  hub: GatewayHub;
  settings: SettingsService;
}

/**
 * Voice presence: who is in which voice channel and how they are set. It is
 * deliberately only presence — the audio is relayed by the SFU and never
 * decoded, so nothing here sees or touches a media packet, and the state is tiny.
 *
 * Like presence, it lives in memory: a restart empties every room, which is
 * correct, since the underlying connections are gone with it.
 */
export function createVoiceService(deps: VoiceDeps): VoiceService {
  const { sqlite, hub } = deps;
  /** userId -> membership. A member is in at most one voice channel. */
  const members = new Map<string, Membership>();
  /** channelId -> member ids, for a quick roster and the room-size check. */
  const rooms = new Map<string, Set<string>>();

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

  function leave(userId: string): void {
    const membership = members.get(userId);
    if (!membership) return;
    drop(userId, membership);
    broadcast(membership.channelId);
  }

  return {
    room,
    channelOf: (userId) => members.get(userId)?.channelId ?? null,
    leave,
    handleOffline: leave,

    join(userId, channelId) {
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
        broadcast(existing.channelId);
      }

      members.set(userId, { channelId, muted: false, deafened: false });
      const occupants = rooms.get(channelId) ?? new Set<string>();
      occupants.add(userId);
      rooms.set(channelId, occupants);
      broadcast(channelId);
    },

    update(userId, patch) {
      const membership = members.get(userId);
      if (!membership) throw new HttpError(409, 'not_in_voice', 'You are not in a voice channel.');
      if (patch.muted !== undefined) membership.muted = patch.muted;
      if (patch.deafened !== undefined) membership.deafened = patch.deafened;
      broadcast(membership.channelId);
    },
  };
}
