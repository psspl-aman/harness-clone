'use client';

import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { ServerCrash } from 'lucide-react';
import { api, ApiClientError, DAEMON_URL, qk } from '@/lib/api';
import { useConnection } from '@/lib/stores';

/** Shown when the daemon is unreachable; disappears as soon as it's back. */
export function DaemonBanner() {
  const status = useConnection((s) => s.status);
  const system = useQuery({
    queryKey: qk.system,
    queryFn: api.system,
    retry: false,
    refetchInterval: (q) => (q.state.error ? 3000 : false),
  });
  const unreachable =
    status === 'reconnecting' ||
    (system.error instanceof ApiClientError && system.error.isUnreachable);

  return (
    <AnimatePresence>
      {unreachable && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="overflow-hidden"
        >
          <div
            role="alert"
            className="bg-destructive/10 text-destructive border-destructive/20 flex items-center gap-3 border-b px-6 py-2.5 text-sm"
          >
            <ServerCrash className="size-4 shrink-0" />
            <span>
              Can’t reach the AgentForge daemon at <code className="font-mono">{DAEMON_URL}</code>.
              Start it with{' '}
              <code className="bg-destructive/10 rounded px-1 font-mono">pnpm dev:daemon</code> —
              reconnecting automatically.
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
