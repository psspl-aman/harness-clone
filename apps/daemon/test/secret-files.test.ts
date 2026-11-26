import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSecretFile } from '../src/services/git';
import { commitAll, withheldSecrets } from '../src/services/orchestrator/git-ops';
import { GIT_ID, tempDir, writeTree } from './helpers';

describe('isSecretFile', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    'apps/api/.env',
    'apps/api/.env.development.local',
    'certs/server.pem',
    'id_rsa.key',
    'cert.p12',
    '.npmrc',
  ])('treats %s as a secret', (path) => expect(isSecretFile(path)).toBe(true));

  it.each([
    '.env.example',
    '.env.sample',
    '.env.template',
    '.env.dist',
    'apps/api/.env.example',
    'src/env.ts',
    'README.md',
  ])('allows %s', (path) => expect(isSecretFile(path)).toBe(false));
});

describe('commitAll', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', [...GIT_ID, ...args], { cwd: repo, encoding: 'utf8' }).trim();

  beforeEach(() => {
    repo = tempDir('af-secrets-');
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'base');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  it('commits env templates but never real env files', async () => {
    writeTree(repo, {
      '.env': 'API_KEY=real', // gforge:allow — fake fixture
      '.env.example': 'API_KEY=\n',
      'src/index.ts': 'export {};\n',
    });
    const c = await commitAll(repo, 'task');
    expect(c.commit).not.toBeNull();
    expect(c.skippedSecrets).toEqual(['.env']);
    expect(git('ls-files').split('\n').sort()).toEqual(['.env.example', 'src/index.ts']);
  });

  it('lists withheld secrets, but not gitignored ones', async () => {
    writeTree(repo, {
      '.gitignore': '.env.local\n',
      '.env': 'API_KEY=real', // gforge:allow — fake fixture
      '.env.local': 'API_KEY=local', // gforge:allow — fake fixture
      'certs/dev.pem': 'KEY',
      '.env.example': 'API_KEY=\n',
    });
    await commitAll(repo, 'task');
    expect((await withheldSecrets(repo)).sort()).toEqual(['.env', 'certs/dev.pem']);
  });
});
