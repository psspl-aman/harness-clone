import type { MemoryEntryDto } from '@agentforge/shared';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { documents } from '../src/db/schema';
import { newId } from '../src/lib/id';
import { terms } from '../src/services/memory';
import { createTestApp, tempDir, type TestApp } from './helpers';

let t: TestApp;
let root: string;
let projectId: string;
let repo: string;

beforeEach(async () => {
  root = tempDir('af-mem-');
  t = await createTestApp({}, { orchestrator: { autoStart: false } });
  const p = await t.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      mode: 'scratch',
      name: 'Shop',
      location: { kind: 'local', parentDir: root, folderName: 'shop' },
    },
  });
  projectId = p.json().id;
  repo = p.json().localPath;
  await t.ctx.projects.runOnboarding(projectId);
});
afterEach(async () => {
  await t.cleanup();
  rmSync(root, { recursive: true, force: true });
});

const add = async (payload: object, global = false): Promise<MemoryEntryDto> => {
  const r = await t.app.inject({
    method: 'POST',
    url: global ? '/api/memory' : `/api/projects/${projectId}/memory`,
    payload,
  });
  expect(r.statusCode).toBe(201);
  return r.json();
};
const list = async (q = '') =>
  (await t.app.inject({ url: `/api/projects/${projectId}/memory${q}` })).json() as MemoryEntryDto[];
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('memory', () => {
  it('creates, searches, filters, pins, edits and deletes entries', async () => {
    const a = await add({
      kind: 'decision',
      title: 'Payments via Stripe',
      content: 'Use Stripe Checkout; webhooks verify signatures.',
      tags: ['payments'],
    });
    await add({
      kind: 'pitfall',
      title: 'Flaky e2e on CI',
      content: 'Wait for the network to be idle.',
    });
    expect(a).toMatchObject({ scope: 'project', projectId, source: 'user', pinned: false });

    expect((await list('?search=webhook')).map((m) => m.title)).toEqual(['Payments via Stripe']);
    expect((await list('?search=payments')).length).toBe(1); // tags are searched
    expect((await list('?kind=pitfall')).map((m) => m.title)).toEqual(['Flaky e2e on CI']);

    const pinned = (
      await t.app.inject({
        method: 'PATCH',
        url: `/api/memory/${a.id}`,
        payload: { pinned: true, content: 'Stripe Checkout only.' },
      })
    ).json();
    expect(pinned).toMatchObject({ pinned: true, content: 'Stripe Checkout only.' });
    expect((await list('?scope=project'))[0]!.id).toBe(a.id); // pinned first

    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/memory`,
          payload: { kind: 'nope', title: '', content: '' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/memory/${a.id}` })).statusCode).toBe(
      204,
    );
    expect((await list('?search=stripe')).length).toBe(0);
  });

  it('keeps global preferences separate from project memory', async () => {
    await add(
      {
        kind: 'preference',
        title: 'Functional components',
        content: 'Prefer function components and hooks.',
      },
      true,
    );
    const global = (await t.app.inject({ url: '/api/memory' })).json();
    expect(global).toHaveLength(1);
    expect(global[0]).toMatchObject({ scope: 'global', projectId: null });
    expect((await list()).some((m) => m.scope === 'global')).toBe(false);
  });

  it('selects relevant memory for a prompt within the budget', async () => {
    expect([...terms('Adding Stripe refunds to the payments API')]).toEqual([
      'stripe',
      'refund',
      'payment',
      'api',
    ]);
    await add({
      kind: 'decision',
      title: 'Payments via Stripe',
      content: 'Stripe Checkout; refunds go through the Refund API.',
    });
    await add({
      kind: 'decision',
      title: 'Auth uses JWT cookies',
      content: 'Sessions live in httpOnly cookies.',
    });
    await add({ kind: 'convention', title: 'Package manager', content: 'Use pnpm.' });
    await add(
      { kind: 'preference', title: 'Functional components', content: 'Prefer hooks.' },
      true,
    );

    const picked = t.ctx.memory
      .forPrompt(projectId, 'Add a Stripe refund endpoint', 10_000)
      .map((m) => m.title);
    expect(picked).toContain('Payments via Stripe');
    expect(picked).toContain('Package manager');
    expect(picked).toContain('Functional components (your preference)');
    expect(picked).not.toContain('Auth uses JWT cookies');

    // A tight budget keeps the highest-ranked entries only.
    const tight = t.ctx.memory
      .forPrompt(projectId, 'Add a Stripe refund endpoint', 50)
      .map((m) => m.title);
    expect(tight).toEqual(['Functional components (your preference)']);
  });

  it('mirrors project memory to .agentforge/memory.md, kept out of git', async () => {
    await add({
      kind: 'decision',
      title: 'Payments via Stripe',
      content: 'Stripe Checkout only.',
      pinned: true,
    });
    const file = join(repo, '.agentforge', 'memory.md');
    await until(
      () => existsSync(file) && readFileSync(file, 'utf8').includes('Payments via Stripe'),
    );
    const md = readFileSync(file, 'utf8');
    expect(md).toContain('# Project memory — Shop');
    expect(md).toContain('## Decision');
    expect(md).toContain('### 📌 Payments via Stripe');
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.agentforge/');

    await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { memory: { mirrorFile: false } },
    });
    t.ctx.memory.writeMirror(projectId);
    expect(existsSync(file)).toBe(false);
  });
});

describe('docs', () => {
  it('lists repo Markdown and task reports, reads and exports them', async () => {
    writeFileSync(join(repo, 'README.md'), '# Shop\n\nAn online shop.\n');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'architecture.md'), '# Architecture\n\n## Layers\n');
    writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n');
    const task = t.ctx.tasks.createFollowUp(projectId, null, {
      title: 'Cart',
      description: 'x',
      type: 'feature',
      priority: 'low',
      acceptanceCriteria: [],
      roleEngines: {},
      origin: 'error',
      pipelineState: {},
    });
    t.ctx.db
      .insert(documents)
      .values({
        id: newId('doc'),
        projectId,
        taskId: task.id,
        kind: 'task_report',
        title: `${task.key}: Cart`,
        content: `# ${task.key}: Cart\n\nAdded a cart.\n\n## Files changed\n- cart.ts`,
      })
      .run();

    const docs = (await t.app.inject({ url: `/api/projects/${projectId}/docs` })).json();
    expect(docs.map((d: { kind: string; title: string }) => [d.kind, d.title])).toEqual([
      ['readme', 'README.md'],
      ['changelog', 'CHANGELOG.md'],
      ['architecture', 'docs/architecture.md'],
      ['task_report', `${task.key}: Cart`],
    ]);
    const report = docs[3];
    expect(report.taskKey).toBe(task.key);

    const readme = (
      await t.app.inject({
        url: `/api/projects/${projectId}/docs/item?doc=${encodeURIComponent('file:README.md')}`,
      })
    ).json();
    expect(readme).toMatchObject({ kind: 'readme', content: '# Shop\n\nAn online shop.\n' });
    expect(
      (
        await t.app.inject({
          url: `/api/projects/${projectId}/docs/item?doc=${encodeURIComponent('file:.env')}`,
        })
      ).statusCode,
    ).toBe(400);

    const dl = await t.app.inject({
      url: `/api/projects/${projectId}/docs/item?doc=${report.id}&download=1`,
    });
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="${task.key}-report.md"`);
    expect(dl.body).toContain('Added a cart.');

    const all = await t.app.inject({ url: `/api/projects/${projectId}/docs/export` });
    expect(all.headers['content-type']).toMatch(/text\/markdown/);
    expect(all.headers['content-disposition']).toBe('attachment; filename="shop-docs.md"');
    expect(all.body).toMatch(/^# Shop — documentation/);
    expect(all.body).toContain('## README.md\n\n## Shop\n\nAn online shop.');
    expect(all.body).toContain(
      `## ${task.key}: Cart\n\n## ${task.key}: Cart\n\nAdded a cart.\n\n### Files changed`,
    );
  });
});
