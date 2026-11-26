import { DecideApprovalSchema, Topics, type SafetyApprovalDto } from '@ai-harness/shared';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { projects, tasks } from '../db/schema';
import type { GuardProvider } from '../engines/types';
import type { EventBus } from '../events/bus';
import { AppError, conflict, notFound } from '../http/errors';
import { GUARD_HEADER } from '../lib/guard-header';
import { newId } from '../lib/id';
import { classifyTool } from '../safety/classify';
import type { SettingsService } from './settings';

const APPROVAL_TTL_MS = 10 * 60_000;
const WAIT_SLICE_MS = 20_000;
const MAX_LOG = 100;

/** The hook Claude Code runs before each tool call (see `--settings` hooks.PreToolUse). */
const HOOK_SCRIPT = `#!/usr/bin/env node
// AI Harness safety guard — asks the local AI Harness daemon whether a tool call may run.
// Exit 0 lets the call proceed; exit 2 blocks it and tells the agent why.
const url = process.env.AF_GUARD_URL;
const token = process.env.AF_GUARD_TOKEN;
if (!url || !token) process.exit(0);
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try { input = JSON.parse(raw); } catch { process.exit(0); }
const block = (m) => { process.stderr.write('Blocked by AI Harness: ' + m + '\\n'); process.exit(2); };
const post = async (path, body) => {
  const r = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', '${GUARD_HEADER}': token }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};
try {
  let res = await post('/api/safety/check', { tool: input.tool_name, input: input.tool_input ?? {}, cwd: input.cwd ?? null });
  while (res.decision === 'pending') res = await post('/api/safety/wait', { id: res.id });
  if (res.decision === 'deny') block(res.reason);
  process.exit(0);
} catch (e) {
  block('the safety check is unavailable (' + (e && e.message) + ')');
}
`;

export interface Session {
  root: string;
  engineId: string;
  projectId: string | null;
  taskId: string | null;
  role: string | null;
}

interface Pending {
  dto: SafetyApprovalDto;
  /** Guard session that asked. */
  session: string;
  waiters: Set<() => void>;
  timer: NodeJS.Timeout;
}

export const CheckSchema = z.object({
  tool: z.string().max(200),
  input: z.record(z.string(), z.unknown()).default({}),
  cwd: z.string().max(4096).nullable().optional(),
});

/**
 * Guards agent tool calls: issues per-run tokens and a PreToolUse hook,
 * classifies each call (allow / ask you / block), and holds risky calls
 * until you approve or deny them in the UI.
 */
export class SafetyService {
  readonly hookPath: string;
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Pending>();
  private readonly recent: SafetyApprovalDto[] = [];

  constructor(
    private readonly d: {
      db: Db;
      bus: EventBus;
      settings: SettingsService;
      home: string;
      /** The daemon's own URL once it is listening (null before). */
      url: () => string | null;
    },
  ) {
    const dir = join(d.home, 'bin');
    mkdirSync(dir, { recursive: true });
    this.hookPath = join(dir, 'ai-harness-guard.mjs');
    writeFileSync(this.hookPath, HOOK_SCRIPT);
    chmodSync(this.hookPath, 0o755);
  }

  /** The run a guard token belongs to (also authenticates the agent tools MCP server). */
  sessionFor(token: string | undefined): Readonly<Session> | null {
    return (token && this.sessions.get(token)) || null;
  }

  /** For EngineRegistry: a guard per run, or null when the daemon isn't listening yet. */
  readonly provider: GuardProvider = (ctx) => {
    const url = this.d.url();
    if (!url) return null;
    const token = randomBytes(24).toString('base64url');
    this.sessions.set(token, {
      root: ctx.root,
      engineId: ctx.engineId,
      projectId: ctx.projectId ?? null,
      taskId: ctx.taskId ?? null,
      role: ctx.role ?? null,
    });
    return {
      config: {
        hookCommand: `"${process.execPath}" "${this.hookPath}"`,
        env: { AF_GUARD_URL: url, AF_GUARD_TOKEN: token },
        mcp: { url: `${url}/mcp`, headers: { [GUARD_HEADER]: token } },
      },
      revoke: () => this.revoke(token),
    };
  };

  /** Called by the hook. */
  check(
    token: string | undefined,
    raw: unknown,
  ): { decision: 'allow' | 'deny' | 'pending'; reason?: string; id?: string } {
    const s = token ? this.sessions.get(token) : undefined;
    if (!s) throw new AppError(401, 'GUARD_TOKEN', 'Unknown or expired guard token');
    const { tool, input } = CheckSchema.parse(raw);
    // Agents must not answer their own approvals through the API.
    const text = JSON.stringify(input);
    if (/AF_GUARD_TOKEN|\/api\/safety\b/.test(text))
      return this.block(s, tool, text.slice(0, 300), "Agents can't use AI Harness's safety API");
    const v = classifyTool(tool, input, s.root);
    if (v.level === 'allow') return { decision: 'allow' };
    if (v.level === 'deny') return this.block(s, tool, v.summary, v.reason);
    if (!this.d.settings.get().safety.confirmDangerousCommands) return { decision: 'allow' };
    const dto = this.describe(s, tool, v.summary, v.reason, 'pending');
    const p: Pending = {
      dto,
      session: token!,
      waiters: new Set(),
      timer: setTimeout(() => this.settle(dto.id, 'expired'), APPROVAL_TTL_MS).unref(),
    };
    this.pending.set(dto.id, p);
    this.emit(dto);
    return { decision: 'pending', id: dto.id };
  }

  /** Called by the hook: waits up to ~20 s for a decision, then asks it to poll again. */
  async wait(
    token: string | undefined,
    raw: unknown,
  ): Promise<{ decision: 'allow' | 'deny' | 'pending'; reason?: string; id?: string }> {
    const { id } = z.object({ id: z.string().max(64) }).parse(raw);
    const p = this.pending.get(id);
    if (!p) {
      const done = this.recent.find((r) => r.id === id);
      if (!done) throw notFound('Approval');
      return this.answer(done);
    }
    if (p.session !== token)
      throw new AppError(401, 'GUARD_TOKEN', 'Unknown or expired guard token');
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, WAIT_SLICE_MS);
      function done() {
        clearTimeout(t);
        p!.waiters.delete(done);
        resolve();
      }
      p.waiters.add(done);
    });
    const now = this.pending.get(id)?.dto ?? this.recent.find((r) => r.id === id)!;
    return this.answer(now);
  }

  approvals(): SafetyApprovalDto[] {
    return [...[...this.pending.values()].map((p) => p.dto), ...this.recent].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  }

  decide(id: string, raw: unknown): SafetyApprovalDto {
    const { decision } = DecideApprovalSchema.parse(raw);
    if (!this.pending.has(id)) {
      if (this.recent.some((r) => r.id === id)) throw conflict('This request was already answered');
      throw notFound('Approval');
    }
    return this.settle(id, decision === 'approve' ? 'approved' : 'denied');
  }

  stop(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, 'denied');
    this.sessions.clear();
  }

  private revoke(token: string) {
    this.sessions.delete(token);
    for (const [id, p] of this.pending) if (p.session === token) this.settle(id, 'expired');
  }

  private settle(id: string, status: SafetyApprovalDto['status']): SafetyApprovalDto {
    const p = this.pending.get(id)!;
    clearTimeout(p.timer);
    this.pending.delete(id);
    const dto = { ...p.dto, status, decidedAt: Date.now() };
    this.remember(dto);
    for (const w of [...p.waiters]) w();
    this.emit(dto);
    return dto;
  }

  private answer(dto: SafetyApprovalDto) {
    if (dto.status === 'pending') return { decision: 'pending' as const, id: dto.id };
    if (dto.status === 'approved') return { decision: 'allow' as const };
    return {
      decision: 'deny' as const,
      reason:
        dto.status === 'expired'
          ? `${dto.reason} — nobody approved it in time. Find another way or leave it for the user.`
          : `${dto.reason} — the user denied this. Don't retry it; find another way or explain what you need.`,
    };
  }

  private block(s: Session, tool: string, summary: string, reason: string) {
    const dto = this.describe(s, tool, summary, reason, 'blocked');
    this.remember(dto);
    this.emit(dto);
    return { decision: 'deny' as const, reason: `${reason}. This is not allowed in AI Harness.` };
  }

  private describe(
    s: Session,
    tool: string,
    summary: string,
    reason: string,
    status: SafetyApprovalDto['status'],
  ): SafetyApprovalDto {
    const p = s.projectId
      ? this.d.db
          .select({ name: projects.name })
          .from(projects)
          .where(eq(projects.id, s.projectId))
          .get()
      : null;
    const t = s.taskId
      ? this.d.db.select({ key: tasks.key }).from(tasks).where(eq(tasks.id, s.taskId)).get()
      : null;
    const now = Date.now();
    return {
      id: newId('apr'),
      projectId: s.projectId,
      projectName: p?.name ?? null,
      taskId: s.taskId,
      taskKey: t?.key ?? null,
      role: s.role,
      engineId: s.engineId,
      tool,
      summary,
      reason,
      status,
      createdAt: now,
      expiresAt: now + APPROVAL_TTL_MS,
      decidedAt: status === 'pending' ? null : now,
    };
  }

  private remember(dto: SafetyApprovalDto) {
    this.recent.unshift(dto);
    this.recent.splice(MAX_LOG);
  }

  private emit(dto: SafetyApprovalDto) {
    this.d.bus.emit('safety.approval', { approval: dto }, [
      Topics.global,
      ...(dto.projectId ? [Topics.project(dto.projectId)] : []),
    ]);
  }
}
