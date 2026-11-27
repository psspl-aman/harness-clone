'use client';

import { resolveRouting, routingRuleFor, type Complexity } from '@ai-harness/shared';
import { useQuery } from '@tanstack/react-query';
import { Zap } from 'lucide-react';
import { api, qk } from '@/lib/api';
import { cn } from '@/lib/utils';

/** The effective routing rule for a task (global routing + project override). null when routing is off. */
export function useRoutingRule(projectId: string, complexity: Complexity) {
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  const project = useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => api.projects.get(projectId),
  });
  if (!settings.data) return null;
  const routing = resolveRouting(settings.data.routing, project.data?.pipeline.routing ?? null);
  return routingRuleFor(routing, complexity);
}

/** Shows which pipeline profile complexity routing will give a task (nothing when routing is off). */
export function RoutingBadge({
  projectId,
  complexity,
  className,
}: {
  projectId: string;
  complexity: Complexity;
  className?: string;
}) {
  const rule = useRoutingRule(projectId, complexity);
  if (!rule) return null;
  const lite = rule.pipeline === 'lite';
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        lite
          ? 'border-amber-500/25 bg-amber-500/12 text-amber-700 dark:text-amber-400'
          : 'bg-muted text-muted-foreground border-transparent',
        className,
      )}
      title={
        lite
          ? 'Lite pipeline — Develop then merge (skips review, tests and docs)'
          : 'Full pipeline — Develop → Review → Test → Document → merge'
      }
    >
      {lite && <Zap className="size-3" />}
      {lite ? 'Lite' : 'Full'}
      {rule.model ? ` · ${rule.model}` : ''}
      {rule.effort ? ` · ${rule.effort} effort` : ''}
    </span>
  );
}

/** Compact inline flag for list/board cards: shown only when a task takes the lite pipeline. */
export function RoutingChip({
  task,
  className,
}: {
  task: { projectId: string; complexity: Complexity };
  className?: string;
}) {
  const rule = useRoutingRule(task.projectId, task.complexity);
  if (rule?.pipeline !== 'lite') return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400',
        className,
      )}
      title={`Lite pipeline — Develop then merge${rule.model ? ` · ${rule.model}` : ''}`}
    >
      <Zap className="size-3" /> Lite
    </span>
  );
}
