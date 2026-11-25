import { z } from 'zod';
import type { TaskStatus } from './enums';
import type { TaskDiffDto } from './pipeline';

// ─── Git: branches, history and the work done on each branch ────────────────

/** A task that touched git, and where its work lives now. */
export interface GitTaskRefDto {
  id: string;
  key: string;
  title: string;
  status: TaskStatus;
  /** The task's own branch (deleted once it has been merged). */
  branchName: string | null;
  /** The branch it started from / merges into. */
  baseBranch: string | null;
  mergedInto: string | null;
  mergeCommit: string | null;
  pullRequestUrl: string | null;
  /**
   * merged: work is in `mergedInto` · pull_request: waiting in a PR ·
   * in_progress: still on its own branch · cancelled: stopped, branch kept · done: finished without a merge.
   */
  state: 'merged' | 'pull_request' | 'in_progress' | 'cancelled' | 'done';
  completedAt: number | null;
  updatedAt: number;
}

export interface GitBranchDto {
  /** Short name: "main", "feature/x", or "origin/feature/x" for remote branches. */
  name: string;
  kind: 'local' | 'remote';
  head: string;
  subject: string;
  author: string;
  /** Last commit time (ms). */
  date: number;
  /** Tracking branch and how far this branch is ahead/behind it. */
  upstream: string | null;
  upstreamAhead: number | null;
  upstreamBehind: number | null;
  upstreamGone: boolean;
  /** Commits only on this branch / only on the working branch. */
  ahead: number | null;
  behind: number | null;
  /** Everything on this branch is already in the working branch. */
  merged: boolean;
  /** Checked out in the project folder. */
  current: boolean;
  /** Agents merge finished tasks here. */
  working: boolean;
  default: boolean;
  /** Folder where it's checked out, when that isn't the project folder (agent worktrees). */
  worktree: string | null;
  /** Remote branches: a local branch with the same name exists. */
  hasLocal: boolean;
  tasks: GitTaskRefDto[];
}

export const GIT_CHANGE_KINDS = [
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked',
  'conflicted',
] as const;
export type GitChangeKind = (typeof GIT_CHANGE_KINDS)[number];

export interface GitChangeDto {
  path: string;
  from: string | null;
  kind: GitChangeKind;
  staged: boolean;
}

/** All the tasks whose work went into (or is heading for) one branch. */
export interface GitWorkGroupDto {
  branch: string;
  exists: boolean;
  tasks: GitTaskRefDto[];
}

export interface GitOverviewDto {
  projectId: string;
  isRepo: boolean;
  localPath: string;
  /** Checked-out branch in the project folder; null when detached or not a repo. */
  current: string | null;
  detachedAt: string | null;
  workingBranch: string | null;
  defaultBranch: string | null;
  /** Remote URLs with any credentials removed. */
  remotes: { name: string; url: string }[];
  /** Upstream of the current branch. */
  upstream: { name: string; ahead: number; behind: number } | null;
  /** A merge/rebase/cherry-pick left half-way in the project folder. */
  operation: 'merge' | 'rebase' | 'cherry-pick' | null;
  changes: GitChangeDto[];
  changesTruncated: boolean;
  branches: GitBranchDto[];
  /** Older remote branches left out of `branches` (very large repos). */
  hiddenRemoteBranches: number;
  work: GitWorkGroupDto[];
  /** GitHub repo linked to the project (enables pull requests). */
  githubRepo: string | null;
}

export interface GitCommitDto {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: number;
  isMerge: boolean;
  /** The task this commit belongs to, recognised from its message. */
  task: { id: string; key: string; title: string } | null;
}

export interface GitBranchDetailDto {
  branch: string;
  /** What it's compared with (null = plain history). */
  base: string | null;
  commits: GitCommitDto[];
  commitsTruncated: boolean;
  /** Changes since it split off `base`. */
  diff: TaskDiffDto | null;
  tasks: GitTaskRefDto[];
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

const branchName = z
  .string()
  .trim()
  .min(1, 'Branch name is required')
  .max(120)
  .regex(/^[^\s~^:?*[\\]+$/, 'No spaces or ~ ^ : ? * [ \\ in branch names')
  .refine(
    (n) =>
      !n.startsWith('-') &&
      !n.startsWith('/') &&
      !n.endsWith('/') &&
      !n.endsWith('.') &&
      !n.endsWith('.lock') &&
      !n.includes('..') &&
      !n.includes('//') &&
      !n.includes('@{') &&
      n !== 'HEAD',
    'That isn’t a valid branch name',
  );
export const GitBranchNameSchema = branchName;

export const GitCreateBranchInputSchema = z.object({
  name: branchName,
  /** Start point (branch or commit); defaults to the working branch. */
  from: z.string().trim().min(1).max(200).optional(),
  checkout: z.boolean().default(false),
});
export type GitCreateBranchInput = z.input<typeof GitCreateBranchInputSchema>;

export const GitCheckoutInputSchema = z.object({ branch: z.string().trim().min(1).max(200) });
export type GitCheckoutInput = z.infer<typeof GitCheckoutInputSchema>;

export const GitMergeInputSchema = z.object({
  source: z.string().trim().min(1).max(200),
  /** Defaults to the working branch. */
  target: z.string().trim().min(1).max(200).optional(),
});
export type GitMergeInput = z.infer<typeof GitMergeInputSchema>;

export const GitDeleteBranchInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** Delete even when it has commits that aren't merged anywhere. */
  force: z.boolean().default(false),
});
export type GitDeleteBranchInput = z.input<typeof GitDeleteBranchInputSchema>;

export const GitWorkingBranchInputSchema = z.object({ branch: z.string().trim().min(1).max(200) });

export const GitCommitInputSchema = z.object({
  message: z.string().trim().min(1, 'Write a commit message').max(5000),
});

export const GitPushInputSchema = z.object({
  branch: z.string().trim().min(1).max(200).optional(),
});

export const GitPullRequestInputSchema = z.object({
  branch: z.string().trim().min(1).max(200),
  /** Defaults to the working branch. */
  base: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(250).optional(),
  body: z.string().max(20_000).optional(),
});
export type GitPullRequestInput = z.input<typeof GitPullRequestInputSchema>;

export interface GitActionResultDto {
  /** Human-readable outcome ("Merged feature/x into main"). */
  message: string;
  overview: GitOverviewDto;
  url?: string;
}
