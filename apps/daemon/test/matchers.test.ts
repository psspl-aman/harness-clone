import { describe, expect, it } from 'vitest';
import { fingerprint, OutputScanner, type DetectedError } from '../src/services/errors/matchers';

const scan = (text: string) => {
  const found: DetectedError[] = [];
  const s = new OutputScanner((e) => found.push(e));
  s.push(text);
  s.flush();
  return found;
};

describe('error matchers', () => {
  it('TypeScript (tsc and tsc --pretty)', () => {
    expect(
      scan("src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n"),
    ).toMatchObject([
      {
        matcher: 'typescript',
        filePath: 'src/app.ts',
        line: 12,
        column: 5,
        message: "TS2322: Type 'string' is not assignable to type 'number'.",
      },
    ]);
    expect(
      scan(
        "\u001b[96msrc/x.tsx\u001b[0m:\u001b[93m3\u001b[0m:\u001b[93m9\u001b[0m - \u001b[91merror\u001b[0m TS2304: Cannot find name 'foo'.",
      ),
    ).toMatchObject([{ filePath: 'src/x.tsx', line: 3, column: 9 }]);
  });

  it('Node exceptions with the first non-library frame', () => {
    const out =
      'TypeError: user.name is not a function\n    at greet (/work/app/src/greet.js:4:15)\n    at Object.<anonymous> (/work/app/index.js:2:1)\n';
    expect(scan(out)).toMatchObject([
      {
        matcher: 'js-exception',
        message: 'TypeError: user.name is not a function',
        filePath: '/work/app/src/greet.js',
        line: 4,
        column: 15,
      },
    ]);
    expect(scan('Error: boom\n    at foo (node:internal/x:1:1)\n')).toEqual([]);
  });

  it('Python tracebacks point at the last project frame', () => {
    const out =
      'Traceback (most recent call last):\n  File "app/main.py", line 10, in <module>\n    run()\n  File "/usr/lib/python3.12/site-packages/x.py", line 5, in run\nKeyError: \'user_id\'\n';
    expect(scan(out)).toMatchObject([
      {
        matcher: 'python-traceback',
        message: "KeyError: 'user_id'",
        filePath: 'app/main.py',
        line: 10,
      },
    ]);
    expect(scan("KeyError: 'x'\n")).toEqual([]); // no traceback → not an error report
  });

  it('Go, Rust and Java', () => {
    expect(scan('./main.go:12:2: undefined: foo\n')).toMatchObject([
      { matcher: 'go', filePath: 'main.go', line: 12, column: 2, message: 'undefined: foo' },
    ]);
    expect(
      scan('error[E0425]: cannot find value `x` in this scope\n --> src/main.rs:3:5\n'),
    ).toMatchObject([
      {
        matcher: 'rust',
        filePath: 'src/main.rs',
        line: 3,
        message: 'error[E0425]: cannot find value `x` in this scope',
      },
    ]);
    expect(scan('src/Main.java:7: error: cannot find symbol\n')).toMatchObject([
      { matcher: 'java', filePath: 'src/Main.java', line: 7 },
    ]);
    expect(
      scan(
        'Exception in thread "main" java.lang.IllegalStateException: bad\n\tat com.acme.App.run(App.java:42)\n',
      ),
    ).toMatchObject([
      {
        matcher: 'java',
        message: 'java.lang.IllegalStateException: bad',
        filePath: 'App.java',
        line: 42,
      },
    ]);
  });

  it('test runners and bundlers', () => {
    expect(
      scan('FAILED tests/test_api.py::test_create - AssertionError: 404 != 201\n'),
    ).toMatchObject([
      {
        matcher: 'test-failure',
        filePath: 'tests/test_api.py',
        message: 'Test failed: test_create — AssertionError: 404 != 201',
      },
    ]);
    expect(scan(' FAIL  src/sum.test.ts > adds numbers\n')).toMatchObject([
      { filePath: 'src/sum.test.ts' },
    ]);
    expect(scan(' × src/sum.test.ts > adds numbers 3ms\n')).toMatchObject([
      { message: 'Test failed: adds numbers' },
    ]);
    expect(scan('not ok 2 - greets by name\n')).toMatchObject([
      { message: 'Test failed: greets by name' },
    ]);
    expect(
      scan('12:00:01 [vite] Internal server error: Failed to resolve import "./missing"\n'),
    ).toMatchObject([{ matcher: 'bundler' }]);
    expect(scan("Module not found: Error: Can't resolve './Button'\n")).toMatchObject([
      { message: "Cannot resolve module './Button'" },
    ]);
  });

  it('handles chunked output, CRLF and ANSI; ignores normal logs', () => {
    const found: DetectedError[] = [];
    const s = new OutputScanner((e) => found.push(e));
    s.push('compiling...\r\nsrc/a.ts(1,1): err');
    s.push("or TS1005: ';' expected.\r\nready in 300ms\n");
    expect(found).toMatchObject([{ filePath: 'src/a.ts', message: "TS1005: ';' expected." }]);
    expect(found[0]!.excerpt).toContain('compiling...');
    expect(scan('Server listening on http://localhost:3000\nGET / 200 4ms\n')).toEqual([]);
  });

  it('fingerprints group repeats but keep different files apart', () => {
    const a = fingerprint({
      matcher: 'typescript',
      filePath: 'a.ts',
      message: "TS2322: Type 'x' not assignable (line 12)",
    });
    const b = fingerprint({
      matcher: 'typescript',
      filePath: 'a.ts',
      message: "TS2322: Type 'y' not assignable (line 40)",
    });
    const c = fingerprint({
      matcher: 'typescript',
      filePath: 'b.ts',
      message: "TS2322: Type 'x' not assignable (line 12)",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
