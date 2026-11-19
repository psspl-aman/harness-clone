import {
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
  MemoryInputSchema,
  MemoryUpdateSchema,
  Topics,
  type MemoryEntryDto,
  type MemoryKind,
  type MemoryScope,
} from '@agentforge/shared';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { memoryEntries, projects, tasks } from '../db/schema';
import type { EventBus } from '../events/bus';
import { notFound } from '../http/errors';
import { excludeAgentforgeDir } from '../lib/agentforge-dir';
import { newId } from '../lib/id';
import type { SettingsService } from './settings';

type Row = typeof memoryEntries.$inferSelect;

const STOP = new Set(
  'a an and are as at be by for from has have in into is it its of on or that the this to was were will with when where which who why how what add use using make should can new task implement create update fix feature support'.split(
    ' ',
  ),
);
/** Lower-case word stems (≥ 3 chars) for overlap scoring. */
export function terms(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    const stem = w.replace(/(ing|ed|es|s)$/, '') || w;
    if (!STOP.has(stem)) out.add(stem);
  }
  return out;
}

/** Kinds every agent should see regardless of the task. */
const ALWAYS: MemoryKind[] = ['preference', 'convention', 'command', 'pitfall', 'stack'];

export interface PromptMemory {
  title: string;
  content: string;
  pinned: boolean;
}

/**
 * Project, task and global memory: CRUD and search, relevance-ranked
 * selection for agent prompts (within a character budget), and a readable
 * mirror at `.agentforge/memory.md` in the project folder.
 */
export class MemoryService {
  private readonly pendingMirror = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly settings: SettingsService,
  ) {}

  list(q: {
    projectId?: string | null;
    scope?: MemoryScope;
    search?: string;
    kind?: MemoryKind;
  }): MemoryEntryDto[] {
    const where = q.projectId
      ? and(
          eq(memoryEntries.projectId, q.projectId),
          q.scope ? eq(memoryEntries.scope, q.scope) : undefined,
        )
      : eq(memoryEntries.scope, 'global');
    let rows = this.db
      .select()
      .from(memoryEntries)
      .where(and(where, q.kind ? eq(memoryEntries.kind, q.kind) : undefined))
      .orderBy(desc(memoryEntries.pinned), desc(memoryEntries.updatedAt))
      .all();
    const s = q.search?.trim().toLowerCase();
    if (s)
      rows = rows.filter((r) =>
        [r.title, r.content, r.tags.join(' '), MEMORY_KIND_LABELS[r.kind]].some((f) =>
          f.toLowerCase().includes(s),
        ),
      );
    return this.toDtos(rows);
  }

  create(projectId: string | null, raw: unknown): MemoryEntryDto {
    const v = MemoryInputSchema.parse(raw);
    if (projectId) this.project(projectId);
    const id = newId('mem');
    this.db
      .insert(memoryEntries)
      .values({ id, scope: projectId ? 'project' : 'global', projectId, ...v, source: 'user' })
      .run();
    this.changed(projectId);
    return this.get(id);
  }

  update(id: string, raw: unknown): MemoryEntryDto {
    const row = this.row(id);
    const v = MemoryUpdateSchema.parse(raw);
    this.db
      .update(memoryEntries)
      .set({ ...v, updatedAt: Date.now() })
      .where(eq(memoryEntries.id, id))
      .run();
    this.changed(row.projectId);
    return this.get(id);
  }

  remove(id: string): void {
    const row = this.row(id);
    this.db.delete(memoryEntries).where(eq(memoryEntries.id, id)).run();
    this.changed(row.projectId);
  }

  get(id: string): MemoryEntryDto {
    return this.toDtos([this.row(id)])[0]!;
  }

  /** Something else (Documenter, onboarding) wrote memory for this project. */
  changed(projectId: string | null): void {
    this.bus.emit(
      'memory.updated',
      { projectId },
      projectId ? [Topics.project(projectId)] : [Topics.global],
    );
    if (projectId) this.scheduleMirror(projectId);
    else
      for (const p of this.db.select({ id: projects.id }).from(projects).all())
        this.scheduleMirror(p.id);
  }

  /**
   * Memory for an agent prompt: pinned entries, global preferences and
   * always-relevant kinds first, then entries ranked by word overlap with
   * `query`, cut to `budget` characters. Task notes of other tasks are only
   * included when they are relevant.
   */
  forPrompt(
    projectId: string,
    query: string,
    budget = this.settings.get().memory.maxPromptChars,
    excludeTaskId?: string,
  ): PromptMemory[] {
    const rows = this.db
      .select()
      .from(memoryEntries)
      .where(
        or(
          eq(memoryEntries.projectId, projectId),
          and(eq(memoryEntries.scope, 'global'), isNull(memoryEntries.projectId)),
        ),
      )
      .all()
      .filter((r) => r.taskId !== excludeTaskId || !excludeTaskId);
    const q = terms(query);
    const now = Date.now();
    const scored = rows
      .map((r) => {
        const words = terms(`${r.title} ${r.content} ${r.tags.join(' ')}`);
        let overlap = 0;
        for (const w of q) if (words.has(w)) overlap++;
        const relevance = q.size ? overlap / Math.sqrt(q.size) : 0;
        const always = r.pinned || r.scope === 'global' || ALWAYS.includes(r.kind);
        const ageDays = (now - r.updatedAt) / 86_400_000;
        const score =
          (r.pinned ? 100 : 0) +
          (r.scope === 'global' ? 50 : 0) +
          (always ? 20 : 0) +
          relevance * 10 +
          Math.max(0, 1 - ageDays / 90);
        return { r, score, relevant: always || overlap > 0 };
      })
      // Task notes are history: only bring them in when they relate to this work.
      .filter(
        (x) =>
          x.relevant && (x.r.scope !== 'task' || x.score >= 10 / Math.sqrt(Math.max(q.size, 1))),
      )
      .sort((a, b) => b.score - a.score);
    const out: PromptMemory[] = [];
    let used = 0;
    for (const { r } of scored) {
      const size = r.title.length + r.content.length + 8;
      if (used + size > budget) continue;
      used += size;
      out.push({
        title: r.scope === 'global' ? `${r.title} (your preference)` : r.title,
        content: r.content,
        pinned: r.pinned,
      });
    }
    return out;
  }

  /** Write `.agentforge/memory.md` now (normally debounced after changes). */
  writeMirror(projectId: string): void {
    const p = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!p) return;
    const file = join(p.localPath, '.agentforge', 'memory.md');
    if (!this.settings.get().memory.mirrorFile) {
      rmSync(file, { force: true });
      return;
    }
    const rows = this.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.projectId, projectId))
      .orderBy(desc(memoryEntries.pinned), desc(memoryEntries.updatedAt))
      .all();
    const sections = MEMORY_KINDS.map((k) => {
      const items = rows.filter((r) => r.kind === k && r.scope === 'project');
      return items.length
        ? `## ${MEMORY_KIND_LABELS[k]}\n\n${items.map((r) => `### ${r.pinned ? '📌 ' : ''}${r.title}\n\n${r.content.trim()}\n`).join('\n')}`
        : '';
    }).filter(Boolean);
    const taskNotes = this.toDtos(rows.filter((r) => r.scope === 'task'));
    const md = [
      `# Project memory — ${p.name}`,
      '> Maintained by AgentForge (edit it in the app; changes to this file are overwritten). Not committed to git.',
      ...sections,
      taskNotes.length
        ? `## Completed tasks\n\n${taskNotes.map((t) => `- **${t.title}** — ${t.content.trim().replace(/\n+/g, ' ')}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    try {
      mkdirSync(join(p.localPath, '.agentforge'), { recursive: true });
      excludeAgentforgeDir(p.localPath);
      writeFileSync(file, `${md}\n`);
    } catch {
      // The folder may be gone or read-only; the DB stays the source of truth.
    }
  }

  stop(): void {
    for (const [id, t] of this.pendingMirror) {
      clearTimeout(t);
      this.writeMirror(id);
    }
    this.pendingMirror.clear();
  }

  private scheduleMirror(projectId: string) {
    clearTimeout(this.pendingMirror.get(projectId));
    this.pendingMirror.set(
      projectId,
      setTimeout(() => {
        this.pendingMirror.delete(projectId);
        this.writeMirror(projectId);
      }, 300).unref(),
    );
  }

  private toDtos(rows: Row[]): MemoryEntryDto[] {
    const taskIds = [...new Set(rows.map((r) => r.taskId).filter((x): x is string => !!x))];
    const keys = new Map(
      taskIds.length
        ? this.db
            .select({ id: tasks.id, key: tasks.key })
            .from(tasks)
            .where(inArray(tasks.id, taskIds))
            .all()
            .map((t) => [t.id, t.key])
        : [],
    );
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      projectId: r.projectId,
      taskId: r.taskId,
      taskKey: r.taskId ? (keys.get(r.taskId) ?? null) : null,
      kind: r.kind,
      title: r.title,
      content: r.content,
      tags: r.tags,
      pinned: r.pinned,
      source: r.source,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  private row(id: string): Row {
    const r = this.db.select().from(memoryEntries).where(eq(memoryEntries.id, id)).get();
    if (!r) throw notFound('Memory entry');
    return r;
  }

  private project(id: string) {
    const p = this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get();
    if (!p) throw notFound('Project');
    return p;
  }
}
