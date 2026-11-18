'use client';

import { GithubConnect } from '@/components/github/github-connect';
import { GithubIcon } from '@/components/icons';
import { PageHeader } from '@/components/shell/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function IntegrationsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-8">
      <PageHeader
        title="Integrations"
        description="Connections AgentForge uses on your behalf. Credentials are encrypted and stay on this machine."
      />
      <Card className="shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GithubIcon className="size-4" /> GitHub
          </CardTitle>
          <CardDescription>
            Create repositories, clone projects into your workspace and (later) open pull requests.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <GithubConnect />
        </CardContent>
      </Card>
    </div>
  );
}
