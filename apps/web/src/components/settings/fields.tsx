'use client';

import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import { EngineSelectItems, useUnusableEngine } from '@/components/engines/engine-select-items';
import { api, qk } from '@/lib/api';

function Row({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function NumberField(props: {
  id: string;
  label: string;
  hint?: ReactNode;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  const invalid =
    !Number.isInteger(props.value) || props.value < props.min || props.value > props.max;
  return (
    <Row id={props.id} label={props.label} hint={props.hint}>
      <div className="flex items-center gap-2">
        <Input
          id={props.id}
          type="number"
          inputMode="numeric"
          min={props.min}
          max={props.max}
          value={Number.isNaN(props.value) ? '' : props.value}
          aria-invalid={invalid}
          onChange={(e) => props.onChange(e.target.value === '' ? NaN : Number(e.target.value))}
          className="h-8 w-24 text-right tabular-nums"
        />
        {props.suffix && <span className="text-muted-foreground w-10 text-xs">{props.suffix}</span>}
      </div>
    </Row>
  );
}

export function SwitchField(props: {
  id: string;
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row id={props.id} label={props.label} hint={props.hint}>
      <Switch id={props.id} checked={props.checked} onCheckedChange={props.onChange} />
    </Row>
  );
}

export function SelectField<T extends string>(props: {
  id: string;
  label: string;
  hint?: ReactNode;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Row id={props.id} label={props.label} hint={props.hint}>
      <Select value={props.value} onValueChange={(v) => props.onChange(v as T)}>
        <SelectTrigger id={props.id} size="sm" className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  );
}

export function TextField(props: {
  id: string;
  label: string;
  hint?: ReactNode;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <Row id={props.id} label={props.label} hint={props.hint}>
      <Input
        id={props.id}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        className="h-8 w-72 font-mono text-xs"
      />
    </Row>
  );
}

/** Engine picker backed by the live engine list (custom engines + status included). */
export function EngineField(props: {
  id: string;
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (v: string) => void;
}) {
  const unusable = useUnusableEngine(props.value);
  return (
    <Row
      id={props.id}
      label={props.label}
      hint={
        unusable ? (
          <span className="text-destructive">
            {unusable} isn’t installed — pick an installed engine.
          </span>
        ) : (
          props.hint
        )
      }
    >
      <Select value={props.value} onValueChange={props.onChange}>
        <SelectTrigger
          id={props.id}
          size="sm"
          className={unusable ? 'border-destructive w-52' : 'w-52'}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <EngineSelectItems extra={props.value} />
        </SelectContent>
      </Select>
    </Row>
  );
}

const MODEL_DEFAULT = '__default';

/** Model picker populated from `engineId`'s model list; "Engine default" uses the engine's own default. */
export function ModelField(props: {
  id: string;
  label: string;
  hint?: ReactNode;
  engineId: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  const engines = useQuery({ queryKey: qk.engines, queryFn: api.engines.list });
  const list = engines.data?.find((e) => e.id === props.engineId)?.models ?? [];
  const stale = !!props.value && !list.some((m) => m.id === props.value);
  return (
    <Row id={props.id} label={props.label} hint={props.hint}>
      <Select
        value={props.value ?? MODEL_DEFAULT}
        onValueChange={(v) => props.onChange(v === MODEL_DEFAULT ? undefined : v)}
        disabled={list.length === 0 && !props.value}
      >
        <SelectTrigger id={props.id} size="sm" className="w-52">
          <SelectValue placeholder="Engine default" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={MODEL_DEFAULT}>Engine default</SelectItem>
          {stale && (
            <SelectItem value={props.value!} disabled>
              {props.value}
              <span className="text-muted-foreground text-xs">· unavailable</span>
            </SelectItem>
          )}
          {list.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  );
}
