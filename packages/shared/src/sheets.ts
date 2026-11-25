import { z } from 'zod';
import {
  COMPLEXITIES,
  PRIORITIES,
  TASK_TYPES,
  type Complexity,
  type Priority,
  type TaskType,
} from './enums';

// ─── Spreadsheet task sources (Excel / Google Sheets / CSV) ──────────────────

export const SHEET_KINDS = ['google', 'file'] as const;
export type SheetKind = (typeof SHEET_KINDS)[number];

/** Task fields a sheet column can feed. */
export const SHEET_FIELDS = [
  'id',
  'title',
  'description',
  'priority',
  'complexity',
  'type',
  'status',
  'acceptance',
] as const;
export type SheetField = (typeof SHEET_FIELDS)[number];

const location = z.string().trim().min(1).max(2000);

export const SheetSourceInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(SHEET_KINDS),
    /** Google Sheets link (or any CSV URL) for "google"; an absolute .xlsx/.csv path for "file". */
    location,
    /** Worksheet name for Excel files (first sheet when empty). */
    sheet: z.string().trim().max(120).nullable().optional(),
    /** Header name to use for a field, when auto-detection picks the wrong column. */
    columns: z.partialRecord(z.enum(SHEET_FIELDS), z.string().trim().max(120)).default({}),
    /** null = sync only when you press Sync. */
    pollingIntervalSec: z.number().int().min(60).max(86_400).nullable().default(300),
    /** Approve imported rows right away so agents start on them without waiting for you. */
    autoStart: z.boolean().default(true),
    /** Let the Planner add acceptance criteria and subtasks before building. */
    autoEnrich: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'google' && !/^https:\/\//i.test(v.location))
      ctx.addIssue({
        code: 'custom',
        path: ['location'],
        message: 'Paste the sheet’s https:// link',
      });
    if (v.kind === 'file' && !/^(\/|~\/|[A-Za-z]:[\\/])/.test(v.location))
      ctx.addIssue({
        code: 'custom',
        path: ['location'],
        message: 'Use the full path to the file',
      });
    if (v.kind === 'file' && !/\.(xlsx|csv|tsv)$/i.test(v.location))
      ctx.addIssue({
        code: 'custom',
        path: ['location'],
        message: 'Supported files: .xlsx, .csv, .tsv',
      });
  });
export type SheetSourceInput = z.input<typeof SheetSourceInputSchema>;

export const SheetSourceUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    sheet: z.string().trim().max(120).nullable(),
    columns: z.partialRecord(z.enum(SHEET_FIELDS), z.string().trim().max(120)),
    pollingIntervalSec: z.number().int().min(60).max(86_400).nullable(),
    autoStart: z.boolean(),
    autoEnrich: z.boolean(),
  })
  .partial()
  .strict();

/** One row, read and normalised. */
export interface SheetRowDto {
  /** Stable id: the ID column when there is one, else derived from the title. */
  id: string;
  row: number;
  title: string;
  description: string;
  priority: Priority;
  /** The cell as written (e.g. "P1", "High", "2"). */
  priorityRaw: string | null;
  /** Lower = sooner; used to order the queue within a priority. */
  rank: number;
  complexity: Complexity;
  type: TaskType;
  acceptanceCriteria: string[];
  status: string | null;
  /** Rows marked done / cancelled / skip are not imported. */
  skip: boolean;
}

export interface SheetPreviewDto {
  headers: string[];
  /** Which header each field was read from (null = not found). */
  columns: Record<SheetField, string | null>;
  /** Worksheet names (Excel files). */
  sheets: string[];
  rows: SheetRowDto[];
  total: number;
  warnings: string[];
}

export interface SheetSyncResultDto {
  at: number;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  conflicts: number;
  started: number;
  errors: string[];
}

export interface SheetSourceDto {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  kind: SheetKind;
  location: string;
  sheet: string | null;
  columns: Partial<Record<SheetField, string>>;
  pollingIntervalSec: number | null;
  autoStart: boolean;
  autoEnrich: boolean;
  syncing: boolean;
  lastSyncedAt: number | null;
  lastError: string | null;
  lastResult: SheetSyncResultDto | null;
  createdAt: number;
  updatedAt: number;
}

export const SheetPreviewInputSchema = z.object({
  kind: z.enum(SHEET_KINDS),
  location,
  sheet: z.string().trim().max(120).nullable().optional(),
  columns: z.partialRecord(z.enum(SHEET_FIELDS), z.string().trim().max(120)).default({}),
});
export type SheetPreviewInput = z.input<typeof SheetPreviewInputSchema>;

// Re-exported for the column parser's validation.
export const SHEET_ENUMS = { PRIORITIES, COMPLEXITIES, TASK_TYPES };
