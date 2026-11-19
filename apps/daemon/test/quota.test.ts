import type { PlannerTask } from '@agentforge/shared';
import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkpoints, projectSettings, tasks as tasksTable, usageRecords } from '../src/db/schema';
import { newId } from '../src/lib/id';
import {
  claudeLimitStream,
  claudeStream,
  FIXTURES,
  makeFakeCli,
  type FakeCli,
  type FakeResponse,
} from './fake-cli';
import { createTestApp, tempDir, type TestApp } from './helpers';
import { join } from 'node:path';

let t: TestApp;
let root: string;
let agent: FakeCli;
let projectId: string;

const AUTH_OK = JSON.stringify({ loggedIn: true, loginExpiresAt: '2099-01-01T00:00:00Z' });
const base = (auth = AUTH_OK): FakeResponse[] => [
  { match: '--version', stdout: '2.1.327' },
  { match: 'auth status', stdout: auth },
];
const role = (name: string, text: string, extra: Partial<FakeResponse> = {}): FakeResponse => ({
  match: '-p',
  stdout: claudeStream(text),
  stdinIncludes: `# Role: ${name}`,
  ...extra,
});
const rest = () => [
  role('Reviewer', JSON.stringify({ verdict: 'APPROVE', summary: 'ok', comments: [] })),
  role('Tester', JSON.stringify({ passed: true, summary: 'ok' })),
  role('Documenter', JSON.stringify({ summary: 'done', report: 'report' })),
];
const pt = (ref: string): PlannerTask => ({
  ref,
  title: `Task ${ref}`,
  description: 'd',
  type: 'feature',
  priority: 'medium',
  complexity: 's',
  acceptanceCriteria: ['ok'],
  affectedAreas: [],
  dependsOn: [],
  subtasks: [],
  suggestedEngines: {},
});

beforeEach(async () => {
  root = tempDir('af-quota-');
  agent = makeFakeCli(root, 'claude');
  agent.setResponses(base());
  t = await createTestApp({}, { orchestrator: { autoStart: false } });
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
      name: 'Quota App',
      location: { kind: 'local', parentDir: root, folderName: 'qa' },
    },
  });
  projectId = res.json().id;
  await t.ctx.projects.runOnboarding(projectId);
});
afterEach(async () => {
  await t.cleanup();
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  const plan = t.ctx.tasks.createPlan(projectId, null, {
    goal: 'g',
    scope: '',
    outOfScope: '',
    architectureNotes: '',
    risks: [],
    assumptions: [],
  });
  const [task] = t.ctx.tasks.createFromPlanner(projectId, plan.id, null, [pt('T1')]);
  await t.app.inject({ method: 'POST', url: `/api/plans/${plan.id}/approve`, payload: {} });
  await t.ctx.orchestrator.idle();
  return task!.id;
}
const get = (id: string) => t.ctx.tasks.get(id);
const until = async (fn: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await t.ctx.orchestrator.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('auto-pause and auto-resume', () => {
  it('saves a checkpoint and resumes the same CLI session when the window resets', async () => {
    const resetSec = Math.ceil(Date.now() / 1000) + 2;
    agent.setResponses([
      ...base(),
      {
        match: '-p',
        stdinIncludes: '# Role: Developer',
        stdout: claudeLimitStream(resetSec),
        exitCode: 1,
        once: true,
      },
      {
        match: '-p --output-format stream-json --verbose --resume',
        stdinIncludes: 'You were interrupted',
        stdout: claudeStream('Finished after the reset.'),
        writeFiles: { 'a.txt': 'a' },
      },
      ...rest(),
    ]);
    const id = await start();
    expect(get(id)).toMatchObject({
      status: 'PAUSED_QUOTA',
      pipeline: { resumeAt: resetSec * 1000 },
    });
    const [cp] = t.ctx.db.select().from(checkpoints).where(eq(checkpoints.taskId, id)).all();
    expect(cp).toMatchObject({
      taskStatus: 'IN_DEVELOPMENT',
      role: 'developer',
      engineId: 'claude-code',
      sessionId: '11111111-2222-3333-4444-555555555555',
      lastCompletedStep: 'QUEUED',
    });
    expect(cp!.notes).toContain('Started on the task');
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/tasks/${id}/checkpoints` })).json(),
    ).toHaveLength(1);
    // The global "paused" banner lists it with its resume time.
    expect((await t.app.inject({ method: 'GET', url: '/api/tasks/paused' })).json()).toEqual([
      expect.objectContaining({ id, status: 'PAUSED_QUOTA', resumeAt: resetSec * 1000 }),
    ]);

    await until(() => get(id).status !== 'PAUSED_QUOTA'); // the scheduler resumes on its own
    await t.ctx.orchestrator.idle();
    expect(get(id).status).toBe('DONE');
    expect(t.ctx.tasks.history(id).map((h) => h.reason)).toContain(
      'Usage window renewed — resuming',
    );
    const resumed = agent.calls().find((c) => c.stdin.includes('You were interrupted'))!;
    expect(resumed.args).toEqual(
      expect.arrayContaining(['--resume', '11111111-2222-3333-4444-555555555555']),
    );
  });

  it('probes with exponential backoff when the error has no reset time', async () => {
    agent.setResponses([
      ...base(),
      {
        match: '-p',
        stdinIncludes: '# Role: Developer',
        stdout: claudeLimitStream(null),
        exitCode: 1,
      },
    ]);
    const before = Date.now();
    const id = await start();
    const q = t.ctx.settings.get().quota;
    const first = get(id).pipeline.resumeAt!;
    expect(first - before).toBeGreaterThanOrEqual(q.probeInitialBackoffSec * 1000 - 1000);
    // Time passes: the probe fails again and the wait doubles.
    t.ctx.db
      .update(tasksTable)
      .set({ resumeAt: Date.now() - 1 })
      .where(eq(tasksTable.id, id))
      .run();
    await until(() => get(id).status === 'PAUSED_QUOTA' && get(id).pipeline.resumeAt! > Date.now());
    await t.ctx.orchestrator.idle();
    const second = get(id).pipeline.resumeAt! - Date.now();
    expect(second).toBeGreaterThan(q.probeInitialBackoffSec * 2 * 1000 - 5000);
    // The window comes back: the next probe succeeds and the task finishes.
    agent.setResponses([
      ...base(),
      role('Developer', 'done', { writeFiles: { 'a.txt': 'a' } }),
      ...rest(),
    ]);
    t.ctx.db
      .update(tasksTable)
      .set({ resumeAt: Date.now() - 1 })
      .where(eq(tasksTable.id, id))
      .run();
    await until(() => get(id).status !== 'PAUSED_QUOTA');
    await t.ctx.orchestrator.idle();
    expect(get(id).status).toBe('DONE');
    expect(
      t.ctx.db.select().from(checkpoints).where(eq(checkpoints.taskId, id)).all(),
    ).toHaveLength(2);
  });

  it('continues on the fallback engine instead of pausing', async () => {
    const backup = makeFakeCli(root, 'backup');
    backup.setResponses([
      { match: '--version', stdout: 'backup 1.0' },
      { match: 'whoami', stdout: 'me' },
      { match: '', stdout: 'Finished on the backup engine.', writeFiles: { 'b.txt': 'b' } },
    ]);
    await t.app.inject({
      method: 'POST',
      url: '/api/engines/custom',
      payload: {
        slug: 'backup',
        displayName: 'Backup CLI',
        config: {
          command: backup.path,
          args: [],
          promptVia: 'stdin',
          outputFormat: 'text',
          authCheckArgs: ['whoami'],
        },
      },
    });
    t.ctx.db
      .update(projectSettings)
      .set({ fallbackEnabled: true, engineFallback: { 'claude-code': 'custom:backup' } })
      .where(eq(projectSettings.projectId, projectId))
      .run();
    agent.setResponses([
      ...base(),
      {
        match: '-p',
        stdinIncludes: '# Role: Developer',
        stdout: claudeLimitStream(Math.floor(Date.now() / 1000) + 3600),
        exitCode: 1,
      },
      ...rest(),
    ]);
    const id = await start();
    expect(get(id)).toMatchObject({ status: 'DONE', roleEngines: { developer: 'custom:backup' } });
    expect(backup.calls().find((c) => c.args.length === 0)!.stdin).toContain(
      'Another engine started this step',
    );
  });

  it('resumes a login pause once the engine is active again', async () => {
    agent.setResponses([
      ...base(),
      {
        match: '-p',
        stdinIncludes: '# Role: Developer',
        stdoutFile: join(FIXTURES, 'claude-auth.jsonl'),
        exitCode: 1,
        once: true,
      },
      role('Developer', 'done', { writeFiles: { 'a.txt': 'a' } }),
      ...rest(),
    ]);
    const id = await start();
    expect(get(id).status).toBe('PAUSED_AUTH');
    expect(t.ctx.engines.get('claude-code').authStatus).toBe('EXPIRED');
    await t.ctx.orchestrator.tick();
    expect(get(id).status).toBe('PAUSED_AUTH'); // still logged out
    await t.ctx.engines.refresh('claude-code'); // e.g. after you log in
    await until(() => get(id).status !== 'PAUSED_AUTH');
    await t.ctx.orchestrator.idle();
    expect(get(id).status).toBe('DONE');
  });

  it("doesn't start work on an engine whose window is exhausted", async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 3600;
    await t.ctx.engines
      .run('claude-code', { prompt: 'x', cwd: root, permission: 'readonly' }, () => {})
      .catch(() => {});
    agent.setResponses([
      ...base(),
      { match: '-p', stdout: claudeLimitStream(resetSec), exitCode: 1 },
    ]);
    await t.ctx.engines.run(
      'claude-code',
      { prompt: 'x', cwd: root, permission: 'readonly' },
      () => {},
    );
    expect(t.ctx.engines.get('claude-code').authStatus).toBe('QUOTA_EXHAUSTED');
    const id = await start();
    expect(get(id).status).toBe('QUEUED');
    expect(get(id).statusReason).toMatch(/Waiting for Claude Code's usage window/);
  });
});

describe('usage analytics', () => {
  it('summarises tokens and cost by day, project, engine, role, task and task type', async () => {
    await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { pricing: { 'gpt-x': { input: 2, output: 10 } } },
    });
    agent.setResponses([
      ...base(),
      role('Developer', 'done', { writeFiles: { 'a.txt': 'a' } }),
      ...rest(),
    ]);
    const id = await start();
    expect(get(id).status).toBe('DONE');
    // An engine that doesn't report cost: estimated from the price table.
    t.ctx.db
      .insert(usageRecords)
      .values({
        id: newId('use'),
        projectId,
        taskId: id,
        role: 'reviewer',
        taskType: 'feature',
        engineId: 'codex',
        model: 'gpt-x',
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        costUsd: 3,
        costSource: 'estimated',
      })
      .run();
    const s = (await t.app.inject({ method: 'GET', url: '/api/usage/summary?days=7' })).json();
    expect(s.totals.runs).toBe(5);
    expect(s.totals.costUsd).toBeCloseTo(3.04, 2);
    expect(s.totals.estimatedShare).toBeCloseTo(3 / 3.04, 2);
    expect(s.byDay).toHaveLength(1);
    expect(s.byWeek).toHaveLength(1);
    expect(s.byProject).toMatchObject([{ key: projectId, label: 'Quota App', runs: 5 }]);
    expect(s.byEngine.map((b: { key: string }) => b.key)).toEqual(['codex', 'claude-code']);
    expect(s.byRole.map((b: { key: string }) => b.key).sort()).toEqual([
      'developer',
      'documenter',
      'reviewer',
      'tester',
    ]);
    expect(s.topTasks).toMatchObject([{ key: id, taskKey: 'QA-1', runs: 5 }]);
    expect(s.byTaskType).toMatchObject([{ type: 'feature', tasks: 1 }]);
    const byEngine = (
      await t.app.inject({ method: 'GET', url: '/api/usage/summary?days=7&engineId=codex' })
    ).json();
    expect(byEngine.totals.runs).toBe(1);
  });

  it('estimates cost from the price table when the CLI reports none', async () => {
    const custom = makeFakeCli(root, 'plain');
    custom.setResponses([
      { match: '--version', stdout: '1.0' },
      { match: '', stdout: 'answer\ntokens in=1000000 out=500000\n' },
    ]);
    await t.app.inject({
      method: 'POST',
      url: '/api/engines/custom',
      payload: {
        slug: 'plain',
        displayName: 'Plain',
        config: {
          command: custom.path,
          args: [],
          promptVia: 'stdin',
          outputFormat: 'text',
          usage: { regex: 'in=(?<input>\\d+) out=(?<output>\\d+)' },
        },
      },
    });
    await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { pricing: { 'custom:plain': { input: 1, output: 4 } } },
    });
    const runId = t.ctx.runs.start({
      projectId,
      role: 'reviewer',
      engineId: 'custom:plain',
      prompt: 'p',
      cwd: root,
    });
    const result = await t.ctx.engines.run(
      'custom:plain',
      { prompt: 'p', cwd: root, permission: 'readonly' },
      t.ctx.runs.sink(runId),
    );
    t.ctx.runs.finish(runId, result);
    const rec = t.ctx.db.select().from(usageRecords).where(eq(usageRecords.runId, runId)).get()!;
    expect(rec).toMatchObject({ costSource: 'estimated', costUsd: 3 });
  });

  it('reports usage windows: from the CLI and against your configured limit', async () => {
    await t.app.inject({
      method: 'PATCH',
      url: '/api/engines/claude-code',
      payload: { windowTokenLimit: 1_000_000, windowHours: 5 },
    });
    t.ctx.db
      .insert(usageRecords)
      .values({
        id: newId('use'),
        engineId: 'claude-code',
        inputTokens: 250_000,
        outputTokens: 50_000,
      })
      .run();
    t.ctx.db
      .insert(usageRecords)
      .values({
        id: newId('use'),
        engineId: 'claude-code',
        inputTokens: 999,
        outputTokens: 0,
        recordedAt: Date.now() - 6 * 3600_000,
      })
      .run();
    const w = (await t.app.inject({ method: 'GET', url: '/api/usage/windows' })).json();
    expect(w.find((x: { engineId: string }) => x.engineId === 'claude-code')).toMatchObject({
      configured: { limit: 1_000_000, hours: 5, used: 300_000 },
    });
  });
});
