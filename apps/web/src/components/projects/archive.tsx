'use client';

import type { ProjectSummary } from '@agentforge/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ChevronDown, Loader2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, ApiClientError, qk } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

type ProjectRef = Pick<ProjectSummary, 'id' | 'name' | 'localPath'>;

const errMsg = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));

function useRestore(project: ProjectRef, onDone?: () => void) {
  return useMutation({
    mutationFn: () => api.projects.restore(project.id),
    onSuccess: () => {
      toast.success(`Restored ${project.name}`, {
        description: 'Its tasks continue where they stopped.',
      });
      onDone?.();
    },
    onError: (e) => toast.error('Could not restore project', { description: errMsg(e) }),
  });
}

/** Moves a project off the dashboard. Nothing is deleted, so it can be restored later. */
export function ArchiveDialog({
  project,
  open,
  onOpenChange,
}: {
  project: ProjectRef;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const archive = useMutation({
    mutationFn: () => api.projects.archive(project.id),
    onSuccess: () => {
      toast.success(`Archived ${project.name}`, {
        description: 'Restore it any time from Archived projects on the dashboard.',
      });
      router.push('/');
    },
    onError: (e) => toast.error('Could not archive project', { description: errMsg(e) }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive {project.name}?</DialogTitle>
          <DialogDescription>
            It moves to Archived projects on the dashboard. Building stops, running agents are
            stopped, and its app and terminals are closed. Plans, tasks, history and memory are
            kept: restore it and every task continues where it stopped. The folder{' '}
            <code className="font-mono">{project.localPath}</code> is not touched.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => archive.mutate()} disabled={archive.isPending}>
            {archive.isPending ? <Loader2 className="animate-spin" /> : <Archive />} Archive project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Deletes a project and all its AgentForge data for good. Files on disk are untouched. */
export function DeleteForeverDialog({
  project,
  open,
  onOpenChange,
  onDeleted,
}: {
  project: ProjectRef;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDeleted?: () => void;
}) {
  const [confirm, setConfirm] = useState('');
  const remove = useMutation({
    mutationFn: () => api.projects.remove(project.id),
    onSuccess: () => {
      toast.success(`Deleted ${project.name}`, { description: 'Files on disk were not touched.' });
      onOpenChange(false);
      onDeleted?.();
    },
    onError: (e) => toast.error('Could not delete project', { description: errMsg(e) }),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setConfirm('');
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {project.name} permanently?</DialogTitle>
          <DialogDescription>
            Its plans, tasks, run history and memory are deleted from AgentForge and can’t be
            restored. The folder <code className="font-mono">{project.localPath}</code> and its git
            history stay exactly as they are.
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder={`Type ${project.name} to confirm`}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-label="Confirm project name"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={confirm !== project.name || remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete
            permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Shown instead of the workspace when an archived project is opened directly. */
export function ArchivedProjectNotice({
  project,
}: {
  project: ProjectRef & { archivedAt: number | null };
}) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const restore = useRestore(project);
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 p-16 text-center">
      <div className="bg-muted text-muted-foreground grid size-12 place-items-center rounded-xl">
        <Archive className="size-6" />
      </div>
      <h1 className="text-lg font-semibold">{project.name} is archived</h1>
      <p className="text-muted-foreground text-sm">
        Archived {timeAgo(project.archivedAt)}. Nothing runs while it’s archived. Restore it to
        continue its tasks where they stopped.
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Button onClick={() => restore.mutate()} disabled={restore.isPending}>
          {restore.isPending ? <Loader2 className="animate-spin" /> : <ArchiveRestore />} Restore
        </Button>
        <Button asChild variant="outline">
          <Link href="/">Back to projects</Link>
        </Button>
        <Button
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 /> Delete permanently
        </Button>
      </div>
      <DeleteForeverDialog
        project={project}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => router.push('/')}
      />
    </div>
  );
}

function ArchivedRow({ project }: { project: ProjectSummary }) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const restore = useRestore(project);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{project.name}</p>
        <p className="text-muted-foreground truncate font-mono text-xs">{project.localPath}</p>
      </div>
      <span className="text-muted-foreground text-xs">
        {project.taskCounts.total} task{project.taskCounts.total === 1 ? '' : 's'} · archived{' '}
        {timeAgo(project.archivedAt)}
      </span>
      <div className="flex gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => restore.mutate()}
          disabled={restore.isPending}
        >
          {restore.isPending ? <Loader2 className="animate-spin" /> : <ArchiveRestore />} Restore
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          aria-label={`Delete ${project.name} permanently`}
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 />
        </Button>
      </div>
      <DeleteForeverDialog project={project} open={deleteOpen} onOpenChange={setDeleteOpen} />
    </li>
  );
}

/** Collapsible list of archived projects at the bottom of the dashboard (hidden when empty). */
export function ArchivedProjectsSection() {
  const [open, setOpen] = useState(false);
  const archived = useQuery({ queryKey: qk.archivedProjects, queryFn: api.projects.archived });
  const list = archived.data ?? [];
  if (!list.length) return null;
  return (
    <section className="mt-6 border-t pt-3" aria-label="Archived projects">
      <button
        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm font-medium"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown className={cn('size-4 transition-transform', !open && '-rotate-90')} />
        <Archive className="size-4" /> Archived projects ({list.length})
      </button>
      {open && (
        <ul className="bg-card mt-3 divide-y rounded-xl border">
          {list.map((p) => (
            <ArchivedRow key={p.id} project={p} />
          ))}
        </ul>
      )}
    </section>
  );
}
