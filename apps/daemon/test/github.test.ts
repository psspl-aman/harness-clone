import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secrets } from '../src/db/schema';
import { createTestApp, GIT_ID, tempDir, type TestApp } from './helpers';

const TOKEN = 'ghp_testtoken_0123456789abcdef'; // gforge:allow — fake test token

interface FakeRepo {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  description: string | null;
  default_branch: string;
  updated_at: string;
  html_url: string;
}

/** Minimal fake of the GitHub REST API, backed by local bare repos for cloning. */
class FakeGithub {
  repos: FakeRepo[] = [];
  calls: string[] = [];
  constructor(readonly remoteRoot: string) {}

  addRepo(
    fullName: string,
    files: Record<string, string> = { 'README.md': '# hi' },
    isPrivate = false,
  ) {
    const [owner, name] = fullName.split('/') as [string, string];
    const work = tempDir('af-src-');
    for (const [f, c] of Object.entries(files)) writeFileSync(join(work, f), c);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: work });
    execFileSync('git', [...GIT_ID, 'add', '-A'], { cwd: work });
    execFileSync('git', [...GIT_ID, 'commit', '-qm', 'init'], { cwd: work });
    mkdirSync(join(this.remoteRoot, owner), { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', work, join(this.remoteRoot, `${fullName}.git`)]);
    rmSync(work, { recursive: true, force: true });
    const repo = {
      full_name: fullName,
      name,
      owner: { login: owner },
      private: isPrivate,
      description: null,
      default_branch: 'main',
      updated_at: new Date().toISOString(),
      html_url: `https://github.com/${fullName}`,
    };
    this.repos.push(repo);
    return repo;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const auth = new Headers(init?.headers).get('authorization');
    this.calls.push(`${method} ${url.pathname}`);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });
    if (auth !== `token ${TOKEN}`) return json(401, { message: 'Bad credentials' });
    const p = url.pathname;
    if (method === 'GET' && p === '/user')
      return json(
        200,
        { login: 'octo', name: 'Octo Cat', avatar_url: 'https://a/x.png' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    if (method === 'GET' && p === '/user/orgs')
      return json(200, [{ login: 'acme', avatar_url: null }]);
    if (method === 'GET' && p === '/user/repos') return json(200, this.repos);
    const m = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (method === 'GET' && m) {
      const r = this.repos.find((x) => x.full_name === `${m[1]}/${m[2]}`);
      return r ? json(200, r) : json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && (p === '/user/repos' || /^\/orgs\/[^/]+\/repos$/.test(p))) {
      const body = JSON.parse(String(init?.body)) as {
        name: string;
        private: boolean;
        auto_init: boolean;
      };
      const owner = p === '/user/repos' ? 'octo' : p.split('/')[2]!;
      if (this.repos.some((r) => r.full_name === `${owner}/${body.name}`))
        return json(422, {
          message: 'Validation Failed',
          errors: [{ message: 'name already exists on this account' }],
        });
      expect(body.auto_init).toBe(true);
      return json(
        201,
        this.addRepo(`${owner}/${body.name}`, { 'README.md': `# ${body.name}` }, body.private),
      );
    }
    return json(404, { message: 'Not Found' });
  };
}

let t: TestApp;
let gh: FakeGithub;
let remoteRoot: string;

beforeEach(async () => {
  remoteRoot = tempDir('af-remote-');
  gh = new FakeGithub(remoteRoot);
  t = await createTestApp(
    {},
    {
      github: {
        fetch: gh.fetch as typeof fetch,
        baseUrl: 'https://api.github.test',
        cloneUrlFor: (n) => join(remoteRoot, `${n}.git`),
      },
    },
  );
});
afterEach(async () => {
  await t.cleanup();
  rmSync(remoteRoot, { recursive: true, force: true });
});

const connect = () =>
  t.app.inject({ method: 'POST', url: '/api/github/connect', payload: { token: TOKEN } });

describe('GitHub connection', () => {
  it('connects with a token, stores it encrypted and reports status', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/github/status' })).json()).toMatchObject(
      { connected: false, ghCliAvailable: false },
    );
    const events: string[] = [];
    t.ctx.bus.subscribe((e) => events.push(e.type));
    const res = await connect();
    expect(res.json()).toMatchObject({
      connected: true,
      login: 'octo',
      name: 'Octo Cat',
      scopes: ['repo', 'read:org'],
      source: 'token',
    });
    expect(events).toContain('github.status_changed');
    expect(JSON.stringify(t.ctx.db.select().from(secrets).all())).not.toContain(TOKEN);
    const status = await t.app.inject({ method: 'GET', url: '/api/github/status' });
    expect(status.body).not.toContain(TOKEN);
    expect(
      (await t.app.inject({ method: 'DELETE', url: '/api/github/connection' })).json().connected,
    ).toBe(false);
    expect(t.ctx.secrets.get('github.token')).toBeNull();
  });

  it('rejects bad tokens and requires a connection for repo calls', async () => {
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/github/connect',
      payload: { token: 'ghp_wrongtoken_00000000000' }, // gforge:allow — fake test token
    });
    expect(bad.statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/github/repos' })).statusCode).toBe(409);
  });

  it('imports the token from a logged-in gh CLI', async () => {
    const dir = tempDir();
    const fakeGh = join(dir, 'gh');
    writeFileSync(fakeGh, `#!/bin/sh\necho ${TOKEN}\n`);
    chmodSync(fakeGh, 0o755);
    const t2 = await createTestApp(
      {},
      {
        github: {
          fetch: gh.fetch as typeof fetch,
          baseUrl: 'https://api.github.test',
          ghCommand: fakeGh,
        },
      },
    );
    expect(
      (await t2.app.inject({ method: 'GET', url: '/api/github/status' })).json().ghCliAvailable,
    ).toBe(true);
    const res = await t2.app.inject({ method: 'POST', url: '/api/github/import-cli' });
    expect(res.json()).toMatchObject({ connected: true, source: 'gh-cli' });
    await t2.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists and filters repos and owners', async () => {
    gh.addRepo('octo/storefront');
    gh.addRepo('acme/billing-api');
    await connect();
    const all = (await t.app.inject({ method: 'GET', url: '/api/github/repos' })).json();
    expect(all.map((r: { fullName: string }) => r.fullName)).toEqual([
      'octo/storefront',
      'acme/billing-api',
    ]);
    const filtered = (
      await t.app.inject({ method: 'GET', url: '/api/github/repos?q=bill' })
    ).json();
    expect(filtered).toHaveLength(1);
    const owners = (await t.app.inject({ method: 'GET', url: '/api/github/owners' })).json();
    expect(owners).toEqual([
      { login: 'octo', type: 'user', avatarUrl: 'https://a/x.png' },
      { login: 'acme', type: 'org', avatarUrl: null },
    ]);
  });
});

describe('GitHub projects', () => {
  it('creates a new repo for a scratch project and clones it into the workspace', async () => {
    await connect();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        mode: 'scratch',
        name: 'Shiny',
        location: {
          kind: 'github',
          repo: { action: 'create', owner: 'acme', name: 'shiny', private: true },
        },
        initialRequirement: 'Landing page',
      },
    });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(gh.calls).toContain('POST /orgs/acme/repos');
    expect(p).toMatchObject({
      source: 'github',
      githubRepo: 'acme/shiny',
      defaultBranch: 'main',
      localPath: join(t.home, 'workspaces', 'acme', 'shiny'),
    });
    expect(existsSync(join(p.localPath, 'README.md'))).toBe(true);
    await t.ctx.projects.runOnboarding(p.id);

    const dup = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        mode: 'scratch',
        name: 'Shiny',
        location: {
          kind: 'github',
          repo: { action: 'create', owner: 'acme', name: 'shiny', private: true },
        },
      },
    });
    expect(dup.statusCode).toBe(422);
    expect(dup.json().error.message).toMatch(/already exists/);
  });

  it('attaches an existing repo, cloning beside an occupied folder', async () => {
    gh.addRepo('octo/api', { 'go.mod': 'module api\n', 'main.go': 'package main' });
    await connect();
    mkdirSync(join(t.home, 'workspaces/octo/api'), { recursive: true });
    writeFileSync(join(t.home, 'workspaces/octo/api/keep.txt'), 'occupied');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { mode: 'existing', location: { kind: 'github', fullName: 'octo/api' } },
    });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p.localPath).toBe(join(t.home, 'workspaces/octo/api-2'));
    expect(p.name).toBe('api');
    await t.ctx.projects.runOnboarding(p.id);
    const d = (await t.app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).json();
    expect(d.commands.test).toBe('go test ./...');
    expect(d.onboardingReport.git.remote).toContain('octo/api.git');
  });

  it('reports a missing repo cleanly', async () => {
    await connect();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { mode: 'existing', location: { kind: 'github', fullName: 'octo/ghost' } },
    });
    expect(res.statusCode).toBe(404);
  });
});
