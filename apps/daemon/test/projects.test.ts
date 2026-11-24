import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryEntries } from '../src/db/schema';
import {
  createTestApp,
  GIT_ID,
  installFakeEngine,
  tempDir,
  writeTree,
  type TestApp,
} from './helpers';

let t: TestApp;
let root: string;
beforeEach(async () => {
  t = await createTestApp();
  root = tempDir();
});
afterEach(async () => {
  await t.cleanup();
  rmSync(root, { recursive: true, force: true });
});

const post = (payload: object) => t.app.inject({ method: 'POST', url: '/api/projects', payload });
const gitOut = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const settle = (id: string) => t.ctx.projects.runOnboarding(id);

describe('create from scratch (local)', () => {
  it('creates the folder, initialises git with a safe .gitignore and stores the requirement', async () => {
    await installFakeEngine(t, 'codex');
    const events: string[] = [];
    t.ctx.bus.subscribe((e) => events.push(e.type));
    const res = await post({
      mode: 'scratch',
      name: 'Todo App',
      location: { kind: 'local', parentDir: root, folderName: 'todo-app' },
      stackPreferences: 'Next.js + SQLite',
      roleEngines: { reviewer: 'codex' },
      initialRequirement: 'Build a todo app with tags',
    });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    const dir = join(root, 'todo-app');
    expect(p).toMatchObject({
      name: 'Todo App',
      slug: 'todo-app',
      origin: 'scratch',
      source: 'local',
      localPath: dir,
      defaultBranch: 'main',
      stackPreferences: 'Next.js + SQLite',
      roleEngines: { reviewer: 'codex' },
    });
    expect(gitOut(dir, 'log', '--oneline')).toMatch(/initialize project/);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.env');
    await settle(p.id);
    const detail = (await t.app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).json();
    expect(detail.onboardingStatus).toBe('done');
    expect(detail.onboardingReport.git.isRepo).toBe(true);
    const reqs = (
      await t.app.inject({ method: 'GET', url: `/api/projects/${p.id}/requirements` })
    ).json();
    expect(reqs).toMatchObject([
      { author: 'user', content: 'Build a todo app with tags', intent: 'generate_plan' },
    ]);
    expect(events).toEqual(
      expect.arrayContaining(['project.created', 'project.onboarding', 'project.updated']),
    );
  });

  it('rejects duplicates, non-empty folders and bad input', async () => {
    const body = {
      mode: 'scratch',
      name: 'A',
      location: { kind: 'local', parentDir: root, folderName: 'a' },
    };
    expect((await post(body)).statusCode).toBe(201);
    const dup = await post(body);
    expect(dup.statusCode).toBe(409);
    writeTree(root, { 'b/x.txt': 'x' });
    expect(
      (await post({ ...body, location: { ...body.location, folderName: 'b' } })).json().error
        .message,
    ).toMatch(/not empty/);
    expect(
      (await post({ ...body, location: { ...body.location, folderName: '../evil' } })).statusCode,
    ).toBe(400);
    expect((await post({ mode: 'scratch', name: '', location: body.location })).statusCode).toBe(
      400,
    );
  });

  it('gives each project a unique slug', async () => {
    const mk = (folderName: string) =>
      post({
        mode: 'scratch',
        name: 'Same Name',
        location: { kind: 'local', parentDir: root, folderName },
      });
    expect((await mk('one')).json().slug).toBe('same-name');
    expect((await mk('two')).json().slug).toBe('same-name-2');
  });
});

describe('attach existing (local)', () => {
  it('initialises git without committing secrets, analyses and writes project memory', async () => {
    const dir = join(root, 'legacy');
    writeTree(dir, {
      'package.json': JSON.stringify({
        scripts: { dev: 'vite', test: 'vitest' },
        devDependencies: { vite: '7' },
      }),
      'package-lock.json': '{}',
      'src/main.js': 'console.log(1)',
      '.env': 'API_KEY=topsecret', // gforge:allow — fake fixture
      '.env.production': 'API_KEY=prodsecret', // gforge:allow — fake fixture
      'certs/server.pem': 'PRIVATE',
    });
    const res = await post({
      mode: 'existing',
      location: { kind: 'local', path: dir, initGit: true },
    });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p.name).toBe('legacy');
    const tracked = gitOut(dir, 'ls-files').split('\n');
    expect(tracked).toEqual(expect.arrayContaining(['package.json', 'src/main.js', '.gitignore']));
    expect(tracked).not.toContain('.env');
    expect(tracked).not.toContain('.env.production');
    expect(tracked).not.toContain('certs/server.pem');

    await settle(p.id);
    const d = (await t.app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).json();
    expect(d.commands).toMatchObject({
      install: 'npm install',
      run: 'npm run dev',
      test: 'npm test',
    });
    expect(d.stack).toContain('Vite');
    expect(d.onboardingReport.envFiles).toEqual(['.env', '.env.production']);
    const mem = t.ctx.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.projectId, p.id))
      .all();
    expect(mem.map((m) => m.kind)).toEqual(
      expect.arrayContaining(['stack', 'command', 'architecture', 'pitfall']),
    );
    expect(JSON.stringify(mem)).not.toContain('topsecret');
  });

  it('keeps user-edited commands when re-analysing and leaves files on delete', async () => {
    const dir = join(root, 'svc');
    writeTree(dir, { 'go.mod': 'module svc\n', 'main.go': 'package main' });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', [...GIT_ID, 'add', '-A'], { cwd: dir });
    execFileSync('git', [...GIT_ID, 'commit', '-qm', 'init'], { cwd: dir });
    const p = (
      await post({ mode: 'existing', name: 'Service', location: { kind: 'local', path: dir } })
    ).json();
    await settle(p.id);
    const upd = await t.app.inject({
      method: 'PATCH',
      url: `/api/projects/${p.id}`,
      payload: { commands: { run: 'air', lint: '' } },
    });
    expect(upd.json().commands).toMatchObject({ run: 'air', lint: null, test: 'go test ./...' });
    expect(
      (await t.app.inject({ method: 'POST', url: `/api/projects/${p.id}/analyze` })).statusCode,
    ).toBe(202);
    await settle(p.id);
    const after = (await t.app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).json();
    expect(after.commands.run).toBe('air');
    expect(after.commands.lint).toBe('go vet ./...'); // cleared → refilled from detection
    const mem = t.ctx.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.projectId, p.id))
      .all();
    expect(mem.filter((m) => m.kind === 'stack')).toHaveLength(1); // replaced, not duplicated

    expect(
      (await t.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` })).statusCode,
    ).toBe(204);
    expect(existsSync(join(dir, 'main.go'))).toBe(true);
    expect((await t.app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).statusCode).toBe(
      404,
    );
  });

  it('requires git (or permission to initialise it)', async () => {
    const dir = join(root, 'nogit');
    writeTree(dir, { 'a.txt': 'x' });
    const res = await post({
      mode: 'existing',
      location: { kind: 'local', path: dir, initGit: false },
    });
    expect(res.statusCode).toBe(400);
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });

  it('stores per-project pipeline overrides and fallback engines', async () => {
    await installFakeEngine(t, 'codex');
    const p = (
      await post({
        mode: 'scratch',
        name: 'Y',
        location: { kind: 'local', parentDir: root, folderName: 'y' },
      })
    ).json();
    expect(p.pipeline).toMatchObject({
      maxConcurrentTasks: null,
      fallbackEnabled: false,
      engineFallback: {},
      paused: false,
    });
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/projects/${p.id}`,
      payload: {
        pipeline: {
          maxFixLoops: 1,
          mergeStrategy: 'pull_request',
          fallbackEnabled: true,
          engineFallback: { 'claude-code': 'codex' },
        },
      },
    });
    expect(res.json().pipeline).toMatchObject({
      maxFixLoops: 1,
      mergeStrategy: 'pull_request',
      fallbackEnabled: true,
      engineFallback: { 'claude-code': 'codex' },
    });
    const cleared = await t.app.inject({
      method: 'PATCH',
      url: `/api/projects/${p.id}`,
      payload: { pipeline: { maxFixLoops: null } },
    });
    expect(cleared.json().pipeline.maxFixLoops).toBeNull();
    expect(
      (
        await t.app.inject({
          method: 'PATCH',
          url: `/api/projects/${p.id}`,
          payload: { pipeline: { maxFixLoops: 99 } },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('rejects updates with unknown fields', async () => {
    const p = (
      await post({
        mode: 'scratch',
        name: 'X',
        location: { kind: 'local', parentDir: root, folderName: 'x' },
      })
    ).json();
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/projects/${p.id}`,
      payload: { localPath: '/etc' },
    });
    expect(res.statusCode).toBe(400);
  });
});
