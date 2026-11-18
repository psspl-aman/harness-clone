import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events/bus';

const note = (title: string) => ({ level: 'info' as const, title });

describe('EventBus', () => {
  it('assigns increasing sequence numbers and notifies listeners', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.subscribe((e) => seen.push(e.seq));
    bus.emit('notification', note('a'));
    bus.emit('notification', note('b'));
    expect(seen).toEqual([1, 2]);
    expect(bus.currentSeq).toBe(2);
  });

  it('validates payloads against shared schemas', () => {
    const bus = new EventBus();
    // @ts-expect-error deliberately wrong payload
    expect(() => bus.emit('notification', { level: 'loud', title: 1 })).toThrow();
    expect(bus.currentSeq).toBe(0);
  });

  it('isolates failing listeners', () => {
    const onListenerError = vi.fn();
    const bus = new EventBus({ onListenerError });
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(good);
    bus.emit('notification', note('x'));
    expect(good).toHaveBeenCalledOnce();
    expect(onListenerError).toHaveBeenCalledOnce();
  });

  it('replays buffered events filtered by topic', () => {
    const bus = new EventBus();
    bus.emit('notification', note('g1'));
    bus.emit('project.deleted', { projectId: 'p1' }, ['global', 'project:p1']);
    bus.emit('project.deleted', { projectId: 'p2' }, ['project:p2']);
    const { events, truncated } = bus.replay(1, new Set(['project:p1', 'project:p2']));
    expect(events.map((e) => e.seq)).toEqual([2, 3]);
    expect(truncated).toBe(false);
  });

  it('reports truncation when the ring buffer evicted needed events', () => {
    const bus = new EventBus({ bufferSize: 3 });
    for (let i = 0; i < 6; i++) bus.emit('notification', note(String(i)));
    const r = bus.replay(1, new Set(['global']));
    expect(r.events.map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(r.truncated).toBe(true);
    expect(bus.replay(3, new Set(['global'])).truncated).toBe(false);
  });
});
