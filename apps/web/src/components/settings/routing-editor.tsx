'use client';

import {
  COMPLEXITIES,
  EFFORT_LABELS,
  EFFORTS,
  type Complexity,
  type Effort,
  type PipelineProfile,
  type Routing,
} from '@agentforge/shared';
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

const COMPLEXITY_LABELS: Record<Complexity, string> = {
  xs: 'XS · trivial',
  s: 'S · small',
  m: 'M · medium',
  l: 'L · large',
  xl: 'XL · very large',
};

/** Edit a complexity→pipeline-profile routing map (used in global Settings and per project). */
export function RoutingEditor({
  value,
  onChange,
}: {
  value: Routing;
  onChange: (v: Routing) => void;
}) {
  const setProfile = (c: Complexity, patch: Partial<Routing['profiles'][Complexity]>) =>
    onChange({
      ...value,
      profiles: { ...value.profiles, [c]: { ...value.profiles[c], ...patch } },
    });
  return (
    <div className="space-y-4">
      <Label className="flex items-start gap-3 font-normal">
        <Switch
          checked={value.enabled}
          onCheckedChange={(x) => onChange({ ...value, enabled: x })}
          className="mt-0.5"
          aria-label="Route tasks by complexity"
        />
        <span>
          <span className="text-sm font-medium">Route tasks by complexity</span>
          <span className="text-muted-foreground block text-xs">
            Give each complexity a pipeline and a model. Off: every task runs the full pipeline with
            its usual model.
          </span>
        </span>
      </Label>
      {value.enabled && (
        <div className="divide-y rounded-lg border">
          {COMPLEXITIES.map((c) => {
            const rule = value.profiles[c];
            return (
              <div key={c} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <span className="w-28 text-sm font-medium">{COMPLEXITY_LABELS[c]}</span>
                <Select
                  value={rule.pipeline}
                  onValueChange={(p) => setProfile(c, { pipeline: p as PipelineProfile })}
                >
                  <SelectTrigger size="sm" className="w-44" aria-label={`${c} pipeline`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lite">Lite · Develop → Merge</SelectItem>
                    <SelectItem value="full">Full pipeline</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={rule.model ?? ''}
                  placeholder="Engine default model"
                  aria-label={`${c} model`}
                  onChange={(e) =>
                    setProfile(c, { model: e.target.value.trim() ? e.target.value.trim() : null })
                  }
                  className="h-8 w-44 font-mono text-xs"
                />
                <Select
                  value={rule.effort ?? '__default'}
                  onValueChange={(v) =>
                    setProfile(c, { effort: v === '__default' ? null : (v as Effort) })
                  }
                >
                  <SelectTrigger size="sm" className="w-36" aria-label={`${c} effort`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default">Default effort</SelectItem>
                    {EFFORTS.map((e) => (
                      <SelectItem key={e} value={e}>
                        {EFFORT_LABELS[e]} effort
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
          <p className="text-muted-foreground px-3 py-2 text-xs">
            Lite skips Review, Test and Document. The model is applied only when the role’s engine
            offers it (e.g. “haiku”/“opus” for Claude, “gpt-5-codex” for Codex); otherwise the
            engine’s own default is used. Effort applies to engines that support it (Claude Code,
            Codex) and is used when the task and project set none.
          </p>
        </div>
      )}
    </div>
  );
}
