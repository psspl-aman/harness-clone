import { isAbsolute, relative, resolve } from 'node:path';

export type GuardLevel = 'allow' | 'confirm' | 'deny';
export interface GuardVerdict {
  level: GuardLevel;
  reason: string;
  /** Human-readable summary of what the agent wants to do. */
  summary: string;
}

const SECRET_PATH =
  /(^|[\s/'"=])(\.env(\.[\w.-]+)?|[\w.-]*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|ed25519|ecdsa|dsa)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(\.json)?|\.aws\/credentials|\.ssh\/[\w.-]+|secrets?\.(json|ya?ml|toml))(?=$|[\s'";|&)])/i;
const SAFE_ENV_TEMPLATE = /\.env\.(example|sample|template|dist)\b/gi;

const within = (root: string, p: string) => {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const r = relative(root, abs);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, process.env.HOME ?? '/home');

const allow = (summary: string): GuardVerdict => ({ level: 'allow', reason: '', summary });

function mentionsSecretFile(text: string): boolean {
  const cleaned = text.replace(SAFE_ENV_TEMPLATE, '');
  return SECRET_PATH.test(cleaned);
}

/** Classify a shell command an agent wants to run inside `root`. */
export function classifyCommand(command: string, root: string): GuardVerdict {
  const cmd = command.trim();
  const summary = cmd.length > 300 ? `${cmd.slice(0, 300)}…` : cmd;
  const deny = (reason: string): GuardVerdict => ({ level: 'deny', reason, summary });
  const confirm = (reason: string): GuardVerdict => ({ level: 'confirm', reason, summary });

  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(cmd)) return deny('Fork bomb');
  if (/\bmkfs(\.\w+)?\b|\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/.test(cmd))
    return deny('Writes to a disk device');
  if (/\b(shutdown|reboot|halt|poweroff)\b/.test(cmd)) return deny('Shuts down the machine');

  // rm -r / -f with dangerous targets.
  for (const m of cmd.matchAll(/\brm\s+((?:-[a-zA-Z]+\s+|--[a-z-]+\s+)*)([^;&|\n]+)/g)) {
    const flags = m[1] ?? '';
    const recursive = /-[a-zA-Z]*[rR]|--recursive/.test(flags);
    const targets = (m[2] ?? '')
      .trim()
      .split(/\s+/)
      .filter((t) => t && !t.startsWith('-'));
    for (const t of targets) {
      const p = expandHome(t.replace(/^["']|["']$/g, ''));
      if (
        recursive &&
        (p === '/' ||
          p === '/*' ||
          p === '~' ||
          p === process.env.HOME ||
          /^\$\{?HOME\}?\/?\*?$/.test(t) ||
          p === '..' ||
          p.startsWith('../') ||
          p === '.' ||
          p === './' ||
          p === '*')
      )
        return p === '.' || p === './' || p === '*'
          ? confirm('Deletes everything in the project folder')
          : deny('Recursive delete outside the project');
      if (isAbsolute(p) && !within(root, p))
        return recursive
          ? deny('Recursive delete outside the project')
          : confirm('Deletes a file outside the project');
      if (p.startsWith('..') && !within(root, p))
        return confirm('Deletes a file outside the project');
    }
  }

  if (/\bsudo\b|\bdoas\b/.test(cmd)) return confirm('Runs a command as administrator');
  if (/\bgit\s+push\b/.test(cmd))
    return confirm(
      /\s(-f|--force|--force-with-lease)\b|\s\+\S/.test(cmd)
        ? 'Force-pushes to a remote'
        : 'Pushes to a remote (AgentForge merges for you)',
    );
  if (
    /\bgit\s+(-C\s+\S+\s+)?(checkout|switch)\s+(main|master)\b|\bgit\s+branch\s+-[dD]\s+(main|master)\b/.test(
      cmd,
    )
  )
    return confirm('Touches the main branch from a task worktree');
  if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(cmd))
    return confirm('Pipes a download into a shell');
  if (/\bchmod\s+(-R\s+)?[0-7]*7{2,}\s+\//.test(cmd) || /\bchown\s+-R\s+\S+\s+\//.test(cmd))
    return confirm('Changes permissions outside the project');
  if (
    /(^|[;&|(]\s*)(printenv|env)\s*($|[|;&>)])/.test(cmd) ||
    /\bcat\s+\/proc\/\d+\/environ/.test(cmd)
  )
    return confirm('Prints environment variables (may contain secrets)');
  if (mentionsSecretFile(cmd)) return confirm('Reads or writes a file that may contain secrets');

  // Writes via redirection / tee / cp / mv to absolute paths outside the project.
  for (const m of cmd.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?)\s*(["']?)(\/[^\s"';|&]+)\1/g)) {
    const p = m[2]!;
    if (!within(root, p) && !/^\/dev\/(null|stdout|stderr|tty)$/.test(p) && !p.startsWith('/tmp/'))
      return confirm(`Writes outside the project (${p})`);
  }
  for (const m of cmd.matchAll(
    /\b(?:cp|mv|install|ln)\s+(?:-\S+\s+)*\S+\s+(["']?)(\/[^\s"';|&]+)\1/g,
  )) {
    const p = m[2]!;
    if (!within(root, p) && !p.startsWith('/tmp/'))
      return confirm(`Writes outside the project (${p})`);
  }
  return allow(summary);
}

/** Classify any tool call (Claude Code tool names; others are passed through). */
export function classifyTool(
  tool: string,
  input: Record<string, unknown>,
  root: string,
): GuardVerdict {
  const path = String(input.file_path ?? input.path ?? input.notebook_path ?? '');
  switch (tool) {
    case 'Bash':
      return classifyCommand(String(input.command ?? ''), root);
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const summary = `${tool} ${path}`;
      if (path && !within(root, expandHome(path)))
        return { level: 'deny', reason: 'Agents may only write inside the project', summary };
      if (mentionsSecretFile(` ${path}`))
        return { level: 'confirm', reason: 'Writes a file that may contain secrets', summary };
      return allow(summary);
    }
    case 'Read':
    case 'Grep':
    case 'Glob': {
      const summary = `${tool} ${path || String(input.pattern ?? '')}`;
      if (path && mentionsSecretFile(` ${path}`))
        return { level: 'confirm', reason: 'Reads a file that may contain secrets', summary };
      if (
        path &&
        !within(root, expandHome(path)) &&
        /^(~|\/(root|home\/[^/]+\/\.(ssh|aws|gnupg|config)))/.test(path)
      )
        return { level: 'confirm', reason: 'Reads private files outside the project', summary };
      return allow(summary);
    }
    default:
      return allow(tool);
  }
}
