'use client';

import type { ProjectDetail, ProjectRunDto, ServiceRunDto } from '@agentforge/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  CircleAlert,
  ExternalLink,
  FlaskConical,
  Hammer,
  Loader2,
  PackageOpen,
  Play,
  RotateCw,
  Server,
  Square,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api, ApiClientError, qk } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWorkspaceUi } from './store';

const fail = (title: string) => (e: unknown) =>
  toast.error(title, { description: e instanceof ApiClientError ? e.message : String(e) });

export function useProjectRun(projectId: string) {
  return useQuery({
    queryKey: qk.projectRun(projectId),
    queryFn: () => api.runtime.run(projectId),
  });
}

const DOT: Record<ServiceRunDto['status'], string> = {
  running: 'bg-success',
  starting: 'bg-warning animate-pulse',
  crashed: 'bg-destructive',
  stopped: 'bg-muted-foreground/40',
};

/** Per-server status for multi-server projects: URL, port, errors and a jump to its terminal. */
function ServicesMenu({ run }: { run: ProjectRunDto }) {
  const showTerminal = useWorkspaceUi((s) => s.showTerminal);
  const up = run.services.filter((s) => s.status === 'running').length;
  const failed = run.services.filter((s) => s.status === 'crashed' || s.error).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className={cn('h-7 gap-1.5 px-2 text-xs', failed && 'text-destructive')}
          data-testid="run-services"
        >
          {failed ? <CircleAlert className="size-3.5" /> : <Server className="size-3.5" />}
          {up}/{run.services.length} servers
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Servers
        </DropdownMenuLabel>
        {run.services.map((s) => (
          <DropdownMenuItem
            key={s.name}
            className="flex-col items-stretch gap-0.5"
            disabled={!s.terminalId}
            onSelect={() => s.terminalId && showTerminal(s.terminalId)}
          >
            <span className="flex items-center gap-2">
              <span className={cn('size-2 shrink-0 rounded-full', DOT[s.status])} />
              <span className="font-medium">{s.name}</span>
              <span className="text-muted-foreground text-[11px] capitalize">{s.status}</span>
              {s.port && (
                <span className="text-muted-foreground ml-auto font-mono text-[11px]">
                  :{s.port}
                </span>
              )}
            </span>
            {s.url && (s.status === 'running' || s.status === 'starting') && (
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-primary truncate pl-4 font-mono text-[11px] hover:underline"
              >
                {s.url}
              </a>
            )}
            {s.error && <span className="text-destructive pl-4 text-[11px]">{s.error}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RunStatus({ run }: { run: ProjectRunDto }) {
  const s = run.status;
  return (
    <span
      className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium"
      data-testid="run-status"
    >
      {s === 'starting' ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : s === 'crashed' ? (
        <CircleAlert className="text-destructive size-3.5" />
      ) : (
        <span
          className={cn(
            'size-2 rounded-full',
            s === 'running' ? 'bg-success animate-pulse' : 'bg-muted-foreground/40',
          )}
        />
      )}
      {s === 'running'
        ? 'Running'
        : s === 'starting'
          ? 'Starting'
          : s === 'crashed'
            ? `Crashed${run.exitCode !== null ? ` (exit ${run.exitCode})` : ''}`
            : 'Stopped'}
    </span>
  );
}

/** Start/stop/restart the project's dev server and launch one-shot build/test/install runs. */
export function RunControls({
  project,
  onConfigure,
}: {
  project: ProjectDetail;
  onConfigure: () => void;
}) {
  const id = project.id;
  const qc = useQueryClient();
  const run = useProjectRun(id);
  const showTerminal = useWorkspaceUi((s) => s.showTerminal);
  const setRun = (r: ProjectRunDto) => qc.setQueryData(qk.projectRun(id), r);
  const start = useMutation({
    mutationFn: () => api.runtime.start(id),
    onSuccess: (r) => {
      setRun(r);
      if (r.terminalId) showTerminal(r.terminalId);
    },
    onError: fail('Could not start the project'),
  });
  const stop = useMutation({
    mutationFn: () => api.runtime.stop(id),
    onSuccess: setRun,
    onError: fail('Could not stop the project'),
  });
  const restart = useMutation({
    mutationFn: () => api.runtime.restart(id),
    onSuccess: (r) => {
      setRun(r);
      if (r.terminalId) showTerminal(r.terminalId);
    },
    onError: fail('Could not restart the project'),
  });
  const oneShot = useMutation({
    mutationFn: (kind: 'build' | 'test' | 'install') => api.runtime.oneShot(id, kind),
    onSuccess: (t) => showTerminal(t.id),
    onError: fail('Could not start the command'),
  });

  const r = run.data;
  const live = r?.status === 'running' || r?.status === 'starting';
  const busy = start.isPending || stop.isPending || restart.isPending;
  const cmds = project.commands;
  const canRun = !!cmds.run || !!cmds.services?.length;
  const oneShots = [
    { kind: 'build' as const, label: 'Build', icon: Hammer },
    { kind: 'test' as const, label: 'Run tests', icon: FlaskConical },
    { kind: 'install' as const, label: 'Install dependencies', icon: PackageOpen },
  ];

  return (
    <div className="flex items-center gap-2">
      {r && <RunStatus run={r} />}
      {r && r.services.length > 1 && <ServicesMenu run={r} />}
      {r?.previewUrl && live && (
        <a
          href={r.previewUrl}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground hidden items-center gap-1 font-mono text-xs lg:flex"
        >
          {r.previewUrl.replace(/^https?:\/\//, '')} <ExternalLink className="size-3" />
        </a>
      )}
      <div className="flex">
        {live ? (
          <>
            <Button
              size="sm"
              variant="outline"
              className="rounded-r-none"
              onClick={() => stop.mutate()}
              disabled={busy}
            >
              {stop.isPending ? <Loader2 className="animate-spin" /> : <Square />} Stop
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="-ml-px rounded-none"
              onClick={() => restart.mutate()}
              disabled={busy}
              aria-label="Restart"
              title="Restart"
            >
              {restart.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            className="rounded-r-none"
            onClick={() => (canRun ? start.mutate() : onConfigure())}
            disabled={busy}
            title={
              cmds.services?.length
                ? `Starts ${cmds.services.map((x) => x.name).join(', ')}`
                : cmds.run
                  ? `Runs: ${cmds.run}`
                  : 'Set a run command first'
            }
          >
            {start.isPending ? <Loader2 className="animate-spin" /> : <Play />} Run
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant={live ? 'outline' : 'default'}
              className="-ml-px rounded-l-none px-2"
              aria-label="More run commands"
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              Project commands
            </DropdownMenuLabel>
            {oneShots.map((o) => (
              <DropdownMenuItem
                key={o.kind}
                disabled={!cmds[o.kind] || oneShot.isPending}
                onSelect={() => oneShot.mutate(o.kind)}
              >
                <o.icon />
                <span className="flex-1">{o.label}</span>
                <span className="text-muted-foreground max-w-28 truncate font-mono text-[11px]">
                  {cmds[o.kind] ?? 'not set'}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onConfigure}>Edit commands…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
