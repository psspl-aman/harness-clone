'use client';

import {
  AGENT_ROLES,
  cheapModelFor,
  type CreateProjectInput,
  type GithubRepo,
  type RoleEngines,
  type RoleModels,
  type StagedAttachmentDto,
} from '@agentforge/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FolderOpen,
  FolderSearch,
  HardDrive,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { DirectoryPicker, useFsRoots } from '@/components/fs/directory-picker';
import { PathCheckStatus } from '@/components/fs/path-check';
import { GithubConnect, useGithubStatus } from '@/components/github/github-connect';
import { RepoPicker } from '@/components/github/repo-picker';
import { GithubIcon } from '@/components/icons';
import { EngineRoles, useResolvedEngines } from '@/components/projects/engine-roles';
import { RequirementFiles } from '@/components/projects/requirement-files';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useDebounced } from '@/hooks/use-debounced';
import { api, ApiClientError, qk } from '@/lib/api';
import { cn } from '@/lib/utils';

type Mode = 'scratch' | 'existing';
type StepId = 'details' | 'location' | 'stack' | 'engines' | 'requirement' | 'source' | 'review';

const STEPS: Record<Mode, { id: StepId; label: string }[]> = {
  scratch: [
    { id: 'details', label: 'Name' },
    { id: 'location', label: 'Location' },
    { id: 'stack', label: 'Stack' },
    { id: 'engines', label: 'Agents' },
    { id: 'requirement', label: 'Requirement' },
    { id: 'review', label: 'Review' },
  ],
  existing: [
    { id: 'source', label: 'Source' },
    { id: 'details', label: 'Name' },
    { id: 'engines', label: 'Agents' },
    { id: 'review', label: 'Review' },
  ],
};

const STACK_CHIPS = [
  'Static site (HTML/CSS/JS)',
  'TypeScript',
  'Next.js',
  'React + Vite',
  'Tailwind CSS',
  'Node.js API',
  'FastAPI',
  'Django',
  'Go',
  'PostgreSQL',
  'SQLite',
  'Prisma',
  'Vitest',
];
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const toFolder = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
// Last path segment, handling both POSIX (/) and Windows (\) separators.
const basename = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? '';
// An absolute path on either platform: POSIX "/…" or Windows "C:\…" / "C:/…".
const isAbsPath = (p: string) => /^(\/|[A-Za-z]:[\\/])/.test(p);
/**
 * Join a parent folder and a child name with the separator the parent already uses
 * (`F:\prep` + `tip-splitter` → `F:\prep\tip-splitter`), else the daemon's separator.
 */
const joinPath = (parent: string, child: string, sep?: string) => {
  const s = parent.includes('\\') ? '\\' : parent.includes('/') ? '/' : (sep ?? '/');
  return `${parent.replace(/[\\/]+$/, '')}${s}${child}`;
};

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
    </div>
  );
}

function ChoiceCard({
  selected,
  onClick,
  icon,
  title,
  description,
}: {
  selected: boolean;
  onClick: () => void;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'bg-card flex items-start gap-3 rounded-xl border p-4 text-left transition-all hover:shadow-sm',
        selected ? 'border-primary ring-primary/20 ring-4' : 'hover:border-primary/40',
      )}
    >
      <div
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-lg',
          selected ? 'bg-primary text-primary-foreground' : 'bg-muted',
        )}
      >
        {icon}
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
    </button>
  );
}

function ModeChooser() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 md:px-8">
      <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Start something new, or bring an existing codebase for agents to work on.
      </p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {[
          {
            mode: 'scratch',
            icon: Sparkles,
            title: 'Start from scratch',
            text: 'Describe what you want. Agents plan it, scaffold it and build it — in a local folder or a new GitHub repo.',
          },
          {
            mode: 'existing',
            icon: FolderOpen,
            title: 'Attach existing project',
            text: 'Point at a local folder or clone a GitHub repo. AgentForge analyses the stack, commands and conventions.',
          },
        ].map((c, i) => (
          <motion.div
            key={c.mode}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06 }}
          >
            <Link
              href={`/projects/new?mode=${c.mode}`}
              className="group bg-card hover:border-primary/40 flex h-full flex-col gap-3 rounded-2xl border p-6 shadow-xs transition-all hover:shadow-md"
            >
              <div className="bg-accent text-accent-foreground grid size-11 place-items-center rounded-xl">
                <c.icon className="size-5" />
              </div>
              <h2 className="font-semibold">{c.title}</h2>
              <p className="text-muted-foreground text-sm">{c.text}</p>
              <span className="text-primary mt-auto flex items-center gap-1 text-sm font-medium">
                Continue{' '}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function Wizard({ mode }: { mode: Mode }) {
  const router = useRouter();
  const steps = STEPS[mode];
  const [stepIdx, setStepIdx] = useState(0);
  const step = steps[stepIdx]!;

  // Shared
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [roleEngines, setRoleEngines] = useState<Partial<RoleEngines>>({});
  const [cheap, setCheap] = useState(false);
  const roots = useFsRoots();
  const resolvedEngines = useResolvedEngines(roleEngines);
  const engineList = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  const cheapModels = useMemo((): RoleModels => {
    if (!cheap) return {};
    const out: RoleModels = {};
    for (const role of AGENT_ROLES) {
      const id = resolvedEngines[role];
      const m = cheapModelFor(id, engineList.data?.find((e) => e.id === id)?.models);
      if (m) out[role] = m;
    }
    return out;
  }, [cheap, resolvedEngines, engineList.data]);
  // Scratch
  const [where, setWhere] = useState<'local' | 'github'>('local');
  const [parentDir, setParentDir] = useState('');
  const [folderName, setFolderName] = useState('');
  const [ghAction, setGhAction] = useState<'create' | 'existing'>('create');
  const [ghOwner, setGhOwner] = useState('');
  const [ghRepoName, setGhRepoName] = useState('');
  const [ghPrivate, setGhPrivate] = useState(true);
  const [ghRepo, setGhRepo] = useState<GithubRepo | null>(null);
  const [stack, setStack] = useState('');
  const [requirement, setRequirement] = useState('');
  const [requirementFiles, setRequirementFiles] = useState<StagedAttachmentDto[]>([]);
  // Existing
  const [existingPath, setExistingPath] = useState('');
  const [initGit, setInitGit] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const github = useGithubStatus();
  const ghConnected = !!github.data?.connected;
  const owners = useQuery({
    queryKey: qk.githubOwners,
    queryFn: api.github.owners,
    enabled: ghConnected && mode === 'scratch',
  });
  const effectiveOwner = ghOwner || github.data?.login || '';
  const effectiveFolder = folderName || toFolder(name);
  const effectiveRepoName = ghRepoName || toFolder(name);

  const checkPath =
    mode === 'scratch'
      ? parentDir && effectiveFolder
        ? joinPath(parentDir, effectiveFolder, roots.data?.sep)
        : ''
      : existingPath.trim();
  const usesLocal =
    (mode === 'scratch' && where === 'local') || (mode === 'existing' && where === 'local');
  const debouncedPath = useDebounced(checkPath, 300);
  const check = useQuery({
    queryKey: qk.fsCheck(debouncedPath, mode),
    queryFn: () => api.fs.check(debouncedPath, mode),
    enabled: usesLocal && isAbsPath(debouncedPath),
    retry: false,
  });
  const checkLoading = usesLocal && (checkPath !== debouncedPath || check.isFetching);

  const derivedName =
    mode === 'existing' && !nameTouched
      ? where === 'github'
        ? (ghRepo?.name ?? '')
        : basename(existingPath)
      : name;

  const input = useMemo((): CreateProjectInput | null => {
    if (mode === 'scratch') {
      const location =
        where === 'local'
          ? { kind: 'local' as const, parentDir, folderName: effectiveFolder }
          : {
              kind: 'github' as const,
              repo:
                ghAction === 'create'
                  ? {
                      action: 'create' as const,
                      owner: effectiveOwner,
                      name: effectiveRepoName,
                      private: ghPrivate,
                      description: description || undefined,
                    }
                  : { action: 'existing' as const, fullName: ghRepo?.fullName ?? '' },
            };
      return {
        mode,
        name: name.trim(),
        description: description.trim() || undefined,
        location,
        stackPreferences: stack.trim() || undefined,
        roleEngines,
        ...(cheap ? { roleModels: cheapModels, effort: 'low' as const } : {}),
        initialRequirement: requirement.trim() || undefined,
        initialAttachmentIds: requirementFiles.map((f) => f.id),
      };
    }
    return {
      mode,
      name: derivedName.trim() || undefined,
      description: description.trim() || undefined,
      location:
        where === 'local'
          ? { kind: 'local', path: existingPath.trim(), initGit }
          : { kind: 'github', fullName: ghRepo?.fullName ?? '' },
      roleEngines,
      ...(cheap ? { roleModels: cheapModels, effort: 'low' as const } : {}),
    };
  }, [
    mode,
    where,
    parentDir,
    effectiveFolder,
    ghAction,
    effectiveOwner,
    effectiveRepoName,
    ghPrivate,
    description,
    ghRepo,
    name,
    stack,
    roleEngines,
    cheap,
    cheapModels,
    requirement,
    requirementFiles,
    derivedName,
    existingPath,
    initGit,
  ]);

  const stepValid = (id: StepId): boolean => {
    switch (id) {
      case 'details':
        return mode === 'existing' || name.trim().length > 0;
      case 'location':
        if (where === 'local')
          return !!check.data?.ok && !checkLoading && SAFE_NAME.test(effectiveFolder);
        if (!ghConnected) return false;
        return ghAction === 'create'
          ? !!effectiveOwner && SAFE_NAME.test(effectiveRepoName)
          : !!ghRepo;
      case 'source':
        if (where === 'local')
          return !!check.data?.ok && !checkLoading && (check.data.isGitRepo || initGit);
        return ghConnected && !!ghRepo;
      default:
        return true;
    }
  };

  const create = useMutation({
    mutationFn: () => api.projects.create(input!),
    onSuccess: (p) => {
      toast.success(mode === 'scratch' ? `Created ${p.name}` : `Attached ${p.name}`, {
        description: 'Analysing the project…',
      });
      // The project route can take a while to compile/load; the button stays busy
      // (create.isSuccess) until this page unmounts, so a second click can't re-create it.
      router.prefetch(`/projects/${p.id}`);
      router.push(`/projects/${p.id}`);
    },
    onError: (err) =>
      toast.error('Could not create project', {
        description: err instanceof ApiClientError ? err.message : String(err),
      }),
  });

  /** Why Next is disabled on a step, shown next to the buttons. */
  const blockedReason = (id: StepId): string | null => {
    if (stepValid(id)) return null;
    const pathReason = (path: string, emptyMsg: string) => {
      if (!path.trim()) return emptyMsg;
      if (!isAbsPath(path.trim())) return 'Use a full (absolute) path';
      if (checkLoading) return 'Checking the folder…';
      if (check.error)
        return check.error instanceof ApiClientError
          ? check.error.message
          : 'Could not check the folder';
      if (check.data && !check.data.ok) return check.data.reason ?? 'This folder can’t be used';
      return null;
    };
    switch (id) {
      case 'details':
        return 'Enter a project name';
      case 'location':
        if (where === 'local') {
          if (!parentDir.trim()) return 'Choose a parent folder';
          if (!effectiveFolder) return 'Enter a project folder name';
          if (!SAFE_NAME.test(effectiveFolder))
            return 'The folder name can only use letters, numbers, dots, dashes and underscores';
          return pathReason(checkPath, 'Choose a parent folder');
        }
        if (!ghConnected) return 'Connect GitHub to continue';
        if (ghAction === 'create')
          return !effectiveOwner
            ? 'Choose an owner'
            : 'The repository name can only use letters, numbers, dots, dashes and underscores';
        return 'Choose a repository';
      case 'source':
        if (where === 'local')
          return (
            pathReason(existingPath, 'Enter or browse to the project folder') ??
            'Not a git repository — turn on “Initialise a git repository”'
          );
        return ghConnected ? 'Choose a repository' : 'Connect GitHub to continue';
      default:
        return null;
    }
  };
  const canNext = stepValid(step.id);
  const nextHint = blockedReason(step.id);
  // Stays busy after success until the project page replaces this one.
  const busy = create.isPending || create.isSuccess;
  const isLast = stepIdx === steps.length - 1;
  const next = () => {
    if (!canNext) return;
    if (isLast) create.mutate();
    else setStepIdx((i) => i + 1);
  };

  const pathChooser = (
    value: string,
    onChange: (v: string) => void,
    label: string,
    pickerTitle: string,
  ) => (
    <Field label={label} htmlFor="path">
      <div className="flex gap-2">
        <Input
          id="path"
          placeholder={
            roots.data
              ? `${roots.data.home.replace(/[\\/]+$/, '')}${roots.data.sep}code`
              : undefined
          }
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-sm"
        />
        <Button type="button" variant="outline" onClick={() => setPickerOpen(true)}>
          <FolderSearch /> Browse
        </Button>
      </div>
      <DirectoryPicker
        // Remount on open so the browser starts at the folder currently in the field.
        key={pickerOpen ? `open:${value}` : 'closed'}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={pickerTitle}
        initialPath={value || undefined}
        onSelect={onChange}
      />
    </Field>
  );

  const whereChooser = (
    <div className="grid gap-3 sm:grid-cols-2">
      <ChoiceCard
        selected={where === 'local'}
        onClick={() => setWhere('local')}
        icon={<HardDrive className="size-4" />}
        title="Local folder"
        description={
          mode === 'scratch'
            ? 'Create the project in a folder on this machine'
            : 'A folder on this machine'
        }
      />
      <ChoiceCard
        selected={where === 'github'}
        onClick={() => setWhere('github')}
        icon={<GithubIcon className="size-4" />}
        title="GitHub"
        description={
          mode === 'scratch'
            ? 'New or existing repo, cloned into your workspace'
            : 'Clone a repository into your workspace'
        }
      />
    </div>
  );

  const content: Record<StepId, ReactNode> = {
    details: (
      <div className="space-y-5">
        <Field
          label="Project name"
          htmlFor="name"
          hint={
            mode === 'existing' && !nameTouched
              ? 'Defaults to the folder or repository name.'
              : undefined
          }
        >
          <Input
            id="name"
            autoFocus
            placeholder={mode === 'scratch' ? 'e.g. Recipe planner' : undefined}
            value={mode === 'existing' && !nameTouched ? derivedName : name}
            aria-invalid={mode === 'scratch' && nameTouched && !name.trim()}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value);
            }}
          />
        </Field>
        <Field
          label="Short description"
          htmlFor="desc"
          hint="Optional. Helps agents understand the goal."
        >
          <Textarea
            id="desc"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
    ),
    location: (
      <div className="space-y-5">
        {whereChooser}
        {where === 'local' ? (
          <div className="space-y-4">
            {pathChooser(
              parentDir,
              setParentDir,
              'Parent folder',
              'Choose where to create the project',
            )}
            <Field
              label="Project folder"
              htmlFor="folder"
              hint={checkPath && <span className="font-mono">{checkPath}</span>}
            >
              <Input
                id="folder"
                value={effectiveFolder}
                onChange={(e) => setFolderName(e.target.value)}
                className="font-mono text-sm"
                aria-invalid={!!effectiveFolder && !SAFE_NAME.test(effectiveFolder)}
              />
            </Field>
            {checkPath && <PathCheckStatus check={check.data} loading={checkLoading} />}
          </div>
        ) : !ghConnected ? (
          <div className="rounded-xl border p-4">
            <p className="mb-3 text-sm font-medium">Connect GitHub to continue</p>
            <GithubConnect compact />
          </div>
        ) : (
          <div className="space-y-4">
            <RadioGroup
              value={ghAction}
              onValueChange={(v) => setGhAction(v as 'create' | 'existing')}
              className="flex gap-6"
            >
              <Label className="flex items-center gap-2 font-normal">
                <RadioGroupItem value="create" /> Create a new repository
              </Label>
              <Label className="flex items-center gap-2 font-normal">
                <RadioGroupItem value="existing" /> Use an existing repository
              </Label>
            </RadioGroup>
            {ghAction === 'create' ? (
              <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
                <Field label="Owner" htmlFor="owner">
                  <Select value={effectiveOwner} onValueChange={setGhOwner}>
                    <SelectTrigger id="owner" className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(
                        owners.data ??
                        (github.data?.login
                          ? [{ login: github.data.login, type: 'user' as const }]
                          : [])
                      ).map((o) => (
                        <SelectItem key={o.login} value={o.login}>
                          {o.login}
                          {o.type === 'org' && (
                            <span className="text-muted-foreground text-xs"> · org</span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Repository name" htmlFor="repo">
                  <Input
                    id="repo"
                    value={effectiveRepoName}
                    onChange={(e) => setGhRepoName(e.target.value)}
                    className="font-mono text-sm"
                    aria-invalid={!SAFE_NAME.test(effectiveRepoName)}
                  />
                </Field>
                <Label className="col-span-full flex items-center gap-3 font-normal">
                  <Switch checked={ghPrivate} onCheckedChange={setGhPrivate} /> Private repository
                </Label>
              </div>
            ) : (
              <RepoPicker value={ghRepo?.fullName ?? null} onChange={setGhRepo} />
            )}
          </div>
        )}
      </div>
    ),
    source: (
      <div className="space-y-5">
        {whereChooser}
        {where === 'local' ? (
          <div className="space-y-3">
            {pathChooser(
              existingPath,
              setExistingPath,
              'Project folder',
              'Choose the project folder',
            )}
            {existingPath && <PathCheckStatus check={check.data} loading={checkLoading} />}
            {check.data?.ok && !check.data.isGitRepo && (
              <Label className="bg-muted/50 flex items-start gap-3 rounded-lg border p-3 font-normal">
                <Switch checked={initGit} onCheckedChange={setInitGit} className="mt-0.5" />
                <span className="text-sm">
                  Initialise a git repository
                  <span className="text-muted-foreground block text-xs">
                    Agents work on isolated branches, so git is required. Env files and keys are
                    added to .gitignore and never committed.
                  </span>
                </span>
              </Label>
            )}
          </div>
        ) : !ghConnected ? (
          <div className="rounded-xl border p-4">
            <p className="mb-3 text-sm font-medium">Connect GitHub to continue</p>
            <GithubConnect compact />
          </div>
        ) : (
          <RepoPicker value={ghRepo?.fullName ?? null} onChange={setGhRepo} />
        )}
      </div>
    ),
    stack: (
      <div className="space-y-4">
        <Field
          label="Stack preferences"
          htmlFor="stack"
          hint="Optional. Leave empty and the Planner will choose a sensible stack."
        >
          <Textarea
            id="stack"
            rows={4}
            placeholder="e.g. Next.js App Router, TypeScript, Tailwind, SQLite via Drizzle"
            value={stack}
            onChange={(e) => setStack(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          {STACK_CHIPS.map((c) => {
            const on = stack.split(/,\s*/).includes(c);
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setStack((s) =>
                    on
                      ? s
                          .split(/,\s*/)
                          .filter((x) => x !== c)
                          .join(', ')
                      : [s.trim(), c].filter(Boolean).join(', '),
                  )
                }
                className={cn(
                  'rounded-full border px-3 py-1 text-xs transition-colors',
                  on ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-accent',
                )}
              >
                {c}
              </button>
            );
          })}
        </div>
      </div>
    ),
    engines: (
      <div className="space-y-3">
        <p className="text-muted-foreground text-sm">
          Pick which engine runs each role for this project. “Default” follows your global settings.
        </p>
        <EngineRoles value={roleEngines} onChange={setRoleEngines} />
        <Label className="bg-muted/50 flex items-start gap-3 rounded-lg border p-3 font-normal">
          <Switch checked={cheap} onCheckedChange={setCheap} className="mt-0.5" />
          <span className="text-sm">
            Cheap mode
            <span className="text-muted-foreground block text-xs">
              Cheapest model per engine (Haiku on Claude Code, engine default elsewhere) and low
              reasoning effort. Turn on LITE routing for small tasks from the project Overview.
            </span>
          </span>
        </Label>
      </div>
    ),
    requirement: (
      <div className="space-y-4">
        <Field
          label="What should we build?"
          htmlFor="req"
          hint="Optional. The Planner starts drafting a plan as soon as the project is created — you review and edit it before anything is built."
        >
          <Textarea
            id="req"
            rows={9}
            placeholder="Describe the product, key features, users and any constraints. Markdown is fine."
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
          />
        </Field>
        <Field label="Requirement documents">
          <RequirementFiles value={requirementFiles} onChange={setRequirementFiles} />
        </Field>
      </div>
    ),
    review: (
      <dl className="divide-y rounded-xl border text-sm">
        {[
          ['Name', input?.name ?? '—'],
          mode === 'scratch'
            ? [
                'Location',
                where === 'local'
                  ? checkPath
                  : ghAction === 'create'
                    ? `New ${ghPrivate ? 'private' : 'public'} repo ${effectiveOwner}/${effectiveRepoName}`
                    : ghRepo?.fullName,
              ]
            : [
                'Source',
                where === 'local'
                  ? `${existingPath}${check.data && !check.data.isGitRepo ? ' (git will be initialised)' : ''}`
                  : `Clone ${ghRepo?.fullName}`,
              ],
          ...(mode === 'scratch'
            ? [
                ['Stack', stack || 'Planner decides'],
                [
                  'Requirement',
                  requirement
                    ? `${requirement.slice(0, 140)}${requirement.length > 140 ? '…' : ''}`
                    : requirementFiles.length
                      ? 'From the attached documents'
                      : 'None yet',
                ],
                [
                  'Documents',
                  requirementFiles.length ? requirementFiles.map((f) => f.name).join(', ') : 'None',
                ],
              ]
            : []),
          [
            'Engine overrides',
            Object.keys(roleEngines).length
              ? Object.entries(roleEngines)
                  .map(([r, e]) => `${r}: ${e}`)
                  .join(', ')
              : 'Global defaults',
          ],
          ...(cheap ? [['Cheap mode', 'Cheapest models, low effort']] : []),
        ].map(([k, v]) => (
          <div key={k} className="flex gap-4 px-4 py-3">
            <dt className="text-muted-foreground w-36 shrink-0">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
    ),
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 md:px-8">
      <Link
        href="/projects/new"
        className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4" /> New project
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">
        {mode === 'scratch' ? 'Start from scratch' : 'Attach existing project'}
      </h1>

      <div className="mt-8 grid gap-8 md:grid-cols-[180px_minmax(0,1fr)]">
        <ol className="flex gap-2 overflow-x-auto md:flex-col md:gap-1" aria-label="Steps">
          {steps.map((s, i) => {
            const done = i < stepIdx;
            const reachable = i <= stepIdx || steps.slice(0, i).every((p) => stepValid(p.id));
            return (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={!reachable}
                  onClick={() => setStepIdx(i)}
                  aria-current={i === stepIdx ? 'step' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm whitespace-nowrap transition-colors disabled:opacity-50',
                    i === stepIdx
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'hover:bg-muted',
                  )}
                >
                  <span
                    className={cn(
                      'grid size-5 shrink-0 place-items-center rounded-full border text-[10px]',
                      done && 'bg-primary border-primary text-primary-foreground',
                      i === stepIdx && 'border-primary text-primary',
                    )}
                  >
                    {done ? <Check className="size-3" /> : i + 1}
                  </span>
                  {s.label}
                </button>
              </li>
            );
          })}
        </ol>

        <form
          className="bg-card flex min-h-[420px] min-w-0 flex-col rounded-2xl border p-4 shadow-xs sm:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            next();
          }}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={step.id}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.15 }}
              className="flex-1"
            >
              <h2 className="mb-5 text-lg font-semibold">{steps[stepIdx]!.label}</h2>
              {content[step.id]}
            </motion.div>
          </AnimatePresence>
          <div className="mt-6 flex items-center justify-between border-t pt-4">
            <Button
              type="button"
              variant="ghost"
              disabled={stepIdx === 0 || busy}
              onClick={() => setStepIdx((i) => i - 1)}
            >
              <ArrowLeft /> Back
            </Button>
            {nextHint && !busy && (
              <p
                id="next-hint"
                role="status"
                className="text-muted-foreground mx-3 min-w-0 flex-1 text-right text-xs"
              >
                {nextHint}
              </p>
            )}
            <Button
              type="submit"
              disabled={!canNext || busy}
              aria-busy={busy}
              aria-describedby={nextHint ? 'next-hint' : undefined}
            >
              {create.isSuccess ? (
                <>
                  <Loader2 className="animate-spin" /> Opening project…
                </>
              ) : create.isPending ? (
                <>
                  <Loader2 className="animate-spin" />{' '}
                  {where === 'github' ? 'Cloning…' : 'Creating…'}
                </>
              ) : isLast ? (
                <>
                  <Check /> {mode === 'scratch' ? 'Create project' : 'Attach project'}
                </>
              ) : (
                <>
                  Next <ArrowRight />
                </>
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function NewProjectInner() {
  const params = useSearchParams();
  const mode = params.get('mode');
  if (mode === 'scratch' || mode === 'existing') return <Wizard key={mode} mode={mode} />;
  return <ModeChooser />;
}

export default function NewProjectPage() {
  return (
    <Suspense>
      <NewProjectInner />
    </Suspense>
  );
}
