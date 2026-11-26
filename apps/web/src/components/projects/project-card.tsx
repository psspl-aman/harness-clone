'use client';

import type { ProjectSummary } from '@ai-harness/shared';
import { AlertTriangle, ChevronRight, FolderGit2, HardDrive } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { GithubIcon } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

const RUN_STATUS = {
  running: { label: 'Running', cls: 'bg-success' },
  starting: { label: 'Starting', cls: 'bg-warning motion-safe:animate-pulse' },
  crashed: { label: 'Crashed', cls: 'bg-destructive' },
  stopped: { label: 'Stopped', cls: 'bg-muted-foreground/40' },
} as const;

export function ProjectCard({
  project,
  index,
  list,
}: {
  project: ProjectSummary;
  index: number;
  list: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const { total, done, active } = project.taskCounts;
  const progress = total ? Math.round((done / total) * 100) : 0;
  const activeProgress = total ? Math.round((active / total) * 100) : 0;
  const run = RUN_STATUS[project.runningStatus];
  const location = project.githubRepo ?? project.localPath;
  const SourceIcon = project.source === 'github' ? GithubIcon : HardDrive;

  return (
    <motion.article
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: reduceMotion ? 0 : Math.min(index * 0.04, 0.2) }}
      className={cn(
        'group bg-card hover:border-primary/30 focus-within:ring-ring/50 relative grid min-w-0 content-start gap-3.5 rounded-xl border p-4 shadow-xs transition-shadow focus-within:ring-2 hover:shadow-md',
        list &&
          'gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,.75fr)] lg:items-center lg:gap-5 lg:py-3',
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-md',
            project.source === 'github'
              ? 'bg-accent text-accent-foreground'
              : 'bg-muted text-muted-foreground',
          )}
        >
          <FolderGit2 className="size-4.5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold tracking-tight">
            <Link
              href={`/projects/${project.id}`}
              className="outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']"
            >
              {project.name}
            </Link>
          </h3>
          <p className="text-muted-foreground mt-0.5 flex items-center gap-1.5 font-mono text-[11px]">
            <SourceIcon className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate" title={location}>
              {location}
            </span>
          </p>
        </div>
        <ChevronRight
          className={cn(
            'text-muted-foreground group-hover:text-primary size-4 shrink-0',
            list && 'lg:hidden',
          )}
          aria-hidden="true"
        />
      </div>

      <div className="min-w-0 space-y-2">
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="text-foreground font-medium">
            {done}/{total} tasks done
          </span>
          {active > 0 && (
            <Badge variant="secondary" className="bg-accent text-accent-foreground">
              {active} active
            </Badge>
          )}
          <span className="ml-auto tabular-nums">{progress}%</span>
        </div>
        <div className="bg-muted flex h-1.5 overflow-hidden rounded-full" aria-hidden="true">
          <div className="bg-primary h-full shrink-0" style={{ width: `${progress}%` }} />
          <div className="bg-progress-active h-full" style={{ width: `${activeProgress}%` }} />
        </div>
        {(project.stack.length > 0 || project.openErrorCount > 0) && (
          <div className="flex flex-wrap items-center gap-1">
            {project.stack.slice(0, 5).map((stack) => (
              <Badge key={stack} variant="outline" className="text-muted-foreground font-normal">
                {stack}
              </Badge>
            ))}
            {project.openErrorCount > 0 && (
              <Badge
                variant="outline"
                className="text-destructive border-destructive/25 bg-destructive/10 ml-auto gap-1"
                aria-label={`${project.openErrorCount} open errors`}
              >
                <AlertTriangle className="size-3" /> {project.openErrorCount}
              </Badge>
            )}
          </div>
        )}
      </div>

      <div
        className={cn(
          'text-muted-foreground flex flex-wrap items-center justify-between gap-1.5 border-t pt-2.5 text-xs',
          list && 'lg:border-0 lg:pt-0',
        )}
      >
        <span className="flex items-center gap-1.5">
          <span className={cn('size-1.5 rounded-full', run.cls)} />
          {run.label}
        </span>
        <span>Active {timeAgo(project.lastActivityAt ?? project.createdAt)}</span>
      </div>
    </motion.article>
  );
}
