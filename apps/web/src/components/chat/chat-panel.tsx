'use client';

import type { ChatMessageDto, TaskDto } from '@agentforge/shared';
import { describeEvent } from '@/lib/agent-events';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CircleStop,
  FileCode2,
  Hash,
  ListChecks,
  Loader2,
  Paperclip,
  Pencil,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLiveEvent, useLiveTopic } from '@/components/live-provider';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useNow } from '@/hooks/use-now';
import { api, qk } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { EnvKeysStrip } from './env-keys';
import { SheetTasksStrip } from './sheet-tasks';
import { Composer, type ComposerDraft } from './composer';

const INTENT_LABEL = {
  generate_plan: 'Plan',
  add_to_plan: 'Add tasks',
  discuss: 'Discuss',
} as const;

function PlannerAvatar() {
  return (
    <div
      className="from-primary to-chart-2 text-primary-foreground grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br shadow-xs"
      aria-hidden
    >
      <Sparkles className="size-3.5" />
    </div>
  );
}

/** Live view of the running planner: elapsed time, recent steps, cancel. */
function PlannerThinking({
  projectId,
  runId,
  startedAt,
}: {
  projectId: string;
  runId: string | null;
  startedAt: number | null;
}) {
  const [steps, setSteps] = useState<string[]>([]);
  const now = useNow(1000);
  useLiveTopic(runId ? `run:${runId}` : null);
  useLiveEvent((e) => {
    if (e.type === 'run.event' && e.payload.runId === runId) {
      const d = describeEvent(e.payload.event);
      if (d) setSteps((s) => (s.at(-1) === d ? s : [...s.slice(-5), d]));
    }
  });
  const cancel = useMutation({ mutationFn: () => api.chat.cancel(projectId) });
  const elapsed = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  return (
    <div className="flex gap-2.5" role="status" aria-label="Planner is working">
      <PlannerAvatar />
      <div className="bg-muted/50 min-w-0 flex-1 rounded-xl rounded-tl-sm border px-3 py-2.5">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="text-primary size-3.5 animate-spin" />
          <span className="font-medium">Planner is working</span>
          <span className="text-muted-foreground tabular-nums text-xs">{elapsed}s</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-xs"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
          >
            <CircleStop className="size-3" /> Stop
          </Button>
        </div>
        {steps.length > 0 && (
          <ul className="text-muted-foreground mt-1.5 space-y-0.5 font-mono text-[11px]">
            {steps.map((s, i) => (
              <li key={i} className={cn('truncate', i === steps.length - 1 && 'text-foreground')}>
                {s}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface MessageProps {
  m: ChatMessageDto;
  tasks: TaskDto[];
  onDraft: (d: ComposerDraft) => void;
  onOpenPlan: () => void;
  onOpenTask: (id: string) => void;
  previousUser: ChatMessageDto | undefined;
}

function Message({ m, tasks, onDraft, onOpenPlan, onOpenTask, previousUser }: MessageProps) {
  if (m.author === 'system') {
    return <p className="text-muted-foreground px-6 text-center text-xs">{m.content}</p>;
  }
  if (m.author === 'user') {
    const produced = tasks.filter((t) => m.producedTaskIds.includes(t.id));
    return (
      <div className={cn('group flex flex-col items-end gap-1', m.supersededBy && 'opacity-50')}>
        <div className="bg-primary/10 max-w-[90%] rounded-xl rounded-tr-sm px-3 py-2">
          <Markdown>{m.content}</Markdown>
          {(m.attachments.length > 0 ||
            m.references.files.length > 0 ||
            m.references.tasks.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {m.attachments.map((a) => (
                <span
                  key={a.id}
                  className="bg-background/70 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
                >
                  <Paperclip className="size-3" /> {a.name}
                </span>
              ))}
              {m.references.files.map((f) => (
                <span
                  key={f}
                  className="bg-background/70 flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]"
                >
                  <FileCode2 className="size-3" /> {f}
                </span>
              ))}
              {m.references.tasks.map((k) => (
                <span
                  key={k}
                  className="bg-background/70 flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]"
                >
                  <Hash className="size-3" /> {k}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
          {m.intent && <span>{INTENT_LABEL[m.intent]}</span>}
          {m.version > 1 && <span>· v{m.version}</span>}
          {m.supersededBy && <span>· edited</span>}
          <span>· {timeAgo(m.createdAt)}</span>
          {!m.supersededBy && (
            <button
              className="hover:text-foreground opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              onClick={() =>
                onDraft({ content: m.content, intent: m.intent ?? undefined, supersedesId: m.id })
              }
              aria-label="Edit requirement"
            >
              <Pencil className="size-3" />
            </button>
          )}
        </div>
        {produced.length > 0 && (
          <div className="flex max-w-[90%] flex-wrap justify-end gap-1">
            {produced.map((t) => (
              <button
                key={t.id}
                onClick={() => onOpenTask(t.id)}
                className="hover:border-primary/40 rounded border px-1.5 py-0.5 font-mono text-[10px]"
                title={t.title}
              >
                {t.key}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  // Planner
  return (
    <div className="flex gap-2.5">
      <PlannerAvatar />
      <div className="min-w-0 flex-1 space-y-2">
        {m.kind === 'error' ? (
          <div
            className={cn(
              'rounded-xl rounded-tl-sm border px-3 py-2.5',
              m.status === 'cancelled' ? 'bg-muted/40' : 'border-destructive/25 bg-destructive/5',
            )}
          >
            <div className="flex items-start gap-2">
              {m.status !== 'cancelled' && (
                <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
              )}
              <Markdown className="min-w-0 flex-1">{m.content}</Markdown>
            </div>
            {previousUser && (
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-7"
                onClick={() =>
                  onDraft({
                    content: previousUser.content,
                    intent: previousUser.intent ?? undefined,
                  })
                }
              >
                <RotateCcw className="size-3" /> Try again
              </Button>
            )}
          </div>
        ) : (
          <div className="bg-card rounded-xl rounded-tl-sm border px-3 py-2.5 shadow-xs">
            <Markdown>{m.content}</Markdown>
            {m.kind === 'questions' && m.questions && (
              <div className="mt-3 space-y-3">
                {m.questions.map((q, i) => (
                  <div key={i} className="space-y-1.5">
                    <p className="text-sm font-medium">
                      {i + 1}. {q.question}
                    </p>
                    {q.why && <p className="text-muted-foreground text-xs">{q.why}</p>}
                    {q.options && (
                      <div className="flex flex-wrap gap-1.5">
                        {q.options.map((o) => (
                          <button
                            key={o}
                            onClick={() =>
                              onDraft({ content: `${q.question}\n→ ${o}`, intent: 'generate_plan' })
                            }
                            className="hover:border-primary/50 hover:bg-accent rounded-full border px-2.5 py-0.5 text-xs"
                          >
                            {o}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() =>
                    onDraft({
                      content: 'Go ahead and plan with your best assumptions.',
                      intent: 'generate_plan',
                      skipQuestions: true,
                    })
                  }
                >
                  Skip questions — plan with assumptions
                </Button>
              </div>
            )}
            {m.kind === 'plan' && (
              <Button size="sm" className="mt-2.5 h-7" onClick={onOpenPlan}>
                <ListChecks className="size-3.5" /> Review plan
              </Button>
            )}
          </div>
        )}
        <p className="text-muted-foreground text-[11px]">{timeAgo(m.createdAt)}</p>
      </div>
    </div>
  );
}

export function ChatPanel({
  projectId,
  onOpenPlan,
  onOpenTask,
}: {
  projectId: string;
  onOpenPlan: () => void;
  onOpenTask: (id: string) => void;
}) {
  const messages = useQuery({
    queryKey: qk.chat(projectId),
    queryFn: () => api.chat.list(projectId),
  });
  const planner = useQuery({
    queryKey: qk.planner(projectId),
    queryFn: () => api.chat.planner(projectId),
  });
  const board = useQuery({
    queryKey: qk.board(projectId),
    queryFn: () => api.board.get(projectId),
  });
  const [draft, setDraft] = useState<{ n: number; d: ComposerDraft | null }>({ n: 0, d: null });
  const scroller = useRef<HTMLDivElement>(null);
  const list = messages.data ?? [];
  const running = planner.data?.running ?? false;
  const count = list.length;
  const lastContent = list.at(-1)?.content;

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [count, lastContent, running]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scroller}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
        aria-live="polite"
      >
        {messages.isPending ? (
          <div className="space-y-3">
            <Skeleton className="ml-auto h-16 w-3/4 rounded-xl" />
            <Skeleton className="h-24 w-4/5 rounded-xl" />
          </div>
        ) : list.length === 0 ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm">
            <PlannerAvatar />
            <p className="text-foreground font-medium">Tell the Planner what to build</p>
            <p>
              Describe the feature or product. The Planner drafts a plan and tasks — you review and
              approve before anything is built.
            </p>
            <p className="text-xs">
              Have a task list already? Use the spreadsheet button below to import a Google Sheet or
              Excel file — agents work through the rows one by one, highest priority first.
            </p>
          </div>
        ) : (
          list.map((m, i) =>
            m.author === 'planner' && m.status === 'running' ? (
              <PlannerThinking
                key={m.id}
                projectId={projectId}
                runId={m.runId ?? planner.data?.runId ?? null}
                startedAt={planner.data?.startedAt ?? m.createdAt}
              />
            ) : (
              <Message
                key={m.id}
                m={m}
                tasks={board.data?.tasks ?? []}
                onDraft={(d) => setDraft((x) => ({ n: x.n + 1, d }))}
                onOpenPlan={onOpenPlan}
                onOpenTask={onOpenTask}
                previousUser={
                  m.kind === 'error'
                    ? list
                        .slice(0, i)
                        .reverse()
                        .find((x) => x.author === 'user')
                    : undefined
                }
              />
            ),
          )
        )}
      </div>
      <EnvKeysStrip projectId={projectId} />
      <SheetTasksStrip projectId={projectId} tasks={board.data?.tasks ?? []} />
      <Composer
        key={draft.n}
        projectId={projectId}
        hasPlan={(board.data?.plans.length ?? 0) > 0}
        busy={running}
        initial={draft.d}
      />
    </div>
  );
}
