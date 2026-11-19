import { createHash } from 'node:crypto';

/** A problem found in terminal/run output. */
export interface DetectedError {
  matcher: string;
  message: string;
  filePath: string | null;
  line: number | null;
  column: number | null;
  /** Surrounding output lines, for the agent and the Errors panel. */
  excerpt: string;
}

/**
 * Matchers see one line at a time plus the recent lines before it. Stateful
 * matchers (tracebacks, stacks) look back through `recent`.
 */
export interface ErrorMatcher {
  id: string;
  stack: string;
  match(line: string, recent: string[]): Omit<DetectedError, 'matcher' | 'excerpt'> | null;
}

// eslint-disable-next-line no-control-regex -- matching ANSI escape sequences is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

const num = (s: string | undefined) => (s ? Number(s) : null);
const rel = (p: string) => p.replace(/^\.\//, '').replace(/^file:\/\//, '');

export const MATCHERS: ErrorMatcher[] = [
  {
    id: 'typescript',
    stack: 'TypeScript',
    match: (l) => {
      const m = l.match(
        /^\s*(\S+\.(?:tsx?|mts|cts))[(:](\d+)[,:](\d+)\)?:?\s*-?\s*error\s+(TS\d+):\s*(.+)$/,
      );
      return m
        ? {
            message: `${m[4]}: ${m[5]!.trim()}`,
            filePath: rel(m[1]!),
            line: num(m[2]),
            column: num(m[3]),
          }
        : null;
    },
  },
  {
    id: 'js-exception',
    stack: 'JavaScript',
    // "TypeError: x is not a function" followed by "at fn (file:line:col)" on the next line.
    match: (l, recent) => {
      const at = l.match(
        /^\s+at (?:.*? \()?((?:\/|\.\.?\/|[A-Za-z]:\\|file:\/\/)?[^():\s][^():]*\.[A-Za-z]{1,5}):(\d+):(\d+)\)?$/,
      );
      if (!at) return null;
      const prev = recent.at(-1) ?? '';
      const head = prev.match(
        /^(?:Uncaught\s+)?((?:[A-Z][A-Za-z]*)?Error|[A-Z][A-Za-z]*Exception)(?:\s*\[[A-Z_]+\])?:\s*(.+)$/,
      );
      if (!head || at[1]!.includes('node_modules') || at[1]!.startsWith('node:')) return null;
      return {
        message: `${head[1]}: ${head[2]!.trim()}`,
        filePath: rel(at[1]!),
        line: num(at[2]),
        column: num(at[3]),
      };
    },
  },
  {
    id: 'python-traceback',
    stack: 'Python',
    // Final line of a traceback, after "Traceback (most recent call last):".
    match: (l, recent) => {
      const m = l.match(
        /^([A-Za-z_][\w.]*(?:Error|Exception|Warning)|KeyboardInterrupt|SystemExit):?\s*(.*)$/,
      );
      if (!m) return null;
      const start = recent.findLastIndex((x) => x.startsWith('Traceback (most recent call last):'));
      if (start < 0) return null;
      const frames = recent
        .slice(start)
        .map((x) => x.match(/^\s*File "([^"]+)", line (\d+)/))
        .filter((x) => !!x && !x[1]!.includes('site-packages') && !x[1]!.startsWith('<'));
      const last = frames.at(-1);
      return {
        message: `${m[1]}${m[2] ? `: ${m[2].trim()}` : ''}`,
        filePath: last ? rel(last[1]!) : null,
        line: last ? num(last[2]) : null,
        column: null,
      };
    },
  },
  {
    id: 'go',
    stack: 'Go',
    match: (l) => {
      const m = l.match(/^(?:\.\/)?([\w./-]+\.go):(\d+):(\d+):\s+(.+)$/);
      if (m)
        return { message: m[4]!.trim(), filePath: rel(m[1]!), line: num(m[2]), column: num(m[3]) };
      const p = l.match(/^panic:\s+(.+)$/);
      return p ? { message: `panic: ${p[1]}`, filePath: null, line: null, column: null } : null;
    },
  },
  {
    id: 'rust',
    stack: 'Rust',
    // "error[E0425]: msg" then "  --> src/main.rs:3:5"
    match: (l, recent) => {
      const at = l.match(/^\s*-->\s+([^:]+):(\d+):(\d+)/);
      if (!at) return null;
      const head = [...recent]
        .reverse()
        .slice(0, 4)
        .find((x) => /^error(\[E\d+\])?:/.test(x));
      return head
        ? {
            message: head.replace(/^error/, 'error').trim(),
            filePath: rel(at[1]!),
            line: num(at[2]),
            column: num(at[3]),
          }
        : null;
    },
  },
  {
    id: 'java',
    stack: 'Java',
    match: (l, recent) => {
      const javac =
        l.match(/^([\w./-]+\.(?:java|kt)):(\d+):\s+error:\s+(.+)$/) ??
        l.match(/^e:\s+(?:file:\/\/)?([\w./-]+\.kt):\s*\(?(\d+),?\s*\d*\)?:?\s*(.+)$/);
      if (javac)
        return {
          message: javac[3]!.trim(),
          filePath: rel(javac[1]!),
          line: num(javac[2]),
          column: null,
        };
      const at = l.match(/^\s+at\s+[\w.$]+\(([\w$]+\.(?:java|kt)):(\d+)\)$/);
      const head = recent
        .at(-1)
        ?.match(
          /^(?:Exception in thread "[^"]+"\s+)?((?:[a-z]\w*\.)+\w*(?:Exception|Error)):?\s*(.*)$/,
        );
      return at && head
        ? {
            message: `${head[1]}${head[2] ? `: ${head[2]}` : ''}`,
            filePath: at[1]!,
            line: num(at[2]),
            column: null,
          }
        : null;
    },
  },
  {
    id: 'test-failure',
    stack: 'Tests',
    match: (l) => {
      const pytest = l.match(/^FAILED\s+([\w./-]+\.py)::(\S+)(?:\s+-\s+(.+))?$/);
      if (pytest)
        return {
          message: `Test failed: ${pytest[2]}${pytest[3] ? ` — ${pytest[3]}` : ''}`,
          filePath: rel(pytest[1]!),
          line: null,
          column: null,
        };
      const jest = l.match(/^\s*FAIL\s+([\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?)\b/);
      if (jest)
        return {
          message: `Test file failed: ${jest[1]}`,
          filePath: rel(jest[1]!),
          line: null,
          column: null,
        };
      const vit = l.match(
        /^\s*(?:×|✗|✕)\s+([\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?)\s+>\s+(.+?)(?:\s+\d+ms)?$/,
      );
      if (vit)
        return {
          message: `Test failed: ${vit[2]}`,
          filePath: rel(vit[1]!),
          line: null,
          column: null,
        };
      const node = l.match(/^not ok \d+ - (.+)$/);
      return node
        ? { message: `Test failed: ${node[1]}`, filePath: null, line: null, column: null }
        : null;
    },
  },
  {
    id: 'bundler',
    stack: 'Build tools',
    match: (l) => {
      const vite = l.match(/\[vite\]\s+(?:Internal server error|Pre-transform error):\s+(.+)$/);
      if (vite) return { message: vite[1]!.trim(), filePath: null, line: null, column: null };
      const next = l.match(/^(?:⨯|Error:)\s+(\.\/[\w./-]+):(\d+):(\d+)$/);
      if (next)
        return {
          message: `Build error in ${next[1]}`,
          filePath: rel(next[1]!),
          line: num(next[2]),
          column: num(next[3]),
        };
      const esbuild = l.match(/^✘ \[ERROR\]\s+(.+)$/);
      if (esbuild) return { message: esbuild[1]!.trim(), filePath: null, line: null, column: null };
      const mod = l.match(
        /(?:Module not found|Cannot find module)[:\s]+(?:Error:\s*)?(?:Can't resolve\s+)?'([^']+)'/,
      );
      return mod
        ? { message: `Cannot resolve module '${mod[1]}'`, filePath: null, line: null, column: null }
        : null;
    },
  },
];

/** Stable id for "the same error": matcher + file + normalised message (numbers and quoted values blurred). */
export function fingerprint(e: Pick<DetectedError, 'matcher' | 'message' | 'filePath'>): string {
  const norm = e.message
    .replace(/'[^']*'|"[^"]*"/g, '"…"')
    .replace(/\b\d+\b/g, 'N')
    .slice(0, 300);
  return createHash('sha1')
    .update(`${e.matcher}|${e.filePath ?? ''}|${norm}`)
    .digest('hex')
    .slice(0, 20);
}

/** Feeds output chunks through the matchers, keeping a little history for context. */
export class OutputScanner {
  private partial = '';
  private readonly recent: string[] = [];

  constructor(
    private readonly onError: (e: DetectedError) => void,
    private readonly matchers: ErrorMatcher[] = MATCHERS,
  ) {}

  push(chunk: string): void {
    const text = this.partial + stripAnsi(chunk).replace(/\r(?!\n)/g, '\n');
    const lines = text.split(/\r?\n/);
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  flush(): void {
    if (this.partial) this.line(this.partial);
    this.partial = '';
  }

  /** Last `n` lines seen (for "process exited" errors). */
  tail(n = 30): string {
    return this.recent.slice(-n).join('\n');
  }

  private line(raw: string) {
    const line = raw.replace(/\s+$/, '');
    for (const m of this.matchers) {
      const hit = m.match(line, this.recent);
      if (hit) {
        this.onError({
          ...hit,
          matcher: m.id,
          excerpt: [...this.recent.slice(-12), line].join('\n'),
        });
        break;
      }
    }
    this.recent.push(line);
    if (this.recent.length > 80) this.recent.shift();
  }
}
