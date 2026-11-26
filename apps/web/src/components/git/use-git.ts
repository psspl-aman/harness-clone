'use client';

import type { GitActionResultDto } from '@ai-harness/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiClientError, qk } from '@/lib/api';

export const errMsg = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));

/**
 * Run a git action: the fresh overview it returns replaces the cached one, branch
 * details refetch, and the outcome shows as a toast. Errors toast unless `quiet`.
 */
export function useGitAction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { run: () => Promise<GitActionResultDto>; quiet?: boolean }) => v.run(),
    onSuccess: (r) => {
      qc.setQueryData(qk.git(projectId), r.overview);
      void qc.invalidateQueries({ queryKey: [...qk.git(projectId), 'branch'] });
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
      toast.success(
        r.message,
        r.url
          ? { action: { label: 'Open', onClick: () => window.open(r.url, '_blank', 'noopener') } }
          : undefined,
      );
    },
    onError: (e, v) => {
      if (!v.quiet) toast.error('Git action failed', { description: errMsg(e) });
    },
  });
}

export const isUnmerged = (e: unknown) =>
  e instanceof ApiClientError && e.code === 'BRANCH_UNMERGED';
