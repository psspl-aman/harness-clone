/** Parsed result of an MCP tool call. */
export interface ToolResult {
  isError: boolean;
  /** The tool's data: its structured content, or JSON parsed from its text; undefined for plain text. */
  json: unknown;
  text: string;
}

const parseJson = (s: string): unknown => {
  if (!s.trim()) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** `{ result: … }` and nothing else: how FastMCP (Python) wraps a tool's return value. */
const isResultWrapper = (v: unknown): v is { result: unknown } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && 'result' in v;

/**
 * The data a tool returned. Python FastMCP servers (e.g. mcp-atlassian) send
 * `structuredContent: { result: "<JSON text>" }`, so the wrapper is unwrapped
 * and a JSON string inside it parsed; a plain-text result counts as text.
 */
export function toolResultJson(structured: unknown, text: string): unknown {
  if (structured === undefined || structured === null) return parseJson(text);
  if (!isResultWrapper(structured)) return structured;
  const inner = structured.result;
  return typeof inner === 'string' ? (parseJson(inner) ?? parseJson(text)) : inner;
}

/** Turn an MCP `tools/call` response into a ToolResult. */
export function toToolResult(r: Record<string, unknown>): ToolResult {
  const text = Array.isArray(r.content)
    ? (r.content as { type: string; text?: unknown }[])
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n')
    : '';
  return { isError: !!r.isError, json: toolResultJson(r.structuredContent, text), text };
}
