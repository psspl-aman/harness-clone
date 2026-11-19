import { Topics, type ErrorDto, type ErrorSource } from '@agentforge/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { errors, plans, tasks } from '../../db/schema';
import type { EventBus } from '../../events/bus';
import { conflict, notFound } from '../../http/errors';
import { newId } from '../../lib/id';
import type { TaskService } from '../tasks';
import type { TerminalService } from '../terminals';
import { fingerprint, OutputScanner, type DetectedError } from './matchers';

type ErrorRow = typeof errors.$inferSelect;

const toDto = (e: ErrorRow): ErrorDto => ({
  id: e.id,
  projectId: e.projectId,
  source: e.source,
  matcher: e.matcher,
  message: e.message,
  filePath: e.filePath,
  line: e.line,
  column: e.column,
  excerpt: e.excerpt,
  occurrences: e.occurrences,
  status: e.status,
  taskId: e.taskId,
  fixTaskId: e.fixTaskId,
  terminalSessionId: e.terminalSessionId,
  firstSeenAt: e.firstSeenAt,
  lastSeenAt: e.lastSeenAt,
});

/**
 * Detects errors in project terminals and run output (pluggable matchers),
 * records failed tasks, de-duplicates by fingerprint, and turns an error into
 * a fix task that goes through the pipeline.
 */
export class ErrorService {
  private readonly scanners = new Map<string, OutputScanner>();
  /** Terminals whose non-zero exit shouldn't be reported (stopped on purpose). */
  private readonly quietExit = new Set<string>();
  /** Terminals whose output already produced a specific error (no extra "exited with code" entry then). */
  private readonly detected = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly tasks: TaskService,
    private readonly terminals: TerminalService,
  ) {}

  attach(): void {
    this.bus.subscribe((e) => {
      if (e.type === 'terminal.output') this.scanner(e.payload.terminalId)?.push(e.payload.data);
      if (e.type === 'terminal.exit') this.onExit(e.payload.terminalId, e.payload.exitCode);
      if (e.type === 'task.status_changed')
        this.onTaskStatus(e.payload.taskId, e.payload.to, e.payload.reason);
    });
  }

  /** Don't report the next exit of this terminal (it is being stopped deliberately). */
  expectExit(terminalId: string): void {
    this.quietExit.add(terminalId);
  }

  list(projectId: string, status?: ErrorDto['status'][]): ErrorDto[] {
    return this.db
      .select()
      .from(errors)
      .where(
        and(
          eq(errors.projectId, projectId),
          status?.length ? inArray(errors.status, status) : undefined,
        ),
      )
      .orderBy(desc(errors.lastSeenAt))
      .all()
      .map(toDto);
  }

  record(
    projectId: string,
    source: ErrorSource,
    d: DetectedError,
    refs: { terminalSessionId?: string | null; taskId?: string | null; runId?: string | null } = {},
  ): ErrorDto {
    const fp = refs.taskId && source === 'task' ? `task:${refs.taskId}` : fingerprint(d);
    const existing = this.db
      .select()
      .from(errors)
      .where(and(eq(errors.projectId, projectId), eq(errors.fingerprint, fp)))
      .get();
    const now = Date.now();
    let id: string;
    if (existing) {
      id = existing.id;
      this.db
        .update(errors)
        .set({
          occurrences: existing.occurrences + 1,
          lastSeenAt: now,
          excerpt: d.excerpt,
          message: d.message,
          // An error that comes back after being fixed is open again.
          status: existing.status === 'resolved' ? 'open' : existing.status,
          fixTaskId: existing.status === 'resolved' ? null : existing.fixTaskId,
          terminalSessionId: refs.terminalSessionId ?? existing.terminalSessionId,
        })
        .where(eq(errors.id, id))
        .run();
    } else {
      id = newId('err');
      this.db
        .insert(errors)
        .values({
          id,
          projectId,
          source,
          matcher: d.matcher,
          message: d.message,
          filePath: d.filePath,
          line: d.line,
          column: d.column,
          excerpt: d.excerpt,
          fingerprint: fp,
          taskId: refs.taskId ?? null,
          runId: refs.runId ?? null,
          terminalSessionId: refs.terminalSessionId ?? null,
        })
        .run();
    }
    return this.emit(id);
  }

  /** Create a fix task (Fix → Review → Test → Document) for an error. */
  fix(errorId: string): ErrorDto {
    const e = this.row(errorId);
    if (e.status === 'fixing' && e.fixTaskId)
      throw conflict('A fix task is already working on this error');
    const where = e.filePath
      ? `${e.filePath}${e.line ? `:${e.line}` : ''}${e.column ? `:${e.column}` : ''}`
      : 'unknown location';
    const plan = this.db
      .select({ id: plans.id })
      .from(plans)
      .where(and(eq(plans.projectId, e.projectId), inArray(plans.status, ['DRAFT', 'APPROVED'])))
      .orderBy(desc(plans.version))
      .get();
    const task = this.tasks.createFollowUp(e.projectId, plan?.id ?? null, {
      title: `Fix: ${e.message.slice(0, 120)}`,
      description: `An error was detected in the project's ${e.source === 'task' ? 'agent pipeline' : `${e.source} output`} (${e.occurrences} occurrence${e.occurrences === 1 ? '' : 's'}).\n\n**Error:** ${e.message}\n**Where:** \`${where}\`\n\n\`\`\`\n${e.excerpt.slice(-4000)}\n\`\`\`\n\nFind the root cause and fix it. Add or update a test that would have caught it when practical.`,
      type: 'bug',
      priority: 'high',
      acceptanceCriteria: [
        `The error no longer occurs: ${e.message.slice(0, 200)}`,
        'The build and existing tests pass',
      ],
      roleEngines: {},
      origin: 'error',
      pipelineState: {},
    });
    this.db.update(tasks).set({ sourceErrorId: e.id }).where(eq(tasks.id, task.id)).run();
    this.tasks.touch(task.id);
    this.db
      .update(errors)
      .set({ status: 'fixing', fixTaskId: task.id })
      .where(eq(errors.id, e.id))
      .run();
    return this.emit(e.id);
  }

  setStatus(errorId: string, status: 'open' | 'ignored' | 'resolved'): ErrorDto {
    this.row(errorId);
    this.db
      .update(errors)
      .set({ status, ...(status !== 'resolved' ? { fixTaskId: null } : {}) })
      .where(eq(errors.id, errorId))
      .run();
    return this.emit(errorId);
  }

  private scanner(terminalId: string): OutputScanner | null {
    let s = this.scanners.get(terminalId);
    if (s) return s;
    let info;
    try {
      info = this.terminals.get(terminalId);
    } catch {
      return null;
    }
    if (!info.projectId || info.kind === 'login') return null;
    const projectId = info.projectId;
    s = new OutputScanner((d) => {
      this.detected.add(terminalId);
      this.record(projectId, info.kind === 'run' ? 'run' : 'terminal', d, {
        terminalSessionId: terminalId,
      });
    });
    this.scanners.set(terminalId, s);
    return s;
  }

  private onExit(terminalId: string, code: number | null) {
    const s = this.scanners.get(terminalId);
    s?.flush();
    this.scanners.delete(terminalId);
    const quiet = this.quietExit.delete(terminalId);
    const specific = this.detected.delete(terminalId);
    let info;
    try {
      info = this.terminals.get(terminalId);
    } catch {
      return;
    }
    if (quiet || specific || info.kind !== 'run' || !info.projectId || code === 0 || code === null)
      return;
    this.record(
      info.projectId,
      'run',
      {
        matcher: 'process-exit',
        message: `${info.title} exited with code ${code}`,
        filePath: null,
        line: null,
        column: null,
        excerpt: s?.tail(40) ?? '',
      },
      { terminalSessionId: terminalId },
    );
  }

  private onTaskStatus(taskId: string, to: string, reason: string | null) {
    const t = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!t) return;
    if (to === 'FAILED') {
      this.record(
        t.projectId,
        'task',
        {
          matcher: 'task-failure',
          message: `${t.key} failed: ${(reason ?? t.pipelineState.lastError?.message ?? 'unknown error').slice(0, 300)}`,
          filePath: null,
          line: null,
          column: null,
          excerpt: t.pipelineState.lastError?.message ?? reason ?? '',
        },
        { taskId },
      );
    }
    if (t.origin === 'error' && t.sourceErrorId) {
      if (to === 'DONE') this.setStatus(t.sourceErrorId, 'resolved');
      if (to === 'CANCELLED') this.setStatus(t.sourceErrorId, 'open');
    }
    // A failed task that is retried and finishes resolves its own failure entry.
    if (to === 'DONE') {
      const own = this.db
        .select()
        .from(errors)
        .where(and(eq(errors.projectId, t.projectId), eq(errors.fingerprint, `task:${taskId}`)))
        .get();
      if (own && own.status !== 'resolved') this.setStatus(own.id, 'resolved');
    }
  }

  private row(id: string): ErrorRow {
    const e = this.db.select().from(errors).where(eq(errors.id, id)).get();
    if (!e) throw notFound('Error');
    return e;
  }

  private emit(id: string): ErrorDto {
    const dto = toDto(this.row(id));
    this.bus.emit('error.updated', { projectId: dto.projectId, error: dto }, [
      Topics.project(dto.projectId),
    ]);
    return dto;
  }
}
