'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { BarList, ColumnChart, LineChart, Meter } from '@/components/charts/charts';
import { PageHeader } from '@/components/shell/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useNow } from '@/hooks/use-now';
import { api, qk } from '@/lib/api';
import { countdown } from '@/lib/format';
import { cn } from '@/lib/utils';

const ALL = '__all';
const tokens = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
        : String(Math.round(n));
const usd = (n: number) =>
  n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
const ROLE: Record<string, string> = {
  planner: 'Planner',
  developer: 'Developer',
  reviewer: 'Reviewer',
  tester: 'Tester',
  fixer: 'Fixer',
  documenter: 'Documenter',
  'test run': 'Engine tests',
};

function Panel({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('gap-3 shadow-xs', className)}>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        {description && <CardDescription className="text-xs">{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card rounded-xl border p-4 shadow-xs">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {sub && <p className="text-muted-foreground mt-0.5 text-[11px]">{sub}</p>}
    </div>
  );
}

function Windows() {
  const windows = useQuery({
    queryKey: qk.usageWindows,
    queryFn: api.usage.windows,
    refetchInterval: 60_000,
  });
  const now = useNow(30_000);
  const list = (windows.data ?? []).filter((w) => w.reported.length || w.configured);
  return (
    <Panel
      title="Usage windows"
      description="How much of each engine's current window is used, and when it resets."
    >
      {!list.length ? (
        <p className="text-muted-foreground text-sm">
          No window data yet. Claude Code reports its 5-hour and 7-day windows after a run; for
          other engines set a limit under{' '}
          <Link href="/agents" className="text-primary hover:underline">
            Agents &amp; Accounts
          </Link>
          .
        </p>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          {list.map((w) => (
            <div key={w.engineId} className="space-y-3">
              <p className="text-sm font-medium">
                {w.displayName}
                {w.authStatus === 'QUOTA_EXHAUSTED' && w.resetAt && (
                  <span className="text-muted-foreground font-normal">
                    {' '}
                    · exhausted, resets in {countdown(w.resetAt, now)}
                  </span>
                )}
              </p>
              {w.reported.map((r) => (
                <Meter
                  key={r.name}
                  label={
                    r.name === 'five_hour'
                      ? '5-hour window'
                      : r.name === 'seven_day'
                        ? '7-day window'
                        : r.name.replace(/_/g, ' ')
                  }
                  used={Math.round((r.utilization ?? 0) * 1000)}
                  limit={1000}
                  caption={
                    r.resetsAt && r.resetsAt > now
                      ? `Resets in ${countdown(r.resetsAt, now)}`
                      : undefined
                  }
                />
              ))}
              {w.configured && (
                <Meter
                  label={`Your limit · last ${w.configured.hours}h`}
                  used={w.configured.used}
                  limit={w.configured.limit}
                  caption={`${tokens(w.configured.used)} of ${tokens(w.configured.limit)} tokens`}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export default function UsagePage() {
  const [days, setDays] = useState(30);
  const [projectId, setProjectId] = useState(ALL);
  const [engineId, setEngineId] = useState(ALL);
  const [period, setPeriod] = useState<'day' | 'week'>('day');
  const [metric, setMetric] = useState<'tokens' | 'cost'>('tokens');
  const projects = useQuery({ queryKey: qk.projects, queryFn: api.projects.list });
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  const p = projectId === ALL ? '' : projectId;
  const e = engineId === ALL ? '' : engineId;
  const summary = useQuery({
    queryKey: qk.usage(days, p, e),
    queryFn: () => api.usage.summary({ days, projectId: p || undefined, engineId: e || undefined }),
  });
  const s = summary.data;
  const fmt = metric === 'cost' ? usd : tokens;
  const val = (b: { tokens: number; costUsd: number }) =>
    metric === 'cost' ? b.costUsd : b.tokens;
  const sorted = <T extends { tokens: number; costUsd: number }>(xs: T[]) =>
    [...xs].sort((a, b) => val(b) - val(a));
  const series = (period === 'day' ? s?.byDay : s?.byWeek) ?? [];
  const totalTokens = s
    ? s.totals.inputTokens +
      s.totals.outputTokens +
      s.totals.cacheReadTokens +
      s.totals.cacheWriteTokens
    : 0;
  const engineName = (id: string) => engines.data?.find((x) => x.id === id)?.displayName ?? id;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
      <PageHeader
        title="Usage"
        description="Tokens and cost across projects, tasks, roles and engines."
      />

      <div className="mb-6 flex flex-wrap items-center gap-2" role="toolbar" aria-label="Filters">
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger size="sm" className="w-36" aria-label="Time range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[7, 30, 90, 365].map((d) => (
              <SelectItem key={d} value={String(d)}>
                Last {d} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger size="sm" className="w-48" aria-label="Project">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All projects</SelectItem>
            {projects.data?.map((x) => (
              <SelectItem key={x.id} value={x.id}>
                {x.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={engineId} onValueChange={setEngineId}>
          <SelectTrigger size="sm" className="w-44" aria-label="Engine">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All engines</SelectItem>
            {engines.data?.map((x) => (
              <SelectItem key={x.id} value={x.id}>
                {x.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div
          role="radiogroup"
          aria-label="Measure"
          className="bg-muted ml-auto flex rounded-lg p-0.5"
        >
          {(['tokens', 'cost'] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={metric === m}
              onClick={() => setMetric(m)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium capitalize',
                metric === m ? 'bg-background shadow-xs' : 'text-muted-foreground',
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {!s ? (
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Tokens"
              value={tokens(totalTokens)}
              sub={`${tokens(s.totals.inputTokens)} in · ${tokens(s.totals.outputTokens)} out · ${tokens(s.totals.cacheReadTokens)} cached`}
            />
            <Stat
              label="Cost"
              value={usd(s.totals.costUsd)}
              sub={[
                s.totals.estimatedShare > 0
                  ? `${Math.round(s.totals.estimatedShare * 100)}% estimated`
                  : 'as reported by the CLIs',
                s.totals.unpricedRuns ? `${s.totals.unpricedRuns} runs unpriced` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            />
            <Stat
              label="Agent runs"
              value={String(s.totals.runs)}
              sub={`${Math.round(s.totals.durationMs / 60_000)} min of agent time`}
            />
            <Stat
              label="Tasks with usage"
              value={String(s.byTaskType.reduce((a, t) => a + t.tasks, 0))}
              sub={s.topTasks[0] ? `Top: ${s.topTasks[0].taskKey}` : undefined}
            />
          </div>

          <Panel title={metric === 'cost' ? 'Cost over time' : 'Tokens over time'}>
            <div className="mb-2 flex justify-start">
              <div role="radiogroup" aria-label="Period" className="bg-muted flex rounded-lg p-0.5">
                {(['day', 'week'] as const).map((x) => (
                  <button
                    key={x}
                    role="radio"
                    aria-checked={period === x}
                    onClick={() => setPeriod(x)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs font-medium',
                      period === x ? 'bg-background shadow-xs' : 'text-muted-foreground',
                    )}
                  >
                    By {x}
                  </button>
                ))}
              </div>
            </div>
            {/* Daily usage is a trend (line); weekly totals are discrete periods (columns). */}
            {(() => {
              const Chart = period === 'day' ? LineChart : ColumnChart;
              return (
                <Chart
                  title={metric === 'cost' ? 'Cost' : 'Tokens'}
                  format={fmt}
                  points={series.map((b) => ({
                    key: b.key,
                    label: b.label,
                    value: val(b),
                    detail: `${b.runs} runs`,
                  }))}
                />
              );
            })()}
          </Panel>

          <div className="grid gap-6 md:grid-cols-2">
            <Panel title="By engine">
              <BarList
                format={fmt}
                items={sorted(s.byEngine ?? []).map((b) => ({
                  key: b.key,
                  label: engineName(b.key),
                  value: val(b),
                  detail: `${b.runs} runs`,
                }))}
              />
            </Panel>
            <Panel title="By role">
              <BarList
                format={fmt}
                items={sorted(s.byRole).map((b) => ({
                  key: b.key,
                  label: ROLE[b.key] ?? b.key,
                  value: val(b),
                  detail: `${b.runs} runs`,
                }))}
              />
            </Panel>
            <Panel title="By project">
              <BarList
                format={fmt}
                items={sorted(s.byProject).map((b) => ({
                  key: b.key,
                  label: b.label,
                  value: val(b),
                  detail: `${b.runs} runs`,
                }))}
              />
            </Panel>
            <Panel title="By model">
              <BarList
                format={fmt}
                items={sorted(s.byModel).map((b) => ({
                  key: b.key,
                  label: b.label,
                  value: val(b),
                  detail: `${b.runs} runs`,
                }))}
              />
            </Panel>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <Panel title="Top tasks">
              {!s.topTasks.length ? (
                <p className="text-muted-foreground text-sm">No task usage yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-muted-foreground text-xs">
                    <tr>
                      <th className="pb-1 text-left font-medium">Task</th>
                      <th className="pb-1 text-right font-medium">Tokens</th>
                      <th className="pb-1 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.topTasks.map((t) => (
                      <tr key={t.key} className="border-t">
                        <td className="max-w-0 truncate py-1.5 pr-2">
                          {t.projectId ? (
                            <Link href={`/projects/${t.projectId}`} className="hover:underline">
                              <span className="text-muted-foreground font-mono text-xs">
                                {t.taskKey}
                              </span>{' '}
                              {t.label}
                            </Link>
                          ) : (
                            t.label
                          )}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{tokens(t.tokens)}</td>
                        <td className="py-1.5 text-right tabular-nums">{usd(t.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
            <Panel title="Average per task type">
              {!s.byTaskType.length ? (
                <p className="text-muted-foreground text-sm">No task usage yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-muted-foreground text-xs">
                    <tr>
                      <th className="pb-1 text-left font-medium">Type</th>
                      <th className="pb-1 text-right font-medium">Tasks</th>
                      <th className="pb-1 text-right font-medium">Avg tokens</th>
                      <th className="pb-1 text-right font-medium">Avg cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byTaskType.map((t) => (
                      <tr key={t.type} className="border-t">
                        <td className="py-1.5 capitalize">{t.type}</td>
                        <td className="py-1.5 text-right tabular-nums">{t.tasks}</td>
                        <td className="py-1.5 text-right tabular-nums">{tokens(t.avgTokens)}</td>
                        <td className="py-1.5 text-right tabular-nums">{usd(t.avgCostUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>

          <Windows />
        </div>
      )}
    </div>
  );
}
