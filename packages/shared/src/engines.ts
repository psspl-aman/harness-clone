import { z } from 'zod';
import type { AuthStatus, EngineErrorKind } from './enums';

// ─── Normalised agent stream events ──────────────────────────────────────────

export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Cost reported by the CLI itself, when it reports one. */
  costUsd?: number;
  model?: string;
}

export interface UsageWindow {
  /** e.g. "five_hour", "seven_day". */
  name: string;
  /** 0..1 when known. */
  utilization: number | null;
  resetsAt: number | null;
  status: 'allowed' | 'warning' | 'rejected' | 'unknown';
}

/** Every adapter maps its CLI's output onto these events. */
export type AgentEvent =
  | { kind: 'session'; sessionId: string; model?: string }
  | { kind: 'text'; text: string; delta?: boolean }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id?: string; name: string; input?: unknown }
  | { kind: 'tool_result'; id?: string; ok: boolean; output?: string }
  | { kind: 'usage'; usage: UsageDelta }
  | {
      kind: 'rate_limit';
      status: UsageWindow['status'];
      resetsAt: number | null;
      windows: UsageWindow[];
    }
  | { kind: 'error'; message: string; fatal: boolean }
  | { kind: 'log'; stream: 'stdout' | 'stderr'; line: string };

export type PermissionProfile = 'readonly' | 'edit' | 'full';

export interface AgentRunInputDto {
  prompt: string;
  cwd: string;
  model?: string | null;
  /** Resume a previous CLI conversation when the engine supports it. */
  resumeSessionId?: string | null;
  systemPrompt?: string | null;
  permission: PermissionProfile;
  timeoutMs?: number;
}

export interface EngineError {
  kind: EngineErrorKind;
  message: string;
  /** When the usage window resets, if the error says so (epoch ms). */
  resetAt: number | null;
}

export interface AgentRunResultDto {
  status: 'succeeded' | 'failed' | 'cancelled';
  sessionId: string | null;
  finalText: string;
  usage: UsageDelta;
  durationMs: number;
  exitCode: number | null;
  error: EngineError | null;
}

// ─── Engine catalogue / status ───────────────────────────────────────────────

export interface EngineCapabilities {
  login: boolean;
  logout: boolean;
  apiKey: boolean;
  resume: boolean;
  modelList: boolean;
}

export interface EngineInfo {
  id: string;
  kind: 'builtin' | 'custom';
  displayName: string;
  description: string;
  installGuideUrl: string | null;
  installCommand: string | null;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  path: string | null;
  binaryOverride: string | null;
  authStatus: AuthStatus;
  accountLabel: string | null;
  authDetail: string | null;
  resetAt: number | null;
  hasApiKey: boolean;
  defaultModel: string | null;
  models: { id: string; label: string }[];
  usageWindows: UsageWindow[];
  capabilities: EngineCapabilities;
  lastCheckedAt: number | null;
  customConfig: CustomEngineConfig | null;
}

export const UpdateEngineInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    binaryPath: z.string().trim().max(500).nullable().optional(),
    defaultModel: z.string().trim().max(200).nullable().optional(),
  })
  .strict();
export type UpdateEngineInput = z.infer<typeof UpdateEngineInputSchema>;

export const ApiKeyInputSchema = z.object({ apiKey: z.string().trim().min(8).max(500) });

// ─── Custom CLI engines ──────────────────────────────────────────────────────

/** Dotted path into a JSON object, e.g. "message.content.0.text". */
const jsonPath = z
  .string()
  .trim()
  .max(200)
  .regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/, 'Use dotted paths like result.text');

export const CustomEngineConfigSchema = z.object({
  /** Executable name or absolute path (never run through a shell). */
  command: z.string().trim().min(1).max(500),
  /**
   * Argument template. Placeholders: {{prompt}} {{cwd}} {{model}} {{sessionId}}.
   * An argument that is only a placeholder resolving to empty is dropped, along
   * with the flag right before it (so ["--model", "{{model}}"] disappears when no model is set).
   */
  args: z.array(z.string().max(2000)).max(50),
  promptVia: z.enum(['arg', 'stdin']),
  outputFormat: z.enum(['text', 'jsonl']),
  textPath: jsonPath.optional(),
  sessionIdPath: jsonPath.optional(),
  usage: z
    .object({
      inputTokensPath: jsonPath.optional(),
      outputTokensPath: jsonPath.optional(),
      /** Regex with named groups `input` / `output` applied to text output. */
      regex: z.string().max(500).optional(),
    })
    .optional(),
  versionArgs: z.array(z.string().max(100)).max(5).optional(),
  /** Exit code 0 means logged in. */
  authCheckArgs: z.array(z.string().max(100)).max(10).optional(),
  /** Command + args run in an embedded terminal for login. */
  loginArgs: z.array(z.string().max(100)).max(10).optional(),
  /** Env var the stored API key is passed through, e.g. MY_CLI_API_KEY. */
  apiKeyEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .optional(),
});
export type CustomEngineConfig = z.infer<typeof CustomEngineConfigSchema>;

export const CreateCustomEngineInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Lowercase letters, numbers and dashes'),
  displayName: z.string().trim().min(1).max(60),
  config: CustomEngineConfigSchema,
});

export const TestRunInputSchema = z.object({
  prompt: z.string().trim().min(1).max(2000).optional(),
  model: z.string().trim().max(200).optional(),
});

export interface TerminalInfo {
  id: string;
  kind: 'shell' | 'run' | 'login';
  title: string;
  cwd: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  engineId: string | null;
  projectId: string | null;
  createdAt: number;
}

export const STATUS_LABELS: Record<AuthStatus, string> = {
  NOT_INSTALLED: 'Not installed',
  LOGGED_OUT: 'Logged out',
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  QUOTA_EXHAUSTED: 'Quota exhausted',
  UNKNOWN: 'Unknown',
};

export type { EngineErrorKind };
