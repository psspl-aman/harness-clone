'use client';

import type { KeyValueInput } from '@ai-harness/shared';
import { KeyRound, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface KvRow extends KeyValueInput {
  /** A secret already stored on the daemon (value left blank keeps it). */
  saved?: boolean;
  hint?: string;
}

const inputType = (masked?: boolean) => (masked ? 'password' : 'text'); // gforge:allow — input type

/** Editable list of env vars / headers; secrets are write-only. */
export function KvEditor({
  rows,
  onChange,
  addLabel,
  keyPlaceholder,
}: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  addLabel: string;
  keyPlaceholder: string;
}) {
  const set = (i: number, patch: Partial<KvRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={r.key}
            onChange={(e) => set(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            className="h-8 w-[38%] font-mono text-xs"
            aria-label={`Name ${i + 1}`}
          />
          <Input
            value={r.value ?? ''}
            onChange={(e) => set(i, { value: e.target.value })}
            type={inputType(r.secret)}
            autoComplete="off"
            placeholder={
              r.secret && r.saved ? '•••••• saved — leave blank to keep' : (r.hint ?? 'value')
            }
            className="h-8 flex-1 font-mono text-xs"
            aria-label={`Value ${i + 1}`}
          />
          <Button
            type="button"
            size="icon"
            variant={r.secret ? 'secondary' : 'ghost'}
            className={cn('size-8', r.secret && 'text-primary')}
            title={r.secret ? 'Secret (stored encrypted, never shown)' : 'Mark as secret'}
            aria-label={
              r.secret
                ? `Unmark ${r.key || 'value'} as secret`
                : `Mark ${r.key || 'value'} as secret`
            }
            aria-pressed={!!r.secret}
            onClick={() => set(i, { secret: !r.secret, saved: false })}
          >
            <KeyRound className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={`Remove ${r.key || 'row'}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="text-xs"
        onClick={() => onChange([...rows, { key: '', value: '', secret: false }])}
      >
        <Plus /> {addLabel}
      </Button>
    </div>
  );
}

export const toInput = (rows: KvRow[]): KeyValueInput[] =>
  rows
    .filter((r) => r.key.trim())
    .map((r) => ({
      key: r.key.trim(),
      secret: !!r.secret,
      value: r.secret && r.saved && !r.value ? null : (r.value ?? ''),
    }));
