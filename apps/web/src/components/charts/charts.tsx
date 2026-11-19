'use client';

import { AlertTriangle, CheckCircle2, OctagonAlert } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface Point {
  key: string;
  label: string;
  value: number;
  detail?: string;
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!;
};

/**
 * Single-series column chart (one hue, so no legend). Thin columns with a 4px
 * rounded data-end anchored to the baseline, 2px gaps, recessive grid, and a
 * hover tooltip on a hit area taller than the mark.
 */
export function ColumnChart({
  points,
  format,
  title,
  height = 180,
}: {
  points: Point[];
  format: (v: number) => string;
  title: string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const ticks = [max, max / 2, 0];
  if (!points.length)
    return (
      <p className="text-muted-foreground py-10 text-center text-sm">No usage in this period.</p>
    );
  return (
    <figure className="space-y-2" aria-label={title}>
      <div className="flex justify-end">
        <button
          className="text-muted-foreground hover:text-foreground text-xs"
          onClick={() => setTable((t) => !t)}
          aria-pressed={table}
        >
          {table ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {table ? (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 text-left font-medium">Period</th>
              <th className="py-1 text-right font-medium">{title}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.key} className="border-t">
                <td className="py-1">{p.label}</td>
                <td className="py-1 text-right tabular-nums">{format(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="flex gap-2">
          <div
            className="text-muted-foreground flex flex-col justify-between pb-5 text-right text-[10px] tabular-nums"
            style={{ height }}
          >
            {ticks.map((t) => (
              <span key={t}>{format(t)}</span>
            ))}
          </div>
          <div className="relative min-w-0 flex-1">
            <div
              className="absolute inset-x-0 top-0 flex flex-col justify-between"
              style={{ height: height - 20 }}
              aria-hidden
            >
              {ticks.map((t) => (
                <div key={t} className="border-viz-grid border-t" />
              ))}
            </div>
            <div
              className="relative flex items-end gap-[2px]"
              style={{ height: height - 20 }}
              role="list"
            >
              {points.map((p, i) => (
                <div
                  key={p.key}
                  role="listitem"
                  aria-label={`${p.label}: ${format(p.value)}`}
                  className="relative flex h-full min-w-0 flex-1 cursor-default items-end justify-center"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div
                    className={cn(
                      'bg-viz-1 w-full max-w-7 rounded-t-[4px] transition-opacity',
                      hover !== null && hover !== i && 'opacity-50',
                    )}
                    style={{ height: `${Math.max(p.value > 0 ? 2 : 0, (p.value / max) * 100)}%` }}
                  />
                  {hover === i && (
                    <div className="bg-popover text-popover-foreground pointer-events-none absolute bottom-full z-10 mb-1 rounded-md border px-2 py-1 text-xs whitespace-nowrap shadow-md">
                      <p className="font-medium">{p.label}</p>
                      <p className="tabular-nums">{format(p.value)}</p>
                      {p.detail && <p className="text-muted-foreground">{p.detail}</p>}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="text-muted-foreground mt-1 flex justify-between text-[10px]">
              <span>{points[0]!.label}</span>
              {points.length > 1 && <span>{points.at(-1)!.label}</span>}
            </div>
          </div>
        </div>
      )}
    </figure>
  );
}

/**
 * Single-series line chart for a measure over time (one hue, no legend): 2px
 * line, recessive grid, crosshair + tooltip on hover with an 8px marker, and a
 * table view. Each point's hit area is the full column under it.
 */
export function LineChart({
  points,
  format,
  title,
  height = 180,
}: {
  points: Point[];
  format: (v: number) => string;
  title: string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const ticks = [max, max / 2, 0];
  if (!points.length)
    return (
      <p className="text-muted-foreground py-10 text-center text-sm">No usage in this period.</p>
    );
  const plot = height - 20;
  // x at the centre of each point's column, in percent of the width.
  const x = (i: number) => ((i + 0.5) / points.length) * 100;
  const y = (v: number) => 100 - (v / max) * 100;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join(' ');
  const h = hover === null ? null : points[hover]!;
  return (
    <figure className="space-y-2" aria-label={title}>
      <div className="flex justify-end">
        <button
          className="text-muted-foreground hover:text-foreground text-xs"
          onClick={() => setTable((t) => !t)}
          aria-pressed={table}
        >
          {table ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {table ? (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 text-left font-medium">Period</th>
              <th className="py-1 text-right font-medium">{title}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.key} className="border-t">
                <td className="py-1">{p.label}</td>
                <td className="py-1 text-right tabular-nums">{format(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="flex gap-2">
          <div
            className="text-muted-foreground flex flex-col justify-between pb-5 text-right text-[10px] tabular-nums"
            style={{ height }}
          >
            {ticks.map((t) => (
              <span key={t}>{format(t)}</span>
            ))}
          </div>
          <div className="relative min-w-0 flex-1">
            <div className="relative" style={{ height: plot }}>
              <div className="absolute inset-0 flex flex-col justify-between" aria-hidden>
                {ticks.map((t) => (
                  <div key={t} className="border-viz-grid border-t" />
                ))}
              </div>
              <svg
                className="absolute inset-0 h-full w-full overflow-visible"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden
              >
                <path
                  d={path}
                  fill="none"
                  stroke="var(--viz-1)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              {h && (
                <>
                  <div
                    className="bg-foreground/25 pointer-events-none absolute inset-y-0 w-px"
                    style={{ left: `${x(hover!)}%` }}
                    aria-hidden
                  />
                  <div
                    className="bg-viz-1 ring-background pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2"
                    style={{ left: `${x(hover!)}%`, top: `${y(h.value)}%` }}
                    aria-hidden
                  />
                  <div
                    className={cn(
                      'bg-popover text-popover-foreground pointer-events-none absolute top-0 z-10 rounded-md border px-2 py-1 text-xs whitespace-nowrap shadow-md',
                      hover! > points.length / 2 ? '-translate-x-full -ml-2' : 'ml-2',
                    )}
                    style={{ left: `${x(hover!)}%` }}
                  >
                    <p className="font-medium">{h.label}</p>
                    <p className="tabular-nums">{format(h.value)}</p>
                    {h.detail && <p className="text-muted-foreground">{h.detail}</p>}
                  </div>
                </>
              )}
              <div className="absolute inset-0 flex" role="list">
                {points.map((p, i) => (
                  <div
                    key={p.key}
                    role="listitem"
                    aria-label={`${p.label}: ${format(p.value)}`}
                    className="h-full min-w-0 flex-1 cursor-default"
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                  />
                ))}
              </div>
            </div>
            <div className="text-muted-foreground mt-1 flex justify-between text-[10px]">
              <span>{points[0]!.label}</span>
              {points.length > 1 && <span>{points.at(-1)!.label}</span>}
            </div>
          </div>
        </div>
      )}
    </figure>
  );
}

/** Horizontal bars with direct name + value labels (single hue, sorted by the caller). */
export function BarList({
  items,
  format,
  empty = 'No data',
}: {
  items: Point[];
  format: (v: number) => string;
  empty?: string;
}) {
  const max = Math.max(0, ...items.map((i) => i.value)) || 1;
  if (!items.length) return <p className="text-muted-foreground text-sm">{empty}</p>;
  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <li key={it.key} className="group space-y-1" title={it.detail}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate">{it.label}</span>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {format(it.value)}
              {it.detail && <span className="ml-1.5 hidden group-hover:inline">· {it.detail}</span>}
            </span>
          </div>
          <div className="bg-muted h-2 overflow-hidden rounded-[4px]">
            <div
              className="bg-viz-1 h-full rounded-[4px]"
              style={{ width: `${(it.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Usage meter: status color + icon + label, never color alone. */
export function Meter({
  label,
  used,
  limit,
  caption,
}: {
  label: string;
  used: number;
  limit: number;
  caption?: string;
}) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const level = pct >= 90 ? 'critical' : pct >= 70 ? 'warning' : 'good';
  const Icon =
    level === 'critical' ? OctagonAlert : level === 'warning' ? AlertTriangle : CheckCircle2;
  const word =
    level === 'critical'
      ? 'Nearly exhausted'
      : level === 'warning'
        ? 'Getting close'
        : 'Plenty left';
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground flex items-center gap-1 tabular-nums">
          <Icon
            className={cn(
              'size-3.5',
              level === 'critical'
                ? 'text-viz-critical'
                : level === 'warning'
                  ? 'text-viz-warning'
                  : 'text-viz-good',
            )}
            aria-hidden
          />
          {pct}% · {word}
        </span>
      </div>
      <div
        className="bg-muted h-2 overflow-hidden rounded-[4px]"
        role="meter"
        aria-label={label}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${pct}% used, ${word}`}
      >
        <div
          className={cn(
            'h-full rounded-[4px]',
            level === 'critical'
              ? 'bg-viz-critical'
              : level === 'warning'
                ? 'bg-viz-warning'
                : 'bg-viz-good',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {caption && <p className="text-muted-foreground text-[11px]">{caption}</p>}
    </div>
  );
}
