import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeProject, stackFromReport } from '../src/services/onboarding/analyzer';
import { GIT_ID, tempDir, writeTree } from './helpers';

const dirs: string[] = [];
const fixture = (files: Record<string, string>) => {
  const d = tempDir();
  dirs.push(d);
  writeTree(d, files);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('onboarding analyzer', () => {
  it('detects a pnpm Next.js monorepo with commands, conventions and env files', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({
        name: 'shop',
        packageManager: 'pnpm@10.0.0',
        scripts: { dev: 'next dev', build: 'next build', test: 'vitest run', lint: 'eslint .' },
        dependencies: { next: '16', react: '19' },
        devDependencies: { typescript: '5', vitest: '3', tailwindcss: '4' },
      }),
      'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - "packages/*"\n',
      'pnpm-lock.yaml': '',
      'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
      'eslint.config.mjs': 'export default []',
      '.prettierrc': '{}',
      '.env': 'SECRET=should-never-be-read', // gforge:allow — fake fixture
      '.env.example': 'SECRET=',
      'apps/web/package.json': JSON.stringify({ dependencies: { 'framer-motion': '1' } }),
      'apps/web/src/page.tsx': 'export default 1',
      'apps/web/src/page.test.tsx': 'test',
      'packages/ui/package.json': JSON.stringify({ dependencies: { fastify: '5' } }),
      'packages/ui/index.ts': 'export {}',
      'node_modules/next/index.js': 'ignored',
      '.github/workflows/ci.yml': 'on: push',
      'README.md': '# shop',
    });
    const r = await analyzeProject(dir);
    expect(r.packageManagers).toEqual(['pnpm']);
    expect(r.frameworks).toEqual(
      expect.arrayContaining([
        'Next.js',
        'React',
        'TypeScript',
        'Tailwind CSS',
        'Vitest',
        'Fastify',
      ]),
    );
    expect(r.commands).toMatchObject({
      install: { command: 'pnpm install' },
      run: { command: 'pnpm dev', source: 'package.json scripts.dev' },
      build: { command: 'pnpm build' },
      test: { command: 'pnpm test' },
      lint: { command: 'pnpm lint' },
    });
    expect(r.monorepo).toEqual({ tool: 'pnpm workspaces', packages: ['apps/web', 'packages/ui'] });
    expect(r.envFiles).toEqual(['.env', '.env.example']);
    expect(JSON.stringify(r)).not.toContain('should-never-be-read');
    expect(r.conventions).toEqual(
      expect.arrayContaining([
        'TypeScript strict mode is enabled',
        'ESLint is configured',
        'Prettier is configured',
        'CI via GitHub Actions',
        'README present',
      ]),
    );
    expect(r.stats.files).toBeLessThan(20); // node_modules skipped
    expect(r.structure).toContain('apps/');
    expect(r.languages[0]?.name).toBe('TypeScript');
    expect(stackFromReport(r)).toEqual(expect.arrayContaining(['Next.js', 'React', 'TypeScript']));
  });

  it('ignores the npm placeholder test script and uses npm run for scripts', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({
        scripts: {
          start: 'node index.js',
          test: 'echo "Error: no test specified" && exit 1',
          build: 'tsc',
        },
        dependencies: { express: '5' },
      }),
      'package-lock.json': '{}',
      'index.js': '',
    });
    const r = await analyzeProject(dir);
    expect(r.commands.run?.command).toBe('npm start');
    expect(r.commands.build?.command).toBe('npm run build');
    expect(r.commands.test).toBeUndefined();
    expect(r.frameworks).toContain('Express');
  });

  it('detects Django with pytest via poetry', async () => {
    const dir = fixture({
      'pyproject.toml':
        '[tool.poetry]\nname="x"\n[tool.poetry.dependencies]\ndjango = "^5"\npytest = "^8"\nruff = "*"\n',
      'poetry.lock': '',
      'manage.py': '',
      'app/models.py': '',
      'tests/test_models.py': '',
    });
    const r = await analyzeProject(dir);
    expect(r.packageManagers).toEqual(['poetry']);
    expect(r.frameworks).toEqual(expect.arrayContaining(['Django', 'pytest']));
    expect(r.commands.install?.command).toBe('poetry install');
    expect(r.commands.run?.command).toBe('poetry run python manage.py runserver');
    expect(r.commands.test?.command).toBe('poetry run python manage.py test');
    expect(r.commands.lint?.command).toBe('poetry run ruff check .');
  });

  it('detects Go and Makefile fallbacks', async () => {
    const dir = fixture({
      'go.mod': 'module x\nrequire github.com/gin-gonic/gin v1.10.0\n',
      'main.go': 'package main',
      Makefile: 'lint:\n\tgolangci-lint run\n',
    });
    const r = await analyzeProject(dir);
    expect(r.frameworks).toContain('Gin');
    expect(r.commands.run?.command).toBe('go run .');
    expect(r.commands.test?.command).toBe('go test ./...');
    expect(r.commands.lint?.command).toBe('go vet ./...'); // first detection wins over Makefile
  });

  it('reports an empty folder and git details with a redacted remote', async () => {
    const empty = fixture({});
    const r0 = await analyzeProject(empty);
    expect(r0.stats.files).toBe(0);
    expect(r0.notes.join(' ')).toMatch(/empty/);
    expect(r0.git.isRepo).toBe(false);

    const repo = fixture({ 'a.py': 'print(1)', 'requirements.txt': 'flask\n' });
    execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: repo });
    const remoteWithCreds = 'https://user:ghp_secret@github.com/o/r.git'; // gforge:allow — fake fixture (tests redaction)
    execFileSync('git', ['remote', 'add', 'origin', remoteWithCreds], { cwd: repo });
    execFileSync('git', [...GIT_ID, 'add', '-A'], { cwd: repo });
    execFileSync('git', [...GIT_ID, 'commit', '-qm', 'first'], { cwd: repo });
    const r = await analyzeProject(repo);
    expect(r.git).toMatchObject({
      isRepo: true,
      branch: 'trunk',
      remote: 'https://github.com/o/r.git',
      dirty: false,
    });
    expect(r.git.lastCommit?.message).toBe('first');
    expect(r.commands.run?.command).toBe('flask run --debug');
  });
});

describe('emptiness', () => {
  it('treats a folder holding only git housekeeping files as empty', async () => {
    const dir = fixture({ '.gitignore': '.env\n' });
    const r = await analyzeProject(dir);
    expect(r.notes.join(' ')).toMatch(/folder is empty/);
    expect(r.notes.join(' ')).not.toMatch(/No run command/);
  });
});
