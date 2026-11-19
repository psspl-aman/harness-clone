import type { AnyAppEvent, ErrorDto } from '@agentforge/shared';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeStream, makeFakeCli, type FakeCli, type FakeResponse } from './fake-cli';
import { createTestApp, tempDir, type TestApp } from './helpers';

let t: TestApp;
let root: string;
let agent: FakeCli;
let projectId: string;
let repo: string;
const events: AnyAppEvent[] = [];

const BASE: FakeResponse[] = [
  { match: '--version', stdout: '2.1.327' },
  {
    match: 'auth status',
    stdout: JSON.stringify({ loggedIn: true, loginExpiresAt: '2099-01-01T00:00:00Z' }),
  },
];
const until = async (fn: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
};
const setCommands = (commands: Record<string, string | null>) =>
  t.app.inject({ method: 'PATCH', url: `/api/projects/${projectId}`, payload: { commands } });
const errorsOf = async (): Promise<ErrorDto[]> =>
  (await t.app.inject({ url: `/api/projects/${projectId}/errors` })).json();

beforeEach(async () => {
  root = tempDir('af-runtime-');
  agent = makeFakeCli(root, 'claude');
  agent.setResponses(BASE);
  t = await createTestApp({}, { orchestrator: { autoStart: false } });
  events.length = 0;
  t.ctx.bus.subscribe((e) => events.push(e));
  await t.app.inject({
    method: 'PATCH',
    url: '/api/engines/claude-code',
    payload: { binaryPath: agent.path },
  });
  await t.ctx.engines.refresh('claude-code');
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      mode: 'scratch',
      name: 'Runtime App',
      location: { kind: 'local', parentDir: root, folderName: 'rt' },
    },
  });
  projectId = res.json().id;
  repo = res.json().localPath;
  await t.ctx.projects.runOnboarding(projectId);
});
afterEach(async () => {
  await t.cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe('run service', () => {
  it('starts the dev server, detects the preview URL and stops it', async () => {
    await setCommands({ run: 'echo "ready on http://0.0.0.0:5199/app" && sleep 30' });
    const start = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/run/start`,
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({
      status: 'starting',
      command: expect.stringContaining('5199'),
    });
    await until(() => t.ctx.runner.status(projectId).previewUrl !== null);
    expect(t.ctx.runner.status(projectId)).toMatchObject({
      status: 'running',
      previewUrl: 'http://localhost:5199/app',
    });
    expect((await t.app.inject({ url: `/api/projects/${projectId}` })).json().runningStatus).toBe(
      'running',
    );
    // A second start is refused while running.
    expect(
      (await t.app.inject({ method: 'POST', url: `/api/projects/${projectId}/run/start` }))
        .statusCode,
    ).toBe(409);

    const stop = await t.app.inject({ method: 'POST', url: `/api/projects/${projectId}/run/stop` });
    expect(stop.json().status).toBe('stopped');
    expect(events.some((e) => e.type === 'project.run' && e.payload.run.status === 'stopped')).toBe(
      true,
    );
    // A deliberate stop is not an error.
    expect((await errorsOf()).length).toBe(0);
  });

  it('marks a crashing server and records the exit as an error', async () => {
    await setCommands({ run: 'echo booting; exit 3' });
    await t.app.inject({ method: 'POST', url: `/api/projects/${projectId}/run/start` });
    await until(() => t.ctx.runner.status(projectId).status === 'crashed');
    expect(t.ctx.runner.status(projectId).exitCode).toBe(3);
    await until(async () => (await errorsOf()).length === 1);
    const [e] = await errorsOf();
    expect(e).toMatchObject({
      source: 'run',
      matcher: 'process-exit',
      message: 'Dev server exited with code 3',
      status: 'open',
    });
    expect(e!.excerpt).toContain('booting');
  });

  it('requires a configured command', async () => {
    await setCommands({ run: null, build: null });
    const r = await t.app.inject({ method: 'POST', url: `/api/projects/${projectId}/run/start` });
    expect(r.statusCode).toBe(400);
    expect(
      (await t.app.inject({ method: 'POST', url: `/api/projects/${projectId}/run/build` }))
        .statusCode,
    ).toBe(400);
  });

  it('opens shell terminals in the project folder', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/terminals`,
      payload: {},
    });
    expect(r.json()).toMatchObject({ kind: 'shell', projectId, cwd: repo, title: 'Terminal 1' });
  });
});

describe('error detection', () => {
  it('detects, de-duplicates and reopens errors from build output', async () => {
    await setCommands({
      build: `printf "src/app.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.\\n"; exit 2`,
    });
    const run1 = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/run/build`,
    });
    expect(run1.json()).toMatchObject({ kind: 'run', title: 'Build' });
    await until(async () => (await errorsOf()).length === 1);
    const [e] = await errorsOf();
    expect(e).toMatchObject({
      source: 'run',
      matcher: 'typescript',
      filePath: 'src/app.ts',
      line: 4,
      column: 7,
      occurrences: 1,
    });

    await t.app.inject({ method: 'POST', url: `/api/errors/${e!.id}/resolve` });
    await t.app.inject({ method: 'POST', url: `/api/projects/${projectId}/run/build` });
    await until(async () => (await errorsOf())[0]!.occurrences === 2);
    // Same fingerprint → one row; an error that comes back is open again.
    expect(await errorsOf()).toHaveLength(1);
    expect((await errorsOf())[0]!.status).toBe('open');

    await t.app.inject({ method: 'POST', url: `/api/errors/${e!.id}/ignore` });
    expect(
      (await t.app.inject({ url: `/api/projects/${projectId}/errors?status=open,fixing` })).json(),
    ).toHaveLength(0);
    expect(events.some((x) => x.type === 'error.updated')).toBe(true);
  });

  it('turns an error into a Fixer-first task and resolves it when the task is done', async () => {
    await setCommands({
      build: `printf "TypeError: Cannot read properties of undefined (reading 'id')\\n    at load (src/data.js:12:5)\\n"; exit 1`,
      test: null,
    });
    await t.app.inject({ method: 'POST', url: `/api/projects/${projectId}/run/build` });
    await until(async () => (await errorsOf()).length >= 1);
    const err = (await errorsOf()).find((x) => x.matcher === 'js-exception')!;
    expect(err.filePath).toBe('src/data.js');

    const fixed = await t.app.inject({ method: 'POST', url: `/api/errors/${err.id}/fix` });
    expect(fixed.json()).toMatchObject({ status: 'fixing', fixTaskId: expect.any(String) });
    // A second fix request while one is running is refused.
    expect(
      (await t.app.inject({ method: 'POST', url: `/api/errors/${err.id}/fix` })).statusCode,
    ).toBe(409);
    const taskId = fixed.json().fixTaskId as string;
    const task = t.ctx.tasks.get(taskId);
    expect(task).toMatchObject({ origin: 'error', type: 'bug', priority: 'high' });
    expect(task.description).toContain('Cannot read properties of undefined');

    // The fake fix doesn't touch the build script; drop it so AgentForge's own checks pass.
    await setCommands({ build: null });
    agent.setResponses([
      ...BASE,
      {
        match: '-p',
        stdinIncludes: ['# Role: Fixer', 'detected while running the project'],
        stdout: claudeStream('Guarded the undefined lookup.'),
        writeFiles: { 'src/data.js': 'export const load = (x) => x?.id;\n' },
      },
      {
        match: '-p',
        stdinIncludes: '# Role: Reviewer',
        stdout: claudeStream(JSON.stringify({ verdict: 'APPROVE', summary: 'ok', comments: [] })),
      },
      {
        match: '-p',
        stdinIncludes: '# Role: Tester',
        stdout: claudeStream(JSON.stringify({ passed: true, summary: 'ok', total: 1, failed: 0 })),
      },
      {
        match: '-p',
        stdinIncludes: '# Role: Documenter',
        stdout: claudeStream(
          JSON.stringify({
            summary: 'Fixed',
            report: 'Fixed the crash',
            docsUpdated: [],
            memory: [],
            limitations: [],
          }),
        ),
      },
    ]);
    if (task.status === 'DRAFT')
      await t.app.inject({ method: 'POST', url: `/api/tasks/${taskId}/approve`, payload: {} });
    await t.ctx.orchestrator.tick();
    await t.ctx.orchestrator.idle();
    expect(t.ctx.tasks.get(taskId)).toMatchObject({
      status: 'DONE',
      statusReason: 'Merged into main',
    });
    // The develop step ran the Fixer, not the Developer.
    expect(agent.calls().some((c) => c.stdin.includes('# Role: Developer'))).toBe(false);
    expect((await errorsOf()).find((x) => x.id === err.id)!.status).toBe('resolved');
  });

  it('records task failures and resolves them when a retry succeeds', async () => {
    const { id } = t.ctx.tasks.createFollowUp(projectId, null, {
      title: 'Doomed',
      description: 'x',
      type: 'feature',
      priority: 'low',
      acceptanceCriteria: [],
      roleEngines: {},
      origin: 'conflict',
      pipelineState: {},
    });
    t.ctx.tasks.transition(id, 'QUEUED', 'ok', 'user');
    t.ctx.tasks.transition(id, 'IN_DEVELOPMENT', 'ok', 'orchestrator');
    t.ctx.tasks.transition(id, 'FAILED', 'engine crashed', 'orchestrator');
    const [e] = await errorsOf();
    expect(e).toMatchObject({
      source: 'task',
      matcher: 'task-failure',
      taskId: id,
      status: 'open',
    });
    expect(e!.message).toContain('engine crashed');
  });
});

describe('files', () => {
  it('lists the tree and reads files, refusing secrets, traversal and binaries', async () => {
    writeFileSync(join(repo, 'hello.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, '.env'), 'X=1\n');
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    const tree = (await t.app.inject({ url: `/api/projects/${projectId}/files` })).json();
    expect(tree.files).toContain('hello.ts');
    const f = await t.app.inject({ url: `/api/projects/${projectId}/file?path=hello.ts` });
    expect(f.json()).toMatchObject({
      path: 'hello.ts',
      language: 'typescript',
      binary: false,
      content: 'export const x = 1;\n',
    });
    expect(
      (await t.app.inject({ url: `/api/projects/${projectId}/file?path=.env` })).statusCode,
    ).toBe(403);
    expect(
      (await t.app.inject({ url: `/api/projects/${projectId}/file?path=../../etc/passwd` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await t.app.inject({ url: `/api/projects/${projectId}/file?path=.git/config` })).statusCode,
    ).toBe(400);
    expect(
      (await t.app.inject({ url: `/api/projects/${projectId}/file?path=blob.bin` })).json(),
    ).toMatchObject({ binary: true, content: '' });
  });
});
