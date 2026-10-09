// Exercises the voice SFU: three in-process WebRTC peers join one room, two of
// them send audio and one sends a screen, and the third must receive it all. It
// needs no browser and no network, so it verifies the forwarding path the whole
// feature rests on.
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket } from 'werift';
import { createSfu } from '../src/voice/sfu.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

/** An in-process stand-in for a browser client. */
function createClient(userId, sfu, sending) {
  const pc = new RTCPeerConnection({});
  const mic = sending ? new MediaStreamTrack({ kind: 'audio' }) : null;
  const cam = sending ? new MediaStreamTrack({ kind: 'video' }) : null;
  if (mic) pc.addTrack(mic);
  if (cam) pc.addTrack(cam);

  // One entry per inbound track, so a receiver can tell the senders apart.
  const tracks = [];
  pc.onTrack.subscribe((track) => {
    const entry = { received: 0, kind: track.kind, streamId: track.streamId ?? null };
    tracks.push(entry);
    track.onReceiveRtp.subscribe(() => {
      entry.received += 1;
    });
  });

  const client = {
    pc,
    mic,
    cam,
    tracks,
    /** Answers a server offer: the client is the answerer here. */
    async answerOffer(sdp) {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await sfu.answer(userId, pc.localDescription.sdp);
    },
    get packets() {
      return tracks.reduce((sum, entry) => sum + entry.received, 0);
    },
  };
  return client;
}

async function main() {
  const clients = new Map();
  /** The last offer the SFU sent each member, for checking the SDP it carries. */
  const offers = new Map();
  const sfu = createSfu({
    sendOffer: (userId, _channelId, sdp) => {
      offers.set(userId, sdp);
      void clients.get(userId)?.answerOffer(sdp).catch(() => undefined);
    },
  });

  async function join(userId, sending) {
    const client = createClient(userId, sfu, sending);
    clients.set(userId, client);
    await sfu.join(userId, 'room');
    return client;
  }

  const a = await join('A', true);
  const b = await join('B', true);
  const c = await join('C', false);
  await sleep(1500);

  check('every connection came up', [a, b, c].every((client) => client.pc.connectionState === 'connected'), [
    a.pc.connectionState,
    b.pc.connectionState,
    c.pc.connectionState,
  ].join(','));

  // Two microphones push a steady stream, and A also pushes a screen. Nobody has
  // opted in to watch yet, so the screen must not reach anyone.
  let seq = 1000;
  let timestamp = 0;
  let vseq = 5000;
  let vtimestamp = 0;

  /** One batch of audio from both senders plus one screen frame from A. */
  async function push(frames) {
    for (let i = 0; i < frames; i += 1) {
      for (const sender of [a, b]) {
        sender.mic.writeRtp(
          new RtpPacket(
            new RtpHeader({ version: 2, payloadType: 111, sequenceNumber: seq, timestamp, ssrc: sender.mic.ssrc ?? 1 }),
            Buffer.alloc(40, 7),
          ),
        );
      }
      a.cam.writeRtp(
        new RtpPacket(
          new RtpHeader({ version: 2, payloadType: 96, sequenceNumber: vseq, timestamp: vtimestamp, ssrc: a.cam.ssrc ?? 2 }),
          Buffer.alloc(120, 9),
        ),
      );
      seq += 1;
      timestamp += 960;
      vseq += 1;
      vtimestamp += 3000;
      await sleep(20);
    }
  }

  await push(40);
  await sleep(1000);

  const audible = (client) => client.tracks.filter((track) => track.kind === 'audio' && track.received > 0);
  const visible = (client) => client.tracks.filter((track) => track.kind === 'video' && track.received > 0);

  check('a receiver hears both senders', audible(c).length === 2, JSON.stringify(c.tracks));
  check('a sender hears the other sender', audible(b).length > 0);
  // A joined before B, so A's copy of B is wired up on the late-arrival path (the
  // slot exists before B's audio does). B is the only other sender in this room,
  // so A must have exactly one audible track: the one that path builds.
  check('an earlier member hears a later sender', audible(a).length === 1, JSON.stringify(a.tracks));
  // A screen is opt-in: with nobody watching, the relay forwards it to no one.
  check(
    'a screen is not relayed until a viewer opts in',
    visible(b).length === 0 && visible(c).length === 0,
    JSON.stringify(c.tracks),
  );
  check('a sharer is not sent its own screen', visible(a).length === 0, JSON.stringify(a.tracks));

  // C opts in: A's screen is now forwarded, to C alone.
  sfu.watch('C', 'A', true);
  await push(40);
  await sleep(1000);
  check('the viewer sees the shared screen', visible(c).length === 1, JSON.stringify(c.tracks));
  check('a non-viewer still receives no screen', visible(b).length === 0, JSON.stringify(b.tracks));

  // C stops watching: the relay must stop forwarding, which is the bandwidth saving.
  const watched = visible(c)[0]?.received ?? 0;
  sfu.watch('C', 'A', false);
  await push(20);
  await sleep(500);
  check('opting out stops the screen', (visible(c)[0]?.received ?? 0) === watched, `${watched} -> ${visible(c)[0]?.received ?? 0}`);
  // The relayed tracks name their producer via the SDP msid, which is how a
  // browser client tells whose audio each track is (a speaking ring needs that).
  check(
    'each relayed track names its producer',
    /a=msid:A /.test(offers.get('C') ?? '') && /a=msid:B /.test(offers.get('C') ?? ''),
    (offers.get('C') ?? '').split('\n').filter((line) => line.includes('msid')).join(' | '),
  );
  // A forwarded stream must never ride the member's own receive line. addTrack
  // fuses them into one sendrecv m-line, which Chromium will not play back; the
  // receive lines stay recvonly and every relayed stream gets its own sendonly.
  check(
    'no line carries both directions',
    !/a=sendrecv/.test(offers.get('C') ?? ''),
    (offers.get('C') ?? '').split('\n').filter((line) => line === 'a=sendrecv').join(' | '),
  );
  // The offer has to carry a video codec, or no browser could answer a screen.
  check('the offer carries a video codec', /vp8\/90000/i.test(offers.get('C') ?? ''));

  // A client whose network changed cannot offer itself, so the server restarts its
  // ICE and asks again; the fresh offer must carry new ICE credentials.
  const ufrag = (sdp) => (sdp.match(/^a=ice-ufrag:(.*)$/m) ?? [])[1] ?? '';
  const beforeOffer = offers.get('C') ?? '';
  sfu.renegotiate('C');
  await sleep(600);
  const afterOffer = offers.get('C') ?? '';
  check(
    'renegotiate sends a fresh offer with new ICE credentials',
    beforeOffer !== afterOffer && ufrag(afterOffer) !== '' && ufrag(afterOffer) !== ufrag(beforeOffer),
    `ufrag ${ufrag(beforeOffer)} -> ${ufrag(afterOffer)}`,
  );

  // A sender leaves; the room re-offers and must converge again.
  await sfu.leave('B');
  await sleep(1000);
  check('the room stays connected after a member leaves', a.pc.connectionState === 'connected' && c.pc.connectionState === 'connected');

  sfu.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
