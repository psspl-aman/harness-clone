'use client';

import type { ErrorDto, TerminalInfo } from '@ai-harness/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  Bug,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  EyeOff,
  Plus,
  RotateCcw,
  SquareTerminal,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { TaskStatusBadge } from '@/components/plan/badges';
import { XtermView } from '@/components/terminal/xterm-view';
import { Button } from '@/components/ui/button';
import { api, ApiClientError, qk } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AgentsPane } from './agents-pane';
import { useWorkspaceUi, type PanelTab } from './store';

const fail = (title: string) => (e: unknown) =>
  toast.error(title, { description: e instanceof ApiClientError ? e.message : String(e) });

export function useProjectErrors(projectId: string) {
  return useQuery({ queryKey: qk.errors(projectId), queryFn: () => api.runtime.errors(projectId) });
}

/** Collapsible bottom panel of the project workspace: terminals, detected errors and activity. */
export function BottomPanel({
  projectId,
  onOpenTask,
  onOpenFile,
}: {
  projectId: string;
  onOpenTask: (taskId: string) => void;
  onOpenFile: (path: string, line: number | null) => void;
}) {
  const { panelOpen, panelTab, panelHeight, setPanel } = useWorkspaceUi();
  const errors = useProjectErrors(projectId);
  const openErrors = (errors.data ?? []).filter((e) => e.status === 'open').length;
  const drag = useRef<{ y: number; h: number } | null>(null);

  const tabs: { id: PanelTab; label: string; icon: typeof Bug; count?: number }[] = [
    { id: 'agents', label: 'Agents', icon: Bot },
    { id: 'terminals', label: 'Terminals', icon: SquareTerminal },
    { id: 'errors', label: 'Errors', icon: Bug, count: openErrors },
    { id: 'activity', label: 'Activity', icon: Activity },
  ];

  return (
    <div
      className="bg-card flex shrink-0 flex-col border-t"
      style={{ height: panelOpen ? panelHeight : undefined }}
    >
      {panelOpen && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize panel"
          className="hover:bg-primary/40 -mt-1 h-1 cursor-row-resize"
          onPointerDown={(e) => {
            drag.current = { y: e.clientY, h: panelHeight };
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const h = drag.current.h + (drag.current.y - e.clientY);
            setPanel({ panelHeight: Math.min(Math.max(h, 160), window.innerHeight * 0.75) });
          }}
          onPointerUp={() => (drag.current = null)}
        />
      )}
      <div
        className="flex items-center gap-1 overflow-x-auto px-2"
        role="tablist"
        aria-label="Bottom panel"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={panelOpen && panelTab === t.id}
            onClick={() =>
              setPanel(
                panelOpen && panelTab === t.id
                  ? { panelOpen: false }
                  : { panelOpen: true, panelTab: t.id },
              )
            }
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium whitespace-nowrap',
              panelOpen && panelTab === t.id
                ? 'text-foreground bg-accent'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <t.icon className="size-3.5" /> {t.label}
            {!!t.count && (
              <span
                className="bg-destructive rounded-full px-1.5 text-[10px] leading-4 font-semibold text-white"
                data-testid="errors-count"
              >
                {t.count}
              </span>
            )}
          </button>
        ))}
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto size-7"
          aria-label={panelOpen ? 'Collapse panel' : 'Expand panel'}
          onClick={() => setPanel({ panelOpen: !panelOpen })}
        >
          {panelOpen ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
        </Button>
      </div>
      {panelOpen && (
        <div className="min-h-0 flex-1 border-t">
          {panelTab === 'agents' && <AgentsPane projectId={projectId} />}
          {panelTab === 'terminals' && <TerminalsPane projectId={projectId} />}
          {panelTab === 'errors' && (
            <ErrorsPane
              errors={errors.data ?? []}
              loading={errors.isPending}
              onOpenTask={onOpenTask}
              onOpenFile={onOpenFile}
            />
          )}
          {panelTab === 'activity' && (
            <ActivityPane projectId={projectId} onOpenTask={onOpenTask} />
          )}
        </div>
      )}
    </div>
  );
}

function TerminalsPane({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { terminalId, setPanel } = useWorkspaceUi();
  const list = useQuery({
    queryKey: qk.terminals(projectId),
    queryFn: () => api.terminals.list(projectId),
  });
  const terms = (list.data ?? []).filter((t) => t.kind !== 'login');
  const active = terms.find((t) => t.id === terminalId) ?? terms.at(-1) ?? null;
  const create = useMutation({
    mutationFn: () => api.runtime.shell(projectId),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: qk.terminals(projectId) });
      setPanel({ terminalId: t.id });
    },
    onError: fail('Could not open a terminal'),
  });
  const close = useMutation({
    mutationFn: async (t: TerminalInfo) => {
      if (t.status === 'running') await api.terminals.kill(t.id);
      await api.terminals.remove(t.id);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.terminals(projectId) }),
    onError: fail('Could not close the terminal'),
  });

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-48 shrink-0 flex-col border-r">
        <div className="min-h-0 flex-1 overflow-auto p-1">
          {terms.map((t) => (
            <div
              key={t.id}
              className={cn(
                'group flex items-center gap-1.5 rounded px-2 py-1 text-xs',
                active?.id === t.id ? 'bg-accent' : 'hover:bg-accent/50',
              )}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => setPanel({ terminalId: t.id })}
                title={
                  t.status === 'running'
                    ? `${t.title} — running`
                    : `${t.title} — exited${t.exitCode !== null ? ` (${t.exitCode})` : ''}`
                }
              >
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    t.status === 'running'
                      ? 'bg-success'
                      : t.exitCode === 0
                        ? 'bg-muted-foreground/40'
                        : 'bg-destructive',
                  )}
                  aria-hidden
                />
                <span className="truncate">{t.title}</span>
              </button>
              <button
                className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={`Close ${t.title}`}
                onClick={() => close.mutate(t)}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          {!list.isPending && !terms.length && (
            <p className="text-muted-foreground p-2 text-xs">No terminals yet.</p>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="m-1 justify-start text-xs"
          onClick={() => create.mutate()}
          disabled={create.isPending}
        >
          <Plus /> New terminal
        </Button>
      </div>
      <div className="min-w-0 flex-1 p-1">
        {active ? (
          <XtermView
            key={active.id}
            terminalId={active.id}
            className="h-full rounded-md border-0"
          />
        ) : (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            Open a terminal in the project folder, or run the project.
          </div>
        )}
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  run: 'Run',
  terminal: 'Terminal',
  task: 'Pipeline',
  build: 'Build',
  test: 'Tests',
  browser: 'Browser',
};

function ErrorsPane({
  errors,
  loading,
  onOpenTask,
  onOpenFile,
}: {
  errors: ErrorDto[];
  loading: boolean;
  onOpenTask: (taskId: string) => void;
  onOpenFile: (path: string, line: number | null) => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const visible = errors.filter((e) => showClosed || e.status === 'open' || e.status === 'fixing');
  const hidden = errors.length - visible.length;
  if (loading) return <div className="text-muted-foreground p-4 text-sm">Loading…</div>;
  return (
    <div className="h-full overflow-auto">
      {visible.length === 0 ? (
        <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 p-6 text-sm">
          <CheckCircle2 className="text-success size-5" />
          No open errors. AI Harness watches run output, terminals and the pipeline.
          {hidden > 0 && (
            <button className="text-primary text-xs underline" onClick={() => setShowClosed(true)}>
              Show {hidden} resolved or ignored
            </button>
          )}
        </div>
      ) : (
        <ul className="divide-y" data-testid="errors-list">
          {visible.map((e) => (
            <ErrorRow key={e.id} error={e} onOpenTask={onOpenTask} onOpenFile={onOpenFile} />
          ))}
          {hidden > 0 && !showClosed && (
            <li className="p-2 text-center">
              <button
                className="text-primary text-xs underline"
                onClick={() => setShowClosed(true)}
              >
                Show {hidden} resolved or ignored
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function ErrorRow({
  error: e,
  onOpenTask,
  onOpenFile,
}: {
  error: ErrorDto;
  onOpenTask: (taskId: string) => void;
  onOpenFile: (path: string, line: number | null) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const act = useMutation({
    mutationFn: (a: 'fix' | 'ignore' | 'reopen' | 'resolve') => api.runtime.errorAction(e.id, a),
    onSuccess: (x, a) => {
      qc.setQueryData<ErrorDto[]>(qk.errors(x.projectId), (l) =>
        l?.map((y) => (y.id === x.id ? x : y)),
      );
      if (a === 'fix')
        toast.success('Fix task created', { description: 'It runs Fix → Review → Test.' });
    },
    onError: fail('Could not update the error'),
  });
  const closed = e.status === 'resolved' || e.status === 'ignored';
  const where = e.filePath ? `${e.filePath}${e.line ? `:${e.line}` : ''}` : null;
  return (
    <li className={cn('px-3 py-2', closed && 'opacity-60')}>
      <div className="flex items-start gap-2">
        <CircleAlert
          className={cn(
            'mt-0.5 size-4 shrink-0',
            closed ? 'text-muted-foreground' : 'text-destructive',
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <button
            className="block w-full text-left"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            <span className="line-clamp-2 font-mono text-xs break-all">{e.message}</span>
          </button>
          <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px]">
            <span>{SOURCE_LABEL[e.source] ?? e.source}</span>
            {where && (
              <button
                className="hover:text-foreground font-mono underline-offset-2 hover:underline"
                onClick={() => onOpenFile(e.filePath!, e.line)}
              >
                {where}
              </button>
            )}
            <span>
              {e.occurrences}× · {timeAgo(e.lastSeenAt)}
            </span>
            {e.status === 'fixing' && e.fixTaskId && (
              <button
                className="text-primary hover:underline"
                onClick={() => onOpenTask(e.fixTaskId!)}
              >
                Fixing — view task
              </button>
            )}
            {e.status === 'resolved' && <span>Resolved</span>}
            {e.status === 'ignored' && <span>Ignored</span>}
            {e.source === 'task' && e.taskId && (
              <button
                className="hover:text-foreground hover:underline"
                onClick={() => onOpenTask(e.taskId!)}
              >
                Open task
              </button>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {e.status === 'open' && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={act.isPending}
                onClick={() => act.mutate('fix')}
              >
                <Wand2 /> Fix with agent
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                title="Ignore"
                aria-label="Ignore"
                disabled={act.isPending}
                onClick={() => act.mutate('ignore')}
              >
                <EyeOff className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                title="Mark resolved"
                aria-label="Mark resolved"
                disabled={act.isPending}
                onClick={() => act.mutate('resolve')}
              >
                <CheckCircle2 className="size-3.5" />
              </Button>
            </>
          )}
          {closed && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={act.isPending}
              onClick={() => act.mutate('reopen')}
            >
              <RotateCcw /> Reopen
            </Button>
          )}
        </div>
      </div>
      {open && e.excerpt && (
        <pre className="bg-muted mt-2 max-h-48 overflow-auto rounded p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {e.excerpt}
        </pre>
      )}
    </li>
  );
}

function ActivityPane({
  projectId,
  onOpenTask,
}: {
  projectId: string;
  onOpenTask: (id: string) => void;
}) {
  const q = useQuery({
    queryKey: qk.activity(projectId),
    queryFn: () => api.runtime.activity(projectId),
  });
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (q.isPending) return <div className="text-muted-foreground p-4 text-sm">Loading…</div>;
  if (!q.data?.length)
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-sm">
        Task activity shows up here once the pipeline starts working.
      </div>
    );
  return (
    <ul className="h-full divide-y overflow-auto" data-testid="activity-list">
      {q.data.map((a) => (
        <li key={a.id}>
          <button
            className="hover:bg-accent/40 flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs"
            onClick={() => onOpenTask(a.taskId)}
          >
            <span className="text-muted-foreground w-16 shrink-0 tabular-nums">
              {timeAgo(a.createdAt)}
            </span>
            <TaskStatusBadge status={a.to} className="shrink-0" />
            <span className="shrink-0 font-mono font-medium">{a.taskKey}</span>
            <span className="truncate">{a.taskTitle}</span>
            {a.reason && (
              <span className="text-muted-foreground ml-auto max-w-[40%] truncate">{a.reason}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
