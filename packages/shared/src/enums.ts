/** Core domain enumerations shared by daemon and web. */

export const TASK_STATUSES = [
  'DRAFT',
  'APPROVED',
  'QUEUED',
  'IN_DEVELOPMENT',
  'IN_REVIEW',
  'IN_TESTING',
  'FIXING',
  'DOCUMENTING',
  'DONE',
  'PAUSED_QUOTA',
  'PAUSED_AUTH',
  'PAUSED_MANUAL',
  'BLOCKED',
  'NEEDS_HUMAN',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const AGENT_ROLES = [
  'planner',
  'developer',
  'reviewer',
  'tester',
  'fixer',
  'documenter',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Built-in engine adapter ids. Custom adapters use `custom:<slug>`. */
export const BUILTIN_ENGINE_IDS = ['claude-code', 'codex', 'gemini-cli', 'antigravity'] as const;
export type BuiltinEngineId = (typeof BUILTIN_ENGINE_IDS)[number];
export type EngineId = BuiltinEngineId | `custom:${string}`;

export const AUTH_STATUSES = [
  'NOT_INSTALLED',
  'LOGGED_OUT',
  'ACTIVE',
  'EXPIRED',
  'QUOTA_EXHAUSTED',
  'UNKNOWN',
] as const;
export type AuthStatus = (typeof AUTH_STATUSES)[number];

export const ENGINE_ERROR_KINDS = [
  'RATE_LIMIT',
  'QUOTA_EXPIRED',
  'AUTH_EXPIRED',
  'NETWORK',
  'TOOL_ERROR',
  'UNKNOWN',
] as const;
export type EngineErrorKind = (typeof ENGINE_ERROR_KINDS)[number];

export const TASK_TYPES = ['feature', 'bug', 'refactor', 'test', 'docs', 'chore'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const COMPLEXITIES = ['xs', 's', 'm', 'l', 'xl'] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export const PROJECT_SOURCES = ['local', 'github'] as const;
export type ProjectSource = (typeof PROJECT_SOURCES)[number];

export const PROJECT_ORIGINS = ['scratch', 'existing'] as const;
export type ProjectOrigin = (typeof PROJECT_ORIGINS)[number];

export const RUN_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'PAUSED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const MEMORY_SCOPES = ['global', 'project', 'task'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_KINDS = [
  'stack',
  'architecture',
  'convention',
  'command',
  'decision',
  'pitfall',
  'glossary',
  'feature',
  'preference',
  'note',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const PLAN_STATUSES = ['DRAFT', 'APPROVED', 'SUPERSEDED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const REQUIREMENT_INTENTS = ['generate_plan', 'add_to_plan', 'discuss'] as const;
export type RequirementIntent = (typeof REQUIREMENT_INTENTS)[number];

export const ERROR_SOURCES = ['terminal', 'run', 'task', 'build', 'test'] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

export const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const ENGINE_LABELS: Record<BuiltinEngineId, string> = {
  'claude-code': 'Claude Code',
  codex: 'OpenAI Codex',
  'gemini-cli': 'Gemini CLI',
  antigravity: 'Antigravity',
};

export const ROLE_LABELS: Record<AgentRole, string> = {
  planner: 'Planner',
  developer: 'Developer',
  reviewer: 'Reviewer',
  tester: 'Tester',
  fixer: 'Fixer',
  documenter: 'Documenter',
};
