'use client';

import type { TaskDiffDto } from '@ai-harness/shared';
import { ChevronRight, FileMinus, FilePen, FilePlus } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

/** Split a unified patch into per-file chunks keyed by the new path. */
function splitPatch(patch: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of patch.split('\n')) {
    const m = line.match(/^diff --git a\/.* b\/(.*)$/);
    if (m) {
      current = [];
      out.set(m[1]!, current);
      continue;
    }
    if (
      current &&
      !/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(
        line,
      )
    )
      current.push(line);
  }
  return out;
}

const ICON = { added: FilePlus, deleted: FileMinus, modified: FilePen, renamed: FilePen };

export function DiffView({ diff }: { diff: TaskDiffDto }) {
  const chunks = splitPatch(diff.patch);
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(diff.files.slice(0, 3).map((f) => f.path)),
  );
  if (!diff.files.length) return <p className="text-muted-foreground text-sm">No changes yet.</p>;
  const total = diff.files.reduce(
    (a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }),
    { add: 0, del: 0 },
  );
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        {diff.files.length} file{diff.files.length === 1 ? '' : 's'} ·{' '}
        <span className="text-success">+{total.add}</span>{' '}
        <span className="text-destructive">−{total.del}</span>
        {diff.truncated && ' · patch truncated'}
      </p>
      {diff.files.map((f) => {
        const Icon = ICON[f.status];
        const isOpen = open.has(f.path);
        const lines = chunks.get(f.path) ?? [];
        return (
          <div key={f.path} className="overflow-hidden rounded-lg border">
            <button
              className="bg-muted/50 hover:bg-muted flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
              aria-expanded={isOpen}
              onClick={() =>
                setOpen((s) =>
                  s.has(f.path)
                    ? new Set([...s].filter((x) => x !== f.path))
                    : new Set([...s, f.path]),
                )
              }
            >
              <ChevronRight
                className={cn('size-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')}
              />
              <Icon className="text-muted-foreground size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
              <span className="text-success tabular-nums">+{f.additions}</span>
              <span className="text-destructive tabular-nums">−{f.deletions}</span>
            </button>
            {isOpen && (
              <pre className="max-h-96 overflow-auto text-[11px] leading-5">
                {lines.length ? (
                  lines.map((l, i) => (
                    <div
                      key={i}
                      className={cn(
                        'px-3 whitespace-pre',
                        l.startsWith('+') && 'bg-success/10 text-success',
                        l.startsWith('-') && 'bg-destructive/10 text-destructive',
                        l.startsWith('@@') && 'bg-accent/60 text-muted-foreground',
                      )}
                    >
                      {l || ' '}
                    </div>
                  ))
                ) : (
                  <div className="text-muted-foreground px-3 py-2">Binary or empty change.</div>
                )}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
