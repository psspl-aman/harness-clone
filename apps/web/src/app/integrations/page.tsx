'use client';

import { GithubConnect } from '@/components/github/github-connect';
import { GithubIcon } from '@/components/icons';
import { McpServersSection } from '@/components/integrations/mcp-servers';
import { PmsConnectionsSection } from '@/components/integrations/pms-connections';
import { SheetSourcesSection } from '@/components/integrations/sheet-sources';
import { PageHeader } from '@/components/shell/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FileSpreadsheet, SquareKanban, Server } from 'lucide-react';

export default function IntegrationsPage() {
  return (
    <div className="portal-content max-w-3xl py-8">
      <PageHeader
        title="Integrations"
        description="Connections AgentForge uses on your behalf. Credentials are encrypted and stay on this machine."
      />
      <div className="space-y-6">
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SquareKanban className="size-4" /> Issue trackers
            </CardTitle>
            <CardDescription>
              Import tickets from Jira, Linear, GitHub Issues, Asana, ClickUp, Azure DevOps, Trello
              or any tracker with an MCP server, and sync status and comments back. Link a tracker
              to a project from the project’s Overview.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PmsConnectionsSection />
          </CardContent>
        </Card>
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="size-4" /> Spreadsheets
            </CardTitle>
            <CardDescription>
              Keep your task list in Google Sheets or Excel: each row becomes a task with its
              priority, and new rows are picked up automatically — agents start on them, highest
              priority first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SheetSourcesSection />
          </CardContent>
        </Card>
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="size-4" /> MCP servers
            </CardTitle>
            <CardDescription>
              Local (stdio) or remote (HTTP/SSE) Model Context Protocol servers. Test a connection
              to see its tools.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <McpServersSection />
          </CardContent>
        </Card>
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <GithubIcon className="size-4" /> GitHub
            </CardTitle>
            <CardDescription>
              Create repositories, clone projects into your workspace and (later) open pull
              requests.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <GithubConnect />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
