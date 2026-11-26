import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, tempDir, type TestApp } from './helpers';

let t: TestApp;
let root: string;
let projectId: string;
let taskId: string;
let base: string;

beforeAll(async () => {
  root = tempDir('af-agentmcp-');
  t = await createTestApp({}, { orchestrator: { autoStart: false } });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}`;
  const p = await t.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      mode: 'scratch',
      name: 'Shop',
      location: { kind: 'local', parentDir: root, folderName: 'shop' },
    },
  });
  projectId = p.json().id;
  await t.ctx.projects.runOnboarding(projectId);
  await t.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/memory`,
    payload: {
      kind: 'decision',
      title: 'Payments via Stripe',
      content: 'Use Stripe Checkout; never store card numbers.',
    },
  });
  taskId = t.ctx.tasks.createFollowUp(projectId, null, {
    title: 'Refund endpoint',
    description: 'Add POST /refunds.',
    type: 'feature',
    priority: 'medium',
    acceptanceCriteria: ['Refunds go through Stripe'],
    roleEngines: {},
    origin: 'error',
    pipelineState: {},
  }).id;
});
afterAll(async () => {
  await t.cleanup();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function connect(role: string) {
  const guard = t.ctx.safety.provider({ engineId: 'claude-code', root, projectId, taskId, role })!;
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(guard.config.mcp!.url), {
      requestInit: { headers: guard.config.mcp!.headers },
    }),
  );
  return { client, guard };
}
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

describe('agent tools MCP server', () => {
  it('lets a developer declare an env key by name only', async () => {
    const { client } = await connect('developer');
    const out = textOf(
      await client.callTool({
        name: 'request_env_var',
        arguments: { name: 'OPENAI_API_KEY', why: 'Chatbot replies', secret: true },
      }),
    );
    expect(out).toMatch(/Asked the user for OPENAI_API_KEY; the value will go into \.env/);
    expect(t.ctx.envKeys.list(projectId).find((k) => k.name === 'OPENAI_API_KEY')).toMatchObject({
      status: 'pending',
      source: 'agent',
      why: 'Chatbot replies',
    });
    // Reviewers and planners can't ask for keys.
    const { client: reviewer } = await connect('reviewer');
    const names = (await reviewer.listTools()).tools.map((x) => x.name);
    expect(names).not.toContain('request_env_var');
  });

  it('gives agents project memory, their task and related work', async () => {
    const { client, guard } = await connect('developer');
    expect(guard.config.mcp!.url).toBe(`${base}/mcp`);
    const names = (await client.listTools()).tools.map((x) => x.name).sort();
    expect(names).toEqual([
      'project_errors',
      'project_memory_add',
      'project_memory_search',
      'project_tasks',
      'request_env_var',
      'task_details',
      'task_report',
    ]);

    expect(
      textOf(
        await client.callTool({
          name: 'project_memory_search',
          arguments: { query: 'stripe refunds' },
        }),
      ),
    ).toContain('Payments via Stripe');
    const details = JSON.parse(
      textOf(await client.callTool({ name: 'task_details', arguments: {} })),
    );
    expect(details).toMatchObject({
      title: 'Refund endpoint',
      acceptanceCriteria: ['Refunds go through Stripe'],
    });
    expect(
      JSON.parse(textOf(await client.callTool({ name: 'project_tasks', arguments: {} })))[0],
    ).toMatchObject({ title: 'Refund endpoint' });
    expect(textOf(await client.callTool({ name: 'project_errors', arguments: {} }))).toBe(
      'No open errors.',
    );

    const saved = await client.callTool({
      name: 'project_memory_add',
      arguments: {
        kind: 'pitfall',
        title: 'Refunds are async',
        content: 'Stripe refunds settle later; poll the webhook.',
      },
    });
    expect(textOf(saved)).toContain('Saved to project memory');
    const mem = (
      await t.app.inject({ url: `/api/projects/${projectId}/memory?search=webhook` })
    ).json();
    expect(mem[0]).toMatchObject({ source: 'agent', kind: 'pitfall', tags: [details.key] });
    await client.close();
    guard.revoke();
  });

  it('keeps reviewers read-only and rejects unknown tokens', async () => {
    const { client, guard } = await connect('reviewer');
    expect((await client.listTools()).tools.map((x) => x.name)).not.toContain('project_memory_add');
    await client.close();
    guard.revoke();
    // Once the run ends its token no longer works.
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...guard.config.mcp!.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });
});
