'use client';

import { STATUS_LABELS, type AuthStatus } from '@agentforge/shared';
import { useNow } from '@/hooks/use-now';
import { clockTime, countdown } from '@/lib/format';
import { cn } from '@/lib/utils';

const STYLES: Record<AuthStatus, { pill: string; dot: string }> = {
  ACTIVE: { pill: 'bg-success/12 text-success border-success/25', dot: 'bg-success' },
  EXPIRED: {
    pill: 'bg-destructive/10 text-destructive border-destructive/25',
    dot: 'bg-destructive',
  },
  QUOTA_EXHAUSTED: {
    pill: 'bg-warning/15 text-warning border-warning/30',
    dot: 'bg-warning animate-pulse',
  },
  LOGGED_OUT: { pill: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/60' },
  NOT_INSTALLED: { pill: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/40' },
  UNKNOWN: { pill: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/40' },
};

export function EngineStatusPill({
  status,
  resetAt,
  className,
}: {
  status: AuthStatus;
  resetAt?: number | null;
  className?: string;
}) {
  const showReset = status === 'QUOTA_EXHAUSTED' && !!resetAt;
  const now = useNow(1000, showReset);
  const s = STYLES[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        s.pill,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', s.dot)} />
      {STATUS_LABELS[status]}
      {showReset && (
        <span className="font-normal opacity-80">
          · resets {clockTime(resetAt)} ({countdown(resetAt, now)})
        </span>
      )}
    </span>
  );
}
