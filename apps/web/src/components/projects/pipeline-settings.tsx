'use client';

import { DEFAULT_ROUTING, type ProjectDetail } from '@agentforge/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save, Workflow } from 'lucide-react';
import { RoutingEditor } from '@/components/settings/routing-editor';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api, ApiClientError, qk } from '@/lib/api';

type P = ProjectDetail['pipeline'];
const DEFAULT = '__default';
const NONE = '__none';

/** Per-project pipeline overrides and engine fallback. Empty = use the global setting. */
export function PipelineSettingsCard({ project }: { project: ProjectDetail }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  const [edits, setEdits] = useState<P | null>(null);
  const v = edits ?? project.pipeline;
  const set = (patch: Partial<P>) => setEdits({ ...v, ...patch });
  const dirty = edits !== null && JSON.stringify(edits) !== JSON.stringify(project.pipeline);
  const save = useMutation({
    mutationFn: () => {
      const { paused: _paused, ...rest } = v;
      return api.projects.update(project.id, { pipeline: rest });
    },
    onSuccess: (p) => {
      queryClient.setQueryData(qk.project(p.id), p);
      setEdits(null);
      toast.success('Pipeline settings saved');
    },
    onError: (e) =>
      toast.error('Could not save', {
        description: e instanceof ApiClientError ? e.message : String(e),
      }),
  });
  const g = settings.data;
  const usable = (engines.data ?? []).filter((e) => e.enabled && e.installed);

  return (
    <Card className="gap-4 shadow-xs">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Workflow className="size-4" /> Pipeline
          </CardTitle>
          <CardDescription>
            Overrides for this project. Leave a field on default to follow Settings.
          </CardDescription>
        </div>
        {dirty && (
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="pp-parallel">Parallel tasks</Label>
            <Input
              id="pp-parallel"
              type="number"
              min={1}
              max={16}
              placeholder={g ? `Default (${g.concurrency.maxTasksPerProject})` : 'Default'}
              value={v.maxConcurrentTasks ?? ''}
              onChange={(e) =>
                set({ maxConcurrentTasks: e.target.value ? Number(e.target.value) : null })
              }
              className="h-8"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pp-loops">Max fix loops</Label>
            <Input
              id="pp-loops"
              type="number"
              min={0}
              max={10}
              placeholder={g ? `Default (${g.pipeline.maxFixLoops})` : 'Default'}
              value={v.maxFixLoops ?? ''}
              onChange={(e) => set({ maxFixLoops: e.target.value ? Number(e.target.value) : null })}
              className="h-8"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pp-budget">Monthly budget ($)</Label>
            <Input
              id="pp-budget"
              type="number"
              min={0}
              max={1000000}
              step={1}
              placeholder={g?.monthlyBudgetUsd ? `Default ($${g.monthlyBudgetUsd})` : 'No cap'}
              value={v.monthlyBudgetUsd ?? ''}
              onChange={(e) =>
                set({ monthlyBudgetUsd: e.target.value ? Number(e.target.value) : null })
              }
              className="h-8"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pp-review">Review before merge</Label>
            <Select
              value={v.requireHumanReview === null ? DEFAULT : v.requireHumanReview ? 'on' : 'off'}
              onValueChange={(x) => set({ requireHumanReview: x === DEFAULT ? null : x === 'on' })}
            >
              <SelectTrigger id="pp-review" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT}>
                  Default ({g?.pipeline.requireHumanReviewBeforeMerge ? 'on' : 'off'})
                </SelectItem>
                <SelectItem value="on">Require my review</SelectItem>
                <SelectItem value="off">Merge automatically</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pp-merge">When a task is done</Label>
            <Select
              value={v.mergeStrategy ?? DEFAULT}
              onValueChange={(x) =>
                set({ mergeStrategy: x === DEFAULT ? null : (x as 'merge' | 'pull_request') })
              }
            >
              <SelectTrigger id="pp-merge" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT}>
                  Default ({g?.pipeline.mergeStrategy === 'pull_request' ? 'open a PR' : 'merge'})
                </SelectItem>
                <SelectItem value="merge">Merge into working branch</SelectItem>
                <SelectItem value="pull_request" disabled={!project.githubRepo}>
                  Open a GitHub PR{project.githubRepo ? '' : ' (GitHub projects only)'}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-3 rounded-lg border p-3">
          <Label className="flex items-start gap-3 font-normal">
            <Switch
              checked={v.fallbackEnabled}
              onCheckedChange={(x) => set({ fallbackEnabled: x })}
              className="mt-0.5"
              aria-label="Engine fallback"
            />
            <span>
              <span className="text-sm font-medium">Engine fallback</span>
              <span className="text-muted-foreground block text-xs">
                When an engine runs out of usage, continue the step on another engine instead of
                pausing.
              </span>
            </span>
          </Label>
          {v.fallbackEnabled && (
            <div className="space-y-2">
              {usable.map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-3 text-sm">
                  <span>If {e.displayName} is exhausted, use</span>
                  <Select
                    value={v.engineFallback[e.id] ?? NONE}
                    onValueChange={(x) => {
                      const next = { ...v.engineFallback };
                      if (x === NONE) delete next[e.id];
                      else next[e.id] = x;
                      set({ engineFallback: next });
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-48"
                      aria-label={`Fallback for ${e.displayName}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Pause and wait</SelectItem>
                      {usable
                        .filter((o) => o.id !== e.id)
                        .map((o) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.displayName}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3 rounded-lg border p-3">
          <Label className="flex items-start gap-3 font-normal">
            <Switch
              checked={v.routing !== null}
              onCheckedChange={(x) => set({ routing: x ? (g?.routing ?? DEFAULT_ROUTING) : null })}
              className="mt-0.5"
              aria-label="Override complexity routing"
            />
            <span>
              <span className="text-sm font-medium">Override complexity routing</span>
              <span className="text-muted-foreground block text-xs">
                Route this project’s tasks by complexity with its own map instead of the global one
                ({g?.routing.enabled ? 'on' : 'off'}).
              </span>
            </span>
          </Label>
          {v.routing !== null && (
            <RoutingEditor value={v.routing} onChange={(r) => set({ routing: r })} />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
