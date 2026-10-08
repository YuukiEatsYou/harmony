import type {
  VoiceRoomResponse,
  VoiceRoomsResponse,
  VoiceSignalPayload,
  VoiceState,
  VoiceStateUpdatePayload,
} from '@harmony/shared';
import { api } from './api';
import { session } from './session.svelte';
import { playSound } from './sounds';

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
 *
 * Each relayed track carries its producer's member id as the stream id, so a
 * track can be matched to the member it belongs to — that is what a speaking
 * indicator needs.
 */

/** Root-mean-square above which a track counts as someone talking. */
const speakingLevel = 0.015;
/** How often the speaking indicators are recomputed. */
const speakingPollMs = 120;

interface RemoteAudio {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  gain: GainNode;
}

class VoiceStore {
  /** The channel this member is connected to, or null. */
  channelId = $state<string | null>(null);
  /** Everyone in the channel this member is in. */
  members = $state<VoiceState[]>([]);
  /** Rosters for other channels, so the sidebar can show who is where. */
  rosters = $state<Record<string, VoiceState[]>>({});
  /** Member ids currently talking, for the speaking indicators. */
  speaking = $state<Record<string, boolean>>({});
  connecting = $state(false);
  muted = $state(false);
  deafened = $state(false);
  error = $state<string | null>(null);

  #pc: RTCPeerConnection | null = null;
  #mic: MediaStream | null = null;
  #ctx: AudioContext | null = null;
  /** Everything remote is played through this, so deafening is one gain. */
  #master: GainNode | null = null;
  #remote = new Map<string, RemoteAudio>();
  /** One analyser per speaker, the local microphone included. */
  #analysers = new Map<string, AnalyserNode>();
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  /** The member ids in the room on the last roster, for the join/leave sounds. */
  #lastMembers = new Set<string>();
  #rosterReady = false;
  /** An offer that arrived before the connection was ready to answer it. */
  #offer: string | null = null;

  /** Handles the voice gateway frames; `chat` forwards them here. */
  handleFrame(frame: { t?: string; d?: unknown }): void {
    if (frame.t === 'VOICE_STATE_UPDATE') {
      const payload = frame.d as VoiceStateUpdatePayload;
      this.rosters = { ...this.rosters, [payload.channelId]: payload.members };
      if (payload.channelId === this.channelId) {
        this.members = payload.members;
        this.#applyRoster(payload.members);
      }
    } else if (frame.t === 'VOICE_SIGNAL') {
      const payload = frame.d as VoiceSignalPayload;
      if (payload.channelId === this.channelId) void this.#answer(payload.sdp);
    }
  }

  /** Plays a chime when a member other than you joins or leaves the room. */
  #applyRoster(members: VoiceState[]): void {
    const ids = new Set(members.map((entry) => entry.user.id));
    const me = session.user?.id ?? null;
    // The first roster after joining is the baseline: the people already there
    // did not just arrive, so nothing is announced for them.
    if (this.#rosterReady) {
      const joined = [...ids].some((id) => id !== me && !this.#lastMembers.has(id));
      const left = [...this.#lastMembers].some((id) => id !== me && !ids.has(id));
      if (joined) playSound('voiceConnect');
      if (left) playSound('voiceDisconnect');
    }
    this.#lastMembers = ids;
    this.#rosterReady = true;
  }

  /**
   * Fetches who is in each voice channel now. Called once on load, since the
   * per-channel events only arrive as changes are made; without it a client that
   * loads while somebody is already talking would show an empty room.
   */
  async load(): Promise<void> {
    try {
      const data = await api<VoiceRoomsResponse>('/voice');
      const rosters: Record<string, VoiceState[]> = {};
      for (const entry of data.channels) rosters[entry.channelId] = entry.members;
      this.rosters = rosters;
    } catch {
      // A failed load leaves the sidebar without rosters until the next event.
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

  /** Wires one incoming track up for playback and for the speaking indicator. */
  #attachRemote(userId: string, track: MediaStreamTrack): void {
    const ctx = this.#ctx;
    const master = this.#master;
    if (!ctx || !master || this.#remote.has(userId)) return;
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const gain = ctx.createGain();
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(master);
    this.#remote.set(userId, { source, analyser, gain });
    this.#analysers.set(userId, analyser);
  }

  /** Root-mean-square of one analyser's current window. */
  #level(analyser: AnalyserNode): number {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const value of data) sum += value * value;
    return Math.sqrt(sum / data.length);
  }

  /** Recomputes who is talking, and only touches state when it changes. */
  #poll(): void {
    const next: Record<string, boolean> = {};
    for (const [userId, analyser] of this.#analysers) {
      if (this.#level(analyser) > speakingLevel) next[userId] = true;
    }
    if (JSON.stringify(next) !== JSON.stringify(this.speaking)) this.speaking = next;
  }

  /** Tears down the audio graph, the meter, and the microphone. */
  #teardown(): void {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    for (const node of this.#remote.values()) {
      node.source.disconnect();
      node.analyser.disconnect();
      node.gain.disconnect();
    }
    this.#remote.clear();
    this.#analysers.clear();
    this.speaking = {};
    this.#master?.disconnect();
    this.#master = null;
    for (const track of this.#mic?.getTracks() ?? []) track.stop();
    this.#mic = null;
    this.#lastMembers = new Set();
    this.#rosterReady = false;
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

      // Everything remote plays through the master gain, so deafening is one
      // change; the local microphone runs through an analyser only, into a silent
      // sink so the meter is pulled without echoing you back.
      const ctx = this.#ctx ?? new AudioContext();
      this.#ctx = ctx;
      void ctx.resume().catch(() => undefined);
      const master = ctx.createGain();
      master.gain.value = this.deafened ? 0 : 1;
      master.connect(ctx.destination);
      this.#master = master;
      const micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 512;
      const silent = ctx.createGain();
      silent.gain.value = 0;
      const micSource = ctx.createMediaStreamSource(mic);
      micSource.connect(micAnalyser);
      micAnalyser.connect(silent);
      silent.connect(ctx.destination);
      const me = session.user?.id;
      if (me) this.#analysers.set(me, micAnalyser);
      this.#pollTimer = setInterval(() => this.#poll(), speakingPollMs);

      const pc = new RTCPeerConnection({ iceServers: [] });
      this.#pc = pc;
      pc.ontrack = (event) => {
        // The relay names each track's producer in its stream id.
        const userId = event.streams[0]?.id ?? 'unknown';
        this.#attachRemote(userId, event.track);
      };
      for (const track of mic.getTracks()) pc.addTrack(track, mic);

      // The id is set before the request so an offer that races the response is
      // still recognised as ours and answered.
      this.channelId = channelId;
      const room = await api<VoiceRoomResponse>(`/channels/${channelId}/voice`, { method: 'POST' });
      this.members = room.members;
      this.rosters = { ...this.rosters, [channelId]: room.members };
      // Anyone already in the room is a baseline, not a fresh arrival.
      this.#lastMembers = new Set(room.members.map((entry) => entry.user.id));
      this.#rosterReady = true;

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
    this.#teardown();
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
    if (this.#master) this.#master.gain.value = next ? 0 : 1;
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
    this.#teardown();
    this.channelId = null;
    this.members = [];
    this.rosters = {};
    this.muted = false;
    this.deafened = false;
    this.error = null;
  }
}

export const voice = new VoiceStore();
