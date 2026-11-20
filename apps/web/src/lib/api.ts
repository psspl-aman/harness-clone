import type {
  ApiError,
  AppSettings,
  CreateProjectInput,
  DeepPartial,
  FsBrowseResult,
  GithubOwner,
  GithubRepo,
  GithubStatus,
  PathCheckMode,
  PathCheckResult,
  ProjectDetail,
  ProjectSummary,
  RequirementDto,
  SystemInfo,
  UpdateProjectInput,
  CustomEngineConfig,
  EngineInfo,
  TerminalInfo,
  UpdateEngineInput,
  AttachmentDto,
  ChatMessageDto,
  CreateTaskInput,
  PlanBoardDto,
  PlanDto,
  PlannerState,
  ReferenceSuggestions,
  SendMessageInput,
  TaskDto,
  TaskStatusChangeDto,
  UpdatePlanInput,
  UpdateTaskInput,
  AgentEvent,
  PipelineStatusDto,
  ReviewDto,
  RunSummaryDto,
  TaskDiffDto,
  TaskReportDto,
  TestResultDto,
  CheckpointDto,
  UsageSummaryDto,
  UsageWindowStatusDto,
  ActivityItemDto,
  ErrorDto,
  FileContentDto,
  ProjectRunDto,
  McpServerDto,
  McpServerInput,
  PmsConnectionDto,
  PmsConnectionInput,
  PmsIssue,
  PmsMappingDto,
  PmsMappingInput,
  PmsProviderPreset,
  PmsSyncResultDto,
  PmsToolMap,
  PmsFilters,
  DocDto,
  DocSummaryDto,
  MemoryEntryDto,
  MemoryInput,
  MemoryKind,
  MemoryScope,
  SafetyApprovalDto,
  PausedTaskDto,
} from '@agentforge/shared';

export const DAEMON_URL = (
  process.env.NEXT_PUBLIC_AGENTFORGE_DAEMON_URL ?? 'http://127.0.0.1:4317'
).replace(/\/$/, '');

export const DAEMON_WS_URL = `${DAEMON_URL.replace(/^http/, 'ws')}/ws`;

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
  get isUnreachable() {
    return this.code === 'DAEMON_UNREACHABLE';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${DAEMON_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiClientError(
      0,
      'DAEMON_UNREACHABLE',
      `Cannot reach the AgentForge daemon at ${DAEMON_URL}`,
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const err = (data as ApiError | undefined)?.error;
    throw new ApiClientError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? res.statusText,
      err?.details,
    );
  }
  return data as T;
}

export const api = {
  system: () => request<SystemInfo>('GET', '/api/system'),
  settings: {
    get: () => request<AppSettings>('GET', '/api/settings'),
    update: (patch: DeepPartial<AppSettings>) =>
      request<AppSettings>('PATCH', '/api/settings', patch),
  },
  projects: {
    list: () => request<ProjectSummary[]>('GET', '/api/projects'),
    get: (id: string) => request<ProjectDetail>('GET', `/api/projects/${id}`),
    create: (input: CreateProjectInput) => request<ProjectDetail>('POST', '/api/projects', input),
    update: (id: string, input: UpdateProjectInput) =>
      request<ProjectDetail>('PATCH', `/api/projects/${id}`, input),
    remove: (id: string) => request<void>('DELETE', `/api/projects/${id}`),
    analyze: (id: string) => request<{ ok: true }>('POST', `/api/projects/${id}/analyze`),
    requirements: (id: string) =>
      request<RequirementDto[]>('GET', `/api/projects/${id}/requirements`),
  },
  fs: {
    browse: (path?: string, hidden = false) =>
      request<FsBrowseResult>(
        'GET',
        `/api/fs/browse?${new URLSearchParams({ ...(path ? { path } : {}), hidden: hidden ? '1' : '0' })}`,
      ),
    mkdir: (parent: string, name: string) =>
      request<FsBrowseResult>('POST', '/api/fs/mkdir', { parent, name }),
    check: (path: string, mode: PathCheckMode) =>
      request<PathCheckResult>('GET', `/api/fs/check?${new URLSearchParams({ path, mode })}`),
  },
  engines: {
    list: () => request<EngineInfo[]>('GET', '/api/engines'),
    refreshAll: () => request<EngineInfo[]>('POST', '/api/engines/refresh'),
    refresh: (id: string) => request<EngineInfo>('POST', `/api/engines/${id}/refresh`),
    update: (id: string, input: UpdateEngineInput) =>
      request<EngineInfo>('PATCH', `/api/engines/${id}`, input),
    setApiKey: (id: string, apiKey: string) =>
      request<EngineInfo>('PUT', `/api/engines/${id}/api-key`, { apiKey }),
    clearApiKey: (id: string) => request<EngineInfo>('DELETE', `/api/engines/${id}/api-key`),
    login: (id: string) =>
      request<{ terminal: TerminalInfo; hint: string }>('POST', `/api/engines/${id}/login`),
    logout: (id: string) => request<EngineInfo>('POST', `/api/engines/${id}/logout`),
    test: (id: string, body: { prompt?: string; model?: string }) =>
      request<{ runId: string }>('POST', `/api/engines/${id}/test`, body),
    cancelRun: (runId: string) => request<{ ok: true }>('POST', `/api/runs/${runId}/cancel`),
    createCustom: (input: { slug: string; displayName: string; config: CustomEngineConfig }) =>
      request<EngineInfo>('POST', '/api/engines/custom', input),
    updateCustom: (id: string, input: { displayName: string; config: CustomEngineConfig }) =>
      request<EngineInfo>('PUT', `/api/engines/${id}/custom`, input),
    removeCustom: (id: string) => request<void>('DELETE', `/api/engines/${id}`),
  },
  chat: {
    list: (projectId: string) =>
      request<ChatMessageDto[]>('GET', `/api/projects/${projectId}/chat`),
    send: (projectId: string, input: SendMessageInput) =>
      request<ChatMessageDto>('POST', `/api/projects/${projectId}/chat`, input),
    planner: (projectId: string) =>
      request<PlannerState>('GET', `/api/projects/${projectId}/planner`),
    cancel: (projectId: string) =>
      request<{ ok: true }>('POST', `/api/projects/${projectId}/planner/cancel`),
    references: (projectId: string, q: string) =>
      request<ReferenceSuggestions>(
        'GET',
        `/api/projects/${projectId}/references?${new URLSearchParams({ q })}`,
      ),
    upload: async (projectId: string, files: File[]): Promise<AttachmentDto[]> => {
      const form = new FormData();
      for (const f of files) form.append('file', f, f.name);
      let res: Response;
      try {
        res = await fetch(`${DAEMON_URL}/api/projects/${projectId}/attachments`, {
          method: 'POST',
          body: form,
        });
      } catch {
        throw new ApiClientError(
          0,
          'DAEMON_UNREACHABLE',
          `Cannot reach the AgentForge daemon at ${DAEMON_URL}`,
        );
      }
      const data = (await res.json()) as unknown;
      if (!res.ok) {
        const err = (data as ApiError).error;
        throw new ApiClientError(
          res.status,
          err?.code ?? 'HTTP_ERROR',
          err?.message ?? res.statusText,
        );
      }
      return data as AttachmentDto[];
    },
  },
  board: {
    get: (projectId: string) => request<PlanBoardDto>('GET', `/api/projects/${projectId}/board`),
    reorder: (projectId: string, taskIds: string[]) =>
      request<TaskDto[]>('POST', `/api/projects/${projectId}/tasks/reorder`, { taskIds }),
  },
  plans: {
    update: (planId: string, input: UpdatePlanInput) =>
      request<PlanDto>('PATCH', `/api/plans/${planId}`, input),
    approve: (planId: string, taskIds?: string[]) =>
      request<PlanBoardDto>('POST', `/api/plans/${planId}/approve`, { taskIds }),
    regenerate: (planId: string, instructions: string) =>
      request<PlannerState>('POST', `/api/plans/${planId}/regenerate`, { instructions }),
    addTask: (planId: string, input: CreateTaskInput) =>
      request<TaskDto>('POST', `/api/plans/${planId}/tasks`, input),
  },
  tasks: {
    update: (id: string, input: UpdateTaskInput) =>
      request<TaskDto>('PATCH', `/api/tasks/${id}`, input),
    remove: (id: string) => request<void>('DELETE', `/api/tasks/${id}`),
    history: (id: string) => request<TaskStatusChangeDto[]>('GET', `/api/tasks/${id}/history`),
    setDependencies: (id: string, dependsOn: string[]) =>
      request<TaskDto>('PUT', `/api/tasks/${id}/dependencies`, { dependsOn }),
    split: (id: string, parts: { title: string; description?: string }[]) =>
      request<TaskDto[]>('POST', `/api/tasks/${id}/split`, { parts }),
    merge: (taskIds: string[], title?: string) =>
      request<TaskDto>('POST', '/api/tasks/merge', { taskIds, title }),
    approve: (id: string) => request<TaskDto>('POST', `/api/tasks/${id}/approve`),
    unapprove: (id: string) => request<TaskDto>('POST', `/api/tasks/${id}/unapprove`),
    regenerate: (id: string, instructions: string) =>
      request<PlannerState>('POST', `/api/tasks/${id}/regenerate`, { instructions }),
    addSubtask: (id: string, title: string) =>
      request<TaskDto>('POST', `/api/tasks/${id}/subtasks`, { title }),
    updateSubtask: (id: string, input: { title?: string; done?: boolean }) =>
      request<TaskDto>('PATCH', `/api/subtasks/${id}`, input),
    removeSubtask: (id: string) => request<TaskDto>('DELETE', `/api/subtasks/${id}`),
  },
  pipeline: {
    status: (projectId: string) =>
      request<PipelineStatusDto>('GET', `/api/projects/${projectId}/pipeline`),
    pause: (projectId: string) =>
      request<PipelineStatusDto>('POST', `/api/projects/${projectId}/pipeline/pause`),
    resume: (projectId: string) =>
      request<PipelineStatusDto>('POST', `/api/projects/${projectId}/pipeline/resume`),
    task: (
      id: string,
      action: 'pause' | 'resume' | 'cancel' | 'restart' | 'retry' | 'fix' | 'approve-merge',
    ) => request<TaskDto>('POST', `/api/tasks/${id}/${action}`),
    steer: (id: string, message: string) =>
      request<TaskDto>('POST', `/api/tasks/${id}/steer`, { message }),
    requestChanges: (id: string, comments: string) =>
      request<TaskDto>('POST', `/api/tasks/${id}/request-changes`, { comments }),
    runs: (id: string) => request<RunSummaryDto[]>('GET', `/api/tasks/${id}/runs`),
    reviews: (id: string) => request<ReviewDto[]>('GET', `/api/tasks/${id}/reviews`),
    tests: (id: string) => request<TestResultDto[]>('GET', `/api/tasks/${id}/tests`),
    diff: (id: string) => request<TaskDiffDto>('GET', `/api/tasks/${id}/diff`),
    report: (id: string) => request<TaskReportDto | null>('GET', `/api/tasks/${id}/report`),
  },
  usage: {
    summary: (q: { days: number; projectId?: string; engineId?: string }) =>
      request<UsageSummaryDto>(
        'GET',
        `/api/usage/summary?${new URLSearchParams(
          Object.entries(q)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => [k, String(v)]),
        )}`,
      ),
    windows: () => request<UsageWindowStatusDto[]>('GET', '/api/usage/windows'),
    paused: () => request<PausedTaskDto[]>('GET', '/api/tasks/paused'),
    checkpoints: (taskId: string) =>
      request<CheckpointDto[]>('GET', `/api/tasks/${taskId}/checkpoints`),
  },
  runs: {
    get: (id: string) =>
      request<{
        run: { id: string; status: string; engineId: string };
        events: { seq: number; event: AgentEvent }[];
      }>('GET', `/api/runs/${id}`),
  },
  runtime: {
    run: (projectId: string) => request<ProjectRunDto>('GET', `/api/projects/${projectId}/run`),
    start: (projectId: string) =>
      request<ProjectRunDto>('POST', `/api/projects/${projectId}/run/start`),
    stop: (projectId: string) =>
      request<ProjectRunDto>('POST', `/api/projects/${projectId}/run/stop`),
    restart: (projectId: string) =>
      request<ProjectRunDto>('POST', `/api/projects/${projectId}/run/restart`),
    oneShot: (projectId: string, kind: 'build' | 'test' | 'install') =>
      request<TerminalInfo>('POST', `/api/projects/${projectId}/run/${kind}`),
    shell: (projectId: string) =>
      request<TerminalInfo>('POST', `/api/projects/${projectId}/terminals`, {}),
    errors: (projectId: string) => request<ErrorDto[]>('GET', `/api/projects/${projectId}/errors`),
    errorAction: (errorId: string, action: 'fix' | 'ignore' | 'reopen' | 'resolve') =>
      request<ErrorDto>('POST', `/api/errors/${errorId}/${action}`),
    activity: (projectId: string) =>
      request<ActivityItemDto[]>('GET', `/api/projects/${projectId}/activity`),
    files: (projectId: string) =>
      request<{ files: string[]; truncated: boolean }>('GET', `/api/projects/${projectId}/files`),
    file: (projectId: string, path: string) =>
      request<FileContentDto>(
        'GET',
        `/api/projects/${projectId}/file?${new URLSearchParams({ path })}`,
      ),
  },
  safety: {
    approvals: () => request<SafetyApprovalDto[]>('GET', '/api/safety/approvals'),
    decide: (id: string, decision: 'approve' | 'deny') =>
      request<SafetyApprovalDto>('POST', `/api/safety/approvals/${id}`, { decision }),
  },
  memory: {
    list: (
      projectId: string | null,
      q: { search?: string; kind?: MemoryKind; scope?: MemoryScope } = {},
    ) => {
      const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
      return request<MemoryEntryDto[]>(
        'GET',
        `${projectId ? `/api/projects/${projectId}/memory` : '/api/memory'}${qs.size ? `?${qs}` : ''}`,
      );
    },
    create: (projectId: string | null, v: MemoryInput) =>
      request<MemoryEntryDto>(
        'POST',
        projectId ? `/api/projects/${projectId}/memory` : '/api/memory',
        v,
      ),
    update: (id: string, v: Partial<MemoryInput>) =>
      request<MemoryEntryDto>('PATCH', `/api/memory/${id}`, v),
    remove: (id: string) => request<void>('DELETE', `/api/memory/${id}`),
  },
  docs: {
    list: (projectId: string) => request<DocSummaryDto[]>('GET', `/api/projects/${projectId}/docs`),
    get: (projectId: string, doc: string) =>
      request<DocDto>(
        'GET',
        `/api/projects/${projectId}/docs/item?${new URLSearchParams({ doc })}`,
      ),
    downloadUrl: (projectId: string, doc: string) =>
      `${DAEMON_URL}/api/projects/${projectId}/docs/item?${new URLSearchParams({ doc, download: '1' })}`,
    exportUrl: (projectId: string) => `${DAEMON_URL}/api/projects/${projectId}/docs/export`,
  },
  mcp: {
    list: () => request<McpServerDto[]>('GET', '/api/mcp/servers'),
    create: (v: McpServerInput) => request<McpServerDto>('POST', '/api/mcp/servers', v),
    update: (id: string, v: McpServerInput) =>
      request<McpServerDto>('PUT', `/api/mcp/servers/${id}`, v),
    remove: (id: string) => request<void>('DELETE', `/api/mcp/servers/${id}`),
    test: (id: string) => request<McpServerDto>('POST', `/api/mcp/servers/${id}/test`),
  },
  pms: {
    providers: () => request<PmsProviderPreset[]>('GET', '/api/pms/providers'),
    connections: () => request<PmsConnectionDto[]>('GET', '/api/pms/connections'),
    createConnection: (v: PmsConnectionInput) =>
      request<PmsConnectionDto>('POST', '/api/pms/connections', v),
    updateConnection: (id: string, v: PmsConnectionInput) =>
      request<PmsConnectionDto>('PUT', `/api/pms/connections/${id}`, v),
    removeConnection: (id: string) => request<void>('DELETE', `/api/pms/connections/${id}`),
    detect: (mcpServerId: string, provider: string) =>
      request<PmsToolMap>('POST', '/api/pms/detect', { mcpServerId, provider }),
    preview: (v: {
      mcpServerId: string;
      toolMap: PmsToolMap;
      externalProject: string;
      filters?: PmsFilters;
    }) => request<{ issues: PmsIssue[]; total: number }>('POST', '/api/pms/preview', v),
    mappings: (projectId: string) =>
      request<PmsMappingDto[]>('GET', `/api/projects/${projectId}/pms`),
    createMapping: (projectId: string, v: PmsMappingInput) =>
      request<PmsMappingDto>('POST', `/api/projects/${projectId}/pms`, v),
    updateMapping: (id: string, v: Partial<Omit<PmsMappingInput, 'connectionId'>>) =>
      request<PmsMappingDto>('PATCH', `/api/pms/mappings/${id}`, v),
    removeMapping: (id: string) => request<void>('DELETE', `/api/pms/mappings/${id}`),
    sync: (id: string) => request<PmsSyncResultDto>('POST', `/api/pms/mappings/${id}/sync`),
    resolveConflict: (taskId: string, action: 'apply' | 'dismiss') =>
      request<TaskDto>('POST', `/api/tasks/${taskId}/pms-conflict`, { action }),
  },
  terminals: {
    list: (projectId: string) =>
      request<TerminalInfo[]>('GET', `/api/terminals?${new URLSearchParams({ projectId })}`),
    remove: (id: string) => request<void>('DELETE', `/api/terminals/${id}`),
    get: (id: string) =>
      request<TerminalInfo & { scrollback: string }>('GET', `/api/terminals/${id}`),
    input: (id: string, data: string) =>
      request<void>('POST', `/api/terminals/${id}/input`, { data }),
    resize: (id: string, cols: number, rows: number) =>
      request<void>('POST', `/api/terminals/${id}/resize`, { cols, rows }),
    kill: (id: string) => request<void>('POST', `/api/terminals/${id}/kill`),
  },
  github: {
    status: () => request<GithubStatus>('GET', '/api/github/status'),
    connect: (token: string) => request<GithubStatus>('POST', '/api/github/connect', { token }),
    importCli: () => request<GithubStatus>('POST', '/api/github/import-cli'),
    disconnect: () => request<GithubStatus>('DELETE', '/api/github/connection'),
    repos: (q = '') =>
      request<GithubRepo[]>('GET', `/api/github/repos?${new URLSearchParams({ q })}`),
    owners: () => request<GithubOwner[]>('GET', '/api/github/owners'),
  },
};

/** Query keys, centralised so live events can invalidate precisely. */
export const qk = {
  system: ['system'] as const,
  settings: ['settings'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  requirements: (id: string) => ['projects', id, 'requirements'] as const,
  fsBrowse: (path: string | undefined, hidden: boolean) =>
    ['fs', 'browse', path ?? '~', hidden] as const,
  fsCheck: (path: string, mode: PathCheckMode) => ['fs', 'check', mode, path] as const,
  github: ['github', 'status'] as const,
  engines: ['engines'] as const,
  chat: (projectId: string) => ['chat', projectId] as const,
  planner: (projectId: string) => ['planner', projectId] as const,
  board: (projectId: string) => ['board', projectId] as const,
  taskHistory: (taskId: string) => ['task-history', taskId] as const,
  pipeline: (projectId: string) => ['pipeline', projectId] as const,
  usage: (days: number, projectId: string, engineId: string) =>
    ['usage', days, projectId, engineId] as const,
  usageWindows: ['usage', 'windows'] as const,
  taskDetail: (taskId: string, part: 'runs' | 'reviews' | 'tests' | 'diff' | 'report') =>
    ['task-detail', taskId, part] as const,
  run: (runId: string) => ['run', runId] as const,
  projectRun: (projectId: string) => ['project-run', projectId] as const,
  errors: (projectId: string) => ['errors', projectId] as const,
  activity: (projectId: string) => ['activity', projectId] as const,
  terminals: (projectId: string) => ['terminals', projectId] as const,
  files: (projectId: string) => ['files', projectId] as const,
  file: (projectId: string, path: string) => ['files', projectId, path] as const,
  safetyApprovals: ['safety', 'approvals'] as const,
  pausedTasks: ['tasks', 'paused'] as const,
  memory: (projectId: string | null) => ['memory', projectId ?? 'global'] as const,
  docs: (projectId: string) => ['docs', projectId] as const,
  doc: (projectId: string, doc: string) => ['docs', projectId, doc] as const,
  mcpServers: ['mcp', 'servers'] as const,
  pmsProviders: ['pms', 'providers'] as const,
  pmsConnections: ['pms', 'connections'] as const,
  pmsMappings: (projectId: string) => ['pms', 'mappings', projectId] as const,
  references: (projectId: string, q: string) => ['references', projectId, q] as const,
  githubRepos: (q: string) => ['github', 'repos', q] as const,
  githubOwners: ['github', 'owners'] as const,
};
