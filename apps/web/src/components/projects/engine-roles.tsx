'use client';

import {
  AGENT_ROLES,
  ENGINE_LABELS,
  ROLE_LABELS,
  type AgentRole,
  type RoleEngines,
} from '@agentforge/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  EngineSelectItems,
  useEngineOptions,
  useUnusableEngine,
} from '@/components/engines/engine-select-items';
import { cn } from '@/lib/utils';
import { api, qk } from '@/lib/api';

const DEFAULT = '__default';

/** Per-role engine overrides; "Default" falls back to the global setting. */
export function EngineRoles({
  value,
  onChange,
}: {
  value: Partial<RoleEngines>;
  onChange: (v: Partial<RoleEngines>) => void;
}) {
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  const options = useEngineOptions();
  const label = (id: string) =>
    options.find((o) => o.id === id)?.label ??
    ENGINE_LABELS[id as keyof typeof ENGINE_LABELS] ??
    id;
  const set = (role: AgentRole, engine: string) => {
    const next = { ...value };
    if (engine === DEFAULT) delete next[role];
    else next[role] = engine as RoleEngines[AgentRole];
    onChange(next);
  };
  return (
    <div className="divide-y rounded-xl border">
      {AGENT_ROLES.map((role) => (
        <RoleRow
          key={role}
          role={role}
          value={value[role]}
          defaultLabel={settings.data ? label(settings.data.defaultEngines[role]) : null}
          onChange={(v) => set(role, v)}
        />
      ))}
    </div>
  );
}

function RoleRow({
  role,
  value,
  defaultLabel,
  onChange,
}: {
  role: AgentRole;
  value: string | undefined;
  defaultLabel: string | null;
  onChange: (v: string) => void;
}) {
  const unusable = useUnusableEngine(value);
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium" id={`role-${role}`}>
          {ROLE_LABELS[role]}
        </span>
        <Select value={value ?? DEFAULT} onValueChange={onChange}>
          <SelectTrigger
            size="sm"
            className={cn('w-52', unusable && 'border-destructive')}
            aria-labelledby={`role-${role}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>
              Default{defaultLabel ? ` · ${defaultLabel}` : ''}
            </SelectItem>
            <EngineSelectItems extra={value} />
          </SelectContent>
        </Select>
      </div>
      {unusable && (
        <p className="text-destructive mt-1 text-right text-xs" role="alert">
          {unusable} isn’t installed — agents use the next available engine. Pick another one.
        </p>
      )}
    </div>
  );
}
