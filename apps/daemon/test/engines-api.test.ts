import type { AnyAppEvent } from '@ai-harness/shared';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { engineSessions, secrets, usageRecords } from '../src/db/schema';
import { FIXTURES, makeFakeCli, type FakeCli } from './fake-cli';
import { createTestApp, tempDir, type TestApp } from './helpers';

let t: TestApp;
let dir: string;
let claude: FakeCli;
const events: AnyAppEvent[] = [];

const AUTH_OK = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  subscriptionType: 'max',
  email: 'dev@example.com',
  loginExpiresAt: '2099-01-01T00:00:00Z',
});

beforeEach(async () => {
  dir = tempDir('af-eng-api-');
  t = await createTestApp();
  events.length = 0;
  t.ctx.bus.subscribe((e) => events.push(e));
  claude = makeFakeCli(dir, 'claude');
  claude.setResponses([
    { match: '--version', stdout: '2.1.327 (Claude Code)' },
    { match: 'auth status', stdout: AUTH_OK },
    { match: '-p', stdoutFile: join(FIXTURES, 'claude-success.jsonl') },
  ]);
  // Point every built-in engine somewhere deterministic so the host's real CLIs are never touched.
  for (const id of ['codex', 'gemini-cli', 'antigravity'])
    await patch(id, { binaryPath: join(dir, `missing-${id}`) });
  await patch('claude-code', { binaryPath: claude.path });
  await t.ctx.engines.refreshAll();
});
afterEach(async () => {
  await t.cleanup();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const patch = (id: string, payload: object) =>
  t.app.inject({ method: 'PATCH', url: `/api/engines/${id}`, payload });
const get = async (id: string) =>
  (await t.app.inject({ method: 'GET', url: `/api/engines/${id}` })).json();
const waitFor = async <T>(fn: () => T | undefined, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('engine catalogue and status', () => {
  it('lists the built-in engines with install + auth status', async () => {
    const list = (await t.app.inject({ method: 'GET', url: '/api/engines' })).json();
    expect(list.map((e: { id: string }) => e.id)).toEqual([
      'claude-code',
      'codex',
      'gemini-cli',
      'antigravity',
    ]);
    expect(list[0]).toMatchObject({
      installed: true,
      version: '2.1.327',
      authStatus: 'ACTIVE',
      accountLabel: 'dev@example.com',
      path: claude.path,
      capabilities: { login: true, apiKey: true },
    });
    expect(list[0].models.map((m: { id: string }) => m.id)).toEqual(['opus', 'sonnet', 'haiku']);
    for (const e of list.slice(1))
      expect(e).toMatchObject({ installed: false, authStatus: 'NOT_INSTALLED' });
    expect(list[1].installCommand).toBe('npm install -g @openai/codex');
  });

  it('records status changes and broadcasts them', async () => {
    claude.setResponses([
      { match: '--version', stdout: '2.1.327' },
      {
        match: 'auth status',
        stdout: JSON.stringify({ loggedIn: true, loginExpiresAt: '2001-01-01T00:00:00Z' }),
      },
    ]);
    events.length = 0;
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/engines/claude-code/refresh' })).json()
        .authStatus,
    ).toBe('EXPIRED');
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['engine.status_changed', 'engine.updated']),
    );
    const history = t.ctx.db
      .select()
      .from(engineSessions)
      .where(eq(engineSessions.engineId, 'claude-code'))
      .all();
    expect(history.map((h) => h.status)).toEqual(expect.arrayContaining(['ACTIVE', 'EXPIRED']));
  });

  it('updates settings and validates input', async () => {
    expect(
      (await patch('claude-code', { defaultModel: 'sonnet', enabled: false })).json(),
    ).toMatchObject({ defaultModel: 'sonnet', enabled: false });
    expect((await patch('claude-code', { nope: 1 })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/engines/unknown' })).statusCode).toBe(
      404,
    );
  });

  it('stores API keys encrypted and never returns them', async () => {
    const key = 'sk-ant-api03-fakefakefakefake'; // gforge:allow — fake test key
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/engines/claude-code/api-key',
      payload: { apiKey: key },
    });
    expect(res.json()).toMatchObject({
      hasApiKey: true,
      authStatus: 'ACTIVE',
      accountLabel: 'API key',
    });
    expect(res.body).not.toContain(key);
    expect(JSON.stringify(t.ctx.db.select().from(secrets).all())).not.toContain(key);
    expect(
      (
        await t.app.inject({
          method: 'PUT',
          url: '/api/engines/antigravity/api-key',
          payload: { apiKey: key },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await t.app.inject({ method: 'DELETE', url: '/api/engines/claude-code/api-key' })).json()
        .hasApiKey,
    ).toBe(false);
  });
});

describe('runs', () => {
  it('streams a test run over the bus and records usage', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/engines/claude-code/test',
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();
    const finished = await waitFor(() =>
      events.find((e) => e.type === 'run.finished' && e.payload.runId === runId),
    );
    expect(finished.type === 'run.finished' && finished.payload.result).toMatchObject({
      status: 'succeeded',
      finalText: 'DONE',
    });
    const streamed = events.filter((e) => e.type === 'run.event' && e.payload.runId === runId);
    expect(streamed.length).toBeGreaterThan(3);
    expect(streamed[0]!.topics).toEqual([`run:${runId}`]);
    const call = claude.calls().find((c) => c.args[0] === '-p')!;
    expect(call.stdin).toBe('Reply with exactly: OK');
    expect(call.args).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk'])); // test runs are read-only
    const usage = t.ctx.db.select().from(usageRecords).all();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      engineId: 'claude-code',
      inputTokens: 1195,
      outputTokens: 196,
    });
    // Usage windows from the rate-limit event are kept for the dashboard.
    expect((await get('claude-code')).usageWindows[0]).toMatchObject({
      name: 'five_hour',
      utilization: 0.43,
    });
  });

  it('marks the engine exhausted on a usage-limit failure and keeps it until reset', async () => {
    claude.setResponses([
      { match: '--version', stdout: '2.1.327' },
      { match: 'auth status', stdout: AUTH_OK },
      { match: '-p', stdoutFile: join(FIXTURES, 'claude-limit.jsonl'), exitCode: 1 },
    ]);
    const result = await t.ctx.engines.run(
      'claude-code',
      { prompt: 'x', cwd: dir, permission: 'readonly' },
      () => {},
    );
    expect(result.error?.kind).toBe('QUOTA_EXPIRED');
    let e = await get('claude-code');
    expect(e).toMatchObject({ authStatus: 'QUOTA_EXHAUSTED', resetAt: 1795014000_000 });
    e = (await t.app.inject({ method: 'POST', url: '/api/engines/claude-code/refresh' })).json();
    expect(e.authStatus).toBe(Date.now() < 1795014000_000 ? 'QUOTA_EXHAUSTED' : 'ACTIVE');
    expect(
      events.some(
        (ev) => ev.type === 'engine.status_changed' && ev.payload.status === 'QUOTA_EXHAUSTED',
      ),
    ).toBe(true);
  });

  it('limits concurrent runs per engine', async () => {
    await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { concurrency: { maxRunsPerEngine: 1 } },
    });
    claude.setResponses([
      { match: '-p', stdoutFile: join(FIXTURES, 'claude-success.jsonl'), sleepMs: 400 },
    ]);
    const started = Date.now();
    const run = () =>
      t.ctx.engines.run('claude-code', { prompt: 'x', cwd: dir, permission: 'readonly' }, () => {});
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.status).toBe('succeeded');
    expect(b.status).toBe('succeeded');
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
  });

  it('refuses runs on disabled engines and cancels test runs', async () => {
    await patch('codex', { enabled: false });
    await expect(
      t.ctx.engines.run('codex', { prompt: 'x', cwd: dir, permission: 'readonly' }, () => {}),
    ).rejects.toThrow(/disabled/);
    claude.setResponses([{ match: '-p', sleepMs: 10_000 }]);
    const { runId } = (
      await t.app.inject({
        method: 'POST',
        url: '/api/engines/claude-code/test',
        payload: { prompt: 'hi' },
      })
    ).json();
    await new Promise((r) => setTimeout(r, 200));
    expect(
      (await t.app.inject({ method: 'POST', url: `/api/runs/${runId}/cancel` })).statusCode,
    ).toBe(202);
    const done = await waitFor(() =>
      events.find((e) => e.type === 'run.finished' && e.payload.runId === runId),
    );
    expect(done.type === 'run.finished' && done.payload.result.status).toBe('cancelled');
  });
});

describe('custom engines', () => {
  const body = (command: string) => ({
    slug: 'my-cli',
    displayName: 'My CLI',
    config: {
      command,
      args: ['{{prompt}}'],
      promptVia: 'arg',
      outputFormat: 'text',
      authCheckArgs: ['whoami'],
    },
  });

  it('creates, edits and removes a custom engine', async () => {
    const mine = makeFakeCli(dir, 'mycli');
    mine.setResponses([
      { match: '--version', stdout: 'mycli 0.3.1' },
      { match: 'whoami', stdout: 'dev\n' },
      { match: '', stdout: 'answer\n' },
    ]);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/engines/custom',
      payload: body(mine.path),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: 'custom:my-cli',
      kind: 'custom',
      installed: true,
      version: '0.3.1',
      authStatus: 'ACTIVE',
    });
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/engines/custom', payload: body(mine.path) }))
        .statusCode,
    ).toBe(409);
    const r = await t.ctx.engines.run(
      'custom:my-cli',
      { prompt: 'q', cwd: dir, permission: 'readonly' },
      () => {},
    );
    expect(r).toMatchObject({ status: 'succeeded', finalText: 'answer' });

    const upd = await t.app.inject({
      method: 'PUT',
      url: '/api/engines/custom:my-cli/custom',
      payload: {
        displayName: 'Renamed',
        config: { ...body(mine.path).config, authCheckArgs: undefined },
      },
    });
    expect(upd.json()).toMatchObject({ displayName: 'Renamed', authStatus: 'UNKNOWN' });
    expect(
      (await t.app.inject({ method: 'DELETE', url: '/api/engines/custom:my-cli' })).statusCode,
    ).toBe(204);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/engines/custom:my-cli' })).statusCode,
    ).toBe(404);
  });

  it('validates configs and protects built-ins', async () => {
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/engines/custom',
      payload: {
        slug: 'Bad Slug',
        displayName: 'x',
        config: { command: '', args: [], promptVia: 'x', outputFormat: 'text' },
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(
      (await t.app.inject({ method: 'DELETE', url: '/api/engines/claude-code' })).statusCode,
    ).toBe(400);
  });
});

describe('login and logout', () => {
  it('runs the login command in a PTY, streams output and refreshes on exit', async () => {
    claude.setResponses([
      { match: '--version', stdout: '2.1.327' },
      {
        match: 'auth login',
        stdout: 'Opening browser… visit https://claude.ai/oauth?code=demo\nLogin successful.\n',
      },
      { match: 'auth status', stdout: AUTH_OK },
    ]);
    const res = await t.app.inject({ method: 'POST', url: '/api/engines/claude-code/login' });
    expect(res.statusCode).toBe(201);
    const { terminal, hint } = res.json();
    expect(hint).toMatch(/browser/);
    expect(terminal).toMatchObject({ kind: 'login', engineId: 'claude-code', status: 'running' });
    await waitFor(() =>
      events.find((e) => e.type === 'terminal.exit' && e.payload.terminalId === terminal.id),
    );
    const output = events
      .filter((e) => e.type === 'terminal.output' && e.payload.terminalId === terminal.id)
      .map((e) => (e.type === 'terminal.output' ? e.payload.data : ''))
      .join('');
    expect(output).toContain('Login successful.');
    const after = (
      await t.app.inject({ method: 'GET', url: `/api/terminals/${terminal.id}` })
    ).json();
    expect(after).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(after.scrollback).toContain('https://claude.ai/oauth?code=demo');
    await waitFor(
      () =>
        claude.calls().filter((c) => c.args.join(' ').startsWith('auth status')).length >= 2 ||
        undefined,
    );
  });

  it('logs out where supported and explains where not', async () => {
    claude.setResponses([
      { match: 'auth logout', stdout: 'Logged out' },
      { match: '--version', stdout: '2.1.327' },
      { match: 'auth status', stdout: JSON.stringify({ loggedIn: false }) },
    ]);
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/engines/claude-code/logout' })).json()
        .authStatus,
    ).toBe('LOGGED_OUT');
    const agy = makeFakeCli(dir, 'agy');
    await patch('antigravity', { binaryPath: agy.path });
    const res = await t.app.inject({ method: 'POST', url: '/api/engines/antigravity/logout' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/no logout command/);
  });
});
