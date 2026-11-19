import {
  RegenerateInputSchema,
  SendMessageInputSchema,
  Topics,
  type AgentRunResultDto,
  type AttachmentDto,
  type ChatMessageDto,
  type PlannerOutput,
  type PlannerState,
  type ReferenceSuggestions,
  type TaskDto,
} from '@agentforge/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { execa } from 'execa';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Db } from '../../db/client';
import {
  projects,
  projectSettings,
  requirements,
  tasks as tasksTable,
  type Attachment,
} from '../../db/schema';
import type { EngineRegistry } from '../../engines/registry';
import type { EventBus } from '../../events/bus';
import { AppError, badRequest, conflict, notFound } from '../../http/errors';
import { newId } from '../../lib/id';
import type { MemoryService } from '../memory';
import type { RunRecorder } from '../runs';
import type { SettingsService } from '../settings';
import type { TaskService } from '../tasks';
import { excludeAgentforgeDir } from '../../lib/agentforge-dir';
import { parsePlannerOutput } from './parse';
import {
  ALLOWED_OUTPUTS,
  buildPlannerPrompt,
  buildRetryPrompt,
  type PlannerContext,
  type PlannerMode,
} from './prompt';

type MessageRow = typeof requirements.$inferSelect;

const MAX_ATTEMPTS = 3;
const PLANNER_TIMEOUT_MS = 15 * 60_000;
const ATTACH_DIR = '.agentforge/attachments';

interface Job {
  projectId: string;
  mode: PlannerMode;
  requirement: string;
  requirementId: string | null;
  instructions?: string;
  targetTaskId?: string;
  allowQuestions: boolean;
  references: { files: string[]; tasks: string[] };
  attachments: AttachmentDto[];
}

interface Running {
  runId: string | null;
  messageId: string;
  engineId: string;
  controller: AbortController;
  startedAt: number;
  done: Promise<void>;
}

export interface PlannerDeps {
  db: Db;
  bus: EventBus;
  tasks: TaskService;
  engines: EngineRegistry;
  runs: RunRecorder;
  settings: SettingsService;
  memory: MemoryService;
  log: { warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

/**
 * Requirement chat + Planner agent. A user message starts (at most one per
 * project) planner run whose output is strictly validated JSON; invalid
 * output is fed back to the model up to MAX_ATTEMPTS times.
 */
export class PlannerService {
  private readonly running = new Map<string, Running>();
  private readonly fileCache = new Map<string, { at: number; files: string[] }>();

  constructor(private readonly d: PlannerDeps) {}

  // ─── Chat ──────────────────────────────────────────────────────────────────

  messages(projectId: string): ChatMessageDto[] {
    this.project(projectId);
    const rows = this.d.db
      .select()
      .from(requirements)
      .where(eq(requirements.projectId, projectId))
      .orderBy(asc(requirements.createdAt))
      .all();
    return this.toDtos(rows);
  }

  state(projectId: string): PlannerState {
    const r = this.running.get(projectId);
    return {
      projectId,
      running: !!r,
      runId: r?.runId ?? null,
      messageId: r?.messageId ?? null,
      engineId: r?.engineId ?? null,
      startedAt: r?.startedAt ?? null,
    };
  }

  async send(projectId: string, raw: unknown): Promise<ChatMessageDto> {
    const input = SendMessageInputSchema.parse(raw);
    const project = this.project(projectId);
    if (this.running.has(projectId))
      throw conflict('The Planner is still working on the previous message — wait or cancel it');
    let version = 1;
    if (input.supersedesId) {
      const prev = this.d.db
        .select()
        .from(requirements)
        .where(eq(requirements.id, input.supersedesId))
        .get();
      if (!prev || prev.projectId !== projectId || prev.author !== 'user')
        throw badRequest('Can only edit your own messages in this project');
      version = prev.version + 1;
    }
    const attachments = input.attachmentIds.map((id) => this.loadAttachment(project.localPath, id));
    const references = await this.extractReferences(projectId, project.localPath, input.content);
    const id = newId('req');
    this.d.db
      .insert(requirements)
      .values({
        id,
        projectId,
        author: 'user',
        content: input.content,
        intent: input.intent,
        attachments: attachments.map((a) => ({
          id: a.id,
          name: a.name,
          mime: a.mime,
          size: a.size,
          storagePath: a.path,
        })),
        references,
        supersedesId: input.supersedesId ?? null,
        version,
      })
      .run();
    this.d.db
      .update(projects)
      .set({ lastActivityAt: Date.now() })
      .where(eq(projects.id, projectId))
      .run();
    const msg = this.message(id);
    this.emitMessage(msg);

    const hasPlan = !!this.d.tasks.latestPlan(projectId);
    const mode: PlannerMode =
      input.intent === 'discuss'
        ? 'discuss'
        : input.intent === 'add_to_plan' && hasPlan
          ? 'add_to_plan'
          : 'generate_plan';
    this.start({
      projectId,
      mode,
      requirement: input.content,
      requirementId: id,
      allowQuestions: !input.skipQuestions,
      references,
      attachments,
    });
    return msg;
  }

  /**
   * Plan the requirement entered in the new-project wizard, once onboarding
   * has analysed the folder. No-op unless that requirement is still unanswered.
   */
  planInitialRequirement(projectId: string): void {
    if (this.running.has(projectId)) return;
    const rows = this.d.db
      .select()
      .from(requirements)
      .where(eq(requirements.projectId, projectId))
      .orderBy(asc(requirements.createdAt))
      .all();
    const first = rows[0];
    if (rows.length !== 1 || !first || first.author !== 'user' || first.intent !== 'generate_plan')
      return;
    this.start({
      projectId,
      mode: 'generate_plan',
      requirement: first.content,
      requirementId: first.id,
      allowQuestions: true,
      references: first.references,
      attachments: [],
    });
  }

  regeneratePlan(planId: string, raw: unknown): PlannerState {
    const { instructions } = RegenerateInputSchema.parse(raw ?? {});
    const plan = this.d.tasks.plan(planId);
    if (plan.status === 'SUPERSEDED') throw conflict('This plan was superseded');
    if (this.d.tasks.tasksOfPlan(planId).some((t) => t.status !== 'DRAFT')) {
      throw conflict(
        'Some tasks of this plan are already approved — generate a new plan or regenerate individual tasks',
      );
    }
    const req = plan.requirementId
      ? this.d.db.select().from(requirements).where(eq(requirements.id, plan.requirementId)).get()
      : null;
    this.systemNote(
      plan.projectId,
      `Regenerating plan v${plan.version}${instructions ? `: ${instructions}` : ''}`,
    );
    this.start({
      projectId: plan.projectId,
      mode: 'regenerate_plan',
      requirement: req?.content ?? plan.goal,
      requirementId: plan.requirementId,
      instructions,
      allowQuestions: false,
      references: (req?.references as Job['references']) ?? { files: [], tasks: [] },
      attachments: [],
    });
    return this.state(plan.projectId);
  }

  regenerateTask(taskId: string, raw: unknown): PlannerState {
    const { instructions } = RegenerateInputSchema.parse(raw ?? {});
    const task = this.d.tasks.get(taskId);
    this.systemNote(
      task.projectId,
      `Regenerating ${task.key}${instructions ? `: ${instructions}` : ''}`,
    );
    this.start({
      projectId: task.projectId,
      mode: 'regenerate_task',
      requirement: `Rewrite task ${task.key}: ${task.title}`,
      requirementId: task.requirementId,
      instructions,
      targetTaskId: taskId,
      allowQuestions: false,
      references: { files: [], tasks: [] },
      attachments: [],
    });
    return this.state(task.projectId);
  }

  /**
   * Rewrite draft tasks one at a time with the Planner (e.g. tickets imported
   * from a PMS), waiting for whatever the project's Planner is already doing.
   * Tasks that are no longer drafts are skipped.
   */
  async enrich(taskIds: string[], instructions: string): Promise<void> {
    for (const id of taskIds) {
      let task;
      try {
        task = this.d.tasks.get(id);
      } catch {
        continue;
      }
      while (this.running.get(task.projectId)) await this.running.get(task.projectId)!.done;
      try {
        if (this.d.tasks.get(id).status !== 'DRAFT') continue;
      } catch {
        continue;
      }
      this.regenerateTask(id, { instructions });
      await this.running.get(task.projectId)?.done;
    }
  }

  cancel(projectId: string): void {
    const r = this.running.get(projectId);
    if (!r) throw notFound('Running planner');
    r.controller.abort();
  }

  /** Mark planner messages left running by a crash as failed. */
  failOrphans(): void {
    this.d.db
      .update(requirements)
      .set({
        status: 'failed',
        kind: 'error',
        content: 'The Planner was interrupted by a daemon restart. Send your message again.',
      })
      .where(eq(requirements.status, 'running'))
      .run();
  }

  async stop(): Promise<void> {
    for (const r of this.running.values()) r.controller.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.done));
  }

  // ─── References & attachments ──────────────────────────────────────────────

  async suggestions(projectId: string, q: string): Promise<ReferenceSuggestions> {
    const project = this.project(projectId);
    const needle = q.trim().toLowerCase();
    const files = (await this.projectFiles(projectId, project.localPath))
      .filter((f) => !needle || f.toLowerCase().includes(needle))
      .sort(
        (a, b) =>
          Number(!a.toLowerCase().startsWith(needle)) -
            Number(!b.toLowerCase().startsWith(needle)) || a.length - b.length,
      )
      .slice(0, 20);
    const taskRows = this.d.db
      .select({ key: tasksTable.key, title: tasksTable.title, status: tasksTable.status })
      .from(tasksTable)
      .where(eq(tasksTable.projectId, projectId))
      .all()
      .filter(
        (t) =>
          !needle || t.key.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle),
      )
      .slice(0, 20);
    return { files, tasks: taskRows };
  }

  /** Save an uploaded file under `<project>/.agentforge/attachments/<id>/` (git-excluded). */
  saveAttachment(
    projectId: string,
    file: { filename: string; mimetype: string; data: Buffer },
  ): AttachmentDto {
    const project = this.project(projectId);
    const id = newId('att');
    const safe =
      basename(file.filename)
        .replace(/[^\w.\- ]+/g, '_')
        .slice(0, 120) || 'file';
    const dir = join(project.localPath, ATTACH_DIR, id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, safe);
    writeFileSync(path, file.data);
    const meta: AttachmentDto = {
      id,
      name: safe,
      mime: file.mimetype || 'application/octet-stream',
      size: file.data.length,
      path,
    };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
    excludeAgentforgeDir(project.localPath);
    return meta;
  }

  // ─── Planner run ───────────────────────────────────────────────────────────

  private start(job: Job): void {
    const engineId = this.plannerEngine(job.projectId);
    const messageId = newId('req');
    this.d.db
      .insert(requirements)
      .values({
        id: messageId,
        projectId: job.projectId,
        author: 'planner',
        content: '',
        status: 'running',
        kind: 'message',
      })
      .run();
    this.emitMessage(this.message(messageId));
    const controller = new AbortController();
    const entry: Running = {
      runId: null,
      messageId,
      engineId,
      controller,
      startedAt: Date.now(),
      done: Promise.resolve(),
    };
    this.running.set(job.projectId, entry);
    this.emitState(job.projectId);
    entry.done = this.execute(job, entry)
      .catch((err: Error) => {
        this.d.log.error({ err, projectId: job.projectId }, 'planner run crashed');
        this.finishMessage(messageId, {
          kind: 'error',
          status: 'failed',
          content: `The Planner failed: ${err.message}`,
        });
      })
      .finally(() => {
        this.running.delete(job.projectId);
        this.emitState(job.projectId);
      });
  }

  private async execute(job: Job, entry: Running): Promise<void> {
    const project = this.project(job.projectId);
    const engine = this.d.engines.get(entry.engineId);
    if (!engine.installed) {
      return this.finishMessage(entry.messageId, {
        kind: 'error',
        status: 'failed',
        content: `${engine.displayName} (the Planner engine) is not installed. Install it or pick another engine in Settings → Default engines.`,
      });
    }
    const ctx = this.context(job, project);
    const allowed = ALLOWED_OUTPUTS[job.mode].filter(
      (t) => t !== 'questions' || job.allowQuestions,
    );
    const existingKeys = new Set(ctx.tasks.map((t) => t.key.toUpperCase()));
    let prompt = buildPlannerPrompt(ctx);
    let sessionId: string | null = null;
    let lastErrors: string[] = [];
    let lastResult: AgentRunResultDto | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const runId = this.d.runs.start({
        projectId: job.projectId,
        role: 'planner',
        engineId: entry.engineId,
        prompt,
        cwd: project.localPath,
        requirementId: job.requirementId,
        taskId: job.targetTaskId ?? null,
        attempt,
      });
      entry.runId = runId;
      this.d.db
        .update(requirements)
        .set({ runId })
        .where(eq(requirements.id, entry.messageId))
        .run();
      this.emitMessage(this.message(entry.messageId));
      this.emitState(job.projectId);

      let result: AgentRunResultDto;
      try {
        result = await this.d.engines.run(
          entry.engineId,
          {
            prompt,
            cwd: project.localPath,
            permission: 'readonly',
            resumeSessionId: sessionId,
            timeoutMs: PLANNER_TIMEOUT_MS,
            signal: entry.controller.signal,
          },
          this.d.runs.sink(runId),
        );
      } catch (err) {
        result = {
          status: 'failed',
          sessionId: null,
          finalText: '',
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          durationMs: 0,
          exitCode: null,
          error: { kind: 'UNKNOWN', message: (err as Error).message, resetAt: null },
        };
      }
      lastResult = result;
      const parsed =
        result.status === 'succeeded'
          ? parsePlannerOutput(result.finalText, { allowed, existingKeys })
          : null;
      this.d.runs.finish(runId, result, {
        resultJson: parsed?.ok ? parsed.output : null,
        resultSummary:
          parsed && !parsed.ok ? `Invalid planner output: ${parsed.errors.join('; ')}` : undefined,
      });

      if (result.status === 'cancelled')
        return this.finishMessage(entry.messageId, {
          kind: 'error',
          status: 'cancelled',
          content: 'Planning cancelled.',
        });
      if (result.status === 'failed') {
        const e = result.error;
        const hint =
          e?.kind === 'QUOTA_EXPIRED' || e?.kind === 'RATE_LIMIT'
            ? `${engine.displayName} hit its usage limit${e.resetAt ? ` (resets ${new Date(e.resetAt).toLocaleTimeString()})` : ''}.`
            : e?.kind === 'AUTH_EXPIRED'
              ? `${engine.displayName} needs you to log in again (Agents & Accounts).`
              : `${engine.displayName} failed.`;
        return this.finishMessage(entry.messageId, {
          kind: 'error',
          status: 'failed',
          content: `${hint}\n\n${e?.message ?? ''}`.trim(),
        });
      }
      if (parsed!.ok) return this.apply(job, entry, parsed!.output);

      lastErrors = parsed!.errors;
      this.d.log.warn(
        { projectId: job.projectId, attempt, errors: lastErrors },
        'invalid planner output, retrying',
      );
      const engineCanResume =
        this.d.engines.adapter(entry.engineId).capabilities.resume && !!result.sessionId;
      sessionId = engineCanResume ? result.sessionId : null;
      prompt = engineCanResume
        ? buildRetryPrompt(lastErrors, allowed)
        : `${buildPlannerPrompt(ctx)}\n\n## Your previous attempt\n${result.finalText.slice(0, 20_000)}\n\n${buildRetryPrompt(lastErrors, allowed)}`;
    }
    this.finishMessage(entry.messageId, {
      kind: 'error',
      status: 'failed',
      content: `The Planner returned invalid output ${MAX_ATTEMPTS} times, so nothing was changed.\n\nLast problems:\n${lastErrors.map((e) => `- ${e}`).join('\n')}${lastResult?.finalText ? `\n\nLast response (truncated):\n\n${lastResult.finalText.slice(0, 1500)}` : ''}`,
    });
  }

  private apply(job: Job, entry: Running, out: PlannerOutput): void {
    switch (out.type) {
      case 'questions':
        return this.finishMessage(entry.messageId, {
          kind: 'questions',
          status: 'done',
          content: out.message || 'I need a few answers before planning:',
          questions: out.questions,
        });
      case 'reply':
        return this.finishMessage(entry.messageId, {
          kind: 'message',
          status: 'done',
          content: out.message,
        });
      case 'plan': {
        const plan = this.d.tasks.createPlan(job.projectId, job.requirementId, out.plan);
        const created = this.d.tasks.createFromPlanner(
          job.projectId,
          plan.id,
          job.requirementId,
          out.tasks,
        );
        return this.finishMessage(entry.messageId, {
          kind: 'plan',
          status: 'done',
          planId: plan.id,
          content: `${out.message || `Drafted plan v${plan.version}.`}\n\n${created.length} task${created.length === 1 ? '' : 's'} ready for your review.`,
        });
      }
      case 'tasks': {
        const plan = this.d.tasks.latestPlan(job.projectId);
        if (!plan) throw new AppError(409, 'NO_PLAN', 'No plan to add tasks to');
        const created = this.d.tasks.createFromPlanner(
          job.projectId,
          plan.id,
          job.requirementId,
          out.tasks,
        );
        this.d.tasks.syncPlanApproval(plan.id); // the plan has new drafts again
        return this.finishMessage(entry.messageId, {
          kind: 'plan',
          status: 'done',
          planId: plan.id,
          content: `${out.message || 'Added tasks to the plan.'}\n\nAdded ${created.map((t) => t.key).join(', ')} for your review.`,
        });
      }
      case 'task': {
        const t = this.d.tasks.replaceDefinition(job.targetTaskId!, out.task);
        const existing = new Map(
          this.d.tasks.board(job.projectId).tasks.map((x) => [x.key.toUpperCase(), x.id]),
        );
        const deps = out.task.dependsOn
          .map((k) => existing.get(k.toUpperCase()))
          .filter((x): x is string => !!x && x !== t.id);
        this.d.tasks.setDependencies(t.id, { dependsOn: deps });
        return this.finishMessage(entry.messageId, {
          kind: 'plan',
          status: 'done',
          planId: t.planId,
          content: `${out.message || 'Updated the task.'}\n\nRewrote ${t.key}.`,
        });
      }
    }
  }

  // ─── Context ───────────────────────────────────────────────────────────────

  private context(job: Job, project: typeof projects.$inferSelect): PlannerContext {
    const board = this.d.tasks.board(job.projectId);
    const plan = board.plans[0] ?? null;
    const memory = this.d.memory.forPrompt(
      job.projectId,
      [job.requirement, job.instructions ?? '', ...job.references.files].join(' '),
    );
    const history = this.d.db
      .select()
      .from(requirements)
      .where(and(eq(requirements.projectId, job.projectId), eq(requirements.status, 'done')))
      .orderBy(desc(requirements.createdAt))
      .limit(13)
      .all()
      .filter((m) => m.id !== job.requirementId)
      .slice(0, 12)
      .reverse()
      .map((m) => ({
        author: m.author === 'user' ? 'user' : m.author === 'planner' ? 'planner' : 'system',
        content:
          m.kind === 'questions'
            ? `${m.content}\n${(m.questions ?? []).map((q) => `- ${q.question}`).join('\n')}`
            : m.content,
      }));
    const referencedTasks = job.references.tasks.length
      ? board.tasks.filter((t) => job.references.tasks.includes(t.key))
      : [];
    return {
      mode: job.mode,
      project: {
        name: project.name,
        description: project.description,
        localPath: project.localPath,
        origin: project.origin,
        stack: project.stack,
        stackPreferences: project.stackPreferences,
        commands: project.commands as Record<string, string | null>,
      },
      report: project.onboardingReport ?? null,
      memory,
      memoryBudget: this.d.settings.get().memory.maxPromptChars,
      plan,
      tasks: board.tasks.filter((t) => t.status !== 'CANCELLED'),
      history,
      requirement: job.requirement,
      instructions: job.instructions,
      targetTask: job.targetTaskId ? board.tasks.find((t) => t.id === job.targetTaskId) : undefined,
      referencedFiles: job.references.files,
      referencedTasks,
      attachments: job.attachments,
      engines: this.d.engines
        .list()
        .filter((e) => e.enabled)
        .map((e) => e.id),
      allowQuestions: job.allowQuestions,
    };
  }

  private plannerEngine(projectId: string): string {
    const ps = this.d.db
      .select({ r: projectSettings.roleEngines })
      .from(projectSettings)
      .where(eq(projectSettings.projectId, projectId))
      .get();
    return ps?.r.planner ?? this.d.settings.get().defaultEngines.planner;
  }

  private async extractReferences(
    projectId: string,
    root: string,
    content: string,
  ): Promise<{ files: string[]; tasks: string[] }> {
    const fileTokens = [...content.matchAll(/(?<![\w@])@([\w./-]+[\w/])/g)].map((m) => m[1]!);
    const taskTokens = [...content.matchAll(/(?<![\w#])#([A-Za-z]{1,4}-\d{1,6})\b/g)].map((m) =>
      m[1]!.toUpperCase(),
    );
    let files: string[] = [];
    if (fileTokens.length) {
      const all = new Set(await this.projectFiles(projectId, root));
      files = [
        ...new Set(
          fileTokens.filter(
            (f) => all.has(f) || [...all].some((x) => x.startsWith(`${f.replace(/\/$/, '')}/`)),
          ),
        ),
      ];
    }
    let taskKeys: string[] = [];
    if (taskTokens.length) {
      const keys = new Set(
        this.d.db
          .select({ k: tasksTable.key })
          .from(tasksTable)
          .where(and(eq(tasksTable.projectId, projectId), inArray(tasksTable.key, taskTokens)))
          .all()
          .map((r) => r.k),
      );
      taskKeys = [...new Set(taskTokens.filter((t) => keys.has(t)))];
    }
    return { files, tasks: taskKeys };
  }

  private async projectFiles(projectId: string, root: string): Promise<string[]> {
    const cached = this.fileCache.get(projectId);
    if (cached && Date.now() - cached.at < 30_000) return cached.files;
    const r = await execa('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      reject: false,
      timeout: 15_000,
    });
    const files =
      r.exitCode === 0
        ? String(r.stdout)
            .split('\n')
            .filter((f) => f && !f.startsWith('.agentforge/'))
            .slice(0, 50_000)
        : [];
    this.fileCache.set(projectId, { at: Date.now(), files });
    return files;
  }

  private loadAttachment(root: string, id: string): AttachmentDto {
    if (!/^att_[a-z0-9]+$/.test(id)) throw badRequest('Invalid attachment id');
    const metaPath = join(root, ATTACH_DIR, id, 'meta.json');
    if (!existsSync(metaPath)) throw badRequest(`Attachment ${id} not found`);
    return JSON.parse(readFileSync(metaPath, 'utf8')) as AttachmentDto;
  }

  // ─── Messages ──────────────────────────────────────────────────────────────

  private systemNote(projectId: string, content: string) {
    const id = newId('req');
    this.d.db
      .insert(requirements)
      .values({ id, projectId, author: 'system', content, kind: 'message', status: 'done' })
      .run();
    this.emitMessage(this.message(id));
  }

  private finishMessage(id: string, patch: Partial<typeof requirements.$inferInsert>) {
    this.d.db.update(requirements).set(patch).where(eq(requirements.id, id)).run();
    this.emitMessage(this.message(id));
  }

  private message(id: string): ChatMessageDto {
    const row = this.d.db.select().from(requirements).where(eq(requirements.id, id)).get();
    if (!row) throw notFound('Message');
    return this.toDtos([row])[0]!;
  }

  private toDtos(rows: MessageRow[]): ChatMessageDto[] {
    if (!rows.length) return [];
    const projectId = rows[0]!.projectId;
    const supersededBy = new Map(
      this.d.db
        .select({ id: requirements.id, s: requirements.supersedesId })
        .from(requirements)
        .where(eq(requirements.projectId, projectId))
        .all()
        .filter((r) => r.s)
        .map((r) => [r.s!, r.id]),
    );
    const userIds = rows.filter((r) => r.author === 'user').map((r) => r.id);
    const produced = userIds.length
      ? this.d.db
          .select({ id: tasksTable.id, req: tasksTable.requirementId })
          .from(tasksTable)
          .where(inArray(tasksTable.requirementId, userIds))
          .all()
      : [];
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      author: r.author,
      kind: r.kind,
      content: r.content,
      intent: r.intent,
      status: r.status,
      version: r.version,
      supersedesId: r.supersedesId,
      supersededBy: supersededBy.get(r.id) ?? null,
      attachments: (r.attachments as Attachment[]).map((a) => ({
        id: a.id,
        name: a.name,
        mime: a.mime,
        size: a.size,
        path: a.storagePath,
      })),
      references: r.references,
      questions: r.questions ?? null,
      planId: r.planId,
      runId: r.runId,
      producedTaskIds: produced.filter((p) => p.req === r.id).map((p) => p.id),
      createdAt: r.createdAt,
    }));
  }

  private project(projectId: string) {
    const p = this.d.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!p) throw notFound('Project');
    return p;
  }

  private emitMessage(message: ChatMessageDto) {
    this.d.bus.emit('chat.message', { projectId: message.projectId, message }, [
      Topics.project(message.projectId),
    ]);
  }

  private emitState(projectId: string) {
    this.d.bus.emit('planner.state', { state: this.state(projectId) }, [Topics.project(projectId)]);
  }
}

export type { TaskDto };
