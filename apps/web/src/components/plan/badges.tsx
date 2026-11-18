import type { Priority, TaskStatus, TaskType } from '@agentforge/shared';
import {
  Bug,
  FileText,
  FlaskConical,
  Hammer,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const STATUS: Record<TaskStatus, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'bg-muted text-muted-foreground' },
  APPROVED: { label: 'Approved', cls: 'bg-primary/12 text-primary border-primary/25' },
  QUEUED: {
    label: 'Queued',
    cls: 'bg-sky-500/12 text-sky-600 dark:text-sky-400 border-sky-500/25',
  },
  BLOCKED: { label: 'Blocked', cls: 'bg-muted text-muted-foreground border-dashed' },
  IN_DEVELOPMENT: {
    label: 'Developing',
    cls: 'bg-violet-500/12 text-violet-600 dark:text-violet-400 border-violet-500/25',
  },
  IN_REVIEW: {
    label: 'In review',
    cls: 'bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 border-indigo-500/25',
  },
  IN_TESTING: {
    label: 'Testing',
    cls: 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-400 border-cyan-500/25',
  },
  FIXING: {
    label: 'Fixing',
    cls: 'bg-orange-500/12 text-orange-600 dark:text-orange-400 border-orange-500/25',
  },
  DOCUMENTING: {
    label: 'Documenting',
    cls: 'bg-teal-500/12 text-teal-700 dark:text-teal-400 border-teal-500/25',
  },
  DONE: { label: 'Done', cls: 'bg-success/12 text-success border-success/25' },
  PAUSED_QUOTA: { label: 'Paused · quota', cls: 'bg-warning/15 text-warning border-warning/30' },
  PAUSED_AUTH: { label: 'Paused · login', cls: 'bg-warning/15 text-warning border-warning/30' },
  PAUSED_MANUAL: { label: 'Paused', cls: 'bg-warning/15 text-warning border-warning/30' },
  NEEDS_HUMAN: {
    label: 'Needs you',
    cls: 'bg-destructive/10 text-destructive border-destructive/25',
  },
  FAILED: { label: 'Failed', cls: 'bg-destructive/10 text-destructive border-destructive/25' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-muted text-muted-foreground line-through' },
};

export const statusLabel = (s: TaskStatus) => STATUS[s].label;

export function TaskStatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const s = STATUS[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-transparent px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        s.cls,
        className,
      )}
    >
      {s.label}
    </span>
  );
}

export const TYPE_ICON: Record<TaskType, LucideIcon> = {
  feature: Sparkles,
  bug: Bug,
  refactor: Wrench,
  test: FlaskConical,
  docs: FileText,
  chore: Hammer,
};

export function TaskTypeIcon({ type, className }: { type: TaskType; className?: string }) {
  const Icon = TYPE_ICON[type];
  return (
    <Icon className={cn('text-muted-foreground size-3.5 shrink-0', className)} aria-label={type} />
  );
}

const PRIORITY: Record<Priority, string> = {
  low: 'text-muted-foreground',
  medium: 'text-foreground/70',
  high: 'text-warning',
  critical: 'text-destructive',
};

export function PriorityLabel({ priority }: { priority: Priority }) {
  return (
    <span className={cn('text-[11px] font-medium capitalize', PRIORITY[priority])}>{priority}</span>
  );
}
