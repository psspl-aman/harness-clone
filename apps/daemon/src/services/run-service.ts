import {
  Topics,
  type ProcessStatus,
  type ProjectRunDto,
  type ProjectServiceDto,
  type RunKind,
  type ServiceRunDto,
  type TerminalInfo,
} from '@agentforge/shared';
import { eq } from 'drizzle-orm';
import { statSync } from 'node:fs';
import { connect } from 'node:net';
import { relative, resolve } from 'node:path';
import type { Db } from '../db/client';
import { projects } from '../db/schema';
import type { EventBus } from '../events/bus';
import { badRequest, conflict, notFound } from '../http/errors';
import { interactiveShell, shellCommand } from '../lib/platform';
import { stripAnsi } from './errors/matchers';
import type { ErrorService } from './errors/error-service';
import type { ProjectService } from './projects';
import type { TerminalService } from './terminals';

const URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"<>)]*)?/gi;
const PORT_BUSY_RE =
  /^.*(?:EADDRINUSE|address already in use|port \d{2,5} is (?:already )?in use(?!, trying)).*$/im;
const PORT_IN_LINE_RE = /(?::|port\s+)(\d{2,5})\b/i;
const TITLES: Record<RunKind, string> = {
  run: 'Dev server',
  build: 'Build',
  test: 'Tests',
  install: 'Install',
};
/** Ports AgentForge itself uses. */
const RESERVED = new Set([4317, 4318]);
const SETTLE_MS = 4000;
const MAIN_SERVICE = /^(web|frontend|front|client|ui|app|site|www)$/i;

interface ServiceState extends ServiceRunDto {
  stopping: boolean;
}

interface ProjectRun {
  projectId: string;
  startedAt: number;
  services: ServiceState[];
}

/** Is something already listening on this port (IPv4 or IPv6 loopback)? */
export function portInUse(port: number, timeoutMs = 600): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((done) => {
      const s = connect({ port, host });
      const finish = (v: boolean) => {
        s.destroy();
        done(v);
      };
      s.setTimeout(timeoutMs, () => finish(false));
      s.once('connect', () => finish(true));
      s.once('error', () => finish(false));
    });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then(([a, b]) => a || b);
}

const portOf = (url: string) => {
  try {
    const u = new URL(url);
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return null;
  }
};

/**
 * Runs the project's own commands in PTYs: its dev server(s) — one command, or
 * several services (frontend, API, worker…) each in its own terminal with its
 * own port and preview URL — and one-shot build/test/install runs.
 */
export class RunService {
  private readonly runs = new Map<string, ProjectRun>();
  private readonly settle = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly terminals: TerminalService,
    private readonly projectsSvc: ProjectService,
    private readonly errors: ErrorService,
  ) {}

  attach(): void {
    this.bus.subscribe((e) => {
      if (e.type === 'terminal.output') this.onOutput(e.payload.terminalId, e.payload.data);
      if (e.type === 'terminal.exit') this.onExit(e.payload.terminalId, e.payload.exitCode);
      if (e.type === 'project.deleted') this.forget(e.payload.projectId);
    });
  }

  /** A removed project's processes are stopped (its files are left alone). */
  private forget(projectId: string) {
    for (const s of this.runs.get(projectId)?.services ?? []) this.clearSettle(s.terminalId);
    this.runs.delete(projectId);
    for (const t of this.terminals.list({ projectId })) {
      if (t.status === 'running') this.terminals.kill(t.id);
    }
  }

  status(projectId: string): ProjectRunDto {
    this.project(projectId);
    const r = this.runs.get(projectId);
    const services: ServiceRunDto[] = (r?.services ?? []).map(({ stopping: _s, ...dto }) => dto);
    const has = (st: ProcessStatus) => services.some((s) => s.status === st);
    const status: ProcessStatus = has('starting')
      ? 'starting'
      : has('running')
        ? 'running'
        : has('crashed')
          ? 'crashed'
          : 'stopped';
    const withUrl = services.filter(
      (s) => s.url && (s.status === 'running' || s.status === 'starting'),
    );
    const main = withUrl.find((s) => MAIN_SERVICE.test(s.name)) ?? withUrl[0] ?? null;
    const crashed = services.find((s) => s.status === 'crashed');
    return {
      projectId,
      status,
      command:
        services.length > 1
          ? services.map((s) => s.name).join(' + ')
          : (services[0]?.command ?? null),
      terminalId: services.find((s) => s.terminalId)?.terminalId ?? null,
      previewUrl: main?.url ?? null,
      startedAt: r?.startedAt ?? null,
      exitCode: crashed?.exitCode ?? null,
      services,
    };
  }

  /** The services Run would start: the configured list, or the single run command. */
  private definitions(p: typeof projects.$inferSelect): ProjectServiceDto[] {
    const list = p.commands.services?.filter((s) => s.command.trim()) ?? [];
    if (list.length) return list;
    const command = p.commands.run?.trim();
    if (!command) throw badRequest('No run command configured — set one under Overview → Commands');
    return [{ name: 'app', command, cwd: null, port: null }];
  }

  async start(projectId: string): Promise<ProjectRunDto> {
    const p = this.project(projectId);
    const current = this.runs.get(projectId);
    if (current?.services.some((s) => s.status === 'running' || s.status === 'starting'))
      throw conflict('The project is already running — stop or restart it');
    const defs = this.definitions(p);
    // Check every declared port first, so a clash is reported before anything starts.
    const busy = await Promise.all(
      defs.map(async (d) => {
        if (!d.port) return null;
        if (RESERVED.has(d.port))
          return `Port ${d.port} is used by AgentForge itself — give “${d.name}” another port in Overview → Commands.`;
        return (await portInUse(d.port))
          ? `Port ${d.port} is already in use (another app, or an earlier run that’s still going). Stop that process or give “${d.name}” another port in Overview → Commands.`
          : null;
      }),
    );
    const run: ProjectRun = { projectId, startedAt: Date.now(), services: [] };
    this.runs.set(projectId, run);
    const multi = defs.length > 1;
    defs.forEach((d, i) => {
      const s: ServiceState = {
        name: d.name,
        command: d.command,
        cwd: d.cwd ?? null,
        port: d.port ?? null,
        status: 'starting',
        terminalId: null,
        url: null,
        startedAt: Date.now(),
        exitCode: null,
        error: busy[i] ?? null,
        stopping: false,
      };
      run.services.push(s);
      if (s.error) {
        s.status = 'crashed';
        return;
      }
      let cwd: string;
      try {
        cwd = this.serviceCwd(p.localPath, d.cwd);
      } catch (err) {
        s.status = 'crashed';
        s.error = (err as Error).message;
        return;
      }
      const term = this.spawn(p, 'run', d.command, {
        cwd,
        title: multi ? `${TITLES.run} · ${d.name}` : TITLES.run,
        env: d.port ? { PORT: String(d.port) } : {},
      });
      s.terminalId = term.id;
      // No URL printed? Consider it running once it has stayed up for a few seconds.
      this.settle.set(
        term.id,
        setTimeout(() => {
          if (s.status !== 'starting') return;
          this.patch(projectId, s, {
            status: 'running',
            url: s.url ?? (s.port ? `http://localhost:${s.port}` : null),
          });
        }, SETTLE_MS).unref(),
      );
    });
    this.update(projectId);
    if (run.services.every((s) => s.status === 'crashed'))
      throw badRequest(
        run.services
          .map((s) => s.error)
          .filter(Boolean)
          .join('\n'),
      );
    return this.status(projectId);
  }

  async stop(projectId: string): Promise<ProjectRunDto> {
    const r = this.runs.get(projectId);
    const live = r?.services.filter(
      (s) => s.terminalId && (s.status === 'running' || s.status === 'starting'),
    );
    if (!live?.length) return this.status(projectId);
    await Promise.all(
      live.map((s) => {
        s.stopping = true;
        const id = s.terminalId!;
        this.errors.expectExit(id);
        const exited = new Promise<void>((done) => {
          const off = this.bus.subscribe((e) => {
            if (e.type === 'terminal.exit' && e.payload.terminalId === id) {
              off();
              done();
            }
          });
          setTimeout(() => {
            off();
            done();
          }, 5000).unref();
        });
        this.terminals.kill(id);
        return exited;
      }),
    );
    return this.status(projectId);
  }

  async restart(projectId: string): Promise<ProjectRunDto> {
    await this.stop(projectId);
    return this.start(projectId);
  }

  /** One-shot build/test/install in a fresh terminal; errors are detected like any run output. */
  oneShot(projectId: string, kind: Exclude<RunKind, 'run'>): TerminalInfo {
    const p = this.project(projectId);
    const command = p.commands[kind]?.trim();
    if (!command)
      throw badRequest(`No ${kind} command configured — set one under Overview → Commands`);
    return this.spawn(p, kind, command);
  }

  /** Interactive shell in the project folder. */
  shell(projectId: string, title?: string): TerminalInfo {
    const p = this.project(projectId);
    const n = this.terminals.list({ projectId, kind: 'shell' }).length + 1;
    const sh = interactiveShell();
    return this.terminals.create({
      kind: 'shell',
      title: title?.trim() || `Terminal ${n}`,
      cwd: p.localPath,
      command: sh.file,
      args: sh.args,
      projectId,
    });
  }

  stopAll(): void {
    for (const t of this.settle.values()) clearTimeout(t);
  }

  private serviceCwd(root: string, dir: string | null | undefined): string {
    if (!dir) return root;
    const abs = resolve(root, dir);
    const rel = relative(root, abs);
    if (rel.startsWith('..') || resolve(root, rel) !== abs)
      throw new Error(`Folder “${dir}” is outside the project`);
    try {
      if (!statSync(abs).isDirectory()) throw new Error();
    } catch {
      throw new Error(`Folder “${dir}” doesn’t exist in the project`);
    }
    return abs;
  }

  private spawn(
    p: typeof projects.$inferSelect,
    kind: RunKind,
    command: string,
    opts: { cwd?: string; title?: string; env?: Record<string, string> } = {},
  ): TerminalInfo {
    const sh = shellCommand(command);
    return this.terminals.create({
      kind: 'run',
      title: opts.title ?? TITLES[kind],
      cwd: opts.cwd ?? p.localPath,
      command: sh.file,
      args: sh.args,
      projectId: p.id,
      env: { FORCE_COLOR: '1', BROWSER: 'none', ...opts.env },
    });
  }

  private find(terminalId: string): { run: ProjectRun; s: ServiceState } | null {
    for (const run of this.runs.values()) {
      const s = run.services.find((x) => x.terminalId === terminalId);
      if (s) return { run, s };
    }
    return null;
  }

  private onOutput(terminalId: string, data: string) {
    const hit = this.find(terminalId);
    if (!hit) return;
    const { run, s } = hit;
    const text = stripAnsi(data);
    if (!s.error) {
      const busy = PORT_BUSY_RE.exec(text);
      if (busy) {
        const port = PORT_IN_LINE_RE.exec(busy[0])?.[1] ?? s.port;
        const fix =
          run.services.length > 1 ? ` or give “${s.name}” another port` : ' or change the port';
        this.patch(run.projectId, s, {
          error: `${port ? `Port ${port}` : 'Its port'} is already in use — stop the other process${fix} in Overview → Commands.`,
        });
      }
    }
    if (s.url) return;
    // Ports declared by the other services aren't this one's URL (e.g. an API URL in the web log).
    const others = new Set(run.services.filter((x) => x !== s && x.port).map((x) => x.port));
    for (const m of text.matchAll(URL_RE)) {
      const url = m[0].replace('0.0.0.0', 'localhost').replace(/[.,;]$/, '');
      const port = portOf(url);
      if (port && others.has(port)) continue;
      this.clearSettle(terminalId);
      this.patch(run.projectId, s, { url, status: 'running' });
      return;
    }
  }

  private onExit(terminalId: string, code: number | null) {
    const hit = this.find(terminalId);
    if (!hit) return;
    this.clearSettle(terminalId);
    this.patch(hit.run.projectId, hit.s, {
      status: hit.s.stopping || code === 0 ? 'stopped' : 'crashed',
      exitCode: code,
    });
  }

  private clearSettle(terminalId: string | null) {
    if (!terminalId) return;
    clearTimeout(this.settle.get(terminalId));
    this.settle.delete(terminalId);
  }

  private patch(projectId: string, s: ServiceState, patch: Partial<ServiceState>) {
    Object.assign(s, patch);
    this.update(projectId);
  }

  private update(projectId: string) {
    if (!this.runs.has(projectId)) return;
    if (!this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get())
      return;
    const dto = this.status(projectId);
    this.db
      .update(projects)
      .set({ runningStatus: dto.status, lastActivityAt: Date.now() })
      .where(eq(projects.id, projectId))
      .run();
    this.projectsSvc.touch(projectId);
    this.bus.emit('project.run', { run: dto }, [Topics.project(projectId), Topics.global]);
  }

  private project(id: string) {
    const p = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!p) throw notFound('Project');
    return p;
  }
}
