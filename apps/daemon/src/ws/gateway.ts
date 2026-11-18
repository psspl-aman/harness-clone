import { ClientMessageSchema, type AnyAppEvent, type ServerMessage } from '@agentforge/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { EventBus } from '../events/bus';
import { newId } from '../lib/id';

export interface GatewayOptions {
  /** Stop sending when the socket buffer exceeds this many bytes. */
  highWaterMark?: number;
  heartbeatMs?: number;
  isOriginAllowed: (origin: string | undefined) => boolean;
  version: string;
}

interface Client {
  id: string;
  socket: WebSocket;
  topics: Set<string>;
  dropped: number;
  alive: boolean;
}

/**
 * Single WebSocket endpoint (`/ws`). Clients subscribe to topics and receive
 * matching bus events. Slow clients are protected by a high-water mark: events
 * are dropped (and a `lagged` notice sent once the buffer drains) rather than
 * buffered without bound, so the UI can refetch state.
 */
export class WsGateway {
  private readonly clients = new Map<string, Client>();
  private heartbeat?: NodeJS.Timeout;
  private unsubscribeBus?: () => void;

  constructor(
    private readonly bus: EventBus,
    private readonly opts: GatewayOptions,
  ) {}

  get clientCount(): number {
    return this.clients.size;
  }

  register(app: FastifyInstance): void {
    this.unsubscribeBus = this.bus.subscribe((e) => this.fanOut(e));

    app.get('/ws', { websocket: true }, (socket, req) => {
      if (!this.opts.isOriginAllowed(req.headers.origin)) {
        socket.close(1008, 'Origin not allowed');
        return;
      }
      const client: Client = {
        id: newId('ws'),
        socket,
        topics: new Set(),
        dropped: 0,
        alive: true,
      };
      this.clients.set(client.id, client);
      socket.on('pong', () => (client.alive = true));
      socket.on('message', (raw) => this.onMessage(client, raw.toString()));
      socket.on('close', () => this.clients.delete(client.id));
      socket.on('error', () => this.clients.delete(client.id));
      this.send(client, {
        kind: 'hello',
        connectionId: client.id,
        epoch: this.bus.epoch,
        seq: this.bus.currentSeq,
        version: this.opts.version,
      });
    });

    const interval = this.opts.heartbeatMs ?? 30_000;
    this.heartbeat = setInterval(() => {
      for (const c of this.clients.values()) {
        if (!c.alive) {
          c.socket.terminate();
          this.clients.delete(c.id);
          continue;
        }
        c.alive = false;
        c.socket.ping();
      }
    }, interval);
    this.heartbeat.unref();

    app.addHook('onClose', async () => this.close());
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unsubscribeBus?.();
    for (const c of this.clients.values()) c.socket.close(1001, 'Server shutting down');
    this.clients.clear();
  }

  private onMessage(client: Client, raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.send(client, { kind: 'error', message: 'Invalid JSON' });
    }
    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      return this.send(client, {
        kind: 'error',
        message: result.error.issues[0]?.message ?? 'Invalid message',
      });
    }
    const msg = result.data;
    switch (msg.op) {
      case 'subscribe': {
        const added = new Set(msg.topics.filter((t) => !client.topics.has(t)));
        for (const t of msg.topics) client.topics.add(t);
        let replayed = 0;
        let replayTruncated = false;
        if (msg.sinceSeq !== undefined) {
          if (msg.epoch && msg.epoch !== this.bus.epoch) {
            // Daemon restarted: client must refetch everything.
            replayTruncated = true;
          } else {
            // Only replay for newly added topics; existing ones already got live events.
            const { events, truncated } = this.bus.replay(msg.sinceSeq, added);
            replayTruncated = truncated;
            for (const e of events) this.send(client, { kind: 'event', event: e });
            replayed = events.length;
          }
        }
        this.send(client, {
          kind: 'subscribed',
          topics: [...client.topics],
          replayed,
          replayTruncated,
        });
        break;
      }
      case 'unsubscribe':
        for (const t of msg.topics) client.topics.delete(t);
        this.send(client, { kind: 'unsubscribed', topics: msg.topics });
        break;
      case 'ping':
        this.send(client, { kind: 'pong', t: msg.t });
        break;
    }
  }

  private fanOut(event: AnyAppEvent) {
    for (const c of this.clients.values()) {
      if (event.topics.some((t) => c.topics.has(t))) this.send(c, { kind: 'event', event });
    }
  }

  private send(client: Client, msg: ServerMessage) {
    const { socket } = client;
    if (socket.readyState !== socket.OPEN) return;
    const hwm = this.opts.highWaterMark ?? 4 * 1024 * 1024;
    if (msg.kind === 'event' && socket.bufferedAmount > hwm) {
      client.dropped++;
      return;
    }
    if (client.dropped > 0 && socket.bufferedAmount <= hwm / 2) {
      const dropped = client.dropped;
      client.dropped = 0;
      socket.send(JSON.stringify({ kind: 'lagged', dropped } satisfies ServerMessage));
    }
    socket.send(JSON.stringify(msg));
  }
}
