import type { PlannerTask } from '@agentforge/shared';
import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tasks as tasksTable } from '../src/db/schema';
import { createTestApp, installFakeEngine, tempDir, type TestApp } from './helpers';

let t: TestApp;
let root: string;
let projectId: string;

const pt = (
  ref: string,
  dependsOn: string[] = [],
  extra: Partial<PlannerTask> = {},
): PlannerTask => ({
  ref,
  title: `Task ${ref}`,
  description: `Describe ${ref}`,
  type: 'feature',
  priority: 'medium',
  complexity: 'm',
  acceptanceCriteria: [`${ref} works`],
  affectedAreas: [`src/${ref}.ts`],
  dependsOn,
  subtasks: [`${ref} step a`, `${ref} step b`],
  suggestedEngines: {},
  ...extra,
});

beforeEach(async () => {
  t = await createTestApp();
  root = tempDir();
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      mode: 'scratch',
      name: 'Todo App',
      location: { kind: 'local', parentDir: root, folderName: 'todo' },
    },
  });
  projectId = res.json().id;
  await t.ctx.projects.runOnboarding(projectId);
});
afterEach(async () => {
  await t.cleanup();
  rmSync(root, { recursive: true, force: true });
});

const seed = () => {
  const plan = t.ctx.tasks.createPlan(projectId, null, {
    goal: 'Ship todos',
    scope: '',
    outOfScope: '',
    architectureNotes: '',
    risks: [],
    assumptions: [],
  });
  const created = t.ctx.tasks.createFromPlanner(projectId, plan.id, null, [
    pt('T1'),
    pt('T2', ['T1']),
    pt('T3', ['T1', 'T2']),
  ]);
  return { plan, created };
};
const api = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url, payload });

describe('plans and tasks', () => {
  it('creates planner tasks with keys, resolved dependencies, subtasks and history', async () => {
    const { plan, created } = seed();
    expect(created.map((c) => c.key)).toEqual(['TA-1', 'TA-2', 'TA-3']);
    expect(created[2]!.dependsOn).toEqual(expect.arrayContaining([created[0]!.id, created[1]!.id]));
    expect(created[0]!.subtasks.map((s) => s.title)).toEqual(['T1 step a', 'T1 step b']);
    const board = (await api('GET', `/api/projects/${projectId}/board`)).json();
    expect(board.plans).toHaveLength(1);
    expect(board.plans[0]).toMatchObject({
      id: plan.id,
      version: 1,
      status: 'DRAFT',
      goal: 'Ship todos',
    });
    expect(board.tasks.map((x: { status: string }) => x.status)).toEqual([
      'DRAFT',
      'DRAFT',
      'DRAFT',
    ]);
    expect((await api('GET', `/api/tasks/${created[0]!.id}/history`)).json()).toMatchObject([
      { from: null, to: 'DRAFT', actor: 'planner' },
    ]);
    // Dependencies on existing keys work across batches.
    const more = t.ctx.tasks.createFromPlanner(projectId, plan.id, null, [
      pt('X', ['TA-3', 'ta-1']),
    ]);
    expect(more[0]!.key).toBe('TA-4');
    expect(more[0]!.dependsOn.sort()).toEqual([created[0]!.id, created[2]!.id].sort());
  });

  it('edits tasks and plans, validating input', async () => {
    const { plan, created } = seed();
    // Only installed engines can be assigned.
    const refused = await api('PATCH', `/api/tasks/${created[0]!.id}`, {
      roleEngines: { developer: 'gemini-cli' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toMatch(/Gemini CLI isn’t installed/);
    await installFakeEngine(t, 'codex');
    const res = await api('PATCH', `/api/tasks/${created[0]!.id}`, {
      title: 'Set up the API',
      priority: 'high',
      acceptanceCriteria: ['GET /todos returns []'],
      roleEngines: { developer: 'codex' },
    });
    expect(res.json()).toMatchObject({
      title: 'Set up the API',
      priority: 'high',
      roleEngines: { developer: 'codex' },
    });
    expect(
      (await api('PATCH', `/api/tasks/${created[0]!.id}`, { status: 'DONE' })).statusCode,
    ).toBe(400);
    expect(
      (await api('PATCH', `/api/tasks/${created[0]!.id}`, { priority: 'urgent' })).statusCode,
    ).toBe(400);
    expect(
      (
        await api('PATCH', `/api/plans/${plan.id}`, { risks: ['Scope creep'], scope: 'MVP only' })
      ).json(),
    ).toMatchObject({ risks: ['Scope creep'], scope: 'MVP only' });
  });

  it('sets dependencies and rejects cycles and cross-project links', async () => {
    const { created } = seed();
    const [a, b, c] = created as [(typeof created)[0], (typeof created)[0], (typeof created)[0]];
    const cyc = await api('PUT', `/api/tasks/${a.id}/dependencies`, { dependsOn: [c.id] });
    expect(cyc.statusCode).toBe(400);
    expect(cyc.json().error.message).toMatch(/cycle: TA-1 → TA-3 → TA-1|cycle/);
    expect(
      (await api('PUT', `/api/tasks/${a.id}/dependencies`, { dependsOn: [a.id] })).statusCode,
    ).toBe(400);
    expect(
      (await api('PUT', `/api/tasks/${a.id}/dependencies`, { dependsOn: ['tsk_nope'] })).statusCode,
    ).toBe(400);
    expect(
      (await api('PUT', `/api/tasks/${c.id}/dependencies`, { dependsOn: [b.id] })).json().dependsOn,
    ).toEqual([b.id]);
  });

  it('splits a task: parts inherit dependencies and dependents wait for all parts', async () => {
    const { created } = seed();
    const [, b, c] = created as [(typeof created)[0], (typeof created)[0], (typeof created)[0]];
    const parts = (
      await api('POST', `/api/tasks/${b.id}/split`, {
        parts: [{ title: 'Model' }, { title: 'Routes', description: 'CRUD routes' }],
      })
    ).json();
    expect(parts.map((p: { title: string }) => p.title)).toEqual(['Model', 'Routes']);
    expect(parts[1]).toMatchObject({
      key: 'TA-4',
      description: 'CRUD routes',
      dependsOn: b.dependsOn,
    });
    const after = (await api('GET', `/api/tasks/${c.id}`)).json();
    expect(after.dependsOn).toEqual(expect.arrayContaining([b.id, parts[1].id]));
    const order = (await api('GET', `/api/projects/${projectId}/board`))
      .json()
      .tasks.map((x: { key: string }) => x.key);
    expect(order).toEqual(['TA-1', 'TA-2', 'TA-4', 'TA-3']);
  });

  it('merges tasks, combining content and re-pointing dependents', async () => {
    const { created } = seed();
    const [a, b, c] = created as [(typeof created)[0], (typeof created)[0], (typeof created)[0]];
    const extra = t.ctx.tasks.createFromPlanner(projectId, created[0]!.planId!, null, [
      pt('D', ['TA-2']),
    ])[0]!;
    const merged = (
      await api('POST', '/api/tasks/merge', { taskIds: [b.id, c.id], title: 'Model + routes' })
    ).json();
    expect(merged).toMatchObject({ id: b.id, title: 'Model + routes', dependsOn: [a.id] });
    expect(merged.description).toContain('### Task T2');
    expect(merged.acceptanceCriteria).toEqual(['T2 works', 'T3 works']);
    expect(merged.subtasks).toHaveLength(4);
    expect((await api('GET', `/api/tasks/${c.id}`)).statusCode).toBe(404);
    expect((await api('GET', `/api/tasks/${extra.id}`)).json().dependsOn).toEqual([b.id]);
  });

  it('approves all or individually, tracks plan status and history', async () => {
    const { plan, created } = seed();
    expect((await api('POST', `/api/tasks/${created[0]!.id}/approve`)).json().status).toBe(
      'APPROVED',
    );
    expect((await api('GET', `/api/projects/${projectId}/board`)).json().plans[0].status).toBe(
      'DRAFT',
    );
    const board = (await api('POST', `/api/plans/${plan.id}/approve`, {})).json();
    expect(board.tasks.every((x: { status: string }) => x.status === 'APPROVED')).toBe(true);
    expect(board.plans[0]).toMatchObject({ status: 'APPROVED' });
    expect(board.plans[0].approvedAt).toBeGreaterThan(0);
    expect((await api('POST', `/api/tasks/${created[1]!.id}/unapprove`)).json().status).toBe(
      'DRAFT',
    );
    expect((await api('GET', `/api/projects/${projectId}/board`)).json().plans[0].status).toBe(
      'DRAFT',
    );
    const history = (await api('GET', `/api/tasks/${created[1]!.id}/history`)).json();
    expect(history.map((h: { to: string }) => h.to)).toEqual(['DRAFT', 'APPROVED', 'DRAFT']);
    expect((await api('POST', `/api/tasks/${created[0]!.id}/approve`)).statusCode).toBe(409); // already approved
  });

  it('a new plan supersedes a draft plan, but approved plans and tasks stay', async () => {
    const { plan, created } = seed();
    await api('POST', `/api/tasks/${created[0]!.id}/approve`);
    const p2 = t.ctx.tasks.createPlan(projectId, null, {
      goal: 'v2',
      scope: '',
      outOfScope: '',
      architectureNotes: '',
      risks: [],
      assumptions: [],
    });
    expect(p2.version).toBe(2);
    const board = (await api('GET', `/api/projects/${projectId}/board`)).json();
    expect(board.plans.map((p: { id: string }) => p.id)).toEqual([p2.id]);
    expect(board.tasks.map((x: { key: string }) => x.key)).toEqual(['TA-1']); // approved task kept, drafts dropped
    expect(t.ctx.tasks.plan(plan.id).status).toBe('SUPERSEDED');
  });

  it('adds manual tasks, reorders, edits subtasks and deletes drafts', async () => {
    const { plan, created } = seed();
    const manual = (
      await api('POST', `/api/plans/${plan.id}/tasks`, {
        title: 'Write README',
        type: 'docs',
        dependsOn: [created[2]!.id],
        subtasks: ['Install section'],
      })
    ).json();
    expect(manual).toMatchObject({
      key: 'TA-4',
      origin: 'manual',
      type: 'docs',
      dependsOn: [created[2]!.id],
    });
    const order = [manual.id, ...created.map((c) => c.id)];
    await api('POST', `/api/projects/${projectId}/tasks/reorder`, { taskIds: order });
    expect(
      (await api('GET', `/api/projects/${projectId}/board`))
        .json()
        .tasks.map((x: { id: string }) => x.id),
    ).toEqual(order);
    const withSub = (
      await api('POST', `/api/tasks/${manual.id}/subtasks`, { title: 'Usage section' })
    ).json();
    expect(withSub.subtasks.map((s: { title: string }) => s.title)).toEqual([
      'Install section',
      'Usage section',
    ]);
    const toggled = (
      await api('PATCH', `/api/subtasks/${withSub.subtasks[0].id}`, { done: true })
    ).json();
    expect(toggled.subtasks[0].done).toBe(true);
    expect(
      (await api('DELETE', `/api/subtasks/${withSub.subtasks[1].id}`)).json().subtasks,
    ).toHaveLength(1);
    expect((await api('DELETE', `/api/tasks/${created[2]!.id}`)).statusCode).toBe(204);
    expect((await api('GET', `/api/tasks/${manual.id}`)).json().dependsOn).toEqual([]);
  });

  it('refuses to edit or delete tasks an agent is working on', async () => {
    const { created } = seed();
    t.ctx.db
      .update(tasksTable)
      .set({ status: 'IN_DEVELOPMENT' })
      .where(eq(tasksTable.id, created[0]!.id))
      .run();
    expect((await api('PATCH', `/api/tasks/${created[0]!.id}`, { title: 'x' })).statusCode).toBe(
      409,
    );
    expect((await api('DELETE', `/api/tasks/${created[0]!.id}`)).statusCode).toBe(409);
  });
});
