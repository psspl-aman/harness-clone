'use client';

import type { SafetyApprovalDto } from '@agentforge/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, ApiClientError, qk } from '@/lib/api';
import { countdown } from '@/lib/format';

function ApprovalCard({ a }: { a: SafetyApprovalDto }) {
  const qc = useQueryClient();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const decide = useMutation({
    mutationFn: (d: 'approve' | 'deny') => api.safety.decide(a.id, d),
    onSuccess: (x) =>
      qc.setQueryData<SafetyApprovalDto[]>(qk.safetyApprovals, (l) =>
        l?.map((y) => (y.id === x.id ? x : y)),
      ),
    onError: (e) =>
      toast.error('Could not answer', {
        description: e instanceof ApiClientError ? e.message : String(e),
      }),
  });
  const who = [a.projectName, a.taskKey, a.role].filter(Boolean).join(' · ');
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      role="alertdialog"
      aria-label="An agent needs your approval"
      className="bg-popover border-warning/60 rounded-xl border p-4 shadow-lg"
      data-testid="safety-approval"
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="text-warning mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            An agent wants to {a.tool === 'Bash' ? 'run a command' : `use ${a.tool}`}
          </p>
          {who && <p className="text-muted-foreground text-xs">{who}</p>}
          <pre className="bg-muted mt-2 max-h-28 overflow-auto rounded-md p-2 font-mono text-xs break-all whitespace-pre-wrap">
            {a.summary}
          </pre>
          <p className="mt-2 text-xs">{a.reason}.</p>
          <div className="mt-3 flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => decide.mutate('deny')}
              disabled={decide.isPending}
            >
              Deny
            </Button>
            <Button size="sm" onClick={() => decide.mutate('approve')} disabled={decide.isPending}>
              Allow once
            </Button>
            <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">
              Denied in {countdown(a.expiresAt)}
            </span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/** Agent tool calls waiting for your decision (Settings → Safety → Confirm dangerous commands). */
export function SafetyApprovals() {
  const q = useQuery({
    queryKey: qk.safetyApprovals,
    queryFn: api.safety.approvals,
    refetchInterval: 60_000,
  });
  const pending = (q.data ?? []).filter((a) => a.status === 'pending');
  return (
    <div className="pointer-events-none fixed right-4 bottom-20 z-50 flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2">
      <AnimatePresence initial={false}>
        {pending.map((a) => (
          <div key={a.id} className="pointer-events-auto">
            <ApprovalCard a={a} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}
