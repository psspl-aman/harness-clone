import { z } from 'zod';
import { MCP_TRANSPORTS, TASK_STATUSES, type McpTransport, type TaskStatus } from './enums';

// ─── MCP servers ─────────────────────────────────────────────────────────────

/** An env var or HTTP header. Secret values are stored encrypted and never returned. */
export const KeyValueInputSchema = z.object({
  key: z.string().trim().min(1).max(200),
  /** Omit (or null) on update to keep the stored secret value. */
  value: z.string().max(8000).nullable().optional(),
  secret: z.boolean().default(false),
});
export type KeyValueInput = z.infer<typeof KeyValueInputSchema>;

export const McpServerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    transport: z.enum(MCP_TRANSPORTS),
    command: z.string().trim().max(500).nullable().optional(),
    args: z.array(z.string().max(1000)).max(50).default([]),
    env: z.array(KeyValueInputSchema).max(50).default([]),
    url: z.string().trim().max(1000).nullable().optional(),
    headers: z.array(KeyValueInputSchema).max(30).default([]),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.transport === 'stdio' && !v.command)
      ctx.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'A command is required for stdio servers',
      });
    if (v.transport !== 'stdio' && !/^https?:\/\//.test(v.url ?? ''))
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'An http(s) URL is required' });
  });
export type McpServerInput = z.input<typeof McpServerInputSchema>;

export interface KeyValueDto {
  key: string;
  secret: boolean;
  /** null for secrets (write-only). */
  value: string | null;
}

export interface McpToolDto {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerDto {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: KeyValueDto[];
  url: string | null;
  headers: KeyValueDto[];
  enabled: boolean;
  lastStatus: 'unknown' | 'ok' | 'error';
  lastError: string | null;
  tools: McpToolDto[];
  lastCheckedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ─── PMS connections ─────────────────────────────────────────────────────────

export const PMS_PROVIDERS = [
  'jira',
  'linear',
  'github',
  'asana',
  'clickup',
  'azure-devops',
  'trello',
  'custom',
] as const;
export type PmsProvider = (typeof PMS_PROVIDERS)[number];

/**
 * One PMS operation implemented by an MCP tool. `args` is a template: strings
 * may contain `{{var}}` placeholders; a string that is exactly `{{var}}` is
 * replaced by the raw value, and `{{var|number}}` converts it to a number.
 * Variables: project, owner, repo (from "owner/repo"), issueId, status, body,
 * limit, filters.assignee, filters.sprint, filters.labels, filters.status, and
 * transitionId (write-back only: the transition into `status` found by the
 * `transitions` operation, or the status name when there is none).
 */
export const PmsOperationSchema = z.object({
  tool: z.string().trim().min(1).max(200),
  args: z.record(z.string(), z.unknown()).default({}),
  /** Dot path to the issue array in the tool's JSON result (auto-detected when empty). */
  itemsPath: z.string().max(200).optional(),
});
export type PmsOperation = z.infer<typeof PmsOperationSchema>;

export const PMS_FIELDS = [
  'id',
  'title',
  'description',
  'status',
  'url',
  'updatedAt',
  'labels',
  'assignee',
] as const;
export type PmsField = (typeof PMS_FIELDS)[number];

export const PmsToolMapSchema = z.object({
  list: PmsOperationSchema.optional(),
  get: PmsOperationSchema.optional(),
  updateStatus: PmsOperationSchema.optional(),
  /**
   * Lists the transitions available on an issue (Jira-style workflows), so
   * write-back can move a ticket by status name: `{{transitionId}}` is the id
   * of the transition whose target status matches.
   */
  transitions: PmsOperationSchema.optional(),
  comment: PmsOperationSchema.optional(),
  /** Dot paths overriding where each field is read from an issue object. */
  fields: z.partialRecord(z.enum(PMS_FIELDS), z.string().max(200)).default({}),
});
export type PmsToolMap = z.infer<typeof PmsToolMapSchema>;

export const PmsConnectionInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  provider: z.enum(PMS_PROVIDERS),
  mcpServerId: z.string().min(1).max(64),
  toolMap: PmsToolMapSchema.default({ fields: {} }),
});
export type PmsConnectionInput = z.input<typeof PmsConnectionInputSchema>;

export interface PmsConnectionDto {
  id: string;
  name: string;
  provider: PmsProvider;
  mcpServerId: string;
  mcpServerName: string;
  toolMap: PmsToolMap;
  createdAt: number;
  updatedAt: number;
}

export interface PmsProviderPreset {
  id: PmsProvider;
  label: string;
  /** What "external project" means for this provider. */
  projectLabel: string;
  projectPlaceholder: string;
  docsUrl: string | null;
  /** Suggested MCP server setup — check the provider's documentation. */
  server: {
    transport: McpTransport;
    command?: string;
    args?: string[];
    url?: string;
    env?: { key: string; secret: boolean; hint: string }[];
    headers?: { key: string; secret: boolean; hint: string }[];
  } | null;
  toolMap: PmsToolMap;
  defaultStatusMap: Record<string, TaskStatus>;
}

export interface PmsIssue {
  id: string;
  title: string;
  description: string;
  status: string | null;
  url: string | null;
  updatedAt: number | null;
  labels: string[];
  assignee: string | null;
}

// ─── Project mappings ────────────────────────────────────────────────────────

export const PmsFiltersSchema = z.object({
  assignee: z.string().trim().max(200).optional(),
  sprint: z.string().trim().max(200).optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  status: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
});
export type PmsFilters = z.infer<typeof PmsFiltersSchema>;

export const PmsMappingInputSchema = z.object({
  connectionId: z.string().min(1).max(64),
  externalProject: z.string().trim().min(1).max(300),
  /** External status → AI Harness status (used to skip finished tickets and for write-back). */
  statusMap: z.record(z.string().trim().min(1).max(100), z.enum(TASK_STATUSES)).default({}),
  filters: PmsFiltersSchema.default({}),
  /** null = manual sync only. */
  pollingIntervalSec: z.number().int().min(60).max(86_400).nullable().default(null),
  writeBack: z.boolean().default(true),
  /** Ask the Planner to enrich imported tickets (acceptance criteria, files, subtasks). */
  autoEnrich: z.boolean().default(true),
});
export type PmsMappingInput = z.input<typeof PmsMappingInputSchema>;
export const PmsMappingUpdateSchema = PmsMappingInputSchema.omit({ connectionId: true }).partial();

export interface PmsSyncResultDto {
  at: number;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  conflicts: number;
  errors: string[];
}

export interface PmsMappingDto {
  id: string;
  projectId: string;
  connectionId: string;
  connectionName: string;
  provider: PmsProvider;
  externalProject: string;
  statusMap: Record<string, TaskStatus>;
  filters: PmsFilters;
  pollingIntervalSec: number | null;
  writeBack: boolean;
  autoEnrich: boolean;
  syncing: boolean;
  lastSyncedAt: number | null;
  lastError: string | null;
  lastResult: PmsSyncResultDto | null;
  createdAt: number;
  updatedAt: number;
}

/** A ticket changed in the PMS while AI Harness was working on it. */
export interface PmsConflictDto {
  kind: 'changed' | 'closed';
  detectedAt: number;
  title: string;
  description: string;
  externalStatus: string | null;
}

export interface TaskExternalDto {
  connectionId: string;
  /** 'sheet' for rows imported from a spreadsheet. */
  provider: PmsProvider | 'sheet' | null;
  id: string;
  url: string | null;
  updatedAt: number | null;
  conflict: PmsConflictDto | null;
}

export const ResolvePmsConflictSchema = z.object({ action: z.enum(['apply', 'dismiss']) });
