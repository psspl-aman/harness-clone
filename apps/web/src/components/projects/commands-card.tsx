'use client';

import {
  COMMAND_KEYS,
  ProjectCommandsSchema,
  type CommandSuggestionDto,
  type ProjectCommandsDto,
  type ProjectDetail,
  type ProjectServiceDto,
} from '@ai-harness/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Server,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiClientError, qk } from '@/lib/api';
import { cn } from '@/lib/utils';

type Key = (typeof COMMAND_KEYS)[number];
const LABELS: Record<Key, string> = {
  install: 'Install',
  run: 'Run (dev server)',
  build: 'Build',
  test: 'Test',
  lint: 'Lint / check',
};
const errMsg = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));

interface Draft {
  commands: Record<Key, string>;
  services: { name: string; command: string; cwd: string; port: string }[];
}

const toDraft = (c: ProjectCommandsDto): Draft => ({
  commands: Object.fromEntries(COMMAND_KEYS.map((k) => [k, c[k] ?? ''])) as Record<Key, string>,
  services: (c.services ?? []).map((s) => ({
    name: s.name,
    command: s.command,
    cwd: s.cwd ?? '',
    port: s.port ? String(s.port) : '',
  })),
});

const fromDraft = (d: Draft): ProjectCommandsDto => ({
  ...Object.fromEntries(COMMAND_KEYS.map((k) => [k, d.commands[k].trim() || null])),
  services: d.services
    .filter((s) => s.name.trim() || s.command.trim())
    .map((s) => ({
      name: s.name.trim(),
      command: s.command.trim(),
      cwd: s.cwd.trim() || null,
      port: s.port.trim() ? Number(s.port) : null,
    })),
});

const same = (a: Draft, b: Draft) => JSON.stringify(fromDraft(a)) === JSON.stringify(fromDraft(b));

function useSuggestion(projectId: string) {
  return useQuery({
    queryKey: qk.commandSuggestion(projectId),
    queryFn: () => api.projects.suggestion(projectId),
  });
}

/** Commands to install / run / build / test the project, with AI suggestions and multi-server services. */
export function CommandsCard({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const saved = toDraft(project.commands);
  const [edits, setEdits] = useState<Draft | null>(null);
  const draft = edits ?? saved;
  const dirty = edits !== null && !same(edits, saved);
  const detected = project.onboardingReport?.commands ?? {};
  const parsed = ProjectCommandsSchema.safeParse(fromDraft(draft));
  const suggestion = useSuggestion(project.id).data?.suggestion ?? null;

  const save = useMutation({
    mutationFn: (commands: ProjectCommandsDto) => api.projects.update(project.id, { commands }),
    onSuccess: (p) => {
      qc.setQueryData(qk.project(p.id), p);
      setEdits(null);
      toast.success('Commands saved');
    },
    onError: (e) => toast.error('Could not save commands', { description: errMsg(e) }),
  });
  const suggest = useMutation({
    mutationFn: () => api.projects.suggestCommands(project.id),
    onSuccess: (s) => qc.setQueryData(qk.commandSuggestion(project.id), { suggestion: s }),
    onError: (e) => toast.error('Couldn’t start', { description: errMsg(e) }),
  });
  const dismiss = useMutation({
    mutationFn: () => api.projects.dismissSuggestion(project.id),
    onSuccess: () => qc.setQueryData(qk.commandSuggestion(project.id), { suggestion: null }),
  });

  const set = (fn: (d: Draft) => Draft) => setEdits(fn(structuredClone(draft)));
  const nothingSet =
    COMMAND_KEYS.every((k) => !project.commands[k]) && !project.commands.services?.length;
  const multi = draft.services.length > 0;

  const apply = (s: CommandSuggestionDto) => {
    const next: ProjectCommandsDto = {
      ...Object.fromEntries(COMMAND_KEYS.map((k) => [k, s.commands[k] ?? null])),
      services: s.services,
    };
    save.mutate(next, { onSuccess: () => dismiss.mutate() });
  };

  return (
    <Card className="gap-4 shadow-xs">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wand2 className="text-primary size-4" /> Commands
          </CardTitle>
          <CardDescription>
            Used to install, run, build and test the project. Confirm what was detected, or let an
            agent read the project and suggest them.
          </CardDescription>
        </div>
        <div className="flex shrink-0 gap-2">
          {dirty ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEdits(null)}>
                Discard
              </Button>
              <Button
                size="sm"
                onClick={() => parsed.success && save.mutate(parsed.data)}
                disabled={save.isPending || !parsed.success}
              >
                {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant={nothingSet ? 'default' : 'outline'}
              onClick={() => suggest.mutate()}
              disabled={suggest.isPending || suggestion?.status === 'running'}
            >
              {suggestion?.status === 'running' ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Sparkles />
              )}{' '}
              Suggest with AI
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {suggestion && (
          <SuggestionPanel
            s={suggestion}
            current={project.commands}
            applying={save.isPending}
            onApply={() => apply(suggestion)}
            onDismiss={() => dismiss.mutate()}
            onRetry={() => suggest.mutate()}
          />
        )}
        {!suggestion && nothingSet && (
          <p className="bg-muted/50 text-muted-foreground rounded-lg px-3 py-2 text-xs">
            No commands yet. Press <b>Suggest with AI</b> — an agent reads the project (without
            changing anything) and works out how to install and start it, including apps with
            several servers.
          </p>
        )}

        <div className="space-y-3">
          {COMMAND_KEYS.map((k) => {
            const d = detected[k];
            const value = draft.commands[k];
            const differs = d && d.command !== value;
            const runShadowed = k === 'run' && multi;
            return (
              <div key={k} className="grid items-center gap-1.5 sm:grid-cols-[150px_1fr]">
                <label htmlFor={`cmd-${k}`} className="text-sm font-medium">
                  {LABELS[k]}
                </label>
                <div>
                  <Input
                    id={`cmd-${k}`}
                    value={value}
                    placeholder={
                      runShadowed ? 'Not used — the services below run instead' : 'Not set'
                    }
                    onChange={(e) =>
                      set((x) => ({ ...x, commands: { ...x.commands, [k]: e.target.value } }))
                    }
                    className={cn('h-8 font-mono text-xs', runShadowed && 'opacity-60')}
                  />
                  {d && (
                    <p className="text-muted-foreground mt-1 text-[11px]">
                      Detected from {d.source}
                      {differs && (
                        <>
                          {' · '}
                          <button
                            className="text-primary hover:underline"
                            onClick={() =>
                              set((x) => ({ ...x, commands: { ...x.commands, [k]: d.command } }))
                            }
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

        <ServicesEditor
          services={draft.services}
          onChange={(services) => set((x) => ({ ...x, services }))}
        />
        {!parsed.success && dirty && (
          <p className="text-destructive text-xs">
            {parsed.error.issues[0]?.path.join('.')}: {parsed.error.issues[0]?.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ServicesEditor({
  services,
  onChange,
}: {
  services: Draft['services'];
  onChange: (s: Draft['services']) => void;
}) {
  const update = (i: number, patch: Partial<Draft['services'][number]>) =>
    onChange(services.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const ports = services.map((s) => s.port.trim()).filter(Boolean);
  const dupPort = (p: string) => !!p && ports.filter((x) => x === p).length > 1;
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <Server className="size-3.5" /> Several servers?
          </p>
          <p className="text-muted-foreground text-xs">
            For apps that need more than one process (e.g. a frontend + an API + a worker), list
            each one. Run starts them all, each in its own terminal; ports are checked before
            starting and passed as <code>PORT</code>. The first one is the preview.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() =>
            onChange([
              ...services,
              {
                name: services.length ? `service-${services.length + 1}` : 'web',
                command: '',
                cwd: '',
                port: '',
              },
            ])
          }
          disabled={services.length >= 8}
        >
          <Plus /> Add server
        </Button>
      </div>
      {services.length > 0 && (
        <div className="space-y-2">
          <div className="text-muted-foreground hidden grid-cols-[110px_1fr_120px_80px_32px] gap-2 text-[11px] font-medium sm:grid">
            <span>Name</span>
            <span>Command</span>
            <span>Folder</span>
            <span>Port</span>
            <span />
          </div>
          {services.map((s, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[110px_1fr_120px_80px_32px]">
              <Input
                aria-label="Service name"
                value={s.name}
                onChange={(e) => update(i, { name: e.target.value })}
                className="h-8 text-xs"
                placeholder="web"
              />
              <Input
                aria-label="Command"
                value={s.command}
                onChange={(e) => update(i, { command: e.target.value })}
                className="h-8 font-mono text-xs"
                placeholder="npm run dev"
              />
              <Input
                aria-label="Folder"
                value={s.cwd}
                onChange={(e) => update(i, { cwd: e.target.value })}
                className="h-8 font-mono text-xs"
                placeholder="(project root)"
              />
              <Input
                aria-label="Port"
                value={s.port}
                inputMode="numeric"
                onChange={(e) => update(i, { port: e.target.value.replace(/\D/g, '').slice(0, 5) })}
                className={cn('h-8 font-mono text-xs', dupPort(s.port) && 'border-destructive')}
                placeholder="3000"
              />
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label={`Remove ${s.name || 'server'}`}
                onClick={() => onChange(services.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestionPanel({
  s,
  current,
  applying,
  onApply,
  onDismiss,
  onRetry,
}: {
  s: CommandSuggestionDto;
  current: ProjectCommandsDto;
  applying: boolean;
  onApply: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  if (s.status === 'running')
    return (
      <div
        role="status"
        className="bg-accent/40 flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm"
      >
        <Loader2 className="text-primary size-4 animate-spin" />
        <span className="flex-1">
          An agent is reading the project to work out its commands and servers… (read-only, usually
          under a minute)
        </span>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          <X /> Cancel
        </Button>
      </div>
    );
  if (s.status === 'failed')
    return (
      <div
        role="alert"
        className="bg-destructive/10 text-destructive flex items-start gap-3 rounded-lg border border-destructive/20 px-3 py-2.5 text-sm"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span className="flex-1">Couldn’t suggest commands: {s.error}</span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCcw /> Retry
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          <X />
        </Button>
      </div>
    );
  const rows = COMMAND_KEYS.filter((k) => s.commands[k] || current[k]);
  return (
    <div className="border-primary/30 bg-primary/5 space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="text-primary size-4" /> Suggested commands
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button size="sm" onClick={onApply} disabled={applying}>
            {applying ? <Loader2 className="animate-spin" /> : <Check />} Use these
          </Button>
        </div>
      </div>
      <dl className="grid gap-x-3 gap-y-1.5 text-xs sm:grid-cols-[120px_1fr]">
        {rows.map((k) => {
          const next = s.commands[k] ?? null;
          const changed = (next ?? '') !== (current[k] ?? '');
          return (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{LABELS[k]}</dt>
              <dd className="flex flex-wrap items-center gap-2 font-mono">
                {next ?? <span className="text-muted-foreground font-sans">none</span>}
                {changed && current[k] && (
                  <span className="text-muted-foreground font-sans line-through">{current[k]}</span>
                )}
                {changed && <Badge variant="secondary">changed</Badge>}
              </dd>
            </div>
          );
        })}
      </dl>
      {s.services.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">{s.services.length} servers run together:</p>
          <ul className="space-y-1">
            {s.services.map((x: ProjectServiceDto) => (
              <li key={x.name} className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="outline">{x.name}</Badge>
                <code className="font-mono">{x.command}</code>
                {x.cwd && <span className="text-muted-foreground">in {x.cwd}/</span>}
                {x.port && <span className="text-muted-foreground">port {x.port}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.notes.length > 0 && (
        <ul className="text-muted-foreground list-disc space-y-0.5 pl-4 text-xs">
          {s.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
