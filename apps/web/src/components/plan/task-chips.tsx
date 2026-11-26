'use client';

import { AGENT_ROLES, ROLE_LABELS, type AgentRole, type TaskDto } from '@ai-harness/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bot } from 'lucide-react';
import { api, qk } from '@/lib/api';
import { cn } from '@/lib/utils';

const BUILD_ROLES = AGENT_ROLES.filter((r) => r !== 'planner');

/** The engine each role will use for a task: task override → project default → global default. */
export function useEffectiveEngines(projectId: string) {
  const project = useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => api.projects.get(projectId),
  });
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  const name = (id: string) => engines.data?.find((e) => e.id === id)?.displayName ?? id;
  return (task: TaskDto): { role: AgentRole; engineId: string; name: string }[] =>
    BUILD_ROLES.map((role) => {
      const id =
        task.roleEngines[role] ??
        project.data?.roleEngines[role] ??
        settings.data?.defaultEngines[role] ??
        '';
      return { role, engineId: id, name: id ? name(id) : '—' };
    });
}

/** "Claude Code" or "Claude Code +1", with every role's engine in the tooltip. */
export function EnginesChip({ task, className }: { task: TaskDto; className?: string }) {
  const effective = useEffectiveEngines(task.projectId)(task);
  const names = [...new Set(effective.map((e) => e.name))];
  if (!names.length || names[0] === '—') return null;
  return (
    <span
      className={cn('text-muted-foreground inline-flex items-center gap-1 text-[11px]', className)}
      title={effective.map((e) => `${ROLE_LABELS[e.role]}: ${e.name}`).join('\n')}
      aria-label={`Engines: ${effective.map((e) => `${ROLE_LABELS[e.role]} ${e.name}`).join(', ')}`}
    >
      <Bot className="size-3" />
      {names[0]}
      {names.length > 1 && ` +${names.length - 1}`}
    </span>
  );
}

/** Red badge with the number of open errors recorded against the task. */
export function ErrorsChip({ task, className }: { task: TaskDto; className?: string }) {
  if (!task.openErrors) return null;
  return (
    <span
      className={cn(
        'text-destructive inline-flex items-center gap-0.5 text-[11px] font-medium',
        className,
      )}
      title={`${task.openErrors} open error${task.openErrors === 1 ? '' : 's'} — see the Errors panel`}
      data-testid="task-errors"
    >
      <AlertTriangle className="size-3" />
      {task.openErrors}
    </span>
  );
}
