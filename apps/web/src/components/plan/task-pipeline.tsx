'use client';

import { useLiveEvent, useLiveTopic } from '@/components/live-provider';
import { VirtualLog, type LogLine } from '@/components/virtual-log';
import type { AgentEvent, RunSummaryDto, TaskDto, TaskStatus } from '@agentforge/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  GitMerge,
  Loader2,
  MessageSquareReply,
  Pause,
  Play,
  RotateCcw,
  Send,
  XCircle,
  ScrollText,
  Wand2,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { DiffView } from '@/components/diff-view';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useNow } from '@/hooks/use-now';
import { eventLine, ROLE_VERB } from '@/lib/agent-events';
import { api, ApiClientError, qk } from '@/lib/api';
import { clockTime, countdown, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

const errText = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));

const STEPS: { label: string; statuses: TaskStatus[] }[] = [
  { label: 'Develop', statuses: ['IN_DEVELOPMENT'] },
  { label: 'Review', statuses: ['IN_REVIEW'] },
  { label: 'Test', statuses: ['IN_TESTING'] },
  { label: 'Fix', statuses: ['FIXING'] },
  { label: 'Document', statuses: ['DOCUMENTING'] },
  { label: 'Merge', statuses: ['DONE'] },
];
const ORDER: TaskStatus[] = [
  'QUEUED',
  'IN_DEVELOPMENT',
  'IN_REVIEW',
  'IN_TESTING',
  'DOCUMENTING',
  'DONE',
];

function Stepper({ task, history }: { task: TaskDto; history: TaskStatus[] }) {
  const reached = new Set(history);
  const current =
    task.status === 'PAUSED_MANUAL' ||
    task.status === 'PAUSED_QUOTA' ||
    task.status === 'PAUSED_AUTH' ||
    task.status === 'FAILED' ||
    task.status === 'NEEDS_HUMAN'
      ? null
      : task.status;
  return (
    <ol className="flex items-center gap-1" aria-label="Pipeline steps">
      {STEPS.filter((s) => s.label !== 'Fix' || reached.has('FIXING')).map((s, i, all) => {
        const active = task.status !== 'DONE' && s.statuses.includes(current as TaskStatus);
        const done =
          !active &&
          (task.status === 'DONE' ||
            s.statuses.some(
              (x) => reached.has(x) && ORDER.indexOf(x) < ORDER.indexOf(current ?? 'DONE'),
            ) ||
            (s.label === 'Fix' && reached.has('FIXING') && current !== 'FIXING'));
        return (
          <li key={s.label} className="flex items-center gap-1">
            <span
              className={cn(
                'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                active && 'border-primary bg-primary/10 text-primary',
                done && 'border-success/30 bg-success/10 text-success',
                !active && !done && 'text-muted-foreground',
              )}
            >
              {active ? (
                <Loader2 className="size-3 animate-spin" />
              ) : done ? (
                <Check className="size-3" />
              ) : null}
              {s.label}
              {s.label === 'Fix' && task.pipeline.fixLoops > 0 ? ` ×${task.pipeline.fixLoops}` : ''}
            </span>
            {i < all.length - 1 && <ChevronRight className="text-muted-foreground/50 size-3" />}
          </li>
        );
      })}
    </ol>
  );
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: 'warning' | 'error' | 'info';
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border p-3 text-sm',
        tone === 'error' && 'border-destructive/25 bg-destructive/5',
        tone === 'warning' && 'border-warning/30 bg-warning/10',
        tone === 'info' && 'bg-accent/50',
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

export function PipelineControls({ task, onShowLogs }: { task: TaskDto; onShowLogs?: () => void }) {
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onError: (e) => toast.error('Action failed', { description: errText(e) }),
  });
  const [message, setMessage] = useState('');
  const [changes, setChanges] = useState('');
  const now = useNow(1000, !!task.pipeline.resumeAt);
  const s = task.status;
  const running =
    s === 'QUEUED' ||
    ['IN_DEVELOPMENT', 'IN_REVIEW', 'IN_TESTING', 'FIXING', 'DOCUMENTING'].includes(s);
  const paused = s === 'PAUSED_MANUAL' || s === 'PAUSED_QUOTA' || s === 'PAUSED_AUTH';
  const call = (action: Parameters<typeof api.pipeline.task>[1]) =>
    act.mutate(() => api.pipeline.task(task.id, action));

  return (
    <div className="space-y-3">
      {task.pipeline.awaitingMergeReview && s === 'NEEDS_HUMAN' ? (
        <Banner tone="info" icon={<GitMerge className="text-primary size-4" />}>
          <p className="font-medium">{task.statusReason ?? 'Ready to merge'}</p>
          <p className="text-muted-foreground text-xs">
            Check the Changes, Review and Report tabs, then merge or ask for changes.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => call('approve-merge')} disabled={act.isPending}>
              <GitMerge /> Approve &amp; merge
            </Button>
          </div>
          <form
            className="space-y-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (changes.trim())
                act.mutate(() =>
                  api.pipeline.requestChanges(task.id, changes.trim()).then(() => setChanges('')),
                );
            }}
          >
            <Textarea
              rows={2}
              value={changes}
              onChange={(e) => setChanges(e.target.value)}
              placeholder="What should change? The Fixer gets this verbatim."
              aria-label="Requested changes"
              className="text-sm"
            />
            <Button
              size="sm"
              variant="outline"
              type="submit"
              disabled={!changes.trim() || act.isPending}
            >
              <MessageSquareReply /> Request changes
            </Button>
          </form>
        </Banner>
      ) : (
        (s === 'FAILED' || s === 'NEEDS_HUMAN') && (
          <Banner tone="error" icon={<AlertTriangle className="text-destructive size-4" />}>
            <p className="font-medium">{s === 'FAILED' ? 'Failed' : 'Needs you'}</p>
            <p className="text-muted-foreground text-xs break-words whitespace-pre-wrap">
              {task.statusReason ?? task.pipeline.lastError}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => call('retry')}
                disabled={act.isPending}
              >
                <RotateCcw /> Retry this step
              </Button>
              {task.pipeline.branch && (
                <Button
                  size="sm"
                  onClick={() => call('fix')}
                  disabled={act.isPending}
                  title="The Fixer gets this error, then the change goes through review and tests again"
                >
                  <Wand2 /> Fix with agent
                </Button>
              )}
              {onShowLogs && (
                <Button size="sm" variant="ghost" onClick={onShowLogs}>
                  <ScrollText /> Logs
                </Button>
              )}
            </div>
          </Banner>
        )
      )}
      {paused && (
        <Banner tone="warning" icon={<Pause className="text-warning size-4" />}>
          <p className="font-medium">{task.statusReason ?? 'Paused'}</p>
          {task.pipeline.resumeAt && (
            <p className="text-muted-foreground text-xs">
              Usage window resets at {clockTime(task.pipeline.resumeAt)} (
              {countdown(task.pipeline.resumeAt, now)}).
            </p>
          )}
        </Banner>
      )}
      {s === 'BLOCKED' && task.pipeline.blockedReason && (
        <Banner tone="info" icon={<GitMerge className="text-muted-foreground size-4" />}>
          <p>{task.pipeline.blockedReason}</p>
        </Banner>
      )}

      <div className="flex flex-wrap gap-2">
        {running && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => call('pause')}
            disabled={act.isPending}
          >
            <Pause /> Pause
          </Button>
        )}
        {paused && (
          <Button size="sm" onClick={() => call('resume')} disabled={act.isPending}>
            <Play /> Resume
          </Button>
        )}
        {(running || paused || s === 'FAILED' || s === 'NEEDS_HUMAN' || s === 'BLOCKED') && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => act.mutate(() => api.pipeline.task(task.id, 'cancel'))}
            disabled={act.isPending}
          >
            <CircleStop /> Cancel task
          </Button>
        )}
      </div>

      {s !== 'DONE' && s !== 'CANCELLED' && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (message.trim())
              act.mutate(() =>
                api.pipeline.steer(task.id, message.trim()).then(() => {
                  setMessage('');
                  toast.success(
                    task.pipeline.activeRole
                      ? 'Sent — the agent restarts its step with your message'
                      : 'Saved — the next agent run gets your message',
                  );
                }),
              );
          }}
        >
          <Textarea
            rows={1}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              task.pipeline.activeRole
                ? `Message the ${task.pipeline.activeRole}…`
                : 'Message the next agent…'
            }
            aria-label="Message the agent"
            className="min-h-9 resize-none text-sm"
          />
          <Button
            size="icon"
            type="submit"
            aria-label="Send message to agent"
            disabled={!message.trim() || act.isPending}
          >
            <Send />
          </Button>
        </form>
      )}
    </div>
  );
}

function RunLog({ runId }: { runId: string }) {
  const run = useQuery({ queryKey: qk.run(runId), queryFn: () => api.runs.get(runId) });
  const [live, setLive] = useState<{ seq: number; event: AgentEvent }[]>([]);
  const running = run.data?.run.status === 'RUNNING';
  useLiveTopic(running ? `run:${runId}` : null);
  useLiveEvent((e) => {
    if (e.type === 'run.event' && e.payload.runId === runId)
      setLive((l) => [...l, { seq: -(l.length + 1), event: e.payload.event }]);
  });
  if (run.isPending) return <Skeleton className="h-20" />;
  const lines: LogLine[] = [];
  for (const e of [...(run.data?.events ?? []), ...(running ? live : [])]) {
    const l = eventLine(e.event);
    if (l) lines.push({ key: `${e.seq}`, ...l });
  }
  return <VirtualLog lines={lines} empty={running ? 'Waiting for output…' : 'No output.'} />;
}

function Activity({ taskId }: { taskId: string }) {
  const runs = useQuery({
    queryKey: qk.taskDetail(taskId, 'runs'),
    queryFn: () => api.pipeline.runs(taskId),
  });
  const [open, setOpen] = useState<string | null>(null);
  if (runs.isPending) return <Skeleton className="h-32" />;
  if (!runs.data?.length)
    return <p className="text-muted-foreground text-sm">No agent runs yet.</p>;
  const icon = (r: RunSummaryDto) =>
    r.status === 'RUNNING' ? (
      <Loader2 className="text-primary size-3.5 animate-spin" />
    ) : r.status === 'SUCCEEDED' ? (
      <CheckCircle2 className="text-success size-3.5" />
    ) : (
      <XCircle
        className={
          r.status === 'CANCELLED' ? 'text-muted-foreground size-3.5' : 'text-destructive size-3.5'
        }
      />
    );
  return (
    <ol className="space-y-1.5">
      {runs.data.map((r) => (
        <li key={r.id} className="rounded-lg border">
          <button
            className="hover:bg-muted/50 flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
            onClick={() => setOpen(open === r.id ? null : r.id)}
            aria-expanded={open === r.id}
          >
            {icon(r)}
            <span className="font-medium">{ROLE_VERB[r.role]}</span>
            <span className="text-muted-foreground text-xs">
              {r.engineId}
              {r.model ? ` · ${r.model}` : ''}
              {r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}
            </span>
            <span className="text-muted-foreground ml-auto text-xs tabular-nums">
              {r.durationMs ? `${Math.round(r.durationMs / 1000)}s · ` : ''}
              {(r.inputTokens + r.outputTokens + r.cacheReadTokens).toLocaleString()} tok
              {r.costUsd ? ` · $${r.costUsd.toFixed(3)}` : ''}
            </span>
          </button>
          {open === r.id && (
            <div className="space-y-2 border-t p-3">
              {(r.errorMessage || r.resultSummary) && (
                <p
                  className={cn(
                    'text-xs whitespace-pre-wrap',
                    r.errorMessage ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {(r.errorMessage ?? r.resultSummary)!.slice(0, 1200)}
                </p>
              )}
              {r.filesChanged.length > 0 && (
                <p className="text-muted-foreground font-mono text-[11px]">
                  Changed: {r.filesChanged.join(', ')}
                </p>
              )}
              <RunLog runId={r.id} />
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function ReviewsAndTests({ taskId }: { taskId: string }) {
  const reviews = useQuery({
    queryKey: qk.taskDetail(taskId, 'reviews'),
    queryFn: () => api.pipeline.reviews(taskId),
  });
  const tests = useQuery({
    queryKey: qk.taskDetail(taskId, 'tests'),
    queryFn: () => api.pipeline.tests(taskId),
  });
  const [log, setLog] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Reviews
        </h3>
        {!reviews.data?.length && <p className="text-muted-foreground text-sm">No reviews yet.</p>}
        {reviews.data?.map((r) => (
          <div key={r.id} className="space-y-1.5 rounded-lg border p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              {r.verdict === 'APPROVE' ? (
                <CheckCircle2 className="text-success size-4" />
              ) : (
                <XCircle className="text-warning size-4" />
              )}
              {r.reviewer === 'human'
                ? 'You'
                : r.scope === 'tests'
                  ? 'Reviewer (tests)'
                  : 'Reviewer'}
              : {r.verdict === 'APPROVE' ? 'approved' : 'changes requested'}
              <span className="text-muted-foreground ml-auto text-xs font-normal">
                {timeAgo(r.createdAt)}
              </span>
            </p>
            <p className="text-sm">{r.summary}</p>
            {r.comments.length > 0 && (
              <ul className="space-y-1">
                {r.comments.map((c) => (
                  <li key={c.id} className="bg-muted/40 rounded-md px-2 py-1.5 text-xs">
                    <span
                      className={cn(
                        'mr-1.5 rounded px-1 py-0.5 text-[10px] font-semibold uppercase',
                        c.severity === 'blocker' || c.severity === 'major'
                          ? 'bg-destructive/15 text-destructive'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {c.severity}
                    </span>
                    {c.filePath && (
                      <span className="font-mono">
                        {c.filePath}
                        {c.line ? `:${c.line}` : ''}{' '}
                      </span>
                    )}
                    {c.body}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </section>
      <section className="space-y-2">
        <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Test runs
        </h3>
        {!tests.data?.length && <p className="text-muted-foreground text-sm">No test runs yet.</p>}
        {tests.data?.map((r) => (
          <div key={r.id} className="space-y-1.5 rounded-lg border p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              {r.passed ? (
                <CheckCircle2 className="text-success size-4" />
              ) : (
                <XCircle className="text-destructive size-4" />
              )}
              {r.passed ? 'Passed' : 'Failed'}
              {r.total !== null && (
                <span className="text-muted-foreground font-normal">
                  · {r.total} tests{r.failed ? `, ${r.failed} failed` : ''}
                </span>
              )}
              <span className="text-muted-foreground ml-auto text-xs font-normal">
                {timeAgo(r.createdAt)}
              </span>
            </p>
            <p className="text-sm whitespace-pre-wrap">{r.summary}</p>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setLog(log === r.id ? null : r.id)}
            >
              {log === r.id ? 'Hide log' : 'Show log'}
            </Button>
            {log === r.id && (
              <pre className="bg-muted/40 max-h-72 overflow-auto rounded-md p-2 font-mono text-[11px] whitespace-pre-wrap">
                {r.log}
              </pre>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

function Changes({ taskId }: { taskId: string }) {
  const diff = useQuery({
    queryKey: qk.taskDetail(taskId, 'diff'),
    queryFn: () => api.pipeline.diff(taskId),
  });
  if (diff.isPending) return <Skeleton className="h-32" />;
  if (diff.isError) return <p className="text-destructive text-sm">{errText(diff.error)}</p>;
  return <DiffView diff={diff.data} />;
}

function Report({ taskId }: { taskId: string }) {
  const report = useQuery({
    queryKey: qk.taskDetail(taskId, 'report'),
    queryFn: () => api.pipeline.report(taskId),
  });
  if (report.isPending) return <Skeleton className="h-32" />;
  if (!report.data)
    return (
      <p className="text-muted-foreground text-sm">
        The Documenter writes the report once tests pass.
      </p>
    );
  return <Markdown>{report.data.content}</Markdown>;
}

export type PipelineTab = 'details' | 'activity' | 'changes' | 'checks' | 'report';

export function PipelineTabs({
  tab,
  onTab,
}: {
  tab: PipelineTab;
  onTab: (t: PipelineTab) => void;
}) {
  const tabs: [PipelineTab, string][] = [
    ['details', 'Details'],
    ['activity', 'Activity'],
    ['changes', 'Changes'],
    ['checks', 'Review & tests'],
    ['report', 'Report'],
  ];
  return (
    <div role="tablist" aria-label="Task sections" className="flex gap-1 overflow-x-auto">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          role="tab"
          aria-selected={tab === id}
          onClick={() => onTab(id)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap',
            tab === id
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function PipelinePanel({
  task,
  tab,
  history,
}: {
  task: TaskDto;
  tab: Exclude<PipelineTab, 'details'>;
  history: TaskStatus[];
}) {
  return (
    <div className="space-y-4">
      <Stepper task={task} history={history} />
      {tab === 'activity' && <Activity taskId={task.id} />}
      {tab === 'changes' && <Changes taskId={task.id} />}
      {tab === 'checks' && <ReviewsAndTests taskId={task.id} />}
      {tab === 'report' && <Report taskId={task.id} />}
    </div>
  );
}

export { Stepper };
