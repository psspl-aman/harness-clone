'use client';

import { planRemaining, spentNow, type PlanDto, type TaskDto } from '@ai-harness/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  CheckCircle2,
  ChevronDown,
  Clock,
  Columns3,
  ListTree,
  Merge,
  Network,
  Pencil,
  Plus,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiClientError, qk } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AddTaskDialog, EditPlanDialog, InstructionsDialog } from './dialogs';
import { TaskDrawer } from './task-drawer';
import { fmtMinutes } from './task-time';
import { useNow } from '@/hooks/use-now';
import { PipelineBar } from './pipeline-bits';
import { TaskBoard, TaskGraph, TaskList } from './task-views';

type View = 'list' | 'board' | 'graph';
const errText = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));

/** Time left to build the plan: dependency chains run in order, up to N tasks at once. */
function PlanEta({ projectId, tasks }: { projectId: string; tasks: TaskDto[] }) {
  const status = useQuery({
    queryKey: qk.pipeline(projectId),
    queryFn: () => api.pipeline.status(projectId),
  });
  const now = useNow(
    30_000,
    tasks.some((t) => !!t.timing.runningSince),
  );
  const parallel = status.data?.limit ?? 1;
  const { workMs, etaMs } = planRemaining(tasks, parallel, now);
  const spent = tasks.reduce((s, t) => s + spentNow(t.timing, now), 0);
  if (!workMs && !spent) return null;
  return (
    <span
      className="text-muted-foreground inline-flex items-center gap-1 text-xs"
      title={`About ${fmtMinutes(workMs)} of agent work left; dependencies run in order and up to ${parallel} task${parallel === 1 ? '' : 's'} build at once. Agents have spent ${fmtMinutes(spent)} so far.`}
    >
      <Clock className="size-3" aria-hidden />
      {workMs ? `≈ ${fmtMinutes(etaMs)} left` : 'all done'}
      {spent > 0 && ` · ${fmtMinutes(spent)} spent`}
    </span>
  );
}

function PlanSummary({ plan, tasks }: { plan: PlanDto; tasks: TaskDto[] }) {
  const [open, setOpen] = useState(false);
  const approved = tasks.filter((t) => t.status !== 'DRAFT').length;
  const details = [
    ['Scope', plan.scope],
    ['Out of scope', plan.outOfScope],
    ['Architecture notes', plan.architectureNotes],
  ].filter(([, v]) => v);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Plan v{plan.version}</h2>
        <Badge variant={plan.status === 'APPROVED' ? 'default' : 'secondary'}>
          {plan.status === 'APPROVED' ? 'Approved' : 'Draft — needs your review'}
        </Badge>
        <span className="text-muted-foreground text-xs">
          {approved}/{tasks.length} approved · {timeAgo(plan.updatedAt)}
        </span>
        <PlanEta projectId={plan.projectId} tasks={tasks} />
      </div>
      <p className="text-sm">{plan.goal}</p>
      {(details.length > 0 || plan.risks.length > 0 || plan.assumptions.length > 0) && (
        <>
          <button
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />{' '}
            Scope, architecture, risks & assumptions
          </button>
          {open && (
            <div className="bg-muted/40 grid gap-4 rounded-xl border p-4 md:grid-cols-2">
              {details.map(([k, v]) => (
                <div key={k}>
                  <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
                    {k}
                  </p>
                  <Markdown>{v!}</Markdown>
                </div>
              ))}
              {[
                ['Risks', plan.risks],
                ['Assumptions', plan.assumptions],
              ].map(([k, list]) =>
                (list as string[]).length ? (
                  <div key={k as string}>
                    <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
                      {k as string}
                    </p>
                    <ul className="list-disc space-y-0.5 pl-4 text-sm">
                      {(list as string[]).map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </div>
                ) : null,
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function PlanTab({
  projectId,
  openTaskId,
  onOpenTask,
}: {
  projectId: string;
  openTaskId: string | null;
  onOpenTask: (id: string | null) => void;
}) {
  const board = useQuery({
    queryKey: qk.board(projectId),
    queryFn: () => api.board.get(projectId),
  });
  const planner = useQuery({
    queryKey: qk.planner(projectId),
    queryFn: () => api.chat.planner(projectId),
  });
  const [view, setView] = useState<View>('list');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<'edit' | 'regen' | 'add' | null>(null);
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onError: (e) => toast.error('Action failed', { description: errText(e) }),
  });

  if (board.isPending) return <Skeleton className="m-6 h-64 rounded-xl" />;
  const plan = board.data?.plans[0] ?? null;
  const tasks = (board.data?.tasks ?? []).filter((t) => t.status !== 'CANCELLED');
  const cancelled = (board.data?.tasks ?? []).filter((t) => t.status === 'CANCELLED');
  const drafts = tasks.filter((t) => t.status === 'DRAFT');
  const busy = planner.data?.running ?? false;
  const sel = [...selected].filter((id) => tasks.some((t) => t.id === id));
  const toggle = (id: string) =>
    setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  // Cancelled tasks are out of the plan but stay visible so they can be resumed or restarted.
  const visible = [...tasks, ...cancelled];
  const viewProps = {
    tasks: visible,
    selected,
    onToggleSelect: toggle,
    onOpen: (id: string) => onOpenTask(id),
    onApprove: (id: string) => act.mutate(() => api.tasks.approve(id)),
  };

  if (!plan && !tasks.length && !cancelled.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <div className="bg-accent text-accent-foreground grid size-12 place-items-center rounded-xl">
          <Sparkles className="size-6" />
        </div>
        <h2 className="font-semibold">No plan yet</h2>
        <p className="text-muted-foreground max-w-sm text-sm">
          {busy
            ? 'The Planner is working on it — follow along in the chat.'
            : 'Describe what you want in the chat. The Planner drafts a plan and tasks for you to review, edit and approve.'}
        </p>
      </div>
    );
  }

  return (
    <div className="portal-content space-y-4 py-4">
      <div className="bg-card flex flex-wrap items-start justify-between gap-4 rounded-xl border p-3.5 shadow-xs">
        <div className="min-w-0 flex-1">
          {plan ? (
            <PlanSummary plan={plan} tasks={tasks.filter((t) => t.planId === plan.id)} />
          ) : (
            <h2 className="text-lg font-semibold">Tasks</h2>
          )}
        </div>
        {plan && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setDialog('edit')}>
              <Pencil /> Edit plan
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialog('regen')}
              disabled={busy || tasks.some((t) => t.planId === plan.id && t.status !== 'DRAFT')}
              title="Only drafts can be regenerated"
            >
              <Sparkles /> Regenerate
            </Button>
            <Button
              size="sm"
              disabled={!drafts.length || act.isPending}
              onClick={() =>
                act.mutate(() =>
                  api.plans
                    .approve(plan.id)
                    .then(() =>
                      toast.success(
                        `Approved ${drafts.length} task${drafts.length === 1 ? '' : 's'}`,
                        { description: 'They will be built once the orchestrator picks them up.' },
                      ),
                    ),
                )
              }
            >
              <CheckCircle2 /> Approve all{drafts.length ? ` (${drafts.length})` : ''}
            </Button>
          </div>
        )}
      </div>

      <PipelineBar projectId={projectId} tasks={tasks} />

      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Task view"
          className="bg-muted flex rounded-md border p-0.5"
        >
          {(
            [
              ['list', 'List', ListTree],
              ['board', 'Board', Columns3],
              ['graph', 'Graph', Network],
            ] as const
          ).map(([v, label, Icon]) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
                view === v ? 'bg-card shadow-xs' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" /> {label}
            </button>
          ))}
        </div>
        {sel.length > 0 && (
          <div className="bg-accent/60 flex items-center gap-2 rounded-lg px-2 py-1 text-xs">
            <span className="font-medium">{sel.length} selected</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              disabled={!plan || !sel.some((id) => drafts.some((d) => d.id === id))}
              onClick={() =>
                plan &&
                act.mutate(() =>
                  api.plans
                    .approve(
                      plan.id,
                      sel.filter((id) => drafts.some((d) => d.id === id)),
                    )
                    .then(() => setSelected(new Set())),
                )
              }
            >
              <CheckCircle2 className="size-3" /> Approve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              disabled={sel.length < 2}
              onClick={() =>
                act.mutate(() =>
                  api.tasks.merge(sel).then((t) => {
                    setSelected(new Set());
                    toast.success(`Merged into ${t.key}`);
                  }),
                )
              }
            >
              <Merge className="size-3" /> Merge
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </div>
        )}
        {plan && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setDialog('add')}>
            <Plus /> Add task
          </Button>
        )}
      </div>

      {view === 'list' && (
        <TaskList
          {...viewProps}
          onReorder={(ids) => act.mutate(() => api.board.reorder(projectId, ids))}
        />
      )}
      {view === 'board' && (
        <TaskBoard {...viewProps} onUnapprove={(id) => act.mutate(() => api.tasks.unapprove(id))} />
      )}
      {view === 'graph' && <TaskGraph {...viewProps} tasks={tasks} />}

      <TaskDrawer projectId={projectId} taskId={openTaskId} onClose={() => onOpenTask(null)} />
      {plan && dialog === 'edit' && (
        <EditPlanDialog
          plan={plan}
          open
          onOpenChange={(o) => !o && setDialog(null)}
          onSubmit={(v) => act.mutate(() => api.plans.update(plan.id, v))}
        />
      )}
      {plan && dialog === 'regen' && (
        <InstructionsDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          title={`Regenerate plan v${plan.version}`}
          description="The Planner drafts the plan again (replacing these drafts). Follow progress in the chat."
          placeholder="e.g. Fewer, larger tasks; use PostgreSQL instead of SQLite…"
          confirm="Regenerate plan"
          onSubmit={(instructions) => act.mutate(() => api.plans.regenerate(plan.id, instructions))}
        />
      )}
      {plan && dialog === 'add' && (
        <AddTaskDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          onSubmit={(v) =>
            act.mutate(() => api.plans.addTask(plan.id, v).then((t) => onOpenTask(t.id)))
          }
        />
      )}
    </div>
  );
}
