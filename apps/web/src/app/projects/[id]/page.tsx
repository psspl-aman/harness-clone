'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  Copy,
  GitBranch,
  HardDrive,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Archive,
  ScanSearch,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChatPanel } from '@/components/chat/chat-panel';
import { GithubIcon } from '@/components/icons';
import { useLiveTopic } from '@/components/live-provider';
import { PlanTab } from '@/components/plan/plan-tab';
import { ArchiveDialog, ArchivedProjectNotice } from '@/components/projects/archive';
import { ProjectOverview } from '@/components/projects/overview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DocsTab } from '@/components/docs/docs-tab';
import { GitTab } from '@/components/git/git-tab';
import { MemoryList } from '@/components/memory/memory-list';
import { BottomPanel } from '@/components/workspace/bottom-panel';
import { CodeTab } from '@/components/workspace/code-tab';
import { PreviewTab } from '@/components/workspace/preview-tab';
import { RunControls } from '@/components/workspace/run-controls';
import { useWorkspaceUi } from '@/components/workspace/store';
import { api, ApiClientError, qk } from '@/lib/api';
import { cn } from '@/lib/utils';

type Tab = 'plan' | 'overview' | 'chat' | 'preview' | 'code' | 'git' | 'docs' | 'memory';
const TAB_SHORTCUTS: Tab[] = ['plan', 'preview', 'code', 'docs', 'memory', 'overview', 'git'];

export default function ProjectWorkspace() {
  const { id } = useParams<{ id: string }>();
  useLiveTopic(`project:${id}`);
  const project = useQuery({ queryKey: qk.project(id), queryFn: () => api.projects.get(id) });
  const [tab, setTab] = useState<Tab>('plan');
  const [chatOpen, setChatOpen] = useState(true);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [code, setCode] = useState<{ path: string | null; line: number | null }>({
    path: null,
    line: null,
  });
  const showTerminal = useWorkspaceUi((s) => s.showTerminal);
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  const start = useMutation({
    mutationFn: () => api.runtime.start(id),
    onSuccess: (r) => r.terminalId && showTerminal(r.terminalId),
    onError: (e) =>
      toast.error('Could not start the project', {
        description: e instanceof ApiClientError ? e.message : String(e),
      }),
  });
  const analyze = useMutation({
    mutationFn: () => api.projects.analyze(id),
    onError: (e) =>
      toast.error('Could not start analysis', {
        description: e instanceof ApiClientError ? e.message : String(e),
      }),
  });

  // Alt+1…7 switches workspace tabs.
  useEffect(() => {
    const order = TAB_SHORTCUTS;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= order.length) {
        e.preventDefault();
        setTab(order[n - 1]!);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (project.isPending) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }
  if (project.isError || !project.data) {
    const notFound = project.error instanceof ApiClientError && project.error.status === 404;
    return (
      <div className="flex flex-col items-center gap-3 p-16 text-center">
        <h1 className="text-lg font-semibold">
          {notFound ? 'Project not found' : 'Could not load project'}
        </h1>
        <Button asChild variant="outline" size="sm">
          <Link href="/">Back to projects</Link>
        </Button>
      </div>
    );
  }
  const p = project.data;
  if (p.archivedAt) return <ArchivedProjectNotice project={p} />;
  const analysing =
    p.onboardingStatus === 'running' || p.onboardingStatus === 'pending' || analyze.isPending;
  const openTaskInPlan = (taskId: string) => {
    setTab('plan');
    setOpenTask(taskId);
  };
  const openFile = (path: string, line: number | null) => {
    setTab('code');
    setCode({ path, line });
  };

  const tabs: { id: Tab; label: string; mobileOnly?: boolean }[] = [
    { id: 'chat', label: 'Chat', mobileOnly: true },
    { id: 'plan', label: 'Plan & Tasks' },
    { id: 'preview', label: 'Preview' },
    { id: 'code', label: 'Code' },
    { id: 'git', label: 'Git' },
    { id: 'docs', label: 'Docs' },
    { id: 'memory', label: 'Memory' },
    { id: 'overview', label: 'Overview' },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="bg-card flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 md:px-5">
        <div className="min-w-0 flex-1 basis-full sm:basis-64">
          <nav
            aria-label="Project breadcrumb"
            className="text-muted-foreground mb-1 flex items-center gap-1 text-xs"
          >
            <Link href="/" className="hover:text-primary hover:underline">
              Projects
            </Link>
            <ChevronRight className="size-3" aria-hidden="true" />
            <span className="truncate" aria-current="page">
              {p.name}
            </span>
          </nav>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{p.name}</h1>
            <Badge variant="secondary">
              {p.origin === 'scratch' ? 'From scratch' : 'Existing'}
            </Badge>
            {p.stack.slice(0, 4).map((s) => (
              <Badge key={s} variant="outline" className="hidden font-normal lg:inline-flex">
                {s}
              </Badge>
            ))}
          </div>
          <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-4 text-xs">
            <button
              className="hover:text-foreground flex min-w-0 items-center gap-1.5 font-mono"
              title="Copy path"
              onClick={() =>
                navigator.clipboard.writeText(p.localPath).then(() => toast.success('Path copied'))
              }
            >
              <HardDrive className="size-3.5 shrink-0" />{' '}
              <span className="truncate">{p.localPath}</span> <Copy className="size-3 shrink-0" />
            </button>
            {p.githubRepo && (
              <a
                href={`https://github.com/${p.githubRepo}`}
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground flex items-center gap-1.5"
              >
                <GithubIcon className="size-3.5" /> {p.githubRepo}
              </a>
            )}
            {p.workingBranch && (
              <button
                className="hover:text-foreground flex items-center gap-1.5"
                title="Branches and git actions"
                onClick={() => setTab('git')}
              >
                <GitBranch className="size-3.5" /> {p.workingBranch}
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RunControls project={p} onConfigure={() => setTab('overview')} />
          <Button variant="outline" size="sm" onClick={() => analyze.mutate()} disabled={analysing}>
            {analysing ? <Loader2 className="animate-spin" /> : <ScanSearch />} Re-analyse
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setArchiveOpen(true)}>
            <Archive /> Archive
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Requirement chat"
          className={cn(
            'bg-background hidden min-h-0 shrink-0 flex-col border-r md:flex',
            chatOpen ? 'w-[clamp(18rem,26vw,24rem)]' : 'w-0 border-r-0',
          )}
        >
          {chatOpen && (
            <>
              <div className="bg-card flex h-11 shrink-0 items-center gap-2 border-b px-4">
                <MessageSquare className="text-primary size-4" />
                <h2 className="text-sm font-semibold">Requirements</h2>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-7"
                  aria-label="Hide chat"
                  onClick={() => setChatOpen(false)}
                >
                  <PanelLeftClose className="size-4" />
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                <ChatPanel
                  projectId={id}
                  onOpenPlan={() => setTab('plan')}
                  onOpenTask={openTaskInPlan}
                />
              </div>
            </>
          )}
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            role="tablist"
            aria-label="Workspace"
            className="bg-card flex min-h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2 md:px-3"
          >
            {!chatOpen && (
              <Button
                variant="ghost"
                size="icon"
                className="mr-1 hidden size-7 md:inline-flex"
                aria-label="Show chat"
                onClick={() => setChatOpen(true)}
              >
                <PanelLeftOpen className="size-4" />
              </Button>
            )}
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                title={
                  TAB_SHORTCUTS.includes(t.id)
                    ? `Alt+${TAB_SHORTCUTS.indexOf(t.id) + 1}`
                    : undefined
                }
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'focus-visible:ring-ring/50 relative flex min-h-10 shrink-0 items-center px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-inset',
                  t.mobileOnly && 'md:hidden',
                  tab === t.id
                    ? 'text-accent-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                {tab === t.id && (
                  <span className="bg-primary absolute inset-x-2 bottom-0 h-0.5 rounded-full" />
                )}
              </button>
            ))}
          </div>
          <div
            className={cn(
              'min-h-0 flex-1',
              tab === 'code' || tab === 'preview' || tab === 'docs'
                ? 'overflow-hidden'
                : 'overflow-y-auto',
            )}
          >
            {tab === 'chat' && (
              <div className="h-full md:hidden">
                <ChatPanel
                  projectId={id}
                  onOpenPlan={() => setTab('plan')}
                  onOpenTask={openTaskInPlan}
                />
              </div>
            )}
            {tab === 'plan' && (
              <PlanTab projectId={id} openTaskId={openTask} onOpenTask={setOpenTask} />
            )}
            {tab === 'overview' && <ProjectOverview project={p} />}
            {tab === 'preview' && (
              <PreviewTab
                projectId={id}
                onStart={() =>
                  p.commands.run || p.commands.services?.length
                    ? start.mutate()
                    : setTab('overview')
                }
              />
            )}
            {tab === 'git' && <GitTab projectId={id} onOpenTask={openTaskInPlan} />}
            {tab === 'docs' && <DocsTab projectId={id} />}
            {tab === 'memory' && (
              <div className="mx-auto max-w-4xl p-4 md:p-6">
                <MemoryList projectId={id} budget={settings.data?.memory.maxPromptChars} />
              </div>
            )}
            {tab === 'code' && (
              <CodeTab
                projectId={id}
                path={code.path}
                line={code.line}
                onSelect={(path) => setCode({ path, line: null })}
              />
            )}
          </div>
          <BottomPanel projectId={id} onOpenTask={openTaskInPlan} onOpenFile={openFile} />
        </section>
      </div>
      <ArchiveDialog project={p} open={archiveOpen} onOpenChange={setArchiveOpen} />
    </div>
  );
}
