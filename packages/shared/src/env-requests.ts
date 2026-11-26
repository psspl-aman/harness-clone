import { z } from 'zod';

// ─── Env keys the project needs from the user ───────────────────────────────
//
// An agent adds code that reads e.g. OPENAI_API_KEY and declares the name (never a
// value). The user types the real value into a card in the Requirements chat; the
// daemon writes it straight into the project's gitignored `.env`. The value is never
// stored by AgentForge, never returned by the API, and never shown to agents.

export const ENV_KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Names that change how programs start; never written by AgentForge. */
const RESERVED = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'SHELL',
  'COMSPEC',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'BASH_ENV',
  'ENV',
]);
const RESERVED_PREFIXES = ['LD_', 'DYLD_', 'GIT_', 'AGENTFORGE_'];

export function isReservedEnvKey(name: string): boolean {
  const n = name.toUpperCase();
  return RESERVED.has(n) || RESERVED_PREFIXES.some((p) => n.startsWith(p));
}

/** Prefixes frameworks inline into the browser bundle — never for secrets. */
export const PUBLIC_ENV_PREFIX =
  /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|NUXT_PUBLIC_|EXPO_PUBLIC_|GATSBY_)/;

export function looksSecretEnvKey(name: string): boolean {
  return /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH|SIGNING|WEBHOOK|DSN|DATABASE_URL|_KEY$)/i.test(
    name,
  );
}

const keyName = z
  .string()
  .trim()
  .regex(ENV_KEY_NAME_RE, 'Use letters, numbers and _ (not starting with a number)')
  .refine((n) => !isReservedEnvKey(n), 'That name is reserved');

/** Folder (relative to the project) whose `.env` gets the value; "" / "." = project root. */
const folder = z
  .string()
  .trim()
  .max(300)
  .default('')
  .transform((d) => {
    let f = d.replace(/\\/g, '/').replace(/\/+$/, '');
    while (f.startsWith('./')) f = f.slice(2);
    return f === '.' ? '' : f;
  });

export const EnvKeyRequestInputSchema = z.object({
  name: keyName,
  folder,
  why: z.string().trim().max(300).optional(),
  secret: z.boolean().optional(),
});
export type EnvKeyRequestInput = z.input<typeof EnvKeyRequestInputSchema>;

export const EnvKeyValueSchema = z.object({
  value: z
    .string()
    .min(1, 'Enter a value')
    .max(32_768, 'Values are limited to 32 KB')
    .refine((v) => !v.includes('\0'), 'Values can’t contain NUL characters'),
});

export type EnvKeyStatus = 'pending' | 'set' | 'skipped';

/** A key the project needs. Deliberately has no value field. */
export interface EnvKeyRequestDto {
  id: string;
  projectId: string;
  name: string;
  /** `.env` the value goes into, relative to the project (e.g. "api/.env"). */
  file: string;
  why: string | null;
  secret: boolean;
  /** Name is browser-exposed (NEXT_PUBLIC_, VITE_…) but looks like a secret. */
  publicPrefixWarning: boolean;
  status: EnvKeyStatus;
  /** Length of the value in the file (no value is ever returned). */
  length: number | null;
  /** Who asked: an agent on a task, or found in a .env.example. */
  source: 'agent' | 'example';
  taskKey: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnvKeySetResultDto {
  request: EnvKeyRequestDto;
  /** Things the user should know (e.g. the .env file is tracked by git). */
  warnings: string[];
}
