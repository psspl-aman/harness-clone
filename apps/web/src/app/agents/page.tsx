'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { CustomEngineDialog } from '@/components/engines/custom-engine-dialog';
import { EngineCard } from '@/components/engines/engine-card';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, qk } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function AgentsPage() {
  const queryClient = useQueryClient();
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  const [addOpen, setAddOpen] = useState(false);
  const refreshAll = useMutation({
    mutationFn: api.engines.refreshAll,
    onSuccess: (list) => queryClient.setQueryData(qk.engines, list),
  });
  const builtin = engines.data?.filter((e) => e.kind === 'builtin') ?? [];
  const custom = engines.data?.filter((e) => e.kind === 'custom') ?? [];

  return (
    <div className="portal-content py-8">
      <PageHeader
        title="Agents & Accounts"
        description="The coding-agent CLIs AgentForge can drive, and whether each is installed and signed in."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshAll.mutate()}
              disabled={refreshAll.isPending}
            >
              <RefreshCw className={cn(refreshAll.isPending && 'animate-spin')} /> Check all
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus /> Custom CLI
            </Button>
          </>
        }
      />
      {engines.isPending ? (
        <div className="grid gap-4 2xl:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-36 rounded-2xl" />
          ))}
        </div>
      ) : (
        // Two columns only once each card has room for its header and quota bars.
        <div className="grid items-start gap-4 2xl:grid-cols-2">
          {builtin.map((e, i) => (
            <EngineCard key={e.id} engine={e} index={i} />
          ))}
          {custom.length > 0 && (
            <>
              <h2 className="text-muted-foreground col-span-full pt-4 text-sm font-medium">
                Custom engines
              </h2>
              {custom.map((e, i) => (
                <EngineCard key={e.id} engine={e} index={builtin.length + i} />
              ))}
            </>
          )}
        </div>
      )}
      {addOpen && <CustomEngineDialog open={addOpen} onOpenChange={setAddOpen} />}
    </div>
  );
}
