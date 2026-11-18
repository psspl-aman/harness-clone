'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Hourglass } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useNow } from '@/hooks/use-now';
import { api, qk } from '@/lib/api';
import { clockTime, countdown } from '@/lib/format';

/**
 * Global banner for engines that default roles depend on: expired sessions
 * (with a Re-login link) and exhausted usage windows (with a countdown).
 */
export function EngineBanner() {
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list, retry: false });
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get, retry: false });
  const used = new Set(Object.values(settings.data?.defaultEngines ?? {}));
  const problems = (engines.data ?? []).filter(
    (e) =>
      e.enabled &&
      used.has(e.id) &&
      (e.authStatus === 'EXPIRED' || e.authStatus === 'QUOTA_EXHAUSTED'),
  );
  const now = useNow(
    1000,
    problems.some((p) => p.authStatus === 'QUOTA_EXHAUSTED'),
  );

  return (
    <AnimatePresence>
      {problems.map((e) => (
        <motion.div
          key={e.id}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="overflow-hidden"
        >
          {e.authStatus === 'EXPIRED' ? (
            <div
              role="alert"
              className="bg-destructive/10 text-destructive border-destructive/20 flex items-center gap-3 border-b px-6 py-2 text-sm"
            >
              <AlertTriangle className="size-4 shrink-0" />
              <span className="flex-1">
                {e.displayName} session expired — agents using it can’t run until you log in again.
              </span>
              <Link href="/agents" className="font-medium underline-offset-2 hover:underline">
                Re-login
              </Link>
            </div>
          ) : (
            <div
              role="status"
              className="bg-warning/15 border-warning/30 flex items-center gap-3 border-b px-6 py-2 text-sm"
            >
              <Hourglass className="text-warning size-4 shrink-0" />
              <span className="flex-1">
                {e.displayName} usage limit reached
                {e.resetAt
                  ? ` — resets at ${clockTime(e.resetAt)} (in ${countdown(e.resetAt, now)})`
                  : ''}
                .
              </span>
              <Link href="/agents" className="font-medium underline-offset-2 hover:underline">
                Details
              </Link>
            </div>
          )}
        </motion.div>
      ))}
    </AnimatePresence>
  );
}
