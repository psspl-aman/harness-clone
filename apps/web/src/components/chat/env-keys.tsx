'use client';

import type { EnvKeyRequestDto } from '@agentforge/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Eye, EyeOff, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiClientError, qk } from '@/lib/api';
import { cn } from '@/lib/utils';

const errMsg = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));

/** One key the project needs. The typed value lives only in this component until Save. */
function KeyCard({ projectId, k }: { projectId: string; k: EnvKeyRequestDto }) {
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const save = useMutation({
    // No mutation variables: the value is read from the closure so React Query never
    // keeps a copy of it in its cache.
    mutationFn: () => api.envKeys.setValue(projectId, k.id, value),
    onSuccess: (r) => {
      setValue('');
      setShow(false);
      void qc.invalidateQueries({ queryKey: qk.envKeys(projectId) });
      toast.success(`${k.name} saved to ${r.request.file}`, {
        description: 'Only in that file (gitignored). Restart the app (Run) to pick it up.',
      });
      for (const w of r.warnings) toast.warning(w, { duration: 15_000 });
    },
    onError: (e) => toast.error(`Could not save ${k.name}`, { description: errMsg(e) }),
  });
  const skip = useMutation({
    mutationFn: () => api.envKeys.skip(projectId, k.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.envKeys(projectId) }),
    onError: (e) => toast.error('Could not skip', { description: errMsg(e) }),
  });

  return (
    <li className="space-y-1.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs font-medium">{k.name}</span>
        <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px] font-normal">
          {k.file}
        </Badge>
        {k.taskKey && <span className="text-muted-foreground text-[11px]">{k.taskKey}</span>}
      </div>
      {k.why && <p className="text-muted-foreground text-[11px]">{k.why}</p>}
      {k.publicPrefixWarning && (
        <p className="text-warning flex items-start gap-1 text-[11px]">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          This name is shipped to the browser. Put secret keys in a server-only variable instead.
        </p>
      )}
      <form
        className="flex items-center gap-1"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (value && !save.isPending) save.mutate();
        }}
      >
        <Input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={k.secret ? 'Paste the value' : 'Value'}
          aria-label={`Value for ${k.name}`}
          className="h-7 min-w-0 flex-1 font-mono text-xs"
          autoComplete="new-password"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={show ? 'Hide value' : 'Show value'}
          onClick={() => setShow((s) => !s)}
        >
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </Button>
        <Button
          type="submit"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={!value || save.isPending}
        >
          {save.isPending && <Loader2 className="animate-spin" />} Save
        </Button>
      </form>
      {k.status === 'pending' && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-[11px]"
          onClick={() => skip.mutate()}
          disabled={skip.isPending}
        >
          Skip for now
        </button>
      )}
    </li>
  );
}

/**
 * Keys the project needs from you (declared by an agent or listed in a .env.example),
 * shown above the chat composer. Values go straight into the project's gitignored .env.
 */
export function EnvKeysStrip({ projectId }: { projectId: string }) {
  const keys = useQuery({
    queryKey: qk.envKeys(projectId),
    queryFn: () => api.envKeys.list(projectId),
    // Fallback for .env.example files edited outside AgentForge.
    refetchInterval: 30_000,
  });
  const [showSkipped, setShowSkipped] = useState(false);
  const pending = (keys.data ?? []).filter((k) => k.status === 'pending');
  const skipped = (keys.data ?? []).filter((k) => k.status === 'skipped');
  if (!pending.length && !skipped.length) return null;
  const shown = showSkipped ? [...pending, ...skipped] : pending;
  return (
    <div className="border-t bg-amber-500/5 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <KeyRound className="text-warning size-3.5" />
          {pending.length
            ? `${pending.length} key${pending.length === 1 ? '' : 's'} needed`
            : 'Keys skipped'}
        </p>
        {skipped.length > 0 && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground text-[11px]"
            onClick={() => setShowSkipped((s) => !s)}
          >
            {showSkipped ? 'Hide skipped' : `${skipped.length} skipped`}
          </button>
        )}
      </div>
      {shown.length > 0 && (
        <ul className={cn('max-h-64 divide-y overflow-y-auto')}>
          {shown.map((k) => (
            <KeyCard key={k.id} projectId={projectId} k={k} />
          ))}
        </ul>
      )}
      <p className="text-muted-foreground flex items-start gap-1 pt-1 text-[10px] leading-snug">
        <ShieldCheck className="text-success mt-px size-3 shrink-0" />
        Written only to the project’s gitignored .env on this machine — not to the chat,
        AgentForge’s database or agents. Masked in logs; never committed.
      </p>
    </div>
  );
}
