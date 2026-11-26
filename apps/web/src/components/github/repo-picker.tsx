'use client';

import type { GithubRepo } from '@agentforge/shared';
import { useQuery } from '@tanstack/react-query';
import { Check, Lock, Search } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebounced } from '@/hooks/use-debounced';
import { api, ApiClientError, qk } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

export function RepoPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (repo: GithubRepo) => void;
}) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const repos = useQuery({
    queryKey: qk.githubRepos(dq),
    queryFn: () => api.github.repos(dq),
    placeholderData: (prev) => prev,
  });
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
        <Input
          placeholder="Search your repositories"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="pl-8"
          aria-label="Search repositories"
        />
      </div>
      <ScrollArea className="h-64 rounded-lg border">
        {repos.isPending ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : repos.isError ? (
          <p className="text-destructive p-4 text-sm">
            {repos.error instanceof ApiClientError
              ? repos.error.message
              : 'Could not load repositories'}
          </p>
        ) : repos.data?.length === 0 ? (
          <p className="text-muted-foreground p-4 text-sm">No repositories match “{dq}”.</p>
        ) : (
          <ul className="p-1" role="listbox" aria-label="Repositories">
            {repos.data?.map((r) => (
              <li key={r.fullName}>
                <button
                  type="button"
                  role="option"
                  aria-selected={value === r.fullName}
                  onClick={() => onChange(r)}
                  className={cn(
                    'hover:bg-accent flex w-full items-center gap-3 rounded-md px-3 py-2 text-left',
                    value === r.fullName && 'bg-accent',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                      {r.fullName} {r.private && <Lock className="text-muted-foreground size-3" />}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {r.description ?? 'No description'} · updated{' '}
                      {timeAgo(r.updatedAt ? Date.parse(r.updatedAt) : null)}
                    </p>
                  </div>
                  {value === r.fullName && <Check className="text-primary size-4" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
