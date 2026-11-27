import type { Complexity } from './enums';

/** Agent time per task (whole pipeline) before there is history to learn from. */
export const DEFAULT_ESTIMATE_MS: Record<Complexity, number> = {
  xs: 5 * 60_000,
  s: 10 * 60_000,
  m: 25 * 60_000,
  l: 45 * 60_000,
  xl: 90 * 60_000,
};

/** Finished tasks of a complexity needed before their median replaces the default. */
export const ESTIMATE_MIN_SAMPLES = 3;

export interface TaskTimingDto {
  /** Expected agent time for the whole pipeline (develop → review → test → document). */
  estimateMs: number;
  /** `history`: median of your finished tasks of this complexity; `default`: built-in guess. */
  estimateBasis: 'history' | 'default';
  /**
   * Estimated USD cost for this task: the median total cost of your finished tasks of the same
   * complexity. Null until there are enough samples — no fabricated figure without history.
   */
  estCostUsd: number | null;
  /** `history` when `estCostUsd` is set; `none` when there isn't enough cost history yet. */
  estCostBasis: 'history' | 'none';
  /** Agent time spent so far (finished runs). Add `now - runningSince` for a live total. */
  spentMs: number;
  /** Start of the agent run in progress, if any. */
  runningSince: number | null;
  /** When the first agent run started / the last one finished (for done tasks). */
  startedAt: number | null;
  finishedAt: number | null;
}

/** Live agent time spent, including a run in progress. */
export const spentNow = (t: TaskTimingDto, now = Date.now()) =>
  t.spentMs + (t.runningSince ? Math.max(0, now - t.runningSince) : 0);

/** Agent time still expected for a task (never below 10% of its estimate while unfinished). */
export function remainingMs(
  task: { status: string; timing: TaskTimingDto },
  now = Date.now(),
): number {
  if (task.status === 'DONE' || task.status === 'CANCELLED') return 0;
  const est = task.timing.estimateMs;
  return Math.max(est - spentNow(task.timing, now), est * 0.1);
}

/**
 * Wall-clock time left for a set of tasks: dependencies run in order and at most
 * `parallel` tasks build at once, so it is the longer of the critical path and
 * the total remaining work spread over the parallel slots.
 */
export function planRemaining(
  tasks: { id: string; status: string; dependsOn: string[]; timing: TaskTimingDto }[],
  parallel: number,
  now = Date.now(),
): { workMs: number; etaMs: number } {
  const open = tasks.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELLED');
  const byId = new Map(open.map((t) => [t.id, t]));
  const memo = new Map<string, number>();
  const chain = (id: string, seen: Set<string>): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const t = byId.get(id);
    if (!t || seen.has(id)) return 0;
    seen.add(id);
    const before = Math.max(0, ...t.dependsOn.map((d) => chain(d, seen)));
    seen.delete(id);
    const total = before + remainingMs(t, now);
    memo.set(id, total);
    return total;
  };
  const workMs = open.reduce((s, t) => s + remainingMs(t, now), 0);
  const critical = Math.max(0, ...open.map((t) => chain(t.id, new Set())));
  return { workMs, etaMs: Math.max(critical, workMs / Math.max(1, parallel)) };
}
