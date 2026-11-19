import type { AnyAppEvent, PlannerTask } from '@agentforge/shared';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, documents, memoryEntries, reviewComments, testResults } from '../src/db/schema';
import {
  claudeLimitStream,
  claudeStream,
  makeFakeCli,
  type FakeCli,
  type FakeResponse,
} from './fake-cli';
import { createTestApp, GIT_ID, tempDir, type TestApp } from './helpers';

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
const reply = (text: string, extra: Partial<FakeResponse> = {}): FakeResponse => ({
  match: '-p',
  stdout: claudeStream(text),
  ...extra,
});
const role = (name: string, text: string, extra: Partial<FakeResponse> = {}) =>
  reply(text, { stdinIncludes: `# Role: ${name}`, ...extra });

const FAKE_ENV = 'TOKEN=leak'; // gforge:allow — fake secret proving .env files are never committed
const APPROVE = JSON.stringify({ verdict: 'APPROVE', summary: 'Looks good.', comments: [] });
const CHANGES = JSON.stringify({
  verdict: 'changes requested',
  summary: 'Missing a test.',
  comments: [{ file: 'src/a.txt', line: 1, severity: 'major', body: 'Add a test' }],
});
const PASS = JSON.stringify({
  passed: true,
  summary: 'All tests pass.',
  total: 3,
  failed: 0,
  commands: ['npm test'],
});
const DOC = JSON.stringify({
  summary: 'Delivered the feature.',
  report: 'Added the feature file.',
  docsUpdated: ['README.md'],
  memory: [
    {
      kind: 'decision',
      title: 'Plain text storage',
      content: 'Features are stored as .txt files.',
    },
  ],
  limitations: ['No UI yet'],
});
const reviewer = (extra: Partial<FakeResponse> = {}) => role('Reviewer', APPROVE, extra);
const tester = () => role('Tester', PASS);
const documenter = () =>
  role('Documenter', DOC, { writeFiles: { 'README.md': '# Project\n\nNow with features.\n' } });
const developer = (key: string, files: Record<string, string>, extra: Partial<FakeResponse> = {}) =>
  role('Developer', `Implemented ${key}.`, {
    stdinIncludes: ['# Role: Developer', `Task ${key}:`],
    writeFiles: files,
    ...extra,
  });

const script = (...r: FakeResponse[]) => agent.setResponses([...BASE, ...r]);
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const pt = (ref: string, title: string, dependsOn: string[] = []): PlannerTask => ({
  ref,
  title,
  description: `Implement ${title}`,
  type: 'feature',
  priority: 'medium',
  complexity: 's',
  acceptanceCriteria: [`${title} works`],
  affectedAreas: [],
  dependsOn,
  subtasks: [],
  suggestedEngines: {},
});

async function setupApp(home?: string) {
  t = await createTestApp(home ? { AGENTFORGE_HOME: home } : {}, {
    orchestrator: { autoStart: false },
  });
  events.length = 0;
  t.ctx.bus.subscribe((e) => events.push(e));
  await t.app.inject({
    method: 'PATCH',
    url: '/api/engines/claude-code',
    payload: { binaryPath: agent.path },
  });
  await t.ctx.engines.refresh('claude-code');
}

beforeEach(async () => {
  root = tempDir('af-orch-');
  agent = makeFakeCli(root, 'claude');
  script();
  await setupApp();
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      mode: 'scratch',
      name: 'Shop App',
      location: { kind: 'local', parentDir: root, folderName: 'shop' },
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

function plan(...items: PlannerTask[]) {
  const p = t.ctx.tasks.createPlan(projectId, null, {
    goal: 'Ship',
    scope: '',
    outOfScope: '',
    architectureNotes: '',
    risks: [],
    assumptions: [],
  });
  const created = t.ctx.tasks.createFromPlanner(projectId, p.id, null, items);
  return { planId: p.id, tasks: created };
}
const approveAll = (planId: string) =>
  t.app.inject({ method: 'POST', url: `/api/plans/${planId}/approve`, payload: {} });
const task = (id: string) => t.ctx.tasks.get(id);
const statuses = (id: string) => t.ctx.tasks.history(id).map((h) => h.to);
const setProject = (payload: object) =>
  t.app.inject({ method: 'PATCH', url: `/api/projects/${projectId}`, payload });
const waitFor = async (fn: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await t.ctx.orchestrator.tick();
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('pipeline: happy path', () => {
  it('builds dependent tasks in worktrees and merges them into the working branch', async () => {
    script(
      developer('SA-1', { 'src/a.txt': 'feature a\n' }),
      developer('SA-2', { 'src/b.txt': 'feature b\n' }),
      reviewer(),
      tester(),
      documenter(),
    );
    const { planId, tasks } = plan(pt('T1', 'Feature A'), pt('T2', 'Feature B', ['T1']));
    await approveAll(planId);
    await t.ctx.orchestrator.tick();
    expect(task(tasks[1]!.id)).toMatchObject({
      status: 'BLOCKED',
      statusReason: 'Waiting for SA-1',
    });
    await t.ctx.orchestrator.idle();

    for (const x of tasks) expect(task(x.id).status).toBe('DONE');
    expect(statuses(tasks[0]!.id)).toEqual([
      'DRAFT',
      'APPROVED',
      'QUEUED',
      'IN_DEVELOPMENT',
      'IN_REVIEW',
      'IN_TESTING',
      'DOCUMENTING',
      'DONE',
    ]);
    expect(statuses(tasks[1]!.id)).toContain('BLOCKED');
    // Both changes landed on main through no-ff merges; the user's checkout is clean.
    expect(readFileSync(join(repo, 'src/a.txt'), 'utf8')).toBe('feature a\n');
    expect(readFileSync(join(repo, 'src/b.txt'), 'utf8')).toBe('feature b\n');
    expect(git(repo, 'log', '--merges', '--format=%s')).toMatch(
      /Merge SA-2: Feature B\nMerge SA-1: Feature A/,
    );
    expect(git(repo, 'status', '--porcelain')).toBe('');
    // Worktrees and task branches are cleaned up.
    expect(git(repo, 'branch', '--list', 'af/*')).toBe('');
    expect(existsSync(join(t.home, 'worktrees', projectId, 'SA-1'))).toBe(false);
    // SA-2's developer saw SA-1's work (its worktree branched from the updated main).
    const dev2 = agent
      .calls()
      .find((c) => c.stdin.includes('Task SA-2:') && c.stdin.includes('# Role: Developer'))!;
    expect(dev2.stdin).toContain('## Already completed dependencies\n- SA-1 Feature A');
    expect(dev2.args).toEqual(
      expect.arrayContaining(['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash']),
    );
    expect(agent.calls().find((c) => c.stdin.includes('# Role: Reviewer'))!.args).toEqual(
      expect.arrayContaining(['--permission-mode', 'dontAsk']),
    );

    // Records: runs per role, review, tests, report and memory.
    const runs = t.ctx.db.select().from(agentRuns).where(eq(agentRuns.taskId, tasks[0]!.id)).all();
    expect(runs.map((r) => r.role)).toEqual(['developer', 'reviewer', 'tester', 'documenter']);
    expect(runs[0]!.filesChanged).toEqual(['src/a.txt']);
    expect(runs[0]!.diff).toContain('+feature a');
    const report = (
      await t.app.inject({ method: 'GET', url: `/api/tasks/${tasks[0]!.id}/report` })
    ).json();
    expect(report.content).toContain('# SA-1: Feature A');
    expect(report.content).toContain('`src/a.txt` — added, +1 −0');
    expect(report.content).toContain('| developer | 1 |');
    expect(report.content).toContain('No UI yet');
    expect(
      t.ctx.db
        .select()
        .from(memoryEntries)
        .where(eq(memoryEntries.source, 'documenter'))
        .all()
        .map((m) => m.title),
    ).toEqual(expect.arrayContaining(['SA-1: Feature A', 'Plain text storage']));
    const diff = (
      await t.app.inject({ method: 'GET', url: `/api/tasks/${tasks[0]!.id}/diff` })
    ).json();
    expect(diff.files.map((f: { path: string }) => f.path).sort()).toEqual([
      'README.md',
      'src/a.txt',
    ]);
    expect(task(tasks[0]!.id).pipeline.tokens).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'notification' && e.payload.title === 'SA-1 done')).toBe(
      true,
    );
  });

  it('never commits secret files the agent creates', async () => {
    script(
      developer('SA-1', { 'src/a.txt': 'a', '.env': FAKE_ENV, 'id.pem': 'KEY' }),
      reviewer(),
      tester(),
      documenter(),
    );
    const { planId, tasks } = plan(pt('T1', 'Feature A'));
    await approveAll(planId);
    await t.ctx.orchestrator.idle();
    expect(task(tasks[0]!.id).status).toBe('DONE');
    expect(git(repo, 'ls-files')).not.toMatch(/\.env|id\.pem/);
    expect(existsSync(join(repo, '.env'))).toBe(false);
  });
});

describe('pipeline: fix loops', () => {
  it('sends review feedback to the Fixer and re-reviews', async () => {
    script(
      developer('SA-1', { 'src/a.txt': 'a' }),
      reviewer({ stdout: claudeStream(CHANGES), once: true }),
      reviewer(),
      role('Fixer', 'Added the test.', { writeFiles: { 'test/a.test.txt': 'ok' } }),
      tester(),
      documenter(),
    );
    const { planId, tasks } = plan(pt('T1', 'Feature A'));
    await approveAll(planId);
    await t.ctx.orchestrator.idle();
    const id = tasks[0]!.id;
    expect(task(id)).toMatchObject({ status: 'DONE', pipeline: { fixLoops: 1 } });
    expect(statuses(id)).toEqual([
      'DRAFT',
      'APPROVED',
      'QUEUED',
      'IN_DEVELOPMENT',
      'IN_REVIEW',
      'FIXING',
      'IN_REVIEW',
      'IN_TESTING',
      'DOCUMENTING',
      'DONE',
    ]);
    const fixer = agent.calls().find((c) => c.stdin.includes('# Role: Fixer'))!;
    expect(fixer.stdin).toContain('[major] src/a.txt:1 Add a test');
    expect(t.ctx.db.select().from(reviewComments).all()).toMatchObject([
      { severity: 'major', body: 'Add a test' },
    ]);
    expect(existsSync(join(repo, 'test/a.test.txt'))).toBe(true);
  });

  it("verifies with the project's own commands, not just the Tester's word", async () => {
    await setProject({ commands: { test: 'test -f src/fixed.txt && echo verified' } });
    script(
      developer('SA-1', { 'src/a.txt': 'a' }),
      reviewer(),
      tester(),
      role('Fixer', 'Created the missing file.', { writeFiles: { 'src/fixed.txt': 'ok' } }),
      documenter(),
    );
    const { planId, tasks } = plan(pt('T1', 'Feature A'));
    await approveAll(planId);
    await t.ctx.orchestrator.idle();
    const id = tasks[0]!.id;
    expect(statuses(id)).toEqual([
      'DRAFT',
      'APPROVED',
      'QUEUED',
      'IN_DEVELOPMENT',
      'IN_REVIEW',
      'IN_TESTING',
      'FIXING',
      'IN_TESTING',
      'DOCUMENTING',
      'DONE',
    ]);
    const results = t.ctx.db.select().from(testResults).where(eq(testResults.taskId, id)).all();
    expect(results.map((r) => r.passed)).toEqual([false, true]);
    expect(results[0]!.summary).toMatch(/AgentForge's own checks failed/);
    expect(results[0]!.log).toContain('$ test -f src/fixed.txt && echo verified');
    expect(results[1]!.log).toContain('verified');
    expect(agent.calls().find((c) => c.stdin.includes('# Role: Fixer'))!.stdin).toContain(
      "Output of AgentForge's own checks",
    );
  });

  it('escalates to you after the fix-loop limit, and retry grants another round', async () => {
    await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { pipeline: { maxFixLoops: 1 } },
    });
    script(
      developer('SA-1', { 'src/a.txt': 'a' }),
      role('Reviewer', CHANGES),
      role('Fixer', 'Tried.'),
    );
    const { planId, tasks } = plan(pt('T1', 'Feature A'));
    await approveAll(planId);
    await t.ctx.orchestrator.idle();
    const id = tasks[0]!.id;
    expect(task(id)).toMatchObject({ status: 'NEEDS_HUMAN', pipeline: { fixLoops: 1 } });
    expect(task(id).statusReason).toMatch(/Still failing after 1 fix attempt: Missing a test/);
    script(role('Fixer', 'Fixed for real.'), reviewer(), tester(), documenter());
    await t.app.inject({ method: 'POST', url: `/api/tasks/${id}/retry` });
    await t.ctx.orchestrator.idle();
    expect(task(id).status).toBe('DONE');
  });
});

describe('pipeline: failures and pauses', () => {
  it('pauses on a usage limit with the reset time, and resumes the same step', async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 3600;
    script(
      {
        match: '-p',
        stdinIncludes: '# Role: Developer',
        stdout: claudeLimitStream(resetSec),
        exitCode: 1,
        once: true,
      },
      developer('SA-1', { 'src/a.txt': 'a' }),
      reviewer(),
      tester(),
      documenter(),
    );
    const { planId, tasks } = plan(pt('T1', 'Feature A'));
    await approveAll(planId);
    await t.ctx.orchestrator.idle();
    const id = tasks[0]!.id;
    expect(task(id)).toMatchObject({
      status: 'PAUSED_QUOTA',
      pipeline: { resumeAt: resetSec * 1000 },
    });
    expect(task(id).statusReason).toMatch(/Claude Code usage limit reached — resumes at/);
    await t.app.inject({ method: 'POST', url: `/api/tasks/${id}/resume` });
    expect(task(id).status).toBe('IN_DEVELOPMENT');
    await t.ctx.orchestrator.idle();
    expect(task(id).status).toBe('DONE');
  });

  it('retries a crashed step once, then fails; retry resumes at that step', async () => {
    script(
      developer('SA-1', { 'src/a.txt': 'a' }),
      role('Reviewer', '', { stdout: '', stderr: 'segfault', exitCode: 1 }),
    );
    const { planId, tasks } = plan(pt('T1', 'Feature A'));
    await approveAll(planId);
    await t.ctx.orchestrator.idle();
    const id = tasks[0]!.id;
    expect(task(id).status).toBe('FAILED');
    expect(task(id).pipeline.lastError).toMatch(/reviewer failed on Claude Code/);
    expect(
      t.ctx.db.select().from(agentRuns).where(eq(agentRuns.role, 'reviewer')).all(),
    ).toHaveLength(2);
    script(reviewer(), tester(), documenter());
    await t.app.inject({ method: 'POST', url: `/api/tasks/${id}/retry` });
    expect(task(id).status).toBe('IN_REVIEW');
    await t.ctx.orchestrator.idle();
    expect(task(id).status).toBe('DONE');
  });

  it('pauses, resumes and cancels running tasks', async () => {
    script(
      developer('SA-1', { 'src/a.txt': 'a' }, { sleepMs: 4000, once: true }),
      developer('SA-1', { 'src/a.txt': 'a' }),
      reviewer(),
      tester(),
      documenter(),
      developer('SA-2', {}, { sleepMs: 10_000 }),
    );
    const { planId, tasks } = plan(pt('T1', 'Feature A'), pt('T2', 'Feature B'));
    await approveAll(planId);
    await t.ctx.orchestrator.tick();
    const [a, b] = [tasks[0]!.id, tasks[1]!.id];
    await waitFor(() => task(a).pipeline.activeRole === 'developer');
    await t.app.inject({ method: 'POST', url: `/api/tasks/${a}/pause` });
    expect(task(a)).toMatchObject({ status: 'PAUSED_MANUAL' });
    await t.app.inject({ method: 'POST', url: `/api/tasks/${b}/cancel` });
    expect(task(b).status).toBe('CANCELLED');
    await t.ctx.orchestrator.idle();
    expect(task(a).status).toBe('PAUSED_MANUAL');
    await t.app.inject({ method: 'POST', url: `/api/tasks/${a}/resume` });
    await t.ctx.orchestrator.idle();
    expect(task(a).status).toBe('DONE');
    expect(existsSync(join(t.home, 'worktrees', projectId, 'SA-2'))).toBe(false);
  }, 30_000); // several real CLI processes; slow under a fully loaded test run

  it('delivers your message to the running agent by resuming its session', async () => {
    script(
      developer('SA-1', {}, { sleepMs: 3000, once: true }),
      reply('Done, with tabs.', {
        stdinIncludes: 'Message from the user',
        writeFiles: { 'src/a.txt': 'tabs' },
      }),
      reviewer(),
      tester(),
      documenter(),
    );
    const { planId, tasks } = plan(pt('T1', 'Feature A'));
    await approveAll(planId);
    await t.ctx.orchestrator.tick();
    const id = tasks[0]!.id;
    await waitFor(() => task(id).pipeline.activeRole === 'developer');
    await new Promise((r) => setTimeout(r, 300)); // let the CLI start
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/tasks/${id}/steer`,
          payload: { message: 'Use tabs, not spaces' },
        })
      ).statusCode,
    ).toBe(200);
    await t.ctx.orchestrator.idle();
    expect(task(id).status).toBe('DONE');
    const steered = agent.calls().find((c) => c.stdin.includes('Message from the user'))!;
    expect(steered.stdin).toContain('- Use tabs, not spaces');
    expect(steered.args).toEqual(
      expect.arrayContaining(['--resume', '11111111-2222-3333-4444-555555555555']),
    );
  });

  it('limits concurrent tasks per project', async () => {
    await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { concurrency: { maxTasksPerProject: 1 } },
    });
    script(role('Developer', 'done', { sleepMs: 300 }), reviewer(), tester(), documenter());
    const { planId, tasks } = plan(pt('T1', 'A'), pt('T2', 'B'), pt('T3', 'C'));
    await approveAll(planId);
    await t.ctx.orchestrator.tick();
    expect(tasks.map((x) => task(x.id).status).filter((s) => s === 'IN_DEVELOPMENT')).toHaveLength(
      1,
    );
    await t.ctx.orchestrator.idle(90_000);
    const devs = t.ctx.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.role, 'developer'))
      .all()
      .sort((x, y) => x.startedAt - y.startedAt);
    for (let i = 1; i < devs.length; i++)
      expect(devs[i]!.startedAt).toBeGreaterThanOrEqual(devs[i - 1]!.finishedAt!);
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/projects/${projectId}/pipeline` })).json(),
    ).toMatchObject({ limit: 1, running: [], queued: 0 });
  });

  it('holds new work while the project pipeline is paused', async () => {
    await t.app.inject({ method: 'POST', url: `/api/projects/${projectId}/pipeline/pause` });
    const { planId, tasks } = plan(pt('T1', 'A'));
    await approveAll(planId);
    await t.ctx.orchestrator.idle();
    expect(task(tasks[0]!.id).status).toBe('APPROVED'); // paused: approved work stays put
    script(developer('SA-1', { 'a.txt': 'a' }), reviewer(), tester(), documenter());
    await t.app.inject({ method: 'POST', url: `/api/projects/${projectId}/pipeline/resume` });
    await t.ctx.orchestrator.idle();
    expect(task(tasks[0]!.id).status).toBe('DONE');
  });

  it('lets you switch a role’s engine while the task runs', async () => {
    script(developer('SA-1', {}, { sleepMs: 1500 }), reviewer(), tester(), documenter());
    const { planId, tasks } = plan(pt('T1', 'A'));
    await approveAll(planId);
    await t.ctx.orchestrator.tick();
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${tasks[0]!.id}`,
      payload: { roleEngines: { reviewer: 'codex' } },
    });
    expect(res.statusCode).toBe(200);
    expect(
      (
        await t.app.inject({
          method: 'PATCH',
          url: `/api/tasks/${tasks[0]!.id}`,
          payload: { title: 'x' },
        })
      ).statusCode,
    ).toBe(409);
    await t.ctx.orchestrator.idle();
    expect(task(tasks[0]!.id).status).toBe('FAILED'); // codex isn't installed in tests
    expect(task(tasks[0]!.id).pipeline.lastError).toMatch(/reviewer failed on OpenAI Codex/);
  });
});

describe('pipeline: merging', () => {
  it('creates a conflict-resolution task when main moved underneath', async () => {
    const commitOnMain = `cd ${repo} && printf 'main side\\n' > shared.txt && git add shared.txt && git ${GIT_ID.join(' ')} commit -qm 'main change'`;
    const resolve = `git ${GIT_ID.join(' ')} merge main -q || true; printf 'resolved\\n' > shared.txt; git add shared.txt; git ${GIT_ID.join(' ')} commit -q --no-edit`;
    script(
      developer('SA-1', { 'shared.txt': 'task side\n' }, { shell: commitOnMain }),
      role('Developer', 'Resolved conflicts.', {
        stdinIncludes: 'You resolve merge conflicts',
        shell: resolve,
      }),
      reviewer(),
      tester(),
      documenter(),
    );
    const { planId, tasks } = plan(pt('T1', 'Shared file'));
    await approveAll(planId);
    await t.ctx.orchestrator.idle();
    const original = task(tasks[0]!.id);
    expect(original.status).toBe('DONE');
    expect(statuses(original.id)).toContain('BLOCKED');
    const follow = t.ctx.tasks.board(projectId).tasks.find((x) => x.origin === 'conflict')!;
    expect(follow).toMatchObject({
      key: 'SA-2',
      title: 'Resolve merge conflicts for SA-1',
      status: 'DONE',
    });
    expect(t.ctx.tasks.history(original.id).at(-1)!.reason).toBe(
      'Merged via SA-2 (conflict resolution)',
    );
    expect(
      agent.calls().find((c) => c.stdin.includes('You resolve merge conflicts'))!.stdin,
    ).toContain('conflict in: shared.txt');
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('resolved\n');
    expect(git(repo, 'branch', '--list', 'af/*')).toBe('');
  });

  it('waits for your review before merging, and handles requested changes', async () => {
    await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { pipeline: { requireHumanReviewBeforeMerge: true } },
    });
    script(
      developer('SA-1', { 'src/a.txt': 'a' }),
      reviewer(),
      tester(),
      documenter(),
      role('Fixer', 'Renamed.', { writeFiles: { 'src/a.txt': 'renamed' } }),
    );
    const { planId, tasks } = plan(pt('T1', 'A'));
    await approveAll(planId);
    await t.ctx.orchestrator.idle();
    const id = tasks[0]!.id;
    expect(task(id)).toMatchObject({
      status: 'NEEDS_HUMAN',
      pipeline: { awaitingMergeReview: true },
    });
    expect(existsSync(join(repo, 'src/a.txt'))).toBe(false);
    await t.app.inject({
      method: 'POST',
      url: `/api/tasks/${id}/request-changes`,
      payload: { comments: 'Please rename the content' },
    });
    await t.ctx.orchestrator.idle();
    expect(agent.calls().find((c) => c.stdin.includes('# Role: Fixer'))!.stdin).toContain(
      'The user reviewed the change and asked for:\nPlease rename the content',
    );
    expect(task(id).status).toBe('NEEDS_HUMAN');
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/tasks/${id}/reviews` }))
        .json()
        .map((r: { reviewer: string }) => r.reviewer),
    ).toEqual(['agent', 'human', 'agent']);
    await t.app.inject({ method: 'POST', url: `/api/tasks/${id}/approve-merge` });
    expect(task(id).status).toBe('DONE');
    expect(readFileSync(join(repo, 'src/a.txt'), 'utf8')).toBe('renamed');
  });

  it('never merges over uncommitted work in your checkout', async () => {
    script(developer('SA-1', { 'src/a.txt': 'a' }), reviewer(), tester(), documenter());
    writeFileSync(join(repo, 'wip.txt'), 'my unsaved work');
    const { planId, tasks } = plan(pt('T1', 'A'));
    await approveAll(planId);
    await t.ctx.orchestrator.idle();
    const id = tasks[0]!.id;
    expect(task(id).status).toBe('NEEDS_HUMAN');
    expect(task(id).statusReason).toMatch(/has uncommitted changes/);
    rmSync(join(repo, 'wip.txt'));
    await t.app.inject({ method: 'POST', url: `/api/tasks/${id}/approve-merge` });
    expect(task(id).status).toBe('DONE');
  });

  it('merges without touching your files when the working branch is not checked out', async () => {
    git(repo, 'checkout', '-q', '-b', 'my-experiment');
    writeFileSync(join(repo, 'scratch.txt'), 'mine');
    script(developer('SA-1', { 'src/a.txt': 'a' }), reviewer(), tester(), documenter());
    const { planId, tasks } = plan(pt('T1', 'A'));
    await approveAll(planId);
    await t.ctx.orchestrator.idle();
    expect(task(tasks[0]!.id).status).toBe('DONE');
    expect(git(repo, 'show', 'main:src/a.txt')).toBe('a');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('my-experiment');
    expect(readFileSync(join(repo, 'scratch.txt'), 'utf8')).toBe('mine');
  });
});

describe('pipeline: restart recovery', () => {
  it('resumes a task at its current step after the daemon restarts', async () => {
    script(developer('SA-1', { 'src/a.txt': 'a' }), reviewer({ sleepMs: 10_000 }));
    const { planId, tasks } = plan(pt('T1', 'A'));
    await approveAll(planId);
    await t.ctx.orchestrator.tick();
    const id = tasks[0]!.id;
    await waitFor(() => task(id).pipeline.activeRole === 'reviewer');
    // Wait until the reviewer's CLI session has started.
    await waitFor(() =>
      t.ctx.db
        .select()
        .from(agentRuns)
        .all()
        .some((r) => r.taskId === id && r.role === 'reviewer' && !!r.sessionId),
    );
    const home = t.home;
    await t.app.close(); // daemon stops mid-review
    // The interrupted review continues its CLI session with a "continue" prompt.
    script(reply(APPROVE, { stdinIncludes: 'an AgentForge restart' }), tester(), documenter());
    await setupApp(home);
    expect(task(id).status).toBe('IN_REVIEW');
    expect(task(id).pipeline.activeRole).toBeNull();
    await t.ctx.orchestrator.idle();
    expect(task(id).status).toBe('DONE');
    expect(t.ctx.db.select().from(documents).all()).toHaveLength(1);
    const resumed = agent.calls().find((c) => c.stdin.includes('an AgentForge restart'))!;
    expect(resumed.args).toContain('--resume');
    expect(t.ctx.orchestrator.checkpointsOf(id)).toEqual([
      expect.objectContaining({ role: 'reviewer', sessionId: expect.any(String) }),
    ]);
  });
});
