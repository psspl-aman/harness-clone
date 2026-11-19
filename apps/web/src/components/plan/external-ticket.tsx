'use client';

import type { TaskDto } from '@agentforge/shared';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, Ticket } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, ApiClientError } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Small "imported from" chip for task rows and cards. */
export function TicketChip({ task, className }: { task: TaskDto; className?: string }) {
  if (!task.external) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-mono text-[11px]',
        task.external.conflict ? 'text-warning' : 'text-muted-foreground',
        className,
      )}
      title={
        task.external.conflict
          ? 'Changed in the tracker while in progress'
          : `Imported from ${task.external.id}`
      }
    >
      {task.external.conflict ? (
        <AlertTriangle className="size-3" />
      ) : (
        <Ticket className="size-3" />
      )}
      {task.external.id}
    </span>
  );
}

/** Ticket link and, when the ticket changed during work, the change to apply or dismiss. */
export function ExternalTicket({ task }: { task: TaskDto }) {
  const resolve = useMutation({
    mutationFn: (action: 'apply' | 'dismiss') => api.pms.resolveConflict(task.id, action),
    onError: (e) =>
      toast.error('Could not resolve the change', {
        description: e instanceof ApiClientError ? e.message : String(e),
      }),
  });
  const x = task.external;
  if (!x) return null;
  const c = x.conflict;
  return (
    <div className="space-y-2">
      <div
        className="text-muted-foreground flex items-center gap-1.5 text-xs"
        data-testid="ticket-link"
      >
        <Ticket className="size-3.5" /> Imported from{' '}
        <span className="text-foreground font-mono">{x.id}</span>
        {x.url && (
          <a
            href={x.url}
            target="_blank"
            rel="noreferrer"
            className="text-primary inline-flex items-center gap-0.5 hover:underline"
          >
            open <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      {c && (
        <div
          className="border-warning/50 bg-warning/10 rounded-lg border p-3 text-sm"
          role="alert"
          data-testid="pms-conflict"
        >
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="text-warning size-4" />
            {c.kind === 'closed'
              ? `${x.id} was closed in the tracker`
              : `${x.id} was edited in the tracker`}
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            {c.kind === 'closed'
              ? `Its status is now “${c.externalStatus ?? 'closed'}”. Cancel this task, or keep working on it.`
              : 'Apply the new version (the agent is told about it), or keep the task as it is.'}
          </p>
          {c.kind === 'changed' && (
            <div className="bg-background/60 mt-2 max-h-32 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
              <div className="font-medium">{c.title}</div>
              {c.description}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => resolve.mutate('apply')} disabled={resolve.isPending}>
              {c.kind === 'closed' ? 'Cancel task' : 'Apply update'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => resolve.mutate('dismiss')}
              disabled={resolve.isPending}
            >
              {c.kind === 'closed' ? 'Keep working' : 'Ignore'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
