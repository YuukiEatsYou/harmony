// Exercises the voice SFU: three in-process WebRTC peers join one room, two of
// them send audio, and the third must receive both. It needs no browser and no
// network, so it verifies the forwarding path the whole feature rests on.
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
  if (mic) pc.addTrack(mic);

  // One counter per inbound track, so a receiver can tell the senders apart.
  const tracks = [];
  pc.onTrack.subscribe((track) => {
    const entry = { received: 0 };
    tracks.push(entry);
    track.onReceiveRtp.subscribe(() => {
      entry.received += 1;
    });
  });

  const client = {
    pc,
    mic,
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
  const sfu = createSfu({
    sendOffer: (userId, sdp) => {
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

  // Two senders, each pushing a steady stream.
  let seq = 1000;
  let timestamp = 0;
  for (let i = 0; i < 40; i += 1) {
    for (const sender of [a, b]) {
      sender.mic.writeRtp(
        new RtpPacket(
          new RtpHeader({ version: 2, payloadType: 111, sequenceNumber: seq, timestamp, ssrc: sender.mic.ssrc ?? 1 }),
          Buffer.alloc(40, 7),
        ),
      );
    }
    seq += 1;
    timestamp += 960;
    await sleep(20);
  }
  await sleep(1000);

  check('a receiver hears both senders', c.tracks.filter((track) => track.received > 0).length === 2, JSON.stringify(c.tracks));
  check('a sender hears the other sender', b.tracks.some((track) => track.received > 0));

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
