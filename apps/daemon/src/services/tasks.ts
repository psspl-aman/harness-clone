import {
  assertTransition,
  COMPLEXITIES,
  DEFAULT_ESTIMATE_MS,
  ESTIMATE_MIN_SAMPLES,
  type Complexity,
  CreateTaskInputSchema,
  InvalidTransitionError,
  MergeTasksInputSchema,
  ReorderTasksInputSchema,
  SetDependenciesInputSchema,
  SplitTaskInputSchema,
  SubtaskInputSchema,
  Topics,
  UpdatePlanInputSchema,
  UpdateSubtaskInputSchema,
  UpdateTaskInputSchema,
  type PlanBoardDto,
  type PlanDto,
  type PlannerTask,
  type TaskDto,
  type TaskStatus,
  type TaskStatusChangeDto,
  type ActivityItemDto,
  type PmsProvider,
  type PausedTaskDto,
} from '@agentforge/shared';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  agentRuns,
  errors,
  plans,
  pmsConnections,
  projects,
  subtasks,
  taskDependencies,
  tasks,
  taskStatusHistory,
} from '../db/schema';
import type { EventBus } from '../events/bus';
import { AppError, badRequest, conflict, notFound } from '../http/errors';
import { newId } from '../lib/id';

type TaskRow = typeof tasks.$inferSelect;
type PlanRow = typeof plans.$inferSelect;

/** Statuses in which a task's definition may still be edited. */
const EDITABLE: readonly TaskStatus[] = [
  'DRAFT',
  'APPROVED',
  'BLOCKED',
  'NEEDS_HUMAN',
  'FAILED',
  'CANCELLED',
];
const DELETABLE: readonly TaskStatus[] = ['DRAFT', 'APPROVED', 'BLOCKED', 'CANCELLED'];

/** "todo-app" → "TA", "storefront" → "STO". */
export function keyPrefix(slug: string): string {
  const words = slug.split('-').filter(Boolean);
  const p =
    words.length >= 2
      ? words
          .slice(0, 3)
          .map((w) => w[0])
          .join('')
      : (words[0] ?? 'af').slice(0, 3);
  return p.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'AF';
}

export const toPlanDto = (p: PlanRow): PlanDto => ({
  id: p.id,
  projectId: p.projectId,
  requirementId: p.requirementId,
  version: p.version,
  status: p.status,
  goal: p.goal,
  scope: p.scope,
  outOfScope: p.outOfScope,
  architectureNotes: p.architectureNotes,
  risks: p.risks,
  assumptions: p.assumptions,
  approvedAt: p.approvedAt,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

/**
 * Plans and tasks: everything behind the human approval gate — creation from
 * planner output, editing, dependencies (cycle-checked), split/merge,
 * ordering, subtasks and status transitions with full history.
 */
export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
  ) {}

  // ─── Reads ─────────────────────────────────────────────────────────────────

  board(projectId: string): PlanBoardDto {
    const planRows = this.db
      .select()
      .from(plans)
      .where(and(eq(plans.projectId, projectId), ne(plans.status, 'SUPERSEDED')))
      .orderBy(desc(plans.version))
      .all();
    const taskRows = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(asc(tasks.orderIndex), asc(tasks.createdAt))
      .all();
    return { plans: planRows.map(toPlanDto), tasks: this.toDtos(taskRows) };
  }

  get(taskId: string): TaskDto {
    return this.toDtos([this.row(taskId)])[0]!;
  }

  plan(planId: string): PlanDto {
    return toPlanDto(this.planRow(planId));
  }

  latestPlan(projectId: string): PlanRow | null {
    return (
      this.db
        .select()
        .from(plans)
        .where(and(eq(plans.projectId, projectId), ne(plans.status, 'SUPERSEDED')))
        .orderBy(desc(plans.version))
        .get() ?? null
    );
  }

  /** Tasks paused for quota or login across all projects (manual pauses are the user's own). */
  pausedEverywhere(): PausedTaskDto[] {
    return this.db
      .select({ t: tasks, projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(inArray(tasks.status, ['PAUSED_QUOTA', 'PAUSED_AUTH']))
      .orderBy(asc(tasks.resumeAt))
      .all()
      .map(({ t, projectName }) => ({
        id: t.id,
        key: t.key,
        title: t.title,
        projectId: t.projectId,
        projectName,
        status: t.status as PausedTaskDto['status'],
        statusReason: t.statusReason,
        resumeAt: t.resumeAt,
      }));
  }

  /** Latest status changes across a project's tasks, newest first. */
  activity(projectId: string, limit = 100): ActivityItemDto[] {
    return this.db
      .select({ h: taskStatusHistory, key: tasks.key, title: tasks.title })
      .from(taskStatusHistory)
      .innerJoin(tasks, eq(tasks.id, taskStatusHistory.taskId))
      .where(eq(tasks.projectId, projectId))
      .orderBy(desc(taskStatusHistory.id))
      .limit(limit)
      .all()
      .map(({ h, key, title }) => ({
        id: h.id,
        taskId: h.taskId,
        taskKey: key,
        taskTitle: title,
        from: h.fromStatus,
        to: h.toStatus,
        reason: h.reason,
        actor: h.actor,
        createdAt: h.createdAt,
      }));
  }

  history(taskId: string): TaskStatusChangeDto[] {
    this.row(taskId);
    return this.db
      .select()
      .from(taskStatusHistory)
      .where(eq(taskStatusHistory.taskId, taskId))
      .orderBy(asc(taskStatusHistory.id))
      .all()
      .map((h) => ({
        from: h.fromStatus,
        to: h.toStatus,
        reason: h.reason,
        actor: h.actor,
        createdAt: h.createdAt,
      }));
  }

  tasksOfPlan(planId: string): TaskDto[] {
    return this.toDtos(
      this.db
        .select()
        .from(tasks)
        .where(eq(tasks.planId, planId))
        .orderBy(asc(tasks.orderIndex))
        .all(),
    );
  }

  // ─── Plans ─────────────────────────────────────────────────────────────────

  /** New plan version. A previous *draft* plan (and its draft tasks) is superseded. */
  createPlan(
    projectId: string,
    requirementId: string | null,
    data: Omit<typeof plans.$inferInsert, 'id' | 'projectId' | 'version' | 'requirementId'>,
  ): PlanRow {
    const prev = this.db
      .select()
      .from(plans)
      .where(eq(plans.projectId, projectId))
      .orderBy(desc(plans.version))
      .get();
    const id = newId('plan');
    this.db.transaction((tx) => {
      const drafts = tx
        .select()
        .from(plans)
        .where(and(eq(plans.projectId, projectId), eq(plans.status, 'DRAFT')))
        .all();
      for (const d of drafts) {
        tx.update(plans).set({ status: 'SUPERSEDED' }).where(eq(plans.id, d.id)).run();
        const dropped = tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.planId, d.id), eq(tasks.status, 'DRAFT')))
          .all();
        if (dropped.length)
          tx.delete(tasks)
            .where(
              inArray(
                tasks.id,
                dropped.map((t) => t.id),
              ),
            )
            .run();
        for (const t of dropped)
          this.bus.emit('task.deleted', { projectId, taskId: t.id }, [Topics.project(projectId)]);
      }
      tx.insert(plans)
        .values({
          ...data,
          id,
          projectId,
          requirementId,
          version: (prev?.version ?? 0) + 1,
          status: 'DRAFT',
        })
        .run();
    });
    const plan = this.planRow(id);
    this.emitPlan(plan);
    return plan;
  }

  updatePlan(planId: string, raw: unknown): PlanDto {
    const input = UpdatePlanInputSchema.parse(raw);
    const plan = this.planRow(planId);
    if (plan.status === 'SUPERSEDED') throw conflict('This plan was superseded');
    if (Object.keys(input).length)
      this.db.update(plans).set(input).where(eq(plans.id, planId)).run();
    const updated = this.planRow(planId);
    this.emitPlan(updated);
    return toPlanDto(updated);
  }

  /**
   * Approve draft tasks (all of the plan's drafts, or the given subset).
   * The plan becomes APPROVED once it has no draft tasks left.
   */
  approvePlan(
    planId: string,
    taskIds?: string[],
    by: { reason: string; actor: string } = { reason: 'Approved by you', actor: 'user' },
  ): PlanBoardDto {
    const plan = this.planRow(planId);
    if (plan.status === 'SUPERSEDED') throw conflict('This plan was superseded');
    const drafts = this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.planId, planId), eq(tasks.status, 'DRAFT')))
      .all();
    const chosen = taskIds ? drafts.filter((t) => taskIds.includes(t.id)) : drafts;
    if (taskIds && chosen.length !== taskIds.length)
      throw badRequest('Some tasks are not draft tasks of this plan');
    for (const t of chosen) this.transition(t.id, 'APPROVED', by.reason, by.actor);
    this.syncPlanApproval(planId);
    return this.board(plan.projectId);
  }

  // ─── Task creation ─────────────────────────────────────────────────────────

  /**
   * Insert planner tasks. `dependsOn` may reference refs from the same batch
   * or keys of existing project tasks. Returns created tasks in order.
   */
  createFromPlanner(
    projectId: string,
    planId: string,
    requirementId: string | null,
    items: PlannerTask[],
  ): TaskDto[] {
    const existing = this.db
      .select({ id: tasks.id, key: tasks.key })
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .all();
    const byKey = new Map(existing.map((t) => [t.key.toUpperCase(), t.id]));
    const refToId = new Map<string, string>();
    let order = this.maxOrder(projectId);
    const created: string[] = [];
    this.db.transaction((tx) => {
      for (const item of items) {
        const id = this.insertTask(tx as unknown as Db, projectId, {
          planId,
          requirementId,
          title: item.title,
          description: item.description,
          type: item.type,
          priority: item.priority,
          complexity: item.complexity,
          acceptanceCriteria: item.acceptanceCriteria,
          affectedAreas: item.affectedAreas,
          roleEngines: item.suggestedEngines,
          orderIndex: ++order,
          origin: 'planner',
        });
        refToId.set(item.ref, id);
        created.push(id);
        item.subtasks.forEach((title, i) =>
          tx
            .insert(subtasks)
            .values({ id: newId('sub'), taskId: id, title, orderIndex: i })
            .run(),
        );
      }
      items.forEach((item, i) => {
        const deps = new Set<string>();
        for (const d of item.dependsOn) {
          const depId = refToId.get(d) ?? byKey.get(d.toUpperCase());
          if (depId && depId !== created[i]) deps.add(depId);
        }
        for (const dep of deps)
          tx.insert(taskDependencies).values({ taskId: created[i]!, dependsOnTaskId: dep }).run();
      });
    });
    const dtos = this.toDtos(this.db.select().from(tasks).where(inArray(tasks.id, created)).all());
    const ordered = created.map((id) => dtos.find((d) => d.id === id)!);
    for (const t of ordered) this.emitTask(t);
    return ordered;
  }

  create(projectId: string, planId: string | null, raw: unknown): TaskDto {
    const input = CreateTaskInputSchema.parse(raw);
    if (planId) {
      const plan = this.planRow(planId);
      if (plan.projectId !== projectId) throw badRequest('Plan belongs to another project');
    }
    let id = '';
    this.db.transaction((tx) => {
      id = this.insertTask(tx as unknown as Db, projectId, {
        planId,
        requirementId: null,
        title: input.title,
        description: input.description,
        type: input.type,
        priority: input.priority,
        complexity: input.complexity,
        acceptanceCriteria: input.acceptanceCriteria,
        affectedAreas: input.affectedAreas,
        roleEngines: input.roleEngines,
        orderIndex: this.maxOrder(projectId) + 1,
        origin: 'manual',
      });
      input.subtasks.forEach((title, i) =>
        tx
          .insert(subtasks)
          .values({ id: newId('sub'), taskId: id, title, orderIndex: i })
          .run(),
      );
    });
    if (input.dependsOn.length) this.setDependencies(id, { dependsOn: input.dependsOn });
    if (planId) this.reopenPlan(planId);
    const dto = this.get(id);
    this.emitTask(dto);
    return dto;
  }

  // ─── Editing ───────────────────────────────────────────────────────────────

  update(taskId: string, raw: unknown): TaskDto {
    const input = UpdateTaskInputSchema.parse(raw);
    // Reassigning engines or models is allowed at any time (it applies from the next step);
    // the task definition is locked while an agent works on it.
    const onlyEngines = Object.keys(input).every((k) => k === 'roleEngines' || k === 'roleModels');
    const row = onlyEngines ? this.row(taskId) : this.editableRow(taskId);
    if (Object.keys(input).length)
      this.db.update(tasks).set(input).where(eq(tasks.id, row.id)).run();
    const dto = this.get(taskId);
    this.emitTask(dto);
    return dto;
  }

  /** Replace a task's definition (planner regeneration), keeping id, key and links. */
  replaceDefinition(taskId: string, item: PlannerTask): TaskDto {
    this.editableRow(taskId);
    this.db.transaction((tx) => {
      tx.update(tasks)
        .set({
          title: item.title,
          description: item.description,
          type: item.type,
          priority: item.priority,
          complexity: item.complexity,
          acceptanceCriteria: item.acceptanceCriteria,
          affectedAreas: item.affectedAreas,
          roleEngines: item.suggestedEngines,
        })
        .where(eq(tasks.id, taskId))
        .run();
      tx.delete(subtasks).where(eq(subtasks.taskId, taskId)).run();
      item.subtasks.forEach((title, i) =>
        tx
          .insert(subtasks)
          .values({ id: newId('sub'), taskId, title, orderIndex: i })
          .run(),
      );
    });
    const dto = this.get(taskId);
    this.emitTask(dto);
    return dto;
  }

  delete(taskId: string): void {
    const row = this.row(taskId);
    if (!DELETABLE.includes(row.status))
      throw conflict(
        `A ${row.status.toLowerCase().replace(/_/g, ' ')} task can't be deleted — cancel it first`,
      );
    this.db.delete(tasks).where(eq(tasks.id, taskId)).run();
    this.bus.emit('task.deleted', { projectId: row.projectId, taskId }, [
      Topics.project(row.projectId),
    ]);
    for (const t of this.dependents(taskId)) this.emitTask(this.get(t));
    if (row.planId) this.syncPlanApproval(row.planId);
  }

  setDependencies(taskId: string, raw: unknown): TaskDto {
    const { dependsOn } = SetDependenciesInputSchema.parse(raw);
    const row = this.editableRow(taskId);
    const unique = [...new Set(dependsOn)];
    if (unique.includes(taskId)) throw badRequest('A task cannot depend on itself');
    if (unique.length) {
      const deps = this.db
        .select({ id: tasks.id, projectId: tasks.projectId })
        .from(tasks)
        .where(inArray(tasks.id, unique))
        .all();
      if (deps.length !== unique.length || deps.some((d) => d.projectId !== row.projectId))
        throw badRequest('Dependencies must be tasks of the same project');
      const graph = this.graph(row.projectId);
      graph.set(taskId, new Set(unique));
      const cycle = findCycle(graph, taskId);
      if (cycle)
        throw badRequest(
          `That would create a dependency cycle: ${cycle.map((id) => this.row(id).key).join(' → ')}`,
        );
    }
    this.db.transaction((tx) => {
      tx.delete(taskDependencies).where(eq(taskDependencies.taskId, taskId)).run();
      for (const d of unique)
        tx.insert(taskDependencies).values({ taskId, dependsOnTaskId: d }).run();
    });
    const dto = this.get(taskId);
    this.emitTask(dto);
    return dto;
  }

  /** Split one task into N: the first part keeps the original task; dependents wait for every part. */
  split(taskId: string, raw: unknown): TaskDto[] {
    const { parts } = SplitTaskInputSchema.parse(raw);
    const row = this.editableRow(taskId);
    const deps = this.depsOf(taskId);
    const dependents = this.dependents(taskId);
    const ids = [taskId];
    this.db.transaction((tx) => {
      const [first, ...rest] = parts;
      tx.update(tasks)
        .set({ title: first!.title, description: first!.description ?? row.description })
        .where(eq(tasks.id, taskId))
        .run();
      // Make room right after the original task.
      tx.update(tasks)
        .set({ orderIndex: sql`${tasks.orderIndex} + ${rest.length}` })
        .where(
          and(eq(tasks.projectId, row.projectId), sql`${tasks.orderIndex} > ${row.orderIndex}`),
        )
        .run();
      rest.forEach((p, i) => {
        const id = this.insertTask(tx as unknown as Db, row.projectId, {
          planId: row.planId,
          requirementId: row.requirementId,
          title: p.title,
          description: p.description ?? '',
          type: row.type,
          priority: row.priority,
          complexity: row.complexity,
          acceptanceCriteria: [],
          affectedAreas: row.affectedAreas,
          roleEngines: row.roleEngines,
          orderIndex: row.orderIndex + i + 1,
          origin: row.origin,
          status: row.status === 'APPROVED' ? 'DRAFT' : row.status,
        });
        ids.push(id);
        for (const d of deps)
          tx.insert(taskDependencies).values({ taskId: id, dependsOnTaskId: d }).run();
        for (const dep of dependents)
          tx.insert(taskDependencies).values({ taskId: dep, dependsOnTaskId: id }).run();
      });
    });
    if (row.planId) this.reopenPlan(row.planId);
    const out = ids.map((id) => this.get(id));
    for (const t of [...out, ...dependents.map((d) => this.get(d))]) this.emitTask(t);
    return out;
  }

  /** Merge tasks into the first one: texts, criteria, areas and subtasks are combined. */
  merge(raw: unknown): TaskDto {
    const { taskIds, title } = MergeTasksInputSchema.parse(raw);
    const rows = taskIds.map((id) => this.editableRow(id));
    if (new Set(rows.map((r) => r.projectId)).size > 1)
      throw badRequest('Tasks belong to different projects');
    const [target, ...others] = rows as [TaskRow, ...TaskRow[]];
    const otherIds = new Set(others.map((o) => o.id));
    const allIds = new Set(taskIds);
    const deps = new Set(taskIds.flatMap((id) => this.depsOf(id)).filter((d) => !allIds.has(d)));
    const dependents = new Set(
      taskIds.flatMap((id) => this.dependents(id)).filter((d) => !allIds.has(d)),
    );
    const mergedStatus: TaskStatus = rows.some((r) => r.status === 'DRAFT')
      ? 'DRAFT'
      : target.status;
    this.db.transaction((tx) => {
      tx.update(tasks)
        .set({
          title: title ?? target.title,
          description: rows
            .map((r) => (rows.length > 1 ? `### ${r.title}\n\n${r.description}` : r.description))
            .join('\n\n')
            .slice(0, 8000),
          acceptanceCriteria: [...new Set(rows.flatMap((r) => r.acceptanceCriteria))].slice(0, 20),
          affectedAreas: [...new Set(rows.flatMap((r) => r.affectedAreas))].slice(0, 30),
          status: mergedStatus,
        })
        .where(eq(tasks.id, target.id))
        .run();
      if (mergedStatus !== target.status) {
        tx.insert(taskStatusHistory)
          .values({
            taskId: target.id,
            fromStatus: target.status,
            toStatus: mergedStatus,
            reason: 'Merged with draft tasks',
            actor: 'user',
          })
          .run();
      }
      if (others.length) {
        tx.update(subtasks)
          .set({ taskId: target.id })
          .where(inArray(subtasks.taskId, [...otherIds]))
          .run();
        tx.delete(tasks)
          .where(inArray(tasks.id, [...otherIds]))
          .run();
      }
      tx.delete(taskDependencies).where(eq(taskDependencies.taskId, target.id)).run();
      for (const d of deps)
        tx.insert(taskDependencies).values({ taskId: target.id, dependsOnTaskId: d }).run();
      for (const dep of dependents)
        tx.insert(taskDependencies)
          .values({ taskId: dep, dependsOnTaskId: target.id })
          .onConflictDoNothing()
          .run();
    });
    for (const id of otherIds)
      this.bus.emit('task.deleted', { projectId: target.projectId, taskId: id }, [
        Topics.project(target.projectId),
      ]);
    const dto = this.get(target.id);
    this.emitTask(dto);
    for (const d of dependents) this.emitTask(this.get(d));
    if (target.planId) this.syncPlanApproval(target.planId);
    return dto;
  }

  reorder(projectId: string, raw: unknown): TaskDto[] {
    const { taskIds } = ReorderTasksInputSchema.parse(raw);
    const rows = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), inArray(tasks.id, taskIds)))
      .all();
    if (rows.length !== new Set(taskIds).size) throw badRequest('Unknown tasks in reorder');
    this.db.transaction((tx) =>
      taskIds.forEach((id, i) =>
        tx
          .update(tasks)
          .set({ orderIndex: i + 1 })
          .where(eq(tasks.id, id))
          .run(),
      ),
    );
    const out = this.toDtos(this.db.select().from(tasks).where(inArray(tasks.id, taskIds)).all());
    for (const t of out) this.emitTask(t);
    return out;
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  transition(taskId: string, to: TaskStatus, reason: string | null, actor: string): TaskDto {
    const row = this.row(taskId);
    try {
      assertTransition(row.status, to, row.resumeToStatus ?? undefined);
    } catch (err) {
      if (err instanceof InvalidTransitionError)
        throw new AppError(
          409,
          'INVALID_TRANSITION',
          `Can't move ${row.key} from ${row.status} to ${to}`,
        );
      throw err;
    }
    this.db.transaction((tx) => {
      tx.update(tasks).set({ status: to, statusReason: reason }).where(eq(tasks.id, taskId)).run();
      tx.insert(taskStatusHistory)
        .values({ taskId, fromStatus: row.status, toStatus: to, reason, actor })
        .run();
    });
    this.bus.emit(
      'task.status_changed',
      { projectId: row.projectId, taskId, from: row.status, to, reason },
      [Topics.project(row.projectId), Topics.task(taskId)],
    );
    const dto = this.get(taskId);
    this.emitTask(dto);
    return dto;
  }

  approve(taskId: string, by = { reason: 'Approved by you', actor: 'user' }): TaskDto {
    const dto = this.transition(taskId, 'APPROVED', by.reason, by.actor);
    if (dto.planId) this.syncPlanApproval(dto.planId);
    return dto;
  }

  unapprove(taskId: string): TaskDto {
    const dto = this.transition(taskId, 'DRAFT', 'Moved back to draft', 'user');
    if (dto.planId) this.reopenPlan(dto.planId);
    return dto;
  }

  // ─── Subtasks ──────────────────────────────────────────────────────────────

  /**
   * Tick subtasks off for the agents (1-based positions, or all of them). Only
   * ever marks them done — never unticks what you ticked. Works while the task
   * is running, unlike the editing endpoints.
   */
  completeSubtasks(taskId: string, which: number[] | 'all'): number {
    const rows = this.db
      .select()
      .from(subtasks)
      .where(eq(subtasks.taskId, taskId))
      .orderBy(asc(subtasks.orderIndex))
      .all();
    const ids = rows
      .filter((r, i) => !r.done && (which === 'all' || which.includes(i + 1)))
      .map((r) => r.id);
    if (!ids.length) return 0;
    this.db.update(subtasks).set({ done: true }).where(inArray(subtasks.id, ids)).run();
    this.touch(taskId);
    return ids.length;
  }

  addSubtask(taskId: string, raw: unknown): TaskDto {
    const { title } = SubtaskInputSchema.parse(raw);
    this.editableRow(taskId);
    const max = this.db
      .select({ m: sql<number>`coalesce(max(${subtasks.orderIndex}), -1)` })
      .from(subtasks)
      .where(eq(subtasks.taskId, taskId))
      .get()!.m;
    this.db
      .insert(subtasks)
      .values({ id: newId('sub'), taskId, title, orderIndex: Number(max) + 1 })
      .run();
    const dto = this.get(taskId);
    this.emitTask(dto);
    return dto;
  }

  updateSubtask(subtaskId: string, raw: unknown): TaskDto {
    const input = UpdateSubtaskInputSchema.parse(raw);
    const sub = this.db.select().from(subtasks).where(eq(subtasks.id, subtaskId)).get();
    if (!sub) throw notFound('Subtask');
    if (Object.keys(input).length)
      this.db.update(subtasks).set(input).where(eq(subtasks.id, subtaskId)).run();
    const dto = this.get(sub.taskId);
    this.emitTask(dto);
    return dto;
  }

  deleteSubtask(subtaskId: string): TaskDto {
    const sub = this.db.select().from(subtasks).where(eq(subtasks.id, subtaskId)).get();
    if (!sub) throw notFound('Subtask');
    this.db.delete(subtasks).where(eq(subtasks.id, subtaskId)).run();
    const dto = this.get(sub.taskId);
    this.emitTask(dto);
    return dto;
  }

  // ─── Orchestrator support ──────────────────────────────────────────────────

  /** Re-broadcast a task after the orchestrator changed pipeline fields directly. */
  touch(taskId: string): TaskDto {
    const dto = this.get(taskId);
    this.emitTask(dto);
    return dto;
  }

  /** A ticket imported from a PMS: lands as a draft, linked to its source. */
  createImported(
    projectId: string,
    v: {
      title: string;
      description: string;
      type: TaskDto['type'];
      connectionId: string;
      externalId: string;
      externalUrl: string | null;
      externalUpdatedAt: number | null;
      priority?: TaskDto['priority'];
      complexity?: TaskDto['complexity'];
      acceptanceCriteria?: string[];
    },
  ): TaskDto {
    const plan = this.latestPlan(projectId);
    let id = '';
    this.db.transaction((tx) => {
      id = this.insertTask(tx as unknown as Db, projectId, {
        planId: plan?.id ?? null,
        requirementId: null,
        title: v.title,
        description: v.description,
        type: v.type,
        priority: v.priority ?? 'medium',
        complexity: v.complexity ?? 'm',
        acceptanceCriteria: v.acceptanceCriteria ?? [],
        affectedAreas: [],
        roleEngines: {},
        orderIndex: this.maxOrder(projectId) + 1,
        origin: 'pms',
        status: 'DRAFT',
        pipelineState: {},
        pmsConnectionId: v.connectionId,
        externalId: v.externalId,
        externalUrl: v.externalUrl,
        externalUpdatedAt: v.externalUpdatedAt,
      });
    });
    if (plan) this.syncPlanApproval(plan.id);
    const dto = this.get(id);
    this.emitTask(dto);
    return dto;
  }

  /** Raw row lookup for a PMS ticket (null if never imported). */
  findImported(connectionId: string, externalId: string): TaskRow | null {
    return (
      this.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.pmsConnectionId, connectionId), eq(tasks.externalId, externalId)))
        .get() ?? null
    );
  }

  /** Apply PMS-side fields (and pipeline-state patch) to an imported task without status checks. */
  updateImported(
    taskId: string,
    v: Partial<
      Pick<
        TaskRow,
        | 'title'
        | 'description'
        | 'externalUrl'
        | 'externalUpdatedAt'
        | 'priority'
        | 'complexity'
        | 'type'
        | 'acceptanceCriteria'
      >
    >,
    state?: Partial<TaskRow['pipelineState']>,
  ): TaskDto {
    const row = this.row(taskId);
    this.db
      .update(tasks)
      .set({ ...v, ...(state ? { pipelineState: { ...row.pipelineState, ...state } } : {}) })
      .where(eq(tasks.id, taskId))
      .run();
    return this.touch(taskId);
  }

  /** System-created follow-up task (e.g. conflict resolution), already approved. */
  createFollowUp(
    projectId: string,
    planId: string | null,
    v: {
      title: string;
      description: string;
      type: TaskDto['type'];
      priority: TaskDto['priority'];
      acceptanceCriteria: string[];
      roleEngines: TaskDto['roleEngines'];
      origin: 'conflict' | 'error';
      pipelineState: typeof tasks.$inferInsert.pipelineState;
      branchName?: string;
    },
  ): TaskDto {
    let id = '';
    this.db.transaction((tx) => {
      id = this.insertTask(tx as unknown as Db, projectId, {
        planId,
        requirementId: null,
        title: v.title,
        description: v.description,
        type: v.type,
        priority: v.priority,
        complexity: 's',
        acceptanceCriteria: v.acceptanceCriteria,
        affectedAreas: [],
        roleEngines: v.roleEngines,
        orderIndex: this.maxOrder(projectId) + 1,
        origin: v.origin,
        status: 'APPROVED',
        pipelineState: v.pipelineState,
        branchName: v.branchName ?? null,
      });
    });
    const dto = this.get(id);
    this.emitTask(dto);
    return dto;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private insertTask(
    tx: Db,
    projectId: string,
    v: Omit<typeof tasks.$inferInsert, 'id' | 'projectId' | 'key'> & { status?: TaskStatus },
  ): string {
    const project = tx
      .select({ slug: projects.slug, seq: projects.nextTaskSeq })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!project) throw notFound('Project');
    tx.update(projects)
      .set({ nextTaskSeq: project.seq + 1, lastActivityAt: Date.now() })
      .where(eq(projects.id, projectId))
      .run();
    const id = newId('tsk');
    const status = v.status ?? 'DRAFT';
    tx.insert(tasks)
      .values({ ...v, status, id, projectId, key: `${keyPrefix(project.slug)}-${project.seq}` })
      .run();
    tx.insert(taskStatusHistory)
      .values({
        taskId: id,
        fromStatus: null,
        toStatus: status,
        reason:
          v.origin === 'planner'
            ? 'Proposed by the Planner'
            : v.origin === 'conflict'
              ? 'Created to resolve merge conflicts'
              : v.origin === 'error'
                ? 'Created to fix a detected error'
                : v.origin === 'pms'
                  ? 'Imported from the issue tracker'
                  : 'Created by you',
        actor:
          v.origin === 'planner'
            ? 'planner'
            : v.origin === 'conflict' || v.origin === 'error'
              ? 'orchestrator'
              : v.origin === 'pms'
                ? 'pms'
                : 'user',
      })
      .run();
    return id;
  }

  /** Recompute a plan's DRAFT/APPROVED status from its tasks. */
  syncPlanApproval(planId: string) {
    const plan = this.planRow(planId);
    if (plan.status === 'SUPERSEDED') return;
    const drafts = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.planId, planId), eq(tasks.status, 'DRAFT')))
      .all();
    const total = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.planId, planId))
      .all();
    const next = total.length > 0 && drafts.length === 0 ? 'APPROVED' : 'DRAFT';
    if (next !== plan.status) {
      this.db
        .update(plans)
        .set({ status: next, approvedAt: next === 'APPROVED' ? Date.now() : null })
        .where(eq(plans.id, planId))
        .run();
      this.emitPlan(this.planRow(planId));
    }
  }

  private reopenPlan(planId: string) {
    this.syncPlanApproval(planId);
  }

  private maxOrder(projectId: string): number {
    return Number(
      this.db
        .select({ m: sql<number>`coalesce(max(${tasks.orderIndex}), 0)` })
        .from(tasks)
        .where(eq(tasks.projectId, projectId))
        .get()!.m,
    );
  }

  private depsOf(taskId: string): string[] {
    return this.db
      .select({ d: taskDependencies.dependsOnTaskId })
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, taskId))
      .all()
      .map((r) => r.d);
  }

  private dependents(taskId: string): string[] {
    return this.db
      .select({ t: taskDependencies.taskId })
      .from(taskDependencies)
      .where(eq(taskDependencies.dependsOnTaskId, taskId))
      .all()
      .map((r) => r.t);
  }

  private graph(projectId: string): Map<string, Set<string>> {
    const rows = this.db
      .select({ t: taskDependencies.taskId, d: taskDependencies.dependsOnTaskId })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .where(eq(tasks.projectId, projectId))
      .all();
    const g = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!g.has(r.t)) g.set(r.t, new Set());
      g.get(r.t)!.add(r.d);
    }
    return g;
  }

  private row(taskId: string): TaskRow {
    const row = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row) throw notFound('Task');
    return row;
  }

  private editableRow(taskId: string): TaskRow {
    const row = this.row(taskId);
    if (!EDITABLE.includes(row.status))
      throw conflict(
        `${row.key} is ${row.status.toLowerCase().replace(/_/g, ' ')} — pause or cancel it before editing`,
      );
    return row;
  }

  private planRow(planId: string): PlanRow {
    const p = this.db.select().from(plans).where(eq(plans.id, planId)).get();
    if (!p) throw notFound('Plan');
    return p;
  }

  private estimateCache: { at: number; medians: Map<Complexity, number> } | null = null;

  /**
   * Median agent time of finished tasks per complexity (all projects, most recent
   * 200), used as the estimate once there are enough samples. Cached briefly.
   */
  private learnedEstimates(): Map<Complexity, number> {
    if (this.estimateCache && Date.now() - this.estimateCache.at < 60_000)
      return this.estimateCache.medians;
    const rows = this.db
      .select({
        complexity: tasks.complexity,
        spent: sql<number>`sum(coalesce(${agentRuns.durationMs}, 0))`,
      })
      .from(tasks)
      .innerJoin(agentRuns, eq(agentRuns.taskId, tasks.id))
      .where(eq(tasks.status, 'DONE'))
      .groupBy(tasks.id)
      .orderBy(desc(tasks.updatedAt))
      .limit(200)
      .all();
    const medians = new Map<Complexity, number>();
    for (const c of COMPLEXITIES) {
      const xs = rows
        .filter((r) => r.complexity === c && Number(r.spent) > 0)
        .map((r) => Number(r.spent))
        .sort((a, b) => a - b);
      if (xs.length >= ESTIMATE_MIN_SAMPLES) {
        const mid = Math.floor(xs.length / 2);
        medians.set(c, xs.length % 2 ? xs[mid]! : Math.round((xs[mid - 1]! + xs[mid]!) / 2));
      }
    }
    this.estimateCache = { at: Date.now(), medians };
    return medians;
  }

  private toDtos(rows: TaskRow[]): TaskDto[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const medians = this.learnedEstimates();
    const usage = new Map(
      this.db
        .select({
          taskId: agentRuns.taskId,
          tokens: sql<number>`sum(${agentRuns.inputTokens} + ${agentRuns.outputTokens} + ${agentRuns.cacheReadTokens} + ${agentRuns.cacheWriteTokens})`,
          cost: sql<number>`sum(${agentRuns.costUsd})`,
          spent: sql<number>`sum(coalesce(${agentRuns.durationMs}, 0))`,
          runningSince: sql<
            number | null
          >`max(case when ${agentRuns.status} = 'RUNNING' then ${agentRuns.startedAt} end)`,
          startedAt: sql<number | null>`min(${agentRuns.startedAt})`,
          finishedAt: sql<number | null>`max(${agentRuns.finishedAt})`,
        })
        .from(agentRuns)
        .where(inArray(agentRuns.taskId, ids))
        .groupBy(agentRuns.taskId)
        .all()
        .map((u) => [u.taskId, u]),
    );
    const keys = new Map(
      this.db
        .select({ id: tasks.id, key: tasks.key })
        .from(tasks)
        .where(eq(tasks.projectId, rows[0]!.projectId))
        .all()
        .map((t) => [t.id, t.key]),
    );
    const deps = this.db
      .select()
      .from(taskDependencies)
      .where(inArray(taskDependencies.taskId, ids))
      .all();
    const subs = this.db
      .select()
      .from(subtasks)
      .where(inArray(subtasks.taskId, ids))
      .orderBy(asc(subtasks.orderIndex))
      .all();
    const errCounts = new Map(
      this.db
        .select({ taskId: errors.taskId, n: sql<number>`count(*)` })
        .from(errors)
        .where(and(inArray(errors.taskId, ids), eq(errors.status, 'open')))
        .groupBy(errors.taskId)
        .all()
        .map((e) => [e.taskId, Number(e.n)]),
    );
    const connIds = [
      ...new Set(rows.map((r) => r.pmsConnectionId).filter((x): x is string => !!x)),
    ];
    const providers = new Map(
      connIds.length
        ? this.db
            .select({ id: pmsConnections.id, provider: pmsConnections.provider })
            .from(pmsConnections)
            .where(inArray(pmsConnections.id, connIds))
            .all()
            .map((c) => [c.id, c.provider as PmsProvider])
        : [],
    );
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      planId: r.planId,
      requirementId: r.requirementId,
      key: r.key,
      title: r.title,
      description: r.description,
      type: r.type,
      priority: r.priority,
      complexity: r.complexity,
      status: r.status,
      statusReason: r.statusReason,
      acceptanceCriteria: r.acceptanceCriteria,
      affectedAreas: r.affectedAreas,
      roleEngines: r.roleEngines,
      roleModels: r.roleModels,
      orderIndex: r.orderIndex,
      dependsOn: deps.filter((d) => d.taskId === r.id).map((d) => d.dependsOnTaskId),
      subtasks: subs
        .filter((s) => s.taskId === r.id)
        .map((s) => ({ id: s.id, title: s.title, done: s.done, orderIndex: s.orderIndex })),
      origin: r.origin,
      openErrors: errCounts.get(r.id) ?? 0,
      external:
        r.pmsConnectionId && r.externalId
          ? {
              connectionId: r.pmsConnectionId,
              provider: r.pmsConnectionId.startsWith('sht_')
                ? ('sheet' as const)
                : (providers.get(r.pmsConnectionId) ?? null),
              id: r.externalId,
              url: r.externalUrl,
              updatedAt: r.externalUpdatedAt,
              conflict: r.pipelineState.pmsConflict ?? null,
            }
          : null,
      pipeline: {
        branch: r.branchName,
        fixLoops: r.fixLoopCount,
        activeRole: r.pipelineState.activeRole ?? null,
        activeEngine: r.pipelineState.activeEngine ?? null,
        activeRunId: r.pipelineState.activeRunId ?? null,
        awaitingMergeReview: !!r.pipelineState.awaitingMergeReview,
        blockedReason:
          r.status === 'BLOCKED'
            ? r.pipelineState.blockedBy
              ? `Merge conflicts — being resolved in ${keys.get(r.pipelineState.blockedBy.taskId) ?? 'a follow-up task'}`
              : r.statusReason
            : null,
        pullRequestUrl: r.pullRequestUrl,
        resumeAt: r.resumeAt,
        tokens: Number(usage.get(r.id)?.tokens ?? 0),
        costUsd: Number(usage.get(r.id)?.cost ?? 0),
        lastError: r.pipelineState.lastError?.message ?? null,
      },
      timing: (() => {
        const u = usage.get(r.id);
        const learned = medians.get(r.complexity);
        return {
          estimateMs: learned ?? DEFAULT_ESTIMATE_MS[r.complexity],
          estimateBasis: learned ? ('history' as const) : ('default' as const),
          spentMs: Number(u?.spent ?? 0),
          runningSince: u?.runningSince != null ? Number(u.runningSince) : null,
          startedAt: u?.startedAt != null ? Number(u.startedAt) : null,
          finishedAt:
            r.status === 'DONE'
              ? (r.completedAt ?? (u?.finishedAt != null ? Number(u.finishedAt) : null))
              : null,
        };
      })(),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  private emitTask(task: TaskDto) {
    this.bus.emit('task.updated', { projectId: task.projectId, task }, [
      Topics.project(task.projectId),
      Topics.task(task.id),
    ]);
  }

  private emitPlan(plan: PlanRow) {
    this.bus.emit('plan.updated', { projectId: plan.projectId, plan: toPlanDto(plan) }, [
      Topics.project(plan.projectId),
    ]);
  }
}

/** Return a dependency cycle reachable from `start` (as a list of ids), or null. */
export function findCycle(graph: Map<string, Set<string>>, start: string): string[] | null {
  const stack: string[] = [];
  const onStack = new Set<string>();
  const done = new Set<string>();
  const visit = (n: string): string[] | null => {
    if (onStack.has(n)) return [...stack.slice(stack.indexOf(n)), n];
    if (done.has(n)) return null;
    stack.push(n);
    onStack.add(n);
    for (const m of graph.get(n) ?? []) {
      const c = visit(m);
      if (c) return c;
    }
    stack.pop();
    onStack.delete(n);
    done.add(n);
    return null;
  };
  return visit(start);
}

/** Validate planner tasks as a DAG (refs + existing keys), returning problems. */
export function validatePlannerGraph(items: PlannerTask[], existingKeys: Set<string>): string[] {
  const problems: string[] = [];
  const refs = new Map<string, number>();
  items.forEach((t, i) => {
    if (refs.has(t.ref)) problems.push(`Duplicate task ref "${t.ref}"`);
    refs.set(t.ref, i);
  });
  const g = new Map<string, Set<string>>();
  for (const t of items) {
    const edges = new Set<string>();
    for (const d of t.dependsOn) {
      if (d === t.ref) problems.push(`Task ${t.ref} depends on itself`);
      else if (refs.has(d)) edges.add(d);
      else if (!existingKeys.has(d.toUpperCase()))
        problems.push(
          `Task ${t.ref} depends on unknown task "${d}" (use a ref from this response or an existing task key)`,
        );
    }
    g.set(t.ref, edges);
  }
  for (const t of items) {
    const c = findCycle(g, t.ref);
    if (c) {
      problems.push(`Dependency cycle: ${c.join(' → ')}`);
      break;
    }
  }
  return problems;
}
