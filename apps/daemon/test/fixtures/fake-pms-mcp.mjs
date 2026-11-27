#!/usr/bin/env node
// A tiny issue tracker exposed as an MCP server, for tests and E2E.
// State lives in the JSON file named by FAKE_PMS_STATE so tests can seed
// issues and inspect what AI Harness wrote back.
//   stdio:  node fake-pms-mcp.mjs
//   http:   node fake-pms-mcp.mjs --http <port>   (Streamable HTTP at /mcp)
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const STATE = process.env.FAKE_PMS_STATE;
if (!STATE) {
  console.error('FAKE_PMS_STATE is required');
  process.exit(2);
}
const load = () => JSON.parse(readFileSync(STATE, 'utf8'));
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));
const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });
const fail = (m) => ({ isError: true, content: [{ type: 'text', text: m }] });

// ─── FAKE_PMS_FLAVOR=atlassian: the hosted Atlassian (Rovo) tool surface ─────
const CLOUD_ID = 'cloud-123';
const WORKFLOW = { 'To Do': '11', 'In Progress': '21', 'In Review': '31', Done: '41' };
const jiraIssue = ({ project: _p, key, title, description, status, labels, updated_at }) => ({
  key,
  self: `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/issue/${key}`,
  fields: { summary: title, description, status, labels, updated: updated_at },
});

function buildAtlassian(server, guard) {
  const site = (fn) =>
    guard(async (args) =>
      args.cloudId === CLOUD_ID ? fn(args) : fail(`Unknown cloudId ${args.cloudId}`),
    );
  const issueArgs = { cloudId: z.string(), issueIdOrKey: z.string() };
  server.registerTool(
    'getAccessibleAtlassianResources',
    { description: 'Get cloudId', inputSchema: {} },
    guard(async () =>
      text([
        { id: 'conf-only', url: 'https://wiki.example', name: 'wiki', scopes: ['read:confluence'] },
        {
          id: CLOUD_ID,
          url: 'https://acme.atlassian.net',
          name: 'acme',
          scopes: ['read:jira-work'],
        },
      ]),
    ),
  );
  server.registerTool(
    'searchJiraIssuesUsingJql',
    {
      description: 'Search issues with JQL',
      inputSchema: {
        cloudId: z.string(),
        jql: z.string(),
        maxResults: z.number().optional(),
        responseContentFormat: z.string().optional(),
      },
    },
    site(async ({ jql }) => {
      const project = /project = (\w+)/.exec(jql)?.[1];
      const open = load().issues.filter((i) => i.project === project && i.status.name !== 'Done');
      return text({ issues: open.map(jiraIssue), isLast: true });
    }),
  );
  server.registerTool(
    'getJiraIssue',
    {
      description: 'Get issue',
      inputSchema: { ...issueArgs, responseContentFormat: z.string().optional() },
    },
    site(async ({ issueIdOrKey }) => {
      const i = load().issues.find((x) => x.key === issueIdOrKey);
      return i ? text(jiraIssue(i)) : fail(`No issue ${issueIdOrKey}`);
    }),
  );
  server.registerTool(
    'getTransitionsForJiraIssue',
    { description: 'Get transitions', inputSchema: issueArgs },
    site(async ({ issueIdOrKey }) => {
      const i = load().issues.find((x) => x.key === issueIdOrKey);
      if (!i) return fail(`No issue ${issueIdOrKey}`);
      // Like Jira: every status but the current one, named differently from the target.
      const transitions = Object.entries(WORKFLOW)
        .filter(([name]) => name !== i.status.name)
        .map(([name, id]) => ({ id, name: `Move to ${name}`, to: { name, id: `s${id}` } }));
      return text({ expand: 'transitions', transitions });
    }),
  );
  server.registerTool(
    'transitionJiraIssue',
    {
      description: 'Transition issue status',
      inputSchema: { ...issueArgs, transition: z.object({ id: z.string() }) },
    },
    site(async ({ issueIdOrKey, transition }) => {
      const s = load();
      const i = s.issues.find((x) => x.key === issueIdOrKey);
      const status = Object.entries(WORKFLOW).find(([, id]) => id === transition.id)?.[0];
      if (!i || !status || status === i.status.name)
        return fail(`Transition ${transition.id} is not valid for ${issueIdOrKey}`);
      i.status = { name: status };
      s.transitions.push({ key: issueIdOrKey, status });
      save(s);
      return text({});
    }),
  );
  server.registerTool(
    'addCommentToJiraIssue',
    {
      description: 'Add a comment',
      inputSchema: { ...issueArgs, commentBody: z.string(), contentFormat: z.string().optional() },
    },
    site(async ({ issueIdOrKey, commentBody }) => {
      const s = load();
      s.comments.push({ key: issueIdOrKey, body: commentBody });
      save(s);
      return text({ id: '10001' });
    }),
  );
  return server;
}

function build(authorized) {
  const server = new McpServer({ name: 'fake-pms', version: '1.0.0' });
  const guard = (fn) => async (args) =>
    authorized() ? fn(args) : fail('401 unauthorized: bad or missing token');
  if (process.env.FAKE_PMS_FLAVOR === 'atlassian') return buildAtlassian(server, guard);
  server.registerTool(
    'search_issues',
    {
      description: 'List issues in a project',
      inputSchema: {
        project_key: z.string(),
        labels: z.array(z.string()).optional(),
        max_results: z.number().optional(),
      },
    },
    guard(async ({ project_key, labels }) => {
      const s = load();
      const issues = s.issues.filter(
        (i) =>
          i.project === project_key &&
          (!labels?.length || labels.every((l) => i.labels.includes(l))),
      );
      return text({ total: issues.length, issues: issues.map(({ project: _p, ...i }) => i) });
    }),
  );
  server.registerTool(
    'get_issue',
    { description: 'Get one issue', inputSchema: { issue_key: z.string() } },
    guard(async ({ issue_key }) => {
      const i = load().issues.find((x) => x.key === issue_key);
      return i ? text(i) : fail(`No issue ${issue_key}`);
    }),
  );
  server.registerTool(
    'transition_issue',
    {
      description: 'Move an issue to a status',
      inputSchema: { issue_key: z.string(), status: z.string() },
    },
    guard(async ({ issue_key, status }) => {
      const s = load();
      const i = s.issues.find((x) => x.key === issue_key);
      if (!i) return fail(`No issue ${issue_key}`);
      i.status = { name: status };
      s.transitions.push({ key: issue_key, status });
      save(s);
      return text({ ok: true });
    }),
  );
  server.registerTool(
    'add_issue_comment',
    {
      description: 'Comment on an issue',
      inputSchema: { issue_key: z.string(), body: z.string() },
    },
    guard(async ({ issue_key, body }) => {
      const s = load();
      s.comments.push({ key: issue_key, body });
      save(s);
      return text({ ok: true });
    }),
  );
  return server;
}

const httpIdx = process.argv.indexOf('--http');
if (httpIdx > 0) {
  const port = Number(process.argv[httpIdx + 1]);
  const required = process.env.FAKE_PMS_REQUIRE_TOKEN;
  createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) return void res.writeHead(404).end();
    const auth = req.headers.authorization;
    const server = build(() => !required || auth === `Bearer ${required}`);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on(
      'end',
      () => void transport.handleRequest(req, res, body ? JSON.parse(body) : undefined),
    );
  }).listen(port, '127.0.0.1', () => console.error(`fake PMS MCP on http://127.0.0.1:${port}/mcp`));
} else {
  const required = process.env.FAKE_PMS_REQUIRE_TOKEN;
  const server = build(() => !required || process.env.FAKE_PMS_TOKEN === required);
  await server.connect(new StdioServerTransport());
  console.error('fake PMS MCP ready on stdio');
}
