'use client';

import type { PathCheckResult } from '@ai-harness/shared';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';

export function PathCheckStatus({
  check,
  loading,
}: {
  check: PathCheckResult | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Loader2 className="size-3.5 animate-spin" /> Checking folder…
      </p>
    );
  }
  if (!check) return null;
  return (
    <div className="space-y-1 text-xs" aria-live="polite">
      {check.ok ? (
        <p className="text-success flex items-center gap-1.5">
          <CheckCircle2 className="size-3.5" />
          {check.exists
            ? check.isGitRepo
              ? 'Folder is a git repository'
              : 'Folder looks good'
            : 'Folder will be created'}
        </p>
      ) : (
        <p className="text-destructive flex items-center gap-1.5">
          <XCircle className="size-3.5" /> {check.reason}
        </p>
      )}
      {check.ok &&
        check.warnings.map((w) => (
          <p key={w} className="text-warning flex items-center gap-1.5">
            <AlertTriangle className="size-3.5" /> {w}
          </p>
        ))}
    </div>
  );
}
