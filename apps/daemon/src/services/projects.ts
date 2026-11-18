import { ACTIVE_STATUSES, type ProjectSummary } from '@agentforge/shared';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { errors, projects, tasks } from '../db/schema';

export class ProjectService {
  constructor(private readonly db: Db) {}

  /** Dashboard cards: every non-archived project with aggregate counters. */
  listSummaries(): ProjectSummary[] {
    const rows = this.db
      .select()
      .from(projects)
      .where(isNull(projects.archivedAt))
      .orderBy(desc(sql`coalesce(${projects.lastActivityAt}, ${projects.createdAt})`))
      .all();
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const taskAgg = this.db
      .select({
        projectId: tasks.projectId,
        total: sql<number>`count(*)`,
        active: sql<number>`sum(case when ${inArray(tasks.status, [...ACTIVE_STATUSES])} then 1 else 0 end)`,
        done: sql<number>`sum(case when ${tasks.status} = 'DONE' then 1 else 0 end)`,
      })
      .from(tasks)
      .where(and(inArray(tasks.projectId, ids), sql`${tasks.status} <> 'CANCELLED'`))
      .groupBy(tasks.projectId)
      .all();
    const errAgg = this.db
      .select({ projectId: errors.projectId, open: sql<number>`count(*)` })
      .from(errors)
      .where(and(inArray(errors.projectId, ids), eq(errors.status, 'open')))
      .groupBy(errors.projectId)
      .all();
    const taskMap = new Map(taskAgg.map((t) => [t.projectId, t]));
    const errMap = new Map(errAgg.map((e) => [e.projectId, e.open]));

    return rows.map((p) => {
      const t = taskMap.get(p.id);
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        origin: p.origin,
        source: p.source,
        localPath: p.localPath,
        githubRepo: p.githubRepo,
        stack: p.stack,
        runningStatus: p.runningStatus,
        taskCounts: {
          total: Number(t?.total ?? 0),
          active: Number(t?.active ?? 0),
          done: Number(t?.done ?? 0),
        },
        openErrorCount: Number(errMap.get(p.id) ?? 0),
        lastActivityAt: p.lastActivityAt,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    });
  }
}
