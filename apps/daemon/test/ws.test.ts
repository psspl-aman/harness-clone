import type { ServerMessage } from '@agentforge/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createTestApp, type TestApp } from './helpers';

let t: TestApp;
let url: string;

beforeEach(async () => {
  t = await createTestApp();
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = t.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  url = `ws://127.0.0.1:${addr.port}/ws`;
});
afterEach(async () => t.cleanup());

/** Connect and collect messages; `next(pred)` resolves with the first match. */
function connect(headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  const inbox: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] =
    [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as ServerMessage;
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m);
    else inbox.push(m);
  });
  const next = <K extends ServerMessage['kind']>(
    kind: K,
    extra: (m: Extract<ServerMessage, { kind: K }>) => boolean = () => true,
  ) =>
    new Promise<Extract<ServerMessage, { kind: K }>>((resolve, reject) => {
      const pred = (m: ServerMessage) =>
        m.kind === kind && extra(m as Extract<ServerMessage, { kind: K }>);
      const i = inbox.findIndex(pred);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0] as Extract<ServerMessage, { kind: K }>);
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${kind}`)), 3000);
      waiters.push({
        pred,
        resolve: (m) => (clearTimeout(timer), resolve(m as Extract<ServerMessage, { kind: K }>)),
      });
    });
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  return { ws, next, send, inbox };
}

describe('WebSocket gateway', () => {
  it('greets, subscribes and delivers only matching topics', async () => {
    const c = connect();
    const hello = await c.next('hello');
    expect(hello.epoch).toBe(t.ctx.bus.epoch);
    c.send({ op: 'subscribe', topics: ['project:p1'] });
    await c.next('subscribed');
    t.ctx.bus.emit('project.deleted', { projectId: 'p2' }, ['project:p2']);
    t.ctx.bus.emit('project.deleted', { projectId: 'p1' }, ['global', 'project:p1']);
    const ev = await c.next('event');
    expect(ev.event.payload).toEqual({ projectId: 'p1' });
    expect(c.inbox.filter((m) => m.kind === 'event')).toHaveLength(0);
    c.ws.close();
  });

  it('pushes settings changes made over HTTP', async () => {
    const c = connect();
    await c.next('hello');
    c.send({ op: 'subscribe', topics: ['global'] });
    await c.next('subscribed');
    await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { health: { engineCheckIntervalSec: 60 } },
    });
    const ev = await c.next('event', (m) => m.event.type === 'settings.updated');
    expect(
      ev.event.type === 'settings.updated' &&
        ev.event.payload.settings.health.engineCheckIntervalSec,
    ).toBe(60);
    c.ws.close();
  });

  it('replays missed events on resubscribe with sinceSeq', async () => {
    const first = t.ctx.bus.emit('notification', { level: 'info', title: 'one' });
    t.ctx.bus.emit('notification', { level: 'info', title: 'two' });
    t.ctx.bus.emit('notification', { level: 'info', title: 'three' });
    const c = connect();
    await c.next('hello');
    c.send({ op: 'subscribe', topics: ['global'], sinceSeq: first.seq, epoch: t.ctx.bus.epoch });
    const sub = await c.next('subscribed');
    expect(sub.replayed).toBe(2);
    expect(sub.replayTruncated).toBe(false);
    const titles = c.inbox.flatMap((m) =>
      m.kind === 'event' && m.event.type === 'notification' ? [m.event.payload.title] : [],
    );
    expect(titles).toEqual(['two', 'three']);
    c.ws.close();
  });

  it('flags replay as truncated after a daemon restart (epoch change)', async () => {
    const c = connect();
    await c.next('hello');
    c.send({ op: 'subscribe', topics: ['global'], sinceSeq: 0, epoch: 'ep_old' });
    expect((await c.next('subscribed')).replayTruncated).toBe(true);
    c.ws.close();
  });

  it('answers pings and reports protocol errors', async () => {
    const c = connect();
    await c.next('hello');
    c.send({ op: 'ping', t: 42 });
    expect((await c.next('pong')).t).toBe(42);
    c.ws.send('not json');
    expect((await c.next('error')).message).toBe('Invalid JSON');
    c.send({ op: 'subscribe', topics: ['root:x'] });
    expect((await c.next('error')).message).toMatch(/topic/i);
    c.ws.close();
  });

  it('refuses connections from foreign origins', async () => {
    const ws = new WebSocket(url, { headers: { origin: 'https://evil.example.com' } });
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', () => resolve(-1));
    });
    expect([1008, -1]).toContain(code);
  });
});
