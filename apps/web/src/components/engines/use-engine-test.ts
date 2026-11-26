'use client';

import type { AgentEvent, AgentRunResultDto } from '@agentforge/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useLiveEvent, useLiveTopic } from '@/components/live-provider';
import { api, qk } from '@/lib/api';

/**
 * Runs a real prompt through the engine (the same `run()` path agents use) and tracks it.
 * The result comes from the live `run.finished` event, with a polling fallback: a fast
 * failure (e.g. a 401) can finish before the client has subscribed to the run's topic.
 */
export function useEngineTest(engineId: string) {
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [result, setResult] = useState<AgentRunResultDto | null>(null);
  useLiveTopic(runId ? `run:${runId}` : null);
  useLiveEvent((e) => {
    if (e.type === 'run.event' && e.payload.runId === runId)
      setEvents((xs) => [...xs, e.payload.event]);
    if (e.type === 'run.finished' && e.payload.runId === runId) setResult(e.payload.result);
  });
  const poll = useQuery({
    queryKey: ['engine-test', runId],
    queryFn: () => api.engines.runResult(runId!),
    enabled: !!runId && !result,
    refetchInterval: 1500,
  });
  useEffect(() => {
    if (poll.data?.result && !result) setResult(poll.data.result);
  }, [poll.data, result]);
  // The run updates the engine's status (e.g. a sign-in failure → Expired): refetch it.
  useEffect(() => {
    if (result) void queryClient.invalidateQueries({ queryKey: qk.engines });
  }, [result, queryClient]);
  const start = useMutation({
    mutationFn: (body: { prompt?: string; model?: string }) => api.engines.test(engineId, body),
    onMutate: () => {
      setRunId(null);
      setEvents([]);
      setResult(null);
    },
    onSuccess: (r) => setRunId(r.runId),
  });
  return {
    start,
    runId,
    events,
    result,
    running: start.isPending || (!!runId && !result),
    cancel: () => runId && void api.engines.cancelRun(runId),
  };
}
