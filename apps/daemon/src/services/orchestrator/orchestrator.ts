import {
  ACTIVE_STATUSES,
  DocOutputSchema,
  RequestChangesInputSchema,
  ReviewOutputSchema,
  resolveRoleModel,
  resolveRouting,
  routingRuleFor,
  SteerInputSchema,
  TestOutputSchema,
  Topics,
  type AgentRole,
  type AgentRunResultDto,
  type CheckpointDto,
  type DocOutput,
  type PermissionProfile,
  type PipelineState,
  type PipelineStatusDto,
  type ReviewDto,
  type ReviewOutput,
  type RoutingRule,
  type RunSummaryDto,
  type TaskDiffDto,
  type TaskReportDto,
  type TaskStatus,
  type TaskStatusChangeDto,
  type TestResultDto,
} from '@agentforge/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodType } from 'zod';
import type { Db } from '../../db/client';
import {
  agentRuns,
  checkpoints,
  documents,
  memoryEntries,
  projects,
  projectSettings,
  reviewComments,
  reviews,
  taskDependencies,
  tasks,
  testResults,
} from '../../db/schema';
import type { EngineRegistry } from '../../engines/registry';
import type { EventBus } from '../../events/bus';
import { AppError, conflict, notFound } from '../../http/errors';
import { newId } from '../../lib/id';
import type { GithubService } from '../github';
import { extractJson } from '../planner/parse';
import type { RunRecorder } from '../runs';
import type { MemoryService } from '../memory';
import type { SettingsService } from '../settings';
import type { TaskService } from '../tasks';
import * as gitops from './git-ops';
import {
  conflictPrompt,
  developerPrompt,
  documenterPrompt,
  fixerPrompt,
  parseSubtasksDone,
  reviewerPrompt,
  testerPrompt,
  type FixInput,
  type RoleContext,
} from './prompts';
import { formatChecks, runProjectChecks } from './verify';

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

const STEP_TIMEOUT_MS = 45 * 60_000;
const MAX_JSON_ATTEMPTS = 3;
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

interface Driver {
  projectId: string;
  controller: AbortController;
  /** Controller of the engine run in flight (aborted to steer). */
  runController: AbortController | null;
  steering: boolean;
  promise: Promise<void>;
}

interface RoleOutcome<T> {
  result: AgentRunResultDto;
  runId: string;
  value: T | null;
  invalid: string[] | null;
}

export interface OrchestratorDeps {
  db: Db;
  bus: EventBus;
  tasks: TaskService;
  engines: EngineRegistry;
  runs: RunRecorder;
  settings: SettingsService;
  memory: MemoryService;
  github: GithubService;
  home: string;
  log: {
    info: (o: unknown, m?: string) => void;
    warn: (o: unknown, m?: string) => void;
    error: (o: unknown, m?: string) => void;
  };
  /** Run the scheduler automatically (off in tests, which call tick()). */
  autoStart?: boolean;
  tickMs?: number;
}

/**
 * Pipeline orchestrator: schedules approved tasks (dependencies, per-project
 * concurrency) and drives each one through Develop → Review → Test →
 * (Fix loop) → Document → merge, in its own git worktree. All state lives in
 * the database, so a restart resumes every task at its current step.
 */
export class Orchestrator {
  private readonly drivers = new Map<string, Driver>();
  private readonly mergeLocks = new Map<string, Promise<unknown>>();
  private ticking: Promise<void> | null = null;
  private tickAgain = false;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private stopped = false;
  private handoff: {
    prepareRun(taskId: string, role: AgentRole, engineId: string, cwd: string): string;
  } | null = null;

  constructor(private readonly d: OrchestratorDeps) {}

  /** Handoff notes written before each agent run (see HandoffService). */
  setHandoff(h: NonNullable<Orchestrator['handoff']>): void {
    this.handoff = h;
  }

  start(): void {
    // Nothing is running right after boot: clear stale "active run" markers, and
    // checkpoint runs cut off by the shutdown/crash so their CLI session continues.
    for (const t of this.d.db
      .select({ id: tasks.id, s: tasks.pipelineState })
      .from(tasks)
      .where(inArray(tasks.status, [...ACTIVE_STATUSES]))
      .all()) {
      const last = this.d.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.taskId, t.id))
        .orderBy(desc(agentRuns.startedAt))
        .get();
      const hint = !t.s.resumeHint && last ? this.restartHint(t.id, last.id) : null;
      if (!t.s.activeRunId && !hint) continue;
      this.d.db
        .update(tasks)
        .set({
          pipelineState: {
            ...t.s,
            activeRole: null,
            activeEngine: null,
            activeRunId: null,
            ...(hint ? { resumeHint: hint } : {}),
          },
        })
        .where(eq(tasks.id, t.id))
        .run();
    }
    if (this.d.autoStart === false) return;
    this.d.bus.subscribe((e) => {
      if (
        e.type === 'task.status_changed' ||
        e.type === 'settings.updated' ||
        e.type === 'plan.updated'
      )
        this.schedule();
    });
    const loop = () => {
      if (this.stopped) return;
      void this.tick().finally(() => {
        this.timer = setTimeout(loop, this.d.tickMs ?? 3000);
        this.timer.unref();
      });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    for (const d of this.drivers.values()) d.controller.abort();
    await Promise.allSettled([...this.drivers.values()].map((d) => d.promise));
    await this.ticking;
  }

  private schedule() {
    if (this.stopped || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.tick();
    }, 100);
  }

  // ─── Scheduler ─────────────────────────────────────────────────────────────

  /** Promote, recover and start work. Re-entrant calls coalesce. */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      do {
        this.tickAgain = false;
        const projectIds = this.d.db
          .selectDistinct({ id: tasks.projectId })
          .from(tasks)
          .where(inArray(tasks.status, ['APPROVED', 'BLOCKED', 'QUEUED', ...ACTIVE_STATUSES]))
          .all()
          .map((r) => r.id);
        await this.resumePaused();
        for (const pid of projectIds) {
          try {
            // A paused project keeps approved tasks as they are (no promotion churn).
            if (!this.projectConfig(pid).paused) this.promote(pid);
            this.recover(pid);
            this.startQueued(pid);
          } catch (err) {
            this.d.log.error({ err, projectId: pid }, 'scheduler tick failed');
          }
        }
      } while (this.tickAgain && !this.stopped);
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** Wait until no task is running and nothing more can start (tests, shutdown). */
  async idle(timeoutMs = 60_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      await this.tick();
      if (!this.drivers.size) return;
      if (Date.now() > end) throw new Error('orchestrator did not become idle');
      await Promise.race([
        Promise.allSettled([...this.drivers.values()].map((d) => d.promise)),
        new Promise((r) => setTimeout(r, 200)),
      ]);
    }
  }

  private promote(projectId: string) {
    const candidates = this.d.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), inArray(tasks.status, ['APPROVED', 'BLOCKED'])))
      .all()
      .filter((t) => !t.pipelineState.blockedBy);
    if (!candidates.length) return;
    const all = new Map(
      this.d.db
        .select({ id: tasks.id, key: tasks.key, status: tasks.status })
        .from(tasks)
        .where(eq(tasks.projectId, projectId))
        .all()
        .map((t) => [t.id, t]),
    );
    for (const t of candidates) {
      const deps = this.d.db
        .select({ d: taskDependencies.dependsOnTaskId })
        .from(taskDependencies)
        .where(eq(taskDependencies.taskId, t.id))
        .all()
        .map((r) => all.get(r.d))
        .filter((x) => !!x);
      // A cancelled dependency was dropped from the plan, so it no longer gates its dependents.
      const pending = deps.filter((x) => x.status !== 'DONE' && x.status !== 'CANCELLED');
      if (!pending.length) {
        this.d.tasks.transition(t.id, 'QUEUED', 'Ready to build', 'orchestrator');
        continue;
      }
      const broken = pending.filter((x) => x.status === 'FAILED');
      const reason = broken.length
        ? `Dependency ${broken.map((x) => x.key).join(', ')} ${broken.length > 1 ? 'have' : 'has'} failed`
        : `Waiting for ${pending.map((x) => x.key).join(', ')}`;
      if (t.status === 'APPROVED') this.d.tasks.transition(t.id, 'BLOCKED', reason, 'orchestrator');
      else if (t.statusReason !== reason) {
        this.d.db.update(tasks).set({ statusReason: reason }).where(eq(tasks.id, t.id)).run();
        this.d.tasks.touch(t.id);
      }
    }
  }

  /** After a restart, active tasks have no driver: resume them at their current step. */
  private recover(projectId: string) {
    const orphans = this.d.db
      .select({ id: tasks.id, key: tasks.key, status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), inArray(tasks.status, [...ACTIVE_STATUSES])))
      .all()
      .filter((t) => !this.drivers.has(t.id));
    for (const t of orphans) {
      this.d.log.info({ taskId: t.id, status: t.status }, 'resuming task at its current step');
      this.startDriver(t.id, projectId);
    }
  }

  private startQueued(projectId: string) {
    const cfg = this.projectConfig(projectId);
    if (cfg.paused) return;
    const running = [...this.drivers.values()].filter((d) => d.projectId === projectId).length;
    let free = cfg.maxTasks - running;
    if (free <= 0) return;
    const queued = this.d.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.status, 'QUEUED')))
      .orderBy(asc(tasks.orderIndex))
      .all()
      .sort(
        (a, b) =>
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.orderIndex - b.orderIndex,
      );
    for (const t of queued) {
      if (free <= 0) break;
      const engine = this.safeEngine(this.engineFor(t, this.roleFor('IN_DEVELOPMENT', t)));
      if (
        engine?.authStatus === 'QUOTA_EXHAUSTED' &&
        engine.resetAt &&
        engine.resetAt > Date.now() &&
        !this.fallbackFor(t.projectId, engine.id)
      ) {
        const reason = `Waiting for ${engine.displayName}'s usage window (resets ${new Date(engine.resetAt).toLocaleTimeString()})`;
        if (t.statusReason !== reason) {
          this.d.db.update(tasks).set({ statusReason: reason }).where(eq(tasks.id, t.id)).run();
          this.d.tasks.touch(t.id);
        }
        continue;
      }
      free--;
      this.d.tasks.transition(
        t.id,
        'IN_DEVELOPMENT',
        'Picked up by the orchestrator',
        'orchestrator',
      );
      this.d.db
        .update(tasks)
        .set({ startedAt: t.startedAt ?? Date.now() })
        .where(eq(tasks.id, t.id))
        .run();
      this.startDriver(t.id, projectId);
    }
    this.emitStatus(projectId);
  }

  private startDriver(taskId: string, projectId: string) {
    if (this.drivers.has(taskId) || this.stopped) return;
    const driver: Driver = {
      projectId,
      controller: new AbortController(),
      runController: null,
      steering: false,
      promise: Promise.resolve(),
    };
    this.drivers.set(taskId, driver);
    driver.promise = this.drive(taskId, driver)
      .catch((err: Error) => {
        this.d.log.error({ err, taskId }, 'pipeline crashed');
        if (!driver.controller.signal.aborted)
          this.failTask(taskId, this.row(taskId).status, `Pipeline error: ${err.message}`);
      })
      .finally(() => {
        this.drivers.delete(taskId);
        this.patchState(taskId, { activeRole: null, activeEngine: null, activeRunId: null }, false);
        this.emitStatus(projectId);
        this.schedule();
      });
  }

  private async drive(taskId: string, driver: Driver): Promise<void> {
    const signal = driver.controller.signal;
    while (!signal.aborted && !this.stopped) {
      const task = this.row(taskId);
      switch (task.status) {
        case 'IN_DEVELOPMENT':
          await this.develop(task, driver);
          break;
        case 'IN_REVIEW':
          await this.review(task, driver);
          break;
        case 'IN_TESTING':
          await this.test(task, driver);
          break;
        case 'FIXING':
          await this.fix(task, driver);
          break;
        case 'DOCUMENTING':
          await this.document(task, driver);
          break;
        default:
          return;
      }
      if (this.row(taskId).status === task.status && !signal.aborted) return; // step stopped without progressing
    }
  }

  // ─── Steps ─────────────────────────────────────────────────────────────────

  private async develop(task: TaskRow, driver: Driver) {
    const project = this.project(task.projectId);
    const working = project.workingBranch ?? project.defaultBranch ?? 'main';
    const conflictOf = task.pipelineState.conflictOf
      ? this.row(task.pipelineState.conflictOf)
      : null;
    const branch = task.branchName ?? gitops.slugBranch(task.key, task.title);
    const path = task.worktreePath ?? join(this.d.home, 'worktrees', task.projectId, task.key);
    const base = conflictOf?.branchName ?? working;
    const { baseCommit } = await gitops.ensureWorktree(project.localPath, path, branch, base);
    // Pull-request mode: dependencies may be finished but not merged yet.
    const depBranches = this.dependencyRows(task.id)
      .map((d) => d.branchName)
      .filter((b): b is string => !!b);
    const unmerged: string[] = [];
    for (const b of depBranches)
      if (
        (await gitops.branchExists(project.localPath, b)) &&
        !(await gitops.isAncestor(project.localPath, b, working))
      )
        unmerged.push(b);
    if (unmerged.length) await gitops.mergeBranchesInto(path, unmerged);
    this.d.db
      .update(tasks)
      .set({ branchName: branch, worktreePath: path, baseBranch: working })
      .where(eq(tasks.id, task.id))
      .run();
    this.patchState(task.id, { baseCommit: task.pipelineState.baseCommit ?? baseCommit });

    const ctx = this.context(this.row(task.id), project);
    const prompt = conflictOf
      ? conflictPrompt(
          ctx,
          { key: conflictOf.key, title: conflictOf.title },
          task.pipelineState.conflictFiles ?? [],
        )
      : task.origin === 'error'
        ? fixerPrompt(ctx, { source: 'error' })
        : developerPrompt(ctx);
    const role = this.roleFor('IN_DEVELOPMENT', task);
    const out = await this.runRole(task, driver, role, prompt, path, 'full', null, true);
    if (!out) return;
    // LITE routing: skip Review/Test/Document/checks and go straight to merge.
    if (this.isLite(task)) return this.mergeLite(task.id);
    this.advance(task.id, 'IN_REVIEW', 'Implementation committed');
  }

  /**
   * LITE pipeline (complexity routing): the implementation is committed; merge it
   * without Review/Test/Document. The merge is still gated on "require my review"
   * when that is on, so a human can approve or request changes before it lands.
   */
  private async mergeLite(taskId: string): Promise<void> {
    this.patchState(taskId, { lastError: null, quotaProbe: 0 }, false);
    const task = this.row(taskId);
    if (this.projectConfig(task.projectId).requireHumanReview) {
      this.patchState(taskId, { awaitingMergeReview: true });
      this.d.tasks.transition(
        taskId,
        'NEEDS_HUMAN',
        'Ready to merge — review the changes and approve the merge',
        'orchestrator',
      );
      this.notify(
        task,
        'info',
        `${task.key} is ready for your review`,
        'Approve the merge or request changes.',
      );
      return;
    }
    await this.finalize(taskId);
  }

  private async review(task: TaskRow, driver: Driver) {
    const project = this.project(task.projectId);
    const d = await this.taskDiff(task, project);
    const devSummary = this.lastRunSummary(task.id, ['developer', 'fixer']);
    const out = await this.runRole(
      task,
      driver,
      'reviewer',
      reviewerPrompt(this.context(task, project), d, devSummary),
      task.worktreePath!,
      'readonly',
      ReviewOutputSchema,
    );
    if (!out) return;
    const r = out.value!;
    const reviewId = this.saveReview(task.id, out.runId, 'agent', r);
    this.patchState(task.id, { lastReviewId: reviewId });
    if (r.verdict === 'APPROVE') {
      this.advance(task.id, 'IN_TESTING', 'Review approved');
    } else {
      this.patchState(task.id, { fixSource: 'review' });
      this.advance(
        task.id,
        'FIXING',
        `Review requested changes (${r.comments.length} comment${r.comments.length === 1 ? '' : 's'})`,
      );
      this.notify(task, 'warning', `Review requested changes on ${task.key}`, r.summary);
    }
  }

  private async test(task: TaskRow, driver: Driver) {
    const project = this.project(task.projectId);
    const d = await this.taskDiff(task, project);
    const out = await this.runRole(
      task,
      driver,
      'tester',
      testerPrompt(this.context(task, project), d),
      task.worktreePath!,
      'full',
      TestOutputSchema,
      true,
    );
    if (!out) return;
    const agent = out.value!;
    const signal = driver.controller.signal;
    const checks = await runProjectChecks(task.worktreePath!, project.commands, { signal });
    if (signal.aborted) return;
    const ranChecks = checks.steps.length > 0;
    const passed = agent.passed && agent.buildPassed !== false && (!ranChecks || checks.ok);
    const log = [
      ranChecks
        ? `## AgentForge checks\n${formatChecks(checks.steps)}`
        : '## AgentForge checks\nNo build/test commands are configured for this project — relying on the Tester’s report.',
      agent.failures.length
        ? `## Failures reported by the Tester\n${agent.failures.map((f) => `- ${f}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const id = newId('test');
    this.d.db
      .insert(testResults)
      .values({
        id,
        taskId: task.id,
        runId: out.runId,
        passed,
        total: agent.total ?? null,
        failed: agent.failed ?? null,
        skipped: agent.skipped ?? null,
        buildPassed:
          agent.buildPassed ?? (checks.steps.some((s) => s.name === 'build') ? checks.ok : null),
        commands: [...agent.commands, ...checks.steps.map((s) => s.command)],
        summary:
          ranChecks && !checks.ok && agent.passed
            ? `${agent.summary}\n\nAgentForge's own checks failed: \`${checks.steps.at(-1)!.command}\` exited ${checks.steps.at(-1)!.exitCode}.`
            : agent.summary,
        log,
      })
      .run();
    this.patchState(task.id, { lastTestResultId: id });
    if (passed) {
      this.advance(task.id, 'DOCUMENTING', 'Tests passed');
    } else {
      this.patchState(task.id, { fixSource: 'tests' });
      this.advance(task.id, 'FIXING', 'Tests or build failed');
      this.notify(
        task,
        'warning',
        `Tests failed on ${task.key}`,
        agent.failures[0] ?? agent.summary,
      );
    }
  }

  private async fix(task: TaskRow, driver: Driver) {
    const project = this.project(task.projectId);
    const cfg = this.projectConfig(task.projectId);
    if (task.fixLoopCount >= cfg.maxFixLoops) {
      const why = this.lastProblem(task);
      this.d.db.update(tasks).set({ resumeToStatus: 'FIXING' }).where(eq(tasks.id, task.id)).run();
      this.d.tasks.transition(
        task.id,
        'NEEDS_HUMAN',
        `Still failing after ${task.fixLoopCount} fix attempt${task.fixLoopCount === 1 ? '' : 's'}: ${why}`,
        'orchestrator',
      );
      this.notify(
        task,
        'error',
        `${task.key} needs you`,
        `Still failing after ${task.fixLoopCount} fix attempts.`,
      );
      return;
    }
    const source = task.pipelineState.fixSource ?? 'review';
    const out = await this.runRole(
      task,
      driver,
      'fixer',
      fixerPrompt(this.context(task, project), this.fixInput(task, source)),
      task.worktreePath!,
      'full',
      null,
      true,
    );
    if (!out) return;
    this.d.db
      .update(tasks)
      .set({ fixLoopCount: task.fixLoopCount + 1 })
      .where(eq(tasks.id, task.id))
      .run();
    this.advance(
      task.id,
      source === 'tests' ? 'IN_TESTING' : 'IN_REVIEW',
      `Fix ${task.fixLoopCount + 1} committed`,
    );
  }

  private async document(task: TaskRow, driver: Driver) {
    const project = this.project(task.projectId);
    const d = await this.taskDiff(task, project);
    const review = this.latestReview(task.id);
    const tests = this.latestTests(task.id);
    const out = await this.runRole(
      task,
      driver,
      'documenter',
      documenterPrompt(
        this.context(task, project),
        d,
        review ? `${review.verdict}: ${review.summary}` : null,
        tests ? `${tests.passed ? 'passed' : 'failed'}: ${tests.summary}` : null,
      ),
      task.worktreePath!,
      'edit',
      DocOutputSchema,
      true,
    );
    if (!out) return;
    await this.writeReport(this.row(task.id), project, out.value!);
    const cfg = this.projectConfig(task.projectId);
    if (cfg.requireHumanReview) {
      this.patchState(task.id, { awaitingMergeReview: true });
      this.d.tasks.transition(
        task.id,
        'NEEDS_HUMAN',
        'Ready to merge — review the changes and approve the merge',
        'orchestrator',
      );
      this.notify(
        task,
        'info',
        `${task.key} is ready for your review`,
        'Approve the merge or request changes.',
      );
      return;
    }
    await this.finalize(task.id);
  }

  // ─── Merge ─────────────────────────────────────────────────────────────────

  private async finalize(taskId: string): Promise<void> {
    const task = this.row(taskId);
    const prev = this.mergeLocks.get(task.projectId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.doFinalize(taskId));
    this.mergeLocks.set(task.projectId, next);
    await next;
  }

  private async doFinalize(taskId: string): Promise<void> {
    const task = this.row(taskId);
    const project = this.project(task.projectId);
    const working = task.baseBranch ?? project.workingBranch ?? project.defaultBranch ?? 'main';
    const cfg = this.projectConfig(task.projectId);
    const done = (reason: string, patch: Partial<typeof tasks.$inferInsert> = {}) => {
      this.d.db
        .update(tasks)
        .set({ ...patch, completedAt: Date.now() })
        .where(eq(tasks.id, taskId))
        .run();
      this.patchState(taskId, { awaitingMergeReview: false });
      this.d.tasks.transition(taskId, 'DONE', reason, 'orchestrator');
    };

    if (cfg.mergeStrategy === 'pull_request' && project.githubRepo) {
      try {
        await this.d.github.push(project.localPath, project.githubRepo, task.branchName!);
        const report = this.report(taskId);
        const pr = await this.d.github.createPullRequest(project.githubRepo, {
          head: task.branchName!,
          base: working,
          title: `${task.key}: ${task.title}`,
          body: report?.content ?? task.description,
        });
        await gitops.removeWorktree(project.localPath, task.worktreePath!);
        done(`Pull request #${pr.number} opened`, { pullRequestUrl: pr.url });
        this.notify(task, 'success', `${task.key} done — PR #${pr.number} opened`, task.title);
      } catch (err) {
        this.needsHuman(task, `Could not open a pull request: ${(err as Error).message}`, {
          lastError: { kind: 'MERGE', message: (err as Error).message },
        });
      }
      return;
    }

    const outcome = await gitops.mergeIntoWorking(
      project.localPath,
      task.branchName!,
      working,
      `Merge ${task.key}: ${task.title}\n\nBuilt by AgentForge.`,
    );
    if (outcome.status === 'merged') {
      await gitops.removeWorktree(project.localPath, task.worktreePath!);
      await gitops.deleteBranch(project.localPath, task.branchName!);
      this.patchState(taskId, { mergeCommit: outcome.commit, mergedInto: working });
      done(`Merged into ${working}`);
      this.notify(task, 'success', `${task.key} done`, `Merged into ${working}.`);
      // A conflict-resolution task carries its original task home.
      const originalId = task.pipelineState.conflictOf;
      if (originalId) {
        const original = this.row(originalId);
        if (original.status === 'BLOCKED') {
          if (original.worktreePath)
            await gitops.removeWorktree(project.localPath, original.worktreePath);
          if (original.branchName)
            await gitops.deleteBranch(project.localPath, original.branchName);
          this.patchState(originalId, {
            blockedBy: null,
            mergeCommit: outcome.commit,
            mergedInto: working,
          });
          this.d.db
            .update(tasks)
            .set({ completedAt: Date.now() })
            .where(eq(tasks.id, originalId))
            .run();
          this.d.tasks.transition(
            originalId,
            'DONE',
            `Merged via ${task.key} (conflict resolution)`,
            'orchestrator',
          );
        }
      }
      return;
    }
    if (outcome.status === 'dirty') {
      this.needsHuman(
        task,
        `Your working copy (${outcome.path}) has uncommitted changes. Commit or stash them, then approve the merge.`,
        { awaitingMergeReview: true },
      );
      return;
    }
    // Conflicts: hand the branch to a conflict-resolution task.
    const follow = this.d.tasks.createFollowUp(task.projectId, task.planId, {
      title: `Resolve merge conflicts for ${task.key}`,
      description: `${task.key} ("${task.title}") is complete but conflicts with \`${working}\`.\n\nConflicting files: ${outcome.files.map((f) => `\`${f}\``).join(', ') || 'unknown'}.\n\nMerge \`${working}\` into this branch, resolve the conflicts preserving both sides' intent, and make tests pass.`,
      type: 'chore',
      priority: task.priority,
      acceptanceCriteria: [
        `\`${working}\` is merged into the branch with all conflicts resolved`,
        'The build and tests pass',
        `${task.key}'s acceptance criteria still hold`,
      ],
      roleEngines: task.roleEngines,
      origin: 'conflict',
      pipelineState: { conflictOf: task.id, conflictFiles: outcome.files },
    });
    this.patchState(taskId, {
      blockedBy: { kind: 'conflict', taskId: follow.id },
      awaitingMergeReview: false,
    });
    this.d.tasks.transition(
      taskId,
      'BLOCKED',
      `Merge conflicts with ${working} — resolving in ${follow.key}`,
      'orchestrator',
    );
    this.notify(
      task,
      'warning',
      `${task.key} has merge conflicts`,
      `Created ${follow.key} to resolve them.`,
    );
  }

  // ─── User controls ─────────────────────────────────────────────────────────

  pause(taskId: string): void {
    const t = this.row(taskId);
    if (t.status !== 'QUEUED' && !ACTIVE_STATUSES.includes(t.status))
      throw conflict(`${t.key} isn't running`);
    this.d.db.update(tasks).set({ resumeToStatus: t.status }).where(eq(tasks.id, taskId)).run();
    this.d.tasks.transition(taskId, 'PAUSED_MANUAL', 'Paused by you', 'user');
    this.drivers.get(taskId)?.controller.abort();
  }

  async resume(taskId: string): Promise<void> {
    const t = this.row(taskId);
    if (t.status === 'CANCELLED') return this.resumeCancelled(t);
    if (!['PAUSED_MANUAL', 'PAUSED_QUOTA', 'PAUSED_AUTH'].includes(t.status))
      throw conflict(`${t.key} isn't paused`);
    const to = t.resumeToStatus ?? 'QUEUED';
    this.d.tasks.transition(taskId, to, 'Resumed', 'user');
    this.d.db
      .update(tasks)
      .set({ resumeToStatus: null, resumeAt: null })
      .where(eq(tasks.id, taskId))
      .run();
    this.d.tasks.touch(taskId);
    this.schedule();
  }

  async cancel(taskId: string): Promise<void> {
    const t = this.row(taskId);
    if (t.status === 'DONE' || t.status === 'CANCELLED')
      throw conflict(`${t.key} is already ${t.status.toLowerCase()}`);
    // Remember where it stopped, so "Resume" can pick it up from that step later.
    const step = ACTIVE_STATUSES.includes(t.status)
      ? t.status
      : t.resumeToStatus && ACTIVE_STATUSES.includes(t.resumeToStatus)
        ? t.resumeToStatus
        : t.status === 'DRAFT'
          ? 'DRAFT'
          : 'APPROVED';
    this.d.db
      .update(tasks)
      .set({ resumeToStatus: step, resumeAt: null })
      .where(eq(tasks.id, taskId))
      .run();
    this.d.tasks.transition(taskId, 'CANCELLED', 'Cancelled by you', 'user');
    const driver = this.drivers.get(taskId);
    driver?.controller.abort();
    await driver?.promise;
    if (t.worktreePath && existsSync(t.worktreePath)) {
      // Keep the partial work on the task branch (the worktree itself is removed).
      await gitops
        .commitAll(t.worktreePath, `WIP ${t.key}: ${t.title} (cancelled)`)
        .catch((err: Error) => this.d.log.warn({ err, taskId }, 'could not save cancelled work'));
      await gitops.removeWorktree(this.project(t.projectId).localPath, t.worktreePath);
    }
  }

  /** Continue a cancelled task from the step it was cancelled at, with its saved work. */
  private async resumeCancelled(t: TaskRow): Promise<void> {
    const step = t.resumeToStatus;
    const project = this.project(t.projectId);
    const hasWork = !!t.branchName && (await gitops.branchExists(project.localPath, t.branchName));
    if (step && ACTIVE_STATUSES.includes(step) && hasWork) {
      const working = t.baseBranch ?? project.workingBranch ?? project.defaultBranch ?? 'main';
      const path = t.worktreePath ?? join(this.d.home, 'worktrees', t.projectId, t.key);
      await gitops.ensureWorktree(project.localPath, path, t.branchName!, working);
      this.d.db.update(tasks).set({ worktreePath: path }).where(eq(tasks.id, t.id)).run();
      // Continue the interrupted agent's session when the engine supports it.
      const last = this.d.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.taskId, t.id))
        .orderBy(desc(agentRuns.startedAt))
        .get();
      const hint = last ? this.restartHint(t.id, last.id) : null;
      this.patchState(t.id, { lastError: null, ...(hint ? { resumeHint: hint } : {}) }, false);
      this.d.tasks.transition(t.id, step, 'Resumed by you', 'user');
    } else {
      // It hadn't started (or its work is gone): queue it again behind its dependencies.
      this.d.tasks.transition(
        t.id,
        step === 'DRAFT' ? 'DRAFT' : 'APPROVED',
        'Resumed by you',
        'user',
      );
    }
    this.d.db.update(tasks).set({ resumeToStatus: null }).where(eq(tasks.id, t.id)).run();
    this.d.tasks.touch(t.id);
    this.schedule();
  }

  /** Throw away a cancelled task's work and build it again from scratch. */
  async restart(taskId: string): Promise<void> {
    const t = this.row(taskId);
    if (t.status !== 'CANCELLED') throw conflict(`${t.key} can only be restarted once cancelled`);
    const project = this.project(t.projectId);
    if (t.worktreePath) await gitops.removeWorktree(project.localPath, t.worktreePath);
    if (t.branchName) await gitops.deleteBranch(project.localPath, t.branchName);
    // Fresh pipeline state; a conflict-resolution task keeps what it is resolving.
    const s = t.pipelineState;
    this.d.db
      .update(tasks)
      .set({
        branchName: null,
        worktreePath: null,
        baseBranch: null,
        fixLoopCount: 0,
        resumeToStatus: null,
        resumeAt: null,
        pipelineState: {
          ...(s.conflictOf ? { conflictOf: s.conflictOf } : {}),
          ...(s.conflictFiles ? { conflictFiles: s.conflictFiles } : {}),
        },
      })
      .where(eq(tasks.id, taskId))
      .run();
    this.d.tasks.transition(taskId, 'APPROVED', 'Restarted by you', 'user');
    this.schedule();
  }

  retry(taskId: string): void {
    const t = this.row(taskId);
    if (t.status !== 'FAILED' && t.status !== 'NEEDS_HUMAN')
      throw conflict(`${t.key} can only be retried when failed or waiting for you`);
    if (t.pipelineState.awaitingMergeReview) {
      void this.finalize(taskId).catch((err: Error) =>
        this.d.log.error({ err, taskId }, 'merge retry failed'),
      );
      return;
    }
    const to: TaskStatus =
      t.resumeToStatus && ACTIVE_STATUSES.includes(t.resumeToStatus) ? t.resumeToStatus : 'QUEUED';
    if (to === 'FIXING')
      this.d.db.update(tasks).set({ fixLoopCount: 0 }).where(eq(tasks.id, taskId)).run();
    this.d.tasks.transition(taskId, to, 'Retried by you', 'user');
    this.d.db.update(tasks).set({ resumeToStatus: null }).where(eq(tasks.id, taskId)).run();
    this.patchState(taskId, { lastError: null });
    this.schedule();
  }

  /** Send a failed (or stuck) task to the Fixer with what went wrong, then back through review and tests. */
  fixFailed(taskId: string): void {
    const t = this.row(taskId);
    if (t.status !== 'FAILED' && t.status !== 'NEEDS_HUMAN')
      throw conflict(`${t.key} can only be fixed when it has failed or is waiting for you`);
    if (t.pipelineState.awaitingMergeReview)
      throw conflict(`${t.key} is waiting for your merge review — approve it or request changes`);
    if (!t.worktreePath || !existsSync(t.worktreePath))
      throw conflict(`${t.key} has no code to fix yet — retry the step instead`);
    const note = [t.statusReason, t.pipelineState.lastError?.message]
      .filter((x, i, a): x is string => !!x && a.indexOf(x) === i)
      .join('\n\n');
    this.patchState(
      taskId,
      { fixSource: 'failure', failureNote: note || null, lastError: null },
      false,
    );
    this.d.db
      .update(tasks)
      .set({ fixLoopCount: 0, resumeToStatus: null })
      .where(eq(tasks.id, taskId))
      .run();
    this.d.tasks.transition(taskId, 'FIXING', 'Fix requested by you', 'user');
    this.schedule();
  }

  /** Message the agent: it's delivered by restarting the current step with the note (resuming the CLI session). */
  steer(taskId: string, raw: unknown): void {
    const { message } = SteerInputSchema.parse(raw);
    const t = this.row(taskId);
    if (t.status === 'DONE' || t.status === 'CANCELLED')
      throw conflict(`${t.key} is ${t.status.toLowerCase()}`);
    this.patchState(taskId, { notes: [...(t.pipelineState.notes ?? []), message] });
    const driver = this.drivers.get(taskId);
    if (driver?.runController) {
      driver.steering = true;
      driver.runController.abort();
    }
  }

  async approveMerge(taskId: string): Promise<void> {
    const t = this.row(taskId);
    if (t.status !== 'NEEDS_HUMAN' || !t.pipelineState.awaitingMergeReview)
      throw conflict(`${t.key} isn't waiting for a merge review`);
    await this.finalize(taskId);
  }

  requestChanges(taskId: string, raw: unknown): void {
    const { comments } = RequestChangesInputSchema.parse(raw);
    const t = this.row(taskId);
    if (t.status !== 'NEEDS_HUMAN' || !t.pipelineState.awaitingMergeReview)
      throw conflict(`${t.key} isn't waiting for your review`);
    this.saveReview(taskId, null, 'human', {
      verdict: 'CHANGES_REQUESTED',
      summary: comments,
      comments: [],
    });
    this.patchState(taskId, { fixSource: 'human', awaitingMergeReview: false });
    this.d.db.update(tasks).set({ fixLoopCount: 0 }).where(eq(tasks.id, taskId)).run();
    this.d.tasks.transition(taskId, 'FIXING', 'You requested changes', 'user');
    this.schedule();
  }

  setProjectPaused(projectId: string, paused: boolean): PipelineStatusDto {
    this.project(projectId);
    this.d.db
      .insert(projectSettings)
      .values({ projectId, pipelinePaused: paused })
      .onConflictDoUpdate({ target: projectSettings.projectId, set: { pipelinePaused: paused } })
      .run();
    this.emitStatus(projectId);
    this.schedule();
    return this.status(projectId);
  }

  status(projectId: string): PipelineStatusDto {
    const cfg = this.projectConfig(projectId);
    const rows = this.d.db
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.projectId, projectId), inArray(tasks.status, ['QUEUED', ...ACTIVE_STATUSES])),
      )
      .all();
    return {
      projectId,
      paused: cfg.paused,
      limit: cfg.maxTasks,
      queued: rows.filter((r) => r.status === 'QUEUED').length,
      running: rows
        .filter((r) => this.drivers.has(r.id))
        .map((r) => ({
          taskId: r.id,
          key: r.key,
          role: r.pipelineState.activeRole ?? null,
          engineId: r.pipelineState.activeEngine ?? null,
          runId: r.pipelineState.activeRunId ?? null,
        })),
    };
  }

  // ─── Read models ───────────────────────────────────────────────────────────

  runsOf(taskId: string): RunSummaryDto[] {
    this.row(taskId);
    return this.d.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.taskId, taskId))
      .orderBy(asc(agentRuns.startedAt))
      .all()
      .map((r) => ({
        id: r.id,
        role: r.role,
        engineId: r.engineId,
        model: r.model,
        attempt: r.attempt,
        status: r.status,
        resultSummary: r.resultSummary,
        errorKind: r.errorKind,
        errorMessage: r.errorMessage,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        costUsd: r.costUsd,
        filesChanged: r.filesChanged,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationMs: r.durationMs,
      }));
  }

  reviewsOf(taskId: string): ReviewDto[] {
    this.row(taskId);
    const rows = this.d.db
      .select()
      .from(reviews)
      .where(eq(reviews.taskId, taskId))
      .orderBy(asc(reviews.createdAt))
      .all();
    const comments = rows.length
      ? this.d.db
          .select()
          .from(reviewComments)
          .where(
            inArray(
              reviewComments.reviewId,
              rows.map((r) => r.id),
            ),
          )
          .all()
      : [];
    return rows.map((r) => ({
      id: r.id,
      reviewer: r.reviewer,
      verdict: r.verdict,
      summary: r.summary,
      createdAt: r.createdAt,
      comments: comments
        .filter((c) => c.reviewId === r.id)
        .map((c) => ({
          id: c.id,
          filePath: c.filePath,
          line: c.line,
          severity: c.severity,
          body: c.body,
          resolved: c.resolved,
        })),
    }));
  }

  testsOf(taskId: string): TestResultDto[] {
    this.row(taskId);
    return this.d.db
      .select()
      .from(testResults)
      .where(eq(testResults.taskId, taskId))
      .orderBy(asc(testResults.createdAt))
      .all()
      .map((t) => ({
        id: t.id,
        passed: t.passed,
        total: t.total,
        failed: t.failed,
        skipped: t.skipped,
        buildPassed: t.buildPassed,
        commands: t.commands,
        summary: t.summary,
        log: t.log,
        createdAt: t.createdAt,
      }));
  }

  report(taskId: string): TaskReportDto | null {
    const doc = this.d.db
      .select()
      .from(documents)
      .where(and(eq(documents.taskId, taskId), eq(documents.kind, 'task_report')))
      .orderBy(desc(documents.updatedAt))
      .get();
    return doc
      ? { id: doc.id, title: doc.title, content: doc.content, updatedAt: doc.updatedAt }
      : null;
  }

  async diffOf(taskId: string): Promise<TaskDiffDto> {
    const task = this.row(taskId);
    const project = this.project(task.projectId);
    const merge = task.pipelineState.mergeCommit;
    if (merge && (await gitops.revParse(project.localPath, merge)))
      return gitops.diff(project.localPath, `${merge}^1`, merge);
    return this.taskDiff(task, project);
  }

  history(taskId: string): TaskStatusChangeDto[] {
    return this.d.tasks.history(taskId);
  }

  // ─── Role runs ─────────────────────────────────────────────────────────────

  /**
   * Run one role through its engine and record it. Handles steering
   * (restart with the user's note, resuming the session), JSON outputs with
   * error-feedback retries, one automatic retry for transient failures, and
   * pausing on quota/auth problems. Returns null when the step must stop.
   */
  private async runRole<T>(
    task: TaskRow,
    driver: Driver,
    role: AgentRole,
    prompt: string,
    cwd: string,
    permission: PermissionProfile,
    schema: ZodType<T> | null,
    commit = false,
  ): Promise<RoleOutcome<T> | null> {
    const signal = driver.controller.signal;
    let engineId = this.engineFor(task, role);
    // Point the agent at the handoff notes (and, after an engine switch, at what earlier agents did).
    prompt += this.handoff?.prepareRun(task.id, role, engineId, cwd) ?? '';
    let nextPrompt = prompt;
    let resume: string | null = null;
    // Resuming after a quota/auth pause: continue the interrupted session when possible.
    const hint = this.row(task.id).pipelineState.resumeHint;
    if (hint && hint.role === role) {
      this.patchState(task.id, { resumeHint: null }, false);
      if (hint.sessionId && this.d.engines.adapter(engineId).capabilities.resume) {
        resume = hint.sessionId;
        nextPrompt = `You were interrupted (usage limit, login or an AgentForge restart) before finishing. Continue exactly where you left off and complete the task as originally instructed.${schema ? ' Finish with the JSON object described earlier.' : ''}`;
      } else if (hint.summary) {
        nextPrompt = `${prompt}\n\n## Progress before an interruption\nA previous attempt was interrupted (usage limit, login or an AgentForge restart). Its partial output:\n${hint.summary.slice(0, 6000)}\n\nCheck the working directory for work already done and continue from there.`;
      }
    }
    let jsonAttempts = 0;
    let failures = 0;
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) return null;
      const notes = this.row(task.id).pipelineState.notes ?? [];
      if (driver.steering && notes.length) {
        const list = notes.map((n) => `- ${n}`).join('\n');
        nextPrompt = resume
          ? `Message from the user while you were working:\n${list}\n\nContinue the task, taking this into account.${schema ? ' Finish with the JSON object described earlier.' : ''}`
          : `${prompt}\n\n## Messages from the user (follow these)\n${list}`;
      }
      driver.steering = false;
      if (notes.length) this.patchState(task.id, { notes: [] }, false);
      const head = commit ? await gitops.revParse(cwd, 'HEAD') : null;
      const runId = this.d.runs.start({
        projectId: task.projectId,
        taskId: task.id,
        role,
        engineId,
        prompt: nextPrompt,
        cwd,
        attempt,
      });
      this.patchState(task.id, { activeRole: role, activeEngine: engineId, activeRunId: runId });
      const runController = new AbortController();
      driver.runController = runController;
      const onAbort = () => runController.abort();
      signal.addEventListener('abort', onAbort);
      let result: AgentRunResultDto;
      try {
        result = await this.d.engines.run(
          engineId,
          {
            prompt: nextPrompt,
            cwd,
            permission,
            model: this.modelFor(task, role, engineId),
            resumeSessionId: resume,
            timeoutMs: STEP_TIMEOUT_MS,
            signal: runController.signal,
            context: { projectId: task.projectId, taskId: task.id, role },
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
          error: {
            kind:
              err instanceof AppError && err.code === 'ENGINE_DISABLED'
                ? 'AUTH_EXPIRED'
                : 'UNKNOWN',
            message: (err as Error).message,
            resetAt: null,
          },
        };
      } finally {
        signal.removeEventListener('abort', onAbort);
        driver.runController = null;
      }
      if (result.sessionId)
        this.patchState(
          task.id,
          { sessions: { ...this.row(task.id).pipelineState.sessions, [role]: result.sessionId } },
          false,
        );

      // Commit whatever the agent changed, even on failure, so nothing is lost.
      let extra: { filesChanged?: string[]; diff?: string | null } = {};
      if (commit && existsSync(cwd)) {
        const c = await gitops.commitAll(
          cwd,
          `${task.key}: ${role}${result.status === 'succeeded' ? '' : ` (${result.status})`}\n\n${task.title}`,
        );
        if (c.commit && head)
          extra = {
            filesChanged: c.files,
            diff: (await gitops.diff(cwd, head, c.commit)).patch.slice(0, 100_000),
          };
        if (c.skippedSecrets.length)
          this.d.log.warn(
            { taskId: task.id, files: c.skippedSecrets },
            'refused to commit secret-looking files',
          );
      }

      // Implementers report finished subtasks; tick them off so nobody has to.
      if (result.status === 'succeeded' && (role === 'developer' || role === 'fixer')) {
        const done = parseSubtasksDone(result.finalText);
        if (done && (done === 'all' || done.length)) this.d.tasks.completeSubtasks(task.id, done);
      }

      let value: T | null = null;
      let invalid: string[] | null = null;
      if (result.status === 'succeeded' && schema) {
        try {
          const parsed = schema.safeParse(extractJson(result.finalText));
          if (parsed.success) value = parsed.data;
          else
            invalid = parsed.error.issues
              .slice(0, 10)
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
        } catch (err) {
          invalid = [(err as Error).message];
        }
      }
      this.d.runs.finish(runId, result, {
        ...extra,
        taskType: task.type,
        resultJson: value,
        resultSummary: invalid ? `Invalid ${role} output: ${invalid.join('; ')}` : undefined,
      });

      if (result.status === 'cancelled') {
        if (driver.steering && !signal.aborted) {
          resume = this.d.engines.adapter(engineId).capabilities.resume
            ? (result.sessionId ?? this.row(task.id).pipelineState.sessions?.[role] ?? null)
            : null;
          continue;
        }
        return null;
      }
      if (result.status === 'failed') {
        const e = result.error;
        if (e && (e.kind === 'QUOTA_EXPIRED' || e.kind === 'RATE_LIMIT')) {
          const fallback = this.fallbackFor(task.projectId, engineId);
          if (fallback) {
            // Continue on the fallback engine instead of pausing.
            this.d.db
              .update(tasks)
              .set({ roleEngines: { ...this.row(task.id).roleEngines, [role]: fallback } })
              .where(eq(tasks.id, task.id))
              .run();
            this.notify(
              task,
              'info',
              `${task.key} switched to ${this.engineName(fallback)}`,
              `${this.engineName(engineId)} hit its usage limit.`,
            );
            const partial = result.finalText.trim();
            engineId = fallback;
            resume = null;
            nextPrompt = partial
              ? `${prompt}\n\n## Progress before an interruption\nAnother engine started this step and was interrupted by a usage limit. Its partial output:\n${partial.slice(0, 6000)}\n\nCheck the working directory for work already done and continue from there.`
              : prompt;
            continue;
          }
          this.pauseFor(
            task,
            'PAUSED_QUOTA',
            `${this.engineName(engineId)} usage limit reached`,
            e.resetAt,
            e.message,
            { role, engineId, sessionId: result.sessionId, partial: result.finalText },
          );
          return null;
        }
        if (e?.kind === 'AUTH_EXPIRED') {
          this.pauseFor(
            task,
            'PAUSED_AUTH',
            `${this.engineName(engineId)} needs you to log in again`,
            null,
            e.message,
            { role, engineId, sessionId: result.sessionId, partial: result.finalText },
          );
          return null;
        }
        if (++failures < 2) {
          resume = null;
          nextPrompt = prompt;
          continue;
        }
        this.failTask(
          task.id,
          this.row(task.id).status,
          `${role} failed on ${this.engineName(engineId)}: ${e?.message ?? 'unknown error'}`,
        );
        return null;
      }
      if (invalid) {
        if (
          ++jsonAttempts < MAX_JSON_ATTEMPTS &&
          result.sessionId &&
          this.d.engines.adapter(engineId).capabilities.resume
        ) {
          resume = result.sessionId;
          nextPrompt = `Your final message could not be used:\n${invalid.map((x) => `- ${x}`).join('\n')}\n\nReply with ONLY the corrected JSON object.`;
          continue;
        }
        if (jsonAttempts < MAX_JSON_ATTEMPTS) {
          resume = null;
          nextPrompt = `${prompt}\n\nYour previous final message was invalid:\n${invalid.map((x) => `- ${x}`).join('\n')}`;
          continue;
        }
        this.failTask(
          task.id,
          this.row(task.id).status,
          `The ${role} returned invalid output ${MAX_JSON_ATTEMPTS} times`,
        );
        return null;
      }
      return { result, runId, value, invalid: null };
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private advance(taskId: string, to: TaskStatus, reason: string) {
    this.patchState(taskId, { lastError: null, quotaProbe: 0 }, false);
    this.d.tasks.transition(taskId, to, reason, 'orchestrator');
  }

  private pauseFor(
    task: TaskRow,
    status: 'PAUSED_QUOTA' | 'PAUSED_AUTH',
    reason: string,
    resetAt: number | null,
    detail: string,
    run: { role: AgentRole; engineId: string; sessionId: string | null; partial: string },
  ) {
    const current = this.row(task.id);
    let resumeAt = resetAt;
    let probe = current.pipelineState.quotaProbe ?? 0;
    if (status === 'PAUSED_QUOTA' && !resumeAt) {
      // No reset time in the error: probe again with exponential backoff.
      const q = this.d.settings.get().quota;
      resumeAt =
        Date.now() + Math.min(q.probeInitialBackoffSec * 2 ** probe, q.probeMaxBackoffSec) * 1000;
      probe++;
    }
    const sessionId = run.sessionId ?? current.pipelineState.sessions?.[run.role] ?? null;
    const summary = run.partial.trim().slice(0, 8000);
    const lastStep =
      this.d.tasks
        .history(task.id)
        .filter((h) => h.to !== current.status)
        .at(-1)?.to ?? null;
    this.d.db
      .insert(checkpoints)
      .values({
        id: newId('chk'),
        taskId: task.id,
        runId: current.pipelineState.activeRunId ?? null,
        taskStatus: current.status,
        role: run.role,
        engineId: run.engineId,
        sessionId,
        branchName: current.branchName,
        lastCompletedStep: lastStep,
        notes: summary,
        data: { resumeAt, reason },
      })
      .run();
    this.d.db
      .update(tasks)
      .set({ resumeToStatus: current.status, resumeAt })
      .where(eq(tasks.id, task.id))
      .run();
    this.patchState(
      task.id,
      {
        quotaProbe: probe,
        resumeHint: { role: run.role, sessionId, summary },
        lastError: {
          kind: status === 'PAUSED_QUOTA' ? 'QUOTA_EXPIRED' : 'AUTH_EXPIRED',
          message: detail,
        },
      },
      false,
    );
    const when = resumeAt
      ? `resumes at ${new Date(resumeAt).toLocaleTimeString()}`
      : 'resumes after you log in';
    this.d.tasks.transition(task.id, status, `${reason} — ${when}`, 'orchestrator');
    this.notify(task, 'warning', `${task.key} paused`, `${reason}. It ${when} automatically.`);
  }

  /** Resume hint (and checkpoint) for a run interrupted by a daemon restart. */
  private restartHint(taskId: string, runId: string): PipelineState['resumeHint'] {
    let detail;
    try {
      detail = this.d.runs.get(runId);
    } catch {
      return null;
    }
    const run = detail.run;
    // Still marked active at boot: it was cut off by a shutdown (cancelled) or crash (failed orphan).
    if (run.status === 'SUCCEEDED' || run.status === 'RUNNING') return null;
    if (run.status === 'FAILED' && !/daemon restart/i.test(run.errorMessage ?? '')) return null;
    const summary = detail.events
      .map((e) => (e.event.kind === 'text' ? e.event.text : ''))
      .join('')
      .slice(-6000);
    const t = this.row(taskId);
    this.d.db
      .insert(checkpoints)
      .values({
        id: newId('chk'),
        taskId,
        runId,
        taskStatus: t.status,
        role: run.role,
        engineId: run.engineId,
        sessionId: run.sessionId,
        branchName: t.branchName,
        lastCompletedStep: null,
        notes: summary,
        data: { reason: 'Interrupted by a daemon restart' },
      })
      .run();
    return { role: run.role, sessionId: run.sessionId, summary };
  }

  /** Resume quota pauses whose time has come (re-checking the engine) and auth pauses whose engine is active again. */
  private async resumePaused(): Promise<void> {
    const paused = this.d.db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ['PAUSED_QUOTA', 'PAUSED_AUTH']))
      .all();
    for (const t of paused) {
      const step = t.resumeToStatus;
      if (!step) continue;
      const engineId = this.engineFor(t, this.roleFor(step, t));
      if (t.status === 'PAUSED_QUOTA') {
        if (!t.resumeAt || t.resumeAt > Date.now()) continue;
        const engine = await this.d.engines.refresh(engineId).catch(() => null);
        if (
          engine?.authStatus === 'QUOTA_EXHAUSTED' &&
          engine.resetAt &&
          engine.resetAt > Date.now()
        ) {
          this.d.db
            .update(tasks)
            .set({
              resumeAt: engine.resetAt,
              statusReason: `${engine.displayName} usage limit reached — resumes at ${new Date(engine.resetAt).toLocaleTimeString()}`,
            })
            .where(eq(tasks.id, t.id))
            .run();
          this.d.tasks.touch(t.id);
          continue;
        }
      } else if (this.safeEngine(engineId)?.authStatus !== 'ACTIVE') {
        continue;
      }
      this.d.tasks.transition(
        t.id,
        step,
        t.status === 'PAUSED_QUOTA'
          ? 'Usage window renewed — resuming'
          : 'Logged in again — resuming',
        'orchestrator',
      );
      this.d.db
        .update(tasks)
        .set({ resumeToStatus: null, resumeAt: null })
        .where(eq(tasks.id, t.id))
        .run();
      this.d.tasks.touch(t.id);
      this.notify(
        t,
        'info',
        `${t.key} resumed`,
        `Continuing ${step.toLowerCase().replace(/_/g, ' ')}.`,
      );
    }
  }

  /** The agent role that works on a task in `status`. Error-fix tasks start with the Fixer. */
  private roleFor(status: TaskStatus, task?: Pick<TaskRow, 'origin' | 'pipelineState'>): AgentRole {
    if (status === 'IN_DEVELOPMENT' && task?.origin === 'error' && !task.pipelineState.conflictOf)
      return 'fixer';
    const map: Partial<Record<TaskStatus, AgentRole>> = {
      IN_REVIEW: 'reviewer',
      IN_TESTING: 'tester',
      FIXING: 'fixer',
      DOCUMENTING: 'documenter',
    };
    return map[status] ?? 'developer';
  }

  /** Fallback engine for `engineId` in this project, if fallback is enabled and that engine is ready. */
  private fallbackFor(projectId: string, engineId: string): string | null {
    const ps = this.d.db
      .select()
      .from(projectSettings)
      .where(eq(projectSettings.projectId, projectId))
      .get();
    const enabled = (ps?.fallbackEnabled ?? false) || this.d.settings.get().quota.fallbackEnabled;
    const target = ps?.engineFallback?.[engineId];
    if (!enabled || !target || target === engineId) return null;
    const e = this.safeEngine(target);
    return e && e.enabled && e.installed && e.authStatus === 'ACTIVE' ? target : null;
  }

  private safeEngine(engineId: string) {
    try {
      return this.d.engines.get(engineId);
    } catch {
      return null;
    }
  }

  checkpointsOf(taskId: string): CheckpointDto[] {
    this.row(taskId);
    return this.d.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.taskId, taskId))
      .orderBy(asc(checkpoints.createdAt))
      .all()
      .map((c) => ({
        id: c.id,
        taskStatus: c.taskStatus,
        role: c.role,
        engineId: c.engineId,
        sessionId: c.sessionId,
        branchName: c.branchName,
        lastCompletedStep: c.lastCompletedStep,
        notes: c.notes,
        createdAt: c.createdAt,
      }));
  }

  private failTask(taskId: string, step: TaskStatus, message: string) {
    const t = this.row(taskId);
    if (!ACTIVE_STATUSES.includes(t.status) && t.status !== 'QUEUED') return;
    this.d.db
      .update(tasks)
      .set({ resumeToStatus: ACTIVE_STATUSES.includes(step) ? step : null })
      .where(eq(tasks.id, taskId))
      .run();
    this.patchState(taskId, { lastError: { kind: 'UNKNOWN', message } }, false);
    this.d.tasks.transition(taskId, 'FAILED', message.slice(0, 500), 'orchestrator');
    this.notify(t, 'error', `${t.key} failed`, message.slice(0, 300));
  }

  private needsHuman(task: TaskRow, reason: string, state: Partial<PipelineState>) {
    this.patchState(task.id, state, false);
    const current = this.row(task.id);
    if (current.status === 'NEEDS_HUMAN') {
      this.d.db.update(tasks).set({ statusReason: reason }).where(eq(tasks.id, task.id)).run();
      this.d.tasks.touch(task.id);
    } else {
      this.d.tasks.transition(task.id, 'NEEDS_HUMAN', reason, 'orchestrator');
    }
    this.notify(task, 'warning', `${task.key} needs you`, reason);
  }

  private patchState(taskId: string, patch: Partial<PipelineState>, emit = true) {
    const row = this.d.db
      .select({ s: tasks.pipelineState })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get();
    if (!row) return;
    this.d.db
      .update(tasks)
      .set({ pipelineState: { ...row.s, ...patch } })
      .where(eq(tasks.id, taskId))
      .run();
    if (emit) this.d.tasks.touch(taskId);
  }

  /** The task's change: everything on its branch since it forked from the working branch. */
  private async taskDiff(task: TaskRow, project: ProjectRow): Promise<TaskDiffDto> {
    const empty: TaskDiffDto = { base: null, head: null, files: [], patch: '', truncated: false };
    const inWorktree = !!task.worktreePath && existsSync(task.worktreePath);
    const dir = inWorktree ? task.worktreePath! : project.localPath;
    const head = inWorktree ? 'HEAD' : task.branchName;
    if (!head || !(await gitops.revParse(dir, head))) return empty;
    const working = await gitops.revParse(dir, task.baseBranch ?? project.workingBranch ?? 'main');
    const base =
      (working && (await gitops.mergeBase(dir, working, head))) || task.pipelineState.baseCommit;
    return base ? gitops.diff(dir, base, head) : empty;
  }

  private context(task: TaskRow, project: ProjectRow): RoleContext {
    const dto = this.d.tasks.get(task.id);
    const memory = this.d.memory.forPrompt(
      project.id,
      [dto.title, dto.description, ...dto.acceptanceCriteria, ...dto.affectedAreas].join(' '),
      undefined,
      task.id,
    );
    const deps = this.dependencyRows(task.id).map((d) => ({
      key: d.key,
      title: d.title,
      summary:
        this.d.db
          .select({ c: documents.content })
          .from(documents)
          .where(and(eq(documents.taskId, d.id), eq(documents.kind, 'task_report')))
          .get()
          ?.c.split('\n')
          .find((l) => l.trim() && !l.startsWith('#')) ?? null,
    }));
    return {
      project: {
        name: project.name,
        description: project.description,
        stack: project.stack,
        commands: project.commands as Record<string, string | null>,
        conventions: project.onboardingReport?.conventions ?? [],
      },
      memory,
      memoryBudget: this.d.settings.get().memory.maxPromptChars,
      task: dto,
      dependencies: deps,
      branch: task.branchName ?? '',
      workingBranch: task.baseBranch ?? project.workingBranch ?? 'main',
      notes: task.pipelineState.notes ?? [],
    };
  }

  private fixInput(task: TaskRow, source: 'review' | 'tests' | 'human' | 'failure'): FixInput {
    if (source === 'failure')
      return { source, failure: task.pipelineState.failureNote ?? undefined };
    if (source === 'tests') {
      const t = this.latestTests(task.id);
      return { source, testSummary: t?.summary, failures: t ? [t.summary] : [], checkLog: t?.log };
    }
    const r = this.latestReview(task.id);
    if (source === 'human') return { source, humanComments: r?.summary };
    return {
      source,
      review: r
        ? {
            summary: r.summary,
            comments: r.comments.map((c) => ({
              file: c.filePath,
              line: c.line,
              severity: c.severity,
              body: c.body,
            })),
          }
        : undefined,
    };
  }

  private lastProblem(task: TaskRow): string {
    if (task.pipelineState.fixSource === 'tests')
      return this.latestTests(task.id)?.summary.slice(0, 300) ?? 'tests failing';
    return this.latestReview(task.id)?.summary.slice(0, 300) ?? 'review still requesting changes';
  }

  private latestReview(taskId: string): ReviewDto | null {
    return this.reviewsOf(taskId).at(-1) ?? null;
  }

  private latestTests(taskId: string): TestResultDto | null {
    return this.testsOf(taskId).at(-1) ?? null;
  }

  private lastRunSummary(taskId: string, roles: AgentRole[]): string | null {
    return (
      this.d.db
        .select({ s: agentRuns.resultSummary })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.taskId, taskId),
            inArray(agentRuns.role, roles),
            eq(agentRuns.status, 'SUCCEEDED'),
          ),
        )
        .orderBy(desc(agentRuns.startedAt))
        .get()?.s ?? null
    );
  }

  private saveReview(
    taskId: string,
    runId: string | null,
    reviewer: 'agent' | 'human',
    r: ReviewOutput,
  ): string {
    const id = newId('rev');
    this.d.db.transaction((tx) => {
      tx.insert(reviews)
        .values({ id, taskId, runId, reviewer, verdict: r.verdict, summary: r.summary })
        .run();
      for (const c of r.comments)
        tx.insert(reviewComments)
          .values({
            id: newId('rc'),
            reviewId: id,
            filePath: c.file ?? null,
            line: c.line ?? null,
            severity: c.severity,
            body: c.body,
          })
          .run();
    });
    return id;
  }

  private async writeReport(task: TaskRow, project: ProjectRow, doc: DocOutput) {
    const d = await this.taskDiff(task, project);
    const runs = this.runsOf(task.id);
    const revs = this.reviewsOf(task.id);
    const tests = this.latestTests(task.id);
    const byRole = new Map<string, { tokens: number; cost: number; runs: number }>();
    for (const r of runs) {
      const e = byRole.get(r.role) ?? { tokens: 0, cost: 0, runs: 0 };
      byRole.set(r.role, {
        tokens: e.tokens + r.inputTokens + r.outputTokens + r.cacheReadTokens,
        cost: e.cost + r.costUsd,
        runs: e.runs + 1,
      });
    }
    const content = [
      `# ${task.key}: ${task.title}`,
      doc.summary,
      // The Documenter often brings its own headings; only add one when it didn't.
      /^\s*#/.test(doc.report) ? doc.report : `## What changed\n${doc.report}`,
      `## Files changed (${d.files.length})\n${d.files.map((f) => `- \`${f.path}\` — ${f.status}, +${f.additions} −${f.deletions}`).join('\n') || '- none'}`,
      doc.docsUpdated.length
        ? `## Documentation updated\n${doc.docsUpdated.map((f) => `- \`${f}\``).join('\n')}`
        : '',
      `## Review\n${revs.map((r, i) => `${i + 1}. ${r.reviewer === 'human' ? 'You' : 'Reviewer'}: **${r.verdict === 'APPROVE' ? 'approved' : 'changes requested'}** — ${r.summary}`).join('\n') || 'No reviews.'}`,
      `## Tests\n${tests ? `${tests.passed ? '✅ Passed' : '❌ Failed'}${tests.total !== null ? ` — ${tests.total} tests, ${tests.failed ?? 0} failed` : ''}. ${tests.summary}` : 'No test results.'}`,
      `## Token usage\n| Role | Runs | Tokens | Cost |\n|---|---|---|---|\n${[...byRole].map(([role, u]) => `| ${role} | ${u.runs} | ${u.tokens.toLocaleString()} | $${u.cost.toFixed(4)} |`).join('\n')}`,
      doc.limitations.length
        ? `## Known limitations\n${doc.limitations.map((l) => `- ${l}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const existing = this.d.db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.taskId, task.id), eq(documents.kind, 'task_report')))
      .get();
    if (existing)
      this.d.db
        .update(documents)
        .set({ content, title: `${task.key}: ${task.title}` })
        .where(eq(documents.id, existing.id))
        .run();
    else
      this.d.db
        .insert(documents)
        .values({
          id: newId('doc'),
          projectId: task.projectId,
          taskId: task.id,
          kind: 'task_report',
          title: `${task.key}: ${task.title}`,
          content,
        })
        .run();
    // Task memory: what it delivered, the decisions it made and the files it touched.
    const decisions = doc.memory.filter((m) => m.kind === 'decision' || m.kind === 'architecture');
    const taskMemory = [
      doc.summary,
      decisions.length
        ? `Decisions:\n${decisions.map((m) => `- ${m.title}: ${m.content}`).join('\n')}`
        : '',
      d.files.length
        ? `Files touched: ${d.files
            .slice(0, 40)
            .map((f) => f.path)
            .join(', ')}${d.files.length > 40 ? ` (+${d.files.length - 40} more)` : ''}`
        : '',
      doc.limitations.length ? `Known limitations: ${doc.limitations.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    this.d.db.transaction((tx) => {
      tx.delete(memoryEntries)
        .where(and(eq(memoryEntries.taskId, task.id), eq(memoryEntries.source, 'documenter')))
        .run();
      tx.insert(memoryEntries)
        .values({
          id: newId('mem'),
          scope: 'task',
          projectId: task.projectId,
          taskId: task.id,
          kind: 'feature',
          title: `${task.key}: ${task.title}`,
          content: taskMemory,
          source: 'documenter',
          tags: [task.key],
        })
        .run();
      for (const m of doc.memory)
        tx.insert(memoryEntries)
          .values({
            id: newId('mem'),
            scope: 'project',
            projectId: task.projectId,
            kind: m.kind,
            title: m.title,
            content: m.content,
            source: 'documenter',
            tags: [task.key],
          })
          .run();
    });
  }

  /** Dependencies that still count — cancelled ones are dropped (no branch merge, no context). */
  private dependencyRows(taskId: string): TaskRow[] {
    const ids = this.d.db
      .select({ d: taskDependencies.dependsOnTaskId })
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, taskId))
      .all()
      .map((r) => r.d);
    return ids.length
      ? this.d.db
          .select()
          .from(tasks)
          .where(and(inArray(tasks.id, ids), sql`${tasks.status} <> 'CANCELLED'`))
          .all()
      : [];
  }

  private engineFor(task: TaskRow, role: AgentRole): string {
    const ps = this.d.db
      .select({ r: projectSettings.roleEngines })
      .from(projectSettings)
      .where(eq(projectSettings.projectId, task.projectId))
      .get();
    // Task override → project override → global default; an engine that isn't installed
    // (or is disabled) is skipped so a stale choice doesn't fail the step.
    const chain = [task.roleEngines[role], ps?.r[role], this.d.settings.get().defaultEngines[role]];
    const set = chain.filter((x): x is string => !!x);
    const usable = set.find((id) => {
      const e = this.safeEngine(id);
      return !!e && e.installed && e.enabled;
    });
    return usable ?? set[0]!;
  }

  /**
   * The model for a role on a task:
   *   task.roleModels[role] → project.roleModels[role] → routing-profile model → null.
   * A null result lets the engine fall back to its own default model (then the CLI default).
   * The routing-profile model is only used when the chosen engine actually offers it, so a
   * profile tuned for one engine never hands an unknown model id to another.
   */
  private modelFor(task: TaskRow, role: AgentRole, engineId: string): string | null {
    const ps = this.d.db
      .select({ m: projectSettings.roleModels })
      .from(projectSettings)
      .where(eq(projectSettings.projectId, task.projectId))
      .get();
    const explicit = resolveRoleModel(task.roleModels, ps?.m, role);
    if (explicit) return explicit;
    const rule = this.routingRule(task);
    if (rule?.model && this.engineOffersModel(engineId, rule.model)) return rule.model;
    return null;
  }

  private engineOffersModel(engineId: string, model: string): boolean {
    return this.safeEngine(engineId)?.models.some((m) => m.id === model) ?? false;
  }

  /** The complexity-routing rule for a task, or null when routing is off (full pipeline). */
  private routingRule(
    task: Pick<TaskRow, 'projectId' | 'complexity' | 'pipelineState'>,
  ): RoutingRule | null {
    // Conflict-resolution tasks always run the full pipeline (merge safety).
    if (task.pipelineState.conflictOf) return null;
    const override = this.d.db
      .select({ r: projectSettings.routing })
      .from(projectSettings)
      .where(eq(projectSettings.projectId, task.projectId))
      .get()?.r;
    const routing = resolveRouting(this.d.settings.get().routing, override);
    return routingRuleFor(routing, task.complexity);
  }

  /** Whether this task should take the LITE pipeline (Develop → Merge, skipping review/test/docs). */
  private isLite(task: Pick<TaskRow, 'projectId' | 'complexity' | 'pipelineState'>): boolean {
    return this.routingRule(task)?.pipeline === 'lite';
  }

  private engineName(engineId: string): string {
    try {
      return this.d.engines.get(engineId).displayName;
    } catch {
      return engineId;
    }
  }

  private projectConfig(projectId: string) {
    const s = this.d.settings.get();
    const ps = this.d.db
      .select()
      .from(projectSettings)
      .where(eq(projectSettings.projectId, projectId))
      .get();
    return {
      paused: ps?.pipelinePaused ?? false,
      maxTasks: ps?.maxConcurrentTasks ?? s.concurrency.maxTasksPerProject,
      maxFixLoops: ps?.maxFixLoops ?? s.pipeline.maxFixLoops,
      requireHumanReview: ps?.requireHumanReview ?? s.pipeline.requireHumanReviewBeforeMerge,
      mergeStrategy: ps?.mergeStrategy ?? s.pipeline.mergeStrategy,
    };
  }

  private notify(
    task: TaskRow,
    level: 'info' | 'success' | 'warning' | 'error',
    title: string,
    message?: string,
  ) {
    this.d.bus.emit(
      'notification',
      { level, title, message, projectId: task.projectId, taskId: task.id },
      [Topics.global, Topics.project(task.projectId)],
    );
  }

  private emitStatus(projectId: string) {
    this.d.bus.emit('pipeline.updated', { status: this.status(projectId) }, [
      Topics.project(projectId),
    ]);
  }

  private row(taskId: string): TaskRow {
    const t = this.d.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!t) throw notFound('Task');
    return t;
  }

  private project(projectId: string): ProjectRow {
    const p = this.d.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!p) throw notFound('Project');
    return p;
  }
}
