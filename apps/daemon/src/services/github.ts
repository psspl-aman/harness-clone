import type { GithubOwner, GithubRepo, GithubStatus } from '@agentforge/shared';
import { Octokit } from '@octokit/rest';
import { execa } from 'execa';
import type { Db } from '../db/client';
import { kvDelete, kvGet, kvSet } from '../db/kv';
import type { EventBus } from '../events/bus';
import { AppError, badRequest } from '../http/errors';
import type { SecretStore } from './secrets';

const TOKEN_SECRET = 'github.token'; // gforge:allow — secret name, not a value
const META_KEY = 'github.connection';

interface ConnectionMeta {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  scopes: string[];
  source: 'token' | 'gh-cli';
}

export interface GithubServiceOptions {
  /** Override for tests / GitHub Enterprise. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Clone URL for a repo; tests point this at a local bare repo. */
  cloneUrlFor?: (fullName: string) => string;
  /** Command used to read a token from the GitHub CLI. */
  ghCommand?: string;
}

type RawRepo = {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  description: string | null;
  default_branch?: string;
  updated_at?: string | null;
  html_url: string;
};

const toRepo = (r: RawRepo): GithubRepo => ({
  fullName: r.full_name,
  name: r.name,
  owner: r.owner.login,
  private: r.private,
  description: r.description,
  defaultBranch: r.default_branch ?? 'main',
  updatedAt: r.updated_at ?? null,
  htmlUrl: r.html_url,
});

/** Map Octokit errors to user-facing API errors without leaking request details. */
function ghError(err: unknown, action: string): AppError {
  const status = (err as { status?: number }).status;
  const msg = (
    err as { response?: { data?: { message?: string; errors?: { message?: string }[] } } }
  ).response?.data;
  const detail = msg?.errors?.[0]?.message ?? msg?.message;
  if (status === 401)
    return new AppError(401, 'GITHUB_AUTH', 'GitHub rejected the token — reconnect GitHub');
  if (status === 403)
    return new AppError(
      403,
      'GITHUB_FORBIDDEN',
      `GitHub refused to ${action}${detail ? `: ${detail}` : ''}`,
    );
  if (status === 404)
    return new AppError(404, 'GITHUB_NOT_FOUND', `Not found on GitHub while trying to ${action}`);
  if (status === 422)
    return new AppError(422, 'GITHUB_INVALID', `Could not ${action}${detail ? `: ${detail}` : ''}`);
  return new AppError(502, 'GITHUB_ERROR', `GitHub request failed while trying to ${action}`);
}

export class GithubService {
  private repoCache: { at: number; repos: GithubRepo[] } | null = null;
  private ghCliCache: { at: number; available: boolean } | null = null;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly bus: EventBus,
    private readonly opts: GithubServiceOptions = {},
  ) {}

  private client(token = this.secrets.get(TOKEN_SECRET)): Octokit {
    if (!token) throw new AppError(409, 'GITHUB_NOT_CONNECTED', 'Connect GitHub first');
    return new Octokit({
      auth: token,
      baseUrl: this.opts.baseUrl,
      userAgent: 'agentforge',
      request: this.opts.fetch ? { fetch: this.opts.fetch } : undefined,
    });
  }

  async status(): Promise<GithubStatus> {
    const meta = kvGet<ConnectionMeta>(this.db, META_KEY);
    const connected = !!meta && this.secrets.has(TOKEN_SECRET);
    return {
      connected,
      login: connected ? meta.login : null,
      name: connected ? meta.name : null,
      avatarUrl: connected ? meta.avatarUrl : null,
      scopes: connected ? meta.scopes : [],
      source: connected ? meta.source : null,
      ghCliAvailable: await this.ghCliAvailable(),
    };
  }

  async connect(token: string, source: ConnectionMeta['source'] = 'token'): Promise<GithubStatus> {
    let res;
    try {
      res = await this.client(token).request('GET /user');
    } catch (err) {
      const e = ghError(err, 'verify the token');
      throw e.code === 'GITHUB_AUTH' ? badRequest('GitHub rejected this token') : e;
    }
    const scopes = String(res.headers['x-oauth-scopes'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.secrets.set(TOKEN_SECRET, token);
    kvSet(this.db, META_KEY, {
      login: res.data.login,
      name: res.data.name ?? null,
      avatarUrl: res.data.avatar_url ?? null,
      scopes,
      source,
    } satisfies ConnectionMeta);
    this.repoCache = null;
    return this.emitStatus();
  }

  /** One-click connect using the token from an already logged-in `gh` CLI. */
  async importFromGhCli(): Promise<GithubStatus> {
    const token = await this.ghCliToken();
    if (!token)
      throw badRequest('The GitHub CLI is not installed or not logged in (run `gh auth login`)');
    return this.connect(token, 'gh-cli');
  }

  async disconnect(): Promise<GithubStatus> {
    this.secrets.delete(TOKEN_SECRET);
    kvDelete(this.db, META_KEY);
    this.repoCache = null;
    return this.emitStatus();
  }

  /** Repos the user can access, most recently updated first, filtered by `query`. */
  async listRepos(query = ''): Promise<GithubRepo[]> {
    if (!this.repoCache || Date.now() - this.repoCache.at > 60_000) {
      const octo = this.client();
      const repos: GithubRepo[] = [];
      try {
        for (let page = 1; page <= 3; page++) {
          const res = await octo.request('GET /user/repos', {
            per_page: 100,
            page,
            sort: 'updated',
            affiliation: 'owner,collaborator,organization_member',
          });
          repos.push(...(res.data as RawRepo[]).map(toRepo));
          if (res.data.length < 100) break;
        }
      } catch (err) {
        throw ghError(err, 'list repositories');
      }
      this.repoCache = { at: Date.now(), repos };
    }
    const q = query.trim().toLowerCase();
    const list = q
      ? this.repoCache.repos.filter(
          (r) => r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q),
        )
      : this.repoCache.repos;
    return list.slice(0, 100);
  }

  async listOwners(): Promise<GithubOwner[]> {
    const octo = this.client();
    try {
      const [user, orgs] = await Promise.all([
        octo.request('GET /user'),
        octo.request('GET /user/orgs', { per_page: 100 }),
      ]);
      return [
        { login: user.data.login, type: 'user', avatarUrl: user.data.avatar_url ?? null },
        ...orgs.data.map((o) => ({
          login: o.login,
          type: 'org' as const,
          avatarUrl: o.avatar_url ?? null,
        })),
      ];
    } catch (err) {
      throw ghError(err, 'list accounts');
    }
  }

  async getRepo(fullName: string): Promise<GithubRepo> {
    const [owner, repo] = fullName.split('/') as [string, string];
    try {
      const res = await this.client().request('GET /repos/{owner}/{repo}', { owner, repo });
      return toRepo(res.data as RawRepo);
    } catch (err) {
      throw ghError(err, `open ${fullName}`);
    }
  }

  async createRepo(input: {
    owner: string;
    name: string;
    private: boolean;
    description?: string;
  }): Promise<GithubRepo> {
    const octo = this.client();
    const meta = kvGet<ConnectionMeta>(this.db, META_KEY);
    const body = {
      name: input.name,
      private: input.private,
      description: input.description,
      auto_init: true,
    };
    try {
      const res =
        meta && input.owner === meta.login
          ? await octo.request('POST /user/repos', body)
          : await octo.request('POST /orgs/{org}/repos', { org: input.owner, ...body });
      this.repoCache = null;
      return toRepo(res.data as RawRepo);
    } catch (err) {
      throw ghError(err, `create ${input.owner}/${input.name}`);
    }
  }

  /**
   * Clone without ever writing the token to disk or argv: it is passed to git
   * as an HTTP header through GIT_CONFIG_* environment variables.
   */
  async clone(fullName: string, dest: string): Promise<void> {
    const token = this.secrets.get(TOKEN_SECRET);
    const url = this.opts.cloneUrlFor?.(fullName) ?? `https://github.com/${fullName}.git`;
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
    if (token && url.startsWith('https://')) {
      const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
      Object.assign(env, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${new URL(url).origin}/.extraheader`,
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      });
    }
    try {
      await execa('git', ['clone', '--', url, dest], { env, timeout: 15 * 60_000 });
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr ?? '');
      const safe = token ? stderr.split(token).join('***') : stderr;
      throw new AppError(
        502,
        'CLONE_FAILED',
        `git clone failed: ${safe.split('\n').filter(Boolean).slice(-2).join(' ') || 'unknown error'}`,
      );
    }
  }

  /** Push a branch to the repo on GitHub (token via env, like clone). */
  async push(repoDir: string, fullName: string, branch: string): Promise<void> {
    const url = this.opts.cloneUrlFor?.(fullName) ?? `https://github.com/${fullName}.git`;
    const token = this.secrets.get(TOKEN_SECRET);
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', ...this.authEnv(url, token) };
    try {
      await execa('git', ['push', '--force-with-lease', url, `${branch}:refs/heads/${branch}`], {
        cwd: repoDir,
        env,
        timeout: 10 * 60_000,
      });
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr ?? '');
      throw new AppError(
        502,
        'PUSH_FAILED',
        `git push failed: ${(token ? stderr.split(token).join('***') : stderr).split('\n').filter(Boolean).slice(-2).join(' ')}`,
      );
    }
  }

  async createPullRequest(
    fullName: string,
    pr: { head: string; base: string; title: string; body: string },
  ): Promise<{ url: string; number: number }> {
    const [owner, repo] = fullName.split('/') as [string, string];
    try {
      const res = await this.client().request('POST /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        ...pr,
      });
      return { url: res.data.html_url, number: res.data.number };
    } catch (err) {
      throw ghError(err, `open a pull request on ${fullName}`);
    }
  }

  private authEnv(url: string, token: string | null): Record<string, string> {
    if (!token || !url.startsWith('https://')) return {};
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${new URL(url).origin}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    };
  }

  private async emitStatus(): Promise<GithubStatus> {
    const status = await this.status();
    this.bus.emit('github.status_changed', { status });
    return status;
  }

  private async ghCliToken(): Promise<string | null> {
    try {
      const { stdout } = await execa(this.opts.ghCommand ?? 'gh', ['auth', 'token'], {
        timeout: 5000,
      });
      const t = stdout.trim();
      return t.length >= 20 ? t : null;
    } catch {
      return null;
    }
  }

  private async ghCliAvailable(): Promise<boolean> {
    if (this.ghCliCache && Date.now() - this.ghCliCache.at < 60_000)
      return this.ghCliCache.available;
    const available = (await this.ghCliToken()) !== null;
    this.ghCliCache = { at: Date.now(), available };
    return available;
  }
}
