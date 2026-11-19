'use client';

import type { ReactNode } from 'react';
import { AppSidebar } from './app-sidebar';
import { CommandPalette } from './command-palette';
import { DaemonBanner } from './daemon-banner';
import { EngineBanner } from './engine-banner';
import { SafetyApprovals } from './safety-approvals';
import { Topbar } from './topbar';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh overflow-hidden">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <DaemonBanner />
        <EngineBanner />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
      <CommandPalette />
      <SafetyApprovals />
    </div>
  );
}
