'use client';

import type { ProjectCostDto, UsageBucket } from '@agentforge/shared';
import { useQuery } from '@tanstack/react-query';
import { Coins, Info, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { BarList, ColumnChart } from '@/components/charts/charts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api, qk } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

export const fmtTokens = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
        : String(Math.round(n));
export const fmtUsd = (n: number) =>
  n === 0 ? '$0' : n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;

const ROLE: Record<string, string> = {
  planner: 'Planner',
  developer: 'Developer',
  reviewer: 'Reviewer',
  tester: 'Tester',
  fixer: 'Fixer',
  documenter: 'Documenter',
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-muted/40 rounded-lg px-3 py-2.5">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-muted-foreground text-[11px]">{sub}</p>}
    </div>
  );
}

/** Cost, token usage and a forecast for finishing the project's open tasks. */
export function ProjectCostCard({ projectId }: { projectId: string }) {
  const cost = useQuery({
    queryKey: qk.projectCost(projectId),
    queryFn: () => api.projects.cost(projectId),
    refetchInterval: 60_000,
  });
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost');
  const engineName = (id: string) => engines.data?.find((e) => e.id === id)?.displayName ?? id;

  return (
    <Card className="gap-4 shadow-xs">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Coins className="text-primary size-4" /> Cost & token usage
          </CardTitle>
          <CardDescription>
            Everything agents have used on this project so far, and what the open tasks will likely
            cost.
          </CardDescription>
        </div>
        <Link
          href="/usage"
          className="text-muted-foreground hover:text-foreground shrink-0 text-xs"
        >
          Usage page →
        </Link>
      </CardHeader>
      <CardContent>
        {!cost.data ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : (
          <CostBody
            data={cost.data}
            metric={metric}
            setMetric={setMetric}
            engineName={engineName}
          />
        )}
      </CardContent>
    </Card>
  );
}

function CostBody({
  data,
  metric,
  setMetric,
  engineName,
}: {
  data: ProjectCostDto;
  metric: 'cost' | 'tokens';
  setMetric: (m: 'cost' | 'tokens') => void;
  engineName: (id: string) => string;
}) {
  const t = data.summary.totals;
  const total = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  if (t.runs === 0)
    return (
      <p className="text-muted-foreground text-sm">
        No agent runs yet — costs show up here as soon as agents start working.
      </p>
    );
  const val = (b: UsageBucket) => (metric === 'cost' ? b.costUsd : b.tokens);
  const fmt = metric === 'cost' ? fmtUsd : fmtTokens;
  const sorted = (xs: UsageBucket[]) => [...xs].sort((a, b) => val(b) - val(a));
  const f = data.forecast;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Total cost"
          value={
            t.estimatedShare > 0.01
              ? `~${fmtUsd(t.costUsd)}${t.estimatedShare > 0.99 ? ' est.' : ''}`
              : fmtUsd(t.costUsd)
          }
          sub={
            t.estimatedShare > 0.01
              ? `${Math.round(t.estimatedShare * 100)}% estimated from list prices`
              : t.unpricedRuns
                ? `${t.unpricedRuns} run${t.unpricedRuns === 1 ? '' : 's'} not priced`
                : 'as reported by the engines'
          }
        />
        <Stat
          label="Tokens"
          value={fmtTokens(total)}
          sub={`${fmtTokens(t.inputTokens)} in · ${fmtTokens(t.outputTokens)} out`}
        />
        <Stat
          label="Agent runs"
          value={String(t.runs)}
          sub={`${data.tasks.done}/${data.tasks.total - data.tasks.cancelled} tasks done`}
        />
        <Stat
          label="Agent time"
          value={t.durationMs ? formatDuration(Math.round(t.durationMs / 1000)) : '—'}
          sub={
            data.perDoneTask
              ? `~${fmtUsd(data.perDoneTask.costUsd)} per finished task`
              : 'no finished tasks yet'
          }
        />
      </div>

      {f ? (
        <div className="bg-accent/40 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm">
          <TrendingUp className="text-primary mt-0.5 size-4 shrink-0" />
          <p>
            Finishing the <b>{f.open}</b> open task{f.open === 1 ? '' : 's'} will likely cost about{' '}
            <b>{fmtUsd(f.costUsd)}</b> (~{fmtTokens(f.tokens)} tokens), so roughly{' '}
            <b>{fmtUsd(t.costUsd + f.costUsd)}</b> for the whole project.
            <span className="text-muted-foreground block text-xs">
              Based on what finished tasks of the same size cost
              {f.basedOn < f.open && ` (${f.open - f.basedOn} use the overall average)`}; fix loops
              and retries can push it higher.
            </span>
          </p>
        </div>
      ) : data.tasks.open > 0 ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Info className="size-3.5" /> A cost forecast for the {data.tasks.open} open task
          {data.tasks.open === 1 ? '' : 's'} appears once the first task is finished.
        </p>
      ) : null}

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Last 30 days</p>
        <div className="bg-muted inline-flex rounded-md p-0.5 text-xs" role="tablist">
          {(['cost', 'tokens'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={metric === m}
              onClick={() => setMetric(m)}
              className={cn(
                'rounded px-2 py-0.5 capitalize',
                metric === m ? 'bg-background shadow-xs' : 'text-muted-foreground',
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <ColumnChart
        title={metric === 'cost' ? 'Cost per day' : 'Tokens per day'}
        height={140}
        format={fmt}
        points={data.summary.byDay.map((b) => ({
          key: b.key,
          label: b.label,
          value: val(b),
          detail: `${b.runs} runs${metric === 'cost' && (b.estimatedCostUsd ?? 0) > 0 ? ' · est.' : ''}`,
        }))}
      />
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-sm font-medium">By role</p>
          <BarList
            format={fmt}
            items={sorted(data.summary.byRole).map((b) => ({
              key: b.key,
              label: ROLE[b.key] ?? b.label,
              value: val(b),
              detail: `${b.runs} runs${metric === 'cost' && (b.estimatedCostUsd ?? 0) > 0 ? ' · est.' : ''}`,
            }))}
          />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">By engine & model</p>
          <BarList
            format={fmt}
            items={[
              ...sorted(data.summary.byEngine).map((b) => ({
                key: `e:${b.key}`,
                label: engineName(b.key),
                value: val(b),
                detail: `${b.runs} runs${metric === 'cost' && (b.estimatedCostUsd ?? 0) > 0 ? ' · est.' : ''}`,
              })),
              ...sorted(data.summary.byModel)
                .filter((b) => b.key !== 'unknown')
                .map((b) => ({
                  key: `m:${b.key}`,
                  label: `· ${b.label}`,
                  value: val(b),
                  detail: `${b.runs} runs${metric === 'cost' && (b.estimatedCostUsd ?? 0) > 0 ? ' · est.' : ''}`,
                })),
            ]}
          />
        </div>
      </div>
      {data.summary.topTasks.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Most expensive tasks</p>
          <BarList
            format={fmt}
            items={[...data.summary.topTasks]
              .sort((a, b) => val(b) - val(a))
              .slice(0, 5)
              .map((b) => ({
                key: b.key,
                label: `${b.taskKey} · ${b.label}`,
                value: val(b),
                detail: `${b.runs} runs${metric === 'cost' && (b.estimatedCostUsd ?? 0) > 0 ? ' · est.' : ''}`,
              }))}
          />
        </div>
      )}
    </div>
  );
}
