'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export interface LogLine {
  key: string | number;
  text: string;
  tone?: string;
}

/**
 * Virtualized log: only the visible lines are rendered (wrapped lines are
 * measured), and it follows new output while you're scrolled to the bottom.
 */
export function VirtualLog({
  lines,
  className,
  empty,
}: {
  lines: LogLine[];
  className?: string;
  empty?: string;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual can't be memoized by the React Compiler; this component opts out
  const v = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 18,
    overscan: 20,
  });

  useEffect(() => {
    if (follow.current && lines.length) v.scrollToIndex(lines.length - 1, { align: 'end' });
  }, [lines.length, v]);

  return (
    <div
      ref={parent}
      role="log"
      aria-live="off"
      onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className={cn(
        'bg-muted/40 max-h-72 overflow-auto rounded-md p-2 font-mono text-[11px] leading-relaxed',
        className,
      )}
    >
      {lines.length === 0 ? (
        <p className="text-muted-foreground">{empty ?? 'No output yet.'}</p>
      ) : (
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((item) => {
            const l = lines[item.index]!;
            return (
              <p
                key={l.key}
                data-index={item.index}
                ref={v.measureElement}
                className={cn('absolute inset-x-0 break-words whitespace-pre-wrap', l.tone)}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {l.text}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}
