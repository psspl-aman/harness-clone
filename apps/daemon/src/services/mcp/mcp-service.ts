import {
  McpServerInputSchema,
  Topics,
  type KeyValueDto,
  type KeyValueInput,
  type McpServerDto,
  type McpToolDto,
} from '@ai-harness/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { mcpServers } from '../../db/schema';
import type { EventBus } from '../../events/bus';
import { AppError, badRequest, notFound } from '../../http/errors';
import { newId } from '../../lib/id';
import { PRODUCT_SLUG } from '../../lib/product';
import type { SecretStore } from '../secrets';
import { toToolResult, type ToolResult } from './tool-result';

export type { ToolResult } from './tool-result';

type ServerRow = typeof mcpServers.$inferSelect;

const SECRET_PREFIX = 'secret:';
const CALL_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
const IDLE_CLOSE_MS = 120_000;

interface Pooled {
  client: Client;
  stderr: string[];
  lastUsed: number;
  closing?: boolean;
}

export class McpError extends AppError {
  constructor(message: string) {
    super(502, 'MCP_ERROR', message);
  }
}

/**
 * MCP servers (stdio, Streamable HTTP, legacy SSE): configuration with
 * encrypted env/header secrets, a small connection pool with idle close,
 * connection tests (tool listing) and tool calls.
 */
export class McpService {
  private readonly pool = new Map<string, Promise<Pooled>>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly secrets: SecretStore,
  ) {}

  start(): void {
    this.sweeper ??= setInterval(() => void this.sweep(), 30_000).unref();
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await Promise.all([...this.pool.keys()].map((id) => this.disconnect(id)));
  }

  list(): McpServerDto[] {
    return this.db
      .select()
      .from(mcpServers)
      .all()
      .map((r) => this.toDto(r))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): McpServerDto {
    return this.toDto(this.row(id));
  }

  create(raw: unknown): McpServerDto {
    const v = McpServerInputSchema.parse(raw);
    const id = newId('mcp');
    this.db
      .insert(mcpServers)
      .values({
        id,
        name: v.name,
        transport: v.transport,
        command: v.transport === 'stdio' ? v.command! : null,
        args: v.transport === 'stdio' ? v.args : [],
        env: this.storeValues(id, 'env', v.env, {}),
        url: v.transport === 'stdio' ? null : v.url!,
        headers: this.storeValues(id, 'header', v.transport === 'stdio' ? [] : v.headers, {}),
        enabled: v.enabled,
      })
      .run();
    return this.emit(id);
  }

  async update(id: string, raw: unknown): Promise<McpServerDto> {
    const row = this.row(id);
    const v = McpServerInputSchema.parse(raw);
    this.db
      .update(mcpServers)
      .set({
        name: v.name,
        transport: v.transport,
        command: v.transport === 'stdio' ? v.command! : null,
        args: v.transport === 'stdio' ? v.args : [],
        env: this.storeValues(id, 'env', v.env, row.env),
        url: v.transport === 'stdio' ? null : v.url!,
        headers: this.storeValues(
          id,
          'header',
          v.transport === 'stdio' ? [] : v.headers,
          row.headers,
        ),
        enabled: v.enabled,
        lastStatus: 'unknown',
        lastError: null,
      })
      .where(eq(mcpServers.id, id))
      .run();
    await this.disconnect(id);
    return this.emit(id);
  }

  async remove(id: string): Promise<void> {
    const row = this.row(id);
    await this.disconnect(id);
    for (const ref of [...Object.values(row.env), ...Object.values(row.headers)])
      if (ref.startsWith(SECRET_PREFIX)) this.secrets.delete(ref.slice(SECRET_PREFIX.length));
    this.db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
    this.bus.emit('mcp.removed', { serverId: id }, [Topics.global]);
    this.bus.emit('pms.connections_changed', {}, [Topics.global]);
  }

  /** Connect (fresh), list tools and record the outcome. */
  async test(id: string): Promise<McpServerDto> {
    await this.disconnect(id);
    try {
      const tools = await this.listTools(id);
      this.db
        .update(mcpServers)
        .set({ lastStatus: 'ok', lastError: null, toolsCache: tools, lastCheckedAt: Date.now() })
        .where(eq(mcpServers.id, id))
        .run();
    } catch (err) {
      this.db
        .update(mcpServers)
        .set({
          lastStatus: 'error',
          lastError: (err as Error).message.slice(0, 2000),
          lastCheckedAt: Date.now(),
        })
        .where(eq(mcpServers.id, id))
        .run();
    }
    return this.emit(id);
  }

  async listTools(id: string): Promise<McpToolDto[]> {
    return this.withClient(id, async (c) => {
      const tools: McpToolDto[] = [];
      let cursor: string | undefined;
      do {
        const r = await c.listTools(cursor ? { cursor } : {}, { timeout: CALL_TIMEOUT_MS });
        for (const t of r.tools)
          tools.push({
            name: t.name,
            description: t.description?.slice(0, 1000),
            inputSchema: t.inputSchema as Record<string, unknown>,
          });
        cursor = r.nextCursor;
      } while (cursor && tools.length < 1000);
      return tools;
    });
  }

  async callTool(id: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const r = await this.withClient(id, (c) =>
      c.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS }),
    );
    return toToolResult(r);
  }

  // ─── Connections ───────────────────────────────────────────────────────────

  private async withClient<T>(id: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const row = this.row(id);
    if (!row.enabled) throw badRequest(`MCP server "${row.name}" is disabled`);
    for (let attempt = 0; ; attempt++) {
      let pooled: Pooled;
      try {
        pooled = await this.connection(row);
      } catch (err) {
        throw new McpError(`Could not connect to "${row.name}": ${(err as Error).message}`);
      }
      pooled.lastUsed = Date.now();
      try {
        return await fn(pooled.client);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        // A dropped connection gets one reconnect; tool/protocol errors are reported.
        const dropped = /closed|ECONNRESET|EPIPE|not connected|terminated/i.test(msg);
        if (dropped && attempt === 0) {
          await this.disconnect(id);
          continue;
        }
        const stderr = pooled.stderr.join('').trim().split('\n').slice(-5).join('\n');
        throw new McpError(`${row.name}: ${msg}${stderr ? `\n${stderr}` : ''}`);
      }
    }
  }

  private connection(row: ServerRow): Promise<Pooled> {
    let p = this.pool.get(row.id);
    if (!p) {
      p = this.connect(row);
      this.pool.set(row.id, p);
      p.catch(() => this.pool.delete(row.id));
    }
    return p;
  }

  private async connect(row: ServerRow): Promise<Pooled> {
    const stderr: string[] = [];
    let transport: Transport;
    if (row.transport === 'stdio') {
      const t = new StdioClientTransport({
        command: row.command!,
        args: row.args,
        env: { ...getDefaultEnvironment(), ...this.resolveValues(row.env) },
        stderr: 'pipe',
      });
      t.stderr?.on('data', (d: Buffer) => {
        stderr.push(d.toString());
        if (stderr.length > 50) stderr.splice(0, stderr.length - 50);
      });
      transport = t;
    } else {
      const headers = this.resolveValues(row.headers);
      const url = new URL(row.url!);
      transport =
        row.transport === 'http'
          ? new StreamableHTTPClientTransport(url, { requestInit: { headers } })
          : new SSEClientTransport(url, {
              requestInit: { headers },
              eventSourceInit: {
                fetch: (u, init) =>
                  fetch(u, {
                    ...init,
                    headers: { ...(init?.headers as Record<string, string>), ...headers },
                  }),
              },
            });
    }
    const client = new Client({ name: PRODUCT_SLUG, version: '0.1.0' });
    const pooled: Pooled = { client, stderr, lastUsed: Date.now() };
    client.onclose = () => {
      if (!pooled.closing) this.pool.delete(row.id);
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no response within ${CONNECT_TIMEOUT_MS / 1000}s`)),
            CONNECT_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      await client.close().catch(() => {});
      const tail = stderr.join('').trim().split('\n').slice(-5).join('\n');
      throw new Error(`${(err as Error).message}${tail ? `\n${tail}` : ''}`);
    } finally {
      clearTimeout(timer);
    }
    return pooled;
  }

  private async disconnect(id: string): Promise<void> {
    const p = this.pool.get(id);
    if (!p) return;
    this.pool.delete(id);
    const pooled = await p.catch(() => null);
    if (pooled) {
      pooled.closing = true;
      await pooled.client.close().catch(() => {});
    }
  }

  private async sweep(): Promise<void> {
    for (const [id, p] of this.pool) {
      const pooled = await p.catch(() => null);
      if (pooled && Date.now() - pooled.lastUsed > IDLE_CLOSE_MS) await this.disconnect(id);
    }
  }

  // ─── Secrets ───────────────────────────────────────────────────────────────

  /** Store values; secrets go to the encrypted store and the row keeps `secret:<name>`. */
  private storeValues(
    id: string,
    kind: 'env' | 'header',
    items: KeyValueInput[],
    previous: Record<string, string>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    const seen = new Set<string>();
    for (const it of items) {
      if (seen.has(it.key))
        throw badRequest(`Duplicate ${kind === 'env' ? 'variable' : 'header'} "${it.key}"`);
      seen.add(it.key);
      const secretName = `mcp:${id}:${kind}:${it.key}`;
      if (it.secret) {
        if (it.value !== undefined && it.value !== null && it.value !== '')
          this.secrets.set(secretName, it.value);
        else if (!previous[it.key]?.startsWith(SECRET_PREFIX))
          throw badRequest(`Enter a value for secret "${it.key}"`);
        out[it.key] = `${SECRET_PREFIX}${secretName}`;
      } else {
        out[it.key] = it.value ?? '';
      }
    }
    // Secrets that were removed (or turned into plain values) are deleted.
    for (const [k, ref] of Object.entries(previous))
      if (ref.startsWith(SECRET_PREFIX) && out[k] !== ref)
        this.secrets.delete(ref.slice(SECRET_PREFIX.length));
    return out;
  }

  private resolveValues(values: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values))
      out[k] = v.startsWith(SECRET_PREFIX)
        ? (this.secrets.get(v.slice(SECRET_PREFIX.length)) ?? '')
        : v;
    return out;
  }

  private toKv(values: Record<string, string>): KeyValueDto[] {
    return Object.entries(values).map(([key, v]) =>
      v.startsWith(SECRET_PREFIX)
        ? { key, secret: true, value: null }
        : { key, secret: false, value: v },
    );
  }

  private toDto(r: ServerRow): McpServerDto {
    return {
      id: r.id,
      name: r.name,
      transport: r.transport,
      command: r.command,
      args: r.args,
      env: this.toKv(r.env),
      url: r.url,
      headers: this.toKv(r.headers),
      enabled: r.enabled,
      lastStatus: r.lastStatus,
      lastError: r.lastError,
      tools: r.toolsCache,
      lastCheckedAt: r.lastCheckedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private row(id: string): ServerRow {
    const r = this.db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
    if (!r) throw notFound('MCP server');
    return r;
  }

  private emit(id: string): McpServerDto {
    const dto = this.get(id);
    this.bus.emit('mcp.updated', { server: dto }, [Topics.global]);
    return dto;
  }
}
