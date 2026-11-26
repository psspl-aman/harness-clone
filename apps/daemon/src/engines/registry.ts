import {
  BUILTIN_ENGINE_IDS,
  CreateCustomEngineInputSchema,
  CustomEngineConfigSchema,
  Topics,
  UpdateEngineInputSchema,
  type AgentEvent,
  type AuthStatus,
  type EngineInfo,
} from '@ai-harness/shared';
import { eq } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/client';
import { engines, engineSessions, usageRecords } from '../db/schema';
import type { EventBus } from '../events/bus';
import { AppError, badRequest, conflict, notFound } from '../http/errors';
import { costOf } from '../lib/cost';
import { newId } from '../lib/id';
import type { SecretStore } from '../services/secrets';
import type { SettingsService } from '../services/settings';
import type { TerminalService } from '../services/terminals';
import { AntigravityAdapter } from './adapters/antigravity';
import { ClaudeCodeAdapter } from './adapters/claude-code';
import { CodexAdapter } from './adapters/codex';
import { CustomCliAdapter } from './adapters/custom';
import { GeminiCliAdapter } from './adapters/gemini-cli';
import type {
  AdapterEnv,
  AgentEngineAdapter,
  AgentRunInput,
  AgentRunResult,
  GuardProvider,
} from './types';

type EngineRow = typeof engines.$inferSelect;

export interface EngineRegistryOptions {
  db: Db;
  bus: EventBus;
  secrets: SecretStore;
  settings: SettingsService;
  terminals: TerminalService;
  home: string;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
  /** Periodic health checks (off in tests). */
  autoRefresh?: boolean;
  /** Extra binary search dirs (tests). */
  extraPath?: string[];
}

const apiKeyName = (id: string) => `engine.${id}.apiKey`;

/** Simple FIFO semaphore per engine, sized from settings at acquire time. */
class Gate {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly limit: () => number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.limit()) {
      await new Promise<void>((resolve, reject) => {
        const w = () => resolve();
        this.waiters.push(w);
        signal?.addEventListener('abort', () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error('aborted'));
        });
      });
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (this.active < this.limit()) this.waiters.shift()?.();
    };
  }
  get inUse() {
    return this.active;
  }
}

/**
 * Owns every engine adapter: seeds the `engines` table, keeps install/auth
 * status fresh (periodic health checks + after logins), serialises runs per
 * engine and turns run outcomes (rate limits, expired auth) into status.
 */
export class EngineRegistry {
  private readonly adapters = new Map<string, AgentEngineAdapter>();
  private readonly gates = new Map<string, Gate>();
  private readonly refreshing = new Map<string, Promise<EngineInfo>>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly testRuns = new Map<string, AbortController>();
  private readonly testRunPromises = new Set<Promise<void>>();

  constructor(private readonly o: EngineRegistryOptions) {}

  init(): void {
    for (const id of BUILTIN_ENGINE_IDS) {
      const adapter = this.buildBuiltin(id);
      this.o.db
        .insert(engines)
        .values({ id, kind: 'builtin', displayName: adapter.displayName })
        .onConflictDoNothing()
        .run();
      this.adapters.set(id, adapter);
    }
    for (const row of this.o.db.select().from(engines).where(eq(engines.kind, 'custom')).all()) {
      if (row.customConfig) this.adapters.set(row.id, this.buildCustom(row));
    }
    if (this.o.autoRefresh !== false) {
      void this.refreshAll().finally(() => this.schedule());
    }
  }

  /** Stop health checks, cancel test runs and wait for in-flight work (shutdown). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.testRuns.values()) c.abort();
    await Promise.allSettled([...this.refreshing.values(), ...this.testRunPromises]);
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  list(): EngineInfo[] {
    return this.o.db
      .select()
      .from(engines)
      .all()
      .filter((r) => this.adapters.has(r.id))
      .sort(
        (a, b) =>
          Number(a.kind === 'custom') - Number(b.kind === 'custom') || order(a.id) - order(b.id),
      )
      .map((r) => this.toInfo(r));
  }

  get(id: string): EngineInfo {
    return this.toInfo(this.row(id));
  }

  adapter(id: string): AgentEngineAdapter {
    const a = this.adapters.get(id);
    if (!a) throw notFound('Engine');
    return a;
  }

  // ─── Health checks ─────────────────────────────────────────────────────────

  async refreshAll(): Promise<EngineInfo[]> {
    const ids = [...this.adapters.keys()].filter((id) => this.row(id).enabled);
    await Promise.allSettled(ids.map((id) => this.refresh(id)));
    return this.list();
  }

  /** Re-detect install + auth. Concurrent calls for the same engine share one probe. */
  refresh(id: string): Promise<EngineInfo> {
    if (this.stopped) return Promise.resolve(this.get(id));
    const inflight = this.refreshing.get(id);
    if (inflight) return inflight;
    const p = this.doRefresh(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, p);
    return p;
  }

  private async doRefresh(id: string): Promise<EngineInfo> {
    const adapter = this.adapter(id);
    const before = this.row(id);
    const detect = await adapter.detectInstalled().catch(() => ({ installed: false as const }));
    const patch: Partial<typeof engines.$inferInsert> = {
      installed: detect.installed,
      version: 'version' in detect ? (detect.version ?? null) : null,
      detectedPath: 'path' in detect ? (detect.path ?? null) : null,
      lastCheckedAt: Date.now(),
    };
    if (!detect.installed) {
      Object.assign(patch, { authStatus: 'NOT_INSTALLED', authDetail: null, accountLabel: null });
    } else {
      const auth = await adapter
        .getAuthStatus()
        .catch((err: Error) => ({ status: 'UNKNOWN' as AuthStatus, detail: err.message }));
      // A quota pause learned from a run outlives auth probes until it resets.
      const quotaHolds =
        before.authStatus === 'QUOTA_EXHAUSTED' &&
        before.resetAt !== null &&
        before.resetAt > Date.now() &&
        auth.status === 'ACTIVE';
      Object.assign(patch, {
        authStatus: quotaHolds ? 'QUOTA_EXHAUSTED' : auth.status,
        authDetail: quotaHolds ? before.authDetail : (auth.detail ?? null),
        accountLabel: 'accountLabel' in auth ? (auth.accountLabel ?? null) : null,
        resetAt: quotaHolds ? before.resetAt : 'resetAt' in auth ? (auth.resetAt ?? null) : null,
      });
      if ('models' in auth && auth.models?.length) patch.models = auth.models;
    }
    return this.apply(id, patch);
  }

  private schedule() {
    if (this.stopped) return;
    const sec = this.o.settings.get().health.engineCheckIntervalSec;
    this.timer = setTimeout(
      () => void this.refreshAll().finally(() => this.schedule()),
      sec * 1000,
    );
    this.timer.unref();
  }

  /** Call when the interval setting changes. */
  reschedule(): void {
    if (this.o.autoRefresh === false || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule();
  }

  // ─── Configuration ─────────────────────────────────────────────────────────

  update(id: string, raw: unknown): EngineInfo {
    this.row(id);
    const input = UpdateEngineInputSchema.parse(raw);
    const patch: Partial<typeof engines.$inferInsert> = {};
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.binaryPath !== undefined) patch.binaryPath = input.binaryPath || null;
    if (input.defaultModel !== undefined) patch.defaultModel = input.defaultModel || null;
    if (input.windowTokenLimit !== undefined) patch.windowTokenLimit = input.windowTokenLimit;
    if (input.windowHours !== undefined) patch.windowHours = input.windowHours;
    const info = this.apply(id, patch);
    if (input.binaryPath !== undefined) void this.refresh(id);
    return info;
  }

  setApiKey(id: string, apiKey: string): Promise<EngineInfo> {
    if (!this.adapter(id).capabilities.apiKey)
      throw badRequest('This engine does not use API keys');
    this.o.secrets.set(apiKeyName(id), apiKey);
    return this.refresh(id);
  }

  clearApiKey(id: string): Promise<EngineInfo> {
    this.adapter(id);
    this.o.secrets.delete(apiKeyName(id));
    return this.refresh(id);
  }

  createCustom(raw: unknown): Promise<EngineInfo> {
    const input = CreateCustomEngineInputSchema.parse(raw);
    const id = `custom:${input.slug}`;
    if (this.o.db.select({ id: engines.id }).from(engines).where(eq(engines.id, id)).get())
      throw conflict(`An engine with id ${id} already exists`);
    this.o.db
      .insert(engines)
      .values({ id, kind: 'custom', displayName: input.displayName, customConfig: input.config })
      .run();
    this.adapters.set(id, this.buildCustom(this.row(id)));
    return this.refresh(id);
  }

  updateCustom(id: string, raw: unknown): Promise<EngineInfo> {
    const row = this.row(id);
    if (row.kind !== 'custom') throw badRequest('Only custom engines can be edited this way');
    const input = CreateCustomEngineInputSchema.omit({ slug: true }).parse(raw);
    this.o.db
      .update(engines)
      .set({
        displayName: input.displayName,
        customConfig: CustomEngineConfigSchema.parse(input.config),
      })
      .where(eq(engines.id, id))
      .run();
    this.adapters.set(id, this.buildCustom(this.row(id)));
    return this.refresh(id);
  }

  removeCustom(id: string): void {
    const row = this.row(id);
    if (row.kind !== 'custom')
      throw badRequest('Built-in engines cannot be removed — disable them instead');
    this.o.db.delete(engines).where(eq(engines.id, id)).run();
    this.o.secrets.delete(apiKeyName(id));
    this.adapters.delete(id);
    this.o.bus.emit('engine.removed', { engineId: id });
  }

  // ─── Login / logout ────────────────────────────────────────────────────────

  async startLogin(id: string) {
    const adapter = this.adapter(id);
    if (!adapter.capabilities.login) throw badRequest(`${adapter.displayName} has no login flow`);
    const flow = await adapter.startLogin().catch((err: Error) => {
      throw new AppError(409, 'ENGINE_UNAVAILABLE', err.message);
    });
    const cwd = join(this.o.home, 'tmp');
    mkdirSync(cwd, { recursive: true });
    const terminal = this.o.terminals.create({
      kind: 'login',
      title: `${adapter.displayName} login`,
      cwd,
      command: flow.command,
      args: flow.args,
      env: flow.env,
      engineId: id,
      onExit: () => void this.refresh(id),
    });
    return { terminal, hint: flow.hint };
  }

  async logout(id: string): Promise<EngineInfo> {
    const adapter = this.adapter(id);
    try {
      await adapter.logout();
    } catch (err) {
      throw new AppError(409, 'LOGOUT_UNSUPPORTED', (err as Error).message);
    }
    return this.refresh(id);
  }

  // ─── Runs ──────────────────────────────────────────────────────────────────

  /**
   * Run an agent through an engine, respecting the per-engine concurrency
   * limit. Rate-limit and auth outcomes update the engine's status.
   */
  private guardProvider: GuardProvider | null = null;

  /** Safety guard for engines that support a pre-tool-use hook. */
  setGuardProvider(p: GuardProvider | null): void {
    this.guardProvider = p;
  }

  async run(
    id: string,
    input: AgentRunInput,
    onEvent: (e: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    const adapter = this.adapter(id);
    const row = this.row(id);
    if (!row.enabled)
      throw new AppError(409, 'ENGINE_DISABLED', `${adapter.displayName} is disabled`);
    const gate = this.gate(id);
    const release = await gate.acquire(input.signal);
    const guard = adapter.supportsGuard
      ? (this.guardProvider?.({ engineId: id, root: input.cwd, ...input.context }) ?? null)
      : null;
    try {
      const result = await adapter.run(
        { ...input, model: input.model ?? row.defaultModel, guard: guard?.config },
        (e) => {
          if (e.kind === 'rate_limit' && e.windows.length)
            this.apply(id, { usageWindows: e.windows });
          onEvent(e);
        },
      );
      this.applyRunOutcome(id, result);
      return result;
    } finally {
      guard?.revoke();
      release();
    }
  }

  private applyRunOutcome(id: string, result: AgentRunResult) {
    const e = result.error;
    if (!e) {
      const row = this.row(id);
      if (row.authStatus !== 'ACTIVE' && row.installed)
        this.apply(id, { authStatus: 'ACTIVE', authDetail: row.authDetail, resetAt: null });
      return;
    }
    if (e.kind === 'QUOTA_EXPIRED' || e.kind === 'RATE_LIMIT') {
      this.apply(id, { authStatus: 'QUOTA_EXHAUSTED', authDetail: e.message, resetAt: e.resetAt });
    } else if (e.kind === 'AUTH_EXPIRED') {
      this.apply(id, { authStatus: 'EXPIRED', authDetail: e.message, resetAt: null });
    }
  }

  /** A tiny read-only prompt in a scratch folder to prove the engine works end to end. */
  startTestRun(id: string, opts: { prompt?: string; model?: string } = {}): { runId: string } {
    this.adapter(id);
    const runId = newId('test');
    const cwd = join(this.o.home, 'tmp', runId);
    mkdirSync(cwd, { recursive: true });
    const controller = new AbortController();
    this.testRuns.set(runId, controller);
    const topics = [Topics.run(runId)];
    const done = this.run(
      id,
      {
        prompt: opts.prompt ?? 'Reply with exactly: OK',
        cwd,
        model: opts.model ?? null,
        permission: 'readonly',
        timeoutMs: 180_000,
        signal: controller.signal,
      },
      (event) => this.o.bus.emit('run.event', { runId, event }, topics, { transient: true }),
    )
      .catch((err: Error): AgentRunResult => ({
        status: 'failed',
        sessionId: null,
        finalText: '',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        durationMs: 0,
        exitCode: null,
        error: { kind: 'UNKNOWN', message: err.message, resetAt: null },
      }))
      .then((result) => {
        this.testRuns.delete(runId);
        const u = result.usage;
        if (u.inputTokens || u.outputTokens || u.cacheReadTokens) {
          const cost = costOf(u, id, this.o.settings.get().pricing);
          this.o.db
            .insert(usageRecords)
            .values({
              id: newId('use'),
              engineId: id,
              model: u.model ?? null,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadTokens,
              cacheWriteTokens: u.cacheWriteTokens,
              costUsd: cost.costUsd,
              costSource: cost.source,
              durationMs: result.durationMs,
            })
            .run();
        }
        this.o.bus.emit('run.finished', { runId, result }, topics);
      })
      .finally(() => this.testRunPromises.delete(done));
    this.testRunPromises.add(done);
    return { runId };
  }

  cancelTestRun(runId: string): void {
    const c = this.testRuns.get(runId);
    if (!c) throw notFound('Run');
    c.abort();
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private gate(id: string): Gate {
    let g = this.gates.get(id);
    if (!g) {
      g = new Gate(() => this.o.settings.get().concurrency.maxRunsPerEngine);
      this.gates.set(id, g);
    }
    return g;
  }

  private env(id: string): AdapterEnv {
    return {
      binaryOverride: () =>
        this.o.db.select({ p: engines.binaryPath }).from(engines).where(eq(engines.id, id)).get()
          ?.p ?? null,
      apiKey: () => this.o.secrets.get(apiKeyName(id)),
      extraPath: this.o.extraPath,
    };
  }

  private buildBuiltin(id: (typeof BUILTIN_ENGINE_IDS)[number]): AgentEngineAdapter {
    const env = this.env(id);
    switch (id) {
      case 'claude-code':
        return new ClaudeCodeAdapter(env);
      case 'codex':
        return new CodexAdapter(env);
      case 'gemini-cli':
        return new GeminiCliAdapter(env);
      case 'antigravity':
        return new AntigravityAdapter(env);
    }
  }

  private buildCustom(row: EngineRow): AgentEngineAdapter {
    return new CustomCliAdapter(
      row.id,
      row.displayName,
      CustomEngineConfigSchema.parse(row.customConfig),
      this.env(row.id),
    );
  }

  private row(id: string): EngineRow {
    const row = this.o.db.select().from(engines).where(eq(engines.id, id)).get();
    if (!row) throw notFound('Engine');
    return row;
  }

  /** Persist a patch, record status history, and broadcast the change. */
  private apply(id: string, patch: Partial<typeof engines.$inferInsert>): EngineInfo {
    const before = this.row(id);
    if (Object.keys(patch).length)
      this.o.db.update(engines).set(patch).where(eq(engines.id, id)).run();
    const after = this.row(id);
    if (before.authStatus !== after.authStatus || before.resetAt !== after.resetAt) {
      this.o.db
        .insert(engineSessions)
        .values({
          id: newId('ses'),
          engineId: id,
          status: after.authStatus,
          accountLabel: after.accountLabel,
          resetAt: after.resetAt,
          detail: after.authDetail,
        })
        .run();
      this.o.bus.emit('engine.status_changed', {
        engineId: id,
        status: after.authStatus,
        resetAt: after.resetAt,
      });
      this.o.log.info(
        { engineId: id, from: before.authStatus, to: after.authStatus },
        'engine status changed',
      );
    }
    const info = this.toInfo(after);
    this.o.bus.emit('engine.updated', { engine: info });
    return info;
  }

  private toInfo(r: EngineRow): EngineInfo {
    const a = this.adapter(r.id);
    return {
      id: r.id,
      kind: r.kind,
      displayName: r.displayName,
      description: a.description,
      installGuideUrl: a.installGuideUrl,
      installCommand: a.installCommand,
      enabled: r.enabled,
      installed: r.installed,
      version: r.version,
      path: r.detectedPath,
      binaryOverride: r.binaryPath,
      authStatus: r.lastCheckedAt === null ? 'UNKNOWN' : r.authStatus,
      accountLabel: r.accountLabel,
      authDetail: r.authDetail,
      resetAt: r.resetAt,
      hasApiKey: this.o.secrets.has(apiKeyName(r.id)),
      defaultModel: r.defaultModel,
      models: r.models.length ? r.models : a.staticModels,
      usageWindows: r.usageWindows,
      capabilities: a.capabilities,
      lastCheckedAt: r.lastCheckedAt,
      customConfig: r.customConfig ?? null,
      windowTokenLimit: r.windowTokenLimit,
      windowHours: r.windowHours,
    };
  }
}

const order = (id: string) => {
  const i = (BUILTIN_ENGINE_IDS as readonly string[]).indexOf(id);
  return i < 0 ? 99 : i;
};
