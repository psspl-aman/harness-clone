'use client';

import {
  type SheetField,
  type SheetKind,
  type SheetPreviewDto,
  type SheetSourceDto,
} from '@agentforge/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Download,
  Eye,
  FileSpreadsheet,
  Loader2,
  Plus,
  RefreshCw,
  Sheet,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { PriorityLabel } from '@/components/plan/badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { cn } from '@/lib/utils';

const errMsg = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));

const FIELD_LABELS: Record<SheetField, string> = {
  title: 'Title',
  priority: 'Priority',
  description: 'Description',
  id: 'ID',
  complexity: 'Size',
  type: 'Type',
  status: 'Status',
  acceptance: 'Acceptance criteria',
};
const SHOWN_FIELDS: SheetField[] = [
  'title',
  'priority',
  'description',
  'id',
  'status',
  'complexity',
  'type',
  'acceptance',
];
const POLLING = [
  { value: 'off', label: 'Only when I press Sync' },
  { value: '60', label: 'Every minute' },
  { value: '300', label: 'Every 5 minutes' },
  { value: '900', label: 'Every 15 minutes' },
  { value: '3600', label: 'Every hour' },
];
const AUTO = '__auto__';

const TEMPLATE = [
  'ID,Title,Description,Priority,Size,Type,Status',
  'T-1,Add login page,"Email + password login with validation and error messages",High,M,feature,',
  'T-2,Fix crash on empty cart,"Checkout throws when the cart is empty",P0,S,bug,',
  'T-3,Write setup guide,"README section on installing and running locally",Low,S,docs,',
].join('\n');

function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'agentforge-tasks-template.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useSheetSources() {
  return useQuery({ queryKey: qk.sheets, queryFn: api.sheets.list });
}

function KindIcon({ kind, className }: { kind: SheetKind; className?: string }) {
  return kind === 'google' ? (
    <Sheet className={cn('size-4 text-emerald-600', className)} aria-label="Google Sheet" />
  ) : (
    <FileSpreadsheet className={cn('size-4 text-green-700', className)} aria-label="Excel/CSV" />
  );
}

/** Spreadsheets feeding tasks: all projects (Integrations) or one project (Overview). */
export function SheetSourcesSection({ projectId }: { projectId?: string }) {
  const sources = useSheetSources();
  const [open, setOpen] = useState(false);
  const list = (sources.data ?? []).filter((s) => !projectId || s.projectId === projectId);
  return (
    <div className="space-y-3">
      {sources.isLoading ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : list.length === 0 ? (
        <p className="text-muted-foreground text-sm">No sheets connected yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {list.map((s) => (
            <SheetSourceRow key={s.id} source={s} showProject={!projectId} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={downloadTemplate}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
        >
          <Download className="size-3.5" /> Download a template (.csv)
        </button>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus /> Connect sheet
        </Button>
      </div>
      {open && <SheetSourceDialog projectId={projectId} open={open} onOpenChange={setOpen} />}
    </div>
  );
}

function resultLine(s: SheetSourceDto): string | null {
  const r = s.lastResult;
  if (!r) return null;
  const parts = [
    `${r.total} row${r.total === 1 ? '' : 's'}`,
    r.created && `${r.created} new`,
    r.updated && `${r.updated} updated`,
    r.started && `${r.started} started`,
    r.skipped && `${r.skipped} skipped`,
    r.conflicts && `${r.conflicts} changed while in progress`,
  ].filter(Boolean);
  return parts.join(' · ');
}

function SheetSourceRow({
  source: s,
  showProject,
}: {
  source: SheetSourceDto;
  showProject: boolean;
}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const sync = useMutation({
    mutationFn: () => api.sheets.sync(s.id),
    onSuccess: (r) =>
      toast.success(`Synced “${s.name}”`, {
        description: `${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged.`,
      }),
    onError: (e) => toast.error('Sync failed', { description: errMsg(e) }),
  });
  const update = useMutation({
    mutationFn: (v: Parameters<typeof api.sheets.update>[1]) => api.sheets.update(s.id, v),
    onError: (e) => toast.error('Could not save', { description: errMsg(e) }),
  });
  const remove = useMutation({
    mutationFn: () => api.sheets.remove(s.id),
    onSuccess: () => {
      qc.setQueryData<SheetSourceDto[]>(qk.sheets, (l) => l?.filter((x) => x.id !== s.id));
      toast.success(`Disconnected “${s.name}”`, {
        description: 'Tasks already imported stay in the project.',
      });
    },
    onError: (e) => toast.error('Could not remove', { description: errMsg(e) }),
  });
  const line = resultLine(s);
  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-wrap items-start gap-3">
        <KindIcon kind={s.kind} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{s.name}</span>
            {showProject && (
              <Link
                href={`/projects/${s.projectId}`}
                className="text-muted-foreground hover:text-foreground text-xs"
              >
                → {s.projectName}
              </Link>
            )}
            {s.sheet && <Badge variant="outline">{s.sheet}</Badge>}
          </div>
          <p className="text-muted-foreground truncate font-mono text-[11px]" title={s.location}>
            {s.location}
          </p>
          <p className="text-muted-foreground text-xs">
            {s.syncing ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" /> Syncing…
              </span>
            ) : s.lastSyncedAt ? (
              <>
                Synced {timeAgo(s.lastSyncedAt)}
                {line && ` · ${line}`}
              </>
            ) : (
              'Not synced yet'
            )}
            {s.pollingIntervalSec
              ? ` · checks every ${s.pollingIntervalSec >= 3600 ? `${s.pollingIntervalSec / 3600}h` : `${Math.round(s.pollingIntervalSec / 60)}m`}`
              : ' · manual sync'}
          </p>
          {s.lastError && (
            <p className="text-destructive flex items-start gap-1 text-xs">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {s.lastError}
            </p>
          )}
          {!!s.lastResult?.errors.length && (
            <p className="text-warning text-xs">{s.lastResult.errors.slice(0, 2).join(' · ')}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => sync.mutate()}
            disabled={sync.isPending || s.syncing}
          >
            <RefreshCw className={cn((sync.isPending || s.syncing) && 'animate-spin')} /> Sync
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={`Disconnect ${s.name}`}
            onClick={() => setConfirm(true)}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <Switch
          checked={s.autoStart}
          onCheckedChange={(v) => update.mutate({ autoStart: v })}
          aria-label="Start agents automatically"
        />
        Start agents on new rows automatically (highest priority first)
      </label>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect “{s.name}”?</DialogTitle>
            <DialogDescription>
              New rows won’t be imported any more. Tasks already created from it stay in{' '}
              {s.projectName}, and the sheet itself isn’t touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                setConfirm(false);
                remove.mutate();
              }}
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

function PreviewTable({ preview }: { preview: SheetPreviewDto }) {
  if (!preview.rows.length)
    return <p className="text-muted-foreground text-sm">No task rows found in the sheet.</p>;
  return (
    <div className="max-h-64 overflow-auto rounded-lg border">
      <table className="w-full text-xs">
        <thead className="bg-muted/60 sticky top-0 text-left">
          <tr>
            <th className="px-2 py-1.5 font-medium">#</th>
            <th className="px-2 py-1.5 font-medium">Task</th>
            <th className="px-2 py-1.5 font-medium">Priority</th>
            <th className="px-2 py-1.5 font-medium">Size</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {preview.rows.map((r, i) => (
            <tr key={r.id} className={cn(r.skip && 'text-muted-foreground line-through')}>
              <td className="text-muted-foreground px-2 py-1.5 tabular-nums">{i + 1}</td>
              <td className="max-w-72 px-2 py-1.5">
                <div className="truncate font-medium" title={r.title}>
                  {r.title}
                </div>
                {r.description && (
                  <div className="text-muted-foreground truncate" title={r.description}>
                    {r.description}
                  </div>
                )}
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                <PriorityLabel priority={r.priority} />
                {r.priorityRaw && r.priorityRaw.toLowerCase() !== r.priority && (
                  <span className="text-muted-foreground"> ({r.priorityRaw})</span>
                )}
              </td>
              <td className="px-2 py-1.5 uppercase">{r.complexity}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SheetSourceDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId?: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: qk.projects, queryFn: api.projects.list });
  const [project, setProject] = useState(projectId ?? '');
  const [kind, setKind] = useState<SheetKind>('google');
  const [location, setLocation] = useState('');
  const [sheet, setSheet] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [columns, setColumns] = useState<Partial<Record<SheetField, string>>>({});
  const [polling, setPolling] = useState('300');
  const [autoStart, setAutoStart] = useState(true);
  const [autoEnrich, setAutoEnrich] = useState(true);
  const [preview, setPreview] = useState<SheetPreviewDto | null>(null);

  const input = { kind, location: location.trim(), sheet, columns };
  const doPreview = useMutation({
    mutationFn: (v: typeof input) => api.sheets.preview(v),
    onSuccess: (p) => {
      setPreview(p);
      if (!name.trim()) setName(defaultName(kind, location));
    },
    onError: (e) => {
      setPreview(null);
      toast.error('Couldn’t read the sheet', { description: errMsg(e) });
    },
  });
  const create = useMutation({
    mutationFn: () =>
      api.sheets.create(project, {
        ...input,
        name: name.trim() || defaultName(kind, location),
        pollingIntervalSec: polling === 'off' ? null : Number(polling),
        autoStart,
        autoEnrich,
      }),
    onSuccess: (s) => {
      // The first import starts right away and its live updates can arrive before this
      // response, so keep what's already there and refetch rather than overwrite it.
      qc.setQueryData<SheetSourceDto[]>(qk.sheets, (l) =>
        l && !l.some((x) => x.id === s.id) ? [...l, s] : l,
      );
      void qc.invalidateQueries({ queryKey: qk.sheets });
      toast.success(`Connected “${s.name}”`, {
        description: autoStart
          ? 'Importing rows now — agents start on them, highest priority first.'
          : 'Importing rows now — they’ll wait for your approval.',
      });
      onOpenChange(false);
    },
    onError: (e) => toast.error('Could not connect the sheet', { description: errMsg(e) }),
  });

  const reset = () => setPreview(null);
  const setCol = (f: SheetField, v: string) => {
    const next = { ...columns };
    if (v === AUTO) delete next[f];
    else next[f] = v;
    setColumns(next);
    if (preview) doPreview.mutate({ ...input, columns: next });
  };
  const canPreview = location.trim().length > 3;
  const pending = preview?.rows.filter((r) => !r.skip).length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect a spreadsheet</DialogTitle>
          <DialogDescription>
            Each row becomes a task. Put the task in a <b>Title</b> column and its <b>Priority</b>{' '}
            (High / Medium / Low, P0–P3 or 1, 2, 3…) next to it — agents work on the highest
            priority first. Optional columns: Description, ID, Size, Type, Status.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!projectId && (
            <div className="space-y-1.5">
              <Label htmlFor="sheet-project">Project</Label>
              <Select value={project} onValueChange={setProject}>
                <SelectTrigger id="sheet-project" className="w-full">
                  <SelectValue placeholder="Choose the project the tasks belong to" />
                </SelectTrigger>
                <SelectContent>
                  {(projects.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Source</Label>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Sheet source">
              {(
                [
                  ['google', 'Google Sheets', 'A link to the sheet'],
                  ['file', 'Excel or CSV file', '.xlsx, .csv or .tsv on this machine'],
                ] as const
              ).map(([k, label, hint]) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  onClick={() => {
                    setKind(k);
                    setLocation('');
                    setSheet(null);
                    reset();
                  }}
                  className={cn(
                    'flex items-start gap-2 rounded-lg border p-3 text-left text-sm transition-colors',
                    kind === k ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                  )}
                >
                  <KindIcon kind={k} className="mt-0.5" />
                  <span>
                    <span className="block font-medium">{label}</span>
                    <span className="text-muted-foreground text-xs">{hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sheet-location">{kind === 'google' ? 'Sheet link' : 'File path'}</Label>
            <div className="flex gap-2">
              <Input
                id="sheet-location"
                value={location}
                onChange={(e) => {
                  setLocation(e.target.value);
                  reset();
                }}
                placeholder={
                  kind === 'google'
                    ? 'https://docs.google.com/spreadsheets/d/…/edit#gid=0'
                    : '/home/you/Documents/tasks.xlsx'
                }
                className="font-mono text-xs"
              />
              <Button
                variant="outline"
                disabled={!canPreview || doPreview.isPending}
                onClick={() => doPreview.mutate(input)}
              >
                {doPreview.isPending ? <Loader2 className="animate-spin" /> : <Eye />} Preview
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              {kind === 'google'
                ? 'Share the sheet as “Anyone with the link — Viewer” (or Publish to web). The tab in the link is the one that’s read. AgentForge only reads it.'
                : 'The file is re-read on every sync, so you can keep editing it in Excel.'}
            </p>
          </div>

          {preview && (
            <div className="space-y-3 rounded-lg border p-3">
              {preview.sheets.length > 1 && (
                <div className="flex items-center gap-2">
                  <Label className="text-xs">Worksheet</Label>
                  <Select
                    value={sheet ?? preview.sheets[0]}
                    onValueChange={(v) => {
                      setSheet(v);
                      doPreview.mutate({ ...input, sheet: v });
                    }}
                  >
                    <SelectTrigger className="h-8 w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {preview.sheets.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                {SHOWN_FIELDS.map((f) => (
                  <div key={f} className="flex items-center gap-2">
                    <span className="text-muted-foreground w-28 shrink-0 text-xs">
                      {FIELD_LABELS[f]}
                    </span>
                    <Select value={columns[f] ?? AUTO} onValueChange={(v) => setCol(f, v)}>
                      <SelectTrigger className="h-7 flex-1 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={AUTO}>
                          {preview.columns[f] ? `Auto: ${preview.columns[f]}` : 'Auto: not found'}
                        </SelectItem>
                        {preview.headers
                          .filter((h) => h)
                          .map((h) => (
                            <SelectItem key={h} value={h}>
                              {h}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              {preview.warnings.map((w) => (
                <p key={w} className="text-warning flex items-start gap-1 text-xs">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {w}
                </p>
              ))}
              <p className="text-sm">
                <b>{pending}</b> task{pending === 1 ? '' : 's'} to import
                {preview.total - pending > 0 && (
                  <span className="text-muted-foreground">
                    {' '}
                    ({preview.total - pending} marked done/skipped)
                  </span>
                )}
                , in the order agents will pick them up:
              </p>
              <PreviewTable preview={preview} />
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sheet-name">Name</Label>
              <Input
                id="sheet-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={location ? defaultName(kind, location) : 'Sprint backlog'}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheet-polling">Check for new rows</Label>
              <Select value={polling} onValueChange={setPolling}>
                <SelectTrigger id="sheet-polling" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POLLING.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <label className="flex items-start gap-3 text-sm">
              <Switch checked={autoStart} onCheckedChange={setAutoStart} className="mt-0.5" />
              <span>
                <span className="font-medium">Start working automatically</span>
                <span className="text-muted-foreground block text-xs">
                  New rows are approved right away and agents build them, highest priority first.
                  Turn off to review each task before it starts.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <Switch checked={autoEnrich} onCheckedChange={setAutoEnrich} className="mt-0.5" />
              <span>
                <span className="font-medium">Let the Planner detail each task first</span>
                <span className="text-muted-foreground block text-xs">
                  Adds acceptance criteria, affected files and subtasks from the codebase. Keeps the
                  sheet’s title and priority.
                </span>
              </span>
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!project || !canPreview || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending && <Loader2 className="animate-spin" />} Connect & import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function defaultName(kind: SheetKind, location: string): string {
  if (kind === 'file') {
    const base = location.split(/[\\/]/).pop() ?? '';
    return base.replace(/\.(xlsx|csv|tsv)$/i, '') || 'Tasks';
  }
  return 'Google Sheet';
}
