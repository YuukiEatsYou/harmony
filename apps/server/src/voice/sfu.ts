import { MediaStream, MediaStreamTrack, RTCPeerConnection } from 'werift';

/**
 * The server end of a voice room, as a selective forwarder. It terminates one
 * WebRTC connection per member and relays each member's encoded audio to the
 * others. It never decodes, mixes or re-encodes: an Opus payload arrives on one
 * connection and is written, unchanged, to the outbound slots of the others. So
 * no member's IP is ever exposed to another, and the server's work is packet
 * forwarding and DTLS, not audio.
 *
 * Negotiation is non-trickle: `setLocalDescription` gathers candidates before it
 * resolves, so an offer carries them and no candidate relay is needed. Only the
 * server offers, so there is no glare, and a per-connection queue keeps one
 * offer outstanding at a time. A member joining or leaving adds or drops an
 * audio slot on the others' connections, which is one re-offer each.
 *
 * The caller owns the room: it checks permissions and the size limit, and tells
 * the SFU when a member joins or leaves. The SFU trusts its room membership.
 */

/** How the SFU reaches a member's client; the gateway carries these in practice. */
export interface SfuSignals {
  /** Sends an SDP offer for the member's connection; the client answers it. */
  sendOffer(userId: string, channelId: string, sdp: string): void;
}

export interface Sfu {
  /** Adds a member to a room, negotiating their connection and the others'. */
  join(userId: string, channelId: string): Promise<void>;
  /** Applies the SDP answer a member's client sent back for the last offer. */
  answer(userId: string, sdp: string): Promise<void>;
  /** Removes a member, closing their connection and re-offering the others. */
  leave(userId: string): Promise<void>;
  /** Closes every connection; on shutdown. */
  close(): void;
}

export interface SfuOptions {
  /** UDP range the ICE agent may bind, so a firewall can open exactly that range. */
  portRange?: [number, number];
  /** A public IP to advertise as a host candidate when the host is behind NAT. */
  publicIp?: string | null;
  /**
   * Where connection-level events go. The relay is deliberately silent, which is
   * fine until audio does not arrive and there is nothing to look at; this is the
   * seam an operator can watch.
   */
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

interface Peer {
  userId: string;
  channelId: string;
  pc: RTCPeerConnection;
  /** This member's own audio, once it has arrived. */
  inbound: MediaStreamTrack | null;
  /** Outbound slot per other member, keyed by that member's id. */
  outbound: Map<string, MediaStreamTrack>;
  /** Forwarding pipes per producer, keyed by that member's id, so one leaves cleanly. */
  pipes: Map<string, Array<() => void>>;
  /** Serialises re-offers: only one may be outstanding on a connection. */
  queue: Promise<void>;
  /** True while an offer is out and unanswered; a further change waits for it. */
  awaitingAnswer: boolean;
  /** A change arrived mid-negotiation, so one more offer is owed. */
  needsOffer: boolean;
  closed: boolean;
}

/** A member with a live connection. `channelId` is validated by the caller. */
export function createSfu(signals: SfuSignals, options: SfuOptions = {}): Sfu {
  const peers = new Map<string, Peer>();
  const log = options.log ?? ((): void => {});

  /** The config every connection is made with. */
  const peerConfig = {
    ...(options.portRange ? { icePortRange: options.portRange } : {}),
    ...(options.publicIp ? { iceAdditionalHostAddresses: [options.publicIp] } : {}),
  };

  function room(channelId: string): Peer[] {
    return [...peers.values()].filter((peer) => peer.channelId === channelId && !peer.closed);
  }

  /**
   * Sends an offer for a connection, but only when none is outstanding: a client
   * can answer one offer at a time, so a change that arrives mid-negotiation is
   * remembered and offered again once the answer comes back.
   */
  function reoffer(peer: Peer): void {
    if (peer.closed) return;
    if (peer.awaitingAnswer) {
      peer.needsOffer = true;
      return;
    }
    peer.awaitingAnswer = true;
    peer.queue = peer.queue
      .then(async () => {
        if (peer.closed) return;
        await peer.pc.setLocalDescription(await peer.pc.createOffer());
        if (peer.pc.localDescription) signals.sendOffer(peer.userId, peer.channelId, peer.pc.localDescription.sdp);
      })
      .catch(() => undefined);
  }

  /** Re-offers everyone in a room, once each, after its membership changed. */
  function reofferRoom(channelId: string): void {
    for (const peer of room(channelId)) reoffer(peer);
  }

  /**
   * Starts piping a producer's audio into one of a consumer's outbound slots.
   * No-op when that pipe already exists, so it is safe to call again whenever
   * the producer's track finally arrives.
   */
  function pipe(producer: Peer, consumer: Peer, slot: MediaStreamTrack): void {
    if (!producer.inbound || consumer.pipes.has(producer.userId)) return;
    const subscription = producer.inbound.onReceiveRtp.subscribe((packet) => {
      if (!consumer.closed) slot.writeRtp(packet);
    });
    consumer.pipes.set(producer.userId, [() => subscription.unSubscribe()]);
  }

  /** A consumer's outbound slot carrying a producer's audio, made on demand. */
  function connect(producer: Peer, consumer: Peer): void {
    if (consumer.outbound.has(producer.userId)) return;
    const slot = new MediaStreamTrack({ kind: 'audio' });
    // The msid carries the producer's member id, so the receiving client can tell
    // whose audio each relayed track is: a speaking indicator needs that, and the
    // roster order is not reliable enough to guess it from.
    const source = new MediaStream([slot]);
    source.id = producer.userId;
    // A dedicated send-only line. Not addTrack: addTrack reuses the member's own
    // receive-only microphone line when the slot is the first thing the connection
    // sends, fusing both directions onto one sendrecv m-line. That is legal SDP and
    // werift tolerates it, but Chromium hands the received audio nowhere on such a
    // line while Firefox plays it, which is exactly the one-way call users hit. A
    // receive-only microphone line plus one send-only line per forwarded stream is
    // what an SFU is supposed to offer.
    consumer.pc.addTransceiver(slot, { direction: 'sendonly', streams: [source] });
    consumer.outbound.set(producer.userId, slot);
    pipe(producer, consumer, slot);
  }

  /** Brings one member's connection in step with everyone else in the room. */
  function reconcile(peer: Peer): void {
    for (const other of room(peer.channelId)) {
      if (other === peer) continue;
      connect(other, peer);
      connect(peer, other);
    }
  }

  /** Drops a consumer's slot and pipes for a producer, used when one leaves. */
  function disconnect(consumer: Peer, producerId: string): void {
    consumer.outbound.delete(producerId);
    for (const unsubscribe of consumer.pipes.get(producerId) ?? []) unsubscribe();
    consumer.pipes.delete(producerId);
  }

  return {
    async join(userId, channelId) {
      if (peers.has(userId)) await this.leave(userId);
      log('voice_sfu_join', { userId, channelId, room: room(channelId).map((peer) => peer.userId) });

      const pc = new RTCPeerConnection(peerConfig);
      const peer: Peer = {
        userId,
        channelId,
        pc,
        inbound: null,
        outbound: new Map(),
        pipes: new Map(),
        queue: Promise.resolve(),
        awaitingAnswer: false,
        needsOffer: false,
        closed: false,
      };
      // The member's own microphone: one receive-only audio line.
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.onTrack.subscribe((track) => {
        peer.inbound = track;
        // Slots made before the track arrived can be wired up now.
        for (const consumer of room(channelId)) {
          if (consumer === peer) continue;
          const slot = consumer.outbound.get(userId);
          if (slot) pipe(peer, consumer, slot);
        }
      });

      peers.set(userId, peer);
      reconcile(peer);
      reofferRoom(channelId);
    },

    async answer(userId, sdp) {
      const peer = peers.get(userId);
      if (!peer || peer.closed) return;
      await peer.pc.setRemoteDescription({ type: 'answer', sdp });
      peer.awaitingAnswer = false;
      // A change that arrived while this answer was in flight is offered now.
      if (peer.needsOffer) {
        peer.needsOffer = false;
        reoffer(peer);
      }
    },

    async leave(userId) {
      const peer = peers.get(userId);
      if (!peer) return;
      log('voice_sfu_leave', { userId });
      peer.closed = true;
      peers.delete(userId);
      for (const subscriptions of peer.pipes.values()) for (const unsubscribe of subscriptions) unsubscribe();
      for (const other of room(peer.channelId)) disconnect(other, userId);
      reofferRoom(peer.channelId);
      try {
        await peer.pc.close();
      } catch {
        // Closing a connection that already failed is nothing to report.
      }
    },

    close() {
      for (const peer of peers.values()) {
        peer.closed = true;
        for (const subscriptions of peer.pipes.values()) for (const unsubscribe of subscriptions) unsubscribe();
        void Promise.resolve(peer.pc.close()).catch(() => undefined);
      }
      peers.clear();
    },
  };
}
