'use client';

import type { ReactNode } from 'react';
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
