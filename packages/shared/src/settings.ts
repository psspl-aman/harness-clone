import { z } from 'zod';
import { AGENT_ROLES } from './enums';

export const EngineIdSchema = z
  .string()
  .regex(
    /^(claude-code|codex|gemini-cli|antigravity|custom:[a-z0-9][a-z0-9-]{0,62})$/,
    'Unknown engine id',
  );

const roleEngineShape = Object.fromEntries(AGENT_ROLES.map((r) => [r, EngineIdSchema])) as Record<
  (typeof AGENT_ROLES)[number],
  typeof EngineIdSchema
>;

export const RoleEnginesSchema = z.object(roleEngineShape);
export type RoleEngines = z.infer<typeof RoleEnginesSchema>;

/** Global application settings. Stored as one JSON document in `settings`. */
export const AppSettingsSchema = z.object({
  /** Where GitHub clones / managed workspaces live. null → `<AGENTFORGE_HOME>/workspaces`. */
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
    /** Mirror project memory to `.agentforge/memory.md` (kept out of git). */
    mirrorFile: z.boolean(),
    /** Keep `.agentforge/PROJECT.md` and `tasks/<KEY>.md` handoff notes for agents (kept out of git). */
    handoffFiles: z.boolean(),
  }),
  safety: z.object({
    confirmDangerousCommands: z.boolean(),
    redactSecrets: z.boolean(),
  }),
  defaultEngines: RoleEnginesSchema,
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
