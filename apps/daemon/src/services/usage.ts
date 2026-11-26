import type {
  ProjectCostDto,
  UsageBucket,
  UsageSummaryDto,
  UsageWindowStatusDto,
} from '@ai-harness/shared';
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

  /** All-time cost of one project plus a forecast for its open tasks. */
  projectCost(projectId: string): ProjectCostDto {
    const now = Date.now();
    const summary = this.summary({ from: 0, to: now, projectId });
    const since = now - 30 * 86_400_000;
    summary.byDay = summary.byDay.filter((b) => new Date(`${b.key}T00:00:00`).getTime() >= since);
    const rows = this.db
      .select({
        id: tasks.id,
        status: tasks.status,
        complexity: tasks.complexity,
        tokens: sql<number>`coalesce(${TOKENS}, 0)`,
        cost: sql<number>`coalesce(${COST}, 0)`,
      })
      .from(tasks)
      .leftJoin(usageRecords, eq(usageRecords.taskId, tasks.id))
      .where(eq(tasks.projectId, projectId))
      .groupBy(tasks.id)
      .all()
      .map((r) => ({ ...r, tokens: Number(r.tokens), cost: Number(r.cost) }));
    const done = rows.filter((r) => r.status === 'DONE');
    const cancelled = rows.filter((r) => r.status === 'CANCELLED').length;
    const open = rows.filter((r) => r.status !== 'DONE' && r.status !== 'CANCELLED');
    const avg = (xs: typeof rows) =>
      xs.length
        ? {
            costUsd: xs.reduce((a, r) => a + r.cost, 0) / xs.length,
            tokens: xs.reduce((a, r) => a + r.tokens, 0) / xs.length,
          }
        : null;
    const overall = avg(done);
    let forecast: ProjectCostDto['forecast'] = null;
    if (overall && open.length) {
      const bySize = new Map<string, { costUsd: number; tokens: number }>();
      for (const c of new Set(done.map((r) => r.complexity))) {
        const a = avg(done.filter((r) => r.complexity === c));
        if (a) bySize.set(c, a);
      }
      let cost = 0;
      let tokens = 0;
      let basedOn = 0;
      for (const t of open) {
        const typical = bySize.get(t.complexity);
        if (typical) basedOn++;
        const ref = typical ?? overall;
        cost += Math.max(0, ref.costUsd - t.cost);
        tokens += Math.max(0, ref.tokens - t.tokens);
      }
      forecast = { costUsd: cost, tokens: Math.round(tokens), basedOn, open: open.length };
    }
    return {
      projectId,
      summary,
      tasks: { total: rows.length, done: done.length, open: open.length, cancelled },
      perDoneTask: overall
        ? { costUsd: overall.costUsd, tokens: Math.round(overall.tokens) }
        : null,
      forecast,
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
