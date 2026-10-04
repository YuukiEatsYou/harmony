import type { FastifyInstance } from 'fastify';
import {
  GATEWAY_VERSION,
  GatewayCloseCode,
  GatewayEvent,
  GatewayOp,
  type GatewayHello,
  type GatewayIdentify,
  type GatewayReady,
} from '@harmony/shared';
import type { AuthContext } from '../auth/service.ts';
import type { GatewayHub } from '../realtime/hub.ts';

export interface GatewayOptions {
  heartbeatIntervalMs: number;
  cookieName: string;
  resolveToken: (token: string) => AuthContext | null;
  hub: GatewayHub;
}

/**
 * The realtime edge. A client is greeted with HELLO, then must IDENTIFY:
 * either with a session token (API clients) or, for browser clients, by
 * relying on the session cookie presented during the WebSocket handshake.
 *
 * After that the client heartbeats. A socket can die without either end being
 * told (a phone dropping off the network, a laptop lid closing), and until it is
 * closed its member stays online and its slot stays taken. So a connection that
 * goes quiet for about two heartbeat intervals is presumed dead and closed, and
 * one that never identifies is closed after a single interval.
 */
export function registerGateway(app: FastifyInstance, options: GatewayOptions): void {
  const interval = options.heartbeatIntervalMs;
  // Two missed beats, plus room for a slow network or a throttled background
  // tab delivering one late, before giving up on a connection.
  const silenceLimitMs = interval * 2 + Math.min(interval, 5000);

  app.get('/gateway', { websocket: true }, (socket, request) => {
    const clientId = options.hub.register(
      (payload) => {
        try {
          socket.send(payload);
        } catch {
          // Socket is closing; its close handler will unregister it.
        }
      },
      (code, reason) => {
        try {
          socket.close(code, reason);
        } catch {
          // Already closing.
        }
      },
    );

    let identified = false;
    const identifyTimer = setTimeout(() => {
      if (!identified) socket.close(GatewayCloseCode.NotAuthenticated, 'Identify timed out');
    }, interval);

    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    /** Pushes the deadline back whenever the client shows it is still there. */
    const heardFrom = (): void => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        socket.close(GatewayCloseCode.SessionTimedOut, 'Heartbeat timed out');
        // A dead peer never completes the closing handshake, and the socket would
        // linger (and keep its member online) until TCP gives up. Cut it loose.
        setTimeout(() => socket.terminate(), 5000).unref();
      }, silenceLimitMs);
    };
    heardFrom();

    // Browser handshakes carry cookies, so allow cookie-based identification.
    const cookieToken = request.cookies?.[options.cookieName] ?? null;
    const cookieAuth = cookieToken ? options.resolveToken(cookieToken) : null;

    const hello: GatewayHello = {
      heartbeat_interval: interval,
      gateway_version: GATEWAY_VERSION,
    };
    socket.send(JSON.stringify({ op: GatewayOp.Hello, d: hello }));
    app.log.debug({ ip: request.ip }, 'gateway client connected');

    socket.on('message', (raw: Buffer) => {
      heardFrom();

      let frame: { op?: number; d?: unknown };
      try {
        frame = JSON.parse(raw.toString()) as { op?: number; d?: unknown };
      } catch {
        return; // Ignore malformed frames instead of tearing down the socket.
      }

      if (frame.op === GatewayOp.Heartbeat) {
        socket.send(JSON.stringify({ op: GatewayOp.HeartbeatAck, d: null }));
        return;
      }

      if (frame.op === GatewayOp.Identify) {
        const identify = frame.d as GatewayIdentify | undefined;
        const auth = identify?.token ? options.resolveToken(identify.token) : cookieAuth;

        if (!auth) {
          socket.close(GatewayCloseCode.AuthenticationFailed, 'Your session has ended. Please sign in again.');
          return;
        }

        identified = true;
        clearTimeout(identifyTimer);
        options.hub.authenticate(clientId, auth);
        const ready: GatewayReady = { user: auth.user, gateway_version: GATEWAY_VERSION };
        socket.send(JSON.stringify({ op: GatewayOp.Dispatch, t: GatewayEvent.Ready, d: ready }));
      }
    });

    socket.on('close', () => {
      clearTimeout(identifyTimer);
      if (silenceTimer) clearTimeout(silenceTimer);
      options.hub.unregister(clientId);
      app.log.debug('gateway client disconnected');
    });
    socket.on('error', (error: Error) => app.log.error({ err: error }, 'gateway socket error'));
  });
}
