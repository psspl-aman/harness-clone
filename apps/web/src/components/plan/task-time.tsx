'use client';

import { remainingMs, spentNow, type TaskDto } from '@ai-harness/shared';
import { Clock } from 'lucide-react';
import { useNow } from '@/hooks/use-now';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Minutes-level duration ("12m", "1h 5m"); under a minute shows "<1m". */
export const fmtMinutes = (ms: number) =>
  ms < 60_000 ? '<1m' : formatDuration(Math.round(ms / 60_000) * 60);

/** Compact USD ("$0.42", "<$0.01", "$1.2k"). */
export const fmtCost = (usd: number) =>
  usd > 0 && usd < 0.01
    ? '<$0.01'
    : usd >= 1000
      ? `$${(usd / 1000).toFixed(1)}k`
      : `$${usd.toFixed(2)}`;

const basisText = (t: TaskDto) =>
  t.timing.estimateBasis === 'history'
    ? `typical for your finished ${t.complexity.toUpperCase()} tasks`
    : `a starting guess for ${t.complexity.toUpperCase()} tasks — it adapts once a few tasks are done`;

/** Compact time label for list rows and board cards. */
export function TaskTimeChip({ task, className }: { task: TaskDto; className?: string }) {
  const live = !!task.timing.runningSince;
  const now = useNow(30_000, live);
  const spent = spentNow(task.timing, now);
  const est = task.timing.estimateMs;
  let label: string;
  let title: string;
  if (task.status === 'DONE') {
    label = `took ${fmtMinutes(spent)}`;
    title = `Agents worked ${fmtMinutes(spent)} on this task (estimate was ~${fmtMinutes(est)})`;
  } else if (task.status === 'CANCELLED') {
    if (!spent) return null;
    label = `spent ${fmtMinutes(spent)}`;
    title = `Agents worked ${fmtMinutes(spent)} before it was cancelled`;
  } else if (spent > 0) {
    label = `${fmtMinutes(spent)} / ~${fmtMinutes(est)}`;
    title = `Agent time spent / estimated (${basisText(task)})`;
  } else {
    label = `~${fmtMinutes(est)}`;
    title = `Estimated agent time: ${basisText(task)}`;
  }
  // A cost forecast (median of your finished tasks of this complexity), shown only when there's
  // history to base it on — never a fabricated figure.
  const showCost = task.status !== 'DONE' && task.status !== 'CANCELLED' && task.timing.estCostUsd;
  return (
    <span className={cn('inline-flex items-center gap-1', className)} title={title}>
      <Clock className="size-3" aria-hidden />
      {label}
      {showCost ? (
        <span
          className="text-muted-foreground"
          title={`Estimated cost — median of your finished ${task.complexity.toUpperCase()} tasks`}
        >
          · ~{fmtCost(task.timing.estCostUsd!)} est.
        </span>
      ) : null}
    </span>
  );
}

/** Estimate / spent / elapsed details for the task drawer. */
export function TaskTimePanel({ task }: { task: TaskDto }) {
  const t = task.timing;
  const now = useNow(10_000, !!t.runningSince);
  const spent = spentNow(t, now);
  const elapsed = t.startedAt ? (t.finishedAt ?? now) - t.startedAt : null;
  const left = remainingMs(task, now);
  const over = task.status !== 'DONE' && spent > t.estimateMs;
  const items: [string, string, string?][] = [
    ['Estimate', `~${fmtMinutes(t.estimateMs)}`, basisText(task)],
    ['Agent time', spent ? fmtMinutes(spent) : '—', 'Time agents actually spent running'],
    [
      task.status === 'DONE' ? 'Start to finish' : 'Elapsed',
      elapsed != null ? fmtMinutes(elapsed) : '—',
      'Wall-clock time since the first agent started, including waiting and pauses',
    ],
    [
      'Remaining',
      task.status === 'DONE' || task.status === 'CANCELLED'
        ? '—'
        : `~${fmtMinutes(left)}${over ? ' (over estimate)' : ''}`,
      'Estimate minus time spent',
    ],
    [
      'Est. cost',
      t.estCostUsd != null ? `~${fmtCost(t.estCostUsd)}` : '—',
      t.estCostUsd != null
        ? `Median cost of your finished ${task.complexity.toUpperCase()} tasks`
        : `No cost history yet for ${task.complexity.toUpperCase()} tasks — appears once a few finish`,
    ],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {items.map(([k, v, hint]) => (
        <div key={k} className="bg-muted/40 rounded-lg px-3 py-2" title={hint}>
          <dt className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            {k}
          </dt>
          <dd className="text-sm font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
