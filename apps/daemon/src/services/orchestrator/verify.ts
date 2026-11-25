import { execa } from 'execa';

export interface VerifyStep {
  name: 'install' | 'build' | 'test';
  command: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
  timedOut: boolean;
}

const TAIL = 12_000;

export interface CheckOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Run one project command through a shell, capturing the tail of its output. */
export async function runCheck(
  cwd: string,
  name: VerifyStep['name'],
  command: string,
  opts: CheckOptions = {},
): Promise<VerifyStep> {
  const started = Date.now();
  const r = await execa(command, {
    cwd,
    shell: true,
    reject: false,
    all: true,
    timeout: opts.timeoutMs ?? 15 * 60_000,
    cancelSignal: opts.signal,
    env: { CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    stdin: 'ignore',
  });
  const output = String(r.all ?? '');
  return {
    name,
    command,
    exitCode: r.exitCode ?? null,
    durationMs: Date.now() - started,
    output: output.length > TAIL ? `…${output.slice(-TAIL)}` : output,
    timedOut: !!r.timedOut,
  };
}

/**
 * Run the project's own install/build/test commands in the task worktree so
 * the pipeline doesn't rely on the Tester's word alone. Commands are the
 * user-confirmed strings from the project settings and run through a shell.
 */
export async function runProjectChecks(
  cwd: string,
  commands: { install?: string | null; build?: string | null; test?: string | null },
  opts: CheckOptions = {},
): Promise<{ ok: boolean; steps: VerifyStep[] }> {
  const steps: VerifyStep[] = [];
  for (const name of ['install', 'build', 'test'] as const) {
    const command = commands[name]?.trim();
    if (!command) continue;
    const step = await runCheck(cwd, name, command, opts);
    steps.push(step);
    if (step.exitCode !== 0) return { ok: false, steps };
  }
  return { ok: true, steps };
}

export function formatChecks(steps: VerifyStep[]): string {
  return steps
    .map(
      (s) =>
        `$ ${s.command}\n(exit ${s.exitCode ?? '?'}${s.timedOut ? ', timed out' : ''}, ${Math.round(s.durationMs / 1000)}s)\n${s.output.trim()}`,
    )
    .join('\n\n');
}
