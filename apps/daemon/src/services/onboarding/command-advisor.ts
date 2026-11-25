import {
  ProjectServiceSchema,
  Topics,
  type AgentRunResultDto,
  type CommandSuggestionDto,
} from '@agentforge/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { projects, projectSettings } from '../../db/schema';
import type { EngineRegistry } from '../../engines/registry';
import type { EventBus } from '../../events/bus';
import { badRequest, conflict, notFound } from '../../http/errors';
import type { RunRecorder } from '../runs';
import type { SettingsService } from '../settings';

const TIMEOUT_MS = 5 * 60_000;
/** AgentForge's own daemon and web app. */
const RESERVED_PORTS = [4317, 4318];

const cmd = z
  .string()
  .trim()
  .max(500)
  .nullable()
  .optional()
  .transform((v) => (v ? v : null));

const OutputSchema = z.object({
  install: cmd,
  run: cmd,
  build: cmd,
  test: cmd,
  lint: cmd,
  services: z.array(ProjectServiceSchema).max(8).default([]),
  notes: z.array(z.string().max(500)).max(10).default([]),
});

export interface AdvisorDeps {
  db: Db;
  bus: EventBus;
  engines: EngineRegistry;
  runs: RunRecorder;
  settings: SettingsService;
  log: { warn: (o: unknown, m?: string) => void };
  reservedPorts?: number[];
}

/** The last JSON object in an agent's answer (fenced or bare). */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!);
  for (const c of [...fences].reverse()) {
    try {
      return JSON.parse(c);
    } catch {
      /* try the next candidate */
    }
  }
  const end = text.lastIndexOf('}');
  for (
    let start = text.lastIndexOf('{', end);
    start >= 0;
    start = text.lastIndexOf('{', start - 1)
  ) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* widen */
    }
  }
  return null;
}

export function parseSuggestion(text: string) {
  const json = extractJson(text);
  if (!json) return { ok: false as const, error: 'The agent didn’t return the commands as JSON.' };
  const v = OutputSchema.safeParse(json);
  if (!v.success)
    return {
      ok: false as const,
      error: `The agent’s answer didn’t match the expected shape: ${v.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    };
  // A single service is just the run command.
  const out = v.data;
  if (out.services.length === 1) {
    const s = out.services[0]!;
    out.run ??= s.cwd ? `cd ${JSON.stringify(s.cwd)} && ${s.command}` : s.command;
    out.services = [];
  }
  const names = new Set<string>();
  out.services = out.services.filter((s) => {
    const k = s.name.toLowerCase();
    if (names.has(k)) return false;
    names.add(k);
    return true;
  });
  return { ok: true as const, data: out };
}

function prompt(reserved: number[]): string {
  return `You are setting up how to run this project on the user's machine. Read the project (package.json files and their scripts, lockfiles, workspace config, Makefile, docker-compose, Procfile, README, framework config, .env.example) — do not run, install or change anything.

Work out:
- install: the one command that installs all dependencies (for several folders chain them, e.g. \`npm ci && npm --prefix server ci\`). Use the package manager the lockfile implies.
- build, test, lint: the project's real commands (null when there is none).
- How the app runs in development:
  - ONE server (most apps): put its command in "run" and leave "services" empty.
  - SEVERAL processes that must run at the same time (e.g. a frontend + an API, a worker, a database container): list each in "services" with a short name ("web", "api", "worker"…), the command, "cwd" (folder relative to the project root, "" for the root) and the "port" it listens on. Put the user-facing app first. Set "run" to null.
- Ports: every service gets a different port. Never use ${reserved.join(' or ')} (AgentForge uses them). Prefer each tool's default; if two would collide, give one another port and make the command use it (e.g. \`vite --port 5174\`, \`next dev -p 3001\`, or PORT=… where the app reads PORT). If the frontend calls the API, say in notes which env var/URL points at it.
- notes: up to 5 short lines on anything the user must know first (required env vars, a database to start, Node/Python version, the URL to open).

Commands run from the project root with bash, so they may use \`cd dir && …\`, but prefer "cwd". Don't include commands that need sudo or that deploy.

Answer with ONLY this JSON object (no prose):
\`\`\`json
{"install": "…" | null, "run": "…" | null, "build": "…" | null, "test": "…" | null, "lint": "…" | null,
 "services": [{"name": "web", "command": "…", "cwd": "", "port": 5173}],
 "notes": ["…"]}
\`\`\``;
}

/**
 * "Suggest with AI" for the project's commands: a read-only agent run that
 * reads the code and proposes install/run/build/test/lint commands and, for
 * multi-server apps, one service per process with non-clashing ports.
 * Nothing is saved until the user applies the suggestion.
 */
export class CommandAdvisor {
  private readonly current = new Map<string, CommandSuggestionDto>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly d: AdvisorDeps) {}

  get(projectId: string): CommandSuggestionDto | null {
    return this.current.get(projectId) ?? null;
  }

  dismiss(projectId: string): void {
    this.controllers.get(projectId)?.abort();
    this.current.delete(projectId);
  }

  stop(): void {
    for (const c of this.controllers.values()) c.abort();
  }

  suggest(projectId: string): CommandSuggestionDto {
    const p = this.d.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!p) throw notFound('Project');
    if (this.current.get(projectId)?.status === 'running')
      throw conflict('Already working out the commands');
    const engineId = this.pickEngine(projectId);
    const s: CommandSuggestionDto = {
      projectId,
      status: 'running',
      engineId,
      runId: null,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      commands: {},
      services: [],
      notes: [],
    };
    this.current.set(projectId, s);
    const ctl = new AbortController();
    this.controllers.set(projectId, ctl);
    void this.execute(s, p.localPath, ctl).finally(() => {
      if (this.controllers.get(projectId) === ctl) this.controllers.delete(projectId);
    });
    this.emit(s);
    return s;
  }

  private async execute(s: CommandSuggestionDto, cwd: string, ctl: AbortController) {
    const text = prompt(this.d.reservedPorts ?? RESERVED_PORTS);
    const runId = this.d.runs.start({
      projectId: s.projectId,
      role: 'planner',
      engineId: s.engineId,
      prompt: text,
      cwd,
    });
    s.runId = runId;
    this.emit(s);
    let result: AgentRunResultDto;
    try {
      result = await this.d.engines.run(
        s.engineId,
        {
          prompt: text,
          cwd,
          permission: 'readonly',
          timeoutMs: TIMEOUT_MS,
          signal: ctl.signal,
          context: { projectId: s.projectId, taskId: null, role: 'planner' },
        },
        this.d.runs.sink(runId),
      );
    } catch (err) {
      result = {
        status: 'failed',
        sessionId: null,
        finalText: '',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        durationMs: 0,
        exitCode: null,
        error: { kind: 'UNKNOWN', message: (err as Error).message, resetAt: null },
      };
    }
    const parsed = result.status === 'succeeded' ? parseSuggestion(result.finalText) : null;
    this.d.runs.finish(runId, result, {
      resultJson: parsed?.ok ? parsed.data : null,
      resultSummary: parsed?.ok ? 'Suggested project commands' : (parsed?.error ?? null),
    });
    // Dismissed (or superseded) while running: drop the result.
    if (this.current.get(s.projectId) !== s) return;
    s.finishedAt = Date.now();
    if (parsed?.ok) {
      const { services, notes, ...commands } = parsed.data;
      Object.assign(s, { status: 'done', commands, services, notes });
    } else {
      s.status = 'failed';
      s.error =
        result.status === 'cancelled'
          ? 'Cancelled.'
          : (parsed?.error ?? result.error?.message ?? 'The agent run failed.');
    }
    this.emit(s);
  }

  private pickEngine(projectId: string): string {
    const ps = this.d.db
      .select({ r: projectSettings.roleEngines })
      .from(projectSettings)
      .where(eq(projectSettings.projectId, projectId))
      .get();
    const preferred = ps?.r.planner ?? this.d.settings.get().defaultEngines.planner;
    const usable = (id: string) => {
      try {
        const e = this.d.engines.get(id);
        return e.installed && e.enabled && e.authStatus === 'ACTIVE';
      } catch {
        return false;
      }
    };
    if (usable(preferred)) return preferred;
    const other = this.d.engines.list().find((e) => usable(e.id));
    if (other) return other.id;
    throw badRequest(
      'No signed-in agent engine is available — log in to one under Agents & Accounts.',
    );
  }

  private emit(s: CommandSuggestionDto) {
    this.d.bus.emit('project.command_suggestion', { suggestion: { ...s } }, [
      Topics.project(s.projectId),
    ]);
  }
}
