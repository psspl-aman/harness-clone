'use client';

import type { EngineInfo } from '@ai-harness/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import {
  ChevronDown,
  Copy,
  ExternalLink,
  FlaskConical,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import { useNow } from '@/hooks/use-now';
import { api, ApiClientError, qk } from '@/lib/api';
import { countdown, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CustomEngineDialog } from './custom-engine-dialog';
import { LoginDialog } from './login-dialog';
import { EngineStatusPill } from './status-pill';
import { TestRunDialog } from './test-run-dialog';

const ACCENTS: Record<string, string> = {
  'claude-code': 'from-orange-400 to-amber-600',
  codex: 'from-zinc-600 to-zinc-900',
  'gemini-cli': 'from-sky-400 to-indigo-600',
  antigravity: 'from-blue-500 to-emerald-500',
};
const DEFAULT_MODEL = '__default';
const errText = (e: unknown) => (e instanceof ApiClientError ? e.message : String(e));

function UsageWindows({ engine }: { engine: EngineInfo }) {
  const now = useNow(30_000, engine.usageWindows.length > 0);
  if (!engine.usageWindows.length) return null;
  const label = (n: string) =>
    ({ five_hour: '5-hour window', seven_day: '7-day window' })[n] ?? n.replace(/_/g, ' ');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {engine.usageWindows.map((w) => {
        const pct = w.utilization !== null ? Math.round(w.utilization * 100) : null;
        return (
          <div key={w.name} className="space-y-1">
            <div className="text-muted-foreground flex justify-between text-xs">
              <span>{label(w.name)}</span>
              <span className="tabular-nums">
                {pct !== null ? `${pct}% used` : '—'}
                {w.resetsAt && w.resetsAt > now ? ` · resets in ${countdown(w.resetsAt, now)}` : ''}
              </span>
            </div>
            <div
              className="bg-muted h-1.5 overflow-hidden rounded-full"
              role="progressbar"
              aria-valuenow={pct ?? 0}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={label(w.name)}
            >
              <div
                className={cn(
                  'h-full rounded-full',
                  (pct ?? 0) >= 90
                    ? 'bg-destructive'
                    : (pct ?? 0) >= 70
                      ? 'bg-warning'
                      : 'bg-primary',
                )}
                style={{ width: `${pct ?? 0}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function EngineCard({ engine, index }: { engine: EngineInfo; index: number }) {
  const queryClient = useQueryClient();
  const [loginOpen, setLoginOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [binary, setBinary] = useState<string | null>(null);

  const onUpdated = (msg?: string) => (e: EngineInfo) => {
    queryClient.setQueryData<EngineInfo[]>(qk.engines, (list) =>
      list?.map((x) => (x.id === e.id ? e : x)),
    );
    if (msg) toast.success(msg);
  };
  const onError = (title: string) => (e: unknown) =>
    toast.error(title, { description: errText(e) });
  const refresh = useMutation({
    mutationFn: () => api.engines.refresh(engine.id),
    onSuccess: onUpdated(),
    onError: onError('Refresh failed'),
  });
  const update = useMutation({
    mutationFn: (p: Parameters<typeof api.engines.update>[1]) => api.engines.update(engine.id, p),
    onSuccess: onUpdated('Saved'),
    onError: onError('Could not save'),
  });
  const logout = useMutation({
    mutationFn: () => api.engines.logout(engine.id),
    onSuccess: onUpdated(`Logged out of ${engine.displayName}`),
    onError: onError('Logout failed'),
  });
  const setKey = useMutation({
    mutationFn: () => api.engines.setApiKey(engine.id, apiKey.trim()),
    onSuccess: (e) => {
      setApiKey('');
      onUpdated('API key saved')(e);
    },
    onError: onError('Could not save API key'),
  });
  const clearKey = useMutation({
    mutationFn: () => api.engines.clearApiKey(engine.id),
    onSuccess: onUpdated('API key removed'),
    onError: onError('Could not remove key'),
  });
  const remove = useMutation({
    mutationFn: () => api.engines.removeCustom(engine.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.engines });
      toast.success(`Removed ${engine.displayName}`);
    },
    onError: onError('Could not remove'),
  });

  const installed = engine.installed;
  const needsLogin =
    installed && (engine.authStatus === 'LOGGED_OUT' || engine.authStatus === 'EXPIRED');
  // Signed in (a used-up quota still means signed in): no Login button — switch accounts by
  // logging out under Configure first.
  const signedIn = engine.authStatus === 'ACTIVE' || engine.authStatus === 'QUOTA_EXHAUSTED';

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.05, 0.3) }}
      aria-label={engine.displayName}
      className={cn(
        'bg-card rounded-2xl border shadow-xs transition-opacity',
        !engine.enabled && 'opacity-70',
      )}
    >
      <div className="flex flex-wrap items-start gap-4 p-5">
        <div
          className={cn(
            'grid size-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br text-lg font-semibold text-white shadow-sm',
            ACCENTS[engine.id] ?? 'from-violet-500 to-fuchsia-600',
          )}
        >
          {engine.displayName[0]}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold tracking-tight">{engine.displayName}</h2>
            <EngineStatusPill
              status={engine.enabled ? engine.authStatus : 'UNKNOWN'}
              resetAt={engine.resetAt}
            />
            {!engine.enabled && <span className="text-muted-foreground text-xs">Disabled</span>}
            {engine.version && (
              <span className="text-muted-foreground font-mono text-xs">v{engine.version}</span>
            )}
          </div>
          <p className="text-muted-foreground text-sm">{engine.description}</p>
          {installed && (engine.accountLabel || engine.authDetail) && (
            <p className="text-xs">
              {engine.accountLabel && <span className="font-medium">{engine.accountLabel}</span>}
              {engine.accountLabel && engine.authDetail && (
                <span className="text-muted-foreground"> · </span>
              )}
              {engine.authDetail && (
                <span className="text-muted-foreground">{engine.authDetail}</span>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {installed && engine.capabilities.login && !signedIn && (
            <Button
              size="sm"
              variant={needsLogin ? 'default' : 'outline'}
              onClick={() => setLoginOpen(true)}
            >
              <LogIn /> {engine.authStatus === 'EXPIRED' ? 'Re-login' : 'Login'}
            </Button>
          )}
          {installed && engine.authStatus === 'ACTIVE' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setTestOpen(true)}
              disabled={!engine.enabled}
            >
              <FlaskConical /> Test
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={`Refresh ${engine.displayName}`}
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            <RefreshCw className={cn(refresh.isPending && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {(installed && engine.usageWindows.length > 0) || !installed ? (
        <div className="space-y-4 px-5 pb-4">
          {installed && <UsageWindows engine={engine} />}
          {!installed && (
            <div className="bg-muted/50 flex flex-wrap items-center gap-3 rounded-xl border border-dashed p-3 text-sm">
              <span className="text-muted-foreground">Not found on this machine.</span>
              {engine.installCommand && (
                <button
                  className="bg-background hover:border-primary/40 flex min-w-0 items-center gap-2 rounded-md border px-2 py-1 font-mono text-xs"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(engine.installCommand!)
                      .then(() => toast.success('Install command copied'))
                  }
                  title="Copy install command"
                >
                  <span className="truncate">{engine.installCommand}</span>{' '}
                  <Copy className="size-3 shrink-0" />
                </button>
              )}
              {engine.installGuideUrl && (
                <a
                  href={engine.installGuideUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary inline-flex items-center gap-1 text-xs hover:underline"
                >
                  Install guide <ExternalLink className="size-3" />
                </a>
              )}
            </div>
          )}
        </div>
      ) : null}

      <div className="border-t">
        <button
          className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between px-5 py-2.5 text-xs font-medium"
          onClick={() => setConfigOpen((o) => !o)}
          aria-expanded={configOpen}
        >
          <span>
            Configure
            {engine.lastCheckedAt ? (
              <span className="font-normal"> · checked {timeAgo(engine.lastCheckedAt)}</span>
            ) : null}
          </span>
          <ChevronDown className={cn('size-4 transition-transform', configOpen && 'rotate-180')} />
        </button>
        {configOpen && (
          <div className="grid gap-5 px-5 pb-5 md:grid-cols-2">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor={`en-${engine.id}`}>Enabled</Label>
              <Switch
                id={`en-${engine.id}`}
                checked={engine.enabled}
                onCheckedChange={(v) => update.mutate({ enabled: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor={`model-${engine.id}`}>Default model</Label>
              <Select
                value={engine.defaultModel ?? DEFAULT_MODEL}
                onValueChange={(v) =>
                  update.mutate({ defaultModel: v === DEFAULT_MODEL ? null : v })
                }
              >
                <SelectTrigger id={`model-${engine.id}`} size="sm" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_MODEL}>CLI default</SelectItem>
                  {[
                    ...engine.models,
                    ...(engine.defaultModel &&
                    !engine.models.some((m) => m.id === engine.defaultModel)
                      ? [{ id: engine.defaultModel, label: engine.defaultModel }]
                      : []),
                  ].map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <form
              className="space-y-1.5 md:col-span-2"
              onSubmit={(e) => {
                e.preventDefault();
                update.mutate({ binaryPath: (binary ?? '').trim() || null });
              }}
            >
              <Label htmlFor={`bin-${engine.id}`}>Executable</Label>
              <div className="flex gap-2">
                <Input
                  id={`bin-${engine.id}`}
                  value={binary ?? engine.binaryOverride ?? ''}
                  placeholder="Auto-detect"
                  onChange={(e) => setBinary(e.target.value)}
                  className="h-8 font-mono text-xs"
                />
                <Button size="sm" variant="outline" type="submit" disabled={binary === null}>
                  Save
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                Leave empty to auto-detect{engine.path ? ` (found ${engine.path})` : ''}.
              </p>
            </form>
            <form
              className="space-y-1.5 md:col-span-2"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const limit = Number(f.get('limit')) || null;
                const hours = Number(f.get('hours')) || null;
                update.mutate({
                  windowTokenLimit: limit && hours ? limit : null,
                  windowHours: limit && hours ? hours : null,
                });
              }}
            >
              <Label htmlFor={`limit-${engine.id}`}>Usage window limit</Label>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Input
                  id={`limit-${engine.id}`}
                  name="limit"
                  type="number"
                  min={1}
                  defaultValue={engine.windowTokenLimit ?? ''}
                  placeholder="tokens"
                  className="h-8 w-36"
                />
                <span className="text-muted-foreground">tokens per</span>
                <Input
                  name="hours"
                  type="number"
                  min={1}
                  step="0.5"
                  defaultValue={engine.windowHours ?? ''}
                  placeholder="hours"
                  aria-label="Window length in hours"
                  className="h-8 w-24"
                />
                <span className="text-muted-foreground">hours</span>
                <Button size="sm" variant="outline" type="submit">
                  Save
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                Optional. Shows how much of your plan’s window is used on the Usage page (Claude
                Code reports its windows itself).
              </p>
            </form>
            {engine.capabilities.apiKey && (
              <form
                className="space-y-1.5 md:col-span-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (apiKey.trim().length >= 8) setKey.mutate();
                }}
              >
                <Label htmlFor={`key-${engine.id}`} className="flex items-center gap-1.5">
                  <KeyRound className="size-3.5" /> API key{' '}
                  {engine.hasApiKey && (
                    <span className="text-success text-xs font-normal">· stored</span>
                  )}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id={`key-${engine.id}`}
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      engine.hasApiKey
                        ? '•••••••• (replace)'
                        : 'Optional — use instead of signing in'
                    }
                    className="h-8 font-mono text-xs"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    type="submit"
                    disabled={apiKey.trim().length < 8 || setKey.isPending}
                  >
                    {setKey.isPending && <Loader2 className="animate-spin" />} Save
                  </Button>
                  {engine.hasApiKey && (
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => clearKey.mutate()}
                    >
                      Remove
                    </Button>
                  )}
                </div>
                <p className="text-muted-foreground text-xs">
                  Encrypted on this machine and passed to the CLI only through its environment.
                </p>
              </form>
            )}
            <div className="flex flex-wrap gap-2 md:col-span-2">
              {installed && engine.capabilities.logout && engine.authStatus !== 'LOGGED_OUT' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => logout.mutate()}
                  disabled={logout.isPending}
                >
                  <LogOut /> Log out
                </Button>
              )}
              {engine.kind === 'custom' && (
                <>
                  <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                    <Pencil /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => remove.mutate()}
                  >
                    <Trash2 /> Remove
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {loginOpen && <LoginDialog engine={engine} open={loginOpen} onOpenChange={setLoginOpen} />}
      {testOpen && <TestRunDialog engine={engine} open={testOpen} onOpenChange={setTestOpen} />}
      {editOpen && (
        <CustomEngineDialog engine={engine} open={editOpen} onOpenChange={setEditOpen} />
      )}
    </motion.article>
  );
}
