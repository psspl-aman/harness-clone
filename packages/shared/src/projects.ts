import { z } from 'zod';
import { RoleEnginesSchema } from './settings';
import { ProjectSummarySchema, Timestamp } from './entities';

// ─── Directory browser ───────────────────────────────────────────────────────

export interface FsEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  hidden: boolean;
}

export interface FsBrowseResult {
  path: string;
  parent: string | null;
  home: string;
  writable: boolean;
  isGitRepo: boolean;
  /** Sub-directories only (files are never listed). */
  entries: FsEntry[];
  /** Number of non-directory items, so the UI can show "empty" vs "has files". */
  fileCount: number;
  truncated: boolean;
}

export const PATH_CHECK_MODES = ['scratch', 'existing'] as const;
export type PathCheckMode = (typeof PATH_CHECK_MODES)[number];

export interface PathCheckResult {
  path: string;
  ok: boolean;
  exists: boolean;
  isDirectory: boolean;
  empty: boolean;
  writable: boolean;
  isGitRepo: boolean;
  /** Human-readable reason when `ok` is false. */
  reason: string | null;
  /** Non-blocking notes (e.g. "not a git repository"). */
  warnings: string[];
  existingProjectId: string | null;
}

// ─── Project creation ────────────────────────────────────────────────────────

const name = z.string().trim().min(1, 'Name is required').max(80);
const absPath = z
  .string()
  .trim()
  .min(1)
  .refine((p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p), 'Must be an absolute path');
const folderName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore')
  .refine((n) => n !== '.' && n !== '..', 'Invalid folder name');
export const RepoFullNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'Expected owner/repo');
const repoName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore');

export const ScratchLocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), parentDir: absPath, folderName }),
  z.object({
    kind: z.literal('github'),
    repo: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('create'),
        /** User login or organisation. */
        owner: z.string().trim().min(1),
        name: repoName,
        private: z.boolean(),
        description: z.string().max(350).optional(),
      }),
      z.object({ action: z.literal('existing'), fullName: RepoFullNameSchema }),
    ]),
  }),
]);

export const ExistingLocationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    path: absPath,
    /** Initialise git (with secret-safe .gitignore) when the folder isn't a repo. */
    initGit: z.boolean().default(true),
  }),
  z.object({ kind: z.literal('github'), fullName: RepoFullNameSchema }),
]);

export const CreateProjectInputSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('scratch'),
    name,
    description: z.string().max(2000).optional(),
    location: ScratchLocationSchema,
    stackPreferences: z.string().max(4000).optional(),
    roleEngines: RoleEnginesSchema.partial().optional(),
    initialRequirement: z.string().max(50_000).optional(),
  }),
  z.object({
    mode: z.literal('existing'),
    name: name.optional(),
    description: z.string().max(2000).optional(),
    location: ExistingLocationSchema,
    roleEngines: RoleEnginesSchema.partial().optional(),
  }),
]);
export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>;

// ─── Onboarding analysis ─────────────────────────────────────────────────────

export const ProjectCommandsSchema = z.object({
  install: z.string().max(500).nullable().optional(),
  run: z.string().max(500).nullable().optional(),
  build: z.string().max(500).nullable().optional(),
  test: z.string().max(500).nullable().optional(),
  lint: z.string().max(500).nullable().optional(),
});
export type ProjectCommandsDto = z.infer<typeof ProjectCommandsSchema>;
export const COMMAND_KEYS = ['install', 'run', 'build', 'test', 'lint'] as const;

export interface DetectedCommand {
  command: string;
  /** Where it came from, e.g. "package.json scripts.dev". */
  source: string;
}

export interface OnboardingReport {
  analyzedAt: number;
  durationMs: number;
  languages: { name: string; files: number; share: number }[];
  frameworks: string[];
  packageManagers: string[];
  monorepo: { tool: string; packages: string[] } | null;
  commands: Partial<Record<(typeof COMMAND_KEYS)[number], DetectedCommand>>;
  /** Indented directory outline (depth-limited, noisy dirs skipped). */
  structure: string;
  /** File names only — values are never read. */
  envFiles: string[];
  conventions: string[];
  git: {
    isRepo: boolean;
    branch: string | null;
    remote: string | null;
    dirty: boolean | null;
    lastCommit: { hash: string; message: string; date: string } | null;
  };
  stats: { files: number; dirs: number; truncated: boolean };
  notes: string[];
}

// ─── Project detail ──────────────────────────────────────────────────────────

export const ONBOARDING_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const ProjectDetailSchema = ProjectSummarySchema.extend({
  description: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  workingBranch: z.string().nullable(),
  stackPreferences: z.string().nullable(),
  commands: ProjectCommandsSchema,
  onboardingStatus: z.enum(ONBOARDING_STATUSES),
  onboardingError: z.string().nullable(),
  onboardedAt: Timestamp.nullable(),
  roleEngines: RoleEnginesSchema.partial(),
  pipeline: z.object({
    maxConcurrentTasks: z.number().nullable(),
    maxFixLoops: z.number().nullable(),
    requireHumanReview: z.boolean().nullable(),
    mergeStrategy: z.enum(['merge', 'pull_request']).nullable(),
    fallbackEnabled: z.boolean(),
    engineFallback: z.record(z.string(), z.string()),
    paused: z.boolean(),
  }),
  /** Full analysis; typed as OnboardingReport on the client. */
  onboardingReport: z.custom<OnboardingReport>().nullable(),
});
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

export const UpdateProjectInputSchema = z
  .object({
    name: name.optional(),
    description: z.string().max(2000).nullable().optional(),
    stackPreferences: z.string().max(4000).nullable().optional(),
    commands: ProjectCommandsSchema.optional(),
    roleEngines: RoleEnginesSchema.partial().optional(),
    /** Per-project overrides; null clears an override (back to the global setting). */
    pipeline: z
      .object({
        maxConcurrentTasks: z.number().int().min(1).max(16).nullable(),
        maxFixLoops: z.number().int().min(0).max(10).nullable(),
        requireHumanReview: z.boolean().nullable(),
        mergeStrategy: z.enum(['merge', 'pull_request']).nullable(),
        fallbackEnabled: z.boolean(),
        engineFallback: z.record(z.string().max(80), z.string().max(80)),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;

export interface RequirementDto {
  id: string;
  projectId: string;
  author: 'user' | 'planner' | 'system';
  content: string;
  intent: string | null;
  version: number;
  createdAt: number;
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

export interface GithubStatus {
  connected: boolean;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
  scopes: string[];
  source: 'token' | 'gh-cli' | null;
  /** Whether the `gh` CLI is installed and logged in (offers one-click import). */
  ghCliAvailable: boolean;
}

export const GithubConnectInputSchema = z.object({
  token: z.string().trim().min(20, 'That does not look like a GitHub token').max(400),
});

export interface GithubRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  updatedAt: string | null;
  htmlUrl: string;
}

export interface GithubOwner {
  login: string;
  type: 'user' | 'org';
  avatarUrl: string | null;
}
