/**
 * Cross-platform helpers for locating and spawning CLIs.
 *
 * The daemon was first written for POSIX, where a CLI on the PATH is an
 * executable file you can hand straight to `spawn`. On Windows the same CLI is
 * usually a `.cmd`/`.bat` shim (npm) that the OS cannot launch directly — doing
 * so raises "error code 193" (ERROR_BAD_EXE_FORMAT). These helpers centralise
 * the Windows handling so the rest of the code stays platform-agnostic; on
 * POSIX every one of them is a transparent pass-through.
 *
 * Each helper takes the platform and environment as arguments (defaulting to
 * the live process) so the behaviour is pure and testable on any host.
 */

import { existsSync } from 'node:fs';

type Env = Record<string, string | undefined>;

export const isWindows = process.platform === 'win32';

/**
 * Path to a Git Bash `bash.exe` on Windows, for `CLAUDE_CODE_GIT_BASH_PATH`.
 *
 * Claude Code runs its PreToolUse hooks (including AI Harness's own safety
 * guard) and its Bash tool through Git Bash on Windows. When it can't locate
 * Git Bash it reports "Git Bash wasn't found" and fails every tool call, so an
 * agent can read/think but never write a file. Pointing it at a detected
 * bash.exe fixes this. Returns undefined on POSIX (bash is native) or when no
 * Git install can be found. Pure given `exists`, so it is testable on any host.
 */
export function gitBashPath(
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  if (platform !== 'win32') return undefined;
  const preset = env.CLAUDE_CODE_GIT_BASH_PATH?.trim();
  if (preset && exists(preset)) return preset;
  const roots: string[] = [];
  // Derive the Git install root from git.exe on PATH (…\cmd, …\bin, …\mingw64\bin).
  for (const raw of (env.PATH || env.Path || '').split(';')) {
    const dir = raw.trim().replace(/[\\/]+$/, '');
    if (!dir || !exists(`${dir}\\git.exe`)) continue;
    // Strip the known bin subdir to get the install root (leftmost match wins, so
    // "…\mingw64\bin" strips the whole segment rather than just the trailing "\bin").
    const root = dir.replace(/[\\/](?:mingw(?:64|32)[\\/]bin|cmd|bin)$/i, '');
    if (root && root !== dir) roots.push(root);
  }
  // Common install locations as a fallback.
  const programsLocal = env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs` : undefined;
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], programsLocal]) {
    if (base) roots.push(`${base}\\Git`);
  }
  for (const root of roots) {
    for (const cand of [`${root}\\bin\\bash.exe`, `${root}\\usr\\bin\\bash.exe`]) {
      if (exists(cand)) return cand;
    }
  }
  return undefined;
}

/** The Windows command interpreter (honours a custom %ComSpec%). */
export const comSpec = (env: Env = process.env): string => env.ComSpec || 'cmd.exe';

export interface SpawnSpec {
  file: string;
  args: string[];
}

/**
 * How to run a shell *command string* (e.g. a project's build command) in a PTY
 * or child process. POSIX: a login shell via bash. Windows: cmd.exe.
 */
export function shellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env,
): SpawnSpec {
  return platform === 'win32'
    ? { file: comSpec(env), args: ['/d', '/s', '/c', command] }
    : { file: 'bash', args: ['-lc', command] };
}

/** An interactive shell (no command) in the current directory. */
export function interactiveShell(
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env,
): SpawnSpec {
  return platform === 'win32'
    ? { file: comSpec(env), args: [] }
    : { file: env.SHELL || 'bash', args: ['-l'] };
}

/** A path Windows can launch directly (a real executable image). */
const WINDOWS_DIRECT = /\.(exe|com)$/i;
const IS_SHELL = /(^|[\\/])(cmd|powershell|pwsh)(\.exe)?$/i;

/**
 * Wrap a resolved binary + args for spawning a PTY on Windows. Native `.exe`
 * files (and cmd/powershell themselves) run directly; `.cmd`/`.bat` and
 * extensionless npm shims must go through cmd.exe or Windows raises error 193.
 * No-op on POSIX.
 */
export function ptyCommand(
  file: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env,
): SpawnSpec {
  if (platform !== 'win32') return { file, args };
  if (WINDOWS_DIRECT.test(file) || IS_SHELL.test(file)) return { file, args };
  return { file: comSpec(env), args: ['/d', '/s', '/c', file, ...args] };
}

/**
 * Executable extensions from %PATHEXT%, lowercased and dot-prefixed. Empty on
 * POSIX. Used by `which` to resolve a bare name (e.g. `claude`) to its real
 * launcher (`claude.cmd`) rather than the non-executable POSIX shim.
 */
export function pathExts(
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env,
): string[] {
  if (platform !== 'win32') return [];
  // %PATHEXT% is always ';'-separated; path.delimiter is the host's (':' on POSIX).
  return (env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
