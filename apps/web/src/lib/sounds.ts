/**
 * The in-app sounds, served from the web client's own public directory: the two
 * notification tones, and the two that mark somebody joining or leaving voice.
 *
 * They play through the Web Audio API rather than an <audio> element. On iOS an
 * audio element registers with the system now-playing session, so every message
 * that chirped threw the media player into the Dynamic Island; a Web Audio
 * buffer has no such session and stays out of the way.
 *
 * Nothing here touches device notifications: there is no push, no service
 * worker involvement and no permission prompt. A sound only ever plays while a
 * Harmony page is open, and whether it plays at all is the member's choice.
 */
const SOURCES = {
  /** A message aimed at you: a reply, or your name mentioned. */
  major: '/sounds/major_notification.mp3',
  /** Any other message worth a quieter nudge. */
  minor: '/sounds/minor_notification.mp3',
  /** Somebody joined the voice channel you are in. */
  voiceConnect: '/sounds/vc_connect.mp3',
  /** Somebody left the voice channel you are in. */
  voiceDisconnect: '/sounds/vc_disconnect.mp3',
} as const;

export type SoundName = keyof typeof SOURCES;

/** The page's one audio context, created on first use and kept for its life. */
let context: AudioContext | null = null;

/** Each sound's decoded data, fetched and decoded at most once. */
const decoded = new Map<SoundName, Promise<AudioBuffer>>();

function audioContext(): AudioContext | null {
  if (context) return context;
  const constructor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!constructor) return null;
  context = new constructor();
  return context;
}

/** Fetches and decodes a sound once; every later play reuses the buffer. */
function bufferFor(sound: SoundName): Promise<AudioBuffer> | null {
  const ctx = audioContext();
  if (!ctx) return null;
  let pending = decoded.get(sound);
  if (!pending) {
    pending = fetch(SOURCES[sound])
      .then((response) => response.arrayBuffer())
      .then((data) => ctx.decodeAudioData(data));
    decoded.set(sound, pending);
  }
  return pending;
}

/**
 * Wakes the context on the first user gesture and decodes every sound ahead of
 * time. A context created before any interaction starts suspended, and iOS only
 * lets it resume inside a gesture, so this is what lets a later, un-gestured
 * sound actually play.
 */
function unlock(): void {
  const ctx = audioContext();
  if (!ctx) return;
  void ctx.resume().catch(() => {});
  for (const sound of Object.keys(SOURCES) as SoundName[]) bufferFor(sound);
}

if (typeof window !== 'undefined') {
  const gestures = ['pointerdown', 'keydown', 'touchstart'] as const;
  const onGesture = (): void => {
    for (const type of gestures) window.removeEventListener(type, onGesture);
    unlock();
  };
  for (const type of gestures) window.addEventListener(type, onGesture, { passive: true });
}

/**
 * Plays one of the sounds. A buffer source is single use, so a fresh one is made
 * each time, over the buffer decoded once above: a later sound never waits on
 * another fetch or decode.
 */
export function playSound(sound: SoundName): void {
  const ctx = audioContext();
  if (!ctx) return;
  // A browser that has not seen a gesture yet keeps the context suspended, and
  // this produces nothing. There is nothing to do about that and nothing worth
  // telling anyone.
  void ctx.resume().catch(() => {});
  const buffer = bufferFor(sound);
  if (!buffer) return;
  void buffer
    .then((decodedBuffer) => {
      const source = ctx.createBufferSource();
      source.buffer = decodedBuffer;
      source.connect(ctx.destination);
      source.start();
    })
    .catch(() => {});
}
