import type { COMMAND_KEYS, DetectedCommand, OnboardingReport } from '@ai-harness/shared';
import { existsSync } from 'node:fs';
import { opendir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { redactRemote } from '../../lib/paths';
import { PROJECT_DATA_DIR_NAMES } from '../../lib/project-data-dir';
import { git, isRepoRoot } from '../git';

type CommandKey = (typeof COMMAND_KEYS)[number];

/** Directories that are never interesting for analysis. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  '.idea',
  '.vscode',
  'bin',
  'obj',
  '.dart_tool',
  'Pods',
  '.terraform',
  ...PROJECT_DATA_DIR_NAMES,
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  scala: 'Scala',
  rb: 'Ruby',
  php: 'PHP',
  cs: 'C#',
  fs: 'F#',
  swift: 'Swift',
  m: 'Objective-C',
  dart: 'Dart',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  cc: 'C++',
  hpp: 'C++',
  ex: 'Elixir',
  exs: 'Elixir',
  erl: 'Erlang',
  hs: 'Haskell',
  clj: 'Clojure',
  lua: 'Lua',
  r: 'R',
  jl: 'Julia',
  zig: 'Zig',
  sol: 'Solidity',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sql: 'SQL',
  sh: 'Shell',
  bash: 'Shell',
  ps1: 'PowerShell',
  tf: 'Terraform',
};
const HOUSEKEEPING_FILES = new Set(['.gitignore', '.gitattributes', '.DS_Store', '.editorconfig']);

/** Markup/style languages are listed but don't define the stack on their own. */
const SECONDARY_LANGS = new Set(['HTML', 'CSS', 'SCSS', 'Shell', 'SQL', 'PowerShell']);

const JS_FRAMEWORKS: [dep: string, label: string][] = [
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['@remix-run/react', 'Remix'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['astro', 'Astro'],
  ['@angular/core', 'Angular'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['solid-js', 'Solid'],
  ['react-native', 'React Native'],
  ['expo', 'Expo'],
  ['electron', 'Electron'],
  ['@tauri-apps/api', 'Tauri'],
  ['react', 'React'],
  ['@nestjs/core', 'NestJS'],
  ['fastify', 'Fastify'],
  ['express', 'Express'],
  ['hono', 'Hono'],
  ['koa', 'Koa'],
  ['vite', 'Vite'],
  ['tailwindcss', 'Tailwind CSS'],
  ['prisma', 'Prisma'],
  ['@prisma/client', 'Prisma'],
  ['drizzle-orm', 'Drizzle'],
  ['typeorm', 'TypeORM'],
  ['mongoose', 'Mongoose'],
  ['graphql', 'GraphQL'],
  ['@trpc/server', 'tRPC'],
  ['vitest', 'Vitest'],
  ['jest', 'Jest'],
  ['@playwright/test', 'Playwright'],
  ['cypress', 'Cypress'],
  ['storybook', 'Storybook'],
];
const PY_FRAMEWORKS: [pattern: RegExp, label: string][] = [
  [/\bdjango\b/i, 'Django'],
  [/\bfastapi\b/i, 'FastAPI'],
  [/\bflask\b/i, 'Flask'],
  [/\bstarlette\b/i, 'Starlette'],
  [/\bsqlalchemy\b/i, 'SQLAlchemy'],
  [/\bpydantic\b/i, 'Pydantic'],
  [/\bpytest\b/i, 'pytest'],
  [/\bcelery\b/i, 'Celery'],
  [/\bstreamlit\b/i, 'Streamlit'],
  [/\btorch\b/i, 'PyTorch'],
  [/\btensorflow\b/i, 'TensorFlow'],
  [/\bpandas\b/i, 'pandas'],
];

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
}

const readText = (p: string) => readFile(p, 'utf8').catch(() => null);
async function readJson<T>(p: string): Promise<T | null> {
  const t = await readText(p);
  if (!t) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

interface WalkResult {
  files: string[]; // relative paths
  dirs: number;
  truncated: boolean;
  extCounts: Map<string, number>;
}

async function walk(root: string, maxFiles = 20_000, maxDepth = 8): Promise<WalkResult> {
  const res: WalkResult = { files: [], dirs: 0, truncated: false, extCounts: new Map() };
  const queue: [string, number][] = [[root, 0]];
  while (queue.length) {
    const [dir, depth] = queue.shift()!;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      continue;
    }
    for await (const d of handle) {
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || (d.name.startsWith('.') && d.name !== '.github')) continue;
        res.dirs++;
        if (depth + 1 <= maxDepth) queue.push([full, depth + 1]);
      } else if (d.isFile()) {
        if (res.files.length >= maxFiles) {
          res.truncated = true;
          continue;
        }
        res.files.push(relative(root, full).split(sep).join('/'));
        const dot = d.name.lastIndexOf('.');
        if (dot > 0) {
          const ext = d.name.slice(dot + 1).toLowerCase();
          res.extCounts.set(ext, (res.extCounts.get(ext) ?? 0) + 1);
        }
      }
    }
  }
  return res;
}

function runner(pm: string | undefined) {
  switch (pm) {
    case 'pnpm':
      return { install: 'pnpm install', script: (s: string) => `pnpm ${s}` };
    case 'yarn':
      return { install: 'yarn install', script: (s: string) => `yarn ${s}` };
    case 'bun':
      return { install: 'bun install', script: (s: string) => `bun run ${s}` };
    default:
      return {
        install: 'npm install',
        script: (s: string) => (s === 'test' || s === 'start' ? `npm ${s}` : `npm run ${s}`),
      };
  }
}

/** Build a depth-limited outline of the tree for prompts and the UI. */
function outline(files: string[], maxDepth = 2, maxLines = 60): string {
  interface Node {
    children: Map<string, Node>;
    files: number;
  }
  const rootNode: Node = { children: new Map(), files: 0 };
  for (const f of files) {
    const parts = f.split('/');
    let node = rootNode;
    for (let i = 0; i < parts.length - 1 && i < maxDepth; i++) {
      const name = parts[i]!;
      if (!node.children.has(name)) node.children.set(name, { children: new Map(), files: 0 });
      node = node.children.get(name)!;
    }
    node.files++;
  }
  const lines: string[] = [];
  const render = (node: Node, indent: string) => {
    for (const [name, child] of [...node.children.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (lines.length >= maxLines) return;
      const count = child.files ? ` (${child.files} file${child.files === 1 ? '' : 's'})` : '';
      lines.push(`${indent}${name}/${count}`);
      render(child, `${indent}  `);
    }
  };
  render(rootNode, '');
  const topFiles = files.filter((f) => !f.includes('/')).sort();
  for (const f of topFiles.slice(0, 25)) lines.push(f);
  if (topFiles.length > 25) lines.push(`… ${topFiles.length - 25} more files`);
  return lines.join('\n');
}

/**
 * Deterministic project analysis: no LLM involved, safe to run on any folder.
 * Never reads the contents of env files or anything that could hold secrets.
 */
export async function analyzeProject(root: string): Promise<OnboardingReport> {
  const started = Date.now();
  const tree = await walk(root);
  const fileSet = new Set(tree.files);
  const has = (f: string) => fileSet.has(f);
  const notes: string[] = [];
  const frameworks = new Set<string>();
  const packageManagers: string[] = [];
  const commands: Partial<Record<CommandKey, DetectedCommand>> = {};
  const setCmd = (k: CommandKey, command: string, source: string) => {
    if (!commands[k]) commands[k] = { command, source };
  };

  // ── Languages
  const langCounts = new Map<string, number>();
  for (const [ext, n] of tree.extCounts) {
    const lang = LANGUAGE_BY_EXT[ext];
    if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + n);
  }
  const totalLang = [...langCounts.values()].reduce((a, b) => a + b, 0) || 1;
  const languages = [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, files]) => ({ name, files, share: Math.round((files / totalLang) * 1000) / 10 }));

  // ── JavaScript / TypeScript
  const pkg = await readJson<PackageJson>(join(root, 'package.json'));
  let monorepo: OnboardingReport['monorepo'] = null;
  if (pkg) {
    let pm: string | undefined = pkg.packageManager?.split('@')[0];
    if (!pm) {
      if (has('pnpm-lock.yaml')) pm = 'pnpm';
      else if (has('yarn.lock')) pm = 'yarn';
      else if (has('bun.lockb') || has('bun.lock')) pm = 'bun';
      else if (has('package-lock.json')) pm = 'npm';
    }
    packageManagers.push(pm ?? 'npm');
    if (!pm) notes.push('No lockfile found; assuming npm.');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [dep, label] of JS_FRAMEWORKS) if (dep in deps) frameworks.add(label);
    if ('typescript' in deps || has('tsconfig.json')) frameworks.add('TypeScript');

    const r = runner(pm);
    setCmd('install', r.install, pm ? `${pm} lockfile` : 'package.json');
    const scripts = pkg.scripts ?? {};
    const pick = (key: CommandKey, names: string[]) => {
      for (const n of names) {
        const s = scripts[n];
        if (s && !/no test specified/.test(s))
          return setCmd(key, r.script(n), `package.json scripts.${n}`);
      }
    };
    pick('run', ['dev', 'start:dev', 'serve', 'start', 'develop']);
    pick('build', ['build', 'compile']);
    pick('test', ['test', 'test:unit', 'vitest', 'jest']);
    pick('lint', ['lint', 'check', 'typecheck']);

    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    const pnpmWs = has('pnpm-workspace.yaml')
      ? await readText(join(root, 'pnpm-workspace.yaml'))
      : null;
    const pnpmGlobs = pnpmWs
      ? [...pnpmWs.matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm)].map((m) => m[1]!.trim())
      : [];
    const globs = ws?.length ? ws : pnpmGlobs;
    if (globs.length || has('turbo.json') || has('nx.json') || has('lerna.json')) {
      const tool = has('turbo.json')
        ? 'Turborepo'
        : has('nx.json')
          ? 'Nx'
          : has('lerna.json')
            ? 'Lerna'
            : `${pm ?? 'npm'} workspaces`;
      const packages = tree.files
        .filter((f) => f.endsWith('/package.json') && f.split('/').length <= 4)
        .map((f) => f.slice(0, -'/package.json'.length))
        .sort();
      monorepo = { tool, packages };
      // Frameworks usually live in the workspace packages, not the root manifest.
      for (const dir of packages.slice(0, 40)) {
        const sub = await readJson<PackageJson>(join(root, dir, 'package.json'));
        const subDeps = { ...sub?.dependencies, ...sub?.devDependencies };
        for (const [dep, label] of JS_FRAMEWORKS) if (dep in subDeps) frameworks.add(label);
        if ('typescript' in subDeps) frameworks.add('TypeScript');
      }
    }
  } else if (has('deno.json') || has('deno.jsonc')) {
    packageManagers.push('deno');
    frameworks.add('Deno');
    setCmd('run', 'deno task dev', 'deno.json');
    setCmd('test', 'deno test', 'deno.json');
  }

  // ── Python
  const pyproject = has('pyproject.toml') ? await readText(join(root, 'pyproject.toml')) : null;
  const requirements = has('requirements.txt')
    ? await readText(join(root, 'requirements.txt'))
    : null;
  if (pyproject || requirements || has('setup.py') || has('Pipfile')) {
    const pm = has('uv.lock')
      ? 'uv'
      : has('poetry.lock') || /\[tool\.poetry\]/.test(pyproject ?? '')
        ? 'poetry'
        : has('Pipfile')
          ? 'pipenv'
          : 'pip';
    packageManagers.push(pm);
    const text = `${pyproject ?? ''}\n${requirements ?? ''}`;
    for (const [re, label] of PY_FRAMEWORKS) if (re.test(text)) frameworks.add(label);
    const prefix =
      pm === 'uv'
        ? 'uv run '
        : pm === 'poetry'
          ? 'poetry run '
          : pm === 'pipenv'
            ? 'pipenv run '
            : '';
    setCmd(
      'install',
      pm === 'uv'
        ? 'uv sync'
        : pm === 'poetry'
          ? 'poetry install'
          : pm === 'pipenv'
            ? 'pipenv install'
            : requirements
              ? 'pip install -r requirements.txt'
              : 'pip install -e .',
      `${pm} project`,
    );
    if (has('manage.py')) {
      frameworks.add('Django');
      setCmd('run', `${prefix}python manage.py runserver`, 'manage.py');
      setCmd('test', `${prefix}python manage.py test`, 'manage.py');
    } else if (frameworks.has('FastAPI')) {
      const entry = ['main.py', 'app/main.py', 'src/main.py'].find(has);
      if (entry)
        setCmd(
          'run',
          `${prefix}uvicorn ${entry.replace(/\.py$/, '').replace(/\//g, '.')}:app --reload`,
          `${entry} (FastAPI)`,
        );
    } else if (frameworks.has('Flask')) {
      setCmd('run', `${prefix}flask run --debug`, 'Flask');
    } else if (frameworks.has('Streamlit')) {
      const entry = ['app.py', 'main.py', 'streamlit_app.py'].find(has);
      if (entry) setCmd('run', `${prefix}streamlit run ${entry}`, 'Streamlit');
    }
    if (frameworks.has('pytest') || tree.files.some((f) => /(^|\/)tests?\/.*test_.*\.py$/.test(f)))
      setCmd('test', `${prefix}pytest`, 'pytest');
    if (/\bruff\b/.test(text)) setCmd('lint', `${prefix}ruff check .`, 'ruff');
  }

  // ── Go
  const gomod = has('go.mod') ? await readText(join(root, 'go.mod')) : null;
  if (gomod) {
    packageManagers.push('go modules');
    for (const [re, label] of [
      [/gin-gonic\/gin/, 'Gin'],
      [/labstack\/echo/, 'Echo'],
      [/gofiber\/fiber/, 'Fiber'],
      [/go-chi\/chi/, 'chi'],
    ] as const) {
      if (re.test(gomod)) frameworks.add(label);
    }
    setCmd('install', 'go mod download', 'go.mod');
    setCmd('run', has('main.go') ? 'go run .' : 'go run ./...', 'go.mod');
    setCmd('build', 'go build ./...', 'go.mod');
    setCmd('test', 'go test ./...', 'go.mod');
    setCmd('lint', 'go vet ./...', 'go.mod');
  }

  // ── Rust
  const cargo = has('Cargo.toml') ? await readText(join(root, 'Cargo.toml')) : null;
  if (cargo) {
    packageManagers.push('cargo');
    for (const [re, label] of [
      [/\baxum\b/, 'Axum'],
      [/\bactix-web\b/, 'Actix Web'],
      [/\brocket\b/, 'Rocket'],
      [/\btokio\b/, 'Tokio'],
      [/\btauri\b/, 'Tauri'],
    ] as const) {
      if (re.test(cargo)) frameworks.add(label);
    }
    setCmd('run', 'cargo run', 'Cargo.toml');
    setCmd('build', 'cargo build', 'Cargo.toml');
    setCmd('test', 'cargo test', 'Cargo.toml');
    setCmd('lint', 'cargo clippy', 'Cargo.toml');
  }

  // ── JVM
  const pom = has('pom.xml') ? await readText(join(root, 'pom.xml')) : null;
  const gradleFile = ['build.gradle.kts', 'build.gradle'].find(has);
  const gradle = gradleFile ? await readText(join(root, gradleFile)) : null;
  if (pom || gradle) {
    const spring = /spring-boot/.test(`${pom ?? ''}${gradle ?? ''}`);
    if (spring) frameworks.add('Spring Boot');
    if (pom) {
      packageManagers.push('maven');
      const mvn = has('mvnw') ? './mvnw' : 'mvn';
      if (spring) setCmd('run', `${mvn} spring-boot:run`, 'pom.xml');
      setCmd('build', `${mvn} package`, 'pom.xml');
      setCmd('test', `${mvn} test`, 'pom.xml');
    } else {
      packageManagers.push('gradle');
      const gw = has('gradlew') ? './gradlew' : 'gradle';
      setCmd('run', spring ? `${gw} bootRun` : `${gw} run`, gradleFile!);
      setCmd('build', `${gw} build`, gradleFile!);
      setCmd('test', `${gw} test`, gradleFile!);
    }
  }

  // ── Ruby / PHP / .NET / Dart
  if (has('Gemfile')) {
    packageManagers.push('bundler');
    const gemfile = (await readText(join(root, 'Gemfile'))) ?? '';
    setCmd('install', 'bundle install', 'Gemfile');
    if (/['"]rails['"]/.test(gemfile)) {
      frameworks.add('Rails');
      setCmd('run', 'bin/rails server', 'Gemfile (Rails)');
      setCmd('test', 'bin/rails test', 'Gemfile (Rails)');
    }
    if (/rspec/.test(gemfile)) setCmd('test', 'bundle exec rspec', 'Gemfile (RSpec)');
  }
  if (has('composer.json')) {
    packageManagers.push('composer');
    setCmd('install', 'composer install', 'composer.json');
    if (has('artisan')) {
      frameworks.add('Laravel');
      setCmd('run', 'php artisan serve', 'artisan');
      setCmd('test', 'php artisan test', 'artisan');
    }
  }
  if (tree.files.some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) {
    packageManagers.push('dotnet');
    setCmd('run', 'dotnet run', '.csproj');
    setCmd('build', 'dotnet build', '.csproj');
    setCmd('test', 'dotnet test', '.csproj');
  }
  if (has('pubspec.yaml')) {
    packageManagers.push('pub');
    const pub = (await readText(join(root, 'pubspec.yaml'))) ?? '';
    if (/\bflutter:/.test(pub)) frameworks.add('Flutter');
    setCmd('install', /\bflutter:/.test(pub) ? 'flutter pub get' : 'dart pub get', 'pubspec.yaml');
    setCmd('test', /\bflutter:/.test(pub) ? 'flutter test' : 'dart test', 'pubspec.yaml');
  }

  // ── Makefile fallbacks
  if (has('Makefile')) {
    const mk = (await readText(join(root, 'Makefile'))) ?? '';
    const targets = new Set([...mk.matchAll(/^([A-Za-z0-9_-]+):/gm)].map((m) => m[1]!));
    for (const [key, names] of [
      ['run', ['dev', 'run', 'serve', 'start']],
      ['build', ['build']],
      ['test', ['test']],
      ['lint', ['lint']],
      ['install', ['install', 'setup']],
    ] as [CommandKey, string[]][]) {
      const t = names.find((n) => targets.has(n));
      if (t) setCmd(key, `make ${t}`, `Makefile target ${t}`);
    }
  }

  // ── Docker
  const compose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find(
    has,
  );
  if (has('Dockerfile') || compose) frameworks.add('Docker');
  if (compose && !commands.run) setCmd('run', 'docker compose up', compose);

  // ── Env files (names only)
  const envFiles = tree.files
    .filter((f) => /(^|\/)\.env(\.[^/]+)?$/.test(f) || /(^|\/)[^/]*\.env$/.test(f))
    .sort();

  // ── Conventions
  const conventions: string[] = [];
  const conv = (cond: boolean, text: string) => cond && conventions.push(text);
  const tsconfig = has('tsconfig.json') ? await readText(join(root, 'tsconfig.json')) : null;
  conv(!!tsconfig && /"strict"\s*:\s*true/.test(tsconfig), 'TypeScript strict mode is enabled');
  conv(
    tree.files.some((f) => /^(\.?eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?)$/.test(f)),
    'ESLint is configured',
  );
  conv(
    tree.files.some((f) => /^(\.prettierrc(\.\w+)?|prettier\.config\.[cm]?[jt]s)$/.test(f)),
    'Prettier is configured',
  );
  conv(has('biome.json') || has('biome.jsonc'), 'Biome is configured for lint/format');
  conv(has('.editorconfig'), 'EditorConfig is present');
  conv(/\bruff\b/.test(pyproject ?? ''), 'Ruff is used for Python linting');
  conv(/\bblack\b/.test(pyproject ?? ''), 'Black is used for Python formatting');
  conv(/\bmypy\b/.test(pyproject ?? ''), 'mypy type checking is configured');
  conv(
    tree.files.some((f) => f.startsWith('.husky/')) || existsSync(join(root, '.husky')),
    'Git hooks via Husky',
  );
  conv(
    tree.files.some((f) => /^(commitlint\.config\.[cm]?[jt]s|\.commitlintrc(\.\w+)?)$/.test(f)),
    'Conventional commits enforced (commitlint)',
  );
  conv(
    tree.files.some((f) => f.startsWith('.github/workflows/')),
    'CI via GitHub Actions',
  );
  conv(has('.gitlab-ci.yml'), 'CI via GitLab CI');
  const testFiles = tree.files.filter((f) =>
    /(\.|_)(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/.test(f),
  );
  if (testFiles.length) {
    const colocated = testFiles.filter(
      (f) => !/(^|\/)(tests?|__tests__|spec|e2e)\//.test(f),
    ).length;
    conventions.push(
      `${testFiles.length} test files, ${colocated > testFiles.length / 2 ? 'mostly co-located with source' : 'in dedicated test folders'}`,
    );
  } else if (tree.files.length > 0) {
    notes.push('No test files detected.');
  }
  conv(has('README.md') || has('README'), 'README present');
  conv(has('CONTRIBUTING.md'), 'CONTRIBUTING guide present');
  conv(
    has('CLAUDE.md') || has('AGENTS.md'),
    'Agent instructions file present (CLAUDE.md / AGENTS.md)',
  );

  // ── Git
  const gitInfo: OnboardingReport['git'] = {
    isRepo: false,
    branch: null,
    remote: null,
    dirty: null,
    lastCommit: null,
  };
  if (await isRepoRoot(root)) {
    gitInfo.isRepo = true;
    const g = git(root);
    try {
      const status = await g.status();
      gitInfo.branch = status.current ?? null;
      gitInfo.dirty = !status.isClean();
    } catch {
      /* unborn branch etc. */
    }
    try {
      const remotes = await g.getRemotes(true);
      const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
      gitInfo.remote = redactRemote(origin?.refs.fetch);
    } catch {
      /* no remotes */
    }
    try {
      const log = await g.log({ maxCount: 1 });
      if (log.latest)
        gitInfo.lastCommit = {
          hash: log.latest.hash.slice(0, 10),
          message: log.latest.message,
          date: log.latest.date,
        };
    } catch {
      /* no commits yet */
    }
  }

  // Git housekeeping files (e.g. the .gitignore AI Harness writes) don't count as content.
  const isEmpty = tree.files.every((f) => HOUSEKEEPING_FILES.has(f));
  if (isEmpty) notes.push('The folder is empty — agents will scaffold it from your requirements.');
  if (tree.truncated) notes.push('Large repository: analysis sampled the first 20,000 files.');
  if (!commands.run && !isEmpty)
    notes.push('No run command detected — set one below so AI Harness can start the project.');

  return {
    analyzedAt: Date.now(),
    durationMs: Date.now() - started,
    languages,
    frameworks: [...frameworks],
    packageManagers: [...new Set(packageManagers)],
    monorepo,
    commands,
    structure: outline(tree.files),
    envFiles,
    conventions,
    git: gitInfo,
    stats: { files: tree.files.length, dirs: tree.dirs, truncated: tree.truncated },
    notes,
  };
}

/** Stack chips for the dashboard: top frameworks first, then primary languages. */
export function stackFromReport(r: OnboardingReport): string[] {
  const langs = r.languages
    .filter((l) => !SECONDARY_LANGS.has(l.name) && l.share >= 5)
    .map((l) => l.name);
  const fw = r.frameworks.filter(
    (f) =>
      ![
        'TypeScript',
        'Vitest',
        'Jest',
        'Playwright',
        'Cypress',
        'Storybook',
        'pytest',
        'Pydantic',
      ].includes(f),
  );
  const out = [...fw.slice(0, 4), ...langs.filter((l) => !fw.includes(l))];
  return [...new Set(out)].slice(0, 6);
}
