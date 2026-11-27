import { z } from 'zod';
import { AGENT_ROLES, COMPLEXITIES, type Complexity } from './enums';

export const EngineIdSchema = z
  .string()
  .regex(
    /^(claude-code|codex|gemini-cli|antigravity|custom:[a-z0-9][a-z0-9-]{0,62})$/,
    'Unknown engine id',
  );

/** A model id is engine-specific free-form text (e.g. "opus", "gpt-5-codex"). */
export const ModelIdSchema = z.string().trim().min(1).max(100);

const roleEngineShape = Object.fromEntries(AGENT_ROLES.map((r) => [r, EngineIdSchema])) as Record<
  (typeof AGENT_ROLES)[number],
  typeof EngineIdSchema
>;

export const RoleEnginesSchema = z.object(roleEngineShape);
export type RoleEngines = z.infer<typeof RoleEnginesSchema>;

/** Per-role model overrides. Any role may be omitted (falls back to the engine default). */
export const RoleModelsSchema = z.partialRecord(z.enum(AGENT_ROLES), ModelIdSchema);
export type RoleModels = z.infer<typeof RoleModelsSchema>;

/** Reasoning effort passed to engines that support it. null/absent → the CLI's own default. */
// Claude Code's `--effort` accepts all five; Codex (`model_reasoning_effort`) tops out at "high"
// and clamps "xhigh"/"max" down to it, so one shared control works across engines.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const EffortSchema = z.enum(EFFORTS);
export type Effort = z.infer<typeof EffortSchema>;
export const EFFORT_LABELS: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};
/** Effort levels Codex supports; higher levels clamp to "high". */
export const CODEX_MAX_EFFORT: Effort = 'high';

// ─── Complexity-aware routing ────────────────────────────────────────────────

/**
 * A pipeline shape a task can be routed to by its complexity:
 * - `lite`: Develop → Merge (skips Review, Test, project checks and Document).
 * - `full`: the standard Develop → Review → Test → Document → Merge pipeline.
 */
export const PIPELINE_PROFILES = ['lite', 'full'] as const;
export type PipelineProfile = (typeof PIPELINE_PROFILES)[number];

/** How to run tasks of a given complexity when routing is on. */
export const RoutingRuleSchema = z.object({
  pipeline: z.enum(PIPELINE_PROFILES),
  /** Model to prefer for this complexity, applied only when the engine offers it. Null → engine default. */
  model: ModelIdSchema.nullable(),
  /** Reasoning effort for this complexity on engines that support it. Null → fall through. */
  effort: EffortSchema.nullable().default(null),
});
export type RoutingRule = z.infer<typeof RoutingRuleSchema>;

const routingProfilesShape = Object.fromEntries(
  COMPLEXITIES.map((c) => [c, RoutingRuleSchema]),
) as Record<Complexity, typeof RoutingRuleSchema>;

export const RoutingSchema = z.object({
  /** Off by default: with routing disabled every task runs the full pipeline with the usual model. */
  enabled: z.boolean(),
  /** Complexity → how to run it. */
  profiles: z.object(routingProfilesShape),
});
export type Routing = z.infer<typeof RoutingSchema>;

/** Default routing map (used when routing is enabled). xs/s → lite+fast, m → standard, l/xl → full+strong. */
export const DEFAULT_ROUTING: Routing = {
  enabled: false,
  profiles: {
    xs: { pipeline: 'lite', model: 'haiku', effort: null },
    s: { pipeline: 'lite', model: 'haiku', effort: null },
    m: { pipeline: 'full', model: null, effort: null },
    l: { pipeline: 'full', model: 'opus', effort: null },
    xl: { pipeline: 'full', model: 'opus', effort: null },
  },
};

// ─── Cheap mode ──────────────────────────────────────────────────────────────

/**
 * The cheapest model per engine, used by "Cheap mode". Only engines with a clear small
 * model are listed; others keep their engine default (Codex has no obvious "mini" model).
 */
export const CHEAP_MODELS: Record<string, string> = {
  'claude-code': 'haiku',
  'gemini-cli': 'flash-lite',
};

/** The cheap model for an engine, if it has one and the engine actually offers it. */
export function cheapModelFor(
  engineId: string | undefined,
  offered: { id: string }[] | undefined,
): string | undefined {
  const m = engineId ? CHEAP_MODELS[engineId] : undefined;
  return m && (!offered || offered.some((x) => x.id === m)) ? m : undefined;
}

/** Routing for "Cheap mode": the base routing turned on, with xs/s tasks on the LITE pipeline. */
export function cheapRouting(base: Routing): Routing {
  return {
    enabled: true,
    profiles: {
      ...base.profiles,
      xs: { pipeline: 'lite', model: null, effort: 'low' },
      s: { pipeline: 'lite', model: null, effort: 'low' },
    },
  };
}

/** The effective routing for a project: its override, else the global routing. */
export function resolveRouting(global: Routing, override: Routing | null | undefined): Routing {
  return override ?? global;
}

/** The routing rule for a complexity, or null when routing is off (→ full pipeline, normal model). */
export function routingRuleFor(routing: Routing, complexity: Complexity): RoutingRule | null {
  return routing.enabled ? routing.profiles[complexity] : null;
}

/**
 * Resolve the model for a role: task override → project override → undefined.
 * The engine default and CLI default are applied downstream by the engine layer.
 */
export function resolveRoleModel(
  taskModels: RoleModels | undefined,
  projectModels: RoleModels | undefined,
  role: (typeof AGENT_ROLES)[number],
): string | undefined {
  return taskModels?.[role] ?? projectModels?.[role] ?? undefined;
}

/** Global application settings. Stored as one JSON document in `settings`. */
export const AppSettingsSchema = z.object({
  /** Where GitHub clones / managed workspaces live. null → `<AI_HARNESS_HOME>/workspaces`. */
  workspaceRoot: z.string().min(1).nullable(),
  concurrency: z.object({
    maxTasksPerProject: z.number().int().min(1).max(16),
    maxRunsPerEngine: z.number().int().min(1).max(16),
  }),
  pipeline: z.object({
    maxFixLoops: z.number().int().min(0).max(10),
    requireHumanReviewBeforeMerge: z.boolean(),
    mergeStrategy: z.enum(['merge', 'pull_request']),
    /** Approve the Planner's tasks automatically so building starts without waiting for you. */
    autoApprovePlans: z.boolean(),
    /**
     * Feature and bug tasks: run the tests with the task's source changes reverted. If they
     * still pass, they don't test the change and go back to be strengthened. Costs one extra
     * run of the test command per test round; no AI tokens.
     */
    checkTestsFailWithoutChange: z.boolean(),
    /** After tests pass, the Reviewer checks the tests themselves. One extra agent run per round. */
    reviewTests: z.boolean(),
  }),
  health: z.object({
    engineCheckIntervalSec: z.number().int().min(15).max(3600),
  }),
  quota: z.object({
    probeInitialBackoffSec: z.number().int().min(30).max(3600),
    probeMaxBackoffSec: z
      .number()
      .int()
      .min(60)
      .max(24 * 3600),
    fallbackEnabled: z.boolean(),
  }),
  memory: z.object({
    maxPromptChars: z.number().int().min(500).max(100_000),
    /** Mirror project memory to `.ai-harness/memory.md` (kept out of git). */
    mirrorFile: z.boolean(),
    /** Keep `.ai-harness/PROJECT.md` and `tasks/<KEY>.md` handoff notes for agents (kept out of git). */
    handoffFiles: z.boolean(),
  }),
  safety: z.object({
    confirmDangerousCommands: z.boolean(),
    redactSecrets: z.boolean(),
  }),
  defaultEngines: RoleEnginesSchema,
  /** Per-role model overrides; a missing role uses the engine's own default model. */
  roleModels: RoleModelsSchema,
  /** Default reasoning effort for every project (engines that support it). Null → each CLI's default. */
  effort: EffortSchema.nullable().default(null),
  /** Map task complexity to a pipeline profile and model (off by default). */
  routing: RoutingSchema,
  /** Soft monthly spend cap (USD); when a project's month-to-date cost reaches it, new tasks don't start. 0/null = off. */
  monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable().default(null),
  /**
   * USD per 1M tokens, keyed by model id (e.g. "gpt-5-codex") or engine id.
   * Used only when the CLI doesn't report a cost itself.
   */
  pricing: z.record(
    z.string().trim().min(1).max(100),
    z.object({
      input: z.number().min(0).max(1000),
      output: z.number().min(0).max(1000),
      cacheRead: z.number().min(0).max(1000).default(0),
      cacheWrite: z.number().min(0).max(1000).default(0),
    }),
  ),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
  workspaceRoot: null,
  concurrency: { maxTasksPerProject: 2, maxRunsPerEngine: 2 },
  pipeline: {
    maxFixLoops: 3,
    requireHumanReviewBeforeMerge: false,
    mergeStrategy: 'merge',
    autoApprovePlans: false,
    checkTestsFailWithoutChange: true,
    reviewTests: true,
  },
  health: { engineCheckIntervalSec: 120 },
  quota: { probeInitialBackoffSec: 300, probeMaxBackoffSec: 3 * 3600, fallbackEnabled: false },
  memory: { maxPromptChars: 12_000, mirrorFile: true, handoffFiles: true },
  safety: { confirmDangerousCommands: true, redactSecrets: true },
  pricing: {},
  defaultEngines: {
    planner: 'claude-code',
    developer: 'claude-code',
    reviewer: 'claude-code',
    tester: 'claude-code',
    fixer: 'claude-code',
    documenter: 'claude-code',
  },
  roleModels: {},
  effort: null,
  routing: DEFAULT_ROUTING,
  monthlyBudgetUsd: null,
};

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Recursively merge `patch` onto `base`. Arrays and scalars are replaced. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch))
    return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}
