'use client';

import type { GitBranchDto, GitChangeDto, GitOverviewDto, GitTaskRefDto } from '@agentforge/shared';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  Bot,
  Check,
  CircleDot,
  Cloud,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { DiffView } from '@/components/diff-view';
import { STATUS } from '@/components/plan/badges';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { api, qk } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DeleteBranchDialog, NewBranchDialog, PullRequestDialog } from './git-dialogs';
import { errMsg, useGitAction } from './use-git';

type OpenTask = (taskId: string) => void;

const STATE: Record<GitTaskRefDto['state'], { label: string; cls: string }> = {
  merged: {
    label: 'Merged',
    cls: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  },
  pull_request: {
    label: 'In pull request',
    cls: 'bg-sky-500/12 text-sky-700 dark:text-sky-400 border-sky-500/25',
  },
  in_progress: {
    label: 'In progress',
    cls: 'bg-violet-500/12 text-violet-700 dark:text-violet-400 border-violet-500/25',
  },
  cancelled: { label: 'Cancelled', cls: 'bg-muted text-muted-foreground' },
  done: { label: 'Done', cls: 'bg-muted text-muted-foreground' },
};

const CHANGE: Record<GitChangeDto['kind'], { label: string; cls: string }> = {
  modified: { label: 'M', cls: 'text-amber-600 dark:text-amber-400' },
  added: { label: 'A', cls: 'text-emerald-600 dark:text-emerald-400' },
  deleted: { label: 'D', cls: 'text-destructive' },
  renamed: { label: 'R', cls: 'text-sky-600 dark:text-sky-400' },
  untracked: { label: 'U', cls: 'text-emerald-600 dark:text-emerald-400' },
  conflicted: { label: '!', cls: 'text-destructive font-bold' },
};

/** Branches, what each task did on which branch, and everyday git actions. */
export function GitTab({ projectId, onOpenTask }: { projectId: string; onOpenTask: OpenTask }) {
  const q = useQuery({
    queryKey: qk.git(projectId),
    queryFn: () => api.git.overview(projectId),
    refetchInterval: 15_000,
  });
  const [view, setView] = useState('branches');

  if (q.isPending)
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  if (q.isError)
    return (
      <div className="text-muted-foreground p-10 text-center text-sm">
        Could not read the repository: {errMsg(q.error)}
      </div>
    );
  const o = q.data;
  if (!o.isRepo) return <NotARepo overview={o} />;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <StatusCard overview={o} onShowChanges={() => setView('changes')} />
      {o.operation && <OperationAlert overview={o} />}
      <Tabs value={view} onValueChange={setView}>
        <TabsList>
          <TabsTrigger value="branches">
            Branches <CountBadge n={o.branches.filter((b) => b.kind === 'local').length} />
          </TabsTrigger>
          <TabsTrigger value="work">
            Work by branch <CountBadge n={o.work.reduce((a, g) => a + g.tasks.length, 0)} />
          </TabsTrigger>
          <TabsTrigger value="changes">
            Changes <CountBadge n={o.changes.length} />
          </TabsTrigger>
        </TabsList>
        <TabsContent value="branches">
          {o.branches.length ? (
            <BranchesView overview={o} onOpenTask={onOpenTask} />
          ) : (
            <Card className="flex flex-col items-center gap-3 p-10 text-center text-sm">
              <GitCommitHorizontal className="text-muted-foreground size-6" />
              <p className="font-medium">No commits yet on {o.current ?? 'this repository'}</p>
              <p className="text-muted-foreground max-w-md">
                Agents start their branches from a commit, so make a first commit of the current
                files. Secret files and dependency folders are left out.
              </p>
              {o.changes.length > 0 && (
                <Button size="sm" onClick={() => setView('changes')}>
                  Review {o.changes.length} files and commit
                </Button>
              )}
            </Card>
          )}
        </TabsContent>
        <TabsContent value="work">
          <WorkView overview={o} onOpenTask={onOpenTask} />
        </TabsContent>
        <TabsContent value="changes">
          <ChangesView overview={o} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const CountBadge = ({ n }: { n: number }) =>
  n ? (
    <span className="bg-muted-foreground/15 rounded-full px-1.5 text-[11px] tabular-nums">{n}</span>
  ) : null;

function NotARepo({ overview }: { overview: GitOverviewDto }) {
  const action = useGitAction(overview.projectId);
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 p-16 text-center">
      <GitBranch className="text-muted-foreground size-8" />
      <h2 className="text-lg font-semibold">This folder isn’t a git repository</h2>
      <p className="text-muted-foreground text-sm">
        Agents work on their own branches, so AgentForge needs git. Initialising commits the current
        files on <span className="font-mono">main</span> — secret files like .env are left out.
      </p>
      <Button
        onClick={() => action.mutate({ run: () => api.git.init(overview.projectId) })}
        disabled={action.isPending}
      >
        {action.isPending ? <Loader2 className="animate-spin" /> : <GitBranch />} Initialise git
      </Button>
    </div>
  );
}

function OperationAlert({ overview }: { overview: GitOverviewDto }) {
  const action = useGitAction(overview.projectId);
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>A {overview.operation} is in progress in the project folder</AlertTitle>
      <AlertDescription>
        <p>Resolve the conflicts and commit, or abort to go back to how things were.</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          disabled={action.isPending}
          onClick={() => action.mutate({ run: () => api.git.abort(overview.projectId) })}
        >
          Abort {overview.operation}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

// ─── Status ──────────────────────────────────────────────────────────────────

function StatusCard({
  overview: o,
  onShowChanges,
}: {
  overview: GitOverviewDto;
  onShowChanges: () => void;
}) {
  const action = useGitAction(o.projectId);
  const [busy, setBusy] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const run = (key: string, fn: () => ReturnType<typeof api.git.fetch>) => {
    setBusy(key);
    action.mutate({ run: fn }, { onSettled: () => setBusy(null) });
  };
  const locals = o.branches.filter((b) => b.kind === 'local');
  const remote = o.remotes[0];
  const spin = (key: string, Icon: typeof RefreshCw) =>
    busy === key ? <Loader2 className="animate-spin" /> : <Icon />;

  return (
    <Card className="gap-3 py-4">
      <CardContent className="flex flex-wrap items-start gap-x-8 gap-y-3 px-4">
        <div className="min-w-0 space-y-1">
          <p className="text-muted-foreground text-xs">Project folder is on</p>
          <p className="flex items-center gap-2 font-mono text-base font-semibold">
            <GitBranch className="size-4 shrink-0" />
            <span className="truncate" data-testid="git-current">
              {o.current ?? `detached at ${o.detachedAt}`}
            </span>
          </p>
          {o.changes.length > 0 ? (
            <button
              className="text-xs text-amber-600 hover:underline dark:text-amber-400"
              onClick={onShowChanges}
            >
              {o.changes.length} uncommitted change{o.changes.length === 1 ? '' : 's'}
            </button>
          ) : (
            <p className="text-muted-foreground flex items-center gap-1 text-xs">
              <Check className="size-3" /> Nothing uncommitted
            </p>
          )}
        </div>

        <div className="min-w-0 space-y-1">
          <p className="text-muted-foreground text-xs">Agents branch from and merge into</p>
          <Select
            value={o.workingBranch ?? ''}
            onValueChange={(b) =>
              b !== o.workingBranch &&
              run('working', () => api.git.setWorkingBranch(o.projectId, b))
            }
          >
            <SelectTrigger
              size="sm"
              className="min-w-40 font-mono text-xs"
              aria-label="Working branch"
            >
              <SelectValue placeholder="Pick a branch" />
            </SelectTrigger>
            <SelectContent>
              {locals.map((b) => (
                <SelectItem key={b.name} value={b.name} className="font-mono text-xs">
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-0 space-y-1">
          <p className="text-muted-foreground text-xs">Remote</p>
          {remote ? (
            <>
              <p className="flex items-center gap-1.5 text-sm">
                <Cloud className="size-3.5 shrink-0" />
                <span className="truncate font-mono text-xs" title={remote.url}>
                  {remote.name} · {remote.url.replace(/^https?:\/\//, '')}
                </span>
              </p>
              <p className="text-muted-foreground text-xs" data-testid="git-upstream">
                {o.upstream ? (
                  o.upstream.ahead || o.upstream.behind ? (
                    <>
                      {o.upstream.ahead > 0 && `${o.upstream.ahead} to push`}
                      {o.upstream.ahead > 0 && o.upstream.behind > 0 && ' · '}
                      {o.upstream.behind > 0 && `${o.upstream.behind} to pull`} ({o.upstream.name})
                    </>
                  ) : (
                    `In sync with ${o.upstream.name}`
                  )
                ) : o.current ? (
                  `${o.current} isn’t pushed yet`
                ) : null}
              </p>
            </>
          ) : (
            <p className="text-muted-foreground text-xs">No remote — local only</p>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {remote && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy}
                onClick={() => run('fetch', () => api.git.fetch(o.projectId))}
              >
                {spin('fetch', RefreshCw)} Fetch
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy || !o.upstream}
                onClick={() => run('pull', () => api.git.pull(o.projectId))}
              >
                {spin('pull', ArrowDownToLine)} Pull
              </Button>
            </>
          )}
          {(remote || o.githubRepo) && (
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy || !o.current}
              onClick={() => run('push', () => api.git.push(o.projectId))}
            >
              {spin('push', ArrowUpFromLine)} Push
            </Button>
          )}
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus /> New branch
          </Button>
        </div>
      </CardContent>
      <NewBranchDialog overview={o} open={newOpen} onOpenChange={setNewOpen} />
    </Card>
  );
}

// ─── Branches ────────────────────────────────────────────────────────────────

function BranchesView({
  overview: o,
  onOpenTask,
}: {
  overview: GitOverviewDto;
  onOpenTask: OpenTask;
}) {
  const [filter, setFilter] = useState('');
  const [showRemote, setShowRemote] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const list = useMemo(
    () =>
      o.branches.filter(
        (b) =>
          (showRemote || b.kind === 'local') &&
          (!filter ||
            b.name.toLowerCase().includes(filter.toLowerCase()) ||
            b.tasks.some((t) => t.key.toLowerCase().includes(filter.toLowerCase()))),
      ),
    [o.branches, filter, showRemote],
  );
  const selected =
    o.branches.find((b) => b.name === picked) ??
    o.branches.find((b) => b.current) ??
    o.branches[0] ??
    null;
  const remoteCount = o.branches.filter((b) => b.kind === 'remote').length;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex items-center gap-2 border-b p-2">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter branches or task keys"
              aria-label="Filter branches"
              className="h-8 pl-7 text-sm"
            />
          </div>
          {remoteCount > 0 && (
            <label className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
              <Switch
                checked={showRemote}
                onCheckedChange={setShowRemote}
                aria-label="Show remote branches"
              />
              Remote
            </label>
          )}
        </div>
        <ul className="max-h-[60vh] divide-y overflow-y-auto" aria-label="Branches">
          {list.map((b) => (
            <BranchRow
              key={b.name}
              overview={o}
              branch={b}
              selected={selected?.name === b.name}
              onSelect={() => setPicked(b.name)}
            />
          ))}
          {!list.length && (
            <li className="text-muted-foreground p-6 text-center text-sm">No branches match.</li>
          )}
          {showRemote && o.hiddenRemoteBranches > 0 && (
            <li className="text-muted-foreground p-3 text-center text-xs">
              {o.hiddenRemoteBranches} older remote branches aren’t listed.
            </li>
          )}
        </ul>
      </Card>
      {selected ? (
        <BranchDetail overview={o} branch={selected} onOpenTask={onOpenTask} />
      ) : (
        <Card className="text-muted-foreground p-10 text-center text-sm">
          No commits yet — make a first commit to see branches.
        </Card>
      )}
    </div>
  );
}

function BranchRow({
  overview: o,
  branch: b,
  selected,
  onSelect,
}: {
  overview: GitOverviewDto;
  branch: GitBranchDto;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li
      className={cn(
        'group flex items-start gap-1 px-2 py-2 transition-colors',
        selected ? 'bg-accent' : 'hover:bg-muted/60',
      )}
      data-testid="git-branch-row"
      data-branch={b.name}
    >
      <button className="min-w-0 flex-1 text-left" onClick={onSelect} aria-current={selected}>
        <div className="flex flex-wrap items-center gap-1.5">
          {b.kind === 'remote' ? (
            <Cloud className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <GitBranch className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <span className="truncate font-mono text-[13px] font-medium">{b.name}</span>
          {b.current && <Tag cls="bg-primary/12 text-primary border-primary/25">current</Tag>}
          {b.working && (
            <Tag cls="bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25">
              <Star className="size-2.5" /> working
            </Tag>
          )}
          {b.worktree && (
            <Tag cls="bg-violet-500/12 text-violet-700 dark:text-violet-400 border-violet-500/25">
              <Bot className="size-2.5" /> agent
            </Tag>
          )}
          {b.merged && !b.working && b.kind === 'local' && (
            <Tag cls="bg-muted text-muted-foreground">merged</Tag>
          )}
          {b.tasks.map((t) => (
            <Tag
              key={t.id}
              cls={STATUS[t.status].cls}
              title={`${t.title} — ${STATUS[t.status].label}`}
            >
              {t.key}
            </Tag>
          ))}
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-xs">
          {b.subject} · {b.author} · {timeAgo(b.date)}
        </p>
        <AheadBehind branch={b} working={o.workingBranch} />
      </button>
      <BranchMenu overview={o} branch={b} />
    </li>
  );
}

const Tag = ({
  cls,
  title,
  children,
}: {
  cls: string;
  title?: string;
  children: React.ReactNode;
}) => (
  <span
    title={title}
    className={cn(
      'inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-px text-[10px] leading-none font-medium',
      cls,
    )}
  >
    {children}
  </span>
);

function AheadBehind({ branch: b, working }: { branch: GitBranchDto; working: string | null }) {
  const parts: React.ReactNode[] = [];
  if (!b.working && b.ahead !== null && working)
    parts.push(
      <span key="w" title={`Compared with ${working}`} className="inline-flex items-center gap-1">
        <span className="inline-flex items-center">
          <ArrowUp className="size-3" />
          {b.ahead}
        </span>
        <span className="inline-flex items-center">
          <ArrowDown className="size-3" />
          {b.behind}
        </span>
        <span className="opacity-70">vs {working}</span>
      </span>,
    );
  if (b.upstreamGone) parts.push(<span key="g">upstream deleted</span>);
  else if (b.upstream && (b.upstreamAhead || b.upstreamBehind))
    parts.push(
      <span key="u">
        {b.upstreamAhead ? `${b.upstreamAhead} to push` : ''}
        {b.upstreamAhead && b.upstreamBehind ? ' · ' : ''}
        {b.upstreamBehind ? `${b.upstreamBehind} to pull` : ''}
      </span>,
    );
  else if (b.kind === 'local' && !b.upstream) parts.push(<span key="n">not pushed</span>);
  if (!parts.length) return null;
  return (
    <p className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 text-[11px] tabular-nums">
      {parts}
    </p>
  );
}

function BranchMenu({
  overview: o,
  branch: b,
}: {
  overview: GitOverviewDto;
  branch: GitBranchDto;
}) {
  const action = useGitAction(o.projectId);
  const [del, setDel] = useState<GitBranchDto | null>(null);
  const [pr, setPr] = useState<GitBranchDto | null>(null);
  const [newFrom, setNewFrom] = useState(false);
  const id = o.projectId;
  const local = b.kind === 'local';
  const canSwitch = !b.current && !b.worktree && (local || !b.hasLocal);
  const mergeTargets = [o.workingBranch, o.current].filter(
    (t, i, a): t is string => !!t && t !== b.name && a.indexOf(t) === i,
  );
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 opacity-70 group-hover:opacity-100"
            aria-label={`Actions for ${b.name}`}
          >
            {action.isPending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="truncate font-mono text-xs">{b.name}</DropdownMenuLabel>
          {canSwitch && (
            <DropdownMenuItem
              onSelect={() => action.mutate({ run: () => api.git.checkout(id, b.name) })}
            >
              <CircleDot /> {local ? 'Switch to this branch' : 'Check out locally'}
            </DropdownMenuItem>
          )}
          {local &&
            !b.merged &&
            mergeTargets.map((t) => (
              <DropdownMenuItem
                key={t}
                onSelect={() =>
                  action.mutate({ run: () => api.git.merge(id, { source: b.name, target: t }) })
                }
              >
                <GitMerge /> Merge into <span className="truncate font-mono text-xs">{t}</span>
              </DropdownMenuItem>
            ))}
          {local && !b.working && (
            <DropdownMenuItem
              onSelect={() => action.mutate({ run: () => api.git.setWorkingBranch(id, b.name) })}
            >
              <Star /> Make it the working branch
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setNewFrom(true)}>
            <Plus /> New branch from here
          </DropdownMenuItem>
          {local && (o.remotes.length > 0 || o.githubRepo) && (
            <DropdownMenuItem
              onSelect={() => action.mutate({ run: () => api.git.push(id, b.name) })}
            >
              <Upload /> Push
            </DropdownMenuItem>
          )}
          {local && o.githubRepo && !b.working && (
            <DropdownMenuItem onSelect={() => setPr(b)}>
              <GitPullRequest /> Open pull request
            </DropdownMenuItem>
          )}
          {local && !b.current && !b.working && !b.default && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDel(b)}>
                <Trash2 /> Delete branch
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteBranchDialog projectId={id} branch={del} onOpenChange={(v) => !v && setDel(null)} />
      <PullRequestDialog overview={o} branch={pr} onOpenChange={(v) => !v && setPr(null)} />
      {newFrom && (
        <NewBranchDialog overview={o} from={b.name} open={newFrom} onOpenChange={setNewFrom} />
      )}
    </>
  );
}

// ─── Branch detail ───────────────────────────────────────────────────────────

const PLAIN = '__history__';

function BranchDetail({
  overview: o,
  branch: b,
  onOpenTask,
}: {
  overview: GitOverviewDto;
  branch: GitBranchDto;
  onOpenTask: OpenTask;
}) {
  // undefined = let the daemon pick (the working branch); null = plain history.
  const [baseFor, setBaseFor] = useState<{ branch: string; base: string | null } | null>(null);
  const base = baseFor?.branch === b.name ? baseFor.base : undefined;
  const q = useQuery({
    queryKey: qk.gitBranch(o.projectId, b.name, base),
    queryFn: () => api.git.branch(o.projectId, b.name, base),
  });
  const [showDiff, setShowDiff] = useState(false);
  const d = q.data;
  const choices = o.branches.filter((x) => x.kind === 'local' && x.name !== b.name);

  return (
    <Card className="min-w-0 gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex flex-wrap items-center gap-2 font-mono text-base">
          <GitBranch className="size-4" /> {b.name}
        </CardTitle>
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <span>Compare with</span>
          <Select
            value={
              d ? (d.base ?? PLAIN) : base === null ? PLAIN : (base ?? o.workingBranch ?? PLAIN)
            }
            onValueChange={(v) => setBaseFor({ branch: b.name, base: v === PLAIN ? null : v })}
          >
            <SelectTrigger
              size="sm"
              className="h-7 min-w-36 font-mono text-xs"
              aria-label="Compare with"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PLAIN}>Nothing (full history)</SelectItem>
              {choices.map((x) => (
                <SelectItem key={x.name} value={x.name} className="font-mono text-xs">
                  {x.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {b.worktree && (
            <span className="flex items-center gap-1">
              <Bot className="size-3" /> An agent has it checked out in its own folder
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        {q.isPending ? (
          <Skeleton className="h-40" />
        ) : q.isError ? (
          <p className="text-destructive text-sm">{errMsg(q.error)}</p>
        ) : (
          <>
            {d!.tasks.length > 0 && (
              <section>
                <h3 className="mb-1.5 text-xs font-semibold tracking-wide uppercase">Tasks</h3>
                <ul className="space-y-1">
                  {d!.tasks.map((t) => (
                    <TaskLine key={t.id} task={t} onOpenTask={onOpenTask} here={b.name} />
                  ))}
                </ul>
              </section>
            )}
            <section>
              <h3 className="mb-1.5 text-xs font-semibold tracking-wide uppercase">
                {d!.base ? `Commits not in ${d!.base}` : 'History'}{' '}
                <span className="text-muted-foreground font-normal normal-case">
                  ({d!.commits.length}
                  {d!.commitsTruncated ? '+' : ''})
                </span>
              </h3>
              {d!.commits.length ? (
                <ol className="divide-y rounded-lg border">
                  {d!.commits.map((c) => (
                    <li key={c.hash} className="flex items-start gap-2 px-3 py-1.5 text-sm">
                      {c.isMerge ? (
                        <GitMerge className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                      ) : (
                        <GitCommitHorizontal className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate" title={c.subject}>
                          {c.subject}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          <span className="font-mono">{c.shortHash}</span> · {c.author} ·{' '}
                          {timeAgo(c.date)}
                        </p>
                      </div>
                      {c.task && (
                        <button
                          className="text-primary shrink-0 font-mono text-xs hover:underline"
                          title={c.task.title}
                          onClick={() => onOpenTask(c.task!.id)}
                        >
                          {c.task.key}
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-muted-foreground text-sm">
                  {d!.base ? `Nothing here that ${d!.base} doesn’t already have.` : 'No commits.'}
                </p>
              )}
            </section>
            {d!.diff && d!.diff.files.length > 0 && (
              <section>
                <Button variant="outline" size="sm" onClick={() => setShowDiff((v) => !v)}>
                  <FileDiff /> {showDiff ? 'Hide' : 'Show'} changes vs {d!.base} (
                  {d!.diff.files.length} file
                  {d!.diff.files.length === 1 ? '' : 's'})
                </Button>
                {showDiff && (
                  <div className="mt-3">
                    <DiffView diff={d!.diff} />
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TaskLine({
  task: t,
  onOpenTask,
  here,
}: {
  task: GitTaskRefDto;
  onOpenTask: OpenTask;
  here?: string;
}) {
  const s = STATE[t.state];
  const where =
    t.state === 'merged'
      ? t.mergedInto !== here && `into ${t.mergedInto}`
      : t.branchName && t.branchName !== here
        ? `on ${t.branchName}`
        : null;
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
      <button
        className="text-primary font-mono text-xs font-medium hover:underline"
        onClick={() => onOpenTask(t.id)}
      >
        {t.key}
      </button>
      <span className="min-w-0 flex-1 truncate">{t.title}</span>
      {where && <span className="text-muted-foreground truncate font-mono text-xs">{where}</span>}
      {t.mergeCommit && (
        <span className="text-muted-foreground font-mono text-xs" title="Merge commit">
          {t.mergeCommit.slice(0, 7)}
        </span>
      )}
      {t.pullRequestUrl && (
        <a
          href={t.pullRequestUrl}
          target="_blank"
          rel="noreferrer"
          className="text-primary inline-flex items-center gap-0.5 text-xs hover:underline"
        >
          PR <ExternalLink className="size-3" />
        </a>
      )}
      <Badge variant="outline" className={cn('text-[10px]', s.cls)}>
        {s.label}
      </Badge>
      <span className="text-muted-foreground w-16 text-right text-xs">
        {timeAgo(t.completedAt ?? t.updatedAt)}
      </span>
    </li>
  );
}

// ─── Work by branch ──────────────────────────────────────────────────────────

function WorkView({ overview: o, onOpenTask }: { overview: GitOverviewDto; onOpenTask: OpenTask }) {
  if (!o.work.length)
    return (
      <Card className="text-muted-foreground p-10 text-center text-sm">
        No agent work yet. When tasks run, each one gets its own branch and lands here once it’s
        merged.
      </Card>
    );
  return (
    <div className="space-y-3">
      {o.work.map((g) => {
        const counts = g.tasks.reduce<Record<string, number>>(
          (a, t) => ({ ...a, [t.state]: (a[t.state] ?? 0) + 1 }),
          {},
        );
        return (
          <Card key={g.branch} className="gap-2 py-3" data-testid="git-work-group">
            <CardHeader className="px-4">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                <GitBranch className="size-4" />
                <span className="font-mono">{g.branch}</span>
                {g.branch === o.workingBranch && (
                  <Tag cls="bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25">
                    working
                  </Tag>
                )}
                {!g.exists && <Tag cls="bg-muted text-muted-foreground">branch not found</Tag>}
                <span className="text-muted-foreground ml-auto text-xs font-normal">
                  {Object.entries(counts)
                    .map(
                      ([k, n]) => `${n} ${STATE[k as GitTaskRefDto['state']].label.toLowerCase()}`,
                    )
                    .join(' · ')}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              <ul className="space-y-1.5">
                {g.tasks.map((t) => (
                  <TaskLine key={t.id} task={t} onOpenTask={onOpenTask} here={g.branch} />
                ))}
              </ul>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ─── Uncommitted changes ─────────────────────────────────────────────────────

function ChangesView({ overview: o }: { overview: GitOverviewDto }) {
  const action = useGitAction(o.projectId);
  const [message, setMessage] = useState('');
  if (!o.changes.length)
    return (
      <Card className="text-muted-foreground flex flex-col items-center gap-2 p-10 text-center text-sm">
        <Check className="size-5" /> Nothing uncommitted on {o.current ?? 'this checkout'}.
      </Card>
    );
  return (
    <Card className="gap-3 py-4">
      <CardContent className="space-y-3 px-4">
        <ul
          className="max-h-[45vh] divide-y overflow-y-auto rounded-lg border"
          aria-label="Uncommitted changes"
        >
          {o.changes.map((c) => (
            <li key={`${c.kind}:${c.path}`} className="flex items-center gap-2 px-3 py-1 text-sm">
              <span className={cn('w-3 font-mono text-xs', CHANGE[c.kind].cls)} title={c.kind}>
                {CHANGE[c.kind].label}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={c.path}>
                {c.from ? `${c.from} → ` : ''}
                {c.path}
              </span>
              <span className="text-muted-foreground text-xs">{c.kind}</span>
            </li>
          ))}
        </ul>
        {o.changesTruncated && (
          <p className="text-muted-foreground text-xs">
            Showing the first {o.changes.length} files.
          </p>
        )}
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            action.mutate(
              { run: () => api.git.commit(o.projectId, message) },
              { onSuccess: () => setMessage('') },
            );
          }}
        >
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Describe the change"
            aria-label="Commit message"
            rows={2}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">
              Commits every change on <span className="font-mono">{o.current ?? 'HEAD'}</span>.
              Secret files (.env, keys) are always left out.
            </p>
            <Button type="submit" size="sm" disabled={!message.trim() || action.isPending}>
              {action.isPending ? <Loader2 className="animate-spin" /> : <GitCommitHorizontal />}{' '}
              Commit
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
