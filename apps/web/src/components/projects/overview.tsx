'use client';

import {
  COMMAND_KEYS,
  type ProjectCommandsDto,
  type ProjectDetail,
  type RoleEngines,
} from '@agentforge/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  FileLock2,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  RefreshCw,
  Save,
  Wand2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { EngineRoles } from '@/components/projects/engine-roles';
import { PipelineSettingsCard } from '@/components/projects/pipeline-settings';
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
import { api, ApiClientError, qk } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { TrackerLinksCard } from './tracker-links';

const COMMAND_LABELS: Record<(typeof COMMAND_KEYS)[number], string> = {
  install: 'Install',
  run: 'Run (dev server)',
  build: 'Build',
  test: 'Test',
  lint: 'Lint / check',
};

const errMsg = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));

function Section({
  title,
  description,
  icon,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('gap-4 shadow-xs', className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            {icon}
            {title}
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function OnboardingBanner({ project, onRetry }: { project: ProjectDetail; onRetry: () => void }) {
  if (project.onboardingStatus === 'running' || project.onboardingStatus === 'pending') {
    return (
      <div
        role="status"
        className="bg-accent/60 text-accent-foreground flex items-center gap-3 rounded-xl border px-4 py-3 text-sm"
      >
        <Loader2 className="size-4 animate-spin" /> Analysing the project — detecting stack,
        commands and conventions…
      </div>
    );
  }
  if (project.onboardingStatus === 'failed') {
    return (
      <div
        role="alert"
        className="bg-destructive/10 text-destructive border-destructive/20 flex items-center gap-3 rounded-xl border px-4 py-3 text-sm"
      >
        <AlertTriangle className="size-4" />
        <span className="flex-1">Analysis failed: {project.onboardingError}</span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw /> Retry
        </Button>
      </div>
    );
  }
  return null;
}

function CommandsCard({ project }: { project: ProjectDetail }) {
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<ProjectCommandsDto | null>(null);
  const values = edits ?? project.commands;
  const detected = project.onboardingReport?.commands ?? {};
  const dirty =
    edits !== null && COMMAND_KEYS.some((k) => (edits[k] ?? '') !== (project.commands[k] ?? ''));
  const save = useMutation({
    mutationFn: () =>
      api.projects.update(project.id, {
        commands: Object.fromEntries(COMMAND_KEYS.map((k) => [k, values[k] ?? null])),
      }),
    onSuccess: (p) => {
      queryClient.setQueryData(qk.project(p.id), p);
      setEdits(null);
      toast.success('Commands saved');
    },
    onError: (e) => toast.error('Could not save commands', { description: errMsg(e) }),
  });
  return (
    <Section
      title="Commands"
      description="Used to install, run, build and test the project. Confirm or edit what was detected."
      icon={<Wand2 className="text-primary size-4" />}
      action={
        dirty && (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEdits(null)}>
              Discard
            </Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
            </Button>
          </div>
        )
      }
    >
      <div className="space-y-3">
        {COMMAND_KEYS.map((k) => {
          const d = detected[k];
          const differs = d && d.command !== (values[k] ?? '');
          return (
            <div key={k} className="grid items-center gap-1.5 sm:grid-cols-[150px_1fr]">
              <label htmlFor={`cmd-${k}`} className="text-sm font-medium">
                {COMMAND_LABELS[k]}
              </label>
              <div>
                <Input
                  id={`cmd-${k}`}
                  value={values[k] ?? ''}
                  placeholder="Not set"
                  onChange={(e) => setEdits({ ...values, [k]: e.target.value })}
                  className="h-8 font-mono text-xs"
                />
                {d && (
                  <p className="text-muted-foreground mt-1 text-[11px]">
                    Detected from {d.source}
                    {differs && (
                      <>
                        {' · '}
                        <button
                          className="text-primary hover:underline"
                          onClick={() => setEdits({ ...values, [k]: d.command })}
                        >
                          use <code>{d.command}</code>
                        </button>
                      </>
                    )}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function EnginesCard({ project }: { project: ProjectDetail }) {
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Partial<RoleEngines> | null>(null);
  const value = edits ?? project.roleEngines;
  const dirty = edits !== null && JSON.stringify(edits) !== JSON.stringify(project.roleEngines);
  const save = useMutation({
    mutationFn: () => api.projects.update(project.id, { roleEngines: value }),
    onSuccess: (p) => {
      queryClient.setQueryData(qk.project(p.id), p);
      setEdits(null);
      toast.success('Agent engines saved');
    },
    onError: (e) => toast.error('Could not save', { description: errMsg(e) }),
  });
  return (
    <Section
      title="Agent engines"
      description="Per-role overrides for this project."
      action={
        dirty && (
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
          </Button>
        )
      }
    >
      <EngineRoles value={value} onChange={setEdits} />
    </Section>
  );
}

function AnalysisCards({ project }: { project: ProjectDetail }) {
  const r = project.onboardingReport;
  if (!r) return null;
  const colors = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'];
  return (
    <>
      <Section
        title="Stack"
        description={`${r.stats.files.toLocaleString()} files · ${r.stats.dirs.toLocaleString()} folders · analysed ${timeAgo(r.analyzedAt)}`}
      >
        <div className="space-y-4">
          {r.languages.length > 0 && (
            <div className="space-y-2">
              <div className="flex h-2 overflow-hidden rounded-full" aria-hidden>
                {r.languages.map((l, i) => (
                  <div
                    key={l.name}
                    className={colors[i % colors.length]}
                    style={{ width: `${l.share}%` }}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {r.languages.map((l, i) => (
                  <span key={l.name} className="flex items-center gap-1.5">
                    <span className={cn('size-2 rounded-full', colors[i % colors.length])} />
                    {l.name} <span className="text-muted-foreground">{l.share}%</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {r.frameworks.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {r.frameworks.map((f) => (
                <Badge key={f} variant="secondary">
                  {f}
                </Badge>
              ))}
            </div>
          )}
          <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Package manager</dt>
            <dd>{r.packageManagers.join(', ') || '—'}</dd>
            {r.monorepo && (
              <>
                <dt className="text-muted-foreground">Monorepo</dt>
                <dd>
                  {r.monorepo.tool}
                  {r.monorepo.packages.length > 0 && (
                    <span className="text-muted-foreground font-mono text-xs">
                      {' '}
                      · {r.monorepo.packages.join(', ')}
                    </span>
                  )}
                </dd>
              </>
            )}
          </dl>
          {r.notes.length > 0 && (
            <ul className="text-muted-foreground space-y-1 text-xs">
              {r.notes.map((n) => (
                <li key={n}>• {n}</li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section
        title="Conventions"
        description="Detected from config files; saved to project memory for every agent."
      >
        {r.conventions.length ? (
          <ul className="space-y-1.5 text-sm">
            {r.conventions.map((c) => (
              <li key={c} className="flex gap-2">
                <span className="text-primary">✓</span>
                {c}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No conventions detected yet.</p>
        )}
      </Section>

      <Section title="Structure">
        {r.structure ? (
          <pre className="bg-muted/50 max-h-80 overflow-auto rounded-lg p-3 font-mono text-xs leading-relaxed">
            {r.structure}
          </pre>
        ) : (
          <p className="text-muted-foreground text-sm">The folder is empty.</p>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Git" icon={<GitBranch className="size-4" />}>
          {r.git.isRepo ? (
            <dl className="grid grid-cols-[90px_1fr] gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Branch</dt>
              <dd className="font-mono text-xs">{r.git.branch ?? '—'}</dd>
              <dt className="text-muted-foreground">Remote</dt>
              <dd className="truncate font-mono text-xs">{r.git.remote ?? 'none'}</dd>
              <dt className="text-muted-foreground">Working tree</dt>
              <dd>{r.git.dirty === null ? '—' : r.git.dirty ? 'Uncommitted changes' : 'Clean'}</dd>
              {r.git.lastCommit && (
                <>
                  <dt className="text-muted-foreground">Last commit</dt>
                  <dd className="flex min-w-0 items-center gap-1.5 text-xs">
                    <GitCommitHorizontal className="size-3.5 shrink-0" />
                    <code>{r.git.lastCommit.hash.slice(0, 7)}</code>
                    <span className="truncate">{r.git.lastCommit.message}</span>
                  </dd>
                </>
              )}
            </dl>
          ) : (
            <p className="text-muted-foreground text-sm">Not a git repository.</p>
          )}
        </Section>
        <Section
          title="Environment files"
          icon={<FileLock2 className="size-4" />}
          description="Names only — AgentForge never reads their values."
        >
          {r.envFiles.length ? (
            <div className="flex flex-wrap gap-1.5">
              {r.envFiles.map((f) => (
                <Badge key={f} variant="outline" className="font-mono">
                  {f}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">None found.</p>
          )}
        </Section>
      </div>
    </>
  );
}

export function RemoveDialog({
  project,
  open,
  onOpenChange,
}: {
  project: ProjectDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const [confirm, setConfirm] = useState('');
  const remove = useMutation({
    mutationFn: () => api.projects.remove(project.id),
    onSuccess: () => {
      toast.success(`Removed ${project.name}`, { description: 'Files on disk were not touched.' });
      router.push('/');
    },
    onError: (e) => toast.error('Could not remove project', { description: errMsg(e) }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {project.name} from AgentForge?</DialogTitle>
          <DialogDescription>
            Its plans, tasks, run history and memory are deleted from AgentForge. The folder{' '}
            <code className="font-mono">{project.localPath}</code> and its git history stay exactly
            as they are.
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder={`Type ${project.name} to confirm`}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-label="Confirm project name"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={confirm !== project.name || remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending && <Loader2 className="animate-spin" />} Remove project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Project overview tab: onboarding analysis, commands and engine overrides. */
export function ProjectOverview({ project: p }: { project: ProjectDetail }) {
  const analyze = useMutation({
    mutationFn: () => api.projects.analyze(p.id),
    onError: (e) => toast.error('Could not start analysis', { description: errMsg(e) }),
  });
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      <OnboardingBanner project={p} onRetry={() => analyze.mutate()} />
      {p.stackPreferences && (
        <Section title="Stack preferences">
          <p className="text-sm whitespace-pre-wrap">{p.stackPreferences}</p>
        </Section>
      )}
      <CommandsCard key={`cmd-${p.onboardedAt}`} project={p} />
      <AnalysisCards project={p} />
      <EnginesCard project={p} />
      <PipelineSettingsCard project={p} />
      <TrackerLinksCard projectId={p.id} />
    </div>
  );
}
