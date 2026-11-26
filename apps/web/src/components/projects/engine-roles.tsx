'use client';

import {
  AGENT_ROLES,
  EFFORT_LABELS,
  EFFORTS,
  ENGINE_LABELS,
  ROLE_LABELS,
  type AgentRole,
  type Effort,
  type EngineInfo,
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

/** Settings a task inherits from its project (shown as "Project · …" defaults in the task drawer). */
export interface InheritedRoles {
  roleEngines: Partial<RoleEngines>;
  roleModels: RoleModels;
  effort?: Effort | null;
}

/** Strip the "(latest)" suffix of alias models: "Haiku (latest)" → "Haiku". */
const shortModel = (label: string) => label.replace(/\s*\(latest\)$/, '');

/**
 * The engine each role really runs on: explicit value → inherited (project) → global default.
 * Mirrors the daemon's resolution so the model list matches the engine that will run.
 */
export function useResolvedEngines(
  value: Partial<RoleEngines>,
  inherited?: InheritedRoles,
): Record<AgentRole, string | undefined> {
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  return Object.fromEntries(
    AGENT_ROLES.map((r) => [
      r,
      value[r] ?? inherited?.roleEngines[r] ?? settings.data?.defaultEngines[r],
    ]),
  ) as Record<AgentRole, string | undefined>;
}

/**
 * Per-role engine overrides; "Default" falls back to the inherited (project) setting, then the
 * global setting. When `models`/`onModelsChange` are supplied, each role also gets a model picker
 * populated from the resolved engine's model list (so you can pick, e.g., a Claude model for
 * one role and a Codex model for another).
 */
export function EngineRoles({
  value,
  onChange,
  models,
  onModelsChange,
  inherited,
  effort,
}: {
  value: Partial<RoleEngines>;
  onChange: (v: Partial<RoleEngines>) => void;
  models?: RoleModels;
  onModelsChange?: (v: RoleModels) => void;
  /** Project settings a task inherits; omit outside the task drawer (defaults are global). */
  inherited?: InheritedRoles;
  /** Effective effort, used to flag roles whose engine ignores it. */
  effort?: Effort | null;
}) {
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  const options = useEngineOptions();
  const resolved = useResolvedEngines(value, inherited);
  const label = (id: string) =>
    options.find((o) => o.id === id)?.label ??
    ENGINE_LABELS[id as keyof typeof ENGINE_LABELS] ??
    id;
  const engineInfo = (id: string | undefined) => engines.data?.find((e) => e.id === id);
  const modelLabel = (engine: EngineInfo | undefined, id: string) =>
    shortModel(engine?.models.find((m) => m.id === id)?.label ?? id);

  const engineDefault = (role: AgentRole): string | null => {
    const fromProject = inherited?.roleEngines[role];
    if (fromProject) return `Project · ${label(fromProject)}`;
    return settings.data ? `Default · ${label(settings.data.defaultEngines[role])}` : null;
  };
  /** What "no model override" resolves to on the engine that will run. */
  const modelDefault = (role: AgentRole): string => {
    const engine = engineInfo(resolved[role]);
    const offered = (m: string | undefined) =>
      !!m && (!engine?.models.length || engine.models.some((x) => x.id === m));
    const fromProject = inherited?.roleModels[role];
    if (offered(fromProject)) return `Project · ${modelLabel(engine, fromProject!)}`;
    const global = settings.data?.roleModels[role];
    if (offered(global)) return `Default · ${modelLabel(engine, global!)}`;
    return 'Engine default';
  };

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
      {AGENT_ROLES.map((role) => {
        const engine = engineInfo(resolved[role]);
        return (
          <RoleRow
            key={role}
            role={role}
            value={value[role]}
            resolvedEngine={resolved[role]}
            defaultLabel={engineDefault(role)}
            onChange={(v) => setEngine(role, v)}
            model={models?.[role]}
            modelDefaultLabel={modelDefault(role)}
            showModel={!!onModelsChange}
            onModelChange={(m) => setModel(role, m)}
            effortIgnored={!!effort && !!engine && !engine.capabilities.effort}
            engineName={engine?.displayName}
          />
        );
      })}
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
  modelDefaultLabel,
  showModel,
  onModelChange,
  effortIgnored,
  engineName,
}: {
  role: AgentRole;
  value: string | undefined;
  resolvedEngine: string | undefined;
  defaultLabel: string | null;
  onChange: (v: string) => void;
  model: string | undefined;
  modelDefaultLabel: string;
  showModel: boolean;
  onModelChange: (v: string | undefined) => void;
  effortIgnored: boolean;
  engineName: string | undefined;
}) {
  const unusable = useUnusableEngine(value);
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">{ROLE_LABELS[role]}</span>
        <Select value={value ?? DEFAULT} onValueChange={onChange}>
          <SelectTrigger
            size="sm"
            className={cn('w-52', unusable && 'border-destructive')}
            aria-label={`${ROLE_LABELS[role]} engine`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>{defaultLabel ?? 'Default'}</SelectItem>
            <EngineSelectItems extra={value} />
          </SelectContent>
        </Select>
      </div>
      {showModel && (
        <div className="mt-1.5 flex items-center justify-end gap-2">
          <span className="text-muted-foreground text-xs">Model</span>
          <RoleModelSelect
            engineId={resolvedEngine}
            value={model}
            onChange={onModelChange}
            defaultLabel={modelDefaultLabel}
            ariaLabel={`${ROLE_LABELS[role]} model`}
          />
        </div>
      )}
      {effortIgnored && (
        <p className="text-muted-foreground mt-1 text-right text-xs">
          {engineName} has no effort setting — it runs at its default.
        </p>
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
  defaultLabel,
  ariaLabel,
}: {
  engineId: string | undefined;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  defaultLabel: string;
  ariaLabel: string;
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
      <SelectTrigger size="sm" className="w-52" aria-label={ariaLabel}>
        <SelectValue placeholder={defaultLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>{defaultLabel}</SelectItem>
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

/**
 * Reasoning-effort picker (Claude Code and Codex support it). "Default" means the inherited
 * value (project) or, with none, each CLI's own default.
 */
export function EffortSelect({
  value,
  onChange,
  inherited,
  disabled,
  id,
}: {
  value: Effort | null | undefined;
  onChange: (v: Effort | null) => void;
  /** Effort the "Default" option falls back to (the project's, in the task drawer). */
  inherited?: Effort | null;
  disabled?: boolean;
  id?: string;
}) {
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  const supported = (engines.data ?? [])
    .filter((e) => e.capabilities.effort && e.installed && e.enabled)
    .map((e) => e.displayName);
  const defaultLabel = inherited ? `Project · ${EFFORT_LABELS[inherited]}` : 'CLI default';
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <div>
        <span className="text-sm font-medium" id={id ? `${id}-label` : undefined}>
          Reasoning effort
        </span>
        <p className="text-muted-foreground text-xs">
          {supported.length
            ? `Applies to ${supported.join(' and ')}; other engines ignore it.`
            : 'No installed engine supports an effort setting.'}
        </p>
      </div>
      <Select
        value={value ?? DEFAULT}
        onValueChange={(v) => onChange(v === DEFAULT ? null : (v as Effort))}
        disabled={disabled || supported.length === 0}
      >
        <SelectTrigger size="sm" className="w-52" aria-label="Reasoning effort" id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT}>{defaultLabel}</SelectItem>
          {EFFORTS.map((e) => (
            <SelectItem key={e} value={e}>
              {EFFORT_LABELS[e]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
