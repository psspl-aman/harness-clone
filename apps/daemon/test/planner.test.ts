import type { AnyAppEvent, ChatMessageDto } from '@agentforge/shared';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRuns, memoryEntries, usageRecords } from '../src/db/schema';
import { newId } from '../src/lib/id';
import { claudeStream, FIXTURES, makeFakeCli, type FakeCli, type FakeResponse } from './fake-cli';
import { createTestApp, GIT_ID, tempDir, type TestApp } from './helpers';

let t: TestApp;
let root: string;
let claude: FakeCli;
let projectId: string;
let projectPath: string;
const events: AnyAppEvent[] = [];

const task = (ref: string, dependsOn: string[] = []) => ({
  ref,
  title: `Build ${ref}`,
  description: `Implement ${ref}`,
  type: 'feature',
  priority: 'high',
  complexity: 's',
  acceptanceCriteria: [`${ref} works`],
  affectedAreas: ['src/app.ts'],
  dependsOn,
  subtasks: ['step'],
});
const PLAN = JSON.stringify({
  type: 'plan',
  message: 'A small todo app in two steps.',
  plan: { goal: 'Todo app', scope: 'CRUD todos', risks: ['None'], assumptions: ['Single user'] },
  tasks: [task('T1'), task('T2', ['T1'])],
});
const BASE: FakeResponse[] = [
  { match: '--version', stdout: '2.1.327' },
  {
    match: 'auth status',
    stdout: JSON.stringify({ loggedIn: true, loginExpiresAt: '2099-01-01T00:00:00Z' }),
  },
];
const script = (...runs: FakeResponse[]) => claude.setResponses([...BASE, ...runs]);
const answer = (text: string, extra: Partial<FakeResponse> = {}): FakeResponse => ({
  match: '-p',
  stdout: claudeStream(text),
  once: true,
  ...extra,
});

beforeEach(async () => {
  root = tempDir('af-planner-');
  t = await createTestApp();
  events.length = 0;
  t.ctx.bus.subscribe((e) => events.push(e));
  claude = makeFakeCli(root, 'claude');
  script();
  await t.app.inject({
    method: 'PATCH',
    url: '/api/engines/claude-code',
    payload: { binaryPath: claude.path },
  });
  await t.ctx.engines.refresh('claude-code');
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      mode: 'scratch',
      name: 'Todo App',
      location: { kind: 'local', parentDir: root, folderName: 'todo' },
      stackPreferences: 'Fastify + SQLite',
    },
  });
  projectId = res.json().id;
  projectPath = res.json().localPath;
  await t.ctx.projects.runOnboarding(projectId);
  t.ctx.db
    .insert(memoryEntries)
    .values({
      id: newId('mem'),
      scope: 'project',
      projectId,
      kind: 'decision',
      title: 'Use Zod',
      content: 'Validate every request body with Zod.',
      pinned: true,
    })
    .run();
});
afterEach(async () => {
  await t.cleanup();
  rmSync(root, { recursive: true, force: true });
});

const send = (payload: object) =>
  t.app.inject({ method: 'POST', url: `/api/projects/${projectId}/chat`, payload });
const idle = async () => {
  const end = Date.now() + 10_000;
  while (t.ctx.planner.state(projectId).running) {
    if (Date.now() > end) throw new Error('planner did not finish');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const chat = async (): Promise<ChatMessageDto[]> =>
  (await t.app.inject({ method: 'GET', url: `/api/projects/${projectId}/chat` })).json();
const board = async () =>
  (await t.app.inject({ method: 'GET', url: `/api/projects/${projectId}/board` })).json();
const plannerCalls = () => claude.calls().filter((c) => c.args[0] === '-p');

describe('Planner: generate plan', () => {
  it('turns a requirement into a draft plan with linked tasks', async () => {
    script(answer(`Here is the plan:\n\`\`\`json\n${PLAN}\n\`\`\``));
    const res = await send({ content: 'Build a todo app with tags', intent: 'generate_plan' });
    expect(res.statusCode).toBe(201);
    const userMsg = res.json();
    expect(userMsg).toMatchObject({ author: 'user', intent: 'generate_plan', version: 1 });
    expect(t.ctx.planner.state(projectId).running).toBe(true);
    await idle();

    const b = await board();
    expect(b.plans[0]).toMatchObject({
      version: 1,
      status: 'DRAFT',
      goal: 'Todo app',
      risks: ['None'],
      requirementId: userMsg.id,
    });
    expect(b.tasks.map((x: { key: string; status: string }) => `${x.key}:${x.status}`)).toEqual([
      'TA-1:DRAFT',
      'TA-2:DRAFT',
    ]);
    expect(b.tasks[1].dependsOn).toEqual([b.tasks[0].id]);

    const msgs = await chat();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.producedTaskIds).toHaveLength(2); // traceability
    expect(msgs[1]).toMatchObject({
      author: 'planner',
      kind: 'plan',
      status: 'done',
      planId: b.plans[0].id,
    });
    expect(msgs[1]!.content).toContain('2 tasks ready for your review');

    // Prompt content and read-only permissions.
    const call = plannerCalls()[0]!;
    expect(call.args).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk']));
    expect(call.cwd).toBe(projectPath);
    for (const s of [
      'Build a todo app with tags',
      'Fastify + SQLite',
      'Validate every request body with Zod.',
      'The repository is empty',
      '## Output format',
      '"type": "plan"',
      '"type": "questions"',
    ]) {
      expect(call.stdin).toContain(s);
    }
    // Run is recorded with usage.
    const runs = t.ctx.db.select().from(agentRuns).where(eq(agentRuns.projectId, projectId)).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      role: 'planner',
      status: 'SUCCEEDED',
      engineId: 'claude-code',
      inputTokens: 1000,
      requirementId: userMsg.id,
    });
    expect(
      t.ctx.db.select().from(usageRecords).where(eq(usageRecords.runId, runs[0]!.id)).all(),
    ).toHaveLength(1);
    const detail = (await t.app.inject({ method: 'GET', url: `/api/runs/${runs[0]!.id}` })).json();
    expect(detail.events.map((e: { event: { kind: string } }) => e.event.kind)).toEqual([
      'session',
      'text',
      'usage',
    ]);
    expect(events.some((e) => e.type === 'planner.state')).toBe(true);
  });

  it('feeds validation errors back and retries in the same CLI session', async () => {
    const bad = JSON.stringify({
      type: 'plan',
      plan: { goal: 'x' },
      tasks: [{ ...task('T1'), acceptanceCriteria: [] }],
    });
    script(answer(bad), answer(PLAN));
    await send({ content: 'Build it', intent: 'generate_plan' });
    await idle();
    expect((await board()).tasks).toHaveLength(2);
    const [first, second] = plannerCalls();
    expect(first!.args).not.toContain('--resume');
    expect(second!.args).toEqual(
      expect.arrayContaining(['--resume', '11111111-2222-3333-4444-555555555555']),
    );
    expect(second!.stdin).toContain(
      'tasks.0.acceptanceCriteria: Every task needs at least one acceptance criterion',
    );
    const runs = t.ctx.db.select().from(agentRuns).where(eq(agentRuns.projectId, projectId)).all();
    expect(runs.map((r) => r.attempt).sort()).toEqual([1, 2]);
    expect(runs.find((r) => r.attempt === 1)!.resultSummary).toMatch(/Invalid planner output/);
  });

  it('gives up after three invalid answers without touching the plan', async () => {
    script(answer('not json'), answer('{"type":"plan"}'), answer('still not json'));
    await send({ content: 'Build it', intent: 'generate_plan' });
    await idle();
    const last = (await chat()).at(-1)!;
    expect(last).toMatchObject({ kind: 'error', status: 'failed' });
    expect(last.content).toMatch(/invalid output 3 times/);
    expect((await board()).plans).toHaveLength(0);
  });

  it('asks clarifying questions, then plans without questions when asked to', async () => {
    script(
      answer(
        JSON.stringify({
          type: 'questions',
          message: 'Quick questions:',
          questions: [{ question: 'Web or mobile?', options: ['Web', 'Mobile'] }],
        }),
      ),
    );
    await send({ content: 'Build an app', intent: 'generate_plan' });
    await idle();
    const q = (await chat()).at(-1)!;
    expect(q).toMatchObject({
      kind: 'questions',
      questions: [{ question: 'Web or mobile?', options: ['Web', 'Mobile'] }],
    });

    script(answer(PLAN));
    await send({ content: 'Web', intent: 'generate_plan', skipQuestions: true });
    await idle();
    const prompt = plannerCalls().at(-1)!.stdin;
    expect(prompt).toContain('Do not ask questions');
    expect(prompt).not.toContain('"type": "questions"');
    expect(prompt).toContain('Web or mobile?'); // conversation history
    expect((await board()).tasks).toHaveLength(2);
  });

  it('discusses without creating tasks', async () => {
    script(answer(JSON.stringify({ type: 'reply', message: 'SQLite is fine for a single user.' })));
    await send({ content: 'Is SQLite ok?', intent: 'discuss' });
    await idle();
    expect((await chat()).at(-1)).toMatchObject({
      kind: 'message',
      content: 'SQLite is fine for a single user.',
    });
    expect((await board()).tasks).toHaveLength(0);
  });
});

describe('Planner: wizard requirement', () => {
  it('plans the initial requirement automatically once onboarding finishes', async () => {
    script(answer(PLAN));
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        mode: 'scratch',
        name: 'Wizard App',
        location: { kind: 'local', parentDir: root, folderName: 'wizard' },
        initialRequirement: 'Build a wizard app',
      },
    });
    const id = res.json().id;
    await t.ctx.projects.runOnboarding(id);
    const end = Date.now() + 10_000;
    while (!t.ctx.tasks.latestPlan(id) || t.ctx.planner.state(id).running) {
      if (Date.now() > end) throw new Error('initial plan not created');
      await new Promise((r) => setTimeout(r, 25));
    }
    const msgs = (await t.app.inject({ method: 'GET', url: `/api/projects/${id}/chat` })).json();
    expect(msgs.map((m: { author: string; kind: string }) => `${m.author}:${m.kind}`)).toEqual([
      'user:message',
      'planner:plan',
    ]);
    expect(plannerCalls().at(-1)!.stdin).toContain('Build a wizard app');
    // Re-analysing later never re-plans an already answered requirement.
    await t.ctx.projects.runOnboarding(id);
    expect(t.ctx.planner.state(id).running).toBe(false);
  });
});

describe('Planner: changing plans', () => {
  it('adds tasks to the existing plan, depending on existing keys', async () => {
    script(answer(PLAN));
    await send({ content: 'Build it', intent: 'generate_plan' });
    await idle();
    script(
      answer(
        JSON.stringify({ type: 'tasks', message: 'Added tags.', tasks: [task('T1', ['TA-2'])] }),
      ),
    );
    await send({ content: 'Also add tags', intent: 'add_to_plan' });
    await idle();
    const b = await board();
    expect(b.plans).toHaveLength(1);
    expect(b.tasks.map((x: { key: string }) => x.key)).toEqual(['TA-1', 'TA-2', 'TA-3']);
    expect(b.tasks[2].dependsOn).toEqual([b.tasks[1].id]);
    expect(plannerCalls().at(-1)!.stdin).toContain('- TA-2 [DRAFT]');
    expect((await chat()).at(-1)!.content).toContain('Added TA-3');
  });

  it('regenerates a single task in place and the whole draft plan', async () => {
    script(answer(PLAN));
    await send({ content: 'Build it', intent: 'generate_plan' });
    await idle();
    const [t1, t2] = (await board()).tasks;
    script(
      answer(
        JSON.stringify({
          type: 'task',
          message: 'Narrowed it.',
          task: { ...task('T1', ['TA-1']), title: 'Build the todo API only' },
        }),
      ),
    );
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/tasks/${t2.id}/regenerate`,
          payload: { instructions: 'API only' },
        })
      ).statusCode,
    ).toBe(202);
    await idle();
    const regen = (await board()).tasks.find((x: { id: string }) => x.id === t2.id);
    expect(regen).toMatchObject({
      key: 'TA-2',
      title: 'Build the todo API only',
      dependsOn: [t1.id],
    });
    expect(plannerCalls().at(-1)!.stdin).toContain('Extra instructions from the user: API only');

    const planId = (await board()).plans[0].id;
    script(
      answer(
        JSON.stringify({
          type: 'plan',
          message: 'Smaller.',
          plan: { goal: 'Tiny todo' },
          tasks: [task('T1')],
        }),
      ),
    );
    await t.app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/regenerate`,
      payload: { instructions: 'One task' },
    });
    await idle();
    const b = await board();
    expect(b.plans).toMatchObject([{ version: 2, goal: 'Tiny todo' }]);
    expect(b.tasks.map((x: { key: string }) => x.key)).toEqual(['TA-3']);
  });
});

describe('Planner: failures, concurrency, cancel', () => {
  it('explains engine failures such as usage limits', async () => {
    script({
      match: '-p',
      stdoutFile: join(FIXTURES, 'claude-limit.jsonl'),
      exitCode: 1,
      once: true,
    });
    await send({ content: 'Build it', intent: 'generate_plan' });
    await idle();
    const last = (await chat()).at(-1)!;
    expect(last).toMatchObject({ kind: 'error', status: 'failed' });
    expect(last.content).toMatch(/Claude Code hit its usage limit/);
    expect(t.ctx.engines.get('claude-code').authStatus).toBe('QUOTA_EXHAUSTED');
  });

  it('allows one planner run per project and can cancel it', async () => {
    script(answer(PLAN, { sleepMs: 5000 }));
    await send({ content: 'Build it', intent: 'generate_plan' });
    expect((await send({ content: 'And this', intent: 'generate_plan' })).statusCode).toBe(409);
    await new Promise((r) => setTimeout(r, 200));
    expect(
      (await t.app.inject({ method: 'POST', url: `/api/projects/${projectId}/planner/cancel` }))
        .statusCode,
    ).toBe(202);
    await idle();
    expect((await chat()).at(-1)).toMatchObject({
      kind: 'error',
      status: 'cancelled',
      content: 'Planning cancelled.',
    });
    expect(
      (await t.app.inject({ method: 'POST', url: `/api/projects/${projectId}/planner/cancel` }))
        .statusCode,
    ).toBe(404);
  });

  it('reports a missing planner engine clearly', async () => {
    await t.app.inject({
      method: 'PATCH',
      url: '/api/engines/claude-code',
      payload: { binaryPath: join(root, 'nope') },
    });
    await t.ctx.engines.refresh('claude-code');
    await send({ content: 'Build it', intent: 'generate_plan' });
    await idle();
    expect((await chat()).at(-1)!.content).toMatch(
      /Claude Code \(the Planner engine\) is not installed/,
    );
  });
});

describe('references, attachments and edits', () => {
  it('extracts @file and #task references and passes attachments to the planner', async () => {
    writeFileSync(join(projectPath, 'notes.md'), '# notes');
    execFileSync('git', [...GIT_ID, 'add', 'notes.md'], { cwd: projectPath });
    script(answer(PLAN));
    await send({ content: 'Build it', intent: 'generate_plan' });
    await idle();

    const sug = (
      await t.app.inject({ method: 'GET', url: `/api/projects/${projectId}/references?q=not` })
    ).json();
    expect(sug.files).toContain('notes.md');
    expect(
      (
        await t.app.inject({ method: 'GET', url: `/api/projects/${projectId}/references?q=TA-2` })
      ).json().tasks,
    ).toMatchObject([{ key: 'TA-2' }]);

    const boundary = '----af';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="spec sheet.txt"\r\nContent-Type: text/plain\r\n\r\nMust support dark mode\r\n--${boundary}--\r\n`;
    const up = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/attachments`,
      payload: body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(up.statusCode).toBe(201);
    const [att] = up.json();
    expect(att).toMatchObject({ name: 'spec sheet.txt', mime: 'text/plain', size: 22 });
    expect(att.path.startsWith(join(projectPath, '.agentforge/attachments'))).toBe(true);
    expect(readFileSync(join(projectPath, '.git/info/exclude'), 'utf8')).toContain('.agentforge/');
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: projectPath, encoding: 'utf8' }),
    ).not.toContain('.agentforge');

    script(answer(JSON.stringify({ type: 'tasks', message: 'ok', tasks: [task('T1')] })));
    const msg = (
      await send({
        content: 'See @notes.md and #ta-2, ignore @missing.ts',
        intent: 'add_to_plan',
        attachmentIds: [att.id],
      })
    ).json();
    expect(msg.references).toEqual({ files: ['notes.md'], tasks: ['TA-2'] });
    expect(msg.attachments).toMatchObject([{ id: att.id, name: 'spec sheet.txt' }]);
    await idle();
    const prompt = plannerCalls().at(-1)!.stdin;
    expect(prompt).toContain('## Files the user referenced (read them)\n- notes.md');
    expect(prompt).toContain('- TA-2 [DRAFT] Build T2');
    expect(prompt).toContain(att.path);
    expect(
      (await send({ content: 'x', intent: 'discuss', attachmentIds: ['att_missing'] })).statusCode,
    ).toBe(400);
  });

  it('versions edited requirements', async () => {
    script(answer(PLAN), answer(PLAN));
    const first = (await send({ content: 'Build todos', intent: 'generate_plan' })).json();
    await idle();
    const second = (
      await send({
        content: 'Build todos with due dates',
        intent: 'generate_plan',
        supersedesId: first.id,
      })
    ).json();
    expect(second).toMatchObject({ version: 2, supersedesId: first.id });
    await idle();
    const msgs = await chat();
    expect(msgs.find((m) => m.id === first.id)!.supersededBy).toBe(second.id);
    expect((await board()).plans).toMatchObject([{ version: 2 }]);
    expect(existsSync(projectPath)).toBe(true);
  });
});
