import { describe, expect, it } from 'vitest';
import { classifyEngineError, parseResetAt } from '../src/engines/errors';
import { expandArgs } from '../src/engines/adapters/custom';

const NOW = new Date(2026, 10, 18, 10, 0, 0).getTime(); // local 10:00

describe('classifyEngineError', () => {
  it.each([
    ['Invalid API key · Please run /login', 'AUTH_EXPIRED'],
    ['OAuth token has expired. Please log in again.', 'AUTH_EXPIRED'],
    ['Error: Not logged in', 'AUTH_EXPIRED'],
    ["You've hit your limit · resets 3pm", 'QUOTA_EXPIRED'],
    ['Claude AI usage limit reached|1795014000', 'QUOTA_EXPIRED'],
    ['[API Error: Quota exceeded for quota metric. (Status: 429)]', 'QUOTA_EXPIRED'],
    ['429 Too Many Requests', 'RATE_LIMIT'],
    ['API Error: Overloaded', 'RATE_LIMIT'],
    ['getaddrinfo ENOTFOUND api.anthropic.com', 'NETWORK'],
    ['Something odd happened', 'UNKNOWN'],
  ])('%s → %s', (text, kind) => {
    expect(classifyEngineError(text, NOW).kind).toBe(kind);
  });

  it('keeps only the tail of long output as the message', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    expect(classifyEngineError(text).message.split('\n')).toHaveLength(6);
  });
});

describe('parseResetAt', () => {
  it('parses epoch suffixes in seconds or ms', () => {
    expect(parseResetAt('usage limit reached|1795014000', NOW)).toBe(1795014000_000);
    expect(parseResetAt('limit|1795014000123', NOW)).toBe(1795014000123);
  });
  it('parses ISO timestamps', () => {
    expect(parseResetAt('retry after 2026-11-18T15:00:00Z', NOW)).toBe(
      Date.parse('2026-11-18T15:00:00Z'),
    );
  });
  it('parses relative durations', () => {
    expect(parseResetAt('Try again in 2 hours 5 minutes.', NOW)).toBe(
      NOW + 2 * 3600_000 + 5 * 60_000,
    );
    expect(parseResetAt('Please retry in 41s.', NOW)).toBe(NOW + 41_000);
    expect(parseResetAt('available after 3h', NOW)).toBe(NOW + 3 * 3600_000);
  });
  it('parses clock times as the next occurrence (local time)', () => {
    expect(new Date(parseResetAt("You've hit your limit · resets 3pm", NOW)!).getHours()).toBe(15);
    const early = parseResetAt('resets at 9:30 am', NOW)!; // already past today → tomorrow
    expect(new Date(early).getDate()).toBe(19);
    expect(new Date(parseResetAt('until 18:45', NOW)!).getMinutes()).toBe(45);
  });
  it('ignores bare numbers that are not times', () => {
    expect(parseResetAt('failed at 3 files', NOW)).toBeNull();
    expect(parseResetAt('no reset info', NOW)).toBeNull();
  });
});

describe('custom engine arg templates', () => {
  it('substitutes placeholders and drops empty flag pairs', () => {
    expect(
      expandArgs(['run', '--model', '{{model}}', '--cwd={{cwd}}', '{{prompt}}'], {
        model: '',
        cwd: '/w',
        prompt: 'hi there',
      }),
    ).toEqual(['run', '--cwd=/w', 'hi there']);
    expect(expandArgs(['--model', '{{model}}'], { model: 'big' })).toEqual(['--model', 'big']);
    expect(expandArgs(['{{sessionId}}'], {})).toEqual([]);
  });
});
