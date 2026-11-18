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
import { EngineSelectItems, useEngineOptions } from '@/components/engines/engine-select-items';
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
        <div key={role} className="flex items-center justify-between gap-4 px-4 py-2.5">
          <span className="text-sm font-medium" id={`role-${role}`}>
            {ROLE_LABELS[role]}
          </span>
          <Select value={value[role] ?? DEFAULT} onValueChange={(v) => set(role, v)}>
            <SelectTrigger size="sm" className="w-52" aria-labelledby={`role-${role}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>
                Default{settings.data ? ` · ${label(settings.data.defaultEngines[role])}` : ''}
              </SelectItem>
              <EngineSelectItems extra={value[role]} />
            </SelectContent>
          </Select>
        </div>
      ))}
    </div>
  );
}
