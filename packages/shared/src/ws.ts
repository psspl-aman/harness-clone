import { z } from 'zod';
import { TopicSchema, type AnyAppEvent } from './events';

/** Client → server messages. */
export const ClientMessageSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('subscribe'),
    topics: z.array(TopicSchema).min(1).max(100),
    /** Replay buffered events after this seq (same epoch only). */
    sinceSeq: z.number().int().nonnegative().optional(),
    epoch: z.string().optional(),
  }),
  z.object({ op: z.literal('unsubscribe'), topics: z.array(TopicSchema).min(1).max(100) }),
  z.object({ op: z.literal('ping'), t: z.number().optional() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** Server → client messages. */
export type ServerMessage =
  | { kind: 'hello'; connectionId: string; epoch: string; seq: number; version: string }
  | { kind: 'subscribed'; topics: string[]; replayed: number; replayTruncated: boolean }
  | { kind: 'unsubscribed'; topics: string[] }
  | { kind: 'event'; event: AnyAppEvent }
  | { kind: 'pong'; t?: number }
  | { kind: 'lagged'; dropped: number }
  | { kind: 'error'; message: string };
