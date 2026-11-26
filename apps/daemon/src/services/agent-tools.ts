import { MEMORY_KINDS, type MemoryKind } from '@ai-harness/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { documents, errors, tasks } from '../db/schema';
import type { MemoryService } from './memory';
import { AGENT_TOOLS_SERVER } from '../lib/product';
import type { Session } from './safety';
import type { TaskService } from './tasks';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));
/** Roles that may record durable project knowledge. */
const WRITERS = new Set(['developer', 'fixer', 'tester', 'documenter', 'planner']);

/**
 * The `ai-harness` MCP server agents get during a run (scoped to that run's
 * project and task): search and add project memory, read the task, related
 * tasks and their reports, and the project's open errors.
 */
export function buildAgentTools(
  d: { db: Db; memory: MemoryService; tasks: TaskService },
  s: Readonly<Session>,
): McpServer {
  const server = new McpServer({ name: AGENT_TOOLS_SERVER, version: '0.1.0' });
  const projectId = s.projectId;
  const noProject = text('This run is not attached to an AI Harness project.');

  server.registerTool(
    'project_memory_search',
    {
      description:
        "Search the project's memory (decisions, conventions, commands, pitfalls, architecture, completed tasks) for facts relevant to a question. Use it before making design decisions.",
      inputSchema: { query: z.string().min(1).max(500).describe('What you want to know') },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      if (!projectId) return noProject;
      const hits = d.memory.forPrompt(projectId, query, 8000, s.taskId ?? undefined);
      return hits.length
        ? text(
            hits
              .map((h) => `### ${h.title}${h.pinned ? ' (pinned)' : ''}\n${h.content}`)
              .join('\n\n'),
          )
        : text('Nothing relevant in project memory.');
    },
  );

  if (WRITERS.has(s.role ?? ''))
    server.registerTool(
      'project_memory_add',
      {
        description:
          'Record a durable fact future agents should know (a decision and its reason, a convention, a pitfall, a command). Keep it short and specific; do not record secrets.',
        inputSchema: {
          kind: z.enum(
            MEMORY_KINDS.filter((k) => k !== 'preference') as [MemoryKind, ...MemoryKind[]],
          ),
          title: z.string().min(3).max(200),
          content: z.string().min(3).max(4000),
        },
      },
      async ({ kind, title, content }) => {
        if (!projectId) return noProject;
        const key = s.taskId ? d.tasks.get(s.taskId).key : null;
        const e = d.memory.create(
          projectId,
          { kind, title, content, tags: key ? [key] : [] },
          'agent',
        );
        return text(`Saved to project memory as "${e.title}".`);
      },
    );

  server.registerTool(
    'task_details',
    {
      description:
        'The task you are working on: description, acceptance criteria, subtasks, dependencies (with their report summaries) and messages from the user.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!s.taskId) return text('This run is not working on a specific task.');
      const t = d.tasks.get(s.taskId);
      const deps = t.dependsOn.length
        ? d.tasks.board(t.projectId).tasks.filter((x) => t.dependsOn.includes(x.id))
        : [];
      return json({
        key: t.key,
        title: t.title,
        type: t.type,
        status: t.status,
        description: t.description,
        acceptanceCriteria: t.acceptanceCriteria,
        affectedAreas: t.affectedAreas,
        subtasks: t.subtasks.map((x) => ({ title: x.title, done: x.done })),
        dependencies: deps.map((x) => ({ key: x.key, title: x.title, status: x.status })),
        ticket: t.external ? { id: t.external.id, url: t.external.url } : null,
      });
    },
  );

  server.registerTool(
    'project_tasks',
    {
      description:
        "List the project's tasks (key, title, status) to see related or overlapping work.",
      inputSchema: {
        status: z.string().max(40).optional().describe('Only tasks in this status, e.g. DONE'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => {
      if (!projectId) return noProject;
      const all = d.tasks
        .board(projectId)
        .tasks.filter((t) => !status || t.status === status.toUpperCase());
      return json(all.map((t) => ({ key: t.key, title: t.title, status: t.status, type: t.type })));
    },
  );

  server.registerTool(
    'task_report',
    {
      description:
        'The completion report of a finished task (what changed, files, tests, limitations), by its key such as "SHOP-3".',
      inputSchema: { key: z.string().min(1).max(40) },
      annotations: { readOnlyHint: true },
    },
    async ({ key }) => {
      if (!projectId) return noProject;
      const t = d.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.projectId, projectId), eq(tasks.key, key.toUpperCase())))
        .get();
      if (!t) return text(`No task ${key} in this project.`);
      const doc = d.db
        .select({ c: documents.content })
        .from(documents)
        .where(and(eq(documents.taskId, t.id), eq(documents.kind, 'task_report')))
        .get();
      return text(doc?.c ?? `${key} has no report yet.`);
    },
  );

  server.registerTool(
    'project_errors',
    {
      description:
        'Open errors AI Harness detected while running the project (compiler errors, stack traces, failed tests), with log excerpts.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!projectId) return noProject;
      const rows = d.db
        .select()
        .from(errors)
        .where(and(eq(errors.projectId, projectId), inArray(errors.status, ['open', 'fixing'])))
        .all()
        .slice(0, 20);
      return rows.length
        ? json(
            rows.map((e) => ({
              message: e.message,
              where: e.filePath ? `${e.filePath}${e.line ? `:${e.line}` : ''}` : null,
              occurrences: e.occurrences,
              excerpt: e.excerpt.slice(-1500),
            })),
          )
        : text('No open errors.');
    },
  );

  return server;
}
