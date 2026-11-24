import { DEFAULT_SETTINGS } from '@agentforge/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projects, tasks, errors as errorsTable } from '../src/db/schema';
import { newId } from '../src/lib/id';
import { createTestApp, installFakeEngine, type TestApp } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => t.cleanup());

describe('system & settings API', () => {
  it('reports health and system info', async () => {
    const health = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toMatchObject({ ok: true });
    const info = (await t.app.inject({ method: 'GET', url: '/api/system' })).json();
    expect(info).toMatchObject({ name: 'agentforge', homeDir: t.home });
    expect(info.workspaceRoot).toBe(`${t.home}/workspaces`);
  });

  it('returns defaults, applies deep patches, persists and emits', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/settings' })).json()).toEqual(
      DEFAULT_SETTINGS,
    );
    // An engine that isn't installed can't become a default.
    const refused = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { defaultEngines: { reviewer: 'codex' } },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toMatch(/OpenAI Codex isn’t installed/);
    await installFakeEngine(t, 'codex');
    const events: string[] = [];
    t.ctx.bus.subscribe((e) => events.push(e.type));
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { pipeline: { maxFixLoops: 5 }, defaultEngines: { reviewer: 'codex' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pipeline).toEqual({ ...DEFAULT_SETTINGS.pipeline, maxFixLoops: 5 });
    expect(res.json().defaultEngines.reviewer).toBe('codex');
    expect(events).toEqual(['settings.updated']);
  });

  it('rejects invalid settings with a validation error', async () => {
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { concurrency: { maxTasksPerProject: 99 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
    expect(res.json().error.message).toContain('concurrency.maxTasksPerProject');
    const bad = await t.app.inject({ method: 'PATCH', url: '/api/settings', payload: [1] });
    expect(bad.statusCode).toBe(400);
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('local-only guard', () => {
  it('rejects non-loopback Host headers (DNS rebinding)', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.example.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects foreign browser origins but allows the web app', async () => {
    const evil = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { origin: 'https://evil.example.com' },
      payload: { pipeline: { maxFixLoops: 0 } },
    });
    expect(evil.statusCode).toBe(403);
    const ok = await t.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { origin: 'http://localhost:4318' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:4318');
  });
});

describe('projects API', () => {
  it('lists project summaries with aggregates', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/projects' })).json()).toEqual([]);
    const pid = newId('prj');
    t.ctx.db
      .insert(projects)
      .values({
        id: pid,
        name: 'Demo',
        slug: 'demo',
        origin: 'scratch',
        source: 'local',
        localPath: '/tmp/demo',
      })
      .run();
    const mk = (status: 'DONE' | 'IN_REVIEW' | 'DRAFT' | 'CANCELLED', n: number) =>
      t.ctx.db
        .insert(tasks)
        .values({ id: newId('tsk'), projectId: pid, key: `AF-${n}`, title: 't', status })
        .run();
    mk('DONE', 1);
    mk('IN_REVIEW', 2);
    mk('DRAFT', 3);
    mk('CANCELLED', 4);
    t.ctx.db
      .insert(errorsTable)
      .values({
        id: newId('err'),
        projectId: pid,
        source: 'terminal',
        matcher: 'ts',
        message: 'x',
        fingerprint: 'f',
      })
      .run();
    const [p] = (await t.app.inject({ method: 'GET', url: '/api/projects' })).json();
    expect(p).toMatchObject({
      id: pid,
      name: 'Demo',
      stack: [],
      taskCounts: { total: 3, active: 1, done: 1 },
      openErrorCount: 1,
    });
  });
});
