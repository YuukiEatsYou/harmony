export interface GatewayFrame {
  op: number;
  t?: string;
  d?: unknown;
}

type Listener = (frame: GatewayFrame) => void;

/** How long a probe heartbeat may go unanswered before the socket is replaced. */
const probeTimeoutMs = 5000;

/** Minimal reconnecting WebSocket client for the Harmony gateway. */
export class GatewayClient {
  #url: string;
  #socket: WebSocket | null = null;
  #listeners = new Set<Listener>();
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #probeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the last heartbeat sent is still waiting for its acknowledgement. */
  #awaitingAck = false;
  #stopped = false;
  /** Whether the `online` listener is installed. */
  #listening = false;

  constructor(url: string) {
    this.#url = url;
  }

  static defaultUrl(): string {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}/gateway`;
  }

  onEvent(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  connect(): void {
    this.#stopped = false;
    if (!this.#listening) {
      // Coming back online is the earliest sign a dropped connection can be
      // remade, well before the next heartbeat would notice it was gone.
      window.addEventListener('online', this.#onOnline);
      this.#listening = true;
    }
    if (this.#socket) return;

    const socket = new WebSocket(this.#url);
    this.#socket = socket;

    socket.addEventListener('message', (event) => {
      // A socket that was already replaced is still delivering its last frames;
      // they belong to a connection nobody is listening to any more.
      if (this.#socket !== socket) return;

      let frame: GatewayFrame;
      try {
        frame = JSON.parse(event.data as string) as GatewayFrame;
      } catch {
        return;
      }

      // Answer the handshake; the cookie sent with the handshake authenticates us.
      if (frame.op === 10) {
        socket.send(JSON.stringify({ op: 2, d: {} }));
        const interval = (frame.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval;
        if (interval && interval > 0) this.#startHeartbeat(interval);
        return;
      }

      if (frame.op === 11) {
        this.#awaitingAck = false;
        if (this.#probeTimer) {
          clearTimeout(this.#probeTimer);
          this.#probeTimer = null;
        }
        return;
      }

      this.#emit(frame);
    });

    socket.addEventListener('close', (event) => {
      // A socket that was already replaced, by ensureConnected below, must not
      // clear the one now in use or schedule a duplicate reconnect.
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#stopHeartbeat();
      this.#emit({ op: -1, t: 'CLOSE', d: { code: event.code, reason: event.reason } });
      // 4004 means the session was rejected, 4005 that it was ended by
      // moderation; retrying either would just loop.
      if (!this.#stopped && event.code !== 4004 && event.code !== 4005) this.#scheduleReconnect();
    });
  }

  /**
   * Reconnects if the socket is not currently open. Used when the tab comes back
   * to the foreground: a socket left behind in the background may never report
   * that it died, so waiting for the reconnect delay would leave the client
   * silently dead. Replacing it makes the server see a fresh connection.
   *
   * A socket that still claims to be open may be just as dead, so it is asked to
   * prove otherwise with a heartbeat, and replaced if it cannot answer promptly.
   */
  ensureConnected(): void {
    // A closed client was closed on purpose, such as on sign-out; never revive it.
    if (this.#stopped) return;
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#probe();
      return;
    }
    this.#replace();
  }

  close(): void {
    this.#stopped = true;
    this.#listening = false;
    window.removeEventListener('online', this.#onOnline);
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#stopHeartbeat();
    this.#socket?.close();
    this.#socket = null;
  }

  #onOnline = (): void => this.ensureConnected();

  /** Drops the current socket, dead or not, and connects afresh straight away. */
  #replace(): void {
    const stale = this.#socket;
    this.#socket = null;
    this.#stopHeartbeat();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    try {
      // 4000 is ours to use: it tells the server this was the client's choice.
      stale?.close(4000, 'Reconnecting');
    } catch {
      // Already closed.
    }
    this.connect();
  }

  /**
   * Heartbeats on the server's schedule. A beat that finds the previous one
   * still unanswered means the connection has gone quiet without closing (the
   * network dropped, or a proxy is holding a dead line open), so it is replaced
   * instead of waiting for a close that may never come.
   */
  #startHeartbeat(intervalMs: number): void {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (this.#awaitingAck) {
        this.#replace();
        return;
      }
      this.#sendHeartbeat();
    }, intervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    if (this.#probeTimer) {
      clearTimeout(this.#probeTimer);
      this.#probeTimer = null;
    }
    this.#awaitingAck = false;
  }

  #sendHeartbeat(): void {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    this.#awaitingAck = true;
    try {
      socket.send(JSON.stringify({ op: 1, d: null }));
    } catch {
      // A send on a dying socket; the unanswered beat will replace it.
    }
  }

  /** Heartbeats now and replaces the socket if no acknowledgement comes back soon. */
  #probe(): void {
    if (this.#probeTimer) return;
    const socket = this.#socket;
    this.#sendHeartbeat();
    this.#probeTimer = setTimeout(() => {
      this.#probeTimer = null;
      if (this.#socket === socket && this.#awaitingAck) this.#replace();
    }, probeTimeoutMs);
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  #emit(frame: GatewayFrame): void {
    for (const listener of this.#listeners) listener(frame);
  }
}
