'use client';

import type { AgentEvent } from '@ai-harness/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Bot, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useLiveEvent } from '@/components/live-provider';
import { VirtualLog, type LogLine } from '@/components/virtual-log';
import { eventLine, ROLE_VERB } from '@/lib/agent-events';
import { api, qk } from '@/lib/api';

const MAX_LINES = 2000;

interface Active {
  runId: string;
  role: string;
  label: string;
  engineId: string | null;
  taskId: string | null;
}

/** One running agent: its history so far, then its live output. */
function RunStream({ run, lines }: { run: Active; lines: LogLine[] }) {
  return (
    <section
      className="flex min-h-0 flex-col rounded-lg border"
      aria-label={`${ROLE_VERB[run.role] ?? run.role} ${run.label}`}
    >
      <header className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <Loader2 className="text-primary size-3 animate-spin" />
        <span className="font-medium">{ROLE_VERB[run.role] ?? run.role}</span>
        <span className="truncate">{run.label}</span>
        {run.engineId && (
          <span className="text-muted-foreground ml-auto shrink-0">{run.engineId}</span>
        )}
      </header>
      <VirtualLog
        lines={lines}
        className="max-h-none min-h-0 flex-1 rounded-none rounded-b-lg"
        empty="Starting…"
      />
    </section>
  );
}

/** Live output of every agent working on this project, per role. */
export function AgentsPane({ projectId }: { projectId: string }) {
  const board = useQuery({
    queryKey: qk.board(projectId),
    queryFn: () => api.board.get(projectId),
  });
  const planner = useQuery({
    queryKey: qk.planner(projectId),
    queryFn: () => api.chat.planner(projectId),
  });
  const [live, setLive] = useState<Record<string, (LogLine & { at: number })[]>>({});
  const active: Active[] = [
    ...(planner.data?.running && planner.data.runId
      ? [
          {
            runId: planner.data.runId,
            role: 'planner',
            label: 'Requirement chat',
            engineId: planner.data.engineId,
            taskId: null,
          },
        ]
      : []),
    ...(board.data?.tasks ?? [])
      .filter((t) => t.pipeline.activeRunId && t.pipeline.activeRole)
      .map((t) => ({
        runId: t.pipeline.activeRunId!,
        role: t.pipeline.activeRole!,
        label: `${t.key} ${t.title}`,
        engineId: t.pipeline.activeEngine,
        taskId: t.id,
      })),
  ];
  const ids = active.map((a) => a.runId);
  // Each run's history; live events received after it loaded are appended.
  const histories = useQueries({
    queries: ids.map((runId) => ({ queryKey: qk.run(runId), queryFn: () => api.runs.get(runId) })),
  });

  useLiveEvent((e) => {
    if (e.type !== 'run.event' || !ids.includes(e.payload.runId)) return;
    const line = eventLine(e.payload.event as AgentEvent);
    if (!line) return;
    const runId = e.payload.runId;
    setLive((l) => {
      const cur = l[runId] ?? [];
      return {
        ...l,
        [runId]: [...cur, { key: `l${cur.length}`, at: Date.now(), ...line }].slice(-MAX_LINES),
      };
    });
  });

  const linesFor = (runId: string, i: number): LogLine[] => {
    const h = histories[i];
    const history: LogLine[] = [];
    for (const e of h?.data?.events ?? []) {
      const line = eventLine(e.event);
      if (line) history.push({ key: `h${e.seq}`, ...line });
    }
    const since = h?.dataUpdatedAt ?? 0;
    return [...history, ...(live[runId] ?? []).filter((l) => l.at > since)].slice(-MAX_LINES);
  };

  if (!active.length)
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1.5 p-6 text-sm">
        <Bot className="size-5" />
        No agents are working on this project right now. Their output streams here while they run.
      </div>
    );
  return (
    <div
      className={`grid h-full min-h-0 gap-2 p-2 ${active.length > 1 ? 'md:grid-cols-2' : ''} auto-rows-fr`}
      data-testid="agents-pane"
    >
      {active.map((a, i) => (
        <RunStream key={a.runId} run={a} lines={linesFor(a.runId, i)} />
      ))}
    </div>
  );
}
