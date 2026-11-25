'use client';

import { useQuery } from '@tanstack/react-query';
import { FolderOpen, FolderPlus, LayoutGrid, List, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ArchivedProjectsSection } from '@/components/projects/archive';
import { ProjectCard } from '@/components/projects/project-card';
import { PageHeader } from '@/components/shell/page-header';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, qk } from '@/lib/api';
import { useUi } from '@/lib/stores';
import { cn } from '@/lib/utils';

export default function ProjectsPage() {
  const projects = useQuery({ queryKey: qk.projects, queryFn: api.projects.list });

  const [search, setSearch] = useState('');
  const view = useUi((s) => s.projectView);
  const setView = useUi((s) => s.setProjectView);
  const query = search.trim().toLowerCase();
  const visibleProjects = projects.data?.filter((project) =>
    [project.name, project.githubRepo, project.localPath, ...project.stack].some((value) =>
      value?.toLowerCase().includes(query),
    ),
  );

  return (
    <div className="mx-auto max-w-[1320px] px-4 py-7 md:px-[30px]">
      <PageHeader
        title="Projects"
        description={
          projects.data
            ? `${projects.data.length} project${projects.data.length === 1 ? '' : 's'}`
            : 'Your workspaces'
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/projects/new?mode=existing">
                <FolderOpen /> Attach existing
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/projects/new?mode=scratch">
                <Plus /> New project
              </Link>
            </Button>
          </>
        }
      />
      {projects.data && projects.data.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <label className="relative block w-full max-w-[270px]">
            <span className="sr-only">Filter projects</span>
            <Search
              aria-hidden="true"
              className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2"
            />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter projects…"
              className="bg-card pl-9 text-sm"
            />
          </label>
          <div
            role="group"
            aria-label="Project display"
            className="bg-muted flex gap-0.5 rounded-md border p-0.5"
          >
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={view === 'cards'}
              onClick={() => setView('cards')}
              className="aria-pressed:bg-card aria-pressed:shadow-xs"
            >
              <LayoutGrid /> Cards
            </Button>
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
              className="aria-pressed:bg-card aria-pressed:shadow-xs"
            >
              <List /> List
            </Button>
          </div>
        </div>
      )}
      {projects.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : projects.data && projects.data.length > 0 ? (
        visibleProjects?.length ? (
          <div
            className={cn(
              'grid',
              view === 'list' ? 'gap-2' : 'gap-3.5 sm:grid-cols-2 xl:grid-cols-3',
            )}
          >
            {visibleProjects.map((p, i) => (
              <ProjectCard key={p.id} project={p} index={i} list={view === 'list'} />
            ))}
          </div>
        ) : (
          <div role="status" className="bg-card rounded-xl border px-6 py-10 text-center">
            <h2 className="font-semibold">No matching projects</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Try a project name, repository or stack.
            </p>
          </div>
        )
      ) : projects.isError ? (
        <p className="text-muted-foreground text-sm">
          Projects will appear once the daemon is reachable.
        </p>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-xl border bg-card px-6 py-20 text-center">
          <div className="bg-accent text-accent-foreground mb-4 grid size-12 place-items-center rounded-xl">
            <FolderPlus className="size-6" />
          </div>
          <h2 className="font-semibold">No projects yet</h2>
          <p className="text-muted-foreground mt-1 max-w-sm text-sm">
            Start a new project from a requirement, or attach an existing folder or GitHub repo.
            Agents plan, build, review and test it here.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button asChild variant="outline">
              <Link href="/projects/new?mode=existing">
                <FolderOpen /> Attach existing
              </Link>
            </Button>
            <Button asChild>
              <Link href="/projects/new?mode=scratch">
                <Plus /> New project
              </Link>
            </Button>
          </div>
        </div>
      )}
      <ArchivedProjectsSection />
    </div>
  );
}
