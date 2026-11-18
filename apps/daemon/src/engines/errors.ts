import type { EngineError, EngineErrorKind } from '@agentforge/shared';

const PATTERNS: [EngineErrorKind, RegExp][] = [
  [
    'AUTH_EXPIRED',
    /not (logged|signed) in|please (run )?\/?log ?in|log ?in again|invalid (api )?key|invalid x-api-key|authentication[_ ](error|failed|required)|unauthori[sz]ed|\b401\b|(token|session|credentials?|login) (has |have )?expired|oauth token|re-?authenticate/i,
  ],
  [
    'QUOTA_EXPIRED',
    /usage limit|limit (has been )?reached|hit your (usage |weekly |daily )?limit|quota (exceeded|exhausted)|exceeded your (current )?quota|out of (credits|usage)|credit balance is too low|resource[_ ]?exhausted|weekly limit|5-hour limit|five_hour/i,
  ],
  [
    'RATE_LIMIT',
    /rate.?limit|too many requests|\b429\b|overloaded|\b529\b|try again (later|shortly|in)/i,
  ],
  [
    'NETWORK',
    /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|network (error|is unreachable)|fetch failed|socket hang up|getaddrinfo|unable to connect|connection (reset|refused)/i,
  ],
  ['TOOL_ERROR', /tool (execution )?(failed|error)|permission denied for tool|command not found/i],
];

/** Map raw CLI output / error text to an EngineErrorKind (+ reset time when stated). */
export function classifyEngineError(text: string, now = Date.now()): EngineError {
  const message =
    text.trim().split('\n').filter(Boolean).slice(-6).join('\n').slice(0, 2000) || 'Unknown error';
  for (const [kind, re] of PATTERNS) {
    if (re.test(text)) {
      return {
        kind,
        message,
        resetAt: kind === 'RATE_LIMIT' || kind === 'QUOTA_EXPIRED' ? parseResetAt(text, now) : null,
      };
    }
  }
  return { kind: 'UNKNOWN', message, resetAt: null };
}

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000 };

/**
 * Extract "when does the limit reset" from free text. Understands:
 *  - `…|1700000000` epoch suffixes (seconds or ms)
 *  - ISO timestamps
 *  - relative durations: "in 2h 15m", "after 45 minutes", "in 30 seconds"
 *  - clock times: "resets 3pm", "at 4:05 PM", "until 15:30" (local time, next occurrence)
 */
export function parseResetAt(text: string, now = Date.now()): number | null {
  const epoch = text.match(/\|(\d{10,13})\b/);
  if (epoch) {
    const n = Number(epoch[1]);
    return n < 1e12 ? n * 1000 : n;
  }
  const iso = text.match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/,
  );
  if (iso) {
    const t = Date.parse(iso[0]);
    if (!Number.isNaN(t)) return t;
  }
  const rel = text.match(
    /(?:in|after)\s+((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i,
  );
  if (rel) {
    let ms = 0;
    for (const m of rel[1]!.matchAll(/(\d+)\s*(h|m|s)/gi))
      ms += Number(m[1]) * UNIT_MS[m[2]!.toLowerCase()]!;
    if (ms > 0) return now + ms;
  }
  const clock = text.match(
    /(?:\bat|\bresets?(?:\s+at)?|\buntil)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
  );
  if (clock && (clock[2] !== undefined || clock[3] !== undefined)) {
    let h = Number(clock[1]);
    const min = Number(clock[2] ?? 0);
    const ap = clock[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}
