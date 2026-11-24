import type { AnyAppEvent } from '@agentforge/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers';

let t: TestApp;
const events: AnyAppEvent[] = [];
beforeEach(async () => {
  t = await createTestApp();
  events.length = 0;
  t.ctx.bus.subscribe((e) => events.push(e));
});
afterEach(async () => t.cleanup());

const output = (id: string) =>
  events
    .filter((e) => e.type === 'terminal.output' && e.payload.terminalId === id)
    .map((e) => (e.type === 'terminal.output' ? e.payload.data : ''))
    .join('');
const until = async (fn: () => boolean) => {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('TerminalService', () => {
  // Windows: node-pty can't reliably attach a console under vitest (flaky "AttachConsole failed"),
  // so interactive PTY I/O can't be exercised here; the live daemon drives PTYs fine. Runs on POSIX.
  it.skipIf(process.platform === 'win32')('runs an interactive PTY: input, resize, scrollback, exit', async () => {
    const term = t.ctx.terminals.create({
      kind: 'shell',
      title: 'test',
      cwd: t.home,
      command: 'bash',
      args: ['--noprofile', '--norc', '-c', 'echo ready; read x; echo "got:$x"; stty size'],
    });
    await until(() => output(term.id).includes('ready'));
    await t.app.inject({
      method: 'POST',
      url: `/api/terminals/${term.id}/resize`,
      payload: { cols: 120, rows: 40 },
    });
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/terminals/${term.id}/input`,
          payload: { data: 'hello\r' },
        })
      ).statusCode,
    ).toBe(204);
    await until(() =>
      events.some((e) => e.type === 'terminal.exit' && e.payload.terminalId === term.id),
    );
    expect(output(term.id)).toContain('got:hello');
    expect(output(term.id)).toContain('40 120');
    const info = (await t.app.inject({ method: 'GET', url: `/api/terminals/${term.id}` })).json();
    expect(info).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(info.scrollback).toContain('got:hello');
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/terminals/${term.id}/input`,
          payload: { data: 'x' },
        })
      ).statusCode,
    ).toBe(409);
  });

  // Windows: killing a node-pty PTY and removing its temp dir races with async handle
  // release under vitest (no console to attach); the live daemon handles this fine. Runs on POSIX.
  it.skipIf(process.platform === 'win32')('kills and removes terminals; output events are transient', async () => {
    const term = t.ctx.terminals.create({
      kind: 'shell',
      title: 'sleep',
      cwd: t.home,
      command: 'sleep',
      args: ['30'],
    });
    expect(t.ctx.terminals.list().map((x) => x.id)).toContain(term.id);
    await t.app.inject({ method: 'POST', url: `/api/terminals/${term.id}/kill` });
    await until(() =>
      events.some((e) => e.type === 'terminal.exit' && e.payload.terminalId === term.id),
    );
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/api/terminals/${term.id}` })).statusCode,
    ).toBe(204);
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/terminals/${term.id}` })).statusCode,
    ).toBe(404);
    expect(
      t.ctx.bus
        .replay(0, new Set([`terminal:${term.id}`]))
        .events.every((e) => e.type !== 'terminal.output'),
    ).toBe(true);
  });

  it('reports spawn failures', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/terminals/term_missing' });
    expect(res.statusCode).toBe(404);
    expect(() =>
      t.ctx.terminals.create({
        kind: 'shell',
        title: 'x',
        cwd: '/definitely/not/here',
        command: 'bash',
        args: [],
      }),
    ).toThrow();
  });
});
