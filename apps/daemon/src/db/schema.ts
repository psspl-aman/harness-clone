/**
 * AI Harness SQLite schema (Drizzle). All timestamps are epoch milliseconds.
 * After changing this file run `pnpm db:generate` to emit a SQL migration.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  PipelineState,
  MessageKind,
  PlannerQuestion,
  CustomEngineConfig,
  UsageWindow,
  OnboardingReport,
  AgentRole,
  AppSettings,
  AuthStatus,
  Complexity,
  EngineErrorKind,
  ErrorSource,
  McpTransport,
  McpToolDto,
  PmsFilters,
  PmsSyncResultDto,
  PmsToolMap,
  MemoryKind,
  MemoryScope,
  PlanStatus,
  Priority,
  ProjectOrigin,
  ProjectSource,
  RequirementIntent,
  ReviewScope,
  RoleEngines,
  RoleModels,
  Routing,
  RunStatus,
  ProjectServiceDto,
  SheetField,
  SheetKind,
  SheetSyncResultDto,
  TaskStatus,
  TaskType,
} from '@ai-harness/shared';

const now = () => Date.now();
const createdAt = () => integer('created_at').notNull().$defaultFn(now);
const updatedAt = () => integer('updated_at').notNull().$defaultFn(now).$onUpdateFn(now);
const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();
const bool = (name: string) => integer(name, { mode: 'boolean' });

export interface ProjectCommands {
  install?: string | null;
  run?: string | null;
  build?: string | null;
  test?: string | null;
  lint?: string | null;
  services?: ProjectServiceDto[] | null;
}

// ─── Projects ────────────────────────────────────────────────────────────────

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    origin: text('origin').$type<ProjectOrigin>().notNull(),
    source: text('source').$type<ProjectSource>().notNull(),
    localPath: text('local_path').notNull(),
    githubRepo: text('github_repo'),
    defaultBranch: text('default_branch'),
    workingBranch: text('working_branch'),
    stack: json<string[]>('stack')
      .notNull()
      .default(sql`'[]'`),
    stackPreferences: text('stack_preferences'),
    commands: json<ProjectCommands>('commands')
      .notNull()
      .default(sql`'{}'`),
    onboardingStatus: text('onboarding_status')
      .$type<'pending' | 'running' | 'done' | 'failed' | 'skipped'>()
      .notNull()
      .default('pending'),
    onboardingReport: json<OnboardingReport>('onboarding_report'),
    onboardingError: text('onboarding_error'),
    onboardedAt: integer('onboarded_at'),
    runningStatus: text('running_status')
      .$type<'stopped' | 'starting' | 'running' | 'crashed'>()
      .notNull()
      .default('stopped'),
    nextTaskSeq: integer('next_task_seq').notNull().default(1),
    archivedAt: integer('archived_at'),
    lastActivityAt: integer('last_activity_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('projects_slug_uq').on(t.slug),
    uniqueIndex('projects_path_uq').on(t.localPath),
  ],
);

export const projectSettings = sqliteTable('project_settings', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  /** Per-role engine overrides; missing roles fall back to global defaults. */
  roleEngines: json<Partial<RoleEngines>>('role_engines')
    .notNull()
    .default(sql`'{}'`),
  /** Per-role model overrides; missing roles fall back to global roleModels, then the engine default. */
  roleModels: json<RoleModels>('role_models')
    .notNull()
    .default(sql`'{}'`),
  /** Complexity→pipeline routing override; null falls back to the global routing setting. */
  routing: json<Routing>('routing'),
  maxConcurrentTasks: integer('max_concurrent_tasks'),
  maxFixLoops: integer('max_fix_loops'),
  requireHumanReview: bool('require_human_review'),
  mergeStrategy: text('merge_strategy').$type<AppSettings['pipeline']['mergeStrategy']>(),
  /** e.g. { "claude-code": "codex" } — continue with Y when X is exhausted. */
  engineFallback: json<Record<string, string>>('engine_fallback')
    .notNull()
    .default(sql`'{}'`),
  fallbackEnabled: bool('fallback_enabled').notNull().default(false),
  /** Stop starting new tasks (running ones finish their current step). */
  pipelinePaused: bool('pipeline_paused').notNull().default(false),
  memoryFileEnabled: bool('memory_file_enabled').notNull().default(true),
  memoryFileGitignored: bool('memory_file_gitignored').notNull().default(true),
  updatedAt: updatedAt(),
});

// ─── Requirements & planning ─────────────────────────────────────────────────

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Path relative to AI_HARNESS_HOME/attachments. */
  storagePath: string;
}

export const requirements = sqliteTable(
  'requirements',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    author: text('author').$type<'user' | 'planner' | 'system'>().notNull(),
    content: text('content').notNull(),
    intent: text('intent').$type<RequirementIntent>(),
    attachments: json<Attachment[]>('attachments')
      .notNull()
      .default(sql`'[]'`),
    /** `@file` and `#task` references extracted from the message. */
    references: json<{ files: string[]; tasks: string[] }>('references')
      .notNull()
      .default(sql`'{"files":[],"tasks":[]}'`),
    kind: text('kind').$type<MessageKind>().notNull().default('message'),
    status: text('status')
      .$type<'done' | 'running' | 'failed' | 'cancelled'>()
      .notNull()
      .default('done'),
    questions: json<PlannerQuestion[]>('questions'),
    /** Plan this message created (planner "plan" messages). */
    planId: text('plan_id'),
    runId: text('run_id'),
    /** Previous version of this requirement when edited. */
    supersedesId: text('supersedes_id'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('requirements_project_idx').on(t.projectId, t.createdAt)],
);

export const plans = sqliteTable(
  'plans',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requirementId: text('requirement_id').references(() => requirements.id, {
      onDelete: 'set null',
    }),
    version: integer('version').notNull().default(1),
    status: text('status').$type<PlanStatus>().notNull().default('DRAFT'),
    goal: text('goal').notNull(),
    scope: text('scope').notNull().default(''),
    outOfScope: text('out_of_scope').notNull().default(''),
    architectureNotes: text('architecture_notes').notNull().default(''),
    risks: json<string[]>('risks')
      .notNull()
      .default(sql`'[]'`),
    assumptions: json<string[]>('assumptions')
      .notNull()
      .default(sql`'[]'`),
    approvedAt: integer('approved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('plans_project_idx').on(t.projectId)],
);

// ─── Tasks ───────────────────────────────────────────────────────────────────

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    planId: text('plan_id').references(() => plans.id, { onDelete: 'set null' }),
    requirementId: text('requirement_id').references(() => requirements.id, {
      onDelete: 'set null',
    }),
    /** Human key, e.g. "AF-12". */
    key: text('key').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    type: text('type').$type<TaskType>().notNull().default('feature'),
    priority: text('priority').$type<Priority>().notNull().default('medium'),
    complexity: text('complexity').$type<Complexity>().notNull().default('m'),
    status: text('status').$type<TaskStatus>().notNull().default('DRAFT'),
    statusReason: text('status_reason'),
    /** Status to return to when leaving a PAUSED_* state. */
    resumeToStatus: text('resume_to_status').$type<TaskStatus>(),
    resumeAt: integer('resume_at'),
    acceptanceCriteria: json<string[]>('acceptance_criteria')
      .notNull()
      .default(sql`'[]'`),
    affectedAreas: json<string[]>('affected_areas')
      .notNull()
      .default(sql`'[]'`),
    roleEngines: json<Partial<RoleEngines>>('role_engines')
      .notNull()
      .default(sql`'{}'`),
    roleModels: json<RoleModels>('role_models')
      .notNull()
      .default(sql`'{}'`),
    orderIndex: real('order_index').notNull().default(0),
    fixLoopCount: integer('fix_loop_count').notNull().default(0),
    pipelineState: json<PipelineState>('pipeline_state')
      .notNull()
      .default(sql`'{}'`),
    branchName: text('branch_name'),
    worktreePath: text('worktree_path'),
    baseBranch: text('base_branch'),
    pullRequestUrl: text('pull_request_url'),
    origin: text('origin')
      .$type<'planner' | 'manual' | 'pms' | 'error' | 'conflict'>()
      .notNull()
      .default('planner'),
    /** For fix tasks created from a detected error. */
    sourceErrorId: text('source_error_id'),
    pmsConnectionId: text('pms_connection_id'),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    externalUpdatedAt: integer('external_updated_at'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tasks_project_status_idx').on(t.projectId, t.status),
    index('tasks_plan_idx').on(t.planId),
    index('tasks_resume_idx').on(t.status, t.resumeAt),
    uniqueIndex('tasks_project_key_uq').on(t.projectId, t.key),
    uniqueIndex('tasks_external_uq').on(t.pmsConnectionId, t.externalId),
  ],
);

export const taskStatusHistory = sqliteTable(
  'task_status_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status').$type<TaskStatus>(),
    toStatus: text('to_status').$type<TaskStatus>().notNull(),
    reason: text('reason'),
    actor: text('actor').notNull().default('system'),
    createdAt: createdAt(),
  },
  (t) => [index('task_status_history_task_idx').on(t.taskId, t.createdAt)],
);

export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: text('depends_on_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
    index('task_deps_reverse_idx').on(t.dependsOnTaskId),
  ],
);

export const subtasks = sqliteTable(
  'subtasks',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    done: bool('done').notNull().default(false),
    orderIndex: real('order_index').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('subtasks_task_idx').on(t.taskId)],
);

// ─── Agent runs ──────────────────────────────────────────────────────────────

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    requirementId: text('requirement_id').references(() => requirements.id, {
      onDelete: 'set null',
    }),
    role: text('role').$type<AgentRole>().notNull(),
    engineId: text('engine_id').notNull(),
    model: text('model'),
    attempt: integer('attempt').notNull().default(1),
    status: text('status').$type<RunStatus>().notNull().default('RUNNING'),
    prompt: text('prompt').notNull(),
    cwd: text('cwd'),
    /** CLI conversation/session id, used to resume after a pause. */
    sessionId: text('session_id'),
    resultSummary: text('result_summary'),
    resultJson: json<unknown>('result_json'),
    filesChanged: json<string[]>('files_changed')
      .notNull()
      .default(sql`'[]'`),
    diff: text('diff'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    exitCode: integer('exit_code'),
    errorKind: text('error_kind').$type<EngineErrorKind>(),
    errorMessage: text('error_message'),
    startedAt: integer('started_at').notNull().$defaultFn(now),
    finishedAt: integer('finished_at'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [
    index('agent_runs_task_idx').on(t.taskId, t.startedAt),
    index('agent_runs_project_idx').on(t.projectId, t.startedAt),
    index('agent_runs_status_idx').on(t.status),
  ],
);

export const runEvents = sqliteTable(
  'run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind')
      .$type<'stdout' | 'stderr' | 'message' | 'tool' | 'usage' | 'status' | 'user'>()
      .notNull(),
    data: text('data').notNull(),
    ts: integer('ts').notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex('run_events_run_seq_uq').on(t.runId, t.seq)],
);

export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    reviewer: text('reviewer').$type<'agent' | 'human'>().notNull().default('agent'),
    /** 'code' reviews gate testing; 'tests' reviews check the tests after they pass. */
    scope: text('scope').$type<ReviewScope>().notNull().default('code'),
    verdict: text('verdict').$type<'APPROVE' | 'CHANGES_REQUESTED'>().notNull(),
    summary: text('summary').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('reviews_task_idx').on(t.taskId)],
);

export const reviewComments = sqliteTable(
  'review_comments',
  {
    id: text('id').primaryKey(),
    reviewId: text('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    filePath: text('file_path'),
    line: integer('line'),
    severity: text('severity').$type<'info' | 'minor' | 'major' | 'blocker'>().notNull(),
    body: text('body').notNull(),
    resolved: bool('resolved').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('review_comments_review_idx').on(t.reviewId)],
);

export const testResults = sqliteTable(
  'test_results',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    passed: bool('passed').notNull(),
    total: integer('total'),
    failed: integer('failed'),
    skipped: integer('skipped'),
    buildPassed: bool('build_passed'),
    commands: json<string[]>('commands')
      .notNull()
      .default(sql`'[]'`),
    summary: text('summary').notNull().default(''),
    log: text('log').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('test_results_task_idx').on(t.taskId)],
);

export const checkpoints = sqliteTable(
  'checkpoints',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    taskStatus: text('task_status').$type<TaskStatus>().notNull(),
    role: text('role').$type<AgentRole>(),
    engineId: text('engine_id'),
    sessionId: text('session_id'),
    branchName: text('branch_name'),
    lastCompletedStep: text('last_completed_step'),
    notes: text('notes').notNull().default(''),
    data: json<Record<string, unknown>>('data')
      .notNull()
      .default(sql`'{}'`),
    createdAt: createdAt(),
  },
  (t) => [index('checkpoints_task_idx').on(t.taskId, t.createdAt)],
);

// ─── Errors ──────────────────────────────────────────────────────────────────

export const errors = sqliteTable(
  'errors',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    terminalSessionId: text('terminal_session_id'),
    source: text('source').$type<ErrorSource>().notNull(),
    matcher: text('matcher').notNull(),
    message: text('message').notNull(),
    filePath: text('file_path'),
    line: integer('line'),
    column: integer('column'),
    excerpt: text('excerpt').notNull().default(''),
    /** Stable hash used to de-duplicate repeated occurrences. */
    fingerprint: text('fingerprint').notNull(),
    occurrences: integer('occurrences').notNull().default(1),
    status: text('status')
      .$type<'open' | 'fixing' | 'resolved' | 'ignored'>()
      .notNull()
      .default('open'),
    fixTaskId: text('fix_task_id'),
    firstSeenAt: integer('first_seen_at').notNull().$defaultFn(now),
    lastSeenAt: integer('last_seen_at').notNull().$defaultFn(now),
  },
  (t) => [
    index('errors_project_status_idx').on(t.projectId, t.status),
    uniqueIndex('errors_project_fingerprint_uq').on(t.projectId, t.fingerprint),
  ],
);

// ─── Engines, sessions & usage ───────────────────────────────────────────────

export const engines = sqliteTable('engines', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<'builtin' | 'custom'>().notNull(),
  displayName: text('display_name').notNull(),
  enabled: bool('enabled').notNull().default(true),
  binaryPath: text('binary_path'),
  defaultModel: text('default_model'),
  customConfig: json<CustomEngineConfig>('custom_config'),
  installed: bool('installed').notNull().default(false),
  version: text('version'),
  detectedPath: text('detected_path'),
  /** Known usage limit for the current window (tokens), if the user set one. */
  authStatus: text('auth_status').$type<AuthStatus>().notNull().default('UNKNOWN'),
  authDetail: text('auth_detail'),
  accountLabel: text('account_label'),
  resetAt: integer('reset_at'),
  models: json<{ id: string; label: string }[]>('models')
    .notNull()
    .default(sql`'[]'`),
  usageWindows: json<UsageWindow[]>('usage_windows')
    .notNull()
    .default(sql`'[]'`),
  windowTokenLimit: integer('window_token_limit'),
  windowHours: real('window_hours'),
  lastCheckedAt: integer('last_checked_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const engineSessions = sqliteTable(
  'engine_sessions',
  {
    id: text('id').primaryKey(),
    engineId: text('engine_id')
      .notNull()
      .references(() => engines.id, { onDelete: 'cascade' }),
    status: text('status').$type<AuthStatus>().notNull(),
    accountLabel: text('account_label'),
    resetAt: integer('reset_at'),
    detail: text('detail'),
    checkedAt: integer('checked_at').notNull().$defaultFn(now),
    createdAt: createdAt(),
  },
  (t) => [index('engine_sessions_engine_idx').on(t.engineId, t.checkedAt)],
);

export const usageRecords = sqliteTable(
  'usage_records',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    role: text('role').$type<AgentRole>(),
    taskType: text('task_type').$type<TaskType>(),
    engineId: text('engine_id').notNull(),
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    /** Where costUsd came from: the CLI, the price table, or unknown. */
    costSource: text('cost_source')
      .$type<'reported' | 'estimated' | 'none'>()
      .notNull()
      .default('none'),
    durationMs: integer('duration_ms').notNull().default(0),
    recordedAt: integer('recorded_at').notNull().$defaultFn(now),
  },
  (t) => [
    index('usage_recorded_idx').on(t.recordedAt),
    index('usage_project_idx').on(t.projectId, t.recordedAt),
    index('usage_engine_idx').on(t.engineId, t.recordedAt),
  ],
);

// ─── MCP & PMS ───────────────────────────────────────────────────────────────

export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  transport: text('transport').$type<McpTransport>().notNull(),
  command: text('command'),
  args: json<string[]>('args')
    .notNull()
    .default(sql`'[]'`),
  /** Env var names → secret refs (`secret:<id>`) or literal non-secret values. */ // gforge:allow — doc comment, no secret
  env: json<Record<string, string>>('env')
    .notNull()
    .default(sql`'{}'`),
  url: text('url'),
  headers: json<Record<string, string>>('headers')
    .notNull()
    .default(sql`'{}'`),
  enabled: bool('enabled').notNull().default(true),
  lastStatus: text('last_status').$type<'unknown' | 'ok' | 'error'>().notNull().default('unknown'),
  lastError: text('last_error'),
  toolsCache: json<McpToolDto[]>('tools_cache')
    .notNull()
    .default(sql`'[]'`),
  lastCheckedAt: integer('last_checked_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const pmsConnections = sqliteTable('pms_connections', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  mcpServerId: text('mcp_server_id')
    .notNull()
    .references(() => mcpServers.id, { onDelete: 'cascade' }),
  /** Which MCP tools (and argument templates) implement list/get/update/comment. */
  toolMap: json<PmsToolMap>('tool_map')
    .notNull()
    .default(sql`'{}'`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const pmsMappings = sqliteTable(
  'pms_mappings',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => pmsConnections.id, { onDelete: 'cascade' }),
    externalProject: text('external_project').notNull(),
    statusMap: json<Record<string, TaskStatus>>('status_map')
      .notNull()
      .default(sql`'{}'`),
    filters: json<PmsFilters>('filters')
      .notNull()
      .default(sql`'{}'`),
    pollingIntervalSec: integer('polling_interval_sec'),
    writeBack: bool('write_back').notNull().default(true),
    autoEnrich: bool('auto_enrich').notNull().default(true),
    lastSyncedAt: integer('last_synced_at'),
    lastError: text('last_error'),
    lastResult: json<PmsSyncResultDto>('last_result'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('pms_mappings_uq').on(t.projectId, t.connectionId, t.externalProject)],
);

/** A spreadsheet (Google Sheet, Excel or CSV file) whose rows become tasks of a project. */
export const sheetSources = sqliteTable(
  'sheet_sources',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').$type<SheetKind>().notNull(),
    location: text('location').notNull(),
    sheet: text('sheet'),
    columns: json<Partial<Record<SheetField, string>>>('columns')
      .notNull()
      .default(sql`'{}'`),
    pollingIntervalSec: integer('polling_interval_sec'),
    autoStart: bool('auto_start').notNull().default(true),
    autoEnrich: bool('auto_enrich').notNull().default(true),
    lastSyncedAt: integer('last_synced_at'),
    lastError: text('last_error'),
    lastResult: json<SheetSyncResultDto>('last_result'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('sheet_sources_uq').on(t.projectId, t.location, t.sheet)],
);

// ─── Memory & docs ───────────────────────────────────────────────────────────

export const memoryEntries = sqliteTable(
  'memory_entries',
  {
    id: text('id').primaryKey(),
    scope: text('scope').$type<MemoryScope>().notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<MemoryKind>().notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    tags: json<string[]>('tags')
      .notNull()
      .default(sql`'[]'`),
    pinned: bool('pinned').notNull().default(false),
    source: text('source')
      .$type<'user' | 'documenter' | 'onboarding' | 'planner' | 'agent'>()
      .notNull()
      .default('user'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('memory_scope_idx').on(t.scope, t.projectId),
    index('memory_task_idx').on(t.taskId),
  ],
);

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    kind: text('kind')
      .$type<'task_report' | 'readme' | 'changelog' | 'architecture' | 'other'>()
      .notNull(),
    title: text('title').notNull(),
    /** Repo-relative path when mirrored to a file. */
    path: text('path'),
    content: text('content').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('documents_project_idx').on(t.projectId, t.kind)],
);

// ─── Terminals ───────────────────────────────────────────────────────────────

export const terminalSessions = sqliteTable(
  'terminal_sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    engineId: text('engine_id'),
    kind: text('kind').$type<'shell' | 'run' | 'login'>().notNull(),
    title: text('title').notNull(),
    cwd: text('cwd').notNull(),
    command: text('command'),
    status: text('status').$type<'running' | 'exited'>().notNull().default('running'),
    pid: integer('pid'),
    exitCode: integer('exit_code'),
    createdAt: createdAt(),
    endedAt: integer('ended_at'),
  },
  (t) => [index('terminal_sessions_project_idx').on(t.projectId)],
);

// ─── Settings ────────────────────────────────────────────────────────────────

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: json<unknown>('value').notNull(),
  updatedAt: updatedAt(),
});

// ─── Secrets (encrypted at rest, AES-256-GCM) ────────────────────────────────

export const secrets = sqliteTable('secrets', {
  id: text('id').primaryKey(),
  /** Stable lookup name, e.g. "github.token". */
  name: text('name').notNull().unique(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
