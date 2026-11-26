/**
 * Secret redaction for logs (run events, terminal output). Two layers:
 * exact values AgentForge knows are secret (its encrypted store), and
 * well-known token shapes. Replaced with `[REDACTED]`.
 */
const MASK = '[REDACTED]';

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // gforge:allow — detection pattern
  /\b(?:sk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, // gforge:allow — detection pattern
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // gforge:allow — Stripe secret / restricted key
  /\bwhsec_[A-Za-z0-9+/=]{16,}/g, // gforge:allow — Stripe webhook signing secret
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // gforge:allow — detection pattern
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, // gforge:allow — detection pattern
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // gforge:allow — detection pattern
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // gforge:allow — detection pattern
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // gforge:allow — detection pattern
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // gforge:allow — detection pattern
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // gforge:allow — JWT shape
];
/**
 * `Authorization: Bearer x`, `password=x`, `API_KEY: "x"`, `OPENAI_API_KEY=x`… keep the key,
 * mask the value. The name may carry a prefix/suffix (`STRIPE_SECRET_KEY`, `DB_PASSWORD`).
 */
const ASSIGNMENT =
  /\b((?:[A-Za-z0-9]+[_-])*(?:authorization|bearer|api[_-]?key|access[_-]?token|auth[_-]?token|secret|client[_-]?secret|password|passwd|pwd|token|private[_-]?key|secret[_-]?key|signing[_-]?key)(?:[_-][A-Za-z0-9]+)*\b["']?\s*[:=]\s*(?:bearer\s+)?["']?)([^\s"'`,;]{8,})/gi; // gforge:allow — detection pattern

export type Redactor = (text: string) => string;

export function createRedactor(
  knownSecrets: () => Iterable<string>,
  enabled: () => boolean = () => true,
): Redactor {
  return (text) => {
    if (!text || !enabled()) return text;
    let out = text;
    for (const s of knownSecrets())
      if (s.length >= 8 && out.includes(s)) out = out.split(s).join(MASK);
    for (const re of PATTERNS) out = out.replace(re, MASK);
    out = out.replace(ASSIGNMENT, (_m, key: string, value: string) =>
      value === MASK ? `${key}${value}` : `${key}${MASK}`,
    );
    return out;
  };
}

/** Apply a redactor to every string inside a JSON-like value. */
export function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact);
    return out as T;
  }
  return value;
}
