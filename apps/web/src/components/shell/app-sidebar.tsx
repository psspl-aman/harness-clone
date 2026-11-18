'use client';

import { PanelLeftClose, PanelLeftOpen, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useUi } from '@/lib/stores';
import { cn } from '@/lib/utils';
import { ConnectionStatus } from './connection-status';
import { isActivePath, NAV_ITEMS } from './nav';

export function AppSidebar() {
  const pathname = usePathname();
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggle = useUi((s) => s.toggleSidebar);

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 64 : 232 }}
      transition={{ type: 'spring', stiffness: 400, damping: 40 }}
      className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden shrink-0 flex-col border-r md:flex"
    >
      <div
        className={cn('flex h-14 items-center gap-2.5 px-4', collapsed && 'justify-center px-0')}
      >
        <div className="from-primary to-chart-2 text-primary-foreground grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br shadow-sm">
          <Sparkles className="size-4" />
        </div>
        {!collapsed && <span className="text-[15px] font-semibold tracking-tight">AgentForge</span>}
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-2 py-2" aria-label="Main">
        {NAV_ITEMS.map((item) => {
          const active = isActivePath(pathname, item.href);
          const link = (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex h-9 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
                'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                active && 'bg-sidebar-accent text-sidebar-accent-foreground',
                collapsed && 'justify-center px-0',
              )}
            >
              {active && (
                <motion.span
                  layoutId="nav-active"
                  className="bg-primary absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full"
                />
              )}
              <item.icon className="size-4 shrink-0" />
              {!collapsed && item.label}
            </Link>
          );
          return collapsed ? (
            <Tooltip key={item.href}>
              <TooltipTrigger asChild>{link}</TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          ) : (
            link
          );
        })}
      </nav>

      <div
        className={cn('flex items-center gap-2 p-3', collapsed ? 'flex-col' : 'justify-between')}
      >
        <ConnectionStatus compact={collapsed} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={toggle}
              aria-label="Toggle sidebar"
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4" />
              ) : (
                <PanelLeftClose className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Toggle sidebar (⌘B)</TooltipContent>
        </Tooltip>
      </div>
    </motion.aside>
  );
}
