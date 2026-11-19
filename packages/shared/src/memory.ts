import { z } from 'zod';
import { MEMORY_KINDS, type MemoryKind, type MemoryScope } from './enums';

export const MemoryInputSchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20_000),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  pinned: z.boolean().default(false),
});
export type MemoryInput = z.input<typeof MemoryInputSchema>;
export const MemoryUpdateSchema = MemoryInputSchema.partial();

export type MemorySource = 'user' | 'documenter' | 'onboarding' | 'planner' | 'agent';

export interface MemoryEntryDto {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  taskId: string | null;
  taskKey: string | null;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  source: MemorySource;
  createdAt: number;
  updatedAt: number;
}

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  stack: 'Stack',
  architecture: 'Architecture',
  convention: 'Convention',
  command: 'Command',
  decision: 'Decision',
  pitfall: 'Pitfall',
  glossary: 'Glossary',
  feature: 'Feature',
  preference: 'Preference',
  note: 'Note',
};

export type DocKind = 'task_report' | 'readme' | 'changelog' | 'architecture' | 'other';

/** A task report (stored) or a Markdown file in the repository (read live). */
export interface DocSummaryDto {
  id: string;
  kind: DocKind;
  title: string;
  /** Repo-relative path for project files. */
  path: string | null;
  taskId: string | null;
  taskKey: string | null;
  updatedAt: number;
  size: number;
}

export interface DocDto extends DocSummaryDto {
  content: string;
}
