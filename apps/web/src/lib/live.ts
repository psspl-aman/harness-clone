import type { AnyAppEvent, ClientMessage, ServerMessage } from '@ai-harness/shared';

export type LiveStatus = 'connecting' | 'open' | 'reconnecting';

export interface LiveClientHandlers {
  onStatus: (status: LiveStatus) => void;
  onEvent: (event: AnyAppEvent) => void;
  /** Events may have been missed (lag, buffer eviction, daemon restart): refetch. */
  onResync: (reason: string) => void;
}

/**
 * Browser WebSocket client for the daemon's `/ws` endpoint.
 * - Reference-counted topic subscriptions (components subscribe/unsubscribe freely).
 * - Exponential-backoff reconnect.
 * - Tracks (epoch, seq) so a reconnect replays missed events, or asks the app
 *   to refetch when replay is impossible.
 */
export class LiveClient {
  private ws: WebSocket | null = null;
  private readonly topics = new Map<string, number>();
  private epoch: string | null = null;
  private lastSeq = 0;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly handlers: LiveClientHandlers,
  ) {}

  start() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  addTopic(topic: string) {
    const n = this.topics.get(topic) ?? 0;
    this.topics.set(topic, n + 1);
    if (n === 0) this.send({ op: 'subscribe', topics: [topic] });
  }

  removeTopic(topic: string) {
    const n = this.topics.get(topic) ?? 0;
    if (n <= 1) {
      this.topics.delete(topic);
      if (n === 1) this.send({ op: 'unsubscribe', topics: [topic] });
    } else {
      this.topics.set(topic, n - 1);
    }
  }

  private open() {
    this.handlers.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onmessage = (m) => this.onMessage(JSON.parse(String(m.data)) as ServerMessage);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (!this.stopped) this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    this.attempt++;
    this.handlers.onStatus('reconnecting');
    const delay =
      Math.min(10_000, 500 * 2 ** Math.min(this.attempt - 1, 5)) * (0.8 + Math.random() * 0.4);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.kind) {
      case 'hello': {
        const reconnect = this.epoch !== null;
        const restarted = reconnect && msg.epoch !== this.epoch;
        const since = reconnect && !restarted ? this.lastSeq : undefined;
        if (!reconnect || restarted) this.lastSeq = msg.seq;
        this.epoch = msg.epoch;
        this.attempt = 0;
        this.handlers.onStatus('open');
        if (restarted) this.handlers.onResync('daemon restarted');
        // Data fetched before the socket was subscribed may have missed events
        // emitted in between: refetch once on the first connection.
        if (!reconnect) this.handlers.onResync('initial connection');
        const topics = [...this.topics.keys()];
        if (topics.length) {
          this.send({
            op: 'subscribe',
            topics,
            sinceSeq: since,
            epoch: since !== undefined ? msg.epoch : undefined,
          });
        }
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send({ op: 'ping', t: Date.now() }), 25_000);
        break;
      }
      case 'subscribed':
        if (msg.replayTruncated) this.handlers.onResync('replay truncated');
        break;
      case 'lagged':
        this.handlers.onResync(`dropped ${msg.dropped} events`);
        break;
      case 'event':
        if (msg.event.epoch === this.epoch) this.lastSeq = Math.max(this.lastSeq, msg.event.seq);
        this.handlers.onEvent(msg.event);
        break;
      case 'error':
        console.warn('[live] server error:', msg.message);
        break;
      default:
        break;
    }
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
