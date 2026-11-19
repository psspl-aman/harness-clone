import type { DiffFileDto, TaskDiffDto } from '@agentforge/shared';
import { execa } from 'execa';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { identityConfig, SECRET_FILE_RE } from '../git';

const MAX_PATCH = 400_000;

/** Run git; throws with stderr on failure unless `allowFail`. */
async function git(
  cwd: string,
  args: string[],
  opts: { allowFail?: boolean; env?: Record<string, string> } = {},
) {
  const r = await execa('git', args, {
    cwd,
    reject: false,
    env: { GIT_TERMINAL_PROMPT: '0', ...opts.env },
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.exitCode !== 0 && !opts.allowFail) {
    throw new Error(
      `git ${args[0]} failed: ${String(r.stderr || r.stdout)
        .trim()
        .split('\n')
        .slice(-3)
        .join(' ')}`,
    );
  }
  return { code: r.exitCode ?? 1, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}

const identityArgs = async (dir: string) => (await identityConfig(dir)).flatMap((c) => ['-c', c]);

export const slugBranch = (key: string, title: string) =>
  `af/${key.toLowerCase()}-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)}`.replace(/-$/, '');

export async function revParse(dir: string, ref: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    allowFail: true,
  });
  return r.code === 0 ? r.out.trim() : null;
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await revParse(repo, `refs/heads/${branch}`)) !== null;
}

/**
 * Create (or reuse after a restart) the task worktree on its own branch.
 * Returns the commit the branch started from.
 */
export async function ensureWorktree(
  repo: string,
  path: string,
  branch: string,
  base: string,
): Promise<{ baseCommit: string; created: boolean }> {
  const baseCommit = await revParse(repo, base);
  if (!baseCommit) throw new Error(`Base branch ${base} not found`);
  if (existsSync(path) && (await revParse(path, 'HEAD'))) return { baseCommit, created: false };
  await git(repo, ['worktree', 'prune']);
  mkdirSync(dirname(path), { recursive: true });
  if (await branchExists(repo, branch)) await git(repo, ['worktree', 'add', path, branch]);
  else await git(repo, ['worktree', 'add', '-b', branch, path, base]);
  return { baseCommit, created: true };
}

/** Merge branches that aren't in the worktree yet (e.g. unmerged dependency PR branches). */
export async function mergeBranchesInto(worktree: string, branches: string[]): Promise<void> {
  for (const b of branches) {
    const merged = await git(worktree, ['merge-base', '--is-ancestor', b, 'HEAD'], {
      allowFail: true,
    });
    if (merged.code === 0) continue;
    const r = await git(
      worktree,
      [...(await identityArgs(worktree)), 'merge', '--no-edit', '--no-ff', b],
      { allowFail: true },
    );
    if (r.code !== 0) {
      await git(worktree, ['merge', '--abort'], { allowFail: true });
      throw new Error(`Could not merge dependency branch ${b} into the task branch`);
    }
  }
}

/** Stage everything, never secrets, and commit. Returns the new commit or null when nothing changed. */
export async function commitAll(
  worktree: string,
  message: string,
): Promise<{ commit: string | null; files: string[]; skippedSecrets: string[] }> {
  await git(worktree, ['add', '-A']);
  const staged = (await git(worktree, ['diff', '--cached', '--name-only'])).out
    .split('\n')
    .filter(Boolean);
  const secrets = staged.filter((f) => SECRET_FILE_RE.test(f));
  if (secrets.length) await git(worktree, ['rm', '--cached', '--quiet', '--', ...secrets]);
  const files = staged.filter((f) => !secrets.includes(f));
  if (!files.length) return { commit: null, files: [], skippedSecrets: secrets };
  await git(worktree, [...(await identityArgs(worktree)), 'commit', '--no-verify', '-m', message]);
  return { commit: await revParse(worktree, 'HEAD'), files, skippedSecrets: secrets };
}

export async function diff(dir: string, from: string, to = 'HEAD'): Promise<TaskDiffDto> {
  const numstat = (await git(dir, ['diff', '--numstat', '-M', from, to])).out;
  const status = (await git(dir, ['diff', '--name-status', '-M', from, to])).out;
  const statusByPath = new Map<string, DiffFileDto['status']>();
  for (const line of status.split('\n').filter(Boolean)) {
    const [code, ...paths] = line.split('\t');
    const path = paths.at(-1)!;
    statusByPath.set(
      path,
      code!.startsWith('A')
        ? 'added'
        : code!.startsWith('D')
          ? 'deleted'
          : code!.startsWith('R')
            ? 'renamed'
            : 'modified',
    );
  }
  const files: DiffFileDto[] = numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [add, del, ...rest] = line.split('\t');
      const raw = rest.join('\t');
      // Renames appear as "old => new" or "dir/{a => b}/f".
      const path = raw.includes('=>')
        ? raw.replace(/\{[^}]*=> ([^}]*)\}/, '$1').replace(/^.* => /, '')
        : raw;
      return {
        path,
        status: statusByPath.get(path) ?? 'modified',
        additions: Number(add) || 0,
        deletions: Number(del) || 0,
      };
    });
  const patch = (await git(dir, ['diff', '-M', from, to])).out;
  return {
    base: from,
    head: await revParse(dir, to),
    files,
    patch: patch.slice(0, MAX_PATCH),
    truncated: patch.length > MAX_PATCH,
  };
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  if (existsSync(path))
    await git(repo, ['worktree', 'remove', '--force', path], { allowFail: true });
  await git(repo, ['worktree', 'prune'], { allowFail: true });
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ['branch', '-D', branch], { allowFail: true });
}

/** Path of the worktree that has `branch` checked out, if any. */
async function checkoutOf(repo: string, branch: string): Promise<string | null> {
  const out = (await git(repo, ['worktree', 'list', '--porcelain'])).out;
  let path: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

export type MergeOutcome =
  | { status: 'merged'; commit: string }
  | { status: 'conflict'; files: string[] }
  | { status: 'dirty'; path: string };

/**
 * Merge the task branch into the working branch without disturbing the
 * user: if the working branch is checked out it must be clean (then a normal
 * --no-ff merge runs there); otherwise the merge is computed with
 * `git merge-tree` and the branch ref is advanced directly.
 */
export async function mergeIntoWorking(
  repo: string,
  branch: string,
  working: string,
  message: string,
): Promise<MergeOutcome> {
  const checkout = await checkoutOf(repo, working);
  if (checkout) {
    const dirty = (
      await git(checkout, ['status', '--porcelain', '--untracked-files=normal'])
    ).out.trim();
    if (dirty) return { status: 'dirty', path: checkout };
    const r = await git(
      checkout,
      [...(await identityArgs(checkout)), 'merge', '--no-ff', '--no-edit', '-m', message, branch],
      { allowFail: true },
    );
    if (r.code !== 0) {
      const files = (
        await git(checkout, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })
      ).out
        .split('\n')
        .filter(Boolean);
      await git(checkout, ['merge', '--abort'], { allowFail: true });
      return { status: 'conflict', files };
    }
    return { status: 'merged', commit: (await revParse(checkout, 'HEAD'))! };
  }
  const old = await revParse(repo, `refs/heads/${working}`);
  if (!old) throw new Error(`Working branch ${working} not found`);
  const mt = await git(repo, ['merge-tree', '--write-tree', '--name-only', working, branch], {
    allowFail: true,
  });
  const [tree, ...rest] = mt.out.split('\n');
  if (mt.code === 1) {
    // Conflicted paths are listed until the first blank line; messages follow.
    const end = rest.indexOf('');
    return {
      status: 'conflict',
      files: [...new Set(rest.slice(0, end < 0 ? undefined : end))].slice(0, 50),
    };
  }
  if (mt.code !== 0) throw new Error(`git merge-tree failed: ${mt.err.trim()}`);
  const head = (await revParse(repo, `refs/heads/${branch}`))!;
  const commit = (
    await git(repo, [
      ...(await identityArgs(repo)),
      'commit-tree',
      tree!.trim(),
      '-p',
      old,
      '-p',
      head,
      '-m',
      message,
    ])
  ).out.trim();
  await git(repo, ['update-ref', `refs/heads/${working}`, commit, old]);
  return { status: 'merged', commit };
}

export async function isAncestor(repo: string, ancestor: string, of: string): Promise<boolean> {
  return (
    (await git(repo, ['merge-base', '--is-ancestor', ancestor, of], { allowFail: true })).code === 0
  );
}

export async function mergeBase(dir: string, a: string, b: string): Promise<string | null> {
  const r = await git(dir, ['merge-base', a, b], { allowFail: true });
  return r.code === 0 ? r.out.trim() : null;
}
