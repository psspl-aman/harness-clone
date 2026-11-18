import type {
  ApiError,
  AppSettings,
  DeepPartial,
  ProjectSummary,
  SystemInfo,
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
  },
};

/** Query keys, centralised so live events can invalidate precisely. */
export const qk = {
  system: ['system'] as const,
  settings: ['settings'] as const,
  projects: ['projects'] as const,
};
