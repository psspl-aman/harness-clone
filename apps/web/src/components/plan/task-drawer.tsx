'use client';

import {
  COMPLEXITIES,
  PRIORITIES,
  TASK_TYPES,
  type TaskDto,
  type TaskStatus,
  type UpdateTaskInput,
} from '@agentforge/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle2,
  GitFork,
  Link2,
  Loader2,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { EngineRoles } from '@/components/projects/engine-roles';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiClientError, qk } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { TaskStatusBadge, statusLabel } from './badges';
import { InstructionsDialog, SplitDialog } from './dialogs';

const EDITABLE: TaskStatus[] = [
  'DRAFT',
  'APPROVED',
  'BLOCKED',
  'NEEDS_HUMAN',
  'FAILED',
  'CANCELLED',
];
const errText = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));

function Field({
  label,
  children,
  htmlFor,
}: {
  label: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label
        htmlFor={htmlFor}
        className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
      >
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Editable list of strings, saved on blur / add / remove. */
function ListEditor({
  id,
  items,
  disabled,
  placeholder,
  onSave,
}: {
  id: string;
  items: string[];
  disabled: boolean;
  placeholder: string;
  onSave: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const [adding, setAdding] = useState('');
  const list = draft ?? items;
  const commit = (next: string[]) => {
    const clean = next.map((x) => x.trim()).filter(Boolean);
    setDraft(null);
    if (JSON.stringify(clean) !== JSON.stringify(items)) onSave(clean);
  };
  return (
    <div className="space-y-1.5" id={id}>
      {list.map((item, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <Check className="text-success mt-2 size-3.5 shrink-0" />
          <Textarea
            value={item}
            rows={1}
            disabled={disabled}
            aria-label={`${placeholder} ${i + 1}`}
            onChange={(e) => setDraft(list.map((x, j) => (j === i ? e.target.value : x)))}
            onBlur={() => draft && commit(draft)}
            className="min-h-8 resize-none py-1.5 text-sm"
          />
          {!disabled && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Remove"
              onClick={() => commit(list.filter((_, j) => j !== i))}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      ))}
      {!disabled && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (adding.trim()) {
              commit([...list, adding]);
              setAdding('');
            }
          }}
        >
          <Input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder={`Add ${placeholder.toLowerCase()}…`}
            className="h-8 text-sm"
            aria-label={`New ${placeholder}`}
          />
          <Button
            size="icon"
            variant="outline"
            className="size-8 shrink-0"
            type="submit"
            aria-label={`Add ${placeholder}`}
            disabled={!adding.trim()}
          >
            <Plus className="size-3.5" />
          </Button>
        </form>
      )}
    </div>
  );
}

function DependencyPicker({
  task,
  all,
  disabled,
}: {
  task: TaskDto;
  all: TaskDto[];
  disabled: boolean;
}) {
  const set = useMutation({
    mutationFn: (ids: string[]) => api.tasks.setDependencies(task.id, ids),
    onError: (e) => toast.error('Could not change dependencies', { description: errText(e) }),
  });
  const deps = all.filter((t) => task.dependsOn.includes(t.id));
  const candidates = all.filter((t) => t.id !== task.id && t.status !== 'CANCELLED');
  const toggle = (id: string) =>
    set.mutate(
      task.dependsOn.includes(id)
        ? task.dependsOn.filter((x) => x !== id)
        : [...task.dependsOn, id],
    );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {deps.length === 0 && (
        <span className="text-muted-foreground text-sm">None — can start right away</span>
      )}
      {deps.map((d) => (
        <span
          key={d.id}
          className="bg-muted flex items-center gap-1 rounded-md px-2 py-0.5 text-xs"
        >
          <span className="font-mono">{d.key}</span>{' '}
          <span className="max-w-40 truncate">{d.title}</span>
          {!disabled && (
            <button aria-label={`Remove dependency ${d.key}`} onClick={() => toggle(d.id)}>
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 text-xs">
              <Link2 className="size-3" /> Edit
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-1" align="start">
            <p className="text-muted-foreground px-2 py-1.5 text-xs">{task.key} can start after…</p>
            <div className="max-h-72 overflow-y-auto">
              {candidates.map((c) => (
                <label
                  key={c.id}
                  className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                >
                  <Checkbox
                    checked={task.dependsOn.includes(c.id)}
                    onCheckedChange={() => toggle(c.id)}
                    disabled={set.isPending}
                  />
                  <span className="font-mono text-xs">{c.key}</span>
                  <span className="truncate">{c.title}</span>
                </label>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

export function TaskDrawer({
  projectId,
  taskId,
  onClose,
}: {
  projectId: string;
  taskId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const board = useQuery({
    queryKey: qk.board(projectId),
    queryFn: () => api.board.get(projectId),
  });
  const chat = useQuery({ queryKey: qk.chat(projectId), queryFn: () => api.chat.list(projectId) });
  const task = board.data?.tasks.find((t) => t.id === taskId) ?? null;
  const history = useQuery({
    queryKey: qk.taskHistory(taskId ?? ''),
    queryFn: () => api.tasks.history(taskId!),
    enabled: !!taskId,
  });
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState<string | null>(null);
  const [newSub, setNewSub] = useState('');
  const [splitOpen, setSplitOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);

  const update = useMutation({
    mutationFn: (input: UpdateTaskInput) => api.tasks.update(taskId!, input),
    onError: (e) => toast.error('Could not save', { description: errText(e) }),
  });
  const action = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onError: (e) => toast.error('Action failed', { description: errText(e) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: qk.taskHistory(taskId ?? '') }),
  });

  const editable = !!task && EDITABLE.includes(task.status);
  const disabled = !editable;
  const requirement = task?.requirementId
    ? chat.data?.find((m) => m.id === task.requirementId)
    : undefined;

  return (
    <Sheet open={!!taskId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
        {!task ? (
          <SheetHeader>
            <SheetTitle>Task not found</SheetTitle>
            <SheetDescription>It may have been deleted or merged.</SheetDescription>
          </SheetHeader>
        ) : (
          <>
            <SheetHeader className="bg-background/95 sticky top-0 z-10 gap-2 border-b p-5 backdrop-blur">
              <div className="flex items-center gap-2 pr-8">
                <span className="text-muted-foreground font-mono text-xs">{task.key}</span>
                <TaskStatusBadge status={task.status} />
                {update.isPending && (
                  <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
                )}
              </div>
              <SheetTitle className="sr-only">{task.title}</SheetTitle>
              <SheetDescription className="sr-only">Edit task {task.key}</SheetDescription>
              <Textarea
                value={titleDraft ?? task.title}
                disabled={disabled}
                rows={1}
                aria-label="Title"
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => {
                  if (titleDraft !== null && titleDraft.trim() && titleDraft.trim() !== task.title)
                    update.mutate({ title: titleDraft.trim() });
                  setTitleDraft(null);
                }}
                className="min-h-0 resize-none border-none p-0 text-lg font-semibold shadow-none focus-visible:ring-0"
              />
              <div className="flex flex-wrap gap-2">
                {task.status === 'DRAFT' && (
                  <Button
                    size="sm"
                    onClick={() => action.mutate(() => api.tasks.approve(task.id))}
                    disabled={action.isPending}
                  >
                    <CheckCircle2 /> Approve
                  </Button>
                )}
                {task.status === 'APPROVED' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => action.mutate(() => api.tasks.unapprove(task.id))}
                    disabled={action.isPending}
                  >
                    <Undo2 /> Back to draft
                  </Button>
                )}
                {editable && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setRegenOpen(true)}>
                      <Sparkles /> Regenerate
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setSplitOpen(true)}>
                      <Scissors /> Split
                    </Button>
                  </>
                )}
                {['DRAFT', 'APPROVED', 'BLOCKED', 'CANCELLED'].includes(task.status) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive ml-auto"
                    onClick={() =>
                      action.mutate(async () => {
                        await api.tasks.remove(task.id);
                        toast.success(`Deleted ${task.key}`);
                        onClose();
                      })
                    }
                  >
                    <Trash2 /> Delete
                  </Button>
                )}
              </div>
              {!editable && (
                <p className="text-muted-foreground text-xs">
                  An agent is working on this task — editing is locked until it finishes or is
                  paused.
                </p>
              )}
            </SheetHeader>

            <div className="space-y-6 p-5">
              <div className="grid grid-cols-3 gap-3">
                {(
                  [
                    ['Type', 'type', TASK_TYPES],
                    ['Priority', 'priority', PRIORITIES],
                    ['Complexity', 'complexity', COMPLEXITIES],
                  ] as const
                ).map(([label, key, options]) => (
                  <Field key={key} label={label} htmlFor={`task-${key}`}>
                    <Select
                      value={task[key]}
                      disabled={disabled}
                      onValueChange={(v) => update.mutate({ [key]: v } as UpdateTaskInput)}
                    >
                      <SelectTrigger id={`task-${key}`} size="sm" className="w-full capitalize">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((o) => (
                          <SelectItem key={o} value={o} className="capitalize">
                            {key === 'complexity' ? o.toUpperCase() : o}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ))}
              </div>

              <Field label="Description" htmlFor="task-desc">
                <Textarea
                  id="task-desc"
                  value={descDraft ?? task.description}
                  disabled={disabled}
                  rows={8}
                  onChange={(e) => setDescDraft(e.target.value)}
                  onBlur={() => {
                    if (descDraft !== null && descDraft !== task.description)
                      update.mutate({ description: descDraft });
                    setDescDraft(null);
                  }}
                  className="text-sm"
                />
              </Field>

              <Field label="Acceptance criteria" htmlFor="task-ac">
                <ListEditor
                  key={`ac-${task.updatedAt}`}
                  id="task-ac"
                  items={task.acceptanceCriteria}
                  disabled={disabled}
                  placeholder="Criterion"
                  onSave={(v) => update.mutate({ acceptanceCriteria: v })}
                />
              </Field>

              <Field label="Depends on">
                <DependencyPicker task={task} all={board.data?.tasks ?? []} disabled={disabled} />
              </Field>

              <Field label="Subtasks">
                <div className="space-y-1">
                  {task.subtasks.map((s) => (
                    <div key={s.id} className="group flex items-center gap-2">
                      <Checkbox
                        checked={s.done}
                        aria-label={s.title}
                        onCheckedChange={(v) =>
                          action.mutate(() => api.tasks.updateSubtask(s.id, { done: v === true }))
                        }
                      />
                      <span
                        className={
                          s.done ? 'text-muted-foreground text-sm line-through' : 'text-sm'
                        }
                      >
                        {s.title}
                      </span>
                      {editable && (
                        <button
                          className="text-muted-foreground hover:text-foreground ml-auto opacity-0 group-hover:opacity-100"
                          aria-label={`Remove subtask ${s.title}`}
                          onClick={() => action.mutate(() => api.tasks.removeSubtask(s.id))}
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                  {editable && (
                    <form
                      className="flex gap-1.5 pt-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (newSub.trim())
                          action.mutate(() =>
                            api.tasks.addSubtask(task.id, newSub.trim()).then(() => setNewSub('')),
                          );
                      }}
                    >
                      <Input
                        value={newSub}
                        onChange={(e) => setNewSub(e.target.value)}
                        placeholder="Add subtask…"
                        className="h-8 text-sm"
                        aria-label="New subtask"
                      />
                    </form>
                  )}
                </div>
              </Field>

              <Field label="Affected areas" htmlFor="task-areas">
                <ListEditor
                  key={`aa-${task.updatedAt}`}
                  id="task-areas"
                  items={task.affectedAreas}
                  disabled={disabled}
                  placeholder="Area"
                  onSave={(v) => update.mutate({ affectedAreas: v })}
                />
              </Field>

              <Field label="Agent engines">
                <EngineRoles
                  value={task.roleEngines}
                  onChange={(v) => update.mutate({ roleEngines: v })}
                />
              </Field>

              {requirement && (
                <Field label="From requirement">
                  <div className="bg-muted/50 rounded-lg border p-3 text-sm">
                    <p className="line-clamp-4 whitespace-pre-wrap">{requirement.content}</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      <GitFork className="mr-1 inline size-3" />
                      {timeAgo(requirement.createdAt)}
                      {requirement.version > 1 ? ` · v${requirement.version}` : ''}
                    </p>
                  </div>
                </Field>
              )}

              <Field label="History">
                <ol className="border-muted space-y-2 border-l pl-4">
                  {(history.data ?? []).map((h, i) => (
                    <li key={i} className="relative text-sm">
                      <span className="bg-primary absolute top-1.5 -left-[21px] size-2 rounded-full" />
                      <span className="font-medium">
                        {h.from
                          ? `${statusLabel(h.from)} → ${statusLabel(h.to)}`
                          : statusLabel(h.to)}
                      </span>
                      <span className="text-muted-foreground">
                        {' '}
                        · {h.reason ?? h.actor} · {timeAgo(h.createdAt)}
                      </span>
                    </li>
                  ))}
                </ol>
              </Field>
            </div>

            {splitOpen && (
              <SplitDialog
                task={task}
                open={splitOpen}
                onOpenChange={setSplitOpen}
                onSubmit={(parts) =>
                  action.mutate(() =>
                    api.tasks
                      .split(task.id, parts)
                      .then(() => toast.success(`Split ${task.key} into ${parts.length} tasks`)),
                  )
                }
              />
            )}
            {regenOpen && (
              <InstructionsDialog
                open={regenOpen}
                onOpenChange={setRegenOpen}
                title={`Regenerate ${task.key}`}
                description="The Planner rewrites this task with your instructions. Watch progress in the chat."
                placeholder="e.g. Split the API and UI work, use Zod for validation…"
                confirm="Regenerate"
                onSubmit={(instructions) =>
                  action.mutate(() => api.tasks.regenerate(task.id, instructions))
                }
              />
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
