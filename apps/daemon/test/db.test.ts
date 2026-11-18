import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client';
import { projects, taskStatusHistory, tasks } from '../src/db/schema';
import { newId } from '../src/lib/id';
import { createTestApp, type TestApp } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => t.cleanup());

describe('database', () => {
  it('creates every table from the data model', () => {
    const names = (
      t.dbHandle.sqlite
        .prepare(
          "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '__drizzle%'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const table of [
      'projects',
      'project_settings',
      'requirements',
      'plans',
      'tasks',
      'task_dependencies',
      'task_status_history',
      'subtasks',
      'agent_runs',
      'run_events',
      'reviews',
      'review_comments',
      'test_results',
      'errors',
      'checkpoints',
      'engines',
      'engine_sessions',
      'usage_records',
      'pms_connections',
      'pms_mappings',
      'mcp_servers',
      'memory_entries',
      'documents',
      'terminal_sessions',
      'settings',
    ]) {
      expect(names, table).toContain(table);
    }
  });

  it('enforces foreign keys and cascades project deletion', () => {
    const { db } = t.ctx;
    expect(() =>
      db
        .insert(tasks)
        .values({ id: newId('tsk'), projectId: 'missing', key: 'AF-1', title: 'x' })
        .run(),
    ).toThrow(/FOREIGN KEY/);
    const pid = newId('prj');
    db.insert(projects)
      .values({
        id: pid,
        name: 'P',
        slug: 'p',
        origin: 'existing',
        source: 'local',
        localPath: '/p',
      })
      .run();
    const tid = newId('tsk');
    db.insert(tasks).values({ id: tid, projectId: pid, key: 'AF-1', title: 'x' }).run();
    db.insert(taskStatusHistory).values({ taskId: tid, toStatus: 'DRAFT' }).run();
    db.delete(projects).where(eq(projects.id, pid)).run();
    expect(db.select().from(tasks).all()).toHaveLength(0);
    expect(db.select().from(taskStatusHistory).all()).toHaveLength(0);
  });

  it('round-trips JSON columns and defaults', () => {
    const { db } = t.ctx;
    const pid = newId('prj');
    db.insert(projects)
      .values({
        id: pid,
        name: 'P',
        slug: 'p',
        origin: 'scratch',
        source: 'local',
        localPath: '/p',
        stack: ['next', 'ts'],
        commands: { run: 'pnpm dev' },
      })
      .run();
    const row = db.select().from(projects).where(eq(projects.id, pid)).get()!;
    expect(row.stack).toEqual(['next', 'ts']);
    expect(row.commands).toEqual({ run: 'pnpm dev' });
    expect(row.runningStatus).toBe('stopped');
    expect(row.createdAt).toBeGreaterThan(0);
  });

  it('is idempotent when reopening (migrations already applied)', () => {
    const again = openDb(t.ctx.config.dbPath);
    expect(again.db.select().from(projects).all()).toEqual([]);
    again.close();
  });
});

describe('newId', () => {
  it('is prefixed, topic-safe and time sortable', async () => {
    const a = newId('tsk');
    await new Promise((r) => setTimeout(r, 2));
    const b = newId('tsk');
    expect(a).toMatch(/^tsk_[0-9a-z]{22}$/);
    expect(a < b).toBe(true);
  });
});
