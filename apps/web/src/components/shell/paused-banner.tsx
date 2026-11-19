'use client';

import { useQuery } from '@tanstack/react-query';
import { PauseCircle } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useNow } from '@/hooks/use-now';
import { api, qk } from '@/lib/api';
import { clockTime, countdown } from '@/lib/format';

/** "Paused — usage window expired, resumes at HH:MM" for tasks paused for quota or login, everywhere. */
export function PausedBanner() {
  const q = useQuery({
    queryKey: qk.pausedTasks,
    queryFn: api.usage.paused,
    refetchInterval: 30_000,
    retry: false,
  });
  const paused = q.data ?? [];
  const now = useNow(
    1000,
    paused.some((t) => t.resumeAt),
  );
  const next = paused.find((t) => t.resumeAt);
  const login = paused.filter((t) => t.status === 'PAUSED_AUTH');
  const first = paused[0];
  return (
    <AnimatePresence>
      {first && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="overflow-hidden"
        >
          <div
            role="status"
            className="bg-warning/15 border-warning/30 flex items-center gap-3 border-b px-6 py-2 text-sm"
            data-testid="paused-banner"
          >
            <PauseCircle className="text-warning size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {paused.length === 1 ? (
                <>
                  <span className="font-medium">
                    {first.key} {first.title}
                  </span>{' '}
                  paused —{' '}
                  {first.status === 'PAUSED_AUTH'
                    ? 'waiting for you to log in again'
                    : 'usage window expired'}
                  {first.resumeAt
                    ? `, resumes at ${clockTime(first.resumeAt)} (in ${countdown(first.resumeAt, now)})`
                    : ''}
                  .
                </>
              ) : (
                <>
                  <span className="font-medium">{paused.length} tasks paused</span>
                  {paused.length - login.length > 0 && ' — usage window expired'}
                  {login.length > 0 &&
                    `${paused.length - login.length > 0 ? ';' : ' —'} ${login.length} waiting for login`}
                  {next?.resumeAt
                    ? `. Next resumes at ${clockTime(next.resumeAt)} (in ${countdown(next.resumeAt, now)}).`
                    : '.'}
                </>
              )}
            </span>
            <Link
              href={`/projects/${first.projectId}`}
              className="shrink-0 font-medium underline-offset-2 hover:underline"
            >
              {paused.length === 1 ? 'Open' : `Open ${first.projectName}`}
            </Link>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
