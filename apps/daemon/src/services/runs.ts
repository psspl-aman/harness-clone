import { redactDeep, type Redactor } from '../safety/redact';
import {
  Topics,
  type AgentEvent,
  type AgentRole,
  type AgentRunResultDto,
  type AppSettings,
  type TaskType,
} from '@ai-harness/shared';
import { costOf } from '../lib/cost';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { agentRuns, runEvents, usageRecords } from '../db/schema';
import type { EventBus } from '../events/bus';
import { notFound } from '../http/errors';
import { newId } from '../lib/id';

type RunEventKind = typeof runEvents.$inferInsert.kind;

const kindOf = (e: AgentEvent): RunEventKind => {
  switch (e.kind) {
    case 'text':
    case 'thinking':
      return 'message';
    case 'tool_call':
    case 'tool_result':
      return 'tool';
    case 'usage':
      return 'usage';
    case 'log':
      return e.stream;
    default:
      return 'status';
  }
};

interface LiveRun {
  projectId: string;
  seq: number;
  pending: (typeof runEvents.$inferInsert)[];
  textBuf: string;
  timer: NodeJS.Timeout | null;
}

export interface StartRunInput {
  projectId: string;
  role: AgentRole;
  engineId: string;
  prompt: string;
  cwd: string;
  model?: string | null;
  taskId?: string | null;
  requirementId?: string | null;
  attempt?: number;
}

export interface RunDetail {
  run: typeof agentRuns.$inferSelect;
  events: { seq: number; kind: string; event: AgentEvent; ts: number }[];
}

/**
 * Persists agent runs: one `agent_runs` row per role run, every stream event
 * in `run_events` (streamed text deltas are coalesced), usage in
 * `usage_records`, and live `run.event` / `run.finished` bus events.
 */
export class RunRecorder {
  private readonly live = new Map<string, LiveRun>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly pricing: () => AppSettings['pricing'] = () => ({}),
  ) {}

  start(input: StartRunInput): string {
    const id = newId('run');
    this.db
      .insert(agentRuns)
      .values({
        id,
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        requirementId: input.requirementId ?? null,
        role: input.role,
        engineId: input.engineId,
        model: input.model ?? null,
        attempt: input.attempt ?? 1,
        prompt: input.prompt,
        cwd: input.cwd,
        status: 'RUNNING',
      })
      .run();
    this.live.set(id, {
      projectId: input.projectId,
      seq: 0,
      pending: [],
      textBuf: '',
      timer: null,
    });
    return id;
  }

  /** Event sink for an engine run: persists (batched) and broadcasts. */
  private redact: Redactor | null = null;

  /** Applied to every run event before it is stored or broadcast. */
  setRedactor(r: Redactor): void {
    this.redact = r;
  }

  sink(runId: string): (e: AgentEvent) => void {
    return (raw) => {
      const e = this.redact ? redactDeep(raw, this.redact) : raw;
      const l = this.live.get(runId);
      if (!l) return;
      this.bus.emit(
        'run.event',
        { runId, event: e },
        [Topics.run(runId), Topics.project(l.projectId)],
        { transient: true },
      );
      if (e.kind === 'session')
        this.db
          .update(agentRuns)
          .set({ sessionId: e.sessionId, model: e.model ?? undefined })
          .where(eq(agentRuns.id, runId))
          .run();
      if (e.kind === 'text' && e.delta) {
        l.textBuf += e.text;
        return;
      }
      this.flushText(runId, l);
      l.pending.push({ runId, seq: ++l.seq, kind: kindOf(e), data: JSON.stringify(e) });
      l.timer ??= setTimeout(() => this.flush(runId), 250);
    };
  }

  finish(
    runId: string,
    result: AgentRunResultDto,
    extra: {
      taskType?: TaskType | null;
      resultJson?: unknown;
      resultSummary?: string | null;
      filesChanged?: string[];
      diff?: string | null;
    } = {},
  ): void {
    const l = this.live.get(runId);
    if (l) {
      this.flushText(runId, l);
      this.flush(runId);
      this.live.delete(runId);
    }
    const row = this.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();
    if (!row) return;
    const u = result.usage;
    const cost = costOf(u, row.engineId, this.pricing());
    const status =
      result.status === 'succeeded'
        ? 'SUCCEEDED'
        : result.status === 'cancelled'
          ? 'CANCELLED'
          : 'FAILED';
    this.db
      .update(agentRuns)
      .set({
        status,
        sessionId: result.sessionId ?? row.sessionId,
        model: u.model ?? row.model,
        resultSummary:
          extra.resultSummary ?? (result.finalText ? result.finalText.slice(0, 2000) : null),
        resultJson: extra.resultJson ?? null,
        filesChanged: extra.filesChanged ?? [],
        diff: extra.diff ?? null,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        costUsd: cost.costUsd,
        exitCode: result.exitCode,
        errorKind: result.error?.kind ?? null,
        errorMessage: result.error?.message ?? null,
        finishedAt: Date.now(),
        durationMs: result.durationMs,
      })
      .where(eq(agentRuns.id, runId))
      .run();
    if (u.inputTokens || u.outputTokens || u.cacheReadTokens || u.cacheWriteTokens) {
      this.db
        .insert(usageRecords)
        .values({
          id: newId('use'),
          runId,
          projectId: row.projectId,
          taskId: row.taskId,
          role: row.role,
          taskType: extra.taskType ?? null,
          engineId: row.engineId,
          model: u.model ?? row.model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheWriteTokens,
          costUsd: cost.costUsd,
          costSource: cost.source,
          durationMs: result.durationMs,
        })
        .run();
    }
    this.bus.emit('run.finished', { runId, result }, [
      Topics.run(runId),
      Topics.project(row.projectId),
    ]);
  }

  /** Mark runs left RUNNING by a crash as failed (called on boot). */
  failOrphans(): number {
    const res = this.db
      .update(agentRuns)
      .set({
        status: 'FAILED',
        errorKind: 'UNKNOWN',
        errorMessage: 'Interrupted by a daemon restart',
        finishedAt: Date.now(),
      })
      .where(eq(agentRuns.status, 'RUNNING'))
      .run();
    return res.changes;
  }

  get(runId: string): RunDetail {
    const run = this.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();
    if (!run) throw notFound('Run');
    const l = this.live.get(runId);
    if (l) this.flush(runId);
    const events = this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq))
      .all()
      .map((e) => ({
        seq: e.seq,
        kind: e.kind,
        event: JSON.parse(e.data) as AgentEvent,
        ts: e.ts,
      }));
    return { run, events };
  }

  private flushText(runId: string, l: LiveRun) {
    if (!l.textBuf) return;
    l.pending.push({
      runId,
      seq: ++l.seq,
      kind: 'message',
      data: JSON.stringify({ kind: 'text', text: l.textBuf } satisfies AgentEvent),
    });
    l.textBuf = '';
  }

  private flush(runId: string) {
    const l = this.live.get(runId);
    if (!l) return;
    if (l.timer) clearTimeout(l.timer);
    l.timer = null;
    if (!l.pending.length) return;
    const rows = l.pending.splice(0);
    this.db.insert(runEvents).values(rows).run();
  }
}
