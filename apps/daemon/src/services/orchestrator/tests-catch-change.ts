import type { TaskType } from '@agentforge/shared';
import * as gitops from './git-ops';
import { runCheck, type CheckOptions, type VerifyStep } from './verify';

/**
 * Fail-before check: do the tests notice when the task's change is missing?
 *
 * The task's source files are put back to how they were at the task's base commit
 * (test files, dependency manifests and test-runner config stay as they are), the
 * project's test command runs, and every file is put back. Passing tests at that
 * point mean nothing in the suite checks the change. The outcome is for the whole
 * suite, not per test, so it works with any test runner.
 */

/** Task types whose change must alter behaviour, so tests should fail without it. */
const CHECKED_TYPES: ReadonlySet<TaskType> = new Set(['feature', 'bug']);

const TEST_PATH_RE = new RegExp(
  [
    String.raw`(^|/)(__tests__|__snapshots__|__mocks__|tests?|spec|specs|e2e|cypress)/`,
    String.raw`\.(test|spec|e2e|cy)\.[^/]+$`,
    String.raw`(^|/)test_[^/]+\.py$`,
    String.raw`_test\.(go|py|rb|exs?)$`,
    String.raw`_spec\.rb$`,
    String.raw`(Test|Tests|Spec|IT)\.(java|kt|cs|scala|swift|php)$`,
  ].join('|'),
);

/** Kept as-is: reverting these would break installing or running the tests, not the feature. */
const KEPT_PATH_RE = new RegExp(
  [
    String.raw`(^|/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.npmrc)$`,
    String.raw`(^|/)(requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|setup\.(py|cfg)|tox\.ini|pytest\.ini|conftest\.py)$`,
    String.raw`(^|/)(go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$`,
    String.raw`(^|/)(tsconfig[^/]*\.json|(jest|vitest|playwright|cypress|karma|babel)\.config\.[^/]+|\.mocharc[^/]*|\.babelrc)$`,
  ].join('|'),
);

export const isTestPath = (path: string) => TEST_PATH_RE.test(path);
const isKeptPath = (path: string) => KEPT_PATH_RE.test(path);

export type TestsCatchChangeResult =
  /** Not run; `reason` says why (shown in the test log). */
  | { kind: 'skipped'; reason: string }
  /** The tests failed without the change: they test it. */
  | { kind: 'caught'; reverted: string[]; step: VerifyStep }
  /** The tests passed without the change: they don't test it. */
  | { kind: 'missed'; reverted: string[]; step: VerifyStep }
  /** The run timed out or ended without an exit code, so there is no verdict. */
  | { kind: 'inconclusive'; reverted: string[]; step: VerifyStep };

export interface TestsCatchChangeInput {
  worktree: string;
  /** Commit the task branch started from. */
  baseCommit: string | null | undefined;
  testCommand: string | null | undefined;
  taskType: TaskType;
}

export async function checkTestsCatchChange(
  input: TestsCatchChangeInput,
  opts: CheckOptions = {},
): Promise<TestsCatchChangeResult> {
  const command = input.testCommand?.trim();
  if (!CHECKED_TYPES.has(input.taskType))
    return { kind: 'skipped', reason: `not needed for ${input.taskType} tasks` };
  if (!command) return { kind: 'skipped', reason: 'no Test command is configured' };
  if (!input.baseCommit) return { kind: 'skipped', reason: 'the task has no base commit' };
  if (!(await gitops.isClean(input.worktree)))
    return { kind: 'skipped', reason: 'the worktree has uncommitted changes' };

  const changed = await gitops.changedPaths(input.worktree, input.baseCommit);
  const reverted = changed.map((c) => c.path).filter((p) => !isTestPath(p) && !isKeptPath(p));
  if (!reverted.length)
    return { kind: 'skipped', reason: 'the task changed only tests and configuration' };

  await gitops.setPathsTo(input.worktree, input.baseCommit, reverted);
  let step: VerifyStep;
  try {
    step = await runCheck(input.worktree, 'test', command, opts);
  } finally {
    // Always put the task's files back, even if the run was aborted or threw.
    await gitops.setPathsTo(input.worktree, 'HEAD', reverted);
  }
  if (!(await gitops.isClean(input.worktree)))
    throw new Error('Could not restore the worktree after the fail-before check');
  if (step.timedOut || step.exitCode === null) return { kind: 'inconclusive', reverted, step };
  return { kind: step.exitCode === 0 ? 'missed' : 'caught', reverted, step };
}

/** The test-log section describing a check result. */
export function formatTestsCatchChange(r: TestsCatchChangeResult): string {
  const title = '## Fail-before check';
  if (r.kind === 'skipped') return `${title}\nSkipped: ${r.reason}.`;
  const files = r.reverted
    .slice(0, 30)
    .map((f) => `- ${f}`)
    .join('\n');
  const more = r.reverted.length > 30 ? `\n- … and ${r.reverted.length - 30} more` : '';
  const verdict =
    r.kind === 'caught'
      ? 'Passed: the tests fail without the change, so they test it.'
      : r.kind === 'missed'
        ? 'Failed: the tests still pass without the change, so they do not test it.'
        : `Inconclusive: the test command ${r.step.timedOut ? 'timed out' : 'ended without an exit code'}.`;
  return `${title}\n${verdict}\n\nSource files put back to the base commit for this run:\n${files}${more}\n\n$ ${r.step.command}\n(exit ${r.step.exitCode ?? '?'}${r.step.timedOut ? ', timed out' : ''}, ${Math.round(r.step.durationMs / 1000)}s)\n${r.step.output.trim()}`;
}
