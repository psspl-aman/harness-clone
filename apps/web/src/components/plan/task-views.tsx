'use client';

import type { TaskDto, TaskStatus } from '@ai-harness/shared';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CheckCircle2, GripVertical, ListTree, Network } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { CancelledActions } from './cancelled-actions';
import { PriorityLabel, TaskStatusBadge, TaskTypeIcon } from './badges';
import { RoutingChip } from './routing-badge';
import { TicketChip } from './external-ticket';
import { EnginesChip, ErrorsChip } from './task-chips';
import { TaskProgress } from './pipeline-bits';
import { TaskTimeChip } from './task-time';

export interface ViewProps {
  tasks: TaskDto[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onApprove: (id: string) => void;
}

const keyOf = (tasks: TaskDto[], id: string) => tasks.find((t) => t.id === id)?.key ?? '?';

function Row({
  task,
  tasks,
  selected,
  onToggleSelect,
  onOpen,
  onApprove,
  sortable,
}: { task: TaskDto; tasks: TaskDto[]; sortable: boolean } & Omit<ViewProps, 'tasks'>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !sortable,
  });
  const done = task.subtasks.filter((s) => s.done).length;
  // Cancelled dependencies no longer gate anything, so don't list them.
  const liveDeps = task.dependsOn.filter((d) =>
    tasks.some((t) => t.id === d && t.status !== 'CANCELLED'),
  );
  const cancelled = task.status === 'CANCELLED';
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'bg-card group flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0',
        isDragging && 'relative z-10 shadow-lg',
        selected.has(task.id) && 'bg-accent/50',
      )}
    >
      {sortable && (
        <button
          className="text-muted-foreground hover:text-foreground cursor-grab touch-none active:cursor-grabbing"
          aria-label={`Reorder ${task.key}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
      )}
      <Checkbox
        checked={selected.has(task.id)}
        onCheckedChange={() => onToggleSelect(task.id)}
        aria-label={`Select ${task.key}`}
      />
      <button
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        onClick={() => onOpen(task.id)}
      >
        <span
          className={cn(
            'text-muted-foreground w-14 shrink-0 font-mono text-xs',
            cancelled && 'line-through',
          )}
        >
          {task.key}
        </span>
        <TaskTypeIcon type={task.type} />
        <span className={cn('min-w-0 flex-1', cancelled && 'opacity-60')}>
          <span className="block truncate text-sm font-medium">{task.title}</span>
          <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-[11px]">
            <PriorityLabel priority={task.priority} />
            <span>· {task.complexity.toUpperCase()}</span>
            <RoutingChip task={task} className="before:content-['·_']" />
            {task.external && <TicketChip task={task} />}
            <EnginesChip task={task} />
            <ErrorsChip task={task} />
            {task.subtasks.length > 0 && (
              <span>
                · {done}/{task.subtasks.length} subtasks
              </span>
            )}
            {liveDeps.length > 0 && (
              <span>· after {liveDeps.map((d) => keyOf(tasks, d)).join(', ')}</span>
            )}
            <TaskTimeChip task={task} className="before:content-['·_']" />
          </span>
        </span>
      </button>
      <TaskProgress task={task} />
      {cancelled && (
        <span className="flex items-center gap-1.5">
          <CancelledActions task={task} compact />
        </span>
      )}
      <TaskStatusBadge status={task.status} />
      {task.status === 'DRAFT' && (
        <Button
          size="icon"
          variant="ghost"
          className="size-7 opacity-0 group-hover:opacity-100 focus:opacity-100"
          aria-label={`Approve ${task.key}`}
          onClick={() => onApprove(task.id)}
        >
          <CheckCircle2 className="text-success size-4" />
        </Button>
      )}
    </li>
  );
}

export function TaskList(props: ViewProps & { onReorder: (ids: string[]) => void }) {
  const [order, setOrder] = useState<string[] | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = order ?? props.tasks.map((t) => t.id);
  const byId = new Map(props.tasks.map((t) => [t.id, t]));
  const ordered = ids.map((id) => byId.get(id)).filter((t): t is TaskDto => !!t);
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    setOrder(next);
    props.onReorder(next);
    // Server order arrives via live events; drop the local override after.
    setTimeout(() => setOrder(null), 1500);
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="overflow-hidden rounded-xl border" aria-label="Tasks">
          {ordered.map((t) => (
            <Row key={t.id} {...props} task={t} sortable />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

const COLUMNS: { title: string; statuses: TaskStatus[]; drop?: 'approve' | 'unapprove' }[] = [
  { title: 'Draft', statuses: ['DRAFT'], drop: 'unapprove' },
  { title: 'Approved', statuses: ['APPROVED'], drop: 'approve' },
  { title: 'Up next', statuses: ['QUEUED', 'BLOCKED'] },
  {
    title: 'In progress',
    statuses: ['IN_DEVELOPMENT', 'IN_REVIEW', 'IN_TESTING', 'FIXING', 'DOCUMENTING'],
  },
  {
    title: 'Needs attention',
    statuses: ['NEEDS_HUMAN', 'FAILED', 'PAUSED_QUOTA', 'PAUSED_AUTH', 'PAUSED_MANUAL'],
  },
  { title: 'Done', statuses: ['DONE'] },
  { title: 'Cancelled', statuses: ['CANCELLED'] },
];

export function TaskBoard({
  tasks,
  onOpen,
  onApprove,
  onUnapprove,
}: ViewProps & { onUnapprove: (id: string) => void }) {
  const [over, setOver] = useState<string | null>(null);
  const onDrop = (col: (typeof COLUMNS)[number]) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/task-id');
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    if (col.drop === 'approve' && task.status === 'DRAFT') onApprove(id);
    if (col.drop === 'unapprove' && task.status === 'APPROVED') onUnapprove(id);
  };
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {COLUMNS.map((col) => {
        const items = tasks.filter((t) => col.statuses.includes(t.status));
        return (
          <section
            key={col.title}
            aria-label={col.title}
            onDragOver={(e) => {
              if (col.drop) {
                e.preventDefault();
                setOver(col.title);
              }
            }}
            onDragLeave={() => setOver(null)}
            onDrop={onDrop(col)}
            className={cn(
              'bg-muted/40 flex w-64 shrink-0 flex-col rounded-xl border p-2 transition-colors',
              over === col.title && 'border-primary bg-accent/60',
            )}
          >
            <h3 className="text-muted-foreground mb-2 flex items-center justify-between px-1 text-xs font-medium">
              {col.title} <span className="tabular-nums">{items.length}</span>
            </h3>
            <div className="flex min-h-16 flex-col gap-2">
              {items.map((t) => (
                <button
                  key={t.id}
                  draggable={t.status === 'DRAFT' || t.status === 'APPROVED'}
                  onDragStart={(e) => e.dataTransfer.setData('text/task-id', t.id)}
                  onClick={() => onOpen(t.id)}
                  className="bg-card hover:border-primary/40 rounded-lg border p-2.5 text-left shadow-xs transition-colors"
                >
                  <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-[11px]">
                    <TaskTypeIcon type={t.type} className="size-3" />
                    <span className="font-mono">{t.key}</span>
                    <TicketChip task={t} />
                    <ErrorsChip task={t} />
                    <RoutingChip task={t} />
                    <span className="ml-auto">
                      <PriorityLabel priority={t.priority} />
                    </span>
                  </div>
                  <p className="line-clamp-2 text-sm font-medium">{t.title}</p>
                  <EnginesChip task={t} className="mt-1" />
                  <TaskTimeChip task={t} className="text-muted-foreground mt-1 text-[11px]" />
                  {col.statuses.length > 1 && (
                    <TaskStatusBadge status={t.status} className="mt-1.5" />
                  )}
                  <TaskProgress task={t} compact />
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const NODE_W = 210;
const NODE_H = 54;
const GAP_X = 64;
const GAP_Y = 14;

/** Layered DAG: column = longest dependency chain length. */
export function TaskGraph({ tasks, onOpen }: ViewProps) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const t = byId.get(id);
    const d =
      t && t.dependsOn.length
        ? 1 + Math.max(...t.dependsOn.filter((x) => byId.has(x)).map((x) => depthOf(x, seen)), -1)
        : 0;
    depth.set(id, d);
    return d;
  };
  tasks.forEach((t) => depthOf(t.id));
  const columns: TaskDto[][] = [];
  for (const t of tasks) (columns[depth.get(t.id)!] ??= []).push(t);
  const pos = new Map<string, { x: number; y: number }>();
  columns.forEach((col, ci) =>
    col.forEach((t, ri) => pos.set(t.id, { x: ci * (NODE_W + GAP_X), y: ri * (NODE_H + GAP_Y) })),
  );
  const width = Math.max(1, columns.length) * (NODE_W + GAP_X) - GAP_X;
  const height = Math.max(1, ...columns.map((c) => c.length)) * (NODE_H + GAP_Y) - GAP_Y;
  if (!tasks.length) return null;
  const tone = (s: TaskStatus) =>
    s === 'DONE'
      ? 'stroke-success'
      : s === 'APPROVED'
        ? 'stroke-primary'
        : s === 'DRAFT'
          ? 'stroke-border'
          : 'stroke-warning';
  return (
    <div className="bg-muted/30 overflow-auto rounded-xl border p-4">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="Task dependency graph"
        className="block"
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground/60" />
          </marker>
        </defs>
        {tasks.flatMap((t) =>
          t.dependsOn
            .filter((d) => pos.has(d))
            .map((d) => {
              const a = pos.get(d)!;
              const b = pos.get(t.id)!;
              const x1 = a.x + NODE_W;
              const y1 = a.y + NODE_H / 2;
              const x2 = b.x - 2;
              const y2 = b.y + NODE_H / 2;
              const mx = (x1 + x2) / 2;
              return (
                <path
                  key={`${d}-${t.id}`}
                  d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  className="stroke-muted-foreground/50"
                  strokeWidth={1.5}
                  markerEnd="url(#arrow)"
                />
              );
            }),
        )}
        {tasks.map((t) => {
          const p = pos.get(t.id)!;
          return (
            <g
              key={t.id}
              transform={`translate(${p.x} ${p.y})`}
              className="cursor-pointer"
              onClick={() => onOpen(t.id)}
              role="button"
              aria-label={`${t.key} ${t.title}`}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={10}
                className={cn('fill-card', tone(t.status))}
                strokeWidth={1.5}
              />
              <text x={12} y={20} className="fill-muted-foreground font-mono text-[11px]">
                {t.key}
              </text>
              <foreignObject x={10} y={24} width={NODE_W - 20} height={NODE_H - 26}>
                <p className="text-foreground truncate text-xs font-medium">{t.title}</p>
              </foreignObject>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export const VIEW_ICONS = { list: ListTree, graph: Network };
