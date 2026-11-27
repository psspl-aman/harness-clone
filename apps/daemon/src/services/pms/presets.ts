import type { PmsProvider, PmsProviderPreset, PmsToolMap, TaskStatus } from '@ai-harness/shared';

const TODO_FLOW: Record<string, TaskStatus> = {
  'To Do': 'APPROVED',
  'In Progress': 'IN_DEVELOPMENT',
  'In Review': 'IN_REVIEW',
  Done: 'DONE',
};

/**
 * Starting points per provider. Server commands and tool names are suggestions
 * (MCP servers change quickly) — the connection dialog lists the server's
 * real tools and can auto-detect the tool map from them.
 */
export const PMS_PRESETS: PmsProviderPreset[] = [
  {
    id: 'github',
    label: 'GitHub Issues',
    projectLabel: 'Repository',
    projectPlaceholder: 'owner/repo',
    docsUrl: 'https://github.com/github/github-mcp-server',
    server: {
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: [{ key: 'Authorization', secret: true, hint: 'Bearer <personal access token>' }],
    },
    toolMap: {
      list: {
        tool: 'list_issues',
        args: { owner: '{{owner}}', repo: '{{repo}}', state: 'OPEN', labels: '{{filters.labels}}' },
      },
      get: {
        tool: 'get_issue',
        args: { owner: '{{owner}}', repo: '{{repo}}', issue_number: '{{issueId|number}}' },
      },
      updateStatus: {
        tool: 'update_issue',
        args: {
          owner: '{{owner}}',
          repo: '{{repo}}',
          issue_number: '{{issueId|number}}',
          state: '{{status}}',
        },
      },
      comment: {
        tool: 'add_issue_comment',
        args: {
          owner: '{{owner}}',
          repo: '{{repo}}',
          issue_number: '{{issueId|number}}',
          body: '{{body}}',
        },
      },
      fields: { id: 'number', status: 'state' },
    },
    defaultStatusMap: { open: 'APPROVED', OPEN: 'APPROVED', closed: 'DONE', CLOSED: 'DONE' },
  },
  {
    id: 'jira',
    label: 'Jira',
    projectLabel: 'Project key',
    projectPlaceholder: 'PROJ',
    docsUrl: 'https://github.com/sooperset/mcp-atlassian',
    server: {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-atlassian'],
      env: [
        { key: 'JIRA_URL', secret: false, hint: 'https://your-company.atlassian.net' },
        { key: 'JIRA_USERNAME', secret: false, hint: 'you@company.com' },
        { key: 'JIRA_API_TOKEN', secret: true, hint: 'Atlassian API token' },
      ],
    },
    toolMap: {
      list: {
        tool: 'jira_search',
        args: {
          jql: 'project = {{project}} AND statusCategory != Done ORDER BY updated DESC',
          limit: '{{limit|number}}',
        },
      },
      get: { tool: 'jira_get_issue', args: { issue_key: '{{issueId}}' } },
      transitions: { tool: 'jira_get_transitions', args: { issue_key: '{{issueId}}' } },
      updateStatus: {
        tool: 'jira_transition_issue',
        args: { issue_key: '{{issueId}}', transition_id: '{{transitionId}}' },
      },
      comment: {
        tool: 'jira_add_comment',
        args: { issue_key: '{{issueId}}', comment: '{{body}}' },
      },
      fields: { id: 'key', updatedAt: 'updated' },
    },
    defaultStatusMap: TODO_FLOW,
  },
  {
    id: 'linear',
    label: 'Linear',
    projectLabel: 'Team key',
    projectPlaceholder: 'ENG',
    docsUrl: 'https://linear.app/docs/mcp',
    server: {
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: [{ key: 'Authorization', secret: true, hint: 'Bearer <API key>' }],
    },
    toolMap: { fields: { id: 'identifier' } },
    defaultStatusMap: {
      Todo: 'APPROVED',
      'In Progress': 'IN_DEVELOPMENT',
      'In Review': 'IN_REVIEW',
      Done: 'DONE',
      Canceled: 'CANCELLED',
    },
  },
  {
    id: 'asana',
    label: 'Asana',
    projectLabel: 'Project id',
    projectPlaceholder: '1203456789',
    docsUrl: 'https://developers.asana.com/docs/using-asanas-mcp-server',
    server: null,
    toolMap: { fields: { id: 'gid', title: 'name', description: 'notes' } },
    defaultStatusMap: {},
  },
  {
    id: 'clickup',
    label: 'ClickUp',
    projectLabel: 'List id',
    projectPlaceholder: '901234567',
    docsUrl: null,
    server: null,
    toolMap: { fields: {} },
    defaultStatusMap: {
      'to do': 'APPROVED',
      'in progress': 'IN_DEVELOPMENT',
      review: 'IN_REVIEW',
      complete: 'DONE',
    },
  },
  {
    id: 'azure-devops',
    label: 'Azure DevOps',
    projectLabel: 'Project',
    projectPlaceholder: 'MyProject',
    docsUrl: 'https://github.com/microsoft/azure-devops-mcp',
    server: null,
    toolMap: { fields: { title: 'fields.System.Title', status: 'fields.System.State' } },
    defaultStatusMap: {
      New: 'APPROVED',
      Active: 'IN_DEVELOPMENT',
      Resolved: 'IN_REVIEW',
      Closed: 'DONE',
    },
  },
  {
    id: 'trello',
    label: 'Trello',
    projectLabel: 'Board id',
    projectPlaceholder: '5f1a…',
    docsUrl: null,
    server: null,
    toolMap: { fields: { status: 'list.name' } },
    defaultStatusMap: { 'To Do': 'APPROVED', Doing: 'IN_DEVELOPMENT', Done: 'DONE' },
  },
  {
    id: 'custom',
    label: 'Other (custom MCP server)',
    projectLabel: 'Project',
    projectPlaceholder: 'project id or key',
    docsUrl: null,
    server: null,
    toolMap: { fields: {} },
    defaultStatusMap: TODO_FLOW,
  },
];

export const presetFor = (id: string) =>
  PMS_PRESETS.find((p) => p.id === id) ?? PMS_PRESETS.at(-1)!;

/**
 * A complete tool map for one specific MCP server, recognised by a tool only
 * that server has. Used by auto-detect so users don't write templates by hand.
 */
export interface ServerToolMap {
  provider: PmsProvider;
  /** A tool name unique to this server. */
  marker: string;
  toolMap: PmsToolMap;
  /**
   * Fill `{{cloudId}}` with the user's Atlassian site, looked up with this
   * tool (it takes no arguments) when the tool map is detected.
   */
  siteLookupTool?: string;
}

const CLOUD_ID = '{{cloudId}}';
const ATLASSIAN_ISSUE = { cloudId: CLOUD_ID, issueIdOrKey: '{{issueId}}' };

export const SERVER_TOOL_MAPS: ServerToolMap[] = [
  {
    // Atlassian's hosted Rovo MCP server (https://mcp.atlassian.com/v2/mcp).
    provider: 'jira',
    marker: 'searchJiraIssuesUsingJql',
    siteLookupTool: 'getAccessibleAtlassianResources',
    toolMap: {
      list: {
        tool: 'searchJiraIssuesUsingJql',
        args: {
          cloudId: CLOUD_ID,
          jql: 'project = {{project}} AND statusCategory != Done ORDER BY updated DESC',
          maxResults: '{{limit|number}}',
          responseContentFormat: 'markdown',
        },
      },
      get: {
        tool: 'getJiraIssue',
        args: { ...ATLASSIAN_ISSUE, responseContentFormat: 'markdown' },
      },
      transitions: { tool: 'getTransitionsForJiraIssue', args: ATLASSIAN_ISSUE },
      updateStatus: {
        tool: 'transitionJiraIssue',
        args: { ...ATLASSIAN_ISSUE, transition: { id: '{{transitionId}}' } },
      },
      comment: {
        tool: 'addCommentToJiraIssue',
        args: { ...ATLASSIAN_ISSUE, commentBody: '{{body}}', contentFormat: 'markdown' },
      },
      fields: { id: 'key' },
    },
  },
];
