'use client';

import { useQuery } from '@tanstack/react-query';
import { FolderOpen, FolderPlus, Plus } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ArchivedProjectsSection } from '@/components/projects/archive';
import { ProjectCard } from '@/components/projects/project-card';
import { PageHeader } from '@/components/shell/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { api, qk } from '@/lib/api';

export default function ProjectsPage() {
  const projects = useQuery({ queryKey: qk.projects, queryFn: api.projects.list });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
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
      {projects.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : projects.data && projects.data.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.data.map((p, i) => (
            <ProjectCard key={p.id} project={p} index={i} />
          ))}
        </div>
      ) : projects.isError ? (
        <p className="text-muted-foreground text-sm">
          Projects will appear once the daemon is reachable.
        </p>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-20 text-center">
          <div className="bg-accent text-accent-foreground mb-4 grid size-12 place-items-center rounded-xl">
            <FolderPlus className="size-6" />
          </div>
          <h2 className="font-semibold">No projects yet</h2>
          <p className="text-muted-foreground mt-1 max-w-sm text-sm">
            Start a new project from a requirement, or attach an existing folder or GitHub repo.
            Agents plan, build, review and test it here.
          </p>
          <div className="mt-5 flex gap-2">
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
