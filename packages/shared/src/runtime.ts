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

export interface ProjectRunDto {
  projectId: string;
  status: 'stopped' | 'starting' | 'running' | 'crashed';
  command: string | null;
  terminalId: string | null;
  previewUrl: string | null;
  startedAt: number | null;
  exitCode: number | null;
}

export interface FileContentDto {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string;
  language: string;
}
