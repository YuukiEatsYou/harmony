import { MediaStream, MediaStreamTrack, RTCPeerConnection } from 'werift';

/**
 * The server end of a voice room, as a selective forwarder. It terminates one
 * WebRTC connection per member and relays each member's encoded media to the
 * others. It never decodes, mixes or re-encodes: an Opus or VP8 payload arrives
 * on one connection and is written, unchanged, to the outbound slots of the
 * others. So no member's IP is ever exposed to another, and the server's work is
 * packet forwarding and DTLS, not media.
 *
 * Each member's connection carries, from the moment they join, a receive-only
 * line for their own microphone and one for their screen, plus a send-only slot
 * per other member for that member's microphone and screen. Nothing is negotiated
 * when somebody starts or stops sharing: the client attaches its screen track to
 * the send-only line that is already there, and the relay simply starts or stops
 * copying packets into the slot. Renegotiation happens only when the room's
 * membership changes.
 *
 * Video needs one extra thing audio does not: a consumer that has just started
 * receiving, or lost packets, only gets a picture at the next keyframe, so the
 * SFU forwards a consumer's picture-loss request to the producer.
 *
 * Negotiation is non-trickle: `setLocalDescription` gathers candidates before it
 * resolves, so an offer carries them and no candidate relay is needed. Only the
 * server offers, so there is no glare, and a per-connection queue keeps one
 * offer outstanding at a time.
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
  /**
   * Starts or stops forwarding one producer's screen to one consumer. A screen is
   * only relayed to the consumers that asked for it, so a member who never opts in
   * costs no bandwidth; asking for one that is live requests a keyframe so the
   * picture starts immediately.
   */
  watch(userId: string, producerId: string, watching: boolean): void;
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
   * fine until media does not arrive and there is nothing to look at; this is the
   * seam an operator can watch.
   */
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

interface Peer {
  userId: string;
  channelId: string;
  pc: RTCPeerConnection;
  /** This member's own microphone, once it has arrived. */
  inbound: MediaStreamTrack | null;
  /** This member's own screen, once it has arrived. */
  videoInbound: MediaStreamTrack | null;
  /** The member's screen SSRC, learned from its first packet, to ask for keyframes. */
  videoSsrc: number | null;
  /** Outbound audio slot per other member, keyed by that member's id. */
  outbound: Map<string, MediaStreamTrack>;
  /** Outbound screen slot per other member, keyed by that member's id. */
  videoOutbound: Map<string, MediaStreamTrack>;
  /** Forwarding pipes per producer, keyed by that member's id, so one leaves cleanly. */
  pipes: Map<string, Array<() => void>>;
  /** Screen pipes per producer, including the keyframe requests they carry. */
  videoPipes: Map<string, Array<() => void>>;
  /** Producers whose screens this member has opted in to watch, by member id. */
  watching: Set<string>;
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

  /** Asks a producer's client for a fresh keyframe, once its screen SSRC is known. */
  function requestKeyframe(producer: Peer): void {
    if (producer.videoSsrc === null) return;
    const receiver = producer.pc.getReceivers().find((entry) => entry.kind === 'video');
    void receiver?.sendRtcpPLI(producer.videoSsrc).catch(() => undefined);
  }

  /**
   * Starts piping a producer's microphone into one of a consumer's outbound slots.
   * No-op when that pipe already exists, so it is safe to call again whenever the
   * producer's track finally arrives.
   */
  function pipe(producer: Peer, consumer: Peer, slot: MediaStreamTrack): void {
    if (!producer.inbound || consumer.pipes.has(producer.userId)) return;
    const subscription = producer.inbound.onReceiveRtp.subscribe((packet) => {
      if (!consumer.closed) slot.writeRtp(packet);
    });
    consumer.pipes.set(producer.userId, [() => subscription.unSubscribe()]);
  }

  /**
   * Starts piping a producer's screen into a consumer's outbound slot. Nothing is
   * written until the consumer opts in to watch, so a screen costs a viewer no
   * bandwidth until they ask for it; the pipe is still subscribed, which is what
   * lets the relay learn the producer's SSRC even with no viewer.
   */
  function pipeVideo(producer: Peer, consumer: Peer, slot: MediaStreamTrack): void {
    if (!producer.videoInbound || consumer.videoPipes.has(producer.userId)) return;
    const rtp = producer.videoInbound.onReceiveRtp.subscribe((packet) => {
      // The SSRC is only known once the producer has sent something, and it is
      // what a keyframe request has to name.
      const first = producer.videoSsrc === null;
      if (first) producer.videoSsrc = packet.header.ssrc;
      if (consumer.closed || !consumer.watching.has(producer.userId)) return;
      // The first forwarded packet is rarely a keyframe, so ask for one now.
      if (first) requestKeyframe(producer);
      slot.writeRtp(packet);
    });
    consumer.videoPipes.set(producer.userId, [() => rtp.unSubscribe()]);
    // A viewer that opted in before the picture arrived needs a keyframe to start.
    if (consumer.watching.has(producer.userId)) requestKeyframe(producer);
  }

  /** A consumer's outbound slot carrying a producer's microphone, made on demand. */
  function connect(producer: Peer, consumer: Peer): void {
    if (consumer.outbound.has(producer.userId)) return;
    const slot = new MediaStreamTrack({ kind: 'audio' });
    // The msid carries the producer's member id, so the receiving client can tell
    // whose audio each relayed track is: a speaking indicator needs that, and the
    // roster order is not reliable enough to guess it from.
    const source = new MediaStream([slot]);
    source.id = producer.userId;
    // A dedicated send-only line. Not addTrack: addTrack reuses the member's own
    // receive-only line when the slot is the first thing the connection sends,
    // fusing both directions onto one sendrecv m-line, which Chromium will not
    // play back. A receive-only line plus one send-only line per forwarded stream
    // is what an SFU is supposed to offer.
    consumer.pc.addTransceiver(slot, { direction: 'sendonly', streams: [source] });
    consumer.outbound.set(producer.userId, slot);
    pipe(producer, consumer, slot);
  }

  /** The same, for the producer's screen. */
  function connectVideo(producer: Peer, consumer: Peer): void {
    if (consumer.videoOutbound.has(producer.userId)) return;
    const slot = new MediaStreamTrack({ kind: 'video' });
    const source = new MediaStream([slot]);
    source.id = producer.userId;
    const transceiver = consumer.pc.addTransceiver(slot, { direction: 'sendonly', streams: [source] });
    consumer.videoOutbound.set(producer.userId, slot);
    pipeVideo(producer, consumer, slot);
    // A viewer that has just started, or dropped frames, asks the producer for a
    // keyframe through the consumer's own line rather than a frozen tile.
    transceiver.sender.onPictureLossIndication.subscribe(() => requestKeyframe(producer));
  }

  /** Brings one member's connection in step with everyone else in the room. */
  function reconcile(peer: Peer): void {
    for (const other of room(peer.channelId)) {
      if (other === peer) continue;
      connect(other, peer);
      connectVideo(other, peer);
      connect(peer, other);
      connectVideo(peer, other);
    }
  }

  /**
   * Drops a consumer's slots and pipes for a producer, used when one leaves. The
   * consumer's opt-in is kept, so a producer that rejoins is streamed again without
   * the viewer having to ask a second time.
   */
  function disconnect(consumer: Peer, producerId: string): void {
    consumer.outbound.delete(producerId);
    for (const unsubscribe of consumer.pipes.get(producerId) ?? []) unsubscribe();
    consumer.pipes.delete(producerId);
    consumer.videoOutbound.delete(producerId);
    for (const unsubscribe of consumer.videoPipes.get(producerId) ?? []) unsubscribe();
    consumer.videoPipes.delete(producerId);
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
        videoInbound: null,
        videoSsrc: null,
        outbound: new Map(),
        videoOutbound: new Map(),
        pipes: new Map(),
        videoPipes: new Map(),
        watching: new Set(),
        queue: Promise.resolve(),
        awaitingAnswer: false,
        needsOffer: false,
        closed: false,
      };
      // The member's own microphone and screen: one receive-only line each.
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.onTrack.subscribe((track) => {
        // Slots made before the track arrived can be wired up now.
        if (track.kind === 'video') {
          peer.videoInbound = track;
          for (const consumer of room(channelId)) {
            if (consumer === peer) continue;
            const slot = consumer.videoOutbound.get(userId);
            if (slot) pipeVideo(peer, consumer, slot);
          }
          return;
        }
        peer.inbound = track;
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
      for (const subscriptions of peer.videoPipes.values()) for (const unsubscribe of subscriptions) unsubscribe();
      for (const other of room(peer.channelId)) disconnect(other, userId);
      reofferRoom(peer.channelId);
      try {
        await peer.pc.close();
      } catch {
        // Closing a connection that already failed is nothing to report.
      }
    },

    watch(userId, producerId, watching) {
      const consumer = peers.get(userId);
      if (!consumer || consumer.closed) return;
      if (watching) consumer.watching.add(producerId);
      else consumer.watching.delete(producerId);
      // A viewer that just opted in sees nothing until the producer sends a keyframe.
      const producer = peers.get(producerId);
      if (watching && producer) requestKeyframe(producer);
    },

    close() {
      for (const peer of peers.values()) {
        peer.closed = true;
        for (const subscriptions of peer.pipes.values()) for (const unsubscribe of subscriptions) unsubscribe();
        for (const subscriptions of peer.videoPipes.values()) for (const unsubscribe of subscriptions) unsubscribe();
        void Promise.resolve(peer.pc.close()).catch(() => undefined);
      }
      peers.clear();
    },
  };
}
