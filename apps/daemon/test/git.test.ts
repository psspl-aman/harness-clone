import type { GitActionResultDto, GitBranchDetailDto, GitOverviewDto } from '@ai-harness/shared';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { projects, tasks } from '../src/db/schema';
import { newId } from '../src/lib/id';
import { parseStatus, redactUrl } from '../src/services/git-manager';
import { createTestApp, GIT_ID, tempDir, writeTree, type TestApp } from './helpers';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8' }).trim();

/** A repo on main with one commit. */
function repo(): string {
  const dir = tempDir('af-git-');
  sh(dir, 'init', '--initial-branch=main');
  writeTree(dir, { 'README.md': '# Shop\n', 'src/app.js': 'export const a = 1;\n' });
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-m', 'initial');
  return dir;
}

describe('git status parsing', () => {
  it('reads branch, upstream and every kind of change', () => {
    const raw = [
      '# branch.oid 1234567890abcdef',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/a file.ts',
      '1 A. N... 000000 100644 100644 000 ccc src/new.ts',
      '2 R. N... 100644 100644 100644 ddd eee R100 src/renamed.ts',
      'src/old.ts',
      'u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.ts',
      '? notes.txt',
      '',
    ].join('\0');
    const s = parseStatus(raw);
    expect(s).toMatchObject({
      head: 'feature/x',
      upstream: 'origin/feature/x',
      ahead: 2,
      behind: 1,
    });
    expect(s.changes).toEqual([
      { path: 'src/a file.ts', from: null, kind: 'modified', staged: false },
      { path: 'src/new.ts', from: null, kind: 'added', staged: true },
      { path: 'src/renamed.ts', from: 'src/old.ts', kind: 'renamed', staged: true },
      { path: 'conflict.ts', from: null, kind: 'conflicted', staged: false },
      { path: 'notes.txt', from: null, kind: 'untracked', staged: false },
    ]);
    expect(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0').head).toBeNull();
  });

  it('never shows credentials from remote URLs', () => {
    expect(redactUrl('https://user:tok@github.com/o/r.git')).toBe('https://github.com/o/r.git'); // gforge:allow — fake credentials to test redaction
    expect(redactUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
  });
});

describe('git tab', () => {
  let t: TestApp;
  const dirs: string[] = [];
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
    for (const d of dirs.splice(0))
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const req = async <T>(method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await t.app.inject({ method, url, payload: payload as object });
    return {
      status: res.statusCode,
      body: res.json() as T & { error?: { code: string; message: string } },
    };
  };
  async function project(dir: string, initGit = false) {
    dirs.push(dir);
    const res = await req<{ id: string }>('POST', '/api/projects', {
      mode: 'existing',
      name: 'Shop',
      location: { kind: 'local', path: dir, initGit },
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }
  const overview = async (id: string) =>
    (await req<GitOverviewDto>('GET', `/api/projects/${id}/git`)).body;

  it('lists branches with what each task did and where it landed', async () => {
    const dir = repo();
    sh(dir, 'switch', '-c', 'af/shop-2-add-cart');
    writeTree(dir, { 'src/cart.js': 'export const cart = [];\n' });
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-m', 'SHOP-2: add cart');
    sh(dir, 'switch', 'main');
    writeFileSync(join(dir, 'notes.txt'), 'todo');
    const id = await project(dir);
    const task = (key: string, v: Partial<typeof tasks.$inferInsert>) =>
      t.ctx.db
        .insert(tasks)
        .values({ id: newId('tsk'), projectId: id, key, title: `Task ${key}`, ...v })
        .run();
    task('SHOP-1', {
      status: 'DONE',
      pipelineState: { mergedInto: 'main', mergeCommit: 'abc' },
      completedAt: Date.now(),
    });
    task('SHOP-2', { status: 'IN_REVIEW', branchName: 'af/shop-2-add-cart', baseBranch: 'main' });

    const o = await overview(id);
    expect(o).toMatchObject({
      isRepo: true,
      current: 'main',
      workingBranch: 'main',
      operation: null,
    });
    expect(o.changes).toEqual([
      { path: 'notes.txt', from: null, kind: 'untracked', staged: false },
    ]);
    const main = o.branches.find((b) => b.name === 'main')!;
    expect(main).toMatchObject({
      current: true,
      working: true,
      default: true,
      ahead: 0,
      behind: 0,
    });
    const feature = o.branches.find((b) => b.name === 'af/shop-2-add-cart')!;
    expect(feature).toMatchObject({
      kind: 'local',
      ahead: 1,
      behind: 0,
      merged: false,
      subject: 'SHOP-2: add cart',
    });
    expect(feature.tasks.map((x) => x.key)).toEqual(['SHOP-2']);
    expect(o.work).toHaveLength(1);
    expect(o.work[0]!.branch).toBe('main');
    expect(o.work[0]!.tasks.map((x) => [x.key, x.state])).toEqual(
      expect.arrayContaining([
        ['SHOP-1', 'merged'],
        ['SHOP-2', 'in_progress'],
      ]),
    );

    const d = (
      await req<GitBranchDetailDto>('GET', `/api/projects/${id}/git/branch?name=af/shop-2-add-cart`)
    ).body;
    expect(d.base).toBe('main');
    expect(d.commits).toHaveLength(1);
    expect(d.commits[0]!.task?.key).toBe('SHOP-2');
    expect(d.diff?.files.map((f) => f.path)).toEqual(['src/cart.js']);
    // Plain history of main.
    const h = (await req<GitBranchDetailDto>('GET', `/api/projects/${id}/git/branch?name=main`))
      .body;
    expect(h.base).toBeNull();
    expect(h.commits.map((c) => c.subject)).toEqual(['initial']);
  });

  it('creates, switches, commits, merges and deletes branches', async () => {
    const dir = repo();
    const id = await project(dir);
    const post = (path: string, body?: unknown) =>
      req<GitActionResultDto>('POST', `/api/projects/${id}/git/${path}`, body ?? {});

    expect((await post('branches', { name: 'bad name' })).status).toBe(400);
    let r = await post('branches', { name: 'feature/login', checkout: true });
    expect(r.status).toBe(200);
    expect(r.body.overview.current).toBe('feature/login');
    expect((await post('branches', { name: 'feature/login' })).status).toBe(409);

    writeTree(dir, { 'src/login.js': 'export const login = () => true;\n', '.env': 'TOKEN=x' });
    r = await post('commit', { message: 'Add login' });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/Committed 1 file to feature\/login \(left out 1 secret file\)/);
    expect(sh(dir, 'ls-files')).not.toContain('.env');
    expect((await post('commit', { message: 'again' })).body.error?.message).toMatch(/secret/);

    // Can't delete the branch you're on.
    expect((await post('branches/delete', { name: 'feature/login' })).status).toBe(409);
    r = await post('checkout', { branch: 'main' });
    expect(r.body.overview.current).toBe('main');

    // Merge into the working branch (main is checked out and has only an ignored .env… which is untracked).
    rmSync(join(dir, '.env'));
    r = await post('merge', { source: 'feature/login' });
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Merged feature/login into main');
    expect(sh(dir, 'log', '-1', '--format=%s')).toBe('Merge feature/login into main');
    expect(r.body.overview.branches.find((b) => b.name === 'feature/login')?.merged).toBe(true);
    expect((await post('merge', { source: 'feature/login' })).body.message).toMatch(/already has/);

    r = await post('branches/delete', { name: 'feature/login' });
    expect(r.status).toBe(200);
    expect(r.body.overview.branches.map((b) => b.name)).toEqual(['main']);
    expect((await post('branches/delete', { name: 'main' })).status).toBe(409);
  });

  it('refuses conflicting merges without touching anything, and asks before deleting unmerged work', async () => {
    const dir = repo();
    sh(dir, 'switch', '-c', 'feature/a');
    writeTree(dir, { 'README.md': '# A\n' });
    sh(dir, 'commit', '-am', 'a');
    sh(dir, 'switch', 'main');
    writeTree(dir, { 'README.md': '# Main\n' });
    sh(dir, 'commit', '-am', 'main');
    const id = await project(dir);
    const before = sh(dir, 'rev-parse', 'main');
    const post = (path: string, body: unknown) =>
      req<GitActionResultDto>('POST', `/api/projects/${id}/git/${path}`, body);

    const m = await post('merge', { source: 'feature/a', target: 'main' });
    expect(m.status).toBe(409);
    expect(m.body.error).toMatchObject({ code: 'MERGE_CONFLICT' });
    expect(m.body.error!.message).toContain('README.md');
    expect(sh(dir, 'rev-parse', 'main')).toBe(before);
    expect(sh(dir, 'status', '--porcelain')).toBe('');

    const del = await post('branches/delete', { name: 'feature/a' });
    expect(del.body.error).toMatchObject({ code: 'BRANCH_UNMERGED' });
    expect((await post('branches/delete', { name: 'feature/a', force: true })).status).toBe(200);

    // The working branch can be any local branch.
    sh(dir, 'branch', 'develop');
    const w = await post('working-branch', { branch: 'develop' });
    expect(w.body.overview.workingBranch).toBe('develop');
    expect(
      (await req<{ workingBranch: string }>('GET', `/api/projects/${id}`)).body.workingBranch,
    ).toBe('develop');
    expect((await post('working-branch', { branch: 'nope' })).status).toBe(400);
  });

  it('fetches, pulls and pushes through a remote', async () => {
    const remote = tempDir('af-remote-');
    dirs.push(remote);
    sh(remote, 'init', '--bare', '--initial-branch=main');
    const dir = repo();
    sh(dir, 'remote', 'add', 'origin', remote);
    const id = await project(dir);
    const post = (path: string, body?: unknown) =>
      req<GitActionResultDto>('POST', `/api/projects/${id}/git/${path}`, body ?? {});

    expect((await post('pull')).body.error?.message).toMatch(/push it first/);
    let r = await post('push');
    expect(r.status).toBe(200);
    expect(r.body.overview.upstream).toEqual({ name: 'origin/main', ahead: 0, behind: 0 });
    expect(r.body.overview.remotes).toEqual([{ name: 'origin', url: remote }]);

    // Someone else pushes a commit.
    const other = tempDir('af-clone-');
    dirs.push(other);
    execFileSync('git', ['clone', remote, other]);
    writeTree(other, { 'CHANGELOG.md': 'v2\n' });
    sh(other, 'add', '-A');
    sh(other, 'commit', '-m', 'changelog');
    sh(other, 'push', 'origin', 'main');

    r = await post('fetch');
    expect(r.body.overview.upstream).toMatchObject({ behind: 1 });
    expect(
      r.body.overview.branches.some((b) => b.name === 'origin/main' && b.kind === 'remote'),
    ).toBe(true);
    r = await post('pull');
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Pulled origin/main into main');
    expect(r.body.overview.upstream).toMatchObject({ behind: 0 });

    // Remote-only branches can be checked out as tracking branches.
    sh(other, 'switch', '-c', 'feature/remote');
    sh(other, 'push', 'origin', 'feature/remote');
    await post('fetch');
    r = await post('checkout', { branch: 'origin/feature/remote' });
    expect(r.body.message).toBe('Switched to feature/remote (tracking origin/feature/remote)');
    expect(r.body.overview.current).toBe('feature/remote');
  });

  it('makes the first commit of an empty repository without dependencies or secrets', async () => {
    const dir = repo();
    const empty = tempDir('af-empty-');
    dirs.push(empty);
    const id = await project(dir);
    // Point the project at a repo that has no commits yet.
    sh(empty, 'init', '--initial-branch=main');
    writeTree(empty, {
      'index.js': 'console.log(1)',
      'node_modules/x/index.js': 'x',
      '.env': 'SECRET=1',
    });
    t.ctx.projects.setBranches(id, { workingBranch: 'main' });
    t.ctx.db.update(projects).set({ localPath: empty }).where(eq(projects.id, id)).run();
    let o = await overview(id);
    expect(o).toMatchObject({ isRepo: true, current: 'main', branches: [] });
    const r = await req<GitActionResultDto>('POST', `/api/projects/${id}/git/commit`, {
      message: 'first',
    });
    expect(r.status).toBe(200);
    expect(sh(empty, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'index.js']);
    o = r.body.overview;
    expect(o.branches.map((b) => b.name)).toEqual(['main']);
    expect(o.changes).toEqual([]);
  });

  it('initialises git again when the repository was removed', async () => {
    const dir = tempDir('af-nogit-');
    writeTree(dir, { 'index.html': '<h1>hi</h1>', '.env': 'SECRET=1' });
    const id = await project(dir, true);
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    expect((await overview(id)).isRepo).toBe(false);
    expect((await req('POST', `/api/projects/${id}/git/branches`, { name: 'x' })).status).toBe(400);
    const r = await req<GitActionResultDto>('POST', `/api/projects/${id}/git/init`);
    expect(r.status).toBe(200);
    expect(r.body.overview).toMatchObject({ isRepo: true, current: 'main', workingBranch: 'main' });
    expect(sh(dir, 'ls-files')).not.toContain('.env');
    expect((await req('POST', `/api/projects/${id}/git/init`)).status).toBe(409);
  });
});
