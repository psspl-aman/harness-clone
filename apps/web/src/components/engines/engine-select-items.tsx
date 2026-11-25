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

/** Engines you can pick for a role: installed and enabled. */
export function useEngineOptions(): { id: string; label: string; engine: EngineInfo | null }[] {
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  if (!engines.data)
    return BUILTIN_ENGINE_IDS.map((id) => ({ id, label: ENGINE_LABELS[id], engine: null }));
  return engines.data
    .filter((e) => e.enabled && e.installed)
    .map((e) => ({ id: e.id, label: e.displayName, engine: e }));
}

/** Display name of an engine that is set but can't be picked (not installed or disabled), else null. */
export function useUnusableEngine(id: string | null | undefined): string | null {
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  if (!id || !engines.data) return null;
  const e = engines.data.find((x) => x.id === id);
  if (!e) return id;
  return e.installed && e.enabled ? null : e.displayName;
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

/**
 * <SelectItem>s for every installed, enabled engine, with a status dot and label.
 * `extra` is the current value: when it isn't installed it is listed disabled (so the
 * field still shows what's set) and can't be chosen again.
 */
export function EngineSelectItems({ extra }: { extra?: string | null }) {
  const options = useEngineOptions();
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  const stale = extra && !options.some((o) => o.id === extra);
  const staleName = stale ? (engines.data?.find((e) => e.id === extra)?.displayName ?? extra) : '';
  return (
    <>
      {stale && (
        <SelectItem value={extra} disabled>
          <span className="bg-destructive size-1.5 rounded-full" />
          {staleName}
          <span className="text-muted-foreground text-xs">· Not installed</span>
        </SelectItem>
      )}
      {options.map((o) => (
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
