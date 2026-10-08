import type {
  VoiceRoomResponse,
  VoiceSignalPayload,
  VoiceState,
  VoiceStateUpdatePayload,
} from '@harmony/shared';
import { api } from './api';

/**
 * The client's voice session. All audio is handled here in the browser: the
 * microphone is captured with echo cancellation, noise suppression and gain
 * control, encoded by the browser's own WebRTC stack, and played back from the
 * relay. The server never sees audio, so apart from the UI this file is the whole
 * client side of a call.
 *
 * The server is the only party that offers. This side answers every offer it is
 * sent, so a renegotiation (someone joining or leaving the room) is just
 * answering again; there is nothing to coordinate.
 */
class VoiceStore {
  /** The channel this member is connected to, or null. */
  channelId = $state<string | null>(null);
  /** Everyone in the channel this member is in. */
  members = $state<VoiceState[]>([]);
  /** Rosters for other channels, so the sidebar can show who is where. */
  rosters = $state<Record<string, VoiceState[]>>({});
  connecting = $state(false);
  muted = $state(false);
  deafened = $state(false);
  error = $state<string | null>(null);

  #pc: RTCPeerConnection | null = null;
  #mic: MediaStream | null = null;
  #remote = new MediaStream();
  #audio: HTMLAudioElement | null = null;
  /** An offer that arrived before the connection was ready to answer it. */
  #offer: string | null = null;

  /** Handles the voice gateway frames; `chat` forwards them here. */
  handleFrame(frame: { t?: string; d?: unknown }): void {
    if (frame.t === 'VOICE_STATE_UPDATE') {
      const payload = frame.d as VoiceStateUpdatePayload;
      this.rosters = { ...this.rosters, [payload.channelId]: payload.members };
      if (payload.channelId === this.channelId) this.members = payload.members;
    } else if (frame.t === 'VOICE_SIGNAL') {
      const payload = frame.d as VoiceSignalPayload;
      if (payload.channelId === this.channelId) void this.#answer(payload.sdp);
    }
  }

  /** Answers a server offer. Buffered if the connection is not up yet. */
  async #answer(sdp: string): Promise<void> {
    const pc = this.#pc;
    if (!pc) {
      this.#offer = sdp;
      return;
    }
    const channelId = this.channelId;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      if (channelId && pc.localDescription) {
        await api(`/channels/${channelId}/voice/answer`, {
          method: 'POST',
          body: JSON.stringify({ sdp: pc.localDescription.sdp }),
        });
      }
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /** The remote audio element, made on first use and kept for the session. */
  #ensureAudio(): HTMLAudioElement {
    if (!this.#audio) {
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = this.#remote;
      audio.muted = this.deafened;
      void audio.play().catch(() => undefined);
      this.#audio = audio;
    }
    return this.#audio;
  }

  /** Joins a channel, or moves there from another one. */
  async join(channelId: string): Promise<void> {
    if (this.channelId === channelId || this.connecting) return;
    await this.leave();
    this.connecting = true;
    this.error = null;
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.#mic = mic;

      this.#remote = new MediaStream();
      this.#audio = null;
      const pc = new RTCPeerConnection({ iceServers: [] });
      this.#pc = pc;
      pc.ontrack = (event) => {
        this.#remote.addTrack(event.track);
        this.#ensureAudio();
      };
      for (const track of mic.getTracks()) pc.addTrack(track, mic);

      // The id is set before the request so an offer that races the response is
      // still recognised as ours and answered.
      this.channelId = channelId;
      const room = await api<VoiceRoomResponse>(`/channels/${channelId}/voice`, { method: 'POST' });
      this.members = room.members;
      this.rosters = { ...this.rosters, [channelId]: room.members };

      if (this.#offer) {
        const buffered = this.#offer;
        this.#offer = null;
        await this.#answer(buffered);
      }
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause);
      await this.leave();
    } finally {
      this.connecting = false;
    }
  }

  /** Leaves the channel, tearing down the microphone and the connection. */
  async leave(): Promise<void> {
    const channelId = this.channelId;
    this.channelId = null;
    this.members = [];
    this.#offer = null;
    this.#pc?.close();
    this.#pc = null;
    for (const track of this.#mic?.getTracks() ?? []) track.stop();
    this.#mic = null;
    this.#remote = new MediaStream();
    if (this.#audio) {
      this.#audio.pause();
      this.#audio.srcObject = null;
      this.#audio = null;
    }
    this.muted = false;
    this.deafened = false;
    if (channelId) await api(`/channels/${channelId}/voice`, { method: 'DELETE' }).catch(() => undefined);
  }

  setMuted(next: boolean): void {
    this.muted = next;
    this.#applyMic();
    this.#sync();
  }

  setDeafened(next: boolean): void {
    this.deafened = next;
    if (this.#audio) this.#audio.muted = next;
    this.#applyMic();
    this.#sync();
  }

  /** Discord's rule: a deafened member is also muted, without touching their setting. */
  #applyMic(): void {
    const live = !this.muted && !this.deafened;
    for (const track of this.#mic?.getAudioTracks() ?? []) track.enabled = live;
  }

  #sync(): void {
    if (!this.channelId) return;
    void api(`/channels/${this.channelId}/voice`, {
      method: 'PATCH',
      body: JSON.stringify({ muted: this.muted, deafened: this.deafened }),
    }).catch(() => undefined);
  }

  /** Drops everything without telling the server; used when the session ends. */
  reset(): void {
    this.#offer = null;
    this.#pc?.close();
    this.#pc = null;
    for (const track of this.#mic?.getTracks() ?? []) track.stop();
    this.#mic = null;
    this.#remote = new MediaStream();
    if (this.#audio) {
      this.#audio.pause();
      this.#audio.srcObject = null;
      this.#audio = null;
    }
    this.channelId = null;
    this.members = [];
    this.rosters = {};
    this.muted = false;
    this.deafened = false;
    this.error = null;
  }
}

export const voice = new VoiceStore();
