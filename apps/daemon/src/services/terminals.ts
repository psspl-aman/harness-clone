import { Topics, type TerminalInfo } from '@agentforge/shared';
import { eq } from 'drizzle-orm';
import { existsSync, statSync } from 'node:fs';
import * as pty from 'node-pty';
import type { Db } from '../db/client';
import { terminalSessions } from '../db/schema';
import type { EventBus } from '../events/bus';
import { AppError, notFound } from '../http/errors';
import { newId } from '../lib/id';

const SCROLLBACK_BYTES = 256 * 1024;
const FLUSH_MS = 16;
const MAX_EXITED = 20;

interface Session {
  info: TerminalInfo;
  proc: pty.IPty | null;
  scrollback: string;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  onExit?: (code: number | null) => void;
}

export interface CreateTerminalInput {
  kind: TerminalInfo['kind'];
  title: string;
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  projectId?: string | null;
  engineId?: string | null;
  cols?: number;
  rows?: number;
  onExit?: (code: number | null) => void;
}

/**
 * PTY-backed terminals (node-pty). Output is batched every 16 ms and pushed
 * over the bus as transient `terminal.output` events on `terminal:<id>`;
 * late subscribers fetch the scrollback instead.
 */
export class TerminalService {
  private readonly sessions = new Map<string, Session>();
  private closed = false;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
  ) {}

  create(input: CreateTerminalInput): TerminalInfo {
    if (this.closed) throw new AppError(503, 'SHUTTING_DOWN', 'The daemon is shutting down');
    if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) {
      throw new AppError(400, 'BAD_CWD', `Working directory does not exist: ${input.cwd}`);
    }
    const id = newId('term');
    const info: TerminalInfo = {
      id,
      kind: input.kind,
      title: input.title,
      cwd: input.cwd,
      status: 'running',
      exitCode: null,
      engineId: input.engineId ?? null,
      projectId: input.projectId ?? null,
      createdAt: Date.now(),
    };
    let proc: pty.IPty;
    try {
      proc = pty.spawn(input.command, input.args, {
        name: 'xterm-256color',
        cols: input.cols ?? 100,
        rows: input.rows ?? 28,
        cwd: input.cwd,
        env: {
          ...(process.env as Record<string, string>),
          ...input.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
      });
    } catch (err) {
      throw new AppError(
        500,
        'PTY_SPAWN_FAILED',
        `Could not start ${input.command}: ${(err as Error).message}`,
      );
    }
    const session: Session = {
      info,
      proc,
      scrollback: '',
      pending: '',
      flushTimer: null,
      onExit: input.onExit,
    };
    this.sessions.set(id, session);
    this.db
      .insert(terminalSessions)
      .values({
        id,
        kind: info.kind,
        title: info.title,
        cwd: info.cwd,
        command: [input.command, ...input.args].join(' '),
        projectId: info.projectId,
        engineId: info.engineId,
        pid: proc.pid,
      })
      .run();

    proc.onData((data) => {
      session.scrollback = (session.scrollback + data).slice(-SCROLLBACK_BYTES);
      session.pending += data;
      session.flushTimer ??= setTimeout(() => this.flush(session), FLUSH_MS);
    });
    proc.onExit(({ exitCode }) => {
      if (this.closed) return; // daemon shutting down: DB may already be closed
      this.flush(session);
      session.proc = null;
      info.status = 'exited';
      info.exitCode = exitCode;
      this.db
        .update(terminalSessions)
        .set({ status: 'exited', exitCode, endedAt: Date.now() })
        .where(eq(terminalSessions.id, id))
        .run();
      this.bus.emit('terminal.exit', { terminalId: id, exitCode }, [
        Topics.terminal(id),
        Topics.global,
      ]);
      session.onExit?.(exitCode);
      this.pruneExited();
    });
    this.bus.emit('terminal.created', { terminal: info }, [
      Topics.global,
      ...(info.projectId ? [Topics.project(info.projectId)] : []),
    ]);
    return info;
  }

  get(id: string): TerminalInfo & { scrollback: string } {
    const s = this.require(id);
    return { ...s.info, scrollback: s.scrollback };
  }

  list(filter: { projectId?: string; kind?: TerminalInfo['kind'] } = {}): TerminalInfo[] {
    return [...this.sessions.values()]
      .map((s) => s.info)
      .filter(
        (i) =>
          (!filter.projectId || i.projectId === filter.projectId) &&
          (!filter.kind || i.kind === filter.kind),
      );
  }

  write(id: string, data: string): void {
    const s = this.require(id);
    if (!s.proc) throw new AppError(409, 'TERMINAL_EXITED', 'Terminal has exited');
    s.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.require(id);
    s.proc?.resize(Math.max(10, Math.min(cols, 500)), Math.max(4, Math.min(rows, 200)));
  }

  kill(id: string): void {
    const s = this.require(id);
    s.proc?.kill();
  }

  /** Remove a terminal entirely (killing it first if needed). */
  remove(id: string): void {
    const s = this.require(id);
    s.proc?.kill();
    if (s.flushTimer) clearTimeout(s.flushTimer);
    this.sessions.delete(id);
  }

  closeAll(): void {
    this.closed = true;
    for (const s of this.sessions.values()) {
      if (s.flushTimer) clearTimeout(s.flushTimer);
      s.proc?.kill();
    }
    this.sessions.clear();
  }

  private flush(s: Session) {
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.flushTimer = null;
    if (!s.pending) return;
    const data = s.pending;
    s.pending = '';
    this.bus.emit(
      'terminal.output',
      { terminalId: s.info.id, data },
      [Topics.terminal(s.info.id)],
      { transient: true },
    );
  }

  private pruneExited() {
    const exited = [...this.sessions.values()]
      .filter((s) => s.info.status === 'exited')
      .sort((a, b) => a.info.createdAt - b.info.createdAt);
    for (const s of exited.slice(0, Math.max(0, exited.length - MAX_EXITED)))
      this.sessions.delete(s.info.id);
  }

  private require(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw notFound('Terminal');
    return s;
  }
}
