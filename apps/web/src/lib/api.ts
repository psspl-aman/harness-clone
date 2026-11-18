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
  terminals: {
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
  githubRepos: (q: string) => ['github', 'repos', q] as const,
  githubOwners: ['github', 'owners'] as const,
};
