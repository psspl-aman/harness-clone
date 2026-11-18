'use client';

import type { PlanDto, TaskDto, UpdatePlanInput } from '@agentforge/shared';
import { Plus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

function Shell({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InstructionsDialog(props: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  placeholder: string;
  confirm: string;
  onSubmit: (instructions: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <Shell
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.title}
      description={props.description}
      footer={
        <>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              props.onSubmit(text.trim());
              props.onOpenChange(false);
            }}
          >
            {props.confirm}
          </Button>
        </>
      }
    >
      <Textarea
        autoFocus
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={props.placeholder}
        aria-label="Instructions"
      />
    </Shell>
  );
}

export function SplitDialog({
  task,
  open,
  onOpenChange,
  onSubmit,
}: {
  task: TaskDto;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (parts: { title: string }[]) => void;
}) {
  const [parts, setParts] = useState([`${task.title} (part 1)`, `${task.title} (part 2)`]);
  const valid = parts.filter((p) => p.trim()).length >= 2;
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title={`Split ${task.key}`}
      description="The first part keeps this task; the others become new tasks with the same dependencies. Tasks that depended on it will wait for every part."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              onSubmit(parts.filter((p) => p.trim()).map((title) => ({ title: title.trim() })));
              onOpenChange(false);
            }}
          >
            Split into {parts.filter((p) => p.trim()).length}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {parts.map((p, i) => (
          <div key={i} className="flex gap-2">
            <Input
              value={p}
              aria-label={`Part ${i + 1} title`}
              onChange={(e) => setParts(parts.map((x, j) => (j === i ? e.target.value : x)))}
            />
            {parts.length > 2 && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove part ${i + 1}`}
                onClick={() => setParts(parts.filter((_, j) => j !== i))}
              >
                <X />
              </Button>
            )}
          </div>
        ))}
        {parts.length < 8 && (
          <Button variant="outline" size="sm" onClick={() => setParts([...parts, ''])}>
            <Plus /> Add part
          </Button>
        )}
      </div>
    </Shell>
  );
}

export function AddTaskDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (v: { title: string; description: string }) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title="Add a task"
      description="Added as a draft to the current plan. Open it afterwards to set criteria and dependencies."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!title.trim()}
            onClick={() => {
              onSubmit({ title: title.trim(), description: description.trim() });
              onOpenChange(false);
            }}
          >
            Add task
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="new-title">Title</Label>
          <Input
            id="new-title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-desc">Description</Label>
          <Textarea
            id="new-desc"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
    </Shell>
  );
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

export function EditPlanDialog({
  plan,
  open,
  onOpenChange,
  onSubmit,
}: {
  plan: PlanDto;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (v: UpdatePlanInput) => void;
}) {
  const [v, setV] = useState({
    goal: plan.goal,
    scope: plan.scope,
    outOfScope: plan.outOfScope,
    architectureNotes: plan.architectureNotes,
    risks: plan.risks.join('\n'),
    assumptions: plan.assumptions.join('\n'),
  });
  const field = (key: keyof typeof v, label: string, rows: number, hint?: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`plan-${key}`}>{label}</Label>
      <Textarea
        id={`plan-${key}`}
        rows={rows}
        value={v[key]}
        onChange={(e) => setV({ ...v, [key]: e.target.value })}
      />
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit plan v${plan.version}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!v.goal.trim()}
            onClick={() => {
              onSubmit({
                goal: v.goal.trim(),
                scope: v.scope,
                outOfScope: v.outOfScope,
                architectureNotes: v.architectureNotes,
                risks: lines(v.risks),
                assumptions: lines(v.assumptions),
              });
              onOpenChange(false);
            }}
          >
            Save plan
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {field('goal', 'Goal', 2)}
        {field('scope', 'Scope', 3)}
        {field('outOfScope', 'Out of scope', 2)}
        {field('architectureNotes', 'Architecture notes', 4)}
        {field('risks', 'Risks', 3, 'One per line')}
        {field('assumptions', 'Assumptions', 3, 'One per line')}
      </div>
    </Shell>
  );
}
