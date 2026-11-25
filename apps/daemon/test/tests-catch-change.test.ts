import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filterPatch } from '../src/services/orchestrator/git-ops';
import {
  checkTestsCatchChange,
  formatTestsCatchChange,
  isTestPath,
} from '../src/services/orchestrator/tests-catch-change';
import { GIT_ID, tempDir, writeTree } from './helpers';

let repo: string;
let base: string;

const git = (...args: string[]) =>
  execFileSync('git', [...GIT_ID, ...args], { cwd: repo, encoding: 'utf8' }).trim();
const commit = (files: Record<string, string>, msg: string) => {
  writeTree(repo, files);
  git('add', '-A');
  git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
};

// The "feature": greet.txt must say hello. The test checks it; the weak test checks nothing.
const STRONG = 'grep -q hello src/greet.txt';
const WEAK = 'test -d src';

beforeEach(() => {
  repo = tempDir('af-tcc-');
  git('init', '-q', '-b', 'main');
  base = commit({ 'src/greet.txt': 'todo\n', 'package.json': '{"v":1}\n' }, 'base');
  // The task: implement the feature, add a new module, bump a dependency, add a test.
  commit(
    {
      'src/greet.txt': 'hello\n',
      'src/new.txt': 'new module\n',
      'package.json': '{"v":2}\n',
      'test/greet.test.sh': STRONG,
    },
    'task',
  );
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const run = (testCommand: string | null, taskType: 'feature' | 'refactor' = 'feature') =>
  checkTestsCatchChange({ worktree: repo, baseCommit: base, testCommand, taskType });

describe('fail-before check', () => {
  it('passes when the tests fail without the change, and restores every file', async () => {
    const r = await run(STRONG);
    expect(r.kind).toBe('caught');
    // Source files were reverted; tests and manifests were not.
    expect(r.kind !== 'skipped' && r.reverted.sort()).toEqual(['src/greet.txt', 'src/new.txt']);
    expect(readFileSync(join(repo, 'src/greet.txt'), 'utf8')).toBe('hello\n');
    expect(existsSync(join(repo, 'src/new.txt'))).toBe(true);
    expect(git('status', '--porcelain')).toBe('');
    expect(formatTestsCatchChange(r)).toMatch(/^## Fail-before check\nPassed:/);
  });

  it('fails when the tests still pass without the change', async () => {
    const r = await run(WEAK);
    expect(r.kind).toBe('missed');
    expect(formatTestsCatchChange(r)).toContain('so they do not test it');
    expect(git('status', '--porcelain')).toBe('');
  });

  it('keeps dependency manifests while the tests run without the change', async () => {
    expect((await run('grep -q 2 package.json && grep -q hello src/greet.txt')).kind).toBe(
      'caught',
    );
    // package.json kept its new version, so only the feature made the tests fail.
    expect((await run('grep -q 2 package.json')).kind).toBe('missed');
  });

  it('is skipped when it cannot or should not run', async () => {
    expect(await run(STRONG, 'refactor')).toEqual({
      kind: 'skipped',
      reason: 'not needed for refactor tasks',
    });
    expect(await run(null)).toMatchObject({ kind: 'skipped', reason: /no Test command/ });
    writeTree(repo, { 'src/greet.txt': 'uncommitted\n' });
    expect(await run(STRONG)).toMatchObject({ kind: 'skipped', reason: /uncommitted/ });
    git('checkout', '--', '.');
    // A task that only touched tests has no change to take away.
    const testsOnly = git('rev-parse', 'HEAD');
    commit({ 'test/more.test.sh': 'true' }, 'tests only');
    expect(
      await checkTestsCatchChange({
        worktree: repo,
        baseCommit: testsOnly,
        testCommand: STRONG,
        taskType: 'feature',
      }),
    ).toMatchObject({ kind: 'skipped', reason: /only tests/ });
  });

  it('puts the files back even when the test command is aborted', async () => {
    const ac = new AbortController();
    const pending = checkTestsCatchChange(
      { worktree: repo, baseCommit: base, testCommand: 'sleep 1', taskType: 'feature' },
      { signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 200);
    await pending;
    expect(readFileSync(join(repo, 'src/greet.txt'), 'utf8')).toBe('hello\n');
    expect(git('status', '--porcelain')).toBe('');
  });

  it('is inconclusive when the test command is aborted before it can exit', async () => {
    const testCommand = `"${process.execPath}" -e "setTimeout(() => {}, 1000)"`;
    const result = await checkTestsCatchChange(
      { worktree: repo, baseCommit: base, testCommand, taskType: 'feature' },
      { signal: AbortSignal.abort() },
    );

    expect(result).toMatchObject({ kind: 'inconclusive', step: { exitCode: null } });
    expect(formatTestsCatchChange(result)).toContain('test command ended without an exit code');
    expect(git('status', '--porcelain')).toBe('');
  });
});

describe('test file detection', () => {
  it.each([
    'src/a.test.ts',
    'src/a.spec.tsx',
    'test/helpers.ts',
    'tests/fixtures/data.json',
    'pkg/__tests__/x.js',
    'app/__snapshots__/x.snap',
    'e2e/login.ts',
    'tests/test_api.py',
    'api/test_api.py',
    'server/handler_test.go',
    'spec/models/user_spec.rb',
    'src/main/java/AppTest.java',
  ])('treats %s as a test', (p) => expect(isTestPath(p)).toBe(true));

  it.each(['src/app.ts', 'src/testing-utils.ts', 'src/latest.ts', 'docs/test-plan.md'])(
    'treats %s as source',
    (p) => expect(isTestPath(p)).toBe(false),
  );

  it('filters a patch down to the matching files', () => {
    const patch =
      'diff --git a/src/a.ts b/src/a.ts\n+a\ndiff --git a/src/a.test.ts b/src/a.test.ts\n+t\n';
    expect(filterPatch(patch, isTestPath)).toBe('diff --git a/src/a.test.ts b/src/a.test.ts\n+t\n');
  });
});
