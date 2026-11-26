import {
  SheetPreviewInputSchema,
  SheetSourceInputSchema,
  SheetSourceUpdateSchema,
  Topics,
  type SheetPreviewDto,
  type SheetRowDto,
  type SheetSourceDto,
  type SheetSyncResultDto,
  type TaskStatus,
} from '@ai-harness/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { projects, sheetSources } from '../../db/schema';
import type { EventBus } from '../../events/bus';
import { AppError, badRequest, conflict, notFound } from '../../http/errors';
import { newId } from '../../lib/id';
import type { PlannerService } from '../planner/service';
import type { TaskService } from '../tasks';
import { readTable, rowHash, toRows } from './read';

type Row = typeof sheetSources.$inferSelect;

const FINISHED: TaskStatus[] = ['DONE', 'CANCELLED'];
const POLL_TICK_MS = 15_000;

export interface SheetDeps {
  db: Db;
  bus: EventBus;
  tasks: TaskService;
  planner: PlannerService;
  log: { warn: (o: unknown, m?: string) => void };
  /** Poll sources on their interval (off in tests). */
  autoPoll: boolean;
}

const describe = (r: SheetRowDto, name: string) =>
  `${r.description || '(No description in the sheet.)'}\n\n---\nImported from sheet “${name}”, row ${r.row}${r.priorityRaw ? ` · Priority: ${r.priorityRaw}` : ''}${r.status ? ` · Status: ${r.status}` : ''}`;

/**
 * Spreadsheets as a task inbox: each row of a Google Sheet, Excel or CSV file
 * becomes a task (priority, size and type read from its columns). New rows are
 * picked up on a poll and — with auto-start — approved so agents begin right away,
 * highest priority first.
 */
export class SheetService {
  private readonly syncing = new Set<string>();
  private readonly lastAttempt = new Map<string, number>();
  private poller: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly d: SheetDeps) {}

  attach(): void {
    if (this.d.autoPoll) this.poller = setInterval(() => void this.poll(), POLL_TICK_MS).unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  // ─── Sources ───────────────────────────────────────────────────────────────

  list(projectId?: string): SheetSourceDto[] {
    const rows = projectId
      ? this.d.db.select().from(sheetSources).where(eq(sheetSources.projectId, projectId)).all()
      : this.d.db.select().from(sheetSources).all();
    return rows.map((r) => this.dto(r)).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): SheetSourceDto {
    return this.dto(this.row(id));
  }

  create(projectId: string, raw: unknown): SheetSourceDto {
    const v = SheetSourceInputSchema.parse(raw);
    if (
      !this.d.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()
    )
      throw notFound('Project');
    const dup = this.d.db
      .select({ id: sheetSources.id, sheet: sheetSources.sheet })
      .from(sheetSources)
      .where(and(eq(sheetSources.projectId, projectId), eq(sheetSources.location, v.location)))
      .all()
      .some((r) => (r.sheet ?? '') === (v.sheet ?? ''));
    if (dup) throw conflict('This sheet is already linked to the project');
    const id = newId('sht');
    this.d.db
      .insert(sheetSources)
      .values({
        id,
        projectId,
        name: v.name,
        kind: v.kind,
        location: v.location,
        sheet: v.sheet || null,
        columns: v.columns,
        pollingIntervalSec: v.pollingIntervalSec,
        autoStart: v.autoStart,
        autoEnrich: v.autoEnrich,
      })
      .run();
    return this.emit(id);
  }

  update(id: string, raw: unknown): SheetSourceDto {
    this.row(id);
    const v = SheetSourceUpdateSchema.parse(raw);
    if (Object.keys(v).length)
      this.d.db
        .update(sheetSources)
        .set({ ...v, ...(v.sheet !== undefined ? { sheet: v.sheet || null } : {}) })
        .where(eq(sheetSources.id, id))
        .run();
    return this.emit(id);
  }

  remove(id: string): void {
    const r = this.row(id);
    this.d.db.delete(sheetSources).where(eq(sheetSources.id, id)).run();
    this.d.bus.emit('sheet.removed', { projectId: r.projectId, sourceId: id }, [
      Topics.global,
      Topics.project(r.projectId),
    ]);
  }

  /** Read a sheet with an unsaved configuration and show what would be imported. */
  async preview(raw: unknown): Promise<SheetPreviewDto> {
    const v = SheetPreviewInputSchema.parse(raw);
    const p = toRows(await readTable(v), v.columns);
    return { ...p, rows: p.rows.slice(0, 50) };
  }

  // ─── Sync ──────────────────────────────────────────────────────────────────

  async sync(id: string): Promise<SheetSyncResultDto> {
    const src = this.row(id);
    if (this.syncing.has(id)) throw conflict('A sync is already running');
    this.syncing.add(id);
    this.lastAttempt.set(id, Date.now());
    this.emit(id);
    const r: SheetSyncResultDto = {
      at: Date.now(),
      total: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      conflicts: 0,
      started: 0,
      errors: [],
    };
    /** Drafts to enrich and/or approve, with the sheet priority to keep. */
    const ready: { taskId: string; row: SheetRowDto }[] = [];
    try {
      const { rows, warnings } = toRows(await readTable(src), src.columns);
      r.errors.push(
        ...warnings.filter((w) => /used twice|appears twice|isn’t in the sheet/.test(w)),
      );
      r.total = rows.length;
      for (const row of rows) {
        try {
          this.syncRow(src, row, r, ready);
        } catch (err) {
          r.errors.push(`Row ${row.row}: ${(err as Error).message}`);
        }
      }
      if (ready.length && src.autoStart && !src.autoEnrich) r.started = this.start(src, ready);
      this.d.db
        .update(sheetSources)
        .set({ lastSyncedAt: Date.now(), lastResult: r, lastError: null })
        .where(eq(sheetSources.id, id))
        .run();
    } catch (err) {
      const msg = (err as Error).message;
      this.d.db
        .update(sheetSources)
        .set({ lastError: msg.slice(0, 2000) })
        .where(eq(sheetSources.id, id))
        .run();
      throw err instanceof AppError ? err : badRequest(msg);
    } finally {
      this.syncing.delete(id);
      if (this.exists(id)) this.emit(id);
    }
    if (ready.length && src.autoEnrich) void this.enrichThenStart(src, ready);
    if (r.created)
      this.d.bus.emit(
        'notification',
        {
          level: 'info',
          title: `${r.created} new task${r.created === 1 ? '' : 's'} from “${src.name}”`,
          message: src.autoStart
            ? src.autoEnrich
              ? 'The Planner is detailing them; agents start as soon as each is ready.'
              : 'Agents are starting on them, highest priority first.'
            : 'They’re waiting for your approval in Plan & Tasks.',
          projectId: src.projectId,
        },
        [Topics.global, Topics.project(src.projectId)],
      );
    return r;
  }

  private syncRow(
    src: Row,
    row: SheetRowDto,
    r: SheetSyncResultDto,
    ready: { taskId: string; row: SheetRowDto }[],
  ) {
    const hash = rowHash(row);
    const existing = this.d.tasks.findImported(src.id, row.id);
    const url = src.kind === 'google' ? src.location : null;
    if (!existing) {
      if (row.skip) return void r.skipped++;
      const t = this.d.tasks.createImported(src.projectId, {
        title: row.title,
        description: describe(row, src.name),
        type: row.type,
        priority: row.priority,
        complexity: row.complexity,
        acceptanceCriteria: row.acceptanceCriteria,
        connectionId: src.id,
        externalId: row.id,
        externalUrl: url,
        externalUpdatedAt: null,
      });
      this.d.tasks.updateImported(t.id, {}, { pmsSeen: hash });
      ready.push({ taskId: t.id, row });
      return void r.created++;
    }
    if (existing.projectId !== src.projectId) return void r.skipped++;
    if (FINISHED.includes(existing.status)) return void r.unchanged++;
    if (existing.status === 'DRAFT') {
      if (row.skip) {
        this.d.tasks.updateImported(existing.id, {}, { pmsSeen: hash });
        this.d.tasks.transition(
          existing.id,
          'CANCELLED',
          `Marked “${row.status}” in the sheet`,
          'sheet',
        );
        return void r.updated++;
      }
      if (existing.pipelineState.pmsSeen === hash) return void r.unchanged++;
      this.d.tasks.updateImported(
        existing.id,
        {
          title: row.title,
          description: describe(row, src.name),
          priority: row.priority,
          complexity: row.complexity,
          type: row.type,
          acceptanceCriteria: row.acceptanceCriteria,
        },
        { pmsSeen: hash },
      );
      ready.push({ taskId: existing.id, row });
      return void r.updated++;
    }
    // Approved or in progress: don't change it under the agents — flag it for you instead.
    const pendingKey = row.skip ? `${hash}:skip` : hash;
    if (existing.pipelineState.pmsSeen === pendingKey) return void r.unchanged++;
    if (existing.pipelineState.pmsPendingSeen === pendingKey) return void r.conflicts++;
    this.d.tasks.updateImported(
      existing.id,
      {},
      {
        pmsConflict: {
          kind: row.skip ? 'closed' : 'changed',
          detectedAt: Date.now(),
          title: row.title,
          description: describe(row, src.name),
          externalStatus: row.status,
        },
        pmsPendingSeen: pendingKey,
      },
    );
    this.d.bus.emit(
      'notification',
      {
        level: 'warning',
        title: `${existing.key} changed in “${src.name}”`,
        message: row.skip
          ? `Row ${row.row} was marked “${row.status}” while agents are working on it.`
          : `Row ${row.row} was edited while agents are working on it. Review the change on the task.`,
        projectId: src.projectId,
        taskId: existing.id,
      },
      [Topics.global, Topics.project(src.projectId)],
    );
    r.conflicts++;
  }

  /** Planner adds acceptance criteria and subtasks; each task is approved as soon as it is ready. */
  private async enrichThenStart(src: Row, ready: { taskId: string; row: SheetRowDto }[]) {
    const instructions =
      'This task was imported from a row of the user’s spreadsheet. Keep its intent, title and priority (you may tighten the wording) and keep the "Imported from sheet" line in the description. Make it an actionable task for this codebase: clear acceptance criteria, the likely affected files or areas, and subtasks.';
    for (const item of ready) {
      if (this.stopped) return;
      try {
        await this.d.planner.enrich([item.taskId], instructions);
      } catch (err) {
        this.d.log.warn({ err, taskId: item.taskId }, 'sheet task enrichment failed');
      }
      // The sheet's priority wins over whatever the Planner chose.
      try {
        const t = this.d.tasks.get(item.taskId);
        if (t.status === 'DRAFT' && t.priority !== item.row.priority)
          this.d.tasks.updateImported(item.taskId, { priority: item.row.priority });
      } catch {
        continue;
      }
      if (src.autoStart && this.exists(src.id)) this.start(src, [item]);
    }
  }

  private start(src: Row, items: { taskId: string }[]): number {
    let n = 0;
    for (const { taskId } of items) {
      try {
        if (this.d.tasks.get(taskId).status !== 'DRAFT') continue;
        this.d.tasks.approve(taskId, {
          reason: `Approved automatically (sheet “${src.name}”)`,
          actor: 'sheet',
        });
        n++;
      } catch (err) {
        this.d.log.warn({ err, taskId }, 'could not auto-approve sheet task');
      }
    }
    return n;
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    const due = this.d.db
      .select()
      .from(sheetSources)
      .where(isNotNull(sheetSources.pollingIntervalSec))
      .all();
    for (const s of due) {
      if (this.stopped) return;
      const last = Math.max(s.lastSyncedAt ?? 0, this.lastAttempt.get(s.id) ?? 0);
      if (this.syncing.has(s.id) || now - last < s.pollingIntervalSec! * 1000) continue;
      await this.sync(s.id).catch((err: Error) =>
        this.d.log.warn({ err, sourceId: s.id }, 'sheet polling sync failed'),
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private exists(id: string) {
    return !!this.d.db
      .select({ id: sheetSources.id })
      .from(sheetSources)
      .where(eq(sheetSources.id, id))
      .get();
  }

  private row(id: string): Row {
    const r = this.d.db.select().from(sheetSources).where(eq(sheetSources.id, id)).get();
    if (!r) throw notFound('Sheet');
    return r;
  }

  private dto(r: Row): SheetSourceDto {
    const p = this.d.db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, r.projectId))
      .get();
    return {
      id: r.id,
      projectId: r.projectId,
      projectName: p?.name ?? '(removed)',
      name: r.name,
      kind: r.kind,
      location: r.location,
      sheet: r.sheet,
      columns: r.columns,
      pollingIntervalSec: r.pollingIntervalSec,
      autoStart: r.autoStart,
      autoEnrich: r.autoEnrich,
      syncing: this.syncing.has(r.id),
      lastSyncedAt: r.lastSyncedAt,
      lastError: r.lastError,
      lastResult: r.lastResult ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private emit(id: string): SheetSourceDto {
    const dto = this.get(id);
    this.d.bus.emit('sheet.source', { source: dto }, [
      Topics.global,
      Topics.project(dto.projectId),
    ]);
    return dto;
  }
}
