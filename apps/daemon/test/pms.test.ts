import type { AnyAppEvent, McpServerDto, PmsMappingDto, TaskDto } from '@ai-harness/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpServers } from '../src/db/schema';
import {
  baseVars,
  bindConstants,
  detectToolMap,
  extractItems,
  findTransition,
  normalizeIssue,
  pickAtlassianSite,
  renderArgs,
  transitionNames,
} from '../src/services/pms/normalize';
import { extractTicketKeys } from '../src/services/planner/tickets';
import { claudeStream, makeFakeCli, type FakeCli } from './fake-cli';
import { createTestApp, tempDir, type TestApp } from './helpers';

const SERVER = join(import.meta.dirname, 'fixtures/fake-pms-mcp.mjs');
const TOKEN = 'tok-123'; // gforge:allow — fake token for the fake tracker

interface Issue {
  project: string;
  key: string;
  title: string;
  description: string;
  status: { name: string };
  labels: string[];
  url?: string;
  updated_at?: string;
}
interface State {
  issues: Issue[];
  comments: { key: string; body: string }[];
  transitions: { key: string; status: string }[];
}

describe('normalize', () => {
  it('renders argument templates', () => {
    const vars = baseVars(
      'acme/web',
      { labels: ['bug'], assignee: '' },
      { issueId: '42', body: 'hi' },
    );
    expect(
      renderArgs(
        {
          owner: '{{owner}}',
          repo: '{{repo}}',
          n: '{{issueId|number}}',
          labels: '{{filters.labels}}',
          who: '{{filters.assignee}}',
          jql: 'project = {{project}} ORDER BY updated',
          nested: [{ b: '{{body}}' }],
        },
        vars,
      ),
    ).toEqual({
      owner: 'acme',
      repo: 'web',
      n: 42,
      labels: ['bug'],
      jql: 'project = acme/web ORDER BY updated',
      nested: [{ b: 'hi' }],
    });
  });

  it('finds issue lists and normalises common shapes', () => {
    expect(extractItems({ total: 1, issues: [{ key: 'A-1' }] })).toEqual([{ key: 'A-1' }]);
    expect(extractItems({ data: { issues: { edges: [{ node: { id: 'x' } }] } } })).toEqual([
      { id: 'x' },
    ]);
    expect(extractItems({ a: { b: [{ id: 1 }] } }, 'a.b')).toEqual([{ id: 1 }]);
    expect(() => extractItems('nope')).toThrow(/list of issues/);

    expect(
      normalizeIssue({
        key: 'PROJ-7',
        fields: {
          summary: 'Login breaks',
          description: { type: 'doc', content: [{ content: [{ text: 'Steps' }] }] },
          status: { name: 'In Progress' },
          updated: '2026-11-01T10:00:00Z',
          labels: ['bug'],
        },
        self: 'https://jira/rest/7',
      }),
    ).toMatchObject({
      id: 'PROJ-7',
      title: 'Login breaks',
      description: 'Steps',
      status: 'In Progress',
      labels: ['bug'],
      updatedAt: Date.parse('2026-11-01T10:00:00Z'),
    });
    expect(
      normalizeIssue(
        {
          number: 12,
          id: 99999,
          title: 'Add dark mode',
          body: 'pls',
          state: 'open',
          html_url: 'https://gh/12',
          labels: [{ name: 'ui' }],
          assignee: { login: 'sam' },
        },
        { id: 'number' },
      ),
    ).toMatchObject({
      id: '12',
      status: 'open',
      url: 'https://gh/12',
      labels: ['ui'],
      assignee: 'sam',
    });
    expect(normalizeIssue({ foo: 1 })).toBeNull();
  });

  it('finds ticket keys in a chat message', () => {
    expect(
      extractTicketKeys(
        'Fix TVI-569 and TVI-569 again, see #WA-2, WA-3, PROJ_X-12, ab-1, x/TVI-1, TVI-2.',
        new Set(['WA-3']),
      ),
    ).toEqual(['TVI-569', 'PROJ_X-12', 'TVI-2']);
    expect(extractTicketKeys('A1-1 B1-2 C1-3', new Set(), 2)).toEqual(['A1-1', 'B1-2']);
  });

  it('binds constants and leaves other placeholders for render time', () => {
    expect(
      bindConstants(
        { cloudId: '{{cloudId}}', jql: 'project = {{project}}', t: [{ id: '{{cloudId}}' }], n: 5 },
        { cloudId: 'c-1' },
      ),
    ).toEqual({ cloudId: 'c-1', jql: 'project = {{project}}', t: [{ id: 'c-1' }], n: 5 });
  });

  it('finds the transition into a status', () => {
    const jira = extractItems({
      expand: 'transitions',
      transitions: [
        { id: '21', name: 'Start progress', to: { name: 'In Progress' } },
        { id: '41', name: 'Done', to: { name: 'Done' } },
      ],
    });
    expect(findTransition(jira, 'in progress')).toBe('21');
    expect(findTransition(jira, 'Done')).toBe('41');
    expect(findTransition(jira, 'In Review')).toBeNull();
    expect(transitionNames(jira)).toEqual(['In Progress', 'Done']);
    // mcp-atlassian's flattened shape, and matching on the transition name alone.
    expect(findTransition([{ id: 31, name: 'Review', to_status: 'In Review' }], 'In Review')).toBe(
      '31',
    );
    expect(findTransition([{ id: '5', name: 'Reopen' }], 'reopen')).toBe('5');
  });

  it('picks the Jira site from Atlassian resources', () => {
    expect(
      pickAtlassianSite([
        { id: 'wiki', url: 'https://w', scopes: ['read:confluence-content'] },
        { id: 'jira-1', url: 'https://acme.atlassian.net', scopes: ['read:jira-work'] },
      ]),
    ).toBe('jira-1');
    expect(pickAtlassianSite({ resources: [{ url: 'https://acme.atlassian.net' }] })).toBe(
      'https://acme.atlassian.net',
    );
    expect(pickAtlassianSite([])).toBeNull();
    expect(pickAtlassianSite('not json')).toBeNull();
  });

  it('detects a tool map from tool schemas', () => {
    const map = detectToolMap([
      { name: 'search_issues', inputSchema: { properties: { project_key: {}, max_results: {} } } },
      { name: 'get_issue', inputSchema: { properties: { issue_key: {} } } },
      { name: 'transition_issue', inputSchema: { properties: { issue_key: {}, status: {} } } },
      { name: 'add_issue_comment', inputSchema: { properties: { issue_key: {}, body: {} } } },
    ]);
    expect(map.list).toEqual({
      tool: 'search_issues',
      args: { project_key: '{{project}}', max_results: '{{limit|number}}' },
    });
    expect(map.get).toEqual({ tool: 'get_issue', args: { issue_key: '{{issueId}}' } });
    expect(map.updateStatus).toEqual({
      tool: 'transition_issue',
      args: { issue_key: '{{issueId}}', status: '{{status}}' },
    });
    expect(map.comment).toEqual({
      tool: 'add_issue_comment',
      args: { issue_key: '{{issueId}}', body: '{{body}}' },
    });
    expect(map.transitions).toBeUndefined();

    // A transitions lister isn't mistaken for the status changer.
    const jira = detectToolMap([
      { name: 'jira_get_transitions', inputSchema: { properties: { issue_key: {} } } },
      { name: 'jira_transition_issue', inputSchema: { properties: { issue_key: {} } } },
    ]);
    expect(jira.transitions).toEqual({
      tool: 'jira_get_transitions',
      args: { issue_key: '{{issueId}}' },
    });
    expect(jira.updateStatus?.tool).toBe('jira_transition_issue');
  });
});

let t: TestApp;
let root: string;
let statePath: string;
let projectId: string;
let agent: FakeCli;
const events: AnyAppEvent[] = [];
const state = (): State => JSON.parse(readFileSync(statePath, 'utf8'));
const setState = (fn: (s: State) => void) => {
  const s = state();
  fn(s);
  writeFileSync(statePath, JSON.stringify(s));
};
const until = async (fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

beforeEach(async () => {
  root = tempDir('af-pms-');
  statePath = join(root, 'tracker.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      issues: [
        {
          project: 'WEB',
          key: 'WEB-1',
          title: 'Add a contact form',
          description: 'Name, email, message.',
          status: { name: 'To Do' },
          labels: ['feature'],
          url: 'https://tracker/WEB-1',
          updated_at: '2026-11-01T00:00:00Z',
        },
        {
          project: 'WEB',
          key: 'WEB-2',
          title: 'Footer link is broken',
          description: 'Points to /old.',
          status: { name: 'To Do' },
          labels: ['bug'],
          url: 'https://tracker/WEB-2',
          updated_at: '2026-11-01T00:00:00Z',
        },
        {
          project: 'WEB',
          key: 'WEB-3',
          title: 'Already shipped',
          description: '',
          status: { name: 'Done' },
          labels: [],
          updated_at: '2026-10-01T00:00:00Z',
        },
        {
          project: 'API',
          key: 'API-1',
          title: 'Other project',
          description: '',
          status: { name: 'To Do' },
          labels: [],
        },
      ],
      comments: [],
      transitions: [],
    }),
  );
  agent = makeFakeCli(root, 'claude');
  agent.setResponses([
    { match: '--version', stdout: '2.1.327' },
    {
      match: 'auth status',
      stdout: JSON.stringify({ loggedIn: true, loginExpiresAt: '2099-01-01T00:00:00Z' }),
    },
  ]);
  t = await createTestApp({}, { orchestrator: { autoStart: false } });
  events.length = 0;
  t.ctx.bus.subscribe((e) => events.push(e));
  await t.app.inject({
    method: 'PATCH',
    url: '/api/engines/claude-code',
    payload: { binaryPath: agent.path },
  });
  await t.ctx.engines.refresh('claude-code');
  const p = await t.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      mode: 'scratch',
      name: 'Web App',
      location: { kind: 'local', parentDir: root, folderName: 'web' },
    },
  });
  projectId = p.json().id;
  await t.ctx.projects.runOnboarding(projectId);
});
afterEach(async () => {
  await t.cleanup();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const createStdioServer = async (token = TOKEN) =>
  (
    await t.app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: {
        name: 'Fake tracker',
        transport: 'stdio',
        command: process.execPath,
        args: [SERVER],
        env: [
          { key: 'FAKE_PMS_STATE', value: statePath },
          { key: 'FAKE_PMS_REQUIRE_TOKEN', value: TOKEN },
          { key: 'FAKE_PMS_TOKEN', value: token, secret: true },
        ],
      },
    })
  ).json() as McpServerDto;

async function connect(opts: { writeBack?: boolean; autoEnrich?: boolean } = {}) {
  const server = await createStdioServer();
  const toolMap = (
    await t.app.inject({
      method: 'POST',
      url: '/api/pms/detect',
      payload: { mcpServerId: server.id, provider: 'custom' },
    })
  ).json();
  const conn = (
    await t.app.inject({
      method: 'POST',
      url: '/api/pms/connections',
      payload: { name: 'Tracker', provider: 'custom', mcpServerId: server.id, toolMap },
    })
  ).json();
  const mapping = (
    await t.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/pms`,
      payload: {
        connectionId: conn.id,
        externalProject: 'WEB',
        statusMap: {
          'To Do': 'APPROVED',
          'In Progress': 'IN_DEVELOPMENT',
          'In Review': 'IN_REVIEW',
          Done: 'DONE',
        },
        writeBack: opts.writeBack ?? true,
        autoEnrich: opts.autoEnrich ?? false,
      },
    })
  ).json() as PmsMappingDto;
  return { server, conn, mapping };
}
const sync = async (mappingId: string) =>
  t.app.inject({ method: 'POST', url: `/api/pms/mappings/${mappingId}/sync` });
const imported = (): TaskDto[] =>
  t.ctx.tasks.board(projectId).tasks.filter((x) => x.origin === 'pms');
const byExt = (id: string) => imported().find((x) => x.external?.id === id)!;

describe('MCP servers', () => {
  it('stores secrets encrypted, tests the connection and lists tools', async () => {
    const s = await createStdioServer();
    expect(s.env).toEqual([
      { key: 'FAKE_PMS_STATE', secret: false, value: statePath },
      { key: 'FAKE_PMS_REQUIRE_TOKEN', secret: false, value: TOKEN },
      { key: 'FAKE_PMS_TOKEN', secret: true, value: null },
    ]);
    const raw = t.ctx.db.select().from(mcpServers).where(eq(mcpServers.id, s.id)).get()!;
    expect(raw.env.FAKE_PMS_TOKEN).toMatch(/^secret:/);
    expect(JSON.stringify(raw)).not.toContain(`"${TOKEN}"}`);

    const tested = (
      await t.app.inject({ method: 'POST', url: `/api/mcp/servers/${s.id}/test` })
    ).json() as McpServerDto;
    expect(tested.lastStatus).toBe('ok');
    expect(tested.tools.map((x) => x.name).sort()).toEqual([
      'add_issue_comment',
      'get_issue',
      'search_issues',
      'transition_issue',
    ]);

    // Updating without re-entering the secret keeps it; the tool call is authorised.
    const upd = await t.app.inject({
      method: 'PUT',
      url: `/api/mcp/servers/${s.id}`,
      payload: {
        name: 'Renamed',
        transport: 'stdio',
        command: process.execPath,
        args: [SERVER],
        env: [
          { key: 'FAKE_PMS_STATE', value: statePath },
          { key: 'FAKE_PMS_REQUIRE_TOKEN', value: TOKEN },
          { key: 'FAKE_PMS_TOKEN', secret: true },
        ],
      },
    });
    expect(upd.json().name).toBe('Renamed');
    const r = await t.ctx.mcp.callTool(s.id, 'search_issues', { project_key: 'WEB' });
    expect(r.isError).toBe(false);
    expect((r.json as { total: number }).total).toBe(3);

    await t.app.inject({ method: 'DELETE', url: `/api/mcp/servers/${s.id}` });
    expect(t.ctx.secrets.has(`mcp:${s.id}:env:FAKE_PMS_TOKEN`)).toBe(false);
  });

  it('reports a server that fails to start', async () => {
    const s = (
      await t.app.inject({
        method: 'POST',
        url: '/api/mcp/servers',
        payload: {
          name: 'Broken',
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', 'console.error("boom: missing config"); process.exit(3)'],
        },
      })
    ).json();
    const tested = (
      await t.app.inject({ method: 'POST', url: `/api/mcp/servers/${s.id}/test` })
    ).json();
    expect(tested.lastStatus).toBe('error');
    expect(tested.lastError).toMatch(/boom: missing config|closed/i);
  });

  it('validates input', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/servers',
      payload: { name: 'x', transport: 'http', url: 'ftp://nope' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('talks Streamable HTTP with secret headers', async () => {
    const port = await new Promise<number>((res) => {
      const srv = createServer().listen(0, () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => res(p));
      });
    });
    const child: ChildProcess = spawn(process.execPath, [SERVER, '--http', String(port)], {
      env: { ...process.env, FAKE_PMS_STATE: statePath, FAKE_PMS_REQUIRE_TOKEN: TOKEN },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await new Promise<void>((res) =>
      child.stderr!.on('data', (d: Buffer) => d.toString().includes('fake PMS MCP') && res()),
    );
    try {
      const mk = async (token: string) =>
        (
          await t.app.inject({
            method: 'POST',
            url: '/api/mcp/servers',
            payload: {
              name: `HTTP ${token}`,
              transport: 'http',
              url: `http://127.0.0.1:${port}/mcp`,
              headers: [{ key: 'Authorization', value: `Bearer ${token}`, secret: true }],
            },
          })
        ).json() as McpServerDto;
      const good = await mk(TOKEN);
      expect(good.headers).toEqual([{ key: 'Authorization', secret: true, value: null }]);
      expect(
        (await t.app.inject({ method: 'POST', url: `/api/mcp/servers/${good.id}/test` })).json()
          .tools,
      ).toHaveLength(4);
      expect(
        (await t.ctx.mcp.callTool(good.id, 'get_issue', { issue_key: 'WEB-2' })).json,
      ).toMatchObject({ title: 'Footer link is broken' });
      const bad = await mk('wrong');
      expect((await t.ctx.mcp.callTool(bad.id, 'get_issue', { issue_key: 'WEB-2' })).isError).toBe(
        true,
      );
    } finally {
      child.kill();
    }
  });
});

describe('PMS sync', () => {
  it('previews and imports open tickets as linked drafts, then detects changes', async () => {
    const { server, conn, mapping } = await connect();
    expect(conn.toolMap.list).toMatchObject({
      tool: 'search_issues',
      args: { project_key: '{{project}}' },
    });

    const preview = (
      await t.app.inject({
        method: 'POST',
        url: '/api/pms/preview',
        payload: {
          mcpServerId: server.id,
          toolMap: conn.toolMap,
          externalProject: 'WEB',
          filters: { labels: ['bug'] },
        },
      })
    ).json();
    expect(preview.issues.map((i: { id: string }) => i.id)).toEqual(['WEB-2']);

    const r1 = (await sync(mapping.id)).json();
    expect(r1).toMatchObject({ total: 3, created: 2, skipped: 1, errors: [] });
    const t1 = byExt('WEB-1');
    expect(t1).toMatchObject({
      status: 'DRAFT',
      origin: 'pms',
      title: 'Add a contact form',
      type: 'feature',
    });
    expect(t1.external).toMatchObject({
      provider: 'custom',
      id: 'WEB-1',
      url: 'https://tracker/WEB-1',
      conflict: null,
    });
    expect(t1.description).toContain(
      'Imported from Other (custom MCP server) WEB-1 — https://tracker/WEB-1',
    );
    expect(byExt('WEB-2').type).toBe('bug');
    expect(t.ctx.tasks.history(t1.id)[0]).toMatchObject({ to: 'DRAFT', actor: 'pms' });

    expect((await sync(mapping.id)).json()).toMatchObject({ created: 0, unchanged: 2 });

    // A draft simply follows the ticket.
    setState((s) => (s.issues[0]!.title = 'Add a contact form with captcha'));
    expect((await sync(mapping.id)).json()).toMatchObject({ updated: 1 });
    expect(byExt('WEB-1').title).toBe('Add a contact form with captcha');

    // A closed ticket cancels its draft (and isn't echoed back).
    setState((s) => (s.issues[1]!.status = { name: 'Done' }));
    await sync(mapping.id);
    expect(byExt('WEB-2')).toMatchObject({
      status: 'CANCELLED',
      statusReason: 'Closed in Other (custom MCP server)',
    });
    expect(state().transitions).toEqual([]);

    const m = (await t.app.inject({ url: `/api/projects/${projectId}/pms` })).json()[0];
    expect(m).toMatchObject({ lastError: null, syncing: false, lastResult: { updated: 1 } });
    expect(m.lastSyncedAt).toBeGreaterThan(0);
  });

  it('flags tickets changed while in progress and resolves the conflict', async () => {
    const { mapping } = await connect({ writeBack: false });
    await sync(mapping.id);
    const id = byExt('WEB-1').id;
    for (const s of ['APPROVED', 'QUEUED', 'IN_DEVELOPMENT'] as const)
      t.ctx.tasks.transition(id, s, 'test', 'test');

    setState((s) => (s.issues[0]!.description = 'Also add a phone field.'));
    expect((await sync(mapping.id)).json()).toMatchObject({ conflicts: 1 });
    expect(t.ctx.tasks.get(id).external!.conflict).toMatchObject({
      kind: 'changed',
      title: 'Add a contact form',
    });
    expect(
      events.filter((e) => e.type === 'notification' && e.payload.title.includes('changed in')),
    ).toHaveLength(1);
    // The same change isn't reported twice.
    await sync(mapping.id);
    expect(
      events.filter((e) => e.type === 'notification' && e.payload.title.includes('changed in')),
    ).toHaveLength(1);

    const applied = (
      await t.app.inject({
        method: 'POST',
        url: `/api/tasks/${id}/pms-conflict`,
        payload: { action: 'apply' },
      })
    ).json();
    expect(applied.description).toContain('Also add a phone field.');
    expect(applied.external.conflict).toBeNull();
    expect(t.ctx.tasks.get(id).status).toBe('IN_DEVELOPMENT');
    expect((await sync(mapping.id)).json()).toMatchObject({ unchanged: 2, conflicts: 0 });

    // Closed while in progress → "closed" conflict; applying cancels the task.
    setState((s) => (s.issues[0]!.status = { name: 'Done' }));
    await sync(mapping.id);
    expect(t.ctx.tasks.get(id).external!.conflict!.kind).toBe('closed');
    await t.app.inject({
      method: 'POST',
      url: `/api/tasks/${id}/pms-conflict`,
      payload: { action: 'apply' },
    });
    expect(t.ctx.tasks.get(id).status).toBe('CANCELLED');
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/tasks/${id}/pms-conflict`,
          payload: { action: 'dismiss' },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('writes status and a completion comment back to the tracker', async () => {
    const { mapping } = await connect();
    await sync(mapping.id);
    const id = byExt('WEB-1').id;
    for (const s of [
      'APPROVED',
      'QUEUED',
      'IN_DEVELOPMENT',
      'IN_REVIEW',
      'IN_TESTING',
      'DOCUMENTING',
      'DONE',
    ] as const)
      t.ctx.tasks.transition(id, s, 'test', 'test');
    await until(() => state().comments.length === 1);
    expect(state().transitions).toEqual([
      { key: 'WEB-1', status: 'To Do' },
      { key: 'WEB-1', status: 'In Progress' },
      { key: 'WEB-1', status: 'In Review' },
      { key: 'WEB-1', status: 'Done' },
    ]);
    expect(state().comments[0]!.body).toMatch(
      /^✅ Completed by AI Harness \(WA-\d+\)\.[\s\S]*Usage: 0 tokens/,
    );
  });

  it('reports write-back failures on the link', async () => {
    const { mapping } = await connect();
    await sync(mapping.id);
    const id = byExt('WEB-1').id;
    setState((s) => (s.issues = s.issues.filter((i) => i.key !== 'WEB-1')));
    t.ctx.tasks.transition(id, 'APPROVED', 'ok', 'user');
    await until(() =>
      events.some(
        (e) => e.type === 'notification' && e.payload.title === 'Issue tracker update failed',
      ),
    );
    const m = (await t.app.inject({ url: `/api/projects/${projectId}/pms` })).json()[0];
    expect(m.lastError).toMatch(
      /Write-back for WA-\d+ failed: transition_issue failed: No issue WEB-1/,
    );
  });

  it('asks the Planner to enrich imported tickets', async () => {
    agent.setResponses([
      { match: '--version', stdout: '2.1.327' },
      {
        match: 'auth status',
        stdout: JSON.stringify({ loggedIn: true, loginExpiresAt: '2099-01-01T00:00:00Z' }),
      },
      {
        match: '-p',
        stdinIncludes: 'imported from a',
        stdout: claudeStream(
          JSON.stringify({
            type: 'task',
            message: 'Enriched.',
            task: {
              ref: 'T1',
              title: 'Add a contact form',
              description: 'Form with validation.\n\nImported from WEB-1',
              type: 'feature',
              priority: 'medium',
              complexity: 's',
              acceptanceCriteria: ['Form validates email'],
              affectedAreas: ['src/contact'],
              dependsOn: [],
              subtasks: ['Build form', 'Wire submit'],
              suggestedEngines: {},
            },
          }),
        ),
      },
    ]);
    const { mapping } = await connect({ autoEnrich: true });
    await sync(mapping.id);
    await until(() => imported().every((x) => x.acceptanceCriteria.length > 0), 15_000);
    expect(byExt('WEB-1')).toMatchObject({
      acceptanceCriteria: ['Form validates email'],
      affectedAreas: ['src/contact'],
      status: 'DRAFT',
    });
    expect(byExt('WEB-1').subtasks.map((s) => s.title)).toEqual(['Build form', 'Wire submit']);
  });

  it('sets up the hosted Atlassian server by itself and moves tickets by transition id', async () => {
    const server = (
      await t.app.inject({
        method: 'POST',
        url: '/api/mcp/servers',
        payload: {
          name: 'Atlassian',
          transport: 'stdio',
          command: process.execPath,
          args: [SERVER],
          env: [
            { key: 'FAKE_PMS_STATE', value: statePath },
            { key: 'FAKE_PMS_FLAVOR', value: 'atlassian' },
          ],
        },
      })
    ).json() as McpServerDto;
    const toolMap = (
      await t.app.inject({
        method: 'POST',
        url: '/api/pms/detect',
        payload: { mcpServerId: server.id, provider: 'jira' },
      })
    ).json();
    // Every operation, with the Jira site (not the Confluence-only one) filled in.
    expect(toolMap.list).toMatchObject({
      tool: 'searchJiraIssuesUsingJql',
      args: { cloudId: 'cloud-123', jql: expect.stringContaining('project = {{project}}') },
    });
    expect(toolMap.transitions).toEqual({
      tool: 'getTransitionsForJiraIssue',
      args: { cloudId: 'cloud-123', issueIdOrKey: '{{issueId}}' },
    });
    expect(toolMap.updateStatus.args.transition).toEqual({ id: '{{transitionId}}' });
    expect(toolMap.comment.tool).toBe('addCommentToJiraIssue');

    const conn = (
      await t.app.inject({
        method: 'POST',
        url: '/api/pms/connections',
        payload: { name: 'Jira', provider: 'jira', mcpServerId: server.id, toolMap },
      })
    ).json();
    const mapping = (
      await t.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/pms`,
        payload: {
          connectionId: conn.id,
          externalProject: 'WEB',
          statusMap: {
            'To Do': 'APPROVED',
            'In Progress': 'IN_DEVELOPMENT',
            'In Review': 'IN_REVIEW',
            Done: 'DONE',
          },
          autoEnrich: false,
        },
      })
    ).json() as PmsMappingDto;
    expect((await sync(mapping.id)).json()).toMatchObject({ total: 2, created: 2, errors: [] });
    expect(byExt('WEB-1')).toMatchObject({ title: 'Add a contact form', status: 'DRAFT' });

    const id = byExt('WEB-1').id;
    for (const s of [
      'APPROVED',
      'QUEUED',
      'IN_DEVELOPMENT',
      'IN_REVIEW',
      'IN_TESTING',
      'DOCUMENTING',
      'DONE',
    ] as const)
      t.ctx.tasks.transition(id, s, 'test', 'test');
    await until(() => state().comments.length === 1);
    // "To Do" is skipped: the ticket is already there, so Jira offers no transition to it.
    expect(state().transitions).toEqual([
      { key: 'WEB-1', status: 'In Progress' },
      { key: 'WEB-1', status: 'In Review' },
      { key: 'WEB-1', status: 'Done' },
    ]);
    expect(state().comments[0]!.body).toMatch(/^✅ Completed by AI Harness/);
    const m = (await t.app.inject({ url: `/api/projects/${projectId}/pms` })).json()[0];
    expect(m.lastError).toBeNull();
  });

  it('explains a status the Jira workflow cannot reach', async () => {
    const { conn, mapping } = await connect();
    await sync(mapping.id);
    // Same fake tracker, but answering transitions like a Jira board without "In Progress".
    await t.app.inject({
      method: 'PUT',
      url: `/api/pms/connections/${conn.id}`,
      payload: {
        ...conn,
        toolMap: {
          ...conn.toolMap,
          transitions: { tool: 'search_issues', args: { project_key: 'NONE' } },
        },
      },
    });
    const id = byExt('WEB-1').id;
    for (const s of ['APPROVED', 'QUEUED', 'IN_DEVELOPMENT'] as const)
      t.ctx.tasks.transition(id, s, 'test', 'test');
    await until(
      () =>
        events.filter(
          (e) => e.type === 'notification' && e.payload.title === 'Issue tracker update failed',
        ).length === 1,
    );
    const m = (await t.app.inject({ url: `/api/projects/${projectId}/pms` })).json()[0];
    expect(m.lastError).toMatch(/workflow has no transition to "In Progress"/);
  });

  it('hands tickets mentioned in the chat to the Planner', async () => {
    await connect();
    agent.setResponses([
      { match: '--version', stdout: '2.1.327' },
      {
        match: 'auth status',
        stdout: JSON.stringify({ loggedIn: true, loginExpiresAt: '2099-01-01T00:00:00Z' }),
      },
      {
        match: '-p',
        stdout: claudeStream(JSON.stringify({ type: 'reply', message: 'Here is the analysis.' })),
      },
    ]);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: {
        content: 'Analyse WEB-2 and WEB-99, compare with API-1. Use UTF-8.',
        intent: 'discuss',
      },
    });
    expect(res.statusCode).toBe(201);
    await until(() => !t.ctx.planner.state(projectId).running);
    const prompt = agent
      .calls()
      .filter((c) => c.args[0] === '-p')
      .at(-1)!.stdin;
    expect(prompt).toContain('## Tracker tickets the user referenced');
    expect(prompt).toContain(
      '### WEB-2: Footer link is broken\nFrom Other (custom MCP server) (Tracker) (status: To Do · labels: bug · https://tracker/WEB-2)\nPoints to /old.',
    );
    expect(prompt).toMatch(/### WEB-99: could not be read[\s\S]*No issue WEB-99/);
    // Not under a linked tracker project: flagged, not fetched.
    expect(prompt).toContain('### Not looked up: API-1, UTF-8');
  });

  it('rejects duplicate links and surfaces sync errors', async () => {
    const { conn, mapping } = await connect();
    const dup = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/pms`,
      payload: { connectionId: conn.id, externalProject: 'WEB' },
    });
    expect(dup.statusCode).toBe(409);
    await t.app.inject({
      method: 'PUT',
      url: `/api/pms/connections/${conn.id}`,
      payload: { ...conn, toolMap: { ...conn.toolMap, list: { tool: 'nope', args: {} } } },
    });
    const r = await sync(mapping.id);
    expect(r.statusCode).toBe(502);
    expect(
      (await t.app.inject({ url: `/api/projects/${projectId}/pms` })).json()[0].lastError,
    ).toMatch(/nope/);
  });
});
