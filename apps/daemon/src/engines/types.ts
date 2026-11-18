import type {
  AgentEvent,
  AgentRunInputDto,
  AgentRunResultDto,
  AuthStatus,
  EngineCapabilities,
  EngineError,
  UsageDelta,
} from '@agentforge/shared';

export interface AgentRunInput extends AgentRunInputDto {
  signal?: AbortSignal;
}
export type AgentRunResult = AgentRunResultDto;

export interface DetectResult {
  installed: boolean;
  version?: string;
  path?: string;
}

export interface AuthStatusResult {
  status: AuthStatus;
  accountLabel?: string | null;
  detail?: string | null;
  resetAt?: number | null;
  /** Some CLIs list models as part of the auth probe. */
  models?: { id: string; label: string }[];
}

/** A login flow is a CLI command AgentForge runs in an embedded terminal. */
export interface LoginFlow {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Shown above the terminal. */
  hint: string;
}

/** Per-engine runtime context supplied by the registry. */
export interface AdapterEnv {
  /** User-configured binary path, if any. */
  binaryOverride(): string | null;
  /** API key stored in AgentForge's secret store, if any. */
  apiKey(): string | null;
  /** Extra directories searched for binaries (tests). */
  extraPath?: string[];
}

export interface AgentEngineAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly installGuideUrl: string | null;
  readonly installCommand: string | null;
  readonly capabilities: EngineCapabilities;
  /** Static model suggestions; `getAuthStatus` may return a live list. */
  readonly staticModels: { id: string; label: string }[];

  detectInstalled(): Promise<DetectResult>;
  getAuthStatus(): Promise<AuthStatusResult>;
  startLogin(): Promise<LoginFlow>;
  logout(): Promise<void>;
  run(input: AgentRunInput, onEvent: (e: AgentEvent) => void): Promise<AgentRunResult>;
  parseUsage(event: AgentEvent): UsageDelta | null;
  classifyError(output: string): EngineError;
}
