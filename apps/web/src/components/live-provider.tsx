'use client';

import type {
  AnyAppEvent,
  ChatMessageDto,
  EngineInfo,
  ErrorDto,
  McpServerDto,
  PlanBoardDto,
  PmsMappingDto,
  SafetyApprovalDto,
} from '@agentforge/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { DAEMON_WS_URL, qk } from '@/lib/api';
import { LiveClient } from '@/lib/live';
import { useConnection } from '@/lib/stores';

type Listener = (e: AnyAppEvent) => void;

interface LiveContextValue {
  client: LiveClient | null;
  addListener: (l: Listener) => () => void;
}

const LiveContext = createContext<LiveContextValue | null>(null);

/**
 * Owns the single WebSocket connection, keeps TanStack Query caches in sync
 * with daemon events, and surfaces `notification` events as toasts.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const setStatus = useConnection((s) => s.setStatus);
  const listeners = useRef(new Set<Listener>());
  const [client, setClient] = useState<LiveClient | null>(null);

  useEffect(() => {
    const c = new LiveClient(DAEMON_WS_URL, {
      onStatus: setStatus,
      onResync: () => void queryClient.invalidateQueries(),
      onEvent: (e) => {
        switch (e.type) {
          case 'settings.updated':
            queryClient.setQueryData(qk.settings, e.payload.settings);
            void queryClient.invalidateQueries({ queryKey: qk.system });
            break;
          case 'project.created':
          case 'project.updated':
            // Prefix match also refreshes the project's detail query.
            void queryClient.invalidateQueries({ queryKey: qk.projects });
            break;
          case 'project.deleted':
            queryClient.removeQueries({ queryKey: qk.project(e.payload.projectId) });
            void queryClient.invalidateQueries({ queryKey: qk.projects, exact: true });
            break;
          case 'project.onboarding':
            void queryClient.invalidateQueries({ queryKey: qk.project(e.payload.projectId) });
            break;
          case 'engine.updated':
            queryClient.setQueryData<EngineInfo[]>(qk.engines, (list) =>
              list?.some((x) => x.id === e.payload.engine.id)
                ? list.map((x) => (x.id === e.payload.engine.id ? e.payload.engine : x))
                : undefined,
            );
            if (!queryClient.getQueryData(qk.engines))
              void queryClient.invalidateQueries({ queryKey: qk.engines });
            break;
          case 'chat.message':
            queryClient.setQueryData<ChatMessageDto[]>(qk.chat(e.payload.projectId), (list) => {
              if (!list) return list;
              const m = e.payload.message;
              const i = list.findIndex((x) => x.id === m.id);
              const next = i >= 0 ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m];
              // An edit marks the original as superseded.
              return m.supersedesId
                ? next.map((x) => (x.id === m.supersedesId ? { ...x, supersededBy: m.id } : x))
                : next;
            });
            break;
          case 'planner.state':
            queryClient.setQueryData(qk.planner(e.payload.state.projectId), e.payload.state);
            break;
          case 'plan.updated':
            queryClient.setQueryData<PlanBoardDto>(qk.board(e.payload.projectId), (b) => {
              if (!b) return b;
              const p = e.payload.plan;
              const plans =
                p.status === 'SUPERSEDED'
                  ? b.plans.filter((x) => x.id !== p.id)
                  : b.plans.some((x) => x.id === p.id)
                    ? b.plans.map((x) => (x.id === p.id ? p : x))
                    : [p, ...b.plans];
              return { ...b, plans: plans.sort((a, c) => c.version - a.version) };
            });
            break;
          case 'task.updated':
            queryClient.setQueryData<PlanBoardDto>(qk.board(e.payload.projectId), (b) => {
              if (!b) return b;
              const t = e.payload.task;
              const tasks = b.tasks.some((x) => x.id === t.id)
                ? b.tasks.map((x) => (x.id === t.id ? t : x))
                : [...b.tasks, t];
              return {
                ...b,
                tasks: tasks.sort(
                  (a, c) => a.orderIndex - c.orderIndex || a.createdAt - c.createdAt,
                ),
              };
            });
            void queryClient.invalidateQueries({ queryKey: qk.taskHistory(e.payload.task.id) });
            void queryClient.invalidateQueries({ queryKey: ['task-detail', e.payload.task.id] });
            break;
          case 'run.finished':
            void queryClient.invalidateQueries({ queryKey: ['usage'] });
            break;
          case 'pipeline.updated':
            queryClient.setQueryData(qk.pipeline(e.payload.status.projectId), e.payload.status);
            break;
          case 'error.updated':
            void queryClient.invalidateQueries({ queryKey: qk.projects, exact: true });
            queryClient.setQueryData<ErrorDto[]>(qk.errors(e.payload.projectId), (list) => {
              if (!list) return list;
              const x = e.payload.error;
              return list.some((y) => y.id === x.id)
                ? list
                    .map((y) => (y.id === x.id ? x : y))
                    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
                : [x, ...list];
            });
            break;
          case 'project.run':
            queryClient.setQueryData(qk.projectRun(e.payload.run.projectId), e.payload.run);
            break;
          case 'terminal.created':
            if (e.payload.terminal.projectId)
              void queryClient.invalidateQueries({
                queryKey: qk.terminals(e.payload.terminal.projectId),
              });
            break;
          case 'safety.approval':
            queryClient.setQueryData<SafetyApprovalDto[]>(qk.safetyApprovals, (l) => {
              const x = e.payload.approval;
              const list = l ?? [];
              return list.some((y) => y.id === x.id)
                ? list.map((y) => (y.id === x.id ? x : y))
                : [x, ...list];
            });
            if (e.payload.approval.status === 'blocked')
              toast.warning('Blocked an agent action', {
                description: `${e.payload.approval.summary} — ${e.payload.approval.reason}`,
              });
            break;
          case 'memory.updated':
            void queryClient.invalidateQueries({ queryKey: qk.memory(e.payload.projectId) });
            if (!e.payload.projectId) void queryClient.invalidateQueries({ queryKey: ['memory'] });
            break;
          case 'mcp.updated':
            queryClient.setQueryData<McpServerDto[]>(qk.mcpServers, (l) => {
              if (!l) return l;
              const x = e.payload.server;
              return l.some((y) => y.id === x.id)
                ? l.map((y) => (y.id === x.id ? x : y))
                : [...l, x].sort((a, b) => a.name.localeCompare(b.name));
            });
            break;
          case 'mcp.removed':
            queryClient.setQueryData<McpServerDto[]>(qk.mcpServers, (l) =>
              l?.filter((y) => y.id !== e.payload.serverId),
            );
            break;
          case 'pms.connections_changed':
            void queryClient.invalidateQueries({ queryKey: qk.pmsConnections });
            void queryClient.invalidateQueries({ queryKey: ['pms', 'mappings'] });
            break;
          case 'pms.mapping':
            queryClient.setQueryData<PmsMappingDto[]>(
              qk.pmsMappings(e.payload.mapping.projectId),
              (l) => {
                if (!l) return l;
                const x = e.payload.mapping;
                return l.some((y) => y.id === x.id)
                  ? l.map((y) => (y.id === x.id ? x : y))
                  : [...l, x];
              },
            );
            break;
          case 'pms.mapping_removed':
            queryClient.setQueryData<PmsMappingDto[]>(qk.pmsMappings(e.payload.projectId), (l) =>
              l?.filter((y) => y.id !== e.payload.mappingId),
            );
            break;
          case 'terminal.exit':
            void queryClient.invalidateQueries({ queryKey: ['terminals'] });
            break;
          case 'task.status_changed':
            void queryClient.invalidateQueries({ queryKey: ['activity'] });
            if (e.payload.to === 'DONE') {
              void queryClient.invalidateQueries({ queryKey: qk.docs(e.payload.projectId) });
              void queryClient.invalidateQueries({ queryKey: qk.memory(e.payload.projectId) });
            }
            break;
          case 'task.deleted':
            queryClient.setQueryData<PlanBoardDto>(qk.board(e.payload.projectId), (b) =>
              b ? { ...b, tasks: b.tasks.filter((x) => x.id !== e.payload.taskId) } : b,
            );
            break;
          case 'engine.removed':
            void queryClient.invalidateQueries({ queryKey: qk.engines });
            break;
          case 'engine.status_changed': {
            const name =
              queryClient
                .getQueryData<EngineInfo[]>(qk.engines)
                ?.find((x) => x.id === e.payload.engineId)?.displayName ?? e.payload.engineId;
            if (e.payload.status === 'EXPIRED')
              toast.error(`${name} session expired`, {
                description: 'Log in again from Agents & Accounts.',
              });
            if (e.payload.status === 'QUOTA_EXHAUSTED') {
              toast.warning(`${name} usage limit reached`, {
                description: e.payload.resetAt
                  ? `Resets at ${new Date(e.payload.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                  : undefined,
              });
            }
            break;
          }
          case 'github.status_changed':
            queryClient.setQueryData(qk.github, e.payload.status);
            void queryClient.invalidateQueries({ queryKey: ['github', 'repos'] });
            void queryClient.invalidateQueries({ queryKey: qk.githubOwners });
            break;
          case 'notification': {
            // Pauses and resumes are announced globally; refresh the paused-tasks banner.
            void queryClient.invalidateQueries({ queryKey: qk.pausedTasks });
            const { level, title, message } = e.payload;
            const fn = level === 'info' ? toast.info : toast[level];
            fn(title, { description: message });
            break;
          }
          default:
            break;
        }
        for (const l of listeners.current) l(e);
      },
    });
    c.addTopic('global');
    c.start();
    setClient(c);
    return () => c.stop();
  }, [queryClient, setStatus]);

  const value: LiveContextValue = {
    client,
    addListener: (l) => {
      listeners.current.add(l);
      return () => listeners.current.delete(l);
    },
  };
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

function useLive() {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error('useLive must be used inside <LiveProvider>');
  return ctx;
}

/** Subscribe to a topic (e.g. `project:<id>`) for the component's lifetime. */
export function useLiveTopic(topic: string | null | undefined) {
  const { client } = useLive();
  useEffect(() => {
    if (!client || !topic) return;
    client.addTopic(topic);
    return () => client.removeTopic(topic);
  }, [client, topic]);
}

/** Run `handler` for every event received on subscribed topics. */
export function useLiveEvent(handler: Listener) {
  const { addListener } = useLive();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => addListener((e) => ref.current(e)), [addListener]);
}
