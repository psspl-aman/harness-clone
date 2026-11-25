import {
  ACTIVE_STATUSES,
  COMMAND_KEYS,
  CreateProjectInputSchema,
  Topics,
  UpdateProjectInputSchema,
  type OnboardingReport,
  type ProjectDetail,
  type ProjectSummary,
  type RequirementDto,
} from '@agentforge/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Db } from '../db/client';
import {
  errors,
  memoryEntries,
  projects,
  projectSettings,
  requirements,
  tasks,
  type ProjectCommands,
} from '../db/schema';
import type { EventBus } from '../events/bus';
import { AppError, badRequest, conflict, notFound } from '../http/errors';
import { newId } from '../lib/id';
import { normalizePath, slugify } from '../lib/paths';
import type { AttachmentStore } from './attachments';
import type { FsService } from './fs';
import { currentBranch, initRepo, isRepoRoot } from './git';
import type { GithubService } from './github';
import { analyzeProject, stackFromReport } from './onboarding/analyzer';

type ProjectRow = typeof projects.$inferSelect;

/** The requirement text when the wizard got files but no description. */
const ATTACHMENTS_ONLY_REQUIREMENT = 'Build what the attached documents describe.';

export interface ProjectServiceDeps {
  db: Db;
  bus: EventBus;
  fs: FsService;
  github: GithubService;
  attachments: AttachmentStore;
  workspaceRoot: () => string;
  log: { warn: (o: unknown, m: string) => void; error: (o: unknown, m: string) => void };
}

export class ProjectService {
  private readonly db: Db;
  private readonly onboardingInFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: ProjectServiceDeps) {
    this.db = deps.db;
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  /** Dashboard cards: every non-archived project with aggregate counters. */
  listSummaries(): ProjectSummary[] {
    const rows = this.db
      .select()
      .from(projects)
      .where(isNull(projects.archivedAt))
      .orderBy(desc(sql`coalesce(${projects.lastActivityAt}, ${projects.createdAt})`))
      .all();
    return this.summarize(rows);
  }

  /** Archived projects, most recently archived first. */
  listArchived(): ProjectSummary[] {
    const rows = this.db
      .select()
      .from(projects)
      .where(isNotNull(projects.archivedAt))
      .orderBy(desc(projects.archivedAt))
      .all();
    return this.summarize(rows);
  }

  isArchived(id: string): boolean {
    return !!this.db
      .select({ a: projects.archivedAt })
      .from(projects)
      .where(eq(projects.id, id))
      .get()?.a;
  }

  get(id: string): ProjectDetail {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw notFound('Project');
    const settings = this.db
      .select()
      .from(projectSettings)
      .where(eq(projectSettings.projectId, id))
      .get();
    return {
      ...this.summarize([row])[0]!,
      description: row.description,
      defaultBranch: row.defaultBranch,
      workingBranch: row.workingBranch,
      stackPreferences: row.stackPreferences,
      commands: row.commands,
      onboardingStatus: row.onboardingStatus,
      onboardingError: row.onboardingError,
      onboardedAt: row.onboardedAt,
      onboardingReport: row.onboardingReport ?? null,
      roleEngines: settings?.roleEngines ?? {},
      roleModels: settings?.roleModels ?? {},
      pipeline: {
        maxConcurrentTasks: settings?.maxConcurrentTasks ?? null,
        maxFixLoops: settings?.maxFixLoops ?? null,
        requireHumanReview: settings?.requireHumanReview ?? null,
        mergeStrategy: settings?.mergeStrategy ?? null,
        fallbackEnabled: settings?.fallbackEnabled ?? false,
        engineFallback: settings?.engineFallback ?? {},
        paused: settings?.pipelinePaused ?? false,
        routing: settings?.routing ?? null,
      },
    };
  }

  findByPath(path: string): { id: string; localPath: string; archivedAt: number | null } | null {
    return (
      this.db
        .select({ id: projects.id, localPath: projects.localPath, archivedAt: projects.archivedAt })
        .from(projects)
        .where(eq(projects.localPath, path))
        .get() ?? null
    );
  }

  allPaths(): { id: string; localPath: string }[] {
    return this.db.select({ id: projects.id, localPath: projects.localPath }).from(projects).all();
  }

  listRequirements(projectId: string): RequirementDto[] {
    this.assertExists(projectId);
    return (
      this.db
        .select()
        .from(requirements)
        // User requirements only; the full conversation is served by the chat endpoint.
        .where(and(eq(requirements.projectId, projectId), eq(requirements.author, 'user')))
        .orderBy(asc(requirements.createdAt))
        .all()
        .map((r) => ({
          id: r.id,
          projectId: r.projectId,
          author: r.author,
          content: r.content,
          intent: r.intent,
          version: r.version,
          createdAt: r.createdAt,
        }))
    );
  }

  // ─── Create ────────────────────────────────────────────────────────────────

  async create(raw: unknown): Promise<ProjectDetail> {
    const input = CreateProjectInputSchema.parse(raw);
    // Check wizard uploads before creating folders or repos, so a stale one fails cleanly.
    const stagedIds = input.mode === 'scratch' ? input.initialAttachmentIds : [];
    this.deps.attachments.assertStaged(stagedIds);
    let localPath: string;
    let githubRepo: string | null = null;
    let defaultBranch: string | null = null;
    let createdDir = false;

    if (input.mode === 'scratch') {
      if (input.location.kind === 'local') {
        const parent = normalizePath(input.location.parentDir);
        if (!parent) throw badRequest('Parent folder must be absolute');
        localPath = join(parent, input.location.folderName);
        await this.assertPathOk(localPath, 'scratch');
        if (!existsSync(localPath)) {
          await mkdir(localPath);
          createdDir = true;
        }
        try {
          if (!(await isRepoRoot(localPath))) await initRepo(localPath, { commitExisting: false });
        } catch (err) {
          if (createdDir) await rm(localPath, { recursive: true, force: true });
          throw new AppError(
            500,
            'GIT_INIT_FAILED',
            `Could not initialise git: ${(err as Error).message}`,
          );
        }
        defaultBranch = (await currentBranch(localPath)) ?? 'main';
      } else {
        const repo =
          input.location.repo.action === 'create'
            ? await this.deps.github.createRepo(input.location.repo)
            : await this.deps.github.getRepo(input.location.repo.fullName);
        ({ localPath } = await this.cloneIntoWorkspace(repo.fullName));
        githubRepo = repo.fullName;
        defaultBranch = repo.defaultBranch;
      }
    } else if (input.location.kind === 'local') {
      const path = normalizePath(input.location.path);
      if (!path) throw badRequest('Path must be absolute');
      localPath = path;
      await this.assertPathOk(localPath, 'existing');
      if (!(await isRepoRoot(localPath))) {
        if (!input.location.initGit) {
          throw badRequest(
            'AgentForge needs a git repository to isolate agent work — enable “Initialise git”',
          );
        }
        await initRepo(localPath, { commitExisting: true });
      }
      defaultBranch = await currentBranch(localPath);
    } else {
      const repo = await this.deps.github.getRepo(input.location.fullName);
      ({ localPath } = await this.cloneIntoWorkspace(repo.fullName));
      githubRepo = repo.fullName;
      defaultBranch = repo.defaultBranch;
    }

    const files = await this.deps.attachments.claim(localPath, stagedIds);
    const requirementText =
      input.mode === 'scratch'
        ? input.initialRequirement?.trim() || (files.length ? ATTACHMENTS_ONLY_REQUIREMENT : '')
        : '';
    const name = input.name ?? (githubRepo ? githubRepo.split('/')[1]! : basename(localPath));
    const id = newId('prj');
    const now = Date.now();
    this.db.transaction((tx) => {
      tx.insert(projects)
        .values({
          id,
          name,
          slug: this.uniqueSlug(name),
          description: input.description ?? null,
          origin: input.mode,
          source: githubRepo ? 'github' : 'local',
          localPath,
          githubRepo,
          defaultBranch,
          workingBranch: defaultBranch,
          stackPreferences:
            input.mode === 'scratch' ? input.stackPreferences?.trim() || null : null,
          onboardingStatus: 'pending',
          lastActivityAt: now,
        })
        .run();
      tx.insert(projectSettings)
        .values({ projectId: id, roleEngines: input.roleEngines ?? {} })
        .run();
      if (requirementText) {
        tx.insert(requirements)
          .values({
            id: newId('req'),
            projectId: id,
            author: 'user',
            content: requirementText,
            intent: 'generate_plan',
            attachments: files.map((f) => ({
              id: f.id,
              name: f.name,
              mime: f.mime,
              size: f.size,
              storagePath: f.path,
            })),
          })
          .run();
      }
    });

    const detail = this.get(id);
    this.deps.bus.emit('project.created', { project: this.summaryOf(id) }, [
      Topics.global,
      Topics.project(id),
    ]);
    void this.runOnboarding(id);
    return detail;
  }

  // ─── Update / delete ───────────────────────────────────────────────────────

  update(id: string, raw: unknown): ProjectDetail {
    this.assertExists(id);
    const input = UpdateProjectInputSchema.parse(raw);
    this.db.transaction((tx) => {
      const patch: Partial<typeof projects.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.stackPreferences !== undefined) patch.stackPreferences = input.stackPreferences;
      if (input.commands !== undefined) {
        const current = tx
          .select({ c: projects.commands })
          .from(projects)
          .where(eq(projects.id, id))
          .get()!.c;
        const next: ProjectCommands = { ...current };
        for (const k of COMMAND_KEYS) {
          const v = input.commands[k];
          if (v !== undefined) next[k] = v?.trim() ? v.trim() : null;
        }
        if (input.commands.services !== undefined)
          next.services = input.commands.services?.length
            ? input.commands.services.map((s) => ({
                name: s.name,
                command: s.command,
                cwd: s.cwd?.replace(/^\.\/?/, '').replace(/\/+$/, '') || null,
                port: s.port ?? null,
              }))
            : null;
        patch.commands = next;
      }
      if (Object.keys(patch).length)
        tx.update(projects).set(patch).where(eq(projects.id, id)).run();
      if (input.roleEngines !== undefined) {
        tx.update(projectSettings)
          .set({ roleEngines: input.roleEngines })
          .where(eq(projectSettings.projectId, id))
          .run();
      }
      if (input.roleModels !== undefined) {
        tx.update(projectSettings)
          .set({ roleModels: input.roleModels })
          .where(eq(projectSettings.projectId, id))
          .run();
      }
      if (input.pipeline !== undefined) {
        tx.update(projectSettings)
          .set(input.pipeline)
          .where(eq(projectSettings.projectId, id))
          .run();
      }
    });
    this.emitUpdated(id);
    return this.get(id);
  }

  /**
   * Hides the project from the dashboard and stops everything it runs, keeping all its
   * data so it can be restored. Callers stop running agents (see Orchestrator.suspendProject).
   */
  archive(id: string): ProjectDetail {
    this.assertExists(id);
    if (!this.isArchived(id)) {
      this.db.update(projects).set({ archivedAt: Date.now() }).where(eq(projects.id, id)).run();
      this.deps.bus.emit('project.archived', { projectId: id }, [
        Topics.global,
        Topics.project(id),
      ]);
    }
    return this.get(id);
  }

  /** Brings an archived project back; its tasks continue where they stopped. */
  restore(id: string): ProjectDetail {
    this.assertExists(id);
    if (!this.isArchived(id)) return this.get(id);
    // No other project can hold its folder meanwhile: local paths are unique, and attaching
    // an archived project's folder is refused with a pointer to Restore.
    this.db
      .update(projects)
      .set({ archivedAt: null, lastActivityAt: Date.now() })
      .where(eq(projects.id, id))
      .run();
    this.emitUpdated(id);
    return this.get(id);
  }

  /** Deletes the project and all its data from AgentForge for good. Files on disk are never touched. */
  delete(id: string): void {
    this.assertExists(id);
    this.db.delete(projects).where(eq(projects.id, id)).run();
    this.deps.bus.emit('project.deleted', { projectId: id }, [Topics.global, Topics.project(id)]);
  }

  // ─── Onboarding ────────────────────────────────────────────────────────────

  /** Analyse the project folder (idempotent; concurrent calls share one run). */
  runOnboarding(id: string): Promise<void> {
    const existing = this.onboardingInFlight.get(id);
    if (existing) return existing;
    const run = this.doOnboarding(id).finally(() => this.onboardingInFlight.delete(id));
    this.onboardingInFlight.set(id, run);
    return run;
  }

  /** Wait for background analyses to finish (used on shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.onboardingInFlight.values()]);
  }

  /** Resume analyses interrupted by a daemon restart. */
  resumeInterruptedOnboarding(): void {
    const stuck = this.db
      .select({ id: projects.id })
      .from(projects)
      .where(inArray(projects.onboardingStatus, ['pending', 'running']))
      .all();
    for (const { id } of stuck) void this.runOnboarding(id);
  }

  private async doOnboarding(id: string): Promise<void> {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) return;
    this.setOnboarding(id, 'running', null);
    let report: OnboardingReport;
    try {
      if (!existsSync(row.localPath)) throw new Error(`Folder not found: ${row.localPath}`);
      report = await analyzeProject(row.localPath);
    } catch (err) {
      this.deps.log.error({ err, projectId: id }, 'onboarding analysis failed');
      this.setOnboarding(id, 'failed', (err as Error).message);
      return;
    }
    if (!this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get())
      return;

    this.db.transaction((tx) => {
      const current = tx
        .select({ c: projects.commands })
        .from(projects)
        .where(eq(projects.id, id))
        .get()!.c;
      // Keep anything the user already set; only fill gaps with detected commands.
      const commands: ProjectCommands = { ...current };
      for (const k of COMMAND_KEYS)
        if (!commands[k] && report.commands[k]) commands[k] = report.commands[k]!.command;
      tx.update(projects)
        .set({
          onboardingStatus: 'done',
          onboardingError: null,
          onboardingReport: report,
          onboardedAt: Date.now(),
          stack: stackFromReport(report),
          commands,
          defaultBranch: row.defaultBranch ?? report.git.branch,
          workingBranch: row.workingBranch ?? report.git.branch,
        })
        .where(eq(projects.id, id))
        .run();
      this.writeOnboardingMemory(tx as unknown as Db, id, report);
    });
    this.deps.bus.emit('project.onboarding', { projectId: id, status: 'done', error: null }, [
      Topics.global,
      Topics.project(id),
    ]);
    this.emitUpdated(id);
  }

  /** Replace onboarding-sourced project memory with the latest analysis. */
  private writeOnboardingMemory(db: Db, projectId: string, r: OnboardingReport): void {
    db.delete(memoryEntries)
      .where(and(eq(memoryEntries.projectId, projectId), eq(memoryEntries.source, 'onboarding')))
      .run();
    const entries: {
      kind: typeof memoryEntries.$inferInsert.kind;
      title: string;
      content: string;
    }[] = [];
    const stackLines = [
      r.languages.length &&
        `Languages: ${r.languages.map((l) => `${l.name} (${l.share}%)`).join(', ')}`,
      r.frameworks.length && `Frameworks & tools: ${r.frameworks.join(', ')}`,
      r.packageManagers.length && `Package managers: ${r.packageManagers.join(', ')}`,
      r.monorepo &&
        `Monorepo (${r.monorepo.tool}): ${r.monorepo.packages.join(', ') || 'packages not detected'}`,
    ].filter(Boolean);
    if (stackLines.length)
      entries.push({ kind: 'stack', title: 'Tech stack', content: stackLines.join('\n') });
    const cmds = COMMAND_KEYS.filter((k) => r.commands[k]).map(
      (k) => `${k}: \`${r.commands[k]!.command}\` (from ${r.commands[k]!.source})`,
    );
    if (cmds.length)
      entries.push({ kind: 'command', title: 'Project commands', content: cmds.join('\n') });
    if (r.conventions.length)
      entries.push({
        kind: 'convention',
        title: 'Detected conventions',
        content: r.conventions.map((c) => `- ${c}`).join('\n'),
      });
    if (r.structure)
      entries.push({ kind: 'architecture', title: 'Folder structure', content: r.structure });
    if (r.envFiles.length) {
      entries.push({
        kind: 'pitfall',
        title: 'Environment files',
        content: `These env files exist and must never be committed or printed: ${r.envFiles.join(', ')}`,
      });
    }
    for (const e of entries) {
      db.insert(memoryEntries)
        .values({
          id: newId('mem'),
          scope: 'project',
          projectId,
          source: 'onboarding',
          tags: ['onboarding'],
          ...e,
        })
        .run();
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private setOnboarding(id: string, status: 'running' | 'failed', error: string | null) {
    this.db
      .update(projects)
      .set({ onboardingStatus: status, onboardingError: error })
      .where(eq(projects.id, id))
      .run();
    this.deps.bus.emit('project.onboarding', { projectId: id, status, error }, [
      Topics.global,
      Topics.project(id),
    ]);
    this.emitUpdated(id);
  }

  /** Record the repository's default/working branch (git init, the Git tab). */
  setBranches(
    id: string,
    b: { defaultBranch?: string | null; workingBranch?: string | null },
  ): void {
    this.assertExists(id);
    const patch: Partial<typeof projects.$inferInsert> = {};
    if (b.defaultBranch !== undefined) patch.defaultBranch = b.defaultBranch;
    if (b.workingBranch !== undefined) patch.workingBranch = b.workingBranch;
    if (!Object.keys(patch).length) return;
    this.db.update(projects).set(patch).where(eq(projects.id, id)).run();
    this.emitUpdated(id);
  }

  /** Re-broadcast a project after another service changed it. */
  touch(id: string): void {
    this.emitUpdated(id);
  }

  private emitUpdated(id: string) {
    this.deps.bus.emit('project.updated', { project: this.summaryOf(id) }, [
      Topics.global,
      Topics.project(id),
    ]);
  }

  private summaryOf(id: string): ProjectSummary {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw notFound('Project');
    return this.summarize([row])[0]!;
  }

  private assertExists(id: string) {
    if (!this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get())
      throw notFound('Project');
  }

  private async assertPathOk(path: string, mode: 'scratch' | 'existing') {
    const check = await this.deps.fs.check(path, mode);
    if (!check.ok) {
      throw check.existingProjectId
        ? conflict(check.reason ?? 'Already a project')
        : badRequest(check.reason ?? 'Invalid folder');
    }
  }

  private uniqueSlug(name: string): string {
    const base = slugify(name);
    const taken = new Set(
      this.db
        .select({ slug: projects.slug })
        .from(projects)
        .where(sql`${projects.slug} = ${base} or ${projects.slug} like ${`${base}-%`}`)
        .all()
        .map((r) => r.slug),
    );
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  /** `<workspaceRoot>/<owner>/<repo>`, suffixed when that folder is already used. */
  private async cloneIntoWorkspace(fullName: string): Promise<{ localPath: string }> {
    const [owner, repo] = fullName.split('/') as [string, string];
    const ownerDir = join(this.deps.workspaceRoot(), owner);
    await mkdir(ownerDir, { recursive: true });
    let localPath = join(ownerDir, repo);
    for (let i = 2; existsSync(localPath) && (await readdir(localPath)).length > 0; i++) {
      localPath = join(ownerDir, `${repo}-${i}`);
    }
    if (this.findByPath(localPath)) throw conflict(`${localPath} is already a project`);
    await this.deps.github.clone(fullName, localPath);
    return { localPath };
  }

  private summarize(rows: ProjectRow[]): ProjectSummary[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const taskAgg = this.db
      .select({
        projectId: tasks.projectId,
        total: sql<number>`count(*)`,
        active: sql<number>`sum(case when ${inArray(tasks.status, [...ACTIVE_STATUSES])} then 1 else 0 end)`,
        done: sql<number>`sum(case when ${tasks.status} = 'DONE' then 1 else 0 end)`,
      })
      .from(tasks)
      .where(and(inArray(tasks.projectId, ids), sql`${tasks.status} <> 'CANCELLED'`))
      .groupBy(tasks.projectId)
      .all();
    const errAgg = this.db
      .select({ projectId: errors.projectId, open: sql<number>`count(*)` })
      .from(errors)
      .where(and(inArray(errors.projectId, ids), eq(errors.status, 'open')))
      .groupBy(errors.projectId)
      .all();
    const taskMap = new Map(taskAgg.map((t) => [t.projectId, t]));
    const errMap = new Map(errAgg.map((e) => [e.projectId, e.open]));
    return rows.map((p) => {
      const t = taskMap.get(p.id);
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        origin: p.origin,
        source: p.source,
        localPath: p.localPath,
        githubRepo: p.githubRepo,
        stack: p.stack,
        runningStatus: p.runningStatus,
        taskCounts: {
          total: Number(t?.total ?? 0),
          active: Number(t?.active ?? 0),
          done: Number(t?.done ?? 0),
        },
        openErrorCount: Number(errMap.get(p.id) ?? 0),
        lastActivityAt: p.lastActivityAt,
        archivedAt: p.archivedAt,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    });
  }
}
