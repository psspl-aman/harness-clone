'use client';

import type { AppSettings } from '@ai-harness/shared';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Pricing = AppSettings['pricing'];
const FIELDS = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['cacheRead', 'Cache read'],
  ['cacheWrite', 'Cache write'],
] as const;

/** Price table (USD per 1M tokens) for engines that don't report cost themselves. */
export function PricingEditor({
  value,
  onChange,
}: {
  value: Pricing;
  onChange: (v: Pricing) => void;
}) {
  const [key, setKey] = useState('');
  const rows = Object.entries(value);
  const set = (k: string, field: (typeof FIELDS)[number][0], n: number) =>
    onChange({ ...value, [k]: { ...value[k]!, [field]: n } });
  return (
    <div className="space-y-3 py-2">
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-xs">
              <tr>
                <th className="pb-1 text-left font-medium">Model or engine id</th>
                {FIELDS.map(([, l]) => (
                  <th key={l} className="pb-1 text-right font-medium">
                    {l}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(([k, p]) => (
                <tr key={k}>
                  <td className="py-1 pr-2 font-mono text-xs">{k}</td>
                  {FIELDS.map(([f, l]) => (
                    <td key={f} className="py-1 pl-1">
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        aria-label={`${k} ${l} price`}
                        value={p[f] ?? 0}
                        onChange={(e) => set(k, f, Number(e.target.value) || 0)}
                        className="h-8 w-24 text-right tabular-nums"
                      />
                    </td>
                  ))}
                  <td className="py-1 pl-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      aria-label={`Remove ${k}`}
                      onClick={() => {
                        const next = { ...value };
                        delete next[k];
                        onChange(next);
                      }}
                    >
                      <X />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const k = key.trim();
          if (k && !value[k]) {
            onChange({ ...value, [k]: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
            setKey('');
          }
        }}
      >
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="e.g. gpt-5-codex or codex"
          aria-label="New model or engine id"
          className="h-8 max-w-64 font-mono text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          type="submit"
          disabled={!key.trim() || !!value[key.trim()]}
        >
          <Plus /> Add price
        </Button>
      </form>
      <p className="text-muted-foreground text-xs">
        USD per 1M tokens. Used only when a CLI doesn’t report cost itself (Claude Code does).
        Without a matching entry, cost is estimated from built-in list prices for common Claude,
        GPT/Codex and Gemini models and shown as “est.”; your prices here take precedence.
      </p>
    </div>
  );
}
