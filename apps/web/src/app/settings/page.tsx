'use client';

import {
  AGENT_ROLES,
  AppSettingsSchema,
  ROLE_LABELS,
  type AppSettings,
  type DeepPartial,
} from '@agentforge/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw, Save } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  EngineField,
  NumberField,
  SelectField,
  SwitchField,
  TextField,
} from '@/components/settings/fields';
import { PricingEditor } from '@/components/settings/pricing';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiClientError, qk } from '@/lib/api';
import { diffObjects } from '@/lib/diff';
import { formatDuration } from '@/lib/format';

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="gap-4 shadow-xs">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="divide-y">{children}</CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  const system = useQuery({ queryKey: qk.system, queryFn: api.system });
  // Local edits only; while there are none the form shows live server state,
  // so saves from another tab (via the settings.updated event) appear instantly.
  const [edits, setEdits] = useState<AppSettings | null>(null);
  const draft = edits ?? settings.data ?? null;

  const patch = useMemo(() => {
    if (!edits || !settings.data) return undefined;
    const d = diffObjects(settings.data, edits) as DeepPartial<AppSettings> | undefined;
    // The price table is saved as a whole (so removals stick).
    if (JSON.stringify(edits.pricing) !== JSON.stringify(settings.data.pricing))
      return { ...d, pricing: edits.pricing };
    return d;
  }, [edits, settings.data]);
  const dirty = patch !== undefined;
  const validation = draft ? AppSettingsSchema.safeParse(draft) : null;

  const save = useMutation({
    mutationFn: (p: DeepPartial<AppSettings>) => api.settings.update(p),
    onSuccess: (next) => {
      queryClient.setQueryData(qk.settings, next);
      setEdits(null);
      toast.success('Settings saved');
    },
    onError: (err) =>
      toast.error('Could not save settings', {
        description: err instanceof ApiClientError ? err.message : String(err),
      }),
  });

  const set = <K extends keyof AppSettings>(
    key: K,
    value: Partial<AppSettings[K]> | AppSettings[K],
  ) =>
    setEdits((current) => {
      const base = current ?? settings.data;
      if (!base) return current;
      return {
        ...base,
        [key]:
          typeof value === 'object' && value !== null && key !== 'pricing'
            ? { ...(base[key] as object), ...value }
            : value,
      };
    });

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 pb-28 md:px-8">
      <PageHeader
        title="Settings"
        description="Global defaults for every project. Projects can override most of these."
      />

      {!draft ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          <Section
            title="Default engines"
            description="Which agent engine runs each role unless a project or task overrides it."
          >
            {AGENT_ROLES.map((role) => (
              <EngineField
                key={role}
                id={`engine-${role}`}
                label={ROLE_LABELS[role]}
                value={draft.defaultEngines[role]}
                onChange={(v) =>
                  set('defaultEngines', { [role]: v as AppSettings['defaultEngines'][typeof role] })
                }
              />
            ))}
          </Section>

          <Section
            title="Pipeline"
            description="How tasks move through Develop → Review → Test → Fix → Document."
          >
            <NumberField
              id="maxFixLoops"
              label="Max fix loops per task"
              hint="After this many review/test failures the task goes to Needs human."
              min={0}
              max={10}
              value={draft.pipeline.maxFixLoops}
              onChange={(v) => set('pipeline', { maxFixLoops: v })}
            />
            <SwitchField
              id="requireHumanReview"
              label="Require my review before merge"
              hint="Adds a manual approval step after the AI reviewer."
              checked={draft.pipeline.requireHumanReviewBeforeMerge}
              onChange={(v) => set('pipeline', { requireHumanReviewBeforeMerge: v })}
            />
            <SelectField
              id="mergeStrategy"
              label="When a task is done"
              value={draft.pipeline.mergeStrategy}
              options={[
                { value: 'merge', label: 'Merge into working branch' },
                { value: 'pull_request', label: 'Open a GitHub PR' },
              ]}
              onChange={(v) => set('pipeline', { mergeStrategy: v })}
            />
          </Section>

          <Section
            title="Concurrency"
            description="Independent tasks run in parallel, each in its own git worktree."
          >
            <NumberField
              id="maxTasksPerProject"
              label="Parallel tasks per project"
              min={1}
              max={16}
              value={draft.concurrency.maxTasksPerProject}
              onChange={(v) => set('concurrency', { maxTasksPerProject: v })}
            />
            <NumberField
              id="maxRunsPerEngine"
              label="Parallel runs per engine"
              hint="Keeps you inside each CLI's rate limits."
              min={1}
              max={16}
              value={draft.concurrency.maxRunsPerEngine}
              onChange={(v) => set('concurrency', { maxRunsPerEngine: v })}
            />
          </Section>

          <Section
            title="Usage & sessions"
            description="Health checks and what happens when a usage window runs out."
          >
            <NumberField
              id="engineCheckIntervalSec"
              label="Engine health check interval"
              min={15}
              max={3600}
              suffix="sec"
              value={draft.health.engineCheckIntervalSec}
              onChange={(v) => set('health', { engineCheckIntervalSec: v })}
            />
            <NumberField
              id="probeInitialBackoffSec"
              label="Quota probe initial backoff"
              hint="Used when an error doesn’t say when the window resets."
              min={30}
              max={3600}
              suffix="sec"
              value={draft.quota.probeInitialBackoffSec}
              onChange={(v) => set('quota', { probeInitialBackoffSec: v })}
            />
            <NumberField
              id="probeMaxBackoffSec"
              label="Quota probe max backoff"
              min={60}
              max={86400}
              suffix="sec"
              value={draft.quota.probeMaxBackoffSec}
              onChange={(v) => set('quota', { probeMaxBackoffSec: v })}
            />
            <SwitchField
              id="fallbackEnabled"
              label="Fall back to another engine when exhausted"
              hint="Projects choose which engine to fall back to."
              checked={draft.quota.fallbackEnabled}
              onChange={(v) => set('quota', { fallbackEnabled: v })}
            />
          </Section>

          <Section
            title="Pricing"
            description="Cost estimates for engines that don't report their own cost."
          >
            <PricingEditor value={draft.pricing} onChange={(v) => set('pricing', v)} />
          </Section>

          <Section
            title="Memory & workspace"
            description="What agents remember and where cloned repos live."
          >
            <NumberField
              id="maxPromptChars"
              label="Memory budget per prompt"
              hint="Relevance-filtered memory injected into each agent prompt."
              min={500}
              max={100000}
              suffix="chars"
              value={draft.memory.maxPromptChars}
              onChange={(v) => set('memory', { maxPromptChars: v })}
            />
            <TextField
              id="workspaceRoot"
              label="Managed workspace folder"
              hint="Where GitHub repos are cloned. Leave empty for the default."
              placeholder={system.data ? `${system.data.homeDir}/workspaces` : 'default'}
              value={draft.workspaceRoot ?? ''}
              onChange={(v) => set('workspaceRoot', v.trim() === '' ? null : v)}
            />
          </Section>

          <Section title="Safety" description="Guardrails applied to every agent run.">
            <SwitchField
              id="confirmDangerous"
              label="Confirm dangerous commands"
              hint="Force-pushes, recursive deletes outside the project, reading secret files."
              checked={draft.safety.confirmDangerousCommands}
              onChange={(v) => set('safety', { confirmDangerousCommands: v })}
            />
            <SwitchField
              id="redactSecrets"
              label="Redact secrets from logs"
              checked={draft.safety.redactSecrets}
              onChange={(v) => set('safety', { redactSecrets: v })}
            />
          </Section>

          {system.data && (
            <Section title="System" description="The local AgentForge daemon.">
              {[
                ['Version', system.data.version],
                ['Data directory', system.data.homeDir],
                ['Database', system.data.dbPath],
                ['Workspace folder', system.data.workspaceRoot],
                ['Runtime', `Node ${system.data.nodeVersion} · ${system.data.platform}`],
                ['Uptime', formatDuration(system.data.uptimeSec)],
                ['Live connections', String(system.data.wsClients)],
              ].map(([k, v]) => (
                <div
                  key={k}
                  className="flex justify-between gap-4 py-2.5 text-sm first:pt-0 last:pb-0"
                >
                  <span className="text-muted-foreground">{k}</span>
                  <span className="truncate text-right font-mono text-xs">{v}</span>
                </div>
              ))}
            </Section>
          )}
        </div>
      )}

      {dirty && (
        <div className="bg-background/90 fixed inset-x-0 bottom-0 z-30 border-t backdrop-blur md:right-6 md:bottom-6 md:left-auto md:rounded-xl md:border md:shadow-lg">
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="text-sm">
              {validation && !validation.success ? (
                <span className="text-destructive">
                  {validation.error.issues[0]?.path.join('.')}:{' '}
                  {validation.error.issues[0]?.message}
                </span>
              ) : (
                'Unsaved changes'
              )}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setEdits(null)}>
              <RotateCcw /> Discard
            </Button>
            <Button
              size="sm"
              disabled={save.isPending || !validation?.success}
              onClick={() => patch && save.mutate(patch)}
            >
              {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
