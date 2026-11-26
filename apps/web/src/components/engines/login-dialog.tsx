'use client';

import type { EngineInfo } from '@ai-harness/shared';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { XtermView } from '@/components/terminal/xterm-view';
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

/** Runs the engine's own login command in an embedded terminal. */
export function LoginDialog({
  engine,
  open,
  onOpenChange,
}: {
  engine: EngineInfo;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [exited, setExited] = useState<number | null | undefined>(undefined);
  const start = useMutation({ mutationFn: () => api.engines.login(engine.id) });
  const session = start.data;

  const handleOpenChange = (o: boolean) => {
    if (!o && session && exited === undefined)
      void api.terminals.kill(session.terminal.id).catch(() => {});
    onOpenChange(o);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-3xl [&>*]:min-w-0"
        onOpenAutoFocus={() => !start.data && !start.isPending && start.mutate()}
      >
        <DialogHeader>
          <DialogTitle>Log in to {engine.displayName}</DialogTitle>
          <DialogDescription>{session?.hint ?? 'Starting the login flow…'}</DialogDescription>
        </DialogHeader>
        {start.isError ? (
          <p className="text-destructive text-sm">
            {start.error instanceof ApiClientError ? start.error.message : 'Could not start login'}
          </p>
        ) : session ? (
          <XtermView
            terminalId={session.terminal.id}
            className="h-96"
            onExit={(c) => setExited(c)}
          />
        ) : (
          <div className="text-muted-foreground flex h-96 items-center justify-center gap-2 rounded-lg border text-sm">
            <Loader2 className="size-4 animate-spin" /> Starting…
          </div>
        )}
        <DialogFooter className="items-center sm:justify-between">
          <p className="text-muted-foreground text-xs">
            {exited === undefined ? (
              'Credentials stay with the CLI on this machine — AI Harness never sees them.'
            ) : exited === 0 ? (
              <span className="text-success inline-flex items-center gap-1">
                <CheckCircle2 className="size-3.5" /> Login finished — status refreshed.
              </span>
            ) : (
              `Login exited with code ${exited}.`
            )}
          </p>
          <Button
            variant={exited === undefined ? 'outline' : 'default'}
            onClick={() => handleOpenChange(false)}
          >
            {exited === undefined ? 'Cancel' : 'Done'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
