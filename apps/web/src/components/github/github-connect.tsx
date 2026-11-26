'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, LogOut, Terminal } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { GithubIcon } from '@/components/icons';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiClientError, qk } from '@/lib/api';

const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo,read:org&description=AI Harness';

export function useGithubStatus() {
  return useQuery({ queryKey: qk.github, queryFn: api.github.status });
}

/** Connect / show the GitHub account. Tokens go straight to the daemon’s encrypted store. */
export function GithubConnect({ compact = false }: { compact?: boolean }) {
  const queryClient = useQueryClient();
  const status = useGithubStatus();
  const [token, setToken] = useState('');
  const onDone = (msg: string) => (s: Awaited<ReturnType<typeof api.github.status>>) => {
    queryClient.setQueryData(qk.github, s);
    setToken('');
    toast.success(msg);
  };
  const onError = (err: unknown) =>
    toast.error(err instanceof ApiClientError ? err.message : 'GitHub request failed');
  const connect = useMutation({
    mutationFn: () => api.github.connect(token.trim()),
    onSuccess: onDone('GitHub connected'),
    onError,
  });
  const importCli = useMutation({
    mutationFn: api.github.importCli,
    onSuccess: onDone('Connected using GitHub CLI'),
    onError,
  });
  const disconnect = useMutation({
    mutationFn: api.github.disconnect,
    onSuccess: onDone('GitHub disconnected'),
    onError,
  });

  if (status.isPending) return <Skeleton className="h-24 rounded-xl" />;
  const s = status.data;

  if (s?.connected) {
    return (
      <div className="flex items-center gap-3">
        <Avatar className="size-10">
          {s.avatarUrl && <AvatarImage src={s.avatarUrl} alt="" />}
          <AvatarFallback>{s.login?.[0]?.toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{s.name ?? s.login}</p>
          <p className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
            @{s.login} · via {s.source === 'gh-cli' ? 'GitHub CLI' : 'token'}
            {s.scopes.map((sc) => (
              <Badge key={sc} variant="secondary" className="px-1.5 py-0 font-mono text-[10px]">
                {sc}
              </Badge>
            ))}
          </p>
        </div>
        {!compact && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
          >
            <LogOut /> Disconnect
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {s?.ghCliAvailable && (
        <div className="bg-accent/50 flex flex-wrap items-center gap-3 rounded-lg border p-3">
          <Terminal className="text-primary size-4" />
          <p className="flex-1 text-sm">You’re logged in to the GitHub CLI on this machine.</p>
          <Button
            type="button"
            size="sm"
            onClick={() => importCli.mutate()}
            disabled={importCli.isPending}
          >
            {importCli.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <GithubIcon className="size-4" />
            )}{' '}
            Use GitHub CLI login
          </Button>
        </div>
      )}
      {/* Not a <form>: this renders inside the new-project wizard's form, and a nested form
          submits natively (reloading the page) instead of connecting. */}
      <div className="space-y-2">
        <Label htmlFor="gh-token">Personal access token</Label>
        <div className="flex gap-2">
          <Input
            id="gh-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="ghp_… or github_pat_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              // Keep Enter from submitting an enclosing form (e.g. the wizard).
              e.preventDefault();
              if (token.trim() && !connect.isPending) connect.mutate();
            }}
            className="font-mono"
          />
          <Button
            type="button"
            onClick={() => connect.mutate()}
            disabled={!token.trim() || connect.isPending}
          >
            {connect.isPending && <Loader2 className="animate-spin" />} Connect
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Needs the <code>repo</code> scope (and <code>read:org</code> for organisations). Stored
          encrypted on this machine only.{' '}
          <a
            href={TOKEN_URL}
            target="_blank"
            rel="noreferrer"
            className="text-primary inline-flex items-center gap-0.5 hover:underline"
          >
            Create a token <ExternalLink className="size-3" />
          </a>
        </p>
      </div>
    </div>
  );
}
