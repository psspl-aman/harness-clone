import type { ErrorSource } from './enums';

export type ErrorStatus = 'open' | 'fixing' | 'resolved' | 'ignored';

export interface ErrorDto {
  id: string;
  projectId: string;
  source: ErrorSource;
  matcher: string;
  message: string;
  filePath: string | null;
  line: number | null;
  column: number | null;
  excerpt: string;
  occurrences: number;
  status: ErrorStatus;
  taskId: string | null;
  fixTaskId: string | null;
  terminalSessionId: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

export type RunKind = 'run' | 'build' | 'test' | 'install';

export type ProcessStatus = 'stopped' | 'starting' | 'running' | 'crashed';

/** One running process of a multi-server project. */
export interface ServiceRunDto {
  name: string;
  status: ProcessStatus;
  command: string;
  cwd: string | null;
  port: number | null;
  terminalId: string | null;
  url: string | null;
  startedAt: number | null;
  exitCode: number | null;
  /** Why it didn't start (e.g. its port is taken). */
  error: string | null;
}

export interface ProjectRunDto {
  projectId: string;
  /** Overall: crashed if any service crashed, starting while any is starting, else running. */
  status: ProcessStatus;
  command: string | null;
  /** The first service's terminal (the single dev server for one-command projects). */
  terminalId: string | null;
  /** The main app's URL (a "web"/"frontend" service when there are several). */
  previewUrl: string | null;
  startedAt: number | null;
  exitCode: number | null;
  /** Every process; a single entry for one-command projects. */
  services: ServiceRunDto[];
}

export interface FileContentDto {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string;
  language: string;
}
