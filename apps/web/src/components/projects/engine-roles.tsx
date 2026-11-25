'use client';

import {
  AGENT_ROLES,
  ENGINE_LABELS,
  ROLE_LABELS,
  type AgentRole,
  type RoleEngines,
  type RoleModels,
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

/**
 * Per-role engine overrides; "Default" falls back to the global setting. When
 * `models`/`onModelsChange` are supplied, each role also gets a model picker
 * populated from the chosen engine's model list (so you can pick, e.g., a
 * Claude model for one role and a Codex model for another).
 */
export function EngineRoles({
  value,
  onChange,
  models,
  onModelsChange,
}: {
  value: Partial<RoleEngines>;
  onChange: (v: Partial<RoleEngines>) => void;
  models?: RoleModels;
  onModelsChange?: (v: RoleModels) => void;
}) {
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  const options = useEngineOptions();
  const label = (id: string) =>
    options.find((o) => o.id === id)?.label ??
    ENGINE_LABELS[id as keyof typeof ENGINE_LABELS] ??
    id;
  const setEngine = (role: AgentRole, engine: string) => {
    const next = { ...value };
    if (engine === DEFAULT) delete next[role];
    else next[role] = engine as RoleEngines[AgentRole];
    onChange(next);
    // A model picked for one engine doesn't carry to another: clear a stale pick.
    if (onModelsChange && models?.[role]) {
      const nm = { ...models };
      delete nm[role];
      onModelsChange(nm);
    }
  };
  const setModel = (role: AgentRole, model: string | undefined) => {
    if (!onModelsChange) return;
    const next = { ...(models ?? {}) };
    if (model === undefined) delete next[role];
    else next[role] = model;
    onModelsChange(next);
  };
  return (
    <div className="divide-y rounded-xl border">
      {AGENT_ROLES.map((role) => (
        <RoleRow
          key={role}
          role={role}
          value={value[role]}
          resolvedEngine={value[role] ?? settings.data?.defaultEngines[role]}
          defaultLabel={settings.data ? label(settings.data.defaultEngines[role]) : null}
          onChange={(v) => setEngine(role, v)}
          model={models?.[role]}
          showModel={!!onModelsChange}
          onModelChange={(m) => setModel(role, m)}
        />
      ))}
    </div>
  );
}

function RoleRow({
  role,
  value,
  resolvedEngine,
  defaultLabel,
  onChange,
  model,
  showModel,
  onModelChange,
}: {
  role: AgentRole;
  value: string | undefined;
  resolvedEngine: string | undefined;
  defaultLabel: string | null;
  onChange: (v: string) => void;
  model: string | undefined;
  showModel: boolean;
  onModelChange: (v: string | undefined) => void;
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
      {showModel && (
        <div className="mt-1.5 flex items-center justify-end gap-2">
          <span className="text-muted-foreground text-xs" id={`model-${role}`}>
            Model
          </span>
          <RoleModelSelect
            engineId={resolvedEngine}
            value={model}
            onChange={onModelChange}
            labelledBy={`model-${role}`}
          />
        </div>
      )}
      {unusable && (
        <p className="text-destructive mt-1 text-right text-xs" role="alert">
          {unusable} isn’t installed — agents use the next available engine. Pick another one.
        </p>
      )}
    </div>
  );
}

/** Model picker for a role, populated from the resolved engine's model list. */
function RoleModelSelect({
  engineId,
  value,
  onChange,
  labelledBy,
}: {
  engineId: string | undefined;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  labelledBy: string;
}) {
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  const engine = engineId ? engines.data?.find((e) => e.id === engineId) : undefined;
  const list = engine?.models ?? [];
  const stale = !!value && !list.some((m) => m.id === value);
  return (
    <Select
      value={value ?? DEFAULT}
      onValueChange={(v) => onChange(v === DEFAULT ? undefined : v)}
      disabled={list.length === 0 && !value}
    >
      <SelectTrigger size="sm" className="w-52" aria-labelledby={labelledBy}>
        <SelectValue placeholder="Engine default" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>Engine default</SelectItem>
        {stale && (
          <SelectItem value={value!} disabled>
            {value}
            <span className="text-muted-foreground text-xs">· unavailable</span>
          </SelectItem>
        )}
        {list.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
