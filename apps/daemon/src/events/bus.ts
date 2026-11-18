import {
  EventPayloads,
  Topics,
  type AnyAppEvent,
  type AppEvent,
  type EventPayload,
  type EventType,
} from '@agentforge/shared';
import { newId } from '../lib/id';

export type EventListener = (event: AnyAppEvent) => void;

export interface EventBusOptions {
  /** Number of recent events kept for reconnect replay. */
  bufferSize?: number;
  /** Validate payloads against the shared Zod schemas (on by default). */
  validate?: boolean;
  onListenerError?: (err: unknown, event: AnyAppEvent) => void;
}

/**
 * In-process typed event bus. Every domain change is emitted here; the
 * WebSocket gateway fans events out to subscribed browser clients.
 */
export class EventBus {
  readonly epoch = newId('ep');
  private seq = 0;
  private readonly listeners = new Set<EventListener>();
  private readonly ring: (AnyAppEvent | undefined)[];
  private ringStart = 0;
  private ringLen = 0;
  private readonly validate: boolean;
  private readonly onListenerError: NonNullable<EventBusOptions['onListenerError']>;

  constructor(opts: EventBusOptions = {}) {
    this.ring = new Array(opts.bufferSize ?? 2000);
    this.validate = opts.validate ?? true;
    this.onListenerError =
      opts.onListenerError ?? ((err) => console.error('[bus] listener error', err));
  }

  get currentSeq(): number {
    return this.seq;
  }

  emit<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    topics: string[] = [Topics.global],
  ): AppEvent<T> {
    const checked = this.validate
      ? (EventPayloads[type].parse(payload) as EventPayload<T>)
      : payload;
    const event: AppEvent<T> = {
      seq: ++this.seq,
      epoch: this.epoch,
      type,
      topics: [...new Set(topics)],
      ts: Date.now(),
      payload: checked,
    };
    this.push(event as unknown as AnyAppEvent);
    for (const l of this.listeners) {
      try {
        l(event as unknown as AnyAppEvent);
      } catch (err) {
        this.onListenerError(err, event as unknown as AnyAppEvent);
      }
    }
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Events after `sinceSeq` that touch any of `topics`. `truncated` is true
   * when older events were already evicted, so the client should refetch.
   */
  replay(sinceSeq: number, topics: Set<string>): { events: AnyAppEvent[]; truncated: boolean } {
    const events: AnyAppEvent[] = [];
    const cap = this.ring.length;
    for (let i = 0; i < this.ringLen; i++) {
      const e = this.ring[(this.ringStart + i) % cap]!;
      if (e.seq > sinceSeq && e.topics.some((t) => topics.has(t))) events.push(e);
    }
    // Sequence numbers are contiguous, so the oldest buffered one is derivable.
    const oldestBuffered = this.seq - this.ringLen + 1;
    const truncated = sinceSeq + 1 < oldestBuffered;
    return { events, truncated };
  }

  private push(e: AnyAppEvent) {
    const cap = this.ring.length;
    if (this.ringLen < cap) {
      this.ring[(this.ringStart + this.ringLen) % cap] = e;
      this.ringLen++;
    } else {
      this.ring[this.ringStart] = e;
      this.ringStart = (this.ringStart + 1) % cap;
    }
  }
}
