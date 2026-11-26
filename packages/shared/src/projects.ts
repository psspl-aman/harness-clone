import { z } from 'zod';
import { EffortSchema, RoleEnginesSchema, RoleModelsSchema, RoutingSchema } from './settings';
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

/** `GET /api/fs/roots` — what the daemon's filesystem looks like, for the folder picker. */
export interface FsRoots {
  platform: 'win32' | 'posix';
  /** Path separator on the daemon's OS (`\` or `/`). */
  sep: '\\' | '/';
  home: string;
  /** Drive roots (`C:\`, `D:\`) on Windows; `['/']` on POSIX. */
  drives: string[];
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
    roleModels: RoleModelsSchema.optional(),
    effort: EffortSchema.nullable().optional(),
    initialRequirement: z.string().max(50_000).optional(),
    /** Files staged with POST /api/attachments/staged, attached to the initial requirement. */
    initialAttachmentIds: z
      .array(z.string().regex(/^stg_[a-z0-9]+$/, 'Invalid upload id'))
      .max(10, 'Attach at most 10 files')
      .default([]),
  }),
  z.object({
    mode: z.literal('existing'),
    name: name.optional(),
    description: z.string().max(2000).optional(),
    location: ExistingLocationSchema,
    roleEngines: RoleEnginesSchema.partial().optional(),
    roleModels: RoleModelsSchema.optional(),
    effort: EffortSchema.nullable().optional(),
  }),
]);
export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>;

// ─── Onboarding analysis ─────────────────────────────────────────────────────

/**
 * One long-running process of the app (frontend, API, worker…). Projects with
 * several servers list them here; Run starts them all, each in its own terminal.
 */
export const ProjectServiceSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[\w .-]+$/, 'Letters, numbers, spaces, dots, dashes and underscores only'),
  command: z.string().trim().min(1).max(500),
  /** Folder relative to the project root ("" or omitted = the root). */
  cwd: z
    .string()
    .trim()
    .max(300)
    .refine((v) => !v.startsWith('/') && !v.split(/[\\/]/).includes('..'), {
      message: 'Must be a folder inside the project',
    })
    .nullable()
    .optional(),
  /** The port it listens on: checked before starting and passed as PORT. */
  port: z.number().int().min(1).max(65535).nullable().optional(),
});
export type ProjectServiceDto = z.infer<typeof ProjectServiceSchema>;

export const ProjectCommandsSchema = z.object({
  install: z.string().max(500).nullable().optional(),
  run: z.string().max(500).nullable().optional(),
  build: z.string().max(500).nullable().optional(),
  test: z.string().max(500).nullable().optional(),
  lint: z.string().max(500).nullable().optional(),
  /** When set (non-empty), Run starts these instead of the single run command. */
  services: z
    .array(ProjectServiceSchema)
    .max(8)
    .refine((s) => new Set(s.map((x) => x.name.toLowerCase())).size === s.length, {
      message: 'Service names must be unique',
    })
    .refine(
      (s) => {
        const ports = s.map((x) => x.port).filter((p): p is number => !!p);
        return new Set(ports).size === ports.length;
      },
      { message: 'Two services can’t use the same port' },
    )
    .nullable()
    .optional(),
});
export type ProjectCommandsDto = z.infer<typeof ProjectCommandsSchema>;
export const COMMAND_KEYS = ['install', 'run', 'build', 'test', 'lint'] as const;

/** What an agent proposes after reading the project (nothing is saved until you apply it). */
export interface CommandSuggestionDto {
  projectId: string;
  status: 'running' | 'done' | 'failed';
  engineId: string;
  runId: string | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  commands: Partial<Record<(typeof COMMAND_KEYS)[number], string | null>>;
  services: ProjectServiceDto[];
  /** Short explanation: prerequisites, env vars, how the pieces fit. */
  notes: string[];
}

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
  roleModels: RoleModelsSchema,
  /** Reasoning effort for agent runs; null → each CLI's default. */
  effort: EffortSchema.nullable(),
  pipeline: z.object({
    maxConcurrentTasks: z.number().nullable(),
    maxFixLoops: z.number().nullable(),
    requireHumanReview: z.boolean().nullable(),
    mergeStrategy: z.enum(['merge', 'pull_request']).nullable(),
    fallbackEnabled: z.boolean(),
    engineFallback: z.record(z.string(), z.string()),
    paused: z.boolean(),
    /** Complexity→pipeline routing override; null uses the global routing setting. */
    routing: RoutingSchema.nullable(),
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
    roleModels: RoleModelsSchema.optional(),
    effort: EffortSchema.nullable().optional(),
    /** Per-project overrides; null clears an override (back to the global setting). */
    pipeline: z
      .object({
        maxConcurrentTasks: z.number().int().min(1).max(16).nullable(),
        maxFixLoops: z.number().int().min(0).max(10).nullable(),
        requireHumanReview: z.boolean().nullable(),
        mergeStrategy: z.enum(['merge', 'pull_request']).nullable(),
        fallbackEnabled: z.boolean(),
        engineFallback: z.record(z.string().max(80), z.string().max(80)),
        /** null clears the override (back to the global routing setting). */
        routing: RoutingSchema.nullable(),
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
