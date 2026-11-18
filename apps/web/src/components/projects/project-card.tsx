'use client';

import type { ProjectSummary } from '@agentforge/shared';
import { AlertTriangle, FolderGit2, HardDrive } from 'lucide-react';
import { GithubIcon } from '@/components/icons';
import { motion } from 'motion/react';
import { Badge } from '@/components/ui/badge';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

const RUN_STATUS = {
  running: { label: 'Running', cls: 'bg-success' },
  starting: { label: 'Starting', cls: 'bg-warning animate-pulse' },
  crashed: { label: 'Crashed', cls: 'bg-destructive' },
  stopped: { label: 'Stopped', cls: 'bg-muted-foreground/40' },
} as const;

export function ProjectCard({ project, index }: { project: ProjectSummary; index: number }) {
  const { taskCounts: t } = project;
  const progress = t.total ? Math.round((t.done / t.total) * 100) : 0;
  const run = RUN_STATUS[project.runningStatus];
  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.3) }}
      className="group bg-card hover:border-primary/30 flex flex-col gap-4 rounded-xl border p-5 shadow-xs transition-all hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <div className="bg-accent text-accent-foreground grid size-10 shrink-0 place-items-center rounded-lg">
          <FolderGit2 className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold tracking-tight">{project.name}</h3>
          <p className="text-muted-foreground flex items-center gap-1.5 truncate text-xs">
            {project.source === 'github' ? (
              <GithubIcon className="size-3" />
            ) : (
              <HardDrive className="size-3" />
            )}
            <span className="truncate">{project.githubRepo ?? project.localPath}</span>
          </p>
        </div>
        {project.openErrorCount > 0 && (
          <Badge variant="destructive" className="gap-1">
            <AlertTriangle className="size-3" /> {project.openErrorCount}
          </Badge>
        )}
      </div>

      {project.stack.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {project.stack.slice(0, 5).map((s) => (
            <Badge key={s} variant="secondary" className="font-normal">
              {s}
            </Badge>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <div className="text-muted-foreground flex justify-between text-xs">
          <span>
            {t.done}/{t.total} tasks done{t.active > 0 && ` · ${t.active} active`}
          </span>
          <span className="tabular-nums">{progress}%</span>
        </div>
        <div className="bg-muted h-1.5 overflow-hidden rounded-full">
          <div
            className="bg-primary h-full rounded-full transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div className="text-muted-foreground mt-auto flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5">
          <span className={cn('size-1.5 rounded-full', run.cls)} />
          {run.label}
        </span>
        <span>Active {timeAgo(project.lastActivityAt ?? project.createdAt)}</span>
      </div>
    </motion.article>
  );
}
