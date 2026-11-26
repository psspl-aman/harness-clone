import type { PlannerTask } from '@ai-harness/shared';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { projects } from '../src/db/schema';
import { claudeStream, makeFakeCli, type FakeResponse } from './fake-cli';
import { createTestApp, tempDir, type TestApp } from './helpers';

const TOKEN = 'ghp_prtesttoken_0123456789abcdef'; // gforge:allow — fake test token
let t: TestApp;
let root: string;
const pulls: { head: string; base: string; title: string; body: string }[] = [];

const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  if (url.pathname === '/user')
    return json(200, { login: 'octo', name: null, avatar_url: null }, { 'x-oauth-scopes': 'repo' });
  if (url.pathname === '/repos/octo/shop/pulls' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body));
    pulls.push(body);
    return json(201, {
      html_url: `https://github.com/octo/shop/pull/${pulls.length}`,
      number: pulls.length,
    });
  }
  return json(404, { message: 'Not Found' });
};

const pt = (ref: string, title: string, dependsOn: string[] = []): PlannerTask => ({
  ref,
  title,
  description: title,
  type: 'feature',
  priority: 'medium',
  complexity: 's',
  acceptanceCriteria: ['works'],
  affectedAreas: [],
  dependsOn,
  subtasks: [],
  suggestedEngines: {},
});
const role = (name: string, text: string, extra: Partial<FakeResponse> = {}): FakeResponse => ({
  match: '-p',
  stdout: claudeStream(text),
  stdinIncludes: `# Role: ${name}`,
  ...extra,
});

beforeEach(async () => {
  root = tempDir('af-pr-');
  pulls.length = 0;
  const remotes = join(root, 'remotes');
  t = await createTestApp(
    {},
    {
      orchestrator: { autoStart: false },
      github: {
        fetch: fetchFake as typeof fetch,
        baseUrl: 'https://api.github.test',
        cloneUrlFor: (n) => join(remotes, `${n}.git`),
      },
    },
  );
  const agent = makeFakeCli(root, 'claude');
  agent.setResponses([
    { match: '--version', stdout: '2.1.327' },
    {
      match: 'auth status',
      stdout: JSON.stringify({ loggedIn: true, loginExpiresAt: '2099-01-01T00:00:00Z' }),
    },
    role('Developer', 'Built A.', {
      stdinIncludes: ['# Role: Developer', 'Task SHO-1:'],
      writeFiles: { 'src/a.txt': 'a' },
    }),
    // SHO-2 must see SHO-1's unmerged PR branch in its worktree.
    role('Developer', 'Built B.', {
      stdinIncludes: ['# Role: Developer', 'Task SHO-2:'],
      shell: 'test -f src/a.txt',
      writeFiles: { 'src/b.txt': 'b' },
    }),
    role('Reviewer', JSON.stringify({ verdict: 'APPROVE', summary: 'ok', comments: [] })),
    role('Tester', JSON.stringify({ passed: true, summary: 'ok' })),
    role('Documenter', JSON.stringify({ summary: 'Delivered.', report: 'Report body.' })),
  ]);
  await t.app.inject({
    method: 'PATCH',
    url: '/api/engines/claude-code',
    payload: { binaryPath: agent.path },
  });
  await t.ctx.engines.refresh('claude-code');
  await t.app.inject({ method: 'POST', url: '/api/github/connect', payload: { token: TOKEN } });
  await t.app.inject({
    method: 'PATCH',
    url: '/api/settings',
    payload: { pipeline: { mergeStrategy: 'pull_request' } },
  });
});
afterEach(async () => {
  await t.cleanup();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// Windows: a multi-task pipeline that spawns many engine CLIs through cmd.exe shims exceeds the
// test budget (each spawn carries cmd.exe cold-start cost). The daemon runs it fine. Runs on POSIX.
it.skipIf(process.platform === 'win32')('opens a pull request per task and stacks dependent work on unmerged branches', async () => {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      mode: 'scratch',
      name: 'Shop',
      location: { kind: 'local', parentDir: root, folderName: 'shop' },
    },
  });
  const { id: projectId, localPath } = res.json();
  await t.ctx.projects.runOnboarding(projectId);
  mkdirSync(join(root, 'remotes/octo'), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', localPath, join(root, 'remotes/octo/shop.git')]);
  t.ctx.db
    .update(projects)
    .set({ source: 'github', githubRepo: 'octo/shop' })
    .where(eq(projects.id, projectId))
    .run();

  const plan = t.ctx.tasks.createPlan(projectId, null, {
    goal: 'g',
    scope: '',
    outOfScope: '',
    architectureNotes: '',
    risks: [],
    assumptions: [],
  });
  const [a, b] = t.ctx.tasks.createFromPlanner(projectId, plan.id, null, [
    pt('T1', 'Feature A'),
    pt('T2', 'Feature B', ['T1']),
  ]);
  await t.app.inject({ method: 'POST', url: `/api/plans/${plan.id}/approve`, payload: {} });
  await t.ctx.orchestrator.idle();

  expect(t.ctx.tasks.get(a!.id)).toMatchObject({
    status: 'DONE',
    pipeline: { pullRequestUrl: 'https://github.com/octo/shop/pull/1' },
  });
  expect(t.ctx.tasks.get(b!.id)).toMatchObject({
    status: 'DONE',
    pipeline: { pullRequestUrl: 'https://github.com/octo/shop/pull/2' },
  });
  expect(pulls[0]).toMatchObject({
    base: 'main',
    head: 'af/sho-1-feature-a',
    title: 'SHO-1: Feature A',
  });
  expect(pulls[0]!.body).toContain('# SHO-1: Feature A');
  const remoteBranches = execFileSync('git', ['branch', '--list'], {
    cwd: join(root, 'remotes/octo/shop.git'),
    encoding: 'utf8',
  });
  expect(remoteBranches).toContain('af/sho-1-feature-a');
  expect(remoteBranches).toContain('af/sho-2-feature-b');
  // Nothing was merged locally: main is untouched in PR mode.
  expect(
    execFileSync('git', ['log', '--oneline', 'main'], { cwd: localPath, encoding: 'utf8' })
      .trim()
      .split('\n'),
  ).toHaveLength(1);
});
