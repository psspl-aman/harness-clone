import type { AppSettings, UsageDelta } from '@ai-harness/shared';

export interface CostResult {
  costUsd: number;
  source: 'reported' | 'estimated' | 'none';
}

/**
 * Cost of a run: what the CLI reported, otherwise an estimate from the
 * configurable price table (model first, then engine), otherwise unknown.
 */
export function costOf(
  u: UsageDelta,
  engineId: string,
  pricing: AppSettings['pricing'],
): CostResult {
  if (u.costUsd && u.costUsd > 0) return { costUsd: u.costUsd, source: 'reported' };
  const p = (u.model && pricing[u.model]) || pricing[engineId];
  if (!p) return { costUsd: 0, source: 'none' };
  const cost =
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadTokens * (p.cacheRead ?? 0) +
      u.cacheWriteTokens * (p.cacheWrite ?? 0)) /
    1_000_000;
  return { costUsd: Math.round(cost * 1e6) / 1e6, source: 'estimated' };
}
