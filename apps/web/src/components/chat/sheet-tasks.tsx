'use client';

import type { SheetSourceDto, TaskDto, TaskStatus } from '@agentforge/shared';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, FileSpreadsheet, RefreshCw, Settings2, Sheet } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { SheetSourcesSection, useSheetSources } from '@/components/integrations/sheet-sources';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api, ApiClientError } from '@/lib/api';
import { cn } from '@/lib/utils';

const WAITING: TaskStatus[] = ['DRAFT', 'APPROVED', 'QUEUED'];
const STUCK: TaskStatus[] = [
  'PAUSED_QUOTA',
  'PAUSED_AUTH',
  'PAUSED_MANUAL',
  'BLOCKED',
  'NEEDS_HUMAN',
];

/** Where a sheet's tasks are: done / being worked on / waiting / needing you. */
function progress(sourceId: string, tasks: TaskDto[]) {
  const mine = tasks.filter(
    (t) => t.external?.connectionId === sourceId && t.status !== 'CANCELLED',
  );
  const done = mine.filter((t) => t.status === 'DONE').length;
  const waiting = mine.filter((t) => WAITING.includes(t.status)).length;
  const stuck = mine.filter((t) => STUCK.includes(t.status)).length;
  const working = mine.length - done - waiting - stuck;
  const current = mine.find(
    (t) => !WAITING.includes(t.status) && !STUCK.includes(t.status) && t.status !== 'DONE',
  );
  return { total: mine.length, done, waiting, stuck, working, current };
}

function SheetLine({ source: s, tasks }: { source: SheetSourceDto; tasks: TaskDto[] }) {
  const sync = useMutation({
    mutationFn: () => api.sheets.sync(s.id),
    onSuccess: (r) =>
      toast.success(`Synced “${s.name}”`, {
        description: `${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged.`,
      }),
    onError: (e) =>
      toast.error('Sync failed', {
        description: e instanceof ApiClientError ? e.message : String(e),
      }),
  });
  const p = progress(s.id, tasks);
  const busy = sync.isPending || s.syncing;
  const Icon = s.kind === 'google' ? Sheet : FileSpreadsheet;
  return (
    <li className="flex items-start gap-2 py-1.5">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={s.location}>
          {s.name}
        </p>
        {s.lastError ? (
          <p className="text-destructive flex items-start gap-1 text-[11px]">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <span className="line-clamp-2">{s.lastError}</span>
          </p>
        ) : (
          <>
            <p className="text-muted-foreground text-[11px]">
              {s.syncing && p.total === 0
                ? 'Importing rows…'
                : p.total === 0
                  ? 'No tasks imported yet'
                  : [
                      `${p.done}/${p.total} done`,
                      p.working && `${p.working} in progress`,
                      p.waiting && `${p.waiting} waiting`,
                      p.stuck && `${p.stuck} need you`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
            </p>
            {p.total > 0 && (
              <div
                className="bg-muted mt-1 h-1 overflow-hidden rounded-full"
                role="progressbar"
                aria-label={`${s.name} progress`}
                aria-valuemin={0}
                aria-valuemax={p.total}
                aria-valuenow={p.done}
              >
                <div
                  className="bg-primary h-full rounded-full transition-[width]"
                  style={{ width: `${(p.done / p.total) * 100}%` }}
                />
              </div>
            )}
            {p.current && (
              <p className="text-muted-foreground mt-0.5 truncate text-[11px]">
                Now: <span className="text-foreground">{p.current.key}</span> {p.current.title}
              </p>
            )}
          </>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label={`Sync ${s.name} now`}
        title="Check the sheet for new or changed rows"
        disabled={busy}
        onClick={() => sync.mutate()}
      >
        <RefreshCw className={cn('size-3', busy && 'animate-spin')} />
      </Button>
    </li>
  );
}

/** Spreadsheets feeding this project's tasks, shown above the chat composer. */
export function SheetTasksStrip({ projectId, tasks }: { projectId: string; tasks: TaskDto[] }) {
  const sources = useSheetSources();
  const [manage, setManage] = useState(false);
  const list = (sources.data ?? []).filter((s) => s.projectId === projectId);
  if (list.length === 0) return null;
  return (
    <div className="bg-muted/30 border-t px-3 py-1.5">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          Task sheets
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground h-6 px-1.5 text-[11px]"
          onClick={() => setManage(true)}
        >
          <Settings2 className="size-3" /> Manage
        </Button>
      </div>
      <ul className="max-h-40 divide-y overflow-y-auto">
        {list.map((s) => (
          <SheetLine key={s.id} source={s} tasks={tasks} />
        ))}
      </ul>
      <Dialog open={manage} onOpenChange={setManage}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Task sheets</DialogTitle>
            <DialogDescription>
              Rows become tasks; agents work through them by priority. Sync to pick up new or edited
              rows, turn auto-start off to approve each task yourself, or disconnect a sheet (its
              tasks stay).
            </DialogDescription>
          </DialogHeader>
          <SheetSourcesSection projectId={projectId} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
