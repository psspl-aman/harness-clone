'use client';

import {
  BUILTIN_ENGINE_IDS,
  ENGINE_LABELS,
  STATUS_LABELS,
  type EngineInfo,
} from '@agentforge/shared';
import { useQuery } from '@tanstack/react-query';
import { SelectItem } from '@/components/ui/select';
import { api, qk } from '@/lib/api';
import { cn } from '@/lib/utils';

export function useEngineOptions(): { id: string; label: string; engine: EngineInfo | null }[] {
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  if (!engines.data)
    return BUILTIN_ENGINE_IDS.map((id) => ({ id, label: ENGINE_LABELS[id], engine: null }));
  return engines.data
    .filter((e) => e.enabled)
    .map((e) => ({ id: e.id, label: e.displayName, engine: e }));
}

const dot = (e: EngineInfo | null) =>
  !e
    ? 'bg-muted-foreground/40'
    : e.authStatus === 'ACTIVE'
      ? 'bg-success'
      : e.authStatus === 'QUOTA_EXHAUSTED'
        ? 'bg-warning'
        : e.authStatus === 'EXPIRED'
          ? 'bg-destructive'
          : 'bg-muted-foreground/40';

/** <SelectItem>s for every enabled engine, with a status dot and label. */
export function EngineSelectItems({ extra }: { extra?: string | null }) {
  const options = useEngineOptions();
  const all =
    extra && !options.some((o) => o.id === extra)
      ? [...options, { id: extra, label: extra, engine: null }]
      : options;
  return (
    <>
      {all.map((o) => (
        <SelectItem key={o.id} value={o.id}>
          <span className={cn('size-1.5 rounded-full', dot(o.engine))} />
          {o.label}
          {o.engine && o.engine.authStatus !== 'ACTIVE' && (
            <span className="text-muted-foreground text-xs">
              · {STATUS_LABELS[o.engine.authStatus]}
            </span>
          )}
        </SelectItem>
      ))}
    </>
  );
}
