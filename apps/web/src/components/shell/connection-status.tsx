'use client';

import { cn } from '@/lib/utils';
import { useConnection } from '@/lib/stores';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const LABELS = {
  open: {
    text: 'Live',
    dot: 'bg-success',
    hint: 'Connected to the AI Harness daemon — updates stream in real time.',
  },
  connecting: {
    text: 'Connecting',
    dot: 'bg-warning animate-pulse',
    hint: 'Connecting to the daemon…',
  },
  reconnecting: {
    text: 'Reconnecting',
    dot: 'bg-destructive animate-pulse',
    hint: 'Lost connection to the daemon. Retrying automatically.',
  },
} as const;

export function ConnectionStatus({ compact = false }: { compact?: boolean }) {
  const status = useConnection((s) => s.status);
  const l = LABELS[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="status"
          aria-label={`Daemon connection: ${l.text}`}
          className={cn(
            'text-muted-foreground flex items-center gap-2 rounded-full text-xs font-medium',
            !compact && 'bg-background/60 border px-2.5 py-1',
          )}
        >
          <span className={cn('size-2 rounded-full', l.dot)} />
          {!compact && l.text}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">{l.hint}</TooltipContent>
    </Tooltip>
  );
}
