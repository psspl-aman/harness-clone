'use client';

import {
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
  type MemoryEntryDto,
  type MemoryKind,
  type MemoryScope,
} from '@ai-harness/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain, Loader2, Pencil, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Markdown } from '@/components/markdown';
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
import { Textarea } from '@/components/ui/textarea';
import { api, ApiClientError, qk } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

const errMsg = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));

function MemoryDialog({
  projectId,
  entry,
  open,
  onOpenChange,
  defaultKind,
}: {
  projectId: string | null;
  entry?: MemoryEntryDto;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultKind: MemoryKind;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<MemoryKind>(entry?.kind ?? defaultKind);
  const [title, setTitle] = useState(entry?.title ?? '');
  const [content, setContent] = useState(entry?.content ?? '');
  const [tags, setTags] = useState((entry?.tags ?? []).join(', '));
  const [pinned, setPinned] = useState(entry?.pinned ?? false);
  const save = useMutation({
    mutationFn: () => {
      const v = {
        kind,
        title: title.trim(),
        content: content.trim(),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        pinned,
      };
      return entry ? api.memory.update(entry.id, v) : api.memory.create(projectId, v);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.memory(projectId) });
      onOpenChange(false);
    },
    onError: (e) => toast.error('Could not save', { description: errMsg(e) }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {entry ? 'Edit memory' : projectId ? 'Add to project memory' : 'Add a preference'}
          </DialogTitle>
          <DialogDescription>
            {projectId
              ? 'Agents working on this project get relevant entries in their prompts.'
              : 'Preferences apply to every project and every agent.'}
          </DialogDescription>
        </DialogHeader>
        <form
          id="memory-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <div className="space-y-1.5">
              <Label>Kind</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as MemoryKind)}>
                <SelectTrigger aria-label="Kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {MEMORY_KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mem-title">Title</Label>
              <Input
                id="mem-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={200}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mem-content">Content</Label>
            <Textarea
              id="mem-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              required
              placeholder="Markdown is fine."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mem-tags">Tags</Label>
            <Input
              id="mem-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="payments, api"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={pinned} onCheckedChange={setPinned} aria-label="Pinned" /> Pinned —
            always included in prompts
          </label>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="memory-form"
            disabled={save.isPending || !title.trim() || !content.trim()}
          >
            {save.isPending && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function sourceLabel(e: MemoryEntryDto): string {
  if (e.source === 'documenter') return e.taskKey ? `Documenter · ${e.taskKey}` : 'Documenter';
  if (e.source === 'onboarding') return 'Project analysis';
  if (e.source === 'planner') return 'Planner';
  return 'You';
}

function EntryCard({ entry: e, projectId }: { entry: MemoryEntryDto; projectId: string | null }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.memory(projectId) });
  const pin = useMutation({
    mutationFn: () => api.memory.update(e.id, { pinned: !e.pinned }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.memory.remove(e.id),
    onSuccess: refresh,
    onError: (x) => toast.error('Could not delete', { description: errMsg(x) }),
  });
  const long = e.content.length > 280 || e.content.split('\n').length > 5;
  return (
    <li
      className={cn(
        'bg-card group rounded-xl border p-4 shadow-xs',
        e.pinned && 'border-primary/40',
      )}
      data-testid="memory-entry"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {e.pinned && <Pin className="text-primary size-3.5" aria-label="Pinned" />}
            <h3 className="font-medium">{e.title}</h3>
            <Badge variant="secondary" className="font-normal">
              {MEMORY_KIND_LABELS[e.kind]}
            </Badge>
          </div>
          <div className="text-muted-foreground mt-0.5 text-xs">
            {sourceLabel(e)} · {timeAgo(e.updatedAt)}
            {e.tags.length > 0 && <> · {e.tags.map((t) => `#${t}`).join(' ')}</>}
          </div>
        </div>
        <div className="flex gap-0.5 opacity-70 group-hover:opacity-100">
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={e.pinned ? `Unpin ${e.title}` : `Pin ${e.title}`}
            onClick={() => pin.mutate()}
          >
            {e.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={`Edit ${e.title}`}
            onClick={() => setEdit(true)}
          >
            <Pencil className="size-3.5" />
          </Button>
          {confirm ? (
            <Button
              size="sm"
              variant="destructive"
              className="h-7"
              onClick={() => remove.mutate()}
              onBlur={() => setConfirm(false)}
              autoFocus
            >
              Delete?
            </Button>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={`Delete ${e.title}`}
              onClick={() => setConfirm(true)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      <div className={cn('relative mt-2', long && !expanded && 'max-h-28 overflow-hidden')}>
        <Markdown>{e.content}</Markdown>
        {long && !expanded && (
          <div className="from-card absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t" />
        )}
      </div>
      {long && (
        <button
          className="text-primary mt-1 text-xs hover:underline"
          onClick={() => setExpanded((x) => !x)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      {edit && (
        <MemoryDialog
          projectId={projectId}
          entry={e}
          open={edit}
          onOpenChange={setEdit}
          defaultKind={e.kind}
        />
      )}
    </li>
  );
}

/** Searchable memory list for a project (project + task notes) or the global preferences (projectId null). */
export function MemoryList({ projectId, budget }: { projectId: string | null; budget?: number }) {
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<MemoryKind | 'all'>('all');
  const [scope, setScope] = useState<MemoryScope>(projectId ? 'project' : 'global');
  const [adding, setAdding] = useState(false);
  const q = useQuery({
    queryKey: [...qk.memory(projectId), scope],
    queryFn: () => api.memory.list(projectId, projectId ? { scope } : {}),
  });
  const s = search.trim().toLowerCase();
  const entries = (q.data ?? []).filter(
    (e) =>
      (kind === 'all' || e.kind === kind) &&
      (!s || [e.title, e.content, e.tags.join(' ')].some((f) => f.toLowerCase().includes(s))),
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {projectId && (
          <div className="bg-muted flex rounded-lg p-0.5" role="tablist" aria-label="Memory scope">
            {(['project', 'task'] as const).map((sc) => (
              <button
                key={sc}
                role="tab"
                aria-selected={scope === sc}
                onClick={() => setScope(sc)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium',
                  scope === sc ? 'bg-background shadow-xs' : 'text-muted-foreground',
                )}
              >
                {sc === 'project' ? 'Project knowledge' : 'Completed tasks'}
              </button>
            ))}
          </div>
        )}
        <div className="relative min-w-48 flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search memory"
            className="h-8 pl-8"
            aria-label="Search memory"
          />
        </div>
        <Select value={kind} onValueChange={(v) => setKind(v as MemoryKind | 'all')}>
          <SelectTrigger className="h-8 w-36" aria-label="Filter by kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            {MEMORY_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {MEMORY_KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus /> {projectId ? 'Add memory' : 'Add preference'}
        </Button>
      </div>
      {projectId && (
        <p className="text-muted-foreground text-xs">
          Agents get pinned entries, conventions, commands, pitfalls and the entries most relevant
          to their task
          {budget ? ` (up to ${budget.toLocaleString()} characters)` : ''}. A readable copy is kept
          in <code className="font-mono">.ai-harness/memory.md</code> (not committed).
        </p>
      )}
      {q.isPending ? (
        <div className="text-muted-foreground text-sm">Loading…</div>
      ) : entries.length ? (
        <ul className="space-y-3">
          {entries.map((e) => (
            <EntryCard key={e.id} entry={e} projectId={projectId} />
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center">
          <Brain className="text-muted-foreground size-6" />
          <p className="text-muted-foreground max-w-sm text-sm">
            {q.data?.length
              ? 'Nothing matches your search.'
              : projectId
                ? scope === 'task'
                  ? 'Summaries of completed tasks appear here.'
                  : 'Nothing remembered yet. Project analysis and the Documenter add facts as work completes.'
                : 'No preferences yet — e.g. “Prefer function components” or “Use Vitest for tests”.'}
          </p>
        </div>
      )}
      {adding && (
        <MemoryDialog
          projectId={projectId}
          open={adding}
          onOpenChange={setAdding}
          defaultKind={projectId ? 'decision' : 'preference'}
        />
      )}
    </div>
  );
}
