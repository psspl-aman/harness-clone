'use client';

import type { GitBranchDto, GitOverviewDto } from '@ai-harness/shared';
import { GitPullRequest, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { errMsg, isUnmerged, useGitAction } from './use-git';

const locals = (o: GitOverviewDto) => o.branches.filter((b) => b.kind === 'local');

function BranchSelect({
  id,
  label,
  value,
  onChange,
  branches,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  branches: GitBranchDto[];
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full font-mono text-xs" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {branches.map((b) => (
            <SelectItem key={b.name} value={b.name} className="font-mono text-xs">
              {b.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function NewBranchDialog({
  overview,
  from,
  open,
  onOpenChange,
  onCreated,
}: {
  overview: GitOverviewDto;
  from?: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated?: (name: string) => void;
}) {
  const action = useGitAction(overview.projectId);
  const options = overview.branches.filter((b) => b.kind === 'local' || !b.hasLocal);
  const [name, setName] = useState('');
  const [base, setBase] = useState(
    from ?? overview.workingBranch ?? overview.current ?? options[0]?.name ?? '',
  );
  const [checkout, setCheckout] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    action.mutate(
      {
        quiet: true,
        run: () =>
          api.git.createBranch(overview.projectId, { name: name.trim(), from: base, checkout }),
      },
      {
        onSuccess: () => {
          onCreated?.(name.trim());
          onOpenChange(false);
          setName('');
        },
        onError: (e) => setError(errMsg(e)),
      },
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New branch</DialogTitle>
          <DialogDescription>Start a branch for your own work or an experiment.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="git-branch-name">Branch name</Label>
            <Input
              id="git-branch-name"
              autoFocus
              placeholder="feature/checkout-page"
              className="font-mono"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
          </div>
          <BranchSelect
            id="git-branch-from"
            label="Start from"
            value={base}
            onChange={setBase}
            branches={options}
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={checkout} onCheckedChange={(v) => setCheckout(v === true)} />
            Switch the project folder to it
          </label>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || action.isPending}>
              {action.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Create branch
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteBranchDialog({
  projectId,
  branch,
  onOpenChange,
  onDeleted,
}: {
  projectId: string;
  branch: GitBranchDto | null;
  onOpenChange: (o: boolean) => void;
  onDeleted?: () => void;
}) {
  const action = useGitAction(projectId);
  const [unmerged, setUnmerged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = (o: boolean) => {
    if (!o) {
      setUnmerged(false);
      setError(null);
    }
    onOpenChange(o);
  };
  const run = (force: boolean) =>
    branch &&
    action.mutate(
      { quiet: true, run: () => api.git.deleteBranch(projectId, { name: branch.name, force }) },
      {
        onSuccess: () => {
          onDeleted?.();
          close(false);
        },
        onError: (e) => (isUnmerged(e) ? setUnmerged(true) : setError(errMsg(e))),
      },
    );
  return (
    <Dialog open={!!branch} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {branch?.name}?</DialogTitle>
          <DialogDescription>
            {unmerged
              ? 'This branch has commits that aren’t merged anywhere. Deleting it throws that work away.'
              : 'The branch is removed from this repository. Remote copies are kept.'}
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => run(unmerged)} disabled={action.isPending}>
            {action.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {unmerged ? 'Delete anyway' : 'Delete branch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PullRequestDialog({
  overview,
  branch,
  onOpenChange,
}: {
  overview: GitOverviewDto;
  branch: GitBranchDto | null;
  onOpenChange: (o: boolean) => void;
}) {
  const action = useGitAction(overview.projectId);
  const task = branch?.tasks[0];
  const [title, setTitle] = useState('');
  const [base, setBase] = useState(overview.workingBranch ?? '');
  const [error, setError] = useState<string | null>(null);
  const targets = locals(overview).filter((b) => b.name !== branch?.name);
  return (
    <Dialog
      open={!!branch}
      onOpenChange={(o) => {
        if (!o) {
          setTitle('');
          setError(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Open a pull request</DialogTitle>
          <DialogDescription>
            Pushes <span className="font-mono">{branch?.name}</span> to GitHub (
            {overview.githubRepo}) and opens a pull request.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!branch) return;
            action.mutate(
              {
                quiet: true,
                run: () =>
                  api.git.pullRequest(overview.projectId, {
                    branch: branch.name,
                    base,
                    ...(title.trim() ? { title: title.trim() } : {}),
                  }),
              },
              { onSuccess: () => onOpenChange(false), onError: (er) => setError(errMsg(er)) },
            );
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="git-pr-title">Title</Label>
            <Input
              id="git-pr-title"
              placeholder={task ? `${task.key}: ${task.title}` : branch?.subject}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <BranchSelect
            id="git-pr-base"
            label="Merge into"
            value={base}
            onChange={setBase}
            branches={targets}
          />
          {error && <p className="text-destructive text-sm">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!base || action.isPending}>
              {action.isPending ? <Loader2 className="animate-spin" /> : <GitPullRequest />}
              Open pull request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
