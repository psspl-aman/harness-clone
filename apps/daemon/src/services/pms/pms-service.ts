import {
  PmsConnectionInputSchema,
  PmsFiltersSchema,
  PmsMappingInputSchema,
  PmsMappingUpdateSchema,
  PmsToolMapSchema,
  ResolvePmsConflictSchema,
  Topics,
  type PmsConnectionDto,
  type PmsFilters,
  type PmsIssue,
  type PmsMappingDto,
  type PmsProvider,
  type PmsSyncResultDto,
  type PmsToolMap,
  type TaskStatus,
} from '@ai-harness/shared';
import { createHash } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import {
  agentRuns,
  mcpServers,
  pmsConnections,
  pmsMappings,
  projects,
  tasks,
} from '../../db/schema';
import type { EventBus } from '../../events/bus';
import { badRequest, conflict, notFound } from '../../http/errors';
import { newId } from '../../lib/id';
import { McpError, type McpService } from '../mcp/mcp-service';
import type { Orchestrator } from '../orchestrator/orchestrator';
import type { PlannerService } from '../planner/service';
import type { TicketReference } from '../planner/tickets';
import type { TaskService } from '../tasks';
import {
  baseVars,
  bindConstants,
  detectToolMap,
  extractItems,
  findTransition,
  matchesFilters,
  normalizeIssue,
  pickAtlassianSite,
  renderArgs,
  transitionNames,
} from './normalize';
import { PMS_PRESETS, presetFor, SERVER_TOOL_MAPS, type ServerToolMap } from './presets';

type ConnRow = typeof pmsConnections.$inferSelect;
type MappingRow = typeof pmsMappings.$inferSelect;

const FINISHED: TaskStatus[] = ['DONE', 'CANCELLED'];
const POLL_TICK_MS = 15_000;

export const PreviewInputSchema = z.object({
  mcpServerId: z.string().min(1).max(64),
  toolMap: PmsToolMapSchema,
  externalProject: z.string().trim().min(1).max(300),
  filters: PmsFiltersSchema.default({}),
});

export interface PmsDeps {
  db: Db;
  bus: EventBus;
  mcp: McpService;
  tasks: TaskService;
  planner: PlannerService;
  orchestrator: Orchestrator;
  log: { warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
  /** Poll mappings on their interval (off in tests). */
  autoPoll: boolean;
}

const issueHash = (i: PmsIssue) =>
  createHash('sha1')
    .update(JSON.stringify([i.title, i.description, i.status ?? '']))
    .digest('hex')
    .slice(0, 16);

/**
 * Issue trackers through MCP: connections (an MCP server + a tool map),
 * per-project mappings, sync (import as DRAFT tasks, change/conflict
 * detection, Planner enrichment) and write-back of status and comments.
 */
export class PmsService {
  private readonly syncing = new Set<string>();
  private readonly lastAttempt = new Map<string, number>();
  private readonly writeQueue = new Map<string, Promise<void>>();
  private poller: NodeJS.Timeout | null = null;

  constructor(private readonly d: PmsDeps) {}

  attach(): void {
    this.d.bus.subscribe((e) => {
      if (e.type === 'task.status_changed')
        this.onTaskStatus(e.payload.taskId, e.payload.to, e.payload.reason);
    });
    if (this.d.autoPoll) this.poller = setInterval(() => void this.poll(), POLL_TICK_MS).unref();
  }

  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    await Promise.allSettled([...this.writeQueue.values()]);
  }

  presets() {
    return PMS_PRESETS;
  }

  // ─── Connections ───────────────────────────────────────────────────────────

  listConnections(): PmsConnectionDto[] {
    return this.d.db
      .select({ c: pmsConnections, server: mcpServers.name })
      .from(pmsConnections)
      .innerJoin(mcpServers, eq(mcpServers.id, pmsConnections.mcpServerId))
      .all()
      .map(({ c, server }) => this.connDto(c, server))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getConnection(id: string): PmsConnectionDto {
    const c = this.conn(id);
    return this.connDto(c, this.d.mcp.get(c.mcpServerId).name);
  }

  createConnection(raw: unknown): PmsConnectionDto {
    const v = PmsConnectionInputSchema.parse(raw);
    this.d.mcp.get(v.mcpServerId);
    const id = newId('pms');
    this.d.db
      .insert(pmsConnections)
      .values({
        id,
        name: v.name,
        provider: v.provider,
        mcpServerId: v.mcpServerId,
        toolMap: v.toolMap,
      })
      .run();
    this.d.bus.emit('pms.connections_changed', {}, [Topics.global]);
    return this.getConnection(id);
  }

  updateConnection(id: string, raw: unknown): PmsConnectionDto {
    this.conn(id);
    const v = PmsConnectionInputSchema.parse(raw);
    this.d.mcp.get(v.mcpServerId);
    this.d.db
      .update(pmsConnections)
      .set({ name: v.name, provider: v.provider, mcpServerId: v.mcpServerId, toolMap: v.toolMap })
      .where(eq(pmsConnections.id, id))
      .run();
    this.d.bus.emit('pms.connections_changed', {}, [Topics.global]);
    return this.getConnection(id);
  }

  removeConnection(id: string): void {
    this.conn(id);
    this.d.db.delete(pmsConnections).where(eq(pmsConnections.id, id)).run();
    this.d.bus.emit('pms.connections_changed', {}, [Topics.global]);
  }

  /** Suggest a tool map from the server's real tools: the provider preset where its tools exist, else auto-detection. */
  async detect(raw: unknown): Promise<PmsToolMap> {
    const { mcpServerId, provider } = z
      .object({ mcpServerId: z.string(), provider: z.string() })
      .parse(raw);
    const tools = await this.d.mcp.listTools(mcpServerId);
    const names = new Set(tools.map((t) => t.name));
    const known = SERVER_TOOL_MAPS.find(
      (s) => (s.provider === provider || provider === 'custom') && names.has(s.marker),
    );
    if (known) return this.bindServerToolMap(mcpServerId, known);
    const preset = presetFor(provider).toolMap;
    const detected = detectToolMap(tools);
    const pick = (k: 'list' | 'get' | 'updateStatus' | 'transitions' | 'comment') =>
      preset[k] && names.has(preset[k].tool) ? preset[k] : detected[k];
    return {
      list: pick('list'),
      get: pick('get'),
      updateStatus: pick('updateStatus'),
      transitions: pick('transitions'),
      comment: pick('comment'),
      fields: { ...preset.fields },
    };
  }

  /** A known server's tool map, with the user's site filled in where it needs one. */
  private async bindServerToolMap(serverId: string, known: ServerToolMap): Promise<PmsToolMap> {
    if (!known.siteLookupTool) return known.toolMap;
    const res = await this.call({ mcpServerId: serverId }, known.siteLookupTool, {});
    const cloudId = pickAtlassianSite(res.json);
    if (!cloudId)
      throw badRequest(
        `The server didn't list any Atlassian site for these credentials (${known.siteLookupTool}). Check that the account can open Jira.`,
      );
    return bindConstants(known.toolMap, { cloudId });
  }

  /** Run the list operation with an unsaved configuration and show what would be imported. */
  async preview(raw: unknown): Promise<{ issues: PmsIssue[]; total: number }> {
    const v = PreviewInputSchema.parse(raw);
    const issues = await this.fetchIssues(v.mcpServerId, v.toolMap, v.externalProject, v.filters);
    return { issues: issues.slice(0, 25), total: issues.length };
  }

  /**
   * Read tickets mentioned in chat (the Planner's TicketSource). A key is
   * read through the tracker project linked to this project under the key's
   * prefix (`TVI-569` → the link for `TVI`), with that connection's "get one
   * issue" tool; other keys are reported as unlinked.
   */
  async lookupTickets(projectId: string, keys: string[]): Promise<TicketReference[]> {
    const links = this.d.db
      .select({ m: pmsMappings, c: pmsConnections })
      .from(pmsMappings)
      .innerJoin(pmsConnections, eq(pmsConnections.id, pmsMappings.connectionId))
      .where(eq(pmsMappings.projectId, projectId))
      .all();
    return Promise.all(
      keys.map(async (key): Promise<TicketReference> => {
        const prefix = key.slice(0, key.lastIndexOf('-')).toLowerCase();
        const link = links.find((l) => l.m.externalProject.trim().toLowerCase() === prefix);
        if (!link) return { key, status: 'unlinked' };
        const tracker = `${presetFor(link.c.provider).label} (${link.c.name})`;
        const op = PmsToolMapSchema.parse(link.c.toolMap ?? {}).get;
        if (!op)
          return {
            key,
            status: 'failed',
            tracker,
            reason:
              'The tracker connection has no "Get one issue" tool set up (Integrations → Issue trackers → edit → Auto-detect).',
          };
        try {
          const res = await this.call(
            link.c,
            op.tool,
            renderArgs(op.args, baseVars(link.m.externalProject, link.m.filters, { issueId: key })),
          );
          const json = res.json;
          const issue =
            json && typeof json === 'object' && !Array.isArray(json)
              ? normalizeIssue(json as Record<string, unknown>, link.c.toolMap.fields)
              : null;
          if (!issue)
            return {
              key,
              status: 'failed',
              tracker,
              reason: `"${op.tool}" didn't return a readable ticket: ${res.text.slice(0, 200)}`,
            };
          return { key, status: 'found', tracker, issue };
        } catch (err) {
          return { key, status: 'failed', tracker, reason: (err as Error).message.slice(0, 300) };
        }
      }),
    );
  }

  // ─── Mappings ──────────────────────────────────────────────────────────────

  listMappings(projectId: string): PmsMappingDto[] {
    return this.d.db
      .select()
      .from(pmsMappings)
      .where(eq(pmsMappings.projectId, projectId))
      .all()
      .map((m) => this.mappingDto(m));
  }

  createMapping(projectId: string, raw: unknown): PmsMappingDto {
    const v = PmsMappingInputSchema.parse(raw);
    this.conn(v.connectionId);
    const dup = this.d.db
      .select({ id: pmsMappings.id })
      .from(pmsMappings)
      .where(
        and(
          eq(pmsMappings.projectId, projectId),
          eq(pmsMappings.connectionId, v.connectionId),
          eq(pmsMappings.externalProject, v.externalProject),
        ),
      )
      .get();
    if (dup) throw conflict('This project is already linked to that tracker project');
    const id = newId('map');
    this.d.db
      .insert(pmsMappings)
      .values({
        id,
        projectId,
        connectionId: v.connectionId,
        externalProject: v.externalProject,
        statusMap: v.statusMap,
        filters: v.filters,
        pollingIntervalSec: v.pollingIntervalSec,
        writeBack: v.writeBack,
        autoEnrich: v.autoEnrich,
      })
      .run();
    return this.emitMapping(id);
  }

  updateMapping(id: string, raw: unknown): PmsMappingDto {
    this.mapping(id);
    const v = PmsMappingUpdateSchema.parse(raw);
    this.d.db.update(pmsMappings).set(v).where(eq(pmsMappings.id, id)).run();
    return this.emitMapping(id);
  }

  removeMapping(id: string): void {
    const m = this.mapping(id);
    this.d.db.delete(pmsMappings).where(eq(pmsMappings.id, id)).run();
    this.d.bus.emit('pms.mapping_removed', { projectId: m.projectId, mappingId: id }, [
      Topics.project(m.projectId),
    ]);
  }

  // ─── Sync ──────────────────────────────────────────────────────────────────

  async sync(mappingId: string): Promise<PmsSyncResultDto> {
    const m = this.mapping(mappingId);
    if (this.syncing.has(mappingId)) throw conflict('A sync is already running');
    const c = this.conn(m.connectionId);
    const label = presetFor(c.provider).label;
    this.syncing.add(mappingId);
    this.lastAttempt.set(mappingId, Date.now());
    this.emitMapping(mappingId);
    const r: PmsSyncResultDto = {
      at: Date.now(),
      total: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      conflicts: 0,
      errors: [],
    };
    const enrich: string[] = [];
    try {
      const issues = await this.fetchIssues(c.mcpServerId, c.toolMap, m.externalProject, m.filters);
      r.total = issues.length;
      for (const issue of issues) {
        try {
          this.syncIssue(m, c, label, issue, r, enrich);
        } catch (err) {
          r.errors.push(`${issue.id}: ${(err as Error).message}`);
        }
      }
      this.d.db
        .update(pmsMappings)
        .set({ lastSyncedAt: Date.now(), lastResult: r, lastError: null })
        .where(eq(pmsMappings.id, mappingId))
        .run();
    } catch (err) {
      const msg = (err as Error).message;
      this.d.db
        .update(pmsMappings)
        .set({ lastError: msg.slice(0, 2000) })
        .where(eq(pmsMappings.id, mappingId))
        .run();
      throw err instanceof McpError ? err : badRequest(msg);
    } finally {
      this.syncing.delete(mappingId);
      this.emitMapping(mappingId);
    }
    if (m.autoEnrich && enrich.length) {
      const instructions = `This task was imported from a ${label} ticket. Keep the ticket's intent and title (you may tighten the wording) and keep the "Imported from" line in the description. Make it an actionable task for this codebase: clear acceptance criteria, the likely affected files or areas, and subtasks.`;
      void this.d.planner
        .enrich(enrich, instructions)
        .catch((err: Error) => this.d.log.warn({ err, mappingId }, 'PMS enrichment failed'));
    }
    return r;
  }

  private syncIssue(
    m: MappingRow,
    c: ConnRow,
    label: string,
    issue: PmsIssue,
    r: PmsSyncResultDto,
    enrich: string[],
  ) {
    const mapped = this.mapStatus(m.statusMap, issue.status);
    const closed = !!mapped && FINISHED.includes(mapped);
    const hash = issueHash(issue);
    const existing = this.d.tasks.findImported(c.id, issue.id);
    if (!existing) {
      if (closed) return void r.skipped++;
      const t = this.d.tasks.createImported(m.projectId, {
        title: issue.title,
        description: this.describe(issue, label),
        type: issue.labels.some((l) => /bug|defect/i.test(l))
          ? 'bug'
          : issue.labels.some((l) => /docs?|documentation/i.test(l))
            ? 'docs'
            : 'feature',
        connectionId: c.id,
        externalId: issue.id,
        externalUrl: issue.url,
        externalUpdatedAt: issue.updatedAt,
      });
      this.d.tasks.updateImported(t.id, {}, { pmsSeen: hash });
      enrich.push(t.id);
      return void r.created++;
    }
    if (existing.projectId !== m.projectId) return void r.skipped++;
    if (existing.pipelineState.pmsSeen === hash) return void r.unchanged++;
    if (FINISHED.includes(existing.status)) {
      this.d.tasks.updateImported(
        existing.id,
        { externalUpdatedAt: issue.updatedAt, externalUrl: issue.url },
        { pmsSeen: hash },
      );
      return void r.unchanged++;
    }
    if (existing.status === 'DRAFT') {
      if (closed) {
        this.d.tasks.updateImported(
          existing.id,
          { externalUpdatedAt: issue.updatedAt },
          { pmsSeen: hash },
        );
        this.d.tasks.transition(existing.id, 'CANCELLED', `Closed in ${label}`, 'pms');
      } else {
        this.d.tasks.updateImported(
          existing.id,
          {
            title: issue.title,
            description: this.describe(issue, label),
            externalUpdatedAt: issue.updatedAt,
            externalUrl: issue.url,
          },
          { pmsSeen: hash },
        );
        if (m.autoEnrich) enrich.push(existing.id);
      }
      return void r.updated++;
    }
    // Approved or in progress: don't change it under the agents — flag a conflict for the user.
    if (existing.pipelineState.pmsPendingSeen === hash) return void r.conflicts++;
    const conflictDto = {
      kind: closed ? ('closed' as const) : ('changed' as const),
      detectedAt: Date.now(),
      title: issue.title,
      description: this.describe(issue, label),
      externalStatus: issue.status,
    };
    this.d.tasks.updateImported(
      existing.id,
      {},
      { pmsConflict: conflictDto, pmsPendingSeen: hash },
    );
    this.d.bus.emit(
      'notification',
      {
        level: 'warning',
        title: `${existing.key} changed in ${label}`,
        message: closed
          ? `${issue.id} was closed while AI Harness is working on it.`
          : `${issue.id} was edited while AI Harness is working on it. Review the change on the task.`,
        projectId: m.projectId,
        taskId: existing.id,
      },
      [Topics.global, Topics.project(m.projectId)],
    );
    r.conflicts++;
  }

  /** Apply (update the task / cancel it) or dismiss a PMS change flagged on a task. */
  async resolveConflict(taskId: string, raw: unknown) {
    const { action } = ResolvePmsConflictSchema.parse(raw);
    const row = this.d.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row) throw notFound('Task');
    const c = row.pipelineState.pmsConflict;
    if (!c) throw conflict(`${row.key} has no tracker change to resolve`);
    const accept = {
      pmsConflict: null,
      pmsSeen: row.pipelineState.pmsPendingSeen,
      pmsPendingSeen: undefined,
    };
    if (action === 'dismiss') return this.d.tasks.updateImported(taskId, {}, accept);
    if (c.kind === 'closed') {
      this.d.tasks.updateImported(taskId, {}, accept);
      if (!FINISHED.includes(row.status)) await this.d.orchestrator.cancel(taskId);
      return this.d.tasks.get(taskId);
    }
    this.d.tasks.updateImported(taskId, { title: c.title, description: c.description }, accept);
    if (!FINISHED.includes(row.status))
      this.d.orchestrator.steer(taskId, {
        message: `The ticket was updated in the issue tracker. Take the new version into account:\n\n${c.title}\n\n${c.description.slice(0, 4000)}`,
      });
    return this.d.tasks.get(taskId);
  }

  // ─── Write-back ────────────────────────────────────────────────────────────

  private onTaskStatus(taskId: string, to: TaskStatus, reason: string | null) {
    const row = this.d.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row?.pmsConnectionId || !row.externalId) return;
    const m = this.d.db
      .select()
      .from(pmsMappings)
      .where(
        and(
          eq(pmsMappings.projectId, row.projectId),
          eq(pmsMappings.connectionId, row.pmsConnectionId),
        ),
      )
      .get();
    if (!m?.writeBack) return;
    // Changes that came from the tracker itself aren't echoed back.
    if (reason?.startsWith('Closed in ')) return;
    const prev = this.writeQueue.get(taskId) ?? Promise.resolve();
    const next = prev
      .then(() => this.writeBack(m, row.id, to))
      .catch((err: Error) => {
        const msg = `Write-back for ${row.key} failed: ${err.message}`;
        this.d.log.warn({ err, taskId }, 'PMS write-back failed');
        this.d.db
          .update(pmsMappings)
          .set({ lastError: msg.slice(0, 2000) })
          .where(eq(pmsMappings.id, m.id))
          .run();
        this.emitMapping(m.id);
        this.d.bus.emit(
          'notification',
          {
            level: 'warning',
            title: 'Issue tracker update failed',
            message: msg,
            projectId: row.projectId,
            taskId,
          },
          [Topics.global, Topics.project(row.projectId)],
        );
      })
      .finally(() => {
        if (this.writeQueue.get(taskId) === next) this.writeQueue.delete(taskId);
      });
    this.writeQueue.set(taskId, next);
  }

  private async writeBack(m: MappingRow, taskId: string, to: TaskStatus) {
    const c = this.d.db
      .select()
      .from(pmsConnections)
      .where(eq(pmsConnections.id, m.connectionId))
      .get();
    if (!c) return;
    const t = this.d.tasks.get(taskId);
    const vars = (extra: Record<string, unknown>) =>
      baseVars(m.externalProject, m.filters, { issueId: t.external!.id, ...extra });
    const external = Object.entries(m.statusMap).find(([, s]) => s === to)?.[0];
    if (external && c.toolMap.updateStatus) {
      const transitionId = await this.transitionInto(c.toolMap, c, vars({}), external);
      if (transitionId !== null)
        await this.call(
          c,
          c.toolMap.updateStatus.tool,
          renderArgs(c.toolMap.updateStatus.args, vars({ status: external, transitionId })),
        );
    }
    const body =
      to === 'DONE'
        ? this.doneComment(t)
        : to === 'FAILED'
          ? `AI Harness couldn't finish ${t.key}: ${t.statusReason ?? 'unknown error'}. It needs a look in AI Harness.`
          : null;
    if (body && c.toolMap.comment)
      await this.call(
        c,
        c.toolMap.comment.tool,
        renderArgs(c.toolMap.comment.args, vars({ body })),
      );
  }

  /**
   * What `{{transitionId}}` should be to move the ticket into `status`. Without a
   * `transitions` operation that's the status name itself (trackers that move
   * by name). With one, it's the matching transition's id, or null when the
   * ticket is already in that status. A workflow with no way there is an error.
   */
  private async transitionInto(
    map: PmsToolMap,
    c: Pick<ConnRow, 'mcpServerId'>,
    vars: Record<string, unknown>,
    status: string,
  ): Promise<string | null> {
    if (!map.transitions) return status;
    const res = await this.call(c, map.transitions.tool, renderArgs(map.transitions.args, vars));
    const items = extractItems(res.json ?? {}, map.transitions.itemsPath);
    const id = findTransition(items, status);
    if (id) return id;
    if (map.get) {
      const cur = await this.call(c, map.get.tool, renderArgs(map.get.args, vars));
      const issue =
        cur.json && typeof cur.json === 'object'
          ? normalizeIssue(cur.json as Record<string, unknown>, map.fields)
          : null;
      if (issue?.status?.toLowerCase() === status.toLowerCase()) return null;
    }
    const offered = transitionNames(items);
    throw badRequest(
      `The ticket's workflow has no transition to "${status}"${offered.length ? ` (it offers: ${offered.join(', ')})` : ''}. Match the status mapping to your board's status names.`,
    );
  }

  private doneComment(t: ReturnType<TaskService['get']>): string {
    const doc = this.d.db
      .select({ s: agentRuns.resultSummary })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.taskId, t.id),
          eq(agentRuns.role, 'documenter'),
          isNotNull(agentRuns.resultSummary),
        ),
      )
      .orderBy(desc(agentRuns.startedAt))
      .get();
    const history = this.d.tasks.history(t.id);
    const started = history.find((h) => h.to === 'IN_DEVELOPMENT')?.createdAt;
    const mins = started ? Math.max(1, Math.round((Date.now() - started) / 60_000)) : null;
    const lines = [
      `✅ Completed by AI Harness (${t.key}).`,
      doc?.s ? `\n${doc.s}` : '',
      t.pipeline.pullRequestUrl
        ? `\nPull request: ${t.pipeline.pullRequestUrl}`
        : t.pipeline.branch
          ? `\nMerged branch \`${t.pipeline.branch}\`.`
          : '',
      `\nReviewed and tested by AI Harness agents${t.pipeline.fixLoops ? ` (${t.pipeline.fixLoops} fix loop${t.pipeline.fixLoops === 1 ? '' : 's'})` : ''}.`,
      `Usage: ${t.pipeline.tokens.toLocaleString('en-US')} tokens${t.pipeline.costUsd ? `, $${t.pipeline.costUsd.toFixed(2)}` : ''}${mins ? `, ${mins} min` : ''}.`,
    ];
    return lines.filter(Boolean).join('\n').trim();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async fetchIssues(
    serverId: string,
    toolMap: PmsToolMap,
    project: string,
    filters: PmsFilters,
  ): Promise<PmsIssue[]> {
    const op = toolMap.list;
    if (!op) throw badRequest('This connection has no "list issues" tool configured');
    const res = await this.call(
      { mcpServerId: serverId } as ConnRow,
      op.tool,
      renderArgs(op.args, baseVars(project, filters)),
    );
    if (res.json === undefined)
      throw badRequest(`"${op.tool}" returned text instead of JSON: ${res.text.slice(0, 300)}`);
    const items = extractItems(res.json, op.itemsPath);
    const seen = new Set<string>();
    const out: PmsIssue[] = [];
    for (const item of items) {
      const i = normalizeIssue(item, toolMap.fields);
      if (!i || seen.has(i.id) || !matchesFilters(i, filters)) continue;
      seen.add(i.id);
      out.push(i);
    }
    if (
      items.length &&
      !out.length &&
      !filters.assignee &&
      !filters.labels?.length &&
      !filters.status?.length
    )
      throw badRequest(
        `Couldn't read an id and title from the ${items.length} items "${op.tool}" returned — set the field paths for id and title`,
      );
    return out;
  }

  private async call(c: Pick<ConnRow, 'mcpServerId'>, tool: string, args: unknown) {
    const res = await this.d.mcp.callTool(
      c.mcpServerId,
      tool,
      (args ?? {}) as Record<string, unknown>,
    );
    if (res.isError)
      throw new McpError(`${tool} failed: ${res.text.slice(0, 500) || 'tool error'}`);
    return res;
  }

  private mapStatus(map: Record<string, TaskStatus>, status: string | null): TaskStatus | null {
    if (!status) return null;
    const hit = Object.entries(map).find(([k]) => k.toLowerCase() === status.toLowerCase());
    return hit?.[1] ?? null;
  }

  private describe(i: PmsIssue, label: string): string {
    const meta = [
      i.status && `Status: ${i.status}`,
      i.assignee && `Assignee: ${i.assignee}`,
      i.labels.length && `Labels: ${i.labels.join(', ')}`,
    ]
      .filter(Boolean)
      .join(' · ');
    return `${i.description.trim() || '(No description in the ticket.)'}\n\n---\nImported from ${label} ${i.id}${i.url ? ` — ${i.url}` : ''}${meta ? `\n${meta}` : ''}`;
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    // Archived projects don't pull new tickets until they're restored.
    const due = this.d.db
      .select({ m: pmsMappings })
      .from(pmsMappings)
      .innerJoin(projects, eq(projects.id, pmsMappings.projectId))
      .where(and(isNotNull(pmsMappings.pollingIntervalSec), isNull(projects.archivedAt)))
      .all()
      .map((r) => r.m);
    for (const m of due) {
      const last = Math.max(m.lastSyncedAt ?? 0, this.lastAttempt.get(m.id) ?? 0);
      if (this.syncing.has(m.id) || now - last < m.pollingIntervalSec! * 1000) continue;
      await this.sync(m.id).catch((err: Error) =>
        this.d.log.warn({ err, mappingId: m.id }, 'PMS polling sync failed'),
      );
    }
  }

  private connDto(c: ConnRow, serverName: string): PmsConnectionDto {
    return {
      id: c.id,
      name: c.name,
      provider: c.provider as PmsProvider,
      mcpServerId: c.mcpServerId,
      mcpServerName: serverName,
      toolMap: PmsToolMapSchema.parse(c.toolMap ?? {}),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  private mappingDto(m: MappingRow): PmsMappingDto {
    const c = this.d.db
      .select()
      .from(pmsConnections)
      .where(eq(pmsConnections.id, m.connectionId))
      .get();
    return {
      id: m.id,
      projectId: m.projectId,
      connectionId: m.connectionId,
      connectionName: c?.name ?? '(removed)',
      provider: (c?.provider ?? 'custom') as PmsProvider,
      externalProject: m.externalProject,
      statusMap: m.statusMap,
      filters: m.filters,
      pollingIntervalSec: m.pollingIntervalSec,
      writeBack: m.writeBack,
      autoEnrich: m.autoEnrich,
      syncing: this.syncing.has(m.id),
      lastSyncedAt: m.lastSyncedAt,
      lastError: m.lastError,
      lastResult: m.lastResult ?? null,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  private conn(id: string): ConnRow {
    const c = this.d.db.select().from(pmsConnections).where(eq(pmsConnections.id, id)).get();
    if (!c) throw notFound('PMS connection');
    return c;
  }

  private mapping(id: string): MappingRow {
    const m = this.d.db.select().from(pmsMappings).where(eq(pmsMappings.id, id)).get();
    if (!m) throw notFound('Tracker link');
    return m;
  }

  private emitMapping(id: string): PmsMappingDto {
    const dto = this.mappingDto(this.mapping(id));
    this.d.bus.emit('pms.mapping', { mapping: dto }, [Topics.project(dto.projectId)]);
    return dto;
  }
}
