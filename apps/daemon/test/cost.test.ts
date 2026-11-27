import { builtinPrice, type UsageDelta, type UsageSummaryDto } from '@ai-harness/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usageRecords } from '../src/db/schema';
import { costOf } from '../src/lib/cost';
import { newId } from '../src/lib/id';
import { createTestApp, type TestApp } from './helpers';

const usage = (o: Partial<UsageDelta> = {}): UsageDelta => ({
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...o,
});

describe('costOf', () => {
  it('uses the CLI-reported cost when there is one', () => {
    expect(costOf(usage({ costUsd: 0.42, model: 'gpt-5' }), 'codex', {})).toEqual({
      costUsd: 0.42,
      source: 'reported',
    });
  });

  it('prefers your prices (model, then engine) over the built-in table', () => {
    const pricing = {
      'gpt-5-codex': { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 },
      codex: { input: 2, output: 20, cacheRead: 0, cacheWrite: 0 },
    };
    expect(costOf(usage({ model: 'gpt-5-codex' }), 'codex', pricing)).toEqual({
      costUsd: 2, // 1M × $1 + 0.1M × $10
      source: 'estimated',
    });
    expect(costOf(usage({ model: 'o3' }), 'codex', pricing).costUsd).toBe(4);
  });

  it('estimates from built-in list prices by model family', () => {
    // GPT-5 family: $1.25 in / $10 out / $0.125 cached per 1M.
    expect(
      costOf(usage({ model: 'gpt-5-codex', cacheReadTokens: 1_000_000 }), 'codex', {}),
    ).toEqual({ costUsd: 2.375, source: 'estimated' });
    expect(costOf(usage({ model: 'gpt-6.2-sol' }), 'codex', {}).costUsd).toBe(2.25);
    // Claude Sonnet: $3 / $15.
    expect(costOf(usage({ model: 'claude-sonnet-4-5' }), 'claude-code', {}).costUsd).toBe(4.5);
    // Unknown model on a known engine → that engine's default model price.
    expect(costOf(usage({ model: 'codex (default)' }), 'codex', {}).costUsd).toBe(2.25);
    expect(costOf(usage(), 'codex', {}).costUsd).toBe(2.25);
  });

  it('leaves runs unpriced when nothing matches', () => {
    expect(costOf(usage({ model: 'llama-3' }), 'my-cli', {})).toEqual({
      costUsd: 0,
      source: 'none',
    });
  });
});

describe('builtinPrice', () => {
  it('matches the specific family before the general one', () => {
    expect(builtinPrice('gpt-5-mini')?.input).toBe(0.25);
    expect(builtinPrice('gpt-5.1-codex-mini')?.input).toBe(0.25);
    expect(builtinPrice('o4-mini')?.input).toBe(1.1);
    expect(builtinPrice('claude-opus-4-1-20250805')?.input).toBe(15);
    expect(builtinPrice('claude-opus-4-6')?.input).toBe(5);
    expect(builtinPrice('claude-haiku-4-5')?.input).toBe(1);
    expect(builtinPrice('gemini-2.5-flash')?.input).toBe(0.3);
    expect(builtinPrice('mystery')).toBeNull();
  });
});

describe('usage summary', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('prices old unpriced runs and marks the cost as estimated', async () => {
    t.ctx.db
      .insert(usageRecords)
      .values({
        id: newId('use'),
        engineId: 'codex',
        model: null,
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        costUsd: 0,
        costSource: 'none',
      })
      .run();
    const res = await t.app.inject({ method: 'GET', url: '/api/usage/summary?days=7' });
    const s = res.json() as UsageSummaryDto;
    expect(s.totals.unpricedRuns).toBe(0);
    expect(s.totals.costUsd).toBeCloseTo(2.25);
    expect(s.totals.estimatedShare).toBe(1);
    expect(s.totals.estimatedCostUsd).toBeCloseTo(2.25);
    expect(s.byEngine[0]).toMatchObject({ key: 'codex', estimatedCostUsd: 2.25 });
  });
});
