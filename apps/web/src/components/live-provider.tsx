'use client';

import type { AnyAppEvent } from '@agentforge/shared';
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
          case 'project.deleted':
            void queryClient.invalidateQueries({ queryKey: qk.projects });
            break;
          case 'notification': {
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
