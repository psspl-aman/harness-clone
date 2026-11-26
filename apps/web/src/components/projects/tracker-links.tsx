'use client';

import type { PmsMappingDto, TaskStatus } from '@ai-harness/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Link2, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { usePmsConnections, usePmsProviders } from '@/components/integrations/pms-connections';
import { STATUS } from '@/components/plan/badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api, ApiClientError, qk } from '@/lib/api';
import { timeAgo } from '@/lib/format';

const errMsg = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));
const MAP_TARGETS: TaskStatus[] = [
  'DRAFT',
  'APPROVED',
  'IN_DEVELOPMENT',
  'IN_REVIEW',
  'IN_TESTING',
  'DONE',
  'CANCELLED',
];
const POLLING = [
  { v: 'off', label: 'Manual only', sec: null },
  { v: '300', label: 'Every 5 minutes', sec: 300 },
  { v: '900', label: 'Every 15 minutes', sec: 900 },
  { v: '3600', label: 'Every hour', sec: 3600 },
];
const csv = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function MappingDialog({
  projectId,
  open,
  onOpenChange,
  mapping,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mapping?: PmsMappingDto;
}) {
  const qc = useQueryClient();
  const conns = usePmsConnections().data ?? [];
  const providers = usePmsProviders().data ?? [];
  const [connectionId, setConnectionId] = useState(mapping?.connectionId ?? conns[0]?.id ?? '');
  const conn = conns.find((c) => c.id === connectionId);
  const preset = providers.find((p) => p.id === (mapping?.provider ?? conn?.provider));
  const [externalProject, setExternalProject] = useState(mapping?.externalProject ?? '');
  const [rows, setRows] = useState<{ ext: string; to: TaskStatus }[]>(
    Object.entries(mapping?.statusMap ?? preset?.defaultStatusMap ?? {}).map(([ext, to]) => ({
      ext,
      to,
    })),
  );
  const [assignee, setAssignee] = useState(mapping?.filters.assignee ?? '');
  const [sprint, setSprint] = useState(mapping?.filters.sprint ?? '');
  const [labels, setLabels] = useState((mapping?.filters.labels ?? []).join(', '));
  const [statuses, setStatuses] = useState((mapping?.filters.status ?? []).join(', '));
  const [polling, setPolling] = useState(
    mapping?.pollingIntervalSec ? String(mapping.pollingIntervalSec) : 'off',
  );
  const [writeBack, setWriteBack] = useState(mapping?.writeBack ?? true);
  const [autoEnrich, setAutoEnrich] = useState(mapping?.autoEnrich ?? true);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        externalProject: externalProject.trim(),
        statusMap: Object.fromEntries(
          rows.filter((r) => r.ext.trim()).map((r) => [r.ext.trim(), r.to]),
        ),
        filters: {
          ...(assignee.trim() ? { assignee: assignee.trim() } : {}),
          ...(sprint.trim() ? { sprint: sprint.trim() } : {}),
          ...(csv(labels).length ? { labels: csv(labels) } : {}),
          ...(csv(statuses).length ? { status: csv(statuses) } : {}),
        },
        pollingIntervalSec: POLLING.find((p) => p.v === polling)?.sec ?? null,
        writeBack,
        autoEnrich,
      };
      return mapping
        ? api.pms.updateMapping(mapping.id, body)
        : api.pms.createMapping(projectId, { connectionId, ...body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.pmsMappings(projectId) });
      onOpenChange(false);
    },
    onError: (e) => toast.error('Could not save the link', { description: errMsg(e) }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{mapping ? 'Edit tracker link' : 'Link an issue tracker'}</DialogTitle>
          <DialogDescription>
            Imported tickets land as drafts for you to review before anything is built.
          </DialogDescription>
        </DialogHeader>
        <form
          id="mapping-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Tracker</Label>
              <Select value={connectionId} onValueChange={setConnectionId} disabled={!!mapping}>
                <SelectTrigger aria-label="Tracker connection" className="w-full">
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  {conns.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ext-project">{preset?.projectLabel ?? 'Project'}</Label>
              <Input
                id="ext-project"
                value={externalProject}
                onChange={(e) => setExternalProject(e.target.value)}
                placeholder={preset?.projectPlaceholder}
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Status mapping</Label>
            <p className="text-muted-foreground text-xs">
              Tracker status → AI Harness status. Tickets already Done or Cancelled aren’t imported,
              and AI Harness moves tickets to the mapped status as tasks progress.
            </p>
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={r.ext}
                  onChange={(e) =>
                    setRows(rows.map((x, j) => (j === i ? { ...x, ext: e.target.value } : x)))
                  }
                  placeholder="Tracker status"
                  className="h-8 flex-1"
                  aria-label={`Tracker status ${i + 1}`}
                />
                <span className="text-muted-foreground">→</span>
                <Select
                  value={r.to}
                  onValueChange={(v) =>
                    setRows(rows.map((x, j) => (j === i ? { ...x, to: v as TaskStatus } : x)))
                  }
                >
                  <SelectTrigger className="h-8 w-40" aria-label={`AI Harness status ${i + 1}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MAP_TARGETS.map((s) => (
                      <SelectItem key={s} value={s}>
                        {STATUS[s].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  aria-label="Remove mapping row"
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))}
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-xs"
                onClick={() => setRows([...rows, { ext: '', to: 'APPROVED' }])}
              >
                <Plus /> Add status
              </Button>
              {preset && Object.keys(preset.defaultStatusMap).length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-xs"
                  onClick={() =>
                    setRows(
                      Object.entries(preset.defaultStatusMap).map(([ext, to]) => ({ ext, to })),
                    )
                  }
                >
                  Use {preset.label} defaults
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Filters</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="Assignee"
                className="h-8"
                aria-label="Assignee filter"
              />
              <Input
                value={sprint}
                onChange={(e) => setSprint(e.target.value)}
                placeholder="Sprint"
                className="h-8"
                aria-label="Sprint filter"
              />
              <Input
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                placeholder="Labels (comma separated)"
                className="h-8"
                aria-label="Labels filter"
              />
              <Input
                value={statuses}
                onChange={(e) => setStatuses(e.target.value)}
                placeholder="Statuses (comma separated)"
                className="h-8"
                aria-label="Status filter"
              />
            </div>
            <p className="text-muted-foreground text-xs">
              Filters are passed to the list tool where its arguments use them, and applied to the
              results.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Sync</Label>
              <Select value={polling} onValueChange={setPolling}>
                <SelectTrigger aria-label="Polling" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POLLING.map((p) => (
                    <SelectItem key={p.v} value={p.v}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 pt-6">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={writeBack}
                  onCheckedChange={setWriteBack}
                  aria-label="Write back"
                />{' '}
                Update tickets (status, comments)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={autoEnrich}
                  onCheckedChange={setAutoEnrich}
                  aria-label="Enrich with Planner"
                />{' '}
                Planner adds criteria and subtasks
              </label>
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="mapping-form"
            disabled={!connectionId || !externalProject.trim() || save.isPending}
          >
            {save.isPending && <Loader2 className="animate-spin" />} {mapping ? 'Save' : 'Link'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MappingRow({ mapping: m }: { mapping: PmsMappingDto }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const sync = useMutation({
    mutationFn: () => api.pms.sync(m.id),
    onSuccess: (r) => {
      const parts = [
        r.created && `${r.created} new`,
        r.updated && `${r.updated} updated`,
        r.conflicts && `${r.conflicts} need attention`,
      ].filter(Boolean);
      toast.success('Sync finished', {
        description: parts.length ? parts.join(', ') : `${r.total} tickets, nothing new`,
      });
    },
    onError: (e) => toast.error('Sync failed', { description: errMsg(e) }),
  });
  const remove = useMutation({
    mutationFn: () => api.pms.removeMapping(m.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.pmsMappings(m.projectId) }),
  });
  const r = m.lastResult;
  return (
    <li className="py-3" data-testid="tracker-link">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{m.connectionName}</span>
            <span className="text-muted-foreground">·</span>
            <span className="font-mono text-sm">{m.externalProject}</span>
          </div>
          <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 text-xs">
            <span>
              {m.pollingIntervalSec
                ? `Syncs every ${m.pollingIntervalSec >= 3600 ? `${m.pollingIntervalSec / 3600} h` : `${m.pollingIntervalSec / 60} min`}`
                : 'Manual sync'}
            </span>
            {m.lastSyncedAt ? (
              <span data-testid="sync-summary">
                Synced {timeAgo(m.lastSyncedAt)}
                {r &&
                  ` — ${r.total} ticket${r.total === 1 ? '' : 's'}, ${r.created} new, ${r.updated} updated${r.conflicts ? `, ${r.conflicts} changed while in progress` : ''}`}
              </span>
            ) : (
              <span>Never synced</span>
            )}
          </div>
        </div>
        <div className="flex gap-1">
          {m.writeBack && (
            <Badge variant="outline" className="text-[10px] font-normal">
              Write-back
            </Badge>
          )}
          {m.autoEnrich && (
            <Badge variant="outline" className="text-[10px] font-normal">
              Planner enrich
            </Badge>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => sync.mutate()}
          disabled={sync.isPending || m.syncing}
        >
          {sync.isPending || m.syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync
          now
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label="Edit tracker link"
          onClick={() => setEdit(true)}
        >
          <Pencil className="size-3.5" />
        </Button>
        {confirm ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => remove.mutate()}
            onBlur={() => setConfirm(false)}
          >
            Unlink?
          </Button>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label="Unlink tracker"
            onClick={() => setConfirm(true)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
      {m.lastError && (
        <p className="text-destructive mt-2 flex items-start gap-1.5 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{' '}
          <span className="break-words">{m.lastError}</span>
        </p>
      )}
      {r?.errors.length ? (
        <p className="text-muted-foreground mt-1 text-xs">
          {r.errors.length} ticket(s) couldn’t be imported: {r.errors.slice(0, 2).join('; ')}
        </p>
      ) : null}
      {edit && (
        <MappingDialog projectId={m.projectId} open={edit} onOpenChange={setEdit} mapping={m} />
      )}
    </li>
  );
}

/** Project ↔ tracker links (Overview). */
export function TrackerLinksCard({ projectId }: { projectId: string }) {
  const mappings = useQuery({
    queryKey: qk.pmsMappings(projectId),
    queryFn: () => api.pms.mappings(projectId),
  });
  const conns = usePmsConnections();
  const [adding, setAdding] = useState(false);
  const noConns = conns.isSuccess && conns.data.length === 0;
  return (
    <Card className="gap-4 shadow-xs">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Link2 className="size-4" /> Issue tracker
          </CardTitle>
          <CardDescription>
            Import tickets as draft tasks and keep their status in sync.
          </CardDescription>
        </div>
        {noConns ? (
          <Button size="sm" variant="outline" asChild>
            <Link href="/integrations">Connect a tracker</Link>
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAdding(true)}
            disabled={!conns.data?.length}
          >
            <Plus /> Link
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {mappings.data?.length ? (
          <ul className="divide-y">
            {mappings.data.map((m) => (
              <MappingRow key={m.id} mapping={m} />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">
            {noConns
              ? 'Connect Jira, Linear, GitHub Issues or another tracker on the Integrations page first.'
              : 'Not linked to a tracker.'}
          </p>
        )}
      </CardContent>
      {adding && <MappingDialog projectId={projectId} open={adding} onOpenChange={setAdding} />}
    </Card>
  );
}
