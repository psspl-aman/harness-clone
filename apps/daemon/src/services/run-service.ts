import { Topics, type ProjectRunDto, type RunKind, type TerminalInfo } from '@agentforge/shared';
import { eq } from 'drizzle-orm';
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
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"<>)]*)?/i;
const TITLES: Record<RunKind, string> = {
  run: 'Dev server',
  build: 'Build',
  test: 'Tests',
  install: 'Install',
};

interface RunState extends ProjectRunDto {
  stopping: boolean;
}

/**
 * Runs the project's own commands in PTYs: a long-lived dev server per
 * project (with preview-URL detection) and one-shot build/test/install runs.
 */
export class RunService {
  private readonly runs = new Map<string, RunState>();
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
    clearTimeout(this.settle.get(projectId));
    this.runs.delete(projectId);
    for (const t of this.terminals.list({ projectId })) {
      if (t.status === 'running') this.terminals.kill(t.id);
    }
  }

  status(projectId: string): ProjectRunDto {
    this.project(projectId);
    const r = this.runs.get(projectId);
    if (!r)
      return {
        projectId,
        status: 'stopped',
        command: null,
        terminalId: null,
        previewUrl: null,
        startedAt: null,
        exitCode: null,
      };
    const { stopping: _s, ...dto } = r;
    return dto;
  }

  start(projectId: string): ProjectRunDto {
    const p = this.project(projectId);
    const current = this.runs.get(projectId);
    if (current && (current.status === 'running' || current.status === 'starting'))
      throw conflict('The project is already running — stop or restart it');
    const command = p.commands.run?.trim();
    if (!command) throw badRequest('No run command configured — set one under Overview → Commands');
    const term = this.spawn(p, 'run', command);
    const state: RunState = {
      projectId,
      status: 'starting',
      command,
      terminalId: term.id,
      previewUrl: null,
      startedAt: Date.now(),
      exitCode: null,
      stopping: false,
    };
    this.runs.set(projectId, state);
    // No URL printed? Consider it running once it has stayed up for a few seconds.
    this.settle.set(
      projectId,
      setTimeout(
        () => state.status === 'starting' && this.update(projectId, { status: 'running' }),
        4000,
      ).unref(),
    );
    this.update(projectId, {});
    return this.status(projectId);
  }

  async stop(projectId: string): Promise<ProjectRunDto> {
    const r = this.runs.get(projectId);
    if (!r?.terminalId || r.status === 'stopped' || r.status === 'crashed')
      return this.status(projectId);
    r.stopping = true;
    this.errors.expectExit(r.terminalId);
    const exited = new Promise<void>((resolve) => {
      const off = this.bus.subscribe((e) => {
        if (e.type === 'terminal.exit' && e.payload.terminalId === r.terminalId) {
          off();
          resolve();
        }
      });
      setTimeout(() => {
        off();
        resolve();
      }, 5000).unref();
    });
    this.terminals.kill(r.terminalId);
    await exited;
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

  private spawn(p: typeof projects.$inferSelect, kind: RunKind, command: string): TerminalInfo {
    const sh = shellCommand(command);
    return this.terminals.create({
      kind: 'run',
      title: TITLES[kind],
      cwd: p.localPath,
      command: sh.file,
      args: sh.args,
      projectId: p.id,
      env: { FORCE_COLOR: '1', BROWSER: 'none' },
    });
  }

  private onOutput(terminalId: string, data: string) {
    for (const r of this.runs.values()) {
      if (r.terminalId !== terminalId || r.previewUrl) continue;
      const m = stripAnsi(data).match(URL_RE);
      if (m)
        this.update(r.projectId, {
          previewUrl: m[0].replace('0.0.0.0', 'localhost').replace(/[.,;]$/, ''),
          status: 'running',
        });
    }
  }

  private onExit(terminalId: string, code: number | null) {
    for (const r of this.runs.values()) {
      if (r.terminalId !== terminalId) continue;
      clearTimeout(this.settle.get(r.projectId));
      this.update(r.projectId, {
        status: r.stopping || code === 0 ? 'stopped' : 'crashed',
        exitCode: code,
      });
    }
  }

  private update(projectId: string, patch: Partial<RunState>) {
    const r = this.runs.get(projectId);
    if (!r) return;
    Object.assign(r, patch);
    if (!this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get())
      return;
    this.db
      .update(projects)
      .set({ runningStatus: r.status, lastActivityAt: Date.now() })
      .where(eq(projects.id, projectId))
      .run();
    this.projectsSvc.touch(projectId);
    this.bus.emit('project.run', { run: this.status(projectId) }, [
      Topics.project(projectId),
      Topics.global,
    ]);
  }

  private project(id: string) {
    const p = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!p) throw notFound('Project');
    return p;
  }
}
