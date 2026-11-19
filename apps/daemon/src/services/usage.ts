import type { UsageBucket, UsageSummaryDto, UsageWindowStatusDto } from '@agentforge/shared';
import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { projects, tasks, usageRecords } from '../db/schema';
import type { EngineRegistry } from '../engines/registry';

const TOKENS = sql<number>`sum(${usageRecords.inputTokens} + ${usageRecords.outputTokens} + ${usageRecords.cacheReadTokens} + ${usageRecords.cacheWriteTokens})`;
const COST = sql<number>`sum(${usageRecords.costUsd})`;
const RUNS = sql<number>`count(*)`;

export interface UsageQuery {
  from?: number;
  to?: number;
  projectId?: string;
  engineId?: string;
}

/** Token / cost analytics over `usage_records` (one row per agent run). */
export class UsageService {
  constructor(
    private readonly db: Db,
    private readonly engines: EngineRegistry,
  ) {}

  summary(q: UsageQuery): UsageSummaryDto {
    const to = q.to ?? Date.now();
    const from = q.from ?? to - 30 * 86_400_000;
    const where = and(
      gte(usageRecords.recordedAt, from),
      lte(usageRecords.recordedAt, to),
      q.projectId ? eq(usageRecords.projectId, q.projectId) : undefined,
      q.engineId ? eq(usageRecords.engineId, q.engineId) : undefined,
    );
    const t = this.db
      .select({
        runs: RUNS,
        input: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`,
        output: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`,
        cacheRead: sql<number>`coalesce(sum(${usageRecords.cacheReadTokens}), 0)`,
        cacheWrite: sql<number>`coalesce(sum(${usageRecords.cacheWriteTokens}), 0)`,
        cost: sql<number>`coalesce(sum(${usageRecords.costUsd}), 0)`,
        estimated: sql<number>`coalesce(sum(case when ${usageRecords.costSource} = 'estimated' then ${usageRecords.costUsd} else 0 end), 0)`,
        unpriced: sql<number>`coalesce(sum(case when ${usageRecords.costSource} = 'none' and ${usageRecords.costUsd} = 0 then 1 else 0 end), 0)`,
        duration: sql<number>`coalesce(sum(${usageRecords.durationMs}), 0)`,
      })
      .from(usageRecords)
      .where(where)
      .get()!;

    const group = (
      key: SQL<string | null>,
      label?: SQL<string | null>,
      order: 'cost' | 'key' = 'cost',
    ): UsageBucket[] =>
      this.db
        .select({ key, label: label ?? key, runs: RUNS, tokens: TOKENS, cost: COST })
        .from(usageRecords)
        .leftJoin(projects, eq(projects.id, usageRecords.projectId))
        .leftJoin(tasks, eq(tasks.id, usageRecords.taskId))
        .where(where)
        .groupBy(key)
        .orderBy(order === 'key' ? key : sql`sum(${usageRecords.costUsd}) desc, ${TOKENS} desc`)
        .all()
        .map((r) => ({
          key: r.key ?? 'none',
          label: r.label ?? r.key ?? '—',
          runs: Number(r.runs),
          tokens: Number(r.tokens ?? 0),
          costUsd: Number(r.cost ?? 0),
        }));

    const day = sql<string>`strftime('%Y-%m-%d', ${usageRecords.recordedAt} / 1000, 'unixepoch', 'localtime')`;
    const week = sql<string>`strftime('%Y-W%W', ${usageRecords.recordedAt} / 1000, 'unixepoch', 'localtime')`;
    const top = this.db
      .select({
        key: usageRecords.taskId,
        taskKey: tasks.key,
        title: tasks.title,
        projectId: usageRecords.projectId,
        runs: RUNS,
        tokens: TOKENS,
        cost: COST,
      })
      .from(usageRecords)
      .innerJoin(tasks, eq(tasks.id, usageRecords.taskId))
      .where(where)
      .groupBy(usageRecords.taskId)
      .orderBy(sql`sum(${usageRecords.costUsd}) desc, ${TOKENS} desc`)
      .limit(10)
      .all();
    const perTask = this.db
      .select({ type: tasks.type, taskId: usageRecords.taskId, tokens: TOKENS, cost: COST })
      .from(usageRecords)
      .innerJoin(tasks, eq(tasks.id, usageRecords.taskId))
      .where(where)
      .groupBy(usageRecords.taskId)
      .all();
    const byType = new Map<string, { tasks: number; tokens: number; cost: number }>();
    for (const r of perTask) {
      const e = byType.get(r.type) ?? { tasks: 0, tokens: 0, cost: 0 };
      byType.set(r.type, {
        tasks: e.tasks + 1,
        tokens: e.tokens + Number(r.tokens),
        cost: e.cost + Number(r.cost),
      });
    }

    return {
      from,
      to,
      totals: {
        runs: Number(t.runs),
        inputTokens: Number(t.input),
        outputTokens: Number(t.output),
        cacheReadTokens: Number(t.cacheRead),
        cacheWriteTokens: Number(t.cacheWrite),
        costUsd: Number(t.cost),
        estimatedShare: Number(t.cost) > 0 ? Number(t.estimated) / Number(t.cost) : 0,
        unpricedRuns: Number(t.unpriced),
        durationMs: Number(t.duration),
      },
      byDay: group(day, undefined, 'key'),
      byWeek: group(week, undefined, 'key'),
      byProject: group(
        sql<string | null>`${usageRecords.projectId}`,
        sql<string | null>`coalesce(${projects.name}, 'Engine tests')`,
      ),
      byEngine: group(sql<string>`${usageRecords.engineId}`),
      byModel: group(sql<string | null>`coalesce(${usageRecords.model}, 'unknown')`),
      byRole: group(sql<string | null>`coalesce(${usageRecords.role}, 'test run')`),
      topTasks: top.map((r) => ({
        key: r.key!,
        label: r.title,
        taskKey: r.taskKey,
        projectId: r.projectId,
        runs: Number(r.runs),
        tokens: Number(r.tokens),
        costUsd: Number(r.cost),
      })),
      byTaskType: [...byType]
        .map(([type, v]) => ({
          type,
          tasks: v.tasks,
          avgTokens: Math.round(v.tokens / v.tasks),
          avgCostUsd: v.cost / v.tasks,
        }))
        .sort((a, b) => b.avgTokens - a.avgTokens),
    };
  }

  /** Current window status per engine: what the CLI reports and/or your configured limit. */
  windows(): UsageWindowStatusDto[] {
    return this.engines
      .list()
      .filter((e) => e.installed)
      .map((e) => {
        let configured: UsageWindowStatusDto['configured'] = null;
        if (e.windowTokenLimit && e.windowHours) {
          const since = Date.now() - e.windowHours * 3_600_000;
          const used = this.db
            .select({ t: TOKENS })
            .from(usageRecords)
            .where(and(eq(usageRecords.engineId, e.id), gte(usageRecords.recordedAt, since)))
            .get()?.t;
          configured = { limit: e.windowTokenLimit, hours: e.windowHours, used: Number(used ?? 0) };
        }
        return {
          engineId: e.id,
          displayName: e.displayName,
          authStatus: e.authStatus,
          resetAt: e.resetAt,
          reported: e.usageWindows,
          configured,
        };
      });
  }
}
