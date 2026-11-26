import {
  ROLE_LABELS,
  type AgentRole,
  type ReviewDto,
  type RunSummaryDto,
  type TaskDto,
  type TaskReportDto,
  type TestResultDto,
} from '@ai-harness/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/client';
import { errors, projects } from '../db/schema';
import type { EngineRegistry } from '../engines/registry';
import type { EventBus } from '../events/bus';
import { excludeProjectDataDir, projectDataDir, projectDataDirName } from '../lib/project-data-dir';
import type { SettingsService } from './settings';
import type { TaskService } from './tasks';

/** Pipeline history the handoff files are built from (provided by the orchestrator). */
export interface HandoffSource {
  runsOf(taskId: string): RunSummaryDto[];
  reviewsOf(taskId: string): ReviewDto[];
  testsOf(taskId: string): TestResultDto[];
  report(taskId: string): TaskReportDto | null;
}

const PROJECT_FILE = 'PROJECT.md';
const TASKS_DIR = 'tasks';
const HEADER =
  '> Maintained by AI Harness for every agent working on this project — regenerated automatically, so edits here are overwritten. Not committed to git.';

const clip = (s: string, n: number) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}… (truncated)` : t;
};
const pad = (n: number) => String(n).padStart(2, '0');
const when = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const minutes = (ms: number) => (ms < 60_000 ? '<1m' : `${Math.round(ms / 60_000)}m`);
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const roleName = (r: AgentRole) => ROLE_LABELS[r] ?? r;
const firstLine = (md: string) =>
  md
    .split('\n')
    .find((l) => l.trim() && !l.startsWith('#'))
    ?.trim() ?? null;

/**
 * Keeps markdown "handoff" files in the project so any agent — on any engine —
 * can pick up where another left off:
 *
 * - `.ai-harness/PROJECT.md`: overview, plan and every task's status.
 * - `.ai-harness/tasks/<KEY>.md`: one task's spec, status history, what each
 *   agent run did, the latest review and test results.
 *
 * Files are refreshed (debounced) as tasks change and copied into a task's
 * worktree right before each agent run. `.ai-harness/` is excluded from git.
 */
export class HandoffService {
  private source: HandoffSource | null = null;
  private pending = new Map<string, { timer: NodeJS.Timeout; tasks: Set<string> | 'all' }>();
  private seen = new Set<string>();
  private stopped = false;

  constructor(
    private readonly d: {
      db: Db;
      bus: EventBus;
      settings: SettingsService;
      tasks: TaskService;
      engines: EngineRegistry;
      log: FastifyBaseLogger;
      redact?: (s: string) => string;
      debounceMs?: number;
    },
  ) {}

  setSource(source: HandoffSource): void {
    this.source = source;
  }

  attach(): void {
    // Bring every project's notes up to date after a start.
    for (const p of this.d.db.select({ id: projects.id }).from(projects).all())
      this.schedule(p.id, 'all');
    this.d.bus.subscribe((e) => {
      switch (e.type) {
        case 'task.updated':
          return this.schedule(e.payload.projectId, e.payload.task.id);
        case 'task.status_changed':
          return this.schedule(e.payload.projectId, e.payload.taskId);
        case 'task.deleted':
        case 'plan.updated':
          return this.schedule(e.payload.projectId, 'all');
        case 'error.updated':
          return this.schedule(e.payload.projectId, e.payload.error.taskId ?? null);
        case 'memory.updated':
          if (e.payload.projectId) this.schedule(e.payload.projectId, null);
          return;
        case 'project.onboarding':
          if (e.payload.status === 'done') this.schedule(e.payload.projectId, 'all');
          return;
        case 'settings.updated':
          for (const p of this.d.db.select({ id: projects.id }).from(projects).all())
            this.schedule(p.id, 'all');
          return;
      }
    });
  }

  stop(): void {
    this.stopped = true;
    for (const [projectId, p] of this.pending) {
      clearTimeout(p.timer);
      this.flush(projectId, p.tasks);
    }
    this.pending.clear();
  }

  private get enabled() {
    return this.d.settings.get().memory.handoffFiles;
  }

  /** Mark a project (and optionally one task, or all tasks) for a rewrite. */
  private schedule(projectId: string, taskId: string | null | 'all') {
    if (this.stopped) return;
    const p = this.pending.get(projectId);
    const tasks: Set<string> | 'all' =
      taskId === 'all' || p?.tasks === 'all' || !this.seen.has(projectId)
        ? 'all'
        : new Set([...(p?.tasks ?? []), ...(taskId ? [taskId] : [])]);
    if (p) clearTimeout(p.timer);
    const timer = setTimeout(() => {
      this.pending.delete(projectId);
      this.flush(projectId, tasks);
    }, this.d.debounceMs ?? 1000);
    timer.unref();
    this.pending.set(projectId, { timer, tasks });
  }

  /** Rewrite PROJECT.md and the given task files in the project folder. */
  flush(projectId: string, which: Set<string> | 'all' = 'all'): void {
    try {
      const p = this.d.db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!p || !existsSync(p.localPath)) return;
      const root = projectDataDir(p.localPath);
      if (!this.enabled) {
        rmSync(join(root, PROJECT_FILE), { force: true });
        rmSync(join(root, TASKS_DIR), { recursive: true, force: true });
        return;
      }
      this.seen.add(projectId);
      const board = this.d.tasks.board(projectId);
      mkdirSync(join(root, TASKS_DIR), { recursive: true });
      excludeProjectDataDir(p.localPath);
      writeFileSync(join(root, PROJECT_FILE), this.renderProject(projectId, board));
      const keep = new Set(board.tasks.map((t) => `${t.key}.md`));
      for (const t of board.tasks)
        if (which === 'all' || which.has(t.id))
          writeFileSync(join(root, TASKS_DIR, `${t.key}.md`), this.renderTask(t, board.tasks));
      for (const f of readdirSync(join(root, TASKS_DIR)))
        if (f.endsWith('.md') && !keep.has(f)) rmSync(join(root, TASKS_DIR, f), { force: true });
    } catch (err) {
      // The folder may be gone or read-only; the database stays the source of truth.
      this.d.log.warn({ err, projectId }, 'could not write handoff files');
    }
  }

  /**
   * Called right before an agent run: refresh the files, copy them into the
   * run's directory (a task worktree) and return the prompt section that points
   * the agent at them — plus, when a different engine worked on this task
   * before, a summary of what it did.
   */
  prepareRun(taskId: string, role: AgentRole, engineId: string, cwd: string): string {
    const task = this.d.tasks.get(taskId);
    const p = this.d.db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    const sections: string[] = [];
    if (p && this.enabled) {
      this.flush(p.id, new Set([taskId]));
      if (cwd !== p.localPath) this.copyInto(p.localPath, cwd, task.key);
      const dir = projectDataDirName(p.localPath);
      sections.push(`## Handoff notes
AI Harness keeps shared notes for every agent on this project (out of git; regenerated, so don't edit them):
- \`${dir}/${TASKS_DIR}/${task.key}.md\` — this task: spec, status history, what each earlier agent did, review comments and test results.
- \`${dir}/${PROJECT_FILE}\` — the project overview, plan and every task's status.
- \`${dir}/memory.md\` — decisions, conventions and pitfalls.
Read the task file first when earlier agents have already worked on this task.`);
    }
    const takeover = this.takeover(taskId, role, engineId);
    if (takeover) sections.push(takeover);
    return sections.length ? `\n\n${sections.join('\n\n')}` : '';
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  private engine(id: string) {
    try {
      return this.d.engines.get(id).displayName;
    } catch {
      return id;
    }
  }

  private redact(s: string) {
    return this.d.redact ? this.d.redact(s) : s;
  }

  /** What earlier agents did, when this run is on a different engine than the last one. */
  private takeover(taskId: string, role: AgentRole, engineId: string): string | null {
    const runs = this.source?.runsOf(taskId) ?? [];
    const last = runs.at(-1);
    if (!last || last.engineId === engineId) return null;
    const lines = runs
      .slice(-6)
      .map(
        (r) =>
          `- ${roleName(r.role)} · ${this.engine(r.engineId)} · ${r.status.toLowerCase()}${r.filesChanged.length ? ` · changed ${r.filesChanged.slice(0, 8).join(', ')}` : ''}${
            r.resultSummary || r.errorMessage
              ? `\n  ${clip(r.resultSummary ?? r.errorMessage ?? '', 800).replace(/\n/g, '\n  ')}`
              : ''
          }`,
      );
    const review = this.source?.reviewsOf(taskId).at(-1);
    const tests = this.source?.testsOf(taskId).at(-1);
    return this.redact(
      [
        `## You are taking over (${roleName(role)} on ${this.engine(engineId)})`,
        `Earlier work on this task was done by ${this.engine(last.engineId)}. What happened so far (oldest first):`,
        lines.join('\n'),
        review
          ? `Latest review: ${review.verdict === 'APPROVE' ? 'approved' : 'changes requested'} — ${clip(review.summary, 600)}`
          : '',
        tests
          ? `Latest tests: ${tests.passed ? 'passed' : 'failed'} — ${clip(tests.summary, 600)}`
          : '',
        'Check the working directory for the work already done and continue from there.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  private renderProject(projectId: string, board: ReturnType<TaskService['board']>): string {
    const p = this.d.db.select().from(projects).where(eq(projects.id, projectId)).get()!;
    const plan = board.plans[0] ?? null;
    const byId = new Map(board.tasks.map((t) => [t.id, t]));
    const cmds = Object.entries(p.commands ?? {}).filter(([, v]) => v);
    const conventions = p.onboardingReport?.conventions ?? [];
    const open = this.d.db
      .select()
      .from(errors)
      .where(and(eq(errors.projectId, projectId), eq(errors.status, 'open')))
      .orderBy(desc(errors.lastSeenAt))
      .limit(10)
      .all();
    const rows = board.tasks.map((t) => {
      const summary =
        t.status === 'DONE' ? firstLine(this.source?.report(t.id)?.content ?? '') : null;
      const after = t.dependsOn
        .map((d) => byId.get(d)?.key)
        .filter(Boolean)
        .join(', ');
      return `| ${t.key} | ${cell(t.status)}${t.statusReason ? ` — ${cell(clip(t.statusReason, 80))}` : ''} | ${cell(t.title)}${summary ? `<br>${cell(clip(summary, 160))}` : ''} | ${after || '—'} | [notes](${TASKS_DIR}/${t.key}.md) |`;
    });
    const md = [
      `# ${p.name} — project handoff`,
      HEADER,
      `Updated ${when(Date.now())}`,
      '## Overview',
      [
        p.description ?? '',
        p.stack?.length ? `- **Stack:** ${p.stack.join(', ')}` : '',
        `- **Folder:** \`${p.localPath}\` · working branch \`${p.workingBranch ?? p.defaultBranch ?? 'main'}\``,
        p.githubRepo ? `- **GitHub:** ${p.githubRepo}` : '',
        cmds.length ? `- **Commands:** ${cmds.map(([k, v]) => `${k} \`${v}\``).join(' · ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      conventions.length ? `## Conventions\n${conventions.map((c) => `- ${c}`).join('\n')}` : '',
      plan
        ? [
            `## Plan v${plan.version} (${plan.status.toLowerCase()})`,
            plan.goal,
            plan.scope ? `**Scope:** ${plan.scope}` : '',
            plan.outOfScope ? `**Out of scope:** ${plan.outOfScope}` : '',
            plan.architectureNotes ? `**Architecture:** ${plan.architectureNotes}` : '',
          ]
            .filter(Boolean)
            .join('\n\n')
        : '',
      board.tasks.length
        ? `## Tasks (${board.tasks.length})\n\nCancelled tasks are skipped and don't block the tasks after them.\n\n| Key | Status | Task | After | Details |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}`
        : '## Tasks\n\nNo tasks yet.',
      open.length
        ? `## Open errors\n${open
            .map(
              (e) =>
                `- ${e.filePath ? `\`${e.filePath}${e.line ? `:${e.line}` : ''}\` ` : ''}${clip(e.message, 200)}${e.occurrences > 1 ? ` (×${e.occurrences})` : ''}`,
            )
            .join('\n')}`
        : '',
      '## More\n- `memory.md` — decisions, conventions, pitfalls and completed-task notes.\n- `tasks/<KEY>.md` — each task in full.',
    ];
    return `${this.redact(md.filter(Boolean).join('\n\n'))}\n`;
  }

  private renderTask(t: TaskDto, all: TaskDto[]): string {
    const byId = new Map(all.map((x) => [x.id, x]));
    const runs = this.source?.runsOf(t.id) ?? [];
    const review = this.source?.reviewsOf(t.id).at(-1);
    const tests = this.source?.testsOf(t.id).at(-1);
    const report = t.status === 'DONE' ? this.source?.report(t.id) : null;
    const history = this.d.tasks.history(t.id).slice(-25);
    const engines = Object.entries(t.roleEngines)
      .filter(([, v]) => v)
      .map(([r, v]) => `${roleName(r as AgentRole)}: ${this.engine(v!)}`);
    const md = [
      `# ${t.key}: ${t.title}`,
      HEADER,
      [
        `- **Status:** ${t.status}${t.statusReason ? ` — ${t.statusReason}` : ''}`,
        `- **Type:** ${t.type} · **Priority:** ${t.priority} · **Complexity:** ${t.complexity.toUpperCase()}`,
        t.pipeline.branch ? `- **Branch:** \`${t.pipeline.branch}\`` : '',
        t.dependsOn.length
          ? `- **After:** ${t.dependsOn
              .map((d) => byId.get(d))
              .filter((d): d is TaskDto => !!d)
              .map(
                (d) => `${d.key} (${d.status === 'CANCELLED' ? 'cancelled — skipped' : d.status})`,
              )
              .join(', ')}`
          : '',
        engines.length ? `- **Engines:** ${engines.join(' · ')}` : '',
        t.external
          ? `- **Ticket:** ${t.external.id}${t.external.url ? ` ${t.external.url}` : ''}`
          : '',
        `- **Time:** estimate ~${minutes(t.timing.estimateMs)} · agent time so far ${minutes(t.timing.spentMs)}`,
        `- **Updated:** ${when(t.updatedAt)}`,
      ]
        .filter(Boolean)
        .join('\n'),
      '## Description',
      t.description || '(none)',
      `## Acceptance criteria\n${t.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '- (none given)'}`,
      t.subtasks.length
        ? `## Subtasks\n${t.subtasks.map((s) => `- [${s.done ? 'x' : ' '}] ${s.title}`).join('\n')}`
        : '',
      t.affectedAreas.length ? `**Likely affected areas:** ${t.affectedAreas.join(', ')}` : '',
      runs.length
        ? `## Agent runs (oldest first)\n\n${runs
            .slice(-30)
            .map((r) =>
              [
                `### ${when(r.startedAt)} · ${roleName(r.role)} · ${this.engine(r.engineId)}${r.model ? ` (${r.model})` : ''} · ${r.status.toLowerCase()}${r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}`,
                r.filesChanged.length
                  ? `Files changed: ${r.filesChanged
                      .slice(0, 30)
                      .map((f) => `\`${f}\``)
                      .join(
                        ', ',
                      )}${r.filesChanged.length > 30 ? ` and ${r.filesChanged.length - 30} more` : ''}`
                  : '',
                r.resultSummary ? clip(r.resultSummary, 2500) : '',
                r.errorMessage ? `Error: ${clip(r.errorMessage, 600)}` : '',
              ]
                .filter(Boolean)
                .join('\n\n'),
            )
            .join('\n\n')}`
        : '## Agent runs\n\nNo agent has worked on this task yet.',
      review
        ? `## Latest ${review.scope === 'tests' ? 'test review' : 'review'} — ${review.verdict === 'APPROVE' ? 'approved' : 'changes requested'} (${review.reviewer}, ${when(review.createdAt)})\n\n${clip(review.summary, 1500)}${
            review.comments.filter((c) => !c.resolved).length
              ? `\n\n${review.comments
                  .filter((c) => !c.resolved)
                  .slice(0, 20)
                  .map(
                    (c) =>
                      `- [${c.severity}]${c.filePath ? ` \`${c.filePath}${c.line ? `:${c.line}` : ''}\`` : ''} ${clip(c.body, 400)}`,
                  )
                  .join('\n')}`
              : ''
          }`
        : '',
      tests
        ? `## Latest tests — ${tests.passed ? 'passed' : 'failed'} (${when(tests.createdAt)})\n\n${clip(tests.summary, 1500)}${
            tests.total != null ? `\n\n${tests.total} total, ${tests.failed ?? 0} failed` : ''
          }${tests.commands.length ? `\n\nCommands: ${tests.commands.map((c) => `\`${c}\``).join(', ')}` : ''}`
        : '',
      report ? `## Report\n\n${clip(report.content.replace(/^#.*\n/, ''), 4000)}` : '',
      history.length
        ? `## Status history\n${history
            .map(
              (h) =>
                `- ${when(h.createdAt)} ${h.from ?? '—'} → ${h.to}${h.reason ? ` — ${clip(h.reason, 160)}` : ''} (${h.actor})`,
            )
            .join('\n')}`
        : '',
    ];
    return `${this.redact(md.filter(Boolean).join('\n\n'))}\n`;
  }

  /** Copy the handoff files (and memory) into a task worktree. */
  private copyInto(projectRoot: string, cwd: string, key: string) {
    if (!existsSync(cwd)) return;
    try {
      const dir = projectDataDirName(projectRoot);
      const from = join(projectRoot, dir);
      const to = join(cwd, dir);
      mkdirSync(join(to, TASKS_DIR), { recursive: true });
      for (const f of [PROJECT_FILE, 'memory.md', join(TASKS_DIR, `${key}.md`)])
        if (existsSync(join(from, f))) writeFileSync(join(to, f), readFileSync(join(from, f)));
    } catch (err) {
      this.d.log.warn({ err, cwd }, 'could not copy handoff files into the worktree');
    }
  }
}
