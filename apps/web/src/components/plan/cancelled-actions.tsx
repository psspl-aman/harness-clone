'use client';

import type { TaskDto } from '@ai-harness/shared';
import { useMutation } from '@tanstack/react-query';
import { Play, RotateCcw } from 'lucide-react';
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
import { api, ApiClientError } from '@/lib/api';
import { cn } from '@/lib/utils';

const errText = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));

/** Resume (keep the work, continue where it stopped) or restart (from scratch) a cancelled task. */
export function CancelledActions({ task, compact = false }: { task: TaskDto; compact?: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const act = useMutation({
    mutationFn: (action: 'resume' | 'restart') => api.pipeline.task(task.id, action),
    onSuccess: (_, action) =>
      toast.success(action === 'resume' ? `Resumed ${task.key}` : `Restarted ${task.key}`, {
        description:
          action === 'resume'
            ? 'It continues from where it was cancelled.'
            : 'It will be built again from scratch.',
      }),
    onError: (e) => toast.error('Action failed', { description: errText(e) }),
  });
  if (task.status !== 'CANCELLED') return null;
  const size = compact ? 'h-7 px-2 text-xs' : undefined;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className={cn(size)}
        disabled={act.isPending}
        title="Continue from where it was cancelled, keeping its work so far"
        onClick={() => act.mutate('resume')}
      >
        <Play /> Resume
      </Button>
      <Button
        size="sm"
        variant="outline"
        className={cn(size)}
        disabled={act.isPending}
        title="Discard its work and build it again from scratch"
        onClick={() => (task.pipeline.branch ? setConfirm(true) : act.mutate('restart'))}
      >
        <RotateCcw /> Restart
      </Button>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restart {task.key} from scratch?</DialogTitle>
            <DialogDescription>
              Its branch <span className="font-mono">{task.pipeline.branch}</span> and any work on
              it are deleted, and the task is built again from the start. Use Resume to keep the
              work instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirm(false);
                act.mutate('restart');
              }}
            >
              <RotateCcw /> Restart from scratch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
