import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRedactor } from '../src/safety/redact';
import { formatEnvValue, parseDotenv, upsertEnvLine } from '../src/services/env-keys';
import { commitAll } from '../src/services/orchestrator/git-ops';
import { createTestApp, GIT_ID, tempDir, writeTree, type TestApp } from './helpers';

// Fake, OpenAI-shaped value (not a real key).
const KEY = `sk-proj-${'A1b2'.repeat(10)}`; // gforge:allow — fake fixture

describe('env keys the user fills in', () => {
  let t: TestApp;
  let dir: string;
  let projectId: string;
  const git = (...args: string[]) =>
    execFileSync('git', [...GIT_ID, ...args], { cwd: dir, encoding: 'utf8' }).trim();

  beforeEach(async () => {
    t = await createTestApp();
    dir = tempDir('af-envkeys-');
    writeTree(dir, { 'README.md': '# bot\n', 'api/chat.ts': 'export {};\n' });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'init');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { mode: 'existing', location: { kind: 'local', path: dir, initGit: true } },
    });
    expect(res.statusCode).toBe(201);
    projectId = res.json().id;
  });
  afterEach(async () => {
    await t.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const list = async () =>
    (await t.app.inject({ method: 'GET', url: `/api/projects/${projectId}/env-keys` })).json() as {
      id: string;
      name: string;
      file: string;
      status: string;
      length: number | null;
      secret: boolean;
      source: string;
    }[];
  const setValue = (id: string, value: string) =>
    t.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/env-keys/${id}/value`,
      payload: { value },
    });

  it('asks for a key an agent declares and writes the value only into the gitignored .env', async () => {
    const r = t.ctx.envKeys.request(
      projectId,
      { name: 'OPENAI_API_KEY', folder: 'api', why: 'Chat completions' },
      'BOT-1',
    );
    expect(r).toMatchObject({ file: 'api/.env', status: 'pending', secret: true });
    expect(r).not.toHaveProperty('value');

    const res = await setValue(r.id, KEY);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(KEY);
    expect(res.json().request).toMatchObject({ status: 'set', length: KEY.length });
    expect(res.json().warnings).toEqual([]);

    expect(readFileSync(join(dir, 'api/.env'), 'utf8')).toBe(`OPENAI_API_KEY=${KEY}\n`);
    if (process.platform !== 'win32')
      expect(statSync(join(dir, 'api/.env')).mode & 0o777).toBe(0o600);
    expect(git('check-ignore', 'api/.env')).toBe('api/.env');
    // Not kept by AgentForge: not in the API, the database or the settings store.
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/projects/${projectId}/env-keys` })).body,
    ).not.toContain(KEY);
    expect(readFileSync(join(t.home, 'agentforge.db')).includes(Buffer.from(KEY))).toBe(false);
  });

  it('picks up names added to a .env.example, and keeps other .env lines', async () => {
    writeTree(dir, {
      'api/.env.example': 'OPENAI_API_KEY=\nMODEL=gpt-4o-mini\n', // gforge:allow — fake fixture
      'api/.env': '# local\nMODEL=gpt-4o-mini\nOPENAI_API_KEY=\n',
    });
    const keys = await list();
    expect(keys.map((k) => [k.name, k.file, k.status, k.source]).sort()).toEqual([
      ['MODEL', 'api/.env', 'set', 'example'],
      ['OPENAI_API_KEY', 'api/.env', 'pending', 'example'],
    ]);
    const openai = keys.find((k) => k.name === 'OPENAI_API_KEY')!;
    expect((await setValue(openai.id, KEY)).statusCode).toBe(200);
    expect(readFileSync(join(dir, 'api/.env'), 'utf8')).toBe(
      `# local\nMODEL=gpt-4o-mini\nOPENAI_API_KEY=${KEY}\n`,
    );
  });

  it('warns when the .env is tracked by git', async () => {
    writeTree(dir, { '.env': 'X=1\n' });
    git('add', '-f', '.env');
    git('commit', '-q', '--no-verify', '-m', 'oops');
    const r = t.ctx.envKeys.request(projectId, { name: 'OPENAI_API_KEY' });
    const res = await setValue(r.id, KEY);
    expect(res.json().warnings.join(' ')).toMatch(/already tracked by git/);
  });

  it('refuses folders outside the project, symlinked .env files and reserved names', async () => {
    expect(() =>
      t.ctx.envKeys.request(projectId, { name: 'OPENAI_API_KEY', folder: '../x' }),
    ).toThrow();
    expect(() => t.ctx.envKeys.request(projectId, { name: 'PATH' })).toThrow();
    expect(() => t.ctx.envKeys.request(projectId, { name: 'NODE_OPTIONS' })).toThrow();
    const outside = tempDir('af-outside-');
    writeFileSync(join(outside, 'target'), '');
    symlinkSync(join(outside, 'target'), join(dir, '.env'));
    const r = t.ctx.envKeys.request(projectId, { name: 'OPENAI_API_KEY' });
    expect((await setValue(r.id, KEY)).statusCode).toBe(400);
    expect(readFileSync(join(outside, 'target'), 'utf8')).toBe('');
    rmSync(outside, { recursive: true, force: true });
  });

  it('masks the value in logs and keeps it out of every commit', async () => {
    const r = t.ctx.envKeys.request(projectId, { name: 'OPENAI_API_KEY', folder: 'api' });
    await setValue(r.id, KEY);
    const redact = createRedactor(() => t.ctx.envKeys.knownValues());
    expect(redact(`calling openai with ${KEY}`)).toBe('calling openai with [REDACTED]');

    // An agent pasting it into source: not committed.
    writeTree(dir, { 'api/chat.ts': `const key = '${KEY}';\n`, 'api/ok.ts': 'export {};\n' });
    const c = await commitAll(dir, 'task', { secretValues: t.ctx.envKeys.knownValues() });
    expect(c.leakedSecrets).toEqual(['api/chat.ts']);
    // (.gitignore changed because saving the key added the .env rules to it.)
    expect(c.files).toEqual(['.gitignore', 'api/ok.ts']);
    expect(git('show', '--name-only', '--format=', 'HEAD')).not.toContain('api/chat.ts');

    // The Git tab's Commit refuses it too.
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/git/commit`,
      payload: { message: 'wip' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/api\/chat\.ts contains a secret value/);
    expect(res.body).not.toContain(KEY);
  });

  it('skips a request until an agent asks again', async () => {
    const r = t.ctx.envKeys.request(projectId, { name: 'OPENAI_API_KEY' });
    await t.app.inject({ method: 'POST', url: `/api/projects/${projectId}/env-keys/${r.id}/skip` });
    expect((await list())[0]!.status).toBe('skipped');
    t.ctx.envKeys.request(projectId, { name: 'OPENAI_API_KEY' });
    expect((await list())[0]!.status).toBe('pending');
  });
});

describe('.env file format', () => {
  it.each([
    'plain',
    'sk-proj-abc_123',
    'has spaces and # hash',
    'cost $5 and ${HOME}',
    `it's "quoted"`,
    'back\\slash',
    '-----BEGIN KEY-----\nabc\n-----END KEY-----',
  ])('round-trips %j through dotenv quoting', (value) => {
    const text = upsertEnvLine('', 'K', value);
    expect(parseDotenv(text).get('K')).toBe(value);
  });

  it('single-quotes values with $ so dotenv-expand leaves them alone', () => {
    expect(formatEnvValue('cost $5')).toBe("'cost $5'");
  });

  it('replaces an existing (even multi-line) entry in place', () => {
    const before = 'A=1\nK="old\nvalue"\nB=2\nexport K=dup\n';
    expect(upsertEnvLine(before, 'K', 'new')).toBe('A=1\nK=new\nB=2\n');
  });
});

describe('redaction of prefixed key names', () => {
  it('masks OPENAI_API_KEY= and Stripe-style secrets', () => {
    const r = createRedactor(() => []);
    expect(r('OPENAI_API_KEY=abcdefgh12345678')).toBe('OPENAI_API_KEY=[REDACTED]'); // gforge:allow — fake fixture
    expect(r(`sk_test_51${'Z'.repeat(30)}`)).toBe('[REDACTED]'); // gforge:allow — fake fixture
    expect(r(`whsec_${'Q'.repeat(32)}`)).toBe('[REDACTED]'); // gforge:allow — fake fixture
    expect(r('nothing secret here')).toBe('nothing secret here');
  });
});
