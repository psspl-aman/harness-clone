'use client';

import { statusProgress, type TaskDto } from '@agentforge/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ExternalLink, Loader2, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { useLiveEvent } from '@/components/live-provider';
import { Button } from '@/components/ui/button';
import { useNow } from '@/hooks/use-now';
import { describeEvent, ROLE_VERB } from '@/lib/agent-events';
import { api, qk } from '@/lib/api';
import { clockTime, countdown } from '@/lib/format';
import { cn } from '@/lib/utils';

const fmtTokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);

/** Step progress + what's happening right now, for list rows and board cards. */
export function TaskProgress({ task, compact = false }: { task: TaskDto; compact?: boolean }) {
  const p = task.pipeline;
  const paused =
    task.status === 'PAUSED_QUOTA' ||
    task.status === 'PAUSED_AUTH' ||
    task.status === 'PAUSED_MANUAL';
  const now = useNow(1000, paused && !!p.resumeAt);
  if (task.status === 'DRAFT' || task.status === 'APPROVED' || task.status === 'CANCELLED')
    return null;
  const pct = Math.round(statusProgress(task.status, null) * 100);
  return (
    <div className={cn('space-y-1', compact ? 'mt-2' : 'w-40 shrink-0')}>
      <div
        className="bg-muted h-1 overflow-hidden rounded-full"
        role="progressbar"
        aria-label={`${task.key} progress`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn(
            'h-full rounded-full transition-all',
            task.status === 'DONE'
              ? 'bg-success'
              : task.status === 'FAILED' || task.status === 'NEEDS_HUMAN'
                ? 'bg-destructive'
                : paused
                  ? 'bg-warning'
                  : 'bg-primary',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
        {p.activeRole ? (
          <span className="text-primary flex items-center gap-1 font-medium">
            <Loader2 className="size-2.5 animate-spin" /> {ROLE_VERB[p.activeRole]}
          </span>
        ) : paused && p.resumeAt ? (
          <span className="text-warning">
            resumes {clockTime(p.resumeAt)} ({countdown(p.resumeAt, now)})
          </span>
        ) : p.blockedReason ? (
          <span className="truncate">{p.blockedReason}</span>
        ) : null}
        {p.fixLoops > 0 && (
          <span>
            · {p.fixLoops} fix{p.fixLoops === 1 ? '' : 'es'}
          </span>
        )}
        {p.costUsd > 0 ? (
          <span
            className="ml-auto tabular-nums"
            title={`${p.tokens.toLocaleString()} tokens (including cache reads)`}
          >
            ${p.costUsd.toFixed(p.costUsd < 1 ? 3 : 2)}
          </span>
        ) : p.tokens > 0 ? (
          <span className="ml-auto tabular-nums">{fmtTokens(p.tokens)} tok</span>
        ) : null}
        {p.pullRequestUrl && (
          <a
            href={p.pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary flex items-center gap-0.5 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            PR <ExternalLink className="size-2.5" />
          </a>
        )}
      </div>
    </div>
  );
}

/** "Building · 1 running · 2 queued" + pause/resume building, plus live steps of running agents. */
export function PipelineBar({ projectId, tasks }: { projectId: string; tasks: TaskDto[] }) {
  const status = useQuery({
    queryKey: qk.pipeline(projectId),
    queryFn: () => api.pipeline.status(projectId),
  });
  const toggle = useMutation({
    mutationFn: (pause: boolean) =>
      pause ? api.pipeline.pause(projectId) : api.pipeline.resume(projectId),
  });
  const [steps, setSteps] = useState<Record<string, string>>({});
  useLiveEvent((e) => {
    if (e.type !== 'run.event') return;
    const d = describeEvent(e.payload.event);
    if (d) setSteps((s) => (s[e.payload.runId] === d ? s : { ...s, [e.payload.runId]: d }));
  });
  const s = status.data;
  const building = tasks.some(
    (t) => !['DRAFT', 'APPROVED', 'DONE', 'CANCELLED'].includes(t.status),
  );
  if (!s || (!building && !s.paused)) return null;
  const running = tasks.filter((t) => t.pipeline.activeRole);
  return (
    <div className="bg-card space-y-2 rounded-xl border p-3 shadow-xs" aria-label="Build pipeline">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span
          className={cn(
            'size-2 rounded-full',
            s.paused
              ? 'bg-warning'
              : running.length
                ? 'bg-primary animate-pulse'
                : 'bg-muted-foreground/40',
          )}
        />
        <span className="font-medium">
          {s.paused ? 'Building paused' : running.length ? 'Building' : 'Idle'}
        </span>
        <span className="text-muted-foreground text-xs">
          {s.running.length} running · {s.queued} queued · up to {s.limit} at once
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-7"
          onClick={() => toggle.mutate(!s.paused)}
          disabled={toggle.isPending}
        >
          {s.paused ? (
            <>
              <Play className="size-3.5" /> Resume building
            </>
          ) : (
            <>
              <Pause className="size-3.5" /> Pause building
            </>
          )}
        </Button>
      </div>
      {running.length > 0 && (
        <ul className="space-y-1" aria-label="Live agent activity">
          {running.map((t) => (
            <li
              key={t.id}
              className="bg-muted/40 flex items-center gap-2 rounded-md px-2 py-1 text-xs"
            >
              <Loader2 className="text-primary size-3 shrink-0 animate-spin" />
              <span className="font-mono">{t.key}</span>
              <span className="font-medium">{ROLE_VERB[t.pipeline.activeRole!]}</span>
              <span className="text-muted-foreground">· {t.pipeline.activeEngine}</span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono">
                {t.pipeline.activeRunId ? (steps[t.pipeline.activeRunId] ?? 'starting…') : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
