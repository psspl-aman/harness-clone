'use client';

import {
  AGENT_ROLES,
  cheapModelFor,
  cheapRouting,
  type Effort,
  type ProjectDetail,
  type RoleEngines,
  type RoleModels,
  type UpdateProjectInput,
} from '@ai-harness/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  FileLock2,
  FileSpreadsheet,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Zap,
} from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { EffortSelect, EngineRoles, useResolvedEngines } from '@/components/projects/engine-roles';
import { useUnsavedGuard } from '@/hooks/use-unsaved-guard';
import { PipelineSettingsCard } from '@/components/projects/pipeline-settings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiClientError, qk } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { SheetSourcesSection } from '@/components/integrations/sheet-sources';
import { CommandsCard } from './commands-card';
import { ProjectCostCard } from './project-cost';
import { TrackerLinksCard } from './tracker-links';

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

function EnginesCard({ project }: { project: ProjectDetail }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  const [edits, setEdits] = useState<Partial<RoleEngines> | null>(null);
  const [modelEdits, setModelEdits] = useState<RoleModels | null>(null);
  const [effortEdit, setEffortEdit] = useState<{ v: Effort | null } | null>(null);
  const value = edits ?? project.roleEngines;
  const models = modelEdits ?? project.roleModels;
  const effort = effortEdit ? effortEdit.v : project.effort;
  const dirty =
    (edits !== null && JSON.stringify(edits) !== JSON.stringify(project.roleEngines)) ||
    (modelEdits !== null && JSON.stringify(modelEdits) !== JSON.stringify(project.roleModels)) ||
    (effortEdit !== null && effortEdit.v !== project.effort);
  const cardRef = useRef<HTMLDivElement>(null);
  useUnsavedGuard(dirty, cardRef);
  const resolved = useResolvedEngines(value);
  const discard = () => {
    setEdits(null);
    setModelEdits(null);
    setEffortEdit(null);
  };
  const save = useMutation({
    mutationFn: (input: UpdateProjectInput) => api.projects.update(project.id, input),
    onSuccess: (p, input) => {
      queryClient.setQueryData(qk.project(p.id), p);
      discard();
      toast.success(
        input.pipeline
          ? input.effort === 'low'
            ? 'Cheap mode on — cheapest models, low effort, LITE pipeline for xs/s tasks'
            : 'Reset to defaults'
          : 'Agent engines saved',
      );
    },
    onError: (e) => toast.error('Could not save', { description: errMsg(e) }),
  });
  const cheapMode = () => {
    if (!settings.data) return;
    const cheap: RoleModels = {};
    for (const role of AGENT_ROLES) {
      const engineId = resolved[role];
      const m = cheapModelFor(engineId, engines.data?.find((e) => e.id === engineId)?.models);
      if (m) cheap[role] = m;
    }
    save.mutate({
      roleEngines: value,
      roleModels: cheap,
      effort: 'low',
      pipeline: { routing: cheapRouting(project.pipeline.routing ?? settings.data.routing) },
    });
  };
  const reset = () =>
    save.mutate({ roleEngines: value, roleModels: {}, effort: null, pipeline: { routing: null } });
  return (
    <div ref={cardRef}>
      <Section
        title="Agent engines & models"
        description="Per-role engine and model overrides for this project."
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {dirty ? (
              <>
                <Badge variant="outline" className="border-warning text-warning" role="status">
                  Unsaved changes
                </Badge>
                <Button size="sm" variant="ghost" onClick={discard} disabled={save.isPending}>
                  Discard
                </Button>
                <Button
                  size="sm"
                  onClick={() => save.mutate({ roleEngines: value, roleModels: models, effort })}
                  disabled={save.isPending}
                >
                  {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={cheapMode}
                  disabled={save.isPending || !settings.data}
                  title="Cheapest model per engine (Haiku on Claude Code), low effort, and the LITE pipeline for xs/s tasks"
                >
                  <Zap /> Cheap mode
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={reset}
                  disabled={save.isPending}
                  title="Clear model, effort and routing overrides (engine choices stay)"
                >
                  <RotateCcw /> Reset to defaults
                </Button>
              </>
            )}
          </div>
        }
      >
        <div className="space-y-2">
          <EngineRoles
            value={value}
            onChange={setEdits}
            models={models}
            onModelsChange={setModelEdits}
            effort={effort}
          />
          <div className="rounded-xl border">
            <EffortSelect value={effort} onChange={(v) => setEffortEdit({ v })} />
          </div>
        </div>
      </Section>
    </div>
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
          description="Names only — AI Harness never reads their values."
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
      <ProjectCostCard projectId={p.id} />
      <AnalysisCards project={p} />
      <EnginesCard project={p} />
      <PipelineSettingsCard project={p} />
      <TrackerLinksCard projectId={p.id} />
      <Section
        title="Spreadsheets"
        description="Rows of a Google Sheet or Excel file become tasks of this project, in priority order."
        icon={<FileSpreadsheet className="size-4" />}
      >
        <SheetSourcesSection projectId={p.id} />
      </Section>
    </div>
  );
}
